// ── Volume surfaces: a scalar volume's level surface as a mesh ──────────
// A loaded volume other than the one the raymarcher shows (a vessel or
// probability map, a lesion, a cluster) drawn as a solid triangle surface
// at a level of its own values, together with the raymarched brain. The
// map's own gradual edges place the surface between voxels, so thin
// structures keep their shape as long as their values reach the level.
// setVoxels(true): instead the voxels at or above the level, as cubes.
//
// Meshes are built in the region-mesh worker (its 'field' / 'surface'
// requests). Moving the level re-meshes: one request at a time, the latest
// level wins. Shading and light are those of the region meshes (solid).
//
// Per volume: setField(key, { data, shape, invAb }) once, then
// show(key, { level, color, glass }), setLevel, setColor, setGlass, hide,
// drop. Glass: the region meshes' glass (rim and opacity of GLASS MODE).

import { VS, FS, hexToRaw, voxelGeometry } from './region-meshes.js';
import { makeClipUniforms } from './scene3d.js';

export class VolumeSurfaces {
  // THREE; scene; render(): redraw; onChange(key): a mesh was (re)built or
  // failed (menus: triangle count); uniforms: the region meshes' light
  // uniforms; syncLight(camera): updates them
  constructor({ THREE, scene, render, onChange, uniforms, syncLight }) {
    this.THREE = THREE; this.render = render; this.onChange = onChange || (() => {});
    this.uniforms = uniforms; this.syncLight = syncLight;
    this.group = new THREE.Group();
    this.group.name = 'volume surfaces';
    scene.add(this.group);
    this.items = new Map();   // key → { id, invAb, level, color, shown, hidden, mesh, tris, busy, want, seq, error }
    this.nextId = 1;
    this.voxels = false;      // setVoxels(): the voxels at or above the level as cubes
    this.clipUniforms = makeClipUniforms();   // (CLIPPING: index.html updates their values)
    try {
      this.worker = new Worker(new URL('./region-mesh-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this._done(e.data);
      this.worker.onerror = e => console.warn('volume surfaces: worker failed', e.message);
    } catch (e) { console.warn('volume surfaces: no worker', e); this.worker = null; }
  }

  has(key) { return this.items.has(key); }
  info(key) { return this.items.get(key) || null; }

  setField(key, { data, shape, invAb }) {
    let it = this.items.get(key);
    if (!it) { it = { id: this.nextId++, level: 0, color: '#ff3030', shown: false, hidden: false, mesh: null, tris: 0, busy: false, want: null, seq: 0, error: null }; this.items.set(key, it); }
    it.invAb = invAb;
    const f = data instanceof Float32Array ? data.slice() : Float32Array.from(data);
    if (this.worker) this.worker.postMessage({ type: 'field', id: it.id, data: f, shape: shape.slice(0, 3) }, [f.buffer]);
  }

  show(key, { level, color, glass }) {
    const it = this.items.get(key);
    if (!it) return;
    it.shown = true; it.color = color || it.color;
    if (glass !== undefined) it.glass = !!glass;
    this.setLevel(key, level);
  }
  hide(key) {
    const it = this.items.get(key);
    if (!it) return;
    it.shown = false; this._drop(it); it.want = null;
    this.render();
  }
  // temporarily not drawn (the volume became the raymarched one), kept
  setHidden(key, hidden) {
    const it = this.items.get(key);
    if (!it || it.hidden === !!hidden) return;
    it.hidden = !!hidden;
    if (it.mesh) it.mesh.visible = !it.hidden;
    this.render();
  }
  setColor(key, color) {
    const it = this.items.get(key);
    if (!it) return;
    it.color = color;
    if (it.mesh) it.mesh.material.uniforms.u_color.value.set(...hexToRaw(color));
    this.render();
  }
  // solid (false) or glass (true)
  setGlass(key, glass) {
    const it = this.items.get(key);
    if (!it) return;
    it.glass = !!glass;
    if (it.mesh) this._style(it);
    this.render();
  }
  setLevel(key, level) {
    const it = this.items.get(key);
    if (!it || !it.shown) return;
    it.level = level;
    if (it.mesh && it.builtLevel === level) return;
    it.want = level;
    this._next(it);
  }
  // smooth level surfaces (false) or the voxels at or above the level (true): rebuilds the shown ones
  setVoxels(on) {
    if (this.voxels === !!on) return;
    this.voxels = !!on;
    for (const it of this.items.values()) if (it.shown) { it.builtLevel = undefined; it.want = it.level; this._next(it); }
  }
  // forget the volume (removed from the list)
  drop(key) {
    const it = this.items.get(key);
    if (!it) return;
    this._drop(it);
    if (this.worker) this.worker.postMessage({ type: 'unfield', id: it.id });
    this.items.delete(key);
    this.render();
  }

  _next(it) {
    if (it.busy || it.want === null || !this.worker) return;
    it.busy = true; it.seq++;
    const level = it.want; it.want = null;
    this.worker.postMessage({ type: 'surface', id: it.id, seq: it.seq, level, voxels: this.voxels });
  }

  _done(msg) {
    let key = null, it = null;
    for (const [k, x] of this.items) if (x.id === msg.id) { key = k; it = x; break; }
    if (!it) return;
    it.busy = false;
    if (it.shown && it.want === null) {         // the latest level: use it
      this._drop(it);
      it.error = msg.error || null;
      if (msg.error) console.warn('volume surface:', msg.error);
      else if (msg.empty) { it.tris = 0; it.builtLevel = msg.level; }
      else {
        const geo = voxelGeometry(this.THREE, it.invAb, msg.positions, msg.normals, msg.indices);
        it.tris = msg.indices.length / 3; it.builtLevel = msg.level;
        this._mesh(it, geo);
      }
      this.onChange(key);
      this.render();
    }
    this._next(it);
  }

  _mesh(it, geo) {
    const THREE = this.THREE;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, side: THREE.DoubleSide,
      uniforms: { ...this.uniforms, ...this.clipUniforms, u_color: { value: new THREE.Vector3(...hexToRaw(it.color)) }, u_glass: { value: 0 } },
    });
    const m = new THREE.Mesh(geo, mat);
    m.onBeforeRender = (renderer, scene, cam) => this.syncLight(cam);
    m.visible = !it.hidden;
    it.mesh = m;
    this._style(it);
    this.group.add(m);
  }

  // as the region meshes: solid opaque, both sides; glass blended, front
  // faces, drawn before the glass brain (renderOrder 999)
  _style(it) {
    const m = it.mesh, mat = m.material, glass = !!it.glass;
    mat.uniforms.u_glass.value = glass ? 1 : 0;
    mat.transparent = glass; mat.depthWrite = !glass;
    mat.side = glass ? this.THREE.FrontSide : this.THREE.DoubleSide;
    mat.needsUpdate = true;
    m.renderOrder = glass ? 998 : 0;
  }

  _drop(it) {
    if (!it.mesh) return;
    this.group.remove(it.mesh);
    it.mesh.geometry.dispose(); it.mesh.material.dispose();
    it.mesh = null; it.tris = 0;
  }
}
