const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/renderer/shared/panes');

// A grid of one-tab panes, each pane named for its tab: G([['a'], ['b']]).
const G = cols => cols.map(col => col.map(id => ({ id, tabs: [id], active: id })));
// What each pane shows: the shape the grid had before panes held tabs.
const S = grid => grid.map(col => col.map(p => p.active));
// Each pane's tabs.
const T = grid => grid.map(col => col.map(p => p.tabs));
// Two panes side by side: a and b in the left one (showing a), c on the right.
const two = () => [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }], [{ id: 'p2', tabs: ['c'], active: 'c' }]];

test('reading a grid: its panes, its tabs in turn, what each shows', () => {
  const g = two();
  assert.deepEqual(P.paneIds(g), ['p1', 'p2']);
  assert.equal(P.count(g), 2);
  assert.deepEqual(P.tabIds(g), ['a', 'b', 'c']);
  assert.deepEqual(P.shownTabs(g), ['a', 'c']);
  assert.equal(P.byId(g, 'p2').active, 'c');
  assert.equal(P.paneWith(g, 'b').id, 'p1');
  assert.equal(P.paneWith(g, 'zz'), null);
  assert.deepEqual(P.find(g, 'p2'), { c: 1, r: 0 });
  assert.equal(P.nextId(g), 'p3');
  assert.equal(P.nextId(G([['a']])), 'p1', 'ids that are not pN count as none');
});

test('layoutKey changes when a pane shows another tab, not when its tabs are reordered', () => {
  const g = two();
  assert.notEqual(P.layoutKey(g), P.layoutKey(P.show(g, 'b')));
  assert.equal(P.layoutKey(g), P.layoutKey(P.nudge(g, 'a', 1)));
});

test('a single pane can split any way, or show another of its tabs in the middle', () => {
  const g = [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }]];
  assert.deepEqual(P.zones(g, 'p1', 'b').sort(), ['bottom', 'center', 'left', 'right', 'top']);
  assert.deepEqual(P.zones(g, 'p1', 'a').sort(), ['bottom', 'left', 'right', 'top'], 'the tab it shows has no middle to go to');
  assert.deepEqual(P.zones([[{ id: 'p1', tabs: ['a'], active: 'a' }]], 'p1', 'a'), [], 'its only tab can go nowhere in it');
  assert.deepEqual(P.zones(G([['a']]), 'a', 'new').sort(), ['bottom', 'center', 'left', 'right', 'top']);
  assert.deepEqual(P.zones(G([['a']]), 'gone', 'new'), []);
});

test('splitting to the side makes two columns, on the side it was dropped', () => {
  const right = P.place(G([['a']]), 'b', 'a', 'right');
  assert.deepEqual(S(right), [['a'], ['b']]);
  assert.equal(right[1][0].id, 'p1', 'the new pane gets the next id');
  assert.deepEqual(S(P.place(G([['a']]), 'b', 'a', 'left')), [['b'], ['a']]);
});

test('splitting a column stacks the new pane above or below', () => {
  assert.deepEqual(S(P.place(G([['a'], ['b']]), 'c', 'a', 'bottom')), [['a', 'c'], ['b']]);
  assert.deepEqual(S(P.place(G([['a'], ['b']]), 'c', 'b', 'top')), [['a'], ['c', 'b']]);
});

