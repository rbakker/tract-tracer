// ── nifti.js ──────────────────────────────────────────────
// Self-contained NIfTI-1 parser. Handles sform + qform quaternion.
// Returns a nii object with affine, inv, dims, pixdim, data, mn, mx.

import { invertAffine, decomposeAffineKSP } from './affine.js';

export async function parseNifti(buf) {
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
  const dims     = Array.from({length:8},(_,i)=>dv.getInt16(40+i*2,le));
  const nx=dims[1], ny=dims[2], nz=dims[3];
  if (dims[4] > 1) {
    console.log(`NIfTI contains ${dims[4]} volumes, only the first one is read.`);
  }
  const datatype = dv.getInt16(70,le);
  const vox_offset=dv.getFloat32(108,le);
  const pixdim   = Array.from({length:8},(_,i)=>dv.getFloat32(76+i*4,le));
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
    const dx=pixdim[1], dy=pixdim[2], dz=pixdim[3];

    // Distribute dx to Column 0, dy to Column 1, and (qfac * dz) to Column 2
    Ab = [
      [ dx*(a*a+b*b-c*c-d*d), dy*2*(b*c-a*d),       qfac*dz*2*(b*d+a*c)       ],
      [ dx*2*(b*c+a*d),       dy*(a*a+c*c-b*b-d*d), qfac*dz*2*(c*d-a*b)       ],
      [ dx*2*(b*d-a*c),       dy*2*(c*d+a*b),       qfac*dz*(a*a+d*d-c*c-b*b) ],
      [ qx, qy, qz ]
    ];
  } else {
    Ab = [[pixdim[1],0,0],[0,pixdim[2],0],[0,0,pixdim[3]],[0,0,0]];
  }

  const start = Math.round(vox_offset);
  const n = nx * ny * nz; // Size of exactly one 3D spatial volume

  // Bytes per element for the NIfTI datatype (to stay inside the ArrayBuffer)
  let bytesPerElement = 1;
  if ([4, 512].includes(datatype)) bytesPerElement = 2;
  else if ([8, 16, 768].includes(datatype)) bytesPerElement = 4;
  else if ([64, 1024, 1280].includes(datatype)) bytesPerElement = 8;

  // Ensure our slice or view length strictly caps at `n` elements (the first 3D volume)
  const bytes = () => buf.slice(start, start + n * bytesPerElement); // aligned copy
  let data;
  if (datatype === 2) {
    data = new Uint8Array(buf, start, n);
  } else if (datatype === 4) {
    data = new Int16Array(bytes(), 0, n);
  } else if (datatype === 8) {
    data = new Int32Array(bytes(), 0, n);
  } else if (datatype === 16) {
    data = new Float32Array(bytes(), 0, n);
  } else if (datatype === 64) {
    // Cast 64-bit float down to 32-bit float for WebGL/memory optimization
    const f = new Float64Array(bytes(), 0, n);
    data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = f[i];
  } else if (datatype === 256) {
    data = new Int8Array(buf, start, n);
  } else if (datatype === 512) {
    data = new Uint16Array(bytes(), 0, n);
  } else if (datatype === 768) {
    data = new Uint32Array(bytes(), 0, n);                      // DT_UINT32 (e.g. label volumes from nibabel)
  } else if (datatype === 1024 || datatype === 1280) {
    // 64-bit integers (labels): to 32-bit float, exact up to 16,777,216
    const b = datatype === 1024 ? new BigInt64Array(bytes(), 0, n) : new BigUint64Array(bytes(), 0, n);
    data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = Number(b[i]);
  } else {
    throw 'Unsupported NIfTI datatype ' + datatype;
  }
  
  let mn=Infinity, mx=-Infinity;
  for(let i=0;i<data.length;i+=7){ if(data[i]<mn)mn=data[i]; if(data[i]>mx)mx=data[i]; }

  // Decompose affine into K*S*P, where K is the residual affine, S contains voxel sizes on its diagonal, and P permutes voxels to RAS.
  const decomp = decomposeAffineKSP(Ab,[pixdim[1],pixdim[2],pixdim[3]]);
  const invAb = invertAffine(Ab);

  console.log('NIfTI sform='+sform_code+' qform='+qform_code, nx+'×'+ny+'×'+nz,'Ab', Ab);
  
  return { nx, ny, nz, pixdim, data, mn, mx,
    Ab, decomp, invAb };
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

export async function parseMIF(file) {
  const buffer = await file.arrayBuffer();
  const text = new TextDecoder().decode(buffer);

  // 1. Extract header
  const endIndex = text.indexOf('END');
  const headerText = text.substring(0, endIndex).trim();
  const headerLines = headerText.split('\n');

  const header = {};
  for (const line of headerLines) {
    const [key, value] = line.split(':').map(s => s.trim());
    if (key && value) header[key] = value;
  }

  // 2. Parse dimensions
  const dims = header['dim'].split(',').map(Number);

  // 3. Parse datatype
  const dtype = header['datatype']; // e.g. "Float32LE"
  const typeMap = {
    'Float32LE': Float32Array,
    'Float32BE': Float32Array,
    'UInt8': Uint8Array,
    'Int16LE': Int16Array,
    'Int16BE': Int16Array
    // add more as needed
  };
  const TypedArray = typeMap[dtype];

  // 4. Parse binary offset
  const fileLine = header['file']; // ". 4096"
  const offset = Number(fileLine.split(' ')[1]);

  // 5. Extract binary data
  const bin = buffer.slice(offset);
  const data = new TypedArray(bin);

  return {
    header,
    dims,
    data
  };
}
