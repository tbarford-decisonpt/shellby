const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/main/tank-tidy');

const entry = (ref, category, w = 6, layer = 'floor') => [ref, { ref, category, layer, w, h: 4 }];
const lib = new Map([
  entry('find:rubber-duck', 'find', 5),
  entry('find:sea-glass', 'find', 4),
  entry('castle-keep', 'structure', 16),
  entry('kelp', 'plant', 6, 'back'),
  entry('jelly-lamp', 'bubbler', 6, 'float'),
]);
const NOW = 10 * T.DAY;
const OLD = NOW - 2 * T.DAY;
const tankOf = (placed, editedAt = OLD) => ({ size: 'nano', placed: placed.map((p, i) => ({ uid: i + 1, row: 1, z: 0, ...p })), editedAt });
const seq = (...xs) => { let i = 0; return () => xs[Math.min(i++, xs.length - 1)]; };

test('normalize: on unless turned off, never throws', () => {
  for (const junk of [null, 3, [], 'x']) assert.deepEqual(T.normalize(junk), { on: true, at: 0, last: null });
  assert.equal(T.normalize({ on: false }).on, false);
  assert.equal(T.normalize({ last: { uid: 1, ref: '<x>', from: 1, to: 2 } }).last, null);
});

test('he moves one find a few pixels towards the piece beside it', () => {
  const st = tankOf([{ ref: 'find:rubber-duck', x: 10 }, { ref: 'castle-keep', x: 40 }]);
  const m = T.pick(st, { lib, now: NOW, rand: seq(0, 0, 0) });
  assert.equal(m.uid, 1);
  assert.equal(m.from, 10);
  assert.ok(m.to > 10 && m.to - 10 <= 6, `moved ${m.to - 10}`);
  const after = T.apply(st, m);
  assert.equal(after.placed[0].x, m.to);
  assert.equal(after.placed[1].x, 40, 'the castle never moves');
  assert.equal(st.placed[0].x, 10, 'a new tank, the old one untouched');
});

test('he never moves structures, plants, floating pieces or stickers', () => {
  const st = tankOf([{ ref: 'castle-keep', x: 10 }, { ref: 'kelp', x: 50, row: 0 }, { ref: 'jelly-lamp', x: 70 }]);
  assert.equal(T.pick(st, { lib, now: NOW, rand: () => 0 }), null);
});

test('not in a tank changed in the last day, not twice in a day, not when turned off, and only some days', () => {
  const placed = [{ ref: 'find:rubber-duck', x: 10 }, { ref: 'castle-keep', x: 40 }];
  assert.equal(T.pick(tankOf(placed, NOW - 1000), { lib, now: NOW, rand: () => 0 }), null);
  assert.equal(T.pick(tankOf(placed), { lib, now: NOW, tidy: { at: NOW - 1000 }, rand: () => 0 }), null);
  assert.equal(T.pick(tankOf(placed), { lib, now: NOW, tidy: { on: false }, rand: () => 0 }), null);
  assert.equal(T.pick(tankOf(placed), { lib, now: NOW, rand: () => T.CHANCE }), null);
});

test('a find already snug beside its neighbour stays put', () => {
  const st = tankOf([{ ref: 'find:sea-glass', x: 20 }, { ref: 'find:rubber-duck', x: 21 }]);
  assert.equal(T.pick(st, { lib, now: NOW, rand: seq(0, 0, 0) }), null);
});

test('put it back undoes his move, unless the piece has moved on since', () => {
  const st = tankOf([{ ref: 'find:rubber-duck', x: 10 }, { ref: 'castle-keep', x: 40 }]);
  const m = T.pick(st, { lib, now: NOW, rand: seq(0, 0, 0) });
  const moved = T.apply(st, m);
  assert.equal(T.undo(moved, m).placed[0].x, 10);
  const youMovedIt = { ...moved, placed: moved.placed.map(p => (p.uid === 1 ? { ...p, x: 30 } : p)) };
  assert.equal(T.undo(youMovedIt, m), null);
  assert.equal(T.undo(moved, null), null);
});
