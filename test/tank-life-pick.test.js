const { test } = require('node:test');
const assert = require('node:assert/strict');
const TL = require('../src/renderer/panel/tank-life');

const piece = (uid, spots, extra = {}) => ({ uid, name: `Piece ${uid}`, x: 20 * uid, y: 40, w: 10, h: 8, row: 0, flip: false, layer: 'floor', spots, ...extra });
// A seeded generator, so a run is the same every time.
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('spotsOf puts each spot in the tank, flipped with its piece, never on a floater', () => {
  const [s] = TL.spotsOf([piece(1, [{ kind: 'sit', at: [2, -1] }])]);
  assert.deepEqual({ x: s.x, y: s.y, kind: s.kind }, { x: 22, y: 32, kind: 'sit' });
  const [f] = TL.spotsOf([piece(1, [{ kind: 'sit', at: [2, -1] }], { flip: true })]);
  assert.equal(f.x, 20 + 10 - 1 - 2);
  assert.equal(TL.spotsOf([piece(1, [{ kind: 'sit', at: [0, 0] }], { layer: 'float' })]).length, 0);
});

test('pick is the same for the same seed', () => {
  const spots = TL.spotsOf([piece(1, [{ kind: 'hide', at: [1, 1] }]), piece(2, [{ kind: 'nibble', at: [1, 1] }]), piece(3, [{ kind: 'climb', at: [1, 1] }])]);
  const run = () => { const r = seeded(7); return Array.from({ length: 20 }, () => TL.pick({ spots, rand: r })); };
  assert.deepEqual(run(), run());
});

test('he only sleeps at night, and at night he goes to bed', () => {
  const spots = TL.spotsOf([piece(1, [{ kind: 'sleep', at: [1, 1] }]), piece(2, [{ kind: 'sit', at: [1, 1] }])]);
  const r = seeded(3);
  for (let i = 0; i < 200; i++) assert.notEqual(TL.pick({ spots, rand: r })?.kind, 'sleep');
  assert.equal(TL.pick({ spots, night: true, rand: r }).kind, 'sleep');
  // No bed: at night he does what he'd do by day.
  const noBed = spots.filter(s => s.kind !== 'sleep');
  assert.notEqual(TL.pick({ spots: noBed, night: true, rand: () => 0.9 })?.kind, 'sleep');
});

test('a new piece gets a look first; his favourite comes up more often', () => {
  const spots = TL.spotsOf([piece(1, [{ kind: 'sit', at: [1, 1] }]), piece(2, [{ kind: 'sit', at: [1, 1] }])]);
  const look = TL.pick({ spots, news: [9, 2], rand: () => 0.99 });
  assert.equal(look.kind, 'look');
  assert.equal(look.uid, 2);
  const r = seeded(11);
  const n = { 1: 0, 2: 0 };
  for (let i = 0; i < 2000; i++) { const a = TL.pick({ spots, favourite: 2, rand: r }); if (a) n[a.uid]++; }
  assert.ok(n[2] > n[1] * 2, JSON.stringify(n));
});

test('an empty tank means wandering, and where he stands stays in the tank', () => {
  assert.equal(TL.pick({ spots: [], rand: () => 0.5 }), null);
  const spots = TL.spotsOf([piece(5, [{ kind: 'sit', at: [9, 1] }])]);
  const a = TL.pick({ spots, rand: () => 0.99, maxX: 60, crabW: 22 });
  assert.ok(a.x >= 0 && a.x <= 60);
  for (const kind of Object.keys(TL.DURATION)) assert.ok(TL.DURATION[kind][0] <= TL.DURATION[kind][1]);
});

test('pose: hiding shows nothing, then his eye stalks; sitting lifts him; sleeping has z\'s', () => {
  const spot = { x: 30, y: 30, name: 'Castle' };
  const at = (kind, t, ms = 1000) => TL.pose({ kind, spot, ms }, t, { crabY: 50, crabH: 13 });
  assert.equal(at('hide', 0).crop, 0);
  assert.equal(at('hide', 900).crop, TL.PEEK_ROWS);
  assert.equal(at('sit', 500).lift, 20);
  assert.ok(at('climb', 500).lift > at('climb', 100).lift);
  assert.equal(at('climb', 1000).lift, 0, 'and back down');
  assert.equal(at('sleep', 500).z, true);
  assert.deepEqual(TL.pose(null, 0, { crabY: 50, crabH: 13 }), { lift: 0, crop: null, hop: 0, z: false, face: 0 });
  assert.match(TL.describe({ kind: 'hide', spot }), /hiding in the castle/);
});

test('moving day: pieces hop in one by one, then he follows', () => {
  const pieces = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];
  const start = TL.moving(pieces, 0);
  assert.equal(start.dy.get(3), null, 'not across yet');
  assert.equal(start.crabIn, 0);
  const end = TL.moving(pieces, 60000);
  assert.ok([...end.dy.values()].every(v => v === 0));
  assert.equal(end.done, true);
});
