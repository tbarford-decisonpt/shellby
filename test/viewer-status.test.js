// The file tree's git status (main's viewer-status.js), against real repos in temp folders:
// each file's mark and counts against HEAD, the branch and its upstream, and a commit or a
// git add told apart from a checkout or a reset. And never a lock on the index.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createViewer } = require('../src/main/viewer');
const { parseBranch, parseStatus, parseNumstat, readStatus } = require('../src/main/viewer-status');

function repo({ commit = true } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-vstatus-')));
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'false');
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  write('a.txt', 'one\ntwo\n');
  write('src/b.js', 'const b = 1;\n');
  write('old.txt', 'rename me\nplease\n');
  write('gone.txt', 'bye\n');
  if (commit) { g('add', '-A'); g('commit', '-qm', 'init'); }
  return { base, dir, g, write, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// A read now: the 2 s reuse is for asking twice, so a test nudges first, as a write would.
async function statusNow(v, id, dir) { v.staleFor(dir); return v.statusOf(id); }

test('the branch line: upstream, ahead and behind, a new repo, a detached HEAD', () => {
  assert.deepEqual(parseBranch('## main'), { branch: 'main', upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseBranch('## feat...origin/feat [ahead 2, behind 1]'), { branch: 'feat', upstream: 'origin/feat', ahead: 2, behind: 1 });
  assert.deepEqual(parseBranch('## feat...origin/feat [gone]'), { branch: 'feat', upstream: 'origin/feat', ahead: 0, behind: 0 });
  assert.deepEqual(parseBranch('## No commits yet on main'), { branch: 'main', upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseBranch('## HEAD (no branch)'), { branch: null, upstream: null, ahead: 0, behind: 0 });
});

test('status records: a rename takes the new path and skips the old, conflicts are U', () => {
  const out = ['## main', ' M a.txt', 'R  new.txt', 'old.txt', '?? top.txt', '?? newdir/', 'UU c.txt', 'A  s.js', ' D gone.txt', ''].join('\0');
  assert.deepEqual(parseStatus(out).files, [
    { path: 'a.txt', status: 'M' }, { path: 'new.txt', status: 'R' }, { path: 'top.txt', status: '?' },
    { path: 'newdir/', status: '?' }, { path: 'c.txt', status: 'U' }, { path: 's.js', status: 'A' }, { path: 'gone.txt', status: 'D' },
  ]);
});

test('numstat: counts by path, a rename by its new path, a binary file as 0 and 0', () => {
  const out = ['2\t1\ta.txt', '0\t0\t', 'old.txt', 'new.txt', '-\t-\tpic.png', ''].join('\0');
  const m = parseNumstat(out);
  assert.deepEqual(m.get('a.txt'), { added: 2, removed: 1 });
  assert.deepEqual(m.get('new.txt'), { added: 0, removed: 0 });
  assert.equal(m.has('old.txt'), false);
  assert.deepEqual(m.get('pic.png'), { added: 0, removed: 0 });
});

test('marks against HEAD: modified, untracked, staged, deleted and renamed, with counts', async () => {
  const r = repo();
  try {
    r.write('a.txt', 'one\nTWO\nthree\n');
    r.write('top.txt', 'new\n');
    r.write('newdir/n.txt', 'n\n');
    r.write('src/c.js', 'const c = 1;\n');
    r.g('add', 'src/c.js');
    fs.rmSync(path.join(r.dir, 'gone.txt'));
    r.g('mv', 'old.txt', 'renamed.txt');
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const st = await v.statusOf(h.id);
    assert.equal(st.ok, true, st.error);
    assert.equal(st.branch, 'main');
    const by = Object.fromEntries(st.files.map(f => [f.path, f]));
    assert.deepEqual([by['a.txt'].status, by['a.txt'].added, by['a.txt'].removed], ['M', 2, 1]);
    assert.deepEqual([by['top.txt'].status, by['top.txt'].added], ['?', null], 'untracked: no counts');
    assert.equal(by['newdir/'].status, '?', 'a new folder, as git lists it');
    assert.deepEqual([by['src/c.js'].status, by['src/c.js'].added], ['A', 1]);
    assert.deepEqual([by['gone.txt'].status, by['gone.txt'].removed], ['D', 1]);
    assert.equal(by['renamed.txt'].status, 'R');
    assert.deepEqual(st.committed, []);
    assert.deepEqual(st.staged, [], 'the first read reports neither');
  } finally { r.done(); }
});

test('the branch, its upstream, and how far ahead and behind it is', async () => {
  const r = repo();
  try {
    r.g('checkout', '-q', '-b', 'feat');
    r.write('a.txt', 'feat\n');
    r.g('commit', '-qam', 'feat');
    r.g('branch', '-q', '--set-upstream-to=main');
    r.g('checkout', '-q', 'main');
    r.write('src/b.js', 'const b = 2;\n');
    r.g('commit', '-qam', 'main moves on');
    r.g('checkout', '-q', 'feat');
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const st = await v.statusOf(h.id);
    assert.deepEqual([st.branch, st.upstream, st.ahead, st.behind], ['feat', 'main', 1, 1]);
  } finally { r.done(); }
});

test('a repo with no commits yet: no numstat, the branch still named', async () => {
  const r = repo({ commit: false });
  try {
    r.g('add', 'a.txt');
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const st = await v.statusOf(h.id);
    assert.equal(st.ok, true, st.error);
    assert.equal(st.branch, 'main');
    assert.equal(st.head, null);
    const by = Object.fromEntries(st.files.map(f => [f.path, f.status]));
    assert.equal(by['a.txt'], 'A');
    assert.equal(by['src/'], '?');
  } finally { r.done(); }
});

test('a folder that is not a repo has no marks', async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-vstatus-plain-')));
  try {
    fs.writeFileSync(path.join(base, 'x.txt'), 'x\n');
    const v = createViewer();
    const h = await v.open({ dir: base });
    assert.deepEqual(await v.statusOf(h.id), { ok: true, noGit: true, files: [], committed: [], staged: [] });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a conflicted file is U', async () => {
  const r = repo();
  try {
    r.g('checkout', '-q', '-b', 'other');
    r.write('a.txt', 'theirs\n');
    r.g('commit', '-qam', 'theirs');
    r.g('checkout', '-q', 'main');
    r.write('a.txt', 'ours\n');
    r.g('commit', '-qam', 'ours');
    try { r.g('merge', '-q', 'other'); } catch { /* the conflict is the point */ }
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const st = await v.statusOf(h.id);
    assert.equal(st.files.find(f => f.path === 'a.txt')?.status, 'U');
  } finally { r.done(); }
});

test('a commit lights what it changed, once', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    assert.deepEqual((await v.statusOf(h.id)).committed, [], 'the first read');
    r.write('a.txt', 'changed\n');
    r.g('commit', '-qam', 'work');
    const st = await statusNow(v, h.id, r.dir);
    assert.deepEqual(st.committed, ['a.txt']);
    assert.deepEqual((await v.statusOf(h.id)).committed, [], 'the same answer, reused within 2 s, says it no more');
    assert.deepEqual((await statusNow(v, h.id, r.dir)).committed, [], 'nor does the next read');
  } finally { r.done(); }
});

test('a reset or a checkout moves HEAD without a commit: nothing lights', async () => {
  const r = repo();
  try {
    r.write('a.txt', 'second\n');
    r.g('commit', '-qam', 'second');
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    await v.statusOf(h.id);
    r.g('reset', '-q', '--hard', 'HEAD~1');
    assert.deepEqual((await statusNow(v, h.id, r.dir)).committed, [], 'a reset');
    r.g('checkout', '-q', '-b', 'side');
    r.write('src/b.js', 'side\n');
    r.g('commit', '-qam', 'side');
    await statusNow(v, h.id, r.dir);
    r.g('checkout', '-q', 'main');
    assert.deepEqual((await statusNow(v, h.id, r.dir)).committed, [], 'a checkout');
  } finally { r.done(); }
});

test('the first commit of a new repo lights its files', async () => {
  const r = repo({ commit: false });
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    await v.statusOf(h.id);
    r.g('add', '-A');
    r.g('commit', '-qm', 'first');
    assert.deepEqual((await statusNow(v, h.id, r.dir)).committed.sort(), ['a.txt', 'gone.txt', 'old.txt', 'src/b.js']);
  } finally { r.done(); }
});

