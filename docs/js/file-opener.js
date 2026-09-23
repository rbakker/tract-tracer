// ── file-opener.js ────────────────────────────────────────
// Central place that turns a "drop" — a raw browser FileList/array, or a
// single .zip — into classified, loadable pieces (anatomy, LUT, a
// tractogram or bundle set) and hands each back to the caller to actually
// load. Whether the files arrived loose (dragged/selected together) or
// packed in a zip is transparent past open(): both paths produce the same
// classified result, so a zip can now carry an anatomy + LUT + several
// .tck/.trk bundles + index.json all in one drop.
//
// This module deliberately does NOT touch app state (no state.update,
// no loadLUT/loadTrck calls) — it only classifies and groups. Actually
// loading stays index.html's job, same as before; this just replaces the
// "which loader does this file belong to" decision that used to be
// scattered across each drop zone's own handler with one shared place.
//
// classify()'s per-file {file, kind} records are also intentionally kept
// around on the returned result (see `entries`) rather than being
// discarded once routed — nothing reads that structure yet, but it's the
// natural seed for a later "show everything in this drop as a tree,
// toggle bundles on/off" UI, which is why this is a class (holding that
// structure) rather than a one-shot function.

import { unzipSync } from 'fflate';
import { detectBundleDrop, resolveBundleColors, MANIFEST_FILENAME } from './bundle-io.js';
import { sniffDqzKind, readDqzChildHeader } from './tract-io.js';

const TRACT_EXTS = ['.tck', '.dqz', '.trk'];
const LUT_EXTS    = ['.txt', '.lut'];

// Extensions with a compound ("double") suffix, e.g. "brain.nii.gz" -> base
// "brain" rather than "brain.nii". Extend as needed for other compound
// formats.
const DOUBLE_EXTS = ['.nii.gz', '.mif.gz'];

function extOf(name) {
  const i = name.toLowerCase().lastIndexOf('.');
  return i === -1 ? '' : name.toLowerCase().slice(i);
}

function baseNameCandidates(name) {
  // Candidate sidecar base-names for `name`, most-specific first:
  // "brain.nii.gz" -> ["brain.nii.gz", "brain"]
  // "brain.webm"   -> ["brain.webm", "brain"]
  const lower = name.toLowerCase();
  const doubleExt = DOUBLE_EXTS.find(ext => lower.endsWith(ext));
  const candidates = [name];
  if (doubleExt) {
    candidates.push(name.slice(0, -doubleExt.length));
  } else {
    const dot = name.lastIndexOf('.');
    if (dot > 0) candidates.push(name.slice(0, dot));
  }
  return candidates;
}

export class MultiFileOpener {
  // Classifies a flat File[] by extension. 'anat' is the fallback bucket
  // for anything not recognized as a tractogram/LUT/manifest — same rule
  // the original single-file drop handler used (.nii/.nii.gz/.mif/.webm all
  // just fall through to it by elimination), kept here so a file that
  // used to load fine as a loose drop still does inside a zip.

  static classify(files) {
    const byName = new Map(files.map(f => [f.name, f]));

    // Pass 1: match every non-json file against the json files actually
    // present, using the "<fullname>.json" or "<fullname-minus-its-
    // (double)-extension>.json" convention. Iterating targets (not json
    // files) means we only ever match a sidecar that's genuinely paired to
    // something in this drop.
    const sidecarForTarget = new Map(); // target file.name -> sidecar File
    //const consumedSidecars = new Set(); // json filenames already claimed

    const dataFiles = [];
    for (const file of files) {
      const name = file.name;
      if (name.toLowerCase().endsWith('.json')) continue; // json files are targets' sidecars, not targets themselves
      if (name.toLowerCase() === MANIFEST_FILENAME) continue;

      for (const cand of baseNameCandidates(name)) {
        const jsonName = cand + '.json';
        if (jsonName.toLowerCase() === MANIFEST_FILENAME) continue; // never treat the manifest as a sidecar match
        const jsonFile = byName.get(jsonName);
        if (jsonFile) {
          sidecarForTarget.set(name, jsonFile);
          //consumedSidecars.add(jsonFile.name);
          break; // most-specific candidate wins
        }
      }
      dataFiles.push(file);
    }

    // Pass 2: classify everything not already consumed as a sidecar.
    const classified = [];
    for (const file of dataFiles) {
      //if (consumedSidecars.has(file.name)) continue; // folded into its target's entry below

      const name = file.name;
      if (name.toLowerCase() === MANIFEST_FILENAME) {
        classified.push({ file, kind: 'manifest' });
        continue;
      }

      const ext = extOf(name);
      const sidecar = sidecarForTarget.get(name) || null;

      if (ext === '.webm') {
        // Only .webm needs the merged combo, since parseWebm's signature
        // takes one object - other formats just get sidecar attached
        // alongside file for now, unused until something needs it.
        if (!sidecar) console.warn(`${name} has no matching sidecar - loading without metadata.`);
        classified.push({ file: { name, video: file, sidecar }, kind: 'anat' });
        continue;
      }

      if (TRACT_EXTS.includes(ext)) { classified.push({ file, kind: 'tract', sidecar }); continue; }
      if (LUT_EXTS.includes(ext))   { classified.push({ file, kind: 'lut', sidecar });   continue; }
      classified.push({ file, kind: 'anat', sidecar }); // nifti/mif/etc., sidecar attached if one was found
    }

    return classified;
  }
  
