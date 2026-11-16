// ── markers-io.js ─────────────────────────────────────────
// The drawing side of point and link tables (graph-format.md; read by
// graph-io.js): field helpers shared with the reader, and the resolution of
// a table's style into per-row colors, shapes and sizes (markers) and
// per-end colors and widths (links).
//
// Pure data code — no three.js, no DOM — so it can be tested on its own.

export const MARKER_SHAPES = ['sphere', 'cube', 'diamond', 'cross'];
export const DEFAULT_MARKER_SIZE_PX = 10;
export const DEFAULT_LINK_WIDTH_PX = 2;
const DEFAULT_RGB = [1, 1, 1];

export const fail = msg => { throw new Error(msg); };
export const isNum = v => typeof v === 'number' && Number.isFinite(v);

// A [r,g,b] 0-255 array, or "#rrggbb" → [r,g,b] 0-1, or null.
export function rgb255(c) {
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) { const h = c.replace('#', ''); return [0, 2, 4].map(k => parseInt(h.slice(k, k + 2), 16) / 255); }
  if (!Array.isArray(c) || c.length !== 3 || !c.every(isNum)) return null;
  return c.map(v => Math.max(0, Math.min(255, v)) / 255);
}

// Golden-angle hues: automatic colors for categories without one.
export function autoColor(i) {
  const h = ((i * 137.50776405003785) % 360) / 360, s = 0.65, l = 0.55;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1;
    return t < 1/6 ? p + (q - p) * 6 * t : t < 1/2 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; };
  return [f(h + 1/3), f(h), f(h - 1/3)];
}

// A column not declared: guess its type from the values.
export function guessProperty(name, values) {
  const present = values.filter(v => v != null);
  if (present.length && present.every(isNum))
    return { name, type: present.every(Number.isInteger) ? 'integer' : 'number', description: '', unit: '', declared: false };
  const distinct = new Set(present);
  if (distinct.size <= 50) return { name, type: 'categorical', description: '', unit: '', ordered: false, legend: [], declared: false };
  return { name, type: 'text', description: '', unit: '', declared: false };
}

// Column values → typed array per property type.
export function columnValues(prop, raw, where) {
  if (prop.type === 'number' || prop.type === 'integer') {
    const out = new Float64Array(raw.length);
    raw.forEach((v, i) => {
      if (v == null) out[i] = NaN;
      else if (isNum(v)) out[i] = v;
      else fail(`${where}: "${prop.name}" must be a number (row ${i + 1} has ${JSON.stringify(v)})`);
    });
    return out;
  }
  if (prop.type === 'text') return raw.map(v => (v == null ? null : String(v)));
  return raw.map(v => (v == null ? null : v)); // categorical: keep the raw value (string or number)
}

// Categorical: legend order first, then values found in the data (added to
// the legend with automatic colors).
export function completeLegend(prop, arrays) {
  if (prop.type !== 'categorical') return;
  for (const arr of arrays) for (const v of arr) {
    if (v == null || prop.legend.some(e => e.value === v)) continue;
    prop.legend.push({ value: v, name: String(v), color: null, shape: null, size: null, auto: true });
  }
  prop.legend.forEach((e, i) => { if (!e.color) e.color = autoColor(i); });
  // Sizes and shapes only where they mean something: sizes from the
  // legend, or — for an ordered category — evenly growing along the order
  // (0.4 … 1); shapes from the legend, or automatic for at most as many
  // values as there are shapes. Otherwise the property can't drive
  // size/shape (hasSizes / hasShapes false) and the viewer doesn't offer it.
  const L = prop.legend, m = L.length;
  if (!L.some(e => e.size != null) && prop.ordered && m > 1) L.forEach((e, i) => { e.size = 0.4 + 0.6 * i / (m - 1); });
  prop.hasSizes = L.some(e => e.size != null);
  if (!L.some(e => e.shape) && m >= 2 && m <= MARKER_SHAPES.length) L.forEach((e, i) => { e.shape = MARKER_SHAPES[i]; });
  prop.hasShapes = L.some(e => e.shape);
  prop.index = new Map(prop.legend.map((e, i) => [e.value, i]));
}

// The scale a numeric property is mapped over: its declared range, else
// the data's own.
export function propertyRange(p) {
  const r = p.range || p.dataRange || [0, 1];
  return r[1] > r[0] ? r : [r[0], r[0] + 1];
}

