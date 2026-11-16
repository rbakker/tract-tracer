// ── tools/photo.js ────────────────────────────────────────
// PHOTO TO SURFACE — a tool (tools.md): a photo of the exposed brain,
// taken during surgery, matched to the 3D brain surface by its sulci and
// vessels.
//
// The steps:
//   1. the photo in the tool (zoom, pan), the craniotomy window outlined on
//      it; the photo laid over the 3D view (the lightbox) and roughly
//      matched by eye: ✥ moves it, ⤡ scales and turns it, T shows and
//      hides it;
//   2. landmark pairs — a point on the photo and the same point on the
//      brain surface, in either order — and the photo's camera solved from
//      them (js/camera-solve.js; the lightbox match is its first guess),
//      with each pair's error. Once solved, the photo is projected onto
//      the brain surface by that camera (host.setSurfacePhoto: in the ray
//      marcher), exact on gyri and sulci from any view; both points of a pair can be dragged,
//      the camera solved again as a brain point moves;
//   3. markers: named points on the photo (stimulation sites), each on the
//      brain where the camera's ray through it meets the surface; saved
//      (with the roi contour, pairs, camera) as <photo>.photo.json, read
//      back when dropped with its photo (tools.md › Photo to surface);
//   later: brain shift (a warp).
//
// Photos come in as files (index.html keeps them: host.photos()); what the
// tool adds to a photo — its outline, its place over the view — is kept
// per photo, and in the session state (not the opacity: a live slider).

import { ImagePanel } from '../js/image-panel.js';
import { ImageOverlay } from '../js/image-overlay.js';
import { initialCamera, solveCamera, projectPoint, cameraView, fitPlane, photoHomography } from '../js/camera-solve.js';

let host = null;
let current = null;                 // the photo shown ({ file, name } from host.photos())
const info = new Map();             // per photo: { url, img, ready, outline, place, show, matchView, matchPlace, anchor, pairs, solve, markers, notes }
let panel = null, overlay = null;
let active = false, releaseKey = null, releasePtr = null;
let opacity = 1;                    // the photo over the view (not kept: 100% when shown with T or when adding pairs)
let autoSwitch = true;              // adding pairs: the photo hidden after its point, shown after the brain's
let drag = null;                    // a point being dragged on the 3D view: { r, i, kind: 'photo' | 'brain' | 'marker' }
let screenMarks = [];               // the points on the 3D view as last drawn: { i, kind, x, y } (view px)
const chapterOpen = { lightbox: true, landmarks: true, camera: true, markers: true, save: true };
let picking = false, releasePick = null, releaseEsc = null;   // adding landmark pairs: the clicks on the 3D view are the tool's
let marking = false;                                          // adding markers (on the photo): idem
let withCutout = true;                                        // saving: the photo cut out to its roi contour, as a .png, next to the .json
let layer3d = null, stopLayer = null;                         // the pairs' numbers on the 3D view (a canvas), and the photo following the brain
let slots = null;                                             // the pane's parts (see draw)
let note = '';                                                // a passing message under the landmarks (no surface there, …)
const COLORS = { pending: '#ffd27a', ok: '#7fe0ff', off: '#ff6b6b', marker: '#e2a8ff' };
const MIN_PAIRS = 4;

function infoOf(p) {
  let r = info.get(p);
  if (!r) {
    r = { url: URL.createObjectURL(p.file), img: new Image(), ready: false,
          outline: { points: [], closed: false }, place: { x: 0, y: 0, size: 0.5, angle: 0 }, show: true,
          matchView: null, matchPlace: null, anchor: null, pairs: [], solve: null, markers: [], notes: [] };
    r.img.decoding = 'async';
    r.loading = new Promise((ok, bad) => { r.img.onload = ok; r.img.onerror = () => bad(new Error('not an image')); }).then(() => { r.ready = true; applyRegistration(p, r); }, e => { r.error = e; });
    r.img.src = r.url;
    info.set(p, r);
  }
  return r;
}
function currentPhoto() {
  const ps = host.photos();
  for (const p of [...info.keys()]) if (!ps.includes(p)) { URL.revokeObjectURL(info.get(p).url); info.delete(p); }   // (removed: forgotten)
  if (!ps.includes(current)) current = ps[ps.length - 1] || null;
  return current;
}

// the overlay follows the current photo, and the tool being the chosen one
function syncOverlay() {
  // (the view the photo was matched in: the camera's first guess)
  if (!overlay) overlay = new ImageOverlay(host.view3d(), { onChange: place => { const p = currentPhoto(); if (p) placedByHand(infoOf(p), place); } });
  const p = currentPhoto(), r = p && infoOf(p);
  if (!r || !r.ready) { overlay.setVisible(false); if (host.setSurfacePhoto) host.setSurfacePhoto(null); return; }
  overlay.setImage(r.url, r.img.naturalWidth, r.img.naturalHeight);
  overlay.setPlace(r.place);
  overlay.setOpacity(opacity);
  // with a window outlined: only the brain over the view
  const o = r.outline, iw = r.img.naturalWidth, ih = r.img.naturalHeight;
  overlay.setClip(o.closed ? o.points.map(([x, y]) => [x / iw, y / ih]) : null);
  overlay.setVisible(active && r.show && !onSurface(r));   // (solved: on the surface instead, or flat)
  updateWarp(r);
  updateSurfacePhoto(r);
  if (active && r.show && !r.anchor && !r.solve) anchorPhoto(r);   // (tied to the brain from the start, where it can be)
}
// shown (100% opaque) or hidden: T, the checkbox, adding pairs
function setShown(r, on) {
  r.show = !!on;
  if (r.show) opacity = 1;
  syncOverlay(); drawLayer(); host.redraw();
}
// Solved: the photo projected onto the brain surface by its camera
// (host.setSurfacePhoto — the ray marcher colours each surface point the
// camera saw by the photo's pixel there), exact on gyri and sulci from any
// view; the flat lightbox is for placing it by hand before that.
// (r.warp false: flat instead — the undistorted photo on a plane through the
// brain points, as its camera saw it: exact from that camera's view, text readable)
const onSurface = r => !!(r && r.ready && r.solve && r.warp !== false);
// solved and flat: the photo over the view by a homography, from the plane
// through the brain points — or hidden where that can't be drawn (the plane
// seen from its other side, edge on)
function updateWarp(r) {
  if (!overlay) return;
  if (!r || !r.ready || !r.solve || onSurface(r)) { if (overlay.warp) overlay.setWarp(null); overlay.setHidden(false); return; }
  const image = { w: r.img.naturalWidth, h: r.img.naturalHeight }, pts = complete(r).map(x => x.X);
  let plane = fitPlane(pts);
  if (!plane) { const n = pts.length; plane = { c: [0, 1, 2].map(k => pts.reduce((a, p) => a + p[k], 0) / n), n: r.solve.cam.R[2] }; }   // (in a line: square to the photo's camera)
  const H = photoHomography(r.solve.cam, image, plane, host.project, host.camera().position, overlay.box);
  overlay.setHidden(!H);
  if (H) overlay.setWarp(H);
}
// the photo for the surface: at most 2048 px, transparent outside its roi contour
function photoCanvas(r) {
  const o = r.outline, key = JSON.stringify(o.closed ? o.points : null);
  if (r.canvas && r.canvasKey === key) return r.canvas;
  const iw = r.img.naturalWidth, ih = r.img.naturalHeight, k = Math.min(1, 2048 / Math.max(iw, ih));
  const c = document.createElement('canvas'); c.width = Math.round(iw * k); c.height = Math.round(ih * k);
  const g = c.getContext('2d');
  if (o.closed) { g.beginPath(); o.points.forEach(([x, y], i) => i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)); g.closePath(); g.clip(); }
  g.drawImage(r.img, 0, 0, c.width, c.height);
  r.canvas = c; r.canvasKey = key; r.canvasVersion = (r.canvasVersion || 0) + 1;
  return c;
}
function updateSurfacePhoto(r) {
  if (!host.setSurfacePhoto) return;
  // (kept when another tool is chosen — the screenshot / movie tool: it is part of the rendered scene)
  if (!onSurface(r) || !r.show) { host.setSurfacePhoto(null); return; }
  const cam = r.solve.cam;
  host.setSurfacePhoto({ canvas: photoCanvas(r), version: r.canvasVersion, R: cam.R, C: cam.C, f: cam.f,
                         width: r.img.naturalWidth, height: r.img.naturalHeight, opacity });
}
// where a photo pixel lies on the view: on the surface (solved: where its
// camera's ray meets the brain), or over the view (the lightbox) → [x, y] (view px) or null
function photoToView(r, q) {
  if (onSurface(r)) {
    const cam = r.solve.cam, key = q[0] + ',' + q[1] + '|' + cam.f + '|' + cam.C.join();
    r.hits = r.hits || new Map();
    let X = r.hits.get(key);
    if (X === undefined) {
      const x = (q[0] - r.img.naturalWidth / 2) / cam.f, y = (q[1] - r.img.naturalHeight / 2) / cam.f;
      const hit = host.pickRay(cam.C, [0, 1, 2].map(k => cam.R[0][k] * x + cam.R[1][k] * y + cam.R[2][k]));
      X = hit ? hit.ras : null;
      if (r.hits.size > 500) r.hits.clear();
      r.hits.set(key, X);
    }
    if (!X) return null;
    const [sx, sy, front] = host.project(X);
    return front ? [sx, sy] : null;
  }
  if (!overlay || overlay.hidden) return null;
  return overlay.toView(q[0] / r.img.naturalWidth, q[1] / r.img.naturalHeight);
}
// a point of the 3D view (client px) → the photo pixel there, or null (not on the photo)
function viewToPhoto(r, cx, cy) {
  const iw = r.img.naturalWidth, ih = r.img.naturalHeight;
  let u, v;
  if (onSurface(r)) {
    const hit = host.pick3D(cx, cy);
    if (!hit) return null;
    const [px, py, z] = projectPoint(r.solve.cam, hit.ras, { w: iw, h: ih });
    if (!(z > 0)) return null;
    u = px / iw; v = py / ih;
  } else {
    if (!overlay) return null;
    const rect = host.view3d().getBoundingClientRect();
    [u, v] = overlay.toImage(cx - rect.left, cy - rect.top);
  }
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u * iw, v * ih] : null;
}

