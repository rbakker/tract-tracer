# Packaging data for tractogram.observer: the zip and its manifest

This is a brief for building a `.zip` that the app opens in one go: dropped on
the page, picked with LOAD…, or opened from a URL
(`index.html?load=https://host/subject.zip`). It covers the files that can go
in the zip, the manifest `index.json` as the app reads it today (manifest
version 1), and what happens on load. Only image volumes, parcellations,
segmentations and isosurface inputs are covered: no streamlines, no markers.

> **datapackage.json.** The manifest can now also be a Data Package,
> `datapackage.json`, which can carry tables as well: an atlas's regions with
> their hierarchy, markers, links. See *The zip manifest* in
> graph-format.md. `index.json`, described below, is still read.

## The zip

- **Flat namespace.** Folders inside the zip are ignored: every file is known
  by its **base name** only, so base names must be unique across the zip. A
  zip of a folder (`sub-01/…`) works, and so does one re-packed by macOS or a
  share service: `__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db` and
  `desktop.ini` are skipped.
- **Compression.** Store files that are already compressed (`.nii.gz`,
  `.webm`) without compressing them again (ZIP_STORED). Deflate the text files
  (`index.json`, lookup tables, `.webm.json` sidecars).
- **Without a manifest** the zip still loads: every volume is listed, label
  volumes are recognized from their values, and lookup tables are paired by
  name (see *Lookup tables*). The manifest adds display names, explicit
  types, explicit LUT pairing, the load order and the opening view.

### Files the app reads

| file | what |
|---|---|
| `*.nii`, `*.nii.gz` | NIfTI-1 volumes: scans, label volumes, masks, probability maps |
| `*.mif` | MRtrix volumes |
| `*.webm` + `*.webm.json` | an image volume as video, with its sidecar (see below) |
| `*.txt`, `*.lut` | lookup tables for label volumes |
| `index.json` | the manifest (exactly this name) |

## The manifest: `index.json`

```json
{
  "type": "tractogram.observer",
  "version": 1,
  "volumes": [
    { "file": "sub-01_T1w.webm",       "type": "anat",  "name": "T1w" },
    { "file": "sub-01_vessels.nii.gz", "type": "anat",  "name": "vessel probability" },
    { "file": "sub-01_aparc.nii.gz",   "type": "label", "name": "Desikan-Killiany", "labels": "sub-01_aparc_lut.txt" },
    { "file": "sub-01_tumour.nii.gz",  "type": "label", "name": "tumour",           "labels": "sub-01_tumour_lut.txt" },
    { "file": "sub-01_brainmask.nii.gz", "type": "mask", "name": "brain mask" }
  ],
  "view": { "bounds": "sub-01_T1w.webm", "from": "left", "up": "superior" }
}
```

### Top level

| key | required | meaning |
|---|:---:|---|
| `type` | ✓ | must **start with** `"tractogram.observer"` |
| `version` | ✓ | a number; the app supports up to `1` and refuses newer |
| `volumes` | ✓* | the volumes, **in load order** |
| `bundles` | | streamline files; not used here |
| `view` | | the opening 3D view |

\* At least one of `volumes` or `bundles` must be present and non-empty.

### `volumes[]`

| key | required | meaning |
|---|:---:|---|
| `file` | ✓ | base name of a volume file in the zip (`.nii`, `.nii.gz`, `.mif`, `.webm`) |
| `type` | | `"anat"` (default), `"label"` or `"mask"` |
| `name` | | display name (default: the file name without its extension) |
| `labels` | | base name of the lookup table for **this** volume (with `"label"`) |

- `"anat"`: an image volume, which can be a scan, a colour (RGB / DEC) volume,
  or a probability or vessel map (any scalar volume, including an isosurface
  input).
- `"label"`: a label volume, listed under parcellation **and** segmentation.
  Give it a lookup table with `labels`; without one it gets automatic colours.
- `"mask"`: accepted, and loaded as an ordinary scalar volume. Any volume can
  serve as another volume's mask (ANATOMY › apply mask, rule "is not 0"), so
  the type only documents the intent.

### `view` (optional, every field optional)

| key | value |
|---|---|
| `bounds` | what the view frames and turns around: a volume file name (its non-empty part), or `{ "center": [x, y, z], "radius": mm }` in world coordinates (either field may be left out) |
| `from` | where the eye is, seen from the centre: `"left"`, `"right"`, `"anterior"`, `"posterior"`, `"superior"`, `"inferior"`, or `[x, y, z]` |
| `up` | the same choices; default `"superior"` (`"anterior"` when looking from above or below) |

### Validation

The manifest is checked strictly. A wrong shape, an unknown `type`, or a
`file`, `labels` or `view.bounds` that isn't in the zip gives an error that
names the problem. The user can then cancel, or continue without the
manifest's guidance (with the automatic classification described above).

## What happens on load

The ANATOMY tab has four roles, each a pull-down of the loaded volumes:

