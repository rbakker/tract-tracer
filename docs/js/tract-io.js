// -- tract-io.js ------------------------------------
// MRtrix3 .tck parser + writer / TrackVis .trk parser

export function matMul(A, B) {
  const rowsA = A.length, colsA = A[0].length, colsB = B[0].length;
  return Array.from({ length: rowsA }, (_, r) =>
    Array.from({ length: colsB }, (_, c) => {
      let sum = 0;
      for (let k = 0; k < colsA; k++) sum += A[r][k] * B[k][c];
      return sum;
    })
  );
}

/**
 * Detect whether the host system is little‑endian.
 * @returns {boolean}
 */
function sysLE() {
  const t = new Uint16Array(1); t[0] = 348;
  return new DataView(t.buffer).getUint16(0, true) === 348;
}


/**
 * Parse the text header of a .tck file into a JS object.
 * Handles multi‑line fields and command_history arrays.
 * @param {ArrayBuffer} buf
 * @returns {Object} Parsed header fields
 */
function parseTckHeader(buf) {
  const arrayFields = ['command_history'];
  const maxScan = Math.min(16384, buf.byteLength);
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(new Uint8Array(buf, 0, maxScan));

  const endMatch = text.match(/(^|\n)END(\r?\n|$)/);
  if (!endMatch) throw 'Could not find END in .tck header';

  const headerText = text.slice(0, endMatch.index + endMatch[0].length);
  const lines = headerText.split('\n');
  const header = {};

  if (!lines[0].startsWith('mrtrix tracks')) throw 'Not a .tck file';

  let lastKey = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === 'END') break;

    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      const k = m[1], v = m[2];

      if (arrayFields.indexOf(k) > -1) {
        if (k in header) header[k].push(v);
        else header[k] = [v];
      } else {
        header[k] = v;
      }

      lastKey = k;
    } else if (lastKey !== null) {
      if (arrayFields.indexOf(lastKey) > -1) {
        header[lastKey][header[lastKey].length - 1] += '\n' + line;
      } else {
        header[lastKey] += '\n' + line;
      }
    }
  }

  return header;
}

/**
 * Convert a header object back into raw .tck header text.
 * @param {Object} header
 * @returns {string}
 */
function headerToRaw(header) {
  const lines = [];
  for (const [k, v] of Object.entries(header)) {
    const values = Array.isArray(v) ? v : [v];
    for (const s of values) lines.push(`${k}: ${s}`);
  }
  return 'mrtrix tracks\n' + lines.join('\n') + '\nEND\n';
}

/**
 * Parse a full .tck file into streamlines + metadata.
 * @param {File} file
 * @param {number} [maxNumTracts=0] - Maximum number of tracts to extract, 0 to extract all.
 * @param {number} [every=1] - keep every n-th streamline (then copied out,
 *   so the file's buffer isn't kept alive)
 * @returns {{streamlines: Array, streamlineLookup: Int32Array, header: Object, total: number}}
 */
export async function parseTck(file, maxNumTracts = 0, every = 1) {
  const buf = await file.arrayBuffer();
  
  const header = parseTckHeader(buf);
  const byteOffset = parseInt(header.file.split(' ').pop());
  const m = header.datatype.trim().match(/^float(32|64)(le|be)?$/i);
  if (!m) throw 'Bad TCK datatype';

  const bpe = parseInt(m[1]) / 8;
  const Dtype = bpe === 4 ? Float32Array : Float64Array;
  const le = (m[2] || 'LE').toUpperCase() === 'LE';

  let data;
  if (le === sysLE()) {
    data = byteOffset % bpe
      ? new Dtype(buf.slice(byteOffset))
      : new Dtype(buf, byteOffset);
  } else {
    const len = (buf.byteLength - byteOffset) / bpe;
    data = new Dtype(len);
    const dv = new DataView(buf, byteOffset);
    const getter = bpe === 4 ? dv.getFloat32.bind(dv) : dv.getFloat64.bind(dv);
    for (let i = 0; i < len; i++) data[i] = getter(i * bpe, le);
  }

  const streamlines = [], lookup = [];
  const nPoints = data.length / 3;
  let iPrev = 0, seen = 0;

  // Push a streamline slice [start,end)
  function pushStreamline(start, end) {
    const len = end - start;
    if (len <= 0) return;
    if (seen++ % every) return;

    const si = streamlines.length;
    const off = data.byteOffset + 3 * start * data.BYTES_PER_ELEMENT;
    streamlines.push(new data.constructor(data.buffer, off, 3 * len));

    for (let k = 0; k < len; k++) lookup.push(si);
  }
  // thinned: the kept streamlines into one buffer of their own
  const done = () => {
    if (every > 1) {
      let n = 0; for (const t of streamlines) n += t.length;
      const out = new Float32Array(n); let o = 0;
      for (let i = 0; i < streamlines.length; i++) { const t = streamlines[i]; out.set(t, o); streamlines[i] = out.subarray(o, o + t.length); o += t.length; }
    }
    return { streamlines, streamlineLookup: new Int32Array(lookup), header, total: seen };
  };

  for (let i = 0; i < nPoints; i++) {
    const x = data[3*i], y = data[3*i+1], z = data[3*i+2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      pushStreamline(iPrev, i);
      iPrev = i + 1;
      if (maxNumTracts && streamlines.length >= maxNumTracts) return done();
    }
  }

  pushStreamline(iPrev, nPoints);

  return done();
}


// -- .dqz parser (quantized-delta compressed .tck) ---------------
// See tck_quantize.py / dqz-format.md for the full format spec and the
// reference Python implementation this mirrors byte-for-byte — cross-
// checked directly against it (including every degenerate edge case:
// empty, single-point, and coincident-point streamlines) rather than
// just against the written spec, since a subtle byte-offset mistake
// here would silently corrupt geometry rather than throw.

const DQZ_MAGIC = 'TCKDQZ01';

/**
 * Parse the JSON header of a .dqz file (quantized-delta compressed
 * .tck — see tck_quantize.py / dqz-format.md).
 * @param {ArrayBuffer} buf
 * @returns {Object} A .tck-style header object — source_header's own
 *   fields (the original file's genuine custom metadata, if any) are
 *   merged in directly, and datatype/count/file are regenerated to
 *   describe the DECOMPRESSED data, matching what parseTckHeader would
 *   produce for an equivalent, uncompressed .tck. Format-specific
 *   fields that only a .dqz-aware caller needs (divisor, where the
 *   per-streamline records start) live under header._dqz rather than
 *   mixed into the plain .tck-shaped fields above.
 */
export function parseDqzHeader(buf) {
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 8));
  if (magic !== DQZ_MAGIC) throw 'Not a .dqz file (bad magic)';

  const dv = new DataView(buf);
  const headerLen = dv.getUint32(8, true);
  const headerText = new TextDecoder('utf-8').decode(new Uint8Array(buf, 12, headerLen));
  const dqzHeader = JSON.parse(headerText);

  const header = {
    ...(dqzHeader.source_header || {}),
    datatype: 'Float32LE',
    count: String(dqzHeader.n_streamlines),
    // no real byte-offset concept for this format; same "placeholder,
    // fixed up elsewhere" convention ensureTckHeader/writeTck already use
    file: '. 0',
  };

  header._dqz = {
    divisor: dqzHeader.divisor,
    n_streamlines: dqzHeader.n_streamlines,
    // Optional per the spec — null for files encoded before uuid
    // existed; such a parent simply can't have children matched to it.
    // An opaque string (typically the source .tck's timestamp), compared
    // exactly, never validated as a real UUID. A number is stringified
    // in case a writer ever emits a timestamp unquoted.
    uuid: (typeof dqzHeader.uuid === 'string' && dqzHeader.uuid) ? dqzHeader.uuid
        : (typeof dqzHeader.uuid === 'number' ? String(dqzHeader.uuid) : null),
    dataOffset: 12 + headerLen,
  };

  return header;
}

