// ── markers-io.js ─────────────────────────────────────────
// Reader for the markers format (markers-format.md): markers (points) at
// brain locations, optional links between them, and a declared list of
// typed properties whose values drive shape/color/size/width.
//
// Pure data code — no three.js, no DOM — so it can be tested on its own.
// parseMarkers() validates a parsed JSON object and returns plain arrays;
// resolveMarkerStyle() turns a style (from the file, or the user's
// choice in the FILE panel) into per-marker colors/shapes/sizes.

export const MARKERS_TYPE = 'tractogram.observer.markers';
export const MARKERS_VERSION = 1;
export const MARKER_SHAPES = ['sphere', 'cube', 'diamond', 'cross'];
export const DEFAULT_MARKER_SIZE_PX = 10;
export const DEFAULT_LINK_WIDTH_PX = 2;
const MISSING_RGB = [0.5, 0.5, 0.5];     // no value for the color_by property
const DEFAULT_RGB = [1, 1, 1];
const PROPERTY_TYPES = ['number', 'integer', 'categorical', 'text'];

// Cheap test on raw text: is this (meant to be) a markers file? Used by the
// file opener before parsing, so a markers file with a JSON syntax error is
// still recognized — and reported — as one.
export function looksLikeMarkersText(text) {
  return /"type"\s*:\s*"tractogram\.observer\.markers"/.test(text);
}

const fail = msg => { throw new Error(msg); };
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// A [r,g,b] 0-255 array → [r,g,b] 0-1, or null.
function rgb255(c) {
  if (!Array.isArray(c) || c.length !== 3 || !c.every(isNum)) return null;
  return c.map(v => Math.max(0, Math.min(255, v)) / 255);
}

// Golden-angle hues: automatic colors for categories without one.
function autoColor(i) {
  const h = ((i * 137.50776405003785) % 360) / 360, s = 0.65, l = 0.55;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1;
    return t < 1/6 ? p + (q - p) * 6 * t : t < 1/2 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; };
  return [f(h + 1/3), f(h), f(h - 1/3)];
}

