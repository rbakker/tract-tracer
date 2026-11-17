// ── markers-render.js ─────────────────────────────────────
// Draws a parsed markers set (see markers-io.js) as instanced 3D glyphs —
// one instanced mesh per shape (sphere, cube, diamond, cross) — with a
// per-marker center, color and size; and its links as tapered tubes.
//
// Sizes are in mm (world) or in screen pixels: for pixels the vertex
// shader scales each glyph by its distance to the camera, so it covers the
// same number of pixels at any zoom. The same shader also serves the 2D
// slice panels (NEAR_PASS / FAR_PASS, like the streamlines' slab passes):
// markers whose glyph reaches into the slab are drawn, darker when the
// center lies behind the section plane. In the 3D view (FULL_PASS) those
// slice uniforms are unused.
//
// Depth in the 3D view: each marker darker the farther back it lies within
// its set (u_fogNear … u_fogFar along the line of sight, set per frame by
// the app: the set's depth, at least a share of the scene's, so a small
// cluster isn't overdone; u_fog: how much darker at the back), and a thin
// dark outline (an OUTLINE pass: the glyph's back faces, a little larger,
// in near-black), so a marker in front visibly cuts into one behind.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MARKER_SHAPES } from './markers-io.js';

export const MARKER_VS = `
attribute vec3  iCenter;
attribute vec2  iOffset;    // beside the center, facing the camera (in the size unit): the markers of one spot
attribute vec3  iColor;
attribute float iSize;      // diameter, in mm or CSS px (u_sizeInPx)
uniform float u_opacity;    // opacity of base-colored markers (iBase)
attribute float iIndex;     // index of the drawn marker (for u_hover)
attribute float iDim;       // 1: dimmed (not the highlighted category)
attribute float iBase;      // 1: drawn in the base color — gets u_opacity
uniform float u_hover;      // index of the hovered marker, or -1
uniform float u_sizeInPx;   // 1: iSize is in CSS pixels
uniform float u_pxScale;    // device pixels per CSS pixel
uniform vec2  u_resolution; // drawing-buffer size in device pixels
uniform float u_sizeScale;  // user multiplier (FILE panel)
uniform vec3  u_sliceNormal;
uniform vec3  u_slicePt;
uniform float u_slabHalf;
uniform float u_outlinePx;  // the outline's width (CSS px), OUTLINE pass
varying vec3  vColor;
varying vec3  vNormalV;
varying float vSignedDist;
varying float vAlpha;
varying float vDepth;       // the center's depth (mm along the line of sight): the fog
void main() {
  vec4 cView = modelViewMatrix * vec4(iCenter, 1.0);
  vec4 cClip = projectionMatrix * cView;
  vDepth = -cView.z;
  // World-space diameter. For pixels: a length S at clip depth w covers
  // S * P[1][1] / w * resolution.y / 2 pixels, for a perspective and an
  // orthographic camera alike (w = 1 there).
  float unit = u_sizeScale * (u_sizeInPx > 0.5 ? u_pxScale * cClip.w / (projectionMatrix[1][1] * 0.5 * u_resolution.y) : 1.0);
  float d = iSize * unit;
  bool hovered = abs(iIndex - u_hover) < 0.5;
  if (hovered) d *= 1.35;
  else if (iDim > 0.5) d *= 0.7;
  vSignedDist = dot(iCenter - u_slicePt, u_sliceNormal);
  if (d <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // hidden (size 0)
#if defined(NEAR_PASS)
  // In the slab when the glyph reaches into it; this pass: center in front.
  if (vSignedDist < 0.0 || vSignedDist > u_slabHalf + 0.5 * d) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#elif defined(FAR_PASS)
  if (vSignedDist >= 0.0 || vSignedDist < -u_slabHalf - 0.5 * d) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  vAlpha = (iBase > 0.5 && !hovered) ? u_opacity : 1.0;
  vColor = hovered ? min(iColor * 1.25 + 0.15, vec3(1.0)) : iDim > 0.5 ? iColor * 0.28 + 0.06 : iColor;
  vNormalV = normalize(normalMatrix * normal);
#ifdef OUTLINE
  d += 2.0 * u_outlinePx * u_pxScale * cClip.w / (projectionMatrix[1][1] * 0.5 * u_resolution.y);
#endif
  vec4 pv = modelViewMatrix * vec4(iCenter + position * d, 1.0);
  pv.xy += iOffset * unit;
  gl_Position = projectionMatrix * pv;
}`;