test('a 2x2 can still grow sideways; twelve panes is a full grid: only joining is left', () => {
  const quad = G([['a', 'c'], ['b', 'd']]);
  assert.deepEqual(P.zones(quad, 'a', 'e').sort(), ['bottom', 'center', 'left', 'right', 'top']);
  const full = G([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']]);
  assert.deepEqual(P.zones(full, 'a', 'x'), ['center']);
  assert.equal(P.place(full, 'x', 'a', 'right'), full, 'a refused split leaves it alone');
  const joined = P.place(full, 'x', 'a', 'center');
  assert.deepEqual(joined[0][0], { id: 'a', tabs: ['a', 'x'], active: 'x' });
});

test('a 4x1 strip across a wide screen', () => {
  let g = G([['a']]);
  for (const id of ['b', 'c', 'd']) g = P.place(g, id, P.paneIds(g).at(-1), 'right');
  assert.deepEqual(S(g), [['a'], ['b'], ['c'], ['d']]);
  const last = P.paneIds(g).at(-1);
  assert.ok(!P.zones(g, last, 'e').includes('right'), 'no fifth column');
  assert.ok(P.zones(g, last, 'e').includes('bottom'), 'but a column can stack');
});

test('leaving: the pane shows the next tab, else the one before; an emptied pane closes', () => {
  assert.deepEqual(P.leave(two(), 'a'), [[{ id: 'p1', tabs: ['b'], active: 'b' }], [{ id: 'p2', tabs: ['c'], active: 'c' }]]);
  assert.deepEqual(P.leave(two(), 'b'), [[{ id: 'p1', tabs: ['a'], active: 'a' }], [{ id: 'p2', tabs: ['c'], active: 'c' }]], 'a tab it doesn\'t show: it keeps showing a');
  assert.deepEqual(P.leave(two(), 'c'), [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }]]);
  assert.equal(P.leave([[{ id: 'p1', tabs: ['a', 'b', 'c'], active: 'b' }]], 'b')[0][0].active, 'c', 'the next one');
  assert.equal(P.leave([[{ id: 'p1', tabs: ['a', 'b', 'c'], active: 'c' }]], 'c')[0][0].active, 'b', 'the last goes: the one before');
  const g = two();
  assert.equal(P.leave(g, 'zz'), g);
});

test('show: a tab in a pane shows there; one in no pane joins the focused pane after the tab it shows', () => {
  assert.deepEqual(P.show(two(), 'b')[0][0], { id: 'p1', tabs: ['a', 'b'], active: 'b' });
  assert.deepEqual(P.show(two(), 'z', 'p1')[0][0], { id: 'p1', tabs: ['a', 'z', 'b'], active: 'z' });
  assert.deepEqual(P.show(two(), 'z', 'p2')[1][0], { id: 'p2', tabs: ['c', 'z'], active: 'z' });
  assert.deepEqual(P.show(two(), 'z', 'gone')[0][0].tabs, ['a', 'z', 'b'], 'no focused pane: the first');
  assert.deepEqual(P.show([], 'z'), [[{ id: 'p1', tabs: ['z'], active: 'z' }]]);
  const g = two();
  assert.equal(P.show(g, 'a'), g, 'already showing: unchanged');
});

test('joining a pane: where it\'s dropped on the strip, or at the end; its old pane closes if emptied', () => {
  assert.deepEqual(P.join(two(), 'c', 'p1', 'b'), [[{ id: 'p1', tabs: ['a', 'c', 'b'], active: 'c' }]]);
  assert.deepEqual(P.join(two(), 'c', 'p1'), [[{ id: 'p1', tabs: ['a', 'b', 'c'], active: 'c' }]]);
  assert.deepEqual(P.join(two(), 'b', 'p1', 'a'), [[{ id: 'p1', tabs: ['b', 'a'], active: 'a' }], [{ id: 'p2', tabs: ['c'], active: 'c' }]], 'along its own strip: reordered, still showing a');
  const g = two();
  assert.equal(P.join(g, 'a', 'p1', 'b'), g, 'already there');
  assert.equal(P.join(g, 'b', 'p1', 'gone'), g, 'unknown neighbour');
  assert.equal(P.join(g, 'c', 'gone'), g, 'unknown pane');
  assert.equal(P.join(g, 'b', 'p1', 'b'), g, 'in front of itself');
  assert.deepEqual(T(P.place(g, 'c', 'p1', 'strip', 'a')), [[['c', 'a', 'b']]], 'place with the strip zone joins');
});

