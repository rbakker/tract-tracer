// ── lut-io.js ─────────────────────────────────────────────
// Parses FreeSurfer-style and ITK-SNAP-style label lookup tables (LUTs),
// both plain-text formats mapping an integer label index to an RGB(A)
// colour and a name. Format is auto-detected line by line.
//
// FreeSurfer  (e.g. FreeSurferColorLUT.txt):
//   <index> <name> <R> <G> <B> <A>
//   0   Unknown                                 0   0   0   0
//   2   Left-Cerebral-White-Matter             245 245 245   0
//   comments start with '#'. The alpha column is conventionally unused
//   (almost always 0, but doesn't mean "invisible") — ignored here.
//
// ITK-SNAP label description file:
//   <index> <R> <G> <B> <A> <VIS> <MSH> "<label>"
//   1     0    0  255        1  1  1    "Left Thalamus"
//   comments start with '#'. Alpha (0-1) is meaningful here.
//
// BIDS segmentation lookup table (*_dseg.tsv, tab-separated, a header row):
//   index	name	abbreviation	color	mapping
//   1	Left cerebral white matter	LCWM	#f5f5f5	2
//   only the official columns: index (required, an integer), name
//   (required), abbreviation, color ("#rrggbb"), mapping (the index's
//   label in the BIDS standard lookup — read, not used); "n/a" is no value.
//   A row without a color gets one from an automatic palette (index 0: black).
//
// Returns { map, maxIndex }:
//   map: Map<index, {r,g,b,a (all 0-1), name}>
//   maxIndex: highest index seen (used to size the GPU lookup texture)

const ITK_RE = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+"([^"]*)"\s*$/;
const FS_RE  = /^(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

// The official columns of a BIDS *_dseg.tsv.
const BIDS_LUT_COLUMNS = ['index', 'name', 'abbreviation', 'color', 'mapping'];
// Is this (the first line of a .tsv) the header of a BIDS lookup table?
export function isBidsLutHeader(line) {
  const cols = String(line).replace(/^\uFEFF/, '').trim().split('\t').map(c => c.trim());
  return cols.includes('index') && cols.includes('name');
}

function parseBidsLut(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const cols = lines[0].split('\t').map(c => c.trim());
  const odd = cols.filter(c => !BIDS_LUT_COLUMNS.includes(c));
  if (odd.length) throw `not a BIDS lookup table column: ${odd.join(', ')} (allowed: ${BIDS_LUT_COLUMNS.join(', ')})`;
  const at = c => cols.indexOf(c);
  const iI = at('index'), iN = at('name'), iC = at('color'), iA = at('abbreviation'), iM = at('mapping');
  if (iI < 0 || iN < 0) throw 'a BIDS lookup table needs the columns index and name';
  const map = new Map();
  let maxIndex = 0, auto = 0;
  for (let k = 1; k < lines.length; k++) {
    const cell = lines[k].split('\t').map(c => c.trim());
    const val = i => (i < 0 || cell[i] == null || cell[i] === '' || cell[i] === 'n/a' ? null : cell[i]);
    const idxText = val(iI);
    if (!/^\d+$/.test(idxText || '')) throw `row ${k + 1}: index "${idxText ?? ''}" is not a whole number`;
    const idx = parseInt(idxText, 10);
    if (map.has(idx)) throw `row ${k + 1}: index ${idx} appears twice`;
    const hex = val(iC);
    let rgb;
    if (hex != null) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex);
      if (!m) throw `row ${k + 1}: color "${hex}" is not #rrggbb`;
      const n = parseInt(m[1], 16);
      rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
    } else rgb = idx === 0 ? [0, 0, 0] : autoRgb(auto++);   // (0: the background, black as elsewhere)
    const e = { r: rgb[0], g: rgb[1], b: rgb[2], a: 1, name: val(iN) ?? String(idx) };
    if (val(iA) != null) e.abbreviation = val(iA);
    if (val(iM) != null) e.mapping = val(iM);
    map.set(idx, e);
    if (idx > maxIndex) maxIndex = idx;
  }
  if (map.size === 0) throw 'No label rows in this BIDS lookup table';
  return { map, maxIndex };
}
// golden-angle hues (as the app's automatic colours)
function autoRgb(i) {
  const h = ((i * 137.50776405003785) % 360) / 360, s = 0.65, l = 0.55;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1/6 ? p + (q - p) * 6 * t : t < 1/2 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; };
  return [f(h + 1/3), f(h), f(h - 1/3)];
}

export async function parseLUT(file) {
  const text = await file.text();
  const first = text.split(/\r?\n/, 1)[0];
  if (/\.tsv$/i.test(file.name || '') || isBidsLutHeader(first)) {
    if (!isBidsLutHeader(first)) throw 'a .tsv lookup table needs a BIDS header row: index, name (and optionally abbreviation, color, mapping)';
    return parseBidsLut(text);
  }
  const lines = text.split(/\r?\n/);
  const map = new Map();
  let maxIndex = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let m = ITK_RE.exec(line);
    if (m) {
      const idx = parseInt(m[1], 10);
      map.set(idx, {
        r: +m[2]/255, g: +m[3]/255, b: +m[4]/255, a: +m[5],
        name: m[8],
      });
      if (idx > maxIndex) maxIndex = idx;
      continue;
    }

    m = FS_RE.exec(line);
    if (m) {
      const idx = parseInt(m[1], 10);
      map.set(idx, {
        r: +m[3]/255, g: +m[4]/255, b: +m[5]/255,
        a: 1, // FreeSurfer's alpha column is conventionally unused
        name: m[2].replace(/_/g, ' '),
      });
      if (idx > maxIndex) maxIndex = idx;
      continue;
    }
    // Unrecognised line (stray header/footer text, blank-ish) — skip.
  }

  if (map.size === 0) throw 'No recognisable label entries found in this file';
  return { map, maxIndex };
}

// Builds the shared RGBA8 lookup-table byte buffer used by both the 2D
// slice renderer and the glass brain. Index 0 defaults to black when
// unmapped, any other unmapped index to mid-gray.
export function buildLutRGBA(lutMap, lutMaxIndex) {
  const size = Math.min(Math.max(lutMaxIndex + 1, 1), 65536);
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const e = lutMap.get(i);
    let r, g, b, a;
    if (e) { r=e.r; g=e.g; b=e.b; a=e.a; }
    else if (i === 0) { r=g=b=0; a=1; }
    else { r=g=b=0.5; a=1; }
    data[i*4+0] = Math.round(Math.min(Math.max(r,0),1)*255);
    data[i*4+1] = Math.round(Math.min(Math.max(g,0),1)*255);
    data[i*4+2] = Math.round(Math.min(Math.max(b,0),1)*255);
    data[i*4+3] = Math.round(Math.min(Math.max(a,0),1)*255);
  }
  return { data, size };
}
