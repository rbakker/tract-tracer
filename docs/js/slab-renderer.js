// ── slab-renderer.js ──────────────────────────────────────
// GPU slab overlay renderer for 2D slice canvases.
// Draw order: far lines → near lines → dots (src+tgt always on top).

import * as THREE from 'three';
import { DOTS_VS, DOTS_FS, hexToRgbRaw } from './scene3d.js';

// SLAB_VS does the same screen-space ribbon expansion as scene3d.js's
// RIBBON_VS (see that file for the derivation), adapted for this
// renderer's own orthographic camera and re-purposed to also emit
// vSignedDist for the near/far slab discard test SLAB_FS already does.
// Width here is a SINGLE CONSTANT (u_widthPx) rather than following the
// near/far depth taper the 3D view uses: an orthographic slice has no
// meaningful "camera depth" the way the 3D perspective view does, so
// depth-based tapering wouldn't mean anything here — see the earlier
// design discussion on why 2D width stays flat. One consequence: with an
// orthographic projection, clip.w is always 1, so the perspective-divide
// compensation below (kept for exact parity with RIBBON_VS's formula) is
// a no-op in practice, not dead code — same formula, still correct.
const SLAB_VS = `
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec3 instanceColor;
// Per-instance fixed bundle color — mirrors scene3d.js's RIBBON_VS. Always
// bound (same geometry object is cloned from the 3D mesh — see
// _ensureLineMeshes — so this attribute is already populated there).
attribute vec3 instanceBundleColor;
// position.x = SIDE (-1/+1), position.y = END (0=start, 1=end) — same
// template-quad convention as scene3d.js's RIBBON_VS.
uniform vec2  u_resolution;
uniform float u_widthPx;
uniform vec3  u_sliceNormal;
uniform vec3  u_slicePt;
varying vec3  vColor;
varying vec3  vBundleColor;
varying float vSignedDist;
void main() {
  vColor       = instanceColor;
  vBundleColor = instanceBundleColor;

  vec4 worldStart = modelMatrix * vec4(instanceStart, 1.0);
  vec4 worldEnd   = modelMatrix * vec4(instanceEnd,   1.0);
  vec3 worldPos   = mix(worldStart.xyz, worldEnd.xyz, position.y);
  vSignedDist = dot(worldPos - u_slicePt, u_sliceNormal);

  vec4 clipStart = projectionMatrix * modelViewMatrix * vec4(instanceStart, 1.0);
  vec4 clipEnd   = projectionMatrix * modelViewMatrix * vec4(instanceEnd,   1.0);

  vec2 ssStart = (clipStart.xy / clipStart.w) * 0.5 * u_resolution;
  vec2 ssEnd   = (clipEnd.xy   / clipEnd.w)   * 0.5 * u_resolution;
  vec2 dirPx   = ssEnd - ssStart;
  float dirLen = length(dirPx);
  // Degenerate (zero-length) segment guard — same reasoning as RIBBON_VS.
  dirPx = (dirLen > 1e-4) ? (dirPx / dirLen) : vec2(1.0, 0.0);
  vec2 normalPx = vec2(-dirPx.y, dirPx.x);

  float half_ = 0.5 * u_widthPx;
  // Square-cap join extension, same cheap approach as RIBBON_VS — see its
  // comment for the join-test-streamlines.tck caveat at sharp angles.
  vec2 offsetPx = normalPx * position.x * half_
                + dirPx    * (position.y * 2.0 - 1.0) * half_;

  vec4 clip = mix(clipStart, clipEnd, position.y);
  clip.xy += (offsetPx / (0.5 * u_resolution)) * clip.w;
  gl_Position = clip;
}`;

