# File Viewer: Worktrees and Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The file viewer's header opens a menu of every worktree of the repo and every unmerged local branch, and picking one shows it: a worktree as a folder, as today, and a branch nothing has checked out read from git alone, with its changes since it left main, each diff, its tree and any file in it.

**Architecture:** `src/main/viewer.js` gains a second kind of handle, `kind: 'branch'`, read only with `rev-parse`, `merge-base`, `diff`, `ls-tree` and `cat-file`, plus `placesOf(id)` and `switchTo(id, key)`, which list the repo's places under random keys kept on the handle and open a pick only after checking it again. `src/main/ipc/viewer.js` exposes `viewer:places` and `viewer:switch`, serves `viewer:tree` through the new `treeOf`, and nudges branch handles only on the forgets where commits land (turn end, step undo, `!` commands). The panel turns `#viewerWhere` into a menu button and learns branch mode, keeping the file you were on when the new place has it.

**Tech Stack:** Electron 44, plain JS (no renderer framework, no new dependencies), git via `execFile`, node:test against real temp repos, CDP e2e scripts.

**Spec:** `docs/superpowers/specs/2026-10-12-viewer-worktrees-and-branches-design.md`

## Global Constraints

- Work in `C:\RAD\shellby\.claude\worktrees\file-viewer` on branch `file-viewer` (head 4ca88f4e when this plan was written). Run every command from there.
- Plain HTML/CSS/JS in the renderer. No new runtime or dev dependencies.
- CSP is `default-src 'none'; script-src 'self'; style-src 'self'`: no inline `style`, no inline script. Build DOM with `SB.h` and `textContent`; attributes are fixed words or numbers only.
- git runs through `execFile` with fixed arguments, `-c core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, a timeout, and never throws to its caller.
- A ref reaches git only as a full `refs/heads/...` name taken from `for-each-ref` (or `refs/heads/<base>` for the main checkout's branch). Never a short name, never one from the panel.
- Branch reads never write: no snapshot, no temporary index, no `git add`, no checkout, no hook. `cat-file blob` runs with `GIT_LITERAL_PATHSPECS=1`.
- Caps (exact): 20 worktrees listed; 30 branches checked (newest first); 10 s list reuse; 4 `git status` (and `rev-list`) runs at a time; 8 s timeout per git call; 2 MB per file read; NUL in the first 8 KB means binary; 500 files per changes list (`changes.js` MAX_FILES); 400 KB per patch (`changes.js` MAX_PATCH); 2 s refresh reuse (`REFRESH_MS`); 8 handles (`MAX_HANDLES`); 30,000 paths in a branch's All files (as `fileindex.js` lists a folder).
- User-facing strings, exact: "This branch is gone." (with Back); toast "That worktree or branch is gone."; main's stale-pick error `'That worktree or branch is gone.'`; "Couldn't list worktrees."; "Couldn't read changes." (with Retry); "This folder is gone."; header on a branch "feature-x · branch (from main)"; menu group labels "Worktrees" and "Branches"; worktree row "<branch> · N changed"; branch row "N ahead · <SB.relTime>".
- On a branch "Just uncommitted" and "Open in editor" are hidden, including the notes' "Open in editor" buttons.
- Line endings are LF. Edit with the Edit tool, the Write tool or Node `fs`; never Python text mode.
- Temp dirs in tests: `fs.realpathSync.native(fs.mkdtempSync(...))`.
- Commits: `<type>: <description>` (feat, fix, perf, refactor, test, docs, chore, ci), ending with a `Co-Authored-By:` line naming the model that wrote the commit (for this session: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Never bump `version` or add a CHANGELOG heading. The note goes in `changes/file-viewer.md`.
- After editing anything in `src/renderer/panel/html/`, run `npm run panel:html` and commit the rebuilt `src/renderer/panel/panel.html`.
- `src/preload/preload.js` is at 799 of the 800 lines `test/file-size.test.js` allows: the two new names join the existing `viewerBranch: ...` line, no new line.
- Close every Electron and test process you start. Don't run the installed Shellby's windows; e2e runs use their own `SHELLBY_USER_DATA`.
- e2e counts come from the script's own data (`MADE`, `BRANCH`, `COPY_CHANGED`), never hardcoded numbers.

## Review Focus

Most likely to break first:

1. **A branch named like an option.** `git branch -x` is refused, but `git update-ref refs/heads/-x <sha>` makes one, and `for-each-ref` lists it. Short names would reach git as `-x`; every call here passes `refs/heads/-x`, which git reads as a revision. Pinned in Task 1 (`a ref is only ever a full refs/heads/ name`) and Task 2 (`a branch named like an option is listed and opens`).
2. **A folder or a revision path reaching `cat-file`.** `git cat-file -s <commit>:<folder>` exits 0 with the tree's size (probe below), so the check that a path is in the commit's own `ls-tree` list is what keeps Whole file to files of that commit. Pinned in Task 1 (`All files is the commit's tree; Whole file reads only a path in it`: `src`, `docs/`, `A.TXT`, `../proj/a.txt`, `HEAD:a.txt`, a backslash path, an untracked and an ignored file of the checkout).
3. **A conversation left in the home folder**, which is where Shellby starts one by default. The widened `staleFor` (a handle inside the changed folder) and the panel's live badge (a tab whose folder holds the place) would light up every viewer under `~` on every write. Both skip a folder too wide to browse. Pinned in Task 1 (`staleFor: a worktree inside the changed folder too...`), Task 3 (`fileIndex.forget(os.homedir())` sends nothing) and Task 4 (`tabAt` ignores a tab in home).
4. **A rename in a worktree's `git status -z`.** The probe shows `R  b.txt\0a.txt\0`: the old path is a field of its own, so counting NUL-separated fields counts a rename twice. Pinned in Task 2 (`countStatus`, and a staged rename in the `.claude/worktrees` worktree counting 1).
5. **A picked handle dropped by main** (the 8-handle cap, a closed tab, a panel reload). `call()` replays the first open request, so without care the header would read "feature-x · branch" over the conversation's own files. The panel re-opens the first place and makes the same pick from its new menu (`reopen`, matched by `V.findPlace`). Pinned in Task 4 (`findPlace`) and wired in Task 5.

Verified with throwaway probes in `%TEMP%` (git 2.53.0.windows.2, deleted after):
- `git ls-tree -r -z --name-only <commit>` gives files only, NUL-separated, spaces and `é` unquoted (`a.txt\0d/sp ace/é.md\0`).
- `git cat-file -s <commit>:nope.txt` exits 128 ("path 'nope.txt' does not exist"); `cat-file -s <commit>:d` (a folder) exits 0 and prints the tree's size.
- `for-each-ref --format=%(refname)%00%(committerdate:unix) refs/heads` puts a real NUL between the fields, one ref per line.
- `rev-list --count refs/heads/main..refs/heads/bin` counts the branch's own commits; for a branch with no shared history it counts all of them (1 for a one-commit orphan).
- `merge-base` exits 1 with no output for unrelated histories and 128 for a missing ref; both read as null here, and the branch is then compared with `EMPTY_TREE`.
- `git branch -x` and `git branch -- -x` are refused; `git update-ref refs/heads/-x HEAD` succeeds. `rev-parse --verify '-x^{commit}'` fails ("Needed a single revision"); `rev-parse --verify 'refs/heads/-x^{commit}'` and `rev-list --count refs/heads/main..refs/heads/-x` work. `--end-of-options` also works on 2.53, but the plan doesn't use it: full names are enough, and an older git would read the flag as an unknown option and report a live branch as gone.
- `rev-parse --verify --quiet` of a missing ref exits 1 with no output.
- With `GIT_OPTIONAL_LOCKS=0`, a run of `rev-parse`, `merge-base`, `diff`, `ls-tree`, `cat-file -s`, `cat-file blob`, `for-each-ref`, `rev-list --count` and `status --porcelain -z --untracked-files=all` left `.git/index`'s mtime unchanged and a `post-index-change` hook unfired.
- `git status --porcelain -z --untracked-files=all` after `git mv a.txt b.txt`: `R  b.txt\0a.txt\0?? new.txt\0?? u/v/w.txt\0`.

Accepted residuals: `git status` in each listed worktree runs clean filters (git-lfs), as the Project page's status reads already do. A submodule (gitlink) path in a branch's tree is listed under All files, but reading it answers "Couldn't read that.". A branch tree past 30,000 paths lists and reads only the first 30,000. A key from a list that a second menu open rebuilt after 10 s is refused with an error toast; opening the menu again gives fresh keys. `EMPTY_TREE` is the sha1 empty tree, as today. A folder handle's `merge-base <base> HEAD` (`computeFolder`, today's `compute`, unchanged) still passes the short base name: it comes from Shellby's own `tab.worktree.base` or `parseWorktrees`, and a main checkout on a branch named `-x` would make git fail there and the list fall back to HEAD, as the existing "a base that git cannot find" test shows.

Where the code says something the suggested breakdown didn't: places and switch stay in `src/main/viewer.js` (about 450 lines after both tasks, under the 800 cap), since they share `tooWide`, `sameDir`, `git` and the handle map with `open`; and the renderer is two tasks (pure logic with unit tests, then the screen with its e2e), as in the previous plan.

---

### Task 1: Branch handles in main

**Files:**
- Modify: `src/main/viewer.js` (requires and constants at lines 11-25, `git()` at 27-34, new helpers after `mainBranchFor` at 104-109, `createViewer` at 144-242 replaced, `module.exports` at 244)
- Test: create `test/viewer-branch.test.js`; add one test to `test/viewer.test.js`

**Interfaces:**
- Consumes: `changes.summarize`, `changes.patchFor`, `changes.TREE`, `changes.rootOf`, `changes.snapshot`; `fileIndex.list`, `fileIndex.withFolders`; `leaving.parseWorktrees`, `leaving.okDir`; this file's `tooWide`, `sameDir`, `isUnder`, `longPath`, `readInside`, `mainBranchFor`, `branchOf`.
- Produces:
  - `git(cwd, args, { buffer?: boolean, env?: object, maxBuffer?: number }) -> Promise<string | Buffer | null>` (module-private)
  - `tipOf(root, ref) -> Promise<sha | null>`, `treesOf(root) -> Promise<string[]>` (module-private)
  - constants `HEADS = 'refs/heads/'`, `HEAD_REF` (regex), `TREE_MAX = 30000`
  - `createViewer({ home }) -> { open, openBranch, get, changesOf, diffOf, read, treeOf, close, staleFor, keepTabs }`
  - `open({ dir, base?, tabId?, origin? }) -> Promise<{ ok: true, id, root, name, branch, base, git, kind: 'folder' } | { ok: false, gone?, error }>`; the handle stores `origin = { tabId, root, base } | null` and `tabId` only while its root is `origin.root`
  - `openBranch({ root, ref: 'refs/heads/...', base: string|null, origin? }) -> Promise<{ ok: true, id, root, name, branch, base, git: true, kind: 'branch' } | { ok: false, gone: true, error: 'That worktree or branch is gone.' } | { ok: false, error }>`
  - `changesOf(id)` on a branch handle -> `{ ok: true, files, more, against: base } | { ok: false, branchGone: true, error: 'This branch is gone.' } | { ok: false, gone: true, error } | { ok: false, error: "Couldn't read changes." }`; `uncommittedOnly` is ignored
  - `treeOf(id) -> Promise<{ ok: true, entries: string[] } | { ok: false, expired: true }>` (folder: `fileIndex.list(root)`; branch: `ls-tree` with folders added)
  - `read(id, rel)` on a branch handle -> `readInside`'s shapes (`{ ok: true, text, size }`, `{ ok: false, missing: true }`, `{ ok: false, tooBig: true, size }`, `{ ok: false, binary: true, size }`, `{ ok: false, error }`)
  - `staleFor(dir, { commits?: boolean }) -> string[]`
  - every handle has `{ id, kind, root, git, branch, base, tabId, origin, gen, shown, slots, pending, last, places }`; a branch handle also `{ ref, commit, trees, tree }`

