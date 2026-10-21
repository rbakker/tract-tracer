// ── Region outlines in the 2D sections ───────────────────────────────────
// With a label volume in memory (index.html's "label volume in memory"),
// each set of sections (probe, cursor) outlines one region, in all three
// of its sections where that region is cut:
//   · while the mouse is over one of the set's sections: the region under
//     the mouse (nothing over background), named in a small tag next to it;
//   · otherwise: the region at the set's data cursor — the one its badge
//     names. A click or tap moves the data cursor, so the clicked region
//     stays outlined.
// A set shows its outlines only once all three of its sections are traced;
// the two sets are independent.
//
// Per section (6: probe and cursor × sag/cor/axi) the label volume is cut
// along the section plane at its own voxel size — what that section would
// show if the label volume were the one displayed (nearest voxel) — on the
// CPU, from the renderer's own canvas ↔ world mapping (so rotated sections
// work), and vectorized by label2svg in a Web Worker: one path per region,
// smooth, pixel-exact. This starts once a section plane has rested ~150 ms
// (a new depth, a rotation, another label volume); panning and zooming only
// move the outline, and a section whose plane stays (the clicked one) keeps
// its tracing.
//
// Coordinates: the cut is a pixel grid on the plane, anchored at the label
// volume's first voxel centre (projected onto the plane), so for unrotated
// sections its pixels are exactly the volume's voxels. An SVG overlay on
// each section canvas maps grid pixels → canvas pixels with one affine
// transform (vr.rasToCanvas is affine).

const DEBOUNCE_MS = 150;
const MAX_SIDE = 2048;   // grid size cap (pixels per side)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// invAb as used by mat3mulVec: [row0, row1, row2, translation]
const affine = (M, p) => [0, 1, 2].map(r => M[r][0] * p[0] + M[r][1] * p[1] + M[r][2] * p[2] + (M.length === 4 ? M[3][r] : 0));
const lin = (M, p) => [0, 1, 2].map(r => M[r][0] * p[0] + M[r][1] * p[1] + M[r][2] * p[2]);
function invert3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

// The region a raw value stands for: the value itself, or for an ROI set
// (ref.bits: one bit per ROI) the first ROI whose bit is set (0: none).
function regionOf(ref, v) {
  if (!ref.bits || !v) return v;
  for (let m = v >>> 0, i = 1; m; m >>>= 1, i++) if (m & 1) return i;
  return 0;
}

