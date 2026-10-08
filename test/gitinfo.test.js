const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseStatus, statusOf } = require('../src/main/gitinfo');

const Z = parts => parts.join('\0') + '\0';

test('parseStatus: branch, upstream, ahead and behind', () => {
  const r = parseStatus(Z(['## main...origin/main [ahead 2, behind 1]']));
  assert.deepEqual([r.branch, r.upstream, r.ahead, r.behind, r.detached, r.files], ['main', 'origin/main', 2, 1, false, []]);
  assert.equal(parseStatus(Z(['## feature/x...origin/feature/x [behind 3]'])).behind, 3);
  assert.equal(parseStatus(Z(['## lonely'])).upstream, null);
  assert.equal(parseStatus(Z(['## No commits yet on main'])).branch, 'main');
  assert.equal(parseStatus(Z(['## HEAD (no branch)'])).detached, true);
});

test('parseStatus: changed files, with a rename taking two entries', () => {
  const r = parseStatus(Z(['## main', ' M src/a.js', 'R  new name.js', 'old name.js', '?? notes/todo.md', 'D  gone.txt']));
  assert.deepEqual(r.files, [
    { code: ' M', path: 'src/a.js' },
    { code: 'R ', path: 'new name.js' },
    { code: '??', path: 'notes/todo.md' },
    { code: 'D ', path: 'gone.txt' },
  ]);
});

test('parseStatus caps the list and counts the rest', () => {
  const r = parseStatus(Z(['## main', ...Array.from({ length: 250 }, (_, i) => `?? f${i}.txt`)]));
  assert.equal(r.files.length, 200);
  assert.equal(r.more, 50);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-git-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('statusOf a real repo, from a subfolder; null outside one', async t => {
  try { execFileSync('git', ['init', '-q', '-b', 'trunk', tmp], { windowsHide: true }); } catch { return t.skip('git is not installed'); }
  fs.mkdirSync(path.join(tmp, 'sub'));
  fs.writeFileSync(path.join(tmp, 'sub', 'new.txt'), 'hi');
  const r = await statusOf(path.join(tmp, 'sub'));
  assert.equal(r.branch, 'trunk');
  assert.equal(path.resolve(r.root).toLowerCase(), path.resolve(tmp).toLowerCase());
  assert.deepEqual(r.files, [{ code: '??', path: 'sub/new.txt' }]);
  assert.equal(await statusOf(os.homedir() === tmp ? 'Z:\\nope' : path.parse(tmp).root + 'definitely-not-here-' + Date.now()), null);
});