// Table → { columns: [...], rows: [[...]] }, from either the compact form
// or a list of objects.
function normalizeTable(t, what) {
  if (Array.isArray(t)) {
    const cols = [];
    for (const o of t) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${what}: every entry must be an object`);
      for (const k of Object.keys(o)) if (!cols.includes(k)) cols.push(k);
    }
    return { columns: cols, rows: t.map(o => cols.map(k => (k in o ? o[k] : null))) };
  }
  if (!t || typeof t !== 'object' || !Array.isArray(t.columns) || !Array.isArray(t.rows))
    fail(`${what} must be { "columns": [...], "rows": [[...], ...] } or a list of objects`);
  const n = t.columns.length;
  t.rows.forEach((r, i) => {
    if (!Array.isArray(r) || r.length !== n) fail(`${what}: row ${i + 1} has ${Array.isArray(r) ? r.length : 'no'} values, the columns say ${n}`);
  });
  return t;
}

function parseProperty(name, d) {
  if (!d || typeof d !== 'object') fail(`property "${name}": declaration must be an object`);
  if (!PROPERTY_TYPES.includes(d.type)) fail(`property "${name}": type must be one of ${PROPERTY_TYPES.join(', ')}`);
  const p = { name, type: d.type, description: typeof d.description === 'string' ? d.description : '',
              unit: typeof d.unit === 'string' ? d.unit : '', declared: true };
  if ((d.type === 'number' || d.type === 'integer') && d.range != null) {
    if (!Array.isArray(d.range) || d.range.length !== 2 || !d.range.every(isNum) || d.range[1] <= d.range[0])
      fail(`property "${name}": range must be [min, max] with min < max`);
    p.range = d.range.slice();
  }
  if (d.type === 'categorical') {
    p.ordered = d.ordered === true;
    p.legend = [];
    if (d.legend != null) {
      if (!Array.isArray(d.legend)) fail(`property "${name}": legend must be a list`);
      for (const e of d.legend) {
        if (!e || typeof e !== 'object' || !('value' in e)) fail(`property "${name}": every legend entry needs a "value"`);
        if (p.legend.some(x => x.value === e.value)) fail(`property "${name}": legend value ${JSON.stringify(e.value)} appears twice`);
        p.legend.push({ value: e.value, name: typeof e.name === 'string' ? e.name : String(e.value),
                        color: rgb255(e.color), shape: MARKER_SHAPES.includes(e.shape) ? e.shape : null,
                        size: isNum(e.size) && e.size >= 0 ? e.size : null });
      }
    }
  }
  return p;
}

// A column not declared in "properties": guess its type from the values.
function guessProperty(name, values) {
  const present = values.filter(v => v != null);
  if (present.length && present.every(isNum))
    return { name, type: present.every(Number.isInteger) ? 'integer' : 'number', description: '', unit: '', declared: false };
  const distinct = new Set(present);
  if (distinct.size <= 50) return { name, type: 'categorical', description: '', unit: '', ordered: false, legend: [], declared: false };
  return { name, type: 'text', description: '', unit: '', declared: false };
}

// Column values → typed array per property type.
function columnValues(prop, raw, where) {
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
function completeLegend(prop, arrays) {
  if (prop.type !== 'categorical') return;
  for (const arr of arrays) for (const v of arr) {
    if (v == null || prop.legend.some(e => e.value === v)) continue;
    prop.legend.push({ value: v, name: String(v), color: null, shape: null, size: null, auto: true });
  }
  prop.legend.forEach((e, i) => { if (!e.color) e.color = autoColor(i); });
  prop.index = new Map(prop.legend.map((e, i) => [e.value, i]));
}

// Parses a markers file (already JSON.parse'd). Throws Error with a
// user-facing message on anything invalid. Returns:
//  { name, space, props: Map name→prop, warnings: [],
//    markers: { n, ids: [], index: Map id→i, pos: Float32Array(3n), values: {prop: array} },
//    links:   { n, from: Int32Array, to: Int32Array,
//               values: {prop: {both?, fwd?, bwd?}} }  (fwd = >>, bwd = <<)
//    style:   { markers: {...}, links: {...} } }
export function parseMarkers(obj, fileName = 'markers') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('not a JSON object');
  if (obj.type !== MARKERS_TYPE) fail(`"type" must be "${MARKERS_TYPE}"`);
  if (!Number.isInteger(obj.version)) fail('"version" is missing');
  if (obj.version > MARKERS_VERSION) fail(`this is a version ${obj.version} markers file; this viewer reads version ${MARKERS_VERSION}`);
  const cs = obj.coordinate_system == null ? 'RAS' : obj.coordinate_system;
  if (cs !== 'RAS' && cs !== 'LPS') fail('"coordinate_system" must be "RAS" or "LPS"');
  if (obj.units != null && obj.units !== 'mm') fail('"units" must be "mm"');
  const warnings = [];

  const props = new Map();
  if (obj.properties != null) {
    if (typeof obj.properties !== 'object' || Array.isArray(obj.properties)) fail('"properties" must be an object');
    for (const [k, d] of Object.entries(obj.properties)) {
      if (/^(>>|<<)/.test(k)) fail(`property "${k}": names can't start with >> or <<`);
      props.set(k, parseProperty(k, d));
    }
  }

  // ── markers
  if (obj.markers == null) fail('"markers" is missing');
  const mt = normalizeTable(obj.markers, 'markers');
  const col = name => mt.columns.indexOf(name);
  for (const c of ['id', 'x', 'y', 'z']) if (col(c) < 0) fail(`markers: column "${c}" is missing`);
  const n = mt.rows.length;
  const ids = [], index = new Map(), pos = new Float32Array(3 * n);
  const flip = cs === 'LPS' ? -1 : 1;
  const [ci, cx, cy, cz] = ['id', 'x', 'y', 'z'].map(col);
  mt.rows.forEach((r, i) => {
    const id = r[ci];
    if (id == null || id === '') fail(`markers: row ${i + 1} has no id`);
    const key = String(id);
    if (index.has(key)) fail(`markers: id "${key}" appears twice`);
    index.set(key, i); ids.push(key);
    const x = r[cx], y = r[cy], z = r[cz];
    if (![x, y, z].every(isNum)) fail(`markers: row ${i + 1} ("${key}") needs numeric x, y and z`);
    pos[3 * i] = flip * x; pos[3 * i + 1] = flip * y; pos[3 * i + 2] = z;
  });
  const mValues = {};
  mt.columns.forEach((c, k) => {
    if (['id', 'x', 'y', 'z'].includes(c)) return;
    if (/^(>>|<<)/.test(c)) fail(`markers: column "${c}": direction prefixes are only for links`);
    const raw = mt.rows.map(r => r[k]);
    if (!props.has(c)) { props.set(c, guessProperty(c, raw)); warnings.push(`markers column "${c}" isn't declared in "properties"; treated as ${props.get(c).type}`); }
    mValues[c] = columnValues(props.get(c), raw, 'markers');
  });

  // ── links
  const lv = {}; let from = new Int32Array(0), to = new Int32Array(0), m = 0;
  if (obj.links != null) {
    const lt = normalizeTable(obj.links, 'links');
    const fi = lt.columns.indexOf('from'), ti = lt.columns.indexOf('to');
    if (fi < 0 || ti < 0) fail('links: columns "from" and "to" are required');
    m = lt.rows.length;
    from = new Int32Array(m); to = new Int32Array(m);
    const unknown = new Set();
    lt.rows.forEach((r, i) => {
      const a = index.get(String(r[fi])), b = index.get(String(r[ti]));
      if (a === undefined) unknown.add(String(r[fi]));
      if (b === undefined) unknown.add(String(r[ti]));
      from[i] = a ?? -1; to[i] = b ?? -1;
    });
    if (unknown.size) fail(`links refer to marker id(s) that don't exist: ${[...unknown].slice(0, 10).join(', ')}${unknown.size > 10 ? ', …' : ''}`);
    lt.columns.forEach((c, k) => {
      if (k === fi || k === ti) return;
      const dir = c.startsWith('>>') ? 'fwd' : c.startsWith('<<') ? 'bwd' : 'both';
      const name = dir === 'both' ? c : c.slice(2);
      const raw = lt.rows.map(r => r[k]);
      if (!props.has(name)) { props.set(name, guessProperty(name, raw)); warnings.push(`links column "${c}" isn't declared in "properties"; treated as ${props.get(name).type}`); }
      (lv[name] || (lv[name] = {}))[dir] = columnValues(props.get(name), raw, 'links');
    });
  }

  for (const p of props.values()) {
    const arrays = [];
    if (mValues[p.name]) arrays.push(mValues[p.name]);
    if (lv[p.name]) arrays.push(...Object.values(lv[p.name]));
    completeLegend(p, arrays);
    // Data range for numbers (used when no "range" is declared).
    if (p.type === 'number' || p.type === 'integer') {
      let lo = Infinity, hi = -Infinity;
      for (const a of arrays) for (const v of a) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      p.dataRange = lo <= hi ? [lo, hi] : [0, 1];
    }
  }

  const style = obj.style && typeof obj.style === 'object' ? obj.style : {};
  return {
    name: typeof obj.name === 'string' && obj.name ? obj.name : fileName,
    space: typeof obj.space === 'string' ? obj.space : null,
    coordinateSystem: cs,
    props, warnings,
    markers: { n, ids, index, pos, values: mValues },
    links: { n: m, from, to, values: lv },
    style: { markers: { ...(style.markers || {}) }, links: { ...(style.links || {}) } },
  };
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

