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
// (Little-endian, like the rest of the reader.)
const NIFTI_TYPES = {
  2:    [1, Uint8Array],      // UINT8
  4:    [2, Int16Array],      // INT16
  8:    [4, Int32Array],      // INT32
  16:   [4, Float32Array],    // FLOAT32
  64:   [8, Float64Array],    // FLOAT64
  256:  [1, Int8Array],       // INT8
  512:  [2, Uint16Array],     // UINT16
  768:  [4, Uint32Array],     // UINT32 (e.g. label volumes from nibabel)
  1024: [8, BigInt64Array],   // INT64
  1280: [8, BigUint64Array],  // UINT64
};
function readVolumeFloat32(buf, start, n, datatype) {
  const t = NIFTI_TYPES[datatype];
  if (!t) throw 'Unsupported NIfTI datatype ' + datatype;
  const [bytes, Arr] = t;
  // a copy of just these bytes: aligned for the typed array, and never past the first volume
  const src = new Arr(buf.slice(start, start + n * bytes), 0, n);
  if (Arr === Float32Array) return src;
  const out = new Float32Array(n);
  if (Arr === BigInt64Array || Arr === BigUint64Array) { for (let i = 0; i < n; i++) out[i] = Number(src[i]); }
  else out.set(src);   // the others convert directly
  return out;
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


// ── webm-codecs.js (appended) ────────────────────────────────────────────
// Loader for the .webm + .webm.json sidecar volume format produced by
// nifti_to_webm.py (see webm-format.md): decodes via the native WebCodecs
// VideoDecoder API. (An earlier <video> + per-frame-seeking loader was
// removed: it was slow and never decoded reliably.) The exporter writes
// frames front-to-back along the coronal (Y) axis, with row0=superior and
// col0=anatomical Right, and records the *already-flipped* affine (Ab) in
// the sidecar to match - so Ab is used as-is with no further axis juggling.
//
// Needs a real demuxer, since WebCodecs itself only decodes already-
// demuxed chunks - it doesn't parse containers. Uses `mediabunny`
// (https://mediabunny.dev). Install with `npm install mediabunny`.
//
// Design:
//  - Decodes every packet in one linear pass (VideoDecoder.decode() per
//    packet; the `output` callback fires once each frame is ready) rather
//    than seeking to each frame individually - no keyframe is ever
//    decoded-from more than once. This assumes decode order matches
//    presentation order (true as long as the exporter doesn't use
//    B-frame/alt-ref reordering - nifti_to_webm.py's VP9 encode settings
//    explicitly disable that; libaom-av1's defaults do NOT and will
//    silently reorder unless -lag-in-frames 0 -auto-alt-ref 0 are set,
//    if AV1 is ever revisited here).
//  - Scalar (grayscale) volumes read each frame via its OWN NATIVE decoded
//    format (copyTo() with no `format` option) rather than requesting a
//    converting target format like RGBA. This matters: asking copyTo() to
//    *convert* to a target format was found to invoke real (and in
//    Firefox's case, buggy) colour-management/gamma handling in both
//    major engines, which was the root cause of a systematic darkening
//    bug in decoded pixel values. Reading the native format is a byte-
//    identical memcpy with no conversion step to go wrong. This does mean
//    handling whichever native format shows up - planar YUV-family
//    (I420/I422/I444/NV12/...) or packed RGB-family (RGBA/BGRX/...) -
//    see readByte() in handleFrame() below.
//  - The exporter (nifti_to_webm.py) writes scalar volumes as GBRP with
//    the real intensity data isolated into the GREEN channel only (red/
//    blue held constant at 0), not duplicated into all 3 channels - see
//    readByte()'s comment for why G specifically. GBRP has no chroma
//    subsampling or colour-matrix step at all, so it's immune to the
//    conversion-time bug above regardless of codec.
//  - DEC/colour (channels===3) volumes still use the old, converting
//    copyTo({format:'RGBA'}) path - untouched by the fix above, since
//    real colour data hasn't been confirmed to hit the same bug and a
//    proper fix would need a hand-rolled YUV->RGB matrix if the decoder
//    hands back genuinely subsampled planar colour.
//  - VideoFrame.copyTo() is ASYNC (returns Promise<PlaneLayout[]>), and
//    per spec/MDN, calling frame.close() before an in-flight copyTo()
//    resolves throws InvalidStateError. VideoDecoder's `output` callback
//    is not itself awaited by the decoder - it can fire again for the
//    next frame while a previous frame's copyTo() is still pending. This
//    implementation chains each frame's handling onto a running promise
//    so frames are read and closed strictly one at a time, avoiding any
//    overlap that could race on writing into the shared `data` array or
//    close a frame too early.

export function isWebCodecsVolumeDecodeSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export async function parseWebmCodecs(fileCombo) {
  if (!isWebCodecsVolumeDecodeSupported()) {
    throw new Error('WebCodecs (VideoDecoder) is not available in this browser.');
  }
  // Loaded lazily so browsers/builds that never call this function don't
  // pay for the dependency. Requires `npm install mediabunny` and a
  // bundler (or an import map) that can resolve the bare specifier.
  const { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } = await import('mediabunny');

  const { video: videoFile, sidecar: sidecarFile, name } = fileCombo;
  if (!sidecarFile) {
    throw new Error(`No .webm.json sidecar found for ${name} - cannot load without metadata.`);
  }
  const meta = JSON.parse(await sidecarFile.text());
  const { shape, channels, vox_mm, Ab, mn, mx, categorical } = meta;
  const [nx, ny, nz] = shape;
  const n = nx * ny * nz;
  const data = channels === 3 ? new Float32Array(n * 3) : new Float32Array(n);
  let mnOut = Infinity, mxOut = -Infinity;

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(videoFile) });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error(`No video track found in ${name}`);

  const decoderConfig = await videoTrack.getDecoderConfig();
  if (!decoderConfig) {
    throw new Error(
      `Could not get a WebCodecs decoder config for ${name} - the codec ` +
      `may be unsupported by this browser's VideoDecoder.`
    );
  }

  // Prefer software decode: this project's VP9/GBRP streams decode
  // correctly either way, but hardware-accelerated decode paths were the
  // source of a real, confirmed colour-conversion bug when this was tested
  // against AV1 - kept as a general safety preference.
  decoderConfig.hardwareAcceleration = 'prefer-software';

  const supportCheck = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!supportCheck.supported) {
    throw new Error(`VideoDecoder reports codec config for ${name} as unsupported ` +
      `(codec="${decoderConfig.codec}", hasDescription=${!!decoderConfig.description}).`);
  }

  let frameIndex = 0;      // next frame's Y-axis (front-to-back) index - see caveat above re: decode==presentation order
  let framesRead = 0;
  let sizeChecked = false;
  let firstError = null;
  let chain = Promise.resolve(); // serializes frame handling - see file header comment

  async function handleFrame(frame) {
    const f = frameIndex++;
    try {
      if (!sizeChecked) {
        sizeChecked = true;
        if (frame.codedWidth !== nx || frame.codedHeight !== nz) {
          console.warn(
            `WebM (codecs) frame size ${frame.codedWidth}x${frame.codedHeight} ` +
            `does not match sidecar shape (expected ${nx}x${nz} from nx,nz)`
          );
        }
      }
      if (f >= ny) {
        console.warn(`parseWebmCodecs: got more frames than expected (ny=${ny}), ignoring frame ${f}`);
        return;
      }

      // Read the frame's own native decoded format (no `format` option
      // passed to copyTo()) rather than converting to a target format -
      // see the file header comment for why.
      const nativeBuf = new Uint8Array(frame.allocationSize());
      const planes = await frame.copyTo(nativeBuf);
      const format = frame.format || '';
      // Scalar volumes are encoded as GBRP with the real intensity data
      // isolated into the GREEN channel only (red/blue constant 0) - see
      // nifti_to_webm.py. G specifically: cheapest to encode (confirmed
      // empirically - ~20% smaller than isolating into R or B, since G is
      // plane 0 in ffmpeg's own gbrp plane order and gets "luma-grade"
      // quantization), and conveniently always plane 0 on decode too.
      // Planar/semi-planar formats (I420, I422, I444, NV12, NV21, ...)
      // read plane 0 directly. Packed RGB-family formats (RGBA, RGBX,
      // BGRA, BGRX, ...) interleave 4 bytes/pixel; G is always the middle
      // channel regardless of R/B order, i.e. always byte offset +1.
      const isPacked = /^(RGB|BGR)/i.test(format);
      const { offset, stride } = planes[0];
      const bytesPerPixel = isPacked ? 4 : 1;
      function readByte(row, col) {
        const base = offset + row * stride + col * bytesPerPixel;
        return isPacked ? nativeBuf[base + 1] : nativeBuf[base];
      }

      if (channels === 3) {
        // DEC/colour volumes: NOT YET migrated off the explicit
        // copyTo({format:'RGBA'}) conversion path (still does a second,
        // separate copyTo() call here). The darkening bug this file was
        // rewritten around was only ever observed/investigated for
        // scalar/grayscale volumes - real colour data hasn't been tested
        // against it, and true colour source frames may come back from
        // the decoder as genuinely subsampled planar YUV (not just a
        // grayscale-in-disguise packed format), which the plane-0-only
        // readByte() helper above can't turn into real RGB by itself
        // (would need an actual YUV->RGB matrix applied by hand here,
        // not just a raw byte read). Left as-is - explicit TODO - rather
        // than risk silently breaking working DEC rendering to fix a bug
        // that hasn't been confirmed to affect it.
        const rgbaBuf = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
        const [{ offset: rgbaOffset, stride: rgbaStride }] = await frame.copyTo(rgbaBuf, { format: 'RGBA' });
        for (let row = 0; row < nz; row++) {
          for (let col = 0; col < nx; col++) {
            const pi = rgbaOffset + row * rgbaStride + col * 4;
            const r = rgbaBuf[pi] / 255, g = rgbaBuf[pi + 1] / 255, b = rgbaBuf[pi + 2] / 255;
            const idx = col + f * nx + row * nx * ny;
            data[idx * 3 + 0] = r; data[idx * 3 + 1] = g; data[idx * 3 + 2] = b;
            if (r < mnOut) mnOut = r; if (r > mxOut) mxOut = r;
            if (g < mnOut) mnOut = g; if (g > mxOut) mxOut = g;
            if (b < mnOut) mnOut = b; if (b > mxOut) mxOut = b;
          }
        }
      } else {
        // Grayscale: read the frame's native decoded byte directly - no
        // copyTo() format conversion, no colour-management/gamma step to
        // introduce the darkening bug this section was rewritten to fix.
        for (let row = 0; row < nz; row++) {
          for (let col = 0; col < nx; col++) {
            const u8 = readByte(row, col);
            const val = categorical ? u8 : (mn + (u8 / 255) * (mx - mn));
            const idx = col + f * nx + row * nx * ny;
            data[idx] = val;
            if (val < mnOut) mnOut = val; if (val > mxOut) mxOut = val;
          }
        }
      }
      framesRead++;
    } finally {
      frame.close();
    }
  }

  const decoder = new VideoDecoder({
    output(frame) {
      // Chain onto the running promise so frames are handled strictly in
      // the order `output` was called, one at a time - see file header.
      chain = chain.then(() => handleFrame(frame)).catch(e => {
        // Logged explicitly (name + message + full object) rather than
        // relying on however the devtools console chooses to display an
        // unhandled rejection - that display varies by browser/console
        // and can end up showing only the stack, with the actual error
        // name/message easy to miss or scroll past.
        console.error('parseWebmCodecs frame handling failed:', e && e.name, e && e.message, e);
        // Stashed on window as a fallback in case something upstream
        // (this app's own catch around loadAnat/dispatchOpenedFiles, or
        // the devtools console's own default formatting of a rejected
        // promise) ends up displaying only e.stack and dropping e.name/
        // e.message - inspect via `window.__lastWebCodecsError` directly
        // in the console, independent of any logging either layer does.
        try { window.__lastWebCodecsError = e; } catch { /* no window (non-browser) */ }
        firstError = firstError || e;
        try { frame.close(); } catch { /* already closed by handleFrame's finally */ }
      });
    },
    error(e) {
      firstError = firstError || e;
    },
  });
  decoder.configure(decoderConfig);

  const sink = new EncodedPacketSink(videoTrack);
  try {
    for await (const packet of sink.packets()) {
      if (firstError) break;
      decoder.decode(packet.toEncodedVideoChunk());
    }
    await decoder.flush();
  } catch (e) {
    // decoder.flush()/decode() reject/throw with whatever error the
    // decoder hit (e.g. a DOMException named 'EncodingError'), but
    // callers of parseWebmCodecs typically only log e.stack, which is
    // often empty/unhelpful for a DOMException. Log name/message
    // explicitly, and stash on window as a console-accessible fallback,
    // before rethrowing.
    console.error('parseWebmCodecs decode/flush failed:', e && e.name, e && e.message, e);
    try { window.__lastWebCodecsError = e; } catch { /* no window (non-browser) */ }
    throw e;
  }
  await chain; // wait for the last queued frame handler to finish
  decoder.close();

  if (firstError) {
    console.error('parseWebmCodecs firstError (from decoder.error callback or a frame handler):',
      firstError && firstError.name, firstError && firstError.message, firstError);
    try { window.__lastWebCodecsError = firstError; } catch { /* no window (non-browser) */ }
    throw firstError;
  }

  if (framesRead !== ny) {
    console.warn(`parseWebmCodecs: expected ${ny} frames from sidecar shape, captured ${framesRead}`);
  }

  const invAb = invertAffine(Ab);
  const decomp = decomposeAffineKSP(Ab, vox_mm);

  console.log('WebM volume (WebCodecs)', nx + '×' + ny + '×' + nz,
    channels === 3 ? 'colour (RGB)' : 'scalar', 'Ab', Ab);

  // Return the sidecar's mn/mx (the basis `data` was dequantized against:
  // mn + (u8/255)*(mx-mn), the inverse of the exporter's round(norm*255)),
  // not the observed mnOut/mxOut: the display renormalizes `data` with
  // whatever mn/mx is returned here, and lossy VP9 rarely reproduces the
  // exact global min/max, so the observed range would rescale every voxel
  // on a different basis. Categorical data is the exception: there the raw
  // pixel value IS `data`, so mnOut/mxOut is the self-consistent range.
  return {
    shape: [nx, ny, nz], vox_mm, Ab, invAb, decomp, data, channels,
    mn: categorical ? mnOut : mn,
    mx: categorical ? mxOut : mx,
  };
}
