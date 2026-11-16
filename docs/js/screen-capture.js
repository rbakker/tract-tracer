// ── screen-capture.js ─────────────────────────────────────
// The page as shown on the screen (getDisplayMedia: the browser asks once
// to share the tab), cut to a rectangle of the page: a still (PNG) or a
// recording (MediaRecorder: mp4 where the browser can, else webm) —
// everything shown, the labels and panels on top included, at the
// screen's resolution, in real time.
//
// Cut to the rectangle by the browser where it can (Region Capture:
// Chrome, Edge — the capture itself is cropped to an element's box: here
// an invisible element placed on the rectangle), else frame by frame on a
// canvas (Firefox, Safari: the tab's frame scaled to the page). Either way
// the tab shared must be this one.
//
// No app state: TOOLS › Screenshot / movie uses it.

export const captureSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const regionCrop = () => typeof window.CropTarget === 'function' && typeof window.CropTarget.fromElement === 'function';

export class ScreenCapture {
  constructor({ onEnded = () => {} } = {}) {
    this.onEnded = onEnded;
    this.stream = null; this.track = null; this.video = null;
    this.cropEl = null; this.cropKey = null; this.cropped = false;
  }
  get active() { return !!(this.track && this.track.readyState === 'live'); }

  // sharing on (the browser asks); pointer: the mouse pointer in the picture
  async start({ pointer = false, fps = 30 } = {}) {
    if (this.active) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: fps, max: 60 }, cursor: pointer ? 'always' : 'never' },
      audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
    });
    this.stream = stream; this.track = stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => { this.stop(); this.onEnded(); });
    const v = this.video = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    await new Promise(ok => { if (v.videoWidth) ok(); else v.onloadedmetadata = () => ok(); });
    this.cropKey = null; this.cropped = false;
    // A tab sends frames only when something on it changes: a page standing
    // still would give a stale still and an empty recording. A pixel in the
    // rectangle's corner flickers by 1/255 while sharing (not to be seen).
    const pulse = this.pulse = document.createElement('div');
    pulse.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;pointer-events:none;z-index:2147483647;';
    document.body.appendChild(pulse);
    let odd = false;
    const beat = () => { if (!this.pulse) return; odd = !odd; pulse.style.background = odd ? 'rgba(128,128,128,0.004)' : 'rgba(128,128,128,0.008)'; this._beat = requestAnimationFrame(beat); };
    beat();
  }
  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.video) { this.video.srcObject = null; this.video = null; }
    if (this.cropEl) { this.cropEl.remove(); this.cropEl = null; }
    if (this.pulse) { cancelAnimationFrame(this._beat); this.pulse.remove(); this.pulse = null; }
    this.stream = null; this.track = null; this.cropKey = null; this.cropped = false;
  }

  // cut to rect ({ left, top, width, height }, page px): by the browser when it can
  async cropTo(rect) {
    const key = [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(',');
    if (key === this.cropKey) return;
    this.cropKey = key;
    this.rect = { ...rect };
    if (this.pulse) Object.assign(this.pulse.style, { left: rect.left + 'px', top: rect.top + 'px' });
    if (!regionCrop() || !this.track || !this.track.cropTo) { this.cropped = false; this.found = await this.calibrate(); return; }
    if (!this.cropEl) {
      const el = this.cropEl = document.createElement('div');
      el.style.cssText = 'position:fixed;pointer-events:none;background:transparent;z-index:0;';
      document.body.appendChild(el);
    }
    Object.assign(this.cropEl.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    try { await this.track.cropTo(await window.CropTarget.fromElement(this.cropEl)); this.cropped = true; }
    catch (e) { console.warn('region capture', e); this.cropped = false; }
    // (the cropped frames to arrive: their size the rectangle's)
    const want = Math.round(rect.width * devicePixelRatio);
    for (let i = 0; i < 60 && this.cropped && Math.abs(this.video.videoWidth - want) > 2; i++) await frames(1);
    if (this.cropped && Math.abs(this.video.videoWidth - want) > 2) {   // (not cut after all: undone, cut here instead)
      try { await this.track.cropTo(undefined); } catch (_) {}
      this.cropped = false;
    }
    if (!this.cropped) this.found = await this.calibrate();
  }
  // the part of the shared frame that is rect (when the browser did not cut it)
  _source() {
    const v = this.video, W = v.videoWidth, H = v.videoHeight;
    if (this.cropped) return [0, 0, W, H];
    const m = this.map || { ox: 0, oy: 0, kx: W / window.innerWidth, ky: H / window.innerHeight }, r = this.rect;
    const x = Math.max(0, Math.round(m.ox + r.left * m.kx)), y = Math.max(0, Math.round(m.oy + r.top * m.ky));
    return [x, y, Math.max(2, Math.min(W - x, Math.round(r.width * m.kx))), Math.max(2, Math.min(H - y, Math.round(r.height * m.ky)))];
  }
  // Where the page is in the shared frame. Shared as a window or a screen
  // (Firefox shares no tabs), the frame holds the browser's tabs and title
  // bar too, or more: two marks are shown at the page's corners for a
  // moment and found in the frame. → true when found
  async calibrate() {
    const S = 12, mk = (bg, css) => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;width:' + S + 'px;height:' + S + 'px;z-index:2147483647;pointer-events:none;background:' + bg + ';' + css; document.body.appendChild(d); return d; };
    const a = mk('#ff00ff', 'left:0;top:0;'), b = mk('#00ffff', 'right:0;bottom:0;');
    try {
      await frames(4);
      const v = this.video, W = v.videoWidth, H = v.videoHeight, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0);
      const px = g.getImageData(0, 0, W, H).data;
      const box = (test, x0, x1, y0, y1) => {
        let l = Infinity, t = Infinity, r = -1, bt = -1;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = 4 * (y * W + x); if (test(px[i], px[i + 1], px[i + 2])) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > bt) bt = y; } }
        return r < 0 ? null : { l, t, r: r + 1, b: bt + 1 };
      };
      const ma = box((r, g, b) => r > 200 && g < 70 && b > 200, 0, W >> 1, 0, H >> 1);
      const cy = box((r, g, b) => r < 70 && g > 200 && b > 200, W >> 1, W, H >> 1, H);
      if (!ma || !cy) { this.map = null; return false; }
      const kx = (cy.r - ma.l) / window.innerWidth, ky = (cy.b - ma.t) / window.innerHeight;
      // (the marks' own size must agree: else something else of those colours was found)
      if (!(Math.abs((ma.r - ma.l) - S * kx) < 3 && Math.abs((cy.b - cy.t) - S * ky) < 3)) { this.map = null; return false; }
      this.map = { ox: ma.l, oy: ma.t, kx, ky };
      return true;
    } finally { a.remove(); b.remove(); await frames(2); }
  }
  // a still: a canvas of the rectangle as shown now
  async still() {
    if (!this.cropped) this.found = await this.calibrate();   // (the window may have moved)
    await frames(3);   // (a frame of now: the outline gone)
    const [sx, sy, sw, sh] = this._source(), c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(this.video, sx, sy, sw, sh, 0, 0, sw, sh);
    return c;
  }

  /**
   * Record until stop() of the returned handle, or maxSeconds. → handle
   * { stop(), done: Promise<Blob> }; onTick(seconds, bytes) as it goes.
   */
  record({ format = 'mp4', bitrate = 8e6, fps = 30, maxSeconds = 120, onTick = () => {} } = {}) {
    const mime = pickMime(format);
    let stream = this.stream, raf = 0, canvas = null;
    if (!this.cropped) {   // (cut on a canvas, frame by frame)
      const [, , sw, sh] = this._source();
      canvas = document.createElement('canvas'); canvas.width = sw - sw % 2; canvas.height = sh - sh % 2;
      const g = canvas.getContext('2d');
      const draw = () => { const [sx, sy] = this._source(); g.drawImage(this.video, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height); raf = requestAnimationFrame(draw); };
      draw();
      stream = canvas.captureStream(fps);
    }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    const chunks = []; let bytes = 0;
    const t0 = performance.now();
    rec.ondataavailable = e => { if (e.data && e.data.size) { chunks.push(e.data); bytes += e.data.size; } };
    const tick = setInterval(() => {
      const s = (performance.now() - t0) / 1000;
      onTick(s, bytes);
      if (s >= maxSeconds && rec.state === 'recording') rec.stop();
    }, 250);
    const done = new Promise((ok, bad) => {
      rec.onstop = () => {
        clearInterval(tick); cancelAnimationFrame(raf);
        if (canvas) for (const t of stream.getTracks()) t.stop();
        const b = new Blob(chunks, { type: mime.split(';')[0] }); b.ext = /mp4/.test(mime) ? 'mp4' : 'webm'; ok(b);
      };
      rec.onerror = e => { clearInterval(tick); cancelAnimationFrame(raf); bad(e.error || e); };
    });
    rec.start(1000);
    return { stop: () => { if (rec.state === 'recording') rec.stop(); }, done, mime };
  }
}

// the recorder's type: mp4 (H.264) where the browser records it, else webm
export function pickMime(format) {
  const ok = t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t);
  const mp4 = ['video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4'].find(ok);
  const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(ok);
  return (format === 'mp4' ? mp4 || webm : webm || mp4) || '';
}
export const canRecordMp4 = () => /mp4/.test(pickMime('mp4'));

const frames = n => new Promise(ok => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : setTimeout(ok, 30)); f(); });
