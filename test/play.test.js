const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/main/play');

const work = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 200, height: 180 };

test('he hides fully behind one of your windows, away from where he was', () => {
  const windows = [{ rect: { left: 100, top: 100, right: 1500, bottom: 900 } }];
  const home = { x: 1700, y: 860 };
  for (const r of [0, 0.3, 0.7, 0.999]) {
    const spot = p.chooseHideSpot({ windows, work, size, home }, () => r);
    assert.equal(spot.covered, true);
    assert.ok(spot.x >= 100 + p.HIDE.margin && spot.x + size.width <= 1500 - p.HIDE.margin, `x ${spot.x}`);
    assert.ok(spot.y >= 100 + p.HIDE.margin && spot.y + size.height <= 900 - p.HIDE.margin, `y ${spot.y}`);
    assert.ok(Math.hypot(spot.x - home.x, spot.y - home.y) >= p.HIDE.minAway);
  }
});

test('windows too small to hide behind are ignored; off-screen parts do not count', () => {
  const windows = [{ rect: { left: 10, top: 10, right: 150, bottom: 150 } }, { rect: { left: 1800, top: 900, right: 3000, bottom: 2000 } }];
  const spot = p.chooseHideSpot({ windows, work, size, home: { x: 0, y: 0 } }, () => 0.5);
  assert.equal(spot.covered, false);
});

test('with nothing open he picks the far corner', () => {
  const spot = p.chooseHideSpot({ windows: [], work, size, home: { x: 1700, y: 860 } }, () => 0);
  assert.deepEqual(spot, { x: 0, y: 0, covered: false });
});

test('hints come at their times, then he gives up', () => {
  const game = { hiddenAt: 1000, hints: 0 };
  assert.equal(p.hideStep(game, 1000 + 10000), null);
  assert.deepEqual(p.hideStep(game, 1000 + p.HIDE.hints[0]), { hint: 0 });
  assert.equal(p.hideStep({ ...game, hints: 1 }, 1000 + p.HIDE.hints[0] + 10), null, 'each hint once');
  assert.deepEqual(p.hideStep({ ...game, hints: 1 }, 1000 + p.HIDE.hints[1]), { hint: 1 });
  assert.equal(p.hideStep({ ...game, hints: 3 }, 1000 + p.HIDE.giveUpMs), 'giveup');
  assert.equal(p.hideStep(null, 5), null);
});

test('hide and seek keeps score: finds, his wins and your best time', () => {
  let r = p.hideResult(null, 42000);
  assert.equal(r.best, true);
  r = p.hideResult(r.state, 60000);
  assert.equal(r.best, false);
  r = p.hideResult(r.state, 30000);
  assert.equal(r.best, true);
  r = p.hideResult(r.state, null);
  assert.deepEqual(r.state.hide, { games: 4, found: 3, won: 1, best: 30000 });
});

test('fetch remembers the longest throw', () => {
  let r = p.fetchResult(null, 400);
  assert.equal(r.longest, true);
  r = p.fetchResult(r.state, 200);
  assert.equal(r.longest, false);
  assert.deepEqual(r.state.fetch, { throws: 2, fetched: 2, longest: 400 });
});

test('he stands so the pebble is just in front of his claw, on screen', () => {
  const box = { minX: 0, maxX: 1700 };
  assert.equal(p.pickupX(800, { critterWidth: 200, toySize: 44, box }), 654);
  assert.equal(p.pickupX(-100, { critterWidth: 200, toySize: 44, box }), 0);
  assert.equal(p.pickupX(5000, { critterWidth: 200, toySize: 44, box }), 1700);
});