const SLAB_FS = `
precision highp float;
varying vec3  vColor;
varying vec3  vBundleColor;
varying float vSignedDist;
uniform float u_slabHalf;
// 0 = uniform u_lineColor, 1 = RAS (vColor), 2 = bundle (vBundleColor) —
// same convention as scene3d.js's LINE_FS.
uniform int   u_autoColor;
uniform vec3  u_lineColor;
void main() {
  float d = vSignedDist;
  vec3 col = (u_autoColor == 1) ? vColor : ((u_autoColor == 2) ? vBundleColor : u_lineColor);
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
    // Deliberately NOT setting texture.colorSpace = SRGBColorSpace here
    // (as this used to) — traced directly through three's own
    // WebGLTextures.js getInternalFormat(): that setting makes three
    // allocate this render target's GPU texture as SRGB8_ALPHA8 instead
    // of plain RGBA8, which triggers REAL hardware-level automatic
    // linear->sRGB encoding on every fragment write into it (a WebGL2/
    // GLES3 built-in behavior for SRGB8_ALPHA8 targets, independent of
    // anything the shader source does) — completely unlike the 3D
    // canvas path, which has no such encoding. readRenderTargetPixels is
    // a raw gl.readPixels() wrapper with no compensating decode
    // (confirmed in three's own WebGLRenderer.js), so that encode was
    // one-way and uncompensated: it happened to roughly cancel out
    // THREE.Color's own sRGB->linear auto-conversion for custom/flat
    // colors (making those look right), while corrupting already-raw
    // values like bundle colors a second time (making those look
    // wrong — the "red becomes orange" bug). Leaving this unset keeps
    // texture.colorSpace at Texture's own default (NoColorSpace, which
    // maps to LinearTransfer, i.e. plain RGBA8 — verified in three's own
    // Texture.js/ColorManagement.js) — no hardware encoding at all,
    // matching the 3D canvas path exactly, since every color reaching
    // either pipeline now goes through the same raw hexToRgbRaw
    // conversion (see cv() below) with nothing left to compensate for.
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
      // Ribbon-specific — see SLAB_VS.
      u_resolution:  { value: new THREE.Vector2(1, 1) },
      u_widthPx:     { value: 2.0 },
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
      // Same reasoning as scene3d.js's makeRibbonMaterial: screen-space
      // ribbon construction makes triangle winding easy to get backwards
      // for a given camera's handedness without it being obvious by
      // inspection. This renderer's custom orthographic camera basis
      // (uDir/vDir/nDir as matrixWorld columns) isn't guaranteed to match
      // the 3D perspective camera's winding convention, so this needs its
      // own DoubleSide rather than assuming it inherits the 3D fix.
      side: THREE.DoubleSide,
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
    // s.mode: 'ras' (lines only) = per-vertex direction, 'bundle' = per-
    // instance/per-point fixed bundle color, 'hide' = off (color value
    // irrelevant, not drawn — see showLines/showSrc/showTgt below),
    // else '#rrggbb' custom. col is always a raw [r,g,b] array now (via
    // hexToRgbRaw, imported from scene3d.js) rather than a THREE.Color —
    // the 'ras'/'bundle' placeholder value is genuinely never read (see
    // SLAB_FS's u_autoColor branching), so [1,1,1] there is just a
    // harmless placeholder, not a real color needing conversion.
    const cv = (s) => {
      if (s.mode === 'ras')    return { auto: 1, col: [1, 1, 1] };
      if (s.mode === 'bundle') return { auto: 2, col: [1, 1, 1] };
      return { auto: 0, col: s.mode === 'hide' ? [1, 1, 1] : hexToRgbRaw(s.rgb) };
    };

	const lc = cv(opts.lineStyle);
	const sc = cv(opts.srcStyle);
	const tc = cv(opts.tgtStyle);

    const setLine = (mat) => {
      const u = mat.uniforms;
      u.u_sliceNormal.value.set(nDir[0], nDir[1], nDir[2]);
      u.u_slicePt.value.set(cursor[0], cursor[1], cursor[2]);
      u.u_slabHalf.value  = halfThickMm;
      u.u_autoColor.value = lc.auto;
      u.u_lineColor.value.set(lc.col[0], lc.col[1], lc.col[2]);
      u.u_resolution.value.set(W, H);
      u.u_widthPx.value = opts.lineWidthPx2D ?? 2.0;
    };
    const setDot = (mat, c) => {
      const u = mat.uniforms;
      u.u_sliceNormal.value.set(nDir[0], nDir[1], nDir[2]);
      u.u_slicePt.value.set(cursor[0], cursor[1], cursor[2]);
      u.u_slabHalf.value  = halfThickMm;
      u.u_autoColor.value = c.auto;
      u.u_dotColor.value.set(c.col[0], c.col[1], c.col[2]);
      u.u_pointSize.value = opts.endsPx ?? 6;
    };
    setLine(this._matNear); setLine(this._matFar);
    setDot(this._dmatSrcNear, sc); setDot(this._dmatSrcFar, sc);
    setDot(this._dmatTgtNear, tc); setDot(this._dmatTgtFar, tc);

	// Lines are hidden via WIDTH=0 now, not a color mode (see index.html's
	// LINE·COLOR radio, which no longer has a 'hide'/None option) — 'hide'
	// can still appear here harmlessly (cv() falls through to the custom-
	// color branch for any unrecognized mode), but width is the real gate.
	const showLines = (opts.lineWidthPx2D ?? 2.0) > 0;
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
