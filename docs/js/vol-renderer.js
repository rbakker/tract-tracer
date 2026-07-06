// ── vol-renderer.js ───────────────────────────────────────
// WebGL2 3D-texture volume renderer.

import { eulerToMat3, absVec, mat3mulVec } from './affine.js';

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos*0.5+0.5;
  gl_Position = vec4(a_pos,0,1);
}`;

const FS_SLICE = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D u_vol;
uniform vec3  u_origin;
uniform vec3  u_axisU;
uniform vec3  u_axisV;
uniform vec2  u_window;
uniform vec3  u_chColorH;
uniform vec3  u_chColorV;
uniform float u_wH;
uniform float u_wV;
uniform vec2  u_crosshair;
uniform vec2  u_res;
uniform float u_probeRadius;
uniform vec3 u_probeColor;
in  vec2 v_uv;
out vec4 fragColor;
void main(){
  vec2 px = v_uv * u_res;
  vec2 cp = u_crosshair * u_res;
  vec2 dp = abs(px - cp);
  float gap = 8.0;

  // Cursor geometry (independent of volume)
  float chH = smoothstep(1.5, 0.5, dp.x) * step(gap, dp.y);
  float chV = smoothstep(1.5, 0.5, dp.y) * step(gap, dp.x);
  float onLeftEdge   = smoothstep(1.5, 0.5, px.x - 1.0);
  float onRightEdge  = smoothstep(1.5, 0.5, u_res.x - 1.0 - px.x);
  float onTopEdge    = smoothstep(1.5, 0.5, px.y - 1.0);
  float onBottomEdge = smoothstep(1.5, 0.5, u_res.y - 1.0 - px.y);
  float capV = (onLeftEdge + onRightEdge) * step(dp.y, u_wV);
  float capH = (onTopEdge + onBottomEdge) * step(dp.x, u_wH);

  // Volume sample
  vec3 tc = u_origin + v_uv.x*u_axisU + v_uv.y*u_axisV;
  bool inVol = !any(lessThan(tc,vec3(0.0))) && !any(greaterThan(tc,vec3(1.0)));
  float raw = inVol ? texture(u_vol, tc).r : 0.0;
  float v   = clamp((raw - u_window.x)/u_window.y, 0.0, 1.0);
  vec3 col  = inVol ? vec3(v) : vec3(0.0);

  col = mix(col, u_chColorH, clamp(chH + capH, 0.0, 1.0) * 0.9);
  col = mix(col, u_chColorV, clamp(chV + capV, 0.0, 1.0) * 0.9);

  float dist = length(px - cp);
  float ring = (u_probeRadius < 0.0) ? 0.0 : smoothstep(1.5, 0.0, abs(dist - u_probeRadius));
  col = mix(col, u_probeColor, ring * 0.9);
  fragColor = vec4(col, 1);
}`;

export class VolRenderer {
  constructor() {
    this._glCanvas = document.createElement('canvas');
    const gl = this._glCanvas.getContext('webgl2', {preserveDrawingBuffer:true});
    if (!gl) throw 'WebGL2 not available';
    this.gl = gl;
    this._texture = null;
    this._anat = null;
    this._prog = this._buildProgram(VS, FS_SLICE);
    this._quad = this._buildQuad();
    this._rot = [[1,0,0],[0,1,0],[0,0,1]];
    this._rot_dirs = [
       [1,0,0],
       [0,1,0],
       [0,0,1]
    ]
    this._ras_extent = null
    this._wmin = 0;
    this._wmax = 1;
    // Cached plane params per planeKey for click→RAS mapping
    // { cursor_ras, stepU_ras, stepV_ras, W, H }
    // stepU_ras = RAS mm displacement per pixel in U direction
    // stepV_ras = RAS mm displacement per pixel in V direction
    this._planeParams = {};
  }

  upload(anat) {
	const shape = [anat.shape[0],anat.shape[1],anat.shape[2]]
	const shape_ras = absVec(mat3mulVec(anat.decomp.P,shape));
    this._ras_extent = mat3mulVec(anat.decomp.S,shape_ras);
    this._sharedMmPerPx = {a:null,b:null};
    this._wmin=0; 
    this._wmax=1;

    const gl = this.gl;
    this._anat = anat;
    const n = shape[0]*shape[1]*shape[2];
    const mn=anat.mn, range=(anat.mx-anat.mn)||1;

    const maxSz = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    if (shape[0]>maxSz||shape[1]>maxSz||shape[2]>maxSz)
      throw `Volume exceeds MAX_3D_TEXTURE_SIZE=${maxSz}`;

    if (this._texture) gl.deleteTexture(this._texture);
    this._texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this._texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const texData = new Float32Array(n);
    for (let i=0;i<n;i++){
      const v=(anat.data[i]-mn)/range;
      texData[i]=isFinite(v)?v:0;  // NaN/Inf → 0 (no contribution to glass brain)
    }
    this.texData = texData;

    const ext = gl.getExtension('OES_texture_float_linear');
    const fmt = ext ? gl.R32F : gl.R16F;
    gl.texImage3D(gl.TEXTURE_3D, 0, fmt,
      shape[0],shape[1],shape[2], 0, gl.RED, gl.FLOAT, texData);
    gl.bindTexture(gl.TEXTURE_3D, null);
    console.log('3D texture', ext?'R32F':'R16F',
      shape[0]+'×'+shape[1]+'×'+shape[2],
      '~'+((n*(ext?4:2))/1024/1024).toFixed(0)+' MB'); 
  }

