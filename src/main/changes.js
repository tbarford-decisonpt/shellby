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
const SKIPPED_TOO_MANY = 'Too many untracked files to track this turn';
const STAT_AT_ONCE = 16;                        // untracked files looked at together, off the main thread
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;   // a 2 GB video someone forgot to ignore stays out of .git
const MAX_FILES = 500;                          // rows shown for one turn
const MAX_PATCH = 400 * 1024;                   // one file's diff, as text

function git(cwd, args, { env, input, timeout = SNAPSHOT_TIMEOUT_MS, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    const child = execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
      windowsHide: true, timeout, maxBuffer, encoding: 'utf8',
      // Literal pathspecs: a file a turn named "*.js" or ":(top)x" means that file, not every match.
      env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
    }, (err, stdout, stderr) => resolve(err ? { ok: false, error: String(stderr || err.message).trim().split('\n').pop() } : { ok: true, out: stdout }));
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

/** The repo root for a folder, or null. */
async function rootOf(dir) {
  if (typeof dir !== 'string' || !dir || dir.length > 400 || !path.isAbsolute(dir)) return null;
  try { await fs.promises.access(dir); } catch { return null; }
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { timeout: 5000 });
  return r.ok && r.out.trim() ? path.resolve(r.out.trim()) : null;
}

// Git reports the root in full; the folder it was asked about may be an 8.3
// short name (C:\Users\RUNNER~1\...). Compare the two with names expanded.
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const sameRoot = (root, dir) => !!root && longPath(root).toLowerCase() === longPath(dir).toLowerCase();

/**
 * The working folder as a tree, untracked files included (minus ignored ones,
 * and minus anything enormous). head: the commit checked out at the time (null
 * in a repo with no commits), so a branch can start a copy from exactly here
 * (branch.js). -> { root, tree, head } | null
 *
 * Runs before and after every turn, so nothing in it blocks the main thread.
 * info: optional; given a skipped reason (SKIPPED_TOO_MANY) when the folder is
 * one it won't snapshot, so the turn can say why it has no diff.
 */
async function snapshot(dir, info = null) {
  const root = await rootOf(dir);
  if (!root) return null;
  const [idx, at] = await Promise.all([
    git(root, ['rev-parse', '--git-path', 'index'], { timeout: 5000 }),
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 5000 }),
  ]);
  if (!idx.ok) return null;
  const head = at.ok && TREE.test(at.out.trim()) ? at.out.trim() : null;
  const realIndex = path.resolve(root, idx.out.trim());
  const tmp = path.join(os.tmpdir(), `shellby-index-${crypto.randomBytes(6).toString('hex')}`);
  try {
    // A fresh repo has no index yet; an empty temp one is the same thing.
    try { await fs.promises.copyFile(realIndex, tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const env = { GIT_INDEX_FILE: tmp };
    const tracked = await git(root, ['add', '-u', '--', '.'], { env });
    if (!tracked.ok) return null;
    const others = await git(root, ['ls-files', '-z', '--others', '--exclude-standard'], { env });
    if (!others.ok) return null;
    const untracked = others.out.split('\0').filter(Boolean);
    if (untracked.length > MAX_UNTRACKED) { if (info) info.skipped = SKIPPED_TOO_MANY; return null; }
    const fits = await mapLimit(untracked, STAT_AT_ONCE, async f => {
      try { return (await fs.promises.stat(path.join(root, f))).size <= MAX_UNTRACKED_BYTES; } catch { return false; }
    });
    const small = untracked.filter((_f, i) => fits[i]);
    if (small.length) {
      const added = await git(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: small.join('\0') });
      if (!added.ok) return null;
    }
    const tree = await git(root, ['write-tree'], { env });
    const t = tree.ok && tree.out.trim();
    return t && TREE.test(t) ? { root, tree: t, head } : null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => { /* temp dir */ });
  }
}

/** fn over items, at most `limit` at a time, results in order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Do two folders belong to the same repository (a checkout and its worktrees
 * do: they share one object store, so a snapshot of one diffs against the other)?
 */
async function sameRepo(a, b) {
  // Relative to the folder when git says so (and every git does, before 2.31's --path-format).
  const common = async dir => {
    const r = await git(dir, ['rev-parse', '--git-common-dir'], { timeout: 5000 });
    return r.ok && r.out.trim() ? path.resolve(dir, r.out.trim()).toLowerCase() : null;
  };
  const [x, y] = await Promise.all([common(a), common(b)]);
  return !!x && x === y;
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

// Tools that never write to the folder. Anything else (a shell, an MCP tool
// nobody knows) could have written anywhere in it.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'AskUserQuestion', 'Skill', 'Agent', 'Task', 'SendMessage', 'ListAgents', 'TaskStop', 'Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
  'EnterPlanMode', 'ExitPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'PushNotification', 'ReportFindings',
]);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELLBY_TOOL = /^mcp__(plugin_shellby_)?shellby__/;

