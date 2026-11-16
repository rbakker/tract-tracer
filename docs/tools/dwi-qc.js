// ── tools/dwi-qc.js ───────────────────────────────────────
// DWI QUALITY CONTROL — a tool (tools.md): checks of a diffusion series
// and its gradient table before processing. Loaded when first picked in
// TOOLS (or when a DWI's row needs its mark); talks to the app only
// through the host object it gets in init().
//
// The report: counts, shells, directions, the sidecar's acquisition facts,
// header notes — ✓ fine · ! worth a look · ✗ a problem · i information.
// On request: the gradient directions as markers, a signal check (dropout
// slices; js/signal-worker.js), a tensor fit (FA, MD, DEC, direction lines
// and the orientation check of the .bvec; js/tensor-worker.js). What it
// makes is added as ordinary volumes, markers and streamlines.

import { GRAPH_PROFILE } from '../js/graph-io.js';

let host = null;
let qcToolVol = null;   // the series the tool shows

// a DWI: a volume with a gradient table, a 4D scan, or one named as a DWI (sub-01_dwi.nii.gz)
const dwiVolumes = () => host.volumes().filter(v => v.grad || (v.nvol > 1 && !v.isColor) || /(^|[_\-.])dwi([_\-.]|$)/i.test(v.file.name));
function qcToolVolume() { const vs = dwiVolumes(); if (!vs.includes(qcToolVol)) qcToolVol = vs.find(v => v.grad) || vs[0] || null; return qcToolVol; }

export default {
  id: 'dwi-qc',
  init(h) { host = h; },
  // opened with { vol }: that series
  open(opts = {}) { if (opts.vol) qcToolVol = opts.vol; },
  activate() {}, deactivate() {},
  // the worst of a series' report: 0 fine, 1 worth a look, 2 a problem (the mark on its row in ANATOMY)
  worst(vol) { return qcWorst(vol); },
  // the checklist: for the chosen series, its files
  needs() {
    const v = qcToolVolume();
    if (!v) return [];   // (the tool says what to load)
    const g = v.grad || {}, f = g.files || {}, base = host.lib.volumeBaseName(v.file.name);
    return [
      g.bvals ? ['✓', '.bval: ' + (f.bval || 'b-values')] : ['✗', 'missing .bval file (' + base + '.bval)'],
      g.bvecs ? ['✓', '.bvec: ' + (f.bvec || 'directions')] : ['✗', 'missing .bvec file (' + base + '.bvec)'],
      v.sidecar ? ['✓', '.json sidecar: ' + v.sidecar.name] : ['–', 'no .json sidecar (optional: ' + base + '.json, for the phase encoding and readout time)'],
    ];
  },
  // Nothing loaded: what to load. Otherwise the DWI series in a list (all
  // of them, even one), what's missing (only then), and the chapters.
  draw(el) {
    el.innerHTML = '';
    const vs = dwiVolumes(), v = qcToolVolume();
    if (!v) {
      const n = document.createElement('div'); n.className = 'tool-hint';
      n.textContent = 'Load a DWI file (.nii.gz) with its .bval and .bvec gradient files, and optionally its .json sidecar, to get started.';
      el.appendChild(n); return;
    }
    const pick = host.ui.choiceRow('DWI volume', vs.map((x, i) => [String(i), x.label]), String(vs.indexOf(v)),
      val => { qcToolVol = vs[+val]; host.redraw(); }, 'which DWI series to check (all loaded DWI files)');
    pick.classList.add('qc-series');
    el.appendChild(pick);
    const needs = this.needs();
    if (needs.some(([st]) => st === '✗')) { el.appendChild(host.ui.needsList(needs.filter(([st]) => st !== '✓'))); return; }
    buildQcPanel(v, el);
  },
};

