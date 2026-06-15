// ── scene3d.js ────────────────────────────────────────────
// Three.js 3D scene: TrackballControls, glass brain, plane meshes,
// tractogram LineSegments helpers.

import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════
// TrackballControls (inlined — no npm dependency)
// ═══════════════════════════════════════════════════════════
const { EventDispatcher, Quaternion, Vector2, Vector3 } = THREE;

export class TrackballControls extends EventDispatcher {
  constructor(obj, el) {
    super();
    const sc = this;
    const S = { NONE: -1, ROTATE: 0, ZOOM: 1, PAN: 2 };
    this.object = obj; this.domElement = el; el.style.touchAction = 'none';
    this.enabled = true; this.screen = { left: 0, top: 0, width: 0, height: 0 };
    this.rotateSpeed = 2; this.zoomSpeed = 1.2; this.panSpeed = 0.5;
    this.staticMoving = true;
    this.target = new Vector3();
    const EPS = 1e-6, lp = new Vector3();
    let st = S.NONE;
    const eye = new Vector3(), mp = new Vector2(), mc = new Vector2(),
          la = new Vector3(), zs = new Vector2(), ze = new Vector2(),
          ps = new Vector2(), pe = new Vector2(), ptrs = [], ppos = {};
    this.target0 = this.target.clone(); this.position0 = obj.position.clone(); this.up0 = obj.up.clone();
    this.handleResize = () => {
      const b = el.getBoundingClientRect(), d = el.ownerDocument.documentElement;
      sc.screen = { left: b.left + pageXOffset - d.clientLeft, top: b.top + pageYOffset - d.clientTop, width: b.width, height: b.height };
    };
    const gmc = (px, py) => { const v = new Vector2(); v.set(((px - sc.screen.width * .5 - sc.screen.left) / (sc.screen.width * .5)), (sc.screen.height + 2 * (sc.screen.top - py)) / sc.screen.width); return v; };
    const gms = (px, py) => { const v = new Vector2(); v.set((px - sc.screen.left) / sc.screen.width, (py - sc.screen.top) / sc.screen.height); return v; };
    this.rotateCamera = (() => { const ax = new Vector3(), q = new Quaternion(), ed = new Vector3(), ou = new Vector3(), os = new Vector3(), md = new Vector3(); return () => { md.set(mc.x - mp.x, mc.y - mp.y, 0); let a = md.length(); if (a) { eye.copy(sc.object.position).sub(sc.target); ed.copy(eye).normalize(); ou.copy(sc.object.up).normalize(); os.crossVectors(ou, ed).normalize(); ou.setLength(mc.y - mp.y); os.setLength(mc.x - mp.x); md.copy(ou.add(os)); ax.crossVectors(md, eye).normalize(); a *= sc.rotateSpeed; q.setFromAxisAngle(ax, a); eye.applyQuaternion(q); sc.object.up.applyQuaternion(q); } mp.copy(mc); }; })();
    this.zoomCamera = () => { if (st !== S.ZOOM && st !== S.NONE) return; const f = 1 + (ze.y - zs.y) * sc.zoomSpeed; if (f !== 1 && f > 0) eye.multiplyScalar(f); if (sc.staticMoving) zs.copy(ze); };
    this.panCamera = (() => { const ch = new Vector2(), ou = new Vector3(), p = new Vector3(); return () => { ch.copy(pe).sub(ps); if (ch.lengthSq()) { ch.multiplyScalar(eye.length() * sc.panSpeed); p.copy(eye).cross(sc.object.up).setLength(ch.x); p.add(ou.copy(sc.object.up).setLength(-ch.y)); sc.object.position.add(p); sc.target.add(p); if (sc.staticMoving) ps.copy(pe); } }; })();

    // renderFn is injected by the caller so this module doesn't hold a reference to scene/camera
    this._renderFn = null;
    this.update = () => {
      eye.subVectors(sc.object.position, sc.target);
      sc.rotateCamera(); sc.zoomCamera(); sc.panCamera();
      sc.object.position.addVectors(sc.target, eye);
      sc.object.lookAt(sc.target);
      if (lp.distanceToSquared(sc.object.position) > EPS) lp.copy(sc.object.position);
      if (sc._renderFn) sc._renderFn();
    };
    const omd = e => { if (st === S.NONE) { if (e.button === 0) st = S.ROTATE; else if (e.button === 1) st = S.ZOOM; else if (e.button === 2) st = S.PAN; } if (st === S.ROTATE) { mc.copy(gmc(e.pageX, e.pageY)); mp.copy(mc); } else if (st === S.ZOOM) { zs.copy(gms(e.pageX, e.pageY)); ze.copy(zs); } else if (st === S.PAN) { ps.copy(gms(e.pageX, e.pageY)); pe.copy(ps); } sc.update(); };
    const omm = e => { if (st === S.ROTATE) { mp.copy(mc); mc.copy(gmc(e.pageX, e.pageY)); } else if (st === S.ZOOM) ze.copy(gms(e.pageX, e.pageY)); else if (st === S.PAN) pe.copy(gms(e.pageX, e.pageY)); sc.update(); };
    const omu = () => { st = S.NONE; sc.update(); };
    const omw = e => { if (!sc.enabled) return; e.preventDefault(); if (e.deltaMode === 2) zs.y -= e.deltaY * .025; else if (e.deltaMode === 1) zs.y -= e.deltaY * .01; else zs.y -= e.deltaY * .00025; sc.update(); };
    const opd = e => { if (!sc.enabled) return; if (ptrs.length === 0) { el.setPointerCapture(e.pointerId); el.addEventListener('pointermove', opm); el.addEventListener('pointerup', opu); } ptrs.push(e); if (e.pointerType === 'touch') { } else omd(e); };
    const opm = e => { if (!sc.enabled) return; if (e.pointerType !== 'touch') omm(e); };
    const opu = e => { if (!sc.enabled) return; omu(); ptrs.splice(ptrs.findIndex(p => p.pointerId === e.pointerId), 1); if (ptrs.length === 0) { el.releasePointerCapture(e.pointerId); el.removeEventListener('pointermove', opm); el.removeEventListener('pointerup', opu); } };
    el.addEventListener('contextmenu', e => { if (sc.enabled) e.preventDefault(); });
    el.addEventListener('pointerdown', opd);
    el.addEventListener('wheel', omw, { passive: false });
    this.handleResize(); this.update();
  }
}

