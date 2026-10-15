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
const { execFileTree: execFile } = require('./exec-tree'); // a timeout ends git's whole tree
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const changes = require('./changes');
const fileIndex = require('./fileindex');
const { parseTarget } = require('./filelinks');
const { parseWorktrees, okDir } = require('./leaving');
const { readStatus } = require('./viewer-status');

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
const MAX_PLACE_TREES = 20;          // worktrees in the header's menu
const MAX_PLACE_BRANCHES = 30;       // branches checked for commits of their own, newest first
const PLACES_MS = 10000;             // the menu's list is reused this long, per repo
const AT_ONCE = 4;                   // the menu's git status, rev-list and rev-parse runs at a time, across the whole viewer
const MAX_PICKED = 300;                                      // the picked file's path, at most (selectedNote)
const PICK_UNSAFE = /[\0-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/u; // control, format (bidi) and separator characters

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

// changes.patchFor's own answers (checkRef's, a moved root, objects tidied away, a diff with no
// stderr). Any other error is git's stderr, which never reaches the panel.
const PATCH_SAID = new Set([
  'Not a project folder.', 'Not a snapshot.', 'Not a file in this change.', 'That project has moved.',
  'Those changes have been tidied away by git since.', "Couldn't read the diff.",
]);

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

/**
 * `git status --porcelain -z` -> how many files it names. A rename or copy carries its old path as one more field.
 * skip: folders (relative, forward slashes) whose untracked entries aren't counted: other worktrees nested in this one.
 */
function countStatus(out, skip = []) {
  const keys = skip.map(s => String(s).replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  const nested = name => {
    const n = name.replace(/\/+$/, '').toLowerCase();
    return keys.some(k => n === k || n.startsWith(`${k}/`));
  };
  const recs = String(out || '').split('\0');
  let n = 0;
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].length < 4) continue; // "XY " and at least one letter of a name
    if (recs[i].startsWith('?? ') && nested(recs[i].slice(3))) continue;
    n++;
    if (/^[RC]|^.[RC]/.test(recs[i])) i++;
  }
  return n;
}

/**
 * The branch the main checkout is on, from `git worktree list --porcelain` (its first entry), or null
 * when the repo is bare or the checkout detached: then there is nothing to compare branches with.
 */
function checkoutBranch(out) {
  const first = String(out || '').replace(/\r/g, '').split('\n\n')[0].split('\n');
  if (first.includes('bare')) return null;
  const b = first.find(l => l.startsWith(`branch ${HEADS}`));
  return b ? b.slice(`branch ${HEADS}`.length) : null;
}

/** At most n of the jobs handed to it run at once, whoever hands them over; the rest wait their turn, in order. */
function limiter(n) {
  let running = 0;
  const queue = [];
  const pump = () => {
    while (running < n && queue.length) {
      const { job, resolve, reject } = queue.shift();
      running++;
      Promise.resolve().then(job).then(resolve, reject).finally(() => { running--; pump(); });
    }
  };
  return job => new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); });
}

