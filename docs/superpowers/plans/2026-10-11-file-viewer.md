# File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, full-panel file viewer in Shellby that shows a conversation's folder (or a project's worktree) as a tree, lists what changed since its branch began, and shows each change as a diff with both sides' line numbers, refreshing while Claude edits.

**Architecture:** Main holds folder handles (`src/main/viewer.js`) and serves files and diffs only through them: reads are confined to the handle's root with links and 8.3 names resolved, and diffs only for files on the handle's own changes list, built from `changes.js`'s snapshot/summarize/patchFor. `src/main/ipc/viewer.js` exposes eight channels plus a `viewer:stale` nudge driven by `fileIndex.forget`. The panel gets a new `viewer` view (`src/renderer/panel/viewer.js`) built on a pure `src/renderer/shared/viewer-logic.js`, reached from a Files button per pane, file links in replies, the branch chip and the Project page.

**Tech Stack:** Electron 44, plain JS (no renderer framework, no new dependencies), git via `execFile`, node:test, CDP e2e scripts.

**Spec:** `docs/superpowers/specs/2026-10-11-file-viewer-design.md`

## Global Constraints

- Work in `C:\RAD\shellby\.claude\worktrees\file-viewer` on branch `file-viewer`. Run every command from there.
- Plain HTML/CSS/JS in the renderer. No new runtime or dev dependencies.
- CSP is `default-src 'none'; script-src 'self'; style-src 'self'`: no inline `style`, no inline script. Build DOM with `SB.h` and `textContent`; attributes are fixed words or numbers only.
- git runs through `execFile` with fixed arguments, `core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, a timeout, and never throws to its caller.
- Line endings are LF. Edit with the Edit tool or Node `fs`; never Python text mode.
- Caps (exact): 8 handles; 2 MB per file read; NUL in the first 8 KB means binary; colour up to 4,000 lines; refresh at most once every 2 s; 500 files per changes list (`changes.js` MAX_FILES); 400 KB per patch (`changes.js` MAX_PATCH).
- User-facing strings, exact: "This folder is gone", "Couldn't read changes", "This file is gone", "Showing the first 500 of N", "Too many new files to compare", "Open in editor", "Just uncommitted", "Changes", "All files", "Whole file", "View changes", "Browse files".
- Click on a reply's file link opens the viewer; Ctrl+click opens the editor (`SB.openFile`); Shift+click reveals in Explorer; a path outside the conversation's repo falls back to the editor; pop-out windows (`SB.solo`) keep the editor.
- Temp dirs in tests: `fs.realpathSync.native(fs.mkdtempSync(...))`, except where a test deliberately passes the unresolved form.
- Commits: `<type>: <description>` (feat, fix, perf, refactor, test, docs, chore, ci), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never bump `version` or add a CHANGELOG heading. One note: `changes/file-viewer.md`.
- After editing anything in `src/renderer/panel/html/`, run `npm run panel:html` and commit the rebuilt `panel.html`.
- Close every Electron and test process you start.

## Review Focus

1. **Paths with spaces and non-ASCII characters** (`docs/my notes/é.md`): the changes list, the diff and the read must all work, since git pathspecs are literal and `core.quotepath=off`. Pinned in Task 2.
2. **CRLF files**: the whole-file view must not show a stray `\r` at each line end. Pinned in Task 4 (`splitLines`).
3. **A repo with no commits yet**: Changes compares with the empty tree and lists every file as new, instead of failing. Pinned in Task 2.
4. **A worktree deleted while the viewer is open**: changes and reads return `gone`, and the screen says "This folder is gone" instead of erroring. Pinned in Task 2 (main) and drawn in Task 5.
5. **A conversation started in a subfolder of the repo**: the handle's root is the repo's top level, and a reply link relative to the subfolder resolves to the right file. Pinned in Task 2 (`locate`).

Added after the plan's redteam (run `20261011-0207-redteam-file-viewer-plan`, findings folded in):
- A UNC, drive-relative or stream path never reaches the disk, and outside-the-folder answers exactly like missing (Task 1).
- A repo's own hooks never run when it's only being looked at (Task 2; verified that `changes.snapshot` runs `post-index-change` without this).
- A worktree record planted in `.git/worktrees` can't vouch for a folder of another repo (Task 3).
- The viewer catches up on nudges it heard while hidden, because `SB.send` always returns to the chat (Task 5).
- `preload.js` sits at 797 of 800 lines: the bridge is exactly three lines (Task 3).

Accepted residuals: clean filters (git-lfs) still run on `git add` and `git status`, as they already do for the Project page's status reads and every turn's snapshot. A hard link inside the folder to a file outside reads through (needs a local writer in the folder). A viewer snapshot writes loose blobs of untracked files into `.git`, as turn snapshots do. Turn snapshots (existing code, out of scope) also still run repo hooks. Files-button hiding for remote tabs has no e2e, since it needs an ssh folder.

---

### Task 1: Confined reads in main

**Files:**
- Create: `src/main/viewer.js`
- Test: `test/viewer-read.test.js`

**Interfaces:**
- Produces: `readInside(root: string, rel: string) -> Promise<{ ok: true, text: string, size: number } | { ok: false, missing: true } | { ok: false, gone: true } | { ok: false, tooBig: true, size } | { ok: false, binary: true, size } | { ok: false, error: string }>`; `sameDir(a, b) -> boolean`; `isUnder(root, abs) -> boolean`; `longPath(p) -> string | null`; constants `MAX_BYTES`, `SNIFF_BYTES`.

- [ ] **Step 1: Install dependencies in the worktree**

The worktree starts with no `node_modules`.

Run (PowerShell): `$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'; npm ci; node node_modules/electron/install.js`
Expected: install finishes; `node_modules/electron/dist/electron.exe` exists.

- [ ] **Step 2: Write the failing test**

Create `test/viewer-read.test.js`:

```js
// The file viewer's reads (main's viewer.js): only inside the folder it was
// opened on, links followed, and never a file too big or not text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readInside, sameDir, isUnder, MAX_BYTES } = require('../src/main/viewer');

function folder() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-read-')));
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), '\uFEFFconst b = 1;\n');
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'not yours\n');
  return { base, root, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('reads a file inside the folder, with any BOM stripped', async () => {
  const f = folder();
  try {
    assert.deepEqual(await readInside(f.root, 'a.txt'), { ok: true, text: 'one\ntwo\n', size: 8 });
    const b = await readInside(f.root, 'src/b.js');
    assert.equal(b.ok, true);
    assert.equal(b.text, 'const b = 1;\n');
  } finally { f.done(); }
});

test('refuses .., an absolute path outside, and a junction that leads out', async () => {
  const f = folder();
  try {
    assert.equal((await readInside(f.root, '../outside/secret.txt')).ok, false);
    assert.equal((await readInside(f.root, path.join(f.base, 'outside', 'secret.txt'))).ok, false);
    fs.symlinkSync(path.join(f.base, 'outside'), path.join(f.root, 'link'), 'junction');
    const r = await readInside(f.root, 'link/secret.txt');
    assert.equal(r.ok, false);
    assert.equal(r.text, undefined, 'nothing of the file comes back');
  } finally { f.done(); }
});

test('the folder named any way: different case, or not yet resolved', async () => {
  const f = folder();
  try {
    assert.equal((await readInside(f.root.toUpperCase(), 'A.TXT')).ok, true);
    // On CI the temp folder is an 8.3 short name (RUNNER~1); the unresolved form must still work.
    const unresolved = path.join(os.tmpdir(), path.relative(fs.realpathSync.native(os.tmpdir()), f.root));
    assert.equal((await readInside(unresolved, 'a.txt')).ok, true);
  } finally { f.done(); }
});

test('network, drive and stream paths are refused before anything touches the disk', async () => {
  const f = folder();
  try {
    // A UNC path would make Windows log in to that host; it must never reach realpath.
    const fsReal = fs.realpathSync.native;
    const seen = [];
    fs.realpathSync.native = p => { seen.push(p); return fsReal(p); };
    try {
      for (const rel of ['\\\\attacker.example\\share\\x', '//attacker.example/share/x', 'C:x.txt', 'a.txt:secret', 'src/../../outside/secret.txt', 'D:\\other\\x']) {
        assert.deepEqual(await readInside(f.root, rel), { ok: false, missing: true }, rel);
      }
      assert.ok(!seen.some(p => /attacker|other/.test(p)), `realpath never saw them (${seen.join(' | ')})`);
    } finally { fs.realpathSync.native = fsReal; }
  } finally { f.done(); }
});

test('outside the folder answers exactly as missing does: no telling what exists elsewhere', async () => {
  const f = folder();
  try {
    fs.symlinkSync(path.join(f.base, 'outside'), path.join(f.root, 'link'), 'junction');
    const there = await readInside(f.root, 'link/secret.txt');
    const absent = await readInside(f.root, 'link/no-such.txt');
    assert.deepEqual(there, absent);
    assert.deepEqual(there, { ok: false, missing: true });
  } finally { f.done(); }
});

test('missing, gone, too big and binary say so instead of reading', async () => {
  const f = folder();
  try {
    assert.deepEqual(await readInside(f.root, 'nope.txt'), { ok: false, missing: true });
    assert.deepEqual(await readInside(path.join(f.base, 'vanished'), 'a.txt'), { ok: false, gone: true });
    fs.writeFileSync(path.join(f.root, 'big.log'), Buffer.alloc(MAX_BYTES + 1, 0x61));
    assert.equal((await readInside(f.root, 'big.log')).tooBig, true);
    fs.writeFileSync(path.join(f.root, 'img.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    assert.equal((await readInside(f.root, 'img.png')).binary, true);
    assert.equal((await readInside(f.root, 'src')).ok, false, 'a folder is not a file');
    assert.equal((await readInside(f.root, '')).ok, false);
    assert.equal((await readInside(f.root, 'a\0.txt')).ok, false);
  } finally { f.done(); }
});

test('sameDir and isUnder compare resolved paths', () => {
  const f = folder();
  try {
    assert.equal(sameDir(f.root, f.root.toUpperCase()), true);
    assert.equal(sameDir(f.root, path.join(f.root, 'src')), false);
    assert.equal(isUnder(f.root, path.join(f.root, 'src', 'b.js')), true);
    assert.equal(isUnder(f.root, f.root), false);
    assert.equal(isUnder(f.root, path.join(f.base, 'outside')), false);
  } finally { f.done(); }
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test test/viewer-read.test.js`
Expected: FAIL with `Cannot find module '../src/main/viewer'`.

- [ ] **Step 4: Write the minimal implementation**

Create `src/main/viewer.js`:

```js
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
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;   // past this, "Open in editor" instead
const SNIFF_BYTES = 8 * 1024;        // a NUL in here: not text

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

module.exports = { readInside, sameDir, isUnder, longPath, MAX_BYTES, SNIFF_BYTES };
```

- [ ] **Step 5: Run the test to make sure it passes**

Run: `node --test test/viewer-read.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/viewer.js test/viewer-read.test.js
git commit -m "feat: the file viewer reads files only inside the folder it was opened on

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Handles, the changes list, diffs, and link lookup

**Files:**
- Modify: `src/main/viewer.js`
- Modify: `src/main/changes.js:69-83` (`snapshot` gains a `{ hooks }` option)
- Test: `test/viewer.test.js`; add to `test/changes.test.js`

**Interfaces:**
- Consumes: Task 1's `readInside`, `sameDir`, `isUnder`, `longPath`; `changes.rootOf`, `changes.snapshot`, `changes.summarize`, `changes.patchFor`; `leaving.parseWorktrees`, `leaving.okDir`; `filelinks.parseTarget`.
- Changes: `changes.snapshot(dir, info = null, { hooks = true } = {})`. With `hooks: false` its `git add` calls run with `core.hooksPath` pointed at an empty Shellby-made folder, so a repo's own hooks (`post-index-change` runs on every index write, verified in the redteam run) never fire for a folder that is only being looked at. Turn snapshots keep today's behaviour (`hooks` defaults to true).
- Produces:
  - `createViewer() -> { open, get, changesOf, diffOf, read, close, staleFor }`
  - `open({ dir, base?: string|null, tabId?: string|null }) -> Promise<{ ok: true, id, root, name, branch: string|null, base: string|null, git: boolean } | { ok: false, gone?: true, error }>`
  - `get(id) -> handle | null` (handle has `.root`)
  - `changesOf(id, { uncommittedOnly?: boolean }) -> Promise<{ ok: true, files: [{ path, status: 'A'|'M'|'D'|'T'|'?', added, removed, binary }], more: number, against: string } | { ok: true, noGit: true, files: [], more: 0, against: null } | { ok: false, expired?: true, gone?: true, tooManyNew?: true, error? }>`
  - `diffOf(id, rel) -> Promise<{ ok: true, patch, truncated, binary } | { ok: false, expired?: true, error }>`
  - `read(id, rel) -> Promise<readInside result | { ok: false, expired: true }>`
  - `close(id) -> void`; `staleFor(dir) -> string[]` (handle ids whose root is dir or contains it); `keepTabs(ids: Set<string>) -> void` (drops handles opened from a tab no longer open)
  - `writeWatch(nudge: (cwd) => void) -> (item, cwd) => void`: remembers tool calls `changes.mayWrite` flags and calls `nudge(cwd)` once each one's `tool_result` arrives (Task 3 wires it into the session item handler)
  - `changesOf` answers a repeat call for the same handle and mode from its last result for 2 s (`REFRESH_MS`), and viewer snapshots run one at a time across all handles
  - `locate(cwd, target) -> Promise<{ inside: true, rel: string, line: number|null } | { inside: false }>`
  - `branchOf(dir) -> Promise<string | null>`
  - constants `MAX_HANDLES = 8`, `EMPTY_TREE`

- [ ] **Step 1: Write the failing test**

Create `test/viewer.test.js`:

```js
// The file viewer's handles (main's viewer.js) against real git repos in temp
// folders: what changed since a branch began, untracked files marked, diffs
// only for files on the list, and links found inside the repo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createViewer, locate, branchOf, MAX_HANDLES } = require('../src/main/viewer');

