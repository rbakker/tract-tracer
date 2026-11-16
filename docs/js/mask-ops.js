// ── mask-ops.js ───────────────────────────────────────────
// A mask reshaped by a small pipeline (TOOLS › Mask editor, tools/mask.js),
// all in mm on the volume's own voxel sizes, by exact distance transforms:
//   inside   voxels above `level` (default: not 0)
//   close    grown by r mm, then shrunk by r mm: gaps and sulci narrower
//            than about 2r bridged (an envelope over the sulci)
//   open     shrunk by r mm, then grown by r mm: spurs and strands thinner
//            than about 2r removed
//   smooth   the signed distance to its edge blurred (Gaussian, σ mm): no
//            voxel steps, smooth normals
//   offset   the edge moved out by d mm (negative: in)
// Out: a smooth 0–1 field on the same grid, its edge (the surface) at 0.5,
// the ramp one voxel wide — a surface at sub-voxel precision when rendered
// solid (background below 0.5), and a soft mask (APPLY MASK: weighted by it).
//
// No app state; runs in a worker (js/mask-worker.js) or anywhere.

import { distanceSquared } from './region-place.js';

/**
 * @param {Object} o
 * @param {ArrayLike<number>} o.data - the mask volume (x fastest), the first frame
 * @param {number[]} o.shape - [nx, ny, nz]
 * @param {number[]} o.spacing - voxel size [sx, sy, sz], mm
 * @param {number} [o.level=0] - inside: values above it
 * @param {number} [o.close=0], [o.open=0], [o.smooth=0], [o.offset=0] - mm
 * @param {Function} [o.progress] - (text) as it goes
 * @returns {{ field: Float32Array, inside: number }} the field; its voxels above 0.5
 */
export function shapeMask({ data, shape, spacing, level = 0, close = 0, open = 0, smooth = 0, offset = 0, progress = () => {} }) {
  const [NX, NY, NZ] = shape, sp = spacing, h = (sp[0] + sp[1] + sp[2]) / 3;
  // the work on the mask's box, with room for growing and blurring
  let lo = [NX, NY, NZ], hi = [-1, -1, -1];
  for (let k = 0, o = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++, o++) {
    const v = data[o];
    if (v > level) { if (i < lo[0]) lo[0] = i; if (i > hi[0]) hi[0] = i; if (j < lo[1]) lo[1] = j; if (j > hi[1]) hi[1] = j; if (k < lo[2]) lo[2] = k; if (k > hi[2]) hi[2] = k; }
  }
  const field = new Float32Array(NX * NY * NZ);
  if (hi[0] < 0) return { field, inside: 0 };
  const marginMm = Math.max(0, close) + Math.max(0, offset) + 3 * smooth + 2 * h;
  const m = [0, 1, 2].map(a => Math.ceil(marginMm / sp[a]) + 1);
  const b0 = [0, 1, 2].map(a => Math.max(0, lo[a] - m[a])), b1 = [0, 1, 2].map(a => Math.min(shape[a] - 1, hi[a] + m[a]));
  const [nx, ny, nz] = [0, 1, 2].map(a => b1[a] - b0[a] + 1), n = nx * ny * nz;
  const idx = (i, j, k) => (i + b0[0]) + NX * ((j + b0[1]) + NY * (k + b0[2]));
  let ins = new Uint8Array(n);
  for (let k = 0, o = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, o++) ins[o] = data[idx(i, j, k)] > level ? 1 : 0;
  const grow = (s, r) => { const D = distanceSquared(i => !s[i], nx, ny, nz, sp), r2 = r * r, out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = D[i] <= r2 + 1e-6 ? 1 : 0; return out; };
  const shrink = (s, r) => { const D = distanceSquared(i => !!s[i], nx, ny, nz, sp), r2 = r * r, out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = s[i] && D[i] > r2 + 1e-6 ? 1 : 0; return out; };
  if (close > 0) { progress('closing…'); ins = shrink(grow(ins, close), close); }
  if (open > 0) { progress('opening…'); ins = grow(shrink(ins, open), open); }
  // the signed distance to the edge (mm, + outside): from voxel centres, half a voxel to the edge
  progress('distances…');
  const dOut = distanceSquared(i => !ins[i], nx, ny, nz, sp), dIn = distanceSquared(i => !!ins[i], nx, ny, nz, sp);
  let sd = new Float32Array(n);
  for (let i = 0; i < n; i++) sd[i] = ins[i] ? -(Math.sqrt(dIn[i]) - h / 2) : Math.sqrt(dOut[i]) - h / 2;
  if (smooth > 0) { progress('smoothing…'); sd = gaussian3(sd, [nx, ny, nz], [0, 1, 2].map(a => smooth / sp[a])); }
  let inside = 0;
  for (let k = 0, o = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, o++) {
    const v = Math.min(1, Math.max(0, 0.5 - (sd[o] - offset) / h));
    field[idx(i, j, k)] = v;
    if (v > 0.5) inside++;
  }
  return { field, inside };
}

// separable Gaussian, σ per axis in voxels; the border clamped
function gaussian3(src, [nx, ny, nz], sig) {
  let a = src, b = new Float32Array(src.length);
  const axis = (s, len, stride, starts) => {
    if (!(s > 0.05)) return;
    const R = Math.ceil(3 * s), w = new Float32Array(2 * R + 1);
    let tot = 0; for (let t = -R; t <= R; t++) tot += (w[t + R] = Math.exp(-t * t / (2 * s * s)));
    for (let t = 0; t < w.length; t++) w[t] /= tot;
    const line = new Float32Array(len);
    for (const o of starts) {
      for (let q = 0; q < len; q++) line[q] = a[o + q * stride];
      for (let q = 0; q < len; q++) {
        let v = 0;
        for (let t = -R; t <= R; t++) { const p = Math.min(len - 1, Math.max(0, q + t)); v += w[t + R] * line[p]; }
        b[o + q * stride] = v;
      }
    }
    [a, b] = [b, a];
  };
  const starts = f => { const out = []; f(out); return out; };
  axis(sig[0], nx, 1, starts(o => { for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) o.push(nx * (j + ny * k)); }));
  axis(sig[1], ny, nx, starts(o => { for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) o.push(i + nx * ny * k); }));
  axis(sig[2], nz, nx * ny, starts(o => { for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) o.push(i + nx * j); }));
  return a;
}
