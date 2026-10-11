// The file viewer's side of main (renderer/panel/viewer.js): which folders the
// panel may read, what changed in them, and nothing else.
//
// The panel never names a path or a git ref to read. It opens a handle on a
// conversation's folder (or a worktree the Project page listed), and every read
// after that is confined to the handle's root, resolved with links followed
// and 8.3 names expanded, so a junction can't lead out of it. Diffs are served
// only for files on the handle's own changes list, as changeRef does for a turn.
//
// execFile with fixed arguments, timeouts, and never throws to the caller.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const changes = require('./changes');
const { parseTarget } = require('./filelinks');
const { parseWorktrees, okDir } = require('./leaving');

const MAX_BYTES = 2 * 1024 * 1024;   // past this, "Open in editor" instead
const SNIFF_BYTES = 8 * 1024;        // a NUL in here: not text
const MAX_HANDLES = 8;               // folders open at once; the oldest goes first
const REFRESH_MS = 2000;             // a look again sooner than this is answered from the last one
const GIT_TIMEOUT_MS = 8000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // what a repo with no commits is compared with

function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out) => resolve(err ? null : String(out)));
  });
}

// A path with links followed and 8.3 names expanded, or null when it isn't there.
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Strictly inside root (root itself isn't). Both already resolved; win32 compares without case.
const isUnder = (root, abs) => {
  const rel = path.relative(root, abs);
  return !!rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
};
const sameDir = (a, b) => {
  const x = typeof a === 'string' ? longPath(a) : null;
  const y = typeof b === 'string' ? longPath(b) : null;
  return !!x && !!y && path.relative(x, y) === '';
};

// A relative path made only of plain names: no drive (C:x), no stream (a.txt:s), no
// UNC or rooted start, no '..'. Checked before anything touches the disk, so a
// network path never makes Windows log in to a host (as filelinks.js refuses too).
const plainRel = rel => typeof rel === 'string' && !!rel && rel.length <= 1000 && !/[\0:]/.test(rel)
  && !/^[\\/]/.test(rel) && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');

// Outside the folder and not there at all answer alike: the panel learns nothing about other files.
const NOT_HERE = { ok: false, missing: true };

/** A file under root, as text. rel: as git names it (forward slashes) or the OS does. */
async function readInside(root, rel) {
  const top = typeof root === 'string' ? longPath(root) : null;
  if (!top) return { ok: false, gone: true };
  if (!plainRel(rel)) return { ...NOT_HERE };
  const abs = path.resolve(top, rel);
  if (!isUnder(top, abs)) return { ...NOT_HERE };
  const file = longPath(abs); // links followed: a junction out of the folder ends outside it
  if (!file || !isUnder(top, file)) return { ...NOT_HERE };
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return { ...NOT_HERE }; }
  try {
    // Swapped for a link between the check and the open: the file opened must still be the one inside.
    const st = await fh.stat({ bigint: true });
    const again = longPath(abs);
    if (!again || !isUnder(top, again)) return { ...NOT_HERE };
    const now = await fs.promises.stat(again, { bigint: true });
    if (now.ino !== st.ino || now.dev !== st.dev) return { ...NOT_HERE };
    if (!st.isFile()) return { ok: false, error: 'Not a file.' };
    const size = Number(st.size);
    if (size > MAX_BYTES) return { ok: false, tooBig: true, size };
    const buf = await fh.readFile();
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { ok: false, binary: true, size };
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, text, size };
  } catch {
    return { ...NOT_HERE };
  } finally {
    await fh.close().catch(() => {});
  }
}

// A worktree that isn't the main checkout is compared with the branch the main
// checkout is on; the main checkout itself has no base (HEAD, then).
async function mainBranchFor(root) {
  const [main] = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain']));
  return main && !sameDir(main.path, root) ? main.branch || null : null;
}