// The repo a folder belongs to, as its git common dir resolved and lower-cased (as changes.sameRepo
// compares them), or null. A checkout and its worktrees share one; a folder of another repo doesn't.
async function commonDirOf(dir) {
  const out = (await git(dir, ['rev-parse', '--git-common-dir']))?.trim();
  return out ? path.resolve(dir, out).toLowerCase() : null;
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

/**
 * The line a prompt carries for the file picked in the file tree (panel/files-select.js): only a
 * file still there, inside the conversation's repo (or its folder, outside git), never in a folder
 * too wide to browse. Nothing is read from the file. rel: its path in the tree (relative to the
 * repo's root), so a conversation moved into its own worktree keeps its pick: the same file there.
 * The name comes from the repo, and the line is one Claude takes as Shellby's own words: a name
 * with a control, format or separator character, or longer than MAX_PICKED, is refused, and the
 * rest goes in quotes, which a Windows name can't hold. -> the line, or null
 */
async function selectedNote(cwd, rel, { home = os.homedir() } = {}) {
  if (!okDir(cwd) || !plainRel(rel) || rel.length > MAX_PICKED || PICK_UNSAFE.test(rel)) return null;
  const root = longPath((await changes.rootOf(cwd)) || cwd);
  if (!root || tooWide(cwd, home) || tooWide(root, home)) return null;
  const abs = path.resolve(root, rel);
  if (!isUnder(root, abs)) return null; // by name first: nothing outside the folder is touched
  const file = longPath(abs);           // then links followed: a junction out of it ends outside
  if (!file || !isUnder(root, file)) return null;
  try { if (!fs.statSync(file).isFile()) return null; } catch { return null; }
  const shown = path.relative(root, file).split(path.sep).join('/');
  if (shown.length > MAX_PICKED || PICK_UNSAFE.test(shown)) return null; // a link inside can name another file
  return `[Shellby: the user has the file ${JSON.stringify(shown)} selected in the file tree; "this" or "it" may mean it.]`;
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
  // id -> { id, kind, root, git, common, branch, base, tabId, origin, gen, shown, slots, pending, last, places, placing }.
  // common: the repo's git common dir (commonDirOf), so a folder to fall back on is known to be of it (liveRoot).
  // kind 'folder' reads its folder; kind 'branch' reads git alone and adds { ref, commit, trees, tree }
  // (tree = { commit, p }: the one ls-tree for that commit, running or done, failed or not).
  // slots, pending and last are each by mode ('base' | 'head'; a branch has only 'base'):
  // slots[mode] = { files: Map(path key -> file), ref } (what a diff is cut from), pending[mode] = a
  // look running, last[mode] = { at, result }; shown = the mode of the list the panel was last handed;
  // gen counts nudges. origin = { tabId, root, base }: the conversation the first handle was opened
  // from, carried through the header menu's picks; places = that menu's list (placesOf), placing = its
  // build while one runs. statusHead, statusCached, statusLine: the file tree's status reads (viewer-status.js).
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
    const [branch, common] = top ? await Promise.all([branchOf(root, { home }), commonDirOf(root)]) : [null, null];
    const against = top ? given || (own ? from.base : null) || await mainBranchFor(root) : null;
    const h = add({ kind: 'folder', root, git: !!top, common, branch, base: against, tabId: own ? from.tabId : null, origin: from });
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
    const [trees, common] = await Promise.all([treesOf(top, home), commonDirOf(top)]);
    const h = add({ kind: 'branch', root: top, git: true, common, ref, commit, branch, base: against, tabId: null, origin, trees, tree: null });
    return { ok: true, id: h.id, root: top, name: path.basename(top), branch, base: against, git: true, kind: 'branch' };
  }

  // Where git runs for a handle: its own folder while it is there. Once that is gone (a worktree
  // removed), a branch is still all in the repo, and a menu can still switch away: then another live
  // folder of the same repo (same git common dir), one of a branch's worktrees or the folder the first
  // handle was opened on, never one too wide to browse or of another repo. -> a resolved folder | null
  async function liveRoot(h) {
    if (longPath(h.root)) return h.root;
    if (!h.common) return null;
    for (const dir of [...(h.trees || []), h.origin?.root]) {
      const at = okDir(dir) ? longPath(dir) : null;
      if (at && !tooWide(at, home) && await commonDirOf(at) === h.common) return at;
    }
    return null;
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
    const at = await liveRoot(h);
    if (!at) return { ok: false, gone: true, error: 'This folder is gone.' };
    const commit = await tipOf(at, h.ref);
    if (!commit) {
      // rev-parse answers null for a missing ref and for a git that didn't run: ask git something else.
      const alive = await git(at, ['rev-parse', '--git-dir']);
      return alive === null ? { ok: false, error: "Couldn't read changes." } : { ok: false, branchGone: true, error: 'This branch is gone.' };
    }
    h.commit = commit;
    h.trees = await treesOf(at, home);
    // merge-base exits 1 when the two share no history: then all of the branch is new, from the empty
    // tree. Any other failure (a timeout, a base that no longer resolves) is said, with Retry, rather
    // than shown as the whole branch added "(from main)".
    let before = EMPTY_TREE;
    if (h.base) {
      const mb = await git(at, ['merge-base', `${HEADS}${h.base}`, commit], { exit: true });
      const fork = mb.code === 0 ? mb.out.trim() : '';
      if (TREE.test(fork)) before = fork;
      else if (mb.code !== 1) return { ok: false, error: "Couldn't read changes." };
    }
    const diff = {};
    const sum = await changes.summarize({ root: at, tree: before }, { root: at, tree: commit }, { noFetch: true, info: diff });
    if (diff.failed) return { ok: false, error: "Couldn't read changes." }; // a missing object, a timeout: not "nothing changed"
    const files = sum?.files || [];
    // Git's own spelling: a branch can hold A.txt and a.txt, and nothing on disk folds them.
    h.slots.base = { ref: { root: at, before, after: commit }, files: new Map(files.map(f => [f.path, f])) };
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
    // A branch's diff is commit to commit: any live folder of the repo makes it, not only the one the
    // list was taken in, which may have gone since.
    const root = h.kind === 'branch' ? await liveRoot(h) : slot.ref.root;
    if (!root) return { ok: false, gone: true, error: 'This folder is gone.' };
    const r = await changes.patchFor({ ...slot.ref, root, file: f.path }, { noFetch: true });
    // patchFor's own words stand; anything else is git's stderr (a blob it lacks: "fatal: unable to read ...").
    if (r.error) return { ok: false, error: PATCH_SAID.has(r.error) ? r.error : "Couldn't read that." };
    return { ok: true, patch: r.patch, truncated: r.truncated, binary: f.binary };
  }

  // The paths in a branch's tree at a commit: one ls-tree per commit, shared by every ask while it runs,
  // and a failure (a timeout, a listing over 32 MB, a tree git can't read) kept for that commit rather
  // than run again on each read. at: a live folder of the repo (liveRoot). -> Promise<{ commit, list, set } | null>
  function pathsAt(h, commit, at) {
    if (h.tree?.commit !== commit) {
      const p = git(at, ['ls-tree', '-r', '-z', '--name-only', commit], { maxBuffer: 32 * 1024 * 1024 }).then(out => {
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
    const root = await liveRoot(h);
    if (!root) return { ok: false, gone: true };
    const t = await pathsAt(h, h.commit, root);
    if (!t) return { ok: false, error: "Couldn't read that." };
    if (!t.set.has(rel)) return { ...NOT_HERE };
    const at = `${t.commit}:${rel}`;
    const size = Number((await git(root, ['cat-file', '-s', at]))?.trim());
    if (!Number.isFinite(size)) return { ok: false, error: "Couldn't read that." };
    if (size > MAX_BYTES) return { ok: false, tooBig: true, size };
    // cat-file blob runs no clean or smudge filter: the bytes as committed.
    const buf = await git(root, ['cat-file', 'blob', at], { buffer: true, env: { GIT_LITERAL_PATHSPECS: '1' }, maxBuffer: MAX_BYTES + 1024 });
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

  /** All files: fileindex.js's list for a folder (fresh: not the cached one); a branch's own tree, with its folders. */
  async function treeOf(id, { fresh = false } = {}) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    if (h.kind !== 'branch') return { ok: true, entries: await fileIndex.list(h.root, { fresh }) };
    // The tip as it is now, not where the last changes look left it: Refresh asks for both at once, and
    // computeBranch moves h.commit only after its own rev-parse. A branch gone since keeps its last tree.
    const at = await liveRoot(h);
    if (!at) return { ok: true, entries: [] }; // as a folder gone answers: Changes says it is gone
    const tip = await tipOf(at, h.ref);
    if (tip) h.commit = tip;
    const t = await pathsAt(h, h.commit, at);
    return { ok: true, entries: t ? fileIndex.withFolders(t.list) : [] };
  }

  // The file tree's marks (viewer-status.js), for a folder handle only. One read at a time per
  // handle, in order, so each one's commit check compares with the one before. Asked again within
  // REFRESH_MS with no nudge between, the last answer stands, without its commits and staged files
  // (they lit once). staleFor's h.last = {} and h.pending = {} drop the reuse and the share, as
  // they do for a changes look.
  function statusOf(id) {
    const h = handles.get(id);
    if (!h) return Promise.resolve({ ok: false, expired: true });
    if (h.kind !== 'folder') return Promise.resolve({ ok: false, error: 'Only a folder has a status.' });
    if (!longPath(h.root)) return Promise.resolve({ ok: false, gone: true, error: 'This folder is gone.' });
    if (h.pending.status) return h.pending.status;
    const last = h.last.status;
    if (last && Date.now() - last.at < REFRESH_MS) return Promise.resolve(last.result);
    const gen = h.gen;
    const p = (h.statusLine || Promise.resolve()).then(() => readStatus(h, git)).then(result => {
      if (result.ok && h.gen === gen) h.last.status = { at: Date.now(), result: { ...result, committed: [], staged: [] } };
      return result;
    }).finally(() => { if (h.pending.status === p) delete h.pending.status; });
    h.statusLine = p.catch(() => {});
    h.pending.status = p;
    return p;
  }

  // ---- the header's menu (panel/viewer.js): the repo's worktrees, and its branches still in flight.
  // Built once per repo (its git common dir) and reused for 10 s by every handle on it, however many
  // ask at once. Each handle then keeps its own copy under random keys; a pick names a key, never a
  // path or a ref.
  const lists = new Map();       // git common dir -> { at: when built (null while building), p: Promise<built | null> }
  const slot = limiter(AT_ONCE); // the menu's git status, rev-list and rev-parse runs, across every handle and build

  // The repo's rows, without keys or a current mark (those are each handle's own). -> { base, rows } | null
  async function buildPlaces(root, common) {
    const out = await git(root, ['worktree', 'list', '--porcelain']);
    if (out === null) return null;
    // Local folders only, never the home folder or above (open() would refuse them anyway), and only
    // folders of this repo: a record in .git/worktrees can name any folder, and git status there would
    // run that repo's own filters.
    const all = parseWorktrees(out).filter(w => okDir(w.path));
    const listed = all.filter(w => !tooWide(w.path, home)).slice(0, MAX_PLACE_TREES);
    const ours = await Promise.all(listed.map(w => slot(() => commonDirOf(w.path))));
    const trees = listed.filter((_w, i) => ours[i] === common);
    // Another worktree inside this one (an agent's, under .claude/worktrees) is a place of its own, not
    // an untracked folder of this one, whether or not the repo ignores it.
    const folders = all.map(w => longPath(w.path)).filter(Boolean);
    const inside = dir => {
      const at = longPath(dir);
      return at ? folders.filter(f => isUnder(at, f)).map(f => path.relative(at, f).split(path.sep).join('/')) : [];
    };
    // A count that timed out (8 s) is left off rather than guessed.
    const changed = await Promise.all(trees.map(w => slot(async () => {
      const st = await git(w.path, ['status', '--porcelain', '-z', '--untracked-files=all']);
      return st === null ? null : countStatus(st, inside(w.path));
    })));
    const rows = trees.map((w, i) => ({
      kind: 'worktree', label: path.basename(w.path), branch: w.branch || 'detached',
      ...(changed[i] === null ? {} : { changed: changed[i] }), path: w.path,
    }));
    // Branches with commits the main checkout's branch lacks. One out in a listed worktree shows
    // there instead. Full refs/heads/ names throughout, so none reaches git as an option.
    const base = checkoutBranch(out);
    if (base) {
      const taken = new Set(trees.filter(w => w.branch).map(w => `${HEADS}${w.branch}`));
      const refs = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(committerdate:unix)', 'refs/heads']);
      const newest = String(refs || '').split('\n').map(l => l.replace(/\r$/, '').split('\0'))
        .filter(([ref]) => HEAD_REF.test(ref || '') && !taken.has(ref)).slice(0, MAX_PLACE_BRANCHES);
      const ahead = await Promise.all(newest.map(([ref]) => slot(async () =>
        Number((await git(root, ['rev-list', '--count', `${HEADS}${base}..${ref}`]))?.trim()) || 0)));
      newest.forEach(([ref, at], i) => {
        if (ahead[i] <= 0) return;
        const name = ref.slice(HEADS.length);
        rows.push({ kind: 'branch', label: name, branch: name, ahead: ahead[i], when: Number(at) * 1000 || 0, ref });
      });
    }
    return { base, rows };
  }

  // The repo's rows, shared: one build at a time per repo, reused for 10 s from when it finished.
  // A failed build isn't kept, so the next ask tries again. -> Promise<{ at, base, rows } | null>
  function listFor(root, common) {
    const now = Date.now();
    for (const [k, e] of lists) if (e.at !== null && now - e.at >= PLACES_MS) lists.delete(k);
    const had = lists.get(common);
    if (had) return had.p;
    const e = { at: null, p: null };
    e.p = buildPlaces(root, common).catch(() => null).then(built => {
      if (!built) { if (lists.get(common) === e) lists.delete(common); return null; }
      e.at = Date.now();
      return { ...built, at: e.at };
    });
    lists.set(common, e);
    return e.p;
  }

  /** The menu's list for a handle's repo, under this handle's own keys; built when asked, reused for 10 s. */
  async function placesOf(id) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    if (!h.git) return { ok: false, error: "Couldn't list worktrees." };
    if (!h.places || Date.now() - h.places.at >= PLACES_MS) {
      // Two asks at once on one handle wait for the same list, so neither's keys go stale under the other.
      h.placing ||= (async () => {
        // A handle whose folder went (a worktree removed) lists from a live one of the same repo, so
        // its gone screen can still switch away.
        const from = await liveRoot(h);
        const common = from ? await commonDirOf(from) : null;
        const built = common ? await listFor(from, common) : null;
        if (!built) return false;
        const current = r => (r.kind === 'worktree' ? h.kind === 'folder' && sameDir(r.path, h.root) : h.kind === 'branch' && h.ref === r.ref);
        h.places = {
          at: built.at, base: built.base, common,
          list: built.rows.map(r => ({ key: crypto.randomBytes(8).toString('hex'), ...r, current: current(r) })),
        };
        return true;
      })().finally(() => { h.placing = null; });
      if (!(await h.placing)) return { ok: false, error: "Couldn't list worktrees." };
    }
    return { ok: true, places: h.places.list.map(({ path: _path, ref: _ref, ...shown }) => shown) };
  }

  const GONE = { ok: false, gone: true, error: 'That worktree or branch is gone.' };

  // A pick that went stale: the list it came from is dropped, here and for the repo, so the menu's
  // next open builds it again rather than offering the same dead entry for the rest of the 10 s.
  function stale(h) {
    if (h.places) lists.delete(h.places.common);
    h.places = null;
    return { ...GONE };
  }

  /**
   * A pick from that handle's own list, checked again before it opens: a worktree must still be
   * listed, local, not too wide and of the same repo; a branch must still resolve. -> open()'s or
   * openBranch()'s answer, or GONE for one that went stale since the list was made.
   */
  async function switchTo(id, key) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    const e = typeof key === 'string' ? h.places?.list.find(x => x.key === key) : null;
    if (!e) return { ok: false, error: "That isn't on this list. Open the menu again." };
    const from = await liveRoot(h); // as placesOf listed from
    if (!from) return stale(h);
    if (e.kind === 'worktree') {
      if (!okDir(e.path) || tooWide(e.path, home)) return stale(h);
      const listed = parseWorktrees(await git(from, ['worktree', 'list', '--porcelain']));
      if (!listed.some(w => okDir(w.path) && sameDir(w.path, e.path))) return stale(h);
      if (!(await changes.sameRepo(from, e.path))) return stale(h);
      const r = await open({ dir: e.path, origin: h.origin });
      return r.ok || !r.gone ? r : stale(h);
    }
    const r = await openBranch({ root: from, ref: e.ref, base: h.places.base, origin: h.origin });
    return r.ok || !r.gone ? r : stale(h);
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
    open, openBranch, get: id => handles.get(id) || null, changesOf, diffOf, read, treeOf, statusOf,
    placesOf, switchTo, close: id => { handles.delete(id); }, staleFor, keepTabs,
  };
}

module.exports = {
  readInside, sameDir, isUnder, longPath, tooWide, createViewer, locate, selectedNote, branchOf, writeWatch, countStatus, checkoutBranch, limiter,
  MAX_BYTES, SNIFF_BYTES, MAX_HANDLES, REFRESH_MS, EMPTY_TREE, TREE_MAX, HEAD_REF, MAX_PLACE_TREES, MAX_PLACE_BRANCHES, PLACES_MS,
  PICK_UNSAFE, MAX_PICKED,
};
