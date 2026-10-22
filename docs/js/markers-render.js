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

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MARKER_SHAPES } from './markers-io.js';

export const MARKER_VS = `
attribute vec3  iCenter;
attribute vec3  iColor;
attribute float iSize;      // diameter, in mm or CSS px (u_sizeInPx)
uniform float u_opacity;    // opacity of base-colored markers (iBase)
attribute float iIndex;     // marker index in its file (for u_hover)
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
varying vec3  vColor;
varying vec3  vNormalV;
varying float vSignedDist;
varying float vAlpha;
void main() {
  vec4 cView = modelViewMatrix * vec4(iCenter, 1.0);
  vec4 cClip = projectionMatrix * cView;
  // World-space diameter. For pixels: a length S at clip depth w covers
  // S * P[1][1] / w * resolution.y / 2 pixels, for a perspective and an
  // orthographic camera alike (w = 1 there).
  float d = iSize * u_sizeScale;
  bool hovered = abs(iIndex - u_hover) < 0.5;
  if (hovered) d *= 1.35;
  else if (iDim > 0.5) d *= 0.7;
  if (u_sizeInPx > 0.5) d = d * u_pxScale * cClip.w / (projectionMatrix[1][1] * 0.5 * u_resolution.y);
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
  gl_Position = projectionMatrix * modelViewMatrix * vec4(iCenter + position * d, 1.0);
}`;

export const MARKER_FS = `
precision highp float;
varying float vAlpha;
varying vec3  vColor;
varying vec3  vNormalV;
varying float vSignedDist;
void main() {
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
function makeLinkMesh(set, lr, material) {
  const L = set.links, pos = set.markers.pos, m = L.n;
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
  g.boundingSphere = markerBoundingSphere(pos);
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
    },
    side: THREE.DoubleSide,
  });
}

// Builds a THREE.Group with one instanced mesh per shape in use.
// resolved: resolveMarkerStyle()'s { color, shape, size, sizeUnit }.
// material: pass the previous group's material when rebuilding (a style
// change), so three.js keeps its compiled shader program — disposing a
// material and making a new one would recompile it every time.
// Returns the group; group.userData.material is the shared material (its
// uniforms: u_sizeScale, u_opacity, ... — see setMarkerDisplay), and each
// mesh's userData.markerIndex maps instance → marker index (for picking).
export function makeMarkerGroup(set, resolved, materials = null, linkResolved = null) {
  const { n, pos } = set.markers;
  // Two materials sharing one set of uniforms: markers in their own color
  // (always opaque) and markers in the base color (get the opacity). They
  // must be separate: a translucent marker mustn't write depth — it would
  // hide whatever is drawn after it (slice frames, streamlines) — while an
  // opaque one must.
  const material = (materials && materials.material) || makeMarkerMaterial();
  const baseMaterial = (materials && materials.baseMaterial) || makeMarkerMaterial({ FULL_PASS: 1 }, material.uniforms);
  material.uniforms.u_sizeInPx.value = resolved.sizeUnit === 'px' ? 1 : 0;
  const group = new THREE.Group();
  group.userData.material = material;
  group.userData.baseMaterial = baseMaterial;
  const base = baseGeometries();
  const isBase = i => (resolved.base ? resolved.base[i] : 1) === 1;
  MARKER_SHAPES.forEach((shapeName, s) => addShapeMeshes(s, shapeName));
  if (linkResolved && set.links && set.links.n) {
    const lm = (materials && materials.linkMaterial) || makeLinkMaterial();
    group.userData.linkMaterial = lm;
    group.add(makeLinkMesh(set, linkResolved, lm));
  }
  // One mesh per shape for own-colored markers, one for base-colored ones.
  function addShapeMeshes(s, shapeName) {
    for (const wantBase of [false, true]) {
      const idx = [];
      for (let i = 0; i < n; i++) if (resolved.shape[i] === s && isBase(i) === wantBase && resolved.size[i] > 0) idx.push(i);
      if (!idx.length) continue;
      const k = idx.length;
      const center = new Float32Array(3 * k), color = new Float32Array(3 * k), size = new Float32Array(k);
      const index = new Float32Array(k), dim = new Float32Array(k), baseF = new Float32Array(k);
      idx.forEach((i, j) => {
        center.set(pos.subarray(3 * i, 3 * i + 3), 3 * j);
        color.set(resolved.color.subarray(3 * i, 3 * i + 3), 3 * j);
        size[j] = resolved.size[i];
        index[j] = i;
        dim[j] = resolved.dim ? resolved.dim[i] : 0;
        baseF[j] = wantBase ? 1 : 0;
      });
      const g = new THREE.InstancedBufferGeometry();
      const b = base[shapeName];
      g.index = b.index;
      g.setAttribute('position', b.attributes.position);
      g.setAttribute('normal', b.attributes.normal);
      g.setAttribute('iCenter', new THREE.InstancedBufferAttribute(center, 3));
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(color, 3));
      g.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 1));
      g.setAttribute('iIndex', new THREE.InstancedBufferAttribute(index, 1));
      g.setAttribute('iDim', new THREE.InstancedBufferAttribute(dim, 1));
      g.setAttribute('iBase', new THREE.InstancedBufferAttribute(baseF, 1));
      g.instanceCount = k;
      // Glyphs are placed in the shader, so three's own bounds (from the
      // unit glyph at the origin) would cull them wrongly.
      g.boundingSphere = markerBoundingSphere(pos);
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
    }
  }
  return group;
}

// Which marker (index in its file) is drawn as hovered; -1 for none.
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
  for (const mesh of group.children) if (mesh.userData.isBase) mesh.visible = opacity > 0.004;
}

export function disposeMarkerGroup(group, keepMaterial = false) {
  for (const mesh of group.children) {
    // dispose() frees the GPU buffers of the attributes still attached; the
    // base glyph's position/normal/index are shared between all groups, so
    // detach those first and free only the per-group instance attributes.
    mesh.geometry.deleteAttribute('position');
    mesh.geometry.deleteAttribute('normal');
    mesh.geometry.index = null;
    mesh.geometry.dispose();
  }
  if (!keepMaterial) { group.userData.material.dispose(); group.userData.baseMaterial.dispose(); if (group.userData.linkMaterial) group.userData.linkMaterial.dispose(); }
}

export function markerBoundingSphere(pos) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]));
  return box.isEmpty() ? new THREE.Sphere() : box.getBoundingSphere(new THREE.Sphere());
}