function qcReport(vol) {
  const L = [];   // [status, text]
  const g = vol.grad, n = vol.nvol || 1, h = vol.niiHeader || {};
  const nb = g.bvals ? g.bvals.length : null, nv = g.bvecs ? g.bvecs.length : null;
  // counts
  if (nb == null) L.push(['✗', 'no .bval (b-values) file']);
  if (nv == null) L.push(['✗', 'no .bvec (directions) file']);
  const cnt = [n + ' frames', nb != null ? nb + ' b-values' : null, nv != null ? nv + ' directions' : null].filter(Boolean).join(' · ');
  L.push([(nb == null || nb === n) && (nv == null || nv === n) ? '✓' : '✗', cnt]);
  if (nb == null) return L;
  // shells
  const shells = host.lib.shellsOf(g.bvals);
  L.push(['✓', 'shells: ' + shells.map(s => 'b=' + s.b + ' ×' + s.idx.length).join(' · ')]);
  const b0 = shells.find(s => s.b0);
  if (!b0) L.push(['✗', 'no b=0 volume']);
  else {
    const pos = b0.idx;
    const spread = pos.length > 1 && pos[pos.length - 1] - pos[0] > n / 2;
    L.push([pos.length === 1 ? '!' : '✓', 'b=0 at frame' + (pos.length > 1 ? 's ' : ' ') + host.lib.compactList(pos)
      + (pos.length === 1 ? ' — only one: no check of signal drift' : spread ? ' — spread through the series' : ' — not spread through the series (drift is harder to correct)')]);
  }
  // directions
  if (nv != null && nv === nb) {
    let bad = 0, zero = 0;
    g.bvecs.forEach((d, i) => {
      const len = Math.hypot(d[0], d[1], d[2]);
      if (g.bvals[i] <= host.lib.B0_MAX) { if (len > 0.01 && Math.abs(len - 1) > 0.01) bad++; }
      else if (len < 0.01) zero++; else if (Math.abs(len - 1) > 0.01) bad++;
    });
    if (zero) L.push(['✗', zero + ' diffusion-weighted frame' + (zero > 1 ? 's have' : ' has') + ' no direction (zero vector)']);
    L.push([bad ? '!' : '✓', bad ? bad + ' direction' + (bad > 1 ? 's are' : ' is') + ' not of unit length (scaled b-values?)' : 'directions of unit length']);
    for (const s of shells) if (!s.b0) {
      const dirs = s.idx.map(i => g.bvecs[i]).map(d => { const l = Math.hypot(...d) || 1; return d.map(x => x / l); });
      let dup = 0, minAng = 180;
      for (let a = 0; a < dirs.length; a++) for (let c = a + 1; c < dirs.length; c++) {
        const cos = Math.min(1, Math.abs(dirs[a][0] * dirs[c][0] + dirs[a][1] * dirs[c][1] + dirs[a][2] * dirs[c][2]));
        const ang = Math.acos(cos) * 180 / Math.PI;
        if (ang < 1) dup++; if (ang < minAng) minAng = ang;
      }
      const uniq = dirs.length - dup;
      L.push([dup ? '!' : uniq < 6 ? '✗' : uniq < 15 ? '!' : '✓', 'b=' + s.b + ': ' + uniq + ' distinct direction' + (uniq > 1 ? 's' : '') + (dup ? ' (' + dup + ' repeated)' : '')
        + ' · closest pair ' + minAng.toFixed(1) + '°' + (uniq < 6 ? ' — too few for a tensor' : uniq < 15 ? ' — few: a tensor fit only' : '')
        + (dup ? ' — directions should be evenly spread' : '')]);
      // how well the directions pin down a tensor: the condition number of
      // its design matrix (rows x², y², z², 2xy, 2xz, 2yz); ≈1.3–1.6 for evenly spread directions
      if (uniq >= 6) {
        const c = tensorCondition(dirs);
        L.push([c <= 2.5 ? '✓' : c <= 5 ? '!' : '✗', 'b=' + s.b + ': condition number ' + (isFinite(c) ? c.toFixed(2) : '∞')
          + (c <= 2.5 ? ' — evenly spread' : c <= 5 ? ' — unevenly spread: some tensor orientations are poorly measured' : ' — directions cluster: a tensor is poorly determined')]);
      }
    }
  }
  // the sidecar (BIDS JSON)
  const js = vol._sidecarJson;
  if (!vol.sidecar) L.push(['!', 'no JSON sidecar: phase encoding and readout time unknown (needed by topup / eddy)']);
  else if (js === null) L.push(['✗', vol.sidecar.name + ': not readable JSON']);
  else if (js) {
    const pe = js.PhaseEncodingDirection, trt = js.TotalReadoutTime, es = js.EffectiveEchoSpacing;
    L.push([pe ? '✓' : '!', 'phase encoding: ' + (pe || 'not given') + (js.PhaseEncodingAxis && !pe ? ' (axis ' + js.PhaseEncodingAxis + ', polarity unknown)' : '')]);
    L.push([trt || es ? '✓' : '!', trt ? 'total readout time ' + trt + ' s' : es ? 'effective echo spacing ' + es + ' s' : 'no readout time (TotalReadoutTime / EffectiveEchoSpacing)']);
    if (js.SliceTiming) L.push(['✓', 'slice timing given (' + js.SliceTiming.length + ' slices)' + (js.MultibandAccelerationFactor ? ' · multiband ×' + js.MultibandAccelerationFactor : '')]);
    // A reverse phase-encoded b=0 is a separate file (BIDS: fmap/…_dir-…_epi.nii.gz, its
    // IntendedFor naming this series): only the LOADED host.volumes() can be checked — their
    // sidecars give the polarity. Not finding one is information, not a fault: the
    // session may have it unloaded, and fieldmap-less correction (QSIPrep's SyN-SDC) exists.
    if (pe) {
      const opp = pe.endsWith('-') ? pe.slice(0, -1) : pe + '-';
      const me = vol.file.name;
      const intended = j => [].concat(j.IntendedFor || []).some(x => String(x).split('/').pop() === me);
      const rev = host.volumes().filter(v => v !== vol && v._sidecarJson && v._sidecarJson.PhaseEncodingDirection === opp);
      const fmap = host.volumes().filter(v => v !== vol && v._sidecarJson && intended(v._sidecarJson) && !rev.includes(v));
      if (rev.length) L.push(['✓', 'reverse phase encoding (' + opp + '): ' + rev.map(v => v.label + (intended(v._sidecarJson) ? ' (intended for this series)' : '')).join(', ')]);
      else if (fmap.length) L.push(['✓', 'field map intended for this series: ' + fmap.map(v => v.label).join(', ')]);
      else L.push(['i', 'no reverse phase-encoded b=0 (' + opp + ') or field map among the loaded files — if the session has one (BIDS: fmap/), load it to include it here. Without one, correction is fieldmap-less (e.g. SyN-SDC) and less accurate']);
    }
  }
  // header notes
  // free text in the header: scanner notes ("TE=84;Time=…") are harmless, anything else may name someone
  const htext = [h.descrip, h.auxFile].filter(Boolean).join(' / ');
  if (htext) {
    // notes: key=value pairs, or no words at all (a version number, a date)
    const notes = !h.auxFile && (/^\s*([A-Za-z][\w.]*\s*=\s*[^;=]*;?\s*)+$/.test(h.descrip || '') || !/[A-Za-z]{3,}/.test(h.descrip || ''));
    L.push(notes ? ['i', 'header notes "' + htext + '"'] : ['!', 'header text "' + htext + '" — check it identifies no one']);
  }
  return L;
}
// eigenvalues of a symmetric matrix (Jacobi rotations; small n)
function symEigenvalues(M) {
  const n = M.length, a = M.map(r => r.slice());
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
    }
  }
  return a.map((r, i) => r[i]);
}
function tensorCondition(dirs) {
  const B = dirs.map(([x, y, z]) => [x * x, y * y, z * z, 2 * x * y, 2 * x * z, 2 * y * z]);
  const BtB = [0, 1, 2, 3, 4, 5].map(i => [0, 1, 2, 3, 4, 5].map(j => B.reduce((s, r) => s + r[i] * r[j], 0)));
  const ev = symEigenvalues(BtB).map(v => Math.max(0, v));
  const mx = Math.max(...ev), mn = Math.min(...ev);
  return mn > 1e-12 * mx ? Math.sqrt(mx / mn) : Infinity;
}