function repo({ commit = true } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-')));
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  const write = (at, f, s) => { fs.mkdirSync(path.dirname(path.join(at, f)), { recursive: true }); fs.writeFileSync(path.join(at, f), s); };
  write(dir, 'a.txt', 'one\ntwo\n');
  write(dir, 'src/keep.js', 'const k = 1;\n');
  write(dir, '.gitignore', 'ignored/\n');
  if (commit) { g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init'); }
  return { base, dir, g, write, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// A worktree on its own branch, with one commit of its own.
function worktree(r) {
  const wt = path.join(r.base, 'wt');
  r.g(r.dir, 'worktree', 'add', '-q', '-b', 'feat', wt);
  r.write(wt, 'a.txt', 'one\nTWO\n');
  r.g(wt, 'commit', '-qam', 'feat work');
  return wt;
}

test('a worktree: changes since its branch began, committed, uncommitted and untracked', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    r.write(wt, 'src/keep.js', 'const k = 2;\n');              // uncommitted
    r.write(wt, 'docs/my notes/é.md', '# hi\n');                // untracked, spaces and non-ASCII
    r.write(wt, 'ignored/x.txt', 'never listed\n');
    const v = createViewer();
    const h = await v.open({ dir: wt });
    assert.equal(h.ok, true);
    assert.equal(h.branch, 'feat');
    assert.equal(h.base, 'main', "the main checkout's branch, since no base was given");
    assert.equal(h.git, true);
    const c = await v.changesOf(h.id);
    assert.equal(c.ok, true);
    assert.equal(c.against, 'main');
    const byPath = Object.fromEntries(c.files.map(f => [f.path, f.status]));
    assert.deepEqual(byPath, { 'a.txt': 'M', 'docs/my notes/é.md': '?', 'src/keep.js': 'M' });
    const only = await v.changesOf(h.id, { uncommittedOnly: true });
    assert.deepEqual(only.files.map(f => f.path).sort(), ['docs/my notes/é.md', 'src/keep.js']);
    assert.equal(only.against, 'HEAD');
  } finally { r.done(); }
});

test('diffs only for files on the list, and the read of an odd name works', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    r.write(wt, 'docs/my notes/é.md', '# hi\n');
    const v = createViewer();
    const h = await v.open({ dir: wt });
    await v.changesOf(h.id);
    const d = await v.diffOf(h.id, 'a.txt');
    assert.equal(d.ok, true);
    assert.match(d.patch, /^-two$/m);
    assert.match(d.patch, /^\+TWO$/m);
    const odd = await v.diffOf(h.id, 'docs/my notes/é.md');
    assert.equal(odd.ok, true);
    assert.match(odd.patch, /^\+# hi$/m);
    assert.equal((await v.diffOf(h.id, '.gitignore')).ok, false, 'unchanged: not on the list');
    assert.equal((await v.diffOf(h.id, '../proj/a.txt')).ok, false);
    assert.equal((await v.read(h.id, 'docs/my notes/é.md')).text, '# hi\n');
  } finally { r.done(); }
});

test('a base given (a Shellby copy) wins, and a plain checkout compares with HEAD', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    const v = createViewer();
    assert.equal((await v.open({ dir: wt, base: 'main' })).base, 'main');
    r.write(r.dir, 'a.txt', 'changed in the checkout\n');
    const h = await v.open({ dir: r.dir });
    assert.equal(h.base, null, 'the main checkout has no base');
    const c = await v.changesOf(h.id);
    assert.equal(c.against, 'HEAD');
    assert.deepEqual(c.files.map(f => f.path), ['a.txt']);
  } finally { r.done(); }
});

test('a base that git cannot find falls back to HEAD instead of failing', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir, base: 'no-such-branch' });
    r.write(r.dir, 'a.txt', 'x\n');
    const c = await v.changesOf(h.id);
    assert.equal(c.ok, true);
    assert.equal(c.against, 'HEAD');
    assert.deepEqual(c.files.map(f => f.path), ['a.txt']);
  } finally { r.done(); }
});

test('a repo with no commits lists every file as new', async () => {
  const r = repo({ commit: false });
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const c = await v.changesOf(h.id);
    assert.equal(c.ok, true);
    assert.deepEqual(c.files.map(f => f.path).sort(), ['.gitignore', 'a.txt', 'src/keep.js']);
    assert.ok(c.files.every(f => f.status === '?'));
  } finally { r.done(); }
});

test('a folder that is not a repo has no changes, and a vanished one is gone', async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-plain-')));
  try {
    fs.writeFileSync(path.join(base, 'notes.txt'), 'hi\n');
    const v = createViewer();
    const h = await v.open({ dir: base });
    assert.equal(h.git, false);
    assert.deepEqual(await v.changesOf(h.id), { ok: true, noGit: true, files: [], more: 0, against: null });
    const r = repo();
    const wt = worktree(r);
    const w = await v.open({ dir: wt });
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    assert.equal((await v.changesOf(w.id)).gone, true);
    assert.equal((await v.read(w.id, 'a.txt')).gone, true);
    r.done();
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a subfolder opens the whole repo, and handles are capped', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: path.join(r.dir, 'src') });
    assert.equal(h.root.toLowerCase(), r.dir.toLowerCase());
    const ids = [h.id];
    for (let i = 0; i < MAX_HANDLES; i++) ids.push((await v.open({ dir: r.dir })).id);
    assert.equal(v.get(ids[0]), null, 'the oldest goes first');
    assert.deepEqual(await v.changesOf(ids[0]), { ok: false, expired: true });
    assert.ok(v.get(ids.at(-1)));
    v.close(ids.at(-1));
    assert.equal(v.get(ids.at(-1)), null);
  } finally { r.done(); }
});

test('staleFor finds the handles a changed folder belongs to', async () => {
  const r = repo();
  try {
    const wt = worktree(r);
    const v = createViewer();
    const main = await v.open({ dir: r.dir });
    const copy = await v.open({ dir: wt });
    assert.deepEqual(v.staleFor(path.join(r.dir, 'src')), [main.id]);
    assert.deepEqual(v.staleFor(wt.toUpperCase()), [copy.id]);
    assert.deepEqual(v.staleFor(os.homedir()), []);
    assert.deepEqual(v.staleFor(42), []);
  } finally { r.done(); }
});

test('locate: a link relative to a subfolder, absolute inside, outside, and missing', async () => {
  const r = repo();
  try {
    const sub = path.join(r.dir, 'src');
    assert.deepEqual(await locate(sub, 'keep.js:3'), { inside: true, rel: 'src/keep.js', line: 3 });
    assert.deepEqual(await locate(sub, path.join(r.dir, 'a.txt')), { inside: true, rel: 'a.txt', line: null });
    assert.deepEqual(await locate(sub, os.homedir()), { inside: false });
    assert.deepEqual(await locate(sub, 'nope.js'), { inside: false });
    assert.deepEqual(await locate(sub, '\\\\server\\share\\x.js'), { inside: false });
  } finally { r.done(); }
});

test('branchOf names the branch, and nothing outside a repo', async () => {
  const r = repo();
  try {
    assert.equal(await branchOf(r.dir), 'main');
    assert.equal(await branchOf(os.tmpdir()), null);
  } finally { r.done(); }
});

test("looking at a repo never runs its hooks", async () => {
  const r = repo();
  try {
    const marker = path.join(r.base, 'HOOK_RAN').split(path.sep).join('/');
    fs.writeFileSync(path.join(r.dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    r.write(r.dir, 'new.txt', 'x\n');
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    assert.equal((await v.changesOf(h.id)).ok, true);
    assert.equal(fs.existsSync(marker), false);
  } finally { r.done(); }
});

test('a repeat within 2 s is answered from the last look; a different mode looks again', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    r.write(r.dir, 'a.txt', 'x\n');
    const first = await v.changesOf(h.id);
    r.write(r.dir, 'b.txt', 'y\n');
    assert.deepEqual((await v.changesOf(h.id)).files.map(f => f.path), first.files.map(f => f.path), 'b.txt waits for the next look');
    assert.deepEqual((await v.changesOf(h.id, { uncommittedOnly: true })).files.map(f => f.path).sort(), ['a.txt', 'b.txt']);
    r.write(r.dir, 'c.txt', 'z\n');
    v.staleFor(r.dir); // a nudge: something there changed
    // Same mode as the call just before, inside 2 s: only the nudge can make it look again.
    assert.deepEqual((await v.changesOf(h.id, { uncommittedOnly: true })).files.map(f => f.path).sort(), ['a.txt', 'b.txt', 'c.txt'], 'a nudge always looks again');
  } finally { r.done(); }
});

test('a non-local folder is refused, and a closed tab takes its handles with it', async () => {
  const r = repo();
  try {
    const v = createViewer();
    assert.equal((await v.open({ dir: '\\\\attacker.example\\share' })).ok, false);
    const a = await v.open({ dir: r.dir, tabId: 'keep' });
    const b = await v.open({ dir: r.dir, tabId: 'gone' });
    const c = await v.open({ dir: r.dir });
    v.keepTabs(new Set(['keep']));
    assert.ok(v.get(a.id));
    assert.equal(v.get(b.id), null);
    assert.ok(v.get(c.id), 'a handle from the Project page belongs to no tab');
  } finally { r.done(); }
});

