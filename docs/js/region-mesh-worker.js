// ── Region meshes: the worker (see region-meshes.js) ─────────────────────
// Holds one label volume (posted once) and, per request, turns one region
// (label value) into a closed triangle surface — the same surface the
// raymarcher shows for a label volume (index.html updateLabelOccupancy):
//   1. the region's box (computed for all labels in one pass at load),
//      padded with background, as a 0/1 field;
//   2. a Gaussian blur, σ = 0.8 voxel (the raymarcher's), taking the voxel
//      steps out while keeping thin parts;
//   3. surface nets on its 0.5 level: one vertex per 2×2×2 cell the level
//      crosses (the mean of its edge crossings, linearly interpolated), a
//      quad per grid edge between inside and outside;
//   4. normals from the field's gradient (smooth, also where parts touch
//      only at an edge or corner).
// Vertices are in voxel index coordinates (voxel centres at integers);
// the main thread maps them to world mm. Triangles wind counter-clockwise
// seen from outside (index order), so front faces face outward.
//
// Request  { type: 'volume', gen, raw: Int32Array, shape }
//          { type: 'mesh', gen, label }
// Reply    { gen, label, positions, normals: Float32Array, indices: Uint32Array }
//          { gen, label, empty: true }  or  { gen, label, error }

const SIGMA = 0.8, ISO = 0.5;
const R = Math.ceil(3 * SIGMA), PAD = R + 1;

let vol = null; // { gen, raw, shape, boxes: Map(label → [x0,y0,z0,x1,y1,z1]) }

function boxesOf(raw, [nx, ny, nz]) {
  const boxes = new Map();
  let o = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, o++) {
    const v = raw[o];
    if (v === 0) continue;
    const b = boxes.get(v);
    if (!b) { boxes.set(v, [x, y, z, x, y, z]); continue; }
    if (x < b[0]) b[0] = x; if (x > b[3]) b[3] = x;
    if (y < b[1]) b[1] = y; if (y > b[4]) b[4] = y;
    if (z < b[2]) b[2] = z; if (z > b[5]) b[5] = z;
  }
  return boxes;
}

function blur(a, X, Y, Z) { // separable Gaussian in place (zero outside the box)
  const w = Array.from({ length: R + 1 }, (_, x) => Math.exp(-x * x / (2 * SIGMA * SIGMA)));
  const ws = w[0] + 2 * w.slice(1).reduce((p, q) => p + q, 0);
  for (let t = 0; t <= R; t++) w[t] /= ws;
  const b = new Float32Array(a.length);
  const line = (src, dst, base, stride, len) => {
    for (let k = 0, o = base; k < len; k++, o += stride) {
      let s2 = w[0] * src[o];
      for (let t = 1; t <= R; t++) {
        if (k - t >= 0) s2 += w[t] * src[o - t * stride];
        if (k + t < len) s2 += w[t] * src[o + t * stride];
      }
      dst[o] = s2;
    }
  };
  const XY = X * Y;
  for (let l = 0; l < Y * Z; l++) line(a, b, l * X, 1, X);
  for (let k = 0; k < Z; k++) for (let i = 0; i < X; i++) line(b, a, k * XY + i, X, Y);
  for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) line(a, b, j * X + i, XY, Z);
  return b;
}

