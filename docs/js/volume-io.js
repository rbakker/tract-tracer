// ── nifti.js ──────────────────────────────────────────────
// Self-contained NIfTI-1 parser. Handles sform + qform quaternion.
// Returns a nii object with affine, inv, dims, pixdim, data, mn, mx, channels.
//
// `channels` is 1 for a normal scalar (e.g. T1/T2/FA) volume, or 3 for a
// colour / directionally-encoded-colour (DEC) volume — either a 4D NIfTI
// with exactly 3 volumes along dim4 (MRtrix's own convention, e.g. the
// output of `tensor2metric -vector -modulate FA`), or a single-volume
// NIfTI using the packed DT_RGB24 / DT_RGBA32 datatype. When channels===3,
// `data` is an interleaved Float32Array of length shape[0]*shape[1]*shape[2]*3
// (R,G,B per voxel, already ~[0,1] — no mn/mx windowing is applied).

import { invertAffine, decomposeAffineKSP, matMul } from './affine.js';

function bytesPerElementFor(datatype) {
  if ([4, 512].includes(datatype)) return 2;
  if ([8, 16].includes(datatype)) return 4;
  if (datatype === 64) return 8;
  return 1;
}

// Full-scale value for integer NIfTI datatypes, used to normalize a plain
// integer-typed colour volume (e.g. a hand-made uint8 test image) into the
// [0,1] range the renderer expects. Returns null for float datatypes,
// which are assumed already meaningfully scaled (e.g. MRtrix's own
// tensor2metric output is float32, already ~[0,1]).
function integerRangeMax(datatype) {
  switch (datatype) {
    case 2:   return 255;         // DT_UINT8
    case 256: return 127;         // DT_INT8 (signed)
    case 4:   return 32767;       // DT_INT16 (signed)
    case 512: return 65535;       // DT_UINT16
    case 8:   return 2147483647;  // DT_INT32 (signed)
    default:  return null;        // DT_FLOAT32/64 and anything else
  }
}

