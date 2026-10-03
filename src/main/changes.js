// What a turn changed, and taking it back.
//
// Until now the only trace of Claude's work in the panel was a row per tool
// call. A Bash command that rewrote three files, an `npm install` that touched
// the lockfile, an Edit that went somewhere unexpected: none of it showed as
// what it actually was, a change to your code.
//
// So every turn in a git project is bracketed by two snapshots of the working
// folder, and the difference between them is the turn's diff. A snapshot is a
// git tree object written through a *temporary* index (GIT_INDEX_FILE), seeded
// from the real one so git's stat cache keeps it fast. Your staging area,
// branches, stash and HEAD are never touched; the only trace is a few loose
// objects in .git that `git gc` sweeps up in time.
//
// Undo writes the files back from the "before" tree, and refuses when any of
// them changed again since: putting a turn back must never eat later work.
//
// execFile with fixed arguments (no shell), timeouts on everything, and never
// throws to the caller: a folder that isn't a git repo simply has no diffs.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;   // sha1 or sha256 repos
const SNAPSHOT_TIMEOUT_MS = 20000;
const MAX_UNTRACKED = 5000;                     // past this, a folder isn't one to snapshot
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;   // a 2 GB video someone forgot to ignore stays out of .git
const MAX_FILES = 500;                          // rows shown for one turn
const MAX_PATCH = 400 * 1024;                   // one file's diff, as text

function git(cwd, args, { env, input, timeout = SNAPSHOT_TIMEOUT_MS, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    const child = execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], {
      windowsHide: true, timeout, maxBuffer, encoding: 'utf8',
      // Literal pathspecs: a file a turn named "*.js" or ":(top)x" means that file, not every match.
      env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
    }, (err, stdout, stderr) => resolve(err ? { ok: false, error: String(stderr || err.message).trim().split('\n').pop() } : { ok: true, out: stdout }));
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

/** The repo root for a folder, or null. */
async function rootOf(dir) {
  if (typeof dir !== 'string' || !dir || dir.length > 400 || !path.isAbsolute(dir) || !fs.existsSync(dir)) return null;
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { timeout: 5000 });
  return r.ok && r.out.trim() ? path.resolve(r.out.trim()) : null;
}

// Git reports the root in full; the folder it was asked about may be an 8.3
// short name (C:\Users\RUNNER~1\...). Compare the two with names expanded.
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const sameRoot = (root, dir) => !!root && longPath(root).toLowerCase() === longPath(dir).toLowerCase();

/**
 * The working folder as a tree, untracked files included (minus ignored ones,
 * and minus anything enormous). -> { root, tree } | null
 */
async function snapshot(dir) {
  const root = await rootOf(dir);
  if (!root) return null;
  const idx = await git(root, ['rev-parse', '--git-path', 'index'], { timeout: 5000 });
  if (!idx.ok) return null;
  const realIndex = path.resolve(root, idx.out.trim());
  const tmp = path.join(os.tmpdir(), `shellby-index-${crypto.randomBytes(6).toString('hex')}`);
  try {
    // A fresh repo has no index yet; an empty temp one is the same thing.
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    const tracked = await git(root, ['add', '-u', '--', '.'], { env });
    if (!tracked.ok) return null;
    const others = await git(root, ['ls-files', '-z', '--others', '--exclude-standard'], { env });
    if (!others.ok) return null;
    const untracked = others.out.split('\0').filter(Boolean);
    if (untracked.length > MAX_UNTRACKED) return null;
    const small = untracked.filter(f => {
      try { return fs.statSync(path.join(root, f)).size <= MAX_UNTRACKED_BYTES; } catch { return false; }
    });
    if (small.length) {
      const added = await git(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: small.join('\0') });
      if (!added.ok) return null;
    }
    const tree = await git(root, ['write-tree'], { env });
    const t = tree.ok && tree.out.trim();
    return t && TREE.test(t) ? { root, tree: t } : null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp dir */ }
  }
}

/** `git diff -z --numstat` + `--name-status` -> [{ path, status, added, removed, binary }]. Pure. */
function parseDiffSummary(numstat, nameStatus) {
  const status = new Map();
  const ns = String(nameStatus || '').split('\0');
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i][0]);
  const files = [];
  for (const rec of String(numstat || '').split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-';
    files.push({ path: m[3], status: status.get(m[3]) || 'M', added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary });
  }
  return files;
}