  setRotation(pitch, yaw, roll) {
	const R = eulerToMat3(pitch, yaw, roll);
    this._rot = R; 
    this._rot_dirs = [
      mat3mulVec(R, [1,0,0]),
      mat3mulVec(R, [0,1,0]),
      mat3mulVec(R, [0,0,1])
    ]
  }

  setProbeRadius(px){ this._probeRadiusPx = px; }

  setWindow(wmin, wmax) { this._wmin=wmin; this._wmax=wmax; }
 
  // ── renderSlice ────────────────────────────────────────
  // Renders an oblique slice centred on cursor (RAS mm).
  // All geometry is computed in RAS mm space, then converted to
  // texture coords only for the shader uniform.
  renderSlice(canvas2d, planeKey, viewCentre, cursor, chColorH, chColorV, wH, wV, probeColor, tag='src', zoom=1.0, probeRadius=null) {
    if (!this._texture||!this._anat) return null;
    const anat=this._anat, gl=this.gl;
    const W=canvas2d.width, H=canvas2d.height;
    if (W<=0||H<=0) return null;

    this._glCanvas.width=W; this._glCanvas.height=H;
    gl.viewport(0,0,W,H);

    // ── Step 1: get plane axes for this affine orientation ──
    const [uAx,vAx] = this._getPlaneAxes(planeKey);
    const u_dir = this._rot_dirs[uAx];
    const v_dir = this._rot_dirs[vAx];

    // ── Step 2: mm_per_px ───────────────────────────────
    // All three planes share the same mm_per_px, derived from the SAG slice.
    // This keeps a consistent physical scale across panels so structures
    // appear the same size in all views.
    // SAG axes are [1,2] = A-P × I-S — a portrait brain in a portrait panel,
    // so its letterbox fit is the tightest and most meaningful reference.
    // COR and AXI simply use the SAG-derived value stored from the last SAG render.
    if (!this._sharedMmPerPx[tag]) {
      const u_extent = this._ras_extent[uAx];
      const v_extent = this._ras_extent[vAx];
      const physAR = u_extent / v_extent;
      const canvAR = W / H;
      this._sharedMmPerPx[tag] = canvAR > physAR ? v_extent / H : u_extent / W;
    }
    const mm_per_px = (this._sharedMmPerPx[tag] || (this._ras_extent[vAx] / H)) / zoom;
    const halfU = mm_per_px * W / 2;
    const halfV = mm_per_px * H / 2;

    // ── Step 4: RAS corners → texture coords ───────────
    // U_ras = left→right (+R/+A), V_ras = bottom→top (+A/+S, anatomical up)
    // WebGL v_uv.y=0 at bottom, 1 at top — matches V_hat direction naturally.
    // No drawImage flip needed.
    const cx=viewCentre[0], cy=viewCentre[1], cz=viewCentre[2];

    const rasToTex = (r) => {
      const [vx,vy,vz] = mat3mulVec(anat.invAb, r);
      return [(vx+0.5)/anat.shape[0], (vy+0.5)/anat.shape[1], (vz+0.5)/anat.shape[2]];
    };
    // BL = bottom-left = cursor - effU*U + effV*-V (left, inferior)
    // BR = bottom-right = cursor + effU*U - effV*V
    // TL = top-left  = cursor - effU*U + effV*V
    const BL_ras = [cx - u_dir[0]*halfU - v_dir[0]*halfV,
                    cy - u_dir[1]*halfU - v_dir[1]*halfV,
                    cz - u_dir[2]*halfU - v_dir[2]*halfV];
    const BR_ras = [cx + u_dir[0]*halfU - v_dir[0]*halfV,
                    cy + u_dir[1]*halfU - v_dir[1]*halfV,
                    cz + u_dir[2]*halfU - v_dir[2]*halfV];
    const TL_ras = [cx - u_dir[0]*halfU + v_dir[0]*halfV,
                    cy - u_dir[1]*halfU + v_dir[1]*halfV,
                    cz - u_dir[2]*halfU + v_dir[2]*halfV];
    const BL_tex = rasToTex(BL_ras);
    const BR_tex = rasToTex(BR_ras);
    const TL_tex = rasToTex(TL_ras);
    const origin_tex = BL_tex;
    const axisU_tex  = [BR_tex[0]-BL_tex[0], BR_tex[1]-BL_tex[1], BR_tex[2]-BL_tex[2]];
    const axisV_tex  = [TL_tex[0]-BL_tex[0], TL_tex[1]-BL_tex[1], TL_tex[2]-BL_tex[2]];

    // ── Step 5: draw ────────────────────────────────────
    gl.useProgram(this._prog);
    gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this._texture);
    gl.uniform1i( gl.getUniformLocation(this._prog,'u_vol'),    0);
    gl.uniform3fv(gl.getUniformLocation(this._prog,'u_origin'), origin_tex);
    gl.uniform3fv(gl.getUniformLocation(this._prog,'u_axisU'),  axisU_tex);
    gl.uniform3fv(gl.getUniformLocation(this._prog,'u_axisV'),  axisV_tex);
    gl.uniform2fv(gl.getUniformLocation(this._prog,'u_window'), [this._wmin, this._wmax-this._wmin]);
    // Crosshair: project cursor onto slice plane
    const chDx=cursor[0]-cx,chDy=cursor[1]-cy,chDz=cursor[2]-cz;
    const chU=chDx*u_dir[0]+chDy*u_dir[1]+chDz*u_dir[2];
    const chV=chDx*v_dir[0]+chDy*v_dir[1]+chDz*v_dir[2];
    gl.uniform2fv(gl.getUniformLocation(this._prog,'u_crosshair'),[0.5+chU/(2*halfU), 0.5+chV/(2*halfV)]);
    gl.uniform2fv(gl.getUniformLocation(this._prog,'u_res'),[W,H]);
    gl.uniform1f(gl.getUniformLocation(this._prog,'u_probeRadius'),
      probeRadius !== null ? probeRadius : (this._probeRadiusPx||0));
    gl.uniform3fv(gl.getUniformLocation(this._prog, 'u_probeColor'), probeColor);
    gl.uniform3fv(gl.getUniformLocation(this._prog,'u_chColorH'),chColorH);
    gl.uniform3fv(gl.getUniformLocation(this._prog,'u_chColorV'),chColorV);
    gl.uniform1f(gl.getUniformLocation(this._prog,'u_wH'), wH);
    gl.uniform1f(gl.getUniformLocation(this._prog,'u_wV'), wV);
    gl.bindVertexArray(this._quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // drawImage(img, sx,sy,sw,sh, dx,dy,dw,dh): source top-to-bottom, dest bottom-to-top
    canvas2d.getContext('2d').drawImage(this._glCanvas, 0, 0, W, H);

    // ── Step 6: cache plane params for click→RAS ────────
    this._planeParams[planeKey+tag] = {
      viewCentre_ras: viewCentre,
      cursor_ras: cursor,
      u_dir, v_dir,
      uAx, vAx,
      W, H,
      mm_per_px,   // RAS mm per canvas pixel (uniform in both axes)
    };
    return this._planeParams[planeKey];
  }

