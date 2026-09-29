// ── markers-render.js ─────────────────────────────────────
// Draws a parsed markers set (see markers-io.js) as instanced 3D glyphs —
// one instanced mesh per shape (sphere, cube, diamond, cross) — with a
// per-marker center, color and size.
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
void main() {
  vec4 cView = modelViewMatrix * vec4(iCenter, 1.0);
  vec4 cClip = projectionMatrix * cView;
  // World-space diameter. For pixels: a length S at clip depth w covers
  // S * P[1][1] / w * resolution.y / 2 pixels, for a perspective and an
  // orthographic camera alike (w = 1 there).
  float d = iSize * u_sizeScale;
  if (u_sizeInPx > 0.5) d = d * u_pxScale * cClip.w / (projectionMatrix[1][1] * 0.5 * u_resolution.y);
  vSignedDist = dot(iCenter - u_slicePt, u_sliceNormal);
  if (d <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // hidden (size 0)
#if defined(NEAR_PASS)
  // In the slab when the glyph reaches into it; this pass: center in front.
  if (vSignedDist < 0.0 || vSignedDist > u_slabHalf + 0.5 * d) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#elif defined(FAR_PASS)
  if (vSignedDist >= 0.0 || vSignedDist < -u_slabHalf - 0.5 * d) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  vColor = iColor;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(iCenter + position * d, 1.0);
}`;

export const MARKER_FS = `
precision highp float;
uniform float u_opacity;
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
  gl_FragColor = vec4(col, u_opacity);
}`;

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
// Returns the group; group.userData.material is the shared material (its
// uniforms: u_sizeScale, u_opacity, ... — see setMarkerDisplay), and each
// mesh's userData.markerIndex maps instance → marker index (for picking).
export function makeMarkerGroup(set, resolved) {
  const { n, pos } = set.markers;
  const material = makeMarkerMaterial();
  material.uniforms.u_sizeInPx.value = resolved.sizeUnit === 'px' ? 1 : 0;
  const group = new THREE.Group();
  group.userData.material = material;
  const base = baseGeometries();
  MARKER_SHAPES.forEach((shapeName, s) => {
    const idx = [];
    for (let i = 0; i < n; i++) if (resolved.shape[i] === s) idx.push(i);
    if (!idx.length) return;
    const k = idx.length;
    const center = new Float32Array(3 * k), color = new Float32Array(3 * k), size = new Float32Array(k);
    idx.forEach((i, j) => {
      center.set(pos.subarray(3 * i, 3 * i + 3), 3 * j);
      color.set(resolved.color.subarray(3 * i, 3 * i + 3), 3 * j);
      size[j] = resolved.size[i];
    });
    const g = new THREE.InstancedBufferGeometry();
    const b = base[shapeName];
    g.index = b.index;
    g.setAttribute('position', b.attributes.position);
    g.setAttribute('normal', b.attributes.normal);
    g.setAttribute('iCenter', new THREE.InstancedBufferAttribute(center, 3));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(color, 3));
    g.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 1));
    g.instanceCount = k;
    // Glyphs are placed in the shader, so three's own bounds (from the
    // unit glyph at the origin) would cull them wrongly.
    g.boundingSphere = markerBoundingSphere(pos);
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.userData.markerIndex = Int32Array.from(idx);
    // Pixel-sized glyphs need the target's size and pixel ratio.
    mesh.onBeforeRender = renderer => {
      renderer.getDrawingBufferSize(material.uniforms.u_resolution.value);
      material.uniforms.u_pxScale.value = renderer.getPixelRatio();
    };
    group.add(mesh);
  });
  return group;
}

// Size multiplier and opacity (FILE panel sliders).
export function setMarkerDisplay(group, { sizeScale = 1, opacity = 1 } = {}) {
  const m = group.userData.material;
  m.uniforms.u_sizeScale.value = sizeScale;
  m.uniforms.u_opacity.value = opacity;
  const transparent = opacity < 0.999;
  if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
}

export function disposeMarkerGroup(group) {
  for (const mesh of group.children) {
    // dispose() frees the GPU buffers of the attributes still attached; the
    // base glyph's position/normal/index are shared between all groups, so
    // detach those first and free only the per-group instance attributes.
    mesh.geometry.deleteAttribute('position');
    mesh.geometry.deleteAttribute('normal');
    mesh.geometry.index = null;
    mesh.geometry.dispose();
  }
  group.userData.material.dispose();
}

export function markerBoundingSphere(pos) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]));
  return box.isEmpty() ? new THREE.Sphere() : box.getBoundingSphere(new THREE.Sphere());
}
