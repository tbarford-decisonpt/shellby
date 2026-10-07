// What each try is given of the message's attachments (src/main/try-files.js):
// project files point at the try's own copy, files the copy lacks get a
// snapshot per try, and everything else goes as it is.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tryFiles = require('../src/main/try-files');

// Real paths: CI's temp folder is an 8.3 short name, and git reports the long one.
const tmp = prefix => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function layout() {
  const base = tmp('try-files-');
  const repo = path.join(base, 'repo');
  const copies = [1, 2].map(i => path.join(base, 'worktrees', `c${i}`, 'repo'));
  for (const dir of [repo, ...copies]) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'login.js'), `// ${dir}\n`);
  }
  fs.writeFileSync(path.join(repo, 'notes.md'), 'uncommitted notes\n'); // only in your checkout
  const shot = path.join(base, 'data', 'screenshots', 'screenshot-1.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, 'png');
  return { base, repo, copies, shot, store: i => path.join(base, 'data', 'try-files', 'run-0000-1111', String(i)) };
}

test('placeIn: relative to the first root that holds it, or null', () => {
  const root = path.resolve('/code/app');
  assert.equal(tryFiles.placeIn(path.join(root, 'src', 'a.js'), [root]), path.join('src', 'a.js'));
  assert.equal(tryFiles.placeIn(path.resolve('/code/other/a.js'), [root]), null);
  assert.equal(tryFiles.placeIn(path.resolve('/code/app-two/a.js'), [root]), null); // a sibling with the same start
  assert.equal(tryFiles.placeIn(root, [root]), null);                               // the folder itself
  assert.equal(tryFiles.placeIn(path.join(root, 'a.js'), [null, '', root]), 'a.js');
});

test('clean keeps local absolute paths, at most one message\'s worth', () => {
  const ok = path.resolve('/code/app/a.js');
  assert.deepEqual(tryFiles.clean([ok, 'relative.js', '\\\\server\\share\\x.png', '//server/share/x', 42, null, `${ok}\0x`]), [ok]);
  assert.equal(tryFiles.clean(Array.from({ length: 30 }, (_, i) => path.resolve(`/f${i}.txt`))).length, tryFiles.MAX_FILES);
  assert.deepEqual(tryFiles.clean('nope'), []);
});

test('forTry: a project file is the copy\'s own, a missing one is snapshotted per try, others stay', () => {
  const t = layout();
  try {
    const files = [path.join(t.repo, 'src', 'login.js'), path.join(t.repo, 'notes.md'), t.shot];
    const one = tryFiles.forTry(files, { roots: [t.repo], copy: { path: t.copies[0] }, store: t.store(1) }).files;
    const two = tryFiles.forTry(files, { roots: [t.repo], copy: { path: t.copies[1] }, store: t.store(2) }).files;

    assert.equal(one[0], path.join(t.copies[0], 'src', 'login.js'));
    assert.equal(two[0], path.join(t.copies[1], 'src', 'login.js'));
    // Not in the copies (uncommitted): a snapshot each, never your checkout's file.
    assert.equal(one[1], path.join(t.store(1), 'notes.md'));
    assert.equal(two[1], path.join(t.store(2), 'notes.md'));
    assert.equal(fs.readFileSync(one[1], 'utf8'), 'uncommitted notes\n');
    fs.writeFileSync(one[1], 'try 1 changed it');
    assert.equal(fs.readFileSync(two[1], 'utf8'), 'uncommitted notes\n');
    assert.equal(fs.readFileSync(path.join(t.repo, 'notes.md'), 'utf8'), 'uncommitted notes\n');
    // A screenshot from the data folder goes as it is.
    assert.equal(one[2], t.shot);
    assert.equal(two[2], t.shot);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('forTry: a file from the copy the message was typed in maps to each try\'s copy too', () => {
  const t = layout();
  try {
    const from = path.join(t.copies[0], 'src', 'login.js');
    const r = tryFiles.forTry([from], { roots: [t.repo, t.copies[0]], copy: { path: t.copies[1] }, store: t.store(1) });
    assert.deepEqual(r, { files: [path.join(t.copies[1], 'src', 'login.js')], left: [] });
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('forTry: two snapshots with one name both survive; a folder or a missing file is left off, never your checkout\'s', () => {
  const t = layout();
  try {
    fs.mkdirSync(path.join(t.repo, 'docs'));
    fs.writeFileSync(path.join(t.repo, 'docs', 'notes.md'), 'other notes\n');
    const files = [path.join(t.repo, 'notes.md'), path.join(t.repo, 'docs', 'notes.md'), path.join(t.repo, 'docs'), path.join(t.repo, 'gone.txt')];
    const { files: r, left } = tryFiles.forTry(files, { roots: [t.repo], copy: { path: t.copies[0] }, store: t.store(1) });
    assert.equal(fs.readFileSync(r[0], 'utf8'), 'uncommitted notes\n');
    assert.equal(fs.readFileSync(r[1], 'utf8'), 'other notes\n');
    assert.notEqual(r[0], r[1]);
    assert.equal(r.length, 2);
    assert.deepEqual(left, [files[2], files[3]]);
    assert.deepEqual(tryFiles.inProject([files[2], t.shot], [t.repo]), [files[2]]);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('forTry: a link in the copy that points out of it is not the copy\'s file', () => {
  const t = layout();
  try {
    const outside = path.join(t.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.png'), 'not yours');
    fs.mkdirSync(path.join(t.repo, 'assets'));
    fs.writeFileSync(path.join(t.repo, 'assets', 'secret.png'), 'the checkout\'s');
    fs.symlinkSync(outside, path.join(t.copies[0], 'assets'), 'junction');
    const file = path.join(t.repo, 'assets', 'secret.png');
    const { files } = tryFiles.forTry([file], { roots: [t.repo], copy: { path: t.copies[0] }, store: t.store(1) });
    assert.equal(fs.readFileSync(files[0], 'utf8'), 'the checkout\'s', 'a snapshot of the attached file instead');
    assert.ok(files[0].startsWith(t.store(1)));
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('clean: \\??\\ paths are not local either', () => {
  assert.deepEqual(tryFiles.clean(['\\??\\UNC\\attacker\\share\\x.png']), []);
});

test('prune: runs older than 30 days go, newer ones and anything else stay', () => {
  const dir = tmp('try-files-prune-');
  try {
    const old = path.join(dir, '0123abcd-0000-4000-8000-000000000000');
    const fresh = path.join(dir, '89abcdef-0000-4000-8000-000000000000');
    const other = path.join(dir, 'keep me');
    for (const d of [old, fresh, other]) fs.mkdirSync(path.join(d, '1'), { recursive: true });
    const past = new Date(Date.now() - 31 * 86400000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(other, past, past);
    assert.equal(tryFiles.prune(dir), 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(fresh), 'keep me'].sort());
    assert.equal(tryFiles.prune(path.join(dir, 'missing')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
