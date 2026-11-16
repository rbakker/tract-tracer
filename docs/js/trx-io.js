// ── trx-io.js ─────────────────────────────────────────────
// Reads TRX tractograms (https://github.com/tee-ar-ex/trx-spec): a zip of
// plain little-endian arrays whose names say their type —
//   header.json            NB_STREAMLINES, NB_VERTICES, VOXEL_TO_RASMM, DIMENSIONS
//   positions.3.<float16|float32|float64>   all points, RAS mm, back to back
//   offsets.<uint32|uint64>                 each streamline's first point (often
//                                           with NB_VERTICES appended at the end)
//   dpv/<name>[.n].<dtype>  per point     dps/<name>[.n].<dtype>  per streamline
//   groups/<name>.<int>     streamline indices      dpg/<group>/…  per group
//
// The zip is read in place, not unpacked: its table of contents (at the end
// of the file) gives where each entry's bytes are, and those are read in
// ranges (File.slice) — for stored (uncompressed) entries, the usual TRX
// case, only what is needed, chunk by chunk; deflated ones are streamed
// through the browser's decompressor. So a large file is never held whole:
// the offsets first (exact point counts, for the memory budget), then the
// positions in chunks, straight into the kept points (every n-th streamline
// when thinned).
//
// What the app takes in: positions → streamlines (float32); dps / dpv with
// one value each → data fields (as .dqz data files, see dqz-format.md);
// groups that don't overlap → a bundle field (each group a bundle).
// Overlapping groups, multi-value fields and dpg are listed, not used.

const DTYPES = {
  int8: [Int8Array, 1], uint8: [Uint8Array, 1], int16: [Int16Array, 2], uint16: [Uint16Array, 2],
  int32: [Int32Array, 4], uint32: [Uint32Array, 4], int64: [BigInt64Array, 8], uint64: [BigUint64Array, 8],
  float16: [Uint16Array, 2], float32: [Float32Array, 4], float64: [Float64Array, 8],
};

// float16 → float32, by table
let _f16 = null;
function f16Table() {
  if (_f16) return _f16;
  _f16 = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    _f16[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return _f16;
}

// "dpv/fa.float16" → { dir: 'dpv', name: 'fa', comps: 1, dtype: 'float16' }
export function trxNameInfo(path) {
  const parts = String(path).split('/'), base = parts.pop(), dir = parts.join('/');
  const bits = base.split('.');
  const dtype = bits.pop();
  if (!DTYPES[dtype]) return null;
  let comps = 1;
  if (bits.length > 1 && /^\d+$/.test(bits[bits.length - 1])) comps = +bits.pop();
  return { dir, name: bits.join('.'), comps, dtype };
}

// ── the zip, read in place ──
async function bytes(file, a, b) { return new Uint8Array(await file.slice(a, b).arrayBuffer()); }
async function openZip(file) {
  const size = file.size, tailLen = Math.min(size, 65557);
  const tail = await bytes(file, size - tailLen, size), tv = new DataView(tail.buffer);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw 'not a zip file (no table of contents)';
  let n = tv.getUint16(e + 10, true), cdSize = tv.getUint32(e + 12, true), cdOff = tv.getUint32(e + 16, true);
  if (n === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {   // ZIP64
    const L = e - 20;
    if (L < 0 || tv.getUint32(L, true) !== 0x07064b50) throw 'damaged ZIP64 table of contents';
    const z64 = Number(tv.getBigUint64(L + 8, true));
    const r = new DataView((await bytes(file, z64, z64 + 56)).buffer);
    n = Number(r.getBigUint64(32, true)); cdSize = Number(r.getBigUint64(40, true)); cdOff = Number(r.getBigUint64(48, true));
  }
  const cd = await bytes(file, cdOff, cdOff + cdSize), dv = new DataView(cd.buffer), dec = new TextDecoder();
  const entries = new Map();
  for (let p = 0, k = 0; k < n && p + 46 <= cd.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw 'damaged zip table of contents';
    const method = dv.getUint16(p + 10, true);
    let comp = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), lho = dv.getUint32(p + 42, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nl));
    for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {   // ZIP64 sizes / offset
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(dv.getBigUint64(q, true)); q += 8; }
        if (lho === 0xffffffff) { lho = Number(dv.getBigUint64(q, true)); }
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) entries.set(name, { name, method, comp, size: usize, lho, start: null });
    p += 46 + nl + xl + cl;
  }
  return { file, entries };
}
async function dataStart(z, en) {
  if (en.start == null) {
    const h = new DataView((await bytes(z.file, en.lho, en.lho + 30)).buffer);
    if (h.getUint32(0, true) !== 0x04034b50) throw 'damaged zip entry ' + en.name;
    en.start = en.lho + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  }
  return en.start;
}
// An entry's bytes, in chunks (stored: read in ranges; deflated: streamed).
async function* chunks(z, en, chunkBytes = 64 << 20) {
  const s = await dataStart(z, en);
  if (en.method === 0) {
    for (let a = 0; a < en.size; a += chunkBytes) yield await bytes(z.file, s + a, s + Math.min(en.size, a + chunkBytes));
  } else if (en.method === 8) {
    const reader = z.file.slice(s, s + en.comp).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; }
  } else throw 'zip entry ' + en.name + ': unsupported compression (method ' + en.method + ')';
}
async function readAll(z, en) {
  if (en.method === 0) { const s = await dataStart(z, en); return bytes(z.file, s, s + en.size); }
  const out = new Uint8Array(en.size);
  let o = 0;
  for await (const c of chunks(z, en)) { out.set(c, o); o += c.length; }
  return out;
}
// a typed view of bytes (copied when not aligned)
function typed(u8, dtype) {
  const [T, sz] = DTYPES[dtype];
  if (u8.byteOffset % sz) u8 = u8.slice();
  return new T(u8.buffer, u8.byteOffset, Math.floor(u8.length / sz));
}
// any TRX array → plain numbers (Float64Array: exact for indices up to 2^53)
function asNumbers(u8, dtype) {
  const a = typed(u8, dtype);
  if (dtype === 'float16') { const t = f16Table(), o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = t[a[i]]; return o; }
  if (dtype === 'int64' || dtype === 'uint64') { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Number(a[i]); return o; }
  return a;
}

