// The file viewer's side of main (renderer/panel/viewer.js): which folders and
// branches the panel may read, what changed in them, and nothing else.
//
// The panel never names a path or a git ref to read. It opens a handle on a
// conversation's folder (or a worktree the Project page listed), and every read
// after that is confined to the handle's root, resolved with links followed
// and 8.3 names expanded, so a junction can't lead out of it. Diffs are served
// only for files on the handle's own changes list, as changeRef does for a turn.
// A branch handle (picked from the header's menu by a key main issued) reads a
// branch nothing has checked out from git alone: no checkout, no index, no hook.
//
// execFile with fixed arguments, timeouts, and never throws to the caller.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const changes = require('./changes');
const fileIndex = require('./fileindex');
const { parseTarget } = require('./filelinks');
const { parseWorktrees, okDir } = require('./leaving');

const { TREE } = changes;
const HEADS = 'refs/heads/';
const HEAD_REF = /^refs\/heads\/[^\0\n\r]+$/; // a local branch by its full name, which git never reads as an option

const MAX_BYTES = 2 * 1024 * 1024;   // past this, "Open in editor" instead
const SNIFF_BYTES = 8 * 1024;        // a NUL in here: not text
const MAX_HANDLES = 8;               // folders open at once; the oldest goes first
const REFRESH_MS = 2000;             // a look again sooner than this is answered from the last one
const GIT_TIMEOUT_MS = 8000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // what a repo with no commits is compared with
const TREE_MAX = 30000;              // All files on a branch, at most (fileindex.js lists a folder to the same)

// buffer: the output as bytes (a blob, sniffed for NUL before it's decoded). env: added to git's own.
// exit: answer { code, out } (code: git's exit code, null when it didn't run or timed out) rather than
// the output or null, for a caller that tells one failure from another.
// Nothing is ever fetched (changes.js NO_FETCH_ARGS says why): lazy fetch off, and no transport at all,
// so a repo that says it is a partial clone can't make git run the program its config names.
function git(cwd, args, { buffer = false, env = null, maxBuffer = 8 * 1024 * 1024, exit = false } = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: buffer ? 'buffer' : 'utf8',
      env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    }, (err, out) => {
      const said = err ? null : buffer ? out : String(out);
      resolve(!exit ? said : { code: !err ? 0 : Number.isInteger(err.code) ? err.code : null, out: said ?? '' });
    });
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

// Too wide to browse: the home folder, a folder above it, or a whole drive. A conversation started
// in ~ (where Shellby starts one by default), or in a folder of a dotfiles repo at ~, would otherwise
// hand the panel .ssh, .aws and .claude. Anything at or above a too-wide folder is too wide as well,
// so a repo's root is checked along with the folder asked about. -> the reason, or null
function tooWide(dir, home = os.homedir()) {
  if (typeof dir !== 'string' || !dir) return 'Open what?';
  const key = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  const at = key(longPath(dir) || path.resolve(dir));
  if (path.parse(at).root === at) return "Shellby doesn't browse a whole drive.";
  const h = typeof home === 'string' && home ? key(longPath(home) || path.resolve(home)) : null;
  return h && (path.relative(at, h) === '' || isUnder(at, h)) ? "Shellby doesn't browse your whole home folder." : null;
}

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