// A style's size spec → { unit: 'mm'|'px', min, max } (min === max for a
// single number), or the default. key: 'size' (markers) or 'width' (links).
export function sizeSpec(st, key = 'size') {
  const mm = st[key + '_mm'], px = st[key + '_px'];
  const spec = v => (isNum(v) ? [v, v] : Array.isArray(v) && v.length === 2 && v.every(isNum) ? v : null);
  if (spec(mm)) { const [a, b] = spec(mm); return { unit: 'mm', min: a, max: b }; }
  if (spec(px)) { const [a, b] = spec(px); return { unit: 'px', min: a, max: b }; }
  const d = key === 'size' ? DEFAULT_MARKER_SIZE_PX : DEFAULT_LINK_WIDTH_PX;
  return { unit: 'px', min: d, max: d };
}

// Numeric value → [0,1] over the property's range, or NaN.
function norm01(p, v) {
  if (!Number.isFinite(v)) return NaN;
  const [lo, hi] = propertyRange(p);
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}

// Which markers pass the filters (1) or not (0). filters: a list of
//   { prop, values: Set }   categorical: the value is one of these (OR)
//   { prop, range: [a, b] } number/integer: a <= value <= b
// combined with AND. A marker without a value for a filtered property
// doesn't pass. Returns null when nothing is filtered.
export function markerFilterMask(set, filters) {
  const active = (filters || []).filter(f => set.props.has(f.prop) && set.markers.values[f.prop]);
  if (!active.length) return null;
  const n = set.markers.n, mask = new Uint8Array(n).fill(1);
  for (const f of active) {
    const vals = set.markers.values[f.prop];
    if (f.values) {
      for (let i = 0; i < n; i++) if (mask[i] && (vals[i] == null || !f.values.has(vals[i]))) mask[i] = 0;
    } else if (f.range) {
      const lo = Math.min(f.range[0], f.range[1]), hi = Math.max(f.range[0], f.range[1]);
      const eps = 1e-9 * Math.max(1, hi - lo);
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (mask[i] && !(Number.isFinite(v) && v >= lo - eps && v <= hi + eps)) mask[i] = 0;
      }
    }
  }
  return mask;
}

// Resolves the marker style into per-marker arrays:
//   color Float32Array(3n) 0-1, shape Uint8Array(n) (index into
//   MARKER_SHAPES), size Float32Array(n) (in sizeUnit), sizeUnit 'mm'|'px'.
// colormap(t) → [r,g,b] 0-1 is used for numeric color_by. mask (see
// markerFilterMask): markers with 0 get size 0, i.e. aren't drawn.
export function resolveMarkerStyle(set, st, colormap, mask = null) {
  const { n, values } = set.markers;
  const prop = k => (k && set.props.has(k) ? set.props.get(k) : null);
  const color = new Float32Array(3 * n), shape = new Uint8Array(n), size = new Float32Array(n);
  // base[i] = 1: drawn in the base color (no color_by, outside the window,
  // or no value) — those markers get the style's opacity, see the shader.
  const base = new Uint8Array(n);

  // shape
  const baseShape = Math.max(0, MARKER_SHAPES.indexOf(st.shape));
  const sp = prop(st.shape_by);
  for (let i = 0; i < n; i++) {
    let s = baseShape;
    if (sp && sp.type === 'categorical') {
      const v = values[sp.name] ? values[sp.name][i] : null;
      const e = v == null ? null : sp.legend[sp.index.get(v)];
      if (e && e.shape) s = MARKER_SHAPES.indexOf(e.shape);
    }
    shape[i] = s;
  }

  // color. A numeric color_by spreads the colormap over st.window
  // [from, to] (default: the property's range; to < from inverts it);
  // values outside the window keep the fixed color, like streamlines keep
  // their bundle color outside a data field's window.
  const fixed = rgb255(st.color) || DEFAULT_RGB;
  const cp = prop(st.color_by);
  const cv = cp && values[cp.name];
  const win = cp && (cp.type === 'number' || cp.type === 'integer')
    ? (Array.isArray(st.window) && st.window.length === 2 && st.window.every(isNum) ? st.window : propertyRange(cp)) : null;
  // color_column: each row's own color (an atlas region's), unless color_by is set
  const rc = !cp && st.color_column && set.markers.rowColor ? set.markers.rowColor : null;
  for (let i = 0; i < n; i++) {
    let c = fixed, isBase = 1;
    if (rc && Number.isFinite(rc[3 * i])) { c = [rc[3 * i], rc[3 * i + 1], rc[3 * i + 2]]; isBase = 0; }
    else if (cp && cp.type === 'categorical') {
      const v = cv ? cv[i] : null;
      if (v != null) { c = cp.legend[cp.index.get(v)].color; isBase = 0; } // no value: base color
    } else if (win) {
      const v = cv ? cv[i] : NaN;
      if (Number.isFinite(v)) {
        const [a, b] = win, lo = Math.min(a, b), hi = Math.max(a, b);
        const eps = 1e-9 * Math.max(1, Math.abs(hi - lo));
        if (v >= lo - eps && v <= hi + eps) { c = colormap(a === b ? 0.5 : Math.max(0, Math.min(1, (v - a) / (b - a)))); isBase = 0; }
      }
    }
    base[i] = isBase;
    color[3 * i] = c[0]; color[3 * i + 1] = c[1]; color[3 * i + 2] = c[2];
  }

  // size
  const spec = sizeSpec(st, 'size');
  const zp = prop(st.size_by);
  const zv = zp && values[zp.name];
  for (let i = 0; i < n; i++) {
    let s = spec.max;
    if (zp && zp.type === 'categorical') {
      const v = zv ? zv[i] : null;
      const e = v == null ? null : zp.legend[zp.index.get(v)];
      s = spec.max * (e && e.size != null ? e.size : 1);
    } else if (zp && (zp.type === 'number' || zp.type === 'integer')) {
      const t = zv ? norm01(zp, zv[i]) : NaN;
      s = Number.isNaN(t) ? spec.min : spec.min + t * (spec.max - spec.min);
    }
    size[i] = mask && !mask[i] ? 0 : s;
  }
  return { color, shape, size, sizeUnit: spec.unit, base };
}

