// ── Region meshes: brain regions as 3D surfaces ──────────────────────────
// The regions of the current label volume (index.html's "label volume in
// memory") that were switched on in 3D, each as its own triangle mesh. The
// raymarcher only draws the anatomical volume; everything about regions in
// 3D happens here.
//
// The set works like the streamline bundles' focus:
//   · a region in the set is drawn solid (focused) or as glass (dimmed);
//   · toggleFocus (the sun): adds a region (focused), then flips solid/glass;
//   · solo (the spotlight): only this one solid, all others glass — or,
//     when it already is, all solid again;
//   · setMember (the card's checkmark): add (solid) or remove.
// "All" is every region switched on since the label volume was chosen; a
// different label volume starts an empty set.
//
// Meshes are built in a worker (region-mesh-worker.js: surface nets on the
// region's voxels, rounded within their cells — or, setSurface('voxels'),
// the voxel faces themselves) and cached per (volume, region), so
// switching a region off and on again, or going back to an earlier label
// volume, builds nothing.
//
// Shading follows the scene's light (point light or direction, ambient,
// depth falloff). Glass uses the glass brain's RIM and OPACITY settings:
// alpha = (1 − |N·V|)^rim × opacity, front faces only. The clipping plane
// cuts them (clipUniforms, kept up to date by index.html).
//
// CAPS: where the plane cuts the solid regions, a flat face closes them.
// One quad per cut face (two in slice mode), drawn in the plane; its
// shader looks up the label volume at each pixel (a 3D texture of compact
// region numbers) and colors the pixel by a small table of the solid
// regions, or lets it through. The lookup is a trilinear vote over the 8
// voxels around the point (a region wins where its share reaches 0.5),
// so the cap's edge follows the region's voxel boundary, as the mesh does
// (setSurface('voxels'): the nearest voxel only — squares, as the cubes).

import { LIGHT_FALLOFF_GLSL, CLIP3D_GLSL, makeClipUniforms } from './scene3d.js';

