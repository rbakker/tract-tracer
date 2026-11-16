// ── image-panel.js ────────────────────────────────────────
// A 2D image (a photo) in a box as wide as its parent, as high as the
// image's shape asks (up to maxRatio × the width), with a margin around
// the image (an outline can run along its edge, or just past it). The wheel zooms around
// the pointer, a drag pans, a double-click fits it again.
//
// On it an OUTLINE (a polygon): startOutline(), then a click adds a point;
// a click on the first point, or Enter, closes it; Backspace removes the
// last point; Escape stops (fewer than 3 points: none). Points of a
// finished outline can be dragged. A click that is not for the outline
// goes to onPick(x, y). MARKS: numbered points drawn on it (setMarks).
// All positions in image pixels (x right, y down).
//
// No app state: index.html and the tools make one per image they show.

export class ImagePanel {
  /**
   * @param {Object} o
   * @param {number} [o.maxRatio] - the box's height at most this × its width
   * @param {Function} [o.onOutline] - (outline) after a change: { points: [[x, y]], closed }
   * @param {Function} [o.onPick] - (x, y) a click on the image (not for the outline)
   */
  constructor({ maxRatio = 1.2, margin = 0.05, onOutline = null, onPick = null } = {}) {
    this.maxRatio = maxRatio; this.margin = margin; this.onOutline = onOutline; this.onPick = onPick;
    this.el = document.createElement('div');
    this.el.className = 'img-panel';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.img = null;
    this.zoom = 1; this.cx = 0; this.cy = 0;    // zoom 1: the image fits; (cx, cy): the image point at the box's centre
    this.outline = { points: [], closed: false };
    this.drawing = false;
    this.marks = [];                             // [{ x, y, label, color, shape }]
    this._hover = null;                          // the pointer, box px (for the line to the next point)
    // a new width: drawn again (its height follows from it — so only the
    // width is watched, and the drawing waits a frame: no resize loop)
    this._w = 0;
    this._ro = new ResizeObserver(() => { const w = this.el.clientWidth; if (w && w !== this._w) { this._w = w; requestAnimationFrame(() => this._resize()); } });
    this._ro.observe(this.el);
    this._wire();
  }

  setImage(img) {
    this.img = img;
    this.zoom = 1; this.cx = img ? img.naturalWidth / 2 : 0; this.cy = img ? img.naturalHeight / 2 : 0;
    this._resize();
  }
  setOutline(o) {
    this.outline = { points: (o && o.points || []).map(p => p.slice()), closed: !!(o && o.closed) };
    this.drawing = false;
    this.draw();
  }
  // numbered points on the image: [{ x, y, label, color, shape }] (shape: 'diamond', else a ring)
  setMarks(marks) { this.marks = marks || []; this.draw(); }
  // the image point at the box's centre, zoomed in (zoom: the factor over the fit)
  centreOn(x, y, zoom = null) { if (!this.img) return; if (zoom) this.zoom = Math.max(1, zoom); this.cx = x; this.cy = y; this.draw(); }
  startOutline() { this.outline = { points: [], closed: false }; this.drawing = true; this.draw(); this._changed(); }
  clearOutline() { this.outline = { points: [], closed: false }; this.drawing = false; this.draw(); this._changed(); }
  stopOutline() {
    if (!this.drawing) return;
    this.drawing = false;
    if (this.outline.points.length < 3) this.outline = { points: [], closed: false };
    else this.outline.closed = true;
    this.draw(); this._changed();
  }
  fit() { if (!this.img) return; this.zoom = 1; this.cx = this.img.naturalWidth / 2; this.cy = this.img.naturalHeight / 2; this.draw(); }
  dispose() { this._ro.disconnect(); document.removeEventListener('keydown', this._onKey); this.el.remove(); }

