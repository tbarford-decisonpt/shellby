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

test('a 2x2 can still grow sideways; twelve panes is a full grid: only swapping is left', () => {
  const quad = [['a', 'c'], ['b', 'd']];
  assert.deepEqual(P.zones(quad, 'a', 'e').sort(), ['center', 'left', 'right', 'top', 'bottom'].sort());
  const full = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']];
  assert.deepEqual(P.zones(full, 'a', 'x'), ['center']);
  assert.deepEqual(P.place(full, 'x', 'a', 'right'), full, 'a refused split leaves it alone');
  assert.deepEqual(P.place(full, 'x', 'a', 'center')[0][0], 'x');
});

test('a 4x1 strip across a wide screen', () => {
  let g = [['a']];
  for (const id of ['b', 'c', 'd']) g = P.place(g, id, P.ids(g).at(-1), 'right');
  assert.deepEqual(g, [['a'], ['b'], ['c'], ['d']]);
  assert.ok(!P.zones(g, 'd', 'e').includes('right'), 'no fifth column');
  assert.ok(P.zones(g, 'd', 'e').includes('bottom'), 'but a column can stack');
});

test('fitSizes keeps what it knows and fills in the rest', () => {
  const s = P.fitSizes([['a', 'c'], ['b']], { w: { a: 2, b: 1 }, h: { a: 3 } });
  assert.deepEqual(s.w, { a: 2, c: 2, b: 1 }, 'a column carries one width on every pane');
  assert.deepEqual(s.h, { a: 3, c: 3, b: 1 }, 'a new pane gets its column\'s average');
  assert.deepEqual(P.fitSizes([['a']], null), { w: { a: 1 }, h: { a: 1 } });
  assert.deepEqual(P.fitSizes([['a']], { w: { a: -1, zz: 5 }, h: { a: 'x' } }), { w: { a: 1 }, h: { a: 1 } }, 'junk and gone ids dropped');
});

test('a split halves the pane it splits', () => {
  const g = [['a']];
  const right = P.placeSizes(g, null, 'b', 'a', 'right');
  assert.equal(right.w.a, 0.5);
  assert.equal(right.w.b, 0.5);
  const below = P.placeSizes(g, null, 'b', 'a', 'bottom');
  assert.equal(below.h.a, 0.5);
  assert.equal(below.h.b, 0.5);
  assert.equal(below.w.b, 1, 'same column, same width');
});

test('swapping two panes swaps where they are, not the sizes of the slots', () => {
  const g = [['a'], ['b']];
  const s = P.placeSizes(g, { w: { a: 3, b: 1 }, h: { a: 1, b: 1 } }, 'a', 'b', 'center');
  assert.equal(s.w.a, 1, 'a now sits in b\'s narrow slot');
  assert.equal(s.w.b, 3);
});

test('dragging a line moves weight between the two, never below the minimum', () => {
  assert.deepEqual(P.splitPair(1, 1, 500, 500, 100, 280).map(x => +x.toFixed(3)), [1.2, 0.8]);
  const [a, b] = P.splitPair(1, 1, 500, 500, 400, 280);
  assert.equal(+(b / (a + b) * 1000).toFixed(0), 280, 'clamped at 280 px');
  assert.deepEqual(P.splitPair(1, 1, 0, 0, 50, 280), [1, 1], 'nothing on screen: unchanged');
  const [c, d] = P.splitPair(1, 1, 250, 250, 200, 280);
  assert.equal(+(c / (c + d)).toFixed(2), 0.5, 'too small for the minimum: stays even');
});

test('setWeight sets a whole column, or one pane', () => {
  const g = [['a', 'c'], ['b']];
  assert.deepEqual(P.setWeight(g, null, 'w', 0, null, 2).w, { a: 2, c: 2, b: 1 });
  assert.deepEqual(P.setWeight(g, null, 'h', 0, 1, 4).h, { a: 1, c: 4, b: 1 });
});

test('even evens out the columns, or one column\'s panes', () => {
  const g = [['a', 'c'], ['b']];
  const s = { w: { a: 3, c: 3, b: 1 }, h: { a: 5, c: 1, b: 2 } };
  assert.deepEqual(P.even(g, s, 'w').w, { a: 1, c: 1, b: 1 });
  const rows = P.even(g, s, 'h', 0);
  assert.deepEqual([rows.h.a, rows.h.c, rows.h.b], [1, 1, 2], 'only that column');
});

