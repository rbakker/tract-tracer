// ── camera-solve.js ───────────────────────────────────────
// A photo's camera from points: where it stood, where it looked, its
// focal length — so that 3D points (world mm, RAS) land on the photo's
// pixels where they were seen.
//
// The model: a pinhole camera with square pixels and its principal point
// at the photo's centre (what a phone or surgical camera is, near
// enough). Seven unknowns: the camera's place (3), its orientation (3),
// its focal length (1, in photo pixels). A photo pixel (u, v), v down:
//   [x, y, z] = R (X - C)        (R's rows: right, down, forward)
//   u = w/2 + f x / z,  v = h/2 + f y / z
//
// Solved by Levenberg–Marquardt from a first guess — the 3D view as the
// photo was laid over it (the lightbox): initialCamera(). Over a small,
// nearly flat patch of cortex the focal length and the distance trade off
// against each other (a closer, wider camera looks almost the same), so
// the focal length is held weakly near the guess. Four pairs solve it;
// six or more, spread over the photo, solve it well.
//
// A wrong pair (a mis-click) shouldn't pull the camera off: with five
// pairs or more, the solve is also tried leaving each pair out, the
// solution that fits most pairs best (the median error) kept, and then
// refined with each pair weighted down by its error (a Cauchy weight), so
// that one far-off pair barely counts and shows as far off.
//
// Pure math: no DOM, no three.js.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// a rotation vector → its matrix (Rodrigues)
function rotation(w) {
  const t = Math.hypot(w[0], w[1], w[2]);
  if (t < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = w.map(v => v / t), c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
          [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
          [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
const matMul = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));

/** A world point on the photo: [u, v, depth] (depth ≤ 0: behind the camera). */
export function projectPoint(cam, X, image) {
  const d = sub(X, cam.C), x = dot(cam.R[0], d), y = dot(cam.R[1], d), z = dot(cam.R[2], d);
  return [image.w / 2 + cam.f * x / z, image.h / 2 + cam.f * y / z, z];
}

/**
 * The first guess: the 3D view, with the photo laid over it.
 * @param view - { position, target, up, fov (vertical, degrees), width, height } (the view in px)
 * @param place - the photo over the view: { x, y } its centre from the view's centre and { size } its width, in view heights; { angle } (rad, clockwise)
 * @param image - { w, h } the photo in px
 * @returns {{ R: number[][], C: number[], f: number }}
 */
export function initialCamera(view, place, image) {
  const W = view.width, H = view.height, Fv = (H / 2) / Math.tan(view.fov * Math.PI / 360);
  const fwd = norm(sub(view.target, view.position));
  let up = sub(view.up, mul(fwd, dot(view.up, fwd)));
  up = norm(up);
  const right = norm(cross(fwd, up)), down = mul(up, -1);
  // the photo's centre on the view: the photo's optical axis
  const cx = W / 2 + place.x * H, cy = H / 2 + place.y * H;
  const axis = norm(add(add(mul(right, (cx - W / 2) / Fv), mul(down, (cy - H / 2) / Fv)), fwd));
  const r0 = norm(sub(right, mul(axis, dot(right, axis)))), d0 = cross(axis, r0);
  // the photo turned by angle on the view: its x axis along (cos, sin) there
  const c = Math.cos(place.angle), s = Math.sin(place.angle);
  const rp = norm(add(mul(r0, c), mul(d0, s))), dp = norm(add(mul(r0, -s), mul(d0, c)));
  const sigma = place.size * H / image.w;   // view px per photo px
  return { R: [rp, dp, axis], C: view.position.slice(), f: Fv / sigma };
}

/**
 * The camera that best explains the pairs.
 * @param pairs - [{ q: [u, v] (photo px), X: [x, y, z] (world mm) }]
 * @param init - a camera: { R, C, f } (initialCamera, or a previous solve)
 * @param image - { w, h }
 * @param o.fWeight - photo px of error for a factor e (~2.7) off the expected focal length
 * @param o.fPrior - the expected focal length (default: init's). Give a fixed one (the
 *   hand placement's) when init is a previous solve: anchored to the last solve, the
 *   prior follows it, and a nearly flat patch of brain lets the camera drift away to
 *   a telephoto from metres off (the same picture: further and zoomed in).
 * @returns {{ cam, errors: number[] (px per pair), errorsMm: number[], rms, rmsMm, weights, iterations }}
 */
export function solveCamera(pairs, init, image, opts = {}) {
  opts = { ...opts, fPriorAt: opts.fPrior || init.f };
  const n = pairs.length, med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : 0; };
  const errorsOf = cam => pairs.map(({ q, X }) => { const [u, v, z] = projectPoint(cam, X, image); return z > 0 ? Math.hypot(u - q[0], v - q[1]) : 1e6; });
  // all pairs, and (five or more) each left out: the one fitting most pairs best
  let best = lm(pairs, init, image, null, opts), bestMed = med(errorsOf(best.cam));
  if (n >= 5) for (let k = 0; k < n; k++) {
    const s = lm(pairs.filter((_, i) => i !== k), init, image, null, opts), m = med(errorsOf(s.cam));
    if (m < bestMed) { best = s; bestMed = m; }
  }
  // refined, each pair weighted down by its error
  let cam = best.cam, weights = new Array(n).fill(1), it = best.iterations;
  if (n >= 5) for (let round = 0; round < 4; round++) {
    const e = errorsOf(cam), c = Math.max(2.5 * med(e), 0.002 * image.w);
    weights = e.map(x => 1 / (1 + (x / c) ** 2));
    const s = lm(pairs, cam, image, weights, opts);
    cam = s.cam; it += s.iterations;
  }
  const errors = [], errorsMm = [];
  for (const { q, X } of pairs) {
    const [u, v, z] = projectPoint(cam, X, image), e = Math.hypot(u - q[0], v - q[1]);
    errors.push(e); errorsMm.push(e * Math.abs(z) / cam.f);   // (the error at that depth, in mm)
  }
  // the error summed over the pairs that count (weighted): a far-off pair doesn't spoil it
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const rmsW = a => Math.sqrt(a.reduce((s, x, i) => s + weights[i] * x * x, 0) / wsum);
  return { cam, errors, errorsMm, weights, rms: rmsW(errors), rmsMm: rmsW(errorsMm), iterations: it };
}

// Levenberg–Marquardt from init; weights: per pair (null: all 1)
function lm(pairs, init, image, weights, { fWeight = 10, iterations = 200, fPriorAt = null } = {}) {
  const R0 = init.R, f0 = Math.log(fPriorAt || init.f);
  const sw = weights ? weights.map(Math.sqrt) : null;
  // the parameters: a turn of R0 (3), the camera's place (3), log f (1)
  const camOf = p => ({ R: matMul(rotation([p[0], p[1], p[2]]), R0), C: [p[3], p[4], p[5]], f: Math.exp(p[6]) });
  const residuals = p => {
    const cam = camOf(p), r = [];
    pairs.forEach(({ q, X }, i) => {
      const [u, v, z] = projectPoint(cam, X, image), k = sw ? sw[i] : 1;
      if (z <= 0) { r.push(1e4 * k, 1e4 * k); return; }   // (behind the camera: far off)
      r.push(k * (u - q[0]), k * (v - q[1]));
    });
    r.push(fWeight * (p[6] - f0));
    return r;
  };
  const cost = r => r.reduce((a, x) => a + x * x, 0);
  let p = [0, 0, 0, ...init.C, Math.log(init.f)], r = residuals(p), E = cost(r), lambda = 1e-3, it = 0, done = false;
  const steps = [1e-5, 1e-5, 1e-5, 1e-3, 1e-3, 1e-3, 1e-5];
  for (; it < iterations && !done; it++) {
    // the Jacobian, by differences
    const J = steps.map((h, k) => { const q = p.slice(); q[k] += h; const rq = residuals(q); return rq.map((x, i) => (x - r[i]) / h); });
    const m = r.length, A = [...Array(7)].map(() => new Float64Array(7)), g = new Float64Array(7);
    for (let a = 0; a < 7; a++) {
      for (let i = 0; i < m; i++) g[a] += J[a][i] * r[i];
      for (let b = a; b < 7; b++) { let sum = 0; for (let i = 0; i < m; i++) sum += J[a][i] * J[b][i]; A[a][b] = A[b][a] = sum; }
    }
    let improved = false;
    for (let tries = 0; tries < 10 && !improved; tries++) {
      const M = A.map((row, a) => Float64Array.from(row, (x, b) => x + (a === b ? lambda * (x || 1) : 0)));
      const d = solve7(M, Array.from(g, x => -x));
      if (!d) { lambda *= 10; continue; }
      const q = p.map((x, k) => x + d[k]), rq = residuals(q), Eq = cost(rq);
      if (Eq < E) { const gain = E - Eq; p = q; r = rq; E = Eq; lambda = Math.max(1e-9, lambda / 3); improved = true; if (gain < 1e-10 * (1 + E)) done = true; }
      else lambda *= 10;
    }
    if (!improved) break;
  }
  return { cam: camOf(p), iterations: it };
}
// a small linear system (Gaussian elimination, partial pivoting); null when singular
function solve7(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
  return x;
}

/**
 * The 3D view from the photo's camera: { position, target, up, fov } — the
 * photo's height fills the view's height. target: on the optical axis, at
 * the given distance (the surface: the landmarks' mean depth).
 */
export function cameraView(cam, image, dist) {
  return { position: cam.C.slice(), target: add(cam.C, mul(cam.R[2], dist)), up: mul(cam.R[1], -1),
           fov: 2 * Math.atan((image.h / 2) / cam.f) * 180 / Math.PI };
}

// ── the photo on a plane of the brain, seen from another view ──
// The plane through points (least squares): { c (centroid), n (unit normal) }, or null (fewer than 3, or in a line).
export function fitPlane(points) {
  const n = points.length;
  if (n < 3) return null;
  const c = [0, 1, 2].map(k => points.reduce((s, p) => s + p[k], 0) / n);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) { const d = sub(p, c); for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += d[a] * d[b]; }
  // the covariance's smallest eigenvector (Jacobi rotations)
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], A = M.map(r => r.slice());
  for (let sweep = 0; sweep < 30; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-12) continue;
      const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), co = Math.cos(th), si = Math.sin(th);
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = co * akp - si * akq; A[k][q] = si * akp + co * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = co * apk - si * aqk; A[q][k] = si * apk + co * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = co * vkp - si * vkq; V[k][q] = si * vkp + co * vkq; }
    }
  }
  const ev = [0, 1, 2].map(i => A[i][i]), order = [0, 1, 2].sort((a, b) => ev[a] - ev[b]);
  if (ev[order[1]] < 0.25 * n) return null;   // (all in a line, within half a mm: M sums the squares)
  const k = order[0];
  return { c, n: norm([V[0][k], V[1][k], V[2][k]]) };
}