test('splitting one off: a tab from a pane holding others gets a pane of its own', () => {
  assert.deepEqual(P.place(two(), 'b', 'p1', 'right'), [[{ id: 'p1', tabs: ['a'], active: 'a' }], [{ id: 'p3', tabs: ['b'], active: 'b' }], [{ id: 'p2', tabs: ['c'], active: 'c' }]]);
  assert.deepEqual(P.place(two(), 'a', 'p1', 'bottom')[0], [{ id: 'p1', tabs: ['b'], active: 'b' }, { id: 'p3', tabs: ['a'], active: 'a' }]);
  const lone = [[{ id: 'p1', tabs: ['a'], active: 'a' }]];
  assert.equal(P.place(lone, 'a', 'p1', 'right'), lone, 'a pane\'s only tab can\'t split off it');
  assert.deepEqual(P.place(two(), 'b', 'p1', 'center')[0][0], { id: 'p1', tabs: ['a', 'b'], active: 'b' }, 'its own pane\'s middle shows it there');
  const g = two();
  assert.equal(P.place(g, 'a', 'p1', 'center'), g, 'the tab a pane shows, dropped on its middle: nothing to do');
});

test('a pane\'s x moves its tabs into the pane beside it, keeping the order of every tab', () => {
  const g = [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }, { id: 'p2', tabs: ['c'], active: 'c' }], [{ id: 'p3', tabs: ['d'], active: 'd' }]];
  assert.deepEqual(P.merge(g, 'p2'), { grid: [[{ id: 'p1', tabs: ['a', 'b', 'c'], active: 'a' }], [{ id: 'p3', tabs: ['d'], active: 'd' }]], into: 'p1' }, 'into the one above, after its tabs');
  assert.deepEqual(P.merge(g, 'p1'), { grid: [[{ id: 'p2', tabs: ['a', 'b', 'c'], active: 'c' }], [{ id: 'p3', tabs: ['d'], active: 'd' }]], into: 'p2' }, 'into the one below, in front of its tabs');
  assert.deepEqual(P.merge(g, 'p3'), { grid: [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }, { id: 'p2', tabs: ['c', 'd'], active: 'c' }]], into: 'p2' }, 'alone in its column: into the one level with it on the left');
  for (const id of P.paneIds(g)) assert.deepEqual(P.tabIds(P.merge(g, id).grid), P.tabIds(g), `closing ${id} keeps every tab, in order`);
  const lone = G([['a']]);
  assert.deepEqual(P.merge(lone, 'a'), { grid: lone, into: null }, 'the last pane can\'t close');
  assert.deepEqual(P.merge(g, 'gone'), { grid: g, into: null });
});

test('settle: a closed tab leaves its pane; one that turned up joins the focused pane', () => {
  assert.deepEqual(P.settle(two(), ['a', 'b', 'c', 'new'], 'p2')[1][0], { id: 'p2', tabs: ['c', 'new'], active: 'c' });
  assert.deepEqual(P.settle(two(), ['a', 'b', 'c', 'new'], null)[0][0].tabs, ['a', 'b', 'new'], 'no focused pane: the first');
  assert.deepEqual(P.settle(two(), ['a', 'c'], 'p1'), [[{ id: 'p1', tabs: ['a'], active: 'a' }], [{ id: 'p2', tabs: ['c'], active: 'c' }]]);
  assert.deepEqual(P.settle(two(), ['c'], null), [[{ id: 'p2', tabs: ['c'], active: 'c' }]], 'a pane left with none closes');
  assert.deepEqual(P.settle([], ['x', 'y']), [[{ id: 'p1', tabs: ['x', 'y'], active: 'x' }]], 'nothing yet: one pane with them all');
  assert.deepEqual(P.settle([], []), []);
  const g = two();
  assert.equal(P.settle(g, ['a', 'b', 'c'], 'p1'), g, 'nothing to do: unchanged');
});

