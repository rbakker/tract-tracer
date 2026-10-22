// ── graph-io.js ───────────────────────────────────────────
// Reader for the graph format (graph-format.md): a Frictionless Data
// Package (v2) whose tables are placed in brain space — point tables
// (markers), link tables (connections between their rows) and region
// tables (the regions of a label volume, with names, colors, a hierarchy).
//
// readPackage() validates and normalizes the package; pointSet() turns a
// point table and the link tables referring to it into the "set" the marker
// and link drawing uses (markers-io.js resolveMarkerStyle / resolveLinkStyle).
//
// Pure data code — no three.js, no DOM.

import { fail, isNum, rgb255, guessProperty, columnValues, completeLegend, MARKER_SHAPES } from './markers-io.js';

export const GRAPH_PROFILE = 'https://tractogram.observer/schema/graph-v1.json';

// Cheap test on raw text: is this (meant to be) a graph package? A data
// package with at least one table placed in space ("geometry").
export function looksLikeGraphText(text) {
  return /"resources"\s*:/.test(text) && /"geometry"\s*:/.test(text);   // (a package of files only — a manifest — is no graph file)
}
export function isGraphPackage(obj) {
  return !!obj && typeof obj === 'object' && Array.isArray(obj.resources)
    && (obj.$schema === GRAPH_PROFILE || obj.resources.some(r => r && r.geometry));
}

// ── attribution (standard Data Package properties) ──
// From a package or a resource: where it came from and on what terms —
// sources [{ title, path, email, version }], licenses [{ name, path, title }],
// and for a package also contributors, id (a DOI), version, created,
// homepage; "citation" (ours): the preferred citation text. Empty: null.
export function attributionOf(o) {
  if (!o || typeof o !== 'object') return null;
  const list = x => (Array.isArray(x) ? x.filter(e => e && typeof e === 'object') : []);
  const m = {
    title: typeof o.title === 'string' ? o.title : null,
    sources: list(o.sources), licenses: list(o.licenses), contributors: list(o.contributors),
    id: typeof o.id === 'string' ? o.id : null, version: typeof o.version === 'string' || typeof o.version === 'number' ? String(o.version) : null,
    created: typeof o.created === 'string' ? o.created : null, homepage: typeof o.homepage === 'string' ? o.homepage : null,
    citation: typeof o.citation === 'string' ? o.citation : null,
    space: typeof o.space === 'string' && o.space.trim() ? o.space.trim() : null,
  };
  return m.sources.length || m.licenses.length || m.contributors.length || m.id || m.citation || m.homepage || m.space ? m : null;
}

// ── Spaces ──
// "space" (ours), on a resource or on the whole package (a resource's own
// wins): the coordinate space its positions are in — a TemplateFlow
// identifier (https://www.templateflow.org) such as "MNI152NLin2009aAsym",
// "MNI152NLin2009bAsym" (Lead-DBS), "MNI152NLin6Asym" (FSL), or a word
// of one's own ("native", "subject-01").
// How two spaces relate: 'same'; 'near' — versions of one template in one
// coordinate system, the ICBM 2009 a, b and c (Asym, or Sym), which line
// up to about a millimetre; 'different'; or null when either is unknown.
const ICBM2009 = /^MNI152NLin2009[abc](Asym|Sym)$/i;
export function compareSpaces(a, b) {
  if (!a || !b) return null;
  if (a.toLowerCase() === b.toLowerCase()) return 'same';
  const ma = a.match(ICBM2009), mb = b.match(ICBM2009);
  if (ma && mb && ma[1].toLowerCase() === mb[1].toLowerCase()) return 'near';
  return 'different';
}

// ── CSV (RFC 4180: quotes, "" inside quotes, CRLF) ──
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false, i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;   // BOM
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'date', 'datetime', 'time', 'year', 'any'];

