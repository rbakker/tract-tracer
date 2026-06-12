// ── slab-renderer.js ──────────────────────────────────────
// GPU slab overlay renderer for 2D slice canvases.
// Renders selected tractogram streamlines within a slab around a slice plane,
// composited on top of the anatomy slice.

import * as THREE from 'three';

const SLAB_VS = `
varying vec3  vColor;
varying float vSignedDist;
varying float vEndDist;

attribute vec3  color;
attribute float arcFromStart;
attribute float arcFromEnd;
attribute float probedFlag;

uniform vec3  u_sliceNormal;
uniform vec3  u_slicePt;
uniform float u_endsFlip;

void main() {
  vColor = color;

  vec3 pos = position;
  vSignedDist = dot(pos - u_slicePt, u_sliceNormal);

  vEndDist = (u_endsFlip > 0.5) ? arcFromEnd : arcFromStart;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`;

const SLAB_FS = `
precision highp float;

varying vec3  vColor;
varying float vSignedDist;
varying float vEndDist;

uniform float u_slabHalf;
uniform float u_endsMm;
uniform vec3  u_endsColor;

void main() {
    float d = vSignedDist;

    // --- NEAR PASS: front fragments --------------------------------
    #ifdef NEAR_PASS
        if (d < 0.0) discard;
        if (d > u_slabHalf) discard;
        if (u_endsMm > 0.0 && vEndDist > u_endsMm) discard;

        vec3 col = (u_endsMm > 0.0) ? u_endsColor : vColor;
        gl_FragColor = vec4(col, 1.0);
    #endif

    // --- FAR PASS: back fragments ----------------------------------
    #ifdef FAR_PASS
        if (d >= 0.0) discard;
        if (d < -u_slabHalf) discard;
        if (u_endsMm > 0.0 && vEndDist > u_endsMm) discard;

        float br = 0.5; // constant dimming factor
        vec3 col = (u_endsMm > 0.0) ? u_endsColor : vColor;
        gl_FragColor = vec4(col * br, 1.0);
    #endif
}`;


const DOTS_VS = `
varying vec3 vColor;
varying float vSignedDist;

uniform vec3  u_sliceNormal;
uniform vec3  u_slicePt;
uniform float u_pointSize;

attribute vec3 color;

void main() {
    vColor = color;

    // Signed distance to slicing plane
    vSignedDist = dot(position - u_slicePt, u_sliceNormal);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = u_pointSize;
}`;

const DOTS_FS = `
precision highp float;

varying vec3  vColor;
varying float vSignedDist;

uniform float u_slabHalf;

void main() {
    // circular mask
	float r = length(gl_PointCoord - vec2(0.5));
	float alpha = 1.0 - smoothstep(0.48, 0.52, r);
	if (alpha <= 0.0) discard;

    float d = vSignedDist;

    #ifdef NEAR_PASS
        if (d < 0.0) discard;
        if (d > u_slabHalf) discard;
        gl_FragColor = vec4(vColor, alpha);
    #endif

    #ifdef FAR_PASS
        if (d >= 0.0) discard;
        if (d < -u_slabHalf) discard;
        float br = 0.5; // constant dimming factor
        gl_FragColor = vec4(vColor*br, alpha);
    #endif
}`;

export class SlabRenderer {
  constructor(threeRenderer) {
    this._r      = threeRenderer;
    this._rt     = null;    // WebGLRenderTarget, resized on demand
    this._matNear = null;   // ShaderMaterial: in-slab, depth-write ON  (pass 0)
    this._matFar  = null;   // ShaderMaterial: behind-plane, depth-write OFF (pass 1)
    this._rtW    = 0;
    this._rtH    = 0;
    this._pixels = null;    // reused Uint8Array for readback

    // Two cached clones of selMesh — share geometry, each uses one material.
    // Rebuilt only when selMesh identity changes (tracked by _srcMesh).
    this._meshNear  = null;
    this._meshFar   = null;
    this._dotsNear  = null;  // endpoint dots, same two-pass scheme
    this._dotsFar   = null;
    this._srcMesh   = null;
    this._srcDots   = null;
  }

