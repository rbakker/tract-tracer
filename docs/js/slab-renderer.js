// ── slab-renderer.js ──────────────────────────────────────
// GPU slab overlay renderer for 2D slice canvases.
// Renders selected tractogram streamlines within a slab around a slice plane,
// composited on top of the anatomy slice.

import * as THREE from 'three';

const SLAB_VS = `
varying vec3  vColor;
varying float vSignedDist;  // signed mm from slice plane
varying float vEndDist;     // mm from nearest tract endpoint
attribute vec3  color;
attribute float endDist;
uniform vec3  u_sliceNormal;  // unit normal of slice plane (RAS mm)
uniform vec3  u_slicePt;      // any point on slice plane (RAS mm)
void main() {
  vColor      = color;
  vEndDist    = endDist;
  vSignedDist = dot(position - u_slicePt, u_sliceNormal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Pass 0: in-slab segments only — full brightness, writes depth.
// Rendered first so its depth values protect these fragments from being
// overwritten by the dimmer behind-plane fragments in pass 1.
const SLAB_FS_NEAR = `
precision highp float;
varying vec3  vColor;
varying float vSignedDist;
varying float vEndDist;
uniform float u_slabHalf;
uniform float u_endsMm;
uniform vec3  u_endsColor;
void main() {
  float absDist = abs(vSignedDist);
  if (absDist > u_slabHalf) discard;
  if (u_endsMm > 0.0 && vEndDist > u_endsMm) discard;
  vec3 col = (u_endsMm > 0.0) ? u_endsColor : vColor;
  gl_FragColor = vec4(col, 1.0);
}`;

// Pass 1: behind-plane halo — dimmed, depth-write OFF so it can never
// overwrite a bright fragment that pass 0 already wrote to the depth buffer.
const SLAB_FS_FAR = `
precision highp float;
varying vec3  vColor;
varying float vSignedDist;
varying float vEndDist;
uniform float u_slabHalf;
uniform float u_endsMm;
uniform vec3  u_endsColor;
void main() {
  float absDist = abs(vSignedDist);
  if (absDist <= u_slabHalf) discard;
  if (absDist > u_slabHalf * 4.0) discard;
  if (u_endsMm > 0.0 && vEndDist > u_endsMm) discard;
  float br = max(0.15, 1.0 - (absDist - u_slabHalf) / (u_slabHalf * 3.0));
  vec3 col = (u_endsMm > 0.0) ? u_endsColor : vColor;
  gl_FragColor = vec4(col * br, 1.0);
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
    this._meshNear = null;
    this._meshFar  = null;
    this._srcMesh  = null;
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

  _makeUniforms() {
    return {
      u_sliceNormal: { value: new THREE.Vector3() },
      u_slicePt:     { value: new THREE.Vector3() },
      u_slabHalf:    { value: 1.0 },
      u_endsMm:      { value: 0.0 },
      u_endsColor:   { value: new THREE.Vector3(1, 1, 0.93) },
    };
  }

  _ensureMats() {
    if (this._matNear) return;
    this._matNear = new THREE.ShaderMaterial({
      vertexShader:   SLAB_VS,
      fragmentShader: SLAB_FS_NEAR,
      uniforms:       this._makeUniforms(),
      depthWrite:     true,   // writes depth — protects bright fragments
      depthTest:      true,
    });
    this._matFar = new THREE.ShaderMaterial({
      vertexShader:   SLAB_VS,
      fragmentShader: SLAB_FS_FAR,
      uniforms:       this._makeUniforms(),
      depthWrite:     false,  // never overwrites pass-0 depth values
      depthTest:      true,
    });
  }

  // Call this whenever selMesh is replaced (e.g. after updateProbe rebuilds it).
  // Safe to call with null to clear.
  invalidate(newSelMesh) {
    this._meshNear = null;
    this._meshFar  = null;
    this._srcMesh  = newSelMesh;
  }

  _ensureSliceMeshes(selMesh) {
    if (this._meshNear && this._srcMesh === selMesh) return;
    this._ensureMats();
    // clone() shares geometry buffers — no data copy
    const near = selMesh.clone();
    near.geometry = selMesh.geometry;
    near.material = this._matNear;
    const far = selMesh.clone();
    far.geometry = selMesh.geometry;
    far.material = this._matFar;
    this._meshNear = near;
    this._meshFar  = far;
    this._srcMesh  = selMesh;
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
    const selMesh = opts.selMesh;
    if (!selMesh) return;
    const W = canvas2d.width, H = canvas2d.height;
    if (W <= 0 || H <= 0) return;
    this._ensureRT(W, H);
    this._ensureMats();
    this._ensureSliceMeshes(selMesh);

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
    // They share the same values — only the depth-write flag differs.
    const ec = new THREE.Color(opts.endsColor);
    for (const mat of [this._matNear, this._matFar]) {
      const u = mat.uniforms;
      u.u_sliceNormal.value.set(nDir[0], nDir[1], nDir[2]);
      u.u_slicePt.value.set(cursor[0], cursor[1], cursor[2]);
      u.u_slabHalf.value = halfThickMm;
      u.u_endsMm.value   = opts.endsMm;
      u.u_endsColor.value.set(ec.r, ec.g, ec.b);
    }

    // ── Two-pass render into offscreen RT ─────────────────
    // Pass 0 (near): bright in-slab segments, depth-write ON.
    //   Their depth values are written to the RT's depth buffer.
    // Pass 1 (far):  dim behind-plane segments, depth-write OFF.
    //   depthTest still runs, so any fragment that would land on top
    //   of a pass-0 pixel is correctly discarded.
    const savedRT    = r.getRenderTarget();
    const savedBg    = r.getClearColor(new THREE.Color());
    const savedAlpha = r.getClearAlpha();

    if (!this._scene) this._scene = new THREE.Scene();
    r.setRenderTarget(this._rt);
    r.setClearColor(0x000000, 0);
    r.clear();

    // pass 0 — near
    this._scene.add(this._meshNear);
    r.render(this._scene, cam);
    this._scene.remove(this._meshNear);

    // pass 1 — far (depth-write off, so it loses to any pass-0 fragment)
    this._scene.add(this._meshFar);
    r.render(this._scene, cam);
    this._scene.remove(this._meshFar);

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
