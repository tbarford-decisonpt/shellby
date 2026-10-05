// Clash warnings across copies (src/main/clash.js): which copies changed the
// same files, in what order they're listed, and which clashes are news.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const clash = require('../src/main/clash');

const ROOT = 'C:\\code\\shop';
const copy = (tabId, files, o = {}) => ({ tabId, title: `T ${tabId}`, branch: `shellby/${tabId}-abc123`, base: 'main', root: ROOT, files, ...o });
const checkout = (files, o = {}) => ({ checkout: true, root: ROOT, branch: 'main', files, ...o });

test('returns no clashes when copies changed different files', () => {
  const r = clash.findClashes([copy('a', ['src/a.js']), copy('b', ['src/b.js'])]);
  assert.deepEqual(r, []);
});

test('returns no clashes for a single copy with nothing else in its repository', () => {
  assert.deepEqual(clash.findClashes([copy('a', ['src/a.js'])]), []);
});

test('flags two copies that changed the same file, with who and what', () => {
  const r = clash.findClashes([copy('a', ['src/merge.js', 'src/a.js']), copy('b', ['src/merge.js'])]);
  assert.equal(r.length, 1);
  assert.equal(r[0].root, ROOT);
  assert.equal(r[0].base, 'main');
  assert.deepEqual(r[0].files, ['src/merge.js']);
  assert.equal(r[0].more, 0);
  assert.deepEqual(r[0].copies.map(c => c.tabId), ['a', 'b']);
  assert.deepEqual(r[0].copies[0], { tabId: 'a', title: 'T a', branch: 'shellby/a-abc123' });
});

test('three copies on one file make one clash, not three pairs', () => {
  const r = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js']), copy('c', ['x.js'])]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].copies.map(c => c.tabId), ['a', 'b', 'c']);
});

test('files shared by different sets of copies make separate clashes', () => {
  const r = clash.findClashes([copy('a', ['x.js', 'y.js']), copy('b', ['x.js', 'y.js']), copy('c', ['y.js'])]);
  assert.equal(r.length, 2);
  const pair = r.find(c => c.copies.length === 2);
  const trio = r.find(c => c.copies.length === 3);
  assert.deepEqual(pair.files, ['x.js']);
  assert.deepEqual(trio.files, ['y.js']);
});

test('copies going home to different branches never clash with each other', () => {
  const r = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js'], { base: 'develop' })]);
  assert.deepEqual(r, []);
});

test('copies of different repositories never clash', () => {
  const r = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js'], { root: 'C:\\code\\other' })]);
  assert.deepEqual(r, []);
});

test('the same repository matches whatever the case or slashes of its path', () => {
  const r = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js'], { root: 'c:/Code/Shop/' })]);
  assert.equal(r.length, 1);
});

test('your checkout clashes with a copy that changed a file you have uncommitted', () => {
  const r = clash.findClashes([copy('a', ['src/merge.js']), checkout(['src/merge.js', 'notes.md'])]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].files, ['src/merge.js']);
  assert.deepEqual(r[0].copies[1], { checkout: true, tabId: null, title: 'your checkout', branch: 'main' });
});

test('your checkout clashes with copies of any base in its repository', () => {
  const r = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js'], { base: 'develop' }), checkout(['x.js'])]);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(c => c.base).sort(), ['develop', 'main']);
  assert.ok(r.every(c => c.copies.some(m => m.checkout)));
});

test('a checkout on its own clashes with nothing', () => {
  assert.deepEqual(clash.findClashes([checkout(['x.js'])]), []);
});

test('lists written files before lockfiles, alphabetically, deduped', () => {
  const files = ['package-lock.json', 'src/z.js', 'src/a.js', 'src/a.js', 'yarn.lock', 'README.md'];
  const r = clash.findClashes([copy('a', files), copy('b', files)]);
  assert.deepEqual(r[0].files, ['README.md', 'src/a.js', 'src/z.js', 'package-lock.json', 'yarn.lock']);
});