test('writeWatch nudges once a writing tool has finished, and never for a read', () => {
  const seen = [];
  const watch = writeWatch(cwd => seen.push(cwd));
  watch({ kind: 'tool', id: 't1', name: 'Write' }, 'C:\\p');
  watch({ kind: 'tool', id: 't2', name: 'Read' }, 'C:\\p');
  assert.deepEqual(seen, [], 'nothing until the result is in');
  watch({ kind: 'tool_result', id: 't2' }, 'C:\\p');
  watch({ kind: 'tool_result', id: 't1' }, 'C:\\p');
  watch({ kind: 'tool_result', id: 't1' }, 'C:\\p');
  assert.deepEqual(seen, ['C:\\p']);
});
```

Change the `require` line at the top of this test file to:

```js
const { createViewer, locate, branchOf, writeWatch, MAX_HANDLES } = require('../src/main/viewer');
```

Append to `test/changes.test.js` (add `mayWrite` to its `require` on line 10):

```js
test('mayWrite: file tools and unknown tools could write; reads and results could not', () => {
  assert.equal(mayWrite({ kind: 'tool', name: 'Edit' }), true);
  assert.equal(mayWrite({ kind: 'tool', name: 'Bash' }), true);
  assert.equal(mayWrite({ kind: 'tool', name: 'mcp__someone__thing' }), true);
  assert.equal(mayWrite({ kind: 'tool', name: 'Read' }), false);
  assert.equal(mayWrite({ kind: 'tool', name: 'mcp__shellby__say' }), false);
  assert.equal(mayWrite({ kind: 'tool_result', name: 'Edit' }), false);
  assert.equal(mayWrite(null), false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/viewer.test.js test/changes.test.js`
Expected: FAIL with `createViewer is not a function` and `mayWrite is not a function`.

- [ ] **Step 3: Teach `changes.js` two things**

In `src/main/changes.js`, below `const MAX_PATCH = ...`, add:

```js
// A snapshot taken only to look (the file viewer) runs none of the repo's own
// hooks: git add writes the temporary index, and post-index-change would fire.
// A -c before the subcommand, so any git takes it (GIT_CONFIG_COUNT would need 2.31).
let noHooksDir = null;
const noHooks = () => {
  try { noHooksDir = noHooksDir && fs.existsSync(noHooksDir) ? noHooksDir : fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-no-hooks-')); } catch { /* git finds no hooks in a folder that isn't there either */ }
  return ['-c', `core.hooksPath=${noHooksDir || path.join(os.tmpdir(), 'shellby-no-hooks')}`];
};
```

Change `async function snapshot(dir, info = null) {` to `async function snapshot(dir, info = null, { hooks = true } = {}) {`. Inside `snapshot`, directly after its `const env = { GIT_INDEX_FILE: tmp };` line (line 83, not the one at line 459), add `const pre = hooks ? [] : noHooks();`, then prefix the two `git add` calls with it:

```js
    const tracked = await git(root, [...pre, 'add', '-u', '--', '.'], { env });
```

```js
      const added = await git(root, [...pre, 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: small.join('\0') });
```

(`git()` puts its own `-c` options after `-C <dir>`, and `git -C d -c a -c b add …` is valid; `ls-files` and `write-tree` write no index and run no hooks.)

Update the doc comment above `snapshot` with one line: ` * opts.hooks: false for a look only (the file viewer): the repo's hooks don't run.`

After `noteTool` (around line 199), add:

```js
/** Could this tool call have written to the folder? (The file viewer looks again once its result is in.) */
const mayWrite = item => item?.kind === 'tool' && typeof item.name === 'string'
  && (FILE_TOOLS.has(item.name) || (!READ_ONLY_TOOLS.has(item.name) && !SHELLBY_TOOL.test(item.name)));
```

Add `mayWrite` to the `module.exports` object on the last line.

- [ ] **Step 4: Write the viewer's handles**

In `src/main/viewer.js`, replace the two `require` lines at the top with:

```js
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const changes = require('./changes');
const { parseTarget } = require('./filelinks');
const { parseWorktrees, okDir } = require('./leaving');
```

Below `SNIFF_BYTES`, add:

```js
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
```

Above `module.exports`, add:

```js
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
  const handles = new Map(); // id -> { id, root, git, branch, base, tabId, files: Map(lower path -> file), ref, pending, last }
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
    handles.set(id, { id, root, git: !!top, branch, base: against, tabId, files: new Map(), ref: null, pending: null, last: null });
    return { ok: true, id, root, name: path.basename(root), branch, base: against, git: !!top };
  }

  async function compute(h, uncommittedOnly) {
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
    h.ref = { root: snap.root, before, after: snap.tree };
    h.files = new Map(files.map(f => [f.path.toLowerCase(), f]));
    return { ok: true, files, more: sum?.more || 0, against: fork ? h.base : 'HEAD' };
  }

  function changesOf(id, { uncommittedOnly = false } = {}) {
    const h = handles.get(id);
    if (!h) return Promise.resolve({ ok: false, expired: true });
    if (!h.git) return Promise.resolve({ ok: true, noGit: true, files: [], more: 0, against: null });
    // Asked twice while the first is still hashing the folder, or again within 2 s: one snapshot answers both.
    const key = uncommittedOnly ? 'head' : 'base';
    if (h.pending?.key === key) return h.pending.p;
    if (h.last?.key === key && Date.now() - h.last.at < REFRESH_MS) return Promise.resolve(h.last.result);
    const p = line.then(() => compute(h, uncommittedOnly)).then(result => {
      if (result.ok) h.last = { key, at: Date.now(), result };
      return result;
    }).finally(() => { if (h.pending?.p === p) h.pending = null; });
    line = p.catch(() => {});
    h.pending = { key, p };
    return p;
  }

  async function diffOf(id, rel) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    const f = typeof rel === 'string' ? h.files.get(rel.toLowerCase()) : null;
    if (!f || !h.ref) return { ok: false, error: 'Not a file in these changes.' };
    const r = await changes.patchFor({ ...h.ref, file: f.path });
    return r.error ? { ok: false, error: r.error } : { ok: true, patch: r.patch, truncated: r.truncated, binary: f.binary };
  }

  async function read(id, rel) {
    const h = handles.get(id);
    return h ? readInside(h.root, rel) : { ok: false, expired: true };
  }

  // The handles a changed folder belongs to. Their last look no longer answers a repeat:
  // the 2 s reuse only absorbs asking twice, never a real change.
  function staleFor(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return [];
    const at = longPath(dir) || path.resolve(dir);
    const hit = [...handles.values()].filter(h => path.relative(h.root, at) === '' || isUnder(h.root, at));
    for (const h of hit) h.last = null;
    return hit.map(h => h.id);
  }

  // A conversation closed: the handles opened from it go too (the Project page's belong to no tab).
  function keepTabs(open) {
    for (const [id, h] of handles) if (h.tabId && !open.has(h.tabId)) handles.delete(id);
  }

  return { open, get: id => handles.get(id) || null, changesOf, diffOf, read, close: id => { handles.delete(id); }, staleFor, keepTabs };
}
```

Replace the `module.exports` line with:

```js
module.exports = { readInside, sameDir, isUnder, longPath, createViewer, locate, branchOf, writeWatch, MAX_BYTES, SNIFF_BYTES, MAX_HANDLES, REFRESH_MS, EMPTY_TREE };
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `node --test test/viewer.test.js test/viewer-read.test.js test/changes.test.js`
Expected: PASS (14 in viewer.test.js, 7 in viewer-read.test.js, and every changes test including mayWrite). If the no-commits test fails because `changes.snapshot` returns null for a repo with no HEAD, read `snapshot` in `src/main/changes.js` (it copies a missing index as empty and handles `head: null`) and fix the viewer side.

- [ ] **Step 6: Commit**

```bash
git add src/main/viewer.js src/main/changes.js test/viewer.test.js test/changes.test.js
git commit -m "feat: file viewer handles list what changed since a branch began and serve its diffs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The viewer's channels, the preload bridge, and stale nudges

**Files:**
- Create: `src/main/ipc/viewer.js`
- Modify: `src/main/ipc/index.js` (import beside `registerFilesIpc`; call after `registerFilesIpc(ipcMain, d);`)
- Modify: `src/preload/preload.js` (after the `zoom: invoke('panel:zoom'),` line)
- Modify: `src/main/fileindex.js:109-111` (`forget`) and its `module.exports`
- Modify: `src/main/wiring/sessions.js` (the item handler, beside `changes.noteTool(...)`)
- Modify: `src/renderer/panel/settings.js:210-212` (the editor note under Settings, Claude, Editor)
- Modify: `docs/THREAT-MODEL.md` (the "Where each boundary is held" table)
- Modify: `docs/DEVELOPMENT.md` (code map, beside the `fileindex.js` line)
- Test: `test/ipc-viewer.test.js`; add to `test/fileindex.test.js`

**Interfaces:**
- Consumes: Task 2's `createViewer`, `locate`, `branchOf`, `sameDir`, `writeWatch`; `changes.sameRepo`; `leaving.okDir`, `leaving.git`, `leaving.parseWorktrees`; `d.manager.tabs`, `d.manager.on('tabs')`, `d.remoteService.placeOf`, `d.projects.knowsRoot`, `d.send`, `d.panel`, `d.isStr`.
- Produces for main: `d.viewerNudge(cwd)` (sends `viewer:stale` for handles on that folder without dropping the @-mention cache) and `d.viewerWrites(item, cwd)` (Task 2's `writeWatch(d.viewerNudge)`).
- Produces (channels, all `ipcRenderer.invoke` except the event):
  - `viewer:open({ tabId } | { projectRoot, worktreePath? })` → Task 2 `open` result
  - `viewer:tree(id)` → `{ ok: true, entries: string[] } | { ok: false, expired: true }` (entries as `fileIndex.list`: files and `folder/` entries, forward slashes)
  - `viewer:changes(id, { uncommittedOnly })`, `viewer:read(id, rel)`, `viewer:diff(id, rel)` → Task 2 results
  - `viewer:locate(tabId, target)` → `{ inside, rel?, line? }`
  - `viewer:branch(tabId)` → `{ branch: string | null }`
  - `viewer:close(id)` → `true`
  - event `viewer:stale` → `{ ids: string[] }`
- Preload names: `viewerOpen`, `viewerTree`, `viewerChanges`, `viewerRead`, `viewerDiff`, `viewerLocate`, `viewerBranch`, `viewerClose`, `onViewerStale`.
- `fileIndex.onForget(fn: (cwd) => void)`.

- [ ] **Step 1: Write the failing tests**

Create `test/ipc-viewer.test.js`:

```js
// The file viewer's channels (ipc/viewer.js): a conversation on this PC or a
// worktree the Project page listed, never a path the panel makes up; and a
// nudge when something in an open folder may have changed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, isStr } = require('./helpers/fake-ipc');

installFakeElectron();
const fileIndex = require('../src/main/fileindex');
const { registerViewerIpc } = require('../src/main/ipc/viewer');

function setup() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-ipc-viewer-')));
  const repo = path.join(base, 'proj');
  fs.mkdirSync(repo);
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@example.com');
  g(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'init');
  const wt = path.join(base, 'wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
  const stranger = path.join(base, 'stranger');
  fs.mkdirSync(stranger);
  const remoteDir = path.join(base, 'remote-stand-in');
  fs.mkdirSync(remoteDir);
  const tabs = new Map([
    ['t1', { id: 't1', session: { cwd: wt }, worktree: { base: 'main' } }],
    ['t2', { id: 't2', session: { cwd: remoteDir } }],
  ]);
  const sent = [];
  const listeners = {};
  const ipc = createFakeIpc();
  const d = {
    isStr, manager: { tabs, on: (ev, fn) => { listeners[ev] = fn; } },
    remoteService: { placeOf: cwd => (cwd === remoteDir ? { host: 'box' } : null) },
    projects: { knowsRoot: r => (typeof r === 'string' && r.toLowerCase() === repo.toLowerCase() ? repo : null) },
    panel: { isDestroyed: () => false },
    send: (_win, channel, payload) => sent.push({ channel, payload }),
  };
  registerViewerIpc(ipc.ipcMain, d);
  return { base, repo, wt, stranger, ipc, sent, d, listeners, g, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("a conversation's folder opens, with its copy's base", async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    assert.equal(h.ok, true);
    assert.equal(h.branch, 'feat');
    assert.equal(h.base, 'main');
    const tree = await s.ipc.invoke('viewer:tree', h.id);
    assert.ok(tree.entries.includes('a.txt'));
    assert.equal((await s.ipc.invoke('viewer:read', h.id, 'a.txt')).text, 'one\n');
  } finally { s.done(); }
});

test('a closed conversation, a remote one, and nothing at all are refused', async () => {
  const s = setup();
  try {
    assert.equal((await s.ipc.invoke('viewer:open', { tabId: 'gone' })).ok, false);
    const remote = await s.ipc.invoke('viewer:open', { tabId: 't2' });
    assert.equal(remote.ok, false);
    assert.match(remote.error, /another computer/);
    assert.equal((await s.ipc.invoke('viewer:open', {})).ok, false);
    assert.equal((await s.ipc.invoke('viewer:open', null)).ok, false);
    assert.deepEqual(await s.ipc.invoke('viewer:locate', 't2', 'a.txt'), { inside: false });
    assert.deepEqual(await s.ipc.invoke('viewer:branch', 't2'), { branch: null });
  } finally { s.done(); }
});

test("a project's own worktrees open; any other folder is refused", async () => {
  const s = setup();
  try {
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo })).ok, true, 'the main checkout');
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: s.wt })).ok, true);
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: s.stranger })).ok, false);
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.stranger })).ok, false, 'not a project the page showed');
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: '\\\\attacker.example\\share' })).ok, false, 'never a network path');
  } finally { s.done(); }
});

test('a worktree record planted in the project cannot vouch for a folder of another repo', async () => {
  const s = setup();
  try {
    // git worktree list reports a locked record whatever its folder holds; the folder must point back to this repo.
    const planted = path.join(s.repo, '.git', 'worktrees', 'evil');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, 'gitdir'), `${path.join(s.stranger, '.git').split(path.sep).join('/')}\n`);
    fs.writeFileSync(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(planted, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(planted, 'locked'), '');
    assert.match(s.g(s.repo, 'worktree', 'list', '--porcelain'), /stranger/, 'git does list it');
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: s.stranger })).ok, false);
  } finally { s.done(); }
});

test("a closed conversation's handles go with it", async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    s.listeners.tabs([{ id: 't2' }]);
    assert.deepEqual(await s.ipc.invoke('viewer:changes', h.id), { ok: false, expired: true });
  } finally { s.done(); }
});

test('viewerWrites nudges after a writing tool, and the @-mention list is left alone', async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    const forgot = [];
    fileIndex.onForget(cwd => forgot.push(cwd));
    s.d.viewerWrites({ kind: 'tool', id: 'w1', name: 'Write' }, s.wt);
    s.d.viewerWrites({ kind: 'tool_result', id: 'w1' }, s.wt);
    assert.deepEqual(s.sent.at(-1), { channel: 'viewer:stale', payload: { ids: [h.id] } });
    assert.deepEqual(forgot, [], 'fileIndex.forget was not called');
  } finally { s.done(); }
});

test('only the panel may call them', async () => {
  const s = setup();
  try {
    await assert.rejects(() => s.ipc.invokeAs(s.ipc.senders.critter, 'viewer:open', { tabId: 't1' }));
    assert.ok(s.ipc.refused.includes('viewer:open'));
  } finally { s.done(); }
});

test('forgetting a folder nudges the viewers open on it, and only those', async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    fileIndex.forget(s.wt);
    assert.deepEqual(s.sent.at(-1), { channel: 'viewer:stale', payload: { ids: [h.id] } });
    const before = s.sent.length;
    fileIndex.forget(s.stranger);
    assert.equal(s.sent.length, before);
    await s.ipc.invoke('viewer:close', h.id);
    fileIndex.forget(s.wt);
    assert.equal(s.sent.length, before);
  } finally { s.done(); }
});
```

(`guardIpc` throws "Not allowed from this window." for a refused `handle` call, so `invokeAs` rejects.)

Append to `test/fileindex.test.js`:

```js
test('onForget hears every forget, and a listener that throws harms nothing', () => {
  const { forget, onForget } = require('../src/main/fileindex');
  const heard = [];
  onForget(() => { throw new Error('boom'); });
  onForget(cwd => heard.push(cwd));
  forget('C:\\somewhere');
  forget(42);
  assert.deepEqual(heard, ['C:\\somewhere']);
});
```

If the planted-record test's `git does list it` assertion fails on this machine's git, git itself refuses the record and the viewer check is moot: keep the second assertion, drop the first.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/ipc-viewer.test.js test/fileindex.test.js`
Expected: FAIL: `Cannot find module '../src/main/ipc/viewer'` and `onForget is not a function`.

- [ ] **Step 3: Add `onForget` to fileindex.js**

Replace `forget` (lines 109-111) with:

```js
// Who wants to know when a folder's list goes stale: something in it may have
// changed (the file viewer looks again; ipc/viewer.js).
const forgetters = [];
function onForget(fn) { if (typeof fn === 'function') forgetters.push(fn); }

function forget(cwd) {
  if (typeof cwd !== 'string') return;
  cache.delete(path.resolve(cwd).toLowerCase());
  for (const fn of forgetters) { try { fn(cwd); } catch { /* a listener's trouble is its own */ } }
}
```

Change the export to: `module.exports = { list, rank, mention, suggest, forget, onForget, withFolders };`

- [ ] **Step 4: Write `src/main/ipc/viewer.js`**

