// ── exif.js ───────────────────────────────────────────────
// The lens of a JPEG photo, from its EXIF block (APP1 "Exif"): the focal
// length in 35 mm film terms (tag 0xA405 FocalLengthIn35mmFilm), and the
// real one (0x920A FocalLength, mm) when given. Phones and cameras write
// both; a screen grab or a PNG has none.
//
// No app state; tools/photo.js uses it.

/**
 * @param {Blob} file - the photo (only its first 256 kB are read)
 * @returns {Promise<{ focal35: number|null, focal: number|null, make: string|null, model: string|null }|null>}
 *   null: no EXIF (not a JPEG, or none written)
 */
export async function readExifLens(file) {
  let buf;
  try { buf = await file.slice(0, 256 * 1024).arrayBuffer(); } catch (e) { return null; }
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;   // (not a JPEG)
  // the segments up to the image data: APP1 with "Exif\0\0"
  let o = 2;
  while (o + 4 <= v.byteLength) {
    if (v.getUint8(o) !== 0xFF) return null;
    const marker = v.getUint8(o + 1), len = v.getUint16(o + 2);
    if (marker === 0xDA || marker === 0xD9) return null;   // (start of scan / end: no EXIF before it)
    if (marker === 0xE1 && o + 10 <= v.byteLength && v.getUint32(o + 4) === 0x45786966 && v.getUint16(o + 8) === 0) return parseTiff(v, o + 10);
    o += 2 + len;
  }
  return null;
}

// the TIFF structure in the EXIF block: IFD0 → the Exif IFD → the lens tags
function parseTiff(v, t) {
  if (t + 8 > v.byteLength) return null;
  const le = v.getUint16(t) === 0x4949;   // 'II': little-endian; 'MM': big-endian
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  if (u16(t + 2) !== 42) return null;
  const out = { focal35: null, focal: null, make: null, model: null };
  const str = (o, n) => { let s = ''; for (let i = 0; i < n && o + i < v.byteLength; i++) { const c = v.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s.trim() || null; };
  // one IFD: fn(tag, type, count, valueOffset) for each entry
  const ifd = (at, fn) => {
    if (at + 2 > v.byteLength) return;
    const n = u16(at);
    for (let k = 0; k < n; k++) {
      const e = at + 2 + 12 * k;
      if (e + 12 > v.byteLength) return;
      fn(u16(e), u16(e + 2), u32(e + 4), e + 8);
    }
  };
  let exifAt = null;
  ifd(t + u32(t + 4), (tag, type, count, vo) => {
    if (tag === 0x8769) exifAt = t + u32(vo);                                       // the Exif IFD
    else if (tag === 0x010F) out.make = str(count > 4 ? t + u32(vo) : vo, count);   // Make
    else if (tag === 0x0110) out.model = str(count > 4 ? t + u32(vo) : vo, count);  // Model
  });
  if (exifAt != null) ifd(exifAt, (tag, type, count, vo) => {
    if (tag === 0xA405) { const f = type === 3 ? u16(vo) : u32(vo); if (f > 0) out.focal35 = f; }   // SHORT (or LONG)
    else if (tag === 0x920A && type === 5) {                                                     // RATIONAL
      const p = t + u32(vo);
      if (p + 8 <= v.byteLength) { const a = u32(p), b = u32(p + 4); if (a > 0 && b > 0) out.focal = a / b; }
    }
  });
  return out;
}
