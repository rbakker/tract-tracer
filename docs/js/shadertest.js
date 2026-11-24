// ?shadertest — compiles the app's shaders, one by one, each in a fresh
// WebGL context, and reports OK / FAILED / CRASH (context lost) with the
// compile time and the compiler's warnings. Made after a Windows-only crash
// (2026-11-24): on Windows, browsers translate WebGL to Direct3D (ANGLE) and
// compile with Microsoft's compiler, which choked on the 3D brain shader
// that compiled everywhere else. Run it on Windows before a release.
//
//   ?shadertest        the page; "Run all" by hand
//   ?shadertest&run    runs all at once (for automation): when done, the
//                      title reads "SHADERTEST PASS n/n" or "SHADERTEST FAIL
//                      k/n", window.shaderTestResults holds the results and
//                      the console gets one line "SHADERTEST_RESULT {json}"
//
// The known-bad shader (shadertest-known-bad.js) is only compiled from its
// own button, never by "Run all" or &run: it crashes the browser's graphics
// process on Windows — it is there to check that the test still notices.
//
// Covered: the shaders built with three.js from scene3d.js and
// markers-render.js, in the variants the app switches between (#defines).
// Not covered yet: the 2D renderers (vol-renderer.js, slab-renderer.js) and
// volume-surfaces.js, which build theirs internally — the 2D ones compile
// as the app starts.
import * as THREE from 'three';
import * as S from './scene3d.js';
import * as M from './markers-render.js';

const material = (vs, fs, defines = {}) => new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, defines });
const ribbon = (faint, clip) => { const m = S.makeRibbonMaterial(null, null, faint); if (clip) m.defines.CLIP3D = 1; return m; };

// [name, () => material]
const TESTS = [
  ['3D brain · translucent', () => material(S.GLASS_VS, S.GLASS_ONLY_FS)],
  ['3D brain · solid / glass (the big one)', () => material(S.GLASS_VS, S.SOLID_ONLY_FS)],
  ['streamlines · opaque', () => ribbon(false, false)],
  ['streamlines · faint pass', () => ribbon(true, false)],
  ['streamlines · opaque, clipped', () => ribbon(false, true)],
  ['streamlines · faint pass, clipped', () => ribbon(true, true)],
  ['streamline end dots', () => S.makeDotsMaterial3d()],
  ['markers · 3D', () => M.makeMarkerMaterial({ FULL_PASS: 1 })],
  ['markers · 3D outline', () => M.makeMarkerMaterial({ FULL_PASS: 1, OUTLINE: 1 })],
  ['markers · beyond the section (FAR_PASS)', () => M.makeMarkerMaterial({ FAR_PASS: 1 })],
  ['marker links', () => material(M.LINK_VS, M.LINK_FS)],
];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function rendererInfo() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no WebGL2';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    const r = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const par = !!gl.getExtension('KHR_parallel_shader_compile');
    const l = gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext();
    return r + ' · parallel compile ' + par;
  } catch (e) { return 'WebGL2: ' + e; }
}

// One three.js material, compiled in its own context. → { state: 'ok' |
// 'fail' | 'lost', ms, log }
async function testMaterial(make) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  let lost = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); }
  catch (e) { return { state: 'fail', ms: 0, log: 'no WebGL2 context: ' + e }; }
  const errors = [];
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n') || '(no message)');
  };
  const gl = renderer.getContext();
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  let mat;
  try { mat = make(); } catch (e) { renderer.dispose(); return { state: 'fail', ms: 0, log: 'building the material: ' + e }; }
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), mat));
  const t0 = performance.now();
  let state = 'ok', log = '';
  try {
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);   // (in the background where the browser can)
    renderer.render(scene, camera);   // (three reports compile errors on first use)
  } catch (e) { state = 'fail'; log = String(e); }
  const ms = Math.round(performance.now() - t0);
  await new Promise(r => setTimeout(r, 300));   // (a crash shows as a lost context, a moment later)
  if (lost || gl.isContextLost()) state = 'lost';
  else if (errors.length) { state = 'fail'; log = errors.join('\n'); }
  else {   // warnings (e.g. Direct3D's X4000) in the program logs
    const warn = new Set();
    for (const p of renderer.info.programs || []) { const l = p.program && gl.getProgramInfoLog(p.program); if (l && l.trim()) warn.add(l.trim()); }
    log = [...warn].join('\n');
  }
  try { mat.dispose(); renderer.dispose(); renderer.forceContextLoss(); } catch (e) {}
  return { state, ms, log: log.slice(0, 2000) };
}