/**
 * Parse a full .dqz file into streamlines + metadata, decoding the
 * quantized-delta encoding back into ordinary float coordinates.
 * Same return shape as parseTck.
 * @param {File} file
 * @param {number} [maxNumTracts=0] - Maximum number of streamlines to
 *   decode, 0 for all. A .dqz file's per-streamline records are self-
 *   describing (each starts with its own point count), so once the
 *   kept streamlines are read nothing after them needs to be touched
 *   at all — unlike parseTck's own maxNumTracts, which is accepted but
 *   never actually used to limit anything, this one really does.
 * @returns {{tracts: Array, streamlineLookup: Int32Array, header: Object}}
 */
export async function parseDqz(file, maxNumTracts = 0, every = 1) {
  const buf = await file.arrayBuffer();
  const header = parseDqzHeader(buf);
  const { dataOffset, n_streamlines } = header._dqz;

  const dv = new DataView(buf);
  if (every > 1) return decodeDqzThinned(dv, header, dataOffset, n_streamlines, maxNumTracts, every);

  const numTracts = maxNumTracts ? Math.min(maxNumTracts, n_streamlines) : n_streamlines;

  // First pass: walk just the records being kept, reading each one's
  // n_points (4 bytes) and remembering where its payload starts, so the
  // shared output buffer can be sized once instead of growing
  // streamline by streamline (same two-pass pattern parseTrk uses).
  const pointCounts = new Array(numTracts);
  const recordOffsets = new Array(numTracts);
  let off = dataOffset;
  let totalPoints = 0;

  for (let tr = 0; tr < numTracts; tr++) {
    const n = dv.getUint32(off, true);
    recordOffsets[tr] = off;
    pointCounts[tr] = n;
    totalPoints += n;

    off += 4;
    if (n === 0) continue;
    off += 12 + 4; // start (3 x float32) + Q (float32)
    if (n >= 2) off += (n - 1) * 3; // deltas, 1 byte each
  }

  // Second pass: dequantize directly into one shared buffer, and build
  // per-streamline views into it — same memory layout parseTck/parseTrk
  // use, zero extra copies once the shared buffer is filled. Unlike
  // those two, values here are COMPUTED (cumulative sum of quantized
  // deltas, scaled by Q), not read directly off disk, since the raw
  // bytes are quantized deltas, not coordinates — see
  // dequantize_streamline in tck_quantize.py for the reference this
  // mirrors exactly.
  const dataArray = new Float32Array(totalPoints * 3);
  const lookup = new Int32Array(totalPoints);
  const streamlines = new Array(numTracts);

  let p = 0;  // running index into dataArray, in FLOATS
  let pi = 0; // running index into lookup

  for (let tr = 0; tr < numTracts; tr++) {
    const n = pointCounts[tr];
    const streamlineStartFloat = p;

    if (n === 0) {
      streamlines[tr] = new Float32Array(dataArray.buffer, dataArray.byteOffset + streamlineStartFloat * 4, 0);
      continue;
    }

    let roff = recordOffsets[tr] + 4; // skip n_points, already known
    const sx = dv.getFloat32(roff, true);
    const sy = dv.getFloat32(roff + 4, true);
    const sz = dv.getFloat32(roff + 8, true);
    roff += 12;
    const Q = dv.getFloat32(roff, true);
    roff += 4;

    dataArray[p++] = sx; dataArray[p++] = sy; dataArray[p++] = sz;
    lookup[pi++] = tr;

    // Cumulative sum of quantized-integer deltas — exact integer
    // arithmetic, no accumulated rounding (see tck_quantize.py's module
    // docstring for why the encoding side guarantees this).
    let ix = 0, iy = 0, iz = 0;
    for (let i = 1; i < n; i++) {
      const dx = dv.getInt8(roff);     roff += 1;
      const dy = dv.getInt8(roff);     roff += 1;
      const dz = dv.getInt8(roff);     roff += 1;
      ix += dx; iy += dy; iz += dz;
      dataArray[p++] = sx + ix * Q;
      dataArray[p++] = sy + iy * Q;
      dataArray[p++] = sz + iz * Q;
      lookup[pi++] = tr;
    }

    streamlines[tr] = new Float32Array(dataArray.buffer, dataArray.byteOffset + streamlineStartFloat * 4, n * 3);
  }

  return { streamlines, streamlineLookup: lookup, header, total: n_streamlines };
}

// parseDqz keeping every n-th streamline: the records walked, the kept
// ones decoded (same arithmetic as above).
function decodeDqzThinned(dv, header, dataOffset, n_streamlines, maxNumTracts, every) {
  const offs = [], counts = [];
  let off = dataOffset, total = 0;
  for (let tr = 0; tr < n_streamlines; tr++) {
    const n = dv.getUint32(off, true);
    if (tr % every === 0 && !(maxNumTracts && offs.length >= maxNumTracts)) { offs.push(off); counts.push(n); total += n; }
    off += 4 + (n ? 16 + (n - 1) * 3 : 0);
  }
  const data = new Float32Array(total * 3), lookup = new Int32Array(total), streamlines = new Array(offs.length);
  let p = 0;
  for (let s = 0; s < offs.length; s++) {
    const n = counts[s], start = p;
    if (n) {
      let o = offs[s] + 4;
      const sx = dv.getFloat32(o, true), sy = dv.getFloat32(o + 4, true), sz = dv.getFloat32(o + 8, true), Q = dv.getFloat32(o + 12, true);
      o += 16;
      data[p++] = sx; data[p++] = sy; data[p++] = sz;
      let ix = 0, iy = 0, iz = 0;
      for (let i = 1; i < n; i++, o += 3) {
        ix += dv.getInt8(o); iy += dv.getInt8(o + 1); iz += dv.getInt8(o + 2);
        data[p++] = sx + ix * Q; data[p++] = sy + iy * Q; data[p++] = sz + iz * Q;
      }
      lookup.fill(s, start / 3, p / 3);
    }
    streamlines[s] = data.subarray(start, p);
  }
  return { streamlines, streamlineLookup: lookup, header, total: n_streamlines };
}

/**
 * How many streamlines and points a tract file holds — before reading it,
 * to decide how much of it fits in memory. Exact for .dqz and .tt (their
 * records are walked); for .tck and .trk estimated from the file size.
 * @param {File|Blob} file
 * @param {string} ext - '.tck', '.trk', '.dqz' or '.tt'
 * @returns {Promise<{points:number, streamlines:number|null, exact:boolean}>}
 */