  _ensureRT(W, H) {
    if (this._rt && this._rtW === W && this._rtH === H) return;
    if (this._rt) this._rt.dispose();
    this._rt = new THREE.WebGLRenderTarget(W, H, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format:    THREE.RGBAFormat,
      type:      THREE.UnsignedByteType,
      depthBuffer: true,   // depth buffer required for two-pass ordering
    });
    this._rtW = W; this._rtH = H;
    this._pixels = new Uint8Array(W * H * 4);
  }

  _slabUniforms() {
    return {
      u_sliceNormal: { value: new THREE.Vector3() },
      u_slicePt:     { value: new THREE.Vector3() },
      u_slabHalf:    { value: 1.0 },
      u_endsMm:      { value: 0.0 },
      u_endsColor:   { value: new THREE.Vector3(1, 1, 0.93) },
      u_endsFlip:    { value: 0.0 }
    };
  }

  _dotsUniforms() {
    return {
      u_sliceNormal: { value: new THREE.Vector3() },
      u_slicePt:     { value: new THREE.Vector3() },
      u_slabHalf:    { value: 1.0 },
      u_endsFlip:    { value: 0.0 },
      u_pointSize:   { value: 6.0 }
    };
  }

  _ensureMats() {
    if (this._matNear) return;

    // --- NEAR PASS (front fragments, full brightness) ---
    // selected streamlines
    this._matNear = new THREE.ShaderMaterial({
      vertexShader:   SLAB_VS,
      fragmentShader: SLAB_FS,
      uniforms:       this._slabUniforms(),
      defines:        { NEAR_PASS: 1 },
      depthWrite:     true,
      depthTest:      true,
      transparent:    false
    });
    // streamline ends
    this._dmatNear = new THREE.ShaderMaterial({
      vertexShader:   DOTS_VS,
      fragmentShader: DOTS_FS,
      uniforms:       this._dotsUniforms(),
      defines:        { NEAR_PASS: 1 },
      depthWrite:     false,
      depthTest:      true,
      transparent:    true
    });

    // --- FAR PASS (back fragments, dimmed) ---
    // selected streamlines
    this._matFar = new THREE.ShaderMaterial({
      vertexShader:   SLAB_VS,
      fragmentShader: SLAB_FS,
      uniforms:       this._slabUniforms(),
      defines:        { FAR_PASS: 1 },
      depthWrite:     false,
      depthTest:      true,
      transparent:    true
    });
    // streamline ends
    this._dmatFar = new THREE.ShaderMaterial({
      vertexShader:   DOTS_VS,
      fragmentShader: DOTS_FS,
      uniforms:       this._dotsUniforms(),
      defines:        { FAR_PASS: 1 },
      depthWrite:     false,
      depthTest:      true,
      transparent:    true
    });
  }

  // Call this whenever selMesh is replaced (e.g. after updateProbe rebuilds it).
  // Safe to call with null to clear.
  invalidate(newSelMesh, newDotsMesh) {
    this._meshNear = null;
    this._meshFar  = null;
    this._dotsNear = null;
    this._dotsFar  = null;
    this._srcMesh  = newSelMesh;
    this._srcDots  = null;//newDotsMesh || null;
  }