// a photo pixel's ray, onto a plane: the world point, or null (behind the camera, along the plane)
export function photoRayOnPlane(cam, image, u, v, plane) {
  const x = (u - image.w / 2) / cam.f, y = (v - image.h / 2) / cam.f;
  const d = [0, 1, 2].map(k => cam.R[0][k] * x + cam.R[1][k] * y + cam.R[2][k]);
  const den = dot(plane.n, d);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(plane.n, sub(plane.c, cam.C)) / den;
  return t > 0 ? add(cam.C, mul(d, t)) : null;
}

// A homography from point pairs (≥ 4: [from [x, y], to [x, y]]), h22 = 1 — least squares.
export function homographyFrom(pairs) {
  if (pairs.length < 4) return null;
  const A = [...Array(8)].map(() => new Float64Array(8)), b = new Float64Array(8);
  const addRow = (row, rhs) => { for (let i = 0; i < 8; i++) { b[i] += row[i] * rhs; for (let j = 0; j < 8; j++) A[i][j] += row[i] * row[j]; } };
  for (const [[x, y], [X, Y]] of pairs) {
    addRow([x, y, 1, 0, 0, 0, -X * x, -X * y], X);
    addRow([0, 0, 0, x, y, 1, -Y * x, -Y * y], Y);
  }
  const h = solveN(A.map(r => Array.from(r)), Array.from(b));
  return h ? [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]] : null;
}
function solveN(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
  return x;
}