  // Convert canvas pixel (ex,ey) to RAS mm using cached plane params.
  canvasToRas(planeKey, ex, ey, tag='src') {
    const p = this._planeParams[planeKey+tag];
    if (!p) return null;
    // fu, fv: signed mm from the view centre along U and V
    const fu = (ex/p.W - 0.5) * p.mm_per_px * p.W;
    const fv = (0.5 - ey/p.H) * p.mm_per_px * p.H;   // y flipped
    const u_dir = this._rot_dirs[p.uAx];
    const v_dir = this._rot_dirs[p.vAx];
    return [
      p.viewCentre_ras[0] + fu*u_dir[0] + fv*v_dir[0],
      p.viewCentre_ras[1] + fu*u_dir[1] + fv*v_dir[1],
      p.viewCentre_ras[2] + fu*u_dir[2] + fv*v_dir[2]
    ];
  }

  // panDelta: returns new cursor_ras so anatomy under (x0,y0) moves to (x1,y1)
  /*panDelta(planeKey, x0, y0, x1, y1, tag='a') {
    const p = this._planeParams[planeKey+tag];
    if (!p) return null;
    const dU = ((x1-x0)/p.W) * this._ras_extent[p.uAx];
    const dV = -((y1-y0)/p.H) * this._ras_extent[p.vAx];
    const u_dir = this._rot_dirs[p.uAx];
    const v_dir = this._rot_dirs[p.vAx];    
    return [
      p.viewCentre_ras[0] - dU*u_dir[0] - dV*v_dir[0],
      p.viewCentre_ras[1] - dU*u_dir[1] - dV*v_dir[1],
      p.viewCentre_ras[2] - dU*u_dir[2] - dV*v_dir[2],
    ];
  }*/