// The gradient directions in world (RAS) space. FSL's convention: bvecs
// are along the image's voxel axes, as if stored radiologically — when
// the voxel → world matrix has a positive determinant (neurological
// storage) the x component is negated first.
function gradientDirsWorld(vol) {
  const A = vol.Ab, g = vol.grad;
  if (!A || !g || !g.bvecs) return null;
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const col = c => Math.hypot(A[0][c], A[1][c], A[2][c]) || 1;
  const vs = [col(0), col(1), col(2)];
  return g.bvecs.map(d => {
    const v = [det > 0 ? -d[0] : d[0], d[1], d[2]];
    const w = [0, 1, 2].map(r => A[r][0] * v[0] / vs[0] + A[r][1] * v[1] / vs[1] + A[r][2] * v[2] / vs[2]);
    const l = Math.hypot(...w);
    return l > 1e-6 ? w.map(x => x / l) : null;
  });
}

// Markers made in memory: any graph package (graph-format.md) added as
// if it were a dropped file (a real File, so it can be saved as well).

const SHELL_COLORS = [[255, 140, 40], [80, 170, 255], [120, 220, 110], [235, 90, 200], [250, 230, 80], [160, 120, 255]];

// Convex hull of points (incremental; for points on a sphere: its
// Delaunay triangulation). Returns triangles as index triples. Points
// closer than 1e-6 count once (the first).
function convexHull3(P) {
  const n = P.length, sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const EPS = 1e-9;
  // a first tetrahedron
  let i0 = 0, i1 = -1, i2 = -1, i3 = -1;
  for (let i = 1; i < n && i1 < 0; i++) if (Math.hypot(...sub(P[i], P[i0])) > 1e-6) i1 = i;
  for (let i = 1; i < n && i2 < 0 && i1 >= 0; i++) if (Math.hypot(...cross(sub(P[i1], P[i0]), sub(P[i], P[i0]))) > 1e-6) i2 = i;
  for (let i = 1; i < n && i3 < 0 && i2 >= 0; i++) if (Math.abs(dot(cross(sub(P[i1], P[i0]), sub(P[i2], P[i0])), sub(P[i], P[i0]))) > 1e-6) i3 = i;
  if (i3 < 0) return [];
  const faces = [];
  const addFace = (a, b, c) => { const nrm = cross(sub(P[b], P[a]), sub(P[c], P[a])); faces.push({ v: [a, b, c], n: nrm, d: dot(nrm, P[a]), live: true }); };
  const cen = [0, 1, 2].map(k => (P[i0][k] + P[i1][k] + P[i2][k] + P[i3][k]) / 4);
  for (const [a, b, c] of [[i0, i1, i2], [i0, i1, i3], [i0, i2, i3], [i1, i2, i3]]) {
    const nrm = cross(sub(P[b], P[a]), sub(P[c], P[a]));
    if (dot(nrm, sub(cen, P[a])) > 0) addFace(a, c, b); else addFace(a, b, c);
  }
  const used = new Set([i0, i1, i2, i3]);
  for (let p = 0; p < n; p++) {
    if (used.has(p)) continue;
    if ([...used].some(q => Math.hypot(...sub(P[p], P[q])) < 1e-6)) continue;   // a repeat
    const vis = faces.filter(f => f.live && dot(f.n, P[p]) - f.d > EPS);
    if (!vis.length) continue;
    const edges = new Map();
    for (const f of vis) { f.live = false; for (let k = 0; k < 3; k++) { const a = f.v[k], b = f.v[(k + 1) % 3]; edges.set(a + ',' + b, [a, b]); } }
    for (const [key, [a, b]] of edges) if (!edges.has(b + ',' + a)) addFace(a, b, p);
    used.add(p);
  }
  return faces.filter(f => f.live).map(f => f.v);
}

