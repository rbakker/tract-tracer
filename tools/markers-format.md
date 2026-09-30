# The markers format (`tractogram.observer.markers`, version 1)

A JSON file that places **markers** (points: spheres, diamonds, …) at brain
locations and, optionally, **links** between them (tapered lines, e.g. a
directed connectome). Every marker and link can carry values for a declared
list of **properties**; those values drive shape, color, size and width, show
up on mouse-over, and can be used to filter and recolor interactively.

Examples: `markers-example.json` (stimulation sites of 100 subjects),
`markers-connectome-example.json` (60-region directed connectome).

## Recognizing the file

A `.json` file whose top-level `"type"` is `"tractogram.observer.markers"`.
The file name doesn't matter.

## Top level

| key                 | required | meaning |
|---------------------|----------|---------|
| `type`              | yes      | `"tractogram.observer.markers"` |
| `version`           | yes      | `1` |
| `name`              | no       | display name (default: the file name) |
| `space`             | no       | informative, e.g. `"MNI152NLin2009cAsym"`; no transformation is applied |
| `coordinate_system` | no       | `"RAS"` (default) or `"LPS"` (x and y are negated on reading) |
| `units`             | no       | `"mm"` (the only value in version 1) |
| `properties`        | no       | the declared properties, see below |
| `style`             | no       | how markers and links are drawn, see below |
| `markers`           | yes      | the marker table |
| `links`             | no       | the link table |

## Properties

`properties` maps a property name to its declaration. The same list serves
markers and links; each table uses the properties it has columns for.

| key           | for         | meaning |
|---------------|-------------|---------|
| `type`        | all         | `"number"`, `"integer"`, `"categorical"` or `"text"` |
| `description` | all         | shown on mouse-over and in the FILE panel |
| `unit`        | number, integer | shown after values, e.g. `"mA"` |
| `range`       | number, integer | `[min, max]` that color/size/width scales span; default: the data's own min/max. Fix it to keep several files comparable. |
| `ordered`     | categorical | `true`: the legend order is meaningful (weak < medium < strong) |
| `legend`      | categorical | list of entries, see below |

- **number / integer** — can be mapped to a colormap, a size or a width.
  Integers are shown without decimals.
- **categorical** — a value from a fixed set (strings or numbers). Can be
  mapped to color, shape and size, and used as a filter.
- **text** — free text; shown on mouse-over, never mapped to anything.

### Legend entries (categorical)

```json
{ "value": "speech arrest", "name": "Speech arrest", "color": [230, 60, 40], "shape": "sphere", "size": 1.0 }
```

Only `value` is required. `name` defaults to the value; `color` is `[r, g, b]`
0–255; `shape` is one of the shapes below; `size` multiplies the base size (or
width). Values that occur in the data but have no legend entry — or a
categorical property without any legend, e.g. 100 subject IDs — get
automatic colors, the default shape and size 1.

## Tables

Markers and links are tables. The compact form, recommended for anything
larger than a handful of rows:

```json
"markers": {
  "columns": ["id", "x", "y", "z", "subject", "response"],
  "rows": [ ["P001-01", -48.0, 12.0, 18.0, "P001", "speech arrest"], … ]
}
```

or, equivalently, a list of objects (convenient for small hand-written files):

```json
"markers": [ { "id": "P001-01", "x": -48.0, "y": 12.0, "z": 18.0, "subject": "P001", "response": "speech arrest" } ]
```

`null` (or a missing key) means "no value".

A column that isn't declared in `properties` is still read: its type is
guessed (all numbers → `number`, or `integer` if all whole; otherwise
`categorical` with up to 50 distinct values, else `text`), and the viewer
notes it. Declaring properties is still recommended — it's the only way to
give a range, unit, legend or order.

### Marker table

| column                | required | meaning |
|-----------------------|----------|---------|
| `id`                  | yes      | unique within the file; links refer to it |
| `x`, `y`, `z`         | yes      | position in mm, in `coordinate_system` |
| any declared property | no       | the marker's value |

