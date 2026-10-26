# Packaging data for tractogram.observer: the zip and its manifest

This brief describes how to build a `.zip` that the app opens in one go. The
zip can be dropped on the page, picked with LOAD…, or opened from a URL
(`index.html?load=https://host/subject.zip`). It covers:

- the files that can go in the zip;
- the manifest, `datapackage.json`;
- what happens on load.

The older manifest, `index.json`, is still read. It is described at the end
and gets no new features.

## The zip

- **Flat namespace.** Folders inside the zip are ignored, and every file is
  known by its **base name** only, so base names must be unique across the
  zip.
  - A zip of a folder (`sub-01/…`) works.
  - So does a zip re-packed by macOS or a share service: `__MACOSX/`, `._*`,
    `.DS_Store`, `Thumbs.db` and `desktop.ini` are skipped.
- **Compression.** Store files that are already compressed (`.nii.gz`,
  `.webm`, `.tt.gz`, `.dqz`) without compressing them again (ZIP_STORED).
  Deflate the text files: the manifest, lookup tables, CSV tables and JSON
  sidecars.
- **Without a manifest** the zip still loads:
  - every volume is listed, and label volumes are recognized from their
    values;
  - lookup tables are paired by name (see *Lookup tables*);
  - streamline files are loaded as bundles with automatic colours.

  The manifest adds display names, explicit roles, lookup-table and mask
  pairing, the load order, colours, the opening view, tables, and credit for
  the data.

### Files the app reads

| file | what |
|---|---|
| `*.nii`, `*.nii.gz` | NIfTI-1 volumes: scans, label volumes, masks, probability maps |
| `*.mif` | MRtrix volumes |
| `*.webm` + `*.webm.json` | an image volume as video, with its sidecar (see below) |
| `*.json` next to a volume | its BIDS sidecar (`sub-01_dwi.json` for `sub-01_dwi.nii.gz`) |
| `*.bval`, `*.bvec` | a DWI series' gradient table (FSL), paired by name |
| `*.txt`, `*.lut`, `*_dseg.tsv` | lookup tables for label volumes (FreeSurfer, ITK-SNAP, BIDS) |
| `*.tck`, `*.trk`, `*.dqz`, `*.tt`, `*.tt.gz` | streamlines: MRtrix, TrackVis, compressed `.tck`, DSI Studio |
| `*.dqz` (data) | per-point or per-streamline data of a `.dqz` tractogram |
| `*.csv`, `*.tsv` | tables of the manifest (points, links, regions) |
| `datapackage.json` | the manifest (exactly this name) |
| `index.json` | the older manifest (exactly this name) |

## The manifest: `datapackage.json`

