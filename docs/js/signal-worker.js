// ── Per-volume signal check (a worker, started only when asked for) ──────
// On the raw series, before any processing: which frames, and which slices
// of them, lost signal — dropout from bulk motion during the diffusion
// gradient, a spike, vibration. Per frame and slice the mean signal within
// a brain mask (brain-mask.js), compared with the other frames of the same
// shell in that slice: robustly, against their median and its spread
// (MAD), so a few bad frames don't hide themselves.
//
//   a slice is an OUTLIER when (local dropout, see pass 3) ≥ 25% of its
//   brain voxels keep less than 60% of their signal, or when (as a whole) it
//   is ≥ 20% below the shell's median there
//   AND ≥ 25% below its own frame's neighbouring slices (relative to that
//   median) — the diffusion direction changes the signal smoothly over
//   slices, dropout hits single slices;
//   a frame is OFF when its whole-brain mean is ≥ 10% from the shell's
//   median AND more than 4 robust standard deviations away.
//
// A shell needs 4 frames or more to be compared (a single b=0 can't be).
// Slices with fewer than 50 brain voxels are left out.
//
// The volume it makes: per voxel, in the flagged slices, how much of its
// signal the frame lost against the voxel's own mean over the shell's other
// frames (smoothed in-slice; the largest over the frames) — where in the
// slice the signal went.
//
// Request  { file, bvals, sliceAxis (0, 1 or 2: the acquisition's slice direction) }
// Replies  { progress } … then { shape, nSlices, mask, frameMean, slices: [{ frame, slice, loss, q }],
//            frames: [{ frame, dev, z }], groups: [{ b, n, checked }], nChecked } or { error }

import { forEachNiftiFrame } from './volume-io.js';
import { brainMask } from './brain-mask.js';

const B0_MAX = 50, MIN_VOX = 50;

function shells(bvals) {
  const order = bvals.map((b, i) => [b, i]).sort((a, c) => a[0] - c[0]);
  const out = [];
  for (const [b, i] of order) {
    const last = out[out.length - 1];
    const same = last && (b <= B0_MAX ? last.b0 : !last.b0 && Math.abs(b - last.sum / last.idx.length) <= Math.max(50, 0.05 * b));
    if (same) { last.idx.push(i); last.sum += b; } else out.push({ b0: b <= B0_MAX, sum: b, idx: [i] });
  }
  for (const s of out) s.b = s.b0 ? 0 : Math.round(s.sum / s.idx.length / 10) * 10;
  return out;
}
const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

