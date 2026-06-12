// ── tck.js ────────────────────────────────────────────────
// MRtrix3 .tck parser + writer.

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
 * @param {ArrayBuffer} buf
 * @returns {{tracts: Array, streamlineLookup: Int32Array, header: Object}}
 */
export function parseTck(buf) {
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

  const streamlines = [], streamlineLookup = [];
  const nPoints = data.length / 3;
  let iPrev = 0;

  // Push a streamline slice [start,end)
  function pushStreamline(start, end) {
    const len = end - start;
    if (len <= 0) return;

    const si = streamlines.length;
    const off = data.byteOffset + 3 * start * data.BYTES_PER_ELEMENT;
    streamlines.push(new data.constructor(data.buffer, off, 3 * len));

    for (let k = 0; k < len; k++) streamlineLookup.push(si);
  }

  for (let i = 0; i < nPoints; i++) {
    const x = data[3*i], y = data[3*i+1], z = data[3*i+2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      pushStreamline(iPrev, i);
      iPrev = i + 1;
    }
  }

  pushStreamline(iPrev, nPoints);

  return { streamlines, streamlineLookup: new Int32Array(streamlineLookup), header };
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