async function changedFiles(root, before, after) {
  const base = ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '-z'];
  const [num, names] = await Promise.all([
    git(root, [...base, '--numstat', before, after]),
    git(root, [...base, '--name-status', before, after]),
  ]);
  if (!num.ok || !names.ok) return null;
  return parseDiffSummary(num.out, names.out);
}

/**
 * What changed between two snapshots of the same repo.
 *   -> { root, before, after, files, added, removed, more } | null (nothing changed)
 */
async function summarize(start, end) {
  if (!start || !end || start.root !== end.root || start.tree === end.tree) return null;
  const files = await changedFiles(start.root, start.tree, end.tree);
  if (!files?.length) return null;
  return {
    root: start.root, before: start.tree, after: end.tree,
    files: files.slice(0, MAX_FILES), more: Math.max(0, files.length - MAX_FILES),
    added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

/** Checks the renderer's word before any of it reaches git. -> error string | null */
function checkRef({ root, before, after, file } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > 400) return 'Not a project folder.';
  if (!TREE.test(before || '') || !TREE.test(after || '')) return 'Not a snapshot.';
  if (file != null && (typeof file !== 'string' || !file || file.length > 1000 || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) return 'Not a file in this change.';
  return null;
}

/** One file's diff for a turn, as unified-diff text. -> { patch, truncated } | { error } */
async function patchFor(ref) {
  const bad = checkRef(ref);
  if (bad) return { error: bad };
  const root = await rootOf(ref.root);
  if (!sameRoot(root, ref.root)) return { error: 'That project has moved.' };
  const r = await git(root, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', ref.before, ref.after, '--', ...(ref.file ? [ref.file] : [])], { maxBuffer: 16 * 1024 * 1024 });
  if (!r.ok) return { error: /bad object|not a tree|unknown revision/i.test(r.error) ? 'Those changes have been tidied away by git since.' : r.error || "Couldn't read the diff." };
  return r.out.length > MAX_PATCH ? { patch: r.out.slice(0, MAX_PATCH), truncated: true } : { patch: r.out, truncated: false };
}

/**
 * Put the files a turn changed back the way they were before it.
 *   -> { ok: true, restored } | { ok: false, error, changedSince? }
 */
async function undo(ref) {
  const bad = checkRef(ref);
  if (bad) return { ok: false, error: bad };
  const root = await rootOf(ref.root);
  if (!sameRoot(root, ref.root)) return { ok: false, error: 'That project has moved.' };
  const turn = await changedFiles(root, ref.before, ref.after);
  if (!turn) return { ok: false, error: 'Those changes have been tidied away by git since.' };
  if (!turn.length) return { ok: true, restored: 0 };

  // Anything touched again after this turn (by a later turn, or by you) would
  // be overwritten. Say which, and leave all of it alone.
  const now = await snapshot(root);
  if (!now) return { ok: false, error: "Couldn't take a look at the folder as it is now." };
  const since = await changedFiles(root, ref.after, now.tree);
  if (!since) return { ok: false, error: "Couldn't compare with the folder as it is now." };
  const touched = new Set(since.map(f => f.path));
  const changedSince = turn.map(f => f.path).filter(p => touched.has(p));
  if (changedSince.length) {
    return { ok: false, changedSince: changedSince.slice(0, 20), error: `${changedSince.length === 1 ? 'A file has' : `${changedSince.length} files have`} changed since this turn. Undo the later changes first.` };
  }

  // Files the turn created go; the rest come back from the snapshot.
  for (const f of turn.filter(f => f.status === 'A')) {
    const abs = path.resolve(root, f.path);
    if (!abs.startsWith(root + path.sep)) continue;
    try { fs.rmSync(abs, { force: true }); } catch (e) { return { ok: false, error: `Couldn't remove ${f.path}: ${e.message}` }; }
  }
  const back = turn.filter(f => f.status !== 'A').map(f => f.path);
  if (back.length) {
    const r = await git(root, ['restore', `--source=${ref.before}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: back.join('\0') });
    if (!r.ok) return { ok: false, error: r.error || "git couldn't put them back." };
  }
  return { ok: true, restored: turn.length };
}

module.exports = { snapshot, summarize, patchFor, undo, parseDiffSummary, checkRef, rootOf, TREE };
