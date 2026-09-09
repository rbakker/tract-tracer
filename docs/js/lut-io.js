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
// Returns { map, maxIndex }:
//   map: Map<index, {r,g,b,a (all 0-1), name}>
//   maxIndex: highest index seen (used to size the GPU lookup texture)

const ITK_RE = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+"([^"]*)"\s*$/;
const FS_RE  = /^(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

export async function parseLUT(file) {
  const text = await file.text();
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
