// ── Diffusion tensor fit (a worker, started only when asked for) ─────────
// A 4D DWI series (NIfTI) and its gradient table → per voxel the diffusion
// tensor (log-linear least squares), and from it FA, MD and the principal
// direction V1. Meant for quality control, not as a processing pipeline:
// unweighted, no outlier rejection.
//
// The frames are read one at a time (forEachNiftiFrame), never all at once:
// the least-squares solution is linear in log S, so each frame only adds its
// share to 7 sums per voxel — memory 7 floats per voxel, whatever the
// number of frames.
//
// ORIENTATION CHECK (as MRtrix's dwigradcheck): a gradient table with a
// flipped or swapped axis gives each voxel's tensor the same flip/swap —
// V1 → P·V1. With the right table, V1 follows the fibre bundles, so tracks
// that follow V1 run long; with a wrong one they soon turn off course. For
// each of the 24 distinct flips/swaps P: short deterministic tracks along
// P·V1 from white-matter seeds (FA > 0.4), stopped at FA < 0.15 or a turn
// over 45°; the score is their mean length. The table as given should win.
//
// Request  { file, bvals, bvecs, flipX }   (flipX: FSL's x flip, see index.html gradientDirsWorld)
// Replies  { progress: 0..1 }  …  then
//          { shape, fa, md, v1 (3/voxel, voxel-axis mm frame), mask, scores: [{ name, perm, sign, score (mm) }] best first, nFit, nSeeds }
//          or { error }

import { forEachNiftiFrame } from './volume-io.js';
import { brainMask } from './brain-mask.js';

const B0_MAX = 50;

function solve7(M) {   // inverse of a 7×7 symmetric matrix (Gauss–Jordan)
  const n = 7, a = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c]; if (Math.abs(d) < 1e-12) throw 'the gradient table cannot determine a tensor (too few or repeated directions)';
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c]; if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j]; }
  }
  return a.map(r => r.slice(n));
}

// eigen-decomposition of a symmetric 3×3 (Jacobi): values descending, vectors as columns
function eig3(xx, yy, zz, xy, xz, yz) {
  const a = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]], v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
  }
  const l = [a[0][0], a[1][1], a[2][2]], o = [0, 1, 2].sort((i, j) => l[j] - l[i]);
  return { l: o.map(i => l[i]), v1: [v[0][o[0]], v[1][o[0]], v[2][o[0]]] };
}

// the 24 distinct flips/swaps: 6 axis orders × (none, flip x, flip y, flip z)
// (flipping two axes is flipping the third, up to a sign V1 doesn't have)
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const PERM_NAMES = ['', 'swap yz', 'swap xy', 'xyz → yzx', 'xyz → zxy', 'swap xz'];
const SIGNS = [[1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1]];
const SIGN_NAMES = ['', 'flip x', 'flip y', 'flip z'];