function meshOf(label) {
  const bx = vol.boxes.get(label);
  if (!bx) return null;
  const [nx, ny] = vol.shape, raw = vol.raw;
  // field over the box plus PAD background voxels: grid point (i,j,k) = voxel (ox+i, oy+j, oz+k)
  const ox = bx[0] - PAD, oy = bx[1] - PAD, oz = bx[2] - PAD;
  const X = bx[3] - bx[0] + 1 + 2 * PAD, Y = bx[4] - bx[1] + 1 + 2 * PAD, Z = bx[5] - bx[2] + 1 + 2 * PAD;
  const XY = X * Y;
  const m = new Float32Array(X * Y * Z);
  for (let k = PAD; k < Z - PAD; k++) for (let j = PAD; j < Y - PAD; j++) {
    let s = (ox + PAD) + nx * ((oy + j) + ny * (oz + k)), d = PAD + X * j + XY * k;
    for (let i = PAD; i < X - PAD; i++, s++, d++) if (raw[s] === label) m[d] = 1;
  }
  let f = blur(m.slice(), X, Y, Z);  // (blur uses its input as scratch)
  let iso = ISO;
  { let mx = 0; for (let i = 0; i < f.length; i++) if (f[i] > mx) mx = f[i];
    if (mx < ISO) { f = m; iso = 0.5; } }                 // too thin to survive the blur: the voxels themselves
  // cells: (i,j,k) spans grid points i..i+1 etc.; a vertex per mixed cell
  const CX = X - 1, CY = Y - 1, CZ = Z - 1, CXY = CX * CY;
  const vid = new Int32Array(CX * CY * CZ).fill(-1);
  const pos = [], nrm = [];
  // the 12 cell edges as corner pairs (corner c = dx + 2dy + 4dz)
  const E = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  const c = new Float32Array(8);
  for (let k = 0; k < CZ; k++) for (let j = 0; j < CY; j++) for (let i = 0; i < CX; i++) {
    const g = i + X * j + XY * k;
    let n = 0;
    for (let q = 0; q < 8; q++) { c[q] = f[g + (q & 1) + X * ((q >> 1) & 1) + XY * (q >> 2)]; if (c[q] >= iso) n++; }
    if (n === 0 || n === 8) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of E) {
      if ((c[a] >= iso) === (c[b] >= iso)) continue;
      const t = (iso - c[a]) / (c[b] - c[a]);
      sx += (a & 1) + t * ((b & 1) - (a & 1));
      sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
      sz += (a >> 2) + t * ((b >> 2) - (a >> 2));
      cnt++;
    }
    const u = sx / cnt, v = sy / cnt, w = sz / cnt;
    // gradient of the trilinear field at (u, v, w); the outward normal is −gradient
    const gx = (1 - v) * (1 - w) * (c[1] - c[0]) + v * (1 - w) * (c[3] - c[2]) + (1 - v) * w * (c[5] - c[4]) + v * w * (c[7] - c[6]);
    const gy = (1 - u) * (1 - w) * (c[2] - c[0]) + u * (1 - w) * (c[3] - c[1]) + (1 - u) * w * (c[6] - c[4]) + u * w * (c[7] - c[5]);
    const gz = (1 - u) * (1 - v) * (c[4] - c[0]) + u * (1 - v) * (c[5] - c[1]) + (1 - u) * v * (c[6] - c[2]) + u * v * (c[7] - c[3]);
    const gl = Math.hypot(gx, gy, gz) || 1;
    vid[i + CX * j + CXY * k] = pos.length / 3;
    pos.push(ox + i + u, oy + j + v, oz + k + w);
    nrm.push(-gx / gl, -gy / gl, -gz / gl);
  }
  if (!pos.length) return null;
  // quads: one per pair of neighbouring grid points on either side of the
  // level. An x-edge between points (i,j,k) and (i+1,j,k) is shared by the
  // cells (i, j-1|j, k-1|k); wound so the normal points from inside to outside.
  const idx = [];
  const quad = (a, b, cc, d, flip) => {
    if (a < 0 || b < 0 || cc < 0 || d < 0) return;
    if (flip) idx.push(a, cc, b, a, d, cc); else idx.push(a, b, cc, a, cc, d);
  };
  const cell = (i, j, k) => vid[i + CX * j + CXY * k];
  const ins = o => f[o] >= iso;
  for (let k = 1; k < Z - 1; k++) for (let j = 1; j < Y - 1; j++) for (let i = 0; i < X - 1; i++) {
    const o = i + X * j + XY * k, a = ins(o);
    if (a !== ins(o + 1)) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), !a);
  }
  for (let k = 1; k < Z - 1; k++) for (let j = 0; j < Y - 1; j++) for (let i = 1; i < X - 1; i++) {
    const o = i + X * j + XY * k, a = ins(o);
    if (a !== ins(o + X)) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), !a);
  }
  for (let k = 0; k < Z - 1; k++) for (let j = 1; j < Y - 1; j++) for (let i = 1; i < X - 1; i++) {
    const o = i + X * j + XY * k, a = ins(o);
    if (a !== ins(o + XY)) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), !a);
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), indices: Uint32Array.from(idx) };
}

self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'volume') {
    vol = { gen: msg.gen, raw: msg.raw, shape: msg.shape, boxes: boxesOf(msg.raw, msg.shape) };
    return;
  }
  if (msg.type === 'mesh') {
    const { gen, label } = msg;
    if (!vol || vol.gen !== gen) { self.postMessage({ gen, label, error: 'volume not loaded' }); return; }
    try {
      const r = meshOf(label);
      if (!r) self.postMessage({ gen, label, empty: true });
      else self.postMessage({ gen, label, positions: r.positions, normals: r.normals, indices: r.indices }, [r.positions.buffer, r.normals.buffer, r.indices.buffer]);
    } catch (err) { self.postMessage({ gen, label, error: String(err && err.message || err) }); }
  }
};
