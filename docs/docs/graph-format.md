# The graph format (version 1)

**Status: implemented** (reader: `js/graph-io.js`). It replaces the
markers format (version 1), which is no longer read.

A JSON file that puts **tables** in brain space: points with properties
(stimulation sites, electrode contacts, peaks), **links** between them (a
connectome), and the **regions** of a brain atlas, with their names, colors
and, optionally, their hierarchy. Every row can carry values for declared
**fields**; those values drive shape, color, size and width, show up on
mouse-over, and can be used to filter and recolor interactively.

The file is a **[Data Package](https://datapackage.org/)** (version 2), the
open standard of the Frictionless Data project. Everything specific to
brain space and to drawing is added as extra properties, which the standard
allows and its tools ignore. So the same file can be validated with
`frictionless validate`, and opened as tables in Python
(`frictionless.Package`) or R (the `frictionless` package).

## Recognizing the file

A `.json` file with a `resources` list, at least one of which has a
`geometry` (see below), or with `"$schema"` set to this format's profile,
`https://tractogram.observer/schema/graph-v1.json` (a JSON Schema extending
the Data Package one). Any file name; as the manifest of a zip it is
`datapackage.json` (see *The zip manifest* and `zip-package-spec.md`).

## Overview

```json
{
  "$schema": "…",
  "name": "stimulation-sites",
  "title": "Stimulation sites, 100 subjects",
  "resources": [
    { "name": "sites", "type": "table", "data": [ … ], "schema": { … },
      "geometry": { … }, "style": { … } },
    { "name": "links", "type": "table", "data": [ … ], "schema": { … },
      "style": { … } }
  ]
}
```

| key         | from      | meaning |
|-------------|-----------|---------|
| `name`      | standard  | identifier: lowercase, digits, `-` `_` `.` |
| `title`     | standard  | display name (default: the file name) |
| `description` | standard | shown in the MARKERS / ANATOMY tab |
| `resources` | standard  | the tables (and files, such as a label volume) |

## Tables

A table is a resource with `"type": "table"`, its rows inline in `data` (the
first row holds the column names) or in a CSV file next to the JSON
(`"path": "sites.csv"`):

```json
"data": [
  ["id", "x", "y", "z", "subject", "current", "response"],
  ["P001-01", -48.0, 12.0, 18.0, "P001", 4.5, "speech arrest"]
]
```

A list of objects (`[{"id": "P001-01", "x": -48.0, …}]`) is also allowed:
convenient for small hand-written files. `null` means "no value". A CSV
file is read with its first row as the header (RFC 4180 quoting); its
values are converted to the declared field types. The CSV must come in the
same drop or zip as the JSON (folders don't count: it is found by its file
name).

### Fields

`schema.fields` declares the columns (standard Table Schema):

| key           | from     | meaning |
|---------------|----------|---------|
| `name`        | standard | the column name |
| `type`        | standard | `number`, `integer`, `string`, `boolean`, `array`, … |
| `description` | standard | shown on mouse-over |
| `constraints` | standard | e.g. `{ "required": true, "unique": true }` |
| `categories`  | standard | the field's possible values: a list of values, or of objects `{ "value", "label" }` |
| `categoriesOrdered` | standard | `true`: the order of `categories` is meaningful (weak < medium < strong) |
| `unit`        | **ours** | shown after values, e.g. `"mA"` |
| `range`       | **ours** | `[min, max]` that color/size/width scales span; default: the data's own min/max. Fix it to keep files comparable. |

A field with `categories` is **categorical**: it can drive color, shape and
size, and acts as a filter. A category object may carry, besides `value` and
`label`, **ours**: `color` (`[r, g, b]` 0–255), `shape` (`sphere`, `cube`,
`diamond`, `cross`) and `size` (a factor). A number or integer field without
categories can drive a colormap, a size or a width. A string field without
categories is text: shown, never mapped.

A column that isn't declared is still read, its type guessed as in markers
version 1.

### Keys and references

Standard Table Schema:

- `schema.primaryKey`: the column(s) that identify a row, e.g. `["id"]`.
- `schema.foreignKeys`: a column holding the key of a row in another table,
  `{ "fields": ["from"], "reference": { "resource": "sites", "fields": ["id"] } }`.
  Without `resource`, the reference is to the same table: that is how a
  **hierarchy** is written (`parent` → the same table's key). The reference
  must be to the target's `primaryKey`. A row whose reference has an empty
  part (a top-level region: no `parent`, its `hemi` still set) refers to
  nothing; any other value must exist in the target, or the file is
  refused with a message naming the missing keys.

## Geometry (ours)

Where a table's rows are in space. A table without `geometry` isn't drawn
by itself (a link table is drawn through its references, see below).

**Points:**

```json
"geometry": { "point": ["x", "y", "z"], "space": "MNI152NLin2009cAsym",
              "coordinate_system": "RAS", "units": "mm" }
```

| key | meaning |
|-----|---------|
| `point` | the three columns with the position |
| `space` | informative; no transformation is applied. Also **ours** `space` on the package or a resource, as in `zip-package-spec.md` |
| `coordinate_system` | `"RAS"` (default) or `"LPS"` (x and y negated on reading) |
| `units` | `"mm"` (the only value for now) |

**Regions of a label volume:**

```json
"geometry": { "region": { "volume": "labels", "index": "index" } }
```

| key | meaning |
|-----|---------|
| `volume` | the name of a resource in the package that is a label volume (`.nii.gz`, a `path` next to the JSON) |
| `index` | the column with the region's value in that volume |

The table gives the label volume its **lookup table**: per value the
region's name — the column named by `style.name_column` (ours), else
`name`, else `label`, else the row's key — and color (`style.color_column`,
else `color`; a region without one takes its nearest group's color, else an
automatic one). A value used twice is an error. The table's hierarchy
appears in the PARCELLATION region list as groups that fold out; a group
puts all its regions in 3D at once, or draws them all solid or glass.
Values present in the volume but not in the table are listed under
"other".

The label volume is found by the `path` of the resource named in
`volume`: a loaded volume with that file name (in the same drop, or loaded
later).

*Not yet:* drawing a region table's rows as points (each at the region's
deepest point, a group at the union of its descendants), so that a link
table can connect atlas regions without coordinates.