- [ ] **Step 1: Install dependencies in the worktree (once)**

The worktree may have no `node_modules`.

Run (PowerShell): `if (-not (Test-Path node_modules/electron/dist/electron.exe)) { $env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'; npm ci; node node_modules/electron/install.js }`
Expected: `node_modules/electron/dist/electron.exe` exists.

- [ ] **Step 2: Write the failing tests**

Create `test/viewer-branch.test.js`:

```js
// The file viewer's branch handles (main's viewer.js) against real git repos: a branch
// nothing has checked out, read from git alone. Its own commits since it left main, each
// diff, its tree and its files, with nothing run or written while looking.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createViewer, MAX_BYTES } = require('../src/main/viewer');

const FEAT = 'refs/heads/feat';

function repo() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-branch-')));
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
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  let n = 0;
  // Commits made in a worktree that then goes, so nothing has the branch checked out.
  const commitIn = (wt, files) => {
    for (const [f, s] of Object.entries(files)) write(wt, f, s);
    g(wt, 'add', '-A');
    g(wt, 'commit', '-qm', 'work');
    g(dir, 'worktree', 'remove', '--force', wt);
  };
  const branch = (name, files, { orphan = false } = {}) => {
    const wt = path.join(base, `made-${n++}`);
    if (orphan) {
      g(dir, 'worktree', 'add', '-q', '--detach', wt);
      g(wt, 'checkout', '-q', '--orphan', name);
      g(wt, 'rm', '-rqf', '.');
    } else {
      g(dir, 'worktree', 'add', '-q', '-b', name, wt, 'main');
    }
    commitIn(wt, files);
  };
  const commitOn = (name, files) => {
    const wt = path.join(base, `made-${n++}`);
    g(dir, 'worktree', 'add', '-q', wt, name);
    commitIn(wt, files);
  };
  return { base, dir, g, write, branch, commitOn, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('a branch: its own commits since it left main, each diff, and nothing else', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'a.txt': 'one\nTWO\n', 'docs/new.md': '# new\n' });
    r.write(r.dir, 'src/keep.js', 'const k = 2;\n');           // main moves on after the branch left
    r.g(r.dir, 'commit', '-qam', 'main moves on');
    r.write(r.dir, 'a.txt', 'uncommitted in the checkout\n');  // and has work of its own on disk
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.equal(b.ok, true);
    assert.equal(b.kind, 'branch');
    assert.equal(b.branch, 'feat');
    assert.equal(b.base, 'main');
    assert.equal(b.name, 'proj');
    assert.equal(b.git, true);
    assert.equal(b.root.toLowerCase(), r.dir.toLowerCase());
    const c = await v.changesOf(b.id);
    assert.equal(c.ok, true);
    assert.equal(c.against, 'main');
    assert.deepEqual(Object.fromEntries(c.files.map(f => [f.path, f.status])), { 'a.txt': 'M', 'docs/new.md': 'A' });
    const only = await v.changesOf(b.id, { uncommittedOnly: true });
    assert.deepEqual(only.files.map(f => f.path).sort(), ['a.txt', 'docs/new.md'], 'Just uncommitted does not apply to a branch');
    const d = await v.diffOf(b.id, 'a.txt');
    assert.equal(d.ok, true);
    assert.match(d.patch, /^-two$/m);
    assert.match(d.patch, /^\+TWO$/m);
    assert.equal((await v.diffOf(b.id, 'src/keep.js')).ok, false, "main's own change is not the branch's");
    assert.equal((await v.diffOf(b.id, 'A.TXT')).ok, false, "a branch's paths are git's, case and all");
  } finally { r.done(); }
});

test("All files is the commit's tree; Whole file reads only a path in it", async () => {
  const r = repo();
  try {
    r.branch('feat', { 'docs/new.md': '\uFEFF# new\n' });
    r.write(r.dir, 'loose.txt', 'untracked in the checkout\n');
    r.write(r.dir, 'ignored/x.txt', 'ignored in the checkout\n');
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    const t = await v.treeOf(b.id);
    assert.equal(t.ok, true);
    assert.deepEqual(t.entries.slice().sort(), ['.gitignore', 'a.txt', 'docs/', 'docs/new.md', 'src/', 'src/keep.js']);
    assert.deepEqual(await v.read(b.id, 'docs/new.md'), { ok: true, text: '# new\n', size: 9 }, 'BOM stripped, size as stored');
    // cat-file -s answers for a folder too (a tree's size): only the tree's own file paths get that far.
    for (const rel of ['src', 'docs/', 'A.TXT', '../proj/a.txt', 'HEAD:a.txt', 'docs\\new.md', 'loose.txt', 'ignored/x.txt', '', 42]) {
      assert.deepEqual(await v.read(b.id, rel), { ok: false, missing: true }, String(rel));
    }
  } finally { r.done(); }
});

test('a blob over 2 MB and a binary one say so', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'big.log': Buffer.alloc(MAX_BYTES + 1, 0x61), 'img.png': Buffer.from([0x89, 0x50, 0x00, 0x47]) });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.deepEqual(await v.read(b.id, 'big.log'), { ok: false, tooBig: true, size: MAX_BYTES + 1 });
    assert.deepEqual(await v.read(b.id, 'img.png'), { ok: false, binary: true, size: 4 });
  } finally { r.done(); }
});

test('a branch with no history in common with main is compared with the empty tree', async () => {
  const r = repo();
  try {
    r.branch('lonely', { 'z.txt': 'z\n' }, { orphan: true });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: 'refs/heads/lonely', base: 'main' });
    const c = await v.changesOf(b.id);
    assert.deepEqual(c.files.map(f => `${f.path}:${f.status}`), ['z.txt:A']);
    assert.match((await v.diffOf(b.id, 'z.txt')).patch, /^\+z$/m);
  } finally { r.done(); }
});

test('new commits show once a turn ends, and a deleted branch answers branchGone', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'one.txt': '1\n' });
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['one.txt']);
    r.commitOn('feat', { 'two.txt': '2\n' });
    assert.deepEqual(v.staleFor(r.dir), [], "a tool's result never nudges a branch");
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['one.txt'], 'within 2 s the last look answers');
    assert.deepEqual(v.staleFor(r.base, { commits: true }), [], 'a folder above the repo is none of its worktrees');
    assert.deepEqual(v.staleFor(path.join(r.dir, 'src'), { commits: true }), [b.id], 'a turn end in the repo does');
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path).sort(), ['one.txt', 'two.txt']);
    assert.ok((await v.treeOf(b.id)).entries.includes('two.txt'), 'and its tree is read at the new tip');
    assert.equal((await v.read(b.id, 'two.txt')).text, '2\n');
    r.g(r.dir, 'branch', '-D', 'feat');
    v.staleFor(r.dir, { commits: true });
    assert.deepEqual(await v.changesOf(b.id), { ok: false, branchGone: true, error: 'This branch is gone.' });
  } finally { r.done(); }
});

test('looking at a branch runs none of its hooks and writes no index', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'a.txt': 'one\nTWO\n' });
    // Pinned here, so a core.hooksPath in the machine's own config can't make this pass by itself
    // (changes.test.js shows the same hook does run for a turn's snapshot).
    r.g(r.dir, 'config', 'core.hooksPath', '.git/hooks');
    const marker = path.join(r.base, 'HOOK_RAN').split(path.sep).join('/');
    fs.writeFileSync(path.join(r.dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    const index = path.join(r.dir, '.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: FEAT, base: 'main' });
    assert.equal((await v.changesOf(b.id)).ok, true);
    assert.equal((await v.diffOf(b.id, 'a.txt')).ok, true);
    assert.equal((await v.treeOf(b.id)).ok, true);
    assert.equal((await v.read(b.id, 'a.txt')).ok, true);
    assert.equal(fs.existsSync(marker), false, 'post-index-change never ran');
    assert.equal(fs.statSync(index).mtimeMs, before, '.git/index was not written');
  } finally { r.done(); }
});

test('a ref is only ever a full refs/heads/ name: a branch called -x opens, a short or odd name is refused', async () => {
  const r = repo();
  try {
    r.branch('feat', { 'x.txt': 'x\n' });
    // git branch refuses "-x"; update-ref makes it anyway, as a hand edit or another tool could.
    r.g(r.dir, 'update-ref', 'refs/heads/-x', r.g(r.dir, 'rev-parse', FEAT).trim());
    const v = createViewer();
    const b = await v.openBranch({ root: r.dir, ref: 'refs/heads/-x', base: 'main' });
    assert.equal(b.ok, true);
    assert.equal(b.branch, '-x');
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['x.txt']);
    for (const ref of ['-x', 'feat', 'refs/tags/v1', 'refs/heads/feat\nx', 'HEAD', null]) {
      assert.equal((await v.openBranch({ root: r.dir, ref, base: 'main' })).ok, false, String(ref));
    }
    assert.deepEqual(await v.openBranch({ root: r.dir, ref: 'refs/heads/nope', base: 'main' }), { ok: false, gone: true, error: 'That worktree or branch is gone.' });
  } finally { r.done(); }
});
```

In `test/viewer.test.js`, directly after the `staleFor finds the handles a changed folder belongs to` test (ends at line 184), add:

```js
test('staleFor: a worktree inside the changed folder too, but never everything under a folder too wide', async () => {
  const r = repo();
  try {
    const agent = path.join(r.dir, '.claude', 'worktrees', 'agent-1');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'agent-1', agent);
    const v = createViewer({ home: r.base });
    const a = await v.open({ dir: agent });
    assert.deepEqual(v.staleFor(r.dir), [a.id], "a write in the conversation's folder nudges the agent's worktree under it");
    assert.deepEqual(v.staleFor(r.base), [], 'the home folder (r.base here) is too wide to nudge all it holds');
  } finally { r.done(); }
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `node --test test/viewer-branch.test.js test/viewer.test.js`
Expected: FAIL. viewer-branch.test.js with `TypeError: v.openBranch is not a function`; the new viewer.test.js test with `[]` where `[a.id]` was expected.

- [ ] **Step 4: Requires, constants and the git helper**

In `src/main/viewer.js`, replace the comment block at lines 1-10 with:

```js
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
```

Replace lines 16-18:

```js
const changes = require('./changes');
const { parseTarget } = require('./filelinks');
const { parseWorktrees, okDir } = require('./leaving');
```

with:

```js
const changes = require('./changes');
const fileIndex = require('./fileindex');
const { parseTarget } = require('./filelinks');
const { parseWorktrees, okDir } = require('./leaving');

const { TREE } = changes;
const HEADS = 'refs/heads/';
const HEAD_REF = /^refs\/heads\/[^\0\n\r]+$/; // a local branch by its full name, which git never reads as an option
```

After the line `const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // what a repo with no commits is compared with` add:

```js
const TREE_MAX = 30000;              // All files on a branch, at most (fileindex.js lists a folder to the same)
```

Replace the `git` function (lines 27-34):

```js
function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out) => resolve(err ? null : String(out)));
  });
}
```

with:

```js
// buffer: the output as bytes (a blob, sniffed for NUL before it's decoded). env: added to git's own.
function git(cwd, args, { buffer = false, env = null, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: buffer ? 'buffer' : 'utf8',
      env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out) => resolve(err ? null : buffer ? out : String(out)));
  });
}
```

- [ ] **Step 5: Two git helpers for branches**

After the `mainBranchFor` function (ends at the line `return main && !sameDir(main.path, root) ? main.branch || null : null;` and its closing `}`), add:

