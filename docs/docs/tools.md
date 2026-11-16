# Tools

A *tool* is a task-specific part of tractogram.observer: it lives in the
TOOLS tab, one at a time, picked in the tool selector (type to find it) or
opened with `?tool=<id>` in the address bar or from the ☰ menu. Tools keep
the main tabs uncluttered: anything that is only used for certain
applications belongs in a tool.

There are two kinds:

- **built in** — its controls are a `.tool-pane[data-tool=<id>]` in
  `index.html` and its code is there too (Screenshot / movie, Session);
- **a module** — `tools/<id>.js`, loaded the first time the tool is picked
  (or when something else needs it, such as a volume row's mark). It talks
  to the app only through the *host* object it gets. New tools are
  modules.

Both have an entry in `TOOLS` (index.html, section 11c).

## The entry

```js
{ id: 'dwi-qc', aliases: ['qc', 'dwi'], title: 'DWI quality control',
  desc: 'checks of a diffusion series and its gradient table before processing',
  keywords: 'dwi diffusion gradient bval bvec …',
  module: './tools/dwi-qc.js',
  ready: () => volumes.some(v => v.grad && v.grad.bvals && v.grad.bvecs) }
```

| key | meaning |
|---|---|
| `id` | short, lower case, hyphens: the name in `?tool=` and in the menu's `data-tool` |
| `aliases` | other names `?tool=` accepts |
| `title`, `desc` | the list shows them; `desc` is one line |
| `keywords` | what typing in the selector matches, besides id, title and desc |
| `module` | the module's path (a module tool) |
| `ready()` | a module tool: whether what it works on is loaded — the `● ready` mark in the list, cheap, computed by the host without loading the module |
| `shown()` | a built-in tool: draws its live parts (when shown, and when what's loaded changes) |
| `activate()`, `deactivate()`, `state()` | optional on a built-in tool, as for a module (below) |

The ☰ menu lists a tool with `<button class="mm-sub" data-page="tools"
data-tool="<id>">`; `data-tool=""` opens the list of all tools. Not every
tool needs a menu entry.

## The module

`tools/<id>.js` exports as default an object:

```js
export default {
  id: 'dwi-qc',
  init(host) {},          // once, when loaded: keep the host
  needs() {},             // → [[st, text]]: what it works on — ✓ there, ✗ missing, – optional and missing
  draw(el) {},            // its controls into el (emptied first by the tool); called when shown and when what's loaded changes
  open(opts) {},          // opened for something: openTool(id, opts) — { vol } for the quality control
  activate() {},          // became the chosen tool: claim panels, mouse, keys
  away() {},              // optional: TOOLS hidden (another tab), still the chosen tool: stop modes that wait on the pane
  deactivate() {},        // another tool was chosen: release them
  state() {},             // optional: what to keep in the session (JSON), or null
};
```

- `draw(el)` is the tool's whole pane (the selector above it already shows
  the tool's name, so no title). It draws its checklist where it wants it,
  with `host.ui.needsList(this.needs())`. A tool with nothing to work on
  says what to load (a `.tool-hint`). Parts of a tool go in *chapters*:
  folded sections in the 3D tab's style (`.cfg-section.cfg-fold`, `.open`
  when open, its rows in a `.cfg-fold-body` after it), the tool keeping
  which are open. A chapter that runs something either runs it when opened
  (cheap: a report) or shows its settings and a run button first.
- `activate()` / `deactivate()` bracket the time the tool is the chosen
  one. A tool that takes over the mouse or the keys in the 2D or 3D panels
  (a probe, a landmark picker) does so in `activate()` and undoes it in
  `deactivate()`. Switching tools hides a tool's pane but doesn't reset it:
  work in progress (a movie being made, a check running) goes on.
- `state()` goes into the session state as `tools[<id>]`; `tools.selected`
  is the chosen tool. (Restoring a session is not built yet.)

Its workers and imports are relative to `tools/`: `../js/graph-io.js`,
`new URL('../js/tensor-worker.js', import.meta.url)`.

## The host

What `init(host)` gives a tool — everything a tool may touch in the app:

| | |
|---|---|
| `host.volumes()`, `host.activeVolume()` | the loaded volumes (`{ file, label, grad, sidecar, nvol, Ab, gridShape, … }`), the one rendered |
| `host.markerSets()`, `host.groups()` | the marker sets, the streamline groups |
| `host.addVolume(name, { data, shape, Ab, nvol, category, description, softMask, background, shaderMode })` | a volume made in memory, listed like a dropped file; made again under the same name it replaces itself, and what used it (as mask, surface paint, shown) follows. `softMask`: a 0–1 field with its edge at 0.5 (as a mask: weighted by it); `background` (0–1 of its range), `shaderMode`: for its first showing |
| `host.addTractogram(name, streamlines, note, { ends, color })` | idem a tractogram (`.tck`); `ends: false` without end dots, `color: 'ras'` by direction |
| `host.addMarkers(name, json)` → rec | a marker set from a graph package (graph-format.md) |
| `host.removeMarkers(rec, refresh)` | |
| `host.showVolume(v)`, `host.showMarkers(rec)`, `host.showTracts(groups)` | show what a tool made |
| `host.showFrameSlice(vol, frame, slice, axis)` | a 4D series at one frame, the cursor at one slice |
| `host.readVolume(file)` → parsed | the voxels of a volume (`{ data, shape, Ab, invAb, … }`) |
| `host.readSidecar(vol)` → json | its BIDS sidecar, read once |
| `host.refresh()` | the app's lists redrawn (volumes, markers) and the tool with them: after a change to what's loaded |
| `host.redraw()` | the tool's pane redrawn (its own state changed) |
| `host.ui.choiceRow(label, [[value, text]], value, onChange, tip)` | a select row like the app's |
| `host.ui.sliderRow(label, { min, max, step, value, format, onInput, onChange })` | a slider row like the app's; `onChange(value)` once it settles (a drag let go, a typed value): for work too slow for every step |
| `host.ui.needsList(needs)` | the checklist as an element |
| `host.ui.progress(text)` | the status line (`''` clears it) |
| `host.lib` | `shellsOf(bvals)`, `B0_MAX`, `volumeBaseName(name)`, `compactList(indices)` |
| `host.openTool(id, opts)` | open another tool |
| `host.photos()` | the loaded photos (`{ file, name, registration, registrationFile }`; .jpg, .jpeg, .png — dropped photos open Photo to surface; `registration`: a `.photo.json` dropped with it) |
| `host.view3d()` | the 3D view's element (for a layer over it, such as `js/image-overlay.js`) |
| `host.render()` | `{ volume, mode, segmentation, vessels }`: the rendered volume, its shader (`'solid'`, …), the segmentation, a volume shown as an isosurface |
| `host.keys.claim(key, fn, tip)` → release | a key (no modifiers, not while typing) for the tool: claim it in `activate()`, release it in `deactivate()` |
| `host.pick3D(clientX, clientY)` → `{ ras, kind }` or null | the brain surface under a point of the 3D view (as the menu finds it) |
| `host.pickRay(origin, dir)` → `{ ras, kind }` or null | the brain surface along a ray (world mm), as rendered — a photo's camera ray through a pixel |
| `host.claimClick3D(fn)` → release | left clicks on the 3D view go to `fn(clientX, clientY)` instead of picking a point (dragging still turns the view; a right-click still opens the menu) |
| `host.claimPointer3D({ down, move, up, hover })` → release | a press on the 3D view offered to the tool first: `down(clientX, clientY)` → true takes it (then `move`, `up` until the button is let go; the view doesn't turn), false leaves it to the view; `hover(clientX, clientY)` → a cursor (`'move'`) or `''` — for dragging a tool's own points |
| `host.camera()` | the 3D camera: `{ position, target, up, fov, width, height }` (world mm; fov vertical, degrees; the view in px) |
| `host.setCamera({ position, target, up, fov })` | the 3D camera set (fov: 45 is the app's own) |
| `host.project([x, y, z])` → `[x, y, inFront]` | a world point on the 3D view, in its px |
| `host.setSurfacePhoto({ canvas, version, R, C, f, width, height, opacity })` or `(null)` | a photo projected onto the rendered surface by a pinhole camera (R rows: right, down, forward; C its position, mm; f in photo px; the principal point the photo's centre): each surface point facing the camera, within the photo and where the canvas is not transparent, shows the photo's colour, as taken (unshaded). `version`: changed when the canvas is |
| `host.onRender(fn)` → stop | `fn()` after each frame of the 3D view (a layer over it that follows it) |

Generic parts for tools, in `js/`: `image-panel.js` (an image in a box:
zoom, pan, an outline, clicks in image pixels) and `image-overlay.js` (an
image over a view, with a move and a scale-and-turn handle; only the
handles take the mouse), `screen-capture.js` (the page as shown: a still or a
recording of a rectangle of it, by `getDisplayMedia`; cut by the browser
where it can, else frame by frame), `mask-ops.js` (a mask closed, opened, smoothed and
offset in mm by exact distance transforms, into a smooth 0–1 field; run in
`mask-worker.js`; TOOLS › Mask shaping saves its result with a BIDS-style
sidecar whose `"MaskShaping"` names the source file and the settings — a
volume loaded with one is a soft mask again, and can be made again from its
source), `camera-solve.js` (a photo's camera from point
pairs: a first guess from a view and an image laid over it, then a robust
Levenberg–Marquardt solve; `fitPlane` and `photoHomography`: the photo as
its camera saw it, on a plane through brain points, mapped onto another
view — `ImageOverlay.setWarp` draws it so).

The host grows with the tools: a tool that needs something else from the
app gets it added here, never by reaching into `index.html`.

## Photo to surface: `<photo>.photo.json`

What the tool saves (SAVE), and reads back when it is dropped with its
photo: the photo it names (`photo.file`, by path from the .json, else by
name), else the photo whose name has the same stem (`IMG_0412.jpg` for
`IMG_0412.photo.json`), of the drop or loaded before. Optionally saved
next to it: `<photo>_roi.png`, the photo transparent outside its roi
contour, at full size (so its pixels are the .json's).

```json
{
  "format": "tractogram.observer photo", "version": 1,
  "photo":  { "file": "IMG_0412_roi.png", "original": "IMG_0412.jpg", "width": 4032, "height": 3024 },
  "brain":  { "volume": "sub-01_T1w.nii.gz", "shape": [176, 256, 256], "affine": [[…4], […4], […4], [0, 0, 0, 1]] },
  "roi_contour": [[812.5, 440.0], …],
  "pairs":  [{ "photo": [1203.5, 880.0], "brain": [-41.2, 12.8, 63.0] }, …],
  "camera": { "R": [[…], […], […]], "C": [x, y, z], "f": 2743.1, "principal_point": [2016, 1512],
              "rms_px": 2.1, "rms_mm": 0.12, "pairs_used": 7 },
  "markers": { "S1": { "brain": [-38.4, 15.1, 64.2], "photo": [1350.0, 902.0] }, … }
}
```

- **photo** pixels: as the browser shows the photo (a JPEG's EXIF
  orientation applied), x right, y down, from the top-left corner of the
  top-left pixel. `width`, `height` must match the photo it is applied to.
- **brain** points: world mm (scanner RAS) — the same for every volume in
  that world space. `brain.volume` is the volume rendered when it was saved:
  the surface the markers were placed on; `shape`, `affine` (voxel → world,
  4 × 4) its grid. Loaded with no volume on that grid, the tool notes it;
  rendered on another volume, it says the markers are placed again on that
  surface.
- **camera**: a pinhole camera; a world point X is seen at pixel
  `principal_point + f · (x/z, y/z)` with `[x, y, z] = R (X − C)`
  (rows of R: the camera's right, down, forward). Loading solves it again
  from the pairs, starting from the saved one.
- **markers**: name (unique, ≤ 24 characters) → its point on the photo and
  where the camera's ray through it meets the brain surface (`null`: it
  misses the brain, or there is no camera yet).
- `roi_contour`, `camera` may be null; `pairs`, `markers` empty.

## Later

- Buttons of the chosen tool next to ☰ (declared by the tool, shown while
  it is chosen).
- Restoring a tool's `state()` from a session.
- The probe as a tool.