test('follow: one pane holds its tabs in the strip\'s own order; a split is left alone', () => {
  assert.deepEqual(P.follow([[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }]], ['b', 'a']), [[{ id: 'p1', tabs: ['b', 'a'], active: 'a' }]]);
  const lone = [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }]];
  assert.equal(P.follow(lone, ['a', 'b']), lone);
  const g = two();
  assert.equal(P.follow(g, ['c', 'b', 'a']), g);
});

test('nudge moves a tab one place along its pane\'s strip, and no further than its ends', () => {
  const g = [[{ id: 'p1', tabs: ['a', 'b', 'c'], active: 'a' }]];
  assert.deepEqual(T(P.nudge(g, 'a', 1)), [[['b', 'a', 'c']]]);
  assert.deepEqual(T(P.nudge(g, 'c', -1)), [[['a', 'c', 'b']]]);
  assert.equal(P.nudge(g, 'a', -1), g);
  assert.equal(P.nudge(g, 'c', 1), g);
  assert.equal(P.nudge(g, 'zz', 1), g);
});

test('fitSizes keeps what it knows and fills in the rest', () => {
  const s = P.fitSizes(G([['a', 'c'], ['b']]), { w: { a: 2, b: 1 }, h: { a: 3 } });
  assert.deepEqual(s.w, { a: 2, c: 2, b: 1 }, 'a column carries one width on every pane');
  assert.deepEqual(s.h, { a: 3, c: 3, b: 1 }, 'a new pane gets its column\'s average');
  assert.deepEqual(P.fitSizes(G([['a']]), null), { w: { a: 1 }, h: { a: 1 } });
  assert.deepEqual(P.fitSizes(G([['a']]), { w: { a: -1, zz: 5 }, h: { a: 'x' } }), { w: { a: 1 }, h: { a: 1 } }, 'junk and gone ids dropped');
});

test('a split halves the pane it splits; joining leaves the sizes as they are', () => {
  const g = G([['a']]);
  const right = P.placeSizes(g, null, 'b', 'a', 'right');
  assert.equal(right.w.a, 0.5);
  assert.equal(right.w.p1, 0.5, 'keyed by the new pane\'s id');
  const below = P.placeSizes(g, null, 'b', 'a', 'bottom');
  assert.equal(below.h.a, 0.5);
  assert.equal(below.h.p1, 0.5);
  assert.equal(below.w.p1, 1, 'same column, same width');
  const sizes = { w: { a: 3, b: 1 }, h: { a: 1, b: 1 } };
  assert.deepEqual(P.placeSizes(G([['a'], ['b']]), sizes, 'a', 'b', 'center'), sizes);
  assert.deepEqual(P.placeSizes(G([['a'], ['b']]), sizes, 'a', 'b', 'strip'), sizes);
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
  const g = G([['a', 'c'], ['b']]);
  assert.deepEqual(P.setWeight(g, null, 'w', 0, null, 2).w, { a: 2, c: 2, b: 1 });
  assert.deepEqual(P.setWeight(g, null, 'h', 0, 1, 4).h, { a: 1, c: 4, b: 1 });
});

test('even evens out the columns, or one column\'s panes', () => {
  const g = G([['a', 'c'], ['b']]);
  const s = { w: { a: 3, c: 3, b: 1 }, h: { a: 5, c: 1, b: 2 } };
  assert.deepEqual(P.even(g, s, 'w').w, { a: 1, c: 1, b: 1 });
  const rows = P.even(g, s, 'h', 0);
  assert.deepEqual([rows.h.a, rows.h.c, rows.h.b], [1, 1, 2], 'only that column');
});

test('neighbor: the pane beside or above, level with this one', () => {
  const g = G([['a', 'c'], ['b'], ['d', 'e', 'f']]);
  assert.equal(P.neighbor(g, 'a', 'right'), 'b');
  assert.equal(P.neighbor(g, 'c', 'right'), 'b');
  assert.equal(P.neighbor(g, 'b', 'right'), 'e', 'the middle of three');
  assert.equal(P.neighbor(g, 'a', 'down'), 'c');
  assert.equal(P.neighbor(g, 'a', 'up'), null);
  assert.equal(P.neighbor(g, 'a', 'left'), null);
  assert.equal(P.neighbor(g, 'zz', 'left'), null);
});