```js

// A branch's tip commit, or null (gone, or git couldn't say). The ref is always a full refs/heads/
// name, which never starts with '-': a branch called "-x" can't reach git as an option.
async function tipOf(root, ref) {
  const out = (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim();
  return out && TREE.test(out) ? out : null;
}

// The repo's worktree folders, local ones only, resolved: where a branch's next commit is made.
async function treesOf(root) {
  const listed = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain']))
    .filter(w => okDir(w.path)).map(w => longPath(w.path)).filter(Boolean);
  return listed.length ? listed : [root];
}
```

- [ ] **Step 6: Replace `createViewer`**

Replace the whole of `createViewer`, from the line `/** opts.home: the home folder, never browsed (tests give their own). */` down to and including the `return { open, get: id => handles.get(id) || null, changesOf, diffOf, read, close: id => { handles.delete(id); }, staleFor, keepTabs };` line and the closing `}` after it, with:

```js
/** opts.home: the home folder, never browsed (tests give their own). */
function createViewer({ home = os.homedir() } = {}) {
  // id -> { id, kind, root, git, branch, base, tabId, origin, gen, shown, slots, pending, last, places }.
  // kind 'folder' reads its folder; kind 'branch' reads git alone and adds { ref, commit, trees, tree }.
  // slots, pending and last are each by mode ('base' | 'head'; a branch has only 'base'):
  // slots[mode] = { files: Map(path key -> file), ref } (what a diff is cut from), pending[mode] = a
  // look running, last[mode] = { at, result }; shown = the mode of the list the panel was last handed;
  // gen counts nudges. origin = { tabId, root, base }: the conversation the first handle was opened
  // from, carried through the header menu's picks; places = that menu's list (placesOf).
  const handles = new Map();
  let line = Promise.resolve(); // viewer snapshots take turns: eight handles never hash a big repo at once

  function add(fields) {
    const id = crypto.randomBytes(8).toString('hex');
    if (handles.size >= MAX_HANDLES) handles.delete(handles.keys().next().value);
    const h = { id, gen: 0, shown: null, slots: {}, pending: {}, last: {}, places: null, ...fields };
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
    const h = add({ kind: 'branch', root: top, git: true, ref, commit, branch, base: against, tabId: null, origin, trees: await treesOf(top), tree: null });
    return { ok: true, id: h.id, root: top, name: path.basename(top), branch, base: against, git: true, kind: 'branch' };
  }

  async function computeFolder(h, key) {
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
    h.trees = await treesOf(h.root);
    const fork = h.base ? (await git(h.root, ['merge-base', `${HEADS}${h.base}`, commit]))?.trim() : null;
    const before = fork && TREE.test(fork) ? fork : EMPTY_TREE;
    const sum = await changes.summarize({ root: h.root, tree: before }, { root: h.root, tree: commit });
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
    const r = await changes.patchFor({ ...slot.ref, file: f.path });
    return r.error ? { ok: false, error: r.error } : { ok: true, patch: r.patch, truncated: r.truncated, binary: f.binary };
  }

  // The paths in a branch's tree at its last-read tip, listed once per tip. -> { commit, list, set } | null
  async function pathsAt(h) {
    if (h.tree?.commit === h.commit) return h.tree;
    const commit = h.commit;
    const out = await git(h.root, ['ls-tree', '-r', '-z', '--name-only', commit], { maxBuffer: 32 * 1024 * 1024 });
    if (out === null) return null;
    const list = String(out).split('\0').filter(Boolean).slice(0, TREE_MAX);
    h.tree = { commit, list, set: new Set(list) };
    return h.tree;
  }

  // A file of a branch, from its commit. Only a path its own tree lists (git's spelling, case and all):
  // cat-file would answer for a folder or another revision too. Size first, so a huge blob is never read.
  async function readBlob(h, rel) {
    const t = typeof rel === 'string' && rel ? await pathsAt(h) : null;
    if (!t?.set.has(rel)) return { ...NOT_HERE };
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
    const t = await pathsAt(h);
    return { ok: true, entries: t ? fileIndex.withFolders(t.list) : [] };
  }

  // The handles a changed folder belongs to. Their last look no longer answers a repeat, and a look
  // still running no longer answers one either (it may have hashed the folder before the write):
  // the 2 s reuse only absorbs asking twice, never a real change.
  //   A folder handle on dir, on a folder dir is in, or on one inside dir (an agent's worktree under
  //   the conversation's folder), except inside a folder too wide to browse: a conversation left in ~
  //   would otherwise nudge every viewer on every write.
  //   A branch handle only with { commits: true } (turn ends, step undo, ! commands: where commits
  //   land), when dir is in one of its repo's worktrees; never for each tool's result.
  function staleFor(dir, { commits = false } = {}) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return [];
    const at = longPath(dir) || path.resolve(dir);
    const wide = !!tooWide(at, home);
    const within = root => path.relative(root, at) === '' || isUnder(root, at);
    const hit = [...handles.values()].filter(h => (h.kind === 'branch'
      ? commits && h.trees.some(within)
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
```

`computeFolder` is the old `compute`, unchanged apart from its name. `changes.patchFor` already accepts a commit id for `before` and `after` (`checkRef` tests both against `TREE`, which a 40-hex commit id passes), and `git diff <tree> <commit>` compares a tree with a commit as readily as two trees.

- [ ] **Step 7: Export the new constants**

Replace the `module.exports` line:

```js
module.exports = { readInside, sameDir, isUnder, longPath, tooWide, createViewer, locate, branchOf, writeWatch, MAX_BYTES, SNIFF_BYTES, MAX_HANDLES, REFRESH_MS, EMPTY_TREE };
```

with:

```js
module.exports = { readInside, sameDir, isUnder, longPath, tooWide, createViewer, locate, branchOf, writeWatch, MAX_BYTES, SNIFF_BYTES, MAX_HANDLES, REFRESH_MS, EMPTY_TREE, TREE_MAX, HEAD_REF };
```

- [ ] **Step 8: Run the tests to make sure they pass**

Run: `node --test test/viewer-branch.test.js test/viewer.test.js test/viewer-read.test.js test/ipc-viewer.test.js`
Expected: PASS (7 in viewer-branch.test.js, 19 in viewer.test.js, 7 in viewer-read.test.js, 9 in ipc-viewer.test.js). The ipc tests still pass because `ipc/viewer.js` calls `fileIndex.list` itself until Task 3 moves it, and `staleFor(dir)` without options matches what it did for folder handles.

- [ ] **Step 9: Commit**

```bash
git add src/main/viewer.js test/viewer-branch.test.js test/viewer.test.js
git commit -m "feat: file viewer branch handles read a branch's changes, diffs, tree and files from git alone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The header menu's list, and picking from it

**Files:**
- Modify: `src/main/viewer.js` (constants after `TREE_MAX`, two pure helpers after `treesOf`, three functions inside `createViewer` before `staleFor`, the `return` of `createViewer`, `module.exports`)
- Test: create `test/viewer-places.test.js`

**Interfaces:**
- Consumes: Task 1's `createViewer` internals (`handles`, `open`, `openBranch`, `tipOf` through `openBranch`, `HEADS`, `HEAD_REF`, `git`); `changes.mapLimit`, `changes.sameRepo`; `leaving.parseWorktrees`, `leaving.okDir`; `tooWide`, `sameDir`.
- Produces:
  - `countStatus(out: string) -> number` (pure; files `git status --porcelain -z` names, a rename or copy once)
  - `checkoutBranch(worktreeListOut: string) -> string | null` (pure; the main checkout's branch, null when bare or detached)
  - constants `MAX_PLACE_TREES = 20`, `MAX_PLACE_BRANCHES = 30`, `PLACES_MS = 10000`, `AT_ONCE = 4`
  - `placesOf(id) -> Promise<{ ok: true, places: [{ key, kind: 'worktree'|'branch', label, branch, changed?, ahead?, when?, current }] } | { ok: false, expired: true } | { ok: false, error: "Couldn't list worktrees." }>`. `when` is ms since 1970. Never a path or a ref.
  - `switchTo(id, key) -> Promise<open() result | openBranch() result | { ok: false, expired: true } | { ok: false, error } | { ok: false, gone: true, error: 'That worktree or branch is gone.' }>`
  - handle field `places = { at, base, list: [{ ...the entry above, path? (worktree), ref? (branch) }] }`

- [ ] **Step 1: Write the failing tests**

Create `test/viewer-places.test.js`:

```js
// The file viewer's header menu (main's viewer.js placesOf/switchTo) against real git repos:
// every local worktree of the repo with what it changed, every local branch with commits main
// lacks, each under a key main issued, and a pick checked again before it opens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createViewer, countStatus, checkoutBranch, MAX_PLACE_TREES, MAX_PLACE_BRANCHES, PLACES_MS } = require('../src/main/viewer');

