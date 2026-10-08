// "Is it safe to leave?" against real git in a temp folder: a clone with a
// remote, then each kind of at-risk work one at a time, a Shellby-style copy
// (worktree) reported under its repo, and the wording people actually read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const leaving = require('../src/main/leaving');

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-leave-')));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  g(base, 'init', '-q', '--bare', '-b', 'main', origin);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  g(dir, 'remote', 'add', 'origin', origin);
  g(dir, 'push', '-q', '-u', 'origin', 'main');
  return { base, dir, g, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const commit = (r, file, text) => {
  fs.writeFileSync(path.join(r.dir, file), text);
  r.g(r.dir, 'add', '-A');
  r.g(r.dir, 'commit', '-qm', `change ${file}`);
};

test('a pushed, clean repo is safe to leave', async () => {
  const r = setup();
  try {
    const projects = await leaving.check([r.dir]);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'proj');
    const v = leaving.verdict(projects);
    assert.equal(v.safe, true);
    assert.deepEqual(v.lines, []);
    assert.match(v.headline, /^Safe to leave/);
  } finally { r.done(); }
});

test('unpushed commits are counted and their branches named', async () => {
  const r = setup();
  try {
    commit(r, 'b.txt', 'b\n');
    r.g(r.dir, 'checkout', '-q', '-b', 'feature');
    commit(r, 'c.txt', 'c\n');
    r.g(r.dir, 'checkout', '-q', 'main');
    const [p] = await leaving.check([r.dir]);
    assert.equal(p.unpushed.commits, 2);
    assert.deepEqual(p.unpushed.branches.sort(), ['feature', 'main']);
    const v = leaving.verdict([p]);
    assert.equal(v.safe, false);
    assert.equal(v.headline, '1 project has unpushed work.');
    assert.match(v.lines[0], /^proj: 2 commits not pushed \((feature, main|main, feature)\)$/);
  } finally { r.done(); }
});

test('a branch squash-merged on the remote is not unpushed, even with its branch deleted there', async () => {
  const r = setup();
  try {
    // The PR's own commits stay on the local branch; the remote gets one squash
    // commit with the same change under a different hash.
    r.g(r.dir, 'checkout', '-q', '-b', 'feature');
    commit(r, 'c.txt', 'c\n');
    r.g(r.dir, 'checkout', '-q', 'main');
    r.g(r.dir, 'merge', '-q', '--squash', 'feature');
    r.g(r.dir, 'commit', '-qm', 'feature (#1)');
    r.g(r.dir, 'push', '-q', 'origin', 'main');
    // A branch with real work alongside still counts.
    r.g(r.dir, 'checkout', '-q', '-b', 'wip');
    commit(r, 'd.txt', 'd\n');
    r.g(r.dir, 'checkout', '-q', 'main');
    const [p] = await leaving.check([r.dir]);
    assert.equal(p.unpushed.commits, 1);
    assert.deepEqual(p.unpushed.branches, ['wip']);
  } finally { r.done(); }
});

test('a branch whose only unpushed commit is a merge is still named', async () => {
  const r = setup();
  try {
    r.g(r.dir, 'checkout', '-q', '-b', 'side');
    commit(r, 'c.txt', 'c\n');
    r.g(r.dir, 'push', '-q', 'origin', 'side');
    r.g(r.dir, 'checkout', '-q', 'main');
    commit(r, 'b.txt', 'b\n');
    r.g(r.dir, 'push', '-q', 'origin', 'main');
    r.g(r.dir, 'checkout', '-q', 'side');
    r.g(r.dir, 'merge', '-q', '--no-edit', 'main');
    r.g(r.dir, 'checkout', '-q', 'main');
    const [p] = await leaving.check([r.dir]);
    assert.equal(p.unpushed.commits, 1);
    assert.deepEqual(p.unpushed.branches, ['side']);
  } finally { r.done(); }
});