| role | listed volumes | chosen at load |
|---|---|---|
| **Image volume** (raymarched in 3D, shown in the sections) | all | the **first** volume in manifest order that isn't label-like (not `"label"`, and its name doesn't contain `seg`, `aseg`, `aparc`, `dseg`, `label(s)`, `mask`, `parc`, `parcellation`, `atlas` or `wmparc` as a word part) |
| **Parcellation** (region names, outlines, region meshes) | label volumes | the first label volume **with** a lookup table |
| **Segmentation** (a second label volume, meshes in 3D only) | label volumes | none: picked by the user |
| **Isosurface overlay** (a scalar volume as a surface at a level, also filled in the 2D sections) | all non-label volumes | none: picked by the user |

So:

- **Put the main scan first** in `volumes`, and keep `mask`, `seg`, `label` and
  similar out of its file name.
- **Put the main parcellation first among the label volumes,** with its LUT.
- **Segmentation and isosurface overlay can't be preset** by manifest version
  1. Name and order those volumes so the user finds them easily, for example
  "tumour" and "vessel probability". A role field could be a later manifest
  extension.
- **An isosurface input is an `"anat"` volume:** a probability or vessel map,
  0–1 or any range. Its level starts at half the 99th percentile of its
  values above zero, and the user adjusts it. Keep
  it as `.nii.gz`, since lossy video changes values and the surface follows
  them exactly.
- **Masks are applied per volume** in ANATOMY (apply mask). Mask and volume
  only need to share world space, not the same grid.

## Lookup tables

A label volume's lookup table is found by the first rule that applies:

1. the manifest names it in that volume's `labels`;
2. its name without extension equals the volume's name without extension
   (`brain_seg.txt` ↔ `brain_seg.nii.gz`);
3. otherwise the user is asked.

Formats: FreeSurfer colour LUT (`index name r g b a`, one region per line,
`#` comments) or ITK-SNAP label description files. Values 0–255 for
`r g b`.

A region hierarchy can't be expressed in a lookup table yet. Names with `|`
as paths, and sides read from names, are proposals in the graph-format draft,
not implemented.

## The `.webm` volume format, briefly

A **lossy, compact** way to ship an **image volume** (T1, T2, colour DEC):
the volume as a VP9 video in a WebM container, one frame per coronal
section, plus a small JSON sidecar. It's much smaller than `.nii.gz`, and the browser decodes it natively.

- **Two files:** `<name>.webm` and `<name>.webm.json` (`<name>.json` is
  also accepted). A `.webm` without its sidecar is refused.
- **Video:**
  - pixel format `gbrp` (no YUV conversion);
  - frame 0 is the most anterior section; row 0 is superior; column 0 is
    the subject's right;
  - **scalar values** are in the green channel, 8 bits, windowed to the
    volume's full range;
  - **colour volumes** use R, G and B directly.
- **Sidecar:** `shape` `[columns, frames, rows]`, `channels` (1 or 3),
  `vox_mm`, `Ab` (voxel → world: four rows of three, the columns of the
  affine and then its translation), `mn` and `mx` (the value range that
  0–255 stands for), and `categorical` (false).
- **Made with** `tools/nifti_to_webm.py in.nii.gz out.webm`. It needs ffmpeg
  with libvpx-vp9, numpy, nibabel and Pillow.
- **Not for label volumes, masks or isosurface inputs.** Lossy coding
  shifts values: a changed label at an edge is a different region, and a
  surface follows exact values. Keep those as `.nii.gz`: their large
  uniform areas gzip very well anyway.

Full spec: `webm-format.md`.

## The `.dqz` format, briefly (for later: streamlines)

A compressed `.tck` tractogram, about 4× smaller, for the `bundles` part of
the manifest, which isn't needed for this zip.

- **Header:** the magic `TCKDQZ01`, a uint32 header length, then a JSON
  header with `n_streamlines`, `divisor`, `source_header` (the original
  `.tck` fields) and an optional `uuid`.
- **One record per streamline:**
  - `n_points` (uint32);
  - the first point (3 × float32);
  - a step `Q` (float32);
  - then the other points as int8 deltas (3 bytes per point).

  Positions are rebuilt as `start + cumsum(delta) × Q`. That is exact
  integer accumulation, so the rounding error doesn't build up along the
  streamline.
- **Child data files** (magic `DQZDATA1`, also with the `.dqz` extension)
  carry one per-point or per-streamline field each. They're tied to their
  parent by its `uuid`.
- **Made with** `tck_quantize.py` (in a zip, as `<name>.tck.dqz`).

## Reference: an existing builder

`tools/make_subject_zip.py` builds such a zip for one subject:

- anatomy converted to `.webm` with its sidecar (`"type": "anat"`, main
  scan first);
- label volumes as uint16 `.nii.gz`, each with a FreeSurfer-format LUT
  (`"type": "label"` plus `"labels"`);
- `index.json` written first;
- compressed files stored, text deflated.

A new builder for image, parcellation, segmentation and isosurface inputs
can follow it, leave out the tractogram, and add the isosurface input as an
`"anat"` `.nii.gz`.
