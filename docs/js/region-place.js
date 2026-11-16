// ── region-place.js ───────────────────────────────────────
// Positions for rows placed by atlas region (graph-format.md, geometry.region
// on a point table): per region and side, the point deepest inside it — the
// voxel farthest from the region's border (an exact Euclidean distance
// transform, with the voxel sizes). Not the centroid: that of a curved
// cortical area can fall in white matter or a sulcus.
//
// A region is a set of label values (a leaf: its own; a group: those of its
// descendants). Its side: the voxels with world x < 0 (left) or >= 0
// (right), as in a template whose midline is x = 0; when the region has no
// voxels on the asked side (an atlas with separate values per side), all of
// its voxels count.
//
// Pure functions: no app state, no three.js. Deterministic: ties go to the
// first voxel in memory order, so a position is the same on every machine.

const BIG = 1e20;

// The voxel → world map as coefficients (rows of [a, b, c, t]: world_r = a·i + b·j + c·k + t).
function affineOf(toWorld) {
  const o = toWorld([0, 0, 0]), ex = toWorld([1, 0, 0]), ey = toWorld([0, 1, 0]), ez = toWorld([0, 0, 1]);
  return [0, 1, 2].map(r => [ex[r] - o[r], ey[r] - o[r], ez[r] - o[r], o[r]]);
}

// Squared distance transform along one line (Felzenszwalb & Huttenlocher):
// f in, d out, positions q·s (s2 = s²).
function edt1d(f, n, s2, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let p = v[k], s = ((f[q] + s2 * q * q) - (f[p] + s2 * p * p)) / (2 * s2 * (q - p));
    while (s <= z[k]) { k--; p = v[k]; s = ((f[q] + s2 * q * q) - (f[p] + s2 * p * p)) / (2 * s2 * (q - p)); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = s2 * (q - p) * (q - p) + f[p];
  }
}

/**
 * Squared distance (mm²) of each voxel to the nearest voxel where far(i) is
 * false (exact, Felzenszwalb & Huttenlocher; spacing [sx, sy, sz] mm).
 * No such voxel at all: every voxel BIG.
 */
export function distanceSquared(far, nx, ny, nz, sp) {
  const N = nx * ny * nz, D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = far(i) ? BIG : 0;
  sweepEdt(D, nx, ny, nz, sp);
  return D;
}
function sweepEdt(D, nx, ny, nz, sp) {
  const m = Math.max(nx, ny, nz), f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (n, stride, starts, s2) => {
    for (const o of starts) {
      for (let q = 0; q < n; q++) f[q] = D[o + q * stride];
      edt1d(f, n, s2, d, v, z);
      for (let q = 0; q < n; q++) D[o + q * stride] = d[q];
    }
  };
  const startsOf = (fixed) => { const out = []; fixed(out); return out; };
  pass(nx, 1, startsOf(o => { for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) o.push(nx * (j + ny * k)); }), sp[0] * sp[0]);
  pass(ny, nx, startsOf(o => { for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) o.push(i + nx * ny * k); }), sp[1] * sp[1]);
  pass(nz, nx * ny, startsOf(o => { for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) o.push(i + nx * j); }), sp[2] * sp[2]);
}

// The deepest voxel of a mask (1 inside) of size [nx, ny, nz] with spacing
// [sx, sy, sz]; the mask's border voxels must be outside. → index or -1.
function deepest(mask, nx, ny, nz, sp) {
  const N = nx * ny * nz, D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = mask[i] ? BIG : 0;
  const m = Math.max(nx, ny, nz), f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (n, stride, starts, s2) => {
    for (const o of starts) {
      for (let q = 0; q < n; q++) f[q] = D[o + q * stride];
      edt1d(f, n, s2, d, v, z);
      for (let q = 0; q < n; q++) D[o + q * stride] = d[q];
    }
  };
  const startsOf = (fixed) => { const out = []; fixed(out); return out; };
  pass(nx, 1, startsOf(o => { for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) o.push(nx * (j + ny * k)); }), sp[0] * sp[0]);
  pass(ny, nx, startsOf(o => { for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) o.push(i + nx * ny * k); }), sp[1] * sp[1]);
  pass(nz, nx * ny, startsOf(o => { for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) o.push(i + nx * j); }), sp[2] * sp[2]);
  let bd = 0;
  for (let i = 0; i < N; i++) if (mask[i] && D[i] > bd) bd = D[i];
  if (!(bd > 0)) return -1;
  // Ties are common on a grid: of the deepest voxels, the one nearest
  // their mean (the first in memory order when that ties too).
  const lim = bd * (1 - 1e-6);   // (equal up to rounding)
  let cx = 0, cy = 0, cz = 0, c = 0;
  for (let i = 0; i < N; i++) if (mask[i] && D[i] >= lim) { cx += i % nx; cy += Math.floor(i / nx) % ny; cz += Math.floor(i / (nx * ny)); c++; }
  cx /= c; cy /= c; cz /= c;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < N; i++) if (mask[i] && D[i] >= lim) {
    const dx = (i % nx - cx) * sp[0], dy = (Math.floor(i / nx) % ny - cy) * sp[1], dz = (Math.floor(i / (nx * ny)) - cz) * sp[2];
    const e = dx * dx + dy * dy + dz * dz;
    if (e < bestD) { bestD = e; best = i; }
  }
  return best;
}