// Reads exactly `n` elements of the given NIfTI datatype starting at byte
// offset `start` in `buf`, always returning a Float32Array of length n.
function readVolumeFloat32(buf, start, n, datatype, bytesPerElement) {
  if (datatype === 2) {
    const src = new Uint8Array(buf, start, n);
    const out = new Float32Array(n); out.set(src); return out;
  } else if (datatype === 4) {
    const src = new Int16Array(buf.slice(start, start + n * bytesPerElement), 0, n);
    const out = new Float32Array(n); out.set(src); return out;
  } else if (datatype === 8) {
    const src = new Int32Array(buf.slice(start, start + n * bytesPerElement), 0, n);
    const out = new Float32Array(n); out.set(src); return out;
  } else if (datatype === 16) {
    return new Float32Array(buf.slice(start, start + n * bytesPerElement), 0, n);
  } else if (datatype === 64) {
    const f = new Float64Array(buf.slice(start, start + n * bytesPerElement), 0, n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = f[i];
    return out;
  } else if (datatype === 256) {
    const src = new Int8Array(buf, start, n);
    const out = new Float32Array(n); out.set(src); return out;
  } else if (datatype === 512) {
    const src = new Uint16Array(buf.slice(start, start + n * bytesPerElement), 0, n);
    const out = new Float32Array(n); out.set(src); return out;
  } else {
    throw 'Unsupported NIfTI datatype ' + datatype;
  }
}

export async function parseNifti(file) {
  let buf = await file.arrayBuffer();

  // decompress gzip
  const magic = new Uint8Array(buf, 0, 2);
  if (magic[0]===0x1f && magic[1]===0x8b) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(buf)); writer.close();
    const chunks=[], reader=ds.readable.getReader();
    while(true){ const {done,value}=await reader.read(); if(done) break; chunks.push(value); }
    const total=chunks.reduce((a,c)=>a+c.length,0);
    const out=new Uint8Array(total); let off=0;
    for(const c of chunks){ out.set(c,off); off+=c.length; }
    buf=out.buffer;
  }

  const dv = new DataView(buf);
  const sizeof_hdr = dv.getInt32(0,true);
  const le = (sizeof_hdr===348);
  const dims = Array.from({length:8},(_,i)=>dv.getInt16(40+i*2,le));
  const shape = [ dims[1],dims[2],dims[3] ];
  const nvol = dims[4] || 1;
  const datatype = dv.getInt16(70,le);
  const vox_offset=dv.getFloat32(108,le);
  const pixdim   = Array.from({length:8},(_,i)=>dv.getFloat32(76+i*4,le));
  const vox_mm = [ pixdim[1], pixdim[2], pixdim[3] ];
  const qform_code=dv.getInt16(252,le);
  const sform_code=dv.getInt16(254,le);

  let Ab;
  if (sform_code > 0) {
    Ab = [
      [dv.getFloat32(280,le),dv.getFloat32(284,le),dv.getFloat32(288,le)],
      [dv.getFloat32(296,le),dv.getFloat32(300,le),dv.getFloat32(304,le)],
      [dv.getFloat32(312,le),dv.getFloat32(316,le),dv.getFloat32(320,le)],
      [dv.getFloat32(292,le),dv.getFloat32(308,le),dv.getFloat32(324,le)]
    ];
  } else if (qform_code > 0) {
    const b=dv.getFloat32(256,le), c=dv.getFloat32(260,le), d=dv.getFloat32(264,le);
    const a=Math.sqrt(Math.max(0,1-b*b-c*c-d*d));
    const qx=dv.getFloat32(268,le), qy=dv.getFloat32(272,le), qz=dv.getFloat32(276,le);
    const qfac=pixdim[0]<0?-1:1;
    const dx=vox_mm[0], dy=vox_mm[1], dz=vox_mm[2];

    // Distribute dx to Column 0, dy to Column 1, and (qfac * dz) to Column 2
    Ab = [
      [ dx*(a*a+b*b-c*c-d*d), dy*2*(b*c-a*d),       qfac*dz*2*(b*d+a*c)       ],
      [ dx*2*(b*c+a*d),       dy*(a*a+c*c-b*b-d*d), qfac*dz*2*(c*d-a*b)       ],
      [ dx*2*(b*d-a*c),       dy*2*(c*d+a*b),       qfac*dz*(a*a+d*d-c*c-b*b) ],
      [ qx, qy, qz ]
    ];
  } else {
    Ab = [[vox_mm[0],0,0],[0,vox_mm[1],0],[0,0,vox_mm[2]],[0,0,0]];
  }

  const start = Math.round(vox_offset);
  const n = shape[0] * shape[1] * shape[2]; // Size of exactly one 3D spatial volume
  // Determine the byte size per element based on NIfTI datatype
  // to prevent reading out-of-bounds on the underlying ArrayBuffer
  const bytesPerElement = bytesPerElementFor(datatype);

  // DT_RGB24 (128) / DT_RGBA32 (2304): packed colour datatype, one "volume"
  // with 3 (or 4) interleaved byte components per voxel.
  const isPackedRGB = (datatype === 128 || datatype === 2304);
  // MRtrix / mrview convention for a colour (e.g. DEC FA) map: a plain 4D
  // image with exactly 3 volumes along dim4 — e.g. the output of
  // `tensor2metric -vector -modulate FA`. mrview treats this as RGB
  // automatically, so we do too.
  const isVectorRGB = !isPackedRGB && nvol === 3;

  let data, channels, mn=Infinity, mx=-Infinity;

  if (isPackedRGB) {
    channels = 3;
    const comps = datatype === 2304 ? 4 : 3; // discard alpha for RGBA32
    const raw = new Uint8Array(buf, start, n*comps);
    data = new Float32Array(n*3);
    for (let i=0;i<n;i++) {
      data[i*3+0] = raw[i*comps+0]/255;
      data[i*3+1] = raw[i*comps+1]/255;
      data[i*3+2] = raw[i*comps+2]/255;
    }
    mn=0; mx=1;
  } else if (isVectorRGB) {
    channels = 3;
    data = new Float32Array(n*3);
    // A colour volume stored as an integer datatype (e.g. a hand-made
    // uint8 test image) needs normalizing to [0,1] just like DT_RGB24
    // does above — float datatypes (MRtrix's native output) are left as-is.
    const intMax = integerRangeMax(datatype);
    for (let v=0; v<3; v++) {
      const vol = readVolumeFloat32(buf, start + v*n*bytesPerElement, n, datatype, bytesPerElement);
      for (let i=0;i<n;i++) {
        // abs(): eigenvector components are signed with an arbitrary sign
        // (the eigen-decomposition doesn't fix a direction along the
        // fiber), which can flip between neighboring voxels — notably
        // across mirror-symmetric structures like the interhemispheric
        // midline. The standard DEC convention colours by |eigenvector|;
        // clamping negatives to 0 instead would silently drop a channel
        // wherever the sign happens to land negative.
        const val = Math.abs(intMax ? vol[i]/intMax : vol[i]);
        data[i*3+v] = val;
        if (val<mn) mn=val;
        if (val>mx) mx=val;
      }
    }
  } else {
    channels = 1;
    if (nvol > 1) console.log(`NIfTI contains ${nvol} volumes, only the first one is read.`);
    data = readVolumeFloat32(buf, start, n, datatype, bytesPerElement);
    for (let i=0;i<data.length;i++) {
      if (data[i]<mn) mn=data[i];
      if (data[i]>mx) mx=data[i];
    }
  }

  // Decompose affine into K*S*P, where K is the residual affine, S contains voxel sizes on its diagonal, and P permutes voxels to RAS.
  const invAb = invertAffine(Ab);
  const decomp = decomposeAffineKSP(Ab,[pixdim[1],pixdim[2],pixdim[3]]);

  console.log('NIfTI sform='+sform_code+' qform='+qform_code, shape[0]+'×'+shape[1]+'×'+shape[2],
    channels===3?'colour (RGB)':'scalar', 'Ab', Ab);

  return { shape, vox_mm, Ab, invAb, decomp, data, mn, mx, channels };
}