// A branch's tip commit, or null (gone, or git couldn't say). The ref is always a full refs/heads/
// name, which never starts with '-': a branch called "-x" can't reach git as an option.
async function tipOf(root, ref) {
  const out = (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim();
  return out && TREE.test(out) ? out : null;
}

// The repo's worktree folders, resolved: where a branch's next commit is made. Local ones only, and
// none too wide to browse: a record in .git/worktrees can name any folder, the home folder included,
// and a turn ending anywhere under it would then nudge every viewer on the repo's branches.
async function treesOf(root, home) {
  const listed = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain']))
    .filter(w => okDir(w.path) && !tooWide(w.path, home)).map(w => longPath(w.path)).filter(Boolean);
  return listed.length ? listed : [root];
}

/** The branch a folder's repo is on, or null (not a repo, detached, or a folder too wide to browse). */
async function branchOf(dir, { home = os.homedir() } = {}) {
  const top = await changes.rootOf(dir);
  if (top && (tooWide(dir, home) || tooWide(top, home))) return null;
  const head = top ? (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() : null;
  return head && head !== 'HEAD' ? head : null;
}

/** A file link from a reply: inside the conversation's repo (a file there), or not. Never in a folder too wide to browse. */
async function locate(cwd, target, { home = os.homedir() } = {}) {
  const t = parseTarget(target, cwd);
  if (!t) return { inside: false };
  const root = longPath((await changes.rootOf(cwd)) || cwd);
  if (!root || tooWide(cwd, home) || tooWide(root, home)) return { inside: false };
  const file = longPath(t.file);
  if (!file || !isUnder(root, file)) return { inside: false };
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

/** opts.home: the home folder, never browsed (tests give their own). */
function createViewer({ home = os.homedir() } = {}) {
  // id -> { id, kind, root, git, branch, base, tabId, origin, gen, shown, slots, pending, last, places, placing }.
  // kind 'folder' reads its folder; kind 'branch' reads git alone and adds { ref, commit, trees, tree }
  // (tree = { commit, p }: the one ls-tree for that commit, running or done, failed or not).
  // slots, pending and last are each by mode ('base' | 'head'; a branch has only 'base'):
  // slots[mode] = { files: Map(path key -> file), ref } (what a diff is cut from), pending[mode] = a
  // look running, last[mode] = { at, result }; shown = the mode of the list the panel was last handed;
  // gen counts nudges. origin = { tabId, root, base }: the conversation the first handle was opened
  // from, carried through the header menu's picks; places = that menu's list (placesOf), placing = its
  // build while one runs.
  const handles = new Map();
  let line = Promise.resolve(); // viewer snapshots take turns: eight handles never hash a big repo at once

  function add(fields) {
    const id = crypto.randomBytes(8).toString('hex');
    if (handles.size >= MAX_HANDLES) handles.delete(handles.keys().next().value);
    const h = { id, gen: 0, shown: null, slots: {}, pending: {}, last: {}, places: null, placing: null, ...fields };
    handles.set(id, h);
    return h;
  }

  // origin: given when a pick from the header's menu opens it. The handle belongs to the conversation
  // (keepTabs) only while it shows that conversation's own folder, and then compares with its base.
  async function open({ dir, base = null, tabId = null, origin = null } = {}) {
    // A local folder only: a network share would make Windows log in to it (leaving.js okDir).
    if (!okDir(dir)) return { ok: false, error: 'Open what?' };
    const top = await changes.rootOf(dir);
    const root = longPath(top || dir);
    if (!root) return { ok: false, gone: true, error: 'This folder is gone.' };
    const wide = tooWide(dir, home) || tooWide(root, home);
    if (wide) return { ok: false, error: wide };
    const given = typeof base === 'string' && base ? base : null;
    const from = tabId ? { tabId, root, base: given } : origin;
    const own = !!from && sameDir(from.root, root);
    const branch = top ? await branchOf(root, { home }) : null;
    const against = top ? given || (own ? from.base : null) || await mainBranchFor(root) : null;
    const h = add({ kind: 'folder', root, git: !!top, branch, base: against, tabId: own ? from.tabId : null, origin: from });
    return { ok: true, id: h.id, root, name: path.basename(root), branch, base: against, git: !!top, kind: 'folder' };
  }

  // A branch nothing has checked out (switchTo opens these): its commits since it left base, their
  // diffs, its tree and its files, all read from git. root: the folder of the handle it was picked from.
  async function openBranch({ root, ref, base = null, origin = null } = {}) {
    if (!okDir(root) || typeof ref !== 'string' || !HEAD_REF.test(ref)) return { ok: false, error: 'Open what?' };
    const top = longPath(root);
    if (!top) return { ok: false, gone: true, error: 'This folder is gone.' };
    const wide = tooWide(top, home);
    if (wide) return { ok: false, error: wide };
    const commit = await tipOf(top, ref);
    if (!commit) return { ok: false, gone: true, error: 'That worktree or branch is gone.' };
    const branch = ref.slice(HEADS.length);
    const against = typeof base === 'string' && base ? base : null;
    const h = add({ kind: 'branch', root: top, git: true, ref, commit, branch, base: against, tabId: null, origin, trees: await treesOf(top, home), tree: null });
    return { ok: true, id: h.id, root: top, name: path.basename(top), branch, base: against, git: true, kind: 'branch' };
  }

  async function computeFolder(h, key) {
    const uncommittedOnly = key === 'head';
    if (!longPath(h.root)) return { ok: false, gone: true, error: 'This folder is gone.' };
    const info = {};
    const snap = await changes.snapshot(h.root, info, { hooks: false, noFetch: true });
    if (!snap) return info.skipped ? { ok: false, tooManyNew: true, error: 'Too many new files to compare.' } : { ok: false, error: "Couldn't read changes." };
    // The base by its full name: a main checkout on a branch called "--fork-point" would otherwise
    // reach merge-base as that option. One that doesn't resolve (a 'HEAD' base, a deleted branch)
    // compares with HEAD, as a base git can't find always has.
    const mb = !uncommittedOnly && h.base ? (await git(h.root, ['merge-base', `${HEADS}${h.base}`, 'HEAD']))?.trim() : null;
    const fork = mb && TREE.test(mb) ? mb : null;
    const before = fork || snap.head || EMPTY_TREE;
    const diff = {};
    const sum = await changes.summarize({ root: snap.root, tree: before }, snap, { noFetch: true, info: diff });
    if (diff.failed) return { ok: false, error: "Couldn't read changes." }; // not "Nothing has changed here."
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

  // A branch's changes: its own commits since it left base, or all of it (from the empty tree) when
  // they share no history. The tip is read again each time, so new commits show.
  async function computeBranch(h) {
    const commit = await tipOf(h.root, h.ref);
    if (!commit) {
      if (!longPath(h.root)) return { ok: false, gone: true, error: 'This folder is gone.' };
      // rev-parse answers null for a missing ref and for a git that didn't run: ask git something else.
      const alive = await git(h.root, ['rev-parse', '--git-dir']);
      return alive === null ? { ok: false, error: "Couldn't read changes." } : { ok: false, branchGone: true, error: 'This branch is gone.' };
    }
    h.commit = commit;
    h.trees = await treesOf(h.root, home);
    // merge-base exits 1 when the two share no history: then all of the branch is new, from the empty
    // tree. Any other failure (a timeout, a base that no longer resolves) is said, with Retry, rather
    // than shown as the whole branch added "(from main)".
    let before = EMPTY_TREE;
    if (h.base) {
      const mb = await git(h.root, ['merge-base', `${HEADS}${h.base}`, commit], { exit: true });
      const fork = mb.code === 0 ? mb.out.trim() : '';
      if (TREE.test(fork)) before = fork;
      else if (mb.code !== 1) return { ok: false, error: "Couldn't read changes." };
    }
    const diff = {};
    const sum = await changes.summarize({ root: h.root, tree: before }, { root: h.root, tree: commit }, { noFetch: true, info: diff });
    if (diff.failed) return { ok: false, error: "Couldn't read changes." }; // a missing object, a timeout: not "nothing changed"
    const files = sum?.files || [];
    // Git's own spelling: a branch can hold A.txt and a.txt, and nothing on disk folds them.
    h.slots.base = { ref: { root: h.root, before, after: commit }, files: new Map(files.map(f => [f.path, f])) };
    return { ok: true, files, more: sum?.more || 0, against: h.base };
  }

  function changesOf(id, { uncommittedOnly = false } = {}) {
    const h = handles.get(id);
    if (!h) return Promise.resolve({ ok: false, expired: true });
    if (!h.git) return Promise.resolve({ ok: true, noGit: true, files: [], more: 0, against: null });
    // A branch is all commits: Just uncommitted doesn't apply to it.
    const key = h.kind === 'folder' && uncommittedOnly ? 'head' : 'base';
    // The list handed out is the one a diff is cut from.
    const shown = result => { if (result.ok) h.shown = key; return result; };
    // Asked twice while the first is still hashing the folder, or again within 2 s: one snapshot answers both.
    if (h.pending[key]) return h.pending[key].then(shown);
    const last = h.last[key];
    if (last && Date.now() - last.at < REFRESH_MS) return Promise.resolve(shown(last.result));
    const gen = h.gen;
    // A branch is a few quick git reads: it never waits behind a folder's snapshot.
    const look = h.kind === 'branch' ? computeBranch(h) : line.then(() => computeFolder(h, key));
    const p = look.then(result => {
      // A nudge while it ran: this look may predate the write, so it answers no later call.
      if (result.ok && h.gen === gen) h.last[key] = { at: Date.now(), result };
      return result;
    }).finally(() => { if (h.pending[key] === p) delete h.pending[key]; });
    if (h.kind !== 'branch') line = p.catch(() => {});
    h.pending[key] = p;
    return p.then(shown);
  }

  async function diffOf(id, rel) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    const slot = h.slots[h.shown];
    const f = typeof rel === 'string' ? slot?.files.get(h.kind === 'branch' ? rel : rel.toLowerCase()) : null;
    if (!f) return { ok: false, error: 'Not a file in these changes.' };
    const r = await changes.patchFor({ ...slot.ref, file: f.path }, { noFetch: true });
    return r.error ? { ok: false, error: r.error } : { ok: true, patch: r.patch, truncated: r.truncated, binary: f.binary };
  }

  // The paths in a branch's tree at a commit: one ls-tree per commit, shared by every ask while it runs,
  // and a failure (a timeout, a listing over 32 MB, a tree git can't read) kept for that commit rather
  // than run again on each read. -> Promise<{ commit, list, set } | null>
  function pathsAt(h, commit) {
    if (h.tree?.commit !== commit) {
      const p = git(h.root, ['ls-tree', '-r', '-z', '--name-only', commit], { maxBuffer: 32 * 1024 * 1024 }).then(out => {
        if (out === null) return null;
        // All files lists at most TREE_MAX; Whole file reads any path the tree has.
        const all = out.split('\0').filter(Boolean);
        return { commit, list: all.slice(0, TREE_MAX), set: new Set(all) };
      });
      h.tree = { commit, p };
    }
    return h.tree.p;
  }

  // A file of a branch, from its newest commit read. Only a path its own tree lists (git's spelling, case
  // and all): cat-file would answer for a folder or another revision too. Size first, so a huge blob is never read.
  async function readBlob(h, rel) {
    if (typeof rel !== 'string' || !rel) return { ...NOT_HERE };
    const t = await pathsAt(h, h.commit);
    if (!t) return { ok: false, error: "Couldn't read that." };
    if (!t.set.has(rel)) return { ...NOT_HERE };
    const at = `${t.commit}:${rel}`;
    const size = Number((await git(h.root, ['cat-file', '-s', at]))?.trim());
    if (!Number.isFinite(size)) return { ok: false, error: "Couldn't read that." };
    if (size > MAX_BYTES) return { ok: false, tooBig: true, size };
    // cat-file blob runs no clean or smudge filter: the bytes as committed.
    const buf = await git(h.root, ['cat-file', 'blob', at], { buffer: true, env: { GIT_LITERAL_PATHSPECS: '1' }, maxBuffer: MAX_BYTES + 1024 });
    if (!buf) return { ok: false, error: "Couldn't read that." };
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { ok: false, binary: true, size };
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, text, size };
  }

  async function read(id, rel) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    return h.kind === 'branch' ? readBlob(h, rel) : readInside(h.root, rel);
  }

  /** All files: fileindex.js's list for a folder; a branch's own tree, with its folders. */
  async function treeOf(id) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    if (h.kind !== 'branch') return { ok: true, entries: await fileIndex.list(h.root) };
    // The tip as it is now, not where the last changes look left it: Refresh asks for both at once, and
    // computeBranch moves h.commit only after its own rev-parse. A branch gone since keeps its last tree.
    const tip = await tipOf(h.root, h.ref);
    if (tip) h.commit = tip;
    const t = await pathsAt(h, h.commit);
    return { ok: true, entries: t ? fileIndex.withFolders(t.list) : [] };
  }

  // The handles a changed folder belongs to. Their last look no longer answers a repeat, and a look
  // still running no longer answers one either (it may have hashed the folder before the write):
  // the 2 s reuse only absorbs asking twice, never a real change.
  //   A folder handle on dir, on a folder dir is in, or on one inside dir (an agent's worktree under
  //   the conversation's folder), except inside a folder too wide to browse: a conversation left in ~
  //   would otherwise nudge every viewer on every write.
  //   A branch handle only with { commits: true } (turn ends, step undo, ! commands: where commits
  //   land), when dir is in one of its repo's worktrees; never for each tool's result, and never from a
  //   folder too wide to browse either (treesOf leaves those out as well).
  function staleFor(dir, { commits = false } = {}) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return [];
    const at = longPath(dir) || path.resolve(dir);
    const wide = !!tooWide(at, home);
    const within = root => path.relative(root, at) === '' || isUnder(root, at);
    const hit = [...handles.values()].filter(h => (h.kind === 'branch'
      ? commits && !wide && h.trees.some(within)
      : within(h.root) || (!wide && isUnder(at, h.root))));
    for (const h of hit) { h.gen++; h.last = {}; h.pending = {}; }
    return hit.map(h => h.id);
  }

  // A conversation closed: the handles opened from it go too (the Project page's belong to no tab).
  function keepTabs(open) {
    for (const [id, h] of handles) if (h.tabId && !open.has(h.tabId)) handles.delete(id);
  }

  return {
    open, openBranch, get: id => handles.get(id) || null, changesOf, diffOf, read, treeOf,
    close: id => { handles.delete(id); }, staleFor, keepTabs,
  };
}

module.exports = { readInside, sameDir, isUnder, longPath, tooWide, createViewer, locate, branchOf, writeWatch, MAX_BYTES, SNIFF_BYTES, MAX_HANDLES, REFRESH_MS, EMPTY_TREE, TREE_MAX, HEAD_REF };