## Links

A table without geometry whose rows reference two rows of a point table
(two foreign keys into it: the one on a field named `from`, else the first,
and the other) is a **link table**: each row is drawn as a line between its
two ends. Values in one direction get their own column, declared with
**ours** `direction` and `of`:

```json
{ "name": ">>strength", "type": "number", "direction": "from-to", "of": "strength" },
{ "name": "<<strength", "type": "number", "direction": "to-from", "of": "strength" }
```

Only the declaration counts: the names `>>strength` / `<<strength` are just
names (without `direction` they are ordinary columns). The taper: each
end's width from the value arriving there (`to` ← `from-to`, `from` ←
`to-from`); a missing value gives width 0 at that end.

## Style (ours)

On a table, as in markers version 1 (`style.markers` → the point or region
table's `style`, `style.links` → the link table's `style`):

```json
"style": { "shape_by": "site_type", "color_by": "response", "size_by": "current", "size_mm": [2, 8] }
```

`shape`, `shape_by`, `color`, `color_by`, `colormap`, `size_mm` / `size_px`,
`size_by`, `opacity`; for links `width_mm` / `width_px`, `width_by`, and
`color_by` also `"from.<field>"`, `"to.<field>"` or `"ends"`. Defaults as in
version 1.

New: `"color_column": "color"`, a column holding each row's own color
(`[r, g, b]` or `"#rrggbb"`), as an atlas gives every region its color; and
for a region table `"name_column"` (see *Geometry*).

## Example 1: markers

```json
{
  "name": "stimulation-sites",
  "resources": [{
    "name": "sites", "type": "table",
    "data": [["id", "x", "y", "z", "subject", "current", "response"],
             ["P001-01", -48.0, 12.0, 18.0, "P001", 4.5, "speech arrest"]],
    "schema": {
      "fields": [
        { "name": "id", "type": "string", "constraints": { "required": true, "unique": true } },
        { "name": "x", "type": "number" }, { "name": "y", "type": "number" }, { "name": "z", "type": "number" },
        { "name": "subject", "type": "string" },
        { "name": "current", "type": "number", "description": "stimulation current", "unit": "mA", "range": [0, 10] },
        { "name": "response", "type": "string",
          "categories": [{ "value": "speech arrest", "label": "Speech arrest", "color": [230, 60, 40] },
                         { "value": "none", "label": "No response", "color": [120, 120, 120] }] }
      ],
      "primaryKey": ["id"]
    },
    "geometry": { "point": ["x", "y", "z"], "space": "MNI152NLin2009cAsym" },
    "style": { "color_by": "response", "size_by": "current", "size_mm": [2, 6] }
  }]
}
```

## Example 2: a brain atlas

```json
{
  "name": "example-atlas",
  "resources": [
    { "name": "labels", "path": "example-atlas_labels.nii.gz", "mediatype": "application/x-nifti" },
    { "name": "regions", "type": "table",
      "data": [["index", "acr", "hemi", "name", "parent", "color"],
               [null, "CTX", "L", "cerebral cortex",      null,  "#b0b0b0"],
               [null, "CTX", "R", "cerebral cortex",      null,  "#b0b0b0"],
               [1,    "M1",  "L", "primary motor cortex", "CTX", "#e04030"],
               [2,    "M1",  "R", "primary motor cortex", "CTX", "#e04030"]],
      "schema": {
        "fields": [
          { "name": "index", "type": "integer", "description": "value in the label volume" },
          { "name": "acr", "type": "string", "constraints": { "required": true } },
          { "name": "hemi", "type": "string", "categories": ["L", "R"], "constraints": { "required": true } },
          { "name": "name", "type": "string" },
          { "name": "parent", "type": "string" },
          { "name": "color", "type": "string" }
        ],
        "primaryKey": ["acr", "hemi"],
        "foreignKeys": [{ "fields": ["parent", "hemi"], "reference": { "fields": ["acr", "hemi"] } }]
      },
      "geometry": { "region": { "volume": "labels", "index": "index" } },
      "style": { "color_column": "color" }
    }
  ]
}
```