// Resolves the marker style into per-marker arrays:
//   color Float32Array(3n) 0-1, shape Uint8Array(n) (index into
//   MARKER_SHAPES), size Float32Array(n) (in sizeUnit), sizeUnit 'mm'|'px'.
// colormap(t) → [r,g,b] 0-1 is used for numeric color_by.
export function resolveMarkerStyle(set, st, colormap) {
  const { n, values } = set.markers;
  const prop = k => (k && set.props.has(k) ? set.props.get(k) : null);
  const color = new Float32Array(3 * n), shape = new Uint8Array(n), size = new Float32Array(n);

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
  for (let i = 0; i < n; i++) {
    let c = fixed;
    if (cp && cp.type === 'categorical') {
      const v = cv ? cv[i] : null;
      c = v == null ? MISSING_RGB : cp.legend[cp.index.get(v)].color;
    } else if (win) {
      const v = cv ? cv[i] : NaN;
      if (!Number.isFinite(v)) c = MISSING_RGB;
      else {
        const [a, b] = win, lo = Math.min(a, b), hi = Math.max(a, b);
        const eps = 1e-9 * Math.max(1, Math.abs(hi - lo));
        if (v >= lo - eps && v <= hi + eps) c = colormap(a === b ? 0.5 : Math.max(0, Math.min(1, (v - a) / (b - a))));
      }
    }
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
    size[i] = s;
  }
  return { color, shape, size, sizeUnit: spec.unit };
}
