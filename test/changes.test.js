// A turn's diff, against a real git repo in a temp folder: the whole point is
// that git's own behaviour (temp index, untracked files, restore) is what we
// rely on, so it's git that gets tested, not a mock of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { snapshot, summarize, patchFor, undo, parseDiffSummary, checkRef } = require('../src/main/changes');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-changes-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'core.autocrlf', 'false'); // the machine's own setting would rewrite line endings on restore
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  return { dir, g, write, read, exists: f => fs.existsSync(path.join(dir, f)), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('parseDiffSummary reads numstat and name-status, binaries included', () => {
  const files = parseDiffSummary('3\t1\ta.txt\0-\t-\timg.png\0', 'M\0a.txt\0A\0img.png\0');
  assert.deepEqual(files, [
    { path: 'a.txt', status: 'M', added: 3, removed: 1, binary: false },
    { path: 'img.png', status: 'A', added: 0, removed: 0, binary: true },
  ]);
});

test('checkRef refuses anything that is not a snapshot of a project', () => {
  const ok = { root: path.resolve(os.tmpdir()), before: 'a'.repeat(40), after: 'b'.repeat(40) };
  assert.equal(checkRef(ok), null);
  assert.ok(checkRef({ ...ok, root: 'relative' }));
  assert.ok(checkRef({ ...ok, before: 'HEAD' }), 'a ref name is not a tree id');
  assert.ok(checkRef({ ...ok, after: '--output=x' }));
  assert.ok(checkRef({ ...ok, file: '../../etc/passwd' }));
  assert.ok(checkRef({ ...ok, file: 'C:\\Windows\\x' }));
  assert.equal(checkRef({ ...ok, file: 'src/a.js' }), null);
});

test('a folder that is not a git repo has no snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-nogit-'));
  try { assert.equal(await snapshot(dir), null); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a turn shows edits, new files and deletions, and leaves the index alone', async () => {
  const r = repo();
  try {
    r.write('staged.txt', 'mine');
    r.g('add', 'staged.txt'); // something you staged yourself
    const before = await snapshot(r.dir);
    r.write('a.txt', 'one\nTWO\nthree\n');
    r.write('src/new.js', 'x\n');
    r.write('ignored/big.log', 'noise');
    fs.rmSync(path.join(r.dir, 'gone.txt'));
    const after = await snapshot(r.dir);
    const s = await summarize(before, after);
    assert.deepEqual(s.files.map(f => [f.path, f.status]).sort(), [['a.txt', 'M'], ['gone.txt', 'D'], ['src/new.js', 'A']]);
    assert.equal(s.added, 3);
    assert.equal(s.removed, 2);
    assert.ok(!s.files.some(f => f.path.startsWith('ignored/')), 'ignored files stay out');
    assert.equal(r.g('diff', '--cached', '--name-only').trim(), 'staged.txt', 'your staging area is exactly as you left it');
    const p = await patchFor({ ...s, file: 'a.txt' });
    assert.match(p.patch, /^-two$/m);
    assert.match(p.patch, /^\+TWO$/m);
  } finally { r.done(); }
});

test('nothing changed is no diff at all', async () => {
  const r = repo();
  try {
    const a = await snapshot(r.dir);
    const b = await snapshot(r.dir);
    assert.equal(await summarize(a, b), null);
  } finally { r.done(); }
});

test('undo puts edits back, removes new files and restores deleted ones', async () => {
  const r = repo();
  try {
    const before = await snapshot(r.dir);
    r.write('a.txt', 'changed\n');
    r.write('new.txt', 'new');
    fs.rmSync(path.join(r.dir, 'gone.txt'));
    const s = await summarize(before, await snapshot(r.dir));
    const u = await undo(s);
    assert.deepEqual(u, { ok: true, restored: 3 });
    assert.equal(r.read('a.txt'), 'one\ntwo\n');
    assert.equal(r.exists('new.txt'), false);
    assert.equal(r.read('gone.txt'), 'bye\n');
  } finally { r.done(); }
});

test('undo treats a file named like a glob as that one file', async () => {
  const r = repo();
  try {
    if (process.platform === 'win32') return; // Windows won't make a file called "*.txt" anyway
    const before = await snapshot(r.dir);
    r.write('*.txt', 'odd\n');
    const s = await summarize(before, await snapshot(r.dir));
    r.write('a.txt', 'yours, later\n');
    assert.deepEqual(await undo(s), { ok: true, restored: 1 });
    assert.equal(r.read('a.txt'), 'yours, later\n', 'a.txt was not "matched"');
  } finally { r.done(); }
});

test('undo refuses when a file changed again after the turn, and touches nothing', async () => {
  const r = repo();
  try {
    const before = await snapshot(r.dir);
    r.write('a.txt', 'turn\n');
    r.write('b.txt', 'turn\n');
    const s = await summarize(before, await snapshot(r.dir));
    r.write('a.txt', 'yours, later\n');
    const u = await undo(s);
    assert.equal(u.ok, false);
    assert.deepEqual(u.changedSince, ['a.txt']);
    assert.equal(r.read('a.txt'), 'yours, later\n');
    assert.equal(r.read('b.txt'), 'turn\n', 'not even the files that could have gone back');
  } finally { r.done(); }
});