/**
 * Positions inside regions of a label volume.
 * @param {Object} o
 * @param {ArrayLike<number>} o.raw - the label volume (x fastest)
 * @param {number[]} o.shape - [nx, ny, nz]
 * @param {Function} o.toWorld - voxel [i, j, k] → world [x, y, z] (RAS, mm)
 * @param {{ id: any, values: number[], side: number }[]} o.requests - side 0: left, 1: right, 2: either
 * @param {Function} [o.pause] - awaited after large regions (to keep the page responsive)
 * @returns {Promise<Map<any, number[]|null>>} id → [x, y, z], or null (no voxels)
 */
export async function placeInRegions({ raw, shape, toWorld, requests, pause = null }) {
  const [nx, ny, nz] = shape, A = affineOf(toWorld);
  const sp = [0, 1, 2].map(c => Math.hypot(A[0][c], A[1][c], A[2][c]));
  const out = new Map();
  if (!requests.length) return out;
  // 1. per wanted value and side its bounding box: [x0, y0, z0, x1, y1, z1] ×2
  let maxV = 0;
  for (const r of requests) for (const v of r.values) if (v > maxV) maxV = v;
  const wanted = new Uint8Array(maxV + 1);
  for (const r of requests) for (const v of r.values) if (v > 0) wanted[v] = 1;
  const box = new Map();
  const ax = A[0];
  for (let k = 0, i = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const base = ax[1] * j + ax[2] * k + ax[3];
    for (let x = 0; x < nx; x++, i++) {
      const v = raw[i];
      if (!(v > 0 && v <= maxV && wanted[v])) continue;
      const s = ax[0] * x + base < 0 ? 0 : 1;
      let b = box.get(v);
      if (!b) { b = new Int32Array(12); for (let q = 0; q < 2; q++) b.set([1e9, 1e9, 1e9, -1, -1, -1], 6 * q); box.set(v, b); }
      const o = 6 * s;
      if (x < b[o]) b[o] = x; if (j < b[o + 1]) b[o + 1] = j; if (k < b[o + 2]) b[o + 2] = k;
      if (x > b[o + 3]) b[o + 3] = x; if (j > b[o + 4]) b[o + 4] = j; if (k > b[o + 5]) b[o + 5] = k;
    }
  }
  // 2. per request: the mask in its box (padded by one outside voxel), its deepest voxel
  const inSet = new Uint8Array(maxV + 1);
  for (const r of requests) {
    const sidesOf = s => (s === 2 ? [0, 1] : [s]);
    const unionBox = sides => {
      const u = [1e9, 1e9, 1e9, -1, -1, -1];
      for (const v of r.values) { const b = box.get(v); if (!b) continue;
        for (const s of sides) { const o = 6 * s; if (b[o + 3] < 0) continue;
          for (let c = 0; c < 3; c++) { u[c] = Math.min(u[c], b[o + c]); u[3 + c] = Math.max(u[3 + c], b[o + 3 + c]); } } }
      return u[3] < 0 ? null : u;
    };
    let sides = sidesOf(r.side), u = unionBox(sides);
    if (!u && r.side !== 2) { sides = [0, 1]; u = unionBox(sides); }   // none on that side: the region as a whole
    if (!u) { out.set(r.id, null); continue; }
    for (const v of r.values) if (v > 0 && v <= maxV) inSet[v] = 1;
    const both = sides.length === 2, want = sides[0];
    const mx = u[3] - u[0] + 3, my = u[4] - u[1] + 3, mz = u[5] - u[2] + 3;
    const mask = new Uint8Array(mx * my * mz);
    for (let k = u[2]; k <= u[5]; k++) for (let j = u[1]; j <= u[4]; j++) {
      const base = ax[1] * j + ax[2] * k + ax[3];
      let src = u[0] + nx * (j + ny * k), dst = 1 + mx * ((j - u[1] + 1) + my * (k - u[2] + 1));
      for (let x = u[0]; x <= u[3]; x++, src++, dst++) {
        const v = raw[src];
        if (!(v > 0 && v <= maxV && inSet[v])) continue;
        if (!both && (ax[0] * x + base < 0 ? 0 : 1) !== want) continue;
        mask[dst] = 1;
      }
    }
    for (const v of r.values) if (v > 0 && v <= maxV) inSet[v] = 0;
    const b = deepest(mask, mx, my, mz, sp);
    if (b < 0) { out.set(r.id, null); continue; }
    const bx = b % mx, by = Math.floor(b / mx) % my, bz = Math.floor(b / (mx * my));
    const p = [u[0] + bx - 1, u[1] + by - 1, u[2] + bz - 1];
    out.set(r.id, [0, 1, 2].map(c => A[c][0] * p[0] + A[c][1] * p[1] + A[c][2] * p[2] + A[c][3]));
    if (pause && mask.length > 2e5) await pause();
  }
  return out;
}
