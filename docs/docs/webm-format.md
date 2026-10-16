# The WebM volume format (`.webm` + `.webm.json`)

A 3D volume stored as a **video**: one frame per coronal section, compressed
with the VP9 codec in a WebM container, plus a small JSON **sidecar** with
what the video can't hold (grid size, voxel-to-world matrix, value range).
Video codecs compress image stacks far better than gzip does, so a large
anatomical volume (T1, T2, …) is much smaller than as `.nii.gz`, and
browsers decode it themselves.

The format is lossy by default: it's meant for anatomy that is looked at,
not measured. Label volumes and exact values belong in NIfTI.

Made by [`nifti_to_webm.py`](https://github.com/rbakker/tract-tracer/blob/main/tools/nifti_to_webm.py) (see *Making one*); the examples below use
`T2w.webm` with `T2w.webm.json`.

## The files

| file | contents |
|------|----------|
| `<name>.webm` | the video: VP9 in WebM |
| `<name>.webm.json` | the sidecar (`<name>.json` is also accepted) |

The two are paired by name when they are loaded together (dropped, picked,
or in the same zip). A `.webm` without its sidecar is refused: the video
alone has no position in space and no value range.

## The video

| property | value |
|----------|-------|
| codec, container | VP9 in WebM |
| pixel format | `gbrp`: planar G, B, R, full range (0–255), **no YUV** conversion (`-color_range 2`, BT.709 tags) |
| frames | one per coronal section, `shape[1]` frames |
| frame size | `shape[0]` wide × `shape[2]` high |
| quality | `crf` 10 (default), or lossless |
| frame rate | 10 fps: required by the container, has no meaning |
| keyframes | every 30 frames (`-g 30`) |

`gbrp` is used because it is the one format found to decode identically in
Firefox and Chromium; YUV formats shift values through their colour matrix.

### Frame layout

The volume is first reoriented to RAS (axes swapped and flipped as needed,
never resampled). Then:

- **frame 0** is the most **anterior** section, frames run front to back;
- **row 0** (top of the frame) is **superior**;
- **column 0** (left of the frame) is the subject's **right** (radiological
  convention: the subject seen from the front).

### Values

**Scalar volumes** (`channels: 1`): the value is in the **green** channel;
red and blue are 0. (One channel instead of three copies makes the file
more than 2× smaller, and VP9 treats the green plane best.) The value is
the original intensity windowed to the volume's full range and quantized to
8 bits:

    G = round( (v − mn) / (mx − mn) × 255 )        v ≈ mn + G / 255 × (mx − mn)

**Colour volumes** (`channels: 3`, e.g. direction-encoded colour from
`tensor2metric -vector -modulate FA`, or NIfTI RGB24): red, green and blue
are the colour itself, `round(clip(c, 0, 1) × 255)`, with no windowing (the
values are already meaningfully scaled). Integer input is first divided by
its type's full scale; vector components are taken as absolute values.

**Label volumes** (`categorical: true`): the label value itself goes into
the green channel, so labels must be 0–255. Only use this with
`--lossless`: lossy compression changes values at region edges, and a
changed label is a different region.

## The sidecar

```json
{
  "shape": [128, 160, 128],
  "channels": 1,
  "frame_order": "coronal, front_to_back (frame 0 = most anterior)",
  "frame_layout": "row0=superior, col0=anatomical_right (radiological convention)",
  "vox_mm": [0.5, 0.5, 0.5],
  "Ab": [[-0.5, 0, 0], [0, -0.5, 0], [0, 0, -0.5], [31.75, 39.75, 31.75]],
  "mn": 0.0,
  "mx": 1532.7,
  "categorical": false,
  "codec": "vp9",
  "pix_fmt": "yuv420p",
  "lossless": false,
  "crf": 10
}
```

| key | read by the app | meaning |
|-----|:---:|---------|
| `shape` | ✓ | `[columns, frames, rows]`: the grid size in voxels |
| `channels` | ✓ | `1` scalar (value in green), `3` colour (RGB) |
| `vox_mm` | ✓ | voxel size in mm along the three grid axes |
| `Ab` | ✓ | voxel → world (RAS, mm), see below |
| `mn`, `mx` | ✓ | the original value range that 0–255 stands for (scalar); not used for colour or labels |
| `categorical` | ✓ | `true`: green holds label values, read as they are |
| `frame_order`, `frame_layout` | | informative: the layout described above |
| `codec` | | `"vp9"` |
| `pix_fmt` | | informative; see the note below |
| `lossless`, `crf` | | how it was encoded (`crf` is `null` when lossless) |

The frame size is checked against `shape` (a mismatch is only warned
about); the number of frames should equal `shape[1]`.

### `Ab`: voxel to world

Four rows of three numbers. For the voxel at **column `i`, frame `j`, row
`k`** (all from 0):

    world = i·Ab[0] + j·Ab[1] + k·Ab[2] + Ab[3]

So `Ab[0]`, `Ab[1]`, `Ab[2]` are the world-space steps (mm) of one column,
one frame and one row, and `Ab[3]` is the position of voxel (0, 0, 0). This
is the transpose of the usual 4×4 matrix's first three rows: its columns,
then its translation. It already includes the reorientation and flips of
the frame layout, so it maps video pixels straight to scanner space.

## Making one

    python nifti_to_webm.py T2w.nii.gz T2w.webm                 # lossy, crf 10
    python nifti_to_webm.py labels.nii.gz labels.webm --categorical --lossless
    python nifti_to_webm.py dec.nii.gz dec.webm                  # colour: detected automatically

Needs `ffmpeg` with `libvpx-vp9` on the path, and the Python packages
`numpy`, `nibabel` and `Pillow`. Options: `--categorical` (label values,
see above), `--lossless`, `--yuv444` (recorded in `pix_fmt` only, see the
note). [`make_subject_zip.py`](https://github.com/rbakker/tract-tracer/blob/main/tools/make_subject_zip.py) converts a subject's anatomy this way.

## Notes

- `pix_fmt` in the sidecar says `yuv420p` (or `yuv444p` with `--yuv444`),
  but every file is actually encoded as `gbrp`. The field is left over from
  an earlier version of the converter; readers should ignore it.
- The converter doesn't refuse `--categorical` without `--lossless`.
