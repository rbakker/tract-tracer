# The `.dqz` format

`.dqz` is a compressed representation of `.tck` tractography streamline
data. It shrinks file size substantially by exploiting a property that
tractography output has by construction — points along a streamline are
laid down at a roughly constant step size — while keeping reconstruction
error small, predictable, and mathematically bounded per streamline.

Reference implementation: [`tck_quantize.py`](https://github.com/rbakker/tract-tracer/blob/main/tools/tck_quantize.py)

## How it works

Tractography algorithms generate a streamline by integrating along a
direction field in fixed-size steps, so consecutive points on the same
streamline are almost always close together. `.dqz` turns that
regularity directly into a compact, per-streamline binary encoding.

For each streamline, independently:

1. **The first point is stored exactly**, as a 32-bit float triple. This
   is the streamline's anchor — every other point is expressed relative
   to it.

2. **The longest segment in the streamline is found.** A segment here
   means the straight-line distance between two consecutive points.
   Call this length `max_seg`.

3. **A quantization unit is derived from it**: `Q = max_seg / 127`. This
   is the smallest distance the format can represent along any axis for
   this particular streamline.

4. **Every point is independently rounded onto the Q-grid.** Each point,
   measured relative to the streamline's start, is divided by `Q` and
   rounded to the nearest integer. This produces a sequence of integer
   coordinate triples — a discretized version of the streamline, with
   each point snapped to the nearest point on a 3D grid of spacing `Q`.

5. **Consecutive grid points are stored as differences, not absolute
   values.** Because every segment in the streamline is, by definition,
   no longer than `max_seg`, no single-axis difference between two
   consecutive grid points can exceed 127 grid units in magnitude. That
   guarantee is what lets each difference be stored in a single signed
   byte (`int8`, range −127…127) — three bytes per point, regardless of
   how far apart the two points are in absolute terms or how long the
   streamline is.

Decoding reverses this exactly: starting from the stored first point,
each streamline is reconstructed by cumulatively summing the stored
byte differences and scaling by `Q`.

### Why the divisor is 127, not 128

An axis-aligned segment exactly as long as `max_seg` produces a
difference of exactly `128` grid units under a divisor of 128 —
one more than a signed byte can hold (`int8`'s positive range tops out
at 127). Using 127 as the divisor instead guarantees every possible
difference fits inside `int8` with no exceptions, at a completely
negligible cost: about 0.8% less precision than a literal divide-by-128
would have given.

## Why reconstruction error does not accumulate

The order of operations above is the whole reason this scheme works:
**every point is quantized once, independently, before any differencing
happens.** Nothing in the encoding process ever predicts a point from
the previous *reconstructed* point and stores the leftover error —  that
approach would compound a small rounding error at every single step,
producing drift that grows the further you get from the start of the
streamline.

Here, the byte stored between two points is simply the arithmetic
difference of two numbers that have *already* been rounded. Summing
these differences back up during decoding is exact integer arithmetic —
it recovers precisely the same rounded grid coordinate each point was
independently snapped to in step 4, no matter how many points came
before it.

A short worked example makes this concrete. Suppose three consecutive
points along one axis, in millimeters, are `0.00`, `10.04`, and `20.11`,
and `Q` happens to be `0.10` for this streamline:

| point | value | value / Q | rounded (grid units) |
| ----- | ----- | --------- | -------------------- |
| P0    | 0.00  | 0.0       | 0                    |
| P1    | 10.04 | 100.4     | 100                  |
| P2    | 20.11 | 201.1     | 201                  |

The stored differences are `100 − 0 = 100` and `201 − 100 = 101` — both
comfortably within a signed byte. Decoding sums them back up:
`0, 0+100=100, 100+101=201`, exactly recovering the rounded grid values
`0, 100, 201` from the table above. The reconstructed positions are
`0.00mm`, `10.00mm`, `20.10mm` — each one off from the true value by
whatever that single point's own rounding to the nearest `0.10mm` grid
line introduced, and by nothing more. The error at P2 has no memory of
the error at P1.

## Why maximum deviation is set by the single longest segment

`Q` is one fixed value for an entire streamline, and it is derived
directly from that streamline's `max_seg`. Rounding to the nearest
multiple of `Q` introduces a worst-case error of half a quantization
step on each axis (`Q / 2`). Combining all three axes, the largest
possible 3D reconstruction error for any single point is:

```
max_error = (√3 / 2) × Q ≈ 0.87 × Q = 0.87 × (max_seg / 127)
```

`max_seg / 127` alone (without the `√3/2` factor) is a clean, slightly
more conservative bound that is always safely above the true worst
case, and a convenient one to reason about directly: **no point in a
streamline can ever be reconstructed further off than the length of
that streamline's own single longest segment, divided by 127.**

Because `Q` has to be large enough to let the *longest* segment's
difference still fit in a signed byte, it is sized for that one segment
— even if every other segment in the streamline is much shorter. A
streamline with consistently tight point spacing and only a single
unusually long gap gets its overall precision set by that one gap, not
by its typical spacing. In practice, real tractography streamlines
generated with a fixed step size have very little variation in segment
length in the first place, so this rarely matters — but it is the exact
mechanism that determines precision, worth understanding if a
streamline's segment lengths are unusually irregular.

## File layout

```
offset  size      contents
0       8 bytes   magic: "TCKDQZ01"
8       4 bytes   header_len (uint32, little-endian)
12      header_len bytes   UTF-8 JSON header (see below)
...     per-streamline records, back to back, no padding (see below)
```

### JSON header

```json
{
  "divisor": 127,
  "n_streamlines": 5735,
  "source_header": { }
}
```

- `divisor` — the quantization divisor used for every streamline in this
  file (127 unless a smaller value was explicitly requested).
- `n_streamlines` — how many per-streamline records follow.
- `uuid` — a randomly generated identifier (e.g. UUIDv4) for this specific
  file. Optional, but strongly recommended: it is what lets a *child* data
  file (see [Per-vertex and per-streamline data files](#per-vertex-and-per-streamline-data-files-dqz-children)
  below) verify it was generated against this exact `.dqz`, and what lets a
  viewer auto-apply per-vertex or per-streamline data dropped in alongside
  it. `uuid` is not derived from the file's contents — copying a `.dqz`
  file preserves its `uuid` unchanged — it only distinguishes one encode
  from another. `parent` is a reserved header key used exclusively by
  child data files to reference this field; a plain geometry `.dqz` never
  has a `parent` field itself.
- `source_header` — the custom fields carried by the original `.tck`
  file's own header, if any (anything beyond the handful of fields every
  `.tck` file needs regardless of content, which are not meaningful to
  preserve since they describe the file itself rather than the data —
  those are regenerated fresh whenever a `.dqz` file is decoded back
  into a `.tck`). Preserving this means decoding a `.dqz` file recovers
  not just the original geometry, to within the quantization error
  described above, but any metadata the source file carried too.

### Per-streamline record

```
size            contents
4 bytes         n_points (uint32)
                — if n_points == 0, the record ends here
12 bytes        start (3 × float32: x, y, z of the first point)
4 bytes         Q (float32)
(n_points-1)×3  deltas (int8 triples — one per point after the first)
                — omitted entirely if n_points < 2
```

A streamline whose points all coincide, or which has fewer than two
points, is stored with `Q = 0`; on decoding, every point is simply set
to the stored start.

## File naming

A compressed file is named after the original, with `.dqz` appended —
`Left_CST.tck` becomes `Left_CST.tck.dqz`. The original `.tck` extension
is deliberately kept intact rather than replaced: `.dqz` files share
none of TCK's byte layout, so a name that could be mistaken for a
regular `.tck` risks something trying to open it as one.

Child data files (below) also use the `.dqz` extension, with no further
extension layered on. They are told apart from geometry files, and from
each other, by header inspection rather than by filename — see
[Per-vertex and per-streamline data files](#per-vertex-and-per-streamline-data-files-dqz-children).

## Per-vertex and per-streamline data files (`.dqz` children)

A `.dqz` geometry file stores only streamline positions. Colors, scalar
measurements (CSD amplitude, FA, curvature, …), and categorical labels
(tissue type, bundle membership, …) are stored separately, in one or more
*child* files, each carrying exactly one named field.

A child file references its parent by `uuid` (see above), so a viewer that
already has the parent loaded can recognize a dropped-in child, match it,
and apply it automatically — show the field's name/description, and, for
categorical data, render a legend — with no explicit pairing step from the
user. A parent's `uuid` is optional; a child cannot be verified against a
parent that doesn't have one. A child whose `parent` doesn't match any
currently loaded `.dqz`'s `uuid` should be rejected, or held as
"unmatched," by a decoder — never silently applied to the wrong geometry.

### File naming

Child files use the same `.dqz` extension as their parent — there is no
third extension layered on. The stem is entirely up to whoever generates
the file, e.g. `Left_CST.tck.csd_amplitude.dqz` or
`whole_brain.tck.bundle.dqz`. A decoder identifies a child by its magic
and header, not by its filename.

### File layout

```
offset  size      contents
0       8 bytes   magic: "DQZDATA1"
8       4 bytes   header_len (uint32, little-endian)
12      header_len bytes   UTF-8 JSON header (see below)
...     data records, back to back, no padding (see below)
```

### JSON header

```json
{
  "parent": "3f9c2e1a-7b4d-4e2f-9a1c-8d6b0f2e5c77",
  "n_streamlines": 5735,
  "name": "csd_amplitude",
  "description": "CSD peak amplitude sampled along each streamline",
  "kind": "scaled",
  "scope": "per_vertex",
  "dtype": "uint8",
  "value_min": 0.0,
  "value_max": 0.842,
  "legend": null
}
```

- `parent` — the `uuid` of the `.dqz` geometry file this data belongs to.
  The one reserved header key across the whole `.dqz` family: a plain
  geometry `.dqz` never has a `parent` field, and any file that does is a
  child, regardless of its name.
- `n_streamlines` — must match the parent's count; a cheap first
  consistency check before comparing `parent` against a loaded file's
  `uuid`.
- `name` — short field identifier, e.g. `"csd_amplitude"`,
  `"tissue_label"`, `"bundle"`. Free text, for display only.
- `description` — optional, free text, for display only.
- `kind` — one of:
  - `"raw"` — the stored value *is* the value, no transform. The natural
    fit for `float32`, or for integer data that's already meaningfully
    scaled (counts, indices).
  - `"scaled"` — the stored integer is a linear quantization of a
    continuous value: `value = value_min + (code / max_code) ×
    (value_max − value_min)`, where `max_code` is `255` for `uint8`,
    `65535` for `uint16`, and so on. `value_min`/`value_max` are
    required. Not meaningful with `dtype: "float32"` — there's no byte
    budget to save by scaling a value already stored at full width.
  - `"categorical"` — the stored integer is a code, not a measurement;
    interpolating or averaging it is meaningless. `value_min`/`value_max`
    are not required and are typically omitted.
- `scope` — one of:
  - `"per_vertex"` — one value per streamline point, e.g. FA sampled
    along the tract, or a tissue-type label per point.
  - `"per_streamline"` — one value for the whole streamline, e.g. a
    bundle label or a cluster ID, for a whole-brain tractogram segmented
    into bundles after tracking. (Bundles tracked and stored as separate
    `.tck`/`.dqz` files to begin with need no child file for this — the
    bundle membership is already the file.)
- `dtype` — `"uint8"`, `"int8"`, `"uint16"`, `"int16"`, or `"float32"`.
  Fixed for the whole file.
- `legend` — optional array of `{value, name, color}` entries (`color` as
  `[r, g, b]`, 0–255), mainly for `kind: "categorical"`. Partial or
  entirely absent legends are fine — a decoder falls back to the raw
  code for any value with no matching entry.

### Data records

The record shape depends on `scope`:

**`scope: "per_vertex"`** — one variable-length record per streamline,
mirroring the parent's own per-streamline records:

```
size                    contents
4 bytes                 n_points (uint32)
                        — if n_points == 0, record ends here; must match
                          the parent streamline's own n_points otherwise
n_points × elem_size    values, one per vertex, in the file's dtype
```

**`scope: "per_streamline"`** — a single flat array, one value per
streamline, in streamline order, no per-record framing:

```
size                        contents
n_streamlines × elem_size   values, one per streamline, in the file's dtype
```

`elem_size` is 1 for `uint8`/`int8`, 2 for `uint16`/`int16`, 4 for
`float32`.

### Bundle labels from whole-brain tractography

A whole-brain tractogram classified into bundles after tracking is exactly
a `kind: "categorical"`, `scope: "per_streamline"` child: one byte (or
wider, past 255 bundles) per streamline, plus a `legend` mapping each code
to a bundle name and display color.