export class SectionOutlines {
  // vr: the VolRenderer (canvasToRas / rasToCanvas per section)
  // getRef(): the label volume in memory { vol, raw, shape, invAb } or null
  // colorOf(v): '#rrggbb' of region v
  // nameOf(v): the name of region v
  // getCursor(tag): the data cursor (world mm) of set 'src' / 'tgt'
  // canvases: { src: { sag, cor, axi }, tgt: { … } } section canvases
  // getFilled(): Map(label → fill opacity) — regions filled in every
  // section (the regions shown in 3D), or null
  constructor({ vr, getRef, colorOf, nameOf, getCursor, getFilled, canvases }) {
    this.vr = vr; this.getRef = getRef; this.colorOf = colorOf;
    this.getFilled = getFilled || (() => null);
    this.nameOf = nameOf || (v => 'label ' + v); this.getCursor = getCursor || (() => null);
    this.panels = new Map();
    this.hover = { src: null, tgt: null };   // per set: { P, point, client } while the mouse is over a section
    this.tag = document.createElement('div');  // the hover name tag
    this.tag.className = 'section-outline-name';
    this.tag.style.cssText = 'position:fixed;z-index:61;pointer-events:none;display:none;white-space:nowrap;'
      + 'color:#fff;font:600 11px/1.2 system-ui,sans-serif;'
      + 'text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 0 3px #000;';
    document.body.appendChild(this.tag);
    this.queue = new Map();      // panel id → job (newest only)
    this.busy = false;
    this.refSeen = null; this.refGen = 0;
    try {
      this.worker = new Worker(new URL('./label2svg/worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this._done(e.data);
      this.worker.onerror = e => { console.warn('section outlines: worker failed', e.message); this.busy = false; };
    } catch (e) { console.warn('section outlines: no worker', e); this.worker = null; }
    for (const tag of ['src', 'tgt']) for (const pk of ['sag', 'cor', 'axi']) {
      const c = canvases[tag] && canvases[tag][pk];
      if (c) this._attach(tag, pk, c);
    }
  }

  _attach(tag, pk, canvas) {
    const id = tag + ':' + pk;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'section-outline');
    svg.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;display:none;';
    const g = document.createElementNS(NS, 'g');
    const fill = document.createElementNS(NS, 'g');   // filled regions, under the outline
    const under = document.createElementNS(NS, 'path'), over = document.createElementNS(NS, 'path');
    for (const p of [under, over]) { p.setAttribute('fill', 'none'); p.setAttribute('vector-effect', 'non-scaling-stroke'); p.setAttribute('stroke-linejoin', 'round'); }
    under.setAttribute('stroke', 'rgba(0,0,0,0.75)'); under.setAttribute('stroke-width', '3.5');
    over.setAttribute('stroke-width', '1.6');
    g.append(fill, under, over); svg.appendChild(g);
    canvas.insertAdjacentElement('afterend', svg);
    const P = { id, tag, pk, canvas, svg, g, fill, under, over, key: null, geo: null, paths: null, label: 0, fillKey: '', timer: null };
    this.panels.set(id, P);
    // hover (mouse, pen): the region under the pointer. Touch has no hover:
    // a tap moves the data cursor, whose region is outlined anyway.
    const hoverAt = e => {
      if (e.pointerType === 'touch') return;
      this.hover[tag] = { P, point: this._px(P, e), client: [e.clientX, e.clientY] };
      this._showSide(tag);
    };
    canvas.addEventListener('pointermove', hoverAt);
    canvas.addEventListener('pointerdown', hoverAt);
    canvas.addEventListener('pointerleave', e => {
      if (e.pointerType === 'touch' || !this.hover[tag] || this.hover[tag].P !== P) return;
      this.hover[tag] = null; this._showSide(tag);
    });
  }

  _px(P, e) {
    const r = P.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (P.canvas.width / r.width), (e.clientY - r.top) * (P.canvas.height / r.height)];
  }

  // After each redraw of a section (index.html drawSlice).
  update(pk, tag) {
    const P = this.panels.get(tag + ':' + pk);
    if (!P) return;
    const ref = this.getRef();
    if (ref !== this.refSeen) { this.refSeen = ref; this.refGen++; }
    const geo = ref ? this._geometry(P, ref) : null;
    const key = geo ? geo.key : null;
    if (key !== P.key) {
      P.key = key; P.geo = geo; P.paths = null;
      clearTimeout(P.timer);
      if (geo && this.worker) P.timer = setTimeout(() => this._schedule(P), DEBOUNCE_MS);
    } else if (geo) P.geo = { ...P.geo, toCanvas: geo.toCanvas };  // pan/zoom: new placement only
    this._place(P);
    this._showSide(tag);   // the data cursor may have moved
  }

