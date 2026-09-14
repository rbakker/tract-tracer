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

export const MANIFEST_TYPE = 'tractogram.observer.bundles';
export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = 'index.json';

const TRACT_EXTS = ['.tck', '.trk'];

function extOf(name) {
  const i = name.toLowerCase().lastIndexOf('.');
  return i === -1 ? '' : name.toLowerCase().slice(i);
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
// — a bundle set with a malformed manifest should be a loud error, not a
// fallback to auto-colors (that fallback is only for *missing* manifests).
export function parseManifest(obj) {
  if (!obj || typeof obj !== 'object') throw 'index.json is not a JSON object';
  if (obj.type !== MANIFEST_TYPE) throw `index.json "type" must be "${MANIFEST_TYPE}"`;
  if (typeof obj.version !== 'number') throw 'index.json missing numeric "version"';
  if (obj.version > MANIFEST_VERSION) throw `index.json version ${obj.version} is newer than this app supports (max ${MANIFEST_VERSION})`;
  if (!Array.isArray(obj.bundles) || obj.bundles.length === 0) throw 'index.json "bundles" must be a non-empty array';
  return {
    type: obj.type,
    version: obj.version,
    bundles: obj.bundles.map((b, i) => {
      if (!b || typeof b.file !== 'string') throw `index.json bundles[${i}] missing "file"`;
      let color = null;
      if (b.color != null) {
        color = normalizeManifestColor(b.color);
        if (color === null) throw `index.json bundles[${i}].color must be a "#rrggbb" string or a [r,g,b] array`;
      }
      return { file: b.file, color, name: typeof b.name === 'string' ? b.name : null };
    }),
  };
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
      entries: tractFiles.map((f, i) => ({ file: f, color: colors[i], name: null })),
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
    return { file: f, color: b.color || autoColors[i], name: b.name };
  });
  if (missing.length) throw `index.json references file(s) not present in the drop: ${missing.join(', ')}`;
  return { manifest, entries };
}