export const VS = `
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const FS = `
precision highp sampler3D;
varying vec3 vWorldPos;
varying vec3 vNormal;
uniform vec3  u_color;
uniform float u_glass;        // 0 solid, 1 glass, 3 inner wall (solid back faces)
uniform float u_rimPow;
uniform float u_alphaMult;
uniform vec3  u_lightDir;     // the direction the light travels
uniform vec3  u_lightPos;
uniform float u_pointLight;
uniform float u_ambient;
uniform float u_gloss;
uniform vec3  u_camFwd;
uniform vec3  u_depthTarget;
uniform float u_depthRadius;
// SHADOWS (js/line-shadows.js, high/ultra GPU tier): the light left at a
// point after the way to the light — what the streamlines, the solid brain
// and the solid regions take away. Read 1.5 shadow voxels towards the
// light and 1.5 off the surface, so a surface doesn't shade itself.
// u_meshShadowOn = 0: off.
uniform sampler3D u_shadowTex;
uniform float u_meshShadowOn;
uniform vec3  u_shadowMin;
uniform vec3  u_shadowSize;
uniform float u_shadowVoxMm;
` + LIGHT_FALLOFF_GLSL + CLIP3D_GLSL + `
void main() {
  if (clipped3d(vWorldPos)) discard;
  // clipped open, solid: its inside (back faces) in its own color, flat —
  // the cut reads as filled (a cheap stand-in for a cap in the plane)
  if (u_clipOn > 0.5 && u_glass < 0.5 && !gl_FrontFacing) { gl_FragColor = vec4(u_color * 0.72, 1.0); return; }
  vec3 N = normalize(vNormal);
  // the inner wall faces inward (three.js draws BackSide with the winding
  // flipped, so gl_FrontFacing can't tell); otherwise toward the viewer
  if (u_glass > 2.5) N = -N; else if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = u_pointLight > 0.5 ? normalize(u_lightPos - vWorldPos) : -normalize(u_lightDir);
  float diffuse = max(dot(N, L), 0.0);
  float fall = lightFalloff(vWorldPos, cameraPosition, u_depthTarget, u_camFwd, u_depthRadius);
  vec3 Hraw = L + V;
  float Hlen = length(Hraw);
  float spec = Hlen > 1e-4 ? pow(max(dot(N, Hraw / Hlen), 0.0), 32.0) * smoothstep(0.02, 0.25, Hlen) : 0.0;
  float T = 1.0;   // the direct light that gets here (shadows only take away direct light)
  // (off the surface along its normal too: where the light grazes it, the
  // way to the light would skim the region's own bumps — shadow acne)
  if (u_meshShadowOn > 0.5 && (u_glass < 0.5 || u_glass > 2.5))
    T = texture(u_shadowTex, (vWorldPos + (L * 1.5 + N * 1.5) * u_shadowVoxMm - u_shadowMin) / u_shadowSize).r;
  vec3 col = u_color * (u_ambient + (1.0 - u_ambient) * diffuse * fall * T) + vec3(u_gloss * spec * fall * T);
  float alpha = 1.0;
  if (u_glass > 2.5) col *= 0.75;                       // the inner wall: a little darker
  else if (u_glass > 0.5) alpha = clamp(pow(1.0 - abs(dot(N, V)), u_rimPow) * u_alphaMult, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}`;

// the cap: world → voxel (u_w2v), the label volume as compact numbers
// (u_lab, two bytes per voxel), per number its color and alpha = solid
// region (u_tab, 256 wide)
const CAP_VS = `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const CAP_FS = `
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler3D u_lab;
uniform sampler2D u_tab;
uniform mat4 u_w2v;
uniform vec3 u_dims;
uniform float u_nearest;   // 1: the nearest voxel only (surface 'voxels')
varying vec3 vWorld;
int idAt(ivec3 i) {
  if (any(lessThan(i, ivec3(0))) || any(greaterThanEqual(i, ivec3(u_dims)))) return 0;
  vec2 rg = texelFetch(u_lab, i, 0).rg;
  return int(rg.r * 255.0 + 0.5) + 256 * int(rg.g * 255.0 + 0.5);
}
void main() {
  vec3 v = (u_w2v * vec4(vWorld, 1.0)).xyz;     // voxel coordinates (centres at integers)
  vec3 b = floor(v), f = v - b;
  if (u_nearest > 0.5) f = step(0.5, f);         // all weight on the nearest voxel
  ivec3 ib = ivec3(b);
  int ids[8]; float ws[8];
  for (int c = 0; c < 8; c++) {
    ivec3 o = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    ids[c] = idAt(ib + o);
    vec3 t = mix(1.0 - f, f, vec3(o));
    ws[c] = t.x * t.y * t.z;
  }
  for (int a = 0; a < 8; a++) {
    int id = ids[a];
    if (id == 0) continue;
    vec4 e = texelFetch(u_tab, ivec2(id - (id / 256) * 256, id / 256), 0);
    if (e.a < 0.5) continue;                     // not a solid region in 3D
    float share = 0.0;
    for (int c = 0; c < 8; c++) if (ids[c] == id) share += ws[c];
    if (share >= 0.5) { gl_FragColor = vec4(e.rgb * 0.72, 1.0); return; }
  }
  discard;
}`;

// the cap of an ROI set: u_lab holds each voxel's ROI bits (4 bytes), u_tab
// per ROI (bit) its color and alpha = solid; the first solid ROI whose
// trilinear share at the point reaches 0.5 colors it (overlap: the lower one)
const CAP_FS_BITS = `
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler3D u_lab;
uniform sampler2D u_tab;
uniform mat4 u_w2v;
uniform vec3 u_dims;
uniform int u_n;
uniform float u_nearest;
varying vec3 vWorld;
uint bitsAt(ivec3 i) {
  if (any(lessThan(i, ivec3(0))) || any(greaterThanEqual(i, ivec3(u_dims)))) return 0u;
  uvec4 b = uvec4(texelFetch(u_lab, i, 0) * 255.0 + 0.5);
  return b.r | (b.g << 8) | (b.b << 16) | (b.a << 24);
}
void main() {
  vec3 v = (u_w2v * vec4(vWorld, 1.0)).xyz;
  vec3 b = floor(v), f = v - b;
  if (u_nearest > 0.5) f = step(0.5, f);         // all weight on the nearest voxel
  ivec3 ib = ivec3(b);
  uint m[8]; float ws[8];
  for (int c = 0; c < 8; c++) {
    ivec3 o = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    m[c] = bitsAt(ib + o);
    vec3 t = mix(1.0 - f, f, vec3(o));
    ws[c] = t.x * t.y * t.z;
  }
  for (int k = 0; k < 32; k++) {
    if (k >= u_n) break;
    vec4 e = texelFetch(u_tab, ivec2(k, 0), 0);
    if (e.a < 0.5) continue;
    uint bit = 1u << uint(k);
    float share = 0.0;
    for (int c = 0; c < 8; c++) if ((m[c] & bit) != 0u) share += ws[c];
    if (share >= 0.5) { gl_FragColor = vec4(e.rgb * 0.72, 1.0); return; }
  }
  discard;
}`;

function invert3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
export const hexToRaw = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

// voxel index coordinates → world mm (the label volume's affine);
// normals (from the field's gradient) with the inverse transpose
export function voxelGeometry(THREE, invAb, pos, nrm, idx) {
  const A = invAb;
  const Ab = invert3(A.slice(0, 3)), t = A.length === 4 ? A[3] : [0, 0, 0];
  const det = Ab[0][0] * (Ab[1][1] * Ab[2][2] - Ab[1][2] * Ab[2][1]) - Ab[0][1] * (Ab[1][0] * Ab[2][2] - Ab[1][2] * Ab[2][0]) + Ab[0][2] * (Ab[1][0] * Ab[2][1] - Ab[1][1] * Ab[2][0]);
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] - t[0], y = pos[i + 1] - t[1], z = pos[i + 2] - t[2];
    for (let r = 0; r < 3; r++) out[i + r] = Ab[r][0] * x + Ab[r][1] * y + Ab[r][2] * z;
  }
  const N = new Float32Array(nrm.length);
  for (let i = 0; i < nrm.length; i += 3) {
    let x = 0, y = 0, z = 0;
    for (let r = 0; r < 3; r++) { x += A[r][0] * nrm[i + r]; y += A[r][1] * nrm[i + r]; z += A[r][2] * nrm[i + r]; }
    const l = Math.hypot(x, y, z) || 1;
    N[i] = x / l; N[i + 1] = y / l; N[i + 2] = z / l;
  }
  if (det < 0) for (let i = 0; i < idx.length; i += 3) { const s = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = s; } // mirrored: keep front faces outward
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.computeBoundingSphere();
  return g;
}

