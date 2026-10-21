// ── Region meshes: the worker (see region-meshes.js) ─────────────────────
// Holds one label volume (posted once) and, per request, turns one region
// (label value, or ROI bit) into a closed triangle surface:
//   1. the region's box (computed for all labels in one pass at load),
//      padded with background, as a 0/1 field;
//   2. surface nets on its 0.5 level: one vertex per 2×2×2 cell of voxel
//      centres the level crosses, a quad per grid edge between inside and
//      outside — the surface separates the region's voxels from the rest
//      exactly (thin parts and edge/corner contacts stay connected);
//   3. 'smooth' (default): constrained smoothing — each vertex drawn
//      towards its neighbours but kept inside its own cell (relaxInCells),
//      normals from the smoothed mesh;
//   'voxels': instead the voxel faces themselves, lit flat (voxelFaces);
// Vertices are in voxel index coordinates (voxel centres at integers);
// the main thread maps them to world mm. Triangles wind counter-clockwise
// seen from outside (index order), so front faces face outward.
//
// Request  { type: 'volume', gen, raw: Int32Array, shape, bits, surface }
//          (bits: an ROI set — raw holds one bit per ROI, region v = bit v−1
//          set, so regions may overlap; else region v = the value v;
//          surface: 'smooth' (default: on the voxels, rounded within
//          their cells) or 'voxels' (the voxel faces, lit flat))
//          { type: 'mesh', gen, label }
// Reply    { gen, label, positions, normals: Float32Array, indices: Uint32Array }
//          { gen, label, empty: true }  or  { gen, label, error }
//
// Volume surfaces (js/volume-surfaces.js): a scalar volume's own values,
// meshed at a level, no blur.
// Request  { type: 'field', id, data: Float32Array, shape }   (kept until 'unfield')
//          { type: 'surface', id, seq, level, voxels }   (voxels: the voxels at or above the level as cubes)
//          { type: 'unfield', id }
// Reply    { id, seq, level, positions, normals, indices }, { id, seq, level, empty: true } or { id, seq, error }

const ISO = 0.5;
const PAD = 1;   // background voxels around a region's box (the surface closes in them)

let vol = null; // { gen, raw, shape, bits, boxes: Map(label → [x0,y0,z0,x1,y1,z1]) }

function boxesOf(raw, [nx, ny, nz], bits = false) {
  const boxes = new Map();
  const grow = (v, x, y, z) => {
    const b = boxes.get(v);
    if (!b) { boxes.set(v, [x, y, z, x, y, z]); return; }
    if (x < b[0]) b[0] = x; if (x > b[3]) b[3] = x;
    if (y < b[1]) b[1] = y; if (y > b[4]) b[4] = y;
    if (z < b[2]) b[2] = z; if (z > b[5]) b[5] = z;
  };
  let o = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, o++) {
    const v = raw[o];
    if (v === 0) continue;
    if (!bits) { grow(v, x, y, z); continue; }
    for (let m = v >>> 0, i = 1; m; m >>>= 1, i++) if (m & 1) grow(i, x, y, z);
  }
  return boxes;
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
    if (vol.bits) { const bit = (1 << (label - 1)) >>> 0; for (let i = PAD; i < X - PAD; i++, s++, d++) if ((raw[s] & bit) !== 0) m[d] = 1; }
    else for (let i = PAD; i < X - PAD; i++, s++, d++) if (raw[s] === label) m[d] = 1;
  }
  if (vol.surface === 'voxels') return voxelFaces(m, X, Y, Z, ox, oy, oz);
  // 'smooth': the surface on the voxels themselves (the 0.5 level of the
  // 0/1 field), then rounded within each vertex's own cell (relaxInCells)
  return relaxInCells(surfaceNets(m, X, Y, Z, ISO, ox, oy, oz));
}