// The known-bad shader: raw WebGL, as three handed it over.
async function testRaw(vsSrc, fsSrc) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  let lost = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
  const gl = canvas.getContext('webgl2');
  if (!gl) return { state: 'fail', ms: 0, log: 'no WebGL2 context' };
  const t0 = performance.now();
  const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  const par = gl.getExtension('KHR_parallel_shader_compile');
  if (par) while (!lost && !gl.isContextLost() && !gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR)) await new Promise(r => setTimeout(r, 50));
  const ok = !lost && !gl.isContextLost() && gl.getProgramParameter(p, gl.LINK_STATUS);
  const ms = Math.round(performance.now() - t0);
  await new Promise(r => setTimeout(r, 300));
  if (lost || gl.isContextLost()) return { state: 'lost', ms, log: '' };
  const log = [gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs), gl.getProgramInfoLog(p)].filter(Boolean).join('\n');
  const l = gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext();
  return { state: ok ? 'ok' : 'fail', ms, log: (log || (ok ? '' : '(no message)')).slice(0, 2000) };
}

export function runShaderTest() {
  const params = new URLSearchParams(location.search);
  const build = S.SCENE3D_BUILD || '?';
  const env = rendererInfo() + ' · ' + navigator.userAgent;
  const results = TESTS.map(() => null);
  let bad = null, busy = false;

  document.title = 'Shader test · ' + build;
  const root = document.createElement('div');
  root.id = 'shadertest';
  root.innerHTML = `<style>
    #shadertest{position:fixed;inset:0;z-index:100000;overflow:auto;background:#15171c;color:#e4e6ec;font:14px/1.5 system-ui,sans-serif;padding:20px max(4vw,14px)}
    #shadertest h1{font-size:22px;margin:0 0 4px}
    #shadertest .env{color:#9aa0b0;font-size:12px;overflow-wrap:anywhere;margin-bottom:14px}
    #shadertest button{font:600 14px system-ui,sans-serif;min-height:36px;padding:0 14px;margin:0 8px 8px 0;background:#2c5bd8;color:#fff;border:0;border-radius:4px;cursor:pointer}
    #shadertest button.ghost{background:#2a2e38}
    #shadertest button:disabled{opacity:.45;cursor:default}
    #shadertest table{border-collapse:collapse;width:100%;max-width:1000px;margin:10px 0 18px}
    #shadertest td{padding:6px 8px;border-bottom:1px solid #2a2e38;vertical-align:top}
    #shadertest td.ms{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;color:#9aa0b0}
    #shadertest .ok{color:#5fd08b;font-weight:600}#shadertest .bad{color:#ff6b7f;font-weight:600}#shadertest .run{color:#7fa4ff}
    #shadertest .log{color:#9aa0b0;font-size:12px;white-space:pre-wrap;max-height:7em;overflow:auto}
    #shadertest .note{color:#9aa0b0;max-width:75ch}
    #shadertest textarea{width:100%;max-width:1000px;min-height:140px;background:#1d2027;color:#e4e6ec;border:1px solid #2a2e38;font:12px/1.4 ui-monospace,Consolas,monospace}
  </style>
  <h1>Shader test · build ${esc(build)}</h1>
  <div class="env">${esc(env)}</div>
  <button id="st-all">Run all</button><button class="ghost" id="st-copy">Copy results</button>
  <table><tbody id="st-rows"></tbody></table>
  <p class="note"><b>Known bad</b> — a shader that crashed Windows' graphics process (build 2026-11-24h). On Windows it should end in CRASH or FAILED; elsewhere it compiles. Never run by "Run all". After it, Chrome may switch WebGL off for this page for a while: reload.</p>
  <button class="ghost" id="st-bad">Compile the known-bad shader</button> <span id="st-badres"></span>
  <p class="note">Results as text:</p><textarea id="st-out" readonly></textarea>`;
  document.body.appendChild(root);
  const $ = id => root.querySelector('#' + id);

  const stateText = r => !r ? '' : r.state === 'run' ? '<span class="run">compiling…</span>'
    : r.state === 'ok' ? '<span class="ok">OK</span>' : '<span class="bad">' + (r.state === 'lost' ? 'CRASH (context lost)' : 'FAILED') + '</span>';
  const textOf = (name, r) => (r ? ({ ok: 'OK   ', fail: 'FAIL ', lost: 'CRASH', run: '...  ' }[r.state]) + String(r.ms ?? '').padStart(7) + ' ms  ' : 'not run          ')
    + name + (r && r.log ? '\n        ' + r.log.replace(/\n/g, '\n        ') : '');
  function render() {
    $('st-rows').innerHTML = TESTS.map(([name], i) => {
      const r = results[i];
      return `<tr><td>${esc(name)}${r && r.log ? '<div class="log">' + esc(r.log) + '</div>' : ''}</td><td>${stateText(r)}</td><td class="ms">${r && r.ms != null && r.state !== 'run' ? r.ms + ' ms' : ''}</td></tr>`;
    }).join('');
    $('st-badres').innerHTML = bad ? stateText(bad) + (bad.ms != null && bad.state !== 'run' ? ' ' + bad.ms + ' ms' : '') : '';
    $('st-out').value = 'Shader test · build ' + build + '\n' + env + '\n\n'
      + TESTS.map(([name], i) => textOf(name, results[i])).join('\n')
      + (bad ? '\n\n' + textOf('known bad (should fail on Windows)', bad) : '');
    $('st-all').disabled = $('st-bad').disabled = busy;
  }
  async function runAll() {
    if (busy) return;
    busy = true;
    for (let i = 0; i < TESTS.length; i++) {
      results[i] = { state: 'run' }; render();
      results[i] = await testMaterial(TESTS[i][1]);
      render();
      if (results[i].state === 'lost') {   // (the graphics process went down: the rest would not be fair)
        for (let j = i + 1; j < TESTS.length; j++) results[j] = { state: 'fail', ms: null, log: 'not run: an earlier shader crashed the graphics process' };
        break;
      }
    }
    busy = false; render();
    const failed = results.filter(r => r && r.state !== 'ok').length;
    const summary = { build, env, pass: !failed, results: TESTS.map(([name], i) => ({ name, ...results[i] })) };
    window.shaderTestResults = summary;
    console.log('SHADERTEST_RESULT ' + JSON.stringify(summary));
    document.title = 'SHADERTEST ' + (failed ? 'FAIL ' + failed : 'PASS ' + TESTS.length) + '/' + TESTS.length;
  }
  $('st-all').addEventListener('click', runAll);
  $('st-bad').addEventListener('click', async () => {
    if (busy) return;
    busy = true; bad = { state: 'run' }; render();
    const { KNOWN_BAD_VS, KNOWN_BAD_FS } = await import('./shadertest-known-bad.js');
    bad = await testRaw(KNOWN_BAD_VS, KNOWN_BAD_FS);
    busy = false; render();
  });
  $('st-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('st-out').value); } catch (e) { $('st-out').select(); } });
  render();
  if (params.has('run')) runAll();
}
