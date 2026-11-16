// ── region-probe.js ───────────────────────────────────────
// The REGION PROBE's data: which brain region each streamline ends in, and
// per region the streamlines that end there — built once per tractogram,
// label volume, region filter and search radius, then queried for free.
//
// An end is assigned to the region of the label volume at its voxel when
// that region counts as an endpoint (the region filter: grey matter, say,
// and not white matter or ventricles); otherwise to the nearest region
// that does, within the search radius (an end that stops short of the
// cortex); otherwise to none (0).
//
// Pure functions (no app state): index.html passes the label volume and a
// world → voxel function.

// Region names compared as words: lower case, '-', '_' and '.' as spaces.
const norm = s => ' ' + String(s).toLowerCase().replace(/[-_.,/|()]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
// "white matter, WM" → ['white matter', 'wm']
export const keywordsOf = text => String(text || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
const matchesAny = (names, kws) => kws.some(k => { const n = norm(k); return names.some(x => x.includes(n)); });

// The names a region is matched by: its own and those of the groups above
// it in the region tree (so a parent region works as a keyword).
function namesByIndex(map, tree) {
  const out = new Map();
  for (const [v, e] of map) out.set(v, [norm(e && e.name != null ? e.name : v)]);
  if (tree && tree.roots) {
    const walk = (nd, up) => {
      const here = [...up, norm(nd.name || '')];
      if (nd.index != null && out.has(nd.index)) out.set(nd.index, [...new Set([...out.get(nd.index), ...here])]);
      for (const c of nd.children || []) walk(c, here);
    };
    for (const r of tree.roots) walk(r, []);
  }
  return out;
}

/**
 * The regions that count as endpoints.
 * @param {Map} map - label → { name, … } (the lookup table)
 * @param {Object|null} tree - the region tree ({ roots: [{ name, index, children }] }) or null
 * @param {string} include - keywords (comma-separated): only regions matching one; empty: all
 * @param {string} exclude - keywords: regions matching one don't count
 * @returns {{ eligible: Set<number>, excluded: number[], total: number }}
 */
export function regionFilter(map, tree, include, exclude) {
  const inc = keywordsOf(include), exc = keywordsOf(exclude);
  const names = namesByIndex(map, tree);
  const eligible = new Set(), excluded = [];
  for (const [v, ns] of names) {
    if (!v) continue;                                  // 0: no region
    if ((inc.length && !matchesAny(ns, inc)) || (exc.length && matchesAny(ns, exc))) excluded.push(v);
    else eligible.add(v);
  }
  return { eligible, excluded, total: eligible.size + excluded.length };
}

// Keywords for what is usually not an endpoint, offered as the exclude
// filter when the atlas has regions they match.
export const NON_ENDPOINT_KEYWORDS = ['white matter', 'WM', 'ventricle', 'CSF', 'vessel', 'choroid plexus', 'unknown'];
export function defaultExclude(map, tree) {
  const names = [...namesByIndex(map, tree).values()];
  return NON_ENDPOINT_KEYWORDS.filter(k => names.some(ns => matchesAny(ns, [k]))).join(', ');
}

// mm per voxel along each voxel axis, from a world → voxel function
// (1 / the length of each row of its linear part).
export function voxelSizeOf(toVox) {
  const o = toVox([0, 0, 0]), ex = toVox([1, 0, 0]), ey = toVox([0, 1, 0]), ez = toVox([0, 0, 1]);
  return [0, 1, 2].map(i => 1 / Math.hypot(ex[i] - o[i], ey[i] - o[i], ez[i] - o[i]));
}

// The default search radius: 1.5% of the largest extent of the labelled
// part of the volume (about 2.5 mm for a human brain, 1 mm for a macaque),
// at least one voxel.
export function defaultSearchMm(raw, shape, vox) {
  const [nx, ny, nz] = shape;
  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0 = nz, z1 = -1;
  for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
    if (!raw[i]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (x1 < 0) return Math.max(...vox);
  const ext = Math.max((x1 - x0 + 1) * vox[0], (y1 - y0 + 1) * vox[1], (z1 - z0 + 1) * vox[2]);
  return Math.max(Math.max(...vox), Math.round(ext * 0.015 * 4) / 4);
}

// Voxel offsets within r mm, nearest first (not the voxel itself).
function offsetsWithin(r, vox) {
  const out = [], n = vox.map(v => Math.floor(r / v));
  for (let c = -n[2]; c <= n[2]; c++) for (let b = -n[1]; b <= n[1]; b++) for (let a = -n[0]; a <= n[0]; a++) {
    const d = (a * vox[0]) ** 2 + (b * vox[1]) ** 2 + (c * vox[2]) ** 2;
    if (d > 0 && d <= r * r + 1e-9) out.push([a, b, c, d]);
  }
  return out.sort((p, q) => p[3] - q[3]);
}

/**
 * Builds the end table.
 * @param {Object} o
 * @param {Float32Array[]} o.streamlines - flat xyz per streamline (world mm)
 * @param {Int32Array} o.raw - the label volume
 * @param {number[]} o.shape - its [nx, ny, nz]
 * @param {Function} o.toVox - world [x, y, z] → voxel [i, j, k] (not rounded)
 * @param {Function} [o.labelOf] - raw value → its region (0: none); default: the value itself
 * @param {Set<number>|null} o.eligible - the regions that count as endpoints (null: all)
 * @param {number} o.searchMm - the search radius
 * @param {Function} [o.onProgress] - called with 0..1
 * @param {Function} [o.cancelled] - returns true to stop (the result is then null)
 * @returns {Promise<{ endLabel: Int32Array, start: Map<number, [number, number]>, ids: Int32Array, unassigned: number, nEnds: number }|null>}
 *   endLabel: two per streamline (first end, last end); per region its
 *   streamlines are ids[start[0] .. start[1]) (a streamline with both ends
 *   in it once).
 */
export async function buildEndTable({ streamlines, raw, shape, toVox, labelOf = v => v, eligible, searchMm, onProgress, cancelled }) {
  const [nx, ny, nz] = shape, N = streamlines.length;
  const vox = voxelSizeOf(toVox), offs = offsetsWithin(searchMm, vox);
  const ok = new Map();   // raw value → its region if that counts, else 0
  const regionAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0;
    const r = raw[x + nx * (y + ny * z)];
    if (!r) return 0;
    let v = ok.get(r);
    if (v === undefined) { const l = labelOf(r); v = l && (!eligible || eligible.has(l)) ? l : 0; ok.set(r, v); }
    return v;
  };
  const assign = (px, py, pz) => {
    const q = toVox([px, py, pz]);
    const x = Math.round(q[0]), y = Math.round(q[1]), z = Math.round(q[2]);
    let v = regionAt(x, y, z);
    if (v) return v;
    for (const [a, b, c] of offs) { v = regionAt(x + a, y + b, z + c); if (v) return v; }
    return 0;
  };
  const endLabel = new Int32Array(2 * N);
  let unassigned = 0, nEnds = 0;
  const STEP = 50000;
  for (let s = 0; s < N; s++) {
    if (s % STEP === 0 && s) {
      if (onProgress) onProgress(s / N);
      await new Promise(r => setTimeout(r));
      if (cancelled && cancelled()) return null;
    }
    const t = streamlines[s], n = t.length / 3;
    if (n < 1) continue;
    const a = assign(t[0], t[1], t[2]), b = n > 1 ? assign(t[3 * n - 3], t[3 * n - 2], t[3 * n - 1]) : a;
    endLabel[2 * s] = a; endLabel[2 * s + 1] = b;
    nEnds += n > 1 ? 2 : 1;
    if (!a) unassigned++;
    if (n > 1 && !b) unassigned++;
  }
  // per region its streamlines (counting sort)
  const count = new Map();
  for (let s = 0; s < N; s++) {
    const a = endLabel[2 * s], b = endLabel[2 * s + 1];
    if (a) count.set(a, (count.get(a) || 0) + 1);
    if (b && b !== a) count.set(b, (count.get(b) || 0) + 1);
  }
  const start = new Map(), fill = new Map();
  let total = 0;
  for (const [v, c] of [...count].sort((p, q) => p[0] - q[0])) { start.set(v, [total, total + c]); fill.set(v, total); total += c; }
  const ids = new Int32Array(total);
  for (let s = 0; s < N; s++) {
    const a = endLabel[2 * s], b = endLabel[2 * s + 1];
    if (a) { const k = fill.get(a); ids[k] = s; fill.set(a, k + 1); }
    if (b && b !== a) { const k = fill.get(b); ids[k] = s; fill.set(b, k + 1); }
  }
  if (onProgress) onProgress(1);
  return { endLabel, start, ids, unassigned, nEnds };
}

/**
 * The streamlines with an end in region `from` — and, when `to` is given,
 * their other end in `to` (no direction: from→to and to→from alike).
 * @returns {number[]} streamline indices, ascending
 */
export function regionHits(table, from, to = 0) {
  if (!table || !from) return [];
  const se = table.start.get(from);
  if (!se) return [];
  const out = [], E = table.endLabel, ids = table.ids;
  for (let k = se[0]; k < se[1]; k++) {
    const s = ids[k];
    if (!to) { out.push(s); continue; }
    const a = E[2 * s], b = E[2 * s + 1];
    if ((a === from && b === to) || (a === to && b === from)) out.push(s);
  }
  return out;
}