// A volume's own values as the field (a probability or vessel map): its
// level surface, no blur. Over the box of the voxels at or above the
// level, padded by one voxel below it, so the surface closes at the
// volume's edge too. NaN counts as below.
function fieldMeshOf(fv, level, voxels = false) {
  const [nx, ny, nz] = fv.shape, d = fv.data;
  let x0 = nx, y0 = ny, z0 = nz, x1 = -1, y1 = -1, z1 = -1, lo = Infinity, o = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, o++) {
    const v = d[o];
    if (v < lo) lo = v;
    if (!(v >= level)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (x1 < 0) return null;
  const below = Math.min(lo, level - 1e-6 * (Math.abs(level) + 1));
  const ox = x0 - 1, oy = y0 - 1, oz = z0 - 1;
  const X = x1 - x0 + 3, Y = y1 - y0 + 3, Z = z1 - z0 + 3, XY = X * Y;
  const f = new Float32Array(X * Y * Z).fill(below);
  for (let k = 1; k < Z - 1; k++) for (let j = 1; j < Y - 1; j++) {
    let s = x0 + nx * ((oy + j) + ny * (oz + k)), t = 1 + X * j + XY * k;
    for (let i = 1; i < X - 1; i++, s++, t++) { const v = d[s]; f[t] = v === v ? v : below; }
  }
  if (voxels) {   // the voxels at or above the level, as cubes
    const m = new Float32Array(f.length);
    for (let i = 0; i < f.length; i++) if (f[i] >= level) m[i] = 1;
    return voxelFaces(m, X, Y, Z, ox, oy, oz);
  }
  return surfaceNets(f, X, Y, Z, level, ox, oy, oz);
}

// The 12 cell edges as corner pairs (corner c = dx + 2dy + 4dz), the 6
// faces as corner cycles, and per mixed cell pattern (8 corner bits) how
// its crossed edges group into separate pieces of surface ("manifold"
// surface nets): crossings on one face belong together; on a face whose
// inside corners sit diagonally, the two inside corners count as joined
// (the surface bridges them, so voxels touching along an edge stay one
// region). A cell where two sheets pass then gets two vertices instead of
// one pinched vertex — no folds, no inverted triangles.
const EDGES = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
const FACES = [[0,2,6,4],[1,3,7,5],[0,1,5,4],[2,3,7,6],[0,1,3,2],[4,5,7,6]];
const EDGE_OF = (() => { const t = {}; EDGES.forEach(([a, b], e) => { t[a * 8 + b] = t[b * 8 + a] = e; }); return t; })();
// per pattern: [nComponents, comp of each edge (−1: not crossed) ...12]
const PATTERN = (() => {
  const T = [];
  for (let pat = 0; pat < 256; pat++) {
    const ins = c => (pat >> c) & 1;
    const par = EDGES.map(([a, b]) => ins(a) !== ins(b) ? -2 : -1);   // −2: crossed, not yet grouped
    const up = Array.from({ length: 12 }, (_, e) => e);
    const find = e => { while (up[e] !== e) e = up[e] = up[up[e]]; return e; };
    const join = (a, b) => { up[find(a)] = find(b); };
    for (const F of FACES) {
      const fe = [0, 1, 2, 3].map(q => EDGE_OF[F[q] * 8 + F[(q + 1) & 3]]);   // fe[q]: corners F[q]–F[q+1]
      const cr = fe.filter(e => par[e] === -2);
      if (cr.length === 2) join(cr[0], cr[1]);
      else if (cr.length === 4) {
        // diagonal: join the two edges around each OUTSIDE corner (the inside ones are bridged)
        for (let q = 0; q < 4; q++) if (!ins(F[q])) join(fe[(q + 3) & 3], fe[q]);
      }
    }
    const id = new Map(); const out = [0];
    for (let e = 0; e < 12; e++) {
      if (par[e] !== -2) { out.push(-1); continue; }
      const r = find(e); if (!id.has(r)) id.set(r, id.size);
      out.push(id.get(r));
    }
    out[0] = id.size;
    T.push(out);
  }
  return T;
})();

// Surface nets on the level iso of the field f (X×Y×Z grid points, grid
// point (i,j,k) = voxel (ox+i, oy+j, oz+k)); the field must be below iso
// on its outer layer. One vertex per piece of surface in a cell (see
// PATTERN; usually one).
function surfaceNets(f, X, Y, Z, iso, ox, oy, oz) {
  const XY = X * Y;
  const CX = X - 1, CY = Y - 1, CZ = Z - 1, CXY = CX * CY;
  const vid = new Int32Array(CX * CY * CZ).fill(-1);   // the cell's first vertex
  const pat = new Uint8Array(CX * CY * CZ);            // its corner pattern
  const pos = [], nrm = [], cel = [];   // cel: each vertex's cell (its lowest corner)
  const c = new Float32Array(8), cn = c;   // (cn: the corners for the normals)
  const sx = new Float64Array(4), sy = new Float64Array(4), sz = new Float64Array(4), cnt = new Int32Array(4);
  for (let k = 0; k < CZ; k++) for (let j = 0; j < CY; j++) for (let i = 0; i < CX; i++) {
    const g = i + X * j + XY * k;
    let bits = 0;
    for (let q = 0; q < 8; q++) { const o = g + (q & 1) + X * ((q >> 1) & 1) + XY * (q >> 2); c[q] = f[o]; if (c[q] >= iso) bits |= 1 << q; }
    if (bits === 0 || bits === 255) continue;
    const P = PATTERN[bits], nc = P[0];
    sx.fill(0); sy.fill(0); sz.fill(0); cnt.fill(0);
    for (let e = 0; e < 12; e++) {
      const comp = P[1 + e];
      if (comp < 0) continue;
      const [a, b] = EDGES[e];
      const t = (iso - c[a]) / (c[b] - c[a]);
      sx[comp] += (a & 1) + t * ((b & 1) - (a & 1));
      sy[comp] += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
      sz[comp] += (a >> 2) + t * ((b >> 2) - (a >> 2));
      cnt[comp]++;
    }
    const ci = i + CX * j + CXY * k;
    vid[ci] = pos.length / 3; pat[ci] = bits;
    for (let q = 0; q < nc; q++) {
      const u = sx[q] / cnt[q], v = sy[q] / cnt[q], w = sz[q] / cnt[q];
      // gradient of the trilinear field at (u, v, w); the outward normal is −gradient
      const gx = (1 - v) * (1 - w) * (cn[1] - cn[0]) + v * (1 - w) * (cn[3] - cn[2]) + (1 - v) * w * (cn[5] - cn[4]) + v * w * (cn[7] - cn[6]);
      const gy = (1 - u) * (1 - w) * (cn[2] - cn[0]) + u * (1 - w) * (cn[3] - cn[1]) + (1 - u) * w * (cn[6] - cn[4]) + u * w * (cn[7] - cn[5]);
      const gz = (1 - u) * (1 - v) * (cn[4] - cn[0]) + u * (1 - v) * (cn[5] - cn[1]) + (1 - u) * v * (cn[6] - cn[2]) + u * v * (cn[7] - cn[3]);
      const gl = Math.hypot(gx, gy, gz) || 1;
      pos.push(ox + i + u, oy + j + v, oz + k + w);
      nrm.push(-gx / gl, -gy / gl, -gz / gl);
      cel.push(ox + i, oy + j, oz + k);
    }
  }
  if (!pos.length) return null;
  // quads: one per pair of neighbouring grid points on either side of the
  // level. A grid edge is shared by 4 cells; in each, the vertex of the
  // piece of surface that crosses it. Wound so the normal points from
  // inside to outside.
  const idx = [], quads = [];   // quads: each as its 4 vertices, counter-clockwise from outside
  const vert = (ci, cj, ck, a, b) => {   // cell (ci,cj,ck), its edge between corners a and b
    const n = ci + CX * cj + CXY * ck, base = vid[n];
    if (base < 0) return -1;
    return base + PATTERN[pat[n]][1 + EDGE_OF[a * 8 + b]];
  };
  const quad = (a, b, cc, d, flip) => {
    if (a < 0 || b < 0 || cc < 0 || d < 0) return;
    if (flip) { idx.push(a, cc, b, a, d, cc); quads.push(a, d, cc, b); }
    else { idx.push(a, b, cc, a, cc, d); quads.push(a, b, cc, d); }
  };
  const ins = o => f[o] >= iso;
  // corner index within a cell for offset (dx,dy,dz)
  const C = (dx, dy, dz) => dx + 2 * dy + 4 * dz;
  for (let k = 1; k < Z - 1; k++) for (let j = 1; j < Y - 1; j++) for (let i = 0; i < X - 1; i++) {
    const o = i + X * j + XY * k, a = ins(o);
    if (a === ins(o + 1)) continue;
    // cell (i, j-1+e1, k-1+e2): the edge lies at dy = 1-e1, dz = 1-e2
    const v = (e1, e2) => vert(i, j - 1 + e1, k - 1 + e2, C(0, 1 - e1, 1 - e2), C(1, 1 - e1, 1 - e2));
    quad(v(0, 0), v(1, 0), v(1, 1), v(0, 1), !a);
  }
  for (let k = 1; k < Z - 1; k++) for (let j = 0; j < Y - 1; j++) for (let i = 1; i < X - 1; i++) {
    const o = i + X * j + XY * k, a = ins(o);
    if (a === ins(o + X)) continue;
    const v = (e1, e2) => vert(i - 1 + e1, j, k - 1 + e2, C(1 - e1, 0, 1 - e2), C(1 - e1, 1, 1 - e2));
    quad(v(0, 0), v(0, 1), v(1, 1), v(1, 0), !a);
  }
  for (let k = 0; k < Z - 1; k++) for (let j = 1; j < Y - 1; j++) for (let i = 1; i < X - 1; i++) {
    const o = i + X * j + XY * k, a = ins(o);
    if (a === ins(o + XY)) continue;
    const v = (e1, e2) => vert(i - 1 + e1, j - 1 + e2, k, C(1 - e1, 1 - e2, 0), C(1 - e1, 1 - e2, 1));
    quad(v(0, 0), v(1, 0), v(1, 1), v(0, 1), !a);
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), indices: Uint32Array.from(idx), cells: cel, quads };
}

