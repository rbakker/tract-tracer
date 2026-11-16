// ── tools/mask.js ─────────────────────────────────────────
// MASK EDITOR — a tool (tools.md): a mask (a brain mask from SynthSeg,
// HD-BET, …) reshaped by a small pipeline — close, open, smooth, offset, in
// mm (js/mask-ops.js, in a worker) — into a new volume, named after the
// preset it started from (<mask>_envelope, <mask>_smooth, …; custom:
// <mask>_shaped), so several can be made from one mask: a
// smooth 0–1 field, its surface at 0.5. Presets: envelope (closed over the
// sulci, smooth — the layer of the meninges and the vessels on them, as a
// surgery photo shows it), dilate, erode, smooth.
//
// The new volume can be rendered itself (solid: its background is set to
// 0.5, so its surface is the shaped edge, smooth at sub-voxel precision),
// painted (ANATOMY › surface paint: vessels, a contrast scan), or used as
// a mask (ANATOMY › apply mask: a soft mask, weighted by its value). Made
// again (another setting), it replaces itself, and what uses it follows.
//
// A preset is the starting point and the intent: its sliders are then
// adjusted to the data, the name staying the preset's (<mask>_envelope,
// adjusted, is still the envelope; 'reset' gives the preset's values back).
// The volume being made keeps its name while its sliders are moved (made
// again in place, once a slider is let go); choosing a preset goes to that
// preset's volume.
//
// Saved as <name>.nii.gz with a sidecar <name>.json (BIDS
// style: Description, Sources, GeneratedBy, and "MaskShaping": the source
// file and the settings) — loaded again, it is a soft mask again, and the
// tool can make it again from its source with the same settings.

let host = null;
let src = null;                         // the mask volume shaped
const P = { level: 0, close: 4, open: 0, smooth: 1, offset: 0.5 };
let preset = 'envelope';
let out = null;                         // { vol, src, params, inside, insideSrc } — the one being edited
let editing = null;                     // its name (<mask>_<preset>.nii.gz), kept while the sliders move
const outs = new Map();                 // name → its record: every one made
let busy = false, note = '', worker = null, reqId = 0, timer = 0;
const cache = new Map();                // mask volume → { data, shape, Ab, spacing, integer, min, max, inside }
const recipes = new Map();              // volume → its sidecar's MaskShaping, or null (read once)

const PRESETS = {
  envelope: { close: 4, open: 0, smooth: 1, offset: 0.5, tip: 'closed over the sulci (4 mm), smooth (σ 1 mm), half a mm out: the layer of the meninges and the vessels on it' },
  dilate:   { close: 0, open: 0, smooth: 0.5, offset: 2, tip: 'grown by 2 mm, lightly smoothed' },
  erode:    { close: 0, open: 0, smooth: 0.5, offset: -2, tip: 'shrunk by 2 mm, lightly smoothed' },
  smooth:   { close: 0, open: 0, smooth: 1, offset: 0, tip: 'only smoothed (σ 1 mm): no voxel steps' },
};
const SLIDERS = [
  ['close', 0, 10, 0.5, 'grown, then shrunk by this much: gaps and sulci narrower than about twice it are bridged'],
  ['open', 0, 10, 0.5, 'shrunk, then grown by this much: spurs and strands thinner than about twice it are removed'],
  ['smooth', 0, 3, 0.1, 'the edge smoothed (Gaussian σ): no voxel steps, smooth normals for shading and for surface paint'],
  ['offset', -5, 10, 0.25, 'the edge moved out by this much (negative: in), after smoothing'],
];

const madeVols = () => new Set([...outs.values()].map(o => o.vol));
const candidates = () => { const m = madeVols(); return host.volumes().filter(v => !v.isColor && !m.has(v)); };
const nameFor = (v, pr) => stem(v.file.name) + '_' + (PRESETS[pr] ? pr : 'shaped') + '.nii.gz';
const target = () => editing || nameFor(src, preset);
// the one being edited: the volume of that name, if made (and still loaded)
function follow() { const o = editing && outs.get(editing); out = o && o.src === src && host.volumes().includes(o.vol) ? o : null; }
const stem = name => String(name).replace(/\.(nii\.gz|nii|mif\.gz|mif)$/i, '');
const spacingOf = Ab => [0, 1, 2].map(c => Math.hypot(Ab[0][c], Ab[1][c], Ab[2][c]) || 1);

