// A conversation's outline (src/main/outline.js): each message you sent and
// the files its turn touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { outline } = require('../src/main/outline');

test('each message, oldest first, with the files its diff names', () => {
  const items = [
    { kind: 'user', turnId: 't1', text: 'Fix the  login\nbug', t: 1 },
    { kind: 'tool', id: 'a', name: 'Edit', filePath: 'C:\\p\\src\\login.js' },
    { kind: 'changes', turnId: 't1', files: [{ path: 'src/login.js', status: 'M', added: 3, removed: 1 }], added: 3, removed: 1 },
    { kind: 'user', turnId: 't2', text: 'Now the tests', t: 2 },
    { kind: 'tool', id: 'b', name: 'Bash' },
  ];
  const o = outline(items);
  assert.deepEqual(o.map(t => [t.turnId, t.text, t.tools]), [['t1', 'Fix the login bug', 1], ['t2', 'Now the tests', 1]]);
  assert.deepEqual(o[0].files, [{ path: 'src/login.js', status: 'M', added: 3, removed: 1 }]);
  assert.deepEqual([o[0].added, o[0].removed], [3, 1]);
  assert.deepEqual(o[1].files, []);
});

test('without a diff (no git), the files Claude edited stand in', () => {
  const o = outline([
    { kind: 'user', turnId: 't1', text: 'x' },
    { kind: 'tool', id: 'a', name: 'Write', filePath: 'C:\\p\\a.txt' },
    { kind: 'tool', id: 'b', name: 'Edit', filePath: 'C:\\p\\a.txt' },
    { kind: 'tool', id: 'c', name: 'Edit', filePath: 'C:\\p\\b.txt', sub: true },
  ]);
  assert.deepEqual(o[0].files, [{ path: 'C:\\p\\a.txt' }]);
});

test('only since the last /clear, and a message that was only attachments says so', () => {
  const o = outline([
    { kind: 'user', turnId: 'old', text: 'before' },
    { kind: 'cleared' },
    { kind: 'user', turnId: 't1', attachments: [{}, {}] },
  ]);
  assert.deepEqual(o.map(t => t.text), ['2 attached files']);
  assert.deepEqual(outline(null), []);
});