// Constrained smoothing (as in "constrained elastic surface nets"): each
// vertex moves towards the mean of its neighbours, but never out of its own
// cell — the 2×2×2 voxel centres around it. The surface rounds off (a
// shallow staircase relaxes to the plane through it) yet still separates
// the region's voxels from the others exactly: a thin part can't vanish,
// and the cut (the caps) still matches. Over-relaxed Gauss–Seidel, so long
// terraces flatten in a few dozen passes. Then each quad is split along
// its flatter diagonal (no folds), and the normals come from the smoothed
// mesh itself (area-weighted), so light and shape agree.
const RELAX_PASSES = 40, RELAX_OMEGA = 1.6, RELAX_MARGIN = 0.02;
const TAUBIN_PASSES = 15, TAUBIN_LAMBDA = 0.5, TAUBIN_MU = -0.53;
function relaxInCells(r) {
  if (!r) return r;
  const P = r.positions, C = r.cells, Qd = r.quads, n = P.length / 3;
  // neighbours along the quads' sides, as compact lists
  const deg = new Int32Array(n + 1);
  const pairs = [];
  for (let t = 0; t < Qd.length; t += 4) for (let e = 0; e < 4; e++) {
    const x = Qd[t + e], y = Qd[t + ((e + 1) & 3)];
    if (x < y) pairs.push(x, y); else pairs.push(y, x);
  }
  // each side is shared by two quads: keep it once
  const key = new Float64Array(pairs.length / 2);
  for (let q = 0; q < key.length; q++) key[q] = pairs[2 * q] * n + pairs[2 * q + 1];
  key.sort();
  const ex = [];
  for (let q = 0; q < key.length; q++) if (q === 0 || key[q] !== key[q - 1]) { const x = Math.floor(key[q] / n), y = key[q] - x * n; ex.push(x, y); deg[x + 1]++; deg[y + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(deg[n]), fill = deg.slice(0, n);
  for (let q = 0; q < ex.length; q += 2) { adj[fill[ex[q]]++] = ex[q + 1]; adj[fill[ex[q + 1]]++] = ex[q]; }
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      const s0 = deg[i], s1 = deg[i + 1];
      if (s1 === s0) continue;
      for (let ax = 0; ax < 3; ax++) {
        let sum = 0;
        for (let q = s0; q < s1; q++) sum += P[3 * adj[q] + ax];
        const cur = P[3 * i + ax];
        let x = cur + RELAX_OMEGA * (sum / (s1 - s0) - cur);
        const lo = C[3 * i + ax] + RELAX_MARGIN, hi = C[3 * i + ax] + 1 - RELAX_MARGIN;
        P[3 * i + ax] = x < lo ? lo : x > hi ? hi : x;
      }
    }
  }
  // then a few unconstrained Taubin passes (λ|μ: smooths without
  // shrinking): where the surface turns sharply — the rim of a thin
  // sheet, a crease — the cells alone leave a zigzag of half a voxel;
  // this irons it out. A vertex still stays within half a voxel of its
  // cell, so nothing thin can vanish.
  const T = new Float32Array(P.length);
  for (let pass = 0; pass < 2 * TAUBIN_PASSES; pass++) {
    const k = pass & 1 ? TAUBIN_MU : TAUBIN_LAMBDA;
    for (let i = 0; i < n; i++) {
      const s0 = deg[i], s1 = deg[i + 1];
      for (let ax = 0; ax < 3; ax++) {
        const cur = P[3 * i + ax];
        if (s1 === s0) { T[3 * i + ax] = cur; continue; }
        let sum = 0;
        for (let q = s0; q < s1; q++) sum += P[3 * adj[q] + ax];
        const x = cur + k * (sum / (s1 - s0) - cur);
        const lo = C[3 * i + ax] - 0.5, hi = C[3 * i + ax] + 1.5;
        T[3 * i + ax] = x < lo ? lo : x > hi ? hi : x;
      }
    }
    P.set(T);
  }
  // triangles: each quad split along the diagonal that folds it least
  const I = new Uint32Array(Qd.length / 4 * 6);
  const tn = (a, b, c) => {
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  for (let t = 0, o = 0; t < Qd.length; t += 4, o += 6) {
    const a = Qd[t], b = Qd[t + 1], c = Qd[t + 2], d = Qd[t + 3];
    if (dot(tn(a, b, c), tn(a, c, d)) >= dot(tn(b, c, d), tn(b, d, a))) { I[o] = a; I[o + 1] = b; I[o + 2] = c; I[o + 3] = a; I[o + 4] = c; I[o + 5] = d; }
    else { I[o] = b; I[o + 1] = c; I[o + 2] = d; I[o + 3] = b; I[o + 4] = d; I[o + 5] = a; }
  }
  // normals from the mesh, pointing the way the field's gradient did
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
  let agree = 0;
  for (let i = 0; i < P.length; i += 3) agree += N[i] * r.normals[i] + N[i + 1] * r.normals[i + 1] + N[i + 2] * r.normals[i + 2];
  const sg = agree < 0 ? -1 : 1;
  for (let i = 0; i < P.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l > 0) { N[i] *= sg / l; N[i + 1] *= sg / l; N[i + 2] *= sg / l; }
    else { N[i] = r.normals[i]; N[i + 1] = r.normals[i + 1]; N[i + 2] = r.normals[i + 2]; }
  }
  return { positions: P, normals: N, indices: I };
}