// The diffusion directions on a sphere around the brain (per shell a
// sphere of its own, radius ∝ √b: q-space), one marker per measured
// direction, colored per shell; frame and b-value as properties (color by
// frame: the acquisition order). The sphere's triangulation as links: a
// direction and its opposite measure the same, so the triangulation is
// that of the directions AND their antipodes — the antipodes get no
// marker, only the mesh reaches them. Even triangles: even coverage; a
// large one: a gap; a repeat: no new vertex.
function gradientMarkersJson(vol) {
  const dirs = gradientDirsWorld(vol), g = vol.grad;
  if (!dirs || !g.bvals || g.bvals.length !== dirs.length || !vol.box) return null;
  const c = [0, 1, 2].map(k => (vol.box.min[k] + vol.box.max[k]) / 2);
  const R0 = 0.42 * Math.max(...[0, 1, 2].map(k => vol.box.max[k] - vol.box.min[k]));   // just around the brain
  const shells = host.lib.shellsOf(g.bvals).filter(s => !s.b0);
  const bmax = Math.max(...shells.map(s => s.b), 1);
  const rows = [], links = [];
  shells.forEach(sh => {
    const R = R0 * Math.sqrt(sh.b / bmax), name = 'b=' + sh.b;
    const idx = sh.idx.filter(i => dirs[i]);
    const at = (d, sg) => [0, 1, 2].map(k => +(c[k] + sg * R * d[k]).toFixed(3));
    // vertices: each direction (+) and its antipode (−)
    const verts = [];
    for (const i of idx) for (const sg of [1, -1]) {
      const id = i + (sg > 0 ? '' : ' (antipode)');
      verts.push({ id, p: dirs[i].map(x => sg * x) });
      rows.push([id, ...at(dirs[i], sg), i, Math.round(g.bvals[i]), name, sg > 0 ? 'measured' : 'antipode']);
    }
    // the triangulation's edges; an edge's length against the shell's mean
    // ("stretch") shows the coverage: > 1 a gap, < 1 a cluster. Edges to an
    // antipode are drawn neutral: they are not measured directions.
    const seen = new Set(), edges = [];
    for (const t of convexHull3(verts.map(v => v.p))) for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], key = Math.min(a, b) + ',' + Math.max(a, b);
      if (seen.has(key)) continue; seen.add(key);
      edges.push([a, b, Math.hypot(...[0, 1, 2].map(q => verts[a].p[q] - verts[b].p[q]))]);
    }
    const mean = edges.reduce((s, e) => s + e[2], 0) / (edges.length || 1);
    for (const [a, b, len] of edges) {
      const measured = !verts[a].id.includes('antipode') && !verts[b].id.includes('antipode');
      const st = +(len / mean).toFixed(3);
      links.push([verts[a].id, verts[b].id, measured ? st : null, measured ? +Math.abs(st - 1).toFixed(3) : 0, measured ? 'measured' : 'to an antipode']);
    }
  });
  // a graph package (graph-format.md): the directions as a point table, the edges as a link table
  const stem = vol.label.replace(/\.(nii\.gz|nii)$/i, '');
  return {
    $schema: GRAPH_PROFILE,
    name: (stem + '-gradient-directions').toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
    title: stem + ' · gradient directions',
    description: 'The diffusion directions of ' + vol.label + ' on a sphere around the brain (one per shell, radius ∝ √b), with the triangulation of the directions and their antipodes. Made by the quality control.',
    resources: [
      { name: 'directions', type: 'table',
        data: [['id', 'x', 'y', 'z', 'frame', 'b', 'shell', 'kind'], ...rows],
        schema: {
          fields: [
            { name: 'id', type: 'string' },
            { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' },
            { name: 'frame', type: 'integer', description: 'the frame (acquisition order)' },
            { name: 'b', type: 'number', unit: 's/mm²', description: 'b-value' },
            { name: 'shell', type: 'string', description: 'the shell', categoriesOrdered: true,
              categories: shells.map((s, k) => ({ value: 'b=' + s.b, color: SHELL_COLORS[k % SHELL_COLORS.length] })) },
            { name: 'kind', type: 'string', description: 'a measured direction, or the opposite point (the same measurement: no marker, only the mesh)',
              categories: [{ value: 'measured', size: 1 }, { value: 'antipode', size: 0.001 }] },
          ],
          primaryKey: ['id'],
        },
        geometry: { point: ['x', 'y', 'z'], space: 'the world space of ' + vol.label, units: 'mm' },
        style: { color_by: 'shell', size_by: 'kind', size_mm: +(R0 * 0.06).toFixed(2), aggregate: 'none' } },   // (every direction its own marker: bunching is what it shows)
      { name: 'edges', type: 'table',
        data: [['from', 'to', 'stretch', 'deviation', 'edge'], ...links],
        schema: {
          fields: [
            { name: 'from', type: 'string' }, { name: 'to', type: 'string' },
            { name: 'stretch', type: 'number', range: [0.3, 1.7], description: 'edge length / the shell\'s mean edge length: > 1 a gap in the coverage, < 1 directions bunched together' },
            { name: 'deviation', type: 'number', range: [0.1, 0.7], description: '|stretch − 1|: how far from even' },
            { name: 'edge', type: 'string', description: 'between two measured directions, or to an antipode (not a measurement)', categories: ['measured', 'to an antipode'] },
          ],
          foreignKeys: [{ fields: ['from'], reference: { resource: 'directions', fields: ['id'] } },
                        { fields: ['to'], reference: { resource: 'directions', fields: ['id'] } }],
        },
        style: { color_by: 'stretch', colormap: 'coolwarm', color: [110, 128, 155], width_by: 'deviation', width_px: [1, 5], opacity: 0.8 } },
    ],
  };
}
function showGradientMarkers(vol) {
  const json = gradientMarkersJson(vol);
  if (!json) { alert('The gradient directions need the volume\'s .bval and .bvec, and the volume read once.'); return; }
  const old = host.markerSets().find(m => m.dwiOf === vol);
  if (old) host.removeMarkers(old, false);
  host.addMarkers(json.title, json).then(rec => { if (rec) rec.dwiOf = vol; host.refresh(); });
}


