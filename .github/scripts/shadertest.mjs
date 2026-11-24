// Runs the app's ?shadertest page in Chrome on a Windows runner (ANGLE →
// Direct3D 11, the path that crashed on 2026-11-24) and fails the job if
// any shader fails to compile. See js/shadertest.js.
//
//   node .github/scripts/shadertest.mjs            all shaders ("Run all")
//   KNOWN_BAD=1 node .github/scripts/shadertest.mjs   also the known-bad
//        shader, which must FAIL or CRASH (checks that the test still
//        catches this kind of failure; only on request, never by default)
//   REQUIRE_D3D=0 …   allow a renderer other than Direct3D (local tries)
//
// Serves the repository root itself (no other server needed); three.js
// comes from the CDN, as in the app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 8123;
const KNOWN_BAD = process.env.KNOWN_BAD === '1';
const REQUIRE_D3D = process.env.REQUIRE_D3D !== '0';
const CHANNEL = process.env.BROWSER_CHANNEL ?? 'chrome';   // the runner's installed Chrome
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT);

const summary = [];
const out = line => { console.log(line); summary.push(line); };
let failed = false;

const browser = await chromium.launch({
  channel: CHANNEL || undefined,
  headless: true,
  // ANGLE on Direct3D 11 (on a runner without a GPU: Windows' software
  // device, WARP — the same Microsoft shader compiler as on a real GPU),
  // even where Chrome would otherwise refuse that device
  args: process.platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] : [],
});
try {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [page ' + m.type() + '] ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => console.log('  [page error] ' + e));
  await page.goto(`http://localhost:${PORT}/?shadertest&run`);
  await page.waitForFunction(() => document.title.startsWith('SHADERTEST '), null, { timeout: 15 * 60 * 1000 });
  const r = await page.evaluate(() => window.shaderTestResults);
  out(`### Shader test · build ${r.build}`);
  out('');
  out('`' + r.env + '`');
  out('');
  out('| shader | result | ms |');
  out('|---|---|---:|');
  for (const t of r.results) out(`| ${t.name} | ${t.state === 'ok' ? 'OK' : t.state === 'lost' ? '**CRASH**' : '**FAILED**'} | ${t.ms ?? ''} |`);
  for (const t of r.results) if (t.log) { out(''); out(`<details><summary>${t.name}: compiler messages</summary>\n\n\`\`\`\n${t.log}\n\`\`\`\n</details>`); }
  if (!r.pass) failed = true;
  if (REQUIRE_D3D && !/Direct3D|D3D11/i.test(r.env)) {
    out('');
    out('**Not Direct3D**: the browser did not use ANGLE on Direct3D, so this run does not test what crashed on Windows.');
    failed = true;
  }
  if (KNOWN_BAD) {
    await page.click('#st-bad');
    await page.waitForFunction(() => { const t = document.querySelector('#st-badres').textContent; return t && !/compiling/.test(t); }, null, { timeout: 10 * 60 * 1000 });
    const bad = (await page.textContent('#st-badres')).trim();
    out('');
    out(`Known-bad shader: **${bad}** (expected: FAILED or CRASH)`);
    if (/^OK/.test(bad)) { out('The known-bad shader compiled: this run would not catch that kind of failure.'); failed = true; }
  }
  await page.screenshot({ path: 'shadertest.png', fullPage: true });
  fs.writeFileSync('shadertest.json', JSON.stringify(r, null, 2));
} catch (e) {
  out('**The shader test did not finish:** ' + e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
process.exit(failed ? 1 : 0);