/** The branch a folder's repo is on, or null (not a repo, or detached). */
async function branchOf(dir) {
  const top = await changes.rootOf(dir);
  const head = top ? (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() : null;
  return head && head !== 'HEAD' ? head : null;
}

/** A file link from a reply: inside the conversation's repo (a file there), or not. */
async function locate(cwd, target) {
  const t = parseTarget(target, cwd);
  if (!t) return { inside: false };
  const root = longPath((await changes.rootOf(cwd)) || cwd);
  const file = longPath(t.file);
  if (!root || !file || !isUnder(root, file)) return { inside: false };
  try { if (!fs.statSync(file).isFile()) return { inside: false }; } catch { return { inside: false }; }
  return { inside: true, rel: path.relative(root, file).split(path.sep).join('/'), line: t.line };
}

/** Tool calls that could write, until their results come in; then nudge(cwd) once for each. */
function writeWatch(nudge) {
  const writing = new Set();
  return (item, cwd) => {
    if (changes.mayWrite(item) && item.id) {
      writing.add(item.id);
      if (writing.size > 200) writing.delete(writing.values().next().value);
    } else if (item?.kind === 'tool_result' && writing.delete(item.id) && typeof cwd === 'string') {
      nudge(cwd);
    }
  };
}

function createViewer() {
  // id -> { id, root, git, branch, base, tabId, gen, shown, slots, pending, last }, the last four each by mode ('base' | 'head'):
  // slots[mode] = { files: Map(lower path -> file), ref } (what a diff is cut from), pending[mode] = a look running,
  // last[mode] = { at, result }; shown = the mode of the list the panel was last handed; gen counts nudges.
  const handles = new Map();
  let line = Promise.resolve(); // viewer snapshots take turns: eight handles never hash a big repo at once

  async function open({ dir, base = null, tabId = null } = {}) {
    // A local folder only: a network share would make Windows log in to it (leaving.js okDir).
    if (!okDir(dir)) return { ok: false, error: 'Open what?' };
    const top = await changes.rootOf(dir);
    const root = longPath(top || dir);
    if (!root) return { ok: false, gone: true, error: 'This folder is gone.' };
    const branch = top ? await branchOf(root) : null;
    const against = top ? (typeof base === 'string' && base ? base : await mainBranchFor(root)) : null;
    const id = crypto.randomBytes(8).toString('hex');
    if (handles.size >= MAX_HANDLES) handles.delete(handles.keys().next().value);
    handles.set(id, { id, root, git: !!top, branch, base: against, tabId, gen: 0, shown: null, slots: {}, pending: {}, last: {} });
    return { ok: true, id, root, name: path.basename(root), branch, base: against, git: !!top };
  }

  async function compute(h, key) {
    const uncommittedOnly = key === 'head';
    if (!longPath(h.root)) return { ok: false, gone: true, error: 'This folder is gone.' };
    const info = {};
    const snap = await changes.snapshot(h.root, info, { hooks: false });
    if (!snap) return info.skipped ? { ok: false, tooManyNew: true, error: 'Too many new files to compare.' } : { ok: false, error: "Couldn't read changes." };
    const fork = !uncommittedOnly && h.base ? (await git(h.root, ['merge-base', h.base, 'HEAD']))?.trim() || null : null;
    const before = fork || snap.head || EMPTY_TREE;
    const sum = await changes.summarize({ root: snap.root, tree: before }, snap);
    const files = sum?.files || [];
    // In a snapshot an untracked file is just another added one: git status says which.
    if (files.some(f => f.status === 'A')) {
      const out = await git(h.root, ['status', '--porcelain', '-z', '--untracked-files=all']);
      const fresh = new Set(String(out || '').split('\0').filter(s => s.startsWith('?? ')).map(s => s.slice(3).toLowerCase()));
      for (const f of files) if (f.status === 'A' && fresh.has(f.path.toLowerCase())) f.status = '?';
    }
    h.slots[key] = { ref: { root: snap.root, before, after: snap.tree }, files: new Map(files.map(f => [f.path.toLowerCase(), f])) };
    return { ok: true, files, more: sum?.more || 0, against: fork ? h.base : 'HEAD' };
  }

  function changesOf(id, { uncommittedOnly = false } = {}) {
    const h = handles.get(id);
    if (!h) return Promise.resolve({ ok: false, expired: true });
    if (!h.git) return Promise.resolve({ ok: true, noGit: true, files: [], more: 0, against: null });
    const key = uncommittedOnly ? 'head' : 'base';
    // The list handed out is the one a diff is cut from.
    const shown = result => { if (result.ok) h.shown = key; return result; };
    // Asked twice while the first is still hashing the folder, or again within 2 s: one snapshot answers both.
    if (h.pending[key]) return h.pending[key].then(shown);
    const last = h.last[key];
    if (last && Date.now() - last.at < REFRESH_MS) return Promise.resolve(shown(last.result));
    const gen = h.gen;
    const p = line.then(() => compute(h, key)).then(result => {
      // A nudge while it ran: this look may predate the write, so it answers no later call.
      if (result.ok && h.gen === gen) h.last[key] = { at: Date.now(), result };
      return result;
    }).finally(() => { if (h.pending[key] === p) delete h.pending[key]; });
    line = p.catch(() => {});
    h.pending[key] = p;
    return p.then(shown);
  }

  async function diffOf(id, rel) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    const slot = h.slots[h.shown];
    const f = typeof rel === 'string' ? slot?.files.get(rel.toLowerCase()) : null;
    if (!f) return { ok: false, error: 'Not a file in these changes.' };
    const r = await changes.patchFor({ ...slot.ref, file: f.path });
    return r.error ? { ok: false, error: r.error } : { ok: true, patch: r.patch, truncated: r.truncated, binary: f.binary };
  }

  async function read(id, rel) {
    const h = handles.get(id);
    return h ? readInside(h.root, rel) : { ok: false, expired: true };
  }

  // The handles a changed folder belongs to. Their last look no longer answers a repeat, and a look
  // still running no longer answers one either (it may have hashed the folder before the write):
  // the 2 s reuse only absorbs asking twice, never a real change.
  function staleFor(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return [];
    const at = longPath(dir) || path.resolve(dir);
    const hit = [...handles.values()].filter(h => path.relative(h.root, at) === '' || isUnder(h.root, at));
    for (const h of hit) { h.gen++; h.last = {}; h.pending = {}; }
    return hit.map(h => h.id);
  }

  // A conversation closed: the handles opened from it go too (the Project page's belong to no tab).
  function keepTabs(open) {
    for (const [id, h] of handles) if (h.tabId && !open.has(h.tabId)) handles.delete(id);
  }

  return { open, get: id => handles.get(id) || null, changesOf, diffOf, read, close: id => { handles.delete(id); }, staleFor, keepTabs };
}

module.exports = { readInside, sameDir, isUnder, longPath, createViewer, locate, branchOf, writeWatch, MAX_BYTES, SNIFF_BYTES, MAX_HANDLES, REFRESH_MS, EMPTY_TREE };
