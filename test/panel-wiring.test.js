// The panel making room for a workflow map (wiring/panel.js): which way it
// grows, when it can't, and the size it goes back to after being moved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron } = require('./helpers/fake-ipc');

installFakeElectron();
const { grownBounds, shrunkBounds, ROOMY } = require('../src/main/wiring/panel');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };

test('a panel in the bottom right grows up and to the left, keeping that corner', () => {
  const b = { x: 1400, y: 300, width: 460, height: 700 };
  const g = grownBounds(b, WA);
  assert.equal(g.right, true);
  assert.equal(g.low, true);
  assert.equal(g.set.width, ROOMY.width);
  assert.equal(g.set.height, ROOMY.height);
  assert.equal(g.set.x + g.set.width, b.x + b.width, 'right edge stays put');
  assert.equal(g.set.y + g.set.height, b.y + b.height, 'bottom edge stays put');
});

test('a panel in the top left grows down and to the right', () => {
  const b = { x: 20, y: 20, width: 460, height: 700 };
  const g = grownBounds(b, WA);
  assert.equal(g.right, false);
  assert.equal(g.low, false);
  assert.deepEqual({ x: g.set.x, y: g.set.y }, { x: 20, y: 20 });
});

test('growing never leaves the work area, gap included', () => {
  const wa = { x: 1920, y: 0, width: 1280, height: 1000 };
  const g = grownBounds({ x: 1930, y: 10, width: 460, height: 700 }, wa);
  assert.equal(g.set.width, Math.min(ROOMY.width, wa.width - ROOMY.gap * 2));
  assert.ok(g.set.x >= wa.x + ROOMY.gap);
  assert.ok(g.set.x + g.set.width <= wa.x + wa.width - ROOMY.gap);
  assert.ok(g.set.y >= wa.y + ROOMY.gap);
  assert.ok(g.set.y + g.set.height <= wa.y + wa.height - ROOMY.gap);
});

test('a taller panel keeps its height when it grows wider', () => {
  const g = grownBounds({ x: 100, y: 50, width: 460, height: 900 }, WA);
  assert.equal(g.set.height, 900);
});

test('no room to make on a small screen, or on a panel already that big', () => {
  assert.equal(grownBounds({ x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 800, height: 600 }), null);
  assert.equal(grownBounds({ x: 0, y: 0, width: 1200, height: 800 }, WA), null);
});

test('moved since it grew: back to its old size, from the corner it grew from', () => {
  const from = { x: 1400, y: 300, width: 460, height: 700 };
  const moved = { x: 500, y: 100, width: ROOMY.width, height: ROOMY.height };
  const back = shrunkBounds({ from, right: true, low: true }, moved, WA);
  assert.equal(back.width, from.width);
  assert.equal(back.height, from.height);
  assert.equal(back.x + back.width, moved.x + moved.width);
  assert.equal(back.y + back.height, moved.y + moved.height);
  const topLeft = shrunkBounds({ from, right: false, low: false }, moved, WA);
  assert.deepEqual({ x: topLeft.x, y: topLeft.y }, { x: 500, y: 100 });
});

test('put back inside the work area when it was moved half off screen', () => {
  const from = { x: 0, y: 0, width: 460, height: 700 };
  const back = shrunkBounds({ from, right: false, low: false }, { x: 1800, y: 900, width: 1180, height: 780 }, WA);
  assert.equal(back.x, WA.width - from.width - ROOMY.gap);
  assert.equal(back.y, WA.height - from.height - ROOMY.gap);
});