test('too many unpushed commits to list are still counted', async () => {
  const run = async args => {
    if (args.includes('--show-toplevel')) return 'C:/code/proj\n';
    if (args.includes('--git-common-dir')) return '.git\n';
    if (args.includes('worktree')) return 'worktree C:/code/proj\nHEAD 1\nbranch refs/heads/main\n';
    if (args.includes('status')) return '';
    if (args[2] === 'remote') return 'origin\n';
    if (args.includes('rev-list')) return args.includes('--count') ? '30000\n' : null; // the list overflowed
    return '';
  };
  const [p] = await leaving.check([path.resolve('/code/proj')], run);
  assert.equal(p.ok, true);
  assert.deepEqual(p.unpushed, { commits: 30000, branches: [] });
});

test('uncommitted and untracked files, and stashes, each count', async () => {
  const r = setup();
  try {
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'two\n');
    r.g(r.dir, 'stash', '-q');
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'three\n');
    fs.writeFileSync(path.join(r.dir, 'new.txt'), 'new\n');
    const [p] = await leaving.check([path.join(r.dir)]);
    assert.equal(p.stashes, 1);
    assert.deepEqual({ changed: p.worktrees[0].changed, untracked: p.worktrees[0].untracked }, { changed: 1, untracked: 1 });
    const v = leaving.verdict([p]);
    assert.equal(v.headline, '1 project has uncommitted changes · 1 project has stashed changes.');
    assert.equal(v.lines[0], 'proj: 2 files not committed, 1 stash');
  } finally { r.done(); }
});

test('a worktree copy is checked as part of its repo, not as a project of its own', async () => {
  const r = setup();
  try {
    const copy = path.join(r.base, 'copy');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'shellby/try-abc123', copy);
    fs.writeFileSync(path.join(copy, 'wip.txt'), 'wip\n');
    const projects = await leaving.check([copy, r.dir]);
    assert.equal(projects.length, 1, 'the copy and the checkout are one project');
    const v = leaving.verdict(projects);
    assert.equal(v.lines[0], 'proj: 1 file not committed in the copy shellby/try-abc123');
  } finally { r.done(); }
});

test('a repo with no remote has nowhere to push, so its commits are not "unpushed"', async () => {
  const r = setup();
  try {
    r.g(r.dir, 'remote', 'remove', 'origin');
    commit(r, 'b.txt', 'b\n');
    const [p] = await leaving.check([r.dir]);
    assert.equal(p.unpushed, null);
    assert.equal(leaving.verdict([p]).safe, true);
  } finally { r.done(); }
});

test('folders that are not repos, network shares and junk are skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-nogit-'));
  try {
    assert.deepEqual(await leaving.check([dir, '\\\\server\\share', 'relative', null, 42]), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a repo git cannot read is reported, never called clean', async () => {
  const run = async args => (args.includes('worktree') ? null : args.includes('--show-toplevel') ? 'C:/code/broken\n' : '.git\n');
  const projects = await leaving.check([path.resolve('/code/broken')], run);
  assert.equal(projects[0].ok, false);
  const v = leaving.verdict(projects);
  assert.equal(v.lines.at(-1), "Couldn't check broken");
  assert.equal(v.counts.unreadable, 1);
  assert.equal(v.safe, false, 'so Lock the PC asks instead of locking');
  assert.equal(v.hold, false, 'but a shutdown is not held up over it');
  assert.equal(v.headline, "1 project couldn't be checked.");
});

test('one failed git command makes the project unreadable, never clean', async () => {
  const run = async args => {
    if (args.includes('--show-toplevel')) return 'C:/code/proj\n';
    if (args.includes('--git-common-dir')) return '.git\n';
    if (args.includes('worktree')) return 'worktree C:/code/proj\nHEAD 1\nbranch refs/heads/main\n';
    if (args.includes('status')) return '';
    if (args[2] === 'remote') return 'origin\n';
    if (args.includes('rev-list')) return null; // timed out
    return '';
  };
  const [p] = await leaving.check([path.resolve('/code/proj')], run);
  assert.equal(p.ok, false);
});