function normField(f, where) {
  if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name) fail(`${where}: every field needs a "name"`);
  const type = f.type == null ? 'any' : f.type;
  if (!FIELD_TYPES.includes(type)) fail(`${where}: field "${f.name}": unknown type "${type}"`);
  let categories = null;
  if (f.categories != null) {
    if (!Array.isArray(f.categories)) fail(`${where}: field "${f.name}": "categories" must be a list`);
    categories = f.categories.map(c => (c && typeof c === 'object' && !Array.isArray(c)) ? c : { value: c });
    for (const c of categories) if (!('value' in c)) fail(`${where}: field "${f.name}": every category needs a "value"`);
  }
  if (f.range != null && !(Array.isArray(f.range) && f.range.length === 2 && f.range.every(isNum) && f.range[1] > f.range[0]))
    fail(`${where}: field "${f.name}": "range" must be [min, max] with min < max`);
  if (f.direction != null && !['from-to', 'to-from'].includes(f.direction)) fail(`${where}: field "${f.name}": "direction" must be "from-to" or "to-from"`);
  return { name: f.name, type, description: typeof f.description === 'string' ? f.description : (typeof f.title === 'string' ? f.title : ''),
           unit: typeof f.unit === 'string' ? f.unit : '', range: f.range || null, categories, ordered: f.categoriesOrdered === true,
           direction: f.direction || null, of: typeof f.of === 'string' ? f.of : null, required: !!(f.constraints && f.constraints.required),
           unique: !!(f.constraints && f.constraints.unique), declared: true };
}

// a value as the field's type (CSV gives strings; inline JSON mostly the right type already)
function castValue(v, f) {
  if (v == null || v === '') return null;
  switch (f && f.type) {
    case 'number': case 'integer': case 'year': { const x = typeof v === 'number' ? v : Number(v); return Number.isFinite(x) ? x : v; }
    case 'boolean': return v === true || v === 'true' || v === 'TRUE' || v === '1' || v === 1 ? true : v === false || v === 'false' || v === 'FALSE' || v === '0' || v === 0 ? false : v;
    case 'array': case 'object': if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v;
    default: return v;
  }
}