test('moveToward: into the neighbouring pane, where it joins; or a column of its own at the edge', () => {
  const g = G([['a', 'c'], ['b']]);
  assert.deepEqual(P.moveToward(g, 'a', 'right'), { target: 'b', zone: 'center' });
  const moved = P.place(g, 'a', 'b', 'center');
  assert.deepEqual(S(moved), [['c'], ['a']], 'it shows where it went');
  assert.deepEqual(T(moved), [[['c']], [['b', 'a']]], 'after that pane\'s tabs; its own pane closed');
  assert.deepEqual(P.moveToward(g, 'c', 'left'), { target: 'a', zone: 'left' }, 'sharing a column: a column of its own');
  assert.equal(P.moveToward(g, 'b', 'right'), null, 'alone in its column and its pane: nowhere to go');
  const group = [[{ id: 'p1', tabs: ['a', 'b'], active: 'a' }]];
  assert.deepEqual(P.moveToward(group, 'a', 'right'), { target: 'p1', zone: 'right' }, 'a pane with others: it splits off');
  assert.deepEqual(P.place(group, 'a', 'p1', 'right'), [[{ id: 'p1', tabs: ['b'], active: 'b' }], [{ id: 'p2', tabs: ['a'], active: 'a' }]]);
  assert.equal(P.moveToward(G([['a'], ['b'], ['c'], ['d', 'e']]), 'e', 'right'), null, 'no fifth column');
  // Up and down: into the pane above or below, and nothing past the column's ends.
  const col = G([['a', 'b', 'c'], ['d']]);
  assert.deepEqual(P.moveToward(col, 'b', 'down'), { target: 'c', zone: 'center' });
  assert.deepEqual(P.moveToward(col, 'b', 'up'), { target: 'a', zone: 'center' });
  assert.equal(P.moveToward(col, 'c', 'down'), null, 'bottom of its column');
  assert.equal(P.moveToward(col, 'a', 'up'), null, 'top of its column');
  assert.equal(P.moveToward(col, 'd', 'down'), null, 'alone in its column');
  assert.equal(P.moveToward(col, 'zzz', 'down'), null, 'in no pane');
});

test('shares: what flex-grow gets, always summing to 1, so a lone pane fills the row', () => {
  const split = P.placeSizes(G([['a']]), null, 'b', 'a', 'right');   // a and p1 at 0.5 each
  assert.deepEqual(P.shares(G([['a']]), split), { cols: [1], rows: [[1]] });
  const s = P.shares(G([['a', 'c'], ['b']]), { w: { a: 3, c: 3, b: 1 }, h: { a: 0.25, c: 0.25, b: 0.5 } });
  assert.deepEqual(s, { cols: [0.75, 0.25], rows: [[0.5, 0.5], [1]] });
});

test('needs: the room a grid takes at the minimum size', () => {
  assert.deepEqual(P.needs(G([['a'], ['b', 'c']])), { width: 560, height: 400 });
  assert.deepEqual(P.needs(G([['a']]), { width: 10, height: 30 }), { width: 290, height: 230 });
});

