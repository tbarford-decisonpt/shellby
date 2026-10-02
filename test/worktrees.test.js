// A copy of the repo per tab, against real git in a temp folder. The promises
// worth pinning: your checkout is untouched while the copy works, a clean
// merge lands on the branch it started from, and a conflict leaves your
// checkout exactly as it was.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktrees = require('../src/main/worktrees');

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-wt-')));
  const dir = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'b\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  return { base, dir, home, g, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('branchName makes a safe, recognisable branch from a title', () => {
  assert.equal(worktrees.branchName('Fix the login bug!', 'abc123'), 'shellby/fix-the-login-bug-abc123');
  assert.equal(worktrees.branchName('', 'abc123'), 'shellby/task-abc123');
  assert.equal(worktrees.branchName('../../etc; rm -rf', 'abc123'), 'shellby/etc-rm-rf-abc123');
  assert.match(worktrees.branchName('x'.repeat(200)), worktrees.BRANCH);
});

test('checkWorktree refuses records that are not Shellby\'s own', () => {
  const ok = { path: path.resolve('/tmp/x'), root: path.resolve('/tmp/y'), branch: 'shellby/a-abc123', base: 'main' };
  assert.equal(worktrees.checkWorktree(ok), null);
  assert.ok(worktrees.checkWorktree({ ...ok, branch: 'main' }), 'never touches your own branches');
  assert.ok(worktrees.checkWorktree({ ...ok, base: '--force' }));
  assert.ok(worktrees.checkWorktree({ ...ok, path: 'relative' }));
});

test('a folder that is not a git repo gets no copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-nogit-'));
  try { assert.equal(await worktrees.create(dir, { home: path.join(dir, 'h'), title: 'x' }), null); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the copy works on its own branch, keeps the subfolder, and leaves your checkout alone', async () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.dir, 'a.txt'), 'yours, uncommitted\n');
    const made = await worktrees.create(path.join(t.dir, 'src'), { home: t.home, title: 'Tidy up' });
    assert.equal(made.ok, true);
    const w = made.worktree;
    assert.match(w.branch, /^shellby\/tidy-up-[0-9a-f]{6}$/);
    assert.equal(w.base, 'main');
    assert.equal(path.basename(w.path), 'proj', 'keeps the project name');
    assert.equal(w.cwd, path.join(w.path, 'src'));
    assert.equal(fs.readFileSync(path.join(w.path, 'a.txt'), 'utf8'), 'one\n', 'starts from the last commit');
    fs.writeFileSync(path.join(w.path, 'a.txt'), 'copy\n');
    assert.equal(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'yours, uncommitted\n');
    assert.equal(t.g(t.dir, 'symbolic-ref', '--short', 'HEAD'), 'main');

    // A tab already in a copy doesn't get a copy of the copy.
    assert.equal(await worktrees.create(w.cwd, { home: t.home, title: 'again' }), null);
  } finally { t.done(); }
});

test('bring it home: commits what was left, merges into the base, then tidies up', async () => {
  const t = setup();
  try {
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'Add c' });
    fs.writeFileSync(path.join(w.path, 'c.txt'), 'new\n');
    const s = await worktrees.status(w);
    assert.deepEqual(s, { ok: true, uncommitted: 1, ignored: [], ahead: 0 });
    const r = await worktrees.bringHome(w, { message: 'Shellby: Add c' });
    assert.deepEqual(r, { ok: true, merged: true, commits: 1 });
    assert.equal(fs.readFileSync(path.join(t.dir, 'c.txt'), 'utf8'), 'new\n');
    assert.equal(t.g(t.dir, 'log', '-1', '--format=%s'), 'Shellby: Add c');
    assert.deepEqual(await worktrees.remove(w), { ok: true });
    assert.equal(fs.existsSync(w.path), false);
    assert.equal(t.g(t.dir, 'branch', '--list', w.branch), '', 'the merged branch is gone too');
  } finally { t.done(); }
});

test('a clash with the base is backed out, leaving your checkout as it was', async () => {
  const t = setup();
  try {
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'Clash' });
    fs.writeFileSync(path.join(w.path, 'a.txt'), 'from the copy\n');
    fs.writeFileSync(path.join(t.dir, 'a.txt'), 'from you\n');
    t.g(t.dir, 'commit', '-qam', 'mine');
    const r = await worktrees.bringHome(w, { message: 'Shellby: Clash' });
    assert.equal(r.ok, false);
    assert.equal(r.conflict, true);
    assert.equal(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'from you\n');
    assert.equal(t.g(t.dir, 'status', '--porcelain'), '', 'no half-finished merge left behind');
    assert.equal(fs.existsSync(w.path), true, 'the copy is kept, to sort it out there');
  } finally { t.done(); }
});

test('bring it home refuses when your checkout has moved to another branch', async () => {
  const t = setup();
  try {
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'Moved' });
    fs.writeFileSync(path.join(w.path, 'd.txt'), 'd\n');
    t.g(t.dir, 'switch', '-q', '-c', 'elsewhere');
    const r = await worktrees.bringHome(w, { message: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /elsewhere.*main/);
  } finally { t.done(); }
});

test('throw it away deletes the copy and its unmerged branch', async () => {
  const t = setup();
  try {
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'Nope' });
    fs.writeFileSync(path.join(w.path, 'e.txt'), 'e\n');
    t.g(w.path, 'add', '-A');
    t.g(w.path, 'commit', '-qm', 'unwanted');
    assert.deepEqual(await worktrees.remove(w, { force: true }), { ok: true });
    assert.equal(fs.existsSync(w.path), false);
    assert.equal(t.g(t.dir, 'branch', '--list', w.branch), '');
    assert.equal(fs.existsSync(path.join(t.dir, 'e.txt')), false);
  } finally { t.done(); }
});