  // ── geometry ──
  // the canvas's own size, as last set (not read from the page: while the
  // panel around it is being rebuilt, the page's sizes are in between)
  get _W() { return this._cw || this.el.clientWidth || 1; }
  get _H() { return this._ch || this.canvas.clientHeight || 1; }
  _fitScale() { const iw = this.img.naturalWidth, ih = this.img.naturalHeight; return Math.min(this._W / iw, this._H / ih) * (1 - 2 * this.margin); }
  _scale() { return this._fitScale() * this.zoom; }
  toBox(x, y) { const s = this._scale(); return [(x - this.cx) * s + this._W / 2, (y - this.cy) * s + this._H / 2]; }
  toImage(bx, by) { const s = this._scale(); return [(bx - this._W / 2) / s + this.cx, (by - this._H / 2) / s + this.cy]; }
  // keep the image covering the box, up to the margin past its edges (or
  // centred, where it is smaller)
  _clamp() {
    const s = this._scale(), iw = this.img.naturalWidth, ih = this.img.naturalHeight;
    const mx = this.margin * this._W / s, my = this.margin * this._H / s;
    const hw = this._W / 2 / s - mx, hh = this._H / 2 / s - my;
    this.cx = iw > 2 * hw ? Math.min(iw - hw, Math.max(hw, this.cx)) : iw / 2;
    this.cy = ih > 2 * hh ? Math.min(ih - hh, Math.max(hh, this.cy)) : ih / 2;
  }
  _resize() {
    const W = this.el.clientWidth || 1;
    const ratio = this.img ? Math.min(this.maxRatio, this.img.naturalHeight / this.img.naturalWidth) : 0.6;
    const z = (this.el.getBoundingClientRect().width / (W || 1)) || 1;   // (CSS zoom of the page: sharp at that size too)
    const H = Math.max(40, Math.round(W * ratio)), dpr = (window.devicePixelRatio || 1) * z;
    this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px';
    this._cw = W; this._ch = H;
    this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    this.draw();
  }