// 'voxels': the region exactly as its voxels — a square face wherever a
// voxel of the region meets one outside it, lit flat (its own normal), so
// every step shows. Voxel centres at integers, faces at ±0.5.
function voxelFaces(m, X, Y, Z, ox, oy, oz) {
  const XY = X * Y, pos = [], nrm = [], idx = [];
  const st = [1, X, XY];
  for (let k = 1; k < Z - 1; k++) for (let j = 1; j < Y - 1; j++) for (let i = 1; i < X - 1; i++) {
    const o = i + X * j + XY * k;
    if (!m[o]) continue;
    const c = [ox + i, oy + j, oz + k];
    for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
      if (m[o + s * st[a]]) continue;
      const u = (a + 1) % 3, v = (a + 2) % 3, base = pos.length / 3;
      // corners in (u, v): (−,−) (+,−) (+,+) (−,+) — counter-clockwise seen from +a
      const cs = s > 0 ? [[-1, -1], [1, -1], [1, 1], [-1, 1]] : [[-1, -1], [-1, 1], [1, 1], [1, -1]];
      for (const [du, dv] of cs) {
        const p = c.slice(); p[a] += 0.5 * s; p[u] += 0.5 * du; p[v] += 0.5 * dv;
        pos.push(p[0], p[1], p[2]);
        const nn = [0, 0, 0]; nn[a] = s; nrm.push(nn[0], nn[1], nn[2]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  if (!pos.length) return null;
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), indices: Uint32Array.from(idx) };
}

const fields = new Map(); // id → { data: Float32Array, shape } (volume surfaces)

const reply = (base, r) => {
  if (!r) self.postMessage({ ...base, empty: true });
  else self.postMessage({ ...base, positions: r.positions, normals: r.normals, indices: r.indices },
                        [r.positions.buffer, r.normals.buffer, r.indices.buffer]);
};

self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'volume') {
    vol = { gen: msg.gen, raw: msg.raw, shape: msg.shape, bits: !!msg.bits, surface: msg.surface || 'smooth', boxes: boxesOf(msg.raw, msg.shape, !!msg.bits) };
    return;
  }
  if (msg.type === 'mesh') {
    const { gen, label } = msg;
    if (!vol || vol.gen !== gen) { self.postMessage({ gen, label, error: 'volume not loaded' }); return; }
    try { reply({ gen, label }, meshOf(label)); }
    catch (err) { self.postMessage({ gen, label, error: String(err && err.message || err) }); }
    return;
  }
  if (msg.type === 'field') { fields.set(msg.id, { data: msg.data, shape: msg.shape }); return; }
  if (msg.type === 'unfield') { fields.delete(msg.id); return; }
  if (msg.type === 'surface') {
    const { id, seq, level, voxels } = msg, fv = fields.get(id);
    if (!fv) { self.postMessage({ id, seq, error: 'volume not loaded' }); return; }
    try { reply({ id, seq, level }, fieldMeshOf(fv, level, !!voxels)); }
    catch (err) { self.postMessage({ id, seq, error: String(err && err.message || err) }); }
  }
};
