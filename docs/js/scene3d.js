// ── scene3d.js ────────────────────────────────────────────
// Three.js 3D scene: TrackballControls, glass brain, plane meshes,
// tractogram LineSegments helpers.

import * as THREE from 'three';
import { buildLutRGBA } from './lut-io.js';

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
          ps = new Vector2(), pe = new Vector2(), ptrs = [], ppos = {}, torder = [];
    this.target0 = this.target.clone(); this.position0 = obj.position.clone(); this.up0 = obj.up.clone();
    this.handleResize = () => {
      const b = el.getBoundingClientRect(), d = el.ownerDocument.documentElement;
      sc.screen = { left: b.left + pageXOffset - d.clientLeft, top: b.top + pageYOffset - d.clientTop, width: b.width, height: b.height };
    };
    const gmc = (px, py) => { const v = new Vector2(); v.set(((px - sc.screen.width * .5 - sc.screen.left) / (sc.screen.width * .5)), (sc.screen.height + 2 * (sc.screen.top - py)) / sc.screen.width); return v; };
    const gms = (px, py) => { const v = new Vector2(); v.set((px - sc.screen.left) / sc.screen.width, (py - sc.screen.top) / sc.screen.height); return v; };
    this.rotateCamera = (() => { const ax = new Vector3(), q = new Quaternion(), ed = new Vector3(), ou = new Vector3(), os = new Vector3(), md = new Vector3(); return () => { md.set(mc.x - mp.x, mc.y - mp.y, 0); let a = md.length(); if (a) { eye.copy(sc.object.position).sub(sc.target); ed.copy(eye).normalize(); ou.copy(sc.object.up).normalize(); os.crossVectors(ou, ed).normalize(); ou.setLength(mc.y - mp.y); os.setLength(mc.x - mp.x); md.copy(ou.add(os)); ax.crossVectors(md, eye).normalize(); a *= sc.rotateSpeed; q.setFromAxisAngle(ax, a); eye.applyQuaternion(q); sc.object.up.applyQuaternion(q); } mp.copy(mc); }; })();
    this.zoomCamera = () => { if (st !== S.ZOOM && st !== S.NONE) return; const f = 1 + (ze.y - zs.y) * sc.zoomSpeed; if (f !== 1 && f > 0) eye.multiplyScalar(f); if (sc.staticMoving) zs.copy(ze); };
    this.panCamera = (() => { const ch = new Vector2(), ou = new Vector3(), p = new Vector3(); return () => { ch.copy(pe).sub(ps); if (ch.lengthSq()) { ch.multiplyScalar(eye.length() * sc.panSpeed); p.copy(eye).cross(sc.object.up).setLength(ch.x); p.add(ou.copy(sc.object.up).setLength(ch.y)); sc.object.position.add(p); sc.target.add(p); if (sc.staticMoving) ps.copy(pe); } }; })();

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
    // Touch: one finger rotates (mirrors a left-mouse-button drag); two
    // fingers pinch-zoom and pan together, the classic trackball touch
    // scheme. ptrs/ppos already existed (tracking pointer-capture and, via
    // ppos, each active touch's latest page position) but the actual
    // gesture logic here was never filled in - touchstart/move fell
    // through to an empty block, so touch input did nothing at all.
    // panCamera() has no state gate (unlike zoomCamera(), which only runs
    // while st===S.ZOOM or S.NONE), so driving both from st=S.ZOOM during
    // a two-finger gesture is enough to get simultaneous pinch+pan.
    let pinchDist0 = 0;
    const touchMid = () => { const a = ppos[torder[0]], b = ppos[torder[1]]; return { dx: a.x - b.x, dy: a.y - b.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
    const startRotateTouch = () => { const p = ppos[torder[0]]; mc.copy(gmc(p.x, p.y)); mp.copy(mc); st = S.ROTATE; };
    const startZoomPanTouch = () => { const { dx, dy, mx, my } = touchMid(); pinchDist0 = Math.hypot(dx, dy); ps.copy(gms(mx, my)); pe.copy(ps); st = S.ZOOM; };
    const opd = e => {
      if (!sc.enabled) return;
      if (ptrs.length === 0) { el.setPointerCapture(e.pointerId); el.addEventListener('pointermove', opm); el.addEventListener('pointerup', opu); }
      ptrs.push(e);
      if (e.pointerType === 'touch') {
        ppos[e.pointerId] = { x: e.pageX, y: e.pageY };
        torder.push(e.pointerId);
        if (torder.length === 1) startRotateTouch();
        else if (torder.length === 2) startZoomPanTouch();
        // 3rd+ finger: ignore (still tracked in ppos/torder for bookkeeping
        // on release, but doesn't change the active gesture).
      } else omd(e);
    };
    const opm = e => {
      if (!sc.enabled) return;
      if (e.pointerType === 'touch') {
        if (!(e.pointerId in ppos)) return;
        ppos[e.pointerId] = { x: e.pageX, y: e.pageY };
        if (torder.length === 1) { mp.copy(mc); mc.copy(gmc(e.pageX, e.pageY)); sc.update(); }
        else if (torder.length >= 2) {
          const { dx, dy, mx, my } = touchMid();
          const dist = Math.hypot(dx, dy);
          // Feed the CHANGE in pinch distance into ze.y as if it were a
          // middle-mouse-drag position: zoomCamera() only ever reads the
          // delta against zs.y (re-synced to ze.y after every use, since
          // staticMoving is on), so an incremental value here is enough -
          // it doesn't need to carry any absolute meaning.
          // Pinch OUT (fingers spreading, dist growing) should zoom IN.
          // zoomCamera() makes the eye vector LONGER (zooms out) when
          // (ze.y - zs.y) is positive - so a growing dist needs a
          // NEGATIVE delta here, the opposite sign of the raw distance
          // change.
          zs.y = 0; ze.y = (pinchDist0 - dist) / sc.screen.height;
          pinchDist0 = dist;
          pe.copy(gms(mx, my));
          sc.update();
        }
      } else omm(e);
    };
    const opu = e => {
      if (!sc.enabled) return;
      if (e.pointerType === 'touch' && e.pointerId in ppos) {
        delete ppos[e.pointerId];
        torder.splice(torder.indexOf(e.pointerId), 1);
        if (torder.length === 0) st = S.NONE;
        else if (torder.length === 1) startRotateTouch();      // resume 1-finger rotate without a jump
        else if (torder.length === 2) startZoomPanTouch();     // dropped from 3+ back to 2
      } else omu();
      ptrs.splice(ptrs.findIndex(p => p.pointerId === e.pointerId), 1);
      if (ptrs.length === 0) { el.releasePointerCapture(e.pointerId); el.removeEventListener('pointermove', opm); el.removeEventListener('pointerup', opu); }
    };
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

const GLASS_HELPERS_GLSL = `
precision highp float;
precision highp sampler3D;
uniform sampler3D u_vol;
uniform vec3  u_size;
uniform vec3  u_voxMm;
uniform float u_alpha;
uniform float u_thresh; // RIM-LIT's accumulation cutoff — tied to BACKGROUND's own threshold from index.html (not an independent value; see backgroundThresh there), now that it's no longer cutout's threshold and the original reason for keeping it separate from BACKGROUND (protecting the outer surface from an aggressive CUTOUT) no longer applies to this role at all
// CUTOUT is a fully independent two-row system now, decoupled from
// u_thresh (which stays u_thresh's own thing — RIM-LIT's accumulation
// cutoff — since it's the ONLY UI-adjustable value driving that, via a
// slider that's only ever visible in SOLID mode; repurposing that same
// slider for cutout's own default of 0 would have silently changed
// RIM-LIT's default look for anyone who never opens SOLID mode at all).
// u_cutoutT1/u_cutoutT2 are cutout's own two thresholds; u_cutoutRow1Above
// and u_cutoutRow2AndBelow are explicit operator choices (not inferred
// from which threshold is numerically larger, the old scheme's actual
// source of confusion) — see isCutZone's comment for the exact rule.
uniform float u_cutoutT1;
uniform float u_cutoutBelowThresh; // cutout's second threshold (t2) — name kept from before decoupling, still cutout-only, never shared elsewhere
uniform int   u_cutoutRow1Above;
uniform int   u_cutoutRow2AndBelow;
// BACKGROUND: adjustable replacement for what used to be a fixed
// "is there any real signal here" constant — see occupancyAndGradient's
// and classifyThresh's comments for how this is used.
uniform float u_background;
// BACKGROUND's below/above selector: flips which raw values count as
// background for the WHOLE volume — see occupancyAndGradient's comment.
uniform float u_bgInvert;
// SLICE: the active clip plane becomes two parallel planes straddling its
// own position (a thin slab) instead of a one-sided half-space cut. See
// its usage in main()'s clip-plane loop, duplicated identically in both
// GLASS_ONLY_FS and SOLID_ONLY_FS.
uniform float u_sliceMode;
uniform float u_sliceThickness; // full thickness, in voxel-index-space units (1 unit = 1 voxel along the relevant axis)
// TEMPORARY TUNING - caps a grazing ray's SLICE cross-section width to
// this many multiples of u_sliceThickness, to avoid undersampling at
// steep angles - see its usage right after the clip-plane loop.
uniform float u_sliceWidthCapMult;
uniform float u_glassAlphaMult; // OPACITY's multiplier on GLASS mode's Fresnel alpha — see its usage near fragAlpha
uniform float u_rimPow;
uniform float u_volDiagMm;
uniform int   u_steps;
uniform mat4  u_invPV;
uniform mat4  u_invModel;
uniform vec3  u_camPos;
uniform float u_isColor;
// True (1.0) when Anat modality is forced onto 3-channel (DEC) data:
// display it as a plain grayscale magnitude scan instead of the RGB
// direction colour. Never changes u_isColor itself (isosurface/threshold
// math always needs to know the data is genuinely 3-channel), only which
// branch the DISPLAYED colour takes below.
uniform float u_forceGray;
// TEMPORARY DEBUG uniform - see its usage near solidColor below.
uniform float u_debugDarkNormals;
// TEMPORARY DEBUG/TUNING uniform — see smoothedOccupancyNormal's comment.
// Default 1.0 matches the original hardcoded behavior.
uniform float u_gradRadius;
// GLASS mode: 1.0 makes the solid isosurface's alpha a Fresnel rim term
// instead of fully opaque — see its usage near fragAlpha below. 0.0
// (SOLID mode) is fully opaque, unaffected. Unused in the translucent
// shader (only ever referenced from SOLID_ONLY_FS's main()).
uniform float u_shellMode;
uniform float u_contrast;
uniform float u_applyLUT;
uniform sampler2D u_lut;
uniform float u_lutSize;
uniform float u_dataMin;
uniform float u_dataRange;
uniform mat4  u_model;
uniform mat4  u_projView;
// Off-axis "three-quarter" light direction, fixed relative to the viewer
// (recomputed from camera orientation each frame in onBeforeRender, then
// pre-transformed into this same local voxel-index space rd already uses —
// see u_lightDir's JS-side computation for why). A light glued to the view
// direction (the previous dot(N,rd) headlamp) is exactly the lighting
// condition under which convex and concave detail become indistinguishable
// (the classic "hollow-face" illusion) — this breaks that degeneracy for a
// static, unrotated view, without needing any continuous animation.
uniform vec3  u_lightDir;
// Section-plane clipping — anatomy only (tractogram lines are a separate
// mesh, untouched by this). Each of the 3 planes (sag/cor/axi) is a half-
// space test in LOCAL voxel-index space (same space as ro/rd/t below), so
// it can be applied once to tighten [tStart,tEnd] before either the glass
// accumulation loop or the solid isosurface march — clipping both at once
// for free. u_clipNormal/u_clipPoint are pre-transformed on the JS side
// from the plane's world/RAS normal+point into this local space (normal
// via transpose(linear part of u_model), point via u_invModel — see
// updateClipUniforms in index.html), so no matrix work is needed per-pixel.
// u_clipDir encodes both "is this plane clipping" and which side is kept:
//   0      -> clipping disabled for this plane (OFF or THROUGH/no-clip mode)
//   +1.0   -> "clip -": hide the negative (L/P/I) side, keep positive
//   -1.0   -> "clip +": hide the positive (R/A/S) side, keep negative
uniform vec3  u_clipNormal[3];
uniform vec3  u_clipPoint[3];
uniform float u_clipDir[3];
// Fill-in: whether the clip-plane cut face is painted with sampled anatomy
// (1.0, default) or skipped entirely (0.0) so the ray looks past the cut
// into whatever real tissue lies behind it. See the solid-mode block below.
uniform float u_fillIn;
varying vec2 vNDC;

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 tMin = (vec3(0.0) - ro) / rd;
  vec3 tMax = (u_size    - ro) / rd;
  vec3 t1 = min(tMin, tMax);
  vec3 t2 = max(tMin, tMax);
  return vec2(max(max(t1.x, t1.y), t1.z),
              min(min(t2.x, t2.y), t2.z));
}
vec3 sampleRaw(vec3 p) {
  // Texture stores sqrt-encoded colour (see VolRenderer.upload) to spend
  // the 8 bits/channel where DEC data actually lives — square to undo it.
  // Scalar (grayscale/label) textures store the linear normalized value
  // directly and were never sqrt-encoded, so leave those untouched.
  // Scalar textures are RedFormat (single channel) — replicate .r into
  // all three components. Colour textures are RGBA8 — read all three.
  vec4 texel = texture(u_vol, p / u_size);
  vec3 enc = u_isColor > 0.5 ? texel.rgb : vec3(texel.r);
  return u_isColor > 0.5 ? enc * enc : enc;
}
// Scalar "intensity" used for thresholding/gradient/rim shading: the raw
// value itself for a normal scan. For a DEC/colour map, each channel is
// FA * |eigenvector_component| and the eigenvector is unit length, so the
// Euclidean length of the RGB triple recovers FA exactly — unlike a luma
// weighting (0.3R+0.6G+0.1B), which is biased against blue (S-I-oriented)
// tracts and would wrongly threshold them away.
float sampleVol(vec3 p) {
  vec3 c = sampleRaw(p);
  return u_isColor > 0.5 ? length(c) : c.r;
}
// Reconstructs the original integer label index from the normalized
// scalar texture value (texture stores (raw-min)/range — see
// VolRenderer.upload), rounded to the nearest integer.
float sampleLabelIndex(vec3 p) {
  float norm = texture(u_vol, p / u_size).r;
  return floor(norm * u_dataRange + u_dataMin + 0.5);
}
// Label indices are arbitrary categorical numbers — going from region 47
// to 48 isn't "half as different" as 47 to 49, so a continuous gradient
// of the raw index is meaningless. Instead, border(p) is a clean binary
// signal: 1.0 if ANY face-neighbour has a different (rounded) label than
// p, else 0.0 — independent of how large that jump happens to be.
float labelBorder(vec3 p) {
  float c = sampleLabelIndex(p);
  vec3 e = vec3(1.0, 0.0, 0.0);
  float d = 0.0;
  d = max(d, abs(sampleLabelIndex(p+e.xyz) - c) > 0.5 ? 1.0 : 0.0);
  d = max(d, abs(sampleLabelIndex(p-e.xyz) - c) > 0.5 ? 1.0 : 0.0);
  d = max(d, abs(sampleLabelIndex(p+e.zxy) - c) > 0.5 ? 1.0 : 0.0);
  d = max(d, abs(sampleLabelIndex(p-e.zxy) - c) > 0.5 ? 1.0 : 0.0);
  d = max(d, abs(sampleLabelIndex(p+e.yzx) - c) > 0.5 ? 1.0 : 0.0);
  d = max(d, abs(sampleLabelIndex(p-e.yzx) - c) > 0.5 ? 1.0 : 0.0);
  return d;
}
// A directional analogue of gradient() for the binary border field, used
// only for Fresnel-style rim lighting direction in glass mode. This stays
// blocky by nature — a label volume has no sub-voxel information for any
// neighbourhood-based estimate to recover, widening the sampling radius
// just re-classifies which discrete pattern gets detected, it doesn't
// make the result continuous. That's fine: glass mode is the translucent
// boundary view, not meant to look like a smooth surface — the "make it
// smooth" case is handled by the solid isosurface path at high opacity
// instead (see occupancyAndGradient() below), which has genuine sub-voxel
// information via trilinear interpolation to work with.
vec3 labelNormal(vec3 p) {
  float c = sampleLabelIndex(p);
  vec3 g = vec3(0.0);
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0 && dz == 0) continue;
        float fx = float(dx), fy = float(dy), fz = float(dz);
        float differs = (abs(sampleLabelIndex(p + vec3(fx,fy,fz)) - c) > 0.5) ? 1.0 : 0.0;
        g.x += fx * (2.0 - abs(fy)) * (2.0 - abs(fz)) * differs;
        g.y += fy * (2.0 - abs(fx)) * (2.0 - abs(fz)) * differs;
        g.z += fz * (2.0 - abs(fx)) * (2.0 - abs(fy)) * differs;
      }
    }
  }
  // Same anisotropy correction as gradient()/smoothedOccupancyNormal() -
  // this kernel's unit offsets (-1,0,1) aren't the same physical distance
  // per axis for anisotropic data either.
  return g / u_voxMm;
}
// LUT colour for a label index, with the same out-of-range fallback as
// the 2D slice shader: mid-gray rather than silently repeating whatever
// colour CLAMP_TO_EDGE lands on at the texture boundary. Applies the same
// gamma-curve INTENSITY control used for scalar data (see gammaContrast)
// so the slider has an effect in LUT mode too - always keeps true black
// fixed, brightening/darkening region colours toward or away from white
// rather than a flat multiply that could clip saturated colours.
vec3 lutColor(float idx) {
  vec3 c = (idx < 0.0 || idx >= u_lutSize) ? vec3(0.5)
         : texture(u_lut, vec2((idx + 0.5) / u_lutSize, 0.5)).rgb;
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / u_contrast));
}
// Manual trilinear blend of LUT colour across the 8 voxels surrounding a
// continuous position - mathematically the same result hardware LINEAR
// filtering would give on a pre-baked colour texture, computed here
// instead so the label texture itself can stay NEAREST (required: raw
// label indices are arbitrary categorical numbers, so blending two of
// them before lookup - e.g. averaging region 12 and region 340 into
// "176" - would pick a meaningless third region's colour, not blend two
// real ones). This also fixes the black-speck artifact from a single
// discrete pick: on thin or grazing-angle structures a single nudged
// sample can still land on a background voxel (pure black); interpolating
// dilutes that by its neighbours instead, same as any other boundary
// voxel would be.
vec3 interpolatedLutColor(vec3 p) {
  // Same -0.5 realignment as occupancyAndGradient: sampleLabelIndex(i)
  // reads voxel i's value via NEAREST, representative of its true center
  // at i+0.5, not at i - shifting first keeps colour transitions centred
  // on the true voxel boundary instead of skewed toward one side of it.
  vec3 ps = p - vec3(0.5);
  vec3 p0 = floor(ps);
  vec3 f  = ps - p0;
  vec3 e  = vec3(1e-3); // same tie-avoidance nudge as occupancyAt
  vec3 c000 = lutColor(sampleLabelIndex(p0 + vec3(0.0,0.0,0.0) + e));
  vec3 c100 = lutColor(sampleLabelIndex(p0 + vec3(1.0,0.0,0.0) + e));
  vec3 c010 = lutColor(sampleLabelIndex(p0 + vec3(0.0,1.0,0.0) + e));
  vec3 c110 = lutColor(sampleLabelIndex(p0 + vec3(1.0,1.0,0.0) + e));
  vec3 c001 = lutColor(sampleLabelIndex(p0 + vec3(0.0,0.0,1.0) + e));
  vec3 c101 = lutColor(sampleLabelIndex(p0 + vec3(1.0,0.0,1.0) + e));
  vec3 c011 = lutColor(sampleLabelIndex(p0 + vec3(0.0,1.0,1.0) + e));
  vec3 c111 = lutColor(sampleLabelIndex(p0 + vec3(1.0,1.0,1.0) + e));
  vec3 c00 = mix(c000, c100, f.x);
  vec3 c10 = mix(c010, c110, f.x);
  vec3 c01 = mix(c001, c101, f.x);
  vec3 c11 = mix(c011, c111, f.x);
  vec3 c0  = mix(c00, c10, f.y);
  vec3 c1  = mix(c01, c11, f.y);
  return mix(c0, c1, f.z);
}
// Gamma curve (matches vol-renderer.js's slice shader): always maps 0->0
// and 1->1 exactly, and is monotonic for any exponent — the earlier
// two-sided S-curve attempt mirrored the same darkening on both sides of
// centre instead of flattening toward gray when reduced.
float gammaContrast(float v, float gamma) {
  return pow(clamp(v, 0.0, 1.0), gamma);
}
vec3 gradient(vec3 p) {
  vec3 e = vec3(1.0, 0.0, 0.0);
  vec3 g = vec3(
    sampleVol(p+e.xyz) - sampleVol(p-e.xyz),
    sampleVol(p+e.zxy) - sampleVol(p-e.zxy),
    sampleVol(p+e.yzx) - sampleVol(p-e.yzx)
  );
  // "1 voxel" is 0.9mm in X/Y but 3.3mm in Z for anisotropic data - divide
  // by physical voxel size so the gradient direction reflects true
  // physical space rather than being stretched toward whichever axis has
  // the larger voxel.
  return g / u_voxMm;
}

// ─── Solid isosurface mode (high opacity, any volume type) ────────────
// Glass mode (above) is inherently blocky/translucent — appropriate for
// peering through or showing many internal boundaries at once, not for
// looking like a solid object. At high opacity the person expects an
// actual smooth surface instead, using the SAME threshold as glass mode's
// Fresnel rendering as the cutoff for continuous data, so the two stay
// consistent as opacity slides between them.
//
// Uses sampleVol() as the field — the same "intensity" glass mode already
// uses (raw scalar value for a normal scan, FA magnitude for DEC) — so
// solid and glass mode agree on what the surface means for those types.
//
// Label+LUT data is different: it's binarized to 0/1 (occupied vs
// background) rather than using the raw label value directly. Labels are
// arbitrary categorical numbers, and with occupancyAndGradient's blend
// correctly aligned to reach exactly 50% at the true zone boundary
// (see its own comment), that 50% point corresponds to a different
// absolute value for every different label if the raw number is used —
// there's no single fixed threshold that finds the true boundary for all
// of them simultaneously. Binarizing first fixes that: the blend then
// always ramps 0 to 1 regardless of which label is present, so a fixed
// threshold of 0.5 finds the true boundary universally (see isoThresh
// below, where label mode ignores u_thresh entirely for this reason).
float occupancyAt(vec3 voxCoord) {
  // voxCoord arrives as an exact integer (p0+{0,1} from the caller below),
  // which normalizes to precisely a texel BOUNDARY. Under NEAREST
  // filtering (label+LUT mode) that's a genuine tie between two texels,
  // resolved inconsistently depending on which way floating-point
  // rounding nudges the query point - aliasing the whole occupancy field,
  // not just internal colour boundaries. A tiny epsilon nudge resolves
  // the tie unambiguously (texel zones are a full voxel wide, so this is
  // nowhere near the next boundary) while staying negligible for LINEAR
  // filtering's own blend, so both modes can share this one code path.
  float v = sampleVol(voxCoord + vec3(1e-3));
  bool nearestFiltered = (u_applyLUT > 0.5) && (u_isColor < 0.5);
  return nearestFiltered ? (v > 0.0 ? 1.0 : 0.0) : v;
}
// Trilinear-ish reconstruction of the field, plus (for label data only) an
// analytic gradient reusing the same 8 corner samples. Returns (gradient,
// value) as (xyz, w) — only .w is ever read by any caller below; .xyz is
// meaningful for label mode only and left at zero for continuous data.
//
// For continuous (LINEAR-filtered) data this deliberately does MORE
// smoothing than a single hardware trilinear sample would: each "corner"
// below is itself already a hardware-interpolated sample (see occupancyAt),
// so blending 8 of THOSE together is a second layer of interpolation on
// top of the first - a wider, quadratic-ish kernel that's what makes
// acquisition-slice banding disappear from the isosurface. A single plain
// sampleVol(p) call looks correct but noticeably faceted along slice
// boundaries by comparison; this is a deliberate, wanted trade of a little
// extra softness for that. Label data doesn't have this option (or need
// it) - occupancyAt(k) for it is a genuine discrete per-voxel classification
// via NEAREST, not a blend, so the very same corner construction below is
// simply the correct way to build a smooth occupancy field from arbitrary
// categorical labels, not an extra-smoothing add-on.
vec4 occupancyAndGradient(vec3 p) {
  bool nearestFiltered = (u_applyLUT > 0.5) && (u_isColor < 0.5); // same test as occupancyAt's
  // Label mode: occupancyAt(i) reads voxel i's value via NEAREST,
  // representative of that voxel's TRUE center at i+0.5 (not at i) - so
  // shift p by -0.5 before flooring, making corner p0 correctly represent
  // position p0+0.5 in the blend below. Without this the blend ramps its
  // full 0-1 range across p0 to p0+1, reaching its far value already AT
  // p0+1 (the true zone boundary) rather than being at the 50% midpoint
  // there - meaning any small/fixed threshold finds its crossing far too
  // early, well inside what should still read as background.
  //
  // Continuous mode deliberately does NOT apply that same -0.5 shift.
  // occupancyAt(k) here is itself already H(k), the hardware-interpolated
  // value AT k (not at k+0.5) - so building the outer blend directly from
  // floor(p)/fract(p), with no pre-shift, keeps its result correctly
  // centered on p. (Reusing the label branch's -0.5 shift here was the
  // actual bug fixed previously: it re-centered this same extra-smoothing
  // blend a half voxel away from p - e.g. at p=3.2, the correctly-centered
  // version below weights texel centers 2.5/3.5/4.5 by 0.4/0.5/0.1, whose
  // weighted centroid is exactly 3.2; shifting first, as label mode needs,
  // instead lands that centroid at 2.7.)
  vec3 ps = nearestFiltered ? (p - vec3(0.5)) : p;
  vec3 p0 = floor(ps);
  vec3 f  = ps - p0;
  float c000 = occupancyAt(p0 + vec3(0.0,0.0,0.0));
  float c100 = occupancyAt(p0 + vec3(1.0,0.0,0.0));
  float c010 = occupancyAt(p0 + vec3(0.0,1.0,0.0));
  float c110 = occupancyAt(p0 + vec3(1.0,1.0,0.0));
  float c001 = occupancyAt(p0 + vec3(0.0,0.0,1.0));
  float c101 = occupancyAt(p0 + vec3(1.0,0.0,1.0));
  float c011 = occupancyAt(p0 + vec3(0.0,1.0,1.0));
  float c111 = occupancyAt(p0 + vec3(1.0,1.0,1.0));

  float c00 = mix(c000, c100, f.x);
  float c10 = mix(c010, c110, f.x);
  float c01 = mix(c001, c101, f.x);
  float c11 = mix(c011, c111, f.x);
  float c0  = mix(c00, c10, f.y);
  float c1  = mix(c01, c11, f.y);
  float val = mix(c0, c1, f.z);

  if (!nearestFiltered) {
    // BACKGROUND's below/above selector (u_bgInvert): flips which raw
    // values count as "more tissue-like" for the ENTIRE volume, at this
    // single source point everything else reads through - the rest of
    // the file only ever consumes val via >= comparisons and never
    // assumes anything about the raw data's own brightness convention, so
    // flipping it once here is sufficient to correctly support a scan
    // where background is brighter than tissue (e.g. some microscopy),
    // not just the usual dark-background case, with zero changes needed
    // anywhere else - including the CUTOUT threshold's own comparisons,
    // which read this same (now-corrected) field.
    if (u_bgInvert > 0.5) val = 1.0 - val;
    return vec4(0.0, 0.0, 0.0, val); // gradient unused outside label mode
  }

  float dx = mix(mix(c100-c000, c110-c010, f.y), mix(c101-c001, c111-c011, f.y), f.z);
  float dy = mix(mix(c010-c000, c110-c100, f.x), mix(c011-c001, c111-c101, f.x), f.z);
  float dz = mix(mix(c001-c000, c101-c100, f.x), mix(c011-c010, c111-c110, f.x), f.y);

  return vec4(dx, dy, dz, val);
}
// Marches the ray looking for the first place the raw value field crosses
// thresh, then bisection-refines a few steps for a cleaner surface than the
// raw step size alone would give. Generalized to start from either side of
// thresh: ordinarily tStart sits in background (the natural bounding box
// always does), so this finds the usual entry surface — but when a clip
// plane cuts through the middle of tissue, tStart can start already inside
// it, and this instead finds that tissue's exit boundary, a genuine
// anatomical transition with a well-defined gradient (unlike the cut face
// itself). That's what lets FILL-IN=off "look inside" the anatomy: no flat
// cap, just whatever real surface the ray hits next.
bool findIsosurface(vec3 ro, vec3 rd, float tStart, float tEnd, float stepSize, float thresh,
                     out vec3 hitP) {
  vec3 prevP = ro + tStart * rd;
  bool startInside = occupancyAndGradient(prevP).w >= thresh;
  // The compile-time loop bound below must stay comfortably above the
  // highest u_steps any quality tier can set (see index.html's
  // GLASS_STEPS_BY_TIER) - GLSL requires a constant loop bound, so
  // "i >= u_steps" is checked as an early break instead of using u_steps
  // directly as the bound. If this constant is ever lower than u_steps,
  // every ray silently stops partway through its intended path (at
  // exactly bound/u_steps of the way, for every ray, since stepSize is
  // already computed from the full u_steps) - not a crash, just an
  // increasingly wrong render the higher u_steps goes past this number,
  // which is exactly what a too-high ULTRA setting once hit against an
  // earlier, lower version of this same bound.
  for (int i = 1; i < 512; i++) {
    if (i >= u_steps) break;
    float t = tStart + float(i) * stepSize;
    if (t > tEnd) break;
    vec3 p = ro + t * rd;
    float occ = occupancyAndGradient(p).w;
    bool inside = occ >= thresh;
    if (inside != startInside) {
      vec3 a = prevP, b = p; // a stays on the startInside side, b on the other
      for (int k = 0; k < 6; k++) {
        vec3 mid = (a + b) * 0.5;
        bool midInside = occupancyAndGradient(mid).w >= thresh;
        if (midInside == startInside) a = mid; else b = mid;
      }
      hitP = (a + b) * 0.5;
      return true;
    }
    prevP = p;
  }
  return false;
}
// CUTOUT's rule, redesigned around two EXPLICIT operator choices instead
// of inferring AND/OR from which threshold happens to be numerically
// larger (the old scheme's actual source of confusion — the only way to
// turn cutout off was setting both sliders to precisely the same value,
// a coincidence rather than a discoverable default). Row 1 picks a
// direction (>= t1, or <= t1); row 2 picks how it COMBINES with a second
// bound, AND-ing or OR-ing. The combined expression describes what STAYS
// VISIBLE, not what's cut — cutout removes whatever fails it. With the
// defaults (row1 "above" t1=0, row2 "and below" t2=1), the combined
// condition is "occ>=0 AND occ<=1", true for every possible occ value —
// i.e. cutout is off by construction at those defaults, not by
// coincidence. All comparisons inclusive.
//
// This is strictly more expressive than the old two-threshold system,
// not just a relabeling — the four (row1 x row2) combinations reproduce
// BOTH of the old system's modes (isolate a band: row1=above + row2=
// "and below" is exactly today's default; exclude a band: row1=below +
// row2="or above") PLUS two new one-sided half-space cuts the old system
// had no way to express at all (row1=above + row2="or above" collapses
// to a single effective threshold at min(t1,t2); row1=below + row2=
// "and below" collapses to a single threshold at min(t1,t2) the other
// direction).
bool isCutZone(float occ, float t1, float t2, bool row1Above, bool row2AndBelow) {
  bool cond1 = row1Above ? (occ >= t1) : (occ <= t1);
  bool keep  = row2AndBelow ? (cond1 && occ <= t2) : (cond1 || occ >= t2);
  return !keep;
}
// CUTOUT's own boundary search - structurally identical to findIsosurface
// above (march forward, bisection-refine where the classification flips),
// but flipping isCutZone's two-threshold verdict instead of crossing a
// single value threshold. Also already bidirectional the same way: checks
// isCutZone at its own starting point and searches for the OPPOSITE, so
// the same call correctly handles both "material starts in the cut zone,
// find where it exits" and "material starts on the keep side, find where
// IT ends" without needing to know which case it's in ahead of time.
bool findCutoutBoundary(vec3 ro, vec3 rd, float tStart, float tEnd, float stepSize,
                         float t1, float t2, bool row1Above, bool row2AndBelow, out vec3 hitP) {
  vec3 prevP = ro + tStart * rd;
  bool startCut = isCutZone(occupancyAndGradient(prevP).w, t1, t2, row1Above, row2AndBelow);
  for (int i = 1; i < 512; i++) {
    if (i >= u_steps) break;
    float t = tStart + float(i) * stepSize;
    if (t > tEnd) break;
    vec3 p = ro + t * rd;
    bool nowCut = isCutZone(occupancyAndGradient(p).w, t1, t2, row1Above, row2AndBelow);
    if (nowCut != startCut) {
      vec3 a = prevP, b = p; // a stays on the startCut side, b on the other
      for (int k = 0; k < 6; k++) {
        vec3 mid = (a + b) * 0.5;
        bool midCut = isCutZone(occupancyAndGradient(mid).w, t1, t2, row1Above, row2AndBelow);
        if (midCut == startCut) a = mid; else b = mid;
      }
      hitP = (a + b) * 0.5;
      return true;
    }
    prevP = p;
  }
  return false;
}
// "Is there any real signal here at all" bar - used to classify whether a
// ray starts inside real tissue (see classifyThresh's comment where this
// is used, in main()). Was a fixed constant; now the BACKGROUND slider
// (u_background), so raising it is a genuine, user-controlled statement
// of "this is background noise" rather than a hardcoded assumption — but
// still deliberately independent from u_thresh/CUTOUT, so cutting out a
// dim tissue type (e.g. white matter, dark on a T2 scan) behind a clip
// plane still can never also erode the unrelated outer surface — see the
// long design discussion this separation resulted from.
// Stage 2 of the inner-ray search (see main()'s comment for stage 1, and
// why this two-stage split exists at all). Searches from the FAR side of
// the ray (tFar — the bounding box's own far edge) backward toward the
// clip cut, for the first point where occupancy rises above
// threshBackground: the TRUE outer envelope, found unambiguously from a
// starting point guaranteed to be real background (same guarantee the
// whole design already leans on elsewhere — the bounding box always sits
// in background), regardless of whatever internal structures — possibly
// themselves reading below threshBackground — sit between the clip cut
// and that far edge. A single forward pass can't tell "temporarily dark
// internal structure" apart from "genuinely exited to real background"
// using one threshold test; starting from a KNOWN-background point and
// searching backward sidesteps that ambiguity entirely instead of trying
// to resolve it heuristically mid-search.
bool findOuterBoundaryBackward(vec3 ro, vec3 rd, float tStart, float tFar, float stepSize,
                                float threshBackground, out vec3 hitP) {
  vec3 prevP = ro + tFar * rd;
  for (int i = 1; i < 512; i++) {
    if (i >= u_steps) break;
    float t = tFar - float(i) * stepSize;
    if (t < tStart) break;
    vec3 p = ro + t * rd;
    if (occupancyAndGradient(p).w >= threshBackground) {
      vec3 a = prevP, b = p; // a stays below threshBackground, b at/above it
      for (int k = 0; k < 6; k++) {
        vec3 mid = (a + b) * 0.5;
        if (occupancyAndGradient(mid).w < threshBackground) a = mid; else b = mid;
      }
      hitP = (a + b) * 0.5;
      return true;
    }
    prevP = p;
  }
  return false;
}
vec3 smoothedOccupancyNormal(vec3 p) {
  // Adjustable (default 1.0, matching prior fixed behavior) via
  // u_gradRadius — see its uniform declaration for why this is exposed
  // rather than hardcoded: a fixed sampling distance can alias against a
  // thin, high-intensity shell thinner than (or comparable to) itself,
  // making the estimated gradient DIRECTION flip almost randomly between
  // roughly-correct and wildly-wrong depending on exactly which voxel-grid
  // "terrace" each of the two sample points happens to land on - not a
  // degenerate/near-zero-magnitude problem (a real, non-tiny vector, just
  // an unreliable direction), which is why neither a magnitude cutoff nor
  // a magnitude-based confidence blend fixed it.
  float r = u_gradRadius;
  vec3 g = vec3(
    occupancyAndGradient(p+vec3(r,0.0,0.0)).w - occupancyAndGradient(p-vec3(r,0.0,0.0)).w,
    occupancyAndGradient(p+vec3(0.0,r,0.0)).w - occupancyAndGradient(p-vec3(0.0,r,0.0)).w,
    occupancyAndGradient(p+vec3(0.0,0.0,r)).w - occupancyAndGradient(p-vec3(0.0,0.0,r)).w
  );
  // Same anisotropy correction as gradient() above - "1 voxel" is not the
  // same physical distance in every axis for anisotropic data.
  return g / u_voxMm;
}

`;

// Fully separate shaders for translucent vs solid rendering, swapped on
// the mesh at exactly OPACITY=100% (see index.html's updateGlassBrainUniforms) -
// no blending between them at all. Both share GLASS_HELPERS_GLSL (uniforms +
// every sampling/search helper) and the SAME uniforms object, set on both
// materials in buildGlassBrain, so JS-side code updating a uniform never
// needs to know or care which material is currently active.
// Shared between GLASS_ONLY_FS and SOLID_ONLY_FS (spliced into both via
// template-literal interpolation below) - both shaders need this exact
// same clip-setup logic, and GLSL has no #include, so this is the same
// string-concatenation trick GLASS_HELPERS_GLSL itself already uses, just
// for a statement block instead of a set of function declarations.
const CLIP_SETUP_GLSL = `
  // Section-plane clipping: shrink [tStart,tEnd] by each active plane, in
  // local voxel-index space (same parametrization as ro + t*rd everywhere
  // else in this shader). D(t) = d0 + t*dn is the signed distance from the
  // plane along the ray.
  bool anyPlaneActive = false;
  for (int i = 0; i < 3; i++) {
    float dir = u_clipDir[i];
    if (dir == 0.0) continue;
    anyPlaneActive = true;
    float d0 = dot(ro - u_clipPoint[i], u_clipNormal[i]);
    float dn = dot(rd,                  u_clipNormal[i]);
    if (u_sliceMode > 0.5) {
      // SLICE: two parallel planes straddling the plane's own position by
      // ±halfT, replacing FLIP's one-sided half-space with a thin slab -
      // FLIP has no effect here, the slab is inherently symmetric. ta/tb
      // are the two crossings in EITHER order depending on the ray's
      // approach angle, so min/max sorts them into near/far regardless.
      float halfT = u_sliceThickness * 0.5;
      if (abs(dn) < 1e-8) {
        if (abs(d0) > halfT) tEnd = tStart - 1.0; // ray runs parallel to the slab, entirely outside it
      } else {
        float ta = (-halfT - d0) / dn;
        float tb = ( halfT - d0) / dn;
        tStart = max(tStart, min(ta, tb));
        tEnd   = min(tEnd,   max(ta, tb));
      }
    } else {
      // Ordinary one-sided cut: D>=0 (scaled by dir/FLIP) is kept, D<0 clipped.
      float d0dir = d0 * dir;
      float dndir = dn * dir;
      if (abs(dndir) < 1e-8) {
        if (d0dir < 0.0) tEnd = tStart - 1.0; // whole ray on the clipped side
      } else {
        float tCross = -d0dir / dndir;
        if (dndir > 0.0) tStart = max(tStart, tCross);
        else             tEnd   = min(tEnd, tCross);
      }
    }
  }
  if (u_sliceMode > 0.5 && anyPlaneActive) {
    // Cap the slab's visible cross-section width in T, regardless of
    // viewing angle. A ray grazing along the slab at a steep angle
    // crosses the ±halfThickness band very slowly (width scales as
    // 1/|dn|, dn = dot(rd,normal)), so as the angle approaches true
    // edge-on this window can legitimately balloon far wider than the
    // slab's own intended thickness. With a FIXED step count spread over
    // that much wider window, each step becomes correspondingly larger -
    // easily large enough to step clean over thin tissue structures
    // without ever landing a sample on them, which reads as the slab
    // going dark (RIM-LIT) or losing surfaces entirely (SOLID/GLASS) at
    // grazing angles - undersampling, not a brightness/shading problem.
    // Shrinking the window back to a fixed cap, symmetrically around its
    // own centre (not just clamping tEnd, which would bias the visible
    // cross-section toward the near side), keeps step density roughly
    // constant regardless of angle instead.
    float maxWidth = u_sliceThickness * u_sliceWidthCapMult;
    if (tEnd - tStart > maxWidth) {
      float mid = (tStart + tEnd) * 0.5;
      tStart = mid - maxWidth * 0.5;
      tEnd   = mid + maxWidth * 0.5;
    }
  }
  if (tEnd <= tStart) discard;
`;

const GLASS_ONLY_FS = GLASS_HELPERS_GLSL + `
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

${CLIP_SETUP_GLSL}
  float stepSize = (tEnd - tStart) / float(u_steps);
  float mmPerStep = length(rd * u_voxMm) * stepSize;
  float accAlpha = 0.0;
  vec3  accColor = vec3(0.0);
  bool labelMode = (u_applyLUT > 0.5) && (u_isColor < 0.5);

  // Same compile-time-bound caveat as findIsosurface's loop in the solid
  // shader - must stay comfortably above the highest u_steps any quality
  // tier uses.
  for (int i = 0; i < 512; i++) {
    if (i >= u_steps) break;
    float t = tStart + (float(i) + 0.5) * stepSize;
    vec3 p = ro + t * rd;
    float intensity;
    vec3 grad;
    vec3 col;
    if (labelMode) {
      intensity = labelBorder(p);
      if (intensity < 0.5) continue; // interior voxel, not a region boundary
      grad = labelNormal(p);
      col = lutColor(sampleLabelIndex(p));
    } else {
      intensity = sampleVol(p);
      if (intensity < u_thresh) continue;
      grad = gradient(p);
    }
    float gLen = length(grad);
    if (gLen < 0.0001) continue;
    float rim = 1.0 - abs(dot(grad / gLen, rd));
    rim = pow(rim, u_rimPow);
    float normStep = mmPerStep / u_volDiagMm;
    // For DEC/colour volumes, suppress the low-FA "gray matter halo": a
    // single threshold can't distinguish faint-but-real white matter from
    // faint gray-matter noise, since both clear the same cutoff, and gray
    // matter forms a thick shell — many weak per-voxel contributions along
    // that whole path still add up to visible haze even when each is small.
    // Ramp alpha over a narrow, steep band above threshold so only voxels
    // well past it (white matter tracts) contribute meaningfully.
    float faWeight = 1.0;
    if (u_isColor > 0.5) {
      faWeight = pow(smoothstep(u_thresh, u_thresh + 0.12, intensity), 2.5);
    }
    if (!labelMode) {
      // Contrast slider (shared with the 2D slice panels): a straight gain
      // on top of DEC's baseline boost for colour volumes (their values sit
      // near 0, not a midtone), or a stretch around mid-gray for scalar
      // shading. Only affects the displayed colour — NOT intensity, which
      // stays untouched for the threshold/gradient/alpha logic above.
      float scalarDisp = gammaContrast(intensity, 1.0 / u_contrast);
      col = (u_isColor > 0.5 && u_forceGray < 0.5)
        // DEC colours are inherently dim (each channel is FA*|eigenvector|,
        // rarely above ~0.7) — boost and gamma-lift rather than applying the
        // grayscale intensity-based darkening below, which would compound.
        ? pow(clamp(sampleRaw(p) * 1.6 * u_contrast, 0.0, 1.0), vec3(0.8))
        : mix(vec3(0.25, 0.3, 0.35), vec3(0.75, 0.8, 0.85), scalarDisp);
    }
    float a   = clamp(rim * u_alpha * normStep * faWeight, 0.0, 1.0);
    accColor += (1.0 - accAlpha) * a * col;
    accAlpha += (1.0 - accAlpha) * a;
    if (accAlpha > 0.95) break;
  }

  if (accAlpha < 0.002) discard;
  // Translucent mode blends many samples along the ray into one pixel -
  // there's no single correct depth to give, so this always writes the
  // nearest possible value, matching this mesh's old depthTest:false
  // "always on top" behaviour for this specific (non-opaque) case.
  gl_FragDepth = 0.0;
  gl_FragColor = vec4(accColor, accAlpha);
}
`;

const SOLID_ONLY_FS = GLASS_HELPERS_GLSL + `
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

${CLIP_SETUP_GLSL}
  float stepSize = (tEnd - tStart) / float(u_steps);
  bool labelMode = (u_applyLUT > 0.5) && (u_isColor < 0.5);

  bool haveHit = false;
  bool isCap   = false;
  vec3 hitP;

  // Whether this ray starts already inside real tissue (only possible
  // via a clip plane cutting into it) is decided by a threshold that
  // NEVER depends on isoThresh/u_thresh/CUTOUT - u_background (BACKGROUND
  // in Settings) instead (0.5 for labels, same as isoThresh there, since
  // labels have no continuous brightness spectrum to separate the two
  // thresholds over in the first place). This is what keeps the outer
  // surface from ever eroding when raising CUTOUT to hide a dim tissue
  // type (e.g. white matter on a T2 scan): classification never depends
  // on that slider, so an ordinary ray (the bounding-box entry is always
  // background) can never accidentally take the "starts inside" branch
  // below no matter how high CUTOUT goes - meaning CUTOUT has NO effect
  // at all on an unclipped view. The white-matter-clearing effect only
  // ever happens behind an active clip plane, by design: that's the only
  // place a ray can legitimately start already inside tissue at all.
  //
  // startInside also DIRECTLY drives shading mode below (see shade's
  // computation): every hit found while startInside is true happens
  // behind an active clip plane, one way or another (the cap, stage 1 of
  // the dim-material search, stage 2's backward search, or the COVER-off
  // bright-material case) - all of it gets the dimmer, two-sided
  // treatment uniformly, since all of it is "looking inside" in the same
  // sense, regardless of which of those sub-cases actually found it. Only
  // the plain outer-surface search (startInside false) gets the brighter,
  // front-facing treatment. This is a deliberate simplification: stage 1
  // succeeding (intensity rising past isoThresh - a genuine, well-oriented
  // "entering solid material" crossing, not really a backward-facing exit
  // at all) would technically deserve its own, third shading treatment,
  // but that's an uncommon enough case that reusing the dimmer material
  // for it too was judged not worth a third mode.
  // BACKGROUND's slider value always means the same raw brightness cutoff
  // regardless of below/above - occupancyAndGradient flips the occupancy
  // VALUE (1-rawVal) when inverted, so the threshold compared against it
  // is flipped the same way here, canceling back out to a direct raw-value
  // comparison either way (see occupancyAndGradient's comment for the
  // value side of this). Without this, "above" would leave the slider
  // number meaning something like "1 minus what it shows" - technically
  // consistent, but not what the number on screen would suggest.
  float classifyThresh = labelMode ? 0.5 : (u_bgInvert > 0.5 ? 1.0 - u_background : u_background);
  bool startInside = occupancyAndGradient(ro + tStart * rd).w >= classifyThresh;

  if (startInside) {
    // Real tissue right at the clip cut. COVER (u_fillIn) decides
    // whether to paint a flat cap when that tissue is ALSO on the KEEP
    // side of isoThresh (i.e. not the side CUTOUT hides).
    //
    // occupancyAndGradient, NOT sampleVol: this is a threshold/classification
    // decision (compared against isoThresh below), so it needs the SAME
    // BACKGROUND-polarity-aware, extra-smoothed occupancy field every other
    // threshold decision in this file goes through. A raw sampleVol read
    // here would silently ignore u_bgInvert - correct only when BACKGROUND
    // is set to "below" (no flip), and wrong the moment "above" is used on
    // inverted-polarity data (e.g. bright-background microscopy), since
    // this cap decision would then compare a raw value against a threshold
    // meant to be read in flipped terms.
    float capOcc = occupancyAndGradient(ro + tStart * rd).w;
    // CUTOUT is now a two-threshold system (u_cutoutT1/u_cutoutBelowThresh,
    // combined via u_cutoutRow1Above/u_cutoutRow2AndBelow — u_thresh is no
    // longer involved at all, see its own declaration comment) - see
    // isCutZone's comment for the exact rule this implements. Note this
    // needs no change to findOuterBoundaryBackward,
    // and CUTOUT's own search (findCutoutBoundary) is already bidirectional
    // the same way findIsosurface is - only this caller-side branching needs
    // to know which side capOcc falls on.
    bool onCutSide = isCutZone(capOcc, u_cutoutT1, u_cutoutBelowThresh, u_cutoutRow1Above > 0, u_cutoutRow2AndBelow > 0);
    bool hasCapData = u_fillIn > 0.5 && (labelMode || !onCutSide);
    if (hasCapData) {
      hitP = ro + tStart * rd; isCap = true; haveHit = true;
    } else if (!labelMode && onCutSide) {
      // Material right at the cut is on CUTOUT's hidden side. Two
      // genuinely separate stages, not a single forward pass with a
      // background-dip escape hatch: stage 1 only ever looks for where
      // the ray leaves the cut zone - never for a background dip
      // mid-search, because an INTERNAL structure that happens to read
      // below background level (classifyThresh) would otherwise be
      // misidentified as "the ray has exited the tissue," producing a
      // false outer-shell detection deep inside the brain instead of
      // continuing to search past it. Only once stage 1 has genuinely
      // found nothing before reaching the far side does stage 2 run,
      // searching BACKWARD from that guaranteed-background far edge for
      // the true outer envelope - see findOuterBoundaryBackward's
      // comment for why that sidesteps the ambiguity entirely rather
      // than trying to resolve it heuristically.
      // In practice stage 2 always succeeds once stage 1 has failed,
      // since capOcc (tStart itself) already clears classifyThresh — but
      // its own last checked sample sits one step short of tStart exactly
      // (see its loop bound), so this still checks its return value
      // rather than assuming success, to avoid ever rendering a stale/
      // uninitialized hitP in that theoretical sliver of a gap.
      //
      // Under SLICE, tEnd is no longer the natural bounding-box edge —
      // it's the slab's OWN far plane, which can land anywhere, including
      // well inside real tissue. findOuterBoundaryBackward's own
      // "starting point is guaranteed background" assumption would then
      // be violated, and searching backward from a point that's actually
      // still inside tissue could find a spurious crossing that isn't a
      // real boundary at all. So under SLICE specifically, that
      // assumption is checked explicitly first — if it fails, this ray
      // is left as no-hit (discard/see-through) rather than risking a
      // wrong detection.
      haveHit = findCutoutBoundary(ro, rd, tStart, tEnd, stepSize, u_cutoutT1, u_cutoutBelowThresh, u_cutoutRow1Above > 0, u_cutoutRow2AndBelow > 0, hitP);
      if (!haveHit) {
        bool farIsBackground = (u_sliceMode < 0.5) || (occupancyAndGradient(ro + tEnd * rd).w < classifyThresh);
        if (farIsBackground) {
          haveHit = findOuterBoundaryBackward(ro, rd, tStart, tEnd, stepSize, classifyThresh, hitP);
        }
      }
    } else if (findCutoutBoundary(ro, rd, tStart, tEnd, stepSize, u_cutoutT1, u_cutoutBelowThresh, u_cutoutRow1Above > 0, u_cutoutRow2AndBelow > 0, hitP)) {
      // COVER off, but the material right at the cut is already on the
      // KEEP side - unchanged "look inside" behavior: find where THIS
      // material itself ends (its own exit boundary).
      haveHit = true;
    }
  } else {
    // Ordinary case: ray starts in real background - either the
    // natural bounding-box entry (true for essentially every unclipped
    // ray), or a clip plane landing on genuine background (e.g. a
    // ventricle). Always searches for classifyThresh (the fixed outer
    // bar), completely independent of THRESHOLD/isoThresh - this is
    // what keeps this surface from ever eroding regardless of how high
    // THRESHOLD is pushed for the clip-plane reveal effect above.
    if (findIsosurface(ro, rd, tStart, tEnd, stepSize, classifyThresh, hitP)) {
      haveHit = true;
    }
  }

  if (!haveHit) discard;

  vec3 baseColor;
  float shade;
  // Fully opaque by default (SOLID mode, and the flat cap in any mode —
  // an artificial cross-section has no curved surface for a rim/Fresnel
  // term to mean anything on). GLASS mode (u_shellMode) overrides this
  // below, for the one case a Fresnel term genuinely applies to: a real
  // curved surface with a well-defined normal.
  float fragAlpha = 1.0;
  if (isCap) {
    // Flat, unlit — like the 2D slice panels: this is an artificial
    // cut face, not a real anatomical boundary, so isosurface-style
    // rim/normal shading would be meaningless here (and the gradient
    // at an arbitrary cut is often close to zero anyway).
    // Label/LUT: nearest-neighbour, not interpolatedLutColor's trilinear
    // blend. The blend is what makes the isosurface itself look good -
    // but a cut face is a flat cross-section, exactly like the 2D slice
    // panels, which also read raw per-voxel labels with no blending.
    baseColor = labelMode ? lutColor(sampleLabelIndex(hitP))
              : (u_isColor > 0.5 && u_forceGray < 0.5
                  ? pow(clamp(sampleRaw(hitP) * 1.6 * u_contrast, 0.0, 1.0), vec3(0.8))
                  : vec3(gammaContrast(sampleVol(hitP), 1.0 / u_contrast)));
    shade = 1.0;
  } else {
    // Guard against a degenerate (near-zero) gradient before
    // normalizing — normalize() on a zero-length vector is NaN in
    // GLSL, which renders as solid black. This becomes reachable
    // once real anatomy gets thin enough (a sliver of gray matter
    // only a voxel or so thick, once THRESHOLD has carved away most
    // of it) that the ±1-voxel sampling in smoothedOccupancyNormal
    // straddles both sides of the whole feature and cancels out,
    // rather than landing cleanly on one side of a normal-thickness
    // boundary. Falling back to facing the camera isn't a "correct"
    // normal, but it's a reasonable one, and infinitely better than
    // NaN-black on exactly the thin, hard-won slivers of tissue this
    // whole feature exists to reveal.
    vec3 rawGrad = smoothedOccupancyNormal(hitP);
    vec3 N = (dot(rawGrad, rawGrad) < 1e-8) ? -rd : normalize(rawGrad);
    // Resample slightly inside the surface (N points from background
    // toward tissue) rather than exactly at the ambiguous crossing, for
    // a cleaner normal - and, for colour sampling below (both label+LUT
    // and DEC), so it doesn't land back on background.
    vec3 inwardP = hitP + N * 0.5;
    rawGrad = smoothedOccupancyNormal(inwardP);
    if (dot(rawGrad, rawGrad) >= 1e-8) N = normalize(rawGrad); // else keep the already-valid N from above

    // GLASS mode: a real Fresnel rim on the actual isosurface, instead of
    // full opacity — same rim formula the TRANSLUCENT shader's own accumulated
    // Fresnel term uses (and the same RIM/u_rimPow control), just applied
    // once to a single resolved hit instead of many accumulated samples,
    // so it reads as a thin glass shell rather than a haze. Only the flat
    // cap (isCap, handled above) is excluded — reasonably, since it has no
    // curved surface for a rim term to mean anything on.
    //
    // u_glassAlphaMult gives OPACITY a real, analogous effect here too:
    // 1.0 at OPACITY's default/centre position (unmodified Fresnel, the
    // look already tuned and confirmed to look good), fading toward fully
    // transparent below that and boosting toward more solid-looking above
    // it - the same "neutral at centre" idea as RIM's own slider, just
    // computed from a different curve since a single-sample multiplier
    // isn't the same kind of quantity as RIM-LIT's accumulated density.
    if (u_shellMode > 0.5) {
      float rim = 1.0 - abs(dot(N, rd));
      fragAlpha = clamp(pow(rim, u_rimPow) * u_glassAlphaMult, 0.0, 1.0);
    }
    // N points from background toward tissue (established by this same
    // gradient's sign convention throughout the file), so a normal
    // entry surface faces toward the light and dot(N,u_lightDir)>0. A
    // surface found while startInside (see its own comment above) is the
    // opposite in general: its natural gradient often faces back the way
    // the ray came (a COVER=off exit boundary, or stage 2's backward-
    // found envelope both do, by construction; stage 1 succeeding is the
    // one exception, still lumped in here as a deliberate simplification -
    // see startInside's comment), so straight front-facing shading would
    // render those cases almost uniformly dark. Two-sided shading here
    // instead — these are otherwise either invisible internal walls or
    // reused for a case that doesn't fully need it, so showing them
    // regardless of which way they happen to face is more useful than
    // risking a dark silhouette.
    //
    // startInside also gets a deliberately dimmer, flatter treatment on
    // top of that: peeking inside a solid object is exactly the situation
    // where light doesn't reach directly, so both the ambient floor and
    // the diffuse term's own weight are pulled down versus the
    // exterior's fuller-range, brighter shading.
    float diffuse = startInside ? abs(dot(N, u_lightDir)) : max(dot(N, u_lightDir), 0.0);
    shade = startInside ? (0.3 + 0.5 * diffuse)
                        : (0.2 + 0.8 * diffuse);

    if (labelMode) {
      // Sample at inwardP, not hitP: hitP sits wherever the blended
      // occupancy exactly equals u_thresh, which for label data (raw
      // integer values, not a normalized [0,1] range) can be barely
      // inside the region in blend-weight terms whenever threshold is
      // small relative to the label's own value. inwardP moves the
      // sample solidly into real tissue instead.
      baseColor = interpolatedLutColor(inwardP);
    } else if (u_isColor > 0.5 && u_forceGray < 0.5) {
      // DEC/colour volume: the actual FA-weighted direction colour,
      // same boost as glass mode, at the same inward-nudged point.
      baseColor = pow(clamp(sampleRaw(inwardP) * 1.6 * u_contrast, 0.0, 1.0), vec3(0.8));
    } else {
      // Plain scan: shading alone defines the surface. startInside gets a
      // faint cool/blue tint (vs. neutral white outside), a cheap visual
      // cue for "you're looking at an interior surface" independent of
      // the shade-floor difference above.
      baseColor = startInside ? vec3(0.8,0.8,1.0) : vec3(1.0);
    }
  }
  vec3 solidColor = baseColor * shade;
  // TEMPORARY DEBUG (remove once the thin-structure issue is
  // understood): paints every hit a flat, unmistakable color by which
  // code path produced it, ignoring real shading entirely. Toggle from
  // the console:
  //   window._glassBrainMesh.material.uniforms.u_debugDarkNormals.value = 1;
  //   window._renderer3.render(window._scene, window._camera);
  if (u_debugDarkNormals > 0.5) {
    solidColor = isCap ? vec3(0.0, 0.3, 1.0)      // blue: flat cap
               : startInside ? vec3(1.0, 0.9, 0.0) // yellow: two-sided/"inside" style hit
               : vec3(0.0, 1.0, 0.2);              // green: ordinary front-facing hit
    fragAlpha = 1.0; // always fully opaque in debug view, regardless of GLASS mode's rim alpha, for a clear read
  }

  // Depth is always written from the true projected hit position - the
  // brain correctly occludes, or is occluded by, other scene objects like
  // the section planes, instead of the "always on top" approximation the
  // TRANSLUCENT shader uses. In SOLID mode the material also has
  // depthWrite enabled, so this actually reaches the depth buffer. GLASS
  // mode's material has depthWrite disabled instead: this fragment's own
  // depth test against whatever's already drawn still uses this value (so
  // opaque geometry genuinely in front of the shell still correctly hides
  // it), but the shell's own depth is never written afterward - so it
  // never occludes anything drawn behind it, which is what leaves
  // streamlines and other geometry visible through it.
  vec3 worldPos = (u_model * vec4(hitP - u_size * 0.5, 1.0)).xyz;
  vec4 clipPos = u_projView * vec4(worldPos, 1.0);
  float fragDepth = clipPos.z / clipPos.w * 0.5 + 0.5;

  gl_FragDepth = clamp(fragDepth, 0.0, 1.0);
  gl_FragColor = vec4(solidColor, fragAlpha);
}
`;


export function buildGlassBrain(anat, texData, scene, renderer3, camera, dispInfo) {
  const isColor = (anat.channels || 1) === 3;
  const isLabelMode = !isColor && !!(dispInfo && dispInfo.apply && dispInfo.map);

  // ── Mobile-GPU capability diagnostics ──────────────────────
  // Two specific, plausible causes of an early/silent crash on weak mobile
  // GPUs, checked and reported clearly (console + thrown Error, so the
  // page's global error banner picks it up) rather than letting either
  // condition proceed into undefined driver behavior:
  const gl = renderer3.getContext();
  // 1) A too-large volume for this GPU's 3D texture support. Uploading
  //    past this limit isn't a clean, catchable GL error on every driver —
  //    on some it's exactly the kind of thing that can crash outright.
  const max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  if (Math.max(...anat.shape) > max3D) {
    throw new Error(`Glass brain: volume shape ${anat.shape.join('x')} exceeds this GPU's MAX_3D_TEXTURE_SIZE (${max3D}) — cannot upload.`);
  }
  // 2) R32F (used below for scalar/non-label volumes) is only a FILTERABLE
  //    format per the WebGL2/GLES3 spec when OES_texture_float_linear is
  //    present — plenty of cheap mobile GPUs lack it. Requesting LINEAR
  //    filtering on an unfilterable format is invalid GL state with
  //    genuinely undefined behavior, which on a fragile mobile driver is a
  //    very plausible way to get exactly the kind of early, silent crash
  //    being chased right now. Not switched to a fallback filter mode yet
  //    (that needs a matching change to the shader's own corner-sampling
  //    logic, which currently assumes real hardware LINEAR whenever this
  //    isn't label mode - see occupancyAndGradient's nearestFiltered
  //    branch) — for now this only reports the condition clearly so it can
  //    be confirmed before touching that.
  const hasFloatLinear = !!gl.getExtension('OES_texture_float_linear');
  if (!isColor && !isLabelMode && !hasFloatLinear) {
    console.warn('Glass brain: OES_texture_float_linear is NOT supported on this GPU, but the scalar volume texture is being created with LINEAR filtering anyway (required for the current smoothing scheme) — this is invalid GL state on this device and a likely cause of instability.');
  }
  // Logged unconditionally too, since a webgl2 debug_renderer_info string
  // (actual GPU model, where available) is exactly what's most useful to
  // have on hand once real DevTools access is sorted out.
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  console.info('Glass brain GPU info:', {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor:   dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR),
    max3DTextureSize: max3D,
    volumeShape: anat.shape,
    hasFloatLinear,
  });

  const tex = new THREE.Data3DTexture(texData, ...anat.shape);
  // Colour/DEC volumes are uploaded as normalized RGBA8 (see VolRenderer.upload)
  // — 256 levels/channel is visually plenty and it's 1/4 the memory of float.
  // Scalar volumes stay single-channel float RED for intensity windowing.
  tex.format         = isColor ? THREE.RGBAFormat : THREE.RedFormat;
  tex.type           = isColor ? THREE.UnsignedByteType : THREE.FloatType;
  tex.internalFormat = isColor ? 'RGBA8' : 'R32F';
  // Label volumes need exact (NEAREST) lookups — interpolating between two
  // different label indices produces spurious in-between values with no
  // real meaning (same reasoning as the 2D slice renderer's LUT mode).
  tex.minFilter      = isLabelMode ? THREE.NearestFilter : THREE.LinearFilter;
  tex.magFilter      = isLabelMode ? THREE.NearestFilter : THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate    = true;

  const Ab  = anat.Ab;
  // hx,hy,hz bridges two different index conventions: the raymarcher's own
  // local coordinate space (below, and throughout occupancyAt/sampleVol)
  // treats voxel index i as texel i's LOWER BOUNDARY - its center sits at
  // i+0.5, the standard texture-sampling convention - while Ab (the NIfTI
  // affine) treats index i as ALREADY being that voxel's center, no offset
  // needed. So the true center-of-volume in Ab's terms is (shape-1)/2, not
  // shape/2 - using shape/2 here (missing that -0.5) shifted the entire
  // glass brain's world-space position by half a voxel in every axis
  // relative to the true affine, which is what the 2D slice view and
  // section planes correctly use - hence the mismatch between them.
  const hx = (anat.shape[0]-1) / 2, hy = (anat.shape[1]-1) / 2, hz = (anat.shape[2]-1) / 2;
  const tx = Ab[0][0]*hx + Ab[0][1]*hy + Ab[0][2]*hz + Ab[3][0];
  const ty = Ab[1][0]*hx + Ab[1][1]*hy + Ab[1][2]*hz + Ab[3][1];
  const tz = Ab[2][0]*hx + Ab[2][1]*hy + Ab[2][2]*hz + Ab[3][2];
  const modelMatrix = new THREE.Matrix4().set(
    Ab[0][0], Ab[0][1], Ab[0][2], tx,
    Ab[1][0], Ab[1][1], Ab[1][2], ty,
    Ab[2][0], Ab[2][1], Ab[2][2], tz,
          0,       0,       0,  1
  );
  const invModel = modelMatrix.clone().invert();

  // Three.js manages its own WebGL context, separate from VolRenderer's
  // raw one — the LUT texture there can't be reused here, so build an
  // identically-encoded copy from the same lutMap. A tiny dummy texture
  // stands in when no LUT is loaded, so u_lut is always a valid, distinct
  // texture (leaving a sampler uniform unassigned defaults it to unit 0,
  // colliding with u_vol's sampler3D there — see the earlier 2D-slice fix
  // for the same issue).
  let lutTex, lutSize = 1;
  if (isLabelMode) {
    const { data, size } = buildLutRGBA(dispInfo.map, dispInfo.maxIndex);
    lutTex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lutTex.minFilter = THREE.NearestFilter;
    lutTex.magFilter = THREE.NearestFilter;
    lutTex.needsUpdate = true;
    lutSize = size;
  } else {
    lutTex = new THREE.DataTexture(new Uint8Array([0,0,0,0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lutTex.needsUpdate = true;
  }

  const sharedUniforms = {
      u_vol:       { value: tex },
      u_size:      { value: new THREE.Vector3(...anat.shape) },
      u_voxMm:     { value: new THREE.Vector3(...anat.vox_mm) },
      u_volDiagMm: { value: Math.sqrt(
                       (anat.shape[0] * anat.vox_mm[0])**2 +
                       (anat.shape[1] * anat.vox_mm[1])**2 +
                       (anat.shape[2] * anat.vox_mm[2])**2) },
      u_alpha:     { value: 5.0 },
      u_thresh:    { value: 0.15 }, // RIM-LIT's accumulation cutoff only now — see its declaration comment
      u_cutoutT1:  { value: 0.0 },  // cutout row 1's own threshold, decoupled from u_thresh
      u_cutoutBelowThresh: { value: 1.0 }, // cutout row 2's threshold — [0,1] combined via AND by default = every value = cutout off
      u_cutoutRow1Above:    { value: 1 }, // 1 = "above" (>=), 0 = "below" (<=)
      u_cutoutRow2AndBelow: { value: 1 }, // 1 = "and below" (AND), 0 = "or above" (OR)
      u_background: { value: 0.03 },
      u_bgInvert: { value: 0 },
      u_sliceMode: { value: 0 },
      u_sliceThickness: { value: 3.0 },
      u_sliceWidthCapMult: { value: 15.0 },
      u_glassAlphaMult: { value: 1.0 },
      u_rimPow:    { value: 1.0 },
      u_contrast:  { value: 1.0 },
      // Starts throttled (see index.html's useDraggingStepCount, which
      // ramps this back up to full quality shortly after every rebuild):
      // the render call a few lines down, right after this material is
      // created, is the very FIRST time this shader actually executes on
      // the GPU — on a weak mobile GPU, that unthrottled first frame alone
      // has been enough to trip a driver watchdog and lose the WebGL
      // context outright, with no user interaction involved at all.
      u_steps:     { value: 40 },
      u_invPV:     { value: new THREE.Matrix4() },
      u_invModel:  { value: invModel },
      u_camPos:    { value: new THREE.Vector3() },
      u_isColor:   { value: isColor ? 1 : 0 },
      u_forceGray: { value: dispInfo.forceGray ? 1 : 0 },
      u_debugDarkNormals: { value: 0 }, // TEMPORARY DEBUG - see its GLSL comment
      u_gradRadius: { value: 1.0 }, // TEMPORARY TUNING - see smoothedOccupancyNormal's comment
      u_shellMode: { value: 0 }, // GLASS mode flag — see its GLSL comment
      u_applyLUT:  { value: isLabelMode ? 1 : 0 },
      u_lut:       { value: lutTex },
      u_lutSize:   { value: lutSize },
      u_dataMin:   { value: anat.mn || 0 },
      u_dataRange: { value: (anat.mx - anat.mn) || 1 },
      u_model:     { value: modelMatrix },
      u_projView:  { value: new THREE.Matrix4() },
      // Section-plane clipping (anatomy only) — see updateClipUniforms()
      // in index.html, which keeps these in sync with the PLANES controls,
      // the section-plane rotation (PITCH/YAW/ROLL), and plane position.
      // Disabled (u_clipDir=0) for all three planes by default.
      u_clipDir:    { value: [0, 0, 0] },
      u_clipNormal: { value: [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)] },
      u_clipPoint:  { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      u_fillIn:     { value: 1.0 },
      u_lightDir:   { value: new THREE.Vector3(0, 0, 1) },
  };

  // Three fully separate materials/shaders, swapped on the mesh according
  // to the MODE control (see index.html's updateGlassBrainUniforms) — no
  // blending between them. All three share this SAME uniforms object, so
  // JS-side code updating a uniform never needs to know or care which is
  // currently active. GLASS reuses SOLID_ONLY_FS's exact same shader
  // (same hit-finding, same clip-plane/COVER behavior) rather than a
  // separate near-duplicate — the two differ only in the u_shellMode
  // uniform (opaque vs Fresnel-rim alpha, computed inside that shared
  // shader) and in these three material-level settings (transparency and
  // depth handling).
  const glassMat = new THREE.ShaderMaterial({
    vertexShader:   GLASS_VS,
    fragmentShader: GLASS_ONLY_FS,
    uniforms: sharedUniforms,
    transparent: true,
    depthWrite:  true,
    depthTest:   true,
  });
  const solidMat = new THREE.ShaderMaterial({
    vertexShader:   GLASS_VS,
    fragmentShader: SOLID_ONLY_FS,
    uniforms: sharedUniforms,
    transparent: false, // always genuinely opaque — no blending case to support
    depthWrite:  true,
    depthTest:   true,
  });
  const shellMat = new THREE.ShaderMaterial({
    vertexShader:   GLASS_VS,
    fragmentShader: SOLID_ONLY_FS, // same shader as solidMat — see comment above
    uniforms: sharedUniforms,
    transparent: true,
    depthWrite:  false, // real transparency: streamlines/other geometry behind the shell stay visible through it
    depthTest:   true,
  });

  const geo  = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, glassMat); // default; index.html's updateGlassBrainUniforms corrects this immediately based on the current MODE setting
  mesh.userData.glassMaterial = glassMat;
  mesh.userData.solidMaterial = solidMat;
  mesh.userData.shellMaterial = shellMat;
  mesh.userData.renderMode = 'translucent';
  mesh.frustumCulled = false;
  mesh.renderOrder   = 999;

  const _pv = new THREE.Matrix4();
  // Offset from the view direction, in camera space: mostly forward, plus
  // some down/left-right lean - "three-quarter" studio lighting. Exposed as
  // mutable mesh.userData.lightCam (default: dead ahead, i.e. CENTER) so
  // index.html's LIGHT slider can move it, including all the way back to
  // (0,0,1) - pure view-aligned - which reproduces the original camera-glued
  // "headlamp" light exactly. Recomputed into world space from the camera's
  // own basis each frame so it always reads as coming from the same
  // direction relative to the VIEWER regardless of how far they've orbited,
  // then converted into local voxel-index space the same way rd is (see
  // main()'s "rd = normalize(mat3(u_invModel) * rd_world)"). This is a
  // plain per-frame vector update piggybacking on the render Three.js
  // already does for camera movement — no extra draw calls, no idle redraw
  // loop, so it costs nothing while the view is static.
  mesh.userData.lightCam = new THREE.Vector3(0, 0, 1);
  const _camRight   = new THREE.Vector3();
  const _camUp      = new THREE.Vector3();
  const _camFwd     = new THREE.Vector3();
  const _lightWorld = new THREE.Vector3();
  mesh.onBeforeRender = (renderer, scene, cam) => {
    _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    sharedUniforms.u_projView.value.copy(_pv);
    sharedUniforms.u_invPV.value.copy(_pv).invert();
    sharedUniforms.u_camPos.value.copy(cam.position);

    const lightCam = mesh.userData.lightCam;
    _camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    _camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    _camFwd.setFromMatrixColumn(cam.matrixWorld, 2).multiplyScalar(-1); // camera looks down -Z
    _lightWorld.set(0, 0, 0)
      .addScaledVector(_camRight, lightCam.x)
      .addScaledVector(_camUp,    lightCam.y)
      .addScaledVector(_camFwd,   lightCam.z)
      .normalize();
    sharedUniforms.u_lightDir.value.copy(_lightWorld).transformDirection(invModel).normalize();
  };

  scene.add(mesh);
  // Initial compile — forces shader errors to surface now, for all three
  // materials (whichever one ends up actually selected happens moments
  // later, in index.html's updateGlassBrainUniforms). shellMat reuses
  // solidMat's exact shader source, so this is likely already a cache hit
  // by the time it runs — cheap insurance either way.
  mesh.material = glassMat;
  renderer3.render(scene, camera);
  if (renderer3.getContext().getError()) console.error('Glass brain: WebGL error after first render (translucent shader)');
  mesh.material = solidMat;
  renderer3.render(scene, camera);
  if (renderer3.getContext().getError()) console.error('Glass brain: WebGL error after first render (solid shader)');
  mesh.material = shellMat;
  renderer3.render(scene, camera);
  if (renderer3.getContext().getError()) console.error('Glass brain: WebGL error after first render (glass/shell shader)');
  mesh.material = glassMat;
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


// ── Streamline shading: tangent-based anisotropic sheen ─────────────────
// Kajiya-Kay strand shading (the standard hair/fur-rendering model,
// originally adopted here because a 1px GL_LINE has no cross-section for
// a normal to vary across — see the "why not fake-normal shading"
// discussion this came from; that flat-line renderer has since been
// retired in favor of RIBBON_VS below, but the shading math carries over
// completely unchanged — Kajiya-Kay was never dependent on line width).
// Diffuse/specular are both functions of the angle between the SEGMENT
// TANGENT and the light/half vectors, not a surface normal, which is what
// lets this same fragment shader serve ribbon geometry with zero changes.
// This gives a dynamic sheen that shifts as the view rotates, which reads
// as "lit fiber" rather than flat color, but it is NOT the same as true
// roundness — a real round-tube look needs actual cross-section shading
// (true cylinder geometry), which even the ribbon doesn't have.
export const LINE_FS = `
precision highp float;
varying vec3  vColor;
varying vec3  vBundleColor;
varying vec3  vTangent;
varying vec3  vWorldPos;
uniform vec3  u_lightDir;
// 0 = uniform u_lineColor (custom picker), 1 = per-vertex RAS direction
// (vColor), 2 = per-instance fixed bundle color (vBundleColor).
uniform int   u_autoColor;
uniform vec3  u_lineColor;
uniform float u_ambient;
uniform float u_diffuseStrength;
uniform float u_specStrength;
uniform float u_specPower;
uniform vec3  u_camFwd;
uniform vec3  u_depthTarget;
uniform float u_depthRadius;
// Both default enabled (see sharedLineUniforms) — AO switches
// u_depthAttenEnabled off automatically (the view-axis depth darkening
// was always a placeholder for real occlusion; stacking both multiplies
// their darkening together and fights AO's more precise signal rather
// than complementing it). u_reflectance is a plain user strength control
// (REFLECTANCE, always visible, not tied to AO/ULTRA at all) — unlike
// the depth cue, the sheen isn't redundant with AO (AO only ever reads
// the depth buffer, no lighting-direction awareness at all), so it's
// left as an independent dial rather than coupled to anything.
uniform int   u_depthAttenEnabled;
uniform float u_reflectance; // 0 = flat base color, 1 = normal strength, >1 exaggerated
void main() {
  vec3 base = (u_autoColor == 1) ? vColor : ((u_autoColor == 2) ? vBundleColor : u_lineColor);
  vec3 T = normalize(vTangent);
  vec3 L = normalize(u_lightDir);
  vec3 V = normalize(cameraPosition - vWorldPos);
  // Kajiya-Kay: both terms are trig functions of the angle to the
  // TANGENT (sin, via the Pythagorean identity from the cosine dot
  // product), not to a surface normal — this is what makes it well-
  // defined on a strand/line with no well-formed normal of its own.
  // Brightest at T PERPENDICULAR to L (sin=1), darkest at T PARALLEL/
  // ANTI-PARALLEL to L (sin=0) — same as a real cylindrical strand: light
  // travelling along the strand's own axis never faces any point on its
  // surface head-on (a cylinder's normals all point outward, perpendicular
  // to the axis, so N·L is ~0 all the way around), while light from the
  // side lights up the whole half-circumference facing it.
  float TdotL    = dot(T, L);
  float diffuse  = sqrt(clamp(1.0 - TdotL * TdotL, 0.0, 1.0));
  // Blinn-Phong's half vector H = normalize(L + V) is ill-conditioned
  // whenever L and V approach anti-parallel (L ≈ -V). For a light glued
  // to the camera's own view direction ("headlamp" — this app's default
  // LIGHT=CENTER, and even off-center it stays mostly forward-facing),
  // that happens for every fragment near the camera's look-at point, AT
  // EVERY ORBIT ANGLE — the light always points where the camera looks,
  // and V there always points straight back at the camera, regardless of
  // how the camera has been spun around the target. Left unguarded, H
  // blows up and spec saturates toward white in a patch anchored to the
  // orbit target (fixed in world space) — it isn't failing to update, the
  // same degenerate geometry just recurs at every single angle. stability
  // fades the specular contribution smoothly to 0 as L+V shrinks, rather
  // than normalizing a near-zero vector.
  vec3  Hraw          = L + V;
  float Hlen          = length(Hraw);
  float stability     = smoothstep(0.02, 0.25, Hlen);
  vec3  H             = (Hlen > 1e-4) ? (Hraw / Hlen) : T;
  float TdotH         = dot(T, H);
  float spec          = pow(sqrt(clamp(1.0 - TdotH * TdotH, 0.0, 1.0)), u_specPower) * stability;
  vec3 litFull = base * (u_ambient + u_diffuseStrength * diffuse) + vec3(u_specStrength * spec);
  // mix() rather than a plain multiply so reflectance=0 lands EXACTLY on
  // flat base color (not on base*ambient, which would still be dimmed) —
  // "0 = off" means genuinely off, not "off but still shaded a bit".
  // >1 extrapolates past litFull for an exaggerated look; WebGL clamps
  // the final gl_FragColor to [0,1] on write, so this saturates toward
  // white in bright spots rather than doing anything undefined.
  vec3 lit = mix(base, litFull, u_reflectance);
  // Depth cue, take 3 — near/far planes stay fixed (zoom-invariant) while
  // the camera is OUTSIDE the sphere-approximated volume, same as before.
  // But once the camera crosses the near plane (camDepth > -fogRadius,
  // i.e. it has physically entered the brain), the near plane now tracks
  // the camera exactly, and the far plane shifts by the same amount —
  // keeping the window WIDTH constant at 2*fogRadius rather than
  // collapsing fragments right next to the lens toward the "far" end of a
  // window that never moved. max(...) means this reduces to exactly the
  // original fixed-window formula whenever the camera hasn't entered yet.
  // fogRadius is HALF of u_depthRadius — a local scale-down used only
  // here, not touching the shared uniform (RIBBON_VS's width-by-depth
  // taper below still uses the full u_depthRadius, unchanged) — pulls the
  // whole fog window twice as close to the brain's centre, so the
  // "endpoint dots stay bright while the connecting line body darkens"
  // look (dots have no depth-based darkening at all — see DOTS_FS) shows
  // up across more of a typical view instead of only in the deep
  // background.
  float fogRadius = u_depthRadius * 0.5;
  float camDepth  = dot(cameraPosition - u_depthTarget, u_camFwd);
  float nearDepth = max(-fogRadius, camDepth);
  float farDepth  = nearDepth + 2.0 * fogRadius;
  float depth = dot(vWorldPos - u_depthTarget, u_camFwd);
  float atten = (u_depthAttenEnabled > 0)
    ? clamp(1.0 - (depth - nearDepth) / max(farDepth - nearDepth, 1e-4), 0.0, 1.0)
    : 1.0;
  gl_FragColor = vec4(lit * atten, 1.0);
}`;

// Per-frame shading state for the ribbon mesh (makeRibbonLines, below) —
// kept as its own function (rather than inlined into makeRibbonLines)
// since it used to be shared between two mesh types before the flat-line
// renderer was retired; keeping it separate still reads cleanly and costs
// nothing.
function attachStreamlineShading(mesh) {
  // mesh.userData.lightCam is mutable so index.html's LIGHT slider can
  // drive both this mesh and the glass brain from one shared angle.
  mesh.userData.lightCam    = new THREE.Vector3(0, 0, 1);
  // Depth-intensity reference point/scale — see u_depthTarget/u_depthRadius
  // in LINE_FS. index.html assigns its own controls.target Vector3 here BY
  // REFERENCE (not a copy) so panning updates it automatically; sceneRadius
  // is a plain number, resynced by index.html whenever it changes.
  mesh.userData.depthTarget = new THREE.Vector3(0, 0, 0);
  mesh.userData.sceneRadius = 1;
  const _camRight    = new THREE.Vector3();
  const _camUp       = new THREE.Vector3();
  const _camFwd      = new THREE.Vector3();
  const _drawingSize = new THREE.Vector2();
  mesh.onBeforeRender = (renderer, scene, cam) => {
    const lc = mesh.userData.lightCam;
    const u  = mesh.material.uniforms;
    _camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    _camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    _camFwd.setFromMatrixColumn(cam.matrixWorld, 2).multiplyScalar(-1); // camera looks down -Z
    u.u_lightDir.value
      .set(0, 0, 0)
      .addScaledVector(_camRight, lc.x)
      .addScaledVector(_camUp,    lc.y)
      .addScaledVector(_camFwd,   lc.z)
      .normalize();
    // Depth-intensity: purely DIRECTION-based (view axis + target),
    // cam.position never appears anywhere in this block — see LINE_FS.
    // _camFwd already comes from cam.matrixWorld's rotation only, so
    // dollying (zoomCamera scaling the eye vector's LENGTH) can't move
    // it; only orbiting (which changes the camera's ORIENTATION) does.
    u.u_camFwd.value.copy(_camFwd);
    u.u_depthTarget.value.copy(mesh.userData.depthTarget);
    u.u_depthRadius.value = mesh.userData.sceneRadius;
    // Physical (not CSS) pixel size, needed to convert the desired
    // on-screen line width into a clip-space offset in RIBBON_VS.
    renderer.getDrawingBufferSize(_drawingSize);
    u.u_resolution.value.copy(_drawingSize);
  };
}

// Uniform set used by the ribbon material — a fresh object per call, since
// each material needs its own independent uniform values, not a shared
// reference. Historically shared between two streamline materials (flat +
// ribbon) before flat was retired; kept as its own function since a
// second consumer (the future true-cylinder tube renderer) is plausible.
function sharedLineUniforms() {
  return {
    u_lightDir:        { value: new THREE.Vector3(0, 0, 1) },
    u_autoColor:       { value: 1 },
    u_lineColor:       { value: new THREE.Vector3(1, 1, 1) },
    u_ambient:         { value: 0.35 },
    u_diffuseStrength: { value: 0.75 },
    u_specStrength:    { value: 0.5 },
    u_specPower:       { value: 12.0 },
    // All resynced every frame in attachStreamlineShading's onBeforeRender
    // before first use, so these initial values are never actually visible.
    u_camFwd:          { value: new THREE.Vector3(0, 0, 1) },
    u_depthTarget:     { value: new THREE.Vector3(0, 0, 0) },
    u_depthRadius:     { value: 1.0 },
    // Both toggleable from index.html — see LINE_FS's comment for why
    // they're independent controls rather than one "extras" switch.
    u_depthAttenEnabled: { value: 1 },
    u_reflectance:       { value: 1.0 },
  };
}

// ── Ribbon ("fat line") streamlines ──────────────────────────────────────
// Screen-space-expanded quads instead of GL_LINES, so line width is
// actually controllable (the flat-line renderer this originally sat
// alongside as an opt-in "#2" has since been retired — this is now the
// only streamline geometry). One INSTANCE per segment, all sharing one
// tiny 4-vertex template quad (instancing, not per-vertex duplication,
// since buffer bandwidth matters at this app's scale — up to 20M points
// at ULTRA). Reuses LINE_FS completely unchanged, carrying over #1's
// Kajiya-Kay shading and the view-axis depth cue with zero changes.
export const RIBBON_VS = `
precision highp float;
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec3 instanceTangent;
attribute vec3 instanceColor;
// Per-instance FIXED bundle color — see makeRibbonLines. Always present
// (three.js requires every attribute a shader references to be bound),
// even for a non-bundle load, where it's just filled with the same
// default color the uniform picker would use; only consulted when
// u_autoColor==2 selects it below.
attribute vec3 instanceBundleColor;
// The shared per-instance template quad's own attribute, reusing the
// built-in "position" rather than adding a redundant custom one:
// position.x = SIDE (-1/+1, which edge of the ribbon this corner is on),
// position.y = END (0 = segment start, 1 = segment end). See
// makeRibbonLines for the 4 concrete corner values.
uniform vec2  u_resolution;    // physical (drawing-buffer) pixels
uniform float u_widthNearPx;   // on-screen width at/in front of the depth-cue's near plane
uniform float u_widthFarPx;    // on-screen width at/behind the depth-cue's far plane
uniform vec3  u_camFwd;        // same view-axis direction as LINE_FS's depth cue
uniform vec3  u_depthTarget;
uniform float u_depthRadius;
varying vec3  vColor;
varying vec3  vBundleColor;
varying vec3  vTangent;
varying vec3  vWorldPos;
void main() {
  vColor       = instanceColor;
  vBundleColor = instanceBundleColor;
  vTangent = normalize(mat3(modelMatrix) * instanceTangent);

  vec4 worldStart = modelMatrix * vec4(instanceStart, 1.0);
  vec4 worldEnd   = modelMatrix * vec4(instanceEnd,   1.0);
  vWorldPos = mix(worldStart.xyz, worldEnd.xyz, position.y);

  vec4 clipStart = projectionMatrix * modelViewMatrix * vec4(instanceStart, 1.0);
  vec4 clipEnd   = projectionMatrix * modelViewMatrix * vec4(instanceEnd,   1.0);

  // Work in actual screen pixels (not raw NDC) so both axes are handled
  // uniformly without a separate aspect-ratio correction term.
  vec2 ssStart = (clipStart.xy / clipStart.w) * 0.5 * u_resolution;
  vec2 ssEnd   = (clipEnd.xy   / clipEnd.w)   * 0.5 * u_resolution;
  vec2 dirPx   = ssEnd - ssStart;
  float dirLen = length(dirPx);
  // Degenerate (zero-length) segment guard — see join-test-streamlines.tck's
  // "duplicate_point" case: without this, normalize(0) is NaN and corrupts
  // the whole instance instead of just collapsing it to a point-like quad.
  dirPx = (dirLen > 1e-4) ? (dirPx / dirLen) : vec2(1.0, 0.0);
  vec2 normalPx = vec2(-dirPx.y, dirPx.x);

  // Width by depth, take 2 — same two-regime near plane as LINE_FS's
  // intensity cue (see its comment): fixed and zoom-invariant while the
  // camera is outside the volume, but tracking the camera once it enters
  // so nearby fragments don't get treated as "far" just because the
  // camera drove past a plane that never moved. Still bounded — a mix(),
  // never a division by distance — so nothing here can diverge as the
  // camera keeps moving.
  float camDepth  = dot(cameraPosition - u_depthTarget, u_camFwd);
  float nearDepth = max(-u_depthRadius, camDepth);
  float farDepth  = nearDepth + 2.0 * u_depthRadius;
  float depth   = dot(vWorldPos - u_depthTarget, u_camFwd);
  float depthT  = clamp((depth - nearDepth) / max(farDepth - nearDepth, 1e-4), 0.0, 1.0);
  float widthPx = mix(u_widthNearPx, u_widthFarPx, depthT);

  float half_ = 0.5 * widthPx;
  // Square-cap join fix (the cheap Line2-style approach from the #2 plan):
  // extend each segment by its own half-width past both true endpoints
  // instead of true mitering — closes most gaps at bends for negligible
  // extra cost, at the cost of visible artifacts at very sharp turns (see
  // hairpin_170deg / exact_180_reversal in join-test-streamlines.tck).
  vec2 offsetPx = normalPx * position.x * half_
                + dirPx    * (position.y * 2.0 - 1.0) * half_;

  vec4 clip = mix(clipStart, clipEnd, position.y);
  // Converting a pixel-space offset back to clip space: an NDC delta d
  // corresponds to a pixel delta of d * 0.5 * resolution, so inverting
  // that gives offsetPx / (0.5*resolution); multiplying by clip.w
  // compensates for the hardware's own perspective divide, since this is
  // added BEFORE that divide happens.
  clip.xy += (offsetPx / (0.5 * u_resolution)) * clip.w;
  gl_Position = clip;
}`;

export function makeRibbonMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader:   RIBBON_VS,
    fragmentShader: LINE_FS,
    uniforms: {
      ...sharedLineUniforms(),
      u_resolution:   { value: new THREE.Vector2(1, 1) },
      u_widthNearPx:  { value: 3.0 },
      u_widthFarPx:   { value: 1.0 },
    },
    // Screen-space construction makes winding-order sign easy to get
    // backwards for one viewing direction without it being obvious by
    // inspection; DoubleSide is cheap insurance against an invisible
    // ribbon from one side rather than something worth debugging by eye.
    side: THREE.DoubleSide,
  });
}

// bundleInfo (optional): { idPerStreamline: Int32Array|null, palette: [r,g,b][] }
// — idPerStreamline[i] indexes into palette for tracts[i]. When omitted
// (a normal, non-bundle load), instanceBundleColor is filled with
// DEFAULT_BUNDLE_RGB throughout, so selecting "Bundle" on a non-bundle
// load reads as a reasonable default color out of the box — NOT because
// bundle color is meant to track the flat-color picker generally (real
// bundles have their own independent palette, automatic or specified;
// this is only about what an otherwise-empty default should look like).
export const DEFAULT_BUNDLE_RGB = [1.0, 0.216, 0.0]; // #ff3700 as RAW sRGB-style [0,1] — see hexToRgbRaw for why this must NOT go through THREE.Color

// Canonical hex -> [0,1] conversion for every color that ends up in a
// shader uniform or vertex attribute in this app (line/dot custom colors,
// bundle palette entries, DEFAULT_BUNDLE_RGB above). Deliberately raw —
// NOT new THREE.Color(hex), which auto-converts sRGB->linear internally
// (verified directly in three's own Color.js: setHex() always calls
// ColorManagement.colorSpaceToWorking()). None of this app's own shaders
// (LINE_FS, DOTS_FS, SLAB_FS, the raymarcher, ...) ever re-encode on
// output — confirmed earlier, none include three's colorspace_fragment
// chunk — so every raw value written IS the final displayed value, and
// every hex color feeding one of them needs to skip THREE.Color's
// conversion or it'll silently drift from every other color source that
// does. This exact inconsistency (DEFAULT_BUNDLE_RGB already raw, but
// custom line/dot colors and real bundle-palette colors going through
// THREE.Color) is what made bundle-mode and flat-mode colors diverge
// even when both represented "the same" nominal color.
export function hexToRgbRaw(hex) {
  const n = typeof hex === 'string' ? parseInt(hex.replace(/^#/, ''), 16) : hex;
  return [ ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255 ];
}

export function makeRibbonLines(tracts, widthNearPx = 3.0, widthFarPx = 1.0, bundleInfo = null) {
  let segCount = 0;
  for (const t of tracts) { const n = t.length / 3; if (n >= 2) segCount += n - 1; }

  const instStart = new Float32Array(segCount * 3);
  const instEnd   = new Float32Array(segCount * 3);
  const instTan   = new Float32Array(segCount * 3);
  const instCol   = new Float32Array(segCount * 3);
  const instBCol  = new Float32Array(segCount * 3);
  let si = 0;
  for (let ti2 = 0; ti2 < tracts.length; ti2++) {
    const t = tracts[ti2];
    const n = t.length / 3; if (n < 2) continue;
    let bc = DEFAULT_BUNDLE_RGB;
    if (bundleInfo && bundleInfo.idPerStreamline) {
      const pal = bundleInfo.palette[bundleInfo.idPerStreamline[ti2]];
      if (pal) bc = pal;
    }
    for (let i = 0; i < n - 1; i++) {
      const x0 = t[3*i], y0 = t[3*i+1], z0 = t[3*i+2];
      const x1 = t[3*i+3], y1 = t[3*i+4], z1 = t[3*i+5];
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const dl = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      instStart[3*si] = x0; instStart[3*si+1] = y0; instStart[3*si+2] = z0;
      instEnd[3*si]   = x1; instEnd[3*si+1]   = y1; instEnd[3*si+2]   = z1;
      instTan[3*si]   = dx / dl; instTan[3*si+1] = dy / dl; instTan[3*si+2] = dz / dl;
      instCol[3*si]   = Math.abs(dx) / dl;
      instCol[3*si+1] = Math.abs(dy) / dl;
      instCol[3*si+2] = Math.abs(dz) / dl;
      instBCol[3*si]   = bc[0];
      instBCol[3*si+1] = bc[1];
      instBCol[3*si+2] = bc[2];
      si++;
    }
  }

  // Tiny 4-corner template quad shared by every instance (see RIBBON_VS
  // for what x/y mean). Two triangles: 0-1-2 and 2-1-3.
  // MUST be InstancedBufferGeometry, not a plain BufferGeometry with
  // .instanceCount bolted on — verified against three.js's actual r180
  // source (WebGLRenderer.js): the instanced-draw code path is only taken
  // when geometry.isInstancedBufferGeometry === true, a flag only this
  // class sets. A plain BufferGeometry's .instanceCount is invisible to
  // that check and silently falls through to a single non-instanced draw
  // call instead — which is exactly what made every streamline disappear.
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, 0, 0,   1, 0, 0,
    -1, 1, 0,   1, 1, 0,
  ]), 3));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  geo.setAttribute('instanceStart',   new THREE.InstancedBufferAttribute(instStart, 3));
  geo.setAttribute('instanceEnd',     new THREE.InstancedBufferAttribute(instEnd,   3));
  geo.setAttribute('instanceTangent', new THREE.InstancedBufferAttribute(instTan,   3));
  geo.setAttribute('instanceColor',   new THREE.InstancedBufferAttribute(instCol,   3));
  geo.setAttribute('instanceBundleColor', new THREE.InstancedBufferAttribute(instBCol, 3));
  geo.instanceCount = si;

  const material = makeRibbonMaterial();
  material.uniforms.u_widthNearPx.value = widthNearPx;
  material.uniforms.u_widthFarPx.value  = widthFarPx;

  const mesh = new THREE.Mesh(geo, material);
  // Instance data spans arbitrary world positions unrelated to the tiny
  // template quad's own bounding sphere — same reasoning as the glass
  // brain's full-screen quad needing this.
  mesh.frustumCulled = false;
  attachStreamlineShading(mesh);
  return mesh;
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
// endsPx: dot screen size (in CSS pixels; scaled to framebuffer pixels via
// pixelRatio, which the caller should pass as whatever the renderer is
// ACTUALLY using — renderer.getPixelRatio() — not window.devicePixelRatio
// directly, since those two can differ (e.g. a capped render resolution).
// bundleInfo (optional): { idPerStreamline: Int32Array|null, palette: [r,g,b][] },
// same shape makeRibbonLines takes. Endpoint dots dropped RAS coloring
// entirely (never a useful signal for a single point, per design
// discussion) — the 'color' attribute now carries bundle color instead,
// falling back to a neutral placeholder when there's no bundle (in that
// case the "Bundle" UI option resolves to the flat default color instead
// of this attribute — see index.html's color-resolution logic).
// Returns { src: THREE.Points, tgt: THREE.Points }
export function makeEndpointDots(tracts, probedEnds, cursor, endsPx = 6, pixelRatio = window.devicePixelRatio, bundleInfo = null) {
  const n = tracts.length;
  const srcPos = new Float32Array(n * 6), srcCol = new Float32Array(n * 6);
  const tgtPos = new Float32Array(n * 6), tgtCol = new Float32Array(n * 6);
  // Parallel to srcPos/tgtPos but one int per POINT (not *3) — which
  // bundle each dot belongs to, for hover/click lookups later (see
  // index.html's bundle-name tooltip). -1 = no bundle info available.
  // si/ti (below) are their own counters, separate from the loop index i
  // (the "both probed" case adds twice to src per streamline, so point
  // index in the geometry is NOT the same as streamline index i) — bId
  // needs computing from i and then written out at the SAME si/ti
  // position the matching position/color just went to.
  const srcBundleId = new Int32Array(n * 2), tgtBundleId = new Int32Array(n * 2);
  let si = 0, ti = 0;

  const [cx, cy, cz] = cursor || [0, 0, 0];

  const NEUTRAL_RGB = [1, 1, 1];
  // A bit brighter than the matching line color, not a separate palette —
  // same per-streamline bundle entry makeRibbonLines uses for that same
  // streamline, just scaled up. Discovered by accident (dots have no
  // depth-based darkening at all, unlike the connecting line body — see
  // LINE_FS's fog — so a dot already stood out against its own
  // increasingly-darkened line; this leans into that glowing-endpoint
  // look on purpose instead of leaving it as a side effect).
  const BUNDLE_DOT_INTENSITY = 1.3;
  const bundleCol = (i) => {
    if (!bundleInfo || !bundleInfo.idPerStreamline) return NEUTRAL_RGB;
    const c = bundleInfo.palette[bundleInfo.idPerStreamline[i]] || NEUTRAL_RGB;
    return [c[0] * BUNDLE_DOT_INTENSITY, c[1] * BUNDLE_DOT_INTENSITY, c[2] * BUNDLE_DOT_INTENSITY];
  };
  const bundleId = (i) => (bundleInfo && bundleInfo.idPerStreamline) ? bundleInfo.idPerStreamline[i] : -1;

  for (let i = 0; i < n; i++) {
    const t = tracts[i];
    if (t.length < 6) continue;
    const np = t.length / 3;

    const sx = t[0], sy = t[1], sz = t[2];
    const ex = t[3*(np-1)], ey = t[3*(np-1)+1], ez = t[3*(np-1)+2];
    // Both ends of the same streamline belong to the same bundle, so they
    // share one color — no separate near/far-end direction encoding needed
    // now that RAS is gone from this path.
    const sCol = bundleCol(i);
    const eCol = sCol;
    const bId = bundleId(i);

    const addSrc = (px, py, pz, c) => {
      srcPos[si*3]=px; srcPos[si*3+1]=py; srcPos[si*3+2]=pz;
      srcCol[si*3]=c[0]; srcCol[si*3+1]=c[1]; srcCol[si*3+2]=c[2]; srcBundleId[si]=bId; si++;
    };
    const addTgt = (px, py, pz, c) => {
      tgtPos[ti*3]=px; tgtPos[ti*3+1]=py; tgtPos[ti*3+2]=pz;
      tgtCol[ti*3]=c[0]; tgtCol[ti*3+1]=c[1]; tgtCol[ti*3+2]=c[2]; tgtBundleId[ti]=bId; ti++;
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

  const makePoints = (pos, col, bundleIdArr, count) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, count*3), 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col.slice(0, count*3), 3));
    const mesh = new THREE.Points(geo, makeDotsMaterial3d(endsPx * pixelRatio));
    // Index-aligned with the geometry's points (point i's bundle is
    // bundleId[i]) — for hover/click lookups (see index.html's
    // bundle-name tooltip), which need to go from a raycast hit's
    // .index back to a bundle, and the baked-in color alone isn't a
    // safe way to reverse that (fragile float matching, breaks if two
    // bundles' colors are close).
    mesh.userData.bundleId = bundleIdArr.slice(0, count);
    return mesh;
  };

  return {
    src: makePoints(srcPos, srcCol, srcBundleId, si),
    tgt: makePoints(tgtPos, tgtCol, tgtBundleId, ti),
  };
}