// ── landmark pairs ──
const complete = r => r.pairs.filter(x => x.q && x.X);
// each pair's state: pending (one side only), ok, or off (its error much larger than the others')
function pairStates(r) {
  const s = r.solve, done = complete(r), errs = s ? s.errors : [];
  const med = errs.length ? errs.slice().sort((a, b) => a - b)[Math.floor(errs.length / 2)] : 0;
  return r.pairs.map(x => {
    if (!(x.q && x.X)) return { state: 'pending' };
    const k = done.indexOf(x), e = s && k >= 0 ? errs[k] : null;
    return { state: e != null && e > 5 && e > 2.5 * med ? 'off' : 'ok', err: e, errMm: s && k >= 0 ? s.errorsMm[k] : null };
  });
}
// the camera again, from the pairs (four or more)
function solveFor(r, quick = false) {
  const pairs = complete(r).map(x => ({ q: x.q, X: x.X })), image = { w: r.img.naturalWidth, h: r.img.naturalHeight };
  if (pairs.length < MIN_PAIRS) {
    // no camera any more: placed by hand again, where the camera had it
    const cp = currentPhoto();
    if (r.solve && overlay && cp && r === info.get(cp)) {
      const iw = r.img.naturalWidth, ih = r.img.naturalHeight;
      const c = photoToView(r, [iw / 2, ih / 2]), a = photoToView(r, [iw * 0.25, ih / 2]), b = photoToView(r, [iw * 0.75, ih / 2]);
      r.solve = null;
      if (c && a && b) {
        const Hh = host.view3d().clientHeight || 1, w = 2 * Math.hypot(b[0] - a[0], b[1] - a[1]);
        const place = overlay.placeAt(0.5, 0.5, c[0], c[1], w / Hh, Math.atan2(b[1] - a[1], b[0] - a[0]));
        overlay.setPlace(place); placedByHand(r, place);
      }
      syncOverlay();
    }
    r.solve = null; placeMarkers(r); return;
  }
  const guess = () => initialCamera(r.matchView || host.camera(), r.matchPlace || r.place, image);
  const init = r.solve ? r.solve.cam : guess();
  try {
    // the focal length expected: the hand placement's (or a loaded camera's) — fixed, so
    // the camera can't drift off to a far telephoto over a nearly flat patch of brain
    const opts = { fPrior: r.fPrior || guess().f };
    let s = solveCamera(pairs, init, image, opts);
    if (r.solve && !quick) { const s2 = solveCamera(pairs, guess(), image, opts); if (s2.rms < s.rms) s = s2; }   // (a pair moved a lot: start over too)
    r.solve = s;
  } catch (e) { console.warn('photo camera', e); r.solve = null; }
  placeMarkers(r);
}
// a click on the photo (picking): the photo side of the open pair, or a new pair
function photoClick(x, y) {
  const p = currentPhoto(); if (!p) return;
  if (marking) { addMarker(infoOf(p), x, y); return; }
  if (!picking) return;
  const r = infoOf(p), last = r.pairs[r.pairs.length - 1];
  if (last && !last.q) last.q = [x, y];
  else if (last && last.q && !last.X) last.q = [x, y];   // (clicked again: that point instead)
  else r.pairs.push({ q: [x, y], X: null });
  note = '';
  solveFor(r); nextSide(r); host.redraw();
}
// a click on the 3D view (picking): the brain side
function brainClick(cx, cy) {
  const p = currentPhoto(); if (!p) return;
  const hit = host.pick3D(cx, cy);
  if (!hit) { note = 'no brain surface under that click'; host.redraw(); return; }
  const r = infoOf(p), last = r.pairs[r.pairs.length - 1], X = hit.ras.map(v => +v.toFixed(2));
  if (last && !last.X) last.X = X;
  else if (last && last.X && !last.q) last.X = X;
  else r.pairs.push({ q: null, X });
  note = '';
  solveFor(r); nextSide(r); host.redraw();
}
// adding pairs, switching: the photo hidden when the brain point is next, shown otherwise
function nextSide(r) {
  if (!autoSwitch) { syncOverlay(); drawLayer(); return; }
  const last = r.pairs[r.pairs.length - 1];
  r.show = !(last && last.q && !last.X);
  if (r.show) opacity = 1;
  syncOverlay(); drawLayer();
}
// a click on the 3D view (adding pairs): with the photo shown, a point of
// the photo (where it lies over the view); hidden, a point of the brain
function click3D(cx, cy) {
  const p = currentPhoto(); if (!p) return;
  const r = infoOf(p);
  if (r.show && r.ready && (onSurface(r) || (overlay && !overlay.hidden))) {
    const q = viewToPhoto(r, cx, cy);
    if (!q) { note = marking ? 'that is outside the photo' : 'that is outside the photo — T hides it, to click the brain'; host.redraw(); return; }
    photoClick(q[0], q[1]);
    return;
  }
  if (marking) { note = 'markers go on the photo: T shows it'; host.redraw(); return; }
  brainClick(cx, cy);
}
// adding pairs or adding markers (one at a time): the clicks on the 3D
// view are the tool's, Esc stops; the photo shown, opaque
function setPicking(on) { picking = !!on; if (picking) marking = false; clicksClaimed(); }
function setMarking(on) { marking = !!on; if (marking) picking = false; clicksClaimed(); }
function clicksClaimed() {
  const on = picking || marking;
  if (on && !releasePick) {
    releasePick = host.claimClick3D(click3D); releaseEsc = host.keys.claim('escape', () => { setPicking(false); setMarking(false); host.redraw(); });
    const p = currentPhoto(); if (p) { const r = infoOf(p); r.show = true; opacity = 1; syncOverlay(); }
  }
  if (!on && releasePick) { releasePick(); releasePick = null; releaseEsc(); releaseEsc = null; }
  if (panel) panel.el.classList.toggle('picking', on);
}