function repo() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-places-')));
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  const write = (at, f, s) => { fs.mkdirSync(path.dirname(path.join(at, f)), { recursive: true }); fs.writeFileSync(path.join(at, f), s); };
  write(dir, 'a.txt', 'one\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  // As a repo's .gitignore would: agents' worktrees aren't the checkout's own untracked files.
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.claude/worktrees/\n');
  let n = 0;
  // A branch nothing checks out, `commits` commits ahead of main, committed at `date`.
  const branch = (name, { commits = 1, date = '2026-01-01T00:00:00Z' } = {}) => {
    const wt = path.join(base, `made-${n++}`);
    g(dir, 'worktree', 'add', '-q', '-b', name, wt, 'main');
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    for (let i = 0; i < commits; i++) {
      write(wt, `${name.replace(/\W/g, '_')}-${i}.txt`, `${i}\n`);
      execFileSync('git', ['-C', wt, 'add', '-A'], { windowsHide: true });
      execFileSync('git', ['-C', wt, 'commit', '-qm', `${name} ${i}`], { windowsHide: true, env });
    }
    g(dir, 'worktree', 'remove', '--force', wt);
  };
  return { base, dir, g, write, branch, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('worktrees: the checkout, a hand-made one and one under .claude/worktrees, with their changed files', async () => {
  const r = repo();
  try {
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    r.write(hand, 'a.txt', 'changed\n');          // modified
    r.write(hand, 'new/deep/x.txt', 'x\n');       // untracked, two folders down: one file
    const agent = path.join(r.dir, '.claude', 'worktrees', 'agent-1');
    r.g(r.dir, 'worktree', 'add', '-q', '--detach', agent);
    r.g(agent, 'mv', 'a.txt', 'b.txt');           // a rename: one file, in two fields of git status -z
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    assert.equal(p.ok, true);
    const rows = Object.fromEntries(p.places.filter(x => x.kind === 'worktree').map(x => [x.label, `${x.branch}|${x.changed}|${x.current}`]));
    assert.deepEqual(rows, { proj: 'main|0|true', hand: 'hand|2|false', 'agent-1': 'detached|1|false' });
    assert.ok(p.places.every(x => /^[0-9a-f]{16}$/.test(x.key) && !('path' in x) && !('ref' in x)), 'keys only: no path or ref reaches the panel');
  } finally { r.done(); }
});

test('branches: only those with commits main lacks, newest first, none a worktree has out', async () => {
  const r = repo();
  try {
    r.branch('old', { date: '2026-01-01T00:00:00Z' });
    r.branch('new', { commits: 2, date: '2026-02-01T00:00:00Z' });
    r.g(r.dir, 'branch', 'merged');                       // nothing main lacks
    r.branch('busy', { date: '2026-03-01T00:00:00Z' });
    r.g(r.dir, 'worktree', 'add', '-q', path.join(r.base, 'busy-wt'), 'busy'); // checked out: it shows under Worktrees
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    const branches = p.places.filter(x => x.kind === 'branch');
    assert.deepEqual(branches.map(x => `${x.label}:${x.ahead}`), ['new:2', 'old:1']);
    assert.equal(branches[0].branch, 'new');
    assert.equal(branches[0].when, Date.parse('2026-02-01T00:00:00Z'));
    assert.ok(p.places.some(x => x.kind === 'worktree' && x.branch === 'busy'), 'busy is listed once, as a worktree');
    assert.ok(branches.every(x => !x.current));
  } finally { r.done(); }
});

test('a branch named like an option is listed and opens: git only ever sees refs/heads/-x', async () => {
  const r = repo();
  try {
    r.branch('old');
    r.g(r.dir, 'update-ref', 'refs/heads/-x', r.g(r.dir, 'rev-parse', 'refs/heads/old').trim());
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const x = (await v.placesOf(h.id)).places.find(e => e.label === '-x');
    assert.equal(x?.ahead, 1);
    const b = await v.switchTo(h.id, x.key);
    assert.equal(b.ok, true);
    assert.equal(b.kind, 'branch');
    assert.equal(b.branch, '-x');
    assert.equal(b.base, 'main');
    assert.deepEqual((await v.changesOf(b.id)).files.map(f => f.path), ['old-0.txt']);
  } finally { r.done(); }
});

test(`caps: ${MAX_PLACE_TREES} worktrees, and the newest ${MAX_PLACE_BRANCHES} branches checked`, async () => {
  const r = repo();
  try {
    for (let i = 0; i < MAX_PLACE_TREES; i++) r.g(r.dir, 'worktree', 'add', '-q', '--detach', path.join(r.base, `wt-${i}`));
    r.branch('tip');
    const tip = r.g(r.dir, 'rev-parse', 'refs/heads/tip').trim();
    for (let i = 0; i < MAX_PLACE_BRANCHES + 2; i++) r.g(r.dir, 'update-ref', `refs/heads/b-${i}`, tip);
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    assert.equal(p.places.filter(x => x.kind === 'worktree').length, MAX_PLACE_TREES, `${MAX_PLACE_TREES + 1} worktrees exist`);
    assert.equal(p.places.filter(x => x.kind === 'branch').length, MAX_PLACE_BRANCHES, `${MAX_PLACE_BRANCHES + 3} branches have work of their own`);
  } finally { r.done(); }
});

test('the list is built when asked, then reused for 10 s', async () => {
  const r = repo();
  try {
    assert.equal(PLACES_MS, 10000);
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const first = await v.placesOf(h.id);
    r.branch('late');
    const again = await v.placesOf(h.id);
    assert.deepEqual(again.places.map(x => x.key), first.places.map(x => x.key));
    assert.equal(again.places.some(x => x.label === 'late'), false, 'built under 10 s ago: reused');
    assert.deepEqual(await v.placesOf('nope'), { ok: false, expired: true });
  } finally { r.done(); }
});

test("a pick: a made-up key, another handle's and a stale one are refused; a live one opens", async () => {
  const r = repo();
  try {
    r.branch('old');
    r.branch('new');
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const other = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    const key = label => p.places.find(x => x.label === label).key;
    const made = await v.switchTo(h.id, 'f00df00df00df00d');
    assert.equal(made.ok, false);
    assert.equal(made.gone, undefined, 'not stale: never one of ours');
    assert.equal(typeof made.error, 'string');
    assert.equal((await v.switchTo(other.id, key('new'))).ok, false, "another handle's key");
    assert.equal((await v.switchTo(h.id, 42)).ok, false);
    const GONE = { ok: false, gone: true, error: 'That worktree or branch is gone.' };
    r.g(r.dir, 'worktree', 'remove', '--force', hand);
    assert.deepEqual(await v.switchTo(h.id, key('hand')), GONE, 'a worktree removed since the list was made');
    r.g(r.dir, 'branch', '-D', 'old');
    assert.deepEqual(await v.switchTo(h.id, key('old')), GONE, 'a branch deleted since');
    const b = await v.switchTo(h.id, key('new'));
    assert.equal(b.ok, true);
    assert.equal(b.branch, 'new');
    assert.ok((await v.placesOf(b.id)).places.find(x => x.label === 'new').current, 'the branch being viewed is the checked one');
  } finally { r.done(); }
});

test('a worktree at or above the home folder is never listed, nor opened from a stored entry', async () => {
  const r = repo();
  try {
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    const v = createViewer({ home: hand });
    const h = await v.open({ dir: r.dir });
    const p = await v.placesOf(h.id);
    assert.equal(p.places.some(x => x.label === 'hand'), false);
    // A stored entry whose folder is too wide (edited here to stand in for one) is checked again on a pick:
    // hand is still listed by git and shares the repo, so only the home rule refuses it.
    const entry = v.get(h.id).places.list.find(x => x.label === 'proj');
    entry.path = hand;
    assert.equal((await v.switchTo(h.id, entry.key)).ok, false);
  } finally { r.done(); }
});

test("a pick back to the conversation's own folder belongs to its tab again, with its base", async () => {
  const r = repo();
  try {
    r.branch('new');
    const hand = path.join(r.base, 'hand');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'hand', hand);
    const v = createViewer();
    const h = await v.open({ dir: hand, tabId: 't', base: 'main' });
    const b = await v.switchTo(h.id, (await v.placesOf(h.id)).places.find(x => x.label === 'new').key);
    assert.equal(v.get(b.id).tabId, null, 'a branch belongs to no tab');
    const q = await v.placesOf(b.id);
    const checkout = await v.switchTo(b.id, q.places.find(x => x.label === 'proj').key);
    assert.equal(v.get(checkout.id).tabId, null, "the main checkout isn't the conversation's folder");
    const back = await v.switchTo(b.id, q.places.find(x => x.label === 'hand').key);
    assert.equal(v.get(back.id).tabId, 't');
    assert.equal(back.base, 'main');
    v.keepTabs(new Set());
    assert.equal(v.get(back.id), null, 'closing the conversation takes it');
    assert.ok(v.get(b.id), 'the branch stays');
  } finally { r.done(); }
});

test('countStatus: one per file, a rename or copy counted once', () => {
  assert.equal(countStatus(''), 0);
  assert.equal(countStatus(null), 0);
  assert.equal(countStatus(' M a.txt\0?? new/deep/x.txt\0'), 2);
  assert.equal(countStatus('R  b.txt\0a.txt\0?? n.txt\0'), 2);
  assert.equal(countStatus('C  c.txt\0a.txt\0'), 1);
  assert.equal(countStatus('?? a\0'), 1, 'a one-letter name');
});

test("checkoutBranch: the main checkout's branch, or none when it is bare or detached", () => {
  assert.equal(checkoutBranch('worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/w\nHEAD abc\nbranch refs/heads/x\n'), 'main');
  assert.equal(checkoutBranch('worktree C:/r\r\nHEAD abc\r\nbranch refs/heads/-x\r\n'), '-x');
  assert.equal(checkoutBranch('worktree C:/r\nbare\n\nworktree C:/w\nHEAD abc\nbranch refs/heads/x\n'), null);
  assert.equal(checkoutBranch('worktree C:/r\nHEAD abc\ndetached\n'), null);
  assert.equal(checkoutBranch(null), null);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/viewer-places.test.js`
Expected: FAIL with `TypeError: v.placesOf is not a function` and `TypeError: countStatus is not a function`.

- [ ] **Step 3: Constants and two pure helpers**

In `src/main/viewer.js`, after the line `const TREE_MAX = 30000;              // All files on a branch, at most (fileindex.js lists a folder to the same)` add:

```js
const MAX_PLACE_TREES = 20;          // worktrees in the header's menu
const MAX_PLACE_BRANCHES = 30;       // branches checked for commits of their own, newest first
const PLACES_MS = 10000;             // the menu's list is reused this long
const AT_ONCE = 4;                   // git status (or rev-list) runs at a time
```

After the `treesOf` function from Task 1, add:

```js

/** `git status --porcelain -z` -> how many files it names. A rename or copy carries its old path as one more field. */
function countStatus(out) {
  const recs = String(out || '').split('\0');
  let n = 0;
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].length < 4) continue; // "XY " and at least one letter of a name
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
```

- [ ] **Step 4: The list and the pick**

Inside `createViewer`, directly before the comment line `  // The handles a changed folder belongs to. Their last look no longer answers a repeat, and a look`, add:

```js
  // ---- the header's menu (panel/viewer.js): the repo's worktrees, and its branches still in flight.
  // The list stays on the handle with a random key per entry; a pick names a key, never a path or a ref.

  async function buildPlaces(h) {
    const out = await git(h.root, ['worktree', 'list', '--porcelain']);
    if (out === null) return null;
    const newKey = () => crypto.randomBytes(8).toString('hex');
    // Local folders only, never the home folder or above: open() would refuse them anyway.
    const trees = parseWorktrees(out).filter(w => okDir(w.path) && !tooWide(w.path, home)).slice(0, MAX_PLACE_TREES);
    // A count that timed out (8 s) is left off rather than guessed.
    const changed = await changes.mapLimit(trees, AT_ONCE, async w => {
      const st = await git(w.path, ['status', '--porcelain', '-z', '--untracked-files=all']);
      return st === null ? null : countStatus(st);
    });
    const list = trees.map((w, i) => ({
      key: newKey(), kind: 'worktree', label: path.basename(w.path), branch: w.branch || 'detached',
      ...(changed[i] === null ? {} : { changed: changed[i] }), current: h.kind === 'folder' && sameDir(w.path, h.root), path: w.path,
    }));
    // Branches with commits the main checkout's branch lacks. One out in a listed worktree shows
    // there instead. Full refs/heads/ names throughout, so none reaches git as an option.
    const base = checkoutBranch(out);
    if (base) {
      const taken = new Set(trees.filter(w => w.branch).map(w => `${HEADS}${w.branch}`));
      const refs = await git(h.root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(committerdate:unix)', 'refs/heads']);
      const newest = String(refs || '').split('\n').map(l => l.replace(/\r$/, '').split('\0'))
        .filter(([ref]) => HEAD_REF.test(ref || '') && !taken.has(ref)).slice(0, MAX_PLACE_BRANCHES);
      const ahead = await changes.mapLimit(newest, AT_ONCE, async ([ref]) =>
        Number((await git(h.root, ['rev-list', '--count', `${HEADS}${base}..${ref}`]))?.trim()) || 0);
      newest.forEach(([ref, at], i) => {
        if (ahead[i] <= 0) return;
        const name = ref.slice(HEADS.length);
        list.push({ key: newKey(), kind: 'branch', label: name, branch: name, ahead: ahead[i], when: Number(at) * 1000 || 0, current: h.kind === 'branch' && h.ref === ref, ref });
      });
    }
    return { at: Date.now(), base, list };
  }

  /** The menu's list for a handle's repo, built when asked and reused for 10 s. */
  async function placesOf(id) {
    const h = handles.get(id);
    if (!h) return { ok: false, expired: true };
    if (!h.git) return { ok: false, error: "Couldn't list worktrees." };
    if (!h.places || Date.now() - h.places.at >= PLACES_MS) {
      const built = await buildPlaces(h);
      if (!built) return { ok: false, error: "Couldn't list worktrees." };
      h.places = built;
    }
    return { ok: true, places: h.places.list.map(({ path: _path, ref: _ref, ...shown }) => shown) };
  }

  const GONE = { ok: false, gone: true, error: 'That worktree or branch is gone.' };

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
    if (e.kind === 'worktree') {
      if (!okDir(e.path) || tooWide(e.path, home)) return { ...GONE };
      const listed = parseWorktrees(await git(h.root, ['worktree', 'list', '--porcelain']));
      if (!listed.some(w => okDir(w.path) && sameDir(w.path, e.path))) return { ...GONE };
      if (!(await changes.sameRepo(h.root, e.path))) return { ...GONE };
      const r = await open({ dir: e.path, origin: h.origin });
      return r.ok || !r.gone ? r : { ...GONE };
    }
    const r = await openBranch({ root: h.root, ref: e.ref, base: h.places.base, origin: h.origin });
    return r.ok || !r.gone ? r : { ...GONE };
  }

```

Replace the `return` at the end of `createViewer`:

```js
  return {
    open, openBranch, get: id => handles.get(id) || null, changesOf, diffOf, read, treeOf,
    close: id => { handles.delete(id); }, staleFor, keepTabs,
  };
```

with:

```js
  return {
    open, openBranch, get: id => handles.get(id) || null, changesOf, diffOf, read, treeOf,
    placesOf, switchTo, close: id => { handles.delete(id); }, staleFor, keepTabs,
  };
```

Replace the `module.exports` line from Task 1 with:

```js
module.exports = {
  readInside, sameDir, isUnder, longPath, tooWide, createViewer, locate, branchOf, writeWatch, countStatus, checkoutBranch,
  MAX_BYTES, SNIFF_BYTES, MAX_HANDLES, REFRESH_MS, EMPTY_TREE, TREE_MAX, HEAD_REF, MAX_PLACE_TREES, MAX_PLACE_BRANCHES, PLACES_MS,
};
```

A branch picked from a folder handle keeps that handle's root (a worktree or the main checkout of the same repo); every git call there reads the same refs and objects. The 30-branch cap counts branches after those already out in a listed worktree are dropped, so it caps the `rev-list` calls.

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `node --test test/viewer-places.test.js test/viewer-branch.test.js test/viewer.test.js`
Expected: PASS (10 in viewer-places.test.js, 7, 19). The caps test makes 21 worktrees and may take several seconds.

- [ ] **Step 6: Lint the file**

Run: `npx eslint src/main/viewer.js test/viewer-places.test.js test/viewer-branch.test.js`
Expected: no problems (the `_path`/`_ref` rest siblings match `varsIgnorePattern: '^_'`). Then `(Get-Content src/main/viewer.js | Measure-Object -Line).Lines` reports well under 800.

- [ ] **Step 7: Commit**

```bash
git add src/main/viewer.js test/viewer-places.test.js
git commit -m "feat: the file viewer lists a repo's worktrees and unmerged branches under keys, and opens a pick

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The channels, the preload bridge, and branch-aware nudges

**Files:**
- Modify: `src/main/ipc/viewer.js:48-51` (`viewer:tree`), after line 63 (`viewer:close`), lines 64-70 (the nudge)
- Modify: `src/preload/preload.js:70` (the `viewerBranch: ...` line)
- Modify: `docs/THREAT-MODEL.md:65` (the `Renderer → main file read` row)
- Modify: `docs/DEVELOPMENT.md:407` (the `viewer.js` code-map line)
- Test: add to `test/ipc-viewer.test.js`

**Interfaces:**
- Consumes: Task 1's `treeOf`, `staleFor(dir, { commits })`; Task 2's `placesOf`, `switchTo`; `fileIndex.onForget`; `writeWatch`.
- Produces (channels, `ipcRenderer.invoke`, panel only through `ipc-guard.js`):
  - `viewer:places(id)` -> Task 2's `placesOf` answer
  - `viewer:switch(id, key)` -> Task 2's `switchTo` answer
  - `viewer:tree(id)` -> Task 1's `treeOf` answer
- Preload names: `viewerPlaces`, `viewerSwitch`.
- `d.viewerNudge(dir, { commits? })`: `fileIndex.onForget` passes `{ commits: true }` (turn ends in `wiring/sessions.js` `noteTurnChanges`, `!` commands and rewinds in `parity.js`, step undo in `wiring/step-undo.js`); `d.viewerWrites` (each tool result) passes none.

- [ ] **Step 1: Write the failing tests**

In `test/ipc-viewer.test.js`, after the `setup` function (ends at line 50), add:

```js

// A branch with one commit main lacks and nothing checking it out.
function sideBranch(s) {
  const wt = path.join(s.base, 'side-wt');
  s.g(s.repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  fs.writeFileSync(path.join(wt, 's.txt'), 's\n');
  s.g(wt, 'add', '-A');
  s.g(wt, 'commit', '-qm', 'side');
  s.g(s.repo, 'worktree', 'remove', '--force', wt);
}
```

At the end of the file, add:

```js

test('the header menu: places, and a pick only by a key main issued for that handle', async () => {
  const s = setup();
  try {
    sideBranch(s);
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    const r = await s.ipc.invoke('viewer:places', h.id);
    assert.equal(r.ok, true);
    assert.deepEqual(r.places.filter(p => p.kind === 'branch').map(p => p.label), ['side']);
    assert.ok(r.places.every(p => !('path' in p) && !('ref' in p)), 'a key, never a path or a ref');
    const side = r.places.find(p => p.label === 'side');
    const b = await s.ipc.invoke('viewer:switch', h.id, side.key);
    assert.equal(b.kind, 'branch');
    assert.equal(b.branch, 'side');
    assert.ok((await s.ipc.invoke('viewer:tree', b.id)).entries.includes('s.txt'), "All files is the branch's tree");
    assert.equal((await s.ipc.invoke('viewer:read', b.id, 's.txt')).text, 's\n');
    assert.equal((await s.ipc.invoke('viewer:switch', b.id, side.key)).ok, false, "another handle's key");
    assert.equal((await s.ipc.invoke('viewer:switch', h.id, 'f00d')).ok, false, 'a made-up key');
    await assert.rejects(() => s.ipc.invokeAs(s.ipc.senders.critter, 'viewer:places', h.id));
    await assert.rejects(() => s.ipc.invokeAs(s.ipc.senders.critter, 'viewer:switch', h.id, side.key));
    assert.ok(s.ipc.refused.includes('viewer:places') && s.ipc.refused.includes('viewer:switch'));
  } finally { s.done(); }
});

test('a branch is nudged when a turn ends, never by each tool result; a worktree inside the folder by both', async () => {
  const s = setup();
  try {
    sideBranch(s);
    const agent = path.join(s.wt, '.claude', 'worktrees', 'agent-1');
    s.g(s.wt, 'worktree', 'add', '-q', '-b', 'agent-1', agent);
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    const r = await s.ipc.invoke('viewer:places', h.id);
    const b = await s.ipc.invoke('viewer:switch', h.id, r.places.find(p => p.label === 'side').key);
    const a = await s.ipc.invoke('viewer:switch', h.id, r.places.find(p => p.label === 'agent-1').key);
    const ids = () => s.sent.at(-1).payload.ids.slice().sort();
    s.d.viewerWrites({ kind: 'tool', id: 'w1', name: 'Write' }, s.wt);
    s.d.viewerWrites({ kind: 'tool_result', id: 'w1' }, s.wt);
    assert.deepEqual(ids(), [h.id, a.id].sort(), "a tool's result: the folder, and the agent's worktree inside it");
    fileIndex.forget(s.wt);
    assert.deepEqual(ids(), [h.id, a.id, b.id].sort(), 'a turn end: the branch as well');
    const before = s.sent.length;
    fileIndex.forget(os.homedir());
    assert.equal(s.sent.length, before, 'a conversation in the home folder nudges none of them');
  } finally { s.done(); }
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/ipc-viewer.test.js`
Expected: the two new tests FAIL (the fake ipc has no handler for `viewer:places`); the other nine pass.

- [ ] **Step 3: The channels and the nudge**

In `src/main/ipc/viewer.js`, replace:

```js
  ipcMain.handle('viewer:tree', async (_e, id) => {
    const h = viewer.get(id);
    return h ? { ok: true, entries: await fileIndex.list(h.root) } : { ok: false, expired: true };
  });
```

with:

```js
  ipcMain.handle('viewer:tree', (_e, id) => viewer.treeOf(id)); // a folder's index, or a branch's own tree
```

After the line `  ipcMain.handle('viewer:close', (_e, id) => { viewer.close(id); return true; });` add:

```js
  // The header's menu: the repo's worktrees and unmerged branches, each under a key main issued;
  // a pick names only a key, and main checks it again before it opens (viewer.js switchTo).
  ipcMain.handle('viewer:places', (_e, id) => viewer.placesOf(id));
  ipcMain.handle('viewer:switch', (_e, id, key) => viewer.switchTo(id, key));
```

Replace:

```js
  // Something in a folder may have changed: a nudge for each viewer open on it.
  const nudge = d.viewerNudge = dir => {
    const ids = viewer.staleFor(dir);
    if (ids.length && d.panel && !d.panel.isDestroyed()) d.send(d.panel, 'viewer:stale', { ids });
  };
  fileIndex.onForget(nudge);                      // turn ends, ! commands, step undo
  d.viewerWrites = writeWatch(nudge);             // each tool that could have written (wiring/sessions.js)
```

with:

```js
  // Something in a folder may have changed: a nudge for each viewer open on it. commits: a turn
  // ended, a step was undone or a ! command ran, where a commit may have landed, so viewers on the
  // repo's branches look again too; each tool's result leaves them be.
  const nudge = d.viewerNudge = (dir, opts) => {
    const ids = viewer.staleFor(dir, opts);
    if (ids.length && d.panel && !d.panel.isDestroyed()) d.send(d.panel, 'viewer:stale', { ids });
  };
  fileIndex.onForget(dir => nudge(dir, { commits: true })); // turn ends, ! commands, step undo
  d.viewerWrites = writeWatch(dir => nudge(dir));            // each tool that could have written (wiring/sessions.js)
```

Also change the second line of the file's header comment, `// folder, or on a worktree of a project the Project page showed, then read`, to `// folder, or on a worktree of a project the Project page showed (or a place picked from its header's menu), then read`.

- [ ] **Step 4: The bridge, on the line it already has**

`src/preload/preload.js` is at 799 lines and `test/file-size.test.js` allows 800, so no line is added. Replace line 70:

```js
  viewerBranch: invoke('viewer:branch'), viewerClose: invoke('viewer:close'), onViewerStale: on('viewer:stale'),
```

with:

```js
  viewerBranch: invoke('viewer:branch'), viewerClose: invoke('viewer:close'), viewerPlaces: invoke('viewer:places'), viewerSwitch: invoke('viewer:switch'), onViewerStale: on('viewer:stale'),
```

- [ ] **Step 5: Document the boundary and the module**

In `docs/THREAT-MODEL.md`, replace the whole row at line 65 (it starts `| Renderer → main file read |`) with:

```markdown
| Renderer → main file read | The panel reading files outside the folder it was shown, aiming git at another repo, reaching a UNC network path, being handed the whole home folder, a browsed repo running its own programs, or a branch name read by git as an option | The panel opens a handle on a conversation id or on a local worktree that `git worktree list` reports and that shares the project's git directory, never on a UNC path; a folder (or the repo root it belongs to) that is the home folder, a folder above it or a whole drive is refused, so a conversation left in `~` or a dotfiles repo at `~` never hands over `.ssh` or `.claude`; paths with a drive, a stream, a network or rooted start, or `..` are refused before the disk is touched, then links and 8.3 names are resolved and the file opened is checked to be the one inside; outside and missing answer alike; diffs only for files on that handle's own changes list; 2 MB cap, binary refused. The header's menu lists the repo's local worktrees (none too wide to browse) and its unmerged local branches under random keys main keeps on that handle; a pick names only a key and is checked again before it opens (still listed, same git directory, not too wide; a branch still resolves). A branch is read from git alone (`rev-parse`, `merge-base`, `diff`, `ls-tree`, `cat-file`) with full `refs/heads/` names, so no ref reaches git as an option; Whole file only for a path in the commit's own tree; nothing is checked out, no index written, no hook run. Its snapshots run `git add` into a temporary index with hooks pointed at an empty folder; clean filters (git-lfs) still run, as they do for status reads and the menu's per-worktree `git status` counts | `src/main/viewer.js`, `src/main/ipc/viewer.js`, `src/main/changes.js` |
```

In `docs/DEVELOPMENT.md`, replace line 407:

```
  viewer.js        the file viewer: handles on a folder, reads kept inside it, and what changed since its branch began; ipc/viewer.js serves it
```

with:

```
  viewer.js        the file viewer: handles on a folder (reads kept inside it) or on a branch (read from git alone), what changed since each began, and the header menu's worktrees and branches; ipc/viewer.js serves it
```

- [ ] **Step 6: Run every unit test, lint and typecheck**

Run: `npm test; npm run lint; npm run typecheck`
Expected: all clean. `test/ipc-surface.test.js` finds `viewer:places` and `viewer:switch` on both sides; `test/file-size.test.js` still sees preload.js within 800 lines. If `test/council.test.js` fails with EPERM, rerun it alone (`node --test test/council.test.js`): it is a known flake on this PC and passes alone.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/viewer.js src/preload/preload.js docs/THREAT-MODEL.md docs/DEVELOPMENT.md test/ipc-viewer.test.js
git commit -m "feat: the viewer's places and switch channels, and branch viewers nudged when a turn ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The renderer's pure logic for places

**Files:**
- Modify: `src/renderer/shared/viewer-logic.js` (`whereText` at lines 97-106; new functions before `const api = {` at line 145; the `api` object)
- Test: add to `test/viewer-logic.test.js`

**Interfaces:**
- Consumes: the `placesOf` entry shape from Task 2; `state.tabs` values (`{ id, cwd, busy, pending }`).
- Produces:
  - `whereText({ name, branch, base, against, only, kind })`: for `kind: 'branch'`, `"<branch> · branch (from <base>)"`, or `"<branch> · branch"` with no base
  - `placeSub(place, ago: (ms) => string) -> string`: worktree `"<branch> · N changed"` (or just the branch when there's no count); branch `"N ahead · <ago(when)>"` (or `"N ahead"` when `when` is 0)
  - `findPlace(places, { kind, label, branch }) -> place | null`
  - `placeKey({ kind, root, branch }) -> string` (what `lastFile` is keyed by)
  - `tabAt(tabs: Iterable<tab>, root, home) -> tab | null`: a tab whose folder is the place or inside it, else one whose folder holds the place; never a tab whose folder is too wide

- [ ] **Step 1: Write the failing tests**

In `test/viewer-logic.test.js`, after the `whereText` test (ends at line 80), add:

```js

test('whereText: a branch says so, and where it came from', () => {
  assert.equal(V.whereText({ kind: 'branch', name: 'proj', branch: 'feature-x', base: 'main', against: 'main' }), 'feature-x · branch (from main)');
  assert.equal(V.whereText({ kind: 'branch', name: 'proj', branch: 'feature-x', base: null, against: null }), 'feature-x · branch');
  assert.equal(V.whereText({ kind: 'folder', name: 'proj', branch: 'feat', base: 'main', against: 'main' }), 'proj · feat (from main)');
});

test("placeSub: a worktree's branch and count, a branch's lead and age", () => {
  const ago = t => `at ${t}`;
  assert.equal(V.placeSub({ kind: 'worktree', branch: 'feat', changed: 3 }, ago), 'feat · 3 changed');
  assert.equal(V.placeSub({ kind: 'worktree', branch: 'main', changed: 0 }, ago), 'main · 0 changed');
  assert.equal(V.placeSub({ kind: 'worktree', branch: 'detached' }, ago), 'detached', 'no count: git status timed out');
  assert.equal(V.placeSub({ kind: 'branch', branch: 'x', ahead: 2, when: 5 }, ago), '2 ahead · at 5');
  assert.equal(V.placeSub({ kind: 'branch', branch: 'x', ahead: 1, when: 0 }, ago), '1 ahead');
});

test('findPlace: the same pick in a list made since, by what the panel was shown of it', () => {
  const list = [
    { key: 'k1', kind: 'worktree', label: 'proj', branch: 'main' },
    { key: 'k2', kind: 'worktree', label: 'proj', branch: 'shellby/abc' },
    { key: 'k3', kind: 'branch', label: 'feature-x', branch: 'feature-x' },
  ];
  assert.equal(V.findPlace(list, { kind: 'worktree', label: 'proj', branch: 'shellby/abc' }).key, 'k2');
  assert.equal(V.findPlace(list, { kind: 'branch', label: 'feature-x', branch: 'feature-x' }).key, 'k3');
  assert.equal(V.findPlace(list, { kind: 'branch', label: 'gone', branch: 'gone' }), null);
  assert.equal(V.findPlace(null, { kind: 'branch', label: 'x', branch: 'x' }), null);
  assert.equal(V.findPlace(list, null), null);
});

test('placeKey: a branch and the folder it was picked from remember their files apart', () => {
  const folder = V.placeKey({ kind: 'folder', root: 'C:\\code\\proj', branch: 'main' });
  assert.equal(folder, V.placeKey({ kind: 'folder', root: 'c:\\CODE\\proj', branch: 'main' }), 'any case');
  assert.notEqual(V.placeKey({ kind: 'branch', root: 'C:\\code\\proj', branch: 'feature-x' }), folder);
  assert.notEqual(V.placeKey({ kind: 'branch', root: 'C:\\code\\proj', branch: 'feature-x' }), V.placeKey({ kind: 'branch', root: 'C:\\code\\proj', branch: 'other' }));
});

test('tabAt: a conversation in the place or holding it, never one left in the home folder', () => {
  const home = 'C:\\Users\\Me';
  const inHome = { id: 'h', cwd: 'C:\\Users\\Me' };
  const copy = { id: 'c', cwd: 'C:\\Users\\Me\\AppData\\Roaming\\Shellby\\worktrees\\1\\proj' };
  const sub = { id: 's', cwd: 'C:\\code\\proj\\src' };
  const tabs = [inHome, copy, sub];
  assert.equal(V.tabAt(tabs, 'c:/users/me/appdata/roaming/shellby/worktrees/1/proj/', home), copy, 'its own folder, any case or slash');
  assert.equal(V.tabAt(tabs, `${copy.cwd}\\.claude\\worktrees\\agent-x`, home), copy, 'a worktree inside a conversation\'s folder');
  assert.equal(V.tabAt(tabs, 'C:\\code\\proj', home), sub, 'a conversation started in a subfolder of the place');
  assert.equal(V.tabAt(tabs, 'C:\\Users\\Me\\code\\other', home), null, 'the home folder holds it, but that tab is too wide to count');
  assert.equal(V.tabAt(tabs, 'C:\\code\\proj2', home), null, 'a name that only starts the same');
  assert.equal(V.tabAt(new Map([['c', copy]]).values(), copy.cwd, home), copy, 'any iterable, as state.tabs.values()');
  assert.equal(V.tabAt(tabs, '', home), null);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/viewer-logic.test.js`
Expected: FAIL. The branch `whereText` test gets `'feature-x (from main)'`-style text; the others with `TypeError: V.placeSub is not a function` (and `findPlace`, `placeKey`, `tabAt`).

- [ ] **Step 3: Write the implementation**

In `src/renderer/shared/viewer-logic.js`, replace:

```js
  function whereText({ name, branch, base, against, only } = {}) {
    const from = !branch || !base ? '' : against === 'HEAD' && !only ? ' (since the last commit)' : ` (from ${base})`;
```

with:

```js
  function whereText({ name, branch, base, against, only, kind } = {}) {
    // A branch picked from the header's menu: no folder of its own, and always from its base.
    if (kind === 'branch') return `${branch} · branch${base ? ` (from ${base})` : ''}`;
    const from = !branch || !base ? '' : against === 'HEAD' && !only ? ' (since the last commit)' : ` (from ${base})`;
```

Directly before the line `  const api = { buildTree, visibleRows, numberDiff, splitLines, whereText, tooWide, liveState, totals, totalsText, statusWord, statusClass, STATUS_WORDS };` add:

```js
  /** A row's second line in the header's menu (main's viewer.js placesOf). ago: SB.relTime in the panel. */
  function placeSub(p, ago = () => '') {
    if (p?.kind === 'branch') return [`${p.ahead} ahead`, p.when ? ago(p.when) : ''].filter(Boolean).join(' · ');
    return [p?.branch || 'detached', Number.isInteger(p?.changed) ? `${p.changed} changed` : ''].filter(Boolean).join(' · ');
  }

  /**
   * The same place in a list made since (keys are new each time): by what the panel was shown of
   * it, since it is never told a path or a ref.
   */
  function findPlace(places, place) {
    if (!place) return null;
    return (places || []).find(p => p.kind === place.kind && p.label === place.label && p.branch === place.branch) || null;
  }

  /** What the viewer remembers a place's last file by: a branch apart from the folder it was picked from. */
  function placeKey({ kind, root, branch } = {}) {
    const at = String(root || '').toLowerCase();
    return kind === 'branch' ? `branch|${at}|${branch}` : at;
  }

  /**
   * The open conversation a place belongs to, for the header's live state: one whose folder is the
   * place or inside it, else one whose folder holds it (an agent's worktree in the conversation's
   * folder). A conversation in the home folder or a whole drive holds everything, so it never counts.
   */
  function tabAt(tabs, root, home) {
    const norm = p => String(p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    const at = norm(root);
    if (!at) return null;
    const inside = (a, b) => a === b || a.startsWith(`${b}/`);
    const open = [...(tabs || [])].filter(t => t?.cwd && !tooWide(t.cwd, home));
    return open.find(t => inside(norm(t.cwd), at)) || open.find(t => inside(at, norm(t.cwd))) || null;
  }

```

and change that `const api = ...` line to:

```js
  const api = { buildTree, visibleRows, numberDiff, splitLines, whereText, tooWide, liveState, totals, totalsText, statusWord, statusClass, placeSub, findPlace, placeKey, tabAt, STATUS_WORDS };
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `node --test test/viewer-logic.test.js`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/shared/viewer-logic.js test/viewer-logic.test.js
git commit -m "feat: the viewer's pure logic words a branch's header and a place's menu row, and finds a place's conversation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The header's menu, branch mode, and switching on screen

**Files:**
- Modify: `src/renderer/panel/html/viewer.html:5` (`#viewerWhere` becomes a button)
- Modify: `src/renderer/panel/html/frame.html:154` (the menu's popover, after `noteMenu`)
- Modify: `src/renderer/panel/core.js:428` (the mousedown list that keeps a menu open)
- Modify: `src/renderer/panel/viewer.css:4` (the `.vw-where` rule)
- Modify: `src/renderer/panel/viewer.js` (header comment, `lastFile`, `call`, `start`, `loadChanges`, `drawLive`, `draw`, `note`, `showFile`, new `openPlaces`/`placeRows`/`pick`, a listener, `current`)
- Modify: `src/renderer/panel/panel.html` (rebuilt)
- Modify: `scripts/e2e-viewer.js`
- Modify: `docs/DEVELOPMENT.md:78` (the e2e-viewer row)

**Interfaces:**
- Consumes: preload `viewerPlaces`, `viewerSwitch` (Task 3); `V.whereText`, `V.placeSub`, `V.findPlace`, `V.placeKey`, `V.tabAt` (Task 4); `SB.openMenu`, `SB.closeMenus`, `SB.menuItem`, `SB.relTime`, `SB.toast`, `SB.h`.
- Produces: `SB.viewer.current() -> { id, root, file, side, files, kind, branch, gone } | null` (adds `kind`, `branch`, `gone`); `start(req, { file, line, side, handle, place })`.

- [ ] **Step 1: Write the failing e2e checks**

In `scripts/e2e-viewer.js`, change line 1 to:

```js
// ci: the file viewer: a copy's changes and diffs, whole files, live refresh, Esc back to the panes, worktrees and branches from its header
```

After the line `const FOOT = \`${MADE.length} files · +${ADDED}\`;` add:

```js
// The copy's changed files once the two-hunk check has edited multi.txt in it: what its menu row counts.
const COPY_CHANGED = MADE.length + 1;
// A branch nothing has checked out, with commits main lacks (made late in the run): the menu lists it.
const BRANCH = { name: 'feature-x', file: 'feature.txt', words: 'made on a branch', commits: 1 };
// A worktree an agent makes inside the conversation's copy, and the copy's turn that nudges it.
const AGENT = { name: 'agent-x', file: 'agent.txt', words: 'made by an agent' };
const NUDGE = { file: 'nudge.txt', words: 'a nudge from the copy' };
```

After the line `fs.writeFileSync(path.join(base, 'outside.txt'), 'not in the project\n');` add:

```js
// As a repo's .gitignore would: an agent's worktree isn't the copy's own untracked files (info/exclude is shared by every worktree).
fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.claude/worktrees/\n');
```

After the line `    check(await until("SB.state.view === 'projects'"), 'Back goes to the Project page it was opened from');` add:

```js

    // ---- the header's menu: the repo's worktrees, and a branch still in flight
    const featureWt = path.join(base, 'feature-wt');
    git('worktree', 'add', '-q', '-b', BRANCH.name, featureWt, 'main');
    fs.writeFileSync(path.join(featureWt, BRANCH.file), `${BRANCH.words}\n`);
    execFileSync('git', ['-C', featureWt, 'add', '-A'], { windowsHide: true });
    execFileSync('git', ['-C', featureWt, 'commit', '-qm', 'feature work'], { windowsHide: true });
    git('worktree', 'remove', featureWt); // the branch stays, and nothing has it checked out
    await ev(`SB.viewer.openTab(${JSON.stringify(copyTab)})`);
    check(await until(`SB.state.view === 'viewer' && SB.viewer.current()?.files.length === ${COPY_CHANGED}`), 'the viewer is on the copy again');
    const copyBranch = await ev('SB.viewer.current().branch');
    await open('multi.txt'); // committed on main before the branch left, so the branch has it too
    check(await until("SB.viewer.current()?.file === 'multi.txt'"), 'a file the branch also has is open');
    const keptFile = await ev('SB.viewer.current().file');
    const rowsOf = "[...document.querySelectorAll('#viewerMenu .menu-item')].map(b => ({ title: b.querySelector('.mi-title')?.textContent, sub: b.querySelector('.mi-sub')?.textContent || '', on: b.querySelector('.mi-check')?.textContent === '✓' }))";
    const openMenu = () => ev("document.getElementById('viewerWhere').click()");
    const menuRow = (by, text) => ev(`[...document.querySelectorAll('#viewerMenu .menu-item')].find(b => (b.querySelector(${JSON.stringify(by)})?.textContent || '')${by === '.mi-sub' ? `.startsWith(${JSON.stringify(text)})` : ` === ${JSON.stringify(text)}`}).click()`);
    await openMenu();
    check(await until("!document.getElementById('viewerMenu').hidden && document.querySelectorAll('#viewerMenu .menu-item').length > 0", 20000), 'the header opens a menu of places');
    const places = await ev(rowsOf);
    const copyRow = places.find(p => p.sub === `${copyBranch} · ${COPY_CHANGED} changed`);
    check(!!copyRow && copyRow.on, `the conversation's copy is listed with ${COPY_CHANGED} changed, and checked (${JSON.stringify(places)})`);
    check(places.some(p => p.title === BRANCH.name && p.sub.startsWith(`${BRANCH.commits} ahead · `)), `the branch is listed, ${BRANCH.commits} ahead`);
    check(!places.some(p => p.title === copyBranch), "the copy's branch is listed once, as a worktree");
    const focused = await ev("document.activeElement?.closest('#viewerMenu') ? document.activeElement.textContent : null");
    await ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
    check(focused !== null && await ev(`!!document.activeElement?.closest('#viewerMenu') && document.activeElement.textContent !== ${JSON.stringify(focused)}`), 'the arrow keys move through it');
    await shot('4-places');

    // ---- a branch: what it made, its diff and Whole file, read from git
    await menuRow('.mi-title', BRANCH.name);
    check(await until(`SB.viewer.current()?.kind === 'branch' && document.getElementById('viewerWhere').textContent.startsWith(${JSON.stringify(`${BRANCH.name} · branch (from main)`)})`), 'picking the branch shows it, from main');
    check(await until(`JSON.stringify([...document.querySelectorAll('#viewerList .vw-row')].map(b => b.dataset.path + ':' + b.querySelector('.vw-st').textContent)) === ${JSON.stringify(JSON.stringify([`${BRANCH.file}:A`]))}`), 'Changes lists what the branch made');
    check(await ev(`SB.viewer.current().file === ${JSON.stringify(keptFile)}`), `the file you were on (${keptFile}) stays open, since the branch has it too`);
    check(await ev("document.getElementById('viewerOnlyRow').hidden && document.getElementById('viewerEditor').hidden"), 'a branch has no Just uncommitted and no Open in editor');
    await ev(`[...document.querySelectorAll('#viewerList .vw-row')].find(b => b.dataset.path === ${JSON.stringify(BRANCH.file)}).click()`);
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.add .code')].some(c => c.textContent === ${JSON.stringify(BRANCH.words)})`), "its diff shows the branch's line");
    await ev("[...document.querySelectorAll('#viewerMain .vw-file-head button')].find(b => b.textContent === 'Whole file').click()");
    check(await until(`[...document.querySelectorAll('#viewerMain .dl.ctx .code')].some(c => c.textContent === ${JSON.stringify(BRANCH.words)})`), 'Whole file reads it from the commit');
    check(await ev("document.getElementById('viewerEditor').hidden && document.getElementById('viewerLive').hidden"), 'still no Open in editor, and no live state: a branch is nobody\'s folder');
    await shot('5-branch');

    // ---- the branch deleted while shown; the menu still takes you back to the copy
    git('branch', '-D', BRANCH.name);
    await wait(2200); // main answers a look again within 2 s of the last one
    await ev("document.getElementById('viewerRefresh').click()");
    check(await until("document.querySelector('#viewerMain .vw-gone p')?.textContent === 'This branch is gone.'"), 'a branch deleted while shown says so');
    await openMenu();
    check(await until("document.querySelectorAll('#viewerMenu .menu-item').length > 0", 20000), 'and the menu still opens');
    check(!(await ev(rowsOf)).some(p => p.title === BRANCH.name), 'without the deleted branch');
    await menuRow('.mi-sub', `${copyBranch} · `);
    check(await until(`SB.viewer.current()?.kind === 'folder' && SB.viewer.current().branch === ${JSON.stringify(copyBranch)} && SB.viewer.current().files.length === ${COPY_CHANGED}`), 'picking the copy goes back to it, with what it changed');

    // ---- a worktree an agent made inside the copy: the copy's turn nudges a viewer on it
    const copyRoot = await ev('SB.viewer.current().root');
    const agentAt = path.join(copyRoot, '.claude', 'worktrees', AGENT.name);
    execFileSync('git', ['-C', copyRoot, 'worktree', 'add', '-q', '-b', AGENT.name, agentAt], { windowsHide: true });
    await openMenu();
    check(await until(`[...document.querySelectorAll('#viewerMenu .mi-title')].some(t => t.textContent === ${JSON.stringify(AGENT.name)})`, 20000), "the agent's worktree is in the menu");
    await menuRow('.mi-title', AGENT.name);
    check(await until(`SB.viewer.current()?.root.toLowerCase().endsWith(${JSON.stringify(AGENT.name)}) && SB.viewer.current().files.length === 0`), 'picking it shows the worktree, with nothing changed yet');
    check(await until("!document.getElementById('viewerLive').hidden"), "the live state is the copy's conversation, which holds it");
    await ev("document.getElementById('viewerTabChanges').click()");
    check(await until("document.getElementById('viewerNote').textContent === 'Nothing has changed here.'"), 'its Changes say nothing has changed');
    fs.writeFileSync(path.join(agentAt, AGENT.file), `${AGENT.words}\n`);
    await wait(400);
    check(await ev('SB.viewer.current().files.length === 0'), 'a file the agent writes waits for a look');
    await ev(`SB.activate(${JSON.stringify(copyTab)})`);
    await ev(`SB.send(${JSON.stringify(`edit ${NUDGE.file} ${NUDGE.words}`)})`);
    await idle();
    await ev("SB.setView('viewer')");
    check(await until(`SB.viewer.current()?.files.some(f => f.path === ${JSON.stringify(AGENT.file)})`), "the copy's turn nudged the viewer on the worktree inside it, which looked again");
    await shot('6-agent-worktree');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node scripts/e2e-viewer.js`
Expected: every check before the new section passes; `FAIL  the header opens a menu of places` (there is no `#viewerMenu` yet), and the checks after it fail. The script closes its Electron in `finally`.

- [ ] **Step 3: The markup, and the click that keeps the menu open**

In `src/renderer/panel/html/viewer.html`, replace:

```html
      <span class="vw-where" id="viewerWhere"></span>
```

with:

```html
      <button type="button" class="vw-where" id="viewerWhere" aria-haspopup="menu" aria-expanded="false"></button>
```

In `src/renderer/panel/html/frame.html`, after the line `  <div class="popover" id="noteMenu" role="menu" hidden></div>` add:

```html
  <div class="popover vw-menu" id="viewerMenu" role="menu" aria-label="Worktrees and branches" hidden></div>
```

In `src/renderer/panel/core.js`, replace:

```js
  if (!e.target.closest('.popover, .mode-chip, .folder-chip, .ctx-chip, .usage, .tab-all, .tab-review, .slash-menu, .snip-more, .note-more, #input')) SB.closeMenus();
```

with:

```js
  if (!e.target.closest('.popover, .mode-chip, .folder-chip, .ctx-chip, .usage, .tab-all, .tab-review, .slash-menu, .snip-more, .note-more, .vw-where, #input')) SB.closeMenus();
```

Without it, a click on the header while its menu is open closes the menu on mousedown and the click opens it again.

- [ ] **Step 4: The styles**

In `src/renderer/panel/viewer.css`, replace:

```css
.vw-where { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sand); font-size: var(--fs-13); }
```

with:

```css
.vw-where { flex: 0 1 auto; margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 6px; border: 0; border-radius: var(--r-sm); background: none; color: var(--sand); font: inherit; font-size: var(--fs-13); text-align: left; cursor: pointer; }
.vw-where:hover:not(:disabled), .vw-where:focus-visible, .vw-where[aria-expanded="true"] { background: var(--line-soft); }
.vw-where:disabled { cursor: default; color: var(--sand); opacity: 1; }
.vw-where-caret { color: var(--sand-dim); }
.vw-menu { min-width: 240px; }
.vw-menu-note { margin: 0; padding: 2px 9px 6px; }
```

`margin-right: auto` keeps the live badge, Refresh and Open in editor at the right end, as `flex: 1` did, while the button's hover background covers only its text.

- [ ] **Step 5: The screen's script**

All edits in `src/renderer/panel/viewer.js`.

Replace the header comment's last two lines:

```js
   viewer.js). Opened from a pane's Files button, file links, the branch chip
   and the Project page. */
```

with:

```js
   viewer.js). Opened from a pane's Files button, file links, the branch chip
   and the Project page. Its header's menu switches to another worktree of the
   repo, or to a branch nothing has checked out, read from git alone. */
```

Replace:

```js
  const lastFile = new Map(); // root -> the file last open there, while Shellby runs
```

with:

```js
  const lastFile = new Map(); // a place (V.placeKey) -> the file last open there, while Shellby runs
```

Replace the whole `call` function (from `  // A call on the handle. One dropped (eight others opened since, a closed tab, a reload) is opened` to its closing `  }`, lines 21-38) with:

```js
  // A call on the handle. One dropped (eight others opened since, a closed tab, a reload) is opened
  // again, once, with its changes list rebuilt, since main serves diffs only for files on that list.
  async function call(fn) {
    const me = cur;
    let r = await fn(me.id).catch(() => null);
    if (r?.expired) {
      const again = await reopen(me);
      if (!again?.ok) {
        if (again?.gone) me.gone = true;
        return { ok: false, gone: !!again?.gone, error: again?.error || "Couldn't open that folder." };
      }
      me.id = again.id;
      if (me.git) await api.viewerChanges(me.id, { uncommittedOnly: me.only }).catch(() => null);
      r = await fn(me.id).catch(() => null);
    }
    if (r?.gone) me.gone = true; // the folder was deleted while open: draw() says so
    return r || { ok: false, error: "Couldn't read that." };
  }

  // A place picked from the header's menu has no open request of its own (main hands out keys, not
  // paths): open the first place again, and make the same pick from its menu.
  async function reopen(me) {
    const first = await api.viewerOpen(me.req).catch(() => null);
    if (!first?.ok || !me.place) return first;
    const list = await api.viewerPlaces(first.id).catch(() => null);
    const p = list?.ok ? V.findPlace(list.places, me.place) : null;
    const r = p ? await api.viewerSwitch(first.id, p.key).catch(() => null) : null;
    api.viewerClose(first.id);
    return r?.ok ? r : { ok: false, gone: true, error: 'That worktree or branch is gone.' };
  }
```

Replace the start of `start` (lines 42-62), from `  async function start(req, { file = null, line = null, side = null } = {}) {` through `    if (me.gone) return draw();`, with:

```js
  // opts.handle: one main has opened already (a pick from the header's menu), and opts.place which
  // pick, so call() can make it again. A pick keeps the file you were on when the new place has it
  // too (on its changes list or in its tree), else shows the placeholder.
  async function start(req, { file = null, line = null, side = null, handle = null, place = null } = {}) {
    const r = handle || await api.viewerOpen(req).catch(() => null);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't open that folder.");
    if (cur && cur.id !== r.id) api.viewerClose(cur.id);
    // Back (and Esc) return to where it was opened from: the chat, or the Project page.
    // Opened again from inside the viewer (a file link in it, a pick from its menu), it keeps the first.
    const from = state.view === 'viewer' ? cur?.from || null : state.view;
    const me = cur = {
      ...r, req, from, place, tabId: place ? null : req.tabId || null, side, only: false, files: [], more: 0, against: null, note: null,
      gone: false, branchGone: false, dirty: false, entries: [], open: new Set(), filter: '',
      file: file || (place ? null : lastFile.get(V.placeKey(r))) || null, line, whole: !!line,
    };
    $('viewerFilter').value = '';
    $('viewerMain').replaceChildren();
    SB.setView('viewer');
    draw();
    await Promise.all([loadChanges(), loadTree()]);
    if (cur !== me) return;
    if (me.gone) return draw();
    if (place && me.file && !me.files.some(f => f.path === me.file) && !me.entries.includes(me.file)) me.file = null;
```

The rest of `start` (from `    if (!me.side) me.side = me.files.length || me.note ? 'changes' : 'files';`) stays as it is: Changes is the default when the place changed anything, a branch included.

In `loadChanges`, replace:

```js
    if (r.gone) { me.gone = true; me.files = []; return; }
```

with:

```js
    if (r.branchGone) { me.gone = true; me.branchGone = true; me.files = []; return; }
    if (r.gone) { me.gone = true; me.files = []; return; }
```

Replace `drawLive`:

```js
  function drawLive() {
    const live = cur?.tabId ? V.liveState(state.tabs.get(cur.tabId)) : null;
```

with:

```js
  // The conversation's state in the header: the one it was opened from, or (a pick from the menu, the
  // Project page) one whose folder this is or holds it. A branch is nobody's folder.
  function drawLive() {
    const tab = !cur || cur.kind === 'branch' ? null : cur.tabId ? state.tabs.get(cur.tabId) : V.tabAt(state.tabs.values(), cur.root, state.home);
    const live = V.liveState(tab || null);
```

In `draw`, replace:

```js
    $('viewerWhere').textContent = V.whereText(cur);
    $('viewerWhere').title = cur.root;
```

with:

```js
    const where = $('viewerWhere');
    where.replaceChildren(V.whereText(cur), ...(cur.git ? [h('span', { class: 'vw-where-caret', 'aria-hidden': 'true', text: ' ▾' })] : []));
    where.title = cur.root;
    where.disabled = !cur.git; // a folder that isn't a repo has nothing to switch to: plain text, as before
```

replace:

```js
        h('p', { text: 'This folder is gone.' }),
```

with:

```js
        h('p', { text: cur.branchGone ? 'This branch is gone.' : 'This folder is gone.' }),
```

replace:

```js
    $('viewerSide').hidden = false;
```

with:

```js
    $('viewerSide').hidden = false;
    if (cur.kind === 'branch') $('viewerEditor').hidden = true; // read from git: no file on disk to open
```

and replace:

```js
    $('viewerOnlyRow').hidden = cur.side !== 'changes' || !cur.base;
```

with:

```js
    $('viewerOnlyRow').hidden = cur.side !== 'changes' || !cur.base || cur.kind === 'branch'; // a branch is all commits
```

In `note`, replace:

```js
    editor ? h('button', { type: 'button', class: 'btn slim-btn', text: 'Open in editor', onclick: openInEditor }) : null);
```

with:

```js
    editor && cur?.kind !== 'branch' ? h('button', { type: 'button', class: 'btn slim-btn', text: 'Open in editor', onclick: openInEditor }) : null);
```

In `showFile`, replace:

```js
    lastFile.set(me.root, rel);
```

with:

```js
    lastFile.set(V.placeKey(me), rel);
```

and replace:

```js
    $('viewerEditor').hidden = false;
```

with:

```js
    $('viewerEditor').hidden = me.kind === 'branch';
```

Directly before the comment line `  // Main's nudge: something in the folder may have changed. One look, at most every 2 s, only on`, add:

```js
  // The header's menu: every worktree of the repo, and each branch with commits main lacks. It opens
  // at once and fills in when main has looked (a git status in each worktree can take a moment).
  async function openPlaces() {
    const me = cur;
    const menu = $('viewerMenu');
    const anchor = $('viewerWhere');
    if (!me?.git || !menu.hidden) return SB.closeMenus({ refocus: true });
    SB.openMenu(menu, anchor, () => [h('div', { class: 'menu-label', text: 'Looking…' })]);
    const r = await call(id => api.viewerPlaces(id));
    if (cur !== me || menu.hidden) return;
    SB.closeMenus();
    SB.openMenu(menu, anchor, () => placeRows(r));
  }

  function placeRows(r) {
    if (!r?.ok) return [h('div', { class: 'menu-label', text: 'Worktrees' }), h('p', { class: 'small muted vw-menu-note', text: "Couldn't list worktrees." })];
    const row = p => SB.menuItem(p.label, V.placeSub(p, SB.relTime), () => pick(p), { glyph: p.current ? '✓' : '' });
    const trees = r.places.filter(p => p.kind === 'worktree');
    const branches = r.places.filter(p => p.kind === 'branch');
    return [
      h('div', { class: 'menu-label', text: 'Worktrees' }), ...trees.map(row),
      ...(branches.length ? [h('div', { class: 'menu-sep' }), h('div', { class: 'menu-label', text: 'Branches' }), ...branches.map(row)] : []),
    ];
  }

  // A pick: main checks it again and opens it. Straight to main rather than through call(), whose
  // "gone" means this screen's folder: here it means the pick went stale since the menu opened.
  async function pick(p) {
    const me = cur;
    if (!me) return;
    const r = await api.viewerSwitch(me.id, p.key).catch(() => null);
    if (cur !== me) return;
    if (!r?.ok) return SB.toast(r?.gone || r?.expired ? 'That worktree or branch is gone.' : r?.error || "Couldn't open that.");
    start(me.req, { handle: r, place: { kind: p.kind, label: p.label, branch: p.branch }, file: me.file });
  }

```

After the line `  $('viewerRefresh').addEventListener('click', () => refresh());` add:

```js
  $('viewerWhere').addEventListener('click', openPlaces);
```

Replace:

```js
    current: () => (cur ? { id: cur.id, root: cur.root, file: cur.file, side: cur.side, files: cur.files } : null),
```

with:

```js
    current: () => (cur ? { id: cur.id, root: cur.root, file: cur.file, side: cur.side, files: cur.files, kind: cur.kind, branch: cur.branch, gone: cur.gone } : null),
```

Two things already work without edits: Arrow keys, Home/End and Enter move through the menu because `#viewerMenu` is a `.popover[role="menu"]` (core.js's menu keydown handler) whose rows are `SB.menuItem` buttons; Esc closes it through `SB.closeMenus`. And the 2 s throttle and the hidden-viewer catch-up (`api.onViewerStale`, `SB.views.viewer.render`) apply to every place unchanged.

- [ ] **Step 6: Say what the e2e covers now**

In `docs/DEVELOPMENT.md`, in the row at line 78 that starts ``| `node scripts/e2e-viewer.js [--shots <dir>]` |``, replace the end of its description, `and the Project page's Browse files and worktree rows |`, with:

```
the Project page's Browse files and worktree rows, and the header's menu: the copy and an unmerged branch listed with their counts, the branch's change, diff and Whole file, a deleted branch, back to the copy, and a turn in the copy nudging a viewer on a worktree inside it |
```

- [ ] **Step 7: Rebuild panel.html and run the checks**

Run: `npm run panel:html; node scripts/e2e-viewer.js; npm test; npm run lint; npm run typecheck`
Expected: `all passed` from the e2e, then everything clean. If the arrow-key check fails because focus never reached the menu, check that `SB.openMenu` ran the second time with the rows in place (it focuses `menu.querySelector('button')`), not that the keydown handler is missing.

Then check no Electron is left: `Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*file-viewer*' }` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/panel/html/viewer.html src/renderer/panel/html/frame.html src/renderer/panel/panel.html src/renderer/panel/core.js src/renderer/panel/viewer.css src/renderer/panel/viewer.js scripts/e2e-viewer.js docs/DEVELOPMENT.md
git commit -m "feat: the viewer's header opens a menu of worktrees and branches, and shows a branch read from git

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The change note, and the whole branch green

**Files:**
- Modify: `changes/file-viewer.md`

- [ ] **Step 1: Add the bullet**

In `changes/file-viewer.md`, after the first bullet (the one starting `- **See what a worktree changed, without leaving Shellby.**`) add:

```markdown
- **Every worktree and branch, from the viewer's header.** Click the folder's name at the top of the viewer for a list of the repo's worktrees, each with how many files it has changed, and its branches with work main doesn't have yet. Pick a branch to see what it changed since it left main, each diff and any file in it, all read from git without checking anything out.
```

The controller runs the `humanizer` skill in embedded mode on the note's prose before it ships (user's global CLAUDE.md), keeping every fact.

- [ ] **Step 2: Run every check**

Run: `npm run lint; npm run typecheck; npm test; npm run e2e:ci`
Expected: all four clean, with these known exceptions on this PC: `test/council.test.js` can fail with EPERM under the full run and passes alone (`node --test test/council.test.js`); the dictation speech-helper e2e and `e2e-mods` fail on the pre-viewer baseline 04cc5f1a too. Rerun any other failing e2e alone (`npm run e2e:ci -- <name>`) to tell a flake from a regression, and report it either way.

- [ ] **Step 3: Confirm no stray processes**

Run (PowerShell): `Get-Process electron, node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*file-viewer*' }`
Expected: nothing. Stop any listed by its id.

- [ ] **Step 4: Commit**

```bash
git add changes/file-viewer.md
git commit -m "docs: the change note mentions worktrees and branches in the viewer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Delivery is unchanged from the file viewer's plan (Task 8, Step 5 of `2026-10-11-file-viewer.md`): the PR waits on #27 and Tyler's go-ahead, and this spec and plan leave the branch with the other design notes.