self.onmessage = async e => {
  const { file, bvals, bvecs, voxMm, flipX, si, mask: given } = e.data;
  try {
    const N = bvals.length;
    // Which frames: the b=0s and the LOWEST diffusion-weighted shell. A tensor
    // describes the signal well only at modest weighting; with several shells
    // (and ex-vivo data, whose diffusivity is a few times lower, often has
    // high b-values only) the lowest shell is the right one.
    const order = bvals.map((b, i) => [b, i]).filter(([b]) => b > B0_MAX).sort((a, c) => a[0] - c[0]);
    if (!order.length) throw 'no diffusion-weighted frame';
    const lowB = order[0][0], tol = Math.max(50, 0.05 * lowB);
    const shellIdx = order.filter(([b]) => Math.abs(b - lowB) <= tol && b <= lowB + 2 * tol).map(([, i]) => i);
    const bShell = Math.round(shellIdx.reduce((s, i) => s + bvals[i], 0) / shellIdx.length);
    const used = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (bvals[i] <= B0_MAX) used[i] = 1;
    for (const i of shellIdx) used[i] = 1;
    // design: ln S = ln S0 − b gᵀDg, unknowns [ln S0, Dxx, Dyy, Dzz, Dxy, Dxz, Dyz]
    const X = bvals.map((b, i) => { const [x, y, z] = bvecs[i]; return [1, -b * x * x, -b * y * y, -b * z * z, -2 * b * x * y, -2 * b * x * z, -2 * b * y * z]; });
    const rows = X.filter((_, i) => used[i]);
    const XtX = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
    const Minv = solve7(XtX);
    // pass 1: the mean b=0 and the mean of the shell (for the brain mask, and
    // the signal floor: the data's own scale — float data may be all below 1)
    let acc = null, b0 = null, dw = null, nb0 = 0, ndw = 0, shape = null, n = 0;
    await forEachNiftiFrame(file, (v, f) => {
      if (v >= N || !used[v]) return;
      if (!b0) { n = f.length; b0 = new Float32Array(n); dw = new Float32Array(n); }
      if (bvals[v] <= B0_MAX) { nb0++; for (let i = 0; i < n; i++) b0[i] += f[i]; }
      else { ndw++; for (let i = 0; i < n; i++) dw[i] += f[i]; }
      self.postMessage({ progress: 0.4 * (v + 1) / N });
    }).then(r => { shape = r.shape; });
    if (!nb0) throw 'no b=0 frame';
    for (let i = 0; i < n; i++) b0[i] /= nb0;
    if (ndw) for (let i = 0; i < n; i++) dw[i] /= ndw;
    // pass 2: the least-squares sums of ln S, the signal floored at 0.1% of the voxel's b=0
    // (a zero or negative value would otherwise give an infinite log)
    acc = new Float32Array(7 * n);
    let gmax = 0; for (let i = 0; i < n; i += 97) if (b0[i] > gmax) gmax = b0[i];
    const tiny = 1e-6 * (gmax || 1);
    await forEachNiftiFrame(file, (v, f) => {
      if (v >= N || !used[v]) return;
      const row = X[v];
      for (let i = 0; i < n; i++) {
        const fl = Math.max(1e-3 * b0[i], tiny);
        const y = Math.log(f[i] > fl ? f[i] : fl);
        const o = 7 * i;
        for (let k = 0; k < 7; k++) acc[o + k] += row[k] * y;
      }
      self.postMessage({ progress: 0.4 + 0.4 * (v + 1) / N });
    });
    const brain = (given && given.length === n ? given : brainMask(b0, ndw ? dw : null, shape, si));
    const fa = new Float32Array(n), md = new Float32Array(n), v1 = new Float32Array(3 * n), mask = new Uint8Array(n);
    let nFit = 0;
    const d = new Float64Array(7);
    for (let i = 0; i < n; i++) {
      if (!brain[i]) continue;
      const o = 7 * i;
      for (let k = 0; k < 7; k++) { let s = 0; for (let j = 0; j < 7; j++) s += Minv[k][j] * acc[o + j]; d[k] = s; }
      const { l, v1: e1 } = eig3(d[1], d[2], d[3], d[4], d[5], d[6]);
      const m = (l[0] + l[1] + l[2]) / 3;
      const num = (l[0] - m) ** 2 + (l[1] - m) ** 2 + (l[2] - m) ** 2, den = l[0] * l[0] + l[1] * l[1] + l[2] * l[2];
      fa[i] = den > 0 ? Math.min(1, Math.sqrt(1.5 * num / den)) : 0;
      // MD in µm²/ms (= 10⁻³ mm²/s): brain ≈ 0.7–1, CSF ≈ 3; noisy fits clamped to 0–5, so the
      // background (0, outside the brain) is the volume's minimum
      md[i] = Math.max(0, Math.min(5, m * 1000));
      // V1 in the voxel axes, in mm (FSL: x negated for neurological storage)
      v1[3 * i] = flipX ? -e1[0] : e1[0]; v1[3 * i + 1] = e1[1]; v1[3 * i + 2] = e1[2];
      mask[i] = 1; nFit++;
      if ((i & 0xffff) === 0) self.postMessage({ progress: 0.8 + 0.15 * i / n });
    }
    // orientation check: short deterministic tracks from white-matter seeds, per flip/swap
    const [nx, ny, nz] = shape, vs = voxMm, h = 0.5 * Math.min(vs[0], vs[1], vs[2]);
    const cand = [];
    for (let i = 0; i < n; i++) if (mask[i] && fa[i] > 0.4) cand.push(i);
    const seeds = [];
    const stride = Math.max(1, Math.floor(cand.length / 4000));
    for (let k = 0; k < cand.length; k += stride) seeds.push(cand[k]);
    const scores = [];
    const MAX_STEPS = 400, COS_MAX = Math.cos(45 * Math.PI / 180);
    for (let pi = 0; pi < PERMS.length; pi++) for (let si = 0; si < SIGNS.length; si++) {
      const P = PERMS[pi], S = SIGNS[si];
      // V1 at voxel j as the changed table would give it, in the voxel axes (mm)
      const dirAt = (j, out) => {
        const t0 = flipX ? -v1[3 * j] : v1[3 * j], t = [t0, v1[3 * j + 1], v1[3 * j + 2]];
        out[0] = S[0] * t[P[0]]; out[1] = S[1] * t[P[1]]; out[2] = S[2] * t[P[2]];
        if (flipX) out[0] = -out[0];
      };
      const u = [0, 0, 0];
      let total = 0;
      for (const i of seeds) {
        const x0 = i % nx, y0 = Math.floor(i / nx) % ny, z0 = Math.floor(i / (nx * ny));
        for (const sg of [1, -1]) {
          // position in voxel index units; direction in mm
          let px = x0, py = y0, pz = z0;
          dirAt(i, u);
          let dx = sg * u[0], dy = sg * u[1], dz = sg * u[2];
          let steps = 0;
          for (; steps < MAX_STEPS; steps++) {
            px += dx * h / vs[0]; py += dy * h / vs[1]; pz += dz * h / vs[2];
            const qx = Math.round(px), qy = Math.round(py), qz = Math.round(pz);
            if (qx < 0 || qy < 0 || qz < 0 || qx >= nx || qy >= ny || qz >= nz) break;
            const j = qx + nx * (qy + ny * qz);
            if (!mask[j] || fa[j] < 0.15) break;
            dirAt(j, u);
            let c = u[0] * dx + u[1] * dy + u[2] * dz;
            if (c < 0) { u[0] = -u[0]; u[1] = -u[1]; u[2] = -u[2]; c = -c; }
            if (c < COS_MAX) break;
            dx = u[0]; dy = u[1]; dz = u[2];
          }
          total += steps * h;
        }
      }
      const name = [PERM_NAMES[pi], SIGN_NAMES[si]].filter(Boolean).join(', ') || 'as given';
      // the score: the mean track length (mm) from a seed, both ways together
      scores.push({ name, perm: P, sign: S, score: seeds.length ? total / seeds.length : 0 });
      self.postMessage({ progress: 0.95 + 0.05 * scores.length / 24 });
    }
    scores.sort((a, c) => c.score - a.score);
    self.postMessage({ progress: 1 });
    self.postMessage({ shape, fa, md, v1, mask, scores, nFit, nSeeds: seeds.length, bShell, nUsed: shellIdx.length, nb0 }, [fa.buffer, md.buffer, v1.buffer, mask.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