```js
// The file viewer's channels (viewer.js): open a handle on a conversation's
// folder, or on a worktree of a project the Project page showed, then read
// inside it. Read-only. Kept out of main.js, which only wires it up.
const changes = require('../changes');
const fileIndex = require('../fileindex');
const leaving = require('../leaving');
const { createViewer, locate, branchOf, sameDir, writeWatch } = require('../viewer');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps); this sets d.viewerNudge and d.viewerWrites
 */
function registerViewerIpc(ipcMain, d) {
  const viewer = createViewer();
  // A conversation's folder, when it's one on this PC (a remote tab's is only a stand-in).
  const folderOf = tabId => {
    const tab = d.isStr(tabId) ? d.manager.tabs.get(tabId) : null;
    if (!tab) return { error: 'That conversation is closed.' };
    const cwd = tab.session?.cwd;
    if (!leaving.okDir(cwd)) return { error: 'This conversation has no folder yet.' };
    if (d.remoteService?.placeOf(cwd)) return { error: 'That folder is on another computer.' };
    return { tab, cwd };
  };
  // The project's worktrees as git lists them, but only local folders that really are this repo's:
  // a record in .git/worktrees is the repo's own word, so the folder must point back to it.
  const isWorktreeOf = async (root, dir) => {
    if (!leaving.okDir(dir)) return false;
    const listed = leaving.parseWorktrees(await leaving.git(['-C', root, 'worktree', 'list', '--porcelain']));
    return listed.some(w => leaving.okDir(w.path) && sameDir(w.path, dir)) && changes.sameRepo(root, dir);
  };

  ipcMain.handle('viewer:open', async (_e, req) => {
    if (d.isStr(req?.tabId)) {
      const f = folderOf(req.tabId);
      if (f.error) return { ok: false, error: f.error };
      return viewer.open({ dir: f.cwd, base: f.tab.worktree?.base || null, tabId: f.tab.id });
    }
    if (d.isStr(req?.projectRoot)) {
      const root = d.projects?.knowsRoot(req.projectRoot);
      if (!root) return { ok: false, error: "That isn't a project Shellby knows." };
      const dir = d.isStr(req.worktreePath) ? req.worktreePath : root;
      if (!leaving.okDir(dir)) return { ok: false, error: "That isn't one of the project's worktrees." };
      if (!sameDir(dir, root) && !(await isWorktreeOf(root, dir))) return { ok: false, error: "That isn't one of the project's worktrees." };
      return viewer.open({ dir });
    }
    return { ok: false, error: 'Open what?' };
  });
  ipcMain.handle('viewer:tree', async (_e, id) => {
    const h = viewer.get(id);
    return h ? { ok: true, entries: await fileIndex.list(h.root) } : { ok: false, expired: true };
  });
  ipcMain.handle('viewer:changes', (_e, id, opts) => viewer.changesOf(id, { uncommittedOnly: !!opts?.uncommittedOnly }));
  ipcMain.handle('viewer:read', (_e, id, rel) => viewer.read(id, rel));
  ipcMain.handle('viewer:diff', (_e, id, rel) => viewer.diffOf(id, rel));
  ipcMain.handle('viewer:locate', async (_e, tabId, target) => {
    const f = folderOf(tabId);
    return f.error ? { inside: false } : locate(f.cwd, target);
  });
  ipcMain.handle('viewer:branch', async (_e, tabId) => {
    const f = folderOf(tabId);
    return { branch: f.error ? null : await branchOf(f.cwd) };
  });
  ipcMain.handle('viewer:close', (_e, id) => { viewer.close(id); return true; });
  // Something in a folder may have changed: a nudge for each viewer open on it.
  const nudge = d.viewerNudge = dir => {
    const ids = viewer.staleFor(dir);
    if (ids.length && d.panel && !d.panel.isDestroyed()) d.send(d.panel, 'viewer:stale', { ids });
  };
  fileIndex.onForget(nudge);                      // turn ends, ! commands, step undo
  d.viewerWrites = writeWatch(nudge);             // each tool that could have written (wiring/sessions.js)
  d.manager.on?.('tabs', summary => viewer.keepTabs(new Set(summary.map(t => t.id))));
  return viewer;
}

module.exports = { registerViewerIpc };
```

`changes.sameRepo(a, b)` (changes.js) compares `git rev-parse --git-common-dir` of both folders, so a folder that isn't a repo, or is another repo, fails it.

- [ ] **Step 5: Register it and expose it**

In `src/main/ipc/index.js`, after `const { registerFilesIpc } = require('./files');` add `const { registerViewerIpc } = require('./viewer');`, and after `registerFilesIpc(ipcMain, d);` add `registerViewerIpc(ipcMain, d);`.

`src/preload/preload.js` is at 797 of the 800 lines `test/file-size.test.js` allows, so the bridge takes exactly three lines and no comment line of its own. After `zoom: invoke('panel:zoom'),` add:

```js
  viewerOpen: invoke('viewer:open'), viewerTree: invoke('viewer:tree'), viewerChanges: invoke('viewer:changes'), // the file viewer (main's viewer.js), read-only
  viewerRead: invoke('viewer:read'), viewerDiff: invoke('viewer:diff'), viewerLocate: invoke('viewer:locate'),
  viewerBranch: invoke('viewer:branch'), viewerClose: invoke('viewer:close'), onViewerStale: on('viewer:stale'),
```

- [ ] **Step 6: Nudge after each tool that could have written**

In `src/main/wiring/sessions.js`, in the item handler, directly after the line `if (item.kind === 'tool') changes.noteTool(touchOf(tabId)?.touch, item); // what this turn could have written`, add:

```js
      d.viewerWrites?.(item, tab.session?.cwd); // the file viewer looks again once a writing tool is done (ipc/viewer.js)
```

This nudges the viewer without calling `fileIndex.forget`, so the @-mention list keeps its 20 s cache as today. The turn's end (`noteTurnChanges`), `!` commands (`parity.js`) and step undo (`step-undo.js`) already call `fileIndex.forget`, which nudges through `onForget`.

`d.viewerWrites` is looked up when each item arrives, not when sessions are wired: `main.js` wires sessions (line 315) before `registerIpc` (line 385), and both run at boot before any turn.

- [ ] **Step 7: Update what Settings says about file links**

In `src/renderer/panel/settings.js`, change the `$('editorNote').textContent = ed.using ? ...` sentence (line 211) to:

```js
      ? `File paths in a conversation open in Shellby's viewer. Ctrl+click opens ${ed.using} at the line, and Shift+click shows a file in its folder.`
```

Leave the no-editor sentence as it is.

- [ ] **Step 8: Document the boundary and the module**

In `docs/THREAT-MODEL.md`, add this row after the `| Renderer → main | ...` row:

```markdown
| Renderer → main file read | The panel reading files outside the folder it was shown, aiming git at another repo, reaching a network share, or a browsed repo running its own programs | The panel opens a handle on a conversation id or on a local worktree that `git worktree list` reports and that shares the project's git directory; paths with a drive, a stream, a network or rooted start, or `..` are refused before the disk is touched, then links and 8.3 names are resolved and the file opened is checked to be the one inside; outside and missing answer alike; diffs only for files on that handle's own changes list; 2 MB cap, binary refused. Its snapshots run `git add` into a temporary index with hooks pointed at an empty folder; clean filters (git-lfs) still run, as they do for status reads | `src/main/viewer.js`, `src/main/ipc/viewer.js`, `src/main/changes.js` |
```

In `docs/DEVELOPMENT.md`, after the `  fileindex.js     @ mentions: ...` line, add:

```
  viewer.js        the file viewer: handles on a folder, reads kept inside it, and what changed since its branch began; ipc/viewer.js serves it
```

- [ ] **Step 9: Run every unit test, lint and typecheck**

Run: `npm test; npm run lint; npm run typecheck`
Expected: all clean. `test/ipc-surface.test.js` checks the preload names match main's channels, and `test/file-size.test.js` checks preload.js is still at most 800 lines.

- [ ] **Step 10: Commit**

```bash
git add src/main/ipc/viewer.js src/main/ipc/index.js src/preload/preload.js src/main/fileindex.js src/main/wiring/sessions.js src/renderer/panel/settings.js docs/THREAT-MODEL.md docs/DEVELOPMENT.md test/ipc-viewer.test.js test/fileindex.test.js
git commit -m "feat: the file viewer's channels, and a nudge when an open folder may have changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The viewer's pure renderer logic

**Files:**
- Create: `src/renderer/shared/viewer-logic.js`
- Test: `test/viewer-logic.test.js`

**Interfaces:**
- Produces (global `window.ShellbyViewer`, and `module.exports` under node):
  - `buildTree(entries: string[], files: [{ path, status }]) -> { name, path, dir: true, status, children: Node[] }`; a Node is `{ name, path, dir, status: string|null, children? }`. Folders sort first, then by name without case. A folder with any changed descendant has `status: 'M'`. Deleted files (`status 'D'`) appear even though they're not on disk.
  - `visibleRows(tree, open: Set<string>, filter?: string) -> [{ node, depth }]`
  - `numberDiff(patch: string) -> [{ cls: 'hunk'|'add'|'del'|'ctx'|'meta', text, oldNo: number|null, newNo: number|null }]` (`text` without the leading `+`/`-`/space for add/del/ctx)
  - `splitLines(text) -> string[]` (CRLF and LF, no trailing empty line)
  - `liveState(tab) -> { word: 'Needs you'|'Working'|'Done', cls: 'needs'|'busy'|'done' } | null`
  - `statusWord(s) -> string`; `statusClass(s) -> 'a'|'m'|'d'|'t'|'u'`

- [ ] **Step 1: Write the failing test**

Create `test/viewer-logic.test.js`:

```js
// The file viewer's pure parts (shared/viewer-logic.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/renderer/shared/viewer-logic');

test('buildTree: folders first, case-blind order, change marks carried up', () => {
  const tree = V.buildTree(['src/', 'src/b.js', 'src/A.js', 'README.md', 'docs/', 'docs/x/', 'docs/x/y.md'], [
    { path: 'docs/x/y.md', status: 'M' }, { path: 'src/gone.js', status: 'D' },
  ]);
  assert.deepEqual(tree.children.map(c => c.name), ['docs', 'src', 'README.md']);
  const [docs, src] = tree.children;
  assert.equal(docs.status, 'M', 'a change two folders down marks the top one');
  assert.equal(docs.children[0].status, 'M');
  assert.deepEqual(src.children.map(c => `${c.name}:${c.status}`), ['A.js:null', 'b.js:null', 'gone.js:D']);
  assert.equal(src.status, 'M');
  assert.equal(tree.children[2].status, null);
});

test('buildTree: a deleted file still in the index is listed once', () => {
  const tree = V.buildTree(['a.txt'], [{ path: 'a.txt', status: 'D' }]);
  assert.deepEqual(tree.children.map(c => `${c.name}:${c.status}`), ['a.txt:D']);
});

test('visibleRows: open folders only, or every match and its folders when filtered', () => {
  const tree = V.buildTree(['src/', 'src/main/', 'src/main/app.js', 'src/b.js', 'top.md'], []);
  assert.deepEqual(V.visibleRows(tree, new Set()).map(r => r.node.path), ['src', 'top.md']);
  const open = V.visibleRows(tree, new Set(['src']));
  assert.deepEqual(open.map(r => `${r.depth}:${r.node.path}`), ['0:src', '1:src/main', '1:src/b.js', '0:top.md']);
  assert.deepEqual(V.visibleRows(tree, new Set(), 'APP').map(r => r.node.path), ['src', 'src/main', 'src/main/app.js']);
  assert.deepEqual(V.visibleRows(tree, new Set(), 'zzz'), []);
});

test('numberDiff numbers both sides from each hunk', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt',
    '@@ -3,3 +3,3 @@ head', ' keep', '-old', '+new', ' end', '\\ No newline at end of file',
  ].join('\n');
  const rows = V.numberDiff(patch);
  assert.deepEqual(rows.map(r => [r.cls, r.text, r.oldNo, r.newNo]), [
    ['hunk', '@@ -3,3 +3,3 @@ head', null, null],
    ['ctx', 'keep', 3, 3],
    ['del', 'old', 4, null],
    ['add', 'new', null, 4],
    ['ctx', 'end', 5, 5],
    ['meta', '\\ No newline at end of file', null, null],
  ]);
});

test('numberDiff: a new file starts its side at 1, and a removed "-- x" line is code', () => {
  const rows = V.numberDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+one\n+--- two\n');
  assert.deepEqual(rows.slice(1).map(r => [r.text, r.newNo]), [['one', 1], ['--- two', 2]]);
  assert.deepEqual(V.numberDiff(''), []);
});

test('splitLines drops CRLF and the empty line after a final newline', () => {
  assert.deepEqual(V.splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(V.splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(V.splitLines(''), ['']);
});

test('liveState: waiting on you beats working, and no tab means no state', () => {
  assert.deepEqual(V.liveState({ busy: true, pending: 1 }), { word: 'Needs you', cls: 'needs' });
  assert.deepEqual(V.liveState({ busy: true, pending: 0 }), { word: 'Working', cls: 'busy' });
  assert.deepEqual(V.liveState({ busy: false }), { word: 'Done', cls: 'done' });
  assert.equal(V.liveState(null), null);
});

test('status words and classes', () => {
  assert.equal(V.statusWord('?'), 'New, not tracked yet');
  assert.equal(V.statusWord('M'), 'Modified');
  assert.equal(V.statusClass('?'), 'u');
  assert.equal(V.statusClass('D'), 'd');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/viewer-logic.test.js`
Expected: FAIL with `Cannot find module '../src/renderer/shared/viewer-logic'`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/shared/viewer-logic.js`:

```js
/* The file viewer's pure parts (panel/viewer.js): a flat file list as a tree,
   a unified diff with both sides' line numbers, and a conversation's state in
   a word. No DOM, so node:test runs it. */
