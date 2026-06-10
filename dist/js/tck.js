// ── tck.js ────────────────────────────────────────────────
// MRtrix3 .tck parser. Returns { tracts: TypedArray[], tractForPoint: Int32Array }

function sysLE() {
  const t = new Uint16Array(1); t[0]=348;
  return new DataView(t.buffer).getUint16(0,true)===348;
}

function parseHeader(buf) {
  const text = new TextDecoder().decode(new Uint8Array(buf,0,Math.min(8192,buf.byteLength)));
  const lines = text.split('\n'); let h={}, key;
  if (!lines.shift().startsWith('mrtrix tracks')) throw 'Not a .tck file';
  for (const line of lines) {
    if (line.trim()==='END') break;
    const m = line.match(/([\w\d]+):\s?(.*)/);
    if (m) { key=m[1]; h[key]=m[2]; } else if (key) h[key]+='\n'+line;
  }
  return h;
}

export function parseTck(buf) {
  const header = parseHeader(buf);
  const byteOffset = parseInt(header.file.split(' ').pop());
  const m = header.datatype.match(/^([a-zA-Z]+)(\d+)([a-zA-Z]+)$/);
  if (!m) throw 'Bad TCK datatype';
  const bpe = parseInt(m[2])/8;
  const Dtype = bpe===4 ? Float32Array : Float64Array;
  const le = m[3]==='LE';
  let data;
  if (le===sysLE()) {
    data = byteOffset%bpe ? new Dtype(buf.slice(byteOffset)) : new Dtype(buf,byteOffset);
  } else {
    const len = (buf.byteLength-byteOffset)/bpe;
    data = new Dtype(len);
    const dv = new DataView(buf,byteOffset);
    const g = 'get'+Dtype.name.replace('Array','');
    for (let i=0;i<len;i++) data[i]=dv[g](i*bpe,le);
  }
  const tracts=[], tractForPoint=[];
  let iPrev=0;
  for (let i=0;i<data.length/3;i++) {
    const v=data[3*i];
    if (isNaN(v)||!isFinite(v)) {
      const len=i-iPrev;
      if (len>0) {
        const si=tracts.length;
        const off=data.byteOffset+3*iPrev*data.BYTES_PER_ELEMENT;
        tracts.push(new data.constructor(data.buffer,off,3*len));
        for (let k=0;k<len;k++) tractForPoint.push(si);
      }
      iPrev=i+1;
    }
  }
  return { tracts, tractForPoint: new Int32Array(tractForPoint) };
}