// ── markers: named points on the photo (stimulation sites), on the brain ──
// A marker is placed on the photo; its brain point is where the photo's
// camera ray through it meets the brain surface (as rendered) — none
// before the camera is solved, or where the ray misses the brain. Names are
// short, editable, and unique (the saved table is name → point).
function markerRay(r, q) {
  const c = r.solve.cam, x = (q[0] - r.img.naturalWidth / 2) / c.f, y = (q[1] - r.img.naturalHeight / 2) / c.f;
  return { origin: c.C, dir: [0, 1, 2].map(k => c.R[0][k] * x + c.R[1][k] * y + c.R[2][k]) };
}
function placeMarker(r, m) {
  if (!r.solve || !r.ready) { m.X = null; return; }
  const { origin, dir } = markerRay(r, m.q), hit = host.pickRay(origin, dir);
  m.X = hit ? hit.ras.map(v => +v.toFixed(2)) : null;
}
function placeMarkers(r) { for (const m of r.markers || []) placeMarker(r, m); }
function freeName(r, base = 'S') {
  for (let i = r.markers.length + 1; ; i++) { const n = base + i; if (!r.markers.some(m => m.name === n)) return n; }
}
function addMarker(r, x, y) {
  const m = { name: freeName(r), q: [+x.toFixed(1), +y.toFixed(1)], X: null };
  r.markers.push(m); placeMarker(r, m);
  note = r.solve && !m.X ? m.name + ': the camera\'s ray there misses the brain surface' : '';
  syncMarks(r); drawLayer(); host.redraw();
}
function renameMarker(r, m, name) {
  name = String(name || '').trim();
  if (!name) return 'a name, please';
  if (name.length > 24) return 'at most 24 characters';
  if (r.markers.some(o => o !== m && o.name === name)) return '"' + name + '" is taken';
  m.name = name; return null;
}
// the photo's marks: each pair's photo point, numbered, colored by its state
function syncMarks(r) {
  if (!panel) return;
  const st = pairStates(r);
  panel.setMarks([...r.pairs.map((x, i) => x.q ? { x: x.q[0], y: x.q[1], label: i + 1, color: COLORS[st[i].state] } : null).filter(Boolean),
                  ...(r.markers || []).map(m => ({ x: m.q[0], y: m.q[1], label: m.name, color: COLORS.marker, shape: 'diamond' }))]);
}
// ── the photo following the brain ──
// The photo over the view is tied to the brain at the point under its
// cutout's centre: moving or zooming the view moves and scales the photo
// with that point (by its depth, so turning doesn't shrink it); the photo
// keeps its own turn on the screen — turning the brain in depth has no
// sensible turn of a flat picture. When that point goes out of sight
// (turned to the far side, behind other tissue), the photo stays where
// it is on the screen until the point is in sight again — or until the
// photo is placed by hand somewhere else, which ties it there.
function windowCentre(r) {
  const o = r.outline, iw = r.img.naturalWidth, ih = r.img.naturalHeight;
  if (!(o.closed && o.points.length >= 3)) return [0.5, 0.5];
  let A = 0, cx = 0, cy = 0;   // the polygon's centroid
  o.points.forEach(([x0, y0], i) => { const [x1, y1] = o.points[(i + 1) % o.points.length], c = x0 * y1 - x1 * y0; A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c; });
  return Math.abs(A) < 1e-9 ? [0.5, 0.5] : [cx / (3 * A) / iw, cy / (3 * A) / ih];
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
// px per mm at a point, on the view: the view's focal length over the point's depth
function pxPerMm(X) {
  const c = host.camera(), depth = dot3(sub3(X, c.position), norm3(sub3(c.target, c.position)));
  return depth > 0 ? (c.height / 2) / Math.tan(c.fov * Math.PI / 360) / depth : 0;
}
// is X what the view shows at its point (not behind other tissue, not on the far side)?
function inSight(X, sx, sy) {
  const rect = host.view3d().getBoundingClientRect(), hit = host.pick3D(rect.left + sx, rect.top + sy);
  return !!hit && Math.hypot(hit.ras[0] - X[0], hit.ras[1] - X[1], hit.ras[2] - X[2]) < 3;
}
function anchorPhoto(r) {
  r.anchor = null;
  if (!overlay || !r.ready) return;
  const [u, v] = windowCentre(r), [sx, sy] = overlay.pointAt(u, v);
  const el = host.view3d(), rect = el.getBoundingClientRect();
  const hit = host.pick3D(rect.left + sx, rect.top + sy);
  if (!hit) return;   // (not over the brain: the photo stays put on the screen)
  const k = pxPerMm(hit.ras);
  if (!(k > 0)) return;
  r.anchor = { X: hit.ras, uv: [u, v], widthMm: r.place.size * el.clientHeight / k };   // (the photo's width, in mm at that point)
}
function followBrain(r) {
  const a = r.anchor;
  if (!a || r.solve || !overlay || overlay.dragging || !active || !r.show) return;
  const [sx, sy, front] = host.project(a.X);
  if (!front || !inSight(a.X, sx, sy)) return;   // (out of sight: the photo stays where it is)
  const H = host.view3d().clientHeight || 1, k = pxPerMm(a.X);
  r.place = overlay.placeAt(a.uv[0], a.uv[1], sx, sy, a.widthMm * k / H, r.place.angle);
  overlay.setPlace(r.place);
}
// placed by hand (a handle, reset): the match the camera starts from, and the anchor
function placedByHand(r, place) {
  r.place = place;
  r.matchView = host.camera(); r.matchPlace = { ...place };
  anchorPhoto(r);
}

// the pairs' brain points on the 3D view, numbered — a canvas over the
// view, drawn again with every frame; a point hidden behind the surface
// (from this side) is drawn hollow
function syncLayer() {
  if (!layer3d) {
    layer3d = document.createElement('canvas'); layer3d.className = 'photo-pairs-layer';
    host.view3d().appendChild(layer3d);
    stopLayer = host.onRender(onFrame);
  }
  drawLayer();
}
function onFrame() {
  const p = currentPhoto(), r = p && info.get(p);
  if (r && !r.solve) followBrain(r);
  else if (r && !onSurface(r) && !(drag && drag.kind === 'photo')) updateWarp(r);   // (flat: from this view; a photo point dragged: held still)
  drawLayer();
}
function drawLayer() {
  if (!layer3d) return;
  const el = host.view3d(), W = el.clientWidth, H = el.clientHeight, dpr = window.devicePixelRatio || 1;
  if (layer3d.width !== Math.round(W * dpr) || layer3d.height !== Math.round(H * dpr)) { layer3d.width = Math.round(W * dpr); layer3d.height = Math.round(H * dpr); }
  const g = layer3d.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, layer3d.width, layer3d.height);
  const p = currentPhoto(), r = p && info.get(p);
  if (!active || !r) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = '600 10px system-ui, sans-serif'; g.textBaseline = 'middle';
  // each pair: its photo point a ring (where it lies over the view), its
  // brain point a dot (hollow behind the surface), a line between them
  const st = pairStates(r), rect = el.getBoundingClientRect(), iw = r.img.naturalWidth, ih = r.img.naturalHeight;
  const onPhoto = r.ready;   // (shown or not: where the photo lies — on the surface, or over the view)
  const marks = [];
  r.pairs.forEach((x, i) => {
    const col = COLORS[st[i].state];
    let ring = null, dot = null, seen = true;
    if (x.q && onPhoto) ring = photoToView(r, x.q);
    if (x.X) {
      const [sx, sy, front] = host.project(x.X);
      if (front && sx > -20 && sy > -20 && sx < W + 20 && sy < H + 20) {
        dot = [sx, sy];
        // seen, or behind the surface: what the view shows there is far from it
        const hit = i < 40 ? host.pick3D(rect.left + sx, rect.top + sy) : null;
        seen = !hit || Math.hypot(hit.ras[0] - x.X[0], hit.ras[1] - x.X[1], hit.ras[2] - x.X[2]) < 2;
      }
    }
    if (ring && dot) {
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.beginPath(); g.moveTo(...ring); g.lineTo(...dot); g.stroke();
      g.lineWidth = 1.2; g.strokeStyle = col; g.beginPath(); g.moveTo(...ring); g.lineTo(...dot); g.stroke();
    }
    if (ring) {
      g.lineWidth = 3.5; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.beginPath(); g.arc(ring[0], ring[1], 6, 0, 2 * Math.PI); g.stroke();
      g.lineWidth = 1.6; g.strokeStyle = col; g.beginPath(); g.arc(ring[0], ring[1], 6, 0, 2 * Math.PI); g.stroke();
      marks.push({ i, kind: 'photo', x: ring[0], y: ring[1] });
    }
    if (dot) {
      g.globalAlpha = seen ? 1 : 0.55;
      g.lineWidth = 1.5; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = col;
      g.beginPath(); g.arc(dot[0], dot[1], 3.5, 0, 2 * Math.PI);
      if (seen) g.fill(); g.stroke();
      if (!seen) { g.strokeStyle = col; g.beginPath(); g.arc(dot[0], dot[1], 2.6, 0, 2 * Math.PI); g.stroke(); }
      g.globalAlpha = 1;
      marks.push({ i, kind: 'brain', x: dot[0], y: dot[1] });
    }
    const at = dot || ring;
    if (at) {
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(String(i + 1), at[0] + 8, at[1] - 7);
      g.fillStyle = col; g.fillText(String(i + 1), at[0] + 8, at[1] - 7);
    }
  });
  // each marker: a diamond at its brain point (else, not yet on the brain,
  // hollow where it lies on the photo), with its name
  (r.markers || []).forEach((m, i) => {
    let at = null, onBrain = false;
    if (m.X) { const [sx, sy, front] = host.project(m.X); if (front) { at = [sx, sy]; onBrain = true; } }
    if (!at && onPhoto) at = photoToView(r, m.q);
    if (!at || at[0] < -20 || at[1] < -20 || at[0] > W + 20 || at[1] > H + 20) return;
    const [x, y] = at, dia = () => { g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); };
    g.lineWidth = 3.5; g.strokeStyle = 'rgba(0,0,0,0.75)'; dia(); g.stroke();
    g.lineWidth = 1.6; g.strokeStyle = COLORS.marker; dia(); g.stroke();
    if (onBrain) { g.fillStyle = COLORS.marker; g.beginPath(); g.arc(x, y, 1.8, 0, 2 * Math.PI); g.fill(); }
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(m.name, x + 9, y - 7);
    g.fillStyle = COLORS.marker; g.fillText(m.name, x + 9, y - 7);
    marks.push({ i, kind: 'marker', x, y });
  });
  screenMarks = marks;
}
// the 3D view from the photo's camera; the photo over it, filling its height
function viewFromCamera(r) {
  const s = r.solve; if (!s) return;
  const image = { w: r.img.naturalWidth, h: r.img.naturalHeight };
  const depths = complete(r).map(x => projectPoint(s.cam, x.X, image)[2]).filter(z => z > 0);
  const dist = depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 100;
  r.anchor = null;   // (not following while the view jumps)
  const v = cameraView(s.cam, image, dist);
  // Turned about the camera's axis to keep the brain upright as it was: the
  // view's own up, made square to the axis (the photo turns instead) — the
  // photo's own up only when the view looks along it. The field of view
  // then fits the turned photo's height on the view.
  const ax = s.cam.R[2], cur = host.camera().up, dt = cur[0] * ax[0] + cur[1] * ax[1] + cur[2] * ax[2];
  let up = cur.map((x, k) => x - dt * ax[k]);
  const n = Math.hypot(...up);
  up = n > 0.2 ? up.map(x => x / n) : v.up;
  const pu = s.cam.R[1].map(x => -x), pr = s.cam.R[0];   // (the photo's up and right, on its plane)
  const c = Math.abs(up[0] * pu[0] + up[1] * pu[1] + up[2] * pu[2]), sn = Math.abs(up[0] * pr[0] + up[1] * pr[1] + up[2] * pr[2]);
  const extent = image.h * c + image.w * sn;   // (the turned photo's height, photo px)
  v.up = up;
  v.fov = 2 * Math.atan((extent / 2) / s.cam.f) * 180 / Math.PI;
  // a camera far off (a long lens, a microscope): the view nearer, along the same axis, its field narrowed to match at the brain
  const NEAR = 600;
  if (dist > NEAR) {
    v.position = v.target.map((t, k) => t - ax[k] * NEAR);
    v.fov = 2 * Math.atan((extent / 2) / s.cam.f * dist / NEAR) * 180 / Math.PI;
  }
  host.setCamera(v);
  r.show = true; opacity = 1;
  syncOverlay(); drawLayer(); host.redraw();
}