// ── TENSOR FIT (quality control: the orientation check) ──────
// In its own worker (js/tensor-worker.js), started only when asked for.
// Results: FA, MD and DEC host.volumes(), the principal directions as short line
// segments (a tractogram), and the orientation check in the report.
async function fitTensors(vol) {
  const g = vol.grad;
  if (!g || !g.bvals || !g.bvecs || !vol.Ab) return;
  const A = vol.Ab;
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const vs = [0, 1, 2].map(c => Math.hypot(A[0][c], A[1][c], A[2][c]) || 1);
  const w = new Worker(new URL('../js/tensor-worker.js', import.meta.url), { type: 'module' });
  vol.tensorFit = { running: true, progress: 0 };
  host.refresh();
  w.onmessage = e => {
    const m = e.data;
    if ('progress' in m) { vol.tensorFit.progress = m.progress; const el = document.getElementById('qc-fit-progress'); if (el) el.textContent = 'fitting tensors… ' + Math.round(100 * m.progress) + '%'; return; }
    w.terminate();
    if (m.error) { vol.tensorFit = { error: m.error }; host.refresh(); return; }
    const { shape, fa, md, v1, mask, scores, nFit, nSeeds, bShell, nUsed, nb0 } = m;
    const n = fa.length, stem = host.lib.volumeBaseName(vol.file.name);
    // V1 in world space (for the colors and the lines)
    const W = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const u = [v1[3 * i] / vs[0], v1[3 * i + 1] / vs[1], v1[3 * i + 2] / vs[2]];
      const x = A[0][0] * u[0] + A[0][1] * u[1] + A[0][2] * u[2], y = A[1][0] * u[0] + A[1][1] * u[1] + A[1][2] * u[2], z = A[2][0] * u[0] + A[2][1] * u[1] + A[2][2] * u[2];
      const l = Math.hypot(x, y, z) || 1;
      W[3 * i] = x / l; W[3 * i + 1] = y / l; W[3 * i + 2] = z / l;
    }
    const dec = new Float32Array(3 * n);   // three frames: |V1| per world axis × FA
    for (let i = 0; i < n; i++) { dec[i] = Math.abs(W[3 * i]) * fa[i]; dec[n + i] = Math.abs(W[3 * i + 1]) * fa[i]; dec[2 * n + i] = Math.abs(W[3 * i + 2]) * fa[i]; }
    const made = [
      host.addVolume(stem + '_FA.nii', { data: fa, shape, Ab: A, description: 'FA (tensor fit, quality control)' }),
      host.addVolume(stem + '_MD.nii', { data: md, shape, Ab: A, description: 'MD um2/ms = 1e-3 mm2/s (tensor fit, quality control)' }),
      host.addVolume(stem + '_DEC.nii', { data: dec, shape, Ab: A, nvol: 3, description: 'DEC: |V1| x FA (tensor fit, quality control)' }),
    ];
    // the principal directions: a short line through each voxel with FA ≥ 0.2
    const half = 0.45 * Math.min(...vs), lines = [];
    const [nx, ny] = shape;
    for (let i = 0; i < n; i++) {
      if (!mask[i] || fa[i] < 0.2) continue;
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      const c = [0, 1, 2].map(r => A[r][0] * x + A[r][1] * y + A[r][2] * z + A[3][r]);
      const d = [W[3 * i] * half, W[3 * i + 1] * half, W[3 * i + 2] * half];
      lines.push(new Float32Array([c[0] - d[0], c[1] - d[1], c[2] - d[2], c[0] + d[0], c[1] + d[1], c[2] + d[2]]));
    }
    if (lines.length) host.addTractogram(stem + '_V1.tck', lines, 'tensor V1, FA >= 0.2', { ends: false, color: 'ras' });   // (by direction, as the DEC map)
    let faSum = 0, faN = 0; for (let i = 0; i < n; i++) if (mask[i]) { faSum += fa[i]; faN++; }
    vol.tensorFit = { maskName: w._maskName, scores, nFit, nSeeds, bShell, nUsed, nb0, nLines: lines.length, meanFa: faN ? faSum / faN : 0, made: made.map(v => v.label), tck: lines.length ? stem + '_V1.tck' : null };
    host.refresh();
  };
  w.onerror = e => { vol.tensorFit = { error: e.message || 'the worker failed' }; host.refresh(); };
  let mask = null;
  try { mask = await qcMaskData(vol); } catch (err) { w.terminate(); vol.tensorFit = { error: String(err) }; host.refresh(); return; }
  w._maskName = vol.qcMask ? vol.qcMask.label : null;
  w.postMessage({ file: vol.file, bvals: g.bvals, bvecs: g.bvecs, voxMm: vs, flipX: det > 0, si: siAxisOf(vol), mask });
}
// ── SIGNAL CHECK (quality control, on the raw series) ──────
// In its own worker (js/signal-worker.js): per frame and slice the mean
// brain signal against the rest of its shell; dropout slices and frames
// whose signal is off. Results: report lines, a clickable list (shows that
// frame at that slice) and a volume of the signal lost in those slices, per
// voxel (%): where in the slice it went.
// the voxel axis most along inferior–superior, and whether its index grows upward (for the brain mask's neck cut)
function siAxisOf(vol) {
  const A = vol.Ab; if (!A) return null;
  let best = 2, bv = -1;
  for (let c = 0; c < 3; c++) { const v = Math.abs(A[2][c]) / (Math.hypot(A[0][c], A[1][c], A[2][c]) || 1); if (v > bv) { bv = v; best = c; } }
  return { axis: best, up: A[2][best] > 0 };
}
function sliceAxisOf(vol) {
  const h = vol.niiHeader || {}, A = vol.Ab;
  if (h.sliceDim >= 1 && h.sliceDim <= 3) return h.sliceDim - 1;
  if (!A) return 2;
  let best = 2, bv = -1;   // the voxel axis most along S–I (axial slices, the usual)
  for (let c = 0; c < 3; c++) { const v = Math.abs(A[2][c]) / (Math.hypot(A[0][c], A[1][c], A[2][c]) || 1); if (v > bv) { bv = v; best = c; } }
  return best;
}
// The chosen precomputed mask on the series' grid (nearest voxel; above 0 is
// brain), or null (the workers then make their own).
async function qcMaskData(vol) {
  const mv = vol.qcMask;
  if (!mv || !vol.Ab || !vol.gridShape) return null;
  const p = await host.readVolume(mv.file);
  const [nx, ny, nz] = vol.gridShape, A = vol.Ab, B = p.invAb, [mx, my, mz] = p.shape;
  const out = new Uint8Array(nx * ny * nz);
  let any = 0;
  for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
    const w = [0, 1, 2].map(r => A[r][0] * x + A[r][1] * y + A[r][2] * z + A[3][r]);
    const q = [0, 1, 2].map(r => Math.round(B[r][0] * w[0] + B[r][1] * w[1] + B[r][2] * w[2] + B[3][r]));
    if (q[0] < 0 || q[1] < 0 || q[2] < 0 || q[0] >= mx || q[1] >= my || q[2] >= mz) continue;
    if (p.data[q[0] + mx * (q[1] + my * q[2])] > 0) { out[i] = 1; any++; }
  }
  if (!any) throw 'the mask "' + mv.label + '" has no voxel inside this series';
  return out;
}
async function checkSignal(vol) {
  const g = vol.grad;
  if (!g || !g.bvals || !vol.Ab) return;
  const axis = sliceAxisOf(vol);
  const w = new Worker(new URL('../js/signal-worker.js', import.meta.url), { type: 'module' });
  vol.signalCheck = { running: true, progress: 0 };
  host.refresh();
  w.onmessage = e => {
    const m = e.data;
    if ('progress' in m) { vol.signalCheck.progress = m.progress; const el = document.getElementById('qc-sig-progress'); if (el) el.textContent = 'checking the signal… ' + Math.round(100 * m.progress) + '%'; return; }
    w.terminate();
    if (m.error) { vol.signalCheck = { error: m.error }; host.refresh(); return; }
    const { shape, nSlices, mask, loss, slices, frames, groups, nChecked } = m;
    // the volume: per voxel of a flagged slice, the signal lost there, in % (the largest over the frames)
    const data = new Float32Array(loss.length);
    for (let i = 0; i < loss.length; i++) data[i] = Math.round(1000 * loss[i]) / 10;
    const made = slices.length ? [host.addVolume(host.lib.volumeBaseName(vol.file.name) + '_dropout.nii', { data, shape, Ab: vol.Ab, description: 'signal lost in dropout slices, % (quality control)' }).label] : [];
    vol.signalCheck = { slices, frames, groups, nChecked, nSlices, axis, made, maskName: w._maskName };
    host.refresh();
  };
  w.onerror = e => { vol.signalCheck = { error: e.message || 'the worker failed' }; host.refresh(); };
  let mask = null;
  try { mask = await qcMaskData(vol); } catch (err) { w.terminate(); vol.signalCheck = { error: String(err) }; host.refresh(); return; }
  vol.signalCheck.maskName = vol.qcMask ? vol.qcMask.label : null;
  const maskName = vol.signalCheck.maskName;
  w.postMessage({ file: vol.file, bvals: g.bvals, sliceAxis: axis, si: siAxisOf(vol), mask });
  w._maskName = maskName;
}