// Resolves the link style into per-link arrays, one value per END (a: the
// "from" end, b: the "to" end), so lines can taper and blend:
//   colorA/colorB Float32Array(3m), widthA/widthB Float32Array(m) (in
//   widthUnit 'mm'|'px'), widthUnit, opacity.
// A link is drawn only when both its markers are (markerResolved.size > 0);
// otherwise its widths are 0. Per the format:
//   color: fixed `color`; `color_by` "ends" (default) — the markers'
//   colors; "from.<p>" / "to.<p>" — that marker's value of p; or a link
//   property — with directional columns each end gets the value arriving
//   there (to-end ← ">>", from-end ← "<<").
//   width: `width_mm` / `width_px` ([min, max] with a numeric `width_by`);
//   `width_by` a link property, directional the same way; a missing
//   direction gives width 0 at that end.
export function resolveLinkStyle(set, st, colormap, markerResolved) {
  st = st || {};
  const L = set.links, m = L.n;
  const prop = k => (k && set.props.has(k) ? set.props.get(k) : null);
  const colorA = new Float32Array(3 * m), colorB = new Float32Array(3 * m);
  const widthA = new Float32Array(m), widthB = new Float32Array(m);
  const fixed = rgb255(st.color) || DEFAULT_RGB;
  const colorOf = (p, v) => {
    if (!p || v == null || (typeof v === 'number' && !Number.isFinite(v))) return null;
    if (p.type === 'categorical') { const e = p.legend[p.index.get(v)]; return e ? e.color : null; }
    if (p.type === 'number' || p.type === 'integer') { const t = norm01(p, v); return Number.isNaN(t) ? null : colormap(t); }
    return null;
  };
  // the values arriving at each end of a link property: [atFrom, atTo]
  const endValues = (name, i) => {
    const v = L.values[name]; if (!v) return [null, null];
    if (v.both) return [v.both[i], v.both[i]];
    return [v.bwd ? v.bwd[i] : null, v.fwd ? v.fwd[i] : null];
  };
  const cb = st.color_by == null ? 'ends' : st.color_by;
  const mc = markerResolved.color;
  for (let i = 0; i < m; i++) {
    const a = L.from[i], b = L.to[i];
    let ca = fixed, cbb = fixed;
    if (cb === 'ends') { ca = [mc[3 * a], mc[3 * a + 1], mc[3 * a + 2]]; cbb = [mc[3 * b], mc[3 * b + 1], mc[3 * b + 2]]; }
    else if (typeof cb === 'string' && /^(from|to)\./.test(cb)) {
      const [end, name] = [cb.slice(0, cb.indexOf('.')), cb.slice(cb.indexOf('.') + 1)];
      const p = prop(name), vals = set.markers.values[name];
      const c = p && vals ? colorOf(p, vals[end === 'from' ? a : b]) : null;
      if (c) { ca = c; cbb = c; }
    } else if (prop(cb)) {
      const [va, vb] = endValues(cb, i), p = prop(cb);
      ca = colorOf(p, va) || colorOf(p, vb) || fixed; cbb = colorOf(p, vb) || colorOf(p, va) || fixed;
    }
    colorA.set(ca, 3 * i); colorB.set(cbb, 3 * i);
  }
  const spec = sizeSpec(st, 'width');
  const wp = prop(st.width_by);
  const widthOf = v => {
    if (!wp) return spec.max;
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return 0;
    if (wp.type === 'categorical') { const e = wp.legend[wp.index.get(v)]; return spec.max * (e && e.size != null ? e.size : 1); }
    const t = norm01(wp, v); return Number.isNaN(t) ? 0 : spec.min + t * (spec.max - spec.min);
  };
  for (let i = 0; i < m; i++) {
    const shown = markerResolved.size[L.from[i]] > 0 && markerResolved.size[L.to[i]] > 0;
    if (!shown) continue;
    if (wp) { const [va, vb] = endValues(wp.name, i); widthA[i] = widthOf(va); widthB[i] = widthOf(vb); }
    else { widthA[i] = spec.max; widthB[i] = spec.max; }
  }
  const opacity = isNum(st.opacity) ? Math.max(0, Math.min(1, st.opacity)) : 1;
  return { colorA, colorB, widthA, widthB, widthUnit: spec.unit, opacity };
}

