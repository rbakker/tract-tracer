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
 * @param {ArrayBuffer} buf
 * @returns {{tracts: Array, streamlineLookup: Int32Array, header: Object}}
 */
export async function parseTck(file, maxNumTracts = 0) {
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
  let iPrev = 0;

  // Push a streamline slice [start,end)
  function pushStreamline(start, end) {
    const len = end - start;
    if (len <= 0) return;

    const si = streamlines.length;
    const off = data.byteOffset + 3 * start * data.BYTES_PER_ELEMENT;
    streamlines.push(new data.constructor(data.buffer, off, 3 * len));

    for (let k = 0; k < len; k++) lookup.push(si);
  }

  for (let i = 0; i < nPoints; i++) {
    const x = data[3*i], y = data[3*i+1], z = data[3*i+2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      pushStreamline(iPrev, i);
      iPrev = i + 1;
    }
  }

  pushStreamline(iPrev, nPoints);

  return { streamlines, streamlineLookup: new Int32Array(lookup), header };
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
export function parseTrkHeader(fileAsArrayBuffer) {
    let header = {}
    let byteOffset = 0;
    const view = new DataView(fileAsArrayBuffer);
    // There is no header field for byte-order. Assuming same as system byte-order.
    const LE = sysLE();
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


/** 
* Parse both header and tracts from a TrackVis .trk file
* @param {ArrayBuffer} buf - File contents as a byte array buffer
* @param {Object} [header] - File header if previously parsed
* @param {number} [maxNumTracts=0] - Maximum number of tracts to extract, 0 to extract all.
* @return {Array} Extracted header and tracts
*/
export async function parseTrk(file, maxNumTracts = 0) {
  const buf = await file.arrayBuffer();

  const header = parseTrkHeader(buf);
  const view = new DataView(buf);
  const LE = header.little_endian;

  const numScalars = header.n_scalars;
  const numProperties = header.n_properties;

  let byteOffset = header.hdr_size;
  let numTracts = header.n_count;
  if (maxNumTracts) numTracts = Math.min(maxNumTracts, numTracts);

  const vox2ras = header.vox_to_ras;

  // Precompute affine rows for speed
  const r0 = vox2ras[0], r1 = vox2ras[1], r2 = vox2ras[2];
  const streamlines = [];
  const streamlineLookup = [];

  // We accumulate all points into one big Float32Array
  // (same as TCK reader)
  let totalPoints = 0;
  const pointCounts = new Array(numTracts);

  // First pass: count points
  let off = byteOffset;
  for (let tr = 0; tr < numTracts; tr++) {
    const n = view.getUint32(off, LE);
    off += 4 + (n * (3 + numScalars) * 4) + (numProperties * 4);
    pointCounts[tr] = n;
    totalPoints += n;
  }

  // Allocate final buffer (RAS‑space)
  const dataArray = new Float32Array(totalPoints * 3);

  // Second pass: read + transform directly into final buffer
  let p = 0;
  off = byteOffset;

  for (let tr = 0; tr < numTracts; tr++) {
    const n = view.getUint32(off, LE);
    off += 4;

    const floatsPerPoint = 3 + numScalars;

    for (let i = 0; i < n; i++) {
      const x = view.getFloat32(off + 4 * (i * floatsPerPoint + 0), LE);
      const y = view.getFloat32(off + 4 * (i * floatsPerPoint + 1), LE);
      const z = view.getFloat32(off + 4 * (i * floatsPerPoint + 2), LE);

      // Apply affine
      dataArray[p++] = r0[0] * x + r0[1] * y + r0[2] * z + r0[3];
      dataArray[p++] = r1[0] * x + r1[1] * y + r1[2] * z + r1[3];
      dataArray[p++] = r2[0] * x + r2[1] * y + r2[2] * z + r2[3];
    }

    off += n * floatsPerPoint * 4;
    off += numProperties * 4;
  }

  // Build streamline views + lookup (same as TCK)
  const lookup = new Int32Array(numTracts + 1);
  let base = 0;

  for (let tr = 0; tr < numTracts; tr++) {
    const n = pointCounts[tr];
    lookup[tr] = base;

    const byteOff = base * 3 * 4;
    streamlines.push(
      new Float32Array(
        dataArray.buffer,
        dataArray.byteOffset + byteOff,
        n * 3
      )
    );

    base += n;
  }
  lookup[numTracts] = base;

  return {
    header,
    streamlines,
    streamlineLookup: lookup
  };
}

/*
export async function parseTrk(file, space = 'vox_mm', maxNumTracts = 0) {
  // 1. Read the header bytes up-front
  const headerBlob = file.slice(0, 1024);
  const headerBuffer = await headerBlob.arrayBuffer();
  const header = parseHeader(headerBuffer);
  
  const numScalars = header.n_scalars;
  const numProperties = header.n_properties;
  const floatsPerPoint = 3 + numScalars;
  let numTracts = header.n_count;
  if (maxNumTracts) numTracts = Math.min(maxNumTracts, numTracts);

  const starts = new Int32Array(numTracts);
  const ends = new Int32Array(numTracts);

  const LE = header.little_endian;
  const CHUNK_SIZE = 64 * 1024 * 1024; // 64 MB dynamic processing windows

  // --- PASS 1: Read structural metadata ---
  for (let tr = 0; tr < numTracts; tr++) {
    if (filePos + 4 > file.size) { numTracts = tr; break; }

    if (chunkBuf === null || filePos + 4 > chunkStartPos + chunkBuf.byteLength) {
      chunkStartPos = filePos;
      chunkBlob = file.slice(chunkStartPos, Math.min(file.size, chunkStartPos + CHUNK_SIZE));
      chunkBuf = await chunkBlob.arrayBuffer();
      view = new DataView(chunkBuf);
    }

    let viewOffset = filePos - chunkStartPos;
    const n = view.getUint32(viewOffset, LE);
    const bytesForTractData = (n * floatsPerPoint * 4) + (numProperties * 4);

    starts[tr] = totalPoints;
    ends[tr] = totalPoints + n;

    totalPoints += n;
    filePos += 4 + bytesForTractData;
  }

  // --- Process Matrix Based on Space Option ---
  const vox2ras = header.vox_to_ras;
  const vs = header.voxel_size;
  let r0, r1, r2;

  if (space === 'vox') {
    r0 = [...vox2ras[0]]; r1 = [...vox2ras[1]]; r2 = [...vox2ras[2]];
  } else if (space === 'vox_mm') {
    r0 = [vox2ras[0][0]/vs[0], vox2ras[0][1]/vs[1], vox2ras[0][2]/vs[2], vox2ras[0][3]];
    r1 = [vox2ras[1][0]/vs[0], vox2ras[1][1]/vs[1], vox2ras[1][2]/vs[2], vox2ras[1][3]];
    r2 = [vox2ras[2][0]/vs[0], vox2ras[2][1]/vs[1], vox2ras[2][2]/vs[2], vox2ras[2][3]];
  } else if (space === 'ras') {
    r0 = [1, 0, 0, 0]; r1 = [0, 1, 0, 0]; r2 = [0, 0, 1, 0];
  }

  // --- PASS 2: Populate coordinate buffers ---
  for (let tr = 0; tr < numTracts; tr++) {
    const n = ends[tr] - starts[tr];
    const bytesForTractData = (n * floatsPerPoint * 4) + (numProperties * 4);
    const totalTractBytes = 4 + bytesForTractData;

    // SIMPLIFIED & ROBUST: Check if this entire streamline fits in the cached window
    if (chunkBuf === null || filePos + totalTractBytes > chunkStartPos + chunkBuf.byteLength) {
      chunkStartPos = filePos;
    
      // Dynamically scale up the window if a huge streamline demands more than 64MB
      const currentReadSize = Math.max(CHUNK_SIZE, totalTractBytes);
      chunkBlob = file.slice(chunkStartPos, Math.min(file.size, chunkStartPos + currentReadSize));
      chunkBuf = await chunkBlob.arrayBuffer();
      view = new DataView(chunkBuf);
    }

    let byteOffset = (filePos - chunkStartPos) + 4; // Step past the 4-byte integer

    for (let i = 0; i < n; i++) {
      const step = byteOffset + 4 * (i * floatsPerPoint);
      const x = view.getFloat32(step, LE);
      const y = view.getFloat32(step + 4, LE);
      const z = view.getFloat32(step + 8, LE);

      point2streamline[p] = tr;

      pointsX[p] = r0[0] * x + r0[1] * y + r0[2] * z + r0[3];
      pointsY[p] = r1[0] * x + r1[1] * y + r1[2] * z + r1[3];
      pointsZ[p] = r2[0] * x + r2[1] * y + r2[2] * z + r2[3];
      p++;
    }

    filePos += totalTractBytes;

    // Memory Safeguard: If we had to expand the buffer beyond 64MB for a monster track,
    // kill the buffer reference immediately so the next iteration doesn't get trapped by it.
    if (totalTractBytes > CHUNK_SIZE) {
      chunkBuf = null;
    }
  }

  return {
    header,
    streamlines: { 
      starts: numTracts === starts.length ? starts : starts.subarray(0, numTracts), 
      ends: numTracts === ends.length ? ends : ends.subarray(0, numTracts) 
    },
    pointsX,
    pointsY,
    pointsZ,
    point2streamline
  };
}
*/

/**
 * Convert a TrackVis .trk header into a minimal, valid MRtrix .tck header.
 *
 * @param {Object} trkHeader - Header object parsed from a .trk file.
 * @returns {Object} A new .tck‑style header dictionary.
 */
export function ensureTckHeader(header) {
  if (!header.vox_to_ras && header.file) return header;

  const vox = trkHeader.vox_to_ras;

  const msg =
    'Converted from .trk header with vox_to_ras ' +
    JSON.stringify(vox);

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

  // Compute RAS → voxel transform
  const rasToVoxel = invertAffine(header.vox_to_ras);
  const R = rasToVoxel; // alias

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

	  // Convert RAS → voxel
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
