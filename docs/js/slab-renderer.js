// ── slab-renderer.js ──────────────────────────────────────
// GPU slab overlay renderer for 2D slice canvases.
// Draw order: far lines → near lines → dots (src+tgt always on top).

import * as THREE from 'three';
import { DOTS_VS, DOTS_FS } from './scene3d.js';

const SLAB_VS = `
varying vec3  vColor;
varying float vSignedDist;
attribute vec3 color;
uniform vec3  u_sliceNormal;
uniform vec3  u_slicePt;
void main() {
  vColor = color;
  vSignedDist = dot(position - u_slicePt, u_sliceNormal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SLAB_FS = `
precision highp float;
varying vec3  vColor;
varying float vSignedDist;
uniform float u_slabHalf;
uniform int   u_autoColor;
uniform vec3  u_lineColor;
void main() {
  float d = vSignedDist;
  vec3 col = (u_autoColor > 0) ? vColor : u_lineColor;
  #ifdef NEAR_PASS
    if (d < 0.0 || d > u_slabHalf) discard;
  #endif
  #ifdef FAR_PASS
    if (d >= 0.0 || d < -u_slabHalf) discard;
    col = col * 0.7;
  #endif
  gl_FragColor = vec4(col, 1.0);
}`;

export class SlabRenderer {
  constructor(threeRenderer) {
    this._r      = threeRenderer;
    this._rt     = null;
    this._rtW    = 0;
    this._rtH    = 0;
    this._pixels = null;

    this._matNear     = null;  this._matFar      = null;
    this._dmatSrcNear = null;  this._dmatSrcFar  = null;
    this._dmatTgtNear = null;  this._dmatTgtFar  = null;

    this._meshNear    = null;  this._meshFar     = null;
    this._dotsSrcNear = null;  this._dotsSrcFar  = null;
    this._dotsTgtNear = null;  this._dotsTgtFar  = null;

    this._cachedSelMesh = null;
    this._cachedSrcMesh = null;
    this._cachedTgtMesh = null;

    this._scene = new THREE.Scene();
  }

  _ensureRT(W, H) {
    if (this._rt && this._rtW === W && this._rtH === H) return;
    if (this._rt) this._rt.dispose();
    this._rt = new THREE.WebGLRenderTarget(W, H, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true,
    });
    this._rt.texture.colorSpace = THREE.SRGBColorSpace;
    this._rtW = W; this._rtH = H;
    this._pixels = new Uint8Array(W * H * 4);
  }

  _lineUniforms() {
    return {
      u_sliceNormal: { value: new THREE.Vector3() },
      u_slicePt:     { value: new THREE.Vector3() },
      u_slabHalf:    { value: 1.0 },
      u_autoColor:   { value: 1 },
      u_lineColor:   { value: new THREE.Vector3(1, 0.4, 0) },
    };
  }

  _dotUniforms() {
    return {
      u_sliceNormal: { value: new THREE.Vector3() },
      u_slicePt:     { value: new THREE.Vector3() },
      u_slabHalf:    { value: 1.0 },
      u_autoColor:   { value: 1 },
      u_dotColor:    { value: new THREE.Vector3(1, 1, 0.8) },
      u_pointSize:   { value: 6.0 },
    };
  }

  _ensureMats() {
    if (this._matNear) return;
    const lineMat = (def) => new THREE.ShaderMaterial({
      vertexShader: SLAB_VS, fragmentShader: SLAB_FS,
      uniforms: this._lineUniforms(), defines: def,
      depthWrite: !!def.NEAR_PASS, depthTest: true, transparent: !!def.FAR_PASS,
    });
    const dotMat = (def) => new THREE.ShaderMaterial({
      vertexShader: DOTS_VS, fragmentShader: DOTS_FS,
      uniforms: this._dotUniforms(), defines: def,
      depthWrite: false, depthTest: false, transparent: true,
    });
    this._matNear     = lineMat({ NEAR_PASS: 1 });
    this._matFar      = lineMat({ FAR_PASS:  1 });
    this._dmatSrcNear = dotMat({ NEAR_PASS: 1 });
    this._dmatSrcFar  = dotMat({ FAR_PASS:  1 });
    this._dmatTgtNear = dotMat({ NEAR_PASS: 1 });
    this._dmatTgtFar  = dotMat({ FAR_PASS:  1 });
  }

  invalidate(selMesh) {
    this._meshNear = null; this._meshFar = null;
    this._dotsSrcNear = null; this._dotsSrcFar = null;
    this._dotsTgtNear = null; this._dotsTgtFar = null;
    this._cachedSelMesh = null;
    this._cachedSrcMesh = null;
    this._cachedTgtMesh = null;
  }

  _ensureLineMeshes(selMesh) {
    if (this._meshNear && this._cachedSelMesh === selMesh) return;
    this._ensureMats();
    const mk = (mat) => { const m = selMesh.clone(); m.geometry = selMesh.geometry; m.material = mat; return m; };
    this._meshNear = mk(this._matNear);
    this._meshFar  = mk(this._matFar);
    this._cachedSelMesh = selMesh;
  }

  _ensureDotMeshes(srcMesh, tgtMesh) {
    if (this._dotsSrcNear && this._cachedSrcMesh === srcMesh && this._cachedTgtMesh === tgtMesh) return;
    this._ensureMats();
    const mk = (mesh, mat) => {
      if (!mesh) return null;
      const m = mesh.clone(); m.geometry = mesh.geometry; m.material = mat; return m;
    };
    this._dotsSrcNear = mk(srcMesh, this._dmatSrcNear);
    this._dotsSrcFar  = mk(srcMesh, this._dmatSrcFar);
    this._dotsTgtNear = mk(tgtMesh, this._dmatTgtNear);
    this._dotsTgtFar  = mk(tgtMesh, this._dmatTgtFar);
    this._cachedSrcMesh = srcMesh;
    this._cachedTgtMesh = tgtMesh;
  }

  // opts: { selMesh, srcMesh, tgtMesh, slabMultiplier, lineColor, srcColor, tgtColor, endsPx }
  render(canvas2d, planeKey, cursor, tag, vr, vox_mm, viewCentre, opts) {
    const { selMesh, srcMesh, tgtMesh } = opts;
    if (!selMesh) return;
    const W = canvas2d.width, H = canvas2d.height;
    if (W <= 0 || H <= 0) return;
    this._ensureRT(W, H);
    this._ensureMats();
    this._ensureLineMeshes(selMesh);
    this._ensureDotMeshes(srcMesh || null, tgtMesh || null);

    const r   = this._r;

    const normalAxis  = vr._getNormalAxis(planeKey);
    const [uAx, vAx] = vr._getPlaneAxes(planeKey);
    const nDir = vr._rot_dirs[normalAxis];
    const uDir = vr._rot_dirs[uAx];
    const vDir = vr._rot_dirs[vAx];

    const oopIdx = { sag: 0, cor: 1, axi: 2 };
    const halfThickMm = opts.slabMultiplier * vox_mm[oopIdx[planeKey]] / 2;
    const camDist = halfThickMm * 4 + 1;

    const pp    = vr._planeParams[planeKey + tag];
    if (!pp) return;
    const halfU = pp.mm_per_px * W / 2;
    const halfV = pp.mm_per_px * H / 2;

    const cam = new THREE.OrthographicCamera(-halfU, halfU, halfV, -halfV, 0.01, camDist * 2 + 1);
    cam.matrixAutoUpdate = false;
    cam.matrixWorld.set(
      uDir[0], vDir[0], nDir[0], viewCentre[0] + nDir[0]*camDist,
      uDir[1], vDir[1], nDir[1], viewCentre[1] + nDir[1]*camDist,
      uDir[2], vDir[2], nDir[2], viewCentre[2] + nDir[2]*camDist,
             0,       0,       0, 1
    );
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.updateProjectionMatrix();

    // ── Uniforms ──────────────────────────────────────────
    // c: null=off, 'RAS'=per-vertex, '#rrggbb'=custom
    const cv = (s) => s.mode === 'ras'
      ? { auto: 1, col: new THREE.Color(0xffffff) }
      : { auto: 0, col: new THREE.Color(s.mode === 'hide' ? 0xffffff : s.rgb) };

	const lc = cv(opts.lineStyle);
	const sc = cv(opts.srcStyle);
	const tc = cv(opts.tgtStyle);

    const setLine = (mat) => {
      const u = mat.uniforms;
      u.u_sliceNormal.value.set(nDir[0], nDir[1], nDir[2]);
      u.u_slicePt.value.set(cursor[0], cursor[1], cursor[2]);
      u.u_slabHalf.value  = halfThickMm;
      u.u_autoColor.value = lc.auto;
      u.u_lineColor.value.set(lc.col.r, lc.col.g, lc.col.b);
    };
    const setDot = (mat, c) => {
      const u = mat.uniforms;
      u.u_sliceNormal.value.set(nDir[0], nDir[1], nDir[2]);
      u.u_slicePt.value.set(cursor[0], cursor[1], cursor[2]);
      u.u_slabHalf.value  = halfThickMm;
      u.u_autoColor.value = c.auto;
      u.u_dotColor.value.set(c.col.r, c.col.g, c.col.b);
      u.u_pointSize.value = opts.endsPx ?? 6;
    };
    setLine(this._matNear); setLine(this._matFar);
    setDot(this._dmatSrcNear, sc); setDot(this._dmatSrcFar, sc);
    setDot(this._dmatTgtNear, tc); setDot(this._dmatTgtFar, tc);

	const showLines = opts.lineStyle.mode !== 'hide';
	const showSrc   = opts.srcStyle.mode  !== 'hide' && this._dotsSrcNear;
	const showTgt   = opts.tgtStyle.mode  !== 'hide' && this._dotsTgtNear;

    const savedRT    = r.getRenderTarget();
    const savedBg    = r.getClearColor(new THREE.Color());
    const savedAlpha = r.getClearAlpha();
    const savedAC    = r.autoClear;

    r.setRenderTarget(this._rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.autoClear = false;

    // Pass 0 — far lines
    if (showLines) { this._scene.add(this._meshFar);  r.render(this._scene, cam); this._scene.remove(this._meshFar); }
    // Pass 1 — near lines
    if (showLines) { this._scene.add(this._meshNear); r.render(this._scene, cam); this._scene.remove(this._meshNear); }
    // Pass 2 — dots on top (far sub-pass)
    if (showSrc) this._scene.add(this._dotsSrcFar);
    if (showTgt) this._scene.add(this._dotsTgtFar);
    if (showSrc || showTgt) { r.render(this._scene, cam); }
    if (showSrc) this._scene.remove(this._dotsSrcFar);
    if (showTgt) this._scene.remove(this._dotsTgtFar);
    // Pass 3 — dots on top (near sub-pass)
    if (showSrc) this._scene.add(this._dotsSrcNear);
    if (showTgt) this._scene.add(this._dotsTgtNear);
    if (showSrc || showTgt) { r.render(this._scene, cam); }
    if (showSrc) this._scene.remove(this._dotsSrcNear);
    if (showTgt) this._scene.remove(this._dotsTgtNear);

    r.autoClear = savedAC;
    r.setRenderTarget(savedRT);
    r.setClearColor(savedBg, savedAlpha);

    // ── Composite onto slice canvas (Y-flip) ──────────────
    r.readRenderTargetPixels(this._rt, 0, 0, W, H, this._pixels);
    if (!this._offCanvas || this._offCanvas.width !== W || this._offCanvas.height !== H)
      this._offCanvas = new OffscreenCanvas(W, H);
    const offCtx  = this._offCanvas.getContext('2d');
    const imgData = offCtx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const srcRow = (H - 1 - y) * W * 4;
      imgData.data.set(this._pixels.subarray(srcRow, srcRow + W * 4), y * W * 4);
    }
    offCtx.putImageData(imgData, 0, 0);
    canvas2d.getContext('2d', {colorSpace: 'srgb'}).drawImage(this._offCanvas, 0, 0);
  }
}