// One table resource → { name, title, n, columns, col: Map name→values[], fields: Map, primaryKey, keys, keyIndex, foreignKeys, geometry, style }
async function readTable(res, getText, warnings) {
  const where = `table "${res.name}"`;
  let header, body;
  if (Array.isArray(res.data)) {
    if (res.data.length && Array.isArray(res.data[0])) { header = res.data[0].map(String); body = res.data.slice(1); }
    else {
      header = [];
      for (const o of res.data) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${where}: "data" must be rows (a header row, then rows) or a list of objects`);
        for (const k of Object.keys(o)) if (!header.includes(k)) header.push(k);
      }
      body = res.data.map(o => header.map(k => (k in o ? o[k] : null)));
    }
  } else if (typeof res.path === 'string') {
    const text = await getText(res.path);
    if (text == null) fail(`${where}: its file "${res.path}" is not in the drop`);
    const rows = parseCsv(text);
    if (!rows.length) fail(`${where}: "${res.path}" is empty`);
    header = rows[0]; body = rows.slice(1);
  } else fail(`${where}: needs "data" (inline rows) or a "path" (a CSV file)`);
  body.forEach((r, i) => { if (r.length !== header.length) fail(`${where}: row ${i + 1} has ${r.length} values, the header ${header.length}`); });
  const schema = res.schema || {};
  const fields = new Map();
  for (const f of schema.fields || []) { const nf = normField(f, where); fields.set(nf.name, nf); }
  const col = new Map();
  header.forEach((h, k) => {
    const f = fields.get(h);
    col.set(h, body.map(r => castValue(r[k], f)));
    if (!f) {
      const g = guessProperty(h, col.get(h));
      fields.set(h, { name: h, type: g.type === 'integer' || g.type === 'number' ? g.type : 'string', description: '', unit: '', range: null,
                      categories: null, ordered: false, direction: null, of: null, declared: false, guessed: g.type });
    }
  });
  for (const [k, f] of fields) {
    if (!col.has(k)) { if (f.required) fail(`${where}: the required column "${k}" is missing`); continue; }
    const v = col.get(k);
    if (f.required) v.forEach((x, i) => { if (x == null) fail(`${where}: row ${i + 1} has no "${k}"`); });
    if ((f.type === 'number' || f.type === 'integer') && f.declared) v.forEach((x, i) => { if (x != null && !isNum(x)) fail(`${where}: "${k}" must be a number (row ${i + 1} has ${JSON.stringify(x)})`); });
  }
  const n = body.length;
  // keys
  const pk = schema.primaryKey == null ? null : [].concat(schema.primaryKey);
  let keys = null, keyIndex = null;
  if (pk) {
    for (const k of pk) if (!col.has(k)) fail(`${where}: primaryKey "${k}" is not a column`);
    keys = []; keyIndex = new Map();
    for (let i = 0; i < n; i++) {
      const parts = pk.map(k => col.get(k)[i]);
      if (parts.some(p => p == null || p === '')) fail(`${where}: row ${i + 1} has no value for its key (${pk.join(', ')})`);
      const key = parts.map(String).join('_');
      if (keyIndex.has(key)) fail(`${where}: the key "${key}" appears twice`);
      keys.push(key); keyIndex.set(key, i);
    }
  }
  const foreignKeys = (schema.foreignKeys || []).map(fk => {
    if (!fk || !fk.fields || !fk.reference) fail(`${where}: every foreignKey needs "fields" and "reference"`);
    const fields = [].concat(fk.fields), rfields = [].concat(fk.reference.fields || []);
    if (fields.length !== rfields.length) fail(`${where}: foreignKey ${fields.join(', ')} → ${rfields.join(', ')}: as many fields on both sides`);
    for (const k of fields) if (!col.has(k)) fail(`${where}: foreignKey field "${k}" is not a column`);
    return { fields, resource: fk.reference.resource || null, rfields };
  });
  return { name: res.name, title: res.title || res.name, description: res.description || '', meta: attributionOf(res), n, columns: header, col, fields,
           primaryKey: pk, keys, keyIndex, foreignKeys, geometry: res.geometry || null, style: res.style || {}, warnings };
}

// readPackage(obj, { name, getText(path) → Promise<string|null> })
// → { name, title, description, tables: Map, files: Map name → resource, warnings }
export async function readPackage(obj, { name = 'graph', getText = async () => null } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('not a JSON object');
  if (!Array.isArray(obj.resources) || !obj.resources.length) fail('"resources" is missing or empty');
  const warnings = [], tables = new Map(), files = new Map();
  for (const [i, r] of obj.resources.entries()) {
    if (!r || typeof r !== 'object') fail(`resource ${i + 1}: not an object`);
    if (typeof r.name !== 'string' || !r.name) fail(`resource ${i + 1}: needs a "name"`);
    if (tables.has(r.name) || files.has(r.name)) fail(`resource "${r.name}" appears twice`);
    const isTable = r.type === 'table' || Array.isArray(r.data) || (r.schema && r.schema.fields) || (typeof r.path === 'string' && /\.(csv|tsv)$/i.test(r.path));
    if (isTable) tables.set(r.name, await readTable(r, getText, warnings));
    else files.set(r.name, r);
  }
  // references between tables, checked once all are read
  for (const t of tables.values()) for (const fk of t.foreignKeys) {
    const target = fk.resource ? tables.get(fk.resource) : t;
    if (!target) fail(`table "${t.name}": foreignKey ${fk.fields.join(', ')} refers to "${fk.resource}", which is not a table of this package`);
    const tk = target.primaryKey || [];
    if (fk.rfields.join() !== tk.join()) fail(`table "${t.name}": foreignKey ${fk.fields.join(', ')} must refer to the primaryKey of "${target.name}" (${tk.join(', ') || 'none'})`);
    fk.target = target;
    fk.rows = new Int32Array(t.n).fill(-1);
    const missing = new Set();
    for (let i = 0; i < t.n; i++) {
      const parts = fk.fields.map(k => t.col.get(k)[i]);
      if (parts.some(p => p == null || p === '')) continue;   // no reference: a part is empty (a top-level region's parent, with its side still set)
      const key = parts.map(String).join('_'), j = target.keyIndex.get(key);
      if (j === undefined) missing.add(key); else fk.rows[i] = j;
    }
    if (missing.size) fail(`table "${t.name}": ${fk.fields.join(', ')} refers to key(s) not in "${target.name}": ${[...missing].slice(0, 8).join(', ')}${missing.size > 8 ? ', …' : ''}`);
  }
  for (const t of tables.values()) {
    const g = t.geometry;
    if (!g) continue;
    if (g.point) {
      if (!Array.isArray(g.point) || g.point.length !== 3) fail(`table "${t.name}": geometry.point must name the 3 columns of the position`);
      for (const c of g.point) if (!t.col.has(c)) fail(`table "${t.name}": geometry.point column "${c}" is missing`);
      if (g.coordinate_system != null && !['RAS', 'LPS'].includes(g.coordinate_system)) fail(`table "${t.name}": coordinate_system must be "RAS" or "LPS"`);
      if (g.units != null && g.units !== 'mm') fail(`table "${t.name}": units must be "mm"`);
    } else if (g.region) {
      if (!g.region.index || !t.col.has(g.region.index)) fail(`table "${t.name}": geometry.region.index must name a column`);
      if (g.region.volume && !files.has(g.region.volume)) warnings.push(`table "${t.name}": its label volume "${g.region.volume}" is not a resource of the package`);
    } else fail(`table "${t.name}": geometry needs "point" or "region"`);
  }
  return { meta: attributionOf(obj), name: typeof obj.name === 'string' ? obj.name : name, title: typeof obj.title === 'string' && obj.title ? obj.title : (typeof obj.name === 'string' ? obj.name : name),
           description: typeof obj.description === 'string' ? obj.description : '', profile: obj.$schema || null, tables, files, warnings, view: obj.view || null, raw: obj };
}

// ── to the drawing ─────────────────────────────────────────
// A field as a drawing property (markers-io's shape: type number / integer /
// categorical / text, legend for categorical).
function fieldProp(f, arrays) {
  let p;
  if (f.categories || f.type === 'boolean') {
    const cats = f.categories || [{ value: true }, { value: false }];
    p = { name: f.name, type: 'categorical', description: f.description, unit: f.unit, ordered: f.ordered, declared: f.declared,
          legend: cats.map(c => ({ value: c.value, name: c.label != null ? String(c.label) : String(c.value), color: rgb255(c.color),
                                   shape: MARKER_SHAPES.includes(c.shape) ? c.shape : null, size: isNum(c.size) && c.size >= 0 ? c.size : null })) };
  } else if (f.type === 'number' || f.type === 'integer' || f.type === 'year') {
    p = { name: f.name, type: f.type === 'year' ? 'integer' : f.type, description: f.description, unit: f.unit, declared: f.declared };
    if (f.range) p.range = f.range.slice();
  } else if (!f.declared && f.guessed === 'categorical') {
    p = { name: f.name, type: 'categorical', description: '', unit: '', ordered: false, legend: [], declared: false };
  } else p = { name: f.name, type: 'text', description: f.description, unit: f.unit, declared: f.declared };
  return p;
}
function finishProp(p, arrays) {
  completeLegend(p, arrays);
  if (p.type === 'number' || p.type === 'integer') {
    let lo = Infinity, hi = -Infinity;
    for (const a of arrays) for (const v of a) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    p.dataRange = lo <= hi ? [lo, hi] : [0, 1];
  }
}

// The link tables of a point table: tables without geometry with two
// foreign keys into it (from, to).
export function linkTablesOf(pkg, table) {
  const out = [];
  for (const t of pkg.tables.values()) {
    if (t.geometry || t === table) continue;
    const fks = t.foreignKeys.filter(fk => fk.target === table);
    if (fks.length < 2) continue;
    const from = fks.find(fk => fk.fields.includes('from')) || fks[0];
    const to = fks.find(fk => fk !== from && fk.fields.includes('to')) || fks.find(fk => fk !== from);
    out.push({ table: t, from, to });
  }
  return out;
}

// A point table (and its link tables) → the drawing's set:
//  { name, space, props, warnings,
//    markers: { n, ids, index, pos, values, rowColor },
//    links: { n, from, to, values: { field: { both | fwd | bwd } } },
//    style: { markers, links } }
export function pointSet(pkg, table) {
  const g = table.geometry.point ? table.geometry : null;
  if (!g) fail(`table "${table.name}" has no point geometry`);
  const n = table.n, flip = g.coordinate_system === 'LPS' ? -1 : 1;
  const [cx, cy, cz] = g.point.map(c => table.col.get(c));
  const pos = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    if (![cx[i], cy[i], cz[i]].every(isNum)) fail(`table "${table.name}": row ${i + 1} needs numeric ${g.point.join(', ')}`);
    pos[3 * i] = flip * cx[i]; pos[3 * i + 1] = flip * cy[i]; pos[3 * i + 2] = cz[i];
  }
  const ids = table.keys ? table.keys.slice() : Array.from({ length: n }, (_, i) => String(i + 1));
  const index = new Map(ids.map((k, i) => [k, i]));
  const props = new Map(), values = {}, warnings = [...table.warnings];
  const style = table.style || {};
  const skip = new Set(g.point);
  if (style.color_column) skip.add(style.color_column);
  for (const [name, f] of table.fields) {
    if (skip.has(name) || !table.col.has(name)) continue;
    const p = fieldProp(f);
    props.set(name, p);
    values[name] = columnValues(p, table.col.get(name), `table "${table.name}"`);
  }
  // each row's own color
  let rowColor = null;
  if (style.color_column && table.col.has(style.color_column)) {
    rowColor = new Float32Array(3 * n).fill(NaN);
    table.col.get(style.color_column).forEach((c, i) => { const rgb = rgb255(c); if (rgb) rowColor.set(rgb, 3 * i); });
  }
  // links
  const lts = linkTablesOf(pkg, table);
  let m = 0;
  for (const lt of lts) m += lt.table.n;
  const from = new Int32Array(m), to = new Int32Array(m), lv = {};
  let off = 0;
  for (const lt of lts) {
    const t = lt.table, fkCols = new Set([...lt.from.fields, ...lt.to.fields]);
    for (let i = 0; i < t.n; i++) { from[off + i] = lt.from.rows[i]; to[off + i] = lt.to.rows[i]; }
    for (const [name, f] of t.fields) {
      if (fkCols.has(name) || !t.col.has(name)) continue;
      let dir = 'both', of = name;
      // a value in one direction: declared with "direction" and "of" (a name like >>strength is just a name)
      if (f.direction) { dir = f.direction === 'from-to' ? 'fwd' : 'bwd'; of = f.of || name; }
      if (!props.has(of)) props.set(of, fieldProp({ ...f, name: of }));
      const arr = (lv[of] || (lv[of] = {}));
      if (!arr[dir]) arr[dir] = new Array(m).fill(null);
      const vals = columnValues(props.get(of), t.col.get(name), `table "${t.name}"`);
      for (let i = 0; i < t.n; i++) arr[dir][off + i] = vals[i];
    }
    off += t.n;
  }
  for (const [name, p] of props) {
    if (p.type === 'number' || p.type === 'integer') for (const v of Object.values(lv[name] || {})) for (let i = 0; i < v.length; i++) if (v[i] == null) v[i] = NaN;
    const arrays = [];
    if (values[name]) arrays.push(values[name]);
    if (lv[name]) arrays.push(...Object.values(lv[name]));
    finishProp(p, arrays);
  }
  for (let i = 0; i < m; i++) if (from[i] < 0 || to[i] < 0) fail(`a link table has a row without both ends`);
  return {
    name: table.title && table.title !== table.name ? table.title : (pointTables(pkg).length > 1 ? pkg.title + ' · ' + table.name : pkg.title),
    space: g.space || null, coordinateSystem: g.coordinate_system || 'RAS', props, warnings,
    markers: { n, ids, index, pos, values, rowColor },
    links: { n: m, from, to, values: lv },
    style: { markers: { ...style }, links: { ...((lts[0] && lts[0].table.style) || {}) } },
    table, linkTables: lts.map(l => l.table),
  };
}

// The point tables of a package, in order.
export function pointTables(pkg) { return [...pkg.tables.values()].filter(t => t.geometry && t.geometry.point); }
export function regionTables(pkg) { return [...pkg.tables.values()].filter(t => t.geometry && t.geometry.region); }

// ── region tables → a lookup table with a hierarchy ─────────────────────
// A region table (geometry.region) gives a label volume its names, colors
// and groups. Returns { map: Map index → { name, r, g, b, a }, maxIndex,
// tree } — the map as a parsed LUT (so everything that reads a LUT reads
// this), the tree for the region list:
//   tree.nodes[k] = { key, name, index (or null: a group), color [r,g,b] 0–1 or null,
//                     parent (node or −1), children [node…], row }
//   tree.roots = [node…], tree.byIndex = Map index → node
// The name: the column style.name_column, else "name", else "label", else
// the key. The color: style.color_column, else "color". The parent: a
// foreign key of the table into itself.
export function regionLut(pkg, table) {
  const g = table.geometry && table.geometry.region;
  if (!g) fail(`table "${table.name}" has no region geometry`);
  const st = table.style || {};
  const nameCol = [st.name_column, 'name', 'label'].find(c => c && table.col.has(c)) || null;
  const colorCol = [st.color_column, 'color', 'colour'].find(c => c && table.col.has(c)) || null;
  const idx = table.col.get(g.index);
  const self = table.foreignKeys.find(fk => fk.target === table);
  const keys = table.keys || Array.from({ length: table.n }, (_, i) => String(idx[i] ?? i + 1));
  const nodes = [];
  for (let i = 0; i < table.n; i++) {
    const v = idx[i];
    if (v != null && !(Number.isInteger(v) && v > 0)) fail(`table "${table.name}": row ${i + 1}: "${g.index}" must be a whole number above 0 (the region's value in the label volume)`);
    const name = nameCol && table.col.get(nameCol)[i] != null ? String(table.col.get(nameCol)[i]) : keys[i];
    nodes.push({ key: keys[i], name, index: v == null ? null : v, color: colorCol ? rgb255(table.col.get(colorCol)[i]) : null, parent: -1, children: [], row: i });
  }
  if (self) for (let i = 0; i < table.n; i++) {
    const j = self.rows[i];
    if (j >= 0) { if (j === i) fail(`table "${table.name}": "${keys[i]}" is its own parent`); nodes[i].parent = j; nodes[j].children.push(nodes[i]); }
  }
  // no cycles: every chain of parents ends
  for (const nd of nodes) { let k = 0, p = nd.parent; while (p >= 0) { if (++k > nodes.length) fail(`table "${table.name}": the parents of "${nd.key}" form a loop`); p = nodes[p].parent; } }
  const map = new Map(), byIndex = new Map();
  let maxIndex = 0, auto = 0;
  for (const nd of nodes) {
    if (nd.index == null) continue;
    if (byIndex.has(nd.index)) fail(`table "${table.name}": the value ${nd.index} is given to two regions ("${byIndex.get(nd.index).key}", "${nd.key}")`);
    byIndex.set(nd.index, nd);
    // a region without a color of its own: its nearest group's, else automatic
    let c = nd.color, p = nd.parent;
    while (!c && p >= 0) { c = nodes[p].color; p = nodes[p].parent; }
    if (!c) c = autoColorOf(auto++);
    map.set(nd.index, { name: nd.name, r: c[0], g: c[1], b: c[2], a: 1 });
    if (nd.index > maxIndex) maxIndex = nd.index;
  }
  const roots = nodes.filter(nd => nd.parent < 0);
  return { map, maxIndex, tree: { nodes, roots, byIndex, nameColumn: nameCol, table: table.name } };
}
function autoColorOf(i) { const h = ((i * 137.50776405003785) % 360) / 360, s = 0.65, l = 0.55;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]; }

// ── a hierarchy from region names (a plain lookup table: no graph file) ──
// 1. sides: Left-…/Right-…, lh-/rh- (also inside: ctx-lh-precentral), a
//    trailing _L/_R, " L"/" R", "(L)"/"(R)" — a top level "left" / "right"
//    (the rest under neither, as they are);
// 2. a path: "Forebrain|Cerebral cortex|M1" — the last part the region's
//    name, the parts before it its groups (made as needed, shared).
// Returns a tree as regionLut's, or null when the names give no structure.
const SIDE_RE = [
  [/^left[-_ ]/i, 'L'], [/^right[-_ ]/i, 'R'],
  [/(^|[-_ ])lh([-_ .]|$)/i, 'L'], [/(^|[-_ ])rh([-_ .]|$)/i, 'R'],
  [/[-_ ]L$|\(L\)$/, 'L'], [/[-_ ]R$|\(R\)$/, 'R'],
];
export function sideOfName(name) { for (const [re, s] of SIDE_RE) if (re.test(name)) return s; return null; }
export function treeFromNames(map) {
  const entries = [...map.entries()].filter(([v]) => v > 0);
  const withSide = entries.filter(([, e]) => sideOfName(e.name || '')).length;
  const withPath = entries.filter(([, e]) => (e.name || '').includes('|')).length;
  const useSides = withSide >= 2 && entries.some(([, e]) => sideOfName(e.name || '') === 'L') && entries.some(([, e]) => sideOfName(e.name || '') === 'R');
  if (!useSides && !withPath) return null;
  const nodes = [], groups = new Map();
  const group = (key, name, parent) => {
    if (groups.has(key)) return groups.get(key);
    const nd = { key, name, index: null, color: null, parent: parent ? nodes.indexOf(parent) : -1, children: [], row: -1 };
    nodes.push(nd); if (parent) parent.children.push(nd); groups.set(key, nd); return nd;
  };
  const byIndex = new Map();
  for (const [v, e] of entries) {
    const full = e.name || ('label ' + v);
    const parts = full.split('|').map(s => s.trim()).filter(Boolean);
    let parent = null, prefix = '';
    const side = useSides ? sideOfName(full) : null;
    if (side) { parent = group(side, side === 'L' ? 'left' : 'right', null); prefix = side + '|'; }
    for (const part of parts.slice(0, -1)) { prefix += part + '|'; parent = group(prefix, part, parent); }
    const nd = { key: String(v), name: parts.length ? parts[parts.length - 1] : full, index: v, color: [e.r, e.g, e.b], parent: parent ? nodes.indexOf(parent) : -1, children: [], row: -1 };
    nodes.push(nd); if (parent) parent.children.push(nd); byIndex.set(v, nd);
  }
  return { nodes, roots: nodes.filter(nd => nd.parent < 0), byIndex, fromNames: true };
}