// ── Rows sharing a place: drawn as one marker per color with their count ──
// (graph-format.md, style "aggregate"). Rows at exactly the same position
// form a spot (rows placed in one region and side always do); with
// "overlap" (the default), spots closer than one marker width merge too —
// single linkage, so zooming in splits them in the reverse order. Each spot
// or merged spot is drawn as one marker per category (color, shape, and
// dimmed or not), side by side around its center, with its count.
export const AGGREGATE_MODES = ['overlap', 'spot', 'none'];

// The spots of the drawn rows (size > 0, a finite position), and the
// edges of their minimum spanning tree (by distance, ascending) — the
// merge order. Recomputed only when the drawn rows change.
export function markerSpots(set, resolved) {
  const pos = set.markers.pos, n = set.markers.n, byKey = new Map(), spots = [];
  for (let i = 0; i < n; i++) {
    if (!(resolved.size[i] > 0)) continue;
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
    const key = x + ',' + y + ',' + z;
    let s = byKey.get(key);
    if (!s) { s = { x, y, z, rows: [] }; byKey.set(key, s); spots.push(s); }
    s.rows.push(i);
  }
  // Prim, O(S²): a few thousand spots take some tens of milliseconds
  const S = spots.length, inTree = new Uint8Array(S), dist = new Float64Array(S).fill(Infinity), from = new Int32Array(S).fill(-1);
  const ea = new Int32Array(Math.max(0, S - 1)), eb = new Int32Array(Math.max(0, S - 1)), ew = new Float64Array(Math.max(0, S - 1));
  let m = 0;
  if (S) dist[0] = 0;
  for (let it = 0; it < S; it++) {
    let u = -1, best = Infinity;
    for (let v = 0; v < S; v++) if (!inTree[v] && dist[v] < best) { best = dist[v]; u = v; }
    if (u < 0) break;
    inTree[u] = 1;
    if (from[u] >= 0) { ea[m] = from[u]; eb[m] = u; ew[m] = best; m++; }
    const a = spots[u];
    for (let v = 0; v < S; v++) {
      if (inTree[v]) continue;
      const b = spots[v], d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d < dist[v]) { dist[v] = d; from[v] = u; }
    }
  }
  const order = Array.from({ length: m }, (_, k) => k).sort((p, q) => ew[p] - ew[q] || p - q);
  return { spots, edges: { a: Int32Array.from(order, k => ea[k]), b: Int32Array.from(order, k => eb[k]), w: Float64Array.from(order, k => ew[k]) } };
}

// How many merge steps a distance threshold allows (edges shorter than it).
export function mergeCut(spots, threshold) {
  const w = spots.edges.w;
  let lo = 0, hi = w.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (w[mid] < threshold) lo = mid + 1; else hi = mid; }
  return lo;
}

// Hexagonal spiral: the first k positions (unit spacing), centered.
function hexLayout(k) {
  const out = [[0, 0]];
  const dirs = [[1, 0], [0.5, Math.sqrt(3) / 2], [-0.5, Math.sqrt(3) / 2], [-1, 0], [-0.5, -Math.sqrt(3) / 2], [0.5, -Math.sqrt(3) / 2]];
  for (let ring = 1; out.length < k; ring++) {
    let x = ring, y = 0;   // from the right (two side by side: left and right), around counter-clockwise
    for (let side = 0; side < 6 && out.length < k; side++)
      for (let s = 0; s < ring && out.length < k; s++) { out.push([x, y]); const d = dirs[(side + 2) % 6]; x += d[0]; y += d[1]; }
  }
  out.length = k;
  const cx = out.reduce((a, p) => a + p[0], 0) / k, cy = out.reduce((a, p) => a + p[1], 0) / k;
  return out.map(([x, y]) => [x - cx, y - cy]);
}