  // The section plane and its pixel grid in the label volume.
  _geometry(P, ref) {
    const vr = this.vr, { tag, pk } = P;
    const p00 = vr.canvasToRas(pk, 0, 0, tag), p10 = vr.canvasToRas(pk, 1, 0, tag), p01 = vr.canvasToRas(pk, 0, 1, tag);
    if (!p00 || !p10 || !p01) return null;
    const u = nrm(sub(p10, p00)), v = nrm(sub(p00, p01)); // canvas right, canvas up
    const n = cross(u, v);
    const A = ref.invAb, Ab = invert3(A.slice(0, 3));
    const t = A.length === 4 ? A[3] : [0, 0, 0];
    const toWorld = q => lin(Ab, sub(q, t));             // voxel index → world
    const x0 = toWorld([0, 0, 0]);
    const anchor = sub(x0, scl(n, dot(sub(x0, p00), n))); // first voxel centre, on the plane
    const su = 1 / Math.hypot(...lin(A, u)), sv = 1 / Math.hypot(...lin(A, v));
    const [nx, ny, nz] = ref.shape;
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const i of [-0.5, nx - 0.5]) for (const j of [-0.5, ny - 0.5]) for (const k of [-0.5, nz - 0.5]) {
      const r = sub(toWorld([i, j, k]), anchor);
      const cu = dot(r, u) / su, cv = dot(r, v) / sv;
      umin = Math.min(umin, cu); umax = Math.max(umax, cu); vmin = Math.min(vmin, cv); vmax = Math.max(vmax, cv);
    }
    const i0 = Math.floor(umin), jTop = Math.ceil(vmax);
    const W = Math.min(MAX_SIDE, Math.ceil(umax) - i0 + 1), H = Math.min(MAX_SIDE, jTop - Math.floor(vmin) + 1);
    if (!(W > 0 && H > 0)) return null;
    // grid coordinate (gx, gy) — pixel (i, j) covers [i, i+1] × [j, j+1] — → world
    const gridToWorld = (gx, gy) => add(anchor, add(scl(u, (i0 + gx - 0.5) * su), scl(v, (jTop - gy + 0.5) * sv)));
    const c0 = vr.rasToCanvas(pk, ...gridToWorld(0, 0), tag), c1 = vr.rasToCanvas(pk, ...gridToWorld(1, 0), tag), c2 = vr.rasToCanvas(pk, ...gridToWorld(0, 1), tag);
    const toCanvas = [c1[0] - c0[0], c1[1] - c0[1], c2[0] - c0[0], c2[1] - c0[1], c0[0], c0[1]];
    const r4 = x => Math.round(x * 1e4) / 1e4;
    const key = [this.refGen, ...u.map(r4), ...v.map(r4), r4(dot(n, p00))].join(',');
    return { key, u, v, n, anchor, su, sv, i0, jTop, W, H, gridToWorld, toCanvas };
  }

  // The region at a canvas point, on the same grid as the outlines (nearest voxel).
  _labelAt(P, cx, cy) {
    const ref = this.getRef(), geo = P.geo;
    if (!ref || !geo) return 0;
    const w = this.vr.canvasToRas(P.pk, cx, cy, P.tag);
    if (!w) return 0;
    const r = sub(w, geo.anchor);
    const gx = Math.round(dot(r, geo.u) / geo.su) - geo.i0, gy = geo.jTop - Math.round(dot(r, geo.v) / geo.sv);
    if (gx < 0 || gy < 0 || gx >= geo.W || gy >= geo.H) return 0;
    const [x, y, z] = affine(ref.invAb, geo.gridToWorld(gx + 0.5, gy + 0.5)).map(Math.round);
    const [nx, ny, nz] = ref.shape;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0;
    return regionOf(ref, ref.raw[x + nx * (y + ny * z)]);
  }

  _schedule(P) {
    const ref = this.getRef(), geo = P.geo;
    if (!ref || !geo || geo.key !== P.key) return;
    // cut the label volume along the plane, nearest voxel
    const { W, H } = geo, out = new Int32Array(W * H), [nx, ny, nz] = ref.shape, raw = ref.raw;
    const A = ref.invAb;
    const base = affine(A, geo.gridToWorld(0.5, 0.5));
    const du = lin(A, scl(geo.u, geo.su)), dv = lin(A, scl(geo.v, -geo.sv));
    for (let j = 0; j < H; j++) {
      let x = base[0] + j * dv[0], y = base[1] + j * dv[1], z = base[2] + j * dv[2];
      for (let i = 0; i < W; i++, x += du[0], y += du[1], z += du[2]) {
        const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
        if (xi >= 0 && yi >= 0 && zi >= 0 && xi < nx && yi < ny && zi < nz) out[j * W + i] = raw[xi + nx * (yi + ny * zi)];
      }
    }
    // an ROI set (bits): each ROI traced on its own (they may overlap) —
    // one 0/1 image per ROI the section cuts, labelled with its region number
    let parts;
    if (ref.bits) {
      let any = 0;
      for (let c = 0; c < out.length; c++) any |= out[c];
      parts = [];
      for (let b = 0; b < 32; b++) {
        const bit = 1 << b;
        if (!(any & bit)) continue;
        const img = new Int32Array(out.length);
        for (let c = 0; c < out.length; c++) if (out[c] & bit) img[c] = b + 1;
        parts.push(img);
      }
    } else parts = [out];
    this.queue.delete(P.id);
    this.queue.set(P.id, { id: P.id, key: P.key, parts, W, H, paths: [] });
    this._next();
  }

  _next() {
    if (this.busy || !this.queue.size) return;
    const [pid, job] = [...this.queue.entries()].pop();   // the newest first
    this.queue.delete(pid);
    this.busy = job;
    this._post(job);
  }
  _post(job) {
    if (!job.parts.length) { this._done({ paths: [] }); return; }
    const labels = job.parts.shift();
    this.worker.postMessage({ id: 1, labels, width: job.W, height: job.H, pathsOnly: true,
      options: { background: 0, seamStroke: 0 } }, [labels.buffer]);
  }

  _done(msg) {
    const job = this.busy;
    if (job && msg.paths && job.parts.length) { job.paths.push(...msg.paths); this._post(job); return; }   // (an ROI set: the next ROI)
    this.busy = false;
    if (job && msg.paths) {
      job.paths.push(...msg.paths);
      const P = this.panels.get(job.id);
      if (P && P.key === job.key) {
        P.paths = new Map(job.paths.map(p => [p.label, p.d]));
        this._showSide(P.tag);
      }
    } else if (msg.error) console.warn('section outlines:', msg.error);
    this._next();
  }

  // The overlay over the canvas, and the grid → canvas transform.
  _place(P) {
    const c = P.canvas, s = P.svg;
    s.style.left = c.offsetLeft + 'px'; s.style.top = c.offsetTop + 'px';
    s.style.width = c.offsetWidth + 'px'; s.style.height = c.offsetHeight + 'px';
    s.setAttribute('viewBox', '0 0 ' + c.width + ' ' + c.height);
    if (P.geo) P.g.setAttribute('transform', 'matrix(' + P.geo.toCanvas.join(' ') + ')');
  }

  // The region at a set's data cursor (nearest voxel, as its badge).
  _cursorLabel(tag) {
    const ref = this.getRef(), p = this.getCursor(tag);
    if (!ref || !p) return 0;
    const [x, y, z] = affine(ref.invAb, p).map(Math.round), [nx, ny, nz] = ref.shape;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0;
    return regionOf(ref, ref.raw[x + nx * (y + ny * z)]);
  }

  // Outlines one region in all three sections of a set — the hovered one,
  // else the data cursor's — once all three are traced.
  _showSide(tag) {
    const panels = [...this.panels.values()].filter(P => P.tag === tag);
    const h = this.hover[tag];
    const label = h ? (h.P.geo ? this._labelAt(h.P, h.point[0], h.point[1]) : 0) : this._cursorLabel(tag);
    const ready = panels.every(P => P.geo && P.paths);
    const filled = this.getFilled();
    let shown = false;
    for (const P of panels) {
      const d = ready && label ? P.paths.get(label) : null;
      // the filled regions (each section: those it cuts)
      const fills = ready && filled ? [...filled].filter(([v]) => P.paths.has(v)) : [];
      const fk = fills.map(([v, a]) => v + ':' + a + ':' + this.colorOf(v)).join(',') + '|' + P.key;
      if (fk !== P.fillKey) {
        P.fillKey = fk;
        P.fill.replaceChildren(...fills.map(([v, a]) => {
          const f = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          f.setAttribute('d', P.paths.get(v)); f.setAttribute('fill', this.colorOf(v) || '#fff');
          f.setAttribute('fill-opacity', String(a)); f.setAttribute('stroke', 'none');
          return f;
        }));
      }
      if (!d && !fills.length) { P.svg.style.display = 'none'; P.label = 0; continue; }
      if (!d) { P.under.setAttribute('d', ''); P.over.setAttribute('d', ''); P.label = 0; }
      else if (label !== P.label) {
        P.under.setAttribute('d', d); P.over.setAttribute('d', d);
        P.over.setAttribute('stroke', this.colorOf(label) || '#fff');
        P.label = label;
      }
      this._place(P);
      P.svg.style.display = '';
      if (d && h && P === h.P) shown = true;
    }
    // the name next to the mouse, while the hovered region is outlined
    if (shown) {
      this.tag.textContent = this.nameOf(label);
      this.tag.style.left = (h.client[0] + 14) + 'px';
      this.tag.style.top = (h.client[1] + 14) + 'px';
      this.tag.style.display = '';
      this.tagSide = tag;
    } else if (this.tagSide === tag || !this.tagSide) { this.tag.style.display = 'none'; this.tagSide = null; }
  }

  // For a screenshot: what this section shows of the regions now (the
  // filled regions and the outlined one) as a standalone SVG, w × h pixels
  // over the canvas's own pixel grid (cw × ch); line widths × k. null:
  // nothing shown.
  snapshotSvg(tag, pk, w, h, k = 1) {
    const P = this.panels.get(tag + ':' + pk);
    if (!P || P.svg.style.display === 'none' || !P.geo) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.setAttribute('viewBox', '0 0 ' + P.canvas.width + ' ' + P.canvas.height);
    const g = P.g.cloneNode(true);
    g.setAttribute('transform', 'matrix(' + P.geo.toCanvas.join(' ') + ')');
    // (non-scaling strokes are in output pixels here: scale them as the image)
    for (const el of g.querySelectorAll('[stroke-width]')) el.setAttribute('stroke-width', String(+el.getAttribute('stroke-width') * k));
    svg.appendChild(g);
    return new XMLSerializer().serializeToString(svg);
  }

  // For an SVG screenshot: the regions as layers (groups) in the canvas's
  // own pixel grid (cw × ch), strokes in output pixels (pxOut = output
  // pixels per canvas pixel), as real widths — no non-scaling strokes, so
  // drawing programs show them as on screen:
  //   shown:    what the section shows now (fills of the regions in 3D, the
  //             outlined region), or '' — visible
  //   outlines: every region the section cuts, outlined in its color
  //   fills:    every region the section cuts, filled, opaque
  // Each region a path with its name (<title>, id). null: not traced.
  exportLayers(tag, pk, pxOut = 1) {
    const P = this.panels.get(tag + ':' + pk);
    if (!P || !P.geo || !P.paths) return null;
    const m = P.geo.toCanvas, sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const w = px => +(px / pxOut / sc).toPrecision(4);           // a width in output px → group units
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const idOf = v => 'r' + v + '-' + String(this.nameOf(v)).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
    const tf = ' transform="matrix(' + m.join(' ') + ')"';
    const region = (v, attrs, suffix) => '<path id="' + idOf(v) + suffix + '" d="' + P.paths.get(v) + '" ' + attrs + '><title>' + esc(this.nameOf(v)) + '</title></path>';
    const labels = [...P.paths.keys()].filter(v => v).sort((a, b) => a - b);
    const outlines = labels.map(v => region(v, 'fill="none" stroke="' + (this.colorOf(v) || '#fff') + '" stroke-width="' + w(1.2) + '" stroke-linejoin="round"', '-outline')).join('');
    const fills = labels.map(v => region(v, 'fill="' + (this.colorOf(v) || '#fff') + '" stroke="none"', '-fill')).join('');
    let shown = '';
    if (P.svg.style.display !== 'none') {
      const filled = [...P.fill.children].map(f => '<path d="' + f.getAttribute('d') + '" fill="' + f.getAttribute('fill') + '" fill-opacity="' + f.getAttribute('fill-opacity') + '"/>').join('');
      const d = P.over.getAttribute('d');
      const line = d ? '<path d="' + d + '" fill="none" stroke="#000000" stroke-opacity="0.75" stroke-width="' + w(3.5) + '" stroke-linejoin="round"/>'
        + '<path d="' + d + '" fill="none" stroke="' + P.over.getAttribute('stroke') + '" stroke-width="' + w(1.6) + '" stroke-linejoin="round"><title>' + esc(this.nameOf(P.label)) + '</title></path>' : '';
      if (filled || line) shown = '<g' + tf + '>' + filled + line + '</g>';
    }
    return { shown, outlines: '<g' + tf + '>' + outlines + '</g>', fills: '<g' + tf + '>' + fills + '</g>', count: labels.length };
  }

  // The label volume in memory changed (another one, or its colors / names).
  refresh() {
    for (const P of this.panels.values()) { P.label = 0; P.fillKey = ''; }
    this._showSide('src'); this._showSide('tgt');
  }
}