_ensureSliceMeshes(selMesh, dotsMesh) {
  if (this._meshNear && this._srcMesh === selMesh && this._srcDots === dotsMesh) return;

  this._ensureMats();

  // --- SLAB NEAR ---
  const near = selMesh.clone();
  near.geometry = selMesh.geometry;
  near.material = this._matNear;
  this._meshNear = near;

  // --- SLAB FAR ---
  const far = selMesh.clone();
  far.geometry = selMesh.geometry;
  far.material = this._matFar;
  this._meshFar = far;

  // --- DOTS (if provided) ---
  if (dotsMesh) {
    // --- DOT NEAR (front, full brightness) ---
    const dnear = dotsMesh.clone();
    dnear.geometry = dotsMesh.geometry;
    dnear.material = this._dmatNear;
    this._dotsNear = dnear;

    // --- DOT FAR (back, dimmed) ---
    const dfar = dotsMesh.clone();
    dfar.geometry = dotsMesh.geometry;
    dfar.material = this._dmatFar;
    this._dotsFar  = dfar;
  } else {
    this._dotsNear = null;
    this._dotsFar  = null;
  }

  this._srcMesh = selMesh;
  this._srcDots = dotsMesh || null;
}

  // Render slab for one plane onto canvas2d.
  //
  // canvas2d : the 2D slice canvas (already has anatomy drawn on it)
  // planeKey : 'sag' | 'cor' | 'axi'
  // cursor   : RAS mm point — defines the plane's position (used as u_slicePt)
  // tag      : 'a' (left panels) | 'b' (right panels)
  // vr       : VolRenderer instance (for _planeParams, _rot_dirs, _getNormalAxis, _getPlaneAxes)
  // state    : app state (for viewA/viewB)
  // opts     : { slabMultiplier, endsMm, endsColor, pixdim }
  render(canvas2d, planeKey, cursor, tag, vr, state, opts) {
    const selMesh  = opts.selMesh;
    const dotsMesh = opts.dotsMesh || null;
    if (!selMesh) return;
    const W = canvas2d.width, H = canvas2d.height;
    if (W <= 0 || H <= 0) return;
    this._ensureRT(W, H);
    this._ensureMats();
    this._ensureSliceMeshes(selMesh, dotsMesh);

    const r   = this._r;
    const nii = state.nii;

    // ── Plane normal and axes ──────────────────────────────
    const normalAxis = vr._getNormalAxis(planeKey);
    const [uAx, vAx] = vr._getPlaneAxes(planeKey);
    const nDir = vr._rot_dirs[normalAxis];
    const uDir = vr._rot_dirs[uAx];
    const vDir = vr._rot_dirs[vAx];

    // ── Slab half-thickness in mm ─────────────────────────
    const oopIdx = { sag: 0, cor: 1, axi: 2 };
    const halfThickMm = opts.slabMultiplier * nii.pixdim[oopIdx[planeKey] + 1] / 2;

    // ── Ortho camera from plane geometry ──────────────────
    const camDist = halfThickMm * 4 + 1;
    const views   = tag === 'a' ? state.viewA : state.viewB;
    const vc      = views[planeKey];
    const pp      = vr._planeParams[planeKey + tag];
    if (!pp) return;
    const mpp   = pp.mm_per_px;
    const halfU = mpp * W / 2;
    const halfV = mpp * H / 2;

    const cam = new THREE.OrthographicCamera(-halfU, halfU, halfV, -halfV,
      0.01, camDist * 2 + 1);

    const cpx = vc[0] + nDir[0] * camDist;
    const cpy = vc[1] + nDir[1] * camDist;
    const cpz = vc[2] + nDir[2] * camDist;

    cam.matrixAutoUpdate = false;
    cam.matrixWorld.set(
      uDir[0], vDir[0], nDir[0], cpx,
      uDir[1], vDir[1], nDir[1], cpy,
      uDir[2], vDir[2], nDir[2], cpz,
            0,       0,       0,   1
    );
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.updateProjectionMatrix();

    // ── Update uniforms on both materials ─────────────────
    const ec = new THREE.Color(opts.endsColor);
    const endsFlipVal = (opts.endsMm > 0 && opts.endsFlip) ? 1.0 : 0.0;
    for (const mat of [this._matNear, this._matFar, this._dmatNear,this._dmatFar]) {
      const u = mat.uniforms;
      u.u_sliceNormal.value.set(nDir[0], nDir[1], nDir[2]);
      u.u_slicePt.value.set(cursor[0], cursor[1], cursor[2]);
      u.u_slabHalf.value = halfThickMm;
      if (u.u_endsMm) {
		u.u_endsMm.value   = opts.endsMm;
		u.u_endsFlip.value = endsFlipVal;
		u.u_endsColor.value.set(ec.r, ec.g, ec.b);
	  }
    }

    const savedRT    = r.getRenderTarget();
    const savedBg    = r.getClearColor(new THREE.Color());
    const savedAlpha = r.getClearAlpha();

    if (!this._scene) this._scene = new THREE.Scene();

    // ── Two-pass render into offscreen RT ─────────────────
    // Painter's algorithm: draw dim far fragments first, then bright
    // near fragments on top.  No depth buffer trickery needed — we simply
    // let the second draw overwrite the first wherever they overlap.
    // depthWrite:false on both so Three.js doesn't interfere.

    r.setRenderTarget(this._rt);
    r.setClearColor(0x000000, 0);
    r.clear();

    const savedAutoClear = r.autoClear;
    r.autoClear = false;  // must be off so pass 1 doesn't wipe pass 0's pixels

    // pass 0 — far (dim, drawn first so near will overwrite)
    this._scene.add(this._meshFar);
    if (this._dotsFar)  this._scene.add(this._dotsFar);
    r.render(this._scene, cam);
    this._scene.remove(this._meshFar);
    if (this._dotsFar)  this._scene.remove(this._dotsFar);

    // pass 1 — near (bright, drawn on top)
    this._scene.add(this._meshNear);
    if (this._dotsNear) this._scene.add(this._dotsNear);
    r.render(this._scene, cam);
    this._scene.remove(this._meshNear);
    if (this._dotsNear) this._scene.remove(this._dotsNear);

    r.autoClear = savedAutoClear;
    r.setRenderTarget(savedRT);
    r.setClearColor(savedBg, savedAlpha);

    // ── Composite onto slice canvas ───────────────────────
    // Y-flip: WebGL y=0 is bottom, canvas y=0 is top
    r.readRenderTargetPixels(this._rt, 0, 0, W, H, this._pixels);
    if (!this._offCanvas || this._offCanvas.width !== W || this._offCanvas.height !== H) {
      this._offCanvas = new OffscreenCanvas(W, H);
    }
    const offCtx  = this._offCanvas.getContext('2d');
    const imgData = offCtx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const srcRow = (H - 1 - y) * W * 4;
      imgData.data.set(this._pixels.subarray(srcRow, srcRow + W * 4), y * W * 4);
    }
    offCtx.putImageData(imgData, 0, 0);
    canvas2d.getContext('2d').drawImage(this._offCanvas, 0, 0);
  }
}