function signalReportLines(vol) {
  const s = vol.signalCheck, L = [];
  if (!s || s.running) return L;
  if (s.error) { L.push(['✗', 'signal check: ' + s.error]); return L; }
  L.push(['i', 'brain mask: ' + (s.maskName ? s.maskName : 'its own (from the series)')]);
  for (const g of s.groups) if (!g.checked) L.push(['i', (g.b ? 'b=' + g.b : 'b=0') + ': ' + g.n + ' frame' + (g.n > 1 ? 's' : '') + ' — too few to compare (4 needed)']);
  const nFr = new Set(s.slices.map(x => x.frame)).size, strong = s.slices.filter(x => x.loss >= 0.4).length;
  if (!s.slices.length) L.push(['✓', 'no slice lost signal (' + s.nChecked.toLocaleString() + ' slices compared)']);
  else L.push([strong ? '✗' : '!', s.slices.length + ' slice' + (s.slices.length > 1 ? 's' : '') + ' in ' + nFr + ' frame' + (nFr > 1 ? 's' : '') + ' lost signal'
    + (strong ? ' (' + strong + ' by 40% or more)' : ' (20–40%)') + ':']);
  for (const f of s.frames.slice(0, 8)) {
    const g = s.groups.find(x => x.idx ? x.idx.includes(f.frame) : false);
    L.push(['!', 'frame ' + f.frame + ': its whole brain ' + Math.abs(Math.round(100 * f.dev)) + '% ' + (f.dev > 0 ? 'brighter' : 'darker') + ' than the other frames of its shell' + (g ? ' (b=' + g.b + ')' : ''), 'frame']);
  }
  return L;
}