self.onmessage = async e => {
  const { file, bvals, sliceAxis, si, mask: given } = e.data;
  try {
    const N = bvals.length;
    // pass 1: the mean b=0 and mean diffusion-weighted image, for the brain mask
    let b0 = null, dw = null, nb0 = 0, ndw = 0, shape = null, n = 0;
    await forEachNiftiFrame(file, (v, f) => {
      if (v >= N) return;
      if (!b0) { n = f.length; b0 = new Float32Array(n); dw = new Float32Array(n); }
      if (bvals[v] <= B0_MAX) { nb0++; for (let i = 0; i < n; i++) b0[i] += f[i]; }
      else { ndw++; for (let i = 0; i < n; i++) dw[i] += f[i]; }
      self.postMessage({ progress: 0.45 * (v + 1) / N });
    }).then(r => { shape = r.shape; });
    if (!nb0) throw 'no b=0 frame';
    for (let i = 0; i < n; i++) b0[i] /= nb0;
    if (ndw) for (let i = 0; i < n; i++) dw[i] /= ndw;
    const mask = (given && given.length === n ? given : brainMask(b0, ndw ? dw : null, shape, si));
    // each voxel's slice
    const [nx, ny] = shape, nS = shape[sliceAxis];
    const sliceOf = new Int32Array(n);
    for (let i = 0; i < n; i++) sliceOf[i] = sliceAxis === 0 ? i % nx : sliceAxis === 1 ? Math.floor(i / nx) % ny : Math.floor(i / (nx * ny));
    const count = new Float64Array(nS);
    for (let i = 0; i < n; i++) if (mask[i]) count[sliceOf[i]]++;
    // pass 2: per frame, per slice, the mean signal in the brain; and per
    // shell (that can be compared) each brain voxel's sum over its frames
    const shellList = shells(bvals), shellOf = new Int32Array(N).fill(-1);
    shellList.forEach((g, k) => { if (g.idx.length >= 4) for (const v of g.idx) shellOf[v] = k; });
    const sums = shellList.map(g => (g.idx.length >= 4 ? new Float32Array(n) : null));
    const M = Array.from({ length: N }, () => new Float64Array(nS));
    await forEachNiftiFrame(file, (v, f) => {
      if (v >= N) return;
      const m = M[v], sum = shellOf[v] >= 0 ? sums[shellOf[v]] : null;
      for (let i = 0; i < n; i++) if (mask[i]) { m[sliceOf[i]] += f[i]; if (sum) sum[i] += f[i]; }
      for (let z = 0; z < nS; z++) if (count[z]) m[z] /= count[z];
      self.postMessage({ progress: 0.4 + 0.4 * (v + 1) / N });
    });
    const totalVox = count.reduce((a, b) => a + b, 0);
    const frameMean = M.map(m => { let s = 0; for (let z = 0; z < nS; z++) s += m[z] * count[z]; return totalVox ? s / totalVox : 0; });
    // compare within each shell
    const slices = [], frames = [], groups = [];
    let nChecked = 0;
    for (const g of shellList) {
      const checked = g.idx.length >= 4;
      groups.push({ b: g.b, n: g.idx.length, idx: g.idx.slice(), checked });
      if (!checked) continue;
      // r: each slice against the shell's median there. The diffusion direction
      // alone moves r too (white matter is anisotropic), but smoothly over the
      // slices; dropout hits single slices. So a slice is compared with its own
      // frame's neighbouring slices as well: q = r / mean(r of the slices
      // next to it).
      const med = new Float64Array(nS);
      for (let z = 0; z < nS; z++) if (count[z] >= MIN_VOX) med[z] = median(g.idx.map(v => M[v][z]));
      for (const v of g.idx) {
        const r = z => (count[z] >= MIN_VOX && med[z] > 0 ? M[v][z] / med[z] : NaN);
        for (let z = 0; z < nS; z++) {
          const rz = r(z); if (!Number.isFinite(rz)) continue;
          nChecked++;
          // the brighter of the next slices (or of those two further, at an edge)
          let nb = [r(z - 1), r(z + 1)].filter(Number.isFinite);
          if (!nb.length) nb = [r(z - 2), r(z + 2)].filter(Number.isFinite);
          const ref = nb.length ? Math.max(...nb) : 1;
          const q = rz / ref;
          if (q <= 0.75 && rz <= 0.8) slices.push({ frame: v, slice: z, loss: 1 - rz, q });
        }
      }
      const vals = g.idx.map(v => frameMean[v]);
      const fmed = median(vals), fmad = 1.4826 * median(vals.map(x => Math.abs(x - fmed))) || 1e-12;
      g.idx.forEach((v, k) => {
        const dev = fmed > 0 ? vals[k] / fmed - 1 : 0, zz = (vals[k] - fmed) / fmad;
        if (Math.abs(dev) >= 0.1 && Math.abs(zz) > 4) frames.push({ frame: v, dev, z: zz });
      });
    }
    frames.sort((a, c) => Math.abs(c.dev) - Math.abs(a.dev));
    // pass 3 (the compared shells' frames): per voxel the frame's signal
    // against the voxel's own mean over the OTHER frames of its shell, r,
    // smoothed within the slice (3×3). Two things from it:
    //   · LOCAL dropout, which the slice mean misses when only part of the
    //     slice is hit: a slice where ≥ 25% of the brain voxels keep less
    //     than 60% of their signal (the direction alone rarely does that to
    //     more than a few voxels);
    //   · the volume: in every flagged slice, the signal lost (1 − r), the
    //     largest over the frames — where in the slice it went.
    const loss = new Float32Array(n);
    const flagged = new Map();   // frame → Set of slices (from the slice means)
    for (const x of slices) { if (!flagged.has(x.frame)) flagged.set(x.frame, new Set()); flagged.get(x.frame).add(x.slice); }
    const r = new Float32Array(n), t = new Float32Array(n);
    const [ax0, ax1] = [0, 1, 2].filter(a => a !== sliceAxis), st = [1, nx, nx * ny];
    const coord = (i, a) => (a === 0 ? i % nx : a === 1 ? Math.floor(i / nx) % ny : Math.floor(i / (nx * ny)));
    const c0 = new Int32Array(n), c1 = new Int32Array(n);
    for (let i = 0; i < n; i++) { c0[i] = coord(i, ax0); c1[i] = coord(i, ax1); }
    const box = (src, dst, ax, cc) => {   // 1D mean of 3 along axis ax, over brain voxels
      for (let i = 0; i < n; i++) {
        if (!mask[i]) { dst[i] = 1; continue; }
        let s2 = src[i], w = 1;
        if (cc[i] > 0 && mask[i - st[ax]]) { s2 += src[i - st[ax]]; w++; }
        if (cc[i] < shape[ax] - 1 && mask[i + st[ax]]) { s2 += src[i + st[ax]]; w++; }
        dst[i] = s2 / w;
      }
    };
    const nComp = shellOf.filter(k => k >= 0).length;
    let done = 0;
    await forEachNiftiFrame(file, (v, f) => {
      if (v >= N || shellOf[v] < 0) return;
      const sum = sums[shellOf[v]], k = shellList[shellOf[v]].idx.length;
      for (let i = 0; i < n; i++) {
        if (!mask[i]) { r[i] = 1; continue; }
        const ref = (sum[i] - f[i]) / (k - 1);
        r[i] = ref > 0 ? f[i] / ref : 1;
      }
      box(r, t, ax0, c0); box(t, r, ax1, c1);
      const low = new Float64Array(nS), lowLoss = new Float64Array(nS);
      for (let i = 0; i < n; i++) if (mask[i] && r[i] < 0.6) { low[sliceOf[i]]++; lowLoss[sliceOf[i]] += 1 - r[i]; }
      const zs = flagged.get(v) || new Set();
      for (let z = 0; z < nS; z++) {
        if (count[z] < MIN_VOX || zs.has(z)) continue;
        const frac = low[z] / count[z];
        if (frac >= 0.25) { zs.add(z); slices.push({ frame: v, slice: z, loss: lowLoss[z] / low[z], area: frac, local: true }); }
      }
      if (zs.size) for (let i = 0; i < n; i++) if (mask[i] && zs.has(sliceOf[i])) { const l = Math.max(0, Math.min(1, 1 - r[i])); if (l > loss[i]) loss[i] = l; }
      self.postMessage({ progress: 0.8 + 0.2 * (++done) / nComp });
    });
    slices.sort((a, c) => c.loss * (c.area || 1) - a.loss * (a.area || 1));
    self.postMessage({ progress: 1 });
    self.postMessage({ shape, nSlices: nS, mask, loss, frameMean, slices, frames, groups, nChecked, sliceCount: Array.from(count) }, [mask.buffer, loss.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
