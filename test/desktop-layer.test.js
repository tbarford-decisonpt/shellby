const { test } = require('node:test');
const assert = require('node:assert/strict');
const { covers, DESKTOP_CLASSES } = require('../src/main/desktop-layer');

const crab = { x: 1700, y: 860, width: 200, height: 180 };

test('a maximized window in front hides him', () => {
  assert.equal(covers({ x: 0, y: 0, width: 1920, height: 1040 }, crab), true);
});

test('a window that only overlaps him leaves him visible', () => {
  assert.equal(covers({ x: 0, y: 0, width: 1800, height: 1040 }, crab), false);
  assert.equal(covers({ x: 1750, y: 0, width: 400, height: 1040 }, crab), false);
  assert.equal(covers({ x: 0, y: 0, width: 1920, height: 900 }, crab), false);
});

test('a window exactly his size and spot hides him', () => {
  assert.equal(covers({ ...crab }, crab), true);
});

test('nothing in front, or no box, hides nothing', () => {
  assert.equal(covers(null, crab), false);
  assert.equal(covers({ x: 0, y: 0, width: 1920, height: 1040 }, null), false);
});

test('the desktop host is never counted as covering him', () => {
  assert.ok(DESKTOP_CLASSES.has('Progman'));
  assert.ok(DESKTOP_CLASSES.has('WorkerW'));
});
