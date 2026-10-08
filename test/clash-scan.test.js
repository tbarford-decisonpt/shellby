// What a copy has changed, for clash warnings (src/main/clash-scan.js),
// against real git in a temp folder: committed since it left its base, plus
// uncommitted and untracked; and what's uncommitted in your own checkout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scan = require('../src/main/clash-scan');
const { findClashes } = require('../src/main/clash');
const worktrees = require('../src/main/worktrees');

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-clash-')));
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

test('changedInCopy lists committed, uncommitted and untracked changes since the base', async () => {
  const t = setup();
  try {
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'one' });
    fs.writeFileSync(path.join(w.path, 'a.txt'), 'two\n');
    t.g(w.path, 'commit', '-qam', 'change a');
    fs.writeFileSync(path.join(w.path, 'src', 'b.txt'), 'bb\n');
    fs.mkdirSync(path.join(w.path, 'new'));
    fs.writeFileSync(path.join(w.path, 'new', 'c.txt'), 'c\n');
    const files = await scan.changedInCopy(w);
    assert.deepEqual([...files].sort(), ['a.txt', 'new/c.txt', 'src/b.txt']);
  } finally { t.done(); }
});

test('changedInCopy leaves out what the base got after the copy left it', async () => {
  const t = setup();
  try {
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'one' });
    fs.writeFileSync(path.join(t.dir, 'a.txt'), 'main moved on\n');
    t.g(t.dir, 'commit', '-qam', 'on main');
    assert.deepEqual(await scan.changedInCopy(w), []);
  } finally { t.done(); }
});

test('changedInCopy returns null for a copy whose folder has gone', async () => {
  const t = setup();
  try {
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'one' });
    assert.equal(await scan.changedInCopy({ ...w, path: path.join(t.base, 'nope') }), null);
    assert.equal(await scan.changedInCopy({ ...w, branch: 'main' }), null, 'only Shellby\'s own copies');
  } finally { t.done(); }
});

test('changedInCheckout lists only what is uncommitted, with the branch', async () => {
  const t = setup();
  try {
    assert.deepEqual(await scan.changedInCheckout(t.dir), { branch: 'main', files: [] });
    fs.writeFileSync(path.join(t.dir, 'a.txt'), 'mine\n');
    assert.deepEqual(await scan.changedInCheckout(t.dir), { branch: 'main', files: ['a.txt'] });
    assert.equal(await scan.changedInCheckout(path.join(t.base, 'nope')), null);
  } finally { t.done(); }
});

test('two real copies that changed the same file come out as a clash', async () => {
  const t = setup();
  try {
    const { worktree: one } = await worktrees.create(t.dir, { home: t.home, title: 'one' });
    const { worktree: two } = await worktrees.create(t.dir, { home: t.home, title: 'two' });
    fs.writeFileSync(path.join(one.path, 'a.txt'), 'from one\n');
    t.g(one.path, 'commit', '-qam', 'one');
    fs.writeFileSync(path.join(two.path, 'a.txt'), 'from two\n');
    const entries = await Promise.all([['t1', one], ['t2', two]].map(async ([tabId, w]) => ({ tabId, title: tabId, branch: w.branch, base: w.base, root: w.root, files: await scan.changedInCopy(w) })));
    const r = findClashes(entries);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].files, ['a.txt']);
  } finally { t.done(); }
});