export class RegionMeshes {
  // THREE; scene: where the meshes go; render(): redraw the 3D view;
  // colorOf(v): '#rrggbb' of region v; onChange(): the set changed (menus);
  // getLight(): { lightCam: Vector3 (camera frame), point, falloff, ambient,
  //   target: Vector3, radius, rimPow, alphaMult }
  constructor({ THREE, scene, render, colorOf, onChange, getLight }) {
    this.THREE = THREE; this.render = render; this.colorOf = colorOf;
    this.onChange = onChange || (() => {}); this.getLight = getLight;
    this.group = new THREE.Group();
    this.group.name = 'region meshes';
    scene.add(this.group);
    this.set = new Map();        // label → { focus, mesh | null }
    this.cache = new Map();      // vol → Map(label → BufferGeometry | null (empty))
    this.vol = null; this.ref = null; this.gen = 0;
    this.pending = new Set();    // labels requested from the worker (this gen)
    this.surface = 'smooth';     // setSurface()
    this.uniforms = {
      u_rimPow: { value: 1 }, u_alphaMult: { value: 1 },
      u_lightDir: { value: new THREE.Vector3(0, 0, 1) }, u_lightPos: { value: new THREE.Vector3() },
      u_pointLight: { value: 1 }, u_ambient: { value: 0.25 }, u_gloss: { value: 0.25 }, u_falloff: { value: 0.5 },
      u_camFwd: { value: new THREE.Vector3(0, 0, -1) }, u_depthTarget: { value: new THREE.Vector3() },
      u_depthRadius: { value: 1 },
      // SHADOWS: kept up to date by index.html (syncMeshShadowUniforms)
      u_shadowTex: { value: null }, u_meshShadowOn: { value: 0 },
      u_shadowMin: { value: new THREE.Vector3() }, u_shadowSize: { value: new THREE.Vector3(1, 1, 1) },
      u_shadowVoxMm: { value: 1 },
    };
    this.version = 0;            // +1 on every change of the set (shadow casters follow it)
    // How a dimmed region is drawn: 'glass' (rim) or 'inside' (glass
    // front, its inner walls solid). setDimMode().
    this.dimMode = 'glass';
    // CLIPPING: this set's clip uniforms (index.html updates their values)
    this.clipUniforms = makeClipUniforms();
    this._cap = null;            // the caps (built when first needed, per label volume)
    this._r = new THREE.Vector3(); this._u = new THREE.Vector3();
    try {
      this.worker = new Worker(new URL('./region-mesh-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this._done(e.data);
      this.worker.onerror = e => console.warn('region meshes: worker failed', e.message);
    } catch (e) { console.warn('region meshes: no worker', e); this.worker = null; }
  }

  // The current label volume ({ vol, raw, shape, invAb, bits } or null).
  // bits: an ROI set — raw holds one bit per ROI (region v = bit v−1 set),
  // so regions may overlap. Another volume empties the set (its meshes
  // stay cached).
  setRef(ref) {
    if (ref && this.vol === ref.vol) { this.ref = ref; return; }
    this.clear(false);
    this._dropCaps();
    this.ref = ref; this.vol = ref ? ref.vol : null; this.gen++;
    this.pending.clear();
    if (ref && this.worker) {
      if (!this.cache.has(ref.vol)) this.cache.set(ref.vol, new Map());
      this._postVolume();
    }
    this._changed();   // (redraw now: the old volume's meshes are gone)
  }
  _postVolume() {
    const ref = this.ref;
    this.worker.postMessage({ type: 'volume', gen: this.gen, raw: ref.raw.slice(), shape: ref.shape.slice(), bits: !!ref.bits, surface: this.surface });
  }
  // How region surfaces are built (region-mesh-worker.js): 'smooth' (on the
  // voxels, rounded within their cells) or 'voxels' (every voxel step, lit
  // flat). Rebuilds what is shown.
  setSurface(style) {
    if (style === this.surface) return;
    this.surface = style;
    for (const m of this.cache.values()) for (const g of m.values()) if (g) g.dispose();
    this.cache = new Map();
    if (!this.ref) return;
    this.cache.set(this.vol, new Map());
    if (this._cap) this._cap.mat.uniforms.u_nearest.value = style === 'voxels' ? 1 : 0;
    this.gen++; this.pending.clear();
    if (this.worker) this._postVolume();
    for (const [v, e] of this.set) { this._drop(e); e.mesh = null; e.back = null; this._request(v); }
    this._changed();
  }

  get size() { return this.set.size; }
  has(v) { return this.set.has(v); }
  focused(v) { const e = this.set.get(v); return !!(e && e.focus); }
  building(v) { return this.pending.has(v); }
  isSolo(v) {
    const e = this.set.get(v);
    if (!e || !e.focus) return false;
    for (const [w, x] of this.set) if (w !== v && x.focus) return false;
    return true;
  }
  get allFocused() { for (const x of this.set.values()) if (!x.focus) return false; return true; }
  get anyFocused() { for (const x of this.set.values()) if (x.focus) return true; return false; }

  // the sun: add (solid), then solid ⇄ glass
  toggleFocus(v) {
    const e = this.set.get(v);
    if (!e) this._add(v, true); else { e.focus = !e.focus; this._style(v); }
    this._changed();
  }
  // the spotlight: only v solid (added if needed) — or all solid again
  solo(v) {
    if (this.isSolo(v)) for (const x of this.set.values()) x.focus = true;
    else { if (!this.set.has(v)) this._add(v, true); for (const [w, x] of this.set) x.focus = w === v; }
    for (const w of this.set.keys()) this._style(w);
    this._changed();
  }
  // the checkmark: in the set (solid) or not
  setMember(v, on) {
    if (on && !this.set.has(v)) this._add(v, true);
    else if (!on && this.set.has(v)) { this._drop(this.set.get(v)); this.set.delete(v); }
    else return;
    this._changed();
  }
  // all regions in the set solid (on) or glass
  setAllFocus(on) {
    for (const [w, x] of this.set) { x.focus = on; this._style(w); }
    this._changed();
  }
  // The nearest solid region surface on a ray (THREE.Raycaster): { label,
  // point: [x,y,z], distance } or null — as drawn: what the clipping plane
  // cut away doesn't count, and a region entered through its cut is hit
  // at its cap.
  pickSolid(raycaster) {
    if (!this.group.visible) return null;
    const solid = [...this.set.values()].filter(e => e.mesh && e.focus).map(e => e.mesh);
    if (!solid.length) return null;
    const ray = raycaster.ray, tIn = this.clipEntry(ray.origin, ray.direction);
    for (const hit of raycaster.intersectObjects(solid, false)) {
      if (this.clipped(hit.point)) continue;
      // a back face first: the ray was inside the region already — it came in through the cap
      const back = hit.face && hit.face.normal.clone().transformDirection(hit.object.matrixWorld).dot(ray.direction) > 0;
      if (back && tIn !== null && tIn < hit.distance) {
        const p = ray.origin.clone().addScaledVector(ray.direction, tIn);
        return { label: hit.object.userData.region, point: p.toArray(), distance: tIn };
      }
      return { label: hit.object.userData.region, point: hit.point.toArray(), distance: hit.distance };
    }
    return null;
  }
  // CLIPPING on the CPU (the test of CLIP3D_GLSL, this set's uniforms):
  // clipped(p) — p (world, {x,y,z} or [x,y,z]) is cut away;
  // clipEntry(o, d) — where a ray (unit d) enters the part that is kept,
  // or null (not cut, or it starts inside).
  clipped(p) {
    const u = this.clipUniforms;
    if (u.u_clipOn.value < 0.5) return false;
    const n = u.u_clipN.value, q = u.u_clipQ.value, x = p.x ?? p[0], y = p.y ?? p[1], z = p.z ?? p[2];
    const d = (x - q.x) * n.x + (y - q.y) * n.y + (z - q.z) * n.z, ext = u.u_clipExt.value;
    return u.u_clipSlab.value > 0.5 ? Math.abs(d) > u.u_clipHalfT.value + ext : d * u.u_clipDir.value < -ext;
  }
  clipEntry(o, dir) {
    const u = this.clipUniforms;
    if (u.u_clipOn.value < 0.5) return null;
    const n = u.u_clipN.value, q = u.u_clipQ.value, ext = u.u_clipExt.value;
    const d0 = (o.x - q.x) * n.x + (o.y - q.y) * n.y + (o.z - q.z) * n.z, dn = dir.x * n.x + dir.y * n.y + dir.z * n.z;
    if (Math.abs(dn) < 1e-9) return null;
    if (u.u_clipSlab.value > 0.5) {
      const H = u.u_clipHalfT.value + ext;
      if (Math.abs(d0) <= H || Math.sign(dn) === Math.sign(d0)) return null;
      return (Math.sign(d0) * H - d0) / dn;
    }
    const s = u.u_clipDir.value;               // kept: d·s ≥ −ext
    if (d0 * s >= -ext || dn * s <= 0) return null;
    return (-ext - d0 * s) / (dn * s);
  }
  setDimMode(mode) {
    if (!['glass', 'inside'].includes(mode)) return this.dimMode;
    this.dimMode = mode;
    for (const v of this.set.keys()) this._style(v);
    this.render();
    return mode;
  }
  get visible() { return this.group.visible; }
  setVisible(on) { this.group.visible = !!on; this._changed(); }
  // empty the set
  clear(notify = true) {
    for (const e of this.set.values()) this._drop(e);
    this.set.clear();
    if (notify) this._changed();
  }
  // region colors changed (lookup table edits)
  refreshColors() {
    for (const [v, e] of this.set) if (e.mesh) e.mesh.material.uniforms.u_color.value.set(...hexToRaw(this.colorOf(v) || '#ffffff'));
    if (this._cap) this._cap.dirty = true;
    this.updateCaps();
    this.render();
  }

  _changed() { this.version++; if (this._cap) this._cap.dirty = true; this.updateCaps(); this.onChange(); this.render(); }

  // ── SHADOW CASTERS ──
  // The regions drawn solid (in the set, focused, meshed, group shown):
  // { ref, test(raw value) → solid, box: { min, max } world } or null.
  solidRegions() {
    if (!this.group.visible || !this.ref) return null;
    const labels = [];
    const box = new this.THREE.Box3();
    for (const [v, e] of this.set) if (e.focus && e.mesh) {
      labels.push(v);
      const g = e.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    if (!labels.length) return null;
    let test;
    if (this.ref.bits) {                      // any solid ROI's bit set
      let mask = 0; for (const v of labels) mask |= 1 << (v - 1);
      test = raw => (raw & mask) !== 0;
    } else {
      const max = Math.max(...labels);
      if (max >= 0 && max < 1 << 20) { const solid = new Uint8Array(max + 1); for (const v of labels) solid[v] = 1; test = raw => raw >= 0 && raw < solid.length && solid[raw] === 1; }
      else { const solid = new Set(labels); test = raw => solid.has(raw); }
    }
    return { ref: this.ref, test, box: { min: box.min.toArray(), max: box.max.toArray() } };
  }

  // ── CAPS ──
  // Places (or hides) the caps after the clip uniforms or the set changed.
  updateCaps() {
    const u = this.clipUniforms;
    let solid = false;
    for (const e of this.set.values()) if (e.focus && e.mesh) { solid = true; break; }
    const on = u.u_clipOn.value > 0.5 && !!this.ref && solid;
    if (!on) { if (this._cap) for (const m of this._cap.meshes) m.visible = false; return; }
    if (!this._cap) this._buildCaps();
    const C = this._cap;
    if (!C) return;
    if (C.dirty) this._fillTable();
    const THREE = this.THREE, n = u.u_clipN.value.clone().normalize(), q = u.u_clipQ.value;
    const ext = u.u_clipExt.value, dir = u.u_clipDir.value, slab = u.u_clipSlab.value > 0.5, half = u.u_clipHalfT.value;
    // kept: d·dir ≥ −ext (half space), |d| ≤ half + ext (slab); d = (p − q)·n
    const offs = slab ? [half + ext, -(half + ext)] : [-ext * dir];
    const a = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const e1 = new THREE.Vector3().crossVectors(n, a).normalize(), e2 = new THREE.Vector3().crossVectors(n, e1);
    C.meshes.forEach((m, k) => {
      if (k >= offs.length) { m.visible = false; return; }
      const c = q.clone().addScaledVector(n, offs[k]);
      const pc = C.centre.clone().addScaledVector(n, -C.centre.clone().sub(c).dot(n));   // the volume's centre, onto the plane
      m.matrix.makeBasis(e1, e2, n).scale(new THREE.Vector3(C.size, C.size, 1)).setPosition(pc);
      m.matrixWorldNeedsUpdate = true;
      m.visible = true;
    });
  }

  _buildCaps() {
    const THREE = this.THREE, ref = this.ref, raw = ref.raw, [nx, ny, nz] = ref.shape;
    if (ref.bits) return this._buildCapsBits();
    // compact numbers: 0 = background, 1… the label values present
    const compact = new Map([[0, 0]]), lab = new Uint8Array(raw.length * 2);
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      let c = compact.get(v);
      if (c === undefined) {
        c = compact.size;
        if (c > 65535) { console.warn('region caps: too many labels'); return; }
        compact.set(v, c);
      }
      lab[2 * i] = c & 255; lab[2 * i + 1] = c >> 8;
    }
    const labTex = new THREE.Data3DTexture(lab, nx, ny, nz);
    labTex.format = THREE.RGFormat; labTex.type = THREE.UnsignedByteType;
    labTex.minFilter = labTex.magFilter = THREE.NearestFilter;
    labTex.unpackAlignment = 1; labTex.needsUpdate = true;
    const rows = Math.ceil(compact.size / 256), tab = new Uint8Array(256 * rows * 4);
    const tabTex = new THREE.DataTexture(tab, 256, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    tabTex.minFilter = tabTex.magFilter = THREE.NearestFilter; tabTex.needsUpdate = true;
    // world ↔ voxel (invAb: rows 0–2 the linear part, row 3 the translation)
    const M = ref.invAb, t = M.length === 4 ? M[3] : [0, 0, 0];
    const w2v = new THREE.Matrix4().set(M[0][0], M[0][1], M[0][2], t[0], M[1][0], M[1][1], M[1][2], t[1], M[2][0], M[2][1], M[2][2], t[2], 0, 0, 0, 1);
    const v2w = w2v.clone().invert();
    const box = new THREE.Box3();
    for (const x of [-0.5, nx - 0.5]) for (const y of [-0.5, ny - 0.5]) for (const z of [-0.5, nz - 0.5])
      box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(v2w));
    const mat = new THREE.ShaderMaterial({
      vertexShader: CAP_VS, fragmentShader: CAP_FS, side: THREE.DoubleSide,
      // in front of what lies in the same plane (the volume's own cut face, at extend 0)
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: { u_lab: { value: labTex }, u_tab: { value: tabTex }, u_w2v: { value: w2v }, u_dims: { value: new THREE.Vector3(nx, ny, nz) }, u_nearest: { value: this.surface === 'voxels' ? 1 : 0 } },
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    const meshes = [0, 1].map(k => {
      const m = new THREE.Mesh(geo, mat);
      m.name = 'region cap ' + k; m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false;
      this.group.add(m);
      return m;
    });
    this._cap = { compact, labTex, tabTex, tab, mat, geo, meshes, dirty: true,
      centre: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()).length() };
  }

  // an ROI set: the bits as they are (RGBA bytes), the table per bit
  _buildCapsBits() {
    const THREE = this.THREE, ref = this.ref, [nx, ny, nz] = ref.shape;
    const bytes = new Uint8Array(ref.raw.buffer.slice(ref.raw.byteOffset, ref.raw.byteOffset + ref.raw.byteLength));
    const labTex = new THREE.Data3DTexture(bytes, nx, ny, nz);
    labTex.format = THREE.RGBAFormat; labTex.type = THREE.UnsignedByteType;
    labTex.minFilter = labTex.magFilter = THREE.NearestFilter;
    labTex.unpackAlignment = 1; labTex.needsUpdate = true;
    const tab = new Uint8Array(32 * 4);
    const tabTex = new THREE.DataTexture(tab, 32, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tabTex.minFilter = tabTex.magFilter = THREE.NearestFilter; tabTex.needsUpdate = true;
    const box = this._volBox(ref);
    const mat = new THREE.ShaderMaterial({
      vertexShader: CAP_VS, fragmentShader: CAP_FS_BITS, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: { u_lab: { value: labTex }, u_tab: { value: tabTex }, u_w2v: { value: box.w2v }, u_dims: { value: new THREE.Vector3(nx, ny, nz) }, u_n: { value: 32 }, u_nearest: { value: this.surface === 'voxels' ? 1 : 0 } },
    });
    this._capMeshes(mat, { labTex, tabTex, tab, bits: true, box });
  }
  // world ↔ voxel and the volume's world box
  _volBox(ref) {
    const THREE = this.THREE, [nx, ny, nz] = ref.shape, M = ref.invAb, t = M.length === 4 ? M[3] : [0, 0, 0];
    const w2v = new THREE.Matrix4().set(M[0][0], M[0][1], M[0][2], t[0], M[1][0], M[1][1], M[1][2], t[1], M[2][0], M[2][1], M[2][2], t[2], 0, 0, 0, 1);
    const v2w = w2v.clone().invert(), box = new THREE.Box3();
    for (const x of [-0.5, nx - 0.5]) for (const y of [-0.5, ny - 0.5]) for (const z of [-0.5, nz - 0.5])
      box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(v2w));
    return { w2v, centre: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()).length() };
  }
  _capMeshes(mat, extra) {
    const THREE = this.THREE, geo = new THREE.PlaneGeometry(1, 1);
    const meshes = [0, 1].map(k => {
      const m = new THREE.Mesh(geo, mat);
      m.name = 'region cap ' + k; m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false;
      this.group.add(m);
      return m;
    });
    this._cap = { ...extra, mat, geo, meshes, dirty: true, centre: extra.box.centre, size: extra.box.size };
  }

  // the table: per compact number (per bit for an ROI set) its color, alpha 255 = a solid region in the set
  _fillTable() {
    const C = this._cap;
    C.tab.fill(0);
    if (C.bits) {
      for (const [v, e] of this.set) {
        if (!e.focus || !e.mesh || v < 1 || v > 32) continue;
        const rgb = hexToRaw(this.colorOf(v) || '#ffffff');
        C.tab.set([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255), 255], 4 * (v - 1));
      }
      C.tabTex.needsUpdate = true; C.dirty = false;
      return;
    }
    for (const [v, e] of this.set) {
      if (!e.focus || !e.mesh) continue;
      const c = C.compact.get(v);
      if (c === undefined || c === 0) continue;
      const rgb = hexToRaw(this.colorOf(v) || '#ffffff');
      C.tab.set([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255), 255], 4 * c);
    }
    C.tabTex.needsUpdate = true;
    C.dirty = false;
  }

