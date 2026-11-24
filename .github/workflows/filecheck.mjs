// Checks that every file the app loads by a relative path is in the
// repository: a pushed module that imports a file that was never committed
// fails here, in seconds, with the file named.
//
//   node .github/scripts/filecheck.mjs [site folder, default docs]
//
// Looks at every .js / .mjs / .html under the folder for
//   import … from '…'   export … from '…'   import('…')
//   new URL('…', import.meta.url)  (workers, wasm)   new Worker('…')
//   <script src="…">   <link href="…">   and local "imports" in an import map
// Only relative and root-relative paths count (./x.js, ../x.js, /x.js);
// bare names (three, three/addons/…) and http(s) URLs are left alone.
// In a git work tree the files must also be tracked by git, so running it
// before a push catches a new file that was never added.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const SITE = path.resolve(process.argv[2] || 'docs');
if (!fs.existsSync(SITE)) { console.log('No folder ' + SITE); process.exit(1); }

// files git knows (null: not a git work tree — then the file system decides)
let tracked = null;
try {
  const top = execSync('git rev-parse --show-toplevel', { cwd: SITE, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  tracked = new Set(execSync('git ls-files -z', { cwd: top, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean).map(f => path.resolve(top, f)));
} catch (e) { /* not in git */ }
const exists = f => fs.existsSync(f) && fs.statSync(f).isFile() && (!tracked || tracked.has(f));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(m?js|html)$/i.test(e.name)) out.push(f);
  }
  return out;
}

// [specifier, line] pairs a file refers to
function refsOf(file, text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;   // (comments)
    const add = s => out.push([s, i + 1]);
    let m;
    // (an import over several lines ends in "} from '…'")
    const statics = /^\s*(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|^\s*\}\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = statics.exec(line))) add(m[1] || m[2] || m[3]);
    const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dyn.exec(line))) add(m[1]);
    const url = /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    while ((m = url.exec(line))) add(m[1]);
    const worker = /\bnew\s+(?:Shared)?Worker\(\s*['"]([^'"]+)['"]/g;
    while ((m = worker.exec(line))) add(m[1]);
    if (/\.html$/i.test(file)) {
      const tags = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']|<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
      while ((m = tags.exec(line))) add(m[1] || m[2]);
    }
  });
  // an import map's own (local) entries
  if (/\.html$/i.test(file)) {
    const map = text.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/i);
    if (map) try { for (const v of Object.values(JSON.parse(map[1]).imports || {})) out.push([v, 0]); } catch (e) { out.push(['(import map is not valid JSON)', 0]); }
  }
  return out;
}

const missing = [];
let checked = 0;
for (const file of walk(SITE)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [spec, line] of refsOf(file, text)) {
    if (spec.startsWith('(')) { missing.push(`${path.relative(process.cwd(), file)}: ${spec}`); continue; }
    if (/^(https?:)?\/\//i.test(spec) || /^(data|blob|mailto):/i.test(spec) || spec.includes('${')) continue;
    if (!/^\.{0,2}\//.test(spec)) continue;            // bare names: the import map's
    if (spec.endsWith('/')) continue;                   // (a folder prefix in an import map)
    const clean = spec.split(/[?#]/)[0];
    const target = clean.startsWith('/') ? path.join(SITE, clean) : path.resolve(path.dirname(file), clean);
    checked++;
    if (!exists(target)) {
      const why = fs.existsSync(target) ? 'is not committed (git does not track it)' : 'is not in the repository';
      missing.push(`${path.relative(process.cwd(), file)}${line ? ':' + line : ''} loads ${spec}, which ${why}`);
    }
  }
}

const summary = missing.length
  ? `### File check: ${missing.length} missing\n\n` + missing.map(m => '- ' + m).join('\n')
  : `### File check: OK\n\nAll ${checked} files the app loads by path are in the repository.`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
process.exit(missing.length ? 1 : 0);