test('clean: a saved layout with gone, duplicate and junk entries', () => {
  const saved = { grid: [['a', 'gone', 'a'], [], ['b', 7], 'x', ['c', 'd', 'e', 'f']], sizes: { w: { a: 2 }, h: {} } };
  const out = P.clean(saved, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(out.grid, [['a'], ['b'], ['c', 'd', 'e']], 'gone, duplicate, non-string and over-cap dropped');
  assert.equal(out.sizes.w.a, 2);
  assert.equal(P.clean(null), null);
  assert.equal(P.clean({ grid: 'nope' }), null);
  assert.equal(P.clean({ grid: [['gone']] }, ['a']), null, 'nothing left: null');
  assert.deepEqual(P.clean({ grid: [['a'], ['b'], ['c'], ['d'], ['e']] }).grid.length, 4, 'no more than four columns');
  assert.equal(P.clean({ grid: [['x'.repeat(300)]] }), null, 'absurd ids dropped');
});

test('neighbor: the pane beside or above, level with this one', () => {
  const g = [['a', 'c'], ['b'], ['d', 'e', 'f']];
  assert.equal(P.neighbor(g, 'a', 'right'), 'b');
  assert.equal(P.neighbor(g, 'c', 'right'), 'b');
  assert.equal(P.neighbor(g, 'b', 'right'), 'e', 'the middle of three');
  assert.equal(P.neighbor(g, 'a', 'down'), 'c');
  assert.equal(P.neighbor(g, 'a', 'up'), null);
  assert.equal(P.neighbor(g, 'a', 'left'), null);
  assert.equal(P.neighbor(g, 'zz', 'left'), null);
});

test('moveToward: swap with the neighbour, or a column of its own at the edge', () => {
  const g = [['a', 'c'], ['b']];
  assert.deepEqual(P.moveToward(g, 'a', 'right'), { target: 'b', zone: 'center' });
  assert.deepEqual(P.moveToward(g, 'c', 'left'), { target: 'a', zone: 'left' });
  assert.equal(P.moveToward(g, 'b', 'right'), null, 'alone in its column: nowhere to go');
  assert.equal(P.moveToward([['a'], ['b'], ['c'], ['d', 'e']], 'e', 'right'), null, 'no fifth column');
  // Up and down: a swap inside the column, and nothing past its ends (it is already the last or first pane there).
  const col = [['a', 'b', 'c'], ['d']];
  assert.deepEqual(P.moveToward(col, 'b', 'down'), { target: 'c', zone: 'center' });
  assert.deepEqual(P.moveToward(col, 'b', 'up'), { target: 'a', zone: 'center' });
  assert.equal(P.moveToward(col, 'c', 'down'), null, 'bottom of its column');
  assert.equal(P.moveToward(col, 'a', 'up'), null, 'top of its column');
  assert.equal(P.moveToward(col, 'd', 'down'), null, 'alone in its column: no column of its own to make');
  assert.equal(P.moveToward(col, 'zzz', 'down'), null, 'not on screen');
});

test('shares: what flex-grow gets, always summing to 1, so a lone pane fills the row', () => {
  const g = [['a']];
  const split = P.placeSizes(g, null, 'b', 'a', 'right');           // a and b at 0.5 each
  const closed = P.remove(P.place(g, 'b', 'a', 'right'), 'b');      // back to [['a']]
  assert.deepEqual(P.shares(closed, split), { cols: [1], rows: [[1]] });
  const s = P.shares([['a', 'c'], ['b']], { w: { a: 3, c: 3, b: 1 }, h: { a: 0.25, c: 0.25, b: 0.5 } });
  assert.deepEqual(s, { cols: [0.75, 0.25], rows: [[0.5, 0.5], [1]] });
});

test('needs: the room a grid takes at the minimum size', () => {
  assert.deepEqual(P.needs([['a'], ['b', 'c']]), { width: 560, height: 400 });
  assert.deepEqual(P.needs([['a']], { width: 10, height: 30 }), { width: 290, height: 230 });
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