// COUNTS: "20×" beside a marker that stands for several rows — one quad per
// character, from a small atlas of white digits with a dark outline; in
// screen pixels, on the outer side of the marker (the side away from its
// spot's center: right for a marker on its own); depth-tested at the
// marker's front, so the brain hides it as it hides the marker.
export const LABEL_CHARS = '0123456789×';
const LABEL_PX = 12;                      // character height, CSS px
const LABEL_VS = `
attribute vec3  iCenter;
attribute vec2  iOffset;
attribute float iSize;
attribute float iChar;      // index in LABEL_CHARS
attribute float iPos;       // the character's place in its label
attribute float iLen;       // the label's length in characters
uniform float u_sizeInPx;
uniform float u_pxScale;
uniform vec2  u_resolution;
uniform float u_sizeScale;
uniform float u_charW;      // a character's cell width, as a fraction of the height
uniform float u_adv;        // the advance from one character to the next, idem
varying vec2  vUv;
void main() {
  vec4 cView = modelViewMatrix * vec4(iCenter, 1.0);
  vec4 cClip = projectionMatrix * cView;
  float pxPerWorld = projectionMatrix[1][1] * 0.5 * u_resolution.y / cClip.w;   // device px per mm at this depth
  float unit = u_sizeScale * (u_sizeInPx > 0.5 ? u_pxScale / pxPerWorld : 1.0);
  float d = iSize * unit;
  if (d <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 v = cView;
  v.xy += iOffset * unit;
  v.z += 0.5 * d;                                    // at the marker's front
  vec4 c = projectionMatrix * v;
  float h = ${LABEL_PX.toFixed(1)} * u_pxScale;      // device px
  float rpx = 0.5 * d * pxPerWorld;                  // the marker's radius, device px
  float adv = h * u_adv, cw = h * u_charW, wt = iLen * adv + (cw - adv);
  vec2 u = length(iOffset) > 1e-6 ? normalize(iOffset) : vec2(1.0, 0.0);
  vec2 a = u * (rpx + 0.2 * h);                      // where the label starts, from the marker's center
  float x0, y0;
  if (u.x > 0.38)       { x0 = a.x;            y0 = a.y - 0.5 * h; }   // right of it
  else if (u.x < -0.38) { x0 = a.x - wt;       y0 = a.y - 0.5 * h; }   // left of it
  else                  { x0 = a.x - 0.5 * wt; y0 = u.y > 0.0 ? a.y : a.y - h; }   // above or below
  vec2 px = vec2(x0 + iPos * adv + (position.x + 0.5) * cw, y0 + (position.y + 0.5) * h);
  c.xy += px * 2.0 / u_resolution * c.w;
  vUv = vec2((iChar + position.x + 0.5) / ${LABEL_CHARS.length.toFixed(1)}, position.y + 0.5);
  gl_Position = c;
}`;
const LABEL_FS = `
precision highp float;
uniform sampler2D u_atlas;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(u_atlas, vUv);
  if (t.a < 0.02) discard;
  gl_FragColor = t;
}`;
let _atlas = null;
function labelAtlas() {
  if (_atlas) return _atlas;
  const H = 64, W = Math.round(H * 0.62), cv = document.createElement('canvas');
  cv.width = W * LABEL_CHARS.length; cv.height = H;
  const g = cv.getContext('2d');
  g.font = `600 ${Math.round(H * 0.78)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = H * 0.14; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = '#fff';
  [...LABEL_CHARS].forEach((ch, i) => { g.strokeText(ch, (i + 0.5) * W, H * 0.54); g.fillText(ch, (i + 0.5) * W, H * 0.54); });
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  return (_atlas = { tex, charW: 0.62, adv: 0.54 });
}
function makeLabelMaterial(uniforms) {
  const a = labelAtlas();
  return new THREE.ShaderMaterial({
    vertexShader: LABEL_VS, fragmentShader: LABEL_FS, transparent: true, depthWrite: false,
    uniforms: { u_sizeInPx: uniforms.u_sizeInPx, u_pxScale: uniforms.u_pxScale, u_resolution: uniforms.u_resolution,
                u_sizeScale: uniforms.u_sizeScale, u_charW: { value: a.charW }, u_adv: { value: a.adv }, u_atlas: { value: a.tex } },
  });
}
let _quad = null;
function quadGeometry() { return _quad || (_quad = new THREE.PlaneGeometry(1, 1)); }
// The count labels of the drawn markers with a count above 1 (wanted(j): which).
function makeLabelMesh(inst, material, wanted) {
  const chars = [];
  for (let j = 0; j < inst.n; j++) {
    if (!(inst.count[j] > 1) || !wanted(j)) continue;
    const text = inst.count[j] + '×';
    for (let p = 0; p < text.length; p++) chars.push([j, LABEL_CHARS.indexOf(text[p]), p, text.length]);
  }
  if (!chars.length) return null;
  const k = chars.length, center = new Float32Array(3 * k), offset = new Float32Array(2 * k), size = new Float32Array(k), ch = new Float32Array(k), at = new Float32Array(k), len = new Float32Array(k);
  chars.forEach(([j, c, p, l], q) => {
    center.set(inst.center.subarray(3 * j, 3 * j + 3), 3 * q); offset.set(inst.offset.subarray(2 * j, 2 * j + 2), 2 * q);
    size[q] = inst.size[j]; ch[q] = c; at[q] = p; len[q] = l;
  });
  const g = new THREE.InstancedBufferGeometry(), b = quadGeometry();
  g.index = b.index;
  g.setAttribute('position', b.attributes.position);
  g.setAttribute('iCenter', new THREE.InstancedBufferAttribute(center, 3));
  g.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offset, 2));
  g.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 1));
  g.setAttribute('iChar', new THREE.InstancedBufferAttribute(ch, 1));
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(at, 1));
  g.setAttribute('iLen', new THREE.InstancedBufferAttribute(len, 1));
  g.instanceCount = k;
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.userData.isLabels = true;
  return mesh;
}

export const MARKER_FS = `
precision highp float;
varying float vAlpha;
varying vec3  vColor;
varying vec3  vNormalV;
varying float vSignedDist;
varying float vDepth;
uniform float u_fog;        // 0: none; the back of the set at 1 - this
uniform float u_fogNear;
uniform float u_fogFar;
void main() {
#ifdef OUTLINE
  gl_FragColor = vec4(0.02, 0.025, 0.03, vAlpha);
  return;
#endif
  // Headlight from slightly above-left, plus a little specular: reads as a
  // solid 3D glyph in both the perspective view and the flat slices.
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(-0.35, 0.45, 1.0));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  vec3 col = vColor * (0.35 + 0.65 * diff) + vec3(0.25 * spec);
#ifdef FAR_PASS
  col *= 0.7; // behind the section plane, as the streamlines
#endif
#ifdef FULL_PASS
  col *= 1.0 - u_fog * clamp((vDepth - u_fogNear) / max(u_fogFar - u_fogNear, 1e-3), 0.0, 1.0);
#endif
  gl_FragColor = vec4(col, vAlpha);
}`;

// LINKS: one instanced open tube per link, from its "from" marker to its
// "to" marker, tapering from one end's width to the other's and blending
// one end's color into the other's (see resolveLinkStyle). Widths in mm or
// CSS pixels, as marker sizes. 3D view only.
export const LINK_VS = `
attribute vec3  iA;
attribute vec3  iB;
attribute float iWA;
attribute float iWB;
attribute vec3  iCA;
attribute vec3  iCB;
uniform float u_widthInPx;
uniform float u_pxScale;
uniform vec2  u_resolution;
uniform float u_sizeScale;
varying vec3  vColor;
varying vec3  vNormalV;
void main() {
  float t = position.y + 0.5;                 // 0 at A, 1 at B
  vec3 axis = iB - iA;
  float len = length(axis);
  if (len < 1e-6 || (iWA <= 0.0 && iWB <= 0.0)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 d = axis / len;
  vec3 h = abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(d, h)), v = cross(d, u);
  vec3 p = mix(iA, iB, t);
  float w = mix(iWA, iWB, t) * u_sizeScale;
  if (u_widthInPx > 0.5) {
    vec4 c = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    w = w * u_pxScale * c.w / (projectionMatrix[1][1] * 0.5 * u_resolution.y);
  }
  vec3 radial = u * (position.x / 0.5) + v * (position.z / 0.5);
  vColor = mix(iCA, iCB, t);
  vNormalV = normalize(normalMatrix * radial);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + radial * 0.5 * w, 1.0);
}`;
export const LINK_FS = `
precision highp float;
uniform float u_opacity;
varying vec3 vColor;
varying vec3 vNormalV;
void main() {
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(-0.35, 0.45, 1.0));
  float diff = abs(dot(n, L));
  gl_FragColor = vec4(vColor * (0.55 + 0.45 * diff), u_opacity);
}`;
let _tube = null;
function tubeGeometry() { return _tube || (_tube = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, true)); }
function makeLinkMesh(set, lr, material, inst) {
  // each end at its row's drawn marker (the center of its spot)
  const L = set.links, m = L.n, pos = new Float32Array(3 * set.markers.n).fill(NaN);
  for (let r = 0; r < set.markers.n; r++) { const j = inst.rowInst[r]; if (j >= 0) pos.set(inst.center.subarray(3 * j, 3 * j + 3), 3 * r); }
  const A = new Float32Array(3 * m), B = new Float32Array(3 * m);
  for (let i = 0; i < m; i++) { A.set(pos.subarray(3 * L.from[i], 3 * L.from[i] + 3), 3 * i); B.set(pos.subarray(3 * L.to[i], 3 * L.to[i] + 3), 3 * i); }
  const g = new THREE.InstancedBufferGeometry(), base = tubeGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('normal', base.attributes.normal);
  g.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 3));
  g.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 3));
  g.setAttribute('iWA', new THREE.InstancedBufferAttribute(lr.widthA, 1));
  g.setAttribute('iWB', new THREE.InstancedBufferAttribute(lr.widthB, 1));
  g.setAttribute('iCA', new THREE.InstancedBufferAttribute(lr.colorA, 3));
  g.setAttribute('iCB', new THREE.InstancedBufferAttribute(lr.colorB, 3));
  g.instanceCount = m;
  g.boundingSphere = markerBoundingSphere(inst.center);
  material.uniforms.u_widthInPx.value = lr.widthUnit === 'px' ? 1 : 0;
  material.uniforms.u_opacity.value = lr.opacity;
  material.transparent = lr.opacity < 0.999; material.depthWrite = !material.transparent; material.needsUpdate = true;
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.userData.isLinks = true;
  mesh.onBeforeRender = renderer => {
    renderer.getDrawingBufferSize(material.uniforms.u_resolution.value);
    material.uniforms.u_pxScale.value = renderer.getPixelRatio();
  };
  return mesh;
}
function makeLinkMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: LINK_VS, fragmentShader: LINK_FS, side: THREE.DoubleSide,
    uniforms: { u_widthInPx: { value: 1 }, u_pxScale: { value: 1 }, u_resolution: { value: new THREE.Vector2(1, 1) },
                u_sizeScale: { value: 1 }, u_opacity: { value: 1 } },
  });
}

// Unit-diameter base glyphs (centered on the origin).
let _baseGeometries = null;
function baseGeometries() {
  if (_baseGeometries) return _baseGeometries;
  const bar = (x, y, z) => new THREE.BoxGeometry(x, y, z);
  _baseGeometries = {
    sphere:  new THREE.SphereGeometry(0.5, 20, 14),
    cube:    new THREE.BoxGeometry(0.8, 0.8, 0.8),        // same visual weight as the sphere
    diamond: new THREE.OctahedronGeometry(0.62),
    cross:   mergeGeometries([bar(1, 0.26, 0.26), bar(0.26, 1, 0.26), bar(0.26, 0.26, 1)]),
  };
  return _baseGeometries;
}

export function makeMarkerMaterial(defines = { FULL_PASS: 1 }, uniforms = null) {
  return new THREE.ShaderMaterial({
    vertexShader: MARKER_VS,
    fragmentShader: MARKER_FS,
    defines,
    uniforms: uniforms || {
      u_sizeInPx:    { value: 1 },
      u_pxScale:     { value: 1 },
      u_resolution:  { value: new THREE.Vector2(1, 1) },
      u_sizeScale:   { value: 1 },
      u_hover:       { value: -1 },
      u_opacity:     { value: 1 },
      u_sliceNormal: { value: new THREE.Vector3(0, 0, 1) },
      u_slicePt:     { value: new THREE.Vector3() },
      u_slabHalf:    { value: 1e9 },
      u_outlinePx:   { value: 1.25 },
      u_fog:         { value: 0 },
      u_fogNear:     { value: 0 },
      u_fogFar:      { value: 1 },
    },
    side: defines && defines.OUTLINE ? THREE.BackSide : THREE.DoubleSide,
  });
}

// Builds a THREE.Group with one instanced mesh per shape in use.
// resolved: resolveMarkerStyle()'s { color, shape, size, sizeUnit }, with
// .inst: the markers as drawn (markers-io markerInstances) — without it,
// one per row.
// material: pass the previous group's material when rebuilding (a style
// change), so three.js keeps its compiled shader program — disposing a
// material and making a new one would recompile it every time.
// Returns the group; group.userData.material is the shared material (its
// uniforms: u_sizeScale, u_opacity, ... — see setMarkerDisplay), and each
// mesh's userData.markerIndex maps instance → marker index (for picking).
export function makeMarkerGroup(set, resolved, materials = null, linkResolved = null) {
  const inst = resolved.inst || rowInstances(set, resolved);
  const n = inst.n;
  // Two materials sharing one set of uniforms: markers in their own color
  // (always opaque) and markers in the base color (get the opacity). They
  // must be separate: a translucent marker mustn't write depth — it would
  // hide whatever is drawn after it (slice frames, streamlines) — while an
  // opaque one must.
  const material = (materials && materials.material) || makeMarkerMaterial();
  const baseMaterial = (materials && materials.baseMaterial) || makeMarkerMaterial({ FULL_PASS: 1 }, material.uniforms);
  const outlineMaterial = (materials && materials.outlineMaterial) || makeMarkerMaterial({ FULL_PASS: 1, OUTLINE: 1 }, material.uniforms);
  material.uniforms.u_sizeInPx.value = resolved.sizeUnit === 'px' ? 1 : 0;
  const group = new THREE.Group();
  group.userData.material = material;
  group.userData.baseMaterial = baseMaterial;
  group.userData.outlineMaterial = outlineMaterial;
  const base = baseGeometries();
  const isBase = j => inst.base[j] === 1;
  MARKER_SHAPES.forEach((shapeName, s) => addShapeMeshes(s, shapeName));
  if (linkResolved && set.links && set.links.n) {
    const lm = (materials && materials.linkMaterial) || makeLinkMaterial();
    group.userData.linkMaterial = lm;
    group.add(makeLinkMesh(set, linkResolved, lm, inst));
  }
  // the counts: own-colored and base-colored apart (the latter hide with opacity 0)
  const labelMaterial = (materials && materials.labelMaterial) || makeLabelMaterial(material.uniforms);
  group.userData.labelMaterial = labelMaterial;
  for (const wantBase of [false, true]) {
    const lm = makeLabelMesh(inst, labelMaterial, j => isBase(j) === wantBase);
    if (!lm) continue;
    lm.userData.isBase = wantBase;
    lm.onBeforeRender = renderer => {
      renderer.getDrawingBufferSize(material.uniforms.u_resolution.value);
      material.uniforms.u_pxScale.value = renderer.getPixelRatio();
    };
    group.add(lm);
  }
  // One mesh per shape for own-colored markers, one for base-colored ones.
  function addShapeMeshes(s, shapeName) {
    for (const wantBase of [false, true]) {
      const idx = [];
      for (let i = 0; i < n; i++) if (inst.shape[i] === s && isBase(i) === wantBase && inst.size[i] > 0) idx.push(i);
      if (!idx.length) continue;
      const k = idx.length;
      const center = new Float32Array(3 * k), offset = new Float32Array(2 * k), color = new Float32Array(3 * k), size = new Float32Array(k);
      const index = new Float32Array(k), dim = new Float32Array(k), baseF = new Float32Array(k);
      idx.forEach((i, j) => {
        center.set(inst.center.subarray(3 * i, 3 * i + 3), 3 * j);
        offset.set(inst.offset.subarray(2 * i, 2 * i + 2), 2 * j);
        color.set(inst.color.subarray(3 * i, 3 * i + 3), 3 * j);
        size[j] = inst.size[i];
        index[j] = i;
        dim[j] = inst.dim[i];
        baseF[j] = wantBase ? 1 : 0;
      });
      const g = new THREE.InstancedBufferGeometry();
      const b = base[shapeName];
      g.index = b.index;
      g.setAttribute('position', b.attributes.position);
      g.setAttribute('normal', b.attributes.normal);
      g.setAttribute('iCenter', new THREE.InstancedBufferAttribute(center, 3));
      g.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offset, 2));
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(color, 3));
      g.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 1));
      g.setAttribute('iIndex', new THREE.InstancedBufferAttribute(index, 1));
      g.setAttribute('iDim', new THREE.InstancedBufferAttribute(dim, 1));
      g.setAttribute('iBase', new THREE.InstancedBufferAttribute(baseF, 1));
      g.instanceCount = k;
      // Glyphs are placed in the shader, so three's own bounds (from the
      // unit glyph at the origin) would cull them wrongly.
      g.boundingSphere = markerBoundingSphere(inst.center);
      const mesh = new THREE.Mesh(g, wantBase ? baseMaterial : material);
      mesh.frustumCulled = false;
      mesh.userData.markerIndex = Int32Array.from(idx);
      mesh.userData.isBase = wantBase;
      // Pixel-sized glyphs need the target's size and pixel ratio.
      mesh.onBeforeRender = renderer => {
        renderer.getDrawingBufferSize(material.uniforms.u_resolution.value);
        material.uniforms.u_pxScale.value = renderer.getPixelRatio();
      };
      group.add(mesh);
      // its outline: the same glyphs' back faces, a little larger, near-black (drawn first)
      const om = new THREE.Mesh(g, outlineMaterial);
      om.frustumCulled = false;
      om.renderOrder = -1;
      om.userData.isBase = wantBase; om.userData.outline = true;
      om.onBeforeRender = mesh.onBeforeRender;
      group.add(om);
    }
  }
  return group;
}

// One drawn marker per row (resolveMarkerStyle's arrays as they are).
function rowInstances(set, resolved) {
  const n = set.markers.n, pos = set.markers.pos, rowInst = new Int32Array(n), members = [];
  for (let i = 0; i < n; i++) { rowInst[i] = i; members.push(Int32Array.of(i)); }
  const size = Float32Array.from(resolved.size, (s, i) => (Number.isFinite(pos[3 * i]) ? s : 0));
  return { n, center: pos, offset: new Float32Array(2 * n), color: resolved.color, shape: resolved.shape, size,
           base: resolved.base || new Uint8Array(n).fill(1), dim: resolved.dim || new Uint8Array(n), count: new Uint32Array(n).fill(1), members, rowInst, cut: 0 };
}

// Which drawn marker (index in group's markers as drawn) is hovered; -1 for none.
export function setMarkerHover(group, index) {
  group.userData.material.uniforms.u_hover.value = index == null ? -1 : index;
}

// Size multiplier and the opacity of base-colored markers. 100%: drawn
// like any opaque object. Below that: blended, without writing depth, so
// they don't hide what's behind them. 0%: not drawn at all.
export function setMarkerDisplay(group, { sizeScale = 1, opacity = 1 } = {}) {
  const m = group.userData.material, bm = group.userData.baseMaterial;
  m.uniforms.u_sizeScale.value = sizeScale;
  m.uniforms.u_opacity.value = opacity;
  if (group.userData.linkMaterial) group.userData.linkMaterial.uniforms.u_sizeScale.value = sizeScale;
  const transparent = opacity < 0.999;
  if (bm.transparent !== transparent) {
    bm.transparent = transparent;
    bm.depthWrite = !transparent;
    bm.needsUpdate = true;
  }
  // (a translucent base-coloured marker: no outline — it would show through it)
  for (const mesh of group.children) if (mesh.userData.isBase) mesh.visible = mesh.userData.outline ? !transparent : opacity > 0.004;
  if (group.userData.labelMaterial) group.userData.labelMaterial.uniforms.u_sizeScale.value = sizeScale;
}

export function disposeMarkerGroup(group, keepMaterial = false) {
  const done = new Set();   // (an outline shares its glyphs' geometry)
  for (const mesh of group.children) {
    if (done.has(mesh.geometry)) continue;
    done.add(mesh.geometry);
    // dispose() frees the GPU buffers of the attributes still attached; the
    // base glyph's position/normal/index are shared between all groups, so
    // detach those first and free only the per-group instance attributes.
    mesh.geometry.deleteAttribute('position');
    mesh.geometry.deleteAttribute('normal');
    mesh.geometry.index = null;
    mesh.geometry.dispose();
  }
  if (!keepMaterial) { group.userData.material.dispose(); group.userData.baseMaterial.dispose(); if (group.userData.outlineMaterial) group.userData.outlineMaterial.dispose(); if (group.userData.linkMaterial) group.userData.linkMaterial.dispose(); if (group.userData.labelMaterial) group.userData.labelMaterial.dispose(); }
}

export function markerBoundingSphere(pos) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) if (Number.isFinite(pos[i]) && Number.isFinite(pos[i + 1]) && Number.isFinite(pos[i + 2])) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]));
  return box.isEmpty() ? new THREE.Sphere() : box.getBoundingSphere(new THREE.Sphere());
}