test('when git itself will not run, that is said, not "safe"', async () => {
  const projects = await leaving.check([path.resolve('/code/proj')], async () => null);
  assert.equal(projects.length, 1);
  assert.equal(leaving.verdict(projects).safe, false);
  assert.deepEqual(await leaving.check([], async () => null), [], 'no folders, nothing to say');
});

test('commits on a detached HEAD in a copy count as unpushed', async () => {
  const r = setup();
  try {
    const copy = path.join(r.base, 'loose');
    r.g(r.dir, 'worktree', 'add', '-q', '--detach', copy);
    fs.writeFileSync(path.join(copy, 'd.txt'), 'd\n');
    r.g(copy, 'add', '-A');
    r.g(copy, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'loose');
    const [p] = await leaving.check([r.dir]);
    assert.equal(p.unpushed.commits, 1);
    assert.deepEqual(p.unpushed.branches, ['detached HEAD in loose']);
    assert.equal(leaving.verdict([p]).hold, true);
  } finally { r.done(); }
});

test('stashes and background commands are mentioned but do not hold up a shutdown', () => {
  const p = { name: 'a', ok: true, worktrees: [], unpushed: { commits: 0, branches: [] }, stashes: 2 };
  const v = leaving.verdict([p], { background: [{ program: 'npm', project: 'site' }] });
  assert.equal(v.safe, false);
  assert.equal(v.hold, false);
  assert.equal(leaving.verdict([], { working: ['x'] }).hold, true);
});

test('running dev servers get a line each but never hold up a shutdown', () => {
  const v = leaving.verdict([], { servers: [{ project: 'site', port: 5173 }, { project: 'api', port: null }] });
  assert.equal(v.safe, false);
  assert.equal(v.hold, false);
  assert.equal(v.counts.servers, 2);
  assert.match(v.headline, /2 dev servers still running/);
  assert.deepEqual(v.lines, ['Dev server: site on :5173', 'Dev server: api']);
});

test('what is running: Claude working, waiting on you, background commands', () => {
  const v = leaving.verdict([], {
    working: ['Fix the login bug'],
    waiting: ['Tidy CSS', 'Release notes'],
    background: [{ program: 'npm', project: 'site' }],
  });
  assert.equal(v.safe, false);
  assert.equal(v.headline, 'Claude is still working in 1 conversation · 2 conversations waiting on you · 1 command still running in the background.');
  assert.deepEqual(v.lines, ['Still working: Fix the login bug', 'Waiting on you: Tidy CSS', 'Waiting on you: Release notes', 'In the background: npm in site']);
});

test('the headline counts projects, the way the example reads', () => {
  const p = name => ({ name, ok: true, worktrees: [], unpushed: { commits: 1, branches: ['main'] }, stashes: 0 });
  assert.equal(leaving.verdict([p('a'), p('b')]).headline, '2 projects have unpushed work.');
});

test('parsers: worktree list skips bare and vanished copies; status ignores ignored files', () => {
  const wt = leaving.parseWorktrees([
    'worktree C:/code/proj', 'HEAD 1', 'branch refs/heads/main', '',
    'worktree C:/copies/gone', 'HEAD 2', 'branch refs/heads/old', 'prunable gitdir file points to non-existent location', '',
    'worktree C:/copies/x', 'HEAD 3', 'detached', '',
  ].join('\n'));
  assert.deepEqual(wt.map(w => [path.basename(w.path), w.branch, w.main]), [['proj', 'main', true], ['x', null, false]]);
  assert.deepEqual(leaving.parseStatus(' M a.txt\nR  b -> c\n?? n.txt\n!! ignored\n'), { changed: 2, untracked: 1 });
});