(function (root) {
  'use strict';

  const STATUS_WORDS = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed', '?': 'New, not tracked yet' };
  const statusWord = s => STATUS_WORDS[s] || String(s || '');
  const statusClass = s => (s === '?' ? 'u' : String(s || 'm').toLowerCase());

  /** fileindex's list ('src/', 'src/a.js', …) and the changes -> a tree of { name, path, dir, status, children }. */
  function buildTree(entries, files = []) {
    const changed = new Map((files || []).map(f => [f.path, f.status]));
    const top = { name: '', path: '', dir: true, status: null, children: [] };
    const dirs = new Map([['', top]]);
    const seen = new Set();
    const parentOf = p => { const cut = p.lastIndexOf('/'); return cut < 0 ? '' : p.slice(0, cut); };
    const dirOf = p => {
      if (dirs.has(p)) return dirs.get(p);
      const node = { name: p.slice(p.lastIndexOf('/') + 1), path: p, dir: true, status: null, children: [] };
      dirOf(parentOf(p)).children.push(node);
      dirs.set(p, node);
      return node;
    };
    const addFile = p => {
      if (seen.has(p)) return;
      seen.add(p);
      dirOf(parentOf(p)).children.push({ name: p.slice(p.lastIndexOf('/') + 1), path: p, dir: false, status: changed.get(p) || null });
    };
    for (const e of entries || []) {
      if (typeof e !== 'string' || !e) continue;
      if (e.endsWith('/')) dirOf(e.slice(0, -1));
      else addFile(e);
    }
    // A deleted file isn't on disk, so it may not be in the list: it still belongs in the tree.
    for (const f of files || []) if (f.status === 'D') addFile(f.path);
    const settle = node => {
      node.children.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
      for (const c of node.children) if (c.dir) { settle(c); if (c.children.some(k => k.status)) c.status = 'M'; }
    };
    settle(top);
    return top;
  }

  /** The rows to draw: [{ node, depth }]. Folders open when `open` has them; a filter shows every match and its folders. */
  function visibleRows(tree, open, filter = '') {
    const q = String(filter || '').trim().toLowerCase();
    const rows = [];
    const walk = (node, depth) => {
      for (const c of node.children) {
        if (q) {
          if (!c.dir) { if (c.path.toLowerCase().includes(q)) rows.push({ node: c, depth }); continue; }
          const at = rows.length;
          rows.push({ node: c, depth });
          walk(c, depth + 1);
          if (rows.length === at + 1) rows.pop(); // a folder with nothing in it that matches
          continue;
        }
        rows.push({ node: c, depth });
        if (c.dir && open && open.has(c.path)) walk(c, depth + 1);
      }
    };
    walk(tree, 0);
    return rows;
  }

  const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  /** A unified diff -> [{ cls, text, oldNo, newNo }], each side numbered from its hunk header. */
  function numberDiff(patch) {
    const rows = [];
    // Everything before a file's first @@ is its header (diff --git, index, ---, +++, modes);
    // after it, a removed "-- note" is "--- note", and that's code.
    let a = 0, b = 0, inHeader = true;
    for (const line of String(patch || '').replace(/\n$/, '').split('\n')) {
      if (line.startsWith('diff --git')) inHeader = true;
      const m = HUNK.exec(line);
      if (m) { inHeader = false; a = Number(m[1]); b = Number(m[2]); rows.push({ cls: 'hunk', text: line, oldNo: null, newNo: null }); continue; }
      if (inHeader) continue;
      if (line.startsWith('\\')) rows.push({ cls: 'meta', text: line, oldNo: null, newNo: null });
      else if (line.startsWith('+')) rows.push({ cls: 'add', text: line.slice(1), oldNo: null, newNo: b++ });
      else if (line.startsWith('-')) rows.push({ cls: 'del', text: line.slice(1), oldNo: a++, newNo: null });
      else rows.push({ cls: 'ctx', text: line.slice(1), oldNo: a++, newNo: b++ });
    }
    return rows;
  }

  /** A file's text as lines: CRLF or LF, and no empty line after a final newline. */
  function splitLines(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** The conversation's state for the viewer's header, from the panel's tab. */
  function liveState(tab) {
    if (!tab) return null;
    if (tab.pending > 0) return { word: 'Needs you', cls: 'needs' };
    if (tab.busy) return { word: 'Working', cls: 'busy' };
    return { word: 'Done', cls: 'done' };
  }

  const api = { buildTree, visibleRows, numberDiff, splitLines, liveState, statusWord, statusClass, STATUS_WORDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyViewer = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `node --test test/viewer-logic.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/shared/viewer-logic.js test/viewer-logic.test.js
git commit -m "feat: the file viewer's tree, numbered diffs and live state, as pure functions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The viewer screen

**Files:**
- Create: `src/renderer/panel/html/viewer.html`
- Create: `src/renderer/panel/viewer.css`
- Create: `src/renderer/panel/viewer.js`
- Create: `scripts/e2e-viewer.js`
- Modify: `src/renderer/panel/html/frame.html` (include, stylesheet, two scripts)
- Modify: `src/renderer/panel/core.js:348` (`SB.NAV_SECTION`)
- Rebuild: `src/renderer/panel/panel.html`

**Interfaces:**
- Consumes: Task 3's preload names; Task 4's `window.ShellbyViewer`; `window.ShellbySyntax` (`lineTokenizer`, `langFromPath`); `SB.paintTokens`, `SB.diffPainter`, `SB.openFile`, `SB.setView`, `SB.goBack`, `SB.toast`, `SB.icon`, `SB.remotePlace`, `SB.panes.count`, `state.grid`, `state.tabs`.
- Produces: `SB.viewer = { ICON, canOpen(tab), openTab(tabId, opts?), openWorktree(projectRoot, worktreePath, opts?), openLink(tabId, target, line), syncButtons(), current() }` where `opts = { file?, line?, side?: 'changes'|'files' }` and `current()` returns `{ id, root, file, side, files } | null` for e2e.

- [ ] **Step 1: Write the failing e2e check**

Create `scripts/e2e-viewer.js`:

```js
// ci: the file viewer: a copy's changes and diffs, whole files, live refresh, Esc back to the panes
// The file viewer (panel/viewer.js, main's viewer.js) end to end against the
// fake CLI: a conversation in its own copy edits files, the viewer lists them
// with diffs and both sides' line numbers, a second edit shows up on its own,
// and Esc puts the split panes back as they were.
//   node scripts/e2e-viewer.js [--shots <dir>]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9421;
const SHOT_TIMEOUT_MS = 10000;   // an unpainted window never answers captureScreenshot
const wait = ms => new Promise(r => setTimeout(r, ms));
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : process.env.E2E_SHOTS || null;

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-viewer-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
git('add', '-A');
git('commit', '-qm', 'init');
const claudeConfig = path.join(base, 'claude');
fs.mkdirSync(claudeConfig);
const userData = path.join(base, 'userdata');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboarded: true, crabOnly: false, worktrees: true, projects: { added: [repo] } }));
fs.writeFileSync(path.join(base, 'outside.txt'), 'not in the project\n');

// What the turns write, and so what the viewer must list: counts come from here.
const MADE = [{ file: 'b.txt', words: 'made in the copy' }, { file: 'c.txt', words: 'second change' }];

const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  // Something already on the port (an Electron a killed run left behind): the checks would drive that app instead.
  if ((await targets()).length) {
    console.log(`FAIL  port ${PORT} is taken by another app, maybe an Electron a killed run left behind`);
    process.exit(1);
  }
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: userData, CLAUDE_CONFIG_DIR: claudeConfig, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47972', SHELLBY_E2E: '1' },
  });
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
    const cdp = (method, params) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = expr => cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(m => m.result?.result?.value);
    const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await wait(150); } return false; };
    const idle = () => until('!SB.activeTab().busy');
    // Raced against a wait: a window something covers never answers (CLAUDE.md).
    const shot = async name => {
      if (!SHOTS) return;
      const m = await Promise.race([cdp('Page.captureScreenshot', { format: 'png' }), wait(SHOT_TIMEOUT_MS).then(() => null)]);
      if (m?.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(m.result.data, 'base64'));
      else console.log(`(no screenshot for ${name}: the window didn't paint in time)`);
    };
    await wait(3000);
    await ev("SB.setView('chat')");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(SB.folderChanged)`);
    await wait(500);

    // ---- a conversation in its own copy, beside another
    await ev('SB.newTab()');
    await ev(`SB.send(${JSON.stringify(`edit ${MADE[0].file} ${MADE[0].words}`)})`);
    await idle();
    check(await until("!document.getElementById('branchChip').hidden"), 'the conversation works in its own copy');
    const copyTab = await ev('SB.state.activeTab');
    await ev('SB.splitPane()');
    check(await until('SB.panes.count(SB.state.grid) === 2'), 'two panes side by side');
    await ev(`SB.activate(${JSON.stringify(copyTab)})`);

    // ---- the viewer on it
    await ev(`SB.viewer.openTab(${JSON.stringify(copyTab)})`);
    check(await until("SB.state.view === 'viewer' && document.querySelectorAll('#viewerList .vw-row').length > 0"), 'the viewer opens on the copy');
    const rows = await ev("[...document.querySelectorAll('#viewerList .vw-row')].map(b => b.dataset.path + ':' + b.querySelector('.vw-st').textContent)");
    check(JSON.stringify(rows) === JSON.stringify([`${MADE[0].file}:?`]), `Changes lists the new file as untracked (${rows})`);
    check(/\(from main\)/.test(await ev("document.getElementById('viewerWhere').textContent")), 'the header names the base');
    await ev(`[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === ${JSON.stringify(MADE[0].file)}).click()`);
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.add .code')].some(c => c.textContent === ${JSON.stringify(MADE[0].words)})`), 'its diff shows the line coming');
    check(await ev("document.querySelector('#viewerMain .dl.add .vw-ln:nth-child(2)').textContent") === '1', 'with the new side numbered');
    await shot('1-changes');

    // ---- a second edit shows up on its own. SB.send goes back to the chat (tab-send.js), so the
    // viewer hears the nudge while hidden and catches up when it's shown again.
    await ev(`SB.send(${JSON.stringify(`edit ${MADE[1].file} ${MADE[1].words}`)})`);
    await idle();
    check(await ev("SB.state.view === 'chat' && SB.viewer.current() !== null"), 'sending went back to the chat, the viewer kept its place');
    await ev("SB.setView('viewer')");
    check(await until(`document.querySelectorAll('#viewerList .vw-row').length === ${MADE.length}`), 'shown again, it lists the second edit');
    check(await ev(`SB.viewer.current().file === ${JSON.stringify(MADE[0].file)}`), 'and still has the file you were on');

    // ---- Whole file on a changed file, and back to its diff
    await ev("[...document.querySelectorAll('#viewerMain .vw-file-head button')].find(b => b.textContent === 'Whole file').click()");
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.ctx .code')].some(c => c.textContent === ${JSON.stringify(MADE[0].words)})`), 'Whole file shows the changed file as text');
    await ev("[...document.querySelectorAll('#viewerMain .vw-file-head button')].find(b => b.textContent === 'Diff').click()");
    check(await until("!!document.querySelector('#viewerMain .dl.add')"), 'and Diff goes back');

    // ---- a file that didn't change, read whole
    await ev("document.getElementById('viewerTabFiles').click()");
    await until("[...document.querySelectorAll('#viewerList .vw-row')].some(b => b.dataset.path === 'a.txt')");
    await ev("[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === 'a.txt').click()");
    check(await until("[...document.querySelectorAll('#viewerMain .dl.ctx .code')].some(c => c.textContent === 'original')"), 'an unchanged file opens as its text');
    await shot('2-whole-file');

    // ---- Esc puts the panes back
    check(await ev("SB.state.view === 'viewer'"), 'still in the viewer before Esc');
    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check(await until("SB.state.view === 'chat'"), 'Esc goes back to the chat');
    check(await ev('SB.panes.count(SB.state.grid)') === 2, 'with both panes still there');

    console.log(fails ? `\n${fails} failed` : '\nall passed');
    process.exitCode = fails ? 1 : 0;
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    app.kill();
    await wait(500);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
})();
```

`SB.send` ends with `SB.setView('chat')` (`src/renderer/panel/tab-send.js:172`); the script relies on that, and on the viewer catching up when shown again. Before running, compare the teardown with `scripts/e2e-changes.js` and copy its extra steps if it does more than `app.kill()`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node scripts/e2e-viewer.js`
Expected: FAIL at "the viewer opens on the copy" (`SB.viewer` is undefined). Earlier checks pass.

- [ ] **Step 3: Add the screen's markup**

Create `src/renderer/panel/html/viewer.html`:

```html
  <!-- ====================== FILE VIEWER ====================== -->
  <main class="view view-viewer" id="viewerView" aria-label="Files">
    <div class="vw-head">
      <button type="button" class="back-btn" id="viewerBack">← Back</button>
      <span class="vw-where" id="viewerWhere"></span>
      <span class="vw-live" id="viewerLive" hidden></span>
      <button type="button" class="btn ghost slim-btn" id="viewerRefresh" title="Look again" aria-label="Refresh">⟳</button>
      <button type="button" class="btn ghost slim-btn" id="viewerEditor" hidden>Open in editor</button>
    </div>
    <div class="vw-body">
      <aside class="vw-side" id="viewerSide">
        <div class="vw-tabs" role="tablist" aria-label="What to list">
          <button type="button" role="tab" class="vw-tab" id="viewerTabChanges" aria-selected="true">Changes <span class="vw-count" id="viewerCount"></span></button>
          <button type="button" role="tab" class="vw-tab" id="viewerTabFiles" aria-selected="false">All files</button>
        </div>
        <label class="vw-only small" id="viewerOnlyRow"><input type="checkbox" id="viewerOnly"> Just uncommitted</label>
        <input type="search" class="field slim vw-filter" id="viewerFilter" placeholder="Filter…" aria-label="Filter files" hidden>
        <p class="small muted vw-note" id="viewerNote" hidden></p>
        <ul class="vw-list" id="viewerList" aria-label="Files"></ul>
      </aside>
      <section class="vw-main" id="viewerMain" aria-live="polite"></section>
    </div>
  </main>
```