// ── dragging a pair's points, and markers, on the 3D view ──
// The nearest point within 8 px; a brain point before a marker before a
// photo point (where they lie together, the brain's is the one to move).
// A marker moves on the photo (its brain point follows). Dragging a brain point
// solves the camera again as it goes — the photo moves into its new fit;
// dragging a photo point, the photo holds still until it is let go. A
// press that doesn't move is a click (adding pairs: the next point lands
// right by its partner's mark, once the camera fits).
function markAt(cx, cy) {
  const rect = host.view3d().getBoundingClientRect(), x = cx - rect.left, y = cy - rect.top;
  let best = null, bd = 8;
  for (const kind of ['brain', 'marker', 'photo']) {
    for (const m of screenMarks) if (m.kind === kind) { const d = Math.hypot(m.x - x, m.y - y); if (d <= bd) { bd = d; best = m; } }
    if (best) return best;
  }
  return null;
}
const pointer = {
  down(cx, cy) {
    const p = currentPhoto(), m = p && markAt(cx, cy);
    if (!m) return false;
    drag = { r: infoOf(p), i: m.i, kind: m.kind, raf: 0, at: [cx, cy], moved: false };
    return true;
  },
  move(cx, cy) {
    const d = drag; if (!d) return;
    if (!d.moved && Math.hypot(cx - d.at[0], cy - d.at[1]) < 3) return;
    d.moved = true;
    const r = d.r, x = d.kind === 'marker' ? r.markers[d.i] : r.pairs[d.i]; if (!x) return;
    if (d.kind === 'photo' || d.kind === 'marker') {
      const q = viewToPhoto(r, cx, cy);
      if (!q) return;   // (off the photo: it stays where it was)
      x.q = [+q[0].toFixed(1), +q[1].toFixed(1)];
      if (d.kind === 'marker') { delete x.saved; placeMarker(r, x); }
      syncMarks(r); drawLayer();
      return;
    }
    const hit = host.pick3D(cx, cy);
    if (!hit) return;   // (off the brain: it stays where it was)
    x.X = hit.ras.map(t => +t.toFixed(2));
    drawLayer();
    if (!d.raf) d.raf = requestAnimationFrame(() => { d.raf = 0; if (drag !== d) return; solveFor(r, true); updateSurfacePhoto(r); updateWarp(r); drawLayer(); });
  },
  up(cx, cy) {
    const d = drag; drag = null; if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (!d.moved) { if (picking || marking) click3D(cx, cy); return; }
    if (d.kind !== 'marker') { solveFor(d.r); syncOverlay(); }
    drawLayer(); host.redraw();
  },
  hover(cx, cy) { return markAt(cx, cy) ? 'move' : ''; },
};

