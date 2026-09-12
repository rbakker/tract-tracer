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
          zs.y = 0; ze.y = (dist - pinchDist0) / sc.screen.height;
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
uniform float u_isColor;
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

  if (!nearestFiltered) return vec4(0.0, 0.0, 0.0, val); // gradient unused outside label mode

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
                     out vec3 hitP, out bool wasExit) {
  vec3 prevP = ro + tStart * rd;
  bool startInside = occupancyAndGradient(prevP).w >= thresh;
  wasExit = startInside;
  for (int i = 1; i < 256; i++) {
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
vec3 smoothedOccupancyNormal(vec3 p) {
  float r = 1.0;
  vec3 g = vec3(
    occupancyAndGradient(p+vec3(r,0.0,0.0)).w - occupancyAndGradient(p-vec3(r,0.0,0.0)).w,
    occupancyAndGradient(p+vec3(0.0,r,0.0)).w - occupancyAndGradient(p-vec3(0.0,r,0.0)).w,
    occupancyAndGradient(p+vec3(0.0,0.0,r)).w - occupancyAndGradient(p-vec3(0.0,0.0,r)).w
  );
  // Same anisotropy correction as gradient() above - "1 voxel" is not the
  // same physical distance in every axis for anisotropic data.
  return g / u_voxMm;
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

  // Section-plane clipping: shrink [tStart,tEnd] by each active plane's
  // half-space, in local voxel-index space (same parametrization as
  // ro + t*rd everywhere else in this shader). D(t) = d0 + t*dn is the
  // signed "kept-side" distance along the ray; D>=0 is kept, D<0 clipped.
  // clipEntryPlane tracks which plane (if any) ends up defining the near
  // boundary tStart — i.e. whether this ray enters through an artificial
  // cut face rather than the volume's real edge. Used below to render a
  // proper cut-face "cap" in solid mode instead of running the ordinary
  // isosurface search from a starting point that may already be mid-tissue.
  int clipEntryPlane = -1;
  for (int i = 0; i < 3; i++) {
    float dir = u_clipDir[i];
    if (dir == 0.0) continue;
    float d0 = dot(ro - u_clipPoint[i], u_clipNormal[i]) * dir;
    float dn = dot(rd,                  u_clipNormal[i]) * dir;
    if (abs(dn) < 1e-8) {
      if (d0 < 0.0) tEnd = tStart - 1.0; // whole ray on the clipped side
    } else {
      float tCross = -d0 / dn;
      if (dn > 0.0) { if (tCross > tStart) { tStart = tCross; clipEntryPlane = i; } }
      else          { tEnd = min(tEnd, tCross); }
    }
  }
  if (tEnd <= tStart) discard;

  float stepSize = (tEnd - tStart) / float(u_steps);
  float mmPerStep = length(rd * u_voxMm) * stepSize;
  float accAlpha = 0.0;
  vec3  accColor = vec3(0.0);
  bool labelMode = (u_applyLUT > 0.5) && (u_isColor < 0.5);
  // How much of the final image comes from the solid isosurface vs the
  // translucent glass rendering, driven by the same OPACITY control:
  // alpha=100 -> 50%, alpha=300 (max) -> 100%. Applies to every volume
  // type — plain scans, DEC/colour, and labelled volumes alike — since
  // occupancyAt() below is built on the same sampleVol() field glass mode
  // already uses for each of them.
  float solidBlend = smoothstep(0.0, 200.0, u_alpha);

  if (solidBlend < 1.0) {
    for (int i = 0; i < 256; i++) {
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
        col = (u_isColor > 0.5)
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
  }

  vec3  solidColor = vec3(0.0);
  float solidAlpha = 0.0;
  // Depth written for this fragment. Defaults to the nearest possible
  // value (0.0) — with depthTest now enabled, that guarantees this
  // fragment always wins against whatever's already drawn (matching the
  // old depthTest:false "always on top" behaviour) for the translucent,
  // glass-dominant case, where blending many samples along the ray into
  // one pixel means there's no single correct depth to give anyway.
  // Once solid mode dominates (opacity pushed high enough that this is a
  // genuinely opaque surface, not a blend), this gets overwritten with
  // the real projected depth of the hit point below, so the solid brain
  // correctly occludes — or is occluded by — other scene objects like
  // the section planes, instead of always painting over them regardless
  // of true 3D position.
  float fragDepth = 0.0;
  if (solidBlend > 0.0) {
    vec3 hitP;
    bool haveHit = false;
    bool isCap   = false;
    bool wasExit = false;

    // u_thresh is a meaningful intensity cutoff for continuous FA/scan
    // data, but labels are arbitrary categorical numbers - a magnitude
    // threshold would find the isosurface crossing at a different,
    // mostly-background-weighted blend fraction depending on which
    // label's value happens to be present, displacing the surface itself
    // toward the background side (not just its colour - see
    // interpolatedLutColor's inward nudge above, which only patches the
    // colour symptom of this same root cause). occupancyAt binarizes to
    // 0/1 for label mode specifically so this doesn't depend on any
    // particular label's value - 0.5 always finds the true boundary.
    float isoThresh = labelMode ? 0.5 : u_thresh;

    // This ray's near boundary is an artificial clip-plane cut, not the
    // volume's real edge — inspect what's actually there. When FILL-IN is
    // on (default), and there IS anatomy right at the cut (using the SAME
    // isoThresh as the surface search — the THRESHOLD slider — or the
    // booleanized occupancy for LUT data, where a magnitude threshold has
    // no meaning), paint an anatomy-colored cap there, like a 2D slice.
    // When FILL-IN is off, or the cut lands on background (e.g. tissue
    // deliberately blanked out for a "see-inside" view), skip the cap and
    // fall through to the isosurface search below instead — which, thanks
    // to findIsosurface's generalized start-from-either-side handling, is
    // exactly what reveals a genuine shaded boundary further behind the
    // cut rather than the old degenerate result (a bisection collapsing
    // onto the entry point itself, where the local gradient is often
    // ~flat mid-tissue and normalizing it produced the black flecks
    // originally seen when clipping through solid anatomy). And since an
    // empty hole here writes no depth at all, streamlines occupying that
    // same gap render through normally rather than being hidden behind an
    // opaque cap.
    if (clipEntryPlane >= 0 && u_fillIn > 0.5) {
      vec3 capP = ro + tStart * rd;
      bool hasCapData = labelMode ? (occupancyAt(capP) > 0.5) : (sampleVol(capP) > isoThresh);
      if (hasCapData) { hitP = capP; isCap = true; haveHit = true; }
    }

    if (!haveHit && findIsosurface(ro, rd, tStart, tEnd, stepSize, isoThresh, hitP, wasExit)) {
      haveHit = true;
    }

    if (haveHit) {
      vec3 baseColor;
      float shade;
      if (isCap) {
        // Flat, unlit — like the 2D slice panels: this is an artificial
        // cut face, not a real anatomical boundary, so isosurface-style
        // rim/normal shading would be meaningless here (and the gradient
        // at an arbitrary cut is often close to zero anyway).
        // Label/LUT: nearest-neighbour, not interpolatedLutColor's trilinear
        // blend. The blend is what makes the isosurface itself look good
        // (a previous session's conclusion, left untouched below) — but a
        // cut face is a flat cross-section, exactly like the 2D slice
        // panels, which also read raw per-voxel labels with no blending.
        // sampleLabelIndex already does this NN lookup (the label texture
        // is NEAREST-filtered — see buildGlassBrain), so this is a direct
        // per-voxel color with no extra interpolation math needed.
        baseColor = labelMode ? lutColor(sampleLabelIndex(hitP))
                  : (u_isColor > 0.5
                      ? pow(clamp(sampleRaw(hitP) * 1.6 * u_contrast, 0.0, 1.0), vec3(0.8))
                      : vec3(gammaContrast(sampleVol(hitP), 1.0 / u_contrast)));
        shade = 1.0;
      } else {
        vec3 N = normalize(smoothedOccupancyNormal(hitP));
        // Resample slightly inside the surface (N points from background
        // toward tissue) rather than exactly at the ambiguous crossing, for
        // a cleaner normal - and, for colour sampling below (both label+LUT
        // and DEC), so it doesn't land back on background.
        vec3 inwardP = hitP + N * 0.5;
        N = normalize(smoothedOccupancyNormal(inwardP));
        // N points from background toward tissue (established by this same
        // gradient's sign convention throughout the file), so a normal
        // entry surface faces toward the light and dot(N,u_lightDir)>0. An
        // interior surface revealed by FILL-IN=off (wasExit) is the
        // opposite: its natural gradient faces back the way the ray came,
        // so straight front-facing shading would render it almost
        // uniformly dark. Two-sided shading here instead — this is an
        // otherwise-invisible internal wall, so showing it regardless of
        // which way it happens to face is more useful than a dark silhouette.
        //
        // wasExit also gets a deliberately dimmer, flatter treatment on top
        // of that: peeking inside a solid object is exactly the situation
        // where light doesn't reach directly, so both the ambient floor and
        // the diffuse term's own weight are pulled down versus the
        // exterior's fuller-range, brighter shading.
        float diffuse = wasExit ? abs(dot(N, u_lightDir)) : max(dot(N, u_lightDir), 0.0);
        shade = wasExit ? (0.3 + 0.3 * diffuse)
                        : (0.2 + 0.8 * diffuse);

        if (labelMode) {
          // Sample at inwardP, not hitP: hitP sits wherever the blended
          // occupancy exactly equals u_thresh, which for label data (raw
          // integer values, not a normalized [0,1] range) can be barely
          // inside the region in blend-weight terms whenever threshold is
          // small relative to the label's own value - e.g. threshold=5
          // against label=30 only needs ~17% real-label weight to cross,
          // so a colour sample taken exactly there is dominated by
          // background and comes out dark. inwardP moves the sample
          // solidly into real tissue instead.
          baseColor = interpolatedLutColor(inwardP);
        } else if (u_isColor > 0.5) {
          // DEC/colour volume: the actual FA-weighted direction colour,
          // same boost as glass mode, at the same inward-nudged point.
          baseColor = pow(clamp(sampleRaw(inwardP) * 1.6 * u_contrast, 0.0, 1.0), vec3(0.8));
        } else {
          // Plain scan: shading alone defines the surface — this is the
          // combination already confirmed to look good, left untouched.
          baseColor = vec3(1.0);
        }
      }
      solidColor = baseColor * shade;
      solidAlpha = 1.0;

      if (solidBlend > 0.5) {
        vec3 worldPos = (u_model * vec4(hitP - u_size * 0.5, 1.0)).xyz;
        vec4 clipPos = u_projView * vec4(worldPos, 1.0);
        fragDepth = clipPos.z / clipPos.w * 0.5 + 0.5;
      }
    }
  }

  vec3  finalColor = mix(accColor, solidColor, solidBlend);
  float finalAlpha = mix(accAlpha, solidAlpha, solidBlend);
  if (finalAlpha < 0.002) discard;
  gl_FragDepth = clamp(fragDepth, 0.0, 1.0);
  gl_FragColor = vec4(finalColor, finalAlpha);
}`;


export function buildGlassBrain(anat, texData, scene, renderer3, camera, lutInfo) {
  const isColor = (anat.channels || 1) === 3;
  const isLabelMode = !isColor && !!(lutInfo && lutInfo.apply && lutInfo.map);
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
    const { data, size } = buildLutRGBA(lutInfo.map, lutInfo.maxIndex);
    lutTex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lutTex.minFilter = THREE.NearestFilter;
    lutTex.magFilter = THREE.NearestFilter;
    lutTex.needsUpdate = true;
    lutSize = size;
  } else {
    lutTex = new THREE.DataTexture(new Uint8Array([0,0,0,0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lutTex.needsUpdate = true;
  }

  const mat = new THREE.ShaderMaterial({
    vertexShader:   GLASS_VS,
    fragmentShader: GLASS_FS,
    uniforms: {
      u_vol:       { value: tex },
      u_size:      { value: new THREE.Vector3(...anat.shape) },
      u_voxMm:     { value: new THREE.Vector3(...anat.vox_mm) },
      u_volDiagMm: { value: Math.sqrt(
                       (anat.shape[0] * anat.vox_mm[0])**2 +
                       (anat.shape[1] * anat.vox_mm[1])**2 +
                       (anat.shape[2] * anat.vox_mm[2])**2) },
      u_alpha:     { value: 5.0 },
      u_thresh:    { value: 0.15 },
      u_rimPow:    { value: 1.0 },
      u_contrast:  { value: 1.0 },
      u_steps:     { value: 150 },
      u_invPV:     { value: new THREE.Matrix4() },
      u_invModel:  { value: invModel },
      u_camPos:    { value: new THREE.Vector3() },
      u_isColor:   { value: isColor ? 1 : 0 },
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
    },
    transparent: true,
    depthWrite:  true,
    depthTest:   true,
  });

  const geo  = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, mat);
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
    mat.uniforms.u_projView.value.copy(_pv);
    mat.uniforms.u_invPV.value.copy(_pv).invert();
    mat.uniforms.u_camPos.value.copy(cam.position);

    const lightCam = mesh.userData.lightCam;
    _camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    _camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    _camFwd.setFromMatrixColumn(cam.matrixWorld, 2).multiplyScalar(-1); // camera looks down -Z
    _lightWorld.set(0, 0, 0)
      .addScaledVector(_camRight, lightCam.x)
      .addScaledVector(_camUp,    lightCam.y)
      .addScaledVector(_camFwd,   lightCam.z)
      .normalize();
    mat.uniforms.u_lightDir.value.copy(_lightWorld).transformDirection(invModel).normalize();
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
// endsPx: dot screen size (in CSS pixels; scaled to framebuffer pixels via
// pixelRatio, which the caller should pass as whatever the renderer is
// ACTUALLY using — renderer.getPixelRatio() — not window.devicePixelRatio
// directly, since those two can differ (e.g. a capped render resolution).
// Returns { src: THREE.Points, tgt: THREE.Points }
export function makeEndpointDots(tracts, probedEnds, cursor, endsPx = 6, pixelRatio = window.devicePixelRatio) {
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

  const makePoints = (pos, col, count) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, count*3), 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col.slice(0, count*3), 3));
    return new THREE.Points(geo, makeDotsMaterial3d(endsPx * pixelRatio));
  };

  return {
    src: makePoints(srcPos, srcCol, si),
    tgt: makePoints(tgtPos, tgtCol, ti),
  };
}