  _dropCaps() {
    const C = this._cap;
    if (!C) return;
    for (const m of C.meshes) this.group.remove(m);
    C.labTex.dispose(); C.tabTex.dispose(); C.mat.dispose(); C.geo.dispose();
    this._cap = null;
  }

  _add(v, focus) {
    this.set.set(v, { focus, mesh: null });
    const cached = this.cache.get(this.vol);
    if (cached && cached.has(v)) { this._mesh(v, cached.get(v)); return; }
    this._request(v);
  }
  _request(v) {
    if (!this.worker || this.pending.has(v)) return;
    this.pending.add(v);
    this.worker.postMessage({ type: 'mesh', gen: this.gen, label: v });
  }

  _done(msg) {
    if (msg.gen !== this.gen) return;
    this.pending.delete(msg.label);
    if (msg.error) { console.warn('region meshes: region ' + msg.label + ':', msg.error); this.onChange(); return; }
    const geo = msg.empty ? null : this._geometry(msg.positions, msg.normals, msg.indices);
    this.cache.get(this.vol).set(msg.label, geo);
    if (this.set.has(msg.label)) this._mesh(msg.label, geo);
    this._changed();
  }

  _geometry(pos, nrm, idx) { return voxelGeometry(this.THREE, this.ref.invAb, pos, nrm, idx); }