In `src/renderer/panel/html/frame.html`:
- after `  <!-- @include onboarding.html -->` add a blank line and `  <!-- @include viewer.html -->`
- after `<link rel="stylesheet" href="projects.css">` add `<link rel="stylesheet" href="viewer.css">`
- after `<script src="../shared/panes.js"></script>` add `<script src="../shared/viewer-logic.js"></script>`
- after `<script src="pane-room.js"></script>` add `<script src="viewer.js"></script>`

- [ ] **Step 4: Add the styles**

Create `src/renderer/panel/viewer.css`:

```css
/* The file viewer (viewer.js): a header, the list on the left, the file or its diff on the right. */
body[data-view="viewer"] .view-viewer { display: flex; flex-direction: column; padding: 10px 12px 12px; gap: 8px; animation: fadein .18s var(--ease-out); }
.vw-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vw-where { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sand); font-size: var(--fs-13); }
.vw-live { font-size: var(--fs-12); padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line-soft); color: var(--sand-dim); }
.vw-live.busy { color: var(--glass); }
.vw-live.needs { color: #ffc9bb; }
.vw-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(180px, 30%) minmax(0, 1fr); gap: 10px; }
.vw-side { display: flex; flex-direction: column; min-height: 0; gap: 6px; }
.vw-tabs { display: flex; gap: 4px; }
.vw-tab { flex: 1; padding: 4px 6px; border: 1px solid var(--line-soft); border-radius: var(--r-sm); background: none; color: var(--sand-dim); font-size: var(--fs-12); cursor: pointer; }
.vw-tab[aria-selected="true"] { color: var(--sand); box-shadow: inset 0 -2px 0 var(--glass); }
.vw-tab[hidden] { display: none; }
.vw-count:empty { display: none; }
.vw-only { display: flex; align-items: center; gap: 6px; color: var(--sand-dim); }
.vw-only[hidden] { display: none; }
.vw-note { margin: 0; }
.vw-list { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; min-height: 0; }
.vw-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px 6px; border: 0; border-radius: var(--r-sm); background: none; color: var(--sand-dim); font: var(--fs-12)/1.6 var(--font-mono); text-align: left; cursor: pointer; }
.vw-row:hover, .vw-row:focus-visible { background: var(--line-soft); color: var(--sand); }
.vw-row.on { background: var(--line-soft); color: var(--sand); box-shadow: inset 2px 0 0 var(--glass); }
.vw-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vw-caret { width: 10px; flex: none; }
.vw-st { flex: none; width: 1.2em; text-align: center; font-weight: 600; }
.vw-st.st-a, .vw-st.st-u { color: #c9f2e7; }
.vw-st.st-m, .vw-st.st-t { color: var(--glass); }
.vw-st.st-d { color: #ffc9bb; }
.vw-n { flex: none; font-size: var(--fs-11); }
.vw-n .add { color: #c9f2e7; }
.vw-n .del { color: #ffc9bb; }
.vw-d1 { padding-left: 18px; } .vw-d2 { padding-left: 30px; } .vw-d3 { padding-left: 42px; } .vw-d4 { padding-left: 54px; }
.vw-d5 { padding-left: 66px; } .vw-d6 { padding-left: 78px; } .vw-d7 { padding-left: 90px; } .vw-d8 { padding-left: 102px; }
.vw-d9 { padding-left: 114px; } .vw-d10 { padding-left: 126px; } .vw-d11 { padding-left: 138px; } .vw-d12 { padding-left: 150px; }
.vw-main { min-height: 0; overflow: auto; }
.vw-file-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.vw-file { color: var(--sand); font-size: var(--fs-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vw-file-head .btn { margin-left: auto; }
.vw-code.diff { max-height: none; font-size: var(--fs-12); }
.vw-code .dl { display: flex; padding: 0 10px 0 0; }
.vw-code .dl.hit { background: rgba(243, 230, 204, .13); box-shadow: inset 2px 0 0 var(--sand); }
.vw-ln { flex: none; width: 4.5ch; padding-right: 1ch; text-align: right; color: var(--sand-faint); user-select: none; }
.vw-sign { flex: none; width: 2ch; text-align: center; user-select: none; }
.vw-code .code { white-space: pre; }
.vw-big { display: flex; background: var(--abyss); border: 1px solid var(--line-soft); border-radius: var(--r-sm); font: var(--fs-12)/1.55 var(--font-mono); }
.vw-big pre { margin: 0; }
.vw-gutter { padding: 0 1ch; text-align: right; color: var(--sand-faint); user-select: none; }
.vw-plain { color: var(--sand-dim); white-space: pre; }
.vw-note-box { padding: 12px 0; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.vw-empty, .vw-gone { padding: 18px 0; }
@media (prefers-reduced-motion: reduce) { body[data-view="viewer"] .view-viewer { animation: none; } }
```