// The TRX's entries, by name, whatever folder the zip put them in (a TRX
// zipped as its folder: "name.trx/header.json").
async function openTrx(file) {
  const z = await openZip(file);
  let root = null;
  for (const name of z.entries.keys()) if (/(^|\/)header\.json$/.test(name)) { const r = name.slice(0, -'header.json'.length); if (root == null || r.length < root.length) root = r; }
  if (root == null) throw 'not a TRX file (no header.json)';
  const own = new Map();
  for (const [name, en] of z.entries) if (name.startsWith(root)) own.set(name.slice(root.length), en);
  const header = JSON.parse(new TextDecoder().decode(await readAll(z, own.get('header.json'))));
  return { z, own, header };
}

/** How many streamlines and points a .trx holds (exact, from its header). */
export async function countTrx(file) {
  const { header } = await openTrx(file);
  return { points: +header.NB_VERTICES || 0, streamlines: +header.NB_STREAMLINES || null, exact: true };
}

/**
 * Reads a .trx.
 * @param {File|Blob} file
 * @param {number} [maxNumTracts=0] - at most this many, 0 for all
 * @param {number} [every=1] - keep every n-th streamline
 * @returns {Promise<{ header, streamlines, streamlineLookup, total, fields }>}
 *   fields: [{ header, parsed }] in the shape of .dqz data files
 *   (parseDqzChild), already cut down to the kept streamlines (parsed) —
 *   header.n_streamlines: the file's count.
 */
