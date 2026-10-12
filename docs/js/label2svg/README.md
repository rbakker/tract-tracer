# label2svg v2

Vectorizes a label image, such as a brain atlas slice, into smooth SVG paths, with
**one `<path>` per label**.

- **No gaps or overlaps.** Every boundary between two labels is traced and smoothed once, and
  both labels use that same curve (one of them in reverse).
- **Smooth but faithful.** Pixel staircases become straight lines and smooth curves. With the
  default tolerance (below 0.5 px), drawing the SVG back onto the pixel grid reproduces the input
  labels exactly; see *Accuracy*.
- **One accuracy setting**, in pixels, plus the output precision.
- **No dependencies.** About 650 lines of code for the core, plus 80 for the worker wrapper. Runs in a browser, in a Web Worker, or in Node 22+.

## Usage

```ts
import { Label2Svg, svgFromString } from "label2svg/client";

const vec = new Label2Svg(new Worker(new URL("label2svg/worker", import.meta.url), { type: "module" }));

// labels: one integer label id per pixel, row-major (any typed array), 0 = not drawn
const svg = await vec.fromLabels(labels, width, height, {
  colors: labelColors,   // { 1007: "#1BA696", … }, a Map, or (in-thread only) a function
});
container.replaceChildren(svgFromString(svg));
```

The same functions are available directly, without a worker:

```ts
import { traceLabels, labelsToSvg, labelsFromRGBA } from "label2svg";

const paths = traceLabels(labels, width, height);         // [{ label, d }], sorted by label
const svg   = labelsToSvg(labels, width, height, { colors });

// from a colour-coded canvas, with a colour table (unknown colours throw)
const { labels, colors } = labelsFromRGBA(imageData.data, w, h, { "#1BA696": 1007, … });
```

Each path looks like `<path data-label-id="1007" fill="#1BA696" stroke="#1BA696" d="…"/>`. Its
`d` holds every piece of the label (separate pieces and holes) as subpaths, filled with the
default nonzero rule. Paths can be drawn in any order, because holes are cut out rather than
painted over.

### Options

| Option | Default | Meaning |
|---|---|---|
| `tolerance` | `0.45` | Maximum distance, in px, between a boundary and the midpoints of the pixel edges it replaces. Below 0.5 the output is pixel-exact; higher values give smoother shapes but can merge or cross thin structures. |
| `precision` | `2` | Decimal places of coordinates, in pixel units. 2 → 0.005 px rounding, 1 → 0.05 px and ~20 % smaller files. |
| `background` | `0` | Label that is not drawn. Everything outside the image also counts as this label. |
| `colors` | generated | Fill per label: an object, a `Map` or a function (functions can't be passed to the worker). Unlisted labels get a generated colour. |
| `seamStroke` | `0.5` | Adds a stroke in the fill colour, this many px wide, to hide the hairline seams browsers anti-alias along shared edges. Grows the outer silhouette by half this width. `0` turns it off. |

## Coordinates and world units

Coordinates are in **pixel units**: pixel (x, y) covers the square x…x+1, y…y+1, and the SVG
has `viewBox="0 0 width height"`. Precision is therefore relative to the pixel, whether a pixel
is a nanometre or a millimetre. Place the SVG in world space with a transform in your app
(scale = voxel size, plus the slice origin), for example on a wrapping `<g>`.

Keep the file itself in pixel units. Browsers rasterize SVG geometry in 32-bit floats, so world
coordinates such as 3 400 000 nm would lose sub-pixel accuracy.

Rounding is done once per boundary, and every relative path step is computed from those rounded
points. Both labels sharing a boundary therefore use identical numbers, and rounding can't build
up along a path.

## How it works

1. **Trace boundaries along pixel edges** (`trace.ts`).
   - Corners where three or more labels meet are *junctions*.
   - Boundary edges form *chains* between junctions, or closed loops. Each chain has one label
     on its left and one on its right.
   - Each label's outline is assembled from its chains by following the boundary around every
     junction, which is exact with no distance matching.
   - Where a label touches itself only diagonally, one fixed rule decides whether it connects:
     foreground beats background, and otherwise the lower id wins. Both sides of a boundary
     therefore always agree on its shape.
2. **Straighten** (`fit.ts`, `taut`).
   - Each pixel edge on a chain gets a *portal*: a short segment across it, perpendicular to
     the edge.
   - The boundary must pass through every portal, within ¾ of the tolerance of the edge
     midpoint, and a string is pulled taut through all of them (the funnel algorithm).
   - Staircases become straight lines and curves become gentle polygons, and the string never
     reaches a pixel centre.
   - Junctions may move off their corner within the same limit, to where their boundaries
     naturally pass. All chains at a junction use the moved point.
3. **Fit curves** (`fit.ts`, `fitPolyline`). The taut string is fitted with straight lines and
   cubic Béziers (Schneider's algorithm), within the remaining ¼ of the tolerance. The curve is
   checked both at the data points and halfway between them.
4. **Write** (`index.ts`). One path per label, with relative commands and compact numbers.

## Accuracy

The test suite checks this on your slice, on synthetic images (Voronoi tilings, rings and holes,
1-px lines, checkerboards, per-pixel noise, single pixels, 2× and 3× enlargements of the slice),
and on 300 randomly generated adversarial images:

- **Topology.** For every label, the area enclosed by its traced outlines equals its pixel count
  exactly, and every chain is used once on each side.
- **Pixel-exact output.** The output paths are rasterized at the pixel centres, with the nonzero
  rule and fine Bézier flattening. At the default tolerance, every image reproduces its input
  labels exactly: no wrong pixels, no overlaps, no gaps.
- **Deviation.** The fitted curves stay within the tolerance (0.45 px) of the straightened
  boundary.
- **Browser.** In headless Chromium, the worker's output is identical to Node's, and rendered at
  1:1 every interior pixel matches the PNG.

At a tolerance of 0.8 px, the slice is 97.7 % pixel-exact and a few thin structures overlap.
That is why the default stays below 0.5.

## Size and speed (your slice and 2×/3× enlargements, warm)

| Image | Time | SVG | gzip |
|---|---|---|---|
| 456×320 | ~80 ms | 125 KB | 43 KB |
| 456×320, `precision: 1` | ~70 ms | 102 KB | 33 KB |
| 912×640 | ~100 ms | 234 KB | 48 KB |
| 1368×960 | ~170 ms | 285 KB | 54 KB |

## Development

```sh
npm install -D typescript esbuild
npm run build          # dist/ (ES modules + .d.ts)
npm run demo           # examples/demo.js + examples/worker.js; serve examples/ over HTTP
npm test               # topology/deviation checks + pixel-exact raster test on test/data
node test/edge.ts      # API edge cases
node test/browser.mjs  # needs playwright + chromium
python3 test/gen.py DIR [slice.png]; python3 test/gen_fuzz.py DIR   # more test images
```

Test images use a raw format (`"RGBA"`, u32 width, u32 height, pixels); `test/png2raw.py`
converts PNGs. The demo's `labels.json` is made up: ids 1000 + 7·n, names "Region n".
