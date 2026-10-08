const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/renderer/shared/panes');

test('a single pane can split any way, or be swapped in the middle', () => {
  assert.deepEqual(P.zones([['a']], 'a', 'b').sort(), ['bottom', 'center', 'left', 'right', 'top']);
});

test('splitting to the side makes two columns, on the side it was dropped', () => {
  assert.deepEqual(P.place([['a']], 'b', 'a', 'right'), [['a'], ['b']]);
  assert.deepEqual(P.place([['a']], 'b', 'a', 'left'), [['b'], ['a']]);
});

test('splitting a column stacks the new pane above or below', () => {
  assert.deepEqual(P.place([['a'], ['b']], 'c', 'a', 'bottom'), [['a', 'c'], ['b']]);
  assert.deepEqual(P.place([['a'], ['b']], 'c', 'b', 'top'), [['a'], ['c', 'b']]);
});

test('four panes is a full grid: only swapping is left', () => {
  const quad = [['a', 'c'], ['b', 'd']];
  assert.deepEqual(P.zones(quad, 'a', 'e'), ['center']);
  assert.deepEqual(P.place(quad, 'e', 'a', 'right'), quad, 'a refused split leaves it alone');
  assert.deepEqual(P.place(quad, 'e', 'a', 'center'), [['e', 'c'], ['b', 'd']]);
});

test('dropping a pane on another swaps them', () => {
  assert.deepEqual(P.place([['a'], ['b']], 'a', 'b', 'center'), [['b'], ['a']]);
});

test('a pane already on screen moves rather than appearing twice', () => {
  assert.deepEqual(P.place([['a', 'b']], 'b', 'a', 'right'), [['a'], ['b']]);
  assert.deepEqual(P.place([['a'], ['b']], 'b', 'a', 'bottom'), [['a', 'b']]);
  // Its own column is counted as already gone when deciding what fits.
  assert.ok(P.zones([['a', 'c'], ['b']], 'a', 'c').includes('bottom'));
});

test('dropping a pane on itself changes nothing', () => {
  assert.deepEqual(P.place([['a'], ['b']], 'a', 'a', 'right'), [['a'], ['b']]);
});

test('closing a pane closes up its column', () => {
  assert.deepEqual(P.remove([['a', 'c'], ['b']], 'c'), [['a'], ['b']]);
  assert.deepEqual(P.remove([['a'], ['b']], 'b'), [['a']]);
  assert.deepEqual(P.remove([['a']], 'a'), []);
});

test('replace puts a conversation in the focused pane, or starts the grid', () => {
  assert.deepEqual(P.replace([['a'], ['b']], 'b', 'c'), [['a'], ['c']]);
  assert.deepEqual(P.replace([['a'], ['b']], 'gone', 'c'), [['c'], ['b']]);
  assert.deepEqual(P.replace([], null, 'c'), [['c']]);
  assert.deepEqual(P.replace([['a'], ['b']], 'a', 'b'), [['a'], ['b']], 'already showing: left where it is');
});

test('the pointer picks the nearest edge it may split, else the middle', () => {
  const r = { left: 0, top: 0, width: 100, height: 100 };
  const all = ['center', 'left', 'right', 'top', 'bottom'];
  assert.equal(P.zoneAt(r, 5, 50, all), 'left');
  assert.equal(P.zoneAt(r, 95, 50, all), 'right');
  assert.equal(P.zoneAt(r, 50, 90, all), 'bottom');
  assert.equal(P.zoneAt(r, 50, 50, all), 'center');
  assert.equal(P.zoneAt(r, 5, 50, ['center', 'top', 'bottom']), 'center', 'no room for a column');
});

test('the preview shows the half the new pane will take', () => {
  const view = { left: 0, top: 0, width: 200, height: 100 };
  const pane = { left: 0, top: 0, width: 100, height: 100 };
  assert.deepEqual(P.previewRect('right', pane, view), { left: 100, top: 0, width: 100, height: 100 });
  assert.deepEqual(P.previewRect('bottom', pane, view), { left: 0, top: 50, width: 100, height: 50 });
  assert.deepEqual(P.previewRect('center', pane, view), pane);
});

test('layout gives every pane a header row, and a lone pane the full column', () => {
  assert.deepEqual(P.layout([['a']]), { cols: 1, rows: 1, cells: [{ id: 'a', col: 1, head: 1, feed: '2 / span 1' }] });
  assert.deepEqual(P.layout([['a', 'c'], ['b']]).cells, [
    { id: 'a', col: 1, head: 1, feed: '2 / span 1' },
    { id: 'c', col: 1, head: 3, feed: '4 / span 1' },
    { id: 'b', col: 2, head: 1, feed: '2 / span 3' },
  ]);
});