// ═══════════════════════════════════════════════════════════
// Glass Brain — fullscreen-quad ray-caster
// ═══════════════════════════════════════════════════════════
const GLASS_VS = `
varying vec2 vNDC;
void main() {
  vNDC = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const GLASS_FS = `
precision highp float;
precision highp sampler3D;
uniform sampler3D u_vol;
uniform vec3  u_size;
uniform vec3  u_voxMm;
uniform float u_alpha;
uniform float u_thresh;
uniform float u_rimPow;
uniform float u_volDiagMm;
uniform int   u_steps;
uniform mat4  u_invPV;
uniform mat4  u_invModel;
uniform vec3  u_camPos;
varying vec2 vNDC;

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 tMin = (vec3(0.0) - ro) / rd;
  vec3 tMax = (u_size    - ro) / rd;
  vec3 t1 = min(tMin, tMax);
  vec3 t2 = max(tMin, tMax);
  return vec2(max(max(t1.x, t1.y), t1.z),
              min(min(t2.x, t2.y), t2.z));
}
float sampleVol(vec3 p) { return texture(u_vol, p / u_size).r; }
vec3 gradient(vec3 p) {
  vec3 e = vec3(1.0, 0.0, 0.0);
  return vec3(
    sampleVol(p+e.xyz) - sampleVol(p-e.xyz),
    sampleVol(p+e.zxy) - sampleVol(p-e.zxy),
    sampleVol(p+e.yzx) - sampleVol(p-e.yzx)
  );
}
void main() {
  vec4 near_w = u_invPV * vec4(vNDC, -1.0, 1.0);
  vec4 far_w  = u_invPV * vec4(vNDC,  1.0, 1.0);
  near_w /= near_w.w; far_w /= far_w.w;
  vec3 rd_world = normalize(far_w.xyz - near_w.xyz);
  vec3 ro = (u_invModel * vec4(u_camPos, 1.0)).xyz + u_size * 0.5;
  vec3 rd = normalize(mat3(u_invModel) * rd_world);
  vec2 hit = boxHit(ro, rd);
  if (hit.y < hit.x || hit.y < 0.0) discard;
  float tStart   = max(hit.x, 0.0);
  float tEnd     = hit.y;
  float stepSize = (tEnd - tStart) / float(u_steps);
  float mmPerStep = length(rd * u_voxMm) * stepSize;
  float accAlpha = 0.0;
  vec3  accColor = vec3(0.0);
  for (int i = 0; i < 256; i++) {
    if (i >= u_steps) break;
    float t = tStart + (float(i) + 0.5) * stepSize;
    vec3 p = ro + t * rd;
    float intensity = sampleVol(p);
    if (intensity < u_thresh) continue;
    vec3 grad = gradient(p);
    float gLen = length(grad);
    if (gLen < 0.0001) continue;
    float rim = 1.0 - abs(dot(grad / gLen, rd));
    rim = pow(rim, u_rimPow);
    float normStep = mmPerStep / u_volDiagMm;
    vec3  col = mix(vec3(0.25, 0.3, 0.35), vec3(0.75, 0.8, 0.85), intensity);
    float a   = clamp(rim * u_alpha * normStep, 0.0, 1.0);
    accColor += (1.0 - accAlpha) * a * col;
    accAlpha += (1.0 - accAlpha) * a;
    if (accAlpha > 0.95) break;
  }
  if (accAlpha < 0.002) discard;
  gl_FragColor = vec4(accColor, accAlpha);
}`;

export function buildGlassBrain(nii, texData, scene, renderer3, camera) {
  const tex = new THREE.Data3DTexture(texData, nii.nx, nii.ny, nii.nz);
  tex.format         = THREE.RedFormat;
  tex.type           = THREE.FloatType;
  tex.internalFormat = 'R32F';
  tex.minFilter      = THREE.LinearFilter;
  tex.magFilter      = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate    = true;

  const A  = nii.Ab;
  const hx = nii.nx / 2, hy = nii.ny / 2, hz = nii.nz / 2;
  const tx = A[0][0]*hx + A[0][1]*hy + A[0][2]*hz + A[3][0];
  const ty = A[1][0]*hx + A[1][1]*hy + A[1][2]*hz + A[3][1];
  const tz = A[2][0]*hx + A[2][1]*hy + A[2][2]*hz + A[3][2];
  const modelMatrix = new THREE.Matrix4().set(
    A[0][0], A[0][1], A[0][2], tx,
    A[1][0], A[1][1], A[1][2], ty,
    A[2][0], A[2][1], A[2][2], tz,
          0,       0,       0,  1
  );
  const invModel = modelMatrix.clone().invert();

  const mat = new THREE.ShaderMaterial({
    vertexShader:   GLASS_VS,
    fragmentShader: GLASS_FS,
    uniforms: {
      u_vol:       { value: tex },
      u_size:      { value: new THREE.Vector3(nii.nx, nii.ny, nii.nz) },
      u_voxMm:     { value: new THREE.Vector3(nii.pixdim[1], nii.pixdim[2], nii.pixdim[3]) },
      u_volDiagMm: { value: Math.sqrt(
                       (nii.nx * nii.pixdim[1])**2 +
                       (nii.ny * nii.pixdim[2])**2 +
                       (nii.nz * nii.pixdim[3])**2) },
      u_alpha:     { value: 5.0 },
      u_thresh:    { value: 0.15 },
      u_rimPow:    { value: 1.0 },
      u_steps:     { value: 150 },
      u_invPV:     { value: new THREE.Matrix4() },
      u_invModel:  { value: invModel },
      u_camPos:    { value: new THREE.Vector3() },
    },
    transparent: true,
    depthWrite:  false,
    depthTest:   false,
  });

  const geo  = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder   = 999;

  const _pv = new THREE.Matrix4();
  mesh.onBeforeRender = (renderer, scene, cam) => {
    _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    mat.uniforms.u_invPV.value.copy(_pv).invert();
    mat.uniforms.u_camPos.value.copy(cam.position);
  };

  scene.add(mesh);
  renderer3.render(scene, camera); // initial compile — forces shader errors to surface now
  if (renderer3.getContext().getError()) console.error('Glass brain: WebGL error after first render');
  return mesh;
}

// ═══════════════════════════════════════════════════════════
// Plane mesh helpers
// ═══════════════════════════════════════════════════════════
const PLANE_COLORS = { sag: 0x3af8cc, cor: 0xf8a03a, axi: 0xa03af8 };

export function makePlaneMesh(planeKey, vr, viewCentre) {
  const pc = vr.getPlaneCorners(planeKey, viewCentre);
  if (!pc) return null;
  const [BL, BR, TR, TL] = pc;
  const verts = new Float32Array([...BL, ...BR, ...TR, ...BL, ...TR, ...TL]);
  const geo   = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  const col  = PLANE_COLORS[planeKey];
  const fill = new THREE.Mesh(geo,
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.08,
      side: THREE.DoubleSide, depthWrite: false }));
  const borderPts = new Float32Array([...BL, ...BR, ...TR, ...TL, ...BL]);
  const borderGeo = new THREE.BufferGeometry();
  borderGeo.setAttribute('position', new THREE.BufferAttribute(borderPts, 3));
  const border = new THREE.Line(borderGeo,
    new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.7 }));
  const group = new THREE.Group();
  group.add(fill); group.add(border);
  return group;
}

// ═══════════════════════════════════════════════════════════
// Tractogram geometry helpers
// ═══════════════════════════════════════════════════════════


export function makeLineSegments(tracts) {
  let tv = 0;
  for (const t of tracts) { const n = t.length / 3; if (n >= 2) tv += 2 * (n - 1); }
  const pos          = new Float32Array(tv * 3);
  const col          = new Float32Array(tv * 3);
  let vi = 0;
  for (let si = 0; si < tracts.length; si++) {
    const t = tracts[si];
    const n = t.length / 3; if (n < 2) continue;
    for (let i = 0; i < n - 1; i++) {
      const x0 = t[3*i], y0 = t[3*i+1], z0 = t[3*i+2];
      const x1 = t[3*i+3], y1 = t[3*i+4], z1 = t[3*i+5];
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), dz = Math.abs(z1 - z0);
      const dl = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      pos[3*vi] = x0; pos[3*vi+1] = y0; pos[3*vi+2] = z0;
      pos[3*vi+3] = x1; pos[3*vi+4] = y1; pos[3*vi+5] = z1;
      col[3*vi] = col[3*vi+3] = dx / dl;
      col[3*vi+1] = col[3*vi+4] = dy / dl;
      col[3*vi+2] = col[3*vi+5] = dz / dl;
      vi += 2;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',     new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',        new THREE.BufferAttribute(col, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
}

// ── Dot shaders — used both by slab-renderer and for 3D scene dots ─────────
export const DOTS_VS = `
varying vec3  vColor;
varying float vSignedDist;
uniform vec3  u_sliceNormal;
uniform vec3  u_slicePt;
uniform float u_pointSize;
attribute vec3 color;
void main() {
  vColor = color;
  vSignedDist = dot(position - u_slicePt, u_sliceNormal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = u_pointSize;
}`;

export const DOTS_FS = `
precision highp float;
varying vec3  vColor;
varying float vSignedDist;
uniform float u_slabHalf;
uniform int   u_autoColor;
uniform vec3  u_dotColor;
void main() {
  float r = length(gl_PointCoord - vec2(0.5));
  float alpha = 1.0 - smoothstep(0.35, 0.5, r);
  if (alpha <= 0.0) discard;
  float d = vSignedDist;
  vec3 col = (u_autoColor > 0) ? vColor : u_dotColor;
  #ifdef NEAR_PASS
    if (d < 0.0 || d > u_slabHalf) discard;
    gl_FragColor = vec4(col, alpha);
  #endif
  #ifdef FAR_PASS
    if (d >= 0.0 || d < -u_slabHalf) discard;
    gl_FragColor = vec4(col * 0.7, alpha);
  #endif
  #ifdef FULL_PASS
    gl_FragColor = vec4(col, alpha);
  #endif
}`;

// ShaderMaterial for 3D scene dots (no slab clipping, full-pass).
export function makeDotsMaterial3d(endsPx = 6) {
  return new THREE.ShaderMaterial({
    vertexShader:   DOTS_VS,
    fragmentShader: DOTS_FS,
    uniforms: {
      u_sliceNormal: { value: new THREE.Vector3(0, 0, 1) },
      u_slicePt:     { value: new THREE.Vector3(0, 0, 0) },
      u_slabHalf:    { value: 1e9 },
      u_autoColor:   { value: 1 },
      u_dotColor:    { value: new THREE.Vector3(1, 1, 0.8) },
      u_pointSize:   { value: endsPx },
    },
    defines:     { FULL_PASS: 1 },
    depthWrite:  false,
    depthTest:   true,
    transparent: true,
  });
}

// Endpoint dots — builds src (closest to cursor) and tgt (farthest) geometries in one pass.
//
// probedEnds: Uint8Array per-tract, or null (pass-through mode).
//   0 = start was probed  → src=start, tgt=end
//   1 = end was probed    → src=end,   tgt=start
//   2 = both probed       → both go to src, nothing to tgt
//   null (pass-through)   → assign by Euclidean distance to cursor
//
// cursor: [cx,cy,cz] RAS mm.
// endsPx: dot screen size.
// Returns { src: THREE.Points, tgt: THREE.Points }
export function makeEndpointDots(tracts, probedEnds, cursor, endsPx = 6) {
  const n = tracts.length;
  const srcPos = new Float32Array(n * 6), srcCol = new Float32Array(n * 6);
  const tgtPos = new Float32Array(n * 6), tgtCol = new Float32Array(n * 6);
  let si = 0, ti = 0;

  const [cx, cy, cz] = cursor || [0, 0, 0];

  const dirCol = (ax, ay, az, bx, by, bz) => {
    const dx = Math.abs(bx-ax), dy = Math.abs(by-ay), dz = Math.abs(bz-az);
    const dl = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1;
    return [dx/dl, dy/dl, dz/dl];
  };

  for (let i = 0; i < n; i++) {
    const t = tracts[i];
    if (t.length < 6) continue;
    const np = t.length / 3;

    const sx = t[0], sy = t[1], sz = t[2];
    const ex = t[3*(np-1)], ey = t[3*(np-1)+1], ez = t[3*(np-1)+2];
    const sCol = dirCol(sx, sy, sz, t[3], t[4], t[5]);
    const eCol = dirCol(t[3*(np-2)], t[3*(np-2)+1], t[3*(np-2)+2], ex, ey, ez);

    const addSrc = (px, py, pz, c) => {
      srcPos[si*3]=px; srcPos[si*3+1]=py; srcPos[si*3+2]=pz;
      srcCol[si*3]=c[0]; srcCol[si*3+1]=c[1]; srcCol[si*3+2]=c[2]; si++;
    };
    const addTgt = (px, py, pz, c) => {
      tgtPos[ti*3]=px; tgtPos[ti*3+1]=py; tgtPos[ti*3+2]=pz;
      tgtCol[ti*3]=c[0]; tgtCol[ti*3+1]=c[1]; tgtCol[ti*3+2]=c[2]; ti++;
    };

    if (probedEnds) {
      const flag = probedEnds[i];
      if      (flag === 0) { addSrc(sx,sy,sz,sCol); addTgt(ex,ey,ez,eCol); }
      else if (flag === 1) { addSrc(ex,ey,ez,eCol); addTgt(sx,sy,sz,sCol); }
      else                 { addSrc(sx,sy,sz,sCol); addSrc(ex,ey,ez,eCol); }
    } else {
      const ds2 = (sx-cx)**2 + (sy-cy)**2 + (sz-cz)**2;
      const de2 = (ex-cx)**2 + (ey-cy)**2 + (ez-cz)**2;
      if (ds2 <= de2) { addSrc(sx,sy,sz,sCol); addTgt(ex,ey,ez,eCol); }
      else            { addSrc(ex,ey,ez,eCol); addTgt(sx,sy,sz,sCol); }
    }
  }

  /*const makePoints = (pos, col, count) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, count*3), 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col.slice(0, count*3), 3));
    return new THREE.Points(geo, makeDotsMaterial3d(endsPx));
  };*/
  const makePoints = (pos, col, count) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, count*3), 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col.slice(0, count*3), 3));
    return new THREE.Points(geo, makeDotsMaterial3d(endsPx * window.devicePixelRatio));
  };

  return {
    src: makePoints(srcPos, srcCol, si),
    tgt: makePoints(tgtPos, tgtCol, ti),
  };
}
