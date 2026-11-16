// ── mask-worker.js ────────────────────────────────────────
// shapeMask (js/mask-ops.js) off the main thread, for TOOLS › Mask editor.
// In: { id, data, shape, spacing, level, close, open, smooth, offset };
// out: { id, progress } as it goes, then { id, field, inside } (or { id, error }).
import { shapeMask } from './mask-ops.js';
self.onmessage = e => {
  const { id, ...o } = e.data;
  try {
    const r = shapeMask({ ...o, progress: text => self.postMessage({ id, progress: text }) });
    self.postMessage({ id, field: r.field, inside: r.inside }, [r.field.buffer]);
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};
