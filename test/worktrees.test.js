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

test('a copy can be brought home more than once, and its diffs outlive it', async () => {
  const t = setup();
  try {
    const changes = require('../src/main/changes');
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'Twice' });
    const before = await changes.snapshot(w.path);
    fs.writeFileSync(path.join(w.path, 'c.txt'), 'first\n');
    const after = await changes.snapshot(w.path);
    assert.deepEqual(await worktrees.bringHome(w, { message: 'one' }), { ok: true, merged: true, commits: 1 });

    // The conversation carries on in the same copy, and the next round lands too.
    fs.writeFileSync(path.join(w.path, 'd.txt'), 'second\n');
    assert.deepEqual(await worktrees.bringHome(w, { message: 'two' }), { ok: true, merged: true, commits: 1 });
    assert.equal(fs.readFileSync(path.join(t.dir, 'd.txt'), 'utf8'), 'second\n');
    assert.deepEqual(await worktrees.bringHome(w, { message: 'three' }), { ok: true, merged: false, commits: 0 });

    // Once the copy is gone, a turn's snapshots still read from your checkout.
    assert.deepEqual(await worktrees.remove(w), { ok: true });
    const r = await changes.patchFor({ root: t.dir, before: before.tree, after: after.tree, file: 'c.txt' });
    assert.match(r.patch, /\+first/);
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

test('only a change to files starts the work: reading and looking around do not', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(worktrees.startsWork(tool, {}), true, tool);
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'Task']) assert.equal(worktrees.startsWork(tool, {}), false, tool);
  const looks = [
    'git status', 'git log --oneline -5', 'git -C ../x diff HEAD~1', 'git --no-pager show HEAD', 'git branch -a', 'git branch',
    'ls -la src', 'cat package.json | grep version', 'rg "TODO" src 2>/dev/null', 'find . -name "*.js" | wc -l', 'node --version',
    'Get-ChildItem src', 'git status 2>&1', 'cd src && ls', "sed -n '1,20p' a.js", 'git tag -l', 'git remote -v',
  ];
  for (const c of looks) assert.equal(worktrees.startsWork('Bash', { command: c }), false, c);
  const works = [
    'npm install', 'npm test', 'git commit -am x', 'git checkout -b x', 'git branch new-one', 'git tag v1', 'rm -rf dist',
    'echo hi > a.txt', 'cat a >> b', 'sed -i s/a/b/ x.js', 'find . -delete', 'ls && touch x', 'echo $(rm x)', 'sort -o out in',
    'node script.js', 'git stash', 'Set-Content a.txt hi', 'prettier --write .', '',
  ];
  for (const c of works) assert.equal(worktrees.startsWork('PowerShell', { command: c }), true, c);
});

test('the branch name comes from what Claude called the work', () => {
  assert.equal(worktrees.suggestedName('Branch: fix-login-redirect'), 'fix-login-redirect');
  assert.equal(worktrees.suggestedName('Sure.\n\n**Branch:** `Add-Dark_Mode`'), 'add-dark-mode');
  assert.equal(worktrees.suggestedName('branch: shellby/tidy-up'), 'tidy-up');
  assert.equal(worktrees.suggestedName('I will edit the file now.'), null);
  assert.equal(worktrees.suggestedName(null), null);
  assert.match(worktrees.branchName(worktrees.suggestedName('Branch: fix-login-redirect'), 'abc123'), /^shellby\/fix-login-redirect-abc123$/);
});

test('the conversation is carried into the copy\'s project folder so it can be resumed there', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cfg-'));
  try {
    const from = path.resolve('/work/My Repo/src');
    const to = path.resolve('/copies/abc123/My Repo/src');
    assert.equal(worktrees.projectDirName(from).includes(' '), false);
    const src = path.join(config, 'projects', worktrees.projectDirName(from));
    fs.mkdirSync(path.join(src, 'sess-0001', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sess-0001.jsonl'), '{"x":1}\n');
    fs.writeFileSync(path.join(src, 'sess-0001', 'subagents', 'a.jsonl'), '{}\n');
    assert.equal(worktrees.carryTranscript({ configDir: config, sessionId: 'sess-0001', from, to }), true);
    const dst = path.join(config, 'projects', worktrees.projectDirName(to));
    assert.equal(fs.readFileSync(path.join(dst, 'sess-0001.jsonl'), 'utf8'), '{"x":1}\n');
    assert.ok(fs.existsSync(path.join(dst, 'sess-0001', 'subagents', 'a.jsonl')));
    assert.ok(fs.existsSync(path.join(src, 'sess-0001.jsonl')), 'the original stays');
    assert.equal(worktrees.carryTranscript({ configDir: config, sessionId: 'missing-1', from, to }), false);
    assert.equal(worktrees.carryTranscript({ configDir: config, sessionId: '../../etc', from, to }), false);
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});