/**
 * The photo as its camera saw it, laid on a plane of the brain, seen from
 * another view: a homography from photo pixels to that view's pixels — or
 * null when it can't be drawn (the plane seen from behind, edge on, or
 * behind a camera).
 * @param cam - the photo's camera; image - { w, h }; plane - fitPlane(…)
 * @param project - world point → [x, y, inFront] on the view
 * @param viewPos - the view camera's position (which side of the plane it is on)
 * @param box - the part of the photo to fit it over: [u0, v0, u1, v1] in fractions (default: all of it)
 */
export function photoHomography(cam, image, plane, project, viewPos, box = [0, 0, 1, 1]) {
  if (!plane) return null;
  const side = p => dot(plane.n, sub(p, plane.c));
  if (Math.sign(side(cam.C)) !== Math.sign(side(viewPos))) return null;   // (the other side of the plane)
  const pairs = [];
  for (const a of [0, 0.5, 1]) for (const bb of [0, 0.5, 1]) {
    const u = (box[0] + (box[2] - box[0]) * a) * image.w, v = (box[1] + (box[3] - box[1]) * bb) * image.h;
    const X = photoRayOnPlane(cam, image, u, v, plane);
    if (!X) return null;
    const [x, y, front] = project(X);
    if (!front) return null;
    pairs.push([[u, v], [x, y]]);
  }
  return homographyFrom(pairs);
}
