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
// region blurred as the raymarcher does, normals from its gradient) and cached per (volume, region), so
// switching a region off and on again, or going back to an earlier label
// volume, builds nothing.
//
// Shading follows the scene's light (point light or direction, ambient,
// depth falloff). Glass uses the glass brain's RIM and OPACITY settings:
// alpha = (1 − |N·V|)^rim × opacity, front faces only. Clip planes do not
// apply to the meshes.

import { LIGHT_FALLOFF_GLSL } from './scene3d.js';

const VS = `
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FS = `
varying vec3 vWorldPos;
varying vec3 vNormal;
uniform vec3  u_color;
uniform float u_glass;
uniform float u_rimPow;
uniform float u_alphaMult;
uniform vec3  u_lightDir;     // the direction the light travels
uniform vec3  u_lightPos;
uniform float u_pointLight;
uniform float u_ambient;
uniform vec3  u_camFwd;
uniform vec3  u_depthTarget;
uniform float u_depthRadius;
` + LIGHT_FALLOFF_GLSL + `
void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = u_pointLight > 0.5 ? normalize(u_lightPos - vWorldPos) : -normalize(u_lightDir);
  float diffuse = max(dot(N, L), 0.0);
  float fall = lightFalloff(vWorldPos, cameraPosition, u_depthTarget, u_camFwd, u_depthRadius);
  vec3 Hraw = L + V;
  float Hlen = length(Hraw);
  float spec = Hlen > 1e-4 ? pow(max(dot(N, Hraw / Hlen), 0.0), 32.0) * smoothstep(0.02, 0.25, Hlen) : 0.0;
  vec3 col = u_color * (u_ambient + (1.0 - u_ambient) * diffuse * fall) + vec3(0.25 * spec * fall);
  float alpha = 1.0;
  if (u_glass > 0.5) alpha = clamp(pow(1.0 - abs(dot(N, V)), u_rimPow) * u_alphaMult, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}`;

function invert3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const hexToRaw = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

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
    this.uniforms = {
      u_rimPow: { value: 1 }, u_alphaMult: { value: 1 },
      u_lightDir: { value: new THREE.Vector3(0, 0, 1) }, u_lightPos: { value: new THREE.Vector3() },
      u_pointLight: { value: 1 }, u_ambient: { value: 0.25 }, u_falloff: { value: 0.5 },
      u_camFwd: { value: new THREE.Vector3(0, 0, -1) }, u_depthTarget: { value: new THREE.Vector3() },
      u_depthRadius: { value: 1 },
    };
    this._r = new THREE.Vector3(); this._u = new THREE.Vector3();
    try {
      this.worker = new Worker(new URL('./region-mesh-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this._done(e.data);
      this.worker.onerror = e => console.warn('region meshes: worker failed', e.message);
    } catch (e) { console.warn('region meshes: no worker', e); this.worker = null; }
  }

  // The current label volume ({ vol, raw, shape, invAb } or null). Another
  // volume empties the set (its meshes stay cached).
  setRef(ref) {
    if (ref && this.vol === ref.vol) { this.ref = ref; return; }
    this.clear(false);
    this.ref = ref; this.vol = ref ? ref.vol : null; this.gen++;
    this.pending.clear();
    if (ref && this.worker) {
      if (!this.cache.has(ref.vol)) this.cache.set(ref.vol, new Map());
      this.worker.postMessage({ type: 'volume', gen: this.gen, raw: ref.raw.slice(), shape: ref.shape.slice() });
    }
    this.onChange();
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
    else if (!on && this.set.has(v)) { const e = this.set.get(v); if (e.mesh) this.group.remove(e.mesh), e.mesh.material.dispose(); this.set.delete(v); }
    else return;
    this._changed();
  }
  // all regions in the set solid (on) or glass
  setAllFocus(on) {
    for (const [w, x] of this.set) { x.focus = on; this._style(w); }
    this._changed();
  }
  get visible() { return this.group.visible; }
  setVisible(on) { this.group.visible = !!on; this._changed(); }
  // empty the set
  clear(notify = true) {
    for (const e of this.set.values()) if (e.mesh) { this.group.remove(e.mesh); e.mesh.material.dispose(); }
    this.set.clear();
    if (notify) this._changed();
  }
  // region colors changed (lookup table edits)
  refreshColors() {
    for (const [v, e] of this.set) if (e.mesh) e.mesh.material.uniforms.u_color.value.set(...hexToRaw(this.colorOf(v) || '#ffffff'));
    this.render();
  }

  _changed() { this.onChange(); this.render(); }

  _add(v, focus) {
    this.set.set(v, { focus, mesh: null });
    const cached = this.cache.get(this.vol);
    if (cached && cached.has(v)) { this._mesh(v, cached.get(v)); return; }
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

  // voxel index coordinates → world mm (the label volume's affine);
  // normals (from the field's gradient) with the inverse transpose
  _geometry(pos, nrm, idx) {
    const THREE = this.THREE, A = this.ref.invAb;
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

  _mesh(v, geo) {
    const e = this.set.get(v);
    if (!e || !geo || e.mesh) return;
    const THREE = this.THREE;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: { ...this.uniforms, u_color: { value: new THREE.Vector3(...hexToRaw(this.colorOf(v) || '#ffffff')) }, u_glass: { value: 0 } },
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.region = v;
    m.onBeforeRender = (renderer, scene, cam) => this._sync(cam);
    e.mesh = m;
    this.group.add(m);
    this._style(v);
  }

  // solid: opaque, depth written, both sides; glass: blended, front faces,
  // drawn before the glass brain (renderOrder 999) so its shell blends over
  _style(v) {
    const e = this.set.get(v), m = e && e.mesh;
    if (!m) return;
    const glass = !e.focus, mat = m.material;
    mat.uniforms.u_glass.value = glass ? 1 : 0;
    mat.transparent = glass; mat.depthWrite = !glass;
    mat.side = glass ? this.THREE.FrontSide : this.THREE.DoubleSide;
    mat.needsUpdate = true;
    m.renderOrder = glass ? 998 : 0;
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
    u.u_falloff.value = L.falloff; u.u_ambient.value = L.ambient;
    u.u_depthTarget.value.copy(L.target); u.u_depthRadius.value = L.radius || 1;
    u.u_rimPow.value = L.rimPow; u.u_alphaMult.value = L.alphaMult;
  }
}