test('clean: a saved layout with gone, duplicate and junk entries', () => {
  const saved = {
    grid: [
      [{ id: 'p1', tabs: ['a', 'gone', 'a'], active: 'gone' }, 'nope'],
      [],
      [{ id: 'p1', tabs: ['b', 7], active: 'b' }],
      'x',
      [{ id: 'p4', tabs: ['c'] }, { id: 'p5', tabs: ['d'] }, { id: 'p6', tabs: ['e'] }, { id: 'p7', tabs: ['f'] }],
    ],
    sizes: { w: { p1: 2 }, h: {} },
  };
  const out = P.clean(saved, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(out.grid, [
    [{ id: 'p1', tabs: ['a'], active: 'a' }],
    [{ id: 'p7', tabs: ['b'], active: 'b' }],
    [{ id: 'p4', tabs: ['c'], active: 'c' }, { id: 'p5', tabs: ['d'], active: 'd' }, { id: 'p6', tabs: ['e'], active: 'e' }],
  ], 'gone, duplicate and non-string tabs dropped, its active put right, a duplicate pane id renewed, over the caps dropped');
  assert.equal(out.sizes.w.p1, 2);
  assert.equal(P.clean(null), null);
  assert.equal(P.clean({ grid: 'nope' }), null);
  assert.equal(P.clean({ grid: [[{ id: 'p1', tabs: ['gone'] }]] }, ['a']), null, 'nothing left: null');
  assert.equal(P.clean({ grid: [['a'], ['b'], ['c'], ['d'], ['e']] }).grid.length, 4, 'no more than four columns');
  assert.equal(P.clean({ grid: [[{ id: 'p1', tabs: ['x'.repeat(300)] }]] }), null, 'absurd ids dropped');
});

test('clean: ids every object already has are junk, as tabs and as panes, so the sizes stay numbers', () => {
  const saved = JSON.parse('{"grid":[[{"id":"__proto__","tabs":["__proto__","a"],"active":"a"}],[{"id":"constructor","tabs":["constructor"]}],[{"id":"p2","tabs":["toString","b"],"active":"toString"}]],"sizes":{"w":{"__proto__":9,"p2":1},"h":{}}}');
  const out = P.clean(saved);
  assert.deepEqual(out.grid, [[{ id: 'p3', tabs: ['a'], active: 'a' }], [{ id: 'p2', tabs: ['b'], active: 'b' }]]);
  assert.equal(Object.getPrototypeOf(out.sizes.w), Object.prototype);
  assert.deepEqual(P.shares(out.grid, out.sizes).cols, [0.5, 0.5]);
});

test('clean: a layout saved with one tab per pane reads as panes of one tab each, its sizes kept', () => {
  const old = { grid: [['a', 'c'], ['b']], sizes: { w: { a: 2, c: 2, b: 1 }, h: { a: 3, c: 1, b: 1 } } };
  const out = P.clean(old, ['a', 'b', 'c']);
  assert.deepEqual(out.grid, [[{ id: 'p1', tabs: ['a'], active: 'a' }, { id: 'p2', tabs: ['c'], active: 'c' }], [{ id: 'p3', tabs: ['b'], active: 'b' }]]);
  assert.deepEqual(out.sizes, { w: { p1: 2, p2: 2, p3: 1 }, h: { p1: 3, p2: 1, p3: 1 } });
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

// Until tab-panes.js moves to panes (Task 4 deletes these and this test).
test('compatibility shims read a grid of tab ids, as the panel keeps it until it catches up', () => {
  const old = [['a', 'c'], ['b']];
  assert.deepEqual(P.ids(old), ['a', 'c', 'b']);
  assert.deepEqual(P.ids(two()), ['a', 'c'], 'a pane counts as the tab it shows');
  assert.equal(P.has(old, 'c'), true);
  assert.deepEqual(P.remove(old, 'c'), [['a'], ['b']]);
  assert.deepEqual(P.keep(old, id => id !== 'b'), [['a', 'c']]);
  assert.deepEqual(P.replace([['a'], ['b']], 'b', 'c'), [['a'], ['c']]);
  assert.deepEqual(P.replace([['a'], ['b']], 'gone', 'c'), [['c'], ['b']]);
  assert.deepEqual(P.replace([], null, 'c'), [['c']]);
  assert.deepEqual(P.fitSizes([['a']], null), { w: { a: 1 }, h: { a: 1 } });
  assert.deepEqual(P.shares([['a']], null), { cols: [1], rows: [[1]] });
});
