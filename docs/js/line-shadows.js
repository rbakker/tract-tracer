// ── Streamline shadows ───────────────────────────────────────────────────
// Light that streamlines take away from each other, like light through
// hair (opacity shadow maps): a global density volume of the drawn
// streamlines, and from it a light volume — per voxel, the light left
// after the way to the light source — that the line shader reads once
// per pixel (u_shadowTex in scene3d.js's LINE_FS).
//
//   density: every drawn streamline counts once per voxel it passes
//            through (as for the translucency, computeRibbonDensity),
//            dimmed context lines with their opacity; blurred a little,
//            then compressed (cube root: a few lines shade their close
//            neighbours visibly, a dense core doesn't swallow everything)
//            and divided by the 95th percentile of the occupied voxels,
//            so adding streamlines changes the pattern of the shadows, not
//            their overall depth. Rebuilt when the drawn set changes.
//   light:   rendered on the GPU (a 3D render target, one layer at a
//            time): from each voxel a march towards the light through the
//            density, T = exp(-k · Σ density). The density's resolution
//            (or coarser: lightDiv). Re-rendered when the light direction
//            (it moves with the camera) or k changes.
// The voxel size is the caller's: the translucency's density voxel, 1/100
// of the tractogram's diameter.
import * as THREE from 'three';

const MAX_CELLS = 4e6;   // density grid cap (the voxel grows beyond it)
const MAX_STEPS = 400;   // march length cap, in density voxels
// An occluder voxel's density (setOccluder), in normalized streamline-density
// units (1 = the 95th percentile of the streamlines): the solid brain blocks
// the light within a few voxels at the default shadowing.
const OCCLUDER_DENSITY = 6;