  _drop(e) {
    if (!e.mesh) return;
    this.group.remove(e.mesh); e.mesh.material.dispose();
    if (e.back) e.back.material.dispose();
  }

  _mesh(v, geo) {
    const e = this.set.get(v);
    if (!e || !geo || e.mesh) return;
    const THREE = this.THREE;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: { ...this.uniforms, ...this.clipUniforms, u_color: { value: new THREE.Vector3(...hexToRaw(this.colorOf(v) || '#ffffff')) }, u_glass: { value: 0 } },
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.region = v;
    m.onBeforeRender = (renderer, scene, cam) => this._sync(cam);
    e.mesh = m;
    // the inner walls ('inside' dim mode): the same surface, back faces, solid
    const back = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, side: THREE.BackSide,
      uniforms: { ...this.uniforms, ...this.clipUniforms, u_color: mat.uniforms.u_color, u_glass: { value: 3 } },
    }));
    back.onBeforeRender = m.onBeforeRender;
    back.visible = false;
    m.add(back); e.back = back;
    this.group.add(m);
    this._style(v);
  }

  // solid: opaque, depth written, both sides; glass: blended, front faces,
  // drawn before the glass brain (renderOrder 999) so its shell blends over
  _style(v) {
    const e = this.set.get(v), m = e && e.mesh;
    if (!m) return;
    const glass = !e.focus, mat = m.material, mode = this.dimMode;
    // dimmed: glass (front faces), or inside (glass over solid inner walls)
    mat.uniforms.u_glass.value = glass ? 1 : 0;
    mat.transparent = glass; mat.depthWrite = !glass;
    mat.side = glass ? this.THREE.FrontSide : this.THREE.DoubleSide;
    mat.needsUpdate = true;
    m.renderOrder = glass ? 998 : 0;
    if (e.back) e.back.visible = glass && mode === 'inside';
  }

  // the light, as for the streamlines (scene3d.js attachStreamlineShading)
  _sync(cam) {
    const L = this.getLight(), u = this.uniforms;
    const r = this._r.setFromMatrixColumn(cam.matrixWorld, 0), up = this._u.setFromMatrixColumn(cam.matrixWorld, 1);
    const fwd = u.u_camFwd.value.setFromMatrixColumn(cam.matrixWorld, 2).multiplyScalar(-1);
    const lc = L.lightCam;
    u.u_lightDir.value.set(0, 0, 0).addScaledVector(r, lc.x).addScaledVector(up, lc.y).addScaledVector(fwd, lc.z).normalize();
    const d = cam.position.distanceTo(L.target);
    u.u_lightPos.value.copy(L.target).addScaledVector(u.u_lightDir.value, -d);
    u.u_pointLight.value = L.point ? 1 : 0;
    u.u_falloff.value = L.falloff; u.u_ambient.value = L.ambient; if (L.gloss != null) u.u_gloss.value = L.gloss;
    u.u_depthTarget.value.copy(L.target); u.u_depthRadius.value = L.radius || 1;
    u.u_rimPow.value = L.rimPow; u.u_alphaMult.value = L.alphaMult;
  }
}