export async function countTract(file, ext) {
  if (ext === '.tck') {
    const head = await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer();
    const h = parseTckHeader(head);
    const off = parseInt(String(h.file).split(' ').pop()) || 0;
    const bpe = /64/.test(h.datatype) ? 8 : 4;
    const n = parseInt(h.count) || null;
    return { points: Math.max(0, (file.size - off) / bpe / 3 - (n || 0)), streamlines: n, exact: false };
  }
  if (ext === '.trk') {
    const h = parseTrkHeader(await file.slice(0, 1000).arrayBuffer());
    const n = h.n_count || null, fpp = 3 + h.n_scalars;
    return { points: Math.max(0, (file.size - 1000 - (n || 0) * (4 + 4 * h.n_properties)) / (4 * fpp)), streamlines: n, exact: false };
  }
  if (ext === '.dqz') {
    const buf = await file.arrayBuffer();
    const header = parseDqzHeader(buf), dv = new DataView(buf);
    let off = header._dqz.dataOffset, pts = 0;
    for (let tr = 0; tr < header._dqz.n_streamlines; tr++) { const n = dv.getUint32(off, true); pts += n; off += 4 + (n ? 16 + (n - 1) * 3 : 0); }
    return { points: pts, streamlines: header._dqz.n_streamlines, exact: true };
  }
  if (ext === '.tt') {
    const mats = readMat4(await maybeGunzip(file));
    if (!mats.track) throw 'no "track" matrix in this .tt file';
    const t = mats.track.bytes, dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    let o = 0, n = 0, pts = 0;
    while (o + 16 <= t.length) { const c = dv.getUint32(o, true); pts += c / 3; n++; o += 16 + c - 3; }
    return { points: pts, streamlines: n, exact: true };
  }
  return { points: 0, streamlines: null, exact: false };
}

/**
 * A parsed .dqz data file (parseDqzChild) cut down to every n-th
 * streamline — to go with a parent read thinned.
 */
export function thinDqzChild(parsed, every) {
  if (every <= 1) return parsed;
  const n = parsed.header.n_streamlines, keep = [];
  for (let i = 0; i < n; i += every) keep.push(i);
  const header = { ...parsed.header, n_streamlines: keep.length };
  const Arr = parsed.codes.constructor;
  if (parsed.scope === 'per_streamline') {
    const codes = Arr.from(keep, i => parsed.codes[i]);
    const values = parsed.values === parsed.codes ? codes : Float32Array.from(keep, i => parsed.values[i]);
    return { ...parsed, header, codes, values };
  }
  const pointCounts = new Uint32Array(keep.length), offsets = new Uint32Array(keep.length + 1);
  let total = 0;
  keep.forEach((i, k) => { pointCounts[k] = parsed.pointCounts[i]; offsets[k] = total; total += pointCounts[k]; });
  offsets[keep.length] = total;
  const codes = new Arr(total);
  const values = parsed.values === parsed.codes ? codes : new Float32Array(total);
  keep.forEach((i, k) => {
    const a = parsed.offsets[i], b = parsed.offsets[i + 1];
    codes.set(parsed.codes.subarray(a, b), offsets[k]);
    if (values !== codes) values.set(parsed.values.subarray(a, b), offsets[k]);
  });
  return { ...parsed, header, codes, values, pointCounts, offsets };
}


// -- .tt / .tt.gz parser (DSI Studio) ------------------------------
// A DSI Studio tract file: a MATLAB v4 container (usually gzipped) of
// named matrices. The ones read here:
//   dimension    int32[3]   the grid the tracts were made on
//   voxel_size   float[3]   mm
//   trans_to_mni float[16]  row-major 4×4, voxel → template (MNI) RAS mm
//   report       uint8[]    DSI Studio's methods paragraph
//   track        uint8[]    the streamlines, back to back:
//       uint32  c          number of coordinate values (3 × points)
//       int32×3            the first point
//       int8×(c−3)         every next point as a step from the one before
//     all in 1/32 voxel.
// Other matrices (parameter_id, cluster, color …) are kept in the header
// when they are small, otherwise ignored.

