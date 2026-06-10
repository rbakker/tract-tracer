// ── grid-index.js ─────────────────────────────────────────
// Flat-array grid spatial index for fast radius queries on point clouds.

export class GridIndex {
  constructor(ptsRaw, cellSize) {
    this.pts = (ptsRaw instanceof Float32Array)
      ? ptsRaw
      : new Float32Array(Array.from(ptsRaw).map(Number));
    const pts = this.pts;
    this.cs = +cellSize;
    let mnx=Infinity, mny=Infinity, mnz=Infinity;
    let mxx=-Infinity, mxy=-Infinity, mxz=-Infinity;
    for (let i=0;i<pts.length;i+=3) {
      const x=pts[i],y=pts[i+1],z=pts[i+2];
      if(x<mnx)mnx=x; if(x>mxx)mxx=x;
      if(y<mny)mny=y; if(y>mxy)mxy=y;
      if(z<mnz)mnz=z; if(z>mxz)mxz=z;
    }
    this.min = [mnx,mny,mnz];
    const cs=cellSize;
    this.dims = [
      Math.ceil((mxx-mnx)/cs)+1,
      Math.ceil((mxy-mny)/cs)+1,
      Math.ceil((mxz-mnz)/cs)+1
    ];
    const D=this.dims, n=pts.length/3;
    const ncells=D[0]*D[1]*D[2];
    const count=new Int32Array(ncells);
    for (let i=0;i<n;i++) {
      const cx=Math.floor((pts[3*i  ]-mnx)/cs);
      const cy=Math.floor((pts[3*i+1]-mny)/cs);
      const cz=Math.floor((pts[3*i+2]-mnz)/cs);
      count[cx + cy*D[0] + cz*D[0]*D[1]]++;
    }
    const starts=new Int32Array(ncells+1);
    for (let i=0;i<ncells;i++) starts[i+1]=starts[i]+count[i];
    this.starts=starts;
    this.ptIdx=new Int32Array(n);
    const cur=new Int32Array(ncells);
    for (let i=0;i<n;i++) {
      const cx=Math.floor((pts[3*i  ]-mnx)/cs);
      const cy=Math.floor((pts[3*i+1]-mny)/cs);
      const cz=Math.floor((pts[3*i+2]-mnz)/cs);
      const cell=cx + cy*D[0] + cz*D[0]*D[1];
      this.ptIdx[starts[cell]+cur[cell]++]=i;
    }
  }

  queryRadius(qx,qy,qz,r) {
    const cs=this.cs, mn=this.min, D=this.dims, pts=this.pts;
    const starts=this.starts, ptIdx=this.ptIdx, r2=r*r;
    const x0=Math.max(0,Math.floor((qx-r-mn[0])/cs));
    const x1=Math.min(D[0]-1,Math.floor((qx+r-mn[0])/cs));
    const y0=Math.max(0,Math.floor((qy-r-mn[1])/cs));
    const y1=Math.min(D[1]-1,Math.floor((qy+r-mn[1])/cs));
    const z0=Math.max(0,Math.floor((qz-r-mn[2])/cs));
    const z1=Math.min(D[2]-1,Math.floor((qz+r-mn[2])/cs));
    const found=[];
    if (x0>x1||y0>y1||z0>z1) return found;
    for (let cx=x0;cx<=x1;cx++)
    for (let cy=y0;cy<=y1;cy++)
    for (let cz=z0;cz<=z1;cz++) {
      const cell=cx + cy*D[0] + cz*D[0]*D[1];
      const s=starts[cell], e=starts[cell+1];
      for (let k=s;k<e;k++) {
        const pi=ptIdx[k];
        const dx=pts[3*pi]-qx, dy=pts[3*pi+1]-qy, dz=pts[3*pi+2]-qz;
        if (dx*dx+dy*dy+dz*dz<=r2) found.push(pi);
      }
    }
    return found;
  }
}
