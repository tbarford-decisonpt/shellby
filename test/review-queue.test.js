// The review inbox, the sorting half (src/renderer/panel/review-queue.js): who's
// waiting, in what order, and what each row says.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/renderer/panel/review-queue');
const S = require('../src/renderer/panel/tab-sort');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ready = (at, o = {}) => ({ after: A, turnId: 't', files: 2, added: 10, removed: 3, paths: ['a.js', 'b.js'], at, reviewed: false, ...o });
const tab = (id, o = {}) => ({ id, title: id, cwd: 'C:\\code\\app', queue: [], draft: '', ...o });

test('only finished, unreviewed work that changed files is waiting', () => {
  const tabs = [
    tab('waiting', { ready: ready(5), unread: true }),
    tab('seen', { ready: ready(1, { reviewed: true }) }),
    tab('working', { ready: ready(2), busy: true }),
    tab('helpers', { ready: ready(2), crew: 1 }),
    tab('asking', { ready: ready(2), pending: 1 }),
    tab('nothing', { unread: true }),
  ];
  assert.deepEqual(Q.queue(tabs).map(t => t.id), ['waiting']);
});

test('the queue is oldest first, ties in strip order', () => {
  const tabs = [tab('new', { ready: ready(30) }), tab('old', { ready: ready(10) }), tab('mid1', { ready: ready(20) }), tab('mid2', { ready: ready(20) })];
  assert.deepEqual(Q.queue(tabs).map(t => t.id), ['old', 'mid1', 'mid2', 'new']);
});

test('red checks and clashes are flagged but keep their place', () => {
  const tabs = [
    tab('old', { ready: ready(1) }),
    tab('red', { ready: ready(2), checks: { status: 'fail', after: A } }),
  ];
  const items = Q.queue(tabs).map(t => Q.item(t, { clash: t.id === 'old' ? 'Also changed in ⑂ x: a.js' : '' }));
  assert.deepEqual(items.map(i => [i.id, i.flagged]), [['old', true], ['red', true]]);
});

test('the verdict is only about these changes', () => {
  const t = o => tab('t', { ready: ready(1), ...o });
  assert.equal(Q.verdict(t({})), 'none');
  assert.equal(Q.verdict(t({ checks: { status: 'pass', after: A } })), 'pass');
  assert.equal(Q.verdict(t({ checks: { status: 'fail', after: A } })), 'fail');
  assert.equal(Q.verdict(t({ checks: { status: 'timeout', after: A } })), 'fail');
  assert.equal(Q.verdict(t({ checks: { status: 'error', after: A } })), 'error');
  assert.equal(Q.verdict(t({ checks: { status: 'pass', after: B } })), 'none', 'an older turn\'s verdict');
  assert.equal(Q.verdict(t({ checks: { status: 'pass', after: A } }), A), 'running');
  assert.equal(Q.verdict(t({ checks: { status: 'pass', after: A } }), B), 'pass');
  assert.equal(Q.verdict(tab('x')), 'none');
});

test('a row carries the branch for a copy, the paths, and how many more', () => {
  const t = tab('copy', { ready: ready(7, { files: 8, paths: ['1', '2', '3', '4', '5'] }), worktree: { branch: 'shellby/fix', base: 'main' } });
  const it = Q.item(t, { title: 'Fix it' });
  assert.equal(it.title, 'Fix it');
  assert.equal(it.branch, 'shellby/fix');
  assert.deepEqual(it.paths, ['1', '2', '3', '4', '5']);
  assert.equal(it.more, 3);
  assert.equal(Q.filesLine(it), '8 files · +10 −3');
  assert.equal(Q.item(tab('plain', { ready: ready(1) })).branch, null);
});

test('the label reads the row out in full', () => {
  const t = tab('t', { ready: ready(1, { files: 1 }), checks: { status: 'fail', after: A }, worktree: { branch: 'b1' } });
  const label = Q.label(Q.item(t, { title: 'Docs', clash: 'Also changed in your checkout: a.js' }), '5m ago');
  assert.equal(label, 'Docs. on branch b1. 1 file changed, 10 added, 3 removed. Checks failed. Warning: Also changed in your checkout: a.js. Finished 5m ago');
});

test('counts and where to land after a row leaves', () => {
  assert.equal(Q.countLine(0), 'Nothing waiting for review');
  assert.equal(Q.countLine(1), '1 conversation ready to review');
  assert.equal(Q.countLine(3), '3 conversations ready to review');
  assert.equal(Q.landOn(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(Q.landOn(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(Q.landOn(['a'], 'a'), null);
  assert.equal(Q.landOn(['a', 'b'], 'gone'), 'a');
});

test('the overview puts ready-to-review after asking and before finished', () => {
  const tabs = [tab('f', { unread: true }), tab('r', { ready: ready(1), unread: true }), tab('a', { pending: 1, ready: ready(1) })];
  assert.deepEqual(S.groups(tabs).map(g => [g.standing, g.title]), [['asking', 'Waiting for your OK'], ['review', 'Ready to review'], ['finished', 'Finished']]);
  assert.equal(S.standing(tab('w', { busy: true, ready: ready(1) })), 'working');
  assert.equal(S.standing(tab('s', { ready: ready(1, { reviewed: true }) })), 'quiet');
  assert.equal(S.closable(tab('r', { ready: ready(1) }), 'x'), false, 'unreviewed work is not swept away');
});
