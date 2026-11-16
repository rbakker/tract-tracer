// ── file-paths.js ─────────────────────────────────────────
// Where a file came from: its path inside a dropped zip or folder
// ("sub-01/anat/T1w.nii.gz"), kept on the File as relPath — File.name
// stays the bare name. Two files of the same name in different folders are
// two files: a reference (a manifest's resource path, a sidecar, a
// gradient table, a .photo.json's photo) is resolved by path first, then
// by name where that name is unique, or the one in the referring file's
// own folder. Lists show the shortest end of the path that tells files of
// the same name apart (shortNames).
//
// No app state; no other imports.

export const pathOf = f => String((f && (f.relPath || f.name)) || '');
export const dirOf = p => { p = String(p); return p.slice(0, p.lastIndexOf('/') + 1); };   // with its '/', or ''
export const baseOf = p => String(p).split('/').pop();

// a file with its path (zip, folder), name unchanged
export function withPath(file, path) {
  path = String(path || '').replace(/^\/+/, '');
  if (file && path && path !== file.name) {
    try { Object.defineProperty(file, 'relPath', { value: path, configurable: true, enumerable: false }); } catch (_) {}
  }
  return file;
}

// dir + rel, with '.', '..' and './' resolved ('/…' from the top)
export function joinPath(dir, rel) {
  rel = String(rel).replace(/\\/g, '/');
  const parts = (rel.startsWith('/') ? rel.slice(1) : dir + rel).split('/'), out = [];
  for (const s of parts) { if (s === '' || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
  return out.join('/');
}

export const sameFile = (a, b) => !!a && !!b && (a === b || pathOf(a) === pathOf(b));

/**
 * The file a reference names, or null (not there, or which one is unclear).
 * @param files - the candidates
 * @param ref - a path or a name ("anat/T1w.nii.gz", "T1w.nii.gz")
 * @param from - the file that refers to it (its folder is where ref starts)
 */
export function findFile(files, ref, from = null) {
  if (ref == null || ref === '') return null;
  ref = String(ref).replace(/\\/g, '/');
  const list = Array.from(files || []).filter(Boolean);
  const want = joinPath(from ? dirOf(pathOf(from)) : '', ref);
  let f = list.find(x => pathOf(x) === want) || list.find(x => pathOf(x) === joinPath('', ref));
  if (f) return f;
  const b = baseOf(ref), same = list.filter(x => baseOf(pathOf(x)) === b);
  if (same.length <= 1) return same[0] || null;
  const tail = same.filter(x => ('/' + pathOf(x)).endsWith('/' + joinPath('', ref)));
  if (tail.length === 1) return tail[0];
  if (from) { const d = dirOf(pathOf(from)), near = same.filter(x => dirOf(pathOf(x)) === d); if (near.length === 1) return near[0]; }
  return null;
}

// file → the shortest end of its path that no other file of the list ends with
export function shortNames(files) {
  const list = Array.from(files || []).filter(Boolean), out = new Map();
  for (const f of list) {
    const parts = pathOf(f).split('/');
    let k = 1, name = parts[parts.length - 1];
    const ends = n => list.some(g => g !== f && pathOf(g) !== pathOf(f) && ('/' + pathOf(g)).endsWith('/' + n));
    while (k < parts.length && ends(name)) { k++; name = parts.slice(-k).join('/'); }
    out.set(f, name);
  }
  return out;
}