export async function parseTrx(file, maxNumTracts = 0, every = 1) {
  const { z, own, header: H } = await openTrx(file);
  const NS = +H.NB_STREAMLINES, NV = +H.NB_VERTICES;
  const find = (dir, name) => { for (const [p, en] of own) { const i = trxNameInfo(p); if (i && i.dir === dir && (name == null || i.name === name)) return [p, en, i]; } return null; };
  const pos = find('', 'positions'), off = find('', 'offsets');
  if (!pos || !off) throw 'TRX without positions or offsets';
  if (pos[2].comps !== 3) throw 'TRX positions must have 3 values per point';
  // the offsets: each streamline's [start, end) in points
  let O = asNumbers(await readAll(z, off[1]), off[2].dtype);
  if (O.length === NS) { const o2 = new Float64Array(NS + 1); o2.set(O); o2[NS] = NV; O = o2; }
  if (O.length !== NS + 1) throw `TRX offsets: ${O.length} values for ${NS} streamlines`;
  // the kept streamlines
  const kept = [];
  for (let s = 0; s < NS && !(maxNumTracts && kept.length >= maxNumTracts); s += every) kept.push(s);
  let nKept = 0;
  for (const s of kept) nKept += O[s + 1] - O[s];
  const out = new Float32Array(3 * nKept), outStart = new Float64Array(kept.length + 1);
  for (let k = 0, o = 0; k < kept.length; k++) { outStart[k] = o; o += O[kept[k] + 1] - O[kept[k]]; }
  outStart[kept.length] = nKept;
  // the positions, chunk by chunk, into the kept streamlines' places
  await copyKept(z, pos[1], pos[2].dtype, 3, O, kept, outStart, out);
  const streamlines = new Array(kept.length), lookup = new Int32Array(nKept);
  for (let k = 0; k < kept.length; k++) {
    streamlines[k] = out.subarray(3 * outStart[k], 3 * outStart[k + 1]);
    lookup.fill(k, outStart[k], outStart[k + 1]);
  }
  // data per point / per streamline (one value each), groups
  const fields = [], notUsed = [];
  for (const [p, en] of own) {
    const i = trxNameInfo(p);
    if (!i || (i.dir !== 'dps' && i.dir !== 'dpv')) continue;
    if (i.comps !== 1) { notUsed.push(p + ' (' + i.comps + ' values each)'); continue; }
    const scope = i.dir === 'dps' ? 'per_streamline' : 'per_vertex';
    let values;
    if (scope === 'per_streamline') {
      const all = asNumbers(await readAll(z, en), i.dtype);
      values = Float32Array.from(kept, s => Number(all[s]));
    } else {
      values = new Float32Array(nKept);
      await copyKept(z, en, i.dtype, 1, O, kept, outStart, values);
    }
    const isInt = !/^float/.test(i.dtype);
    let kind = 'raw';
    if (isInt && scope === 'per_streamline') { const d = new Set(values); if (d.size <= 256) kind = 'categorical'; }
    fields.push(fieldOf(i.name, 'TRX ' + p, kind, scope, NS, values, kept, O, outStart));
  }
  // groups: a bundle each, when they don't overlap
  const groups = [...own].map(([p, en]) => [p, en, trxNameInfo(p)]).filter(([, , i]) => i && i.dir === 'groups' && !/^float/.test(i.dtype))
    .sort((a, b) => a[2].name.localeCompare(b[2].name));   // (by name: the zip's order varies)
  let groupNote = null;
  if (groups.length) {
    const code = new Uint16Array(NS);
    let overlap = false;
    const legend = [];
    for (let g = 0; g < groups.length && !overlap; g++) {
      const idx = asNumbers(await readAll(z, groups[g][1]), groups[g][2].dtype);
      for (const s of idx) { if (code[s] && code[s] !== g + 1) { overlap = true; break; } code[s] = g + 1; }   // (a streamline listed twice in one group is fine)
      legend.push({ value: g + 1, name: groups[g][2].name });
    }
    if (overlap) groupNote = groups.length + ' groups that overlap: not used yet (a streamline in two groups)';
    else {
      if (code.some(c => c === 0)) legend.push({ value: 0, name: 'no group' });
      const f = fieldOf('groups', 'TRX groups', 'categorical', 'per_streamline', NS, Float32Array.from(kept, s => code[s]), kept, O, outStart);
      f.header.legend = legend; f.header.role = 'bundles'; f.parsed.header.legend = legend; f.parsed.header.role = 'bundles';
      fields.push(f);
    }
  }
  const header = { format: 'TRX', ...H, streamlines_read: kept.length,
                   fields: fields.map(f => f.header.name),
                   ...(notUsed.length ? { not_used: notUsed } : {}), ...(groupNote ? { groups: groupNote } : {}),
                   ...([...own.keys()].some(p => p.startsWith('dpg/')) ? { dpg: 'data per group: not used yet' } : {}) };
  return { header, streamlines, streamlineLookup: lookup, total: NS, fields };
}

// Copies the kept streamlines' values (comps per point) of an entry into
// out, at outStart (in points), streaming the entry chunk by chunk.
async function copyKept(z, en, dtype, comps, O, kept, outStart, out) {
  const sz = DTYPES[dtype][1], per = sz * comps, t16 = dtype === 'float16' ? f16Table() : null;
  let carry = null, g = 0, k = 0;   // g: points done; k: the kept streamline we're in
  for await (let c of chunks(z, en)) {
    if (carry && carry.length) { const b = new Uint8Array(carry.length + c.length); b.set(carry); b.set(c, carry.length); c = b; }
    const nP = Math.floor(c.length / per);
    carry = c.slice(nP * per);
    const v = typed(c.subarray(0, nP * per), dtype), g1 = g + nP;
    while (k < kept.length && O[kept[k]] < g1) {
      const s = kept[k], a = Math.max(O[s], g), b = Math.min(O[s + 1], g1);
      if (b > a) {
        const src = (a - g) * comps, dst = (outStart[k] + a - O[s]) * comps, n = (b - a) * comps;
        if (t16) for (let i = 0; i < n; i++) out[dst + i] = t16[v[src + i]];
        else if (dtype === 'int64' || dtype === 'uint64') for (let i = 0; i < n; i++) out[dst + i] = Number(v[src + i]);
        else if (v instanceof Float32Array) out.set(v.subarray(src, src + n), dst);
        else for (let i = 0; i < n; i++) out[dst + i] = v[src + i];
      }
      if (O[s + 1] <= g1) k++; else break;
    }
    g = g1;
  }
}

// A field in the shape of a parsed .dqz data file, cut to the kept streamlines.
function fieldOf(name, description, kind, scope, NS, values, kept, O, outStart) {
  const header = { name, description, kind, scope, dtype: 'float32', n_streamlines: NS, legend: null };
  const parsed = { header: { ...header, n_streamlines: kept.length }, scope, values, codes: values, pointCounts: null, offsets: null };
  if (scope === 'per_vertex') {
    parsed.pointCounts = Uint32Array.from(kept, s => O[s + 1] - O[s]);
    parsed.offsets = Uint32Array.from(outStart);
  }
  return { header, parsed };
}