/**
 * The markers as drawn: one per row ("none"), or per spot or merged spot
 * and category. → { n, center Float32Array(3n), offset Float32Array(2n)
 * (side by side, facing the camera, in the size unit), color, shape, size,
 * base, dim, count Uint32Array, members [Int32Array], rowInst Int32Array
 * (row → its marker, −1: not drawn), cut }.
 * @param spots - markerSpots(set, resolved)
 * @param o.mode - 'overlap' | 'spot' | 'none'
 * @param o.mergeMm - for 'overlap': the distance below which spots merge (one marker width, in mm)
 * @param o.rankOf - row → its category's place in the legend (the order around a spot)
 */
export function markerInstances(set, resolved, spots, { mode = 'overlap', mergeMm = 0, rankOf = null } = {}) {
  const n = set.markers.n, pos = set.markers.pos, S = spots.spots.length;
  const groups = [];   // [{ rows: [...] }] per cluster
  let cut = 0;
  if (mode === 'none') { for (const s of spots.spots) for (const r of s.rows) groups.push([r]); }
  else {
    cut = mode === 'overlap' ? mergeCut(spots, mergeMm) : 0;
    const parent = Int32Array.from({ length: S }, (_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let e = 0; e < cut; e++) { const a = find(spots.edges.a[e]), b = find(spots.edges.b[e]); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    const byRoot = new Map();
    spots.spots.forEach((s, i) => { const r = find(i); if (!byRoot.has(r)) { byRoot.set(r, []); groups.push(byRoot.get(r)); } byRoot.get(r).push(...s.rows); });
  }
  const insts = [];
  for (const rows of groups) {
    rows.sort((a, b) => a - b);
    let cx = 0, cy = 0, cz = 0, maxSize = 0;
    for (const r of rows) { cx += pos[3 * r]; cy += pos[3 * r + 1]; cz += pos[3 * r + 2]; if (resolved.size[r] > maxSize) maxSize = resolved.size[r]; }
    cx /= rows.length; cy /= rows.length; cz /= rows.length;
    // per category: color, shape, base, dimmed
    const cats = new Map();
    for (const r of rows) {
      const key = resolved.color[3 * r] + ',' + resolved.color[3 * r + 1] + ',' + resolved.color[3 * r + 2] + '|' + resolved.shape[r] + '|' + (resolved.base ? resolved.base[r] : 1) + '|' + (resolved.dim ? resolved.dim[r] : 0);
      if (!cats.has(key)) cats.set(key, []);
      cats.get(key).push(r);
    }
    const list = [...cats.values()].sort((p, q) => (rankOf ? rankOf(p[0]) - rankOf(q[0]) : 0) || p[0] - q[0]);
    const lay = hexLayout(list.length), step = 1.15 * maxSize;
    list.forEach((members, k) => {
      let size = 0;
      for (const r of members) if (resolved.size[r] > size) size = resolved.size[r];
      insts.push({ c: [cx, cy, cz], o: [lay[k][0] * step, lay[k][1] * step], r0: members[0], size, members: Int32Array.from(members) });
    });
  }
  const k = insts.length;
  const out = { n: k, center: new Float32Array(3 * k), offset: new Float32Array(2 * k), color: new Float32Array(3 * k), shape: new Uint8Array(k),
                size: new Float32Array(k), base: new Uint8Array(k), dim: new Uint8Array(k), count: new Uint32Array(k), members: [],
                rowInst: new Int32Array(n).fill(-1), cut };
  insts.forEach((t, j) => {
    out.center.set(t.c, 3 * j); out.offset.set(t.o, 2 * j);
    out.color.set(resolved.color.subarray(3 * t.r0, 3 * t.r0 + 3), 3 * j);
    out.shape[j] = resolved.shape[t.r0]; out.size[j] = t.size;
    out.base[j] = resolved.base ? resolved.base[t.r0] : 1; out.dim[j] = resolved.dim ? resolved.dim[t.r0] : 0;
    out.count[j] = t.members.length; out.members.push(t.members);
    for (const r of t.members) out.rowInst[r] = j;
  });
  return out;
}