test('git add lights what it staged, once', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    await v.statusOf(h.id);
    r.write('src/b.js', 'const b = 3;\n');
    r.g('add', 'src/b.js');
    assert.deepEqual((await statusNow(v, h.id, r.dir)).staged, ['src/b.js']);
    assert.deepEqual((await statusNow(v, h.id, r.dir)).staged, [], 'still staged, not newly');
  } finally { r.done(); }
});

test('asked twice at once, one read answers both', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const [a, b] = await Promise.all([v.statusOf(h.id), v.statusOf(h.id)]);
    assert.equal(a, b);
  } finally { r.done(); }
});

test('a status never writes the index (so no lock, and no post-index-change hook)', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    const idx = path.join(r.dir, '.git', 'index');
    const old = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(path.join(r.dir, 'a.txt'), old, old); // stale stat info: a status with locks would refresh the index
    const before = fs.statSync(idx).mtimeMs;
    assert.equal((await v.statusOf(h.id)).ok, true);
    assert.equal(fs.statSync(idx).mtimeMs, before, 'the index is as it was');
    r.g('status', '--porcelain');
    assert.notEqual(fs.statSync(idx).mtimeMs, before, 'the check can tell: a plain git status does write it');
  } finally { r.done(); }
});

test("a file added to a folder git lists whole changes what's in it, though the folder's line doesn't", async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    assert.equal((await v.statusOf(h.id)).untrackedIn, undefined, 'no folder listed whole: nothing to look inside');
    r.write('newdir/one.js', '1\n');
    const one = await statusNow(v, h.id, r.dir);
    assert.ok(one.files.some(f => f.path === 'newdir/' && f.status === '?'), 'git lists the folder whole');
    assert.equal(typeof one.untrackedIn, 'string');
    r.write('newdir/two.js', '2\n');
    const two = await statusNow(v, h.id, r.dir);
    assert.deepEqual(two.files.map(f => f.path), one.files.map(f => f.path), "the folder's line is the same");
    assert.notEqual(two.untrackedIn, one.untrackedIn, 'what is inside it is not');
    assert.equal((await statusNow(v, h.id, r.dir)).untrackedIn, two.untrackedIn, 'and nothing new reads the same');
  } finally { r.done(); }
});