function parseMifHeader(buf) {
  // Fields that may appear multiple times
  const arrayFields = ['command_history', 'transform','prior_dw_scheme'];

  const maxScan = Math.min(16384, buf.byteLength);
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(new Uint8Array(buf, 0, maxScan));

  const endMatch = text.match(/(^|\n)END(\r?\n|$)/);
  if (!endMatch) throw 'Could not find END in .mif header';

  const headerText = text.slice(0, endMatch.index + endMatch[0].length);
  const lines = headerText.split('\n');
  const header = {};

  if (!lines[0].startsWith('mrtrix image'))
    throw 'Not a .mif file';

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

// Datatype descriptors: [TypedArray constructor, bytes, DataView method]
const DTYPES = [
  ['Float32LE', Float32Array, 4, 'getFloat32'],
  ['Float32BE', Float32Array, 4, 'getFloat32'],
  ['Float64LE', Float64Array, 8, 'getFloat64'],
  ['Float64BE', Float64Array, 8, 'getFloat64'],
  ['Int8',      Int8Array,    1, 'getInt8'   ],
  ['Int16LE',   Int16Array,   2, 'getInt16'  ],
  ['Int16BE',   Int16Array,   2, 'getInt16'  ],
  ['Int32LE',   Int32Array,   4, 'getInt32'  ],
  ['Int32BE',   Int32Array,   4, 'getInt32'  ],
  ['UInt8',     Uint8Array,   1, 'getUint8'  ],
  ['UInt16LE',  Uint16Array,  2, 'getUint16' ],
  ['UInt16BE',  Uint16Array,  2, 'getUint16' ],
  ['UInt32LE',  Uint32Array,  4, 'getUint32' ],
  ['UInt32BE',  Uint32Array,  4, 'getUint32' ],
];

// Full-scale value for integer .mif datatypes — same purpose as
// integerRangeMax() above but keyed by MRtrix's dtype name string.
function mifIntegerRangeMax(dtypeName) {
  switch (dtypeName) {
    case 'Int8':                       return 127;
    case 'UInt8':                      return 255;
    case 'Int16LE': case 'Int16BE':    return 32767;
    case 'UInt16LE': case 'UInt16BE':  return 65535;
    case 'Int32LE': case 'Int32BE':    return 2147483647;
    case 'UInt32LE': case 'UInt32BE':  return 4294967295;
    default: return null; // Float32LE/BE, Float64LE/BE: already normalized
  }
}

function getMifDtype(dtype) {
  const entry = DTYPES.find(([name]) => name === dtype);
  if (!entry) throw new Error('Unsupported datatype: ' + dtype);
  const [, TypedArr, bytes, dvMethod] = entry;
  const le = !dtype.endsWith('BE'); // LE or no suffix (Int8, UInt8) → true
  return { TypedArr, bytes, dvMethod, le };
}

function computeStrides(layout, dims) {
  const order = layout
    .map((v, i) => ({ mem: Math.abs(v), logical: i }))
    .sort((a, b) => a.mem - b.mem);
  const strides = new Array(layout.length);
  let s = 1;
  for (const { logical } of order) {
    strides[logical] = s;
    s *= dims[logical];
  }
  return strides;
}

export async function parseMif(file, volIndex = 0) {
  const buf = await file.arrayBuffer();
  const header = parseMifHeader(buf);

  const shape    = header['dim'].split(',').map(Number);
  const vox_mm = header['vox'].split(',').map(Number);
  const layout   = header['layout'].split(',').map(Number);
  const nv      = shape[3] ?? 1;
  const start   = Number(header['file'].trim().split(/\s+/)[1]);

  const { TypedArr, bytes, dvMethod, le } = getMifDtype(header['datatype']);

  // Strides in element counts for each logical axis
  const strides = computeStrides(layout, shape);
  const [sx, sy, sz, sv] = strides;

  // Single DataView over the whole buffer — no copies
  const view = new DataView(buf);
  const [nx,ny,nz] = shape.slice(0,3)
  const n    = nx*ny*nz;

  // A plain 3-volume image is treated as a colour / DEC (directionally-
  // encoded-colour) map, matching how mrview displays such files (e.g. the
  // output of `tensor2metric -vector -modulate FA`).
  const isColor = nv === 3;
  const channels = isColor ? 3 : 1;
  const data = new Float32Array(n * channels); // always output Float32 for rendering

  let mn = Infinity, mx = -Infinity;
  if (isColor) {
    // A colour volume stored as an integer datatype needs normalizing to
    // [0,1] — float datatypes (MRtrix's native output) are left as-is.
    const intMax = mifIntegerRangeMax(header['datatype']);
    let outIdx = 0;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          for (let v = 0; v < 3; v++) {
            let val = view[dvMethod](start + (x*sx + y*sy + z*sz + v*sv) * bytes, le);
            if (intMax) val = val / intMax;
            // abs(): see the matching comment in parseNifti — eigenvector
            // sign is arbitrary and shouldn't be clamped to 0.
            val = Math.abs(val);
            data[outIdx*3 + v] = val;
            if (val < mn) mn = val;
            if (val > mx) mx = val;
          }
          outIdx++;
        }
  } else {
    let outIdx = 0;
    const base = start + volIndex * sv * bytes;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const val = view[dvMethod](base + (x*sx + y*sy + z*sz) * bytes, le);
          data[outIdx++] = val;
          if (val < mn) mn = val;
          if (val > mx) mx = val;
        }
  }

  let K = [[1,0,0],[0,1,0],[0,0,1]]
  let S = [[vox_mm[0],0,0],[0,vox_mm[1],0],[0,0,vox_mm[2]]]
  let P = [[1,0,0],[0,1,0],[0,0,1]];
  let b = [0,0,0]

  if (header.transform && header.transform.length >= 3) {
    const rows = header.transform.map(r =>
      r.split(/,\s*/).map(Number)
    );
    K = [
      [rows[0][0], rows[0][1], rows[0][2]],
      [rows[1][0], rows[1][1], rows[1][2]],
      [rows[2][0], rows[2][1], rows[2][2]]
    ];
    b = [rows[0][3], rows[1][3], rows[2][3]]
  }

  const decomp = { K, S, P, b };
  const Ab = matMul(K,S);
  Ab[3] = b;
  const invAb = invertAffine(Ab);

  return { shape, vox_mm, Ab, invAb, decomp, data, mn, mx, channels };
}