  // Unpacks a .zip into the same flat File[] a loose multi-file drop
  // would give. Per-entry decompression is native DecompressionStream
  // under the hood (same idiom volume-io.js already uses for .nii.gz) —
  // fflate here only parses the zip container itself.
  static async filesFromZip(zipFile) {
    const buf = new Uint8Array(await zipFile.arrayBuffer());
    const entries = unzipSync(buf);
    const files = [];
    for (const [name, bytes] of Object.entries(entries)) {
      const base = name.split('/').pop(); // drop any folder prefix from a zipped-up folder
      if (!base) continue; // directory entry
      files.push(new File([bytes], base));
    }
    return files;
  }

  // .dqz child data files (DQZDATA1) share the .dqz extension with
  // geometry files, so classify() — synchronous, extension-only — files
  // them under 'tract' along with real geometry. This async pass sniffs
  // the magic bytes of every .dqz 'tract' entry and re-labels the data
  // files as kind 'dqzChild' (header attached), so they never reach
  // detectBundleDrop/the tractogram loaders as if they were geometry.
  // Only the first few bytes + JSON header are read here, not the data.
  // A child with a malformed header is still reported (kind
  // 'dqzChild', header null, error set) rather than silently dropped.
  static async separateDqzChildren(entries) {
    for (const e of entries) {
      if (e.kind !== 'tract' || extOf(e.file.name) !== '.dqz') continue;
      if (await sniffDqzKind(e.file) !== 'child') continue;
      e.kind = 'dqzChild';
      try { e.header = await readDqzChildHeader(e.file); e.error = null; }
      catch (err) { e.header = null; e.error = String((err && err.message) || err); }
    }
  }

  // Main entry point. rawFiles: the raw File[] from a drop or file input
  // — either loose files, or a single-element array containing one .zip.
  // Returns { entries, anat, lut, tract, bundle, children }:
  //   entries — every classified {file, kind} record (zip-expanded if
  //             applicable) — see the class comment above.
  //   anat    — a File to load as anatomy, or null.
  //   lut     — a File to load as a LUT, or null.
  //   tract   — a single File to load as an ordinary (non-bundle)
  //             tractogram, or null — set only when exactly one tract
  //             file is present with no index.json (mirrors
  //             detectBundleDrop's own single-file/bundle distinction).
  //   bundle  — a resolveBundleColors() result ({manifest, entries}) to
  //             load as a bundle set, or null — set whenever there's more
  //             than one tract file, or exactly one alongside index.json.
  //   children — [{file, header, error}] for every .dqz child data file in
  //             the drop (see separateDqzChildren). Not matched to a
  //             parent here — that needs the loaded geometry, so it's
  //             the caller's job. Never counted as tract files above.
  // At most one of tract/bundle is ever set.
  static async open(rawFiles) {
    const isSingleZip = rawFiles.length === 1 && extOf(rawFiles[0].name) === '.zip';
    const files = isSingleZip ? await MultiFileOpener.filesFromZip(rawFiles[0]) : Array.from(rawFiles);
    const entries = MultiFileOpener.classify(files);
    await MultiFileOpener.separateDqzChildren(entries);

    const anat = entries.find(e => e.kind === 'anat')?.file || null;
    const lut  = entries.find(e => e.kind === 'lut')?.file  || null;
    const childEntries = entries.filter(e => e.kind === 'dqzChild');
    const children = childEntries.map(e => ({ file: e.file, header: e.header, error: e.error }));

    // detectBundleDrop groups by extension, so hand it the drop minus
    // the child files — otherwise geometry + one child would look like a
    // two-file bundle set.
    const childFiles = new Set(childEntries.map(e => e.file));
    const geometryFiles = files.filter(f => !childFiles.has(f));

    let tract = null, bundle = null;
    const grouped = detectBundleDrop(geometryFiles);
    if (grouped) {
      bundle = await resolveBundleColors(grouped);
    } else {
      tract = entries.find(e => e.kind === 'tract')?.file || null;
    }

    return { entries, anat, lut, tract, bundle, children };
  }
}