// ── saving and loading: <photo>.photo.json ──
// (format: tools.md › Photo to surface)
const r1 = v => Math.round(v * 10) / 10;
const stemOf = name => String(name).replace(/\.(jpe?g|png)$/i, '');
const affine4 = Ab => Array.isArray(Ab) && Ab.length === 4 ? [0, 1, 2].map(i => [...Array.from(Ab[i]), Ab[3][i]]).concat([[0, 0, 0, 1]]) : null;
function registrationOf(p, r, photoFile) {
  const vol = host.activeVolume(), s = r.solve, iw = r.img.naturalWidth, ih = r.img.naturalHeight, o = r.outline;
  return {
    format: 'tractogram.observer photo', version: 1,
    photo: { file: photoFile, original: p.file.name, width: iw, height: ih },
    brain: vol ? { volume: vol.file.name, shape: vol.gridShape ? Array.from(vol.gridShape) : null, affine: affine4(vol.Ab) } : null,
    roi_contour: o.closed ? o.points.map(([x, y]) => [r1(x), r1(y)]) : null,
    pairs: r.pairs.map(x => ({ photo: x.q ? x.q.map(r1) : null, brain: x.X || null })),
    camera: s ? { R: s.cam.R.map(row => row.map(v => +v.toFixed(8))), C: s.cam.C.map(v => +v.toFixed(3)), f: +s.cam.f.toFixed(2),
                  principal_point: [iw / 2, ih / 2], rms_px: +s.rms.toFixed(2), rms_mm: +s.rmsMm.toFixed(3), pairs_used: complete(r).length } : null,
    markers: Object.fromEntries(r.markers.map(m => [m.name, { brain: m.X || m.saved || null, photo: m.q.map(r1) }])),   // (saved: as loaded, while there's no camera to place it)
  };
}
// JSON, its number lists on one line each
const jsonText = j => JSON.stringify(j, null, 2).replace(/\[([^\[\]{}"]*)\]/g, (m, x) => '[' + x.trim().replace(/\s+/g, ' ') + ']') + '\n';
function download(blob, name) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
// the photo, transparent outside its roi contour, at full size (its pixels are the .json's)
async function cutoutPng(r) {
  const c = document.createElement('canvas'); c.width = r.img.naturalWidth; c.height = r.img.naturalHeight;
  const g = c.getContext('2d');
  g.beginPath(); r.outline.points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.clip();
  g.drawImage(r.img, 0, 0);
  return new Promise((ok, bad) => c.toBlob(b => b ? ok(b) : bad(new Error('could not encode the png')), 'image/png'));
}
async function saveRegistration(p, r, cutout) {
  const stem = stemOf(p.file.name), png = stem + '_roi.png';
  const j = registrationOf(p, r, cutout ? png : p.file.name);
  download(new Blob([jsonText(j)], { type: 'application/json' }), stem + '.photo.json');
  if (cutout) download(await cutoutPng(r), png);
}
// a loaded .photo.json (p.registration, index.html): applied once the photo is read
function applyRegistration(p, r, redraw = true) {
  const j = p.registration;
  if (!j || r.applied === j || !r.ready) return;
  r.applied = j;
  const notes = [], iw = r.img.naturalWidth, ih = r.img.naturalHeight, from = p.registrationFile ? p.registrationFile.name : 'its .photo.json';
  const pt2 = a => Array.isArray(a) && a.length === 2 && a.every(Number.isFinite) ? [+a[0], +a[1]] : null;
  const pt3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? [+a[0], +a[1], +a[2]] : null;
  if (j.photo && (j.photo.width !== iw || j.photo.height !== ih)) {
    r.notes = [['✗', from + ': made for a photo of ' + j.photo.width + ' × ' + j.photo.height + ' px, this one is ' + iw + ' × ' + ih + ' — not applied']];
    return;
  }
  const c = Array.isArray(j.roi_contour) ? j.roi_contour.map(pt2).filter(Boolean) : [];
  r.outline = c.length >= 3 ? { points: c, closed: true } : { points: [], closed: false };
  r.pairs = Array.isArray(j.pairs) ? j.pairs.map(x => ({ q: pt2(x && x.photo), X: pt3(x && x.brain) })).filter(x => x.q || x.X) : [];
  r.markers = j.markers && typeof j.markers === 'object' ? Object.entries(j.markers).map(([name, m]) => ({ name: String(name).slice(0, 24), q: pt2(m && m.photo), X: null, saved: pt3(m && m.brain) })).filter(m => m.q) : [];
  // the camera: solved again from the pairs, starting from the saved one
  const cam = j.camera, image = { w: iw, h: ih }, pairs = complete(r).map(x => ({ q: x.q, X: x.X }));
  r.solve = null;
  if (pairs.length >= MIN_PAIRS) {
    try {
      // the saved camera to start from — unless it drifted far off (a telephoto metres away: an earlier version's solve)
      let init = cam && Array.isArray(cam.R) && pt3(cam.C) && cam.f > 0 ? { R: cam.R, C: cam.C, f: cam.f } : null;
      if (init) {
        const zs = pairs.map(x => projectPoint(init, x.X, image)[2]), zMean = zs.reduce((a, b) => a + b, 0) / zs.length;
        if (!(zMean > 0 && zMean < 2000)) { notes.push(['!', 'the saved camera was ' + (zMean / 1000).toFixed(0) + ' m from the brain (an earlier solve that drifted): solved again from the pairs — check it']); init = null; }
      }
      const guessCam = initialCamera(host.camera(), r.place, image);
      r.fPrior = init ? init.f : null;
      r.solve = solveCamera(pairs, init || guessCam, image, { fPrior: r.fPrior || guessCam.f });
      if (cam && Number.isFinite(cam.rms_px) && Math.abs(r.solve.rms - cam.rms_px) > 1) notes.push(['!', 'the camera solved again fits to ' + r.solve.rms.toFixed(1) + ' px, saved: ' + cam.rms_px.toFixed(1) + ' px']);
    } catch (e) { notes.push(['!', 'the camera could not be solved again from the saved pairs']); }
  }
  // the brain: the same volume? the markers where they were?
  const vol = host.activeVolume(), b = j.brain;
  // the space: a loaded volume on the saved grid (same shape and voxel → world)? — else a note
  if (b && Array.isArray(b.shape) && Array.isArray(b.affine)) {
    const same = host.volumes().some(v => {
      const A = affine4(v.Ab), sh = v.gridShape;
      return A && sh && sh.join() === b.shape.join() && A.every((row, i) => row.every((x, k) => Math.abs(x - (b.affine[i] || [])[k]) < 1e-3));
    });
    if (!same) notes.push(['i', 'no loaded volume has the grid of ' + (b.volume || 'the saved volume') + ': the points are world coordinates — fine if the scans share world space']);
  }
  // the surface the markers were placed on
  if (b && vol && b.volume && b.volume !== vol.file.name && r.markers.length)
    notes.push(['!', 'the markers were placed on ' + b.volume + ', shown now: ' + vol.file.name + ' — they are placed again on this surface']);
  placeMarkers(r);
  let worst = 0;
  for (const m of r.markers) if (m.saved && m.X) worst = Math.max(worst, Math.hypot(m.X[0] - m.saved[0], m.X[1] - m.saved[1], m.X[2] - m.saved[2]));
  if (worst > 1) notes.push(['!', 'markers now up to ' + worst.toFixed(1) + ' mm from where they were saved (another volume, mask or rendering?)']);
  if (r.solve) for (const m of r.markers) delete m.saved;
  notes.unshift(['i', 'from ' + from + ': ' + r.pairs.length + ' pair' + (r.pairs.length === 1 ? '' : 's') + ', ' + r.markers.length + ' marker' + (r.markers.length === 1 ? '' : 's')]);
  r.notes = notes;
  if (panel && panel.img === r.img) { panel.setOutline(r.outline); syncMarks(r); }
  if (r.solve) r.anchor = null;
  if (redraw) { syncOverlay(); drawLayer(); host.redraw(); }
}

export default {
  id: 'photo',
  init(h) { host = h; },
  // opened with { photo }: that one
  open(opts = {}) { if (opts.photo) current = opts.photo; },
  activate() {
    active = true;
    releaseKey = host.keys.claim('t', () => { const p = currentPhoto(); if (p) setShown(infoOf(p), !infoOf(p).show); }, 'the photo over the 3D view: shown (100% opaque) or hidden');
    releasePtr = host.claimPointer3D(pointer);
    syncOverlay(); syncLayer();
  },
  // TOOLS hidden: adding pairs or markers, and drawing the contour, stop
  // (their clicks and Esc go back to the app); the photo and its points
  // stay over the view
  away() {
    if (picking || marking) { setPicking(false); setMarking(false); note = ''; }
    if (panel && panel.drawing) panel.stopOutline();
  },
  deactivate() {
    active = false;
    if (releaseKey) { releaseKey(); releaseKey = null; }
    if (releasePtr) { releasePtr(); releasePtr = null; }
    drag = null; screenMarks = [];
    setPicking(false); setMarking(false);
    if (panel) panel.stopOutline();
    if (overlay) overlay.setVisible(false);   // (the projected photo stays on the brain: in screenshots and movies too)
    drawLayer();
    // the view's own field of view again (a photo's camera may have changed it)
    // — at the distance that keeps what's at the centre the same size (a narrow photo camera's view would else shrink to a far-off brain)
    const c = host.camera();
    if (Math.abs(c.fov - 45) > 1e-6) {
      const d = c.position.map((x, k) => x - c.target[k]), dist = Math.hypot(...d) || 1;
      const k = Math.tan(c.fov * Math.PI / 360) / Math.tan(45 * Math.PI / 360);
      host.setCamera({ ...c, position: c.target.map((t, i) => t + d[i] / dist * dist * k), fov: 45 });
    }
  },
  // what it works on: a photo, the brain rendered solid; vasculature optional
  // (a volume shown as an isosurface)
  needs() {
    const p = currentPhoto(), r = host.render();
    return [
      p ? ['✓', 'photo: ' + p.name] : ['✗', 'a photo of the exposed brain (.jpg, .png): drop it anywhere'],
      r.volume && r.mode === 'solid' ? ['✓', 'brain: ' + r.volume.label + ', rendered solid']
        : ['✗', 'the brain rendered solid: a T1, masked by its brain mask (ANATOMY), with the shader on solid — the mask alone has no sulci'],
      r.vessels ? ['✓', 'vasculature: ' + r.vessels.label] : ['–', 'optional: vasculature (volume file)'],
    ];
  },
  draw(el) {
    // three parts: the top (photo choice, checklist), the photo (its canvas
    // stays in place — taken out and put back on every redraw, some
    // browsers leave a ghost of it), the rest (rebuilt)
    if (!slots || slots.root !== el || !el.contains(slots.photo)) {
      el.innerHTML = '';
      slots = { root: el, top: document.createElement('div'), photo: document.createElement('div'), rest: document.createElement('div') };
      el.append(slots.top, slots.photo, slots.rest);
    }
    const top = slots.top, rest = slots.rest;
    top.innerHTML = ''; rest.innerHTML = '';
    const ps = host.photos(), p = currentPhoto();
    const missing = this.needs().filter(([st]) => st !== '✓');
    if (!p) {
      const n = document.createElement('div'); n.className = 'tool-hint';
      n.textContent = 'Load a photo of the exposed brain surface (.jpg or .png) — drop it anywhere — to get started.';
      top.append(n, host.ui.needsList(missing)); slots.photo.style.display = 'none';
      syncOverlay();
      return;
    }
    const r = infoOf(p);
    applyRegistration(p, r, false);   // (a .photo.json dropped for a photo already read)
    const pick = host.ui.choiceRow('photo', ps.map((x, i) => [String(i), x.name]), String(ps.indexOf(p)),
      val => { if (panel) panel.stopOutline(); current = ps[+val]; host.redraw(); }, 'which photo (all loaded photos)');
    top.appendChild(pick);
    if (missing.length) top.appendChild(host.ui.needsList(missing));
    if (r.notes && r.notes.length) top.appendChild(host.ui.needsList(r.notes));   // (from loading its .photo.json)

    // the photo: zoom with the wheel, pan by dragging, double-click to fit
    if (!panel) panel = new ImagePanel({ maxRatio: 1.1, onPick: photoClick,
      onOutline: o => { const q = currentPhoto(); if (q) { const r = infoOf(q); r.outline = o; if (o.closed || !o.points.length) { syncOverlay(); if (r.anchor) anchorPhoto(r); } host.redraw(); } } });   // (redraw: the status, and the overlay clipped to it)
    slots.photo.style.display = ''; if (panel.el.parentNode !== slots.photo) slots.photo.appendChild(panel.el);
    if (!r.ready) {
      if (!r.error) r.loading.then(() => host.redraw());
      if (panel.img) panel.setImage(null);
      const n = document.createElement('div'); n.className = 'tool-hint';
      n.textContent = r.error ? 'could not read this photo (' + r.error.message + ')' : 'reading the photo…';
      rest.appendChild(n);
      return;
    }
    if (panel.img !== r.img) { setPicking(false); panel.setImage(r.img); panel.setOutline(r.outline); }
    syncMarks(r);
    const hint = document.createElement('div'); hint.className = 'tool-hint';
    hint.textContent = 'wheel: zoom · drag: pan · double-click: unzoom';
    rest.appendChild(hint);

    // the craniotomy window: what of the photo is brain
    const o = r.outline, row = document.createElement('div'); row.className = 'ctl-row photo-row';
    const lab = document.createElement('label'); lab.textContent = 'roi contour';
    const status = document.createElement('span'); status.className = 'photo-status';
    status.textContent = panel.drawing ? 'click points around the brain · first point or Enter: close · Backspace: undo'
      : o.closed ? 'closed (' + o.points.length + ' points; drag one to move it)' : 'none: the whole photo counts';
    const bDraw = document.createElement('button'); bDraw.className = 'accent-link dt-set-btn';
    bDraw.textContent = panel.drawing ? 'done' : o.closed ? 'redraw' : 'draw';
    bDraw.dataset.tip = 'draw a contour around the part of the photo that is brain (the craniotomy): only that part is shown over the view and used later';
    bDraw.addEventListener('click', () => { if (panel.drawing) panel.stopOutline(); else panel.startOutline(); host.redraw(); });
    row.append(lab, bDraw);
    if (o.points.length && !panel.drawing) {
      const bClr = document.createElement('button'); bClr.className = 'accent-link dt-set-btn'; bClr.textContent = 'clear';
      bClr.addEventListener('click', () => { panel.clearOutline(); host.redraw(); });
      row.appendChild(bClr);
    }
    rest.append(row, status);

    // LIGHTBOX: the photo over the 3D view, matched by eye
    const h = document.createElement('div'); h.className = 'cfg-section cfg-fold' + (chapterOpen.lightbox ? ' open' : '');
    h.textContent = 'LIGHTBOX';
    h.dataset.tip = 'The photo over the 3D view, semi-transparent: turn and zoom the brain to the surgeon\'s view, then match the photo to it — ✥ (top right) moves it, ⤡ (bottom left) scales and turns it about the top-right corner; T shows and hides it. Once the camera is solved from the landmarks, the photo is placed by the camera instead. Click to open or close.';
    h.addEventListener('click', () => { chapterOpen.lightbox = !chapterOpen.lightbox; host.redraw(); });
    rest.appendChild(h);
    if (chapterOpen.lightbox) {
      const body = document.createElement('div'); body.className = 'cfg-fold-body';
      const cr = document.createElement('div'); cr.className = 'ctl-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'dt-check'; cb.checked = r.show; cb.id = 'photo-show';
      const cl = document.createElement('label'); cl.htmlFor = 'photo-show'; cl.textContent = 'show over the 3D view (T)';
      cb.addEventListener('change', () => setShown(r, cb.checked));
      cr.append(cb, cl);
      const op = host.ui.sliderRow('opacity', { min: 0, max: 100, step: 1, value: Math.round(opacity * 100), format: v => v + '%',
        onInput: v => { opacity = v / 100; if (overlay) overlay.setOpacity(opacity); const pp = currentPhoto(); if (pp) updateSurfacePhoto(infoOf(pp)); } });
      body.append(cr, op);
      // warped onto the surface (solved), or flat
      const wr = document.createElement('div'); wr.className = 'ctl-row';
      const wb = document.createElement('input'); wb.type = 'checkbox'; wb.className = 'dt-check'; wb.id = 'photo-warp';
      wb.checked = r.warp !== false; wb.disabled = !r.solve;
      const wl = document.createElement('label'); wl.htmlFor = 'photo-warp'; wl.textContent = 'warp to surface' + (r.solve ? '' : ' (needs ' + MIN_PAIRS + ' landmarks)');
      wr.dataset.tip = 'on: the photo projected onto the brain surface by its camera — right from any view; off: flat, undistorted (text readable), on a plane through the landmarks — exact from the photo\'s camera (CAMERA › view from it)';
      wb.addEventListener('change', () => { r.warp = wb.checked; syncOverlay(); drawLayer(); host.redraw(); });
      wr.append(wb, wl); body.appendChild(wr);
      const n = document.createElement('div'); n.className = 'tool-hint';
      if (r.solve) n.textContent = (onSurface(r) ? 'on the brain surface, projected by the photo\'s camera' : 'flat, on a plane through the landmarks: exact from the photo\'s camera')
        + ' · drag the points on the view to adjust · T shows and hides it';
      else {
        const rr = document.createElement('div'); rr.className = 'ctl-row';
        const bReset = document.createElement('button'); bReset.className = 'accent-link dt-set-btn'; bReset.textContent = 'reset place';
        bReset.dataset.tip = 'the photo back in the middle of the 3D view, at half its height, unturned';
        bReset.addEventListener('click', () => { r.anchor = null; r.place = { x: 0, y: 0, size: 0.5, angle: 0 }; syncOverlay(); placedByHand(r, r.place); });
        rr.appendChild(bReset); body.appendChild(rr);
        n.textContent = '✥ moves the photo · ⤡ scales and turns it · T shows and hides it';
      }
      body.appendChild(n);
      rest.appendChild(body);
    }

    // LANDMARKS: the same point on the photo and on the brain
    const chapter = (key, title, tip) => {
      const hh = document.createElement('div'); hh.className = 'cfg-section cfg-fold' + (chapterOpen[key] ? ' open' : '');
      hh.textContent = title; hh.dataset.tip = tip + ' Click to open or close.';
      hh.addEventListener('click', () => { chapterOpen[key] = !chapterOpen[key]; host.redraw(); });
      rest.appendChild(hh);
      if (!chapterOpen[key]) return null;
      const b = document.createElement('div'); b.className = 'cfg-fold-body'; rest.appendChild(b); return b;
    };
    const lm = chapter('landmarks', 'LANDMARKS', 'Pairs of points: one on the photo, the same one on the brain surface — a vessel fork, where a vein crosses a sulcus, a sulcal junction. Spread them over the roi; six or more.');
    const st = pairStates(r), nDone = complete(r).length;
    if (lm) {
      const row2 = document.createElement('div'); row2.className = 'ctl-row photo-row';
      const lab2 = document.createElement('label'); lab2.textContent = 'pairs';
      const bPick = document.createElement('button'); bPick.className = 'accent-link dt-set-btn' + (picking ? ' on' : '');
      bPick.textContent = picking ? 'done' : 'add';
      bPick.dataset.tip = 'add pairs: click a point on the photo (here, or where it lies over the 3D view), then the same point on the brain with the photo hidden (T) — or the other way round; again for the next pair. Esc or done: stop. Meanwhile a click on the 3D view is for the pairs, not the 3D menu; dragging still turns the brain';
      bPick.addEventListener('click', () => { setPicking(!picking); host.redraw(); });
      row2.append(lab2, bPick);
      if (r.pairs.length) {
        const bAll = document.createElement('button'); bAll.className = 'accent-link dt-set-btn'; bAll.textContent = 'clear';
        bAll.addEventListener('click', () => { r.pairs = []; r.solve = null; host.redraw(); });
        row2.appendChild(bAll);
      }
      const s2 = document.createElement('span'); s2.className = 'photo-status';
      const last = r.pairs[r.pairs.length - 1];
      s2.textContent = (!marking && note) || (picking ? (last && !last.X ? 'now the same point on the brain, the photo hidden (#' + r.pairs.length + ')'
                                                : last && !last.q ? 'now the same point on the photo (#' + r.pairs.length + ')'
                                                : 'click a point on the photo — T: the brain instead')
                              : nDone + ' pair' + (nDone === 1 ? '' : 's') + (nDone < MIN_PAIRS ? ' — ' + MIN_PAIRS + ' needed for the camera, six or more is better' : ''));
      const sw = document.createElement('div'); sw.className = 'ctl-row';
      const swb = document.createElement('input'); swb.type = 'checkbox'; swb.className = 'dt-check'; swb.checked = autoSwitch; swb.id = 'photo-switch';
      const swl = document.createElement('label'); swl.htmlFor = 'photo-switch'; swl.textContent = 'switch after each point';
      sw.dataset.tip = 'adding pairs: the photo hidden after its point is clicked (the brain is next), shown again after the brain point';
      swb.addEventListener('change', () => { autoSwitch = swb.checked; });
      sw.append(swb, swl);
      lm.append(row2, sw, s2);
      if (r.pairs.length) {
        const hd = document.createElement('div'); hd.className = 'tool-hint';
        hd.textContent = 'on the view: ○ the photo point, ● the brain point — drag either to move it';
        lm.appendChild(hd);
      }
      // the pairs: number, state, error; a click on one shows it on the photo; × removes it
      r.pairs.forEach((x, i) => {
        const it = document.createElement('div'); it.className = 'qc-line photo-pair';
        const mark = document.createElement('span'); mark.className = 'qc-st'; mark.style.color = COLORS[st[i].state]; mark.textContent = '●';
        const t = document.createElement('button'); t.className = 'qc-act';
        t.textContent = '#' + (i + 1) + ' ' + (!x.q ? 'brain only' : !x.X ? 'photo only'
          : st[i].err != null ? st[i].err.toFixed(0) + ' px · ' + st[i].errMm.toFixed(1) + ' mm' + (st[i].state === 'off' ? ' — far off: a wrong click?' : '') : 'paired');
        t.dataset.tip = 'show it on the photo';
        t.addEventListener('click', () => { if (x.q) panel.centreOn(x.q[0], x.q[1], Math.max(panel.zoom, 3)); });
        const del = document.createElement('button'); del.className = 'accent-link photo-del'; del.textContent = '×'; del.dataset.tip = 'remove this pair';
        del.addEventListener('click', () => { r.pairs.splice(i, 1); solveFor(r); host.redraw(); });
        it.append(mark, t, del); lm.appendChild(it);
      });
    }

    // CAMERA: where the photo was taken from
    const cm = chapter('camera', 'CAMERA', 'The photo\'s camera, solved from the pairs: where it stood, where it looked, its focal length. From that camera the photo should fit the brain.');
    if (cm) {
      const s = r.solve;
      if (!s) {
        const n = document.createElement('div'); n.className = 'tool-hint';
        n.textContent = nDone < MIN_PAIRS ? 'solved from ' + MIN_PAIRS + ' pairs or more (' + nDone + ' so far)' : 'could not solve it: check the pairs';
        cm.appendChild(n);
      } else {
        const image = { w: r.img.naturalWidth, h: r.img.naturalHeight };
        const depths = complete(r).map(x => projectPoint(s.cam, x.X, image)[2]);
        const dist = depths.reduce((a, b) => a + b, 0) / depths.length;
        const L = [
          [s.rms < 0.01 * image.w ? '✓' : '!', 'error: ' + s.rms.toFixed(0) + ' px (' + s.rmsMm.toFixed(1) + ' mm on the brain), over ' + nDone + ' pairs'],
          ['i', 'focal length ' + s.cam.f.toFixed(0) + ' px (' + (2 * Math.atan(image.h / 2 / s.cam.f) * 180 / Math.PI).toFixed(1) + '° vertical), ' + dist.toFixed(0) + ' mm from the brain'],
        ];
        if (nDone < 6) L.push(['!', 'few pairs: add some, spread over the roi']);
        cm.appendChild(host.ui.needsList(L));
        const rowC = document.createElement('div'); rowC.className = 'ctl-row';
        const bView = document.createElement('button'); bView.className = 'accent-link dt-set-btn'; bView.textContent = 'view from the photo\'s camera';
        bView.dataset.tip = 'the 3D view from where the photo was taken, with its field of view; the photo over it — they should fit (T shows and hides it)';
        bView.addEventListener('click', () => viewFromCamera(r));
        rowC.appendChild(bView);
        cm.appendChild(rowC);
      }
    }

    // MARKERS: named points on the photo (stimulation sites), on the brain
    const mk = chapter('markers', 'MARKERS', 'Named points on the photo — stimulation sites, a tumour border — and where they lie on the brain: the photo\'s camera ray through each, onto the brain surface. Placed on the photo (here, or over the 3D view), dragged there; the name is yours to edit.');
    if (mk) {
      const row3 = document.createElement('div'); row3.className = 'ctl-row photo-row';
      const lab3 = document.createElement('label'); lab3.textContent = 'markers';
      const bMk = document.createElement('button'); bMk.className = 'accent-link dt-set-btn' + (marking ? ' on' : '');
      bMk.textContent = marking ? 'done' : 'add';
      bMk.dataset.tip = 'add markers: click points on the photo (here, or where it lies over the 3D view). Esc or done: stop';
      bMk.addEventListener('click', () => { setMarking(!marking); host.redraw(); });
      row3.append(lab3, bMk);
      if (r.markers.length) {
        const bClr = document.createElement('button'); bClr.className = 'accent-link dt-set-btn'; bClr.textContent = 'clear';
        bClr.addEventListener('click', () => { r.markers = []; syncMarks(r); drawLayer(); host.redraw(); });
        row3.appendChild(bClr);
      }
      const s3 = document.createElement('span'); s3.className = 'photo-status';
      s3.textContent = (marking && note) || (marking ? 'click a point on the photo' : !r.solve ? 'on the brain once the camera is solved (CAMERA)'
        : r.markers.length ? '◆ on the view: drag it to move it on the photo' : 'none yet');
      mk.append(row3, s3);
      r.markers.forEach((m, i) => {
        const it = document.createElement('div'); it.className = 'qc-line photo-pair photo-marker';
        const sym = document.createElement('span'); sym.className = 'qc-st'; sym.style.color = COLORS.marker; sym.textContent = '◆';
        const name = document.createElement('input'); name.type = 'text'; name.className = 'photo-mname'; name.value = m.name; name.maxLength = 24; name.spellcheck = false;
        name.dataset.tip = 'its name (unique): Enter to keep it';
        name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = m.name; name.blur(); } });
        name.addEventListener('change', () => { const err = renameMarker(r, m, name.value); if (err) { note = m.name + ': ' + err; name.value = m.name; } else note = ''; syncMarks(r); drawLayer(); host.redraw(); });
        const xyz = document.createElement('button'); xyz.className = 'qc-act photo-xyz';
        xyz.textContent = m.X ? m.X.map(v => v.toFixed(1)).join(', ') : r.solve ? 'off the brain' : '—';
        xyz.dataset.tip = m.X ? 'world mm (x, y, z) on the brain surface — show it on the photo' : 'show it on the photo';
        xyz.addEventListener('click', () => panel.centreOn(m.q[0], m.q[1], Math.max(panel.zoom, 3)));
        const del = document.createElement('button'); del.className = 'accent-link photo-del'; del.textContent = '×'; del.dataset.tip = 'remove this marker';
        del.addEventListener('click', () => { r.markers.splice(i, 1); syncMarks(r); drawLayer(); host.redraw(); });
        it.append(sym, name, xyz, del); mk.appendChild(it);
      });
      if (r.markers.length && r.solve) {
        const n = document.createElement('div'); n.className = 'tool-hint';
        n.textContent = 'about ' + r.solve.rmsMm.toFixed(1) + ' mm uncertain (the camera\'s error on the brain), before any brain shift';
        mk.appendChild(n);
      }
    }

    // SAVE: the registration (.photo.json), and the photo cut out (.png)
    const sv = chapter('save', 'SAVE', 'The registration — roi contour, landmark pairs, camera, markers (name → brain point) — as <photo>.photo.json; drop it with its photo to carry on. Optionally the photo cut out to its roi contour, as a .png.');
    if (sv) {
      const cr2 = document.createElement('div'); cr2.className = 'ctl-row';
      const cb2 = document.createElement('input'); cb2.type = 'checkbox'; cb2.className = 'dt-check'; cb2.checked = withCutout && r.outline.closed; cb2.disabled = !r.outline.closed; cb2.id = 'photo-cutout';
      const cl2 = document.createElement('label'); cl2.htmlFor = 'photo-cutout'; cl2.textContent = 'with the photo cut out (.png, transparent outside the roi)';
      cb2.addEventListener('change', () => { withCutout = cb2.checked; });
      cr2.append(cb2, cl2);
      const rowS = document.createElement('div'); rowS.className = 'ctl-row';
      const bSave = document.createElement('button'); bSave.className = 'accent-link dt-set-btn'; bSave.textContent = 'save';
      const stem = stemOf(p.file.name);
      bSave.dataset.tip = 'downloads ' + stem + '.photo.json' + (r.outline.closed ? ' (and, ticked, ' + stem + '_roi.png)' : '');
      bSave.addEventListener('click', () => saveRegistration(p, r, withCutout && r.outline.closed).catch(e => alert('Saving the photo: ' + ((e && e.message) || e))));
      rowS.appendChild(bSave);
      sv.append(cr2, rowS);
    }
    syncOverlay(); syncLayer();
  },
  // kept in the session: per photo its registration (as in its .photo.json) and place over the view
  state() {
    const ps = host.photos();
    if (!ps.length) return null;
    return {
      current: current ? current.name : null,
      photos: ps.map(p => { const r = info.get(p); return r && r.ready ? { name: p.name, place: r.place, show: r.show, registration: registrationOf(p, r, p.file.name) } : { name: p.name }; }),
    };
  },
};