Before committing, grep `src/renderer/panel/*.css` for `--sand-faint`, `--line-soft`, `--abyss`, `--glass`, `--font-mono`, `--fs-11`, `--fs-12`, `--fs-13`, `--r-sm` and `fadein` to confirm each exists (all appear in `panel.css`'s `.diff` rules and `bugdex.css`); use the existing name if any differs.

- [ ] **Step 5: Register the view in the dock's Chat section**

In `src/renderer/panel/core.js`, add `viewer: 'chat'` to the `SB.NAV_SECTION` object literal, so Chat stays lit in the dock while the viewer shows. Esc already backs out to the home view (`tabs.js`, `SB.goBack`).

- [ ] **Step 6: Write the screen's script**

Create `src/renderer/panel/viewer.js`:

```js
/* Shellby panel — the file viewer: a conversation's folder (or a project's
   worktree) as a tree and a list of what changed since its branch began, any
   file in colour, and each change as a diff with both sides' line numbers.
   Read-only: main hands over a handle and keeps every read inside it (main's
   viewer.js). Opened from a pane's Files button, file links, the branch chip
   and the Project page. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const V = window.ShellbyViewer;
  const S = window.ShellbySyntax;
  const MAX_COLOUR_LINES = 4000;   // past this, plain text
  const REFRESH_MS = 2000;         // at most one look again in this long
  const ICON = 'M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z';
  const lastFile = new Map(); // root -> the file last open there, while Shellby runs
  let cur = null;             // what's open: the handle, the lists and the file on screen
  let shownAt = 0, timer = null;

  // A call on the handle. One dropped (eight others opened since, a closed tab, a reload) is opened
  // again, once, with its changes list rebuilt, since main serves diffs only for files on that list.
  async function call(fn) {
    const me = cur;
    let r = await fn(me.id).catch(() => null);
    if (r?.expired) {
      const again = await api.viewerOpen(me.req).catch(() => null);
      if (!again?.ok) return { ok: false, error: again?.error || "Couldn't open that folder." };
      me.id = again.id;
      if (me.git) await api.viewerChanges(me.id, { uncommittedOnly: me.only }).catch(() => null);
      r = await fn(me.id).catch(() => null);
    }
    return r || { ok: false, error: "Couldn't read that." };
  }

  const ancestors = rel => rel.split('/').slice(0, -1).map((_s, i, parts) => parts.slice(0, i + 1).join('/'));

  async function start(req, { file = null, line = null, side = null } = {}) {
    const r = await api.viewerOpen(req).catch(() => null);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't open that folder.");
    if (cur && cur.id !== r.id) api.viewerClose(cur.id);
    const me = cur = {
      ...r, req, tabId: req.tabId || null, side, only: false, files: [], more: 0, against: null, note: null, gone: false, dirty: false,
      entries: [], open: new Set(), filter: '', file: file || lastFile.get(r.root) || null, line, whole: !!line,
    };
    $('viewerFilter').value = '';
    $('viewerMain').replaceChildren();
    SB.setView('viewer');
    draw();
    await Promise.all([loadChanges(), loadTree()]);
    if (cur !== me) return;
    if (!me.side) me.side = me.files.length ? 'changes' : 'files';
    if (me.file) for (const a of ancestors(me.file)) me.open.add(a);
    draw();
    if (me.file) showFile(me.file, { line });
    else $('viewerMain').replaceChildren(h('p', { class: 'muted vw-empty', text: me.files.length ? 'Pick a file to see what changed.' : 'Pick a file to read it.' }));
  }

  async function loadChanges() {
    const me = cur;
    const r = await call(id => api.viewerChanges(id, { uncommittedOnly: me.only }));
    if (cur !== me) return;
    shownAt = Date.now();
    me.note = null;
    if (r.gone) { me.gone = true; me.files = []; return; }
    if (r.noGit) { me.git = false; me.files = []; return; }
    if (!r.ok) { me.files = []; me.note = { text: r.tooManyNew ? 'Too many new files to compare.' : "Couldn't read changes.", retry: !r.tooManyNew }; return; }
    me.files = r.files; me.more = r.more || 0; me.against = r.against;
  }

  async function loadTree() {
    const me = cur;
    const r = await call(id => api.viewerTree(id));
    if (cur === me) me.entries = r.ok ? r.entries : [];
  }

  function drawLive() {
    const live = cur?.tabId ? V.liveState(state.tabs.get(cur.tabId)) : null;
    $('viewerLive').hidden = !live;
    if (live) { $('viewerLive').textContent = live.word; $('viewerLive').className = `vw-live ${live.cls}`; }
  }

  function draw() {
    if (!cur) return;
    $('viewerWhere').textContent = [cur.name, cur.branch && (cur.base ? `${cur.branch} (from ${cur.base})` : cur.branch)].filter(Boolean).join(' · ');
    $('viewerWhere').title = cur.root;
    drawLive();
    if (cur.gone) {
      $('viewerSide').hidden = true;
      $('viewerEditor').hidden = true;
      $('viewerMain').replaceChildren(h('div', { class: 'vw-gone' },
        h('p', { text: 'This folder is gone.' }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Back', onclick: () => SB.goBack() })));
      return;
    }
    $('viewerSide').hidden = false;
    if (!cur.git) cur.side = 'files';
    $('viewerTabChanges').hidden = !cur.git;
    $('viewerTabChanges').setAttribute('aria-selected', String(cur.side === 'changes'));
    $('viewerTabFiles').setAttribute('aria-selected', String(cur.side === 'files'));
    $('viewerCount').textContent = cur.files.length ? String(cur.files.length + cur.more) : '';
    $('viewerOnlyRow').hidden = cur.side !== 'changes' || !cur.base;
    $('viewerOnly').checked = cur.only;
    $('viewerFilter').hidden = cur.side !== 'files';
    const said = cur.side !== 'changes' ? ''
      : cur.note ? cur.note.text
        : cur.more ? `Showing the first ${cur.files.length} of ${cur.files.length + cur.more}.`
          : cur.files.length ? '' : 'Nothing has changed here.';
    $('viewerNote').hidden = !said;
    $('viewerNote').replaceChildren(said, ...(cur.side === 'changes' && cur.note?.retry
      ? [' ', h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Retry', onclick: () => refresh() })] : []));
    $('viewerList').replaceChildren(...(cur.side === 'changes' ? changeRows() : treeRows()));
  }

  const counts = f => (f.binary ? h('span', { class: 'vw-n muted', text: 'binary' })
    : h('span', { class: 'vw-n' }, f.added ? h('span', { class: 'add', text: `+${f.added}` }) : null, f.removed ? h('span', { class: 'del', text: ` −${f.removed}` }) : null));

  function changeRows() {
    return cur.files.map(f => h('li', {},
      h('button', { type: 'button', class: `vw-row${f.path === cur.file ? ' on' : ''}`, dataset: { path: f.path }, title: `${V.statusWord(f.status)}: ${f.path}`, onclick: () => showFile(f.path) },
        h('span', { class: `vw-st st-${V.statusClass(f.status)}`, text: f.status }),
        h('span', { class: 'vw-path', text: f.path }),
        counts(f))));
  }

  function treeRows() {
    const tree = V.buildTree(cur.entries, cur.files);
    return V.visibleRows(tree, cur.open, cur.filter).map(({ node, depth }) => {
      const opened = node.dir && (cur.open.has(node.path) || !!cur.filter);
      return h('li', {},
        h('button', {
          type: 'button', class: `vw-row vw-d${Math.min(depth, 12)}${node.dir ? ' dir' : ''}${node.path === cur.file ? ' on' : ''}`,
          dataset: { path: node.path }, 'aria-expanded': node.dir ? String(opened) : null,
          onclick: () => (node.dir ? toggle(node.path) : showFile(node.path)),
        },
          h('span', { class: 'vw-caret', 'aria-hidden': 'true', text: node.dir ? (opened ? '▾' : '▸') : '' }),
          h('span', { class: 'vw-path', text: node.name }),
          node.status ? h('span', { class: `vw-st st-${V.statusClass(node.status)}`, text: node.dir ? '•' : node.status, title: node.dir ? 'Something in here changed' : V.statusWord(node.status) }) : null));
    });
  }

  function toggle(dir) {
    if (cur.open.has(dir)) cur.open.delete(dir); else cur.open.add(dir);
    $('viewerList').replaceChildren(...treeRows());
  }

  const note = (text, editor = false) => h('div', { class: 'vw-note-box' },
    h('p', { class: 'muted', text }),
    editor ? h('button', { type: 'button', class: 'btn slim-btn', text: 'Open in editor', onclick: openInEditor }) : null);

  function openInEditor() {
    if (!cur?.file) return;
    SB.openFile(`${cur.root}\\${cur.file.replace(/\//g, '\\')}`, { line: cur.line, tabId: cur.tabId || state.activeTab });
  }

  // A line to go to (a link's :42) opens the whole file there, changed or not; Diff is a click away.
  async function showFile(rel, { line = null, keep = false } = {}) {
    const me = cur;
    if (me.file !== rel || line) me.whole = !!line;
    me.file = rel; me.line = line;
    lastFile.set(me.root, rel);
    for (const b of document.querySelectorAll('#viewerList .vw-row')) b.classList.toggle('on', b.dataset.path === rel);
    const f = me.files.find(x => x.path === rel) || null;
    const main = $('viewerMain');
    const top = main.scrollTop;
    const body = !f || me.whole ? await wholeFile(rel, line) : await diffOf(f);
    if (cur !== me || me.file !== rel) return;
    main.replaceChildren(fileHead(rel, f), body);
    $('viewerEditor').hidden = false;
    if (keep) main.scrollTop = top;
    else main.querySelector('.hit')?.scrollIntoView({ block: 'center' });
  }

  function fileHead(rel, f) {
    return h('div', { class: 'vw-file-head' },
      h('code', { class: 'vw-file', text: rel, title: rel }),
      f ? h('span', { class: `vw-st st-${V.statusClass(f.status)}`, text: f.status, title: V.statusWord(f.status) }) : null,
      f ? counts(f) : null,
      f ? h('button', {
        type: 'button', class: 'btn ghost slim-btn', text: cur.whole ? 'Diff' : 'Whole file',
        disabled: f.status === 'D' && !cur.whole, onclick: () => { cur.whole = !cur.whole; cur.line = null; showFile(rel); },
      }) : null);
  }

  async function diffOf(f) {
    if (f.binary) return note('A binary file: nothing to show line by line.', true);
    const r = await call(id => api.viewerDiff(id, f.path));
    if (!r.ok) return note(r.error || "Couldn't read the diff.", true);
    const rows = V.numberDiff(r.patch);
    if (!rows.length) return note('No line changes (a mode or line-ending change).');
    const paint = SB.diffPainter?.(f.path);
    const pre = h('pre', { class: 'vw-code diff' }, rows.map(row => {
      const code = h('span', { class: 'code' });
      const toks = paint && row.cls !== 'meta' ? paint(row.cls, row.text) : null;
      if (toks) SB.paintTokens(code, toks); else code.textContent = row.text;
      return h('span', { class: `dl ${row.cls}` },
        h('span', { class: 'vw-ln', text: row.oldNo ?? '' }),
        h('span', { class: 'vw-ln', text: row.newNo ?? '' }),
        h('span', { class: 'vw-sign', text: row.cls === 'add' ? '+' : row.cls === 'del' ? '−' : '' }),
        code);
    }));
    return r.truncated ? h('div', {}, pre, note('This diff is too big to show in full.', true)) : pre;
  }

  async function wholeFile(rel, line) {
    const r = await call(id => api.viewerRead(id, rel));
    if (r.missing) return note('This file is gone.');
    if (r.tooBig) return note('This file is too big to show here.', true);
    if (r.binary) return note('A binary file: nothing to show as text.', true);
    if (!r.ok) return note(r.error || "Couldn't read that.", true);
    const lines = V.splitLines(r.text);
    if (lines.length > MAX_COLOUR_LINES) {
      // Plain past the cap: two blocks of text instead of a row per line.
      const text = h('pre', { class: 'vw-plain', text: lines.join('\n') });
      if (line) requestAnimationFrame(() => { const lh = parseFloat(getComputedStyle(text).lineHeight) || 18; $('viewerMain').scrollTop = Math.max(0, (line - 5) * lh); });
      return h('div', { class: 'vw-code vw-big' }, h('pre', { class: 'vw-gutter', text: lines.map((_l, i) => i + 1).join('\n') }), text);
    }
    const tk = S.lineTokenizer(S.langFromPath(rel));
    return h('pre', { class: 'vw-code diff' }, lines.map((l, i) => h('span', { class: `dl ctx${line === i + 1 ? ' hit' : ''}` },
      h('span', { class: 'vw-ln', text: i + 1 }),
      SB.paintTokens(h('span', { class: 'code' }), tk.line(l)))));
  }

  const sig = rel => { const f = cur?.files.find(x => x.path === rel); return f ? `${f.status}${f.added}/${f.removed}` : '-'; };

  async function refresh({ tree = true } = {}) {
    if (!cur) return;
    const me = cur;
    const before = sig(me.file);
    await Promise.all([loadChanges(), tree ? loadTree() : null]);
    if (cur !== me) return;
    draw();
    if (me.file && (tree || sig(me.file) !== before)) showFile(me.file, { keep: true }); // no line: Diff or Whole stays as chosen
  }

  // Main's nudge: something in the folder may have changed. One look, at most every 2 s, only on
  // Changes and only while showing; otherwise the viewer remembers, and looks when it's shown again.
  const showing = () => state.view === 'viewer' && cur?.side === 'changes';
  api.onViewerStale(({ ids } = {}) => {
    if (!cur || !ids?.includes(cur.id)) return;
    if (!showing()) { cur.dirty = true; return; }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (showing()) refresh({ tree: false }); else if (cur) cur.dirty = true;
    }, Math.max(0, REFRESH_MS - (Date.now() - shownAt)));
  });
  // Shown again (Back to chat, then the Files button, or SB.setView): catch up on what it missed.
  SB.views.viewer = {
    render() {
      if (!cur?.dirty) return;
      cur.dirty = false;
      refresh({ tree: false });
    },
  };

  $('viewerBack').addEventListener('click', () => SB.goBack());
  $('viewerRefresh').addEventListener('click', () => refresh());
  $('viewerEditor').addEventListener('click', openInEditor);
  $('viewerTabChanges').addEventListener('click', async () => { if (!cur) return; cur.side = 'changes'; cur.dirty = false; draw(); await loadChanges(); draw(); });
  $('viewerTabFiles').addEventListener('click', () => { if (!cur) return; cur.side = 'files'; draw(); });
  $('viewerOnly').addEventListener('change', async e => { if (!cur) return; cur.only = e.target.checked; await loadChanges(); draw(); });
  $('viewerFilter').addEventListener('input', e => { if (!cur) return; cur.filter = e.target.value; $('viewerList').replaceChildren(...treeRows()); });
  // ↑/↓ move through the list; the rows are buttons, so Enter opens one.
  $('viewerList').addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...$('viewerList').querySelectorAll('.vw-row')];
    const at = rows.indexOf(document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); }
  });

  SB.viewer = {
    ICON,
    canOpen: tab => !!tab?.cwd && !SB.remotePlace(tab.cwd),
    openTab: (tabId, opts) => (tabId ? start({ tabId }, opts) : null),
    openWorktree: (projectRoot, worktreePath, opts) => start({ projectRoot, worktreePath }, opts),
    // A file link: in the viewer when it's inside the conversation's repo, else your editor as before.
    async openLink(tabId, target, line) {
      const r = await api.viewerLocate(tabId, target).catch(() => null);
      if (r?.inside) return start({ tabId }, { file: r.rel, line: r.line || line });
      return SB.openFile(target, { line, tabId });
    },
    // The Files buttons (Task 6) and the header's live state follow the tabs.
    syncButtons() {
      if (cur && state.view === 'viewer') drawLive();
    },
    current: () => (cur ? { id: cur.id, root: cur.root, file: cur.file, side: cur.side, files: cur.files } : null),
  };
})();
```

- [ ] **Step 7: Rebuild panel.html and run the checks**

Run: `npm run panel:html; npm run lint; node --test test/panel-html.test.js`
Expected: `panel.html` rebuilt, lint clean, the panel-html test passes.

Run: `node scripts/e2e-viewer.js`
Expected: every line PASS, `all passed`. If "shown again, it lists the second edit" fails, find which link broke: log in `onViewerStale` (did a nudge arrive while hidden and set `cur.dirty`?), in `SB.views.viewer.render` (did it refresh?), and in main's `d.viewerNudge` (did `staleFor` match the copy's folder and clear its last look?).

Run: `npm test`
Expected: all pass, `test/file-size.test.js` and `test/panel-html.test.js` included.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/panel/html/viewer.html src/renderer/panel/html/frame.html src/renderer/panel/panel.html src/renderer/panel/viewer.css src/renderer/panel/viewer.js src/renderer/panel/core.js scripts/e2e-viewer.js
git commit -m "feat: a full-panel file viewer with a folder's changes, diffs and whole files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ways in: Files buttons, file links, and the branch chip

**Files:**
- Modify: `src/renderer/panel/tab-panes.js` (`paneHead`, icons at lines 17-19)
- Modify: `src/renderer/panel/html/frame.html` (the main tab strip, after `#newTabBtn`)
- Modify: `src/renderer/panel/tab-strip.js` (`SB.renderTabStrip`, last line)
- Modify: `src/renderer/panel/viewer.js` (`syncButtons`, and the `#filesBtn` click)
- Modify: `src/renderer/panel/files.js:26-39` (`SB.fileLink` title and the click listener)
- Modify: `src/renderer/panel/tab-chips.js:55-67` (`applyFolderLabel`)
- Modify: `src/renderer/panel/tab-git.js:168-232` (the `#branchChip` click)
- Modify: `src/renderer/panel/components.css` (the strip button)
- Modify: `scripts/e2e-viewer.js`
- Rebuild: `src/renderer/panel/panel.html`

**Interfaces:**
- Consumes: Task 5's `SB.viewer`; Task 3's `api.viewerBranch`, `api.viewerLocate`.
- Produces: `.pane-head .pane-files` buttons, `#filesBtn`, link routing, the branch chip for every git folder with a "View changes" entry.

- [ ] **Step 1: Write the failing e2e checks**

In `scripts/e2e-viewer.js`, replace `await ev(\`SB.viewer.openTab(${JSON.stringify(copyTab)})\`);` with a press of the pane's own button:

```js
    const paneId = await ev(`SB.panes.paneWith(SB.state.grid, ${JSON.stringify(copyTab)}).id`);
    check(await until(`!document.querySelector('.pane-head[data-pane="${paneId}"] .pane-files').hidden`), "the copy's pane has a Files button");
    await ev(`document.querySelector('.pane-head[data-pane="${paneId}"] .pane-files').click()`);
```

After the Esc checks, add:

```js
    // ---- file links: click opens the viewer, Ctrl the editor, Shift its folder, outside the repo the editor
    await ev("window.__opened = []; SB.openFile = (p, o) => { window.__opened.push({ p, line: o?.line ?? null, reveal: !!o?.reveal }); }");
    const linkIn = (file, opts = {}) => `(() => { const a = SB.fileLink(${JSON.stringify(file)}, { line: 1 }); document.querySelector('.feed[data-tab="' + ${JSON.stringify(copyTab)} + '"]').append(a); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: ${!!opts.ctrl}, shiftKey: ${!!opts.shift} })); })()`;
    await ev(linkIn(MADE[0].file));
    check(await until(`SB.state.view === 'viewer' && SB.viewer.current()?.file === ${JSON.stringify(MADE[0].file)}`), 'a file link opens the viewer on that file');
    await ev("SB.setView('chat')");
    await ev(linkIn(MADE[0].file, { ctrl: true }));
    check(await until('window.__opened.length === 1') && await ev("SB.state.view === 'chat' && !window.__opened[0].reveal"), 'Ctrl+click opens the editor instead');
    await ev(linkIn(MADE[0].file, { shift: true }));
    check(await until('window.__opened.length === 2') && await ev('window.__opened[1].reveal'), 'Shift+click shows it in its folder');
    await ev(linkIn(path.join(base, 'outside.txt')));
    check(await until('window.__opened.length === 3') && await ev("SB.state.view === 'chat'"), 'a file outside the repo still opens in the editor');

    // ---- the branch chip, in a conversation in your own checkout
    const other = await ev(`[...SB.state.tabs.keys()].find(id => id !== ${JSON.stringify(copyTab)})`);
    await ev(`SB.activate(${JSON.stringify(other)})`);
    check(await until("!document.getElementById('branchChip').hidden && document.getElementById('branchLabel').textContent === 'main'"), 'a plain checkout shows its branch too');
    await ev("document.getElementById('branchChip').click()");
    check(await until("[...document.querySelectorAll('#branchMenu .mi-title')].some(t => t.textContent === 'View changes')"), 'its menu offers View changes');
    await ev("[...document.querySelectorAll('#branchMenu .menu-item')].find(b => b.textContent.includes('View changes')).click()");
    check(await until("SB.state.view === 'viewer' && SB.viewer.current()?.side === 'changes'"), 'which opens the viewer on Changes');
    check(await until("document.getElementById('viewerNote').textContent === 'Nothing has changed here.'"), 'and says when nothing has');
    await ev("SB.setView('chat')");
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node scripts/e2e-viewer.js`
Expected: FAIL at "the copy's pane has a Files button".

- [ ] **Step 3: A Files button in each pane's header**

In `src/renderer/panel/tab-panes.js`, after `const CLOSE_ICON = ...` (line 19) add:

```js
  const FILES_ICON = 'M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z';
```

In `paneHead`, after the `+` button (the one whose `onclick` is `() => newTabIn(paneId)`), add:

```js
      h('button', { class: 'pane-btn pane-files', type: 'button', hidden: true, title: "Browse this conversation's files", 'aria-label': 'Browse files', onclick: () => { const id = activeOf(paneId); if (id) SB.viewer?.openTab(id); } },
        SB.icon(FILES_ICON, { width: 1.3 })),
```