### Link table

| column                  | required | meaning |
|-------------------------|----------|---------|
| `from`, `to`            | yes      | marker ids |
| `name` (a property)     | no       | a value for the link as a whole |
| `>>name`                | no       | the value in the direction `from` → `to` |
| `<<name`                | no       | the value in the direction `to` → `from` |

Both directions of a pair go in ONE row: e.g. `">>strength"` and
`"<<strength"`. `name` must be a declared property; the prefix only says
which direction the value belongs to. A `null` means that direction doesn't
exist. Rows referring to an unknown marker id are an error.

## Style

```json
"style": {
  "markers": { "shape_by": "site_type", "color_by": "response", "size_by": "hub_strength", "size_mm": [2, 8] },
  "links":   { "color_by": "from.network", "width_by": "strength", "width_mm": [0.2, 2.5] }
}
```

### `style.markers`

| key                   | meaning |
|-----------------------|---------|
| `shape`               | fixed shape: `"sphere"` (default), `"cube"`, `"diamond"`, `"cross"` |
| `shape_by`            | a categorical property; shapes from its legend |
| `color`               | fixed color `[r, g, b]` 0–255 |
| `color_by`            | a property: categorical → legend colors; number/integer → colormap over its `range` |
| `colormap`            | for a numeric `color_by`: `"viridis"` (default), `"jet"`, `"gray"`, `"hot"` or `"coolwarm"` |
| `size_mm` / `size_px` | size in mm (world) or in screen pixels: a number, or `[min, max]` together with a numeric `size_by` |
| `size_by`             | a property: number/integer → linear over its `range` onto `[min, max]`; categorical → the legend's `size` factors times the base size |
| `opacity`             | 0–1, default 1 |

### `style.links`

Links are drawn as tapered lines between the centers of their two markers
(the markers cover the ends).

| key                     | meaning |
|-------------------------|---------|
| `color`                 | fixed color |
| `color_by`              | a property of the link; or `"from.<property>"` / `"to.<property>"` — the property of the marker at that end; or `"ends"` — blend from the `from` marker's color to the `to` marker's |
| `width_mm` / `width_px` | a number, or `[min, max]` together with a numeric `width_by` |
| `width_by`              | a property of the link |
| `opacity`               | 0–1, default 1 |

**Directional values and the taper.** When `width_by` names a property the
link table has directional columns for, the width at each end comes from the
value flowing *into* that end:

- width at the **`to`** end ← `>>value` (from → to),
- width at the **`from`** end ← `<<value` (to → from).

So a line widens toward where the stronger connection arrives: strong
`>>strength` with weak `<<strength` looks like a `<` opening toward `to`. A
missing direction (`null`) gives width 0 at that end (a point); equal values
give a line of constant width. A plain (non-directional) column gives
constant width. The same rule applies to a directional `color_by`: each end
gets the color of the value arriving there, blended along the line.

## Defaults and missing values

- No size or width given: markers are 10 px, links 2 px wide — screen
  sizes, so the defaults work equally well for a mouse brain and a human
  one. Give `size_mm` / `width_mm` when size should mean something in the
  brain (a 4 mm stimulation site).
- No shape or color given: white spheres; links colored `"ends"`.
- A marker without a value for the `color_by` property is grey; without a
  `size_by` value, base size; without a `shape_by` value, the default shape.
- A numeric value outside `range` is clamped to it.

## Viewer behavior (not part of the format)

For orientation only: mouse-over shows a marker's or link's values; clicking
a property there recolors all markers (or links) by it, with the hovered
marker's category highlighted; categorical properties act as filters in the
FILE panel; a numeric property's window (APPLY FROM/TO) fades values outside
it (for link widths: a threshold). A link is only shown when both its
markers are.

## Versioning

Anything beyond this — per-marker overrides, curved links, time series — is
for a version 2; a version-1 reader rejects a higher `version`.