test('caps the files listed and counts the rest', () => {
  const files = Array.from({ length: clash.MAX_FILES + 3 }, (_, i) => `f${String(i).padStart(2, '0')}.js`);
  const r = clash.findClashes([copy('a', files), copy('b', files)]);
  assert.equal(r[0].files.length, clash.MAX_FILES);
  assert.equal(r[0].more, 3);
});

test('orders clashes the same way whatever order the copies come in', () => {
  const list = [copy('a', ['x.js']), copy('b', ['x.js']), copy('c', ['y.js']), copy('d', ['y.js'], { root: 'C:\\code\\api' }), copy('e', ['y.js'], { root: 'C:\\code\\api' })];
  const one = clash.findClashes(list);
  const two = clash.findClashes([...list].reverse());
  assert.deepEqual(one.map(c => c.key), two.map(c => c.key));
  assert.equal(one[0].root, 'C:\\code\\api');
});

test('skips malformed entries and the same tab listed twice', () => {
  const r = clash.findClashes([null, { tabId: 'x' }, copy('a', ['x.js']), copy('a', ['x.js']), copy('', ['x.js']), copy('b', 'x.js'), copy('c', ['x.js'], { base: '' })]);
  assert.deepEqual(r, []);
});

test('a copy with no title is named by its branch', () => {
  const r = clash.findClashes([copy('a', ['x.js'], { title: '' }), copy('b', ['x.js'])]);
  assert.equal(r[0].copies[0].title, 'shellby/a-abc123');
});

test('freshClashes returns every clash when there were none before', () => {
  const next = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js'])]);
  assert.equal(clash.freshClashes([], next).length, 1);
  assert.equal(clash.freshClashes(undefined, next).length, 1);
});

test('freshClashes ignores more files on a pair that already clashed', () => {
  const prev = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js'])]);
  const next = clash.findClashes([copy('a', ['x.js', 'y.js']), copy('b', ['x.js', 'y.js'])]);
  assert.deepEqual(clash.freshClashes(prev, next), []);
});

test('freshClashes reports a third copy joining an existing clash', () => {
  const prev = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js']), copy('c', [])]);
  const next = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js']), copy('c', ['x.js'])]);
  const fresh = clash.freshClashes(prev, next);
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0].copies.map(c => c.tabId), ['a', 'b', 'c']);
});

test('freshClashes reports a clash that went away and came back', () => {
  const on = clash.findClashes([copy('a', ['x.js']), copy('b', ['x.js'])]);
  assert.equal(clash.freshClashes([], on).length, 1);
  assert.deepEqual(clash.freshClashes(on, on), []);
});

test('freshClashes tells your checkout in one repository from another', () => {
  const prev = clash.findClashes([copy('a', ['x.js']), checkout(['x.js'])]);
  const next = clash.findClashes([
    copy('a', ['x.js']), checkout(['x.js']),
    copy('b', ['x.js'], { root: 'C:\\code\\api' }), checkout(['x.js'], { root: 'C:\\code\\api' }),
  ]);
  assert.deepEqual(clash.freshClashes(prev, next).map(c => c.root), ['C:\\code\\api']);
});

test('parseStatusZ reads changed, added, untracked and both ends of a rename', () => {
  const out = [' M src/a.js', '?? new file.txt', 'A  src/b.js', 'R  src/new.js', 'src/old.js', '!! node_modules/', ''].join('\0');
  assert.deepEqual(clash.parseStatusZ(out), ['src/a.js', 'new file.txt', 'src/b.js', 'src/new.js', 'src/old.js']);
});

test('parseStatusZ returns nothing for a clean folder', () => {
  assert.deepEqual(clash.parseStatusZ(''), []);
  assert.deepEqual(clash.parseStatusZ(undefined), []);
});

test('parseNamesZ splits git diff --name-only -z output', () => {
  assert.deepEqual(clash.parseNamesZ('a.js\0src/b c.js\0'), ['a.js', 'src/b c.js']);
  assert.deepEqual(clash.parseNamesZ(''), []);
});

test('isLockfile knows lockfiles in any folder, any case', () => {
  assert.equal(clash.isLockfile('package-lock.json'), true);
  assert.equal(clash.isLockfile('api/Cargo.lock'), true);
  assert.equal(clash.isLockfile('src/lock.js'), false);
});
