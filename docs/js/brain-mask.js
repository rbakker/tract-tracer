// ── brain-mask.js ─────────────────────────────────────────
// A brain mask from a diffusion series itself (no other image needed),
// shared by the quality-control workers (tensor-worker.js, signal-worker.js).

// ── A brain mask from the series itself ──
// 1. the head: the mean b=0 above 15% of its 99th percentile;
// 2. within it, the mean diffusion-weighted image above half its Otsu
//    level — scalp and fat lose their signal with diffusion weighting,
//    the brain keeps it;
// 3. the largest connected piece, closed (2 voxels), its holes filled,
//    eroded by one voxel, and again the largest piece;
// 4. opened by 3 voxels (cuts thin bridges to eyes and jaw);
// 5. with the inferior–superior axis given: cut below the neck.
export function otsu(vals) {
  let lo = Infinity, hi = -Infinity; for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return lo;
  const B = 256, h = new Float64Array(B);
  for (const v of vals) h[Math.min(B - 1, Math.floor((v - lo) / (hi - lo) * B))]++;
  let T = 0, mT = 0; for (let k = 0; k < B; k++) { T += h[k]; mT += h[k] * k; }
  let w = 0, m = 0, best = -1, bk = 0;
  for (let k = 0; k < B; k++) { w += h[k]; m += h[k] * k; if (w === 0 || w === T) continue; const s = (mT * w - m * T) ** 2 / (w * (T - w)); if (s > best) { best = s; bk = k; } }
  return lo + (bk + 0.5) / B * (hi - lo);
}
// si (optional): { axis, up } — the voxel axis most along inferior–superior
// and whether its index grows upward; with it the neck is cut off (step 5).
export function brainMask(b0, dw, [nx, ny, nz], si = null) {
  const n = nx * ny * nz;
  const sample = []; for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 200000))) if (b0[i] > 0) sample.push(b0[i]);
  sample.sort((a, c) => a - c);
  const thr = 0.15 * (sample[Math.floor(0.99 * (sample.length - 1))] || 0);
  let m = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (b0[i] > thr) m[i] = 1;
  if (dw) {
    const inHead = []; for (let i = 0; i < n; i++) if (m[i]) inHead.push(dw[i]);
    const t = 0.5 * otsu(inHead);
    for (let i = 0; i < n; i++) if (m[i] && !(dw[i] > t)) m[i] = 0;
  }
  const NB = [1, -1, nx, -nx, nx * ny, -nx * ny];
  const inside = (i, k) => { const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    return k === 0 ? x < nx - 1 : k === 1 ? x > 0 : k === 2 ? y < ny - 1 : k === 3 ? y > 0 : k === 4 ? z < nz - 1 : z > 0; };
  const largest = a => {   // the largest 6-connected piece of a
    const lab = new Int32Array(n); let best = 0, bestSize = 0, cur = 0; const st = [];
    for (let s = 0; s < n; s++) {
      if (!a[s] || lab[s]) continue;
      cur++; let size = 0; st.push(s); lab[s] = cur;
      while (st.length) { const i = st.pop(); size++; for (let k = 0; k < 6; k++) if (inside(i, k)) { const j = i + NB[k]; if (a[j] && !lab[j]) { lab[j] = cur; st.push(j); } } }
      if (size > bestSize) { bestSize = size; best = cur; }
    }
    const o = new Uint8Array(n); for (let i = 0; i < n; i++) if (lab[i] === best && best) o[i] = 1; return o;
  };
  const grow = (a, on) => {   // dilate (on = 1) or erode (on = 0) by one voxel
    const o = a.slice();
    for (let i = 0; i < n; i++) if (a[i] !== on) for (let k = 0; k < 6; k++) if (inside(i, k) && a[i + NB[k]] === on) { o[i] = on; break; }
    return o;
  };
  const fill = a => {   // holes: background not reached from the volume's border
    const out = new Uint8Array(n), st = [];
    for (let i = 0; i < n; i++) {
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      if (!a[i] && (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1)) { out[i] = 1; st.push(i); }
    }
    while (st.length) { const i = st.pop(); for (let k = 0; k < 6; k++) if (inside(i, k)) { const j = i + NB[k]; if (!a[j] && !out[j]) { out[j] = 1; st.push(j); } } }
    const r = new Uint8Array(n); for (let i = 0; i < n; i++) r[i] = out[i] ? 0 : 1; return r;
  };
  m = largest(m);
  m = grow(grow(m, 1), 1); m = grow(grow(m, 0), 0);
  m = fill(m);
  m = grow(m, 0);
  m = largest(m);
  // 4. opened (3 voxels): thin bridges to the eyes, the jaw, the neck break;
  //    the largest piece, grown back within the mask
  {
    let e = m;
    for (let k = 0; k < 3; k++) e = grow(e, 0);
    e = largest(e);
    for (let k = 0; k < 3; k++) e = grow(e, 1);
    for (let i = 0; i < n; i++) if (e[i] && !m[i]) e[i] = 0;
    if (e.some(v => v)) m = e;
  }
  // 5. the neck: going down from the slice where the brain is largest, the
  //    first slice under 15% of that area (the brainstem narrowing) — what
  //    lies below goes (jaw, tongue, neck muscles: they move, and aren't brain)
  if (si && si.axis >= 0 && si.axis <= 2) {
    const dims = [nx, ny, nz], A = si.axis, nA = dims[A];
    const at = i => (A === 0 ? i % nx : A === 1 ? Math.floor(i / nx) % ny : Math.floor(i / (nx * ny)));
    const area = new Float64Array(nA);
    for (let i = 0; i < n; i++) if (m[i]) area[at(i)]++;
    let zMax = 0; for (let z = 1; z < nA; z++) if (area[z] > area[zMax]) zMax = z;
    const down = si.up ? -1 : 1;
    let cut = -1;
    for (let z = zMax; z >= 0 && z < nA; z += down) if (area[z] < 0.15 * area[zMax]) { cut = z; break; }
    if (cut >= 0) {
      for (let i = 0; i < n; i++) { const z = at(i); if (m[i] && (down < 0 ? z < cut : z > cut)) m[i] = 0; }
      m = largest(m);
    }
  }
  return m;
}