function tensorReportLines(vol) {
  const t = vol.tensorFit, L = [];
  if (!t || t.running) return L;
  if (t.error) { L.push(['✗', 'tensor fit: ' + t.error]); return L; }
  const s = t.scores, given = s.find(x => x.name === 'as given'), best = s[0], next = s.find(x => x !== best);
  if (!given || !best) return L;
  // a fit that found (almost) no anisotropy: nothing to check orientations with
  if (t.meanFa < 0.05) L.push(['✗', 'the fit finds almost no anisotropy (mean FA ' + t.meanFa.toFixed(3) + ' in the brain) — check the b-values and the scale of the data']);
  if (!t.nSeeds || best.score < 1) {
    L.push(['✗', 'orientation check not possible: ' + (t.nSeeds ? 'no tracks could be followed' : 'no white matter found (no voxel with FA > 0.4)')]);
  } else if (best === given) {
    const ratio = next ? given.score / Math.max(next.score, 1e-6) : Infinity;
    L.push([ratio >= 1.15 ? '✓' : '!', 'orientation check: the table as given gives the longest tracks (' + given.score.toFixed(1) + ' mm; next "' + next.name + '" ' + next.score.toFixed(1) + ' mm)'
      + (ratio < 1.15 ? ' — a narrow margin: look at the DEC map and the direction lines' : '')]);
  } else {
    L.push(['✗', 'orientation check: "' + best.name + '" gives longer tracks than the table as given (' + best.score.toFixed(1) + ' vs ' + given.score.toFixed(1) + ' mm) — the .bvec looks ' + (best.name.includes('swap') || best.name.includes('→') ? 'swapped' : 'flipped') + '; check the DEC map and the direction lines']);
  }
  if (!t.nLines) L.push(['!', 'no direction lines: no voxel with FA ≥ 0.2']);
  L.push(['i', 'tensor fit of ' + t.nFit.toLocaleString() + ' brain voxels (mask: ' + (t.maskName || 'its own') + ')' + (t.bShell ? ' from b=0 ×' + t.nb0 + ' and b=' + t.bShell + ' ×' + t.nUsed + (host.lib.shellsOf(vol.grad.bvals).filter(x => !x.b0).length > 1 ? ' (the lowest shell)' : '') : '')
    + (t.nLines ? ', ' + t.nLines.toLocaleString() + ' direction lines (FA ≥ 0.2)' : '')]);
  return L;
}