async function sourceData(v) {
  let c = cache.get(v);
  if (c) return c;
  const a = await host.readVolume(v.file);
  const [nx, ny, nz] = a.shape, n = nx * ny * nz, d = a.data;
  let integer = true, min = Infinity, max = -Infinity, inside = 0;
  for (let i = 0; i < n; i++) { const x = d[i]; if (x !== x) continue; if (x < min) min = x; if (x > max) max = x; if (integer && x !== Math.round(x)) integer = false; if (x > 0) inside++; }
  c = { data: d.length === n ? d : d.subarray(0, n), shape: [nx, ny, nz], Ab: a.Ab, spacing: spacingOf(a.Ab), integer, min, max, inside };
  for (const k of cache.keys()) if (!host.volumes().includes(k)) cache.delete(k);
  cache.set(v, c);
  return c;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../js/mask-worker.js', import.meta.url), { type: 'module' });
  return worker;
}
// make it (again): the newest request wins — a running one is stopped
async function make() {
  const v = src; if (!v) return;
  const id = ++reqId;
  busy = true; note = 'reading ' + v.label + '…'; host.redraw();
  let c;
  try { c = await sourceData(v); } catch (e) { busy = false; note = 'could not read ' + v.label + ': ' + ((e && e.message) || e); host.redraw(); return; }
  if (id !== reqId) return;
  if (worker && busy) { worker.terminate(); worker = null; }   // (an older one still running)
  const w = ensureWorker(), params = { ...P };
  note = 'shaping…'; host.redraw();
  const data = new Float32Array(c.data);   // (a copy: the cached one stays)
  const res = await new Promise(resolve => {
    w.onmessage = e => { const m = e.data; if (m.id !== id) return; if (m.progress) { note = m.progress; host.ui.progress('mask: ' + m.progress); return; } resolve(m); };
    w.onerror = e => resolve({ id, error: e.message || 'worker error' });
    w.postMessage({ id, data, shape: c.shape, spacing: c.spacing, ...params }, [data.buffer]);
  });
  host.ui.progress('');
  if (id !== reqId) return;
  busy = false;
  if (res.error) { note = 'failed: ' + res.error; host.redraw(); return; }
  const name = target();
  const desc = 'mask shaping:' + Object.entries(params).filter(([k, x]) => k !== 'level' || x).map(([k, x]) => ' ' + k + ' ' + x).join('');
  const vol = host.addVolume(name, { data: res.field, shape: c.shape, Ab: c.Ab, category: 'anatomy', description: desc.slice(0, 79),
                                     softMask: true, background: 0.5, shaderMode: 'solid' });
  out = { vol, src: v, params, preset, inside: res.inside, insideSrc: c.inside, voxMl: c.spacing[0] * c.spacing[1] * c.spacing[2] / 1000 };
  outs.set(name, out); editing = name;
  note = '';
  host.redraw();
}
// the sidecar's recipe of a volume (a shaped mask, saved and loaded again)
function recipeOf(v) {
  if (recipes.has(v)) return recipes.get(v);
  recipes.set(v, null);
  if (v.sidecar) host.readSidecar(v).then(j => { const m = j && j.MaskShaping; if (m && typeof m === 'object') { recipes.set(v, m); host.redraw(); } }, () => {});
  return null;
}
const recipeText = m => ['level', 'close', 'open', 'smooth', 'offset'].filter(k => Number.isFinite(m[k]) && (k !== 'level' || m[k])).map(k => k + ' ' + m[k]).join(' · ');
function sidecarOf(o) {
  const settings = Object.fromEntries(Object.entries(o.params).filter(([k, x]) => k !== 'level' || x));
  return {
    Description: 'A brain mask reshaped: ' + recipeText(o.params) + ' (mm). A 0–1 field, its edge (the surface) at 0.5.',
    Sources: [o.src.file.name],
    GeneratedBy: [{ Name: 'tractogram.observer', Description: 'TOOLS › Mask editor (tools/mask.js; js/mask-ops.js)' }],
    MaskShaping: { source: o.src.file.name, ...(o.preset && PRESETS[o.preset] ? { preset: o.preset } : {}), ...settings, units: 'mm', steps: 'inside above level; close; open; signed distance smoothed (Gaussian σ = smooth); edge moved out by offset',
                   field: '0–1, the surface at 0.5, a ramp one voxel wide: a soft mask' },
  };
}
const gzipped = buf => { const b = new Uint8Array(buf, 0, 2); return b[0] === 0x1f && b[1] === 0x8b; };
async function gzip(buf) {
  const cs = new CompressionStream('gzip'), w = cs.writable.getWriter();
  w.write(new Uint8Array(buf)); w.close();
  return new Response(cs.readable).arrayBuffer();
}
function download(blob, name) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function save(o) {
  const base = stem(o.vol.file.name);
  let buf = await o.vol.file.arrayBuffer();
  if (!gzipped(buf)) buf = await gzip(buf);
  download(new Blob([buf], { type: 'application/gzip' }), base + '.nii.gz');
  download(new Blob([JSON.stringify(sidecarOf(o), null, 2) + '\n'], { type: 'application/json' }), base + '.json');
}
function changed() {
  if (!(out && out.src === src)) { host.redraw(); return; }
  clearTimeout(timer); timer = setTimeout(make, 50);
}