The manifest is a **[Data Package](https://datapackage.org/)**, the open
standard of the Frictionless Data project. Its `resources` list the files of
the zip, **in load order**, and can also hold tables. The standard allows
extra properties, which its tools ignore; this app's own are marked
**ours** below. The tables themselves (points, links, an atlas's regions
and their hierarchy) are described in `graph-format.md`.

```json
{
  "name": "sub-01",
  "title": "Subject 01",
  "space": "MNI152NLin2009cAsym",
  "licenses": [{ "name": "CC-BY-4.0", "path": "https://creativecommons.org/licenses/by/4.0/" }],
  "resources": [
    { "name": "t1",        "path": "sub-01_T1w.nii.gz",       "role": "anat",  "title": "T1w", "mask": "brainmask" },
    { "name": "brainmask", "path": "sub-01_brainmask.nii.gz", "role": "mask",  "title": "brain mask" },
    { "name": "vessels",   "path": "sub-01_vessels.nii.gz",   "role": "anat",  "title": "vessel probability" },
    { "name": "aparc",     "path": "sub-01_aparc.nii.gz",     "role": "label", "title": "Desikan-Killiany", "labels": "aparc-lut" },
    { "name": "aparc-lut", "path": "sub-01_aparc_lut.txt" },
    { "name": "af-l",      "path": "AF_L.tck.dqz", "title": "arcuate fasciculus, left", "color": "#e04030" },
    { "name": "af-l-fa",   "path": "AF_L.tck.fa.dqz", "role": "data" },
    { "name": "cst-l",     "path": "CST_L.tt.gz",  "title": "corticospinal tract, left", "visible": false }
  ],
  "view": { "bounds": "sub-01_T1w.nii.gz", "from": "left", "up": "superior" }
}
```

### Top level

| key | from | meaning |
|---|---|---|
| `resources` | standard | the files and tables, **in load order** (required) |
| `name`, `title`, `description` | standard | the package's identifier, display name and description |
| `sources`, `licenses`, `contributors`, `id`, `version`, `created`, `homepage` | standard | credit for the data: see *Attribution* |
| `citation` | **ours** | the preferred citation, as text |
| `space` | **ours** | the coordinate space of the whole package (see *Space*) |
| `view` | **ours** | the opening 3D view (see *View*) |

### A volume

A resource whose `path` ends in `.nii`, `.nii.gz`, `.mif` or `.webm`.

| key | from | meaning |
|---|---|---|
| `name` | standard | its identifier, for references from other resources |
| `path` | standard | the file in the zip |
| `title` | standard | display name (default: the file name without its extension) |
| `role` | **ours** | `"anat"` (default), `"label"` or `"mask"`; also `"label"` when a region table places its regions in it |
| `labels` | **ours** | the `name` of the lookup-table resource for **this** volume (with `"label"`) |
| `mask` | **ours** | the `name` of a mask volume of the package, applied to this volume from the start |
| `space` | **ours** | its coordinate space, if it differs from the package's |

The roles:

- `"anat"`: an image volume. It can be a scan, a colour (RGB / DEC) volume,
  or a probability or vessel map (any scalar volume, including an
  isosurface input).
- `"label"`: a label volume, listed under parcellation **and**
  segmentation. Give it a lookup table with `labels`; without one it gets
  automatic colours.
- `"mask"`: a mask. It is loaded as an ordinary scalar volume and can be
  applied to any volume (ANATOMY › apply mask, rule "is not 0"). A mask
  volume is not the first volume shown when there is another.

**`mask`: a default mask.** The volume opens with that mask already
applied, as if it had been picked under ANATOMY › apply mask: where the
mask is 0, the volume counts as 0. This way a zip with a full-head scan and
a brain mask opens showing the brain. The user can switch the mask off or
choose another. The mask and the volume only need to share world space,
not the same grid. Several volumes can share one mask.

### A tractogram

A resource whose `path` ends in `.tck`, `.trk`, `.dqz`, `.tt` or `.tt.gz`.

| key | from | meaning |
|---|---|---|
| `title` | standard | display name of the bundle (default: the file name) |
| `color` | **ours** | `"#rrggbb"` or `[r, g, b]` (0–255 or 0–1) |
| `visible` | **ours** | `false`: starts off, and is read only when switched on |

`visible: false` is for large sets, such as a tract atlas of 80 bundles:
the package opens quickly with a few bundles on, and the rest are read on
demand.

### Other resources

| resource | keys |
|---|---|
| a lookup table: `path` ending in `.txt`, `.lut`, `.tsv` | named by a volume's `labels` |
| a `.dqz` data file | **ours** `role: "data"`: not a tractogram; it is paired with its tractogram by its uuid |
| a volume's JSON sidecar | **ours** `role: "sidecar"`: listed for completeness; it is paired by name |
| a table (points, links, regions) | inline `data` or a CSV `path`; see `graph-format.md` |

A package without any table in space is a manifest only, and is not read as
a graph file.

### Space

**ours** `space`, on the package or on a resource (a resource's own wins),
names the coordinate space its positions are in. Use a
[TemplateFlow](https://www.templateflow.org) identifier where one exists:

- `MNI152NLin2009cAsym` (fMRIPrep);
- `MNI152NLin2009bAsym` (Lead-DBS);
- `MNI152NLin2009aAsym` (DSI Studio's HCP-1065 atlas);
- `MNI152NLin6Asym` (FSL).

Otherwise use a word of your own, such as `"native"` or `"sub-01"`.

- No transformation is applied.
- The space is shown in the item's ⓘ.
- Loading a package in a space that doesn't line up with one already loaded
  gives a warning. The ICBM 2009 a, b and c versions count as one space:
  they line up to within about a millimetre.

### View

**ours** `view`, every field optional:

| key | value |
|---|---|
| `bounds` | what the view frames and turns around: a volume file name (its non-empty part), or `{ "center": [x, y, z], "radius": mm }` in world coordinates (either field may be left out) |
| `from` | where the eye is, seen from the centre: `"left"`, `"right"`, `"anterior"`, `"posterior"`, `"superior"`, `"inferior"`, or `[x, y, z]` |
| `up` | the same choices; default `"superior"` (`"anterior"` when looking from above or below) |

### Attribution

Data copied from elsewhere keeps its credit through the standard Data
Package properties: `sources`, `licenses`, `contributors`, `id`, and
**ours** `citation`. They go on the package and on each resource. The
viewer shows them in an item's ⓘ, the item's own first, then its package's,
with links. See *Attribution* in `graph-format.md` for the details and the
mapping from a BIDS `dataset_description.json`.

### Validation

The manifest is checked strictly. Each of these gives an error that names
the problem:

- a wrong shape or an unknown `role`;
- a `labels` or `mask` that doesn't name a resource of the right kind;
- a file that isn't in the zip;
- a `view.bounds` that isn't in the zip.

The user can then cancel, or continue without the manifest's guidance and
use the automatic classification described above.

## What happens on load

### Volumes

The ANATOMY tab has four roles, each a pull-down of the loaded volumes:

| role | listed volumes | chosen at load |
|---|---|---|
| **Image volume** (raymarched in 3D, shown in the sections) | all | the **first** volume in manifest order that isn't a label or mask volume (by `role`, or by a name containing `seg`, `aseg`, `aparc`, `dseg`, `label(s)`, `mask`, `parc`, `parcellation`, `atlas` or `wmparc` as a word part) |
| **Parcellation** (region names, outlines, region meshes) | label volumes | the first label volume **with** a lookup table |
| **Segmentation** (a second label volume, meshes in 3D only) | label volumes | none: picked by the user |
| **Isosurface overlay** (a scalar volume as a surface at a level, also filled in the 2D sections) | all non-label volumes | none: picked by the user |

So:

- **Put the main scan first,** and give it its brain mask with `mask`.
- **Put the main parcellation first among the label volumes,** with its
  lookup table.
- **Segmentation and the isosurface overlay can't be preset yet.** Name and
  order those volumes so the user finds them easily, for example "tumour"
  and "vessel probability".
- **An isosurface input is an `"anat"` volume:** a probability or vessel
  map, 0–1 or any range.
  - Its level starts at half the 99th percentile of its values above zero,
    and the user adjusts it.
  - Keep it as `.nii.gz`: lossy video changes values, and the surface
    follows them exactly.

### Streamlines

- The tractograms become one bundle each, in manifest order, with their
  `title` and `color`.
- `.dqz` data files attach to their tractogram and appear as its fields.
- How many streamline points are read is capped by the CPU tier (3D ›
  HARDWARE): 75 million, 300 million or 1.2 billion. When a load holds
  more, every n-th streamline is read. The n is the same for all files of
  the load, and the streamline count says "thinned".

## Lookup tables

A label volume's lookup table is found by the first rule that applies:

1. the manifest names it in that volume's `labels`;
2. its name without extension equals the volume's name without extension
   (`brain_seg.txt` ↔ `brain_seg.nii.gz`);
3. otherwise the user is asked.

Formats:

- a FreeSurfer colour LUT: `index name r g b a`, one region per line, `#`
  comments, `r g b` 0–255;
- an ITK-SNAP label description file;
- a BIDS segmentation lookup table, `*_dseg.tsv`: tab-separated, with a
  header row of the official columns only. `index` and `name` are
  required; `abbreviation`, `color` (`#rrggbb`) and `mapping` are optional,
  and `n/a` means no value. A row without a colour gets an automatic one
  (index 0: black). `mapping` is read but not used. A `.tsv` with this
  header is taken as a lookup table, unless a package in the drop declares
  it a table.

A lookup table has no hierarchy, but some structure is read from the
region names. A name with `|` is read as a path, and sides come from names
such as `Left-…` and `ctx-lh-…`. For a real hierarchy, give the label volume
a region table in the manifest (`graph-format.md`, *Geometry*).

## The `.webm` volume format, briefly

A **lossy, compact** way to ship an **image volume** (T1, T2, colour DEC):
the volume as a VP9 video in a WebM container, one frame per coronal
section, plus a small JSON sidecar. It's much smaller than `.nii.gz`, and
the browser decodes it natively.

- **Two files:** `<name>.webm` and `<name>.webm.json` (`<name>.json` is
  also accepted). A `.webm` without its sidecar is refused.
- **Video:**
  - pixel format `gbrp` (no YUV conversion);
  - frame 0 is the most anterior section; row 0 is superior; column 0 is
    the subject's right;
  - **scalar values** are in the green channel, 8 bits, windowed to the
    volume's full range;
  - **colour volumes** use R, G and B directly.
- **Sidecar:**
  - `shape`: `[columns, frames, rows]`;
  - `channels`: 1 or 3;
  - `vox_mm`;
  - `Ab`: voxel → world, as four rows of three (the columns of the affine,
    then its translation);
  - `mn` and `mx`: the value range that 0–255 stands for;
  - `categorical`: false.
- **Made with** `tools/nifti_to_webm.py in.nii.gz out.webm`. It needs
  ffmpeg with libvpx-vp9, numpy, nibabel and Pillow.
- **Not for label volumes, masks or isosurface inputs.** Lossy coding
  shifts values: a changed label at an edge is a different region, and a
  surface follows exact values. Keep those as `.nii.gz`; their large
  uniform areas gzip very well anyway.

Full spec: `webm-format.md`.

## The `.dqz` format, briefly

A compressed `.tck` tractogram, about 4× smaller.

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
  parent by its `uuid`; list them with `role: "data"`.
- **Made with** `tck_quantize.py` (in a zip, as `<name>.tck.dqz`).

Full spec: `dqz-format.md`.

DSI Studio's `.tt.gz` uses the same idea: int8 steps of 1/32 voxel, with
one voxel → MNI matrix per file. It is read as it is.

## Reference: an existing builder

`tools/make_subject_zip.py` builds such a zip for one subject:

- anatomy converted to `.webm` with its sidecar, main scan first;
- label volumes as uint16 `.nii.gz`, each with a FreeSurfer-format LUT;
- the manifest written first;
- compressed files stored, text deflated.

It still writes `index.json`. A new builder should write `datapackage.json`
instead: the same volumes, as resources with `role` and `labels`, plus a
`mask` for the main scan where a brain mask exists.

## The older manifest: `index.json`

`index.json` (manifest version 1) is still read, so existing zips keep
working. **It gets no new features:** a default `mask`, `visible`, `space`,
tables and attribution exist only in `datapackage.json`. When a zip holds
both, `datapackage.json` is used.

```json
{
  "type": "tractogram.observer",
  "version": 1,
  "volumes": [
    { "file": "sub-01_T1w.webm",     "type": "anat",  "name": "T1w" },
    { "file": "sub-01_aparc.nii.gz", "type": "label", "name": "Desikan-Killiany", "labels": "sub-01_aparc_lut.txt" }
  ],
  "bundles": [
    { "file": "AF_L.tck.dqz", "name": "arcuate fasciculus, left", "color": "#e04030" }
  ],
  "view": { "bounds": "sub-01_T1w.webm", "from": "left" }
}
```

| key | meaning |
|---|---|
| `type` | required; must **start with** `"tractogram.observer"` |
| `version` | required; a number, at most `1` |
| `volumes[]` | `file` (required), `type` (`"anat"`, `"label"`, `"mask"`), `name`, `labels` (a file name) |
| `bundles[]` | `file` (required), `name`, `color` |
| `view` | as in `datapackage.json` |

At least one of `volumes` or `bundles` must be present and non-empty.

**Converting to `datapackage.json`:**

| `index.json` | `datapackage.json` |
|---|---|
| each entry of `volumes` and `bundles` | a resource, in the same order: `"path": file`, `"title": name`, and a `name` of your choice as its identifier |
| a volume's `type` | `role` |
| a volume's `labels` (a file name) | a resource for the lookup table, and `labels` set to that resource's `name` |
| a bundle's `color` | `color` |
| `view` | `view`, unchanged |
| `type` and `version` | dropped |