const LIGHT_VS = `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const LIGHT_FS = `
precision highp float;
precision highp sampler3D;
uniform sampler3D u_dens;
uniform vec3  u_densSize;   // density grid, voxels
uniform vec3  u_lightSize;  // light volume, voxels
uniform float u_layer;
uniform vec3  u_dir;        // towards the light, in density voxels (unit length) — parallel light
uniform float u_point;      // 1: a point light at u_lightPos (density voxels) instead
uniform vec3  u_lightPos;
uniform float u_k;
out vec4 outColor;
void main() {
  vec3 p = vec3(gl_FragCoord.xy, u_layer + 0.5) / u_lightSize * u_densSize;
  vec3 dir = u_dir;
  float left = 1e9;                    // voxels to go before reaching the light
  if (u_point > 0.5) { vec3 d = u_lightPos - p; left = length(d); dir = d / max(left, 1e-6); }
  // start half a voxel towards the light: a line hardly shades its own spot
  p += 0.5 * dir; left -= 0.5;
  float tau = 0.0;
  for (int i = 0; i < ${MAX_STEPS}; i++) {
    if (left <= 0.0 || any(lessThan(p, vec3(0.0))) || any(greaterThan(p, u_densSize))) break;
    tau += texture(u_dens, p / u_densSize).r;
    p += dir; left -= 1.0;
  }
  outColor = vec4(exp(-u_k * tau), 0.0, 0.0, 1.0);
}`;

export class LineShadows {
  constructor(renderer) {
    this.renderer = renderer;
    this.densTex = null;
    this.rt = null;
    this.box = null;            // { min: Vector3, size: Vector3 } in world mm
    this.dims = null;           // density grid [nx, ny, nz]
    this.k = 0;                 // darkening per density unit (0: off)
    // tuning (console: setShadowParams)
    this.gamma = 1 / 3;         // density compression (1 = linear)
    this.blurPasses = 1;        // 3x3x3 blurs of the density
    this.lightDiv = 1;          // light volume: this much coarser than the density
    this._lastDir = new THREE.Vector3();
    this._lastPos = new THREE.Vector3(Infinity, 0, 0);
    this._dirty = true;
    this._dummy = new THREE.Data3DTexture(new Uint8Array([255]), 1, 1, 1);
    this._dummy.format = THREE.RedFormat; this._dummy.needsUpdate = true;
    // shared with the line materials (scene3d.js sharedLineUniforms)
    this.uniforms = {
      u_shadowTex:  { value: this._dummy },
      u_shadowOn:   { value: 0 },
      u_shadowMin:  { value: new THREE.Vector3() },
      u_shadowSize: { value: new THREE.Vector3(1, 1, 1) },
    };
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: LIGHT_VS, fragmentShader: LIGHT_FS,
      uniforms: {
        u_dens: { value: null }, u_densSize: { value: new THREE.Vector3() },
        u_lightSize: { value: new THREE.Vector3() }, u_layer: { value: 0 },
        u_dir: { value: new THREE.Vector3() }, u_k: { value: 0 },
        u_point: { value: 0 }, u_lightPos: { value: new THREE.Vector3() },
      },
      depthTest: false, depthWrite: false,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g, this.mat);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene(); this.qScene.add(this.quad);
    this.qCam = new THREE.Camera();
  }

  get active() { return this.k > 0 && !!this.densTex; }

  setStrength(k) {
    if (k === this.k) return;
    this.k = k; this._dirty = true;
    this.uniforms.u_shadowOn.value = this.active ? 1 : 0;
  }

  clear() {
    if (this.densTex) this.densTex.dispose();
    if (this.rt) this.rt.dispose();
    this.densTex = null; this.rt = null; this.box = null; this.lineDens = null; this.occ = null; this.dims = null;
    this.uniforms.u_shadowTex.value = this._dummy;
    this.uniforms.u_shadowOn.value = 0;
  }

  // The density of a ribbon mesh's segments (scene3d.js makeRibbonLines:
  // instanceStart/End in world mm, instanceTract, instanceHighlight).
  // isFaint(i): whether segment i is drawn translucent (dimmed) — those
  // neither cast shadows nor receive them (LINE_FS's FAINT_PASS); null: none.
  // extraBox: { min: [x,y,z], max: [x,y,z] } (world) the grid must cover
  // too — the solid brain's, so it can cast and receive shadows.
  build(mesh, voxelMm, isFaint = null, extraBox = null) {
    const t0 = performance.now();
    const geo = mesh && mesh.geometry;
    const n = geo ? geo.instanceCount : 0;
    if (!n || !(voxelMm > 0) || !geo.userData.instanceTract) { this.clear(); return; }
    const S = geo.attributes.instanceStart.array, E = geo.attributes.instanceEnd.array;
    const tractOf = geo.userData.instanceTract;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < 3 * n; i += 3) for (const A of [S, E]) {
      const x = A[i], y = A[i + 1], z = A[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (extraBox) {
      x0 = Math.min(x0, extraBox.min[0]); y0 = Math.min(y0, extraBox.min[1]); z0 = Math.min(z0, extraBox.min[2]);
      x1 = Math.max(x1, extraBox.max[0]); y1 = Math.max(y1, extraBox.max[1]); z1 = Math.max(z1, extraBox.max[2]);
    }
    let vox = voxelMm, nx, ny, nz;
    for (;;) { // 3-voxel margin (blur, and the light enters through empty space)
      nx = Math.ceil((x1 - x0) / vox) + 6; ny = Math.ceil((y1 - y0) / vox) + 6; nz = Math.ceil((z1 - z0) / vox) + 6;
      if (nx * ny * nz <= MAX_CELLS) break;
      vox *= 1.25;
    }
    const ox = x0 - 3 * vox, oy = y0 - 3 * vox, oz = z0 - 3 * vox, inv = 1 / vox;
    const cells = nx * ny * nz;
    const dens = new Float32Array(cells), last = new Int32Array(cells).fill(-1);
    for (let i = 0; i < n; i++) {
      if (isFaint && isFaint(i)) continue;
      const w = 1;
      const t = tractOf[i];
      const ax = S[3*i], ay = S[3*i+1], az = S[3*i+2];
      const dx = E[3*i] - ax, dy = E[3*i+1] - ay, dz = E[3*i+2] - az;
      const steps = Math.max(1, Math.ceil(Math.sqrt(dx*dx + dy*dy + dz*dz) * inv * 2));
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const c = (Math.floor((az + u*dz - oz) * inv) * ny + Math.floor((ay + u*dy - oy) * inv)) * nx + Math.floor((ax + u*dx - ox) * inv);
        if (last[c] !== t) { last[c] = t; dens[c] += w; }
      }
    }
    // separable blur, 1/4 1/2 1/4 per axis, twice: soft shadows, no voxel steps
    const tmp = new Float32Array(cells);
    const blur = (src, dst, stride, len, pos) => {
      for (let c = 0; c < cells; c++) {
        const p = pos(c);
        let v = 0.5 * src[c];
        if (p > 0) v += 0.25 * src[c - stride];
        if (p < len - 1) v += 0.25 * src[c + stride];
        dst[c] = v;
      }
    };
    const px = c => c % nx, py = c => Math.floor(c / nx) % ny, pz = c => Math.floor(c / (nx * ny));
    for (let r = 0; r < this.blurPasses; r++) {
      blur(dens, tmp, 1, nx, px); blur(tmp, dens, nx, ny, py); blur(dens, tmp, nx * ny, nz, pz);
      dens.set(tmp);
    }
    // compress, then normalize: the 95th percentile of the occupied voxels becomes 1
    if (this.gamma !== 1) for (let c = 0; c < cells; c++) if (dens[c] > 0) dens[c] = Math.pow(dens[c], this.gamma);
    const occ = [];
    const stride = Math.max(1, Math.floor(cells / 200000)); // a sample is plenty
    for (let c = 0; c < cells; c += stride) if (dens[c] > 1e-3) occ.push(dens[c]);
    occ.sort((a, b) => a - b);
    const p95 = occ.length ? occ[Math.floor(0.95 * (occ.length - 1))] : 1;
    const s = 1 / Math.max(p95, 1e-6);
    for (let c = 0; c < cells; c++) dens[c] *= s;
    this.lineDens = dens;
    this.dims = [nx, ny, nz];
    this.box = { min: new THREE.Vector3(ox, oy, oz), size: new THREE.Vector3(nx * vox, ny * vox, nz * vox) };
    this.vox = vox;
    this._fillOccluder();   // the brain, on this grid
    this._upload();
    const D = this.lightDiv;
    const lw = Math.max(2, Math.ceil(nx / D)), lh = Math.max(2, Math.ceil(ny / D)), ld = Math.max(2, Math.ceil(nz / D));
    if (!this.rt || this.rt.width !== lw || this.rt.height !== lh || this.rt.depth !== ld) {
      if (this.rt) this.rt.dispose();
      this.rt = new THREE.WebGL3DRenderTarget(lw, lh, ld, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      this.rt.texture.wrapS = this.rt.texture.wrapT = this.rt.texture.wrapR = THREE.ClampToEdgeWrapping;
    }
    const u = this.uniforms;
    u.u_shadowTex.value = this.rt.texture;
    u.u_shadowMin.value.copy(this.box.min);
    u.u_shadowSize.value.copy(this.box.size);
    u.u_shadowOn.value = this.active ? 1 : 0;
    this._dirty = true;
    this.buildMs = performance.now() - t0;
  }

  // A solid occluder (the brain in SOLID mode): fn(x, y, z) → 0..1 at a
  // world point (1 = solid), or null for none. Sampled at the grid's voxel
  // centres and added to the streamline density as OCCLUDER_DENSITY —
  // nearly opaque within a few voxels. Kept for later rebuilds of the grid.
  setOccluder(fn) {
    this.occluderFn = fn || null;
    if (!this.lineDens) return;
    this._fillOccluder();
    this._upload();
    this._dirty = true;
  }
  _fillOccluder() {
    const fn = this.occluderFn;
    if (!fn || !this.dims) { this.occ = null; return; }
    const t0 = performance.now();
    const [nx, ny, nz] = this.dims, v = this.vox, m = this.box.min;
    const occ = new Float32Array(nx * ny * nz);
    let any = false;
    for (let k = 0, c = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, c++) {
      const o = fn(m.x + (i + 0.5) * v, m.y + (j + 0.5) * v, m.z + (k + 0.5) * v);
      if (o > 0) { occ[c] = o; any = true; }
    }
    this.occ = any ? occ : null;
    this.occluderMs = performance.now() - t0;
  }
  _upload() {
    const dens = this.lineDens, occ = this.occ, cells = dens.length;
    const half = new Uint16Array(cells);
    for (let c = 0; c < cells; c++) {
      const d = occ ? dens[c] + OCCLUDER_DENSITY * occ[c] : dens[c];
      half[c] = THREE.DataUtils.toHalfFloat(Math.min(d, 60000));
    }
    const [nx, ny, nz] = this.dims;
    if (this.densTex) this.densTex.dispose();
    const tex = new THREE.Data3DTexture(half, nx, ny, nz);
    tex.format = THREE.RedFormat; tex.type = THREE.HalfFloatType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1; tex.needsUpdate = true;
    this.densTex = tex;
  }

  // Before each 3D frame: re-renders the light volume when the light
  // changed — its direction (world, pointing from the scene TO the light)
  // for a parallel light, its position (world) for a point light (lightPos
  // given) — or the strength did. Returns true when it rendered.
  update(lightDirWorld, lightPos = null) {
    if (!this.active || !this.rt) return false;
    const vox = this.box.size.x / this.dims[0];
    if (!this._dirty && (lightPos ? this._lastPos.distanceTo(lightPos) < 0.05 * vox
                                  : this._lastDir.dot(lightDirWorld) > 0.99998)) return false;
    this._lastDir.copy(lightDirWorld);
    if (lightPos) this._lastPos.copy(lightPos); else this._lastPos.set(Infinity, 0, 0);
    this._dirty = false;
    const [nx, ny, nz] = this.dims;
    const u = this.mat.uniforms;
    u.u_dens.value = this.densTex;
    u.u_densSize.value.set(nx, ny, nz);
    u.u_lightSize.value.set(this.rt.width, this.rt.height, this.rt.depth);
    u.u_dir.value.copy(lightDirWorld).normalize(); // isotropic voxels: world direction = grid direction
    u.u_k.value = this.k;
    u.u_point.value = lightPos ? 1 : 0;
    if (lightPos) u.u_lightPos.value.copy(lightPos).sub(this.box.min).divideScalar(vox); // density voxels
    const r = this.renderer;
    const prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    for (let z = 0; z < this.rt.depth; z++) {
      u.u_layer.value = z;
      r.setRenderTarget(this.rt, z);
      r.render(this.qScene, this.qCam);
    }
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
    return true;
  }
}