// A path as git names it: long names (no 8.3 RUNNER~1), links followed. A file
// a Write is about to create isn't there yet, so its folder is looked up instead.
function realPath(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* not there yet */ }
  try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}

/** A fresh record of what a turn's own tools could have written. */
const newTouch = () => ({ paths: new Set(), broad: false });

/** Adds one tool call to a turn's record (the record is the turn's own, so it's added to in place). */
function noteTool(touch, item) {
  if (!touch || item?.kind !== 'tool' || typeof item.name !== 'string') return;
  if (FILE_TOOLS.has(item.name)) {
    if (typeof item.filePath === 'string' && item.filePath) touch.paths.add(realPath(item.filePath));
    else touch.broad = true;
  } else if (!READ_ONLY_TOOLS.has(item.name) && !SHELLBY_TOOL.test(item.name)) {
    touch.broad = true;
  }
}

// An absolute path as git names it in this repo (forward slashes), lower-cased to compare; null when outside it.
function relKey(root, abs) {
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/').toLowerCase() : null;
}

/**
 * A turn's diff, cut down to what this conversation could have done: two
 * conversations in one folder must never claim (or undo) each other's work.
 *   mine: { paths, broad }, this turn's tools. Without a shell or an unknown
 *   tool, only the files its Edit/Write calls named count.
 *   others: [{ paths }], files other conversations' tools edited in the same
 *   folder while this turn ran; a turn with a shell still never claims those.
 * Pure. -> summary (scoped: true, when anything was cut) | null
 */
