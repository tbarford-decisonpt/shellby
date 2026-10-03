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

// ---- sending it to GitHub: a bare repo in the temp folder stands in for origin.

function withRemote(t) {
  const bare = path.join(t.base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
  t.g(t.dir, 'remote', 'add', 'origin', bare);
  t.g(t.dir, 'push', '-q', '-u', 'origin', 'main');
  // Someone else's clone, to move origin on behind your back.
  const other = path.join(t.base, 'other');
  execFileSync('git', ['clone', '-q', bare, other], { windowsHide: true });
  t.g(other, 'config', 'user.email', 'o@example.com');
  t.g(other, 'config', 'user.name', 'O');
  t.g(other, 'config', 'core.autocrlf', 'false');
  const theirs = (file, text) => {
    fs.writeFileSync(path.join(other, file), text);
    t.g(other, 'add', '-A');
    t.g(other, 'commit', '-qm', `theirs ${file}`);
    t.g(other, 'push', '-q');
  };
  return { bare, theirs, remoteLog: () => t.g(bare, 'log', '--format=%s', 'main') };
}

test('push sends what was brought home, and status counts it first', async () => {
  const t = setup();
  try {
    const o = withRemote(t);
    const { worktree: w } = await worktrees.create(t.dir, { home: t.home, title: 'Ship it' });
    fs.writeFileSync(path.join(w.path, 'c.txt'), 'c\n');
    await worktrees.bringHome(w, { message: 'Shellby: Ship it' });
    const s = await worktrees.remoteStatus(t.dir);
    assert.equal(s.ok, true);
    assert.equal(s.upstream, 'origin/main');
    assert.deepEqual([s.ahead, s.behind], [1, 0], 'a fast-forward: just the commit');
    assert.deepEqual(await worktrees.pushBase(t.dir, { base: 'main' }), { ok: true, branch: 'main', remote: 'origin', pushed: 1, pulled: 0 });
    assert.match(o.remoteLog(), /Shellby: Ship it/);
    assert.deepEqual(await worktrees.pushBase(t.dir), { ok: true, branch: 'main', remote: 'origin', pushed: 0, pulled: 0 }, 'nothing left to push');
  } finally { t.done(); }
});

test('push takes in what origin has first, with a merge, and never forces', async () => {
  const t = setup();
  try {
    const o = withRemote(t);
    o.theirs('theirs.txt', 'theirs\n');
    fs.writeFileSync(path.join(t.dir, 'mine.txt'), 'mine\n');
    t.g(t.dir, 'add', '-A');
    t.g(t.dir, 'commit', '-qm', 'mine');
    const before = await worktrees.remoteStatus(t.dir, { fetch: true });
    assert.deepEqual([before.ahead, before.behind], [1, 1]);
    const r = await worktrees.pushBase(t.dir);
    assert.equal(r.ok, true);
    assert.equal(r.pulled, 1);
    assert.equal(r.pushed, 2, 'yours and the merge');
    const log = o.remoteLog();
    assert.match(log, /theirs theirs\.txt/, 'their commit survives');
    assert.match(log, /^mine$/m);
    assert.equal(fs.readFileSync(path.join(t.dir, 'theirs.txt'), 'utf8'), 'theirs\n');
  } finally { t.done(); }
});

test('a clash with origin is backed out and nothing is pushed', async () => {
  const t = setup();
  try {
    const o = withRemote(t);
    o.theirs('a.txt', 'from them\n');
    fs.writeFileSync(path.join(t.dir, 'a.txt'), 'from you\n');
    t.g(t.dir, 'commit', '-qam', 'mine');
    const r = await worktrees.pushBase(t.dir);
    assert.equal(r.ok, false);
    assert.equal(r.conflict, true);
    assert.equal(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'from you\n');
    assert.equal(t.g(t.dir, 'status', '--porcelain'), '', 'no half-finished merge left behind');
    assert.doesNotMatch(o.remoteLog(), /^mine$/m);
  } finally { t.done(); }
});

test('push refuses with no remote, or off its base; with origin but no upstream it sets one', async () => {
  const t = setup();
  try {
    const none = await worktrees.pushBase(t.dir);
    assert.equal(none.ok, false);
    assert.match(none.error, /no remote/);
    const bare = path.join(t.base, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
    t.g(t.dir, 'remote', 'add', 'origin', bare);
    const off = await worktrees.pushBase(t.dir, { base: 'release' });
    assert.match(off.error, /on main.*release/);
    assert.deepEqual(await worktrees.pushBase(t.dir), { ok: true, branch: 'main', remote: 'origin', pushed: 1, pulled: 0 });
    assert.equal(t.g(t.dir, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main');
  } finally { t.done(); }
});

test('a pre-push hook that says no is shown in its own words', async () => {
  const t = setup();
  try {
    withRemote(t);
    fs.writeFileSync(path.join(t.dir, 'x.txt'), 'x\n');
    t.g(t.dir, 'add', '-A');
    t.g(t.dir, 'commit', '-qm', 'x');
    fs.writeFileSync(path.join(t.dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho "tests failed: 3 of 40" >&2\nexit 1\n', { mode: 0o755 });
    const r = await worktrees.pushBase(t.dir);
    assert.equal(r.ok, false);
    assert.match(r.detail, /tests failed: 3 of 40/);
    assert.match(r.error, /origin didn't take the push/);
  } finally { t.done(); }
});

test('bring them all home: each lands in turn, other bases are skipped, a clash stops the sweep', async () => {
  const t = setup();
  try {
    const one = (await worktrees.create(t.dir, { home: t.home, title: 'One' })).worktree;
    const two = (await worktrees.create(t.dir, { home: t.home, title: 'Two' })).worktree;
    const clash = (await worktrees.create(t.dir, { home: t.home, title: 'Clash' })).worktree;
    const after = (await worktrees.create(t.dir, { home: t.home, title: 'After' })).worktree;
    fs.writeFileSync(path.join(one.path, 'one.txt'), '1\n');
    fs.writeFileSync(path.join(two.path, 'two.txt'), '2\n');
    fs.writeFileSync(path.join(clash.path, 'one.txt'), 'not 1\n');
    fs.writeFileSync(path.join(after.path, 'after.txt'), 'a\n');
    const elsewhere = { ...two, base: 'release' };

    const r = await worktrees.bringAllHome([one, elsewhere, two, clash, after], { messageFor: w => `Shellby: ${w.branch}` });
    assert.equal(r.ok, false);
    assert.equal(r.stopped, clash.branch);
    assert.deepEqual(r.results.map(x => [x.ok, !!x.skipped, !!x.conflict]), [[true, false, false], [false, true, false], [true, false, false], [false, false, true]]);
    assert.equal(fs.readFileSync(path.join(t.dir, 'two.txt'), 'utf8'), '2\n', 'the ones before the clash stay merged');
    assert.equal(fs.existsSync(path.join(t.dir, 'after.txt')), false, 'nothing after it');
    assert.equal(t.g(t.dir, 'status', '--porcelain'), '');
  } finally { t.done(); }
});

// ------------------------------------------------------------ a copy from a moment in a conversation (branch.js)

const changes = require('../src/main/changes');

test('createAt rebuilds the folder exactly as a snapshot had it, on top of the commit of the time', async () => {
  const t = setup();
  try {
    // The moment: a.txt edited, src/b.txt deleted, a new untracked file.
    fs.writeFileSync(path.join(t.dir, 'a.txt'), 'two\n');
    fs.rmSync(path.join(t.dir, 'src', 'b.txt'));
    fs.writeFileSync(path.join(t.dir, 'src', 'new.txt'), 'new\n');
    const then = await changes.snapshot(t.dir);
    assert.match(then.head, /^[0-9a-f]{40}$/, 'the snapshot knows the commit');
    // Later: committed on, more edits. None of it belongs in the branch.
    t.g(t.dir, 'add', '-A');
    t.g(t.dir, 'commit', '-qm', 'later');
    fs.writeFileSync(path.join(t.dir, 'later.txt'), 'later\n');

    const made = await worktrees.createAt({ repoRoot: t.dir, base: 'main', head: then.head, tree: then.tree, prefix: 'src', home: t.home, slug: 'tidy up', originalCwd: path.join(t.dir, 'src') });
    assert.equal(made.ok, true, made.error);
    const w = made.worktree;
    assert.match(w.branch, /^shellby\/tidy-up-[0-9a-f]{6}$/);
    assert.equal(w.cwd, path.join(w.path, 'src'));
    assert.equal(w.base, 'main');
    assert.equal(w.originalCwd, path.join(t.dir, 'src'));
    assert.equal(fs.readFileSync(path.join(w.path, 'a.txt'), 'utf8'), 'two\n');
    assert.ok(!fs.existsSync(path.join(w.path, 'src', 'b.txt')), 'what was deleted then is deleted');
    assert.ok(fs.existsSync(path.join(w.path, 'src', 'new.txt')), 'what was untracked then is there');
    assert.ok(!fs.existsSync(path.join(w.path, 'later.txt')), 'nothing from after');
    assert.equal(t.g(w.path, 'rev-parse', 'HEAD'), then.head, 'on the commit of the time');
    assert.deepEqual(t.g(w.path, 'status', '--porcelain').split('\n').map(s => s.trim()).sort(), ['?? src/new.txt', 'D src/b.txt', 'M a.txt'], 'the uncommitted work is uncommitted again');
    assert.equal((await changes.snapshot(w.path)).tree, then.tree, 'the very same tree');
    assert.equal(fs.readFileSync(path.join(t.dir, 'later.txt'), 'utf8'), 'later\n', 'your checkout untouched');

    // And it comes home like any other copy.
    const home = await worktrees.bringHome(w, { message: 'branch' });
    assert.equal(home.ok, true, home.error);
    await worktrees.remove(w);
  } finally {
    t.done();
  }
});

test('createAt says so when git has tidied the snapshot away, and refuses what it cannot trust', async () => {
  const t = setup();
  try {
    const head = t.g(t.dir, 'rev-parse', 'HEAD');
    const gone = await worktrees.createAt({ repoRoot: t.dir, base: 'main', head, tree: 'f'.repeat(40), home: t.home, slug: 'x' });
    assert.equal(gone.ok, false);
    assert.equal(gone.gone, true);
    assert.ok(!fs.existsSync(t.home) || !fs.readdirSync(t.home).length, 'no copy left behind');
    const tree = t.g(t.dir, 'rev-parse', 'HEAD^{tree}');
    assert.equal((await worktrees.createAt({ repoRoot: t.dir, base: '--force', head, tree, home: t.home, slug: 'x' })).ok, false);
    assert.equal((await worktrees.createAt({ repoRoot: t.dir, base: 'main', head: 'HEAD', tree, home: t.home, slug: 'x' })).ok, false);
    assert.equal((await worktrees.createAt({ repoRoot: t.dir, base: 'main', head, tree, prefix: '../out', home: t.home, slug: 'x' })).ok, false);
    assert.equal((await worktrees.createAt({ repoRoot: path.join(t.base, 'nope'), base: 'main', head, tree, home: t.home, slug: 'x' })).ok, false);
  } finally {
    t.done();
  }
});

test('startingPoint: where the original copy started, or what the checkout has now', async () => {
  const t = setup();
  try {
    const first = t.g(t.dir, 'rev-parse', 'HEAD');
    assert.equal(await worktrees.startingPoint({ repoRoot: t.dir }), first);
    const made = await worktrees.create(t.dir, { home: t.home, title: 'work' });
    fs.writeFileSync(path.join(made.worktree.path, 'w.txt'), 'w\n');
    t.g(made.worktree.path, 'add', '-A');
    t.g(made.worktree.path, 'commit', '-qm', 'in the copy');
    fs.writeFileSync(path.join(t.dir, 'm.txt'), 'm\n');
    t.g(t.dir, 'add', '-A');
    t.g(t.dir, 'commit', '-qm', 'on main');
    assert.equal(await worktrees.startingPoint({ repoRoot: t.dir, worktree: made.worktree }), first);
    await worktrees.remove(made.worktree, { force: true });
  } finally {
    t.done();
  }
});

test('findSession looks where it was asked first, then finds the newest anywhere; copySession carries it', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cfg-'));
  try {
    const id = '0123abcd-0000-4000-8000-000000000000';
    const put = (dir, text) => {
      const d = path.join(configDir, 'projects', worktrees.projectDirName(dir));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${id}.jsonl`), text);
      return path.join(d, `${id}.jsonl`);
    };
    const old = put('C:\\proj', 'old');
    const newer = put('C:\\copy\\proj', 'newer');
    fs.utimesSync(old, new Date(1000), new Date(1000));
    assert.equal(worktrees.findSession({ configDir, sessionId: id }), newer);
    assert.equal(worktrees.findSession({ configDir, sessionId: id, prefer: ['C:\\proj'] }), old);
    assert.equal(worktrees.findSession({ configDir, sessionId: 'missing-session-id' }), null);
    assert.equal(worktrees.findSession({ configDir, sessionId: '../../etc' }), null);

    fs.mkdirSync(path.join(path.dirname(newer), id, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(newer), id, 'subagents', 'a.jsonl'), 'sub');
    assert.equal(worktrees.copySession({ configDir, file: newer, to: 'C:\\branch\\proj' }), true);
    const there = path.join(configDir, 'projects', worktrees.projectDirName('C:\\branch\\proj'));
    assert.equal(fs.readFileSync(path.join(there, `${id}.jsonl`), 'utf8'), 'newer');
    assert.ok(fs.existsSync(path.join(there, id, 'subagents', 'a.jsonl')), 'its subagents come too');
    assert.equal(worktrees.copySession({ configDir, file: newer, to: 'C:\\copy\\proj' }), true, 'already there is fine');
    assert.equal(worktrees.copySession({ configDir, file: path.join(configDir, 'x.txt'), to: 'C:\\b' }), false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
