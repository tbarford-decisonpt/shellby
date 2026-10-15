const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rank, mention, withFolders, list } = require('../src/main/fileindex');

const files = [
  'README.md',
  'package.json',
  'src/main/main.js',
  'src/main/session.js',
  'src/main/sessions.js',
  'src/renderer/panel/tabs.js',
  'test/session.test.js',
  'docs/My Notes.md',
];

test('rank: the file name itself beats a match in its folders', () => {
  assert.equal(rank(files, 'session')[0], 'src/main/session.js');
  assert.equal(rank(files, 'tabs')[0], 'src/renderer/panel/tabs.js');
});

test('rank: letters in order match across the path, like a file picker', () => {
  assert.ok(rank(files, 'smsj').includes('src/main/session.js'));
  assert.deepEqual(rank(files, 'zzz'), []);
});

test('rank: backslashes and case do not matter', () => {
  assert.equal(rank(files, 'SRC\\MAIN\\MAIN')[0], 'src/main/main.js');
});

test('rank: an empty query lists short, shallow paths first, up to the limit', () => {
  const top = rank(files, '', 3);
  assert.equal(top.length, 3);
  assert.deepEqual(top.slice(0, 2).sort(), ['README.md', 'package.json'], `expected the top-level files first, got ${top}`);
  assert.equal(top[2].split('/').length, 2, 'then one folder down');
});

test('withFolders: folders are offered too, ending in a slash', () => {
  const all = withFolders(['src/main/a.js', 'src/b.js']);
  assert.ok(all.includes('src/'));
  assert.ok(all.includes('src/main/'));
  assert.ok(all.includes('src/main/a.js'));
});

test('mention: quoted when the path has a space', () => {
  assert.equal(mention('src/main.js'), '@src/main.js');
  assert.equal(mention('docs/My Notes.md'), '@"docs/My Notes.md"');
});

test('list: outside git, walks the folder and skips node_modules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-files-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), '');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), '');
    const entries = await list(dir);
    assert.ok(entries.includes('src/app.js'));
    assert.ok(entries.includes('src/'));
    assert.ok(!entries.some(e => e.startsWith('node_modules')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list: cached for a while, unless asked for a fresh one, which is cached in its place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-files-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), '');
    assert.deepEqual(await list(dir), ['a.js']);
    fs.mkdirSync(path.join(dir, 'new'));
    fs.writeFileSync(path.join(dir, 'new', 'b.js'), '');
    assert.ok(!(await list(dir)).includes('new/b.js'), 'the cached list, made before it');
    const fresh = await list(dir, { fresh: true });
    assert.ok(fresh.includes('new/b.js') && fresh.includes('new/'), fresh.join(', '));
    assert.ok((await list(dir)).includes('new/b.js'), 'and the next plain call has it too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list: a folder that is not there lists nothing', async () => {
  assert.deepEqual(await list(path.join(os.tmpdir(), 'shellby-no-such-folder-xyz')), []);
  assert.deepEqual(await list('relative/path'), []);
});

test('onForget hears every forget, and a listener that throws harms nothing', () => {
  const { forget, onForget } = require('../src/main/fileindex');
  const heard = [];
  onForget(() => { throw new Error('boom'); });
  onForget(cwd => heard.push(cwd));
  forget('C:\\somewhere');
  forget(42);
  assert.deepEqual(heard, ['C:\\somewhere']);
});

test('lists past their time are dropped on the next request, not kept until 20 newer folders push them out', async t => {
  const fileindex = require('../src/main/fileindex');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-fi-cache-'));
  const dirs = ['a', 'b', 'c'].map(n => { const d = path.join(base, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'x.txt'), ''); return d; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const before = fileindex.cachedCount();
    await list(dirs[0]);
    await list(dirs[1]);
    assert.equal(fileindex.cachedCount(), before + 2);
    t.mock.timers.tick(fileindex.CACHE_MS + 1);
    await list(dirs[2]);
    assert.equal(fileindex.cachedCount(), 1, 'only the fresh list is left');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
