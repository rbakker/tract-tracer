// ── image-overlay.js ──────────────────────────────────────
// An image laid over a view, semi-transparent (a lightbox), with two
// handles: ✥ at its top-right corner moves it; ⤡ at its bottom-left
// corner scales and turns it about the top-right corner. With a clip (only
// part of the image shown), the corners are those of the part shown. Only the handles
// take the mouse — everywhere else the view below gets it, so the 3D view
// still turns and zooms under the image.
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
    this.hMove = this._handle('✥', 'move the photo', 'move');
    this.hTurn = this._handle('⤡', 'scale and turn the photo (about its top-right corner)', 'nesw-resize');
    el.append(this.img, this.hMove, this.hTurn);
    parent.appendChild(el);
    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(parent);
    this._drag(this.hMove, 'move');
    this._drag(this.hTurn, 'turn');
  }

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
  // the handles' points, from the image's centre, unturned (px): top-right and bottom-left of the part shown
  _corners(b) {
    const [u0, v0, u1, v1] = this.box;
    return { tr: [(u1 - 0.5) * b.w, (v0 - 0.5) * b.h], bl: [(u0 - 0.5) * b.w, (v1 - 0.5) * b.h] };
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
      this.hMove.style.display = this.hTurn.style.display = 'none';
      return;
    }
    this.hMove.style.display = this.hTurn.style.display = '';
    const b = this._box();
    Object.assign(this.img.style, {
      left: (b.cx - b.w / 2) + 'px', top: (b.cy - b.h / 2) + 'px', width: b.w + 'px', height: b.h + 'px', transformOrigin: '50% 50%',
      transform: 'rotate(' + this.place.angle + 'rad)', opacity: this.hidden ? 0 : this.opacity,
    });
    const k = this._corners(b), tr = this._at(b, ...k.tr), bl = this._at(b, ...k.bl);
    this.hMove.style.left = tr[0] + 'px'; this.hMove.style.top = tr[1] + 'px';
    this.hTurn.style.left = bl[0] + 'px'; this.hTurn.style.top = bl[1] + 'px';
  }

  _handle(symbol, tip, cursor) {
    const h = document.createElement('div');
    h.className = 'img-overlay-handle'; h.textContent = symbol; h.dataset.tip = tip; h.style.cursor = cursor;
    return h;
  }
  _drag(h, kind) {
    let start = null;
    h.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const b = this._box();
      const k = this._corners(b);
      start = { px: e.clientX, py: e.clientY, place: { ...this.place }, b, k, tr: this._at(b, ...k.tr) };
      this._dragging = true;
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', e => {
      if (!start) return;
      const { b, place } = start;
      if (kind === 'move') {
        this.place = { ...place, x: place.x + (e.clientX - start.px) / b.H, y: place.y + (e.clientY - start.py) / b.H };
      } else {
        // the top-right handle stays; the bottom-left one follows the pointer
        const r = this.parent.getBoundingClientRect();
        const vx = e.clientX - r.left - start.tr[0], vy = e.clientY - r.top - start.tr[1];
        const { tr, bl } = start.k, dx = bl[0] - tr[0], dy = bl[1] - tr[1];   // from one handle to the other, unturned
        const f = Math.max(24, Math.hypot(vx, vy)) / Math.max(1e-6, Math.hypot(dx, dy));   // the scale factor
        const angle = Math.atan2(vy, vx) - Math.atan2(dy, dx);
        const c = Math.cos(angle), s = Math.sin(angle);
        // the centre: back from the top-right handle (scaled and turned)
        const ax = tr[0] * f, ay = tr[1] * f;
        const cx = start.tr[0] - (ax * c - ay * s), cy = start.tr[1] - (ax * s + ay * c);
        this.place = { x: (cx - b.W / 2) / b.H, y: (cy - b.H / 2) / b.H, size: b.w * f / b.H, angle };
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