  // ── drawing ──
  draw() {
    const c = this.canvas, g = c.getContext('2d'), dpr = c.width / (c.clientWidth || 1);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this._W, this._H);
    g.fillStyle = '#05080b'; g.fillRect(0, 0, this._W, this._H);
    if (!this.img) return;
    this._clamp();
    const s = this._scale(), [ox, oy] = this.toBox(0, 0);
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.img, ox, oy, this.img.naturalWidth * s, this.img.naturalHeight * s);
    const P = this.outline.points.map(p => this.toBox(p[0], p[1]));
    if (!P.length) { this._drawMarks(g); return; }
    // a closed outline: outside it darker
    if (this.outline.closed && P.length >= 3) {
      g.save();
      g.beginPath(); g.rect(0, 0, this._W, this._H);
      g.moveTo(P[0][0], P[0][1]); for (const p of P.slice(1)) g.lineTo(p[0], p[1]); g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fill('evenodd');
      g.restore();
    }
    g.beginPath(); g.moveTo(P[0][0], P[0][1]); for (const p of P.slice(1)) g.lineTo(p[0], p[1]);
    if (this.outline.closed) g.closePath();
    else if (this.drawing && this._hover) g.lineTo(this._hover[0], this._hover[1]);
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(155,187,255,0.95)'; g.stroke();
    P.forEach((p, i) => {
      const r = this.drawing && i === 0 ? 5 : 3;
      g.fillStyle = this.drawing && i === 0 ? '#ffd27a' : '#9bf';
      g.fillRect(p[0] - r, p[1] - r, 2 * r, 2 * r);
    });
    this._drawMarks(g);   // (over the outline)
  }
  _drawMarks(g) {
    g.save();
    g.font = '600 10px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const m of this.marks) {
      const [x, y] = this.toBox(m.x, m.y);
      const shape = () => { g.beginPath(); if (m.shape === 'diamond') { g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); } else g.arc(x, y, 5, 0, 2 * Math.PI); };
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.75)'; shape(); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = m.color || '#7fe0ff'; shape(); g.stroke();
      g.beginPath(); g.moveTo(x - 2, y); g.lineTo(x + 2, y); g.moveTo(x, y - 2); g.lineTo(x, y + 2); g.stroke();
      if (m.label != null) {
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(String(m.label), x + 8, y - 6);
        g.fillStyle = m.color || '#7fe0ff'; g.fillText(String(m.label), x + 8, y - 6);
      }
    }
    g.restore();
  }
  _changed() { if (this.onOutline) this.onOutline({ points: this.outline.points.map(p => p.slice()), closed: this.outline.closed }); }

  // ── the mouse and keys ──
  _wire() {
    const c = this.canvas;
    // the pointer in the box's own px — the page may be zoomed (CSS zoom on the panels: the
    // screen rectangle is larger than the box's own size by that factor)
    const boxXY = e => { const r = c.getBoundingClientRect(), k = r.width / (c.clientWidth || 1) || 1; return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]; };
    const nearPoint = (bx, by) => {
      let best = -1, bd = 7 * 7;
      this.outline.points.forEach((p, i) => { const [x, y] = this.toBox(p[0], p[1]); const d = (x - bx) ** 2 + (y - by) ** 2; if (d <= bd) { bd = d; best = i; } });
      return best;
    };
    c.addEventListener('wheel', e => {
      if (!this.img) return;
      e.preventDefault();
      const [bx, by] = boxXY(e), [ix, iy] = this.toImage(bx, by);
      this.zoom = Math.min(40, Math.max(1, this.zoom * Math.exp(-e.deltaY * 0.0015)));
      // the image point under the pointer stays there
      const s = this._scale();
      this.cx = ix - (bx - this._W / 2) / s; this.cy = iy - (by - this._H / 2) / s;
      this.draw();
    }, { passive: false });
    let down = null;
    c.addEventListener('pointerdown', e => {
      if (!this.img || e.button !== 0) return;
      const [bx, by] = boxXY(e);
      const k = !this.drawing && this.outline.closed ? nearPoint(bx, by) : -1;
      down = { bx, by, cx: this.cx, cy: this.cy, moved: false, point: k };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      const [bx, by] = boxXY(e);
      this._hover = [bx, by];
      if (!down) {
        c.style.cursor = this.drawing || this.el.classList.contains('picking') ? 'crosshair' : (this.outline.closed && nearPoint(bx, by) >= 0 ? 'move' : 'grab');
        if (this.drawing) this.draw();
        return;
      }
      if (!down.moved && Math.hypot(bx - down.bx, by - down.by) > 3) down.moved = true;
      if (!down.moved) return;
      if (down.point >= 0) { this.outline.points[down.point] = this.toImage(bx, by).map(v => +v.toFixed(1)); this.draw(); return; }
      const s = this._scale();
      this.cx = down.cx - (bx - down.bx) / s; this.cy = down.cy - (by - down.by) / s;
      c.style.cursor = 'grabbing';
      this.draw();
    });
    c.addEventListener('pointerup', e => {
      if (!down) return;
      const d = down; down = null;
      if (d.moved) { if (d.point >= 0) this._changed(); return; }
      const [ix, iy] = this.toImage(d.bx, d.by);
      if (this.drawing) {
        const P = this.outline.points;
        if (P.length >= 3) { const [fx, fy] = this.toBox(P[0][0], P[0][1]); if (Math.hypot(fx - d.bx, fy - d.by) <= 8) { this.stopOutline(); return; } }
        P.push([+ix.toFixed(1), +iy.toFixed(1)]);
        this.draw(); this._changed();
      } else if (this.onPick) this.onPick(ix, iy);
    });
    c.addEventListener('pointerleave', () => { this._hover = null; if (this.drawing) this.draw(); });
    c.addEventListener('dblclick', e => { if (!this.drawing) { e.preventDefault(); this.fit(); } });
    this._onKey = e => {
      if (!this.drawing || !this.el.isConnected) return;
      if (e.target.closest && e.target.closest('input, textarea, select')) return;
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); this.stopOutline(); }
      else if (e.key === 'Backspace') { e.preventDefault(); this.outline.points.pop(); this.draw(); this._changed(); }
    };
    document.addEventListener('keydown', this._onKey);
  }
}
