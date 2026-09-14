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

const TRACT_EXTS = ['.tck', '.trk'];
const LUT_EXTS    = ['.txt', '.lut'];

function extOf(name) {
  const i = name.toLowerCase().lastIndexOf('.');
  return i === -1 ? '' : name.toLowerCase().slice(i);
}

export class MultiFileOpener {
  // Classifies a flat File[] by extension. 'anat' is the fallback bucket
  // for anything not recognized as a tractogram/LUT/manifest — same rule
  // the original single-file drop handler used (.nii/.nii.gz/.mif all
  // just fall through to it by elimination), kept here so a file that
  // used to load fine as a loose drop still does inside a zip.
  static classify(files) {
    return files.map(file => {
      const name = file.name;
      if (name.toLowerCase() === MANIFEST_FILENAME) return { file, kind: 'manifest' };
      const ext = extOf(name);
      if (TRACT_EXTS.includes(ext)) return { file, kind: 'tract' };
      if (LUT_EXTS.includes(ext))   return { file, kind: 'lut' };
      return { file, kind: 'anat' };
    });
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

  // Main entry point. rawFiles: the raw File[] from a drop or file input
  // — either loose files, or a single-element array containing one .zip.
  // Returns { entries, anat, lut, tract, bundle }:
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
  // At most one of tract/bundle is ever set.
  static async open(rawFiles) {
    const isSingleZip = rawFiles.length === 1 && extOf(rawFiles[0].name) === '.zip';
    const files = isSingleZip ? await MultiFileOpener.filesFromZip(rawFiles[0]) : Array.from(rawFiles);
    const entries = MultiFileOpener.classify(files);

    const anat = entries.find(e => e.kind === 'anat')?.file || null;
    const lut  = entries.find(e => e.kind === 'lut')?.file || null;

    let tract = null, bundle = null;
    // detectBundleDrop re-scans `files` itself for tract exts + a
    // manifest — cheap, and keeps the single-vs-bundle decision in one
    // place (bundle-io.js) rather than duplicated here.
    const grouped = detectBundleDrop(files);
    if (grouped) {
      bundle = await resolveBundleColors(grouped);
    } else {
      tract = entries.find(e => e.kind === 'tract')?.file || null;
    }

    return { entries, anat, lut, tract, bundle };
  }
}
