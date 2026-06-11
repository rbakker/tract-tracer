// ── tck.js ────────────────────────────────────────────────
// MRtrix3 .tck parser + writer.
// parseTck  → { tracts, tractForPoint, rawHeader }
// writeTck  → ArrayBuffer

function sysLE() {
  const t = new Uint16Array(1); t[0] = 348;
  return new DataView(t.buffer).getUint16(0, true) === 348;
}

// ── parseHeaderTuples ──────────────────────────────────────
// Common routine: reads the ASCII header and returns an ordered
// array of [key, value] pairs, preserving duplicates (e.g. multiple
// command_history lines) and order.  The first entry is always
// ['_magic', 'mrtrix tracks'].  Entries after END are not included.
// Also returns byteLength of the header (up to and including 'END\n').
function parseHeaderTuples(buf) {
  const maxScan = Math.min(16384, buf.byteLength);
  const text = new TextDecoder().decode(new Uint8Array(buf, 0, maxScan));
  const endMatch = text.match(/\nEND\n/);
  if (!endMatch) throw 'Could not find END in .tck header';
  const headerText = text.slice(0, endMatch.index + endMatch[0].length);
  const lines = headerText.split('\n');

  const tuples = [];
  if (!lines[0].startsWith('mrtrix tracks')) throw 'Not a .tck file';
  tuples.push(['_magic', 'mrtrix tracks']);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === 'END') break;
    // Key: value  (key is word characters, value is rest of line)
    const m = line.match(/^([\w]+):\s?(.*)/);
    if (m) {
      tuples.push([m[1], m[2]]);
    } else if (tuples.length > 1 && line !== '') {
      // Continuation line — append to previous value (handles multi-line values)
      tuples[tuples.length - 1][1] += '\n' + line;
    }
  }
  return { tuples, headerByteLength: new TextEncoder().encode(headerText).byteLength };
}

// Build a plain object from tuples (last value wins for duplicates,
// except command_history which is not needed as an object key).
function tuplesToObj(tuples) {
  const h = {};
  for (const [k, v] of tuples) h[k] = v;
  return h;
}

// Build raw header string from tuples, omitting count/total_count/file
// (those are owned by writeTck).  Returned string starts with 'mrtrix tracks'
// and does NOT end with a newline.
function tuplesToRaw(tuples) {
  const lines = [];
  for (const [k, v] of tuples) {
    if (k === '_magic') { lines.push('mrtrix tracks'); continue; }
    if (k === 'count' || k === 'total_count' || k === 'file') continue;
    lines.push(k + ': ' + v);
  }
  return lines.join('\n');
}

export function parseTck(buf) {
  const { tuples } = parseHeaderTuples(buf);
  const h = tuplesToObj(tuples);
  const rawHeader = tuplesToRaw(tuples);

  const byteOffset = parseInt(h.file.split(' ').pop());
  const m = h.datatype.match(/^([a-zA-Z]+)(\d+)([a-zA-Z]+)$/);
  if (!m) throw 'Bad TCK datatype';
  const bpe = parseInt(m[2]) / 8;
  const Dtype = bpe === 4 ? Float32Array : Float64Array;
  const le = m[3] === 'LE';
  let data;
  if (le === sysLE()) {
    data = byteOffset % bpe
      ? new Dtype(buf.slice(byteOffset))
      : new Dtype(buf, byteOffset);
  } else {
    const len = (buf.byteLength - byteOffset) / bpe;
    data = new Dtype(len);
    const dv = new DataView(buf, byteOffset);
    const g = 'get' + Dtype.name.replace('Array', '');
    for (let i = 0; i < len; i++) data[i] = dv[g](i * bpe, le);
  }

  const tracts = [], tractForPoint = [];
  let iPrev = 0;
  for (let i = 0; i < data.length / 3; i++) {
    const v = data[3 * i];
    if (isNaN(v) || !isFinite(v)) {
      const len = i - iPrev;
      if (len > 0) {
        const si = tracts.length;
        const off = data.byteOffset + 3 * iPrev * data.BYTES_PER_ELEMENT;
        tracts.push(new data.constructor(data.buffer, off, 3 * len));
        for (let k = 0; k < len; k++) tractForPoint.push(si);
      }
      iPrev = i + 1;
    }
  }
  return { tracts, tractForPoint: new Int32Array(tractForPoint), rawHeader };
}

// ── writeTck ───────────────────────────────────────────────
// tracts      : Float32Array[] as returned by parseTck
// rawHeader   : string from parseTck (no count/total_count/file lines)
// commandLine : appended as a new command_history entry
// Returns ArrayBuffer.
export function writeTck(tracts, rawHeader, commandLine) {
  const n = tracts.length;

  // Binary payload: each tract's points + NaN,NaN,NaN separator (and final terminator)
  let nFloats = 0;
  for (const t of tracts) nFloats += t.length + 3;
  const data = new Float32Array(nFloats);
  let off = 0;
  for (const t of tracts) {
    for (let i = 0; i < t.length; i++) data[off++] = t[i];
    data[off++] = NaN; data[off++] = NaN; data[off++] = NaN;
  }

  // Header text: rawHeader already starts with 'mrtrix tracks'
  const enc = new TextEncoder();
  const headerLines = [
    rawHeader,
    'command_history: ' + commandLine,
    'count: ' + n,
    'total_count: ' + n,
  ];

  // The 'file: . <offset>' line depends on its own byte position — solve by
  // measuring header length with a placeholder, then align to Float32 (4 bytes).
  const placeholder = headerLines.join('\n') + '\nfile: . 0000000000\nEND\n';
  const dataOffset = Math.ceil(enc.encode(placeholder).byteLength / 4) * 4;

  const fullHeader = headerLines.join('\n') + '\nfile: . ' + dataOffset + '\nEND\n';
  const headerBytes = enc.encode(fullHeader);
  if (headerBytes.byteLength > dataOffset)
    throw 'writeTck: header overflowed estimated offset — please report';

  const out = new ArrayBuffer(dataOffset + data.byteLength);
  new Uint8Array(out).set(headerBytes, 0);
  new Float32Array(out, dataOffset).set(data);
  return out;
}