  // Convert RAS mm to canvas pixel using cached plane params.
  // Return the 4 RAS corners of a slice plane, using the same axis logic as renderSlice.
  // viewCentre: RAS mm centre of the plane.
  // Returns { [[x,y,z],..4] }
  getPlaneCorners(planeKey, viewCentre) {
    if (!this._anat) return null;
    const [uAx,vAx] = this._getPlaneAxes(planeKey);
    const u_dir = this._rot_dirs[uAx];
    const v_dir = this._rot_dirs[vAx];    
    
    //const R = this._rot;
    //const rot3=(m,v)=>[m[0][0]*v[0]+m[0][1]*v[1]+m[0][2]*v[2],
    //                  m[1][0]*v[0]+m[1][1]*v[1]+m[1][2]*v[2],
    //                  m[2][0]*v[0]+m[2][1]*v[1]+m[2][2]*v[2]];
    //const norm=v=>{const l=Math.sqrt(v[0]**2+v[1]**2+v[2]**2)||1;return[v[0]/l,v[1]/l,v[2]/l];};
    //const Uh=norm(rot3(R,ax.U_ras)), Vh=norm(rot3(R,ax.V_ras));
    const hU=this._ras_extent[uAx]/2, hV=this._ras_extent[vAx]/2;
    const cx=viewCentre[0],cy=viewCentre[1],cz=viewCentre[2];
    return [
      [cx-u_dir[0]*hU-v_dir[0]*hV, cy-u_dir[1]*hU-v_dir[1]*hV, cz-u_dir[2]*hU-v_dir[2]*hV],  // BL
      [cx+u_dir[0]*hU-v_dir[0]*hV, cy+u_dir[1]*hU-v_dir[1]*hV, cz+u_dir[2]*hU-v_dir[2]*hV],  // BR
      [cx+u_dir[0]*hU+v_dir[0]*hV, cy+u_dir[1]*hU+v_dir[1]*hV, cz+u_dir[2]*hU+v_dir[2]*hV],  // TR
      [cx-u_dir[0]*hU+v_dir[0]*hV, cy-u_dir[1]*hU+v_dir[1]*hV, cz-u_dir[2]*hU+v_dir[2]*hV],  // TL
    ];
  }

  rasToCanvas(planeKey, rx, ry, rz, tag='src') {
    const p = this._planeParams[planeKey+tag];
    if (!p) return null;
    const dx=rx-p.viewCentre_ras[0], dy=ry-p.viewCentre_ras[1], dz=rz-p.viewCentre_ras[2];
    const fu = dx*p.u_dir[0] + dy*p.u_dir[1] + dz*p.u_dir[2];  // mm along U
    const fv = dx*p.v_dir[0] + dy*p.v_dir[1] + dz*p.v_dir[2];  // mm along V
    const ex = (fu / p.mm_per_px + p.W/2);
    const ey = (p.H/2 - fv / p.mm_per_px);   // y flipped
    return [ex, ey];
  }

  _buildProgram(vsrc,fsrc){
    const gl=this.gl;
    const compile=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw 'Shader: '+gl.getShaderInfoLog(s);return s;};
    const p=gl.createProgram();
    gl.attachShader(p,compile(gl.VERTEX_SHADER,vsrc));
    gl.attachShader(p,compile(gl.FRAGMENT_SHADER,fsrc));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw 'Link: '+gl.getProgramInfoLog(p);
    return p;
  }

  // Map SAG/COR/AXI to U and V axes in ras space.
  _getNormalAxis(planeKey) {
	return ['sag','cor','axi'].indexOf(planeKey);
  }

  _getPlaneAxes(planeKey) {
    const axes = [0,1,2].toSpliced(this._getNormalAxis(planeKey),1);
    // AXI: default would be [0,1] = R-L horizontal, A-P vertical.
    // Swap to [1,0] so A-P runs vertically (matching SAG), R-L horizontally.
    // This keeps the portrait layout consistent across all three panels.
    if (planeKey === 'axi') return [axes[1], axes[0]];
    return axes;
  }

  _buildQuad(){
    const gl=this.gl;
    const vao=gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    const loc=gl.getAttribLocation(this._prog,'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    gl.bindVertexArray(null);
    return vao;
  }
}
