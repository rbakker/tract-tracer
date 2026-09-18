// ── bundle-io.js ──────────────────────────────────────────
// Support for loading several .tck/.trk files simultaneously as one
// colored "bundle set", dropped loose together or unpacked from a .zip
// by file-opener.js (+ an optional index.json manifest either way).
//
// This module only handles *grouping* and *manifest parsing* — actual
// streamline parsing still goes through tract-io.js's parseTck/parseTrk,
// one file at a time, same as a regular single-file load. Zip unpacking
// lives in file-opener.js, one level up — see the note near
// detectBundleDrop below for why.

export const MANIFEST_TYPE = 'tractogram.observer';
export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = 'index.json';

const TRACT_EXTS = ['.tck', '.dqz', '.trk'];
const VOLUME_TYPES = ['anat', 'label', 'mask'];

function extOf(name) {
  const i = name.toLowerCase().lastIndexOf('.');
  return i === -1 ? '' : name.toLowerCase().slice(i);
}

// Fallback bundle display name when a manifest doesn't specify one (or
// there's no manifest at all): filename without its directory path or
// .tck/.trk extension. Lives here (not index.html, where it used to be)
// since this is where the actual filename strings are — index.html only
// ever sees entries[i].file as a File OBJECT, not a string, so calling
// this there on the wrong thing would have silently produced
// "[object File]" the one time the fallback branch actually fired.
export function stripPathExt(filename) {
  const base = String(filename).split(/[\\/]/).pop();
  return base.replace(/\.(tck|tck\.dqz|dqz|trk)$/i, '');
}

// Golden-angle hue rotation, same technique as index.html's
// autoGenerateLut — duplicated here (rather than imported) since
// index.html isn't itself an importable module. Worth consolidating into
// a shared tiny color-utils module if a third place ever needs it.
function hslToRgbHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, h + 1/3), g = hue2rgb(p, q, h), b = hue2rgb(p, q, h - 1/3);
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
const GOLDEN_ANGLE_DEG = 137.50776405003785;

// Default palette when files are dropped together without an index.json.
export function autoBundlePalette(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(hslToRgbHex(((i * GOLDEN_ANGLE_DEG) % 360) / 360, 0.65, 0.55));
  }
  return out;
}