// the sidecars (each one's, and the others' for a reverse phase-encoded b=0): read once, then redrawn
function readQcSidecars() {
  const unread = host.volumes().filter(v => v.sidecar && v._sidecarJson === undefined);
  if (unread.length) Promise.all(unread.map(host.readSidecar)).then(() => host.refresh());
}
// the worst of the report: 0 fine, 1 worth a look, 2 a problem ('i': information only)
const qcWorst = vol => [...qcReport(vol), ...signalReportLines(vol), ...tensorReportLines(vol)].reduce((w, [st]) => st === '✗' ? 2 : st === '!' ? Math.max(w, 1) : w, 0);
// The report and its actions (the tool's body), into d.
// The chapters: each a folded section (the 3D tab's style); opened, it
// runs (the report, the gradient markers) or shows its settings and a
// run button (the outlier detection, the tensor fit), then its results.
const chapterOpen = { report: true, dirs: false, outliers: false, tensor: false };
function buildQcPanel(vol, d) {
  readQcSidecars();
  const chapter = (key, title, tip, fill) => {
    const h = document.createElement('div'); h.className = 'cfg-section cfg-fold' + (chapterOpen[key] ? ' open' : '');
    h.textContent = title; h.dataset.tip = tip + ' Click to open or close.';
    h.addEventListener('click', () => { chapterOpen[key] = !chapterOpen[key]; host.redraw(); });
    d.appendChild(h);
    if (!chapterOpen[key]) return;
    const body = document.createElement('div'); body.className = 'cfg-fold-body qc-body';
    fill(body);
    d.appendChild(body);
  };
  const lines = (body, L, cls = '') => { for (const [st, text] of L) {
    const r = document.createElement('div'); r.className = 'qc-line' + cls;
    const i = document.createElement('span'); i.className = 'qc-st qc-' + (st === '✗' ? 2 : st === '!' ? 1 : st === 'i' ? 'i' : 0); i.textContent = st;
    const t = document.createElement('span'); t.textContent = text;
    r.append(i, t); body.appendChild(r);
  } };
  const actRow = (body, label, tip, onClick) => {
    const r = document.createElement('div'); r.className = 'qc-line qc-act-row';
    const bt = document.createElement('button'); bt.className = 'qc-act';
    bt.textContent = label; bt.dataset.tip = tip; bt.addEventListener('click', onClick);
    r.append(Object.assign(document.createElement('span'), { className: 'qc-st' }), bt);
    body.appendChild(r);
  };
  const created = (body, items) => {   // [[kind, name, show]]: what was made — each name shows that item
    if (!items.length) return;
    const r = document.createElement('div'); r.className = 'qc-line qc-made';
    r.append(Object.assign(document.createElement('span'), { className: 'qc-st' }), Object.assign(document.createElement('span'), { textContent: 'created:' }));
    body.appendChild(r);
    for (const [kind, name, show] of items) {
      const it = document.createElement('div'); it.className = 'qc-line qc-made-item';
      const bt = document.createElement('button'); bt.className = 'qc-act';
      bt.textContent = kind + ' ' + name; bt.dataset.tip = 'show ' + name;
      bt.addEventListener('click', show);
      it.append(Object.assign(document.createElement('span'), { className: 'qc-st' }), bt);
      body.appendChild(it);
    }
  };
  const running = (body, id, text) => {
    const r0 = document.createElement('div'); r0.className = 'qc-line qc-act-row';
    const el = document.createElement('span'); el.id = id; el.className = 'qc-run'; el.textContent = text;
    r0.append(Object.assign(document.createElement('span'), { className: 'qc-st' }), el); body.appendChild(r0);
  };
  // the brain mask the outlier detection and the tensor fit use: their own
  // (---), or a volume (a mask from HD-BET, the T1, the pipeline) — chosen
  // in each chapter (the same choice), so it's clear which one a result was made with
  const maskRow = body => {
    const cands = host.volumes().filter(v => v !== vol && !v.isColor);
    if (vol.qcMask && !cands.includes(vol.qcMask)) vol.qcMask = null;
    const row = host.ui.choiceRow('brain mask', [['', 'from the series'], ...cands.map((v, i) => [String(i), v.label])],
      vol.qcMask ? String(cands.indexOf(vol.qcMask)) : '', val => { vol.qcMask = val === '' ? null : cands[+val]; host.refresh(); });
    row.classList.add('qc-mask-row');
    row.dataset.tip = 'the brain mask to use: one made from the series itself; or a precomputed mask (any volume: voxels above 0 count as brain), resampled to this grid';
    body.appendChild(row);
  };

  // 1. the report
  chapter('report', 'QUALITY REPORT', 'What can be checked without processing: counts, shells, directions, the sidecar\'s acquisition facts, header notes. ✓ fine · ! worth a look · ✗ a problem · i information.',
    body => lines(body, qcReport(vol)));

  // 2. the gradient directions: made when the chapter opens
  chapter('dirs', 'GRADIENT DIRECTIONS', 'Each diffusion direction as a marker on a sphere around the brain (one per shell, radius ∝ √b), colored per shell, with the sphere\'s triangulation: even triangles, even coverage. Color by frame to see the acquisition order.',
    body => {
      const mrec = host.markerSets().find(m => m.dwiOf === vol);
      if (!mrec) {
        if (!vol._dirsMaking) { vol._dirsMaking = true; showGradientMarkers(vol); }
        running(body, 'qc-dirs-progress', 'making the markers…');
        return;
      }
      vol._dirsMaking = false;
      lines(body, [['i', 'one marker per direction, on a sphere per shell; the triangulation shows the coverage']]);
      created(body, [['markers', mrec.set.name, () => host.showMarkers(mrec)]]);
    });

  // 3. outlier detection: the signal check (dropout slices)
  chapter('outliers', 'OUTLIER DETECTION', 'Per frame and slice the brain signal against the other frames of its shell: slices that lost signal (motion during the diffusion gradient, spikes) — on the raw data, before processing.',
    body => {
      const sc = vol.signalCheck;
      if (sc && sc.running) { running(body, 'qc-sig-progress', 'checking the signal… ' + Math.round(100 * (sc.progress || 0)) + '%'); return; }
      if (!sc || sc.error) {
        maskRow(body);
        actRow(body, 'run the signal check', 'compares each slice of each frame with the same slice in the other frames of its shell', () => checkSignal(vol));
        if (sc && sc.error) lines(body, [['✗', 'the last run failed: ' + sc.error]]);
        return;
      }
      const dv = sc.made ? host.volumes().find(v => v.label === sc.made[0]) : null;
      lines(body, [['i', 'mask: ' + (sc.maskName || 'from the series')]]);
      const sl = signalReportLines(vol);
      lines(body, sl.filter(l => l[2] !== 'frame'), ' qc-result');
      if (sc.slices && sc.slices.length) {
        const ax = 'ijk'[sc.axis];
        for (const x of sc.slices.slice(0, 10)) {
          const it = document.createElement('div'); it.className = 'qc-line qc-made-item';
          const bt = document.createElement('button'); bt.className = 'qc-act';
          bt.textContent = 'frame ' + x.frame + ' · ' + ax + '=' + x.slice + ' · −' + Math.round(100 * x.loss) + '%' + (x.local ? ' in ' + Math.round(100 * x.area) + '% of the slice' : '');
          bt.dataset.tip = 'show frame ' + x.frame + ' at slice ' + ax + '=' + x.slice;
          bt.addEventListener('click', () => host.showFrameSlice(vol, x.frame, x.slice, sc.axis));
          it.append(Object.assign(document.createElement('span'), { className: 'qc-st qc-' + (x.loss >= 0.4 ? 2 : 1), textContent: '•' }), bt);
          body.appendChild(it);
        }
        if (sc.slices.length > 10) { const more = document.createElement('div'); more.className = 'qc-line qc-made-item qc-run'; more.textContent = '… and ' + (sc.slices.length - 10) + ' more'; body.appendChild(more); }
      }
      lines(body, sl.filter(l => l[2] === 'frame'), ' qc-result');   // whole frames off: after the slices
      if (dv) created(body, [['volume', dv.label, () => host.showVolume(dv)]]);
      actRow(body, 'run again', 'with another mask, say', () => { vol.signalCheck = null; host.redraw(); });
    });

  // 4. the tensor fit: FA, MD, DEC, direction lines and the orientation check
  chapter('tensor', 'DIFFUSION TENSOR FIT', 'Fits a diffusion tensor per voxel (in the background): FA, MD and direction-encoded color volumes, the principal directions as short lines, and a check of the .bvec orientation (flips, swaps).',
    body => {
      const t = vol.tensorFit;
      if (t && t.running) { running(body, 'qc-fit-progress', 'fitting tensors… ' + Math.round(100 * (t.progress || 0)) + '%'); return; }
      const madeVols = t && t.made ? t.made.map(l => host.volumes().find(v => v.label === l)).filter(Boolean) : [];
      const tckGroups = t && t.tck ? host.groups().filter(g => g.source && g.source.name === t.tck) : [];
      const done = t && t.made && (madeVols.length || tckGroups.length);
      if (!done) {
        maskRow(body);
        actRow(body, 'run the tensor fit', 'FA, MD, DEC, the direction lines and the orientation check', () => fitTensors(vol));
        if (t && t.error) lines(body, [['✗', 'the last run failed: ' + t.error]]);
        return;
      }
      lines(body, tensorReportLines(vol), ' qc-result');
      created(body, [...madeVols.map(v => ['volume', v.label, () => host.showVolume(v)]), ...(tckGroups.length ? [['streamlines', t.tck, () => host.showTracts(tckGroups)]] : [])]);
      actRow(body, 'run again', 'with another mask, say', () => { vol.tensorFit = null; host.redraw(); });
    });
}