export default {
  id: 'mask',
  init(h) { host = h; },
  open(opts = {}) { if (opts.vol) src = opts.vol; },
  activate() {},
  deactivate() {},
  needs() {
    const c = candidates();
    return [src && c.includes(src) ? ['✓', 'mask: ' + src.label] : c.length ? ['✗', 'choose the mask volume below'] : ['✗', 'a mask volume (a brain mask: SynthSeg, HD-BET, … — .nii.gz): drop it anywhere']];
  },
  draw(el) {
    el.innerHTML = '';
    const c = candidates();
    if (!c.length) {
      const n = document.createElement('div'); n.className = 'tool-hint';
      n.textContent = 'Load a mask volume (a brain mask from SynthSeg, HD-BET, … — .nii.gz) to get started.';
      el.appendChild(n); return;
    }
    if (!c.includes(src)) src = c.find(v => v.category === 'parcellation' || /mask|brain|bet|seg/i.test(v.file.name)) || c[0];
    el.appendChild(host.ui.choiceRow('mask', c.map((v, i) => [String(i), v.label]), String(c.indexOf(src)),
      val => { src = c[+val]; editing = null; follow(); host.redraw(); }, 'the mask to shape: where it is above the level below (not 0) is inside'));
    // a shaped mask, loaded with its sidecar: made from which file, how — and again from it
    const rc = recipeOf(src);
    if (rc) {
      const parent = host.volumes().find(v => v.file.name === rc.source);
      const L = host.ui.needsList([['i', src.label + ': made from ' + rc.source + ' — ' + recipeText(rc) + ' mm']]);
      el.appendChild(L);
      const rr = document.createElement('div'); rr.className = 'ctl-row';
      if (parent) {
        const ba = document.createElement('button'); ba.className = 'accent-link dt-set-btn'; ba.textContent = 'shape ' + parent.label + ' again with these';
        ba.dataset.tip = 'the settings above, on ' + rc.source + ' (then adjust them)';
        ba.addEventListener('click', () => {
          const shaped = src;   // (made again under its own name: it is replaced)
          src = parent; preset = PRESETS[rc.preset] ? rc.preset : 'custom'; editing = shaped.file.name; follow();
          for (const k of ['level', 'close', 'open', 'smooth', 'offset']) if (Number.isFinite(rc[k])) P[k] = rc[k];
          host.redraw(); make();
        });
        rr.appendChild(ba);
      } else { const n = document.createElement('span'); n.className = 'tool-hint'; n.textContent = 'load ' + rc.source + ' to make it again'; rr.appendChild(n); }
      el.appendChild(rr);
      return;
    }
    const sd = cache.get(src);
    if (sd && !sd.integer) {   // (a probability map: inside above a level)
      if (P.level < sd.min || P.level > sd.max) P.level = sd.min + 0.5 * (sd.max - sd.min);
      el.appendChild(host.ui.sliderRow('inside above', { min: sd.min, max: sd.max, step: (sd.max - sd.min) / 200 || 0.01, value: P.level,
        format: x => String(+(+x).toPrecision(3)), onInput: x => { P.level = x; }, onChange: () => changed() }));
    } else if (!sd) sourceData(src).then(d => { if (!d.integer) host.redraw(); }, () => {});
    else P.level = 0;

    const pr = host.ui.choiceRow('preset', [...Object.keys(PRESETS).map(k => [k, k]), ['custom', 'custom']], preset,
      val => { preset = val; if (PRESETS[val]) { const { tip, ...q } = PRESETS[val]; Object.assign(P, q); } editing = nameFor(src, val); follow(); host.redraw(); changed(); },
      'envelope: ' + PRESETS.envelope.tip + ' · dilate: ' + PRESETS.dilate.tip + ' · erode: ' + PRESETS.erode.tip + ' · smooth: ' + PRESETS.smooth.tip);
    el.appendChild(pr);
    for (const [key, min, max, step, tip] of SLIDERS) {
      const r = host.ui.sliderRow(key, { min, max, step, value: P[key], format: x => (key === 'offset' && x > 0 ? '+' : '') + x + ' mm' + (key === 'smooth' && x > 0 ? ' σ' : ''),
        onInput: x => { P[key] = x; },
        onChange: () => { changed(); host.redraw(); } });   // (made again once the slider is let go: not at every step)
      r.classList.add('dt-helper'); r.dataset.tip = tip;
      el.appendChild(r);
    }

    const row = document.createElement('div'); row.className = 'ctl-row';
    const b = document.createElement('button'); b.className = 'accent-link dt-set-btn';
    follow();
    const made = !!out;
    b.textContent = made ? 'make again' : 'make ' + stem(target());
    b.dataset.tip = 'make ' + stem(target()) + ' (made again in place as you change the sliders; another preset makes another volume)';
    b.addEventListener('click', () => make());
    row.appendChild(b);
    // adjusted: the preset's own values back
    const pv = PRESETS[preset];
    if (pv && ['close', 'open', 'smooth', 'offset'].some(k => P[k] !== pv[k])) {
      const br = document.createElement('button'); br.className = 'accent-link dt-set-btn'; br.textContent = 'reset';
      br.dataset.tip = 'the sliders back to the ' + preset + ' preset: ' + pv.tip;
      br.addEventListener('click', () => { const { tip, ...q } = pv; Object.assign(P, q); host.redraw(); changed(); });
      row.appendChild(br);
    }
    el.appendChild(row);
    if (busy || note) { const n = document.createElement('div'); n.className = 'tool-hint'; n.textContent = note || 'working…'; el.appendChild(n); }

    if (made && host.volumes().includes(out.vol)) {
      const ml = x => (x * out.voxMl).toFixed(0) + ' mL';
      el.appendChild(host.ui.needsList([
        ['✓', out.vol.label + ': ' + ml(out.inside) + ' inside (the mask: ' + ml(out.insideSrc) + ')'],
        ['i', Object.entries(out.params).filter(([k, x]) => k !== 'level' || x).map(([k, x]) => k + ' ' + x + (k === 'level' ? '' : ' mm')).join(' · ')],
      ]));
      const r2 = document.createElement('div'); r2.className = 'ctl-row';
      const bs = document.createElement('button'); bs.className = 'accent-link dt-set-btn'; bs.textContent = 'show it';
      bs.dataset.tip = 'render it (solid, its surface at 0.5) to see the shape — then ANATOMY › surface paint to colour it with vessels or a contrast scan. Show the vessels as an isosurface to see where it should lie.';
      bs.addEventListener('click', () => host.showVolume(out.vol));
      r2.appendChild(bs);
      // the rendered volume masked by it (a scan, say): ANATOMY › masking › apply mask
      const act = host.activeVolume();
      if (act && act !== out.vol && act !== out.src && !act.isColor) {
        const ba = document.createElement('button'); ba.className = 'accent-link dt-set-btn'; ba.textContent = 'apply to ' + act.label;
        const soft = out.params.smooth > 0;
        ba.dataset.tip = 'mask ' + act.label + ' with it (ANATOMY › masking › apply mask: weighted by its value, its smooth edge kept)'
          + (soft ? ' — and the background set to 0, so the surface is the mask\'s own smooth edge' : '');
        ba.addEventListener('click', () => host.applyMask(out.vol, { background0: soft }));
        r2.appendChild(ba);
      }
      const bv = document.createElement('button'); bv.className = 'accent-link dt-set-btn'; bv.textContent = 'save';
      bv.dataset.tip = 'download ' + stem(out.vol.file.name) + '.nii.gz and its sidecar ' + stem(out.vol.file.name) + '.json (the source and the settings: loaded again, it is a soft mask again, and can be made again from its source)';
      bv.addEventListener('click', () => save(out).catch(e => alert('Saving the mask: ' + ((e && e.message) || e))));
      r2.appendChild(bv); el.appendChild(r2);
    }
  },
  state() { return src ? { mask: src.file.name, preset, ...P } : null; },
};
