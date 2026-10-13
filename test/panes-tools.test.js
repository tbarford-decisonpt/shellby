const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/renderer/shared/panes');

const LOG = 'server:srv-abcd1234';
// What each pane shows.
const S = grid => grid.map(col => col.map(p => p.active));
// One pane of conversations a and b, showing a.
const one = () => [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }]];
// That pane with a server's log beside it.
const withLog = () => P.openTool(one(), LOG, 'p1');

test('a tool id names its kind and what it shows; anything else is a conversation', () => {
  assert.equal(P.isTool(LOG), true);
  assert.deepEqual(P.toolOf(LOG), { kind: 'server', target: 'srv-abcd1234' });
  assert.equal(P.isTool('a'), false);
  assert.equal(P.isTool('server:'), false);
  assert.equal(P.isTool('file:C:\\x'), false, 'only the kinds there are');
  assert.equal(P.toolOf('a'), null);
});

test('opening a tool puts it in a pane of its own to the right; opening it again shows that pane', () => {
  const g = withLog();
  assert.deepEqual(S(g), [['a'], [LOG]]);
  assert.deepEqual(P.openTool(g, LOG, 'p1'), g);
  const shown = P.openTool(P.leave(g, LOG), LOG, 'p1');
  assert.deepEqual(S(shown), [['a'], [LOG]]);
});

test('a tool opens below when four columns are taken, and not at all in a full column then', () => {
  const four = [0, 1, 2, 3].map(i => [{ id: `p${i + 1}`, tabs: [`t${i}`], active: `t${i}` }]);
  assert.deepEqual(S(P.openTool(four, LOG, 'p2'))[1], ['t1', LOG]);
  const full = four.map((col, c) => (c === 1 ? [...col, { id: 'p8', tabs: ['x'], active: 'x' }, { id: 'p9', tabs: ['y'], active: 'y' }] : col));
  assert.equal(P.openTool(full, LOG, 'p2'), full);
});

test('a tool is never one of the conversations main keeps', () => {
  const g = withLog();
  assert.deepEqual(P.tabIds(g), ['a', 'b']);
  assert.deepEqual(P.toolIds(g), [LOG]);
});

test('settling keeps tools, and conversations never land in a tool pane', () => {
  const g = withLog();
  assert.deepEqual(P.toolIds(P.settle(g, ['a', 'b'])), [LOG]);
  const joined = P.settle(g, ['a', 'b', 'c'], 'p2');
  assert.deepEqual(P.byId(joined, 'p2').tabs, [LOG]);
  assert.deepEqual(P.paneWith(joined, 'c').id, 'p1');
  const onlyTool = P.leave(P.leave(g, 'a'), 'b');
  assert.deepEqual(S(onlyTool), [[LOG]]);
  const back = P.settle(onlyTool, ['c']);
  assert.deepEqual(S(back), [['c'], [LOG]], 'a conversation with no pane of its kind gets one, on the left');
  assert.deepEqual(S(P.show(onlyTool, 'c', 'p2')), [['c'], [LOG]]);
});

test('tools are not dragged, and nothing is dropped on them', () => {
  const g = withLog();
  assert.deepEqual(P.zones(g, 'p2', 'b'), []);
  assert.deepEqual(P.zones(g, 'p1', LOG), []);
  assert.equal(P.place(g, 'b', 'p2', 'center'), g);
  assert.equal(P.join(g, 'b', 'p2'), g);
  assert.equal(P.join(g, LOG, 'p1'), g);
  assert.equal(P.moveToward(g, LOG, 'left'), null);
  assert.deepEqual(P.moveToward(g, 'a', 'right'), { target: 'p1', zone: 'right' }, 'the tool pane takes no conversations: a column of its own instead');
});

test("a tool pane's x closes the tool; a conversation pane's x never sends its tabs into a tool pane", () => {
  const g = withLog();
  const gone = P.merge(g, 'p2');
  assert.deepEqual(S(gone.grid), [['a']]);
  assert.equal(gone.into, 'p1');
  assert.deepEqual(P.merge(g, 'p1'), { grid: g, into: null }, 'the last conversation pane stays');
  const three = P.openTool([[{ id: 'p1', tabs: ['a'], active: 'a' }], [{ id: 'p2', tabs: ['b'], active: 'b' }]], LOG, 'p1');
  const m = P.merge(three, 'p1');
  assert.equal(m.into, 'p2');
  assert.deepEqual(P.byId(m.grid, 'p2').tabs, ['a', 'b']);
});

test('a lone tool pane keeps its tab when the strip order is followed', () => {
  const lone = [[{ id: 'p2', tabs: [LOG], active: LOG }]];
  assert.equal(P.follow(lone, ['a']), lone);
});

test('a named layout leaves the tools out; a saved one never brings them back', () => {
  const g = withLog();
  const shape = { name: 'x', cols: [{ w: 1, rows: [1] }, { w: 1, rows: [1] }] };
  assert.equal(P.shapeNeeds(shape, g), 1, 'the log fills no pane: one more conversation is needed');
  assert.deepEqual(S(P.fromShape(shape, g, ['c']).grid), [['a'], ['c']]);
  assert.equal(P.count(P.clean({ grid: g }).grid), 1, 'one pane once the log is dropped');
  assert.deepEqual(P.toolIds(P.clean({ grid: [...g, [{ id: 'p3', tabs: ['c'], active: 'c' }]] }).grid), []);
});