function scope(summary, mine, others = []) {
  if (!summary || !mine) return summary || null;
  const keys = set => new Set([...set].map(p => relKey(summary.root, p)).filter(Boolean));
  let keep;
  if (!mine.broad) {
    const own = keys(mine.paths);
    keep = f => own.has(f.path.toLowerCase());
  } else {
    const theirs = new Set(others.flatMap(o => [...keys(o.paths)]));
    keep = f => !theirs.has(f.path.toLowerCase());
  }
  const files = summary.files.filter(keep);
  if (files.length === summary.files.length) return summary;
  if (!files.length) return null;
  return {
    ...summary, files, scoped: true, more: 0,
    added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

/** Checks the renderer's word before any of it reaches git. -> error string | null */
function checkRef({ root, before, after, file, paths } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > 400) return 'Not a project folder.';
  if (!TREE.test(before || '') || !TREE.test(after || '')) return 'Not a snapshot.';
  const badFile = f => typeof f !== 'string' || !f || f.length > 1000 || f.includes('\0') || path.isAbsolute(f) || f.split(/[\\/]/).includes('..');
  if (file != null && badFile(file)) return 'Not a file in this change.';
  if (paths != null && (!Array.isArray(paths) || paths.length > MAX_FILES || paths.some(badFile))) return 'Not a file in this change.';
  return null;
}

/** One file's diff for a turn, as unified-diff text. -> { patch, truncated } | { error } */
async function patchFor(ref) {
  const bad = checkRef(ref);
  if (bad) return { error: bad };
  const root = await rootOf(ref.root);
  if (!sameRoot(root, ref.root)) return { error: 'That project has moved.' };
  const r = await git(root, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', ref.before, ref.after, '--', ...(ref.file ? [ref.file] : ref.paths || [])], { maxBuffer: 16 * 1024 * 1024 });
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
  const all = await changedFiles(root, ref.before, ref.after);
  if (!all) return { ok: false, error: 'Those changes have been tidied away by git since.' };
  // A scoped turn puts back only its own files, never another conversation's.
  const own = ref.paths ? new Set(ref.paths) : null;
  const turn = own ? all.filter(f => own.has(f.path)) : all;
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

  return putBack(root, ref.before, turn);
}

// Files created since `source` go; the rest come back from it. -> undo()'s answer
async function putBack(root, source, files) {
  for (const f of files.filter(f => f.status === 'A')) {
    const abs = path.resolve(root, f.path);
    if (!abs.startsWith(root + path.sep)) continue;
    try { fs.rmSync(abs, { force: true }); } catch (e) { return { ok: false, error: `Couldn't remove ${f.path}: ${e.message}` }; }
  }
  const back = files.filter(f => f.status !== 'A').map(f => f.path);
  if (back.length) {
    const r = await git(root, ['restore', `--source=${source}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: back.join('\0') });
    if (!r.ok) return { ok: false, error: r.error || "git couldn't put them back." };
  }
  return { ok: true, restored: files.length };
}


// ---- checkpoints that git keeps
//
// A snapshot is a loose tree nothing points at, so `git gc` may sweep it once
// it's a couple of weeks old, and with it the way back to before that turn.
// Each turn's two ends are pinned under a private ref (refs/shellby/turns/...):
// a commit of the "before" tree, and one of the "after" tree on top of it.
// Not a branch, not the stash: `git branch`, `git log` and `git stash list`
// never show them. Only the newest MAX_PINNED stay pinned.

const PIN_PREFIX = 'refs/shellby/turns/';
const MAX_PINNED = 200;
const PIN_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const PIN_ENV = { GIT_AUTHOR_NAME: 'Shellby', GIT_AUTHOR_EMAIL: 'shellby@localhost', GIT_COMMITTER_NAME: 'Shellby', GIT_COMMITTER_EMAIL: 'shellby@localhost' };

/** The ref a turn's checkpoint is pinned under, or null for a name that can't be one. */
const pinRef = name => (typeof name === 'string' && PIN_NAME.test(name) ? `${PIN_PREFIX}${name}` : null);

/**
 * Keep a turn's before and after trees from being swept away. name: the turn's
 * id. -> the ref | null. Never throws.
 */
async function pin(root, before, after, name) {
  const ref = pinRef(name);
  if (!ref || typeof root !== 'string' || !TREE.test(before || '') || !TREE.test(after || '')) return null;
  const first = await git(root, ['commit-tree', before, '-m', `Shellby: before turn ${name}`], { env: PIN_ENV, timeout: 5000 });
  const base = first.ok && first.out.trim();
  if (!base || !TREE.test(base)) return null;
  const second = before === after ? { ok: true, out: base } : await git(root, ['commit-tree', after, '-p', base, '-m', `Shellby: after turn ${name}`], { env: PIN_ENV, timeout: 5000 });
  const tip = second.ok && second.out.trim();
  if (!tip || !TREE.test(tip)) return null;
  const set = await git(root, ['update-ref', ref, tip], { timeout: 5000 });
  if (!set.ok) return null;
  await prunePins(root);
  return ref;
}

/** Every pinned turn, newest first: [{ ref, name, at }]. */
async function pins(root) {
  const r = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(committerdate:unix)', PIN_PREFIX], { timeout: 5000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map(l => {
    const [ref, at] = l.split('\t');
    return { ref, name: ref.slice(PIN_PREFIX.length), at: Number(at) * 1000 || 0 };
  });
}

/** Unpins all but the newest `keep`. -> how many went. */
async function prunePins(root, keep = MAX_PINNED) {
  const old = (await pins(root)).slice(Math.max(0, keep));
  if (!old.length) return 0;
  const r = await git(root, ['update-ref', '--stdin'], { input: old.map(p => `delete ${p.ref}\n`).join(''), timeout: 10000 });
  return r.ok ? old.length : 0;
}

/**
 * Part of a turn taken back: the files that changed between `to` (a checkpoint
 * inside the turn, step-undo.js) and `from` (where the turn's work stands now)
 * go back to `to`. Unlike undo(), files changed again since `from` are only
 * refused until `force`: the caller asks first.
 *   -> { ok: true, restored } | { ok: false, error, changedSince? }
 */
async function restoreTo({ root: dir, to, from, paths } = {}, { force = false } = {}) {
  const bad = checkRef({ root: dir, before: to, after: from, paths });
  if (bad) return { ok: false, error: bad };
  const root = await rootOf(dir);
  if (!sameRoot(root, dir)) return { ok: false, error: 'That project has moved.' };
  const all = await changedFiles(root, to, from);
  if (!all) return { ok: false, error: 'Those changes have been tidied away by git since.' };
  // A scoped turn (scope()) puts back only its own files, never another conversation's.
  const own = paths ? new Set(paths) : null;
  const files = own ? all.filter(f => own.has(f.path)) : all;
  if (!files.length) return { ok: true, restored: 0 };
  if (!force) {
    const now = await snapshot(root);
    if (!now) return { ok: false, error: "Couldn't take a look at the folder as it is now." };
    const since = await changedFiles(root, from, now.tree);
    if (!since) return { ok: false, error: "Couldn't compare with the folder as it is now." };
    const touched = new Set(since.map(f => f.path));
    const changedSince = files.map(f => f.path).filter(p => touched.has(p));
    if (changedSince.length) return { ok: false, changedSince, error: `${changedSince.length === 1 ? 'A file has' : `${changedSince.length} files have`} changed since this turn.` };
  }
  return putBack(root, to, files);
}

// ---- one hunk at a time
//
// A file's diff split at its @@ lines: { head: the lines before the first
// hunk, hunks: [text of each hunk, header line first] }.
function splitHunks(patch) {
  const lines = String(patch || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const first = lines.findIndex(l => l.startsWith('@@'));
  if (first < 0) return { head: lines, hunks: [] };
  const hunks = [];
  for (const l of lines.slice(first)) {
    if (l.startsWith('@@')) hunks.push([l]);
    else hunks[hunks.length - 1].push(l);
  }
  return { head: lines.slice(0, first), hunks: hunks.map(h => h.join('\n')) };
}

/**
 * Take back one hunk of one file a turn changed. `ref.after` is where the
 * turn's work stands now (step-undo.js effectiveAfter), `hunk` the hunk's
 * index in that diff and `header` its @@ line as the panel showed it, so a
 * diff that moved on since can't take back the wrong lines. Refuses when the
 * file changed again since, like undo(). Only modified files: a new file is
 * one hunk, and taking it back is the whole turn's Undo.
 *   -> { ok: true, to: the turn's new "after" tree } | { ok: false, error, changedSince? }
 */
async function undoHunk(ref, { hunk, header } = {}) {
  const bad = checkRef(ref);
  if (bad) return { ok: false, error: bad };
  if (!ref.file) return { ok: false, error: 'Not a file in this change.' };
  if (!Number.isInteger(hunk) || hunk < 0 || typeof header !== 'string' || !header.startsWith('@@')) return { ok: false, error: 'Not a part of this diff.' };
  const root = await rootOf(ref.root);
  if (!sameRoot(root, ref.root)) return { ok: false, error: 'That project has moved.' };

  const r = await git(root, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', ref.before, ref.after, '--', ref.file], { maxBuffer: 16 * 1024 * 1024 });
  if (!r.ok) return { ok: false, error: /bad object|not a tree|unknown revision/i.test(r.error) ? 'Those changes have been tidied away by git since.' : r.error || "Couldn't read the diff." };
  if (/^(new file|deleted file) mode/m.test(r.out) || /^Binary files /m.test(r.out)) return { ok: false, error: 'Only a changed file can be taken back a part at a time.' };
  const { head, hunks } = splitHunks(r.out);
  if (!hunks[hunk] || hunks[hunk].split('\n')[0] !== header) return { ok: false, error: 'That diff has changed since. Open it again.' };

  // Anything that touched this file after the turn would be overwritten.
  const now = await snapshot(root);
  if (!now) return { ok: false, error: "Couldn't take a look at the folder as it is now." };
  const since = await changedFiles(root, ref.after, now.tree);
  if (!since) return { ok: false, error: "Couldn't compare with the folder as it is now." };
  if (since.some(f => f.path === ref.file)) return { ok: false, changedSince: [ref.file], error: `${ref.file} has changed since this turn. Undo the later changes first.` };

  // git apply puts it back through the repo's own filters (line endings and
  // the like), and refuses rather than half-applies if anything doesn't fit.
  const one = `${[...head, hunks[hunk]].join('\n')}\n`;
  const applied = await git(root, ['apply', '-R', '--whitespace=nowarn', '-'], { input: one });
  if (!applied.ok) return { ok: false, error: applied.error || "git couldn't take that part back." };

  // The turn now stands at its old "after" with this one file as it is on disk.
  const to = await treeWith(root, ref.after, ref.file);
  if (!to) return { ok: false, error: "Took it back, but couldn't note where the turn stands now." };
  return { ok: true, to };
}

// `tree` with `file` replaced by what's on disk now. -> tree sha | null
async function treeWith(root, tree, file) {
  const mode = await git(root, ['ls-tree', '-z', tree, '--', file], { timeout: 5000 });
  const m = mode.ok && /^(\d{6}) blob /.exec(mode.out);
  if (!m) return null;
  const blob = await git(root, ['hash-object', '-w', '--', file], { timeout: 10000 });
  const sha = blob.ok && blob.out.trim();
  if (!sha || !TREE.test(sha)) return null;
  const tmp = path.join(os.tmpdir(), `shellby-index-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    if (!(await git(root, ['read-tree', tree], { env })).ok) return null;
    if (!(await git(root, ['update-index', '-z', '--index-info'], { env, input: `${m[1]} ${sha}\t${file}\0` })).ok) return null;
    const out = await git(root, ['write-tree'], { env });
    const t = out.ok && out.out.trim();
    return t && TREE.test(t) ? t : null;
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => { /* temp file */ });
  }
}

module.exports = { pin, pins, prunePins, pinRef, PIN_PREFIX, MAX_PINNED, snapshot, SKIPPED_TOO_MANY, MAX_UNTRACKED, mapLimit, summarize, scope, newTouch, noteTool, patchFor, undo, undoHunk, splitHunks, restoreTo, parseDiffSummary, checkRef, rootOf, sameRepo, TREE };