Update the comment above `paneHead` to: `then a new conversation in this pane, its files, pop out the tab it shows, and close the pane.`

- [ ] **Step 4: A Files button on the main strip, for one pane**

In `src/renderer/panel/html/frame.html`, after the `#newTabBtn` button's closing `</button>`, add:

```html
    <button type="button" class="tab-files" id="filesBtn" title="Browse this conversation's files" aria-label="Browse files" hidden>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
    </button>
```

In `src/renderer/panel/components.css`, add `.tab-files` to the three `.tab-add` selectors at lines 144-149: `.tab-add {` becomes `.tab-add, .tab-files {`, `.tab-add svg {` becomes `.tab-add svg, .tab-files svg {`, and `.tab-add:hover {` becomes `.tab-add:hover, .tab-files:hover {`. Then add `.tab-files[hidden] { display: none; }` after them, since the shared rule sets `display`.

In `src/renderer/panel/viewer.js`, replace `syncButtons` with:

```js
    syncButtons() {
      const canOpen = SB.viewer.canOpen;
      $('filesBtn').hidden = SB.panes.count(state.grid) > 1 || !canOpen(state.tabs.get(state.activeTab));
      for (const b of document.querySelectorAll('.pane-head .pane-files')) {
        const pane = state.grid.flat().find(p => p.id === b.closest('.pane-head')?.dataset.pane);
        b.hidden = !canOpen(state.tabs.get(pane?.active));
      }
      if (cur && state.view === 'viewer') drawLive();
    },
```

And beside the other listeners, add:

```js
  $('filesBtn').addEventListener('click', () => SB.viewer.openTab(state.activeTab));
```

In `src/renderer/panel/tab-strip.js`, at the end of `SB.renderTabStrip` after `SB.refreshPaneHeads();`, add:

```js
    SB.viewer?.syncButtons(); // the Files buttons follow what each pane shows (viewer.js)
```

- [ ] **Step 5: File links open the viewer**

In `src/renderer/panel/files.js`, change the `title` in `SB.fileLink` to:

```js
    title: `Open ${file}${line ? ` at line ${line}` : ''} · Ctrl+click opens your editor · Shift+click shows it in its folder`,
```

Replace the click listener body (lines 33-39) with:

```js
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a.file-link');
    if (!a) return;
    e.preventDefault();
    const feed = a.closest('.feed');
    const tabId = feed?.dataset.tab || state.activeTab;
    const line = Number(a.dataset.line) || null;
    // Ctrl: your editor, as a click used to be. Shift: its folder. A popped-out window has only its
    // chat, and a link outside a conversation (Workflows' runs, say) has no folder to show it in.
    if (e.ctrlKey || e.shiftKey || SB.solo || !SB.viewer || !feed) return SB.openFile(a.dataset.path, { line, reveal: e.shiftKey, tabId });
    SB.viewer.openLink(tabId, a.dataset.path, line);
  });
```

Inside a conversation (`.feed`) this covers reply text, tool rows, permission cards and attachment chips: all of them name files in that conversation's folder.

Run `node --test` and grep `test/` for `Shift+click shows it in its folder`; update any test that asserts the old title.

- [ ] **Step 6: The branch chip for every git folder**

In `src/renderer/panel/tab-chips.js`, above `function applyFolderLabel`, add:

```js
  // A conversation in your own checkout shows its branch too: the way into the file viewer (viewer.js).
  // What's known shows at once, so the chip never blinks; a lookup older than 15 s is redone
  // quietly, one at a time per folder.
  const branchSeen = new Map(); // cwd -> { at, branch, asking }
  function plainBranch(tab) {
    const seen = branchSeen.get(tab.cwd) || { at: 0, branch: null, asking: null };
    branchSeen.set(tab.cwd, seen);
    if (Date.now() - seen.at > 15000 && !seen.asking) {
      seen.asking = api.viewerBranch(tab.id).catch(() => null).then(r => {
        Object.assign(seen, { at: Date.now(), branch: r?.branch || null, asking: null });
        if (SB.activeTab()?.id === tab.id && !tab.worktree) showBranch(seen.branch);
      });
    }
    return seen.branch;
  }
  function showBranch(branch) {
    $('branchChip').hidden = !branch;
    if (branch) {
      $('branchLabel').textContent = branch;
      $('branchChip').title = `On branch ${branch}`;
    }
  }
```

In `applyFolderLabel`, replace the line `$('branchChip').hidden = !w;` and the `if (w) { ... }` block after it with:

```js
    if (w) {
      $('branchChip').hidden = false;
      $('branchLabel').textContent = w.branch.replace(/^shellby\//, '');
      $('branchChip').title = `Its own copy, on branch ${w.branch} (from ${w.base})`;
    } else {
      showBranch(tab && !SB.solo ? plainBranch(tab) : null);
    }
```

In `src/renderer/panel/tab-git.js`, above `$('branchChip').addEventListener('click', ...)`, add:

```js
  // The file viewer (viewer.js) on this conversation, opened on what changed.
  const viewChangesItem = (tab, sub) => h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); SB.viewer?.openTab(tab.id, { side: 'changes' }); } },
    h('span', { class: 'mi-check', text: '≡' }),
    h('span', {}, h('div', { class: 'mi-title', text: 'View changes' }), h('div', { class: 'mi-sub', text: sub })));
```

In the click handler, replace `if (!w) return;` with:

```js
    if (!w) {
      if (!tab || !SB.viewer?.canOpen(tab)) return;
      return SB.openMenu($('branchMenu'), $('branchChip'), () => [
        h('div', { class: 'menu-label', text: `On branch ${$('branchLabel').textContent}` }),
        viewChangesItem(tab, 'Files changed since the last commit, with their diffs'),
      ]);
    }
```

In the copy's menu, directly after `...(SB.clashMenuItems?.(tab) || []), // other copies that changed the same files (clashes.js)`, add:

```js
      viewChangesItem(tab, `Every file changed since it came from ${w.base}, with its diff`),
```

- [ ] **Step 7: Rebuild and run the checks**

Run: `npm run panel:html; npm run lint; npm test`
Expected: clean, all tests pass.

Run: `node scripts/e2e-viewer.js; node scripts/e2e-changes.js; node scripts/e2e-panes.js`
Expected: all three print `all passed` (or their own all-pass line). `e2e-changes` covers the copy's branch chip and menu, and `e2e-panes` covers the pane header this task changed.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/panel/tab-panes.js src/renderer/panel/html/frame.html src/renderer/panel/panel.html src/renderer/panel/tab-strip.js src/renderer/panel/viewer.js src/renderer/panel/files.js src/renderer/panel/tab-chips.js src/renderer/panel/tab-git.js src/renderer/panel/components.css scripts/e2e-viewer.js
git commit -m "feat: open the file viewer from each pane, from file links, and from the branch chip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If a test asserting the old link title changed, add it to this commit.

---

### Task 7: The Project page's worktrees and Browse files

**Files:**
- Modify: `src/renderer/panel/project-page.js:128-153` (`cloneSection`, `copiesList`)
- Modify: `src/renderer/panel/projects.css`
- Modify: `scripts/e2e-viewer.js`

**Interfaces:**
- Consumes: `SB.viewer.openWorktree(projectRoot, worktreePath)`, `SB.viewer.ICON`; `git.copyList` (`{ path, branch, changed }`, at most 12) from `projects/service.js` `gitView`. (No "and N more": `leaving.js` reads at most 12 worktrees including the main checkout, so the list is never cut.)

- [ ] **Step 1: Write the failing e2e checks**

In `scripts/e2e-viewer.js`, before the `console.log(fails ? ...` line, add:

```js
    // ---- the Project page: Browse files, and its worktrees open in the viewer
    await ev("SB.setView('projects')");
    const name = path.basename(repo);
    check(await until(`[...document.querySelectorAll('#pjProjects .pj-row-name b')].some(b => b.textContent === ${JSON.stringify(name)})`), 'the project is on the list');
    await ev(`[...document.querySelectorAll('#pjProjects .pj-row')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`);
    check(await until("[...document.querySelectorAll('#pjDetailScreen .pj-clone-head button')].some(b => b.textContent === 'Browse files')"), 'its clone has Browse files');
    check(await until("document.querySelectorAll('#pjDetailScreen .pj-copy-open').length === 1", 20000), "and its copy is listed, ready to open");
    await ev("document.querySelector('#pjDetailScreen .pj-copy-open').click()");
    check(await until(`SB.state.view === 'viewer' && SB.viewer.current()?.files.length === ${MADE.length}`), "the copy opens in the viewer with what it changed");
    await ev("SB.setView('projects')");
    await ev("[...document.querySelectorAll('#pjDetailScreen .pj-clone-head button')].find(b => b.textContent === 'Browse files').click()");
    check(await until("SB.state.view === 'viewer' && document.getElementById('viewerNote').textContent === 'Nothing has changed here.'"), 'Browse files opens the checkout itself');
    await shot('3-project-page');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node scripts/e2e-viewer.js`
Expected: FAIL at "its clone has Browse files".

- [ ] **Step 3: Implement**

In `src/renderer/panel/project-page.js` `cloneSection`, inside the `pj-clone-head` div, after the `New conversation here` button line, add:

```js
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Browse files', onclick: () => SB.viewer?.openWorktree(c.root, c.root) })),
```

(Move the closing `)` of the `pj-clone-head` `h('div', ...)` from the previous line onto this one.)

Replace `copiesList` with:

```js
  // The repo's other worktrees (Shellby's copies, Claude Code's, your own): work
  // that's easy to forget about, each a click from the file viewer (viewer.js).
  function copiesList(root, git) {
    const list = git?.copyList || [];
    if (!list.length) return null;
    const d = P.keptDetails(`copies:${root}`, L.copiesSummary(list),
      h('ul', { class: 'pj-copy-list' },
        list.map(w => h('li', {},
          h('button', { type: 'button', class: 'pj-copy-open', title: `Browse ${w.path}`, onclick: () => SB.viewer?.openWorktree(root, w.path) },
            SB.icon(SB.viewer?.ICON || '', { width: 1.3 }),
            h('code', { text: w.branch || 'detached' }),
            w.changed ? h('span', { class: 'pj-chip warn', text: `${w.changed} changed` }) : h('span', { class: 'muted small', text: 'clean' }))))));
    d.classList.add('pj-copies');
    return d;
  }
```

In `src/renderer/panel/projects.css`, add:

```css
.pj-copy-list li:has(> .pj-copy-open) { padding: 0; }
.pj-copy-open { display: flex; align-items: center; gap: 8px; width: 100%; padding: 3px 4px 3px 12px; border: 0; border-radius: var(--r-sm); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pj-copy-open code { flex: 1; min-width: 0; }
.pj-copy-open:hover, .pj-copy-open:focus-visible { background: var(--line-soft); }
```

The existing `.pj-copy-list li` rule (line 312) lays the row out with flex and `space-between`; the button takes that layout over, so its own padding replaces the `li`'s, and `code { flex: 1 }` pushes the chip to the right. The existing `.pj-copy-list code` rule (line 313) still styles the branch name.

- [ ] **Step 4: Run the checks**

Run: `npm run lint; npm test; node scripts/e2e-viewer.js; node scripts/e2e-projects.js`
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/panel/project-page.js src/renderer/panel/projects.css scripts/e2e-viewer.js
git commit -m "feat: the Project page opens a project or any of its worktrees in the file viewer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The change note, and the whole branch green

**Files:**
- Create: `changes/file-viewer.md`

- [ ] **Step 1: Write the change note**

Create `changes/file-viewer.md`, in the CHANGELOG's voice (read `CHANGELOG.md`'s latest entry and `changes/split-panes.md` first and match them):

```markdown
### New
- **See what a worktree changed, without leaving Shellby.** A Files button on each pane opens that conversation's folder: what changed since its branch began, each file's diff with line numbers, and any file in colour. It keeps up while Claude works. The branch chip and the Project page open it too, for your own checkouts and every worktree of a project.
- **File links open right here.** Clicking a file Claude mentions opens it in the viewer at that line. Ctrl+click opens your editor, as before.
```

Run the `humanizer` skill in embedded mode on the note's prose before committing (user's global CLAUDE.md), keeping every fact.

- [ ] **Step 2: Run every check**

Run: `npm run lint; npm run typecheck; npm test; npm run e2e:ci`
Expected: all four clean. `e2e:ci` picks up `e2e-viewer` from its `// ci:` first line. If an unrelated e2e fails, rerun it alone (`npm run e2e:ci -- <name>`) to tell a flake from a regression, and report it either way.

- [ ] **Step 3: Confirm no stray processes**

Run (PowerShell): `Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*file-viewer*' }`
Expected: nothing. Stop any listed by its id.

- [ ] **Step 4: Commit**

```bash
git add changes/file-viewer.md
git commit -m "docs: change note for the file viewer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Delivery, after PR #27 (split-panes) merges upstream; not before, and only with Tyler's go-ahead to push**

Run: `git fetch upstream; git rebase upstream/main`
Expected: the 35 split-panes commits drop out as already upstream; only this branch's commits remain. Resolve conflicts by keeping upstream's version of split-panes code and re-applying this branch's edits.

Then drop the design documents, which upstream has no folder for (the spec says so), unless Tyler asks to ship them:

```bash
git rm -r docs/superpowers
git commit -m "chore: drop the file viewer's design notes from the branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Run all four checks again (`npm run lint; npm run typecheck; npm test; npm run e2e:ci`) on the rebased branch, then ask Tyler before pushing or opening the PR. The PR description notes the new trust boundary (CONTRIBUTING.md requires it for IPC and preload changes) and links the THREAT-MODEL row.