// Accepts a manifest bundle's "color" as either a '#rrggbb' string (passed
// through as-is) or an [r,g,b] array — either 0-255 integers (the common
// "typical 8-bit RGB triple" form, e.g. [45,67,89]) or 0-1 floats; any
// component > 1 is treated as the 0-255 form. Returns a '#rrggbb' string,
// or null if the shape isn't recognized at all.
function normalizeManifestColor(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length === 3 && c.every(n => typeof n === 'number' && isFinite(n))) {
    const is255 = c.some(n => n > 1);
    const toByte = n => Math.max(0, Math.min(255, Math.round(is255 ? n : n * 255)));
    return '#' + c.map(n => toByte(n).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

// Validates and normalizes a parsed index.json object. Throws a short,
// user-facing string on anything unrecognized rather than failing silently
// — a manifest with a malformed section should be a loud error, not a
// fallback to auto-colors/auto-detection (that fallback is only for
// *missing* manifests). "bundles" and "volumes" are each optional (a
// manifest can describe just tractogram bundles, just anatomy/label/mask
// volumes, or both) but at least one of the two must be present and
// non-empty — an index.json with neither is pointless.
export function parseManifest(obj) {
  if (!obj || typeof obj !== 'object') throw 'index.json is not a JSON object';
  if (typeof obj.type !== 'string' || !obj.type.startsWith(MANIFEST_TYPE)) throw `index.json "type" must start with "${MANIFEST_TYPE}"`;
  if (typeof obj.version !== 'number') throw 'index.json missing numeric "version"';
  if (obj.version > MANIFEST_VERSION) throw `index.json version ${obj.version} is newer than this app supports (max ${MANIFEST_VERSION})`;
  if (obj.bundles != null && !Array.isArray(obj.bundles)) throw 'index.json "bundles" must be an array';
  if (obj.volumes != null && !Array.isArray(obj.volumes)) throw 'index.json "volumes" must be an array';

  const bundles = (obj.bundles || []).map((b, i) => {
    if (!b || typeof b.file !== 'string') throw `index.json bundles[${i}] missing "file"`;
    let color = null;
    if (b.color != null) {
      color = normalizeManifestColor(b.color);
      if (color === null) throw `index.json bundles[${i}].color must be a "#rrggbb" string or a [r,g,b] array`;
    }
    return { file: b.file, color, name: typeof b.name === 'string' ? b.name : null };
  });

  // "labels" (optional) names another file in the same drop — a LUT to
  // associate with THIS volume specifically, resolved (and checked for
  // presence) by resolveManifestVolumes below, not here — parseManifest
  // only validates shape, the same division of labor as "bundles".
  const volumes = (obj.volumes || []).map((v, i) => {
    if (!v || typeof v.file !== 'string') throw `index.json volumes[${i}] missing "file"`;
    const type = v.type == null ? 'anat' : v.type;
    if (!VOLUME_TYPES.includes(type)) throw `index.json volumes[${i}].type must be one of ${VOLUME_TYPES.join(', ')}`;
    if (v.labels != null && typeof v.labels !== 'string') throw `index.json volumes[${i}].labels must be a filename string`;
    return { file: v.file, type, name: typeof v.name === 'string' ? v.name : null, labels: v.labels || null };
  });

  if (bundles.length === 0 && volumes.length === 0) throw 'index.json must specify at least one of "bundles" or "volumes"';

  return { type: obj.type, version: obj.version, bundles, volumes };
}

// Given a raw drop's file list (plain array, already stripped of
// directories etc.), decides whether this is a "bundle drop": more than
// one tractogram file, or exactly one tractogram file alongside an
// index.json. A single loose .tck/.trk with no manifest is NOT a bundle
// drop — that's the existing single-file path, unchanged.
//
// Returns null if this isn't a bundle drop, otherwise
// { tractFiles: File[], manifestFile: File|null }
export function detectBundleDrop(files) {
  const tractFiles = files.filter(f => TRACT_EXTS.includes(extOf(f.name)));
  const manifestFile = files.find(f => f.name.toLowerCase() === MANIFEST_FILENAME) || null;
  if (tractFiles.length === 0) return null;
  if (tractFiles.length === 1 && !manifestFile) return null; // ordinary single-file load
  return { tractFiles, manifestFile };
}

// Zip unpacking now lives in file-opener.js's MultiFileOpener.filesFromZip
// — a dropped .zip can carry an anatomy and/or LUT alongside bundle
// files, which this module (deliberately scoped to just tractogram
// bundles) has no business knowing about. detectBundleDrop above is
// still the single place that decides tract-file grouping, called by
// MultiFileOpener after it's unpacked whatever needed unpacking.

// Resolves { tractFiles, manifestFile } into a final per-file color list,
// reading and validating the manifest if present, falling back to the
// auto-generated palette otherwise. Files named in the manifest but not
// present in the drop are reported, not silently dropped.
export async function resolveBundleColors({ tractFiles, manifestFile }) {
  const byName = new Map(tractFiles.map(f => [f.name, f]));
  if (!manifestFile) {
    const colors = autoBundlePalette(tractFiles.length);
    return {
      manifest: null,
      entries: tractFiles.map((f, i) => ({ file: f, color: colors[i], name: stripPathExt(f.name) })),
    };
  }
  const text = await manifestFile.text();
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw 'index.json is not valid JSON: ' + e; }
  const manifest = parseManifest(raw);
  const autoColors = autoBundlePalette(manifest.bundles.length);
  const missing = [];
  const entries = manifest.bundles.map((b, i) => {
    const f = byName.get(b.file);
    if (!f) missing.push(b.file);
    // f.name would throw mid-map if f is missing — fall back to b.file
    // itself (already a plain string) rather than assuming f exists;
    // the missing-file throw below still fires either way, this just
    // avoids a raw TypeError pre-empting that nicer, user-facing message.
    return { file: f, color: b.color || autoColors[i], name: b.name || stripPathExt(f ? f.name : b.file) };
  });
  if (missing.length) throw `index.json references file(s) not present in the drop: ${missing.join(', ')}`;
  return { manifest, entries };
}

// Resolves manifest.volumes (if any) against the files actually present
// in the drop — mirrors resolveBundleColors' shape/behavior: throws a
// short, user-facing string listing any referenced file (volume or its
// "labels" LUT) that isn't present, rather than silently dropping it.
// "files" is the drop's full flat file list (not just tractogram files —
// volumes/LUTs are elsewhere in the same drop/zip). Returns [] if the
// manifest has no "volumes" section at all.
export function resolveManifestVolumes(manifest, files) {
  const volumes = manifest && manifest.volumes;
  if (!volumes || !volumes.length) return [];
  const byName = new Map(files.map(f => [f.name, f]));
  const missing = [];
  const resolved = volumes.map(v => {
    const file = byName.get(v.file);
    if (!file) missing.push(v.file);
    let lutFile = null;
    if (v.labels) {
      lutFile = byName.get(v.labels) || null;
      if (!lutFile) missing.push(v.labels);
    }
    return { file, type: v.type, name: v.name || (file ? stripPathExt(file.name) : v.file), lutFile };
  });
  if (missing.length) throw `index.json references file(s) not present in the drop: ${missing.join(', ')}`;
  return resolved;
}