test('every git call is a fixed read', async () => {
  // Answers as a repo would give them, so the reads after status and rev-list run too: a second
  // read with HEAD moved onto a child of the first asks diff-tree what the commit changed.
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
  const heads = [a, `${b} ${a}`];
  const calls = [];
  const fake = async (_cwd, args) => {
    calls.push(args.join(' '));
    return args[0] === 'status' ? '## main\0 M a.txt\0?? newdir/\0' : args[0] === 'rev-list' ? `${heads.shift()}\n` : '';
  };
  const h = { root: 'C:\\nowhere', git: true };
  assert.equal((await readStatus(h, fake)).ok, true);
  assert.equal((await readStatus(h, fake)).ok, true);
  assert.ok(calls.includes('status --porcelain=v1 -b -z --untracked-files=normal'), calls.join(' | '));
  for (const verb of ['rev-list', 'diff-index', 'diff-tree']) assert.ok(calls.some(c => c.startsWith(`${verb} `)), `${verb} ran: ${calls.join(' | ')}`);
  assert.ok(calls.includes('--literal-pathspecs ls-files --others --exclude-standard -z -- newdir/'), `a folder listed whole is looked inside, its name taken literally: ${calls.join(' | ')}`);
  for (const c of calls) assert.match(c, /^(status|rev-list|diff-index|diff-tree|--literal-pathspecs ls-files) /, c);
  assert.ok(!calls.some(c => /^diff /.test(c)), 'never porcelain git diff: it refreshes the index');
});

test('a failure says only our words', async () => {
  assert.deepEqual(await readStatus({ root: 'C:\\nowhere', git: true }, async () => null), { ok: false, error: "Couldn't read git status." });
});

test('a rev-list that fails is a failed read, not a repo with no commits yet', async () => {
  // Read as no commits, every file in the index would light as staged, and the next commit would pass unseen.
  const head = 'a'.repeat(40);
  const h = { root: 'C:\\nowhere', git: true, statusHead: head, statusCached: new Set(['a.txt']) };
  const calls = [];
  const r = await readStatus(h, async (_cwd, args) => {
    calls.push(args[0]);
    return args[0] === 'status' ? '## main\0 M a.txt\0' : args[0] === 'rev-list' ? null : '';
  });
  assert.deepEqual(r, { ok: false, error: "Couldn't read git status." });
  assert.equal(h.statusHead, head, 'the last HEAD stays, for the next read to compare with');
  assert.deepEqual([...h.statusCached], ['a.txt']);
  assert.ok(!calls.includes('diff-index'), 'nothing compared with the empty tree');
});

test('a folder gone, and a handle main dropped', async () => {
  const r = repo();
  try {
    const v = createViewer();
    const h = await v.open({ dir: r.dir });
    assert.deepEqual(await v.statusOf('nope'), { ok: false, expired: true });
    r.done();
    assert.equal((await statusNow(v, h.id, r.dir)).gone, true);
  } finally { r.done(); }
});