A row without `index` (CTX) is a group: it has no voxels of its own and
consists of its descendants. `parent` is written as the parent's acronym,
not its index.

The key is **composite**: `["acr", "hemi"]` — the pair identifies a region,
so M1 left and M1 right are two rows with the same acronym. The reference to
the parent uses the same pair, `["parent", "hemi"]`: a region's parent is the
group with that acronym *on the same side*. Every key column needs a value,
so a structure that is one region across the midline gets its own value,
e.g. `"hemi": "M"`. `hemi` is otherwise an ordinary field: nothing in the
format depends on its name. An atlas without sides simply has
`"primaryKey": ["acr"]`. The viewer shows a composite key joined with `_`
(`M1_L`), and a reference from another table (a marker's region) gives both
columns.

## The simple route (no graph file)

A label volume with a lookup table stays the simplest way to load an atlas,
and keeps working without any graph file:

- a **FreeSurfer** or **ITK-SNAP** LUT, or a **BIDS** `*_dseg.tsv` with
  its official columns (`index`, `name`, optional `abbreviation`, `color`,
  `mapping`; see `zip-package-spec.md`, *Lookup tables*).

These have no hierarchy. Two conveniences derive some structure from the
names:

1. **Left and right** inferred from the names: `Left-…` / `Right-…`,
   `lh-` / `rh-` (also inside, as in `ctx-lh-precentral`), and a trailing
   `_L` / `_R`, ` L` / ` R` or `(L)` / `(R)`. The region list groups by side
   (a top level *left* / *right*; the rest as it is) — when both sides
   occur.
2. **A path in the name**: `Forebrain|Cerebral cortex|Frontal lobe|M1` is
   read as a hierarchy; the last part is the region's name, the parts before
   it its groups (created as needed, and shared between regions with the
   same path).

## Attribution

Data copied from elsewhere (an atlas, published tracts, a template) keeps
its credit with the standard Data Package properties — on the **package**
and on **each resource**; a resource's own override the package's:

| property | where | meaning |
|---|---|---|
| `sources` | package, resource | where it came from: `[{ "title", "path" (a URL, e.g. a DOI link), "email", "version" }]` |
| `licenses` | package, resource | the terms: `[{ "name" (an SPDX / Open Definition id, e.g. `CC-BY-4.0`), "path" (the license's URL), "title" }]` |
| `contributors` | package | who made the package: `[{ "title", "givenName", "familyName", "email", "path", "organization", "roles": ["author", …] }]` |
| `id` | package | a globally unique identifier, typically its DOI (`https://doi.org/…`) |
| `version`, `created`, `homepage` | package | as in the standard |
| **ours** `citation` | package, resource | the preferred citation, as text |

```json
{ "name": "slant-seg", "path": "t1_seg_dwirot.nii.gz", "role": "label", "labels": "slant-lut",
  "sources": [{ "title": "SLANT whole-brain segmentation (Huo et al., 2019)",
                "path": "https://doi.org/10.1016/j.neuroimage.2019.03.041" }],
  "licenses": [{ "name": "…", "path": "…" }] }
```

**Recommended:** every resource copied from a published source carries its
`sources` (with the DOI) and `licenses`; a package that will be shared
carries `contributors`, `licenses` and a `citation`. The viewer shows them
in the ⓘ of a volume, of the tractogram and of a marker set — the item's
own first, then its package's — with links to the sources and licenses.
Data taken from a BIDS dataset maps one to one: `License` → `licenses`,
`Authors` → `contributors`, `HowToAcknowledge` → `citation`,
`ReferencesAndLinks` / `DatasetDOI` → `sources` / `id`.

## The zip manifest: datapackage.json

A graph file named `datapackage.json` inside a zip (or a drop of files) is
also the zip's **manifest**: its file resources are the zip's volumes and
tractograms, in load order, and its tables are read as in any graph file.
The keys for those file resources (`role`, `labels`, `mask`, `color`,
`visible`), the package's `space` and its opening `view` are described in
`zip-package-spec.md`. That page also covers the older `index.json`, which
is still read.

## Later

Kept out of this draft on purpose: tables taken from another file (an atlas
shared by many datasets), references holding a list of keys (many-to-many),
a region's position inherited through a reference (an injection placed in its
atlas region), and several label volumes in one atlas (hemispheres or
subjects as separate files).
