// @ mentions: the files (and folders) in a conversation's working folder, and
// a fuzzy match over them for what you've typed after the @.
//
// In a git project the list is what git knows about (tracked plus untracked,
// minus ignored), which is fast and skips node_modules and build output for
// free. Anywhere else a short, bounded walk stands in. Lists are cached per
// folder for a little while, so typing doesn't re-run git on every key.
//
// rank() is pure; see test/fileindex.test.js.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_FILES = 30000;
const WALK_MAX = 6000;
const WALK_DEPTH = 6;
const CACHE_MS = 20000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj']);

const cache = new Map(); // cwd -> { at, entries: Promise<string[]> }

function gitFiles(cwd) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out) => resolve(err ? null : out.split('\0').filter(Boolean).slice(0, MAX_FILES)));
  });
}

function walk(cwd) {
  const out = [];
  const visit = (dir, rel, depth) => {
    if (out.length >= WALK_MAX || depth > WALK_DEPTH) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= WALK_MAX) return;
      if (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.github') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(path.join(dir, e.name), r, depth + 1); } else if (e.isFile()) out.push(r);
    }
  };
  visit(cwd, '', 0);
  return out;
}

/** Files plus the folders they sit in (folders end with '/'), relative, forward slashes. */
function withFolders(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  return [...dirs, ...files];
}

async function list(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return [];
  const key = path.resolve(cwd).toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  const entries = (async () => withFolders((await gitFiles(cwd)) || walk(cwd)))();
  cache.set(key, { at: Date.now(), entries });
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return entries;
}

// A subsequence match scored the way a file picker should feel: the file's own
// name beats its folders, consecutive letters beat scattered ones, a match at
// a word start beats one mid-word, and shorter paths win ties.
function score(entry, q) {
  const p = entry.toLowerCase();
  if (!q) return 1000 - Math.min(entry.length, 999) - entry.split('/').length * 50;
  const base = p.replace(/\/$/, '').split('/').pop();
  if (base === q) return 10000 - entry.length;
  if (base.startsWith(q)) return 8000 - entry.length;
  if (base.includes(q)) return 6000 - entry.length;
  if (p.includes(q)) return 4000 - entry.length;
  let at = -1, run = 0, s = 2000 - entry.length;
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1);
    if (next < 0) return -1;
    run = next === at + 1 ? run + 1 : 0;
    s += run * 8 + (next === 0 || '/._- '.includes(p[next - 1]) ? 12 : 0) - (next - at - 1);
    at = next;
  }
  return s;
}

/** The best `limit` entries for query `q` (what follows the @). */
function rank(entries, q, limit = 12) {
  const query = String(q || '').replace(/\\/g, '/').toLowerCase().trim();
  const scored = [];
  for (const e of entries) {
    const s = score(e, query);
    if (s >= 0) scored.push([s, e]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map(([, e]) => e);
}

/** How a path goes into the message: @path, quoted when it has spaces. */
function mention(entry) {
  return /\s/.test(entry) ? `@"${entry}"` : `@${entry}`;
}

/** Drop a folder's cached list (a turn or a command just changed its files). */
function forget(cwd) {
  if (typeof cwd === 'string') cache.delete(path.resolve(cwd).toLowerCase());
}

async function suggest(cwd, q, limit = 12) {
  return rank(await list(cwd), q, limit);
}

module.exports = { list, rank, mention, suggest, forget, withFolders };
