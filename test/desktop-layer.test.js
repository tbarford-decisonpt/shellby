const { test } = require('node:test');
const assert = require('node:assert/strict');
const { covers, veil, DESKTOP_CLASSES } = require('../src/main/desktop-layer');

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

// A stand-in BrowserWindow: just what veil() touches.
function win({ visible = true } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    isVisible: () => visible,
    hide() { visible = false; calls.push('hide'); },
    showInactive() { visible = true; calls.push('showInactive'); },
  };
}

test('veiling hides a window that is showing', () => {
  const w = win();
  veil(w, true);
  assert.deepEqual(w.calls, ['hide']);
});

test('lifting the veil shows it again without taking focus, then lowers it', () => {
  const w = win({ visible: false });
  let lowered = 0;
  veil(w, false, { lower: () => lowered++ });
  assert.deepEqual(w.calls, ['showInactive']);
  assert.equal(lowered, 1);
});

test('veil leaves a window already in the asked state alone', () => {
  const shown = win();
  veil(shown, false, { lower: () => assert.fail('lowered a window that never moved') });
  const hiddenWin = win({ visible: false });
  veil(hiddenWin, true);
  assert.deepEqual([...shown.calls, ...hiddenWin.calls], []);
});

test('veil ignores a missing or destroyed window', () => {
  assert.doesNotThrow(() => veil(null, true));
  assert.doesNotThrow(() => veil({ isDestroyed: () => true }, true));
});
