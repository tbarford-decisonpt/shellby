const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { listFiles, rankFiles, withFolders, walk } = require('../src/main/fileindex');

const LIST = withFolders([
  'package.json', 'README.md', 'src/main/main.js', 'src/main/session.js', 'src/main/sessions.js',
  'src/renderer/panel/main-menu.js', 'test/session.test.js', 'docs/SKINS.md',
]);
const paths = r => r.map(x => x.path);

test('withFolders adds every folder a file is in, ending in /', () => {
  assert.deepEqual(withFolders(['a/b/c.js', 'a/d.js', 'e.js']), ['a/', 'a/b/', 'a/b/c.js', 'a/d.js', 'e.js']);
});

test('a name match beats a path match beats scattered letters, and shorter wins ties', () => {
  assert.deepEqual(paths(rankFiles(LIST, 'session', 3)), ['src/main/session.js', 'src/main/sessions.js', 'test/session.test.js']);
  assert.equal(rankFiles(LIST, 'main', 1)[0].path, 'src/main/');
  assert.equal(rankFiles(LIST, 'main.js', 1)[0].path, 'src/main/main.js');
  assert.equal(rankFiles(LIST, 'SKINS', 1)[0].path, 'docs/SKINS.md');
  assert.equal(rankFiles(LIST, 'smmjs', 1)[0].path, 'src/main/main.js');
  assert.deepEqual(rankFiles(LIST, 'zzz'), []);
});

test('typed paths match with either slash, and folders are flagged', () => {
  assert.equal(rankFiles(LIST, 'src\\renderer', 1)[0].path, 'src/renderer/');
  assert.equal(rankFiles(LIST, './src/main/m', 1)[0].path, 'src/main/main.js');
  assert.equal(rankFiles(LIST, 'docs', 1)[0].dir, true);
  assert.equal(rankFiles(LIST, 'README', 1)[0].dir, false);
});

test('an empty query lists the top of the folder first', () => {
  assert.deepEqual(paths(rankFiles(LIST, '', 5)), ['docs/', 'src/', 'test/', 'package.json', 'README.md']);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-files-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };

test('outside git: a walk that skips node_modules, .git and other dot folders', async () => {
  const dir = path.join(tmp, 'plain');
  for (const f of ['a.txt', 'sub/b.md', 'node_modules/x/index.js', '.hidden/secret', '.claude/settings.json']) put(`plain/${f}`);
  const files = (await walk(dir)).sort();
  assert.deepEqual(files, ['.claude/settings.json', 'a.txt', 'sub/b.md']);
});

test('in a git repo: tracked and untracked files, minus ignored ones', async t => {
  const dir = path.join(tmp, 'repo');
  try { execFileSync('git', ['init', '-q', dir], { windowsHide: true }); } catch { return t.skip('git is not installed'); }
  put('repo/.gitignore', 'ignored.log\n');
  put('repo/kept.js');
  put('repo/ignored.log');
  put('repo/deep/er/file.ts');
  const list = await listFiles(dir);
  assert.ok(list.includes('kept.js'));
  assert.ok(list.includes('deep/er/file.ts'));
  assert.ok(list.includes('deep/'));
  assert.ok(!list.includes('ignored.log'));
  // Cached: the same promise comes back within the TTL.
  assert.equal(listFiles(dir), listFiles(dir));
});
