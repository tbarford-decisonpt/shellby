// The files behind the composer's @ picker: what's in a conversation's folder,
// and which of them best match what you've typed so far.
//
// In a git repo that's `git ls-files` (tracked plus untracked, minus ignored),
// the same list your editor's quick-open shows. Anywhere else (Shellby starts
// out in your home folder) it's a walk that skips the usual heavyweights and
// stops at a cap, so a huge folder answers quickly with a partial list rather
// than slowly with a whole one. Lists are cached for a few seconds per folder.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_FILES = 50000;
const WALK_MAX = 20000;
const WALK_MAX_MS = 1500;
const TTL_MS = 15000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.cache', 'dist', 'build',
  'out', 'target', 'bin', 'obj', 'AppData', '$Recycle.Bin', 'System Volume Information']);

function gitFiles(root) {
  return new Promise(resolve => {
    execFile('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout).split('\0').filter(Boolean).slice(0, MAX_FILES)));
  });
}

async function walk(root) {
  const out = [];
  const queue = [''];
  const until = Date.now() + WALK_MAX_MS;
  while (queue.length && out.length < WALK_MAX && Date.now() < until) {
    const rel = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.claude') continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) queue.push(p); }
      else if (e.isFile()) out.push(p);
      if (out.length >= WALK_MAX) break;
    }
  }
  return out;
}

/** Files plus the folders they're in, as forward-slash paths relative to root (folders end in /). */
function withFolders(files) {
  const dirs = new Set();
  for (const f of files) {
    for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  }
  return [...dirs, ...files];
}

const cache = new Map(); // root -> { at, list: Promise<string[]> }

/** Every file and folder under `root` worth suggesting (cached briefly). */
function listFiles(root, now = Date.now()) {
  const hit = cache.get(root);
  if (hit && now - hit.at < TTL_MS) return hit.list;
  const list = (async () => withFolders(((await gitFiles(root)) || (await walk(root))).map(f => f.replace(/\\/g, '/'))))();
  cache.set(root, { at: now, list });
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return list;
}

/**
 * How well `p` matches `q` (lower is better), or null for no match. Name
 * matches beat path matches beat scattered letters, and shorter paths win ties,
 * so `@main` finds main.js before src/main/some/deep/main-thing.js.
 */
function score(p, q) {
  const lower = p.toLowerCase();
  const name = lower.replace(/\/$/, '').split('/').pop();
  const dir = p.endsWith('/');
  const depth = (p.match(/\//g) || []).length - (dir ? 1 : 0);
  if (!q) return depth * 100 + (dir ? 0 : 50); // the top of the folder, folders first
  if (name === q) return 0 + p.length / 1000;
  if (name.startsWith(q)) return 1 + p.length / 1000;
  if (name.includes(q)) return 2 + p.length / 1000;
  if (lower.startsWith(q)) return 3 + p.length / 1000;
  if (lower.includes(q)) return 4 + p.length / 1000;
  // Letters in order, anywhere: "smjs" finds src/main.js. Fewer gaps is better.
  let at = -1, gaps = 0;
  for (const c of q) {
    const next = lower.indexOf(c, at + 1);
    if (next === -1) return null;
    if (next !== at + 1) gaps++;
    at = next;
  }
  return 5 + gaps + p.length / 1000;
}

/** The best `limit` entries for what's typed after @ ("" lists the top of the folder). */
function rankFiles(list, query, limit = 8) {
  const q = String(query || '').toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  const scored = [];
  for (const p of list) {
    const s = score(p, q);
    if (s != null) scored.push([s, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map(([, p]) => ({ path: p, dir: p.endsWith('/') }));
}

module.exports = { listFiles, rankFiles, withFolders, walk, SKIP_DIRS };
