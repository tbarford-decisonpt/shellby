// Sorting open conversations (src/renderer/panel/tab-sort.js): where each tab
// stands, the grouped list, what "close quiet ones" may touch, and what the
// strip's edge markers report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/panel/tab-sort');

const tab = (id, o = {}) => ({ id, title: id, cwd: 'C:\\code\\app', queue: [], draft: '', ...o });

test('standing ranks asking over working over finished over quiet', () => {
  assert.equal(S.standing(tab('a', { pending: 1, busy: true })), 'asking');
  assert.equal(S.standing(tab('b', { busy: true, unread: true })), 'working');
  assert.equal(S.standing(tab('c', { crew: 2 })), 'working');
  assert.equal(S.standing(tab('d', { unread: true, outcome: 'error' })), 'finished');
  assert.equal(S.standing(tab('e', { outcome: 'error' })), 'quiet');
  assert.equal(S.standing(tab('f', { queuePaused: true, queue: [{ text: 'next' }] })), 'finished');
  assert.equal(S.standing(tab('g')), 'quiet');
});

test('groups come in urgency order, keep strip order, and drop empty groups', () => {
  const tabs = [tab('q1'), tab('w1', { busy: true }), tab('a1', { pending: 1 }), tab('q2'), tab('f1', { unread: true })];
  const g = S.groups(tabs);
  assert.deepEqual(g.map(x => x.standing), ['asking', 'finished', 'working', 'quiet']);
  assert.deepEqual(g.find(x => x.standing === 'quiet').tabs.map(t => t.id), ['q1', 'q2']);
  assert.deepEqual(S.groups([tab('q')]).map(x => x.title), ['Quiet']);
});

test('filter needs every word, in the title or the folder', () => {
  const tabs = [tab('Fix login', { cwd: 'C:\\code\\shop' }), tab('Write docs', { cwd: 'C:\\code\\app' })];
  assert.deepEqual(S.groups(tabs, 'login shop').flatMap(g => g.tabs.map(t => t.id)), ['Fix login']);
  assert.deepEqual(S.groups(tabs, 'APP').flatMap(g => g.tabs.map(t => t.id)), ['Write docs']);
  assert.deepEqual(S.groups(tabs, 'nothing'), []);
  assert.equal(S.groups(tabs, '   ').flatMap(g => g.tabs).length, 2);
});

test('closable spares the open tab, anything not quiet, and unsent work', () => {
  assert.equal(S.closable(tab('q'), 'other'), true);
  assert.equal(S.closable(tab('q'), 'q'), false);
  assert.equal(S.closable(tab('w', { busy: true }), 'x'), false);
  assert.equal(S.closable(tab('u', { unread: true }), 'x'), false);
  assert.equal(S.closable(tab('d', { draft: 'half a thought' }), 'x'), false);
  assert.equal(S.closable(tab('d', { draft: '   ' }), 'x'), true);
  assert.equal(S.closable(tab('k', { queue: [{ text: 'later' }] }), 'x'), false);
  assert.equal(S.closable(tab('f', { attachments: ['C:\\shot.png'] }), 'x'), false);
});

test('edges count tabs less than half in view and point at the nearest most urgent one', () => {
  // Ten 100px tabs; the view shows 300..600.
  const standings = ['quiet', 'asking', 'quiet', 'quiet', 'quiet', 'quiet', 'finished', 'quiet', 'finished', 'asking'];
  const items = standings.map((s, i) => ({ id: `t${i}`, left: i * 100, width: 100, standing: s }));
  const e = S.edges(items, { scrollLeft: 300, width: 300 });
  assert.deepEqual(e.left, { count: 3, standing: 'asking', target: 't1' });
  assert.deepEqual(e.right, { count: 4, standing: 'asking', target: 't9' });
  const near = S.edges(items.slice(0, 9), { scrollLeft: 300, width: 300 });
  assert.deepEqual(near.right, { count: 3, standing: 'finished', target: 't6' });
});

test('edges report nothing when every tab is in view', () => {
  const items = [0, 1, 2].map(i => ({ id: `t${i}`, left: i * 100, width: 100, standing: 'quiet' }));
  assert.deepEqual(S.edges(items, { scrollLeft: 0, width: 300 }), { left: null, right: null });
  // Half in view counts as in view.
  assert.equal(S.edges(items, { scrollLeft: 50, width: 250 }).left, null);
});