/** Inflate if gzipped (magic 1f 8b); a Uint8Array either way. */
async function maybeGunzip(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return new Uint8Array(await file.arrayBuffer());
  const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The named matrices of a MATLAB v4 file: name → { type, rows, cols, bytes }. */
export function readMat4(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = {};
  let o = 0;
  while (o + 20 <= u8.length) {
    const type = dv.getInt32(o, true), rows = dv.getInt32(o + 4, true), cols = dv.getInt32(o + 8, true),
          imag = dv.getInt32(o + 12, true), nl = dv.getInt32(o + 16, true);
    if (type < 0 || type > 9999 || rows < 0 || cols < 0 || nl <= 0 || nl > 256)
      throw o ? 'damaged .tt file (at byte ' + o + ')' : 'not a DSI Studio .tt file';
    if (Math.floor(type / 1000) !== 0) throw 'a big-endian .tt file (not supported)';
    o += 20;
    const name = new TextDecoder().decode(u8.subarray(o, o + nl - 1)); o += nl;
    const P = Math.floor(type / 10) % 10, size = [8, 4, 4, 2, 2, 1][P];
    if (!size) throw '.tt matrix "' + name + '" has an unknown type ' + type;
    const n = rows * cols * size * (imag ? 2 : 1);
    if (o + n > u8.length) throw '.tt file ends early (in "' + name + '")';
    out[name] = { P, rows, cols, bytes: u8.subarray(o, o + n) };
    o += n;
  }
  return out;
}

function mat4Values(m) {
  const b = m.bytes, n = m.rows * m.cols;
  const T = [Float64Array, Float32Array, Int32Array, Int16Array, Uint16Array, Uint8Array][m.P];
  const a = new T(n);
  new Uint8Array(a.buffer).set(b.subarray(0, n * T.BYTES_PER_ELEMENT));
  return Array.from(a);
}

/**
 * Parse a DSI Studio .tt / .tt.gz file into streamlines in RAS mm (through
 * its trans_to_mni; without one, voxel × voxel_size).
 * @param {File|Blob} file
 * @param {number} [maxNumTracts=0] - at most this many, 0 for all
 * @param {number} [every=1] - keep every n-th streamline
 */
export async function parseTt(file, maxNumTracts = 0, every = 1) {
  const mats = readMat4(await maybeGunzip(file));
  if (!mats.track) throw 'no "track" matrix in this .tt file';
  const header = { format: 'DSI Studio .tt' };
  for (const [name, m] of Object.entries(mats)) {
    if (name === 'track') continue;
    if (name === 'report' && m.P === 5) header.report = new TextDecoder().decode(m.bytes).replace(/\0+$/, '').trim();
    else if (m.rows * m.cols <= 64) { const v = mat4Values(m); header[name] = v.length === 1 ? v[0] : v; }
  }
  const vs = Array.isArray(header.voxel_size) ? header.voxel_size : [1, 1, 1];
  const T = Array.isArray(header.trans_to_mni) && header.trans_to_mni.length === 16 ? header.trans_to_mni : null;
  // voxel → RAS rows (with the 1/32 already folded in)
  const k = 1 / 32;
  const R = T ? [0, 1, 2].map(r => [T[4 * r] * k, T[4 * r + 1] * k, T[4 * r + 2] * k, T[4 * r + 3]])
              : [[vs[0] * k, 0, 0, 0], [0, vs[1] * k, 0, 0], [0, 0, vs[2] * k, 0]];
  if (!T) header.space = 'voxel × voxel_size (no trans_to_mni in the file)';

  const t = mats.track.bytes, dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  // pass 1: the records (and the points) that are kept
  const offs = [], counts = [];
  let o = 0, seen = 0, total = 0;
  while (o + 16 <= t.length) {
    const c = dv.getUint32(o, true);
    if (c < 3 || c % 3 || o + 16 + c - 3 > t.length) throw 'damaged .tt track data (streamline ' + seen + ')';
    if (seen % every === 0 && !(maxNumTracts && offs.length >= maxNumTracts)) { offs.push(o); counts.push(c / 3); total += c / 3; }
    o += 16 + c - 3; seen++;
  }
  header.count = seen;
  header.streamlines_read = offs.length;
  // pass 2: decode
  const data = new Float32Array(total * 3), lookup = new Int32Array(total), streamlines = new Array(offs.length);
  let p = 0;
  for (let s = 0; s < offs.length; s++) {
    let q = offs[s] + 4;
    let x = dv.getInt32(q, true), y = dv.getInt32(q + 4, true), z = dv.getInt32(q + 8, true);
    q += 12;
    const n = counts[s], start = p;
    for (let i = 0; i < n; i++) {
      if (i) { x += dv.getInt8(q); y += dv.getInt8(q + 1); z += dv.getInt8(q + 2); q += 3; }
      data[p++] = R[0][0] * x + R[0][1] * y + R[0][2] * z + R[0][3];
      data[p++] = R[1][0] * x + R[1][1] * y + R[1][2] * z + R[1][3];
      data[p++] = R[2][0] * x + R[2][1] * y + R[2][2] * z + R[2][3];
    }
    lookup.fill(s, start / 3, p / 3);
    streamlines[s] = data.subarray(start, p);
  }
  return { header, streamlines, streamlineLookup: lookup, total: seen };
}


// -- .dqz child data files (DQZDATA1) ------------------------------
// One named per-vertex or per-streamline field belonging to a parent
// .dqz geometry file, referenced by the parent's uuid — see the
// "Per-vertex and per-streamline data files" section of dqz-format.md.
// A child shares the .dqz extension with geometry files, so the ONLY
// reliable way to tell them apart is the magic: sniffDqzKind() below
// reads just the first 8 bytes (no full-file read) for that purpose.

export const DQZ_CHILD_MAGIC = 'DQZDATA1';

// maxCode is set only for the dtypes allowed with kind "scaled" (the
// spec restricts scaled to unsigned integers).
const DQZ_DTYPES = {
  uint8:   { size: 1, Arr: Uint8Array,   get: 'getUint8',   maxCode: 255 },
  int8:    { size: 1, Arr: Int8Array,    get: 'getInt8',    maxCode: null },
  uint16:  { size: 2, Arr: Uint16Array,  get: 'getUint16',  maxCode: 65535 },
  int16:   { size: 2, Arr: Int16Array,   get: 'getInt16',   maxCode: null },
  float32: { size: 4, Arr: Float32Array, get: 'getFloat32', maxCode: null },
};
const DQZ_KINDS  = ['raw', 'scaled', 'categorical'];
const DQZ_SCOPES = ['per_vertex', 'per_streamline'];

/**
 * Cheap magic-byte sniff of a .dqz-extension File.
 * @param {File|Blob} file
 * @returns {Promise<'geometry'|'child'|null>} null = neither magic.
 */
export async function sniffDqzKind(file) {
  if (file.size < 12) return null;
  const magic = String.fromCharCode(...new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  if (magic === DQZ_MAGIC) return 'geometry';
  if (magic === DQZ_CHILD_MAGIC) return 'child';
  return null;
}

/**
 * Reads just the JSON header of a .dqz child file (magic + length +
 * header bytes only — never the data records), validated for shape.
 * Throws a short user-facing string on anything malformed.
 * @param {File|Blob|ArrayBuffer} src
 * @returns {Promise<Object>} the header, plus _dataOffset
 */
export async function readDqzChildHeader(src) {
  const head = src instanceof ArrayBuffer ? src : await src.slice(0, 12).arrayBuffer();
  const magic = String.fromCharCode(...new Uint8Array(head, 0, 8));
  if (magic !== DQZ_CHILD_MAGIC) throw 'Not a .dqz data file (bad magic)';
  const headerLen = new DataView(head).getUint32(8, true);
  const hbuf = src instanceof ArrayBuffer
    ? new Uint8Array(src, 12, headerLen)
    : new Uint8Array(await src.slice(12, 12 + headerLen).arrayBuffer());
  let h;
  try { h = JSON.parse(new TextDecoder('utf-8').decode(hbuf)); }
  catch (e) {
    // By far the likeliest cause: the header was edited in a text editor
    // and its length changed, but the 4-byte length before it didn't, so
    // the JSON is cut off early or runs into the binary data.
    throw `header is not valid JSON (${e.message || e}). The file records a ${headerLen}-byte header; ` +
          'if it was edited in a text editor and its length changed, that no longer matches. ' +
          'Edit headers with tools/dqz_header.py instead.';
  }

  if (typeof h.parent === 'number') h.parent = String(h.parent);
  if (typeof h.parent !== 'string' || !h.parent) throw '.dqz data file has no "parent" uuid (required)';
  if (!Number.isInteger(h.n_streamlines) || h.n_streamlines < 0) throw '.dqz data file has no valid "n_streamlines"';
  if (!DQZ_DTYPES[h.dtype]) throw `.dqz data file has unsupported dtype "${h.dtype}"`;
  if (!DQZ_KINDS.includes(h.kind)) throw `.dqz data file has unsupported kind "${h.kind}"`;
  if (!DQZ_SCOPES.includes(h.scope)) throw `.dqz data file has unsupported scope "${h.scope}"`;
  if (h.kind === 'scaled') {
    if (DQZ_DTYPES[h.dtype].maxCode === null)
      throw `.dqz data file is kind "scaled" with dtype "${h.dtype}" (scaled requires uint8 or uint16)`;
    if (!(Number.isFinite(h.value_min) && Number.isFinite(h.value_max)))
      throw '.dqz data file is kind "scaled" but lacks numeric value_min/value_max';
  }

  h._dataOffset = 12 + headerLen;
  return h;
}

/**
 * Parse a full .dqz child data file.
 * @param {File} file
 * @returns {Promise<{header: Object, scope: string, values: TypedArray,
 *   codes: TypedArray, pointCounts: Uint32Array|null,
 *   offsets: Uint32Array|null}>}
 *   values — decoded values: Float32Array for kind "scaled" (the linear
 *     transform already applied), otherwise the stored array itself
 *     (same object as `codes`) — categorical codes stay integers.
 *   codes — the raw stored values, in the file's dtype.
 *   per_vertex: values is one flat array over all vertices, streamline
 *     i's values at [offsets[i], offsets[i] + pointCounts[i]) — the same
 *     order and count as the parent's own points, once
 *     checkDqzChildAgainst has passed.
 *   per_streamline: values[i] belongs to streamline i; pointCounts and
 *     offsets are null.
 */
export async function parseDqzChild(file) {
  const buf = await file.arrayBuffer();
  const header = await readDqzChildHeader(buf);
  const { n_streamlines: n, scope, kind } = header;
  const dt = DQZ_DTYPES[header.dtype];
  const dv = new DataView(buf);
  const start = header._dataOffset;

  let codes, pointCounts = null, offsets = null;

  if (scope === 'per_streamline') {
    const need = n * dt.size;
    if (buf.byteLength - start < need)
      throw `.dqz data file is truncated (${buf.byteLength - start} bytes of data, ${need} expected)`;
    codes = new dt.Arr(n);
    for (let i = 0; i < n; i++) codes[i] = dv[dt.get](start + i * dt.size, true);
  } else {
    // per_vertex — first pass: record framing only, to size one flat array.
    pointCounts = new Uint32Array(n);
    offsets = new Uint32Array(n + 1);
    const recStart = new Array(n);
    let off = start, total = 0;
    for (let i = 0; i < n; i++) {
      if (off + 4 > buf.byteLength) throw `.dqz data file is truncated at streamline ${i}`;
      const np = dv.getUint32(off, true);
      off += 4;
      recStart[i] = off;
      pointCounts[i] = np;
      offsets[i] = total;
      total += np;
      off += np * dt.size;
      if (off > buf.byteLength) throw `.dqz data file is truncated at streamline ${i}`;
    }
    offsets[n] = total;
    codes = new dt.Arr(total);
    let p = 0;
    for (let i = 0; i < n; i++) {
      let o = recStart[i];
      for (let k = 0; k < pointCounts[i]; k++, o += dt.size) codes[p++] = dv[dt.get](o, true);
    }
  }

  let values = codes;
  if (kind === 'scaled') {
    // value = value_min + (code / max_code) * (value_max - value_min);
    // unsigned dtypes only (enforced in readDqzChildHeader).
    const vmin = header.value_min, span = header.value_max - header.value_min;
    values = new Float32Array(codes.length);
    for (let i = 0; i < codes.length; i++) values[i] = vmin + (codes[i] / dt.maxCode) * span;
  }

  return { header, scope, values, codes, pointCounts, offsets };
}

/**
 * Checks a parsed child against the parent geometry it claims to belong
 * to. Returns null if consistent, or a short reason string if not.
 * @param {Object} parsed - parseDqzChild() result
 * @param {Float32Array[]} parentStreamlines - the parent file's own
 *   streamlines, in file order (flat xyz per streamline)
 */
export function checkDqzChildAgainst(parsed, parentStreamlines) {
  const n = parsed.header.n_streamlines;
  if (n !== parentStreamlines.length)
    return `n_streamlines ${n} ≠ parent's ${parentStreamlines.length}`;
  if (parsed.scope === 'per_vertex') {
    for (let i = 0; i < n; i++) {
      const np = parsed.pointCounts[i];
      const want = parentStreamlines[i].length / 3;
      if (np !== want)
        return `streamline ${i}: ${np} values but parent has ${want} points`;
    }
  }
  return null;
}


/**
 * @file TrackVis .trk file parser
 * @author Rembrandt Bakker
 */

/*
 * Source: https://trackvis.org/docs/?subsect=fileformat
 *
 * Trackvis header
Name	Data type	Bytes	Comment
id_string[6]	char	6	ID string for track file. The first 5 characters must be "TRACK".
dim[3]	short int	6	Dimension of the image volume.
voxel_size[3]	float	12	Voxel size of the image volume.
origin[3]	float	12	Origin of the image volume. This field is not yet being used by TrackVis. That means the origin is always (0, 0, 0).
n_scalars	short int	2	Number of scalars saved at each track point (besides x, y and z coordinates).
scalar_name[10][20]	char	200	Name of each scalar. Can not be longer than 20 characters each. Can only store up to 10 names.
n_properties	short int	2	Number of properties saved at each track.
property_name[10][20]	char	200	Name of each property. Can not be longer than 20 characters each. Can only store up to 10 names.
vox_to_ras[4][4]	float	64	4x4 matrix for voxel to RAS (crs to xyz) transformation. If vox_to_ras[3][3] is 0, it means the matrix is not recorded. This field is added from version 2.
reserved[444]	char	444	Reserved space for future version.
voxel_order[4]	char	4	Storing order of the original image data. Explained here.
pad2[4]	char	4	Paddings.
image_orientation_patient[6]	float	24	Image orientation of the original image. As defined in the DICOM header.
pad1[2]	char	2	Paddings.
invert_x	unsigned char	1	Inversion/rotation flags used to generate this track file. For internal use only.
invert_y	unsigned char	1	As above.
invert_x	unsigned char	1	As above.
swap_xy	unsigned char	1	As above.
swap_yz	unsigned char	1	As above.
swap_zx	unsigned char	1	As above.
n_count	int	4	Number of tracks stored in this track file. 0 means the number was NOT stored.
version	int	4	Version number. Current version is 2.
hdr_size	int	4	Size of the header. Used to determine byte swap. Should be 1000.
 *
 */


/** 
* Parse the binary header of a TrackVis .trk file.
* @param {ArrayBuffer} fileAsArrayBuffer - File contents as a byte array buffer
* @return {Object} File header as a set of key-value pairs
*/
export function parseTrkHeader(fileAsArrayBuffer, LE = null) {
    // No header field gives the byte order; hdr_size (the last field) must
    // read 1000 — if it doesn't, the file was written in the other order.
    if (LE === null) {
        const dv0 = new DataView(fileAsArrayBuffer);
        LE = dv0.getInt32(996, true) === 1000 ? true : dv0.getInt32(996, false) === 1000 ? false : sysLE();
    }
    let header = {}
    let byteOffset = 0;
    const view = new DataView(fileAsArrayBuffer);
    header.little_endian = LE;
    // id_string[6]	char	6	ID string for track file. The first 5 characters must be "TRACK".
    let v;
    v = String.fromCharCode(...(new Uint8Array(fileAsArrayBuffer,byteOffset,5)));
    if (v != 'TRACK') throw('Not a trackvis file, must start with characters TRACK');
    header.id_code = view.getUint8(byteOffset+5);
    byteOffset += 6;
    // dim[3]	short int	6	Dimension of the image volume.
    v = [];
    for (let i=0; i<3; i++) {
        v.push(view.getUint16(byteOffset,LE));
        byteOffset += 2;
    }
    header.dim = v;
    // voxel_size[3]	float	12	Voxel size of the image volume.
    v = [];
    for (let i=0; i<3; i++) {
        v.push(view.getFloat32(byteOffset,LE));
        byteOffset += 4;
    }
    header.voxel_size = v;
    // origin[3]	float	12	Origin of the image volume. This field is not yet being used by TrackVis. That means the origin is always (0, 0, 0).
    v = [];
    for (let i=0; i<3; i++) {
        v.push(view.getFloat32(byteOffset,LE));
        byteOffset += 4;
    }
    header.origin = v;
    // n_scalars	short int	2	Number of scalars saved at each track point (besides x, y and z coordinates).
    v = view.getUint16(byteOffset,LE)
    byteOffset += 2;
    header.n_scalars = v;
    // scalar_name[10][20]	char	200	Name of each scalar. Can not be longer than 20 characters each. Can only store up to 10 names.
    v = []
    for (let i=0; i<10; i++) {
        let chars = new Uint8Array(fileAsArrayBuffer,byteOffset,20);
        byteOffset += 20
        for (let j=0; j<20; j++) {
            if (chars[j]==0) {
                chars = chars.slice(0,j)
                break;
            }
        }
        v.push( String.fromCharCode(...chars) );
    }
    header.scalar_name = v
    // n_properties	short int	2	Number of properties saved at each track.
    v = view.getUint16(byteOffset,LE);
    byteOffset += 2;
    header.n_properties = v;
    // property_name[10][20]	char	200	Name of each property. Can not be longer than 20 characters each. Can only store up to 10 names.
    v = [];
    for (let i=0; i<10; i++) {
        let chars = new Uint8Array(fileAsArrayBuffer,byteOffset,20);
        byteOffset += 20
        for (let j=0; j<20; j++) {
            if (chars[j]==0) {
                chars = chars.slice(0,j);
                break;
            }
        }
        v.push( String.fromCharCode(...chars) );
    }
    header.property_name = v
    // vox_to_ras[4][4]	float	64	4x4 matrix for voxel to RAS (crs to xyz) transformation. If vox_to_ras[3][3] is 0, it means the matrix is not recorded. This field is added from version 2.
    v = [];
    for (let i=0; i<4; i++) {
        let row = []
        for (let j=0; j<4; j++) {
            row.push( view.getFloat32(byteOffset,LE) );
            byteOffset += 4
        }
        v.push(row);
    }
    header.vox_to_ras = v;
    // reserved[444]	char	444	Reserved space for future version.
    byteOffset += 444
    // voxel_order[4]	char	4	Storing order of the original image data. Explained here.
    v = new Uint8Array(fileAsArrayBuffer,byteOffset,4);
    header.voxel_order = v;
    byteOffset += 4;
    // pad2[4]	char	4	Paddings.
    v = new Uint8Array(fileAsArrayBuffer,byteOffset,4)
    byteOffset += 4;
    header.pad2 = v;
    // image_orientation_patient[6]	float	24	Image orientation of the original image. As defined in the DICOM header.
    v = [];
    for (let i=0; i<6; i++) {
        v.push( view.getFloat32(byteOffset,LE) );
        byteOffset += 4;
    }
    header.image_orientation_patient = v;
    // pad1[2]	char	2	Paddings.
    v = new Uint8Array(fileAsArrayBuffer,byteOffset,2);
    byteOffset += 2;
    header.pad1 = v;
    // invert_x	unsigned char	1	Inversion/rotation flags used to generate this track file. For internal use only.
    v = view.getUint8(byteOffset);
    byteOffset += 1;
    header.invert_x = v;
    // invert_y	unsigned char	1	As above.
    v = view.getUint8(byteOffset);
    byteOffset += 1;
    header.invert_y = v;
    // invert_x	unsigned char	1	As above.
    v = view.getUint8(byteOffset);
    byteOffset += 1;
    header.invert_x = v;
    // swap_xy	unsigned char	1	As above.
    v = view.getUint8(byteOffset);
    byteOffset += 1;
    header.swap_xy = v;
    // swap_yz	unsigned char	1	As above.
    v = view.getUint8(byteOffset);
    byteOffset += 1;
    header.swap_yz = v;
    // swap_zx	unsigned char	1	As above.
    v = view.getUint8(byteOffset);
    byteOffset += 1;
    header.swap_zx = v;
    // n_count	int	4	Number of tracks stored in this track file. 0 means the number was NOT stored.
    v = view.getUint32(byteOffset,LE);
    byteOffset += 4;
    header.n_count = v;
    // version	int	4	Version number. Current version is 2.
    v = view.getUint32(byteOffset,LE);
    byteOffset += 4;
    header.version = v;
    // hdr_size	int	4	Size of the header. Used to determine byte swap. Should be 1000.
    v = view.getUint32(byteOffset,LE);
    byteOffset += 4;
    header.hdr_size = v;
    
    return header;
}


// TrackVis .trk point coordinates are always "voxmm" (the format fixes
// it; no header field chooses): millimetres along the voxel axes, from
// the CORNER of the first voxel — voxel (i,j,k)'s centre is at
// ((i+½)·vx, (j+½)·vy, (k+½)·vz). The header's vox_to_ras (version 2)
// maps voxel indices (centres) to RAS mm, so
//     RAS = vox_to_ras · (p / voxel_size − ½)
// (as nibabel reads it). Without vox_to_ras (version 1, or [3][3] = 0)
// the voxel sizes and voxel_order are all there is: an axis-aligned
// matrix, no origin.
export function trkVoxmmToRas(header) {
  const vs = header.voxel_size.map(v => v || 1);
  let M = header.vox_to_ras;
  if (!M || !M[3] || M[3][3] === 0) {
    const order = String.fromCharCode(...(header.voxel_order || [])).toUpperCase();
    M = [[vs[0], 0, 0, 0], [0, vs[1], 0, 0], [0, 0, vs[2], 0]];
    // L, P or I in voxel_order: that axis runs against RAS
    for (let a = 0; a < 3; a++) if ('LPI'.includes(order[a])) { const row = 'LR'.includes(order[a]) ? 0 : 'PA'.includes(order[a]) ? 1 : 2; M[a][a] = 0; M[row][a] = -vs[a]; }
    console.warn('.trk without vox_to_ras: voxel order "' + order + '", no origin');
  }
  // rows of RAS = A·(p/vs − ½) + t
  return [0, 1, 2].map(r => {
    const A = [M[r][0] / vs[0], M[r][1] / vs[1], M[r][2] / vs[2]];
    return [A[0], A[1], A[2], M[r][3] - 0.5 * (M[r][0] + M[r][1] + M[r][2])];
  });
}

/**
 * The orientation letters of a vox_to_ras matrix ("RAS", "LPS", …), or null.
 */
export function axcodesOf(M) {
  if (!M || !M[3] || M[3][3] === 0) return null;
  let out = '';
  for (let c = 0; c < 3; c++) {
    let r = 0; for (let k = 1; k < 3; k++) if (Math.abs(M[k][c]) > Math.abs(M[r][c])) r = k;
    out += (M[r][c] >= 0 ? 'RAS' : 'LPI')[r];
  }
  return out;
}
/**
 * A .trk header whose voxel_order disagrees with its vox_to_ras: which one
 * the points follow is up to the program that wrote it (DSI Studio's are
 * consistent; others are not always), so it is only noted — the points are
 * placed by vox_to_ras. Returns the note, or null.
 */
export function trkOrientationNote(header) {
  const m = axcodesOf(header.vox_to_ras);
  const order = String.fromCharCode(...(header.voxel_order || [])).replace(/\0.*$/, '').toUpperCase();
  if (!m || !/^[LRAPSI]{3}$/.test(order) || order === m) return null;
  return `voxel_order says ${order} but vox_to_ras is ${m}; placed by vox_to_ras. If the streamlines look mirrored, use the mirror buttons in this header.`;
}

/**
* Parse a TrackVis .trk file: header and streamlines (in RAS mm).
* Read in chunks (file.slice), so a file larger than one ArrayBuffer
* can be read as long as its points fit in memory. n_count 0 ("not
* stored"): read to the end. A file that ends early keeps what it has
* (header.truncated: the number the header promised).
* @param {File|Blob} file
* @param {number} [maxNumTracts=0] - Maximum number of tracts to extract, 0 to extract all.
* @param {number} [every=1] - keep every n-th streamline (a subsample of a huge file)
*/
export async function parseTrk(file, maxNumTracts = 0, every = 1) {
  const header = parseTrkHeader(await file.slice(0, 1000).arrayBuffer());
  const LE = header.little_endian;
  if (header.hdr_size !== 1000) throw '.trk header size is ' + header.hdr_size + ', not 1000';
  const ns = header.n_scalars, np = header.n_properties, fpp = 3 + ns;
  const [r0, r1, r2] = trkVoxmmToRas(header);
  const size = file.size, CHUNK = 64 << 20;
  const promised = header.n_count;
  const limit = maxNumTracts ? (promised ? Math.min(promised, maxNumTracts) : maxNumTracts) : promised || Infinity;

  // a window on the file: bytes [winStart, winStart + win.length)
  let win = new Uint8Array(0), winStart = 1000, readTo = 1000;
  const ensure = async (pos, n) => {
    while (pos + n > winStart + win.length && readTo < size) {
      const more = new Uint8Array(await file.slice(readTo, Math.min(size, readTo + Math.max(CHUNK, n))).arrayBuffer());
      const keep = win.subarray(pos - winStart);
      const next = new Uint8Array(keep.length + more.length);
      next.set(keep); next.set(more, keep.length);
      win = next; winStart = pos; readTo += more.length;
    }
    return pos + n <= winStart + win.length;
  };

  // the points buffer sized from the file once (an upper bound: the file's
  // bytes as points, per-streamline counts included), grown by half when
  // the guess falls short — not by doubling, which for a file of billions
  // of points would ask for twice the memory (and a copy on top)
  const bound = Math.max(0, (size - 1000) / (4 * fpp));
  let pts = new Float32Array(Math.max(1 << 16, Math.ceil(3 * (every > 1 ? bound / every * 1.1 : bound)))), p = 0;
  const counts = [];
  let pos = 1000, seen = 0;
  while (seen < limit) {
    if (!(await ensure(pos, 4))) break;                       // the end
    const dv = new DataView(win.buffer, win.byteOffset);
    const n = dv.getUint32(pos - winStart, LE);
    const need = 4 + n * fpp * 4 + np * 4;
    if (!(await ensure(pos, need))) { header.truncated = promised || seen + 1; break; }   // ends inside a streamline
    if (seen % every === 0) {
      if (p + 3 * n > pts.length) { let L = pts.length; while (L < p + 3 * n) L = Math.ceil(L * 1.5); const g = new Float32Array(L); g.set(pts.subarray(0, p)); pts = g; }
      const d = new DataView(win.buffer, win.byteOffset + (pos - winStart) + 4);
      for (let i = 0; i < n; i++) {
        const o = 4 * i * fpp;
        const x = d.getFloat32(o, LE), y = d.getFloat32(o + 4, LE), z = d.getFloat32(o + 8, LE);
        pts[p++] = r0[0] * x + r0[1] * y + r0[2] * z + r0[3];
        pts[p++] = r1[0] * x + r1[1] * y + r1[2] * z + r1[3];
        pts[p++] = r2[0] * x + r2[1] * y + r2[2] * z + r2[3];
      }
      counts.push(n);
    }
    pos += need; seen++;
  }
  if (promised && seen < Math.min(promised, maxNumTracts || Infinity) && !header.truncated) header.truncated = promised;
  if (header.truncated) console.warn('.trk: the file ends after ' + seen + ' of ' + header.truncated + ' streamlines');
  header.streamlines_read = seen;
  const note = trkOrientationNote(header);
  if (note) header.orientation_note = note;

  // streamline views + point → streamline lookup (as TCK)
  const dataArray = pts.subarray(0, p);
  const lookup = new Int32Array(p / 3);
  const streamlines = new Array(counts.length);
  let base = 0;
  for (let tr = 0; tr < counts.length; tr++) {
    const n = counts[tr];
    lookup.fill(tr, base, base + n);
    streamlines[tr] = new Float32Array(dataArray.buffer, dataArray.byteOffset + base * 12, n * 3);
    base += n;
  }
  return { header, streamlines, streamlineLookup: lookup, total: seen };
}


/**
 * Convert a TrackVis .trk header into a minimal, valid MRtrix .tck header.
 *
 * @param {Object} trkHeader - Header object parsed from a .trk file.
 * @returns {Object} A new .tck‑style header dictionary.
 */
export function ensureTckHeader(header) {
  if (!header.vox_to_ras && header.file) return header;

  const vox = header.vox_to_ras;

  const msg = vox ? 'Converted from .trk header with vox_to_ras ' + JSON.stringify(vox)
                  : 'Converted from ' + (header.format || 'another format') + (header.trans_to_mni ? ' with trans_to_mni ' + JSON.stringify(header.trans_to_mni) : '');

  return {
    datatype: 'Float32LE',
    count: 0,          // writeTck will overwrite this
    total_count: 0,    // writeTck will overwrite this
    file: '. 0',       // placeholder, writeTck fixes it
    command_history: [msg]
  };
}


/**
 * Write streamlines + header into a valid .tck file.
 * @param {Array<Float32Array>} streamlines
 * @param {Object} header
 * @param {string} commandLine
 * @returns {ArrayBuffer}
 */
export function writeTck(streamlines, header, commandLine) {
  const n = streamlines.length;
  header = structuredClone(header);

  // Build float payload with NaN separators
  let nFloats = 0;
  for (const t of streamlines) nFloats += t.length + 3;

  const data = new Float32Array(nFloats);
  let off = 0;

  for (const t of streamlines) {
    for (let i = 0; i < t.length; i++) data[off++] = t[i];
    data[off++] = NaN; data[off++] = NaN; data[off++] = NaN;
  }

  const enc = new TextEncoder();
  if (!header.command_history) header.command_history = [];
  header.command_history.push(commandLine);

  header.count = n;
  header.total_count = n;
  header.file = '. 0000000000';

  const placeholder = headerToRaw(header);
  const dataOffset = Math.ceil(enc.encode(placeholder).byteLength / 4) * 4;
  header.file = `. ${dataOffset}`;

  const fullHeader = headerToRaw(header);
  const headerBytes = enc.encode(fullHeader);

  if (headerBytes.byteLength > dataOffset)
    throw 'writeTck: header overflowed estimated offset.';

  const out = new ArrayBuffer(dataOffset + data.byteLength);
  new Uint8Array(out).set(headerBytes, 0);
  new Float32Array(out, dataOffset).set(data);

  return out;
}


/**
 * If header is not already in .trk format, convert an MRtrix .tck header
 * into a minimal TrackVis .trk header. If a NIfTI header is provided,
 * use its dimensions, voxel sizes and affine to populate the .trk fields.
 *
 * @param {Object} header - Header object in either .trk or .tck format.
 * @param {Object} niiHeader - Header of reference NIfTI file (optional).
 * @returns {Object} A .trk‑style header dictionary.
 */
export function ensureTrkHeader(header, niiHeader) {
  // Already a .trk header → return as-is
  if (header.vox_to_ras && !header.file) return header;

  // Build vox_to_ras from NIfTI affine if available
  let vox_to_ras;
  if (niiHeader?.affine_A && niiHeader?.affine_translation) {
    vox_to_ras = [
      [...niiHeader.affine.A[0], niiHeader.affine.b[0]],
      [...niiHeader.affine.A[1], niiHeader.affine.b[1]],
      [...niiHeader.affine.A[2], niiHeader.affine.b[2]],
      [0, 0, 0, 1]
    ];
  } else {
    // Fallback: identity
    vox_to_ras = [
      [1,0,0,0],
      [0,1,0,0],
      [0,0,1,0],
      [0,0,0,1]
    ];
  }

  // Dimensions and voxel sizes from NIfTI if available
  const dim = niiHeader?.dimensions
    ? [niiHeader.dimensions.nx, niiHeader.dimensions.ny, niiHeader.dimensions.nz]
    : [0,0,0];

  const voxel_size = niiHeader?.voxel_size
    ? [...niiHeader.pixdim_mm]
    : [1,1,1];

  return {
    id_string: "TRACK",
    id_code: 0,

    dim,
    voxel_size,
    origin: [0,0,0],   // NIfTI origin is not directly compatible with .trk

    n_scalars: 0,
    scalar_name: Array(10).fill(""),

    n_properties: 0,
    property_name: Array(10).fill(""),

    vox_to_ras,

    voxel_order: new Uint8Array(4),
    pad2: new Uint8Array(4),
    image_orientation_patient: [1,0,0,0,1,0],
    pad1: new Uint8Array(2),

    // invert_x, invert_y, invert_z, swap_xy, swap_yz, swap_zx
    // intentionally omitted — writeTrk() defaults them to 0.

    n_count: 0,
    version: 2,
    hdr_size: 1000,

    little_endian: true
  };
}


/**
 * Write streamlines + header into a valid TrackVis .trk file.
 * Assumes the header is already a valid .trk header dictionary
 * as produced by parseHeader().
 *
 * Streamlines must be provided as Array<Float32Array>, where each
 * streamline is a flat array [x0,y0,z0, x1,y1,z1, ...] in voxel space.
 *
 * @param {Array<Float32Array>} streamlines - Streamlines in voxel CRS.
 * @param {Object} header - A valid TrackVis .trk header.
 * @returns {ArrayBuffer} A complete .trk file buffer.
 */
export function writeTrk(streamlines, header) {
  const LE = header.little_endian;
  const numScalars = header.n_scalars;
  const numProperties = header.n_properties;

  // --- 1. Clone header so we can modify fields safely ---
  header = structuredClone(header);

  // TrackVis requires n_count to be set
  header.n_count = streamlines.length;

  // --- 2. Build the 1000‑byte header block ---
  const headerBuf = new ArrayBuffer(1000);
  const dv = new DataView(headerBuf);
  let off = 0;

  // id_string[6]
  const id = "TRACK";
  for (let i = 0; i < 5; i++) dv.setUint8(off++, id.charCodeAt(i));
  dv.setUint8(off++, header.id_code || 0);

  // dim[3]
  for (let i = 0; i < 3; i++) dv.setUint16(off, header.dim[i], LE), off += 2;

  // voxel_size[3]
  for (let i = 0; i < 3; i++) dv.setFloat32(off, header.voxel_size[i], LE), off += 4;

  // origin[3]
  for (let i = 0; i < 3; i++) dv.setFloat32(off, header.origin[i], LE), off += 4;

  // n_scalars
  dv.setUint16(off, numScalars, LE); off += 2;

  // scalar_name[10][20]
  for (let i = 0; i < 10; i++) {
    const name = header.scalar_name[i] || "";
    for (let j = 0; j < 20; j++) {
      dv.setUint8(off++, name.charCodeAt(j) || 0);
    }
  }

  // n_properties
  dv.setUint16(off, numProperties, LE); off += 2;

  // property_name[10][20]
  for (let i = 0; i < 10; i++) {
    const name = header.property_name[i] || "";
    for (let j = 0; j < 20; j++) {
      dv.setUint8(off++, name.charCodeAt(j) || 0);
    }
  }

  // vox_to_ras[4][4]
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      dv.setFloat32(off, header.vox_to_ras[r][c], LE);
      off += 4;
    }
  }

  // reserved[444]
  off += 444;

  // voxel_order[4]
  for (let i = 0; i < 4; i++) dv.setUint8(off++, header.voxel_order[i] || 0);

  // pad2[4]
  for (let i = 0; i < 4; i++) dv.setUint8(off++, header.pad2[i] || 0);

  // image_orientation_patient[6]
  for (let i = 0; i < 6; i++) {
    dv.setFloat32(off, header.image_orientation_patient[i], LE);
    off += 4;
  }

  // pad1[2]
  for (let i = 0; i < 2; i++) dv.setUint8(off++, header.pad1[i] || 0);

  // invert_x, invert_y, invert_z
  dv.setUint8(off++, header.invert_x || 0);
  dv.setUint8(off++, header.invert_y || 0);
  dv.setUint8(off++, header.invert_x || 0); // yes, spec repeats invert_x

  // swap_xy, swap_yz, swap_zx
  dv.setUint8(off++, header.swap_xy || 0);
  dv.setUint8(off++, header.swap_yz || 0);
  dv.setUint8(off++, header.swap_zx || 0);

  // n_count
  dv.setUint32(off, header.n_count, LE); off += 4;

  // version
  dv.setUint32(off, header.version || 2, LE); off += 4;

  // hdr_size (must be 1000)
  dv.setUint32(off, 1000, LE); off += 4;

  // --- 3. Compute total payload size ---
  let payloadBytes = 0;

  for (const sl of streamlines) {
    const nPoints = sl.length / 3;
    payloadBytes += 4; // uint32 count
    payloadBytes += nPoints * (3 + numScalars) * 4;
    payloadBytes += numProperties * 4;
  }

  // --- 4. Allocate final buffer ---
  const out = new ArrayBuffer(1000 + payloadBytes);
  const outView = new DataView(out);

  // Copy header
  new Uint8Array(out).set(new Uint8Array(headerBuf), 0);

  // --- 5. Write streamline data ---
  let p = 1000;

  // RAS → voxmm: the inverse of trkVoxmmToRas
  const F = trkVoxmmToRas(header);
  const det = F[0][0] * (F[1][1] * F[2][2] - F[1][2] * F[2][1]) - F[0][1] * (F[1][0] * F[2][2] - F[1][2] * F[2][0]) + F[0][2] * (F[1][0] * F[2][1] - F[1][1] * F[2][0]);
  const I = [[(F[1][1] * F[2][2] - F[1][2] * F[2][1]) / det, (F[0][2] * F[2][1] - F[0][1] * F[2][2]) / det, (F[0][1] * F[1][2] - F[0][2] * F[1][1]) / det],
             [(F[1][2] * F[2][0] - F[1][0] * F[2][2]) / det, (F[0][0] * F[2][2] - F[0][2] * F[2][0]) / det, (F[0][2] * F[1][0] - F[0][0] * F[1][2]) / det],
             [(F[1][0] * F[2][1] - F[1][1] * F[2][0]) / det, (F[0][1] * F[2][0] - F[0][0] * F[2][1]) / det, (F[0][0] * F[1][1] - F[0][1] * F[1][0]) / det]];
  const t = [0, 1, 2].map(r => -(I[r][0] * F[0][3] + I[r][1] * F[1][3] + I[r][2] * F[2][3]));
  const R = [I[0], I[1], I[2], t];

  for (const sl of streamlines) {
    const nPoints = sl.length / 3;

    // number of points
    outView.setUint32(p, nPoints, LE);
    p += 4;

	// x,y,z (+ scalars if any)
	for (let i = 0; i < nPoints; i++) {
	  const x = sl[3*i];
	  const y = sl[3*i+1];
	  const z = sl[3*i+2];

	  // Convert RAS → voxmm
	  const vx = R[0][0]*x + R[0][1]*y + R[0][2]*z + R[3][0];
	  const vy = R[1][0]*x + R[1][1]*y + R[1][2]*z + R[3][1];
	  const vz = R[2][0]*x + R[2][1]*y + R[2][2]*z + R[3][2];

	  outView.setFloat32(p, vx, LE); p += 4;
	  outView.setFloat32(p, vy, LE); p += 4;
	  outView.setFloat32(p, vz, LE); p += 4;

	  // scalars not supported → write zeros
	  for (let s = 0; s < numScalars; s++) {
		outView.setFloat32(p, 0, LE);
		p += 4;
	  }
	}

    // per‑tract properties (ignored → zeros)
    for (let pr = 0; pr < numProperties; pr++) {
      outView.setFloat32(p, 0, LE);
      p += 4;
    }
  }

  return out;
}
