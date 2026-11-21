// ── image-overlay.js ──────────────────────────────────────
// An image laid over a view, semi-transparent (a lightbox), with one
// control in the middle of it (of the part shown, with a clip), kept in the
// view: a see-through disc with crossing arrows moves the image; the ring
// around it turns and scales it about that middle (drag it round: turn;
// out or in: larger or smaller). Only the control takes the mouse —
// everywhere else the view below gets it, so the 3D view still turns and
// zooms under the image. setControls(false) hides it (while points are
// being picked on the image).
//
// Its place: { x, y } its centre from the view's centre, { size } its
// width, both in units of the view's height; { angle } in radians
// (clockwise on the screen). A perspective view keeps what it shows in
// step with its height, so the image stays on the brain when the view is
// resized.
//
// Or placed by a perspective map (setWarp): a 3×3 homography from image
// pixels to view pixels (a photo seen by its camera, on a plane of the
// brain) — then the handles are gone; the browser draws the image warped.
// toView / toImage map between the two either way. Hidden (toggle) is a
// quick look at what's under it.
//
// No app state: a tool makes one (parent: the 3D view's element).

export class ImageOverlay {
  /**
   * @param {HTMLElement} parent - the view's element (position: relative)
   * @param {Object} [o]
   * @param {Function} [o.onChange] - (place) after a handle was dragged
   */
  constructor(parent, { onChange = null } = {}) {
    this.parent = parent; this.onChange = onChange;
    this.place = { x: 0, y: 0, size: 0.5, angle: 0 };
    this.opacity = 0.5; this.visible = false; this.hidden = false;
    this.aspect = 1; this.iw = 1; this.ih = 1;   // the image: height / width, its size in px
    this.warp = null;   // a homography (image px → view px), or null: placed by hand
    this.box = [0, 0, 1, 1];   // the part shown (the handles at its corners): u0, v0, u1, v1 in fractions of the image
    const el = this.el = document.createElement('div');
    el.className = 'img-overlay';
    el.style.display = 'none';
    this.img = document.createElement('img');
    this.img.className = 'img-overlay-img';
    this.img.draggable = false;
    this.controls = true;
    // the control: a ring (turn and scale) round a disc (move), drawn in SVG
    const NS = 'http://www.w3.org/2000/svg', R0 = 17, R1 = 34, S = 2 * R1 + 8;
    const ctl = this.ctl = document.createElement('div');
    ctl.className = 'img-overlay-ctl';
    ctl.style.width = ctl.style.height = S + 'px';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', (-S / 2) + ' ' + (-S / 2) + ' ' + S + ' ' + S); svg.setAttribute('width', S); svg.setAttribute('height', S);
    const mk = (tag, a) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
    // the ring: a band between R0 + 3 and R1, two turning arrows on it
    const rm = (R0 + 3 + R1) / 2, rw = R1 - R0 - 3;
    this.hTurn = mk('circle', { r: rm, fill: 'none', stroke: 'rgba(8,11,15,0.35)', 'stroke-width': rw, class: 'io-turn' });
    const arc = (a0, a1) => { const p = a => [rm * Math.cos(a), rm * Math.sin(a)]; const [x0, y0] = p(a0), [x1, y1] = p(a1); return 'M' + x0 + ' ' + y0 + ' A' + rm + ' ' + rm + ' 0 0 1 ' + x1 + ' ' + y1; };
    const arrows = mk('g', { class: 'io-glyph', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    for (const a of [-Math.PI / 2, Math.PI / 2]) {
      arrows.appendChild(mk('path', { d: arc(a - 0.55, a + 0.55) }));
      const t = a + 0.55, ex = rm * Math.cos(t), ey = rm * Math.sin(t), tx = -Math.sin(t), ty = Math.cos(t), nx = Math.cos(t), ny = Math.sin(t);
      arrows.appendChild(mk('path', { d: 'M' + (ex - 5 * tx + 3.5 * nx) + ' ' + (ey - 5 * ty + 3.5 * ny) + ' L' + ex + ' ' + ey + ' L' + (ex - 5 * tx - 3.5 * nx) + ' ' + (ey - 5 * ty - 3.5 * ny) }));
    }
    // the disc: crossing two-way arrows
    this.hMove = mk('circle', { r: R0, fill: 'rgba(8,11,15,0.35)', stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 1, class: 'io-move' });
    const cross = mk('g', { class: 'io-glyph', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const L = R0 - 5, h = 3.5;
    cross.appendChild(mk('path', { d: `M${-L} 0 H${L} M0 ${-L} V${L} M${-L + h} ${-h} L${-L} 0 L${-L + h} ${h} M${L - h} ${-h} L${L} 0 L${L - h} ${h} M${-h} ${-L + h} L0 ${-L} L${h} ${-L + h} M${-h} ${L - h} L0 ${L} L${h} ${L - h}` }));
    svg.append(this.hTurn, arrows, this.hMove, cross);
    ctl.appendChild(svg);
    this.hTurn.appendChild(mk('title', {})).textContent = 'turn the photo (drag round) and scale it (drag out or in), about its middle';
    this.hMove.appendChild(mk('title', {})).textContent = 'move the photo';
    el.append(this.img, ctl);
    parent.appendChild(el);
    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(parent);
    this._drag(this.hMove, 'move');
    this._drag(this.hTurn, 'turn');
  }
  // the control shown (true) or not (false: while points are picked on the image)
  setControls(on) { this.controls = !!on; this.layout(); }

  setImage(url, width, height) { this.img.src = url || ''; this.iw = width || 1; this.ih = height || 1; this.aspect = width && height ? height / width : 1; this.layout(); }
  // placed by a homography H (rows of 3: image px → view px), or by hand again (null)
  setWarp(H) { this.warp = H || null; this.layout(); }
  // image point (fractions of its width and height) → view px, and back
  toView(u, v) {
    if (this.warp) { const H = this.warp, x = u * this.iw, y = v * this.ih, w = H[2][0] * x + H[2][1] * y + H[2][2];
      return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w]; }
    return this.pointAt(u, v);
  }
  toImage(sx, sy) {
    if (this.warp) { const G = invert3(this.warp), w = G[2][0] * sx + G[2][1] * sy + G[2][2];
      return [(G[0][0] * sx + G[0][1] * sy + G[0][2]) / w / this.iw, (G[1][0] * sx + G[1][1] * sy + G[1][2]) / w / this.ih]; }
    const b = this._box(), c = Math.cos(-this.place.angle), s = Math.sin(-this.place.angle), dx = sx - b.cx, dy = sy - b.cy;
    return [(dx * c - dy * s) / b.w + 0.5, (dx * s + dy * c) / b.h + 0.5];
  }
  setPlace(p) { this.place = { ...this.place, ...p }; this.layout(); }
  // a point of the image (fractions of its width and height) on the view (px)
  pointAt(u, v) { const b = this._box(); return this._at(b, (u - 0.5) * b.w, (v - 0.5) * b.h); }
  // the place that puts image point (u, v) at view point (sx, sy) with this size (view heights) and angle
  placeAt(u, v, sx, sy, size, angle) {
    const W = this.parent.clientWidth || 1, H = this.parent.clientHeight || 1, w = size * H, h = w * this.aspect;
    const dx = (u - 0.5) * w, dy = (v - 0.5) * h, c = Math.cos(angle), s = Math.sin(angle);
    const cx = sx - (dx * c - dy * s), cy = sy - (dx * s + dy * c);
    return { x: (cx - W / 2) / H, y: (cy - H / 2) / H, size, angle };
  }
  get dragging() { return !!this._dragging; }
  setOpacity(a) { this.opacity = a; this.layout(); }
  // only this part of the image shown: a polygon in fractions of its width and height (null: all of it)
  setClip(points) {
    const on = points && points.length >= 3;
    this.img.style.clipPath = on ? 'polygon(' + points.map(([u, v]) => (100 * u).toFixed(2) + '% ' + (100 * v).toFixed(2) + '%').join(', ') + ')' : '';
    this.box = on ? [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))].map(x => Math.min(1, Math.max(0, x)))
                  : [0, 0, 1, 1];
    this.layout();
  }
  // the middle of the part shown, from the image's centre, unturned (px): the control's pivot
  _mid(b) {
    const [u0, v0, u1, v1] = this.box;
    return [((u0 + u1) / 2 - 0.5) * b.w, ((v0 + v1) / 2 - 0.5) * b.h];
  }
  setVisible(on) { this.visible = !!on; this.hidden = false; this.layout(); }
  // hidden for a look at what's under it (true), or shown again (false)
  setHidden(on) { this.hidden = !!on; this.layout(); }
  dispose() { this._ro.disconnect(); this.el.remove(); }

  // the view's size, and the image's centre and size on the screen
  _box() {
    const W = this.parent.clientWidth || 1, H = this.parent.clientHeight || 1, p = this.place;
    const w = p.size * H, h = w * this.aspect;
    return { W, H, cx: W / 2 + p.x * H, cy: H / 2 + p.y * H, w, h };
  }
  // a point of the image (dx, dy from its centre, unturned) on the screen
  _at(b, dx, dy) {
    const c = Math.cos(this.place.angle), s = Math.sin(this.place.angle);
    return [b.cx + dx * c - dy * s, b.cy + dx * s + dy * c];
  }
  layout() {
    const on = this.visible && !!this.img.src;
    this.el.style.display = on ? '' : 'none';
    if (!on) return;
    if (this.warp) {   // the image (at most 2048 px wide), mapped by the homography (CSS: column-major)
      const k = Math.min(1, 2048 / Math.max(this.iw, this.ih)), W = this.warp;
      const H = W.map(row => [row[0] / k, row[1] / k, row[2]]);   // (from the smaller image's px)
      Object.assign(this.img.style, { left: '0px', top: '0px', width: this.iw * k + 'px', height: this.ih * k + 'px', transformOrigin: '0 0',
        transform: 'matrix3d(' + [H[0][0], H[1][0], 0, H[2][0], H[0][1], H[1][1], 0, H[2][1], 0, 0, 1, 0, H[0][2], H[1][2], 0, H[2][2]].join(',') + ')',
        opacity: this.hidden ? 0 : this.opacity });
      this.ctl.style.display = 'none';
      return;
    }
    this.ctl.style.display = this.controls && !this.hidden ? '' : 'none';
    const b = this._box();
    Object.assign(this.img.style, {
      left: (b.cx - b.w / 2) + 'px', top: (b.cy - b.h / 2) + 'px', width: b.w + 'px', height: b.h + 'px', transformOrigin: '50% 50%',
      transform: 'rotate(' + this.place.angle + 'rad)', opacity: this.hidden ? 0 : this.opacity,
    });
    // the control at the middle of the part shown — kept in the view (the photo may reach beyond it)
    const m = this._at(b, ...this._mid(b)), pad = 40;
    this.ctl.style.left = Math.min(b.W - pad, Math.max(pad, m[0])) + 'px';
    this.ctl.style.top = Math.min(b.H - pad, Math.max(pad, m[1])) + 'px';
  }
  _drag(h, kind) {
    let start = null;
    h.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const b = this._box(), r = this.parent.getBoundingClientRect(), mid = this._mid(b), pivot = this._at(b, ...mid);
      start = { px: e.clientX, py: e.clientY, place: { ...this.place }, b, mid, pivot,
                a0: Math.atan2(e.clientY - r.top - pivot[1], e.clientX - r.left - pivot[0]), d0: Math.max(8, Math.hypot(e.clientX - r.left - pivot[0], e.clientY - r.top - pivot[1])) };
      this._dragging = true;
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', e => {
      if (!start) return;
      const { b, place } = start;
      if (kind === 'move') {
        this.place = { ...place, x: place.x + (e.clientX - start.px) / b.H, y: place.y + (e.clientY - start.py) / b.H };
      } else {
        // about the middle (it stays): turned by the pointer's turn round it, scaled by its distance
        const r = this.parent.getBoundingClientRect(), { pivot, mid } = start;
        const vx = e.clientX - r.left - pivot[0], vy = e.clientY - r.top - pivot[1];
        const f = Math.max(0.05, Math.max(8, Math.hypot(vx, vy)) / start.d0);
        const angle = place.angle + Math.atan2(vy, vx) - start.a0;
        const c = Math.cos(angle), s = Math.sin(angle), ax = mid[0] * f, ay = mid[1] * f;
        const cx = pivot[0] - (ax * c - ay * s), cy = pivot[1] - (ax * s + ay * c);   // the centre: back from the middle
        this.place = { x: (cx - b.W / 2) / b.H, y: (cy - b.H / 2) / b.H, size: place.size * f, angle };
      }
      this.layout();
    });
    const end = () => { if (!start) return; start = null; this._dragging = false; if (this.onChange) this.onChange({ ...this.place }); };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }
}

function invert3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
