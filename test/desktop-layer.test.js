const { test } = require('node:test');
const assert = require('node:assert/strict');
const { covers, panelCalm, veil, DESKTOP_CLASSES } = require('../src/main/desktop-layer');

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

// ---------------------------------------------------------------- on top of your apps
// The Win32 side, stubbed: desktop-layer.js reaches it through the module object.
const native = require('../src/main/native-windows');
const { pin, sendToBottom, tuckUnder, setOnTop, isPinned } = require('../src/main/desktop-layer');

const HOST = 900, HWND_BOTTOM = 1, HWND_TOPMOST = -1, HWND_NOTOPMOST = -2;
let calls;
let owners;
Object.assign(native, {
  load: () => ({ SetWindowPos: (h, after) => { calls.push(['pos', h, after]); return true; } }),
  available: () => true,
  hwndOf: w => w.hwnd,
  desktopHost: () => HOST,
  ownBy: (h, owner) => { owners.set(h, owner); return true; },
  ownerOf: h => owners.get(h) || 0,
  float: h => { owners.set(h, 0); calls.push(['float', h]); return true; },
});

function fakeWindow(hwnd) {
  let top = false;
  return { hwnd, isDestroyed: () => false, setAlwaysOnTop: on => { top = on; }, isAlwaysOnTop: () => top };
}
function reset() {
  calls = [];
  owners = new Map();
}

test('on top, pin lifts his window off the desktop and makes it topmost', () => {
  reset();
  setOnTop(() => true);
  const w = fakeWindow(10);
  owners.set(10, HOST);
  assert.equal(pin(w), true);
  assert.equal(w.isAlwaysOnTop(), true);
  assert.equal(native.ownerOf(10), 0);
  assert.deepEqual(calls.at(-1), ['pos', 10, HWND_TOPMOST]);
  assert.equal(isPinned(w), true);
});

test('a lifted window is never sent to the bottom (that would end its topmost)', () => {
  reset();
  setOnTop(() => true);
  const w = fakeWindow(11);
  pin(w);
  calls = [];
  sendToBottom(w);
  assert.deepEqual(calls, []);
});

test('the floor tucks in just behind him when both are on top', () => {
  reset();
  setOnTop(() => true);
  const crab = fakeWindow(12), floor = fakeWindow(13);
  pin(crab);
  pin(floor);
  calls = [];
  tuckUnder(floor, crab);
  assert.deepEqual(calls, [['pos', 13, 12]]);
});

test('switched back, pin drops the topmost and owns him by the desktop again', () => {
  reset();
  setOnTop(() => true);
  const w = fakeWindow(14);
  pin(w);
  setOnTop(() => false);
  assert.equal(isPinned(w), false);
  calls = [];
  assert.equal(pin(w), true);
  assert.equal(w.isAlwaysOnTop(), false);
  assert.equal(native.ownerOf(14), HOST);
  assert.deepEqual(calls, [['pos', 14, HWND_NOTOPMOST], ['pos', 14, HWND_BOTTOM]]);
  assert.equal(isPinned(w), true);
});

test('on the desktop, the floor goes to the bottom under him', () => {
  reset();
  setOnTop(() => false);
  const crab = fakeWindow(15), floor = fakeWindow(16);
  tuckUnder(floor, crab);
  assert.deepEqual(calls, [['pos', 16, HWND_BOTTOM]]);
});

test('a game on another screen keeps the panel spinners going', () => {
  assert.deepEqual(panelCalm({ reason: 'blur', game: true, underGame: false }), { calm: true, deep: false });
});

test("a game lying over the panel stops all of it: nobody can see it", () => {
  assert.deepEqual(panelCalm({ reason: 'blur', game: true, underGame: true }), { calm: true, deep: true });
});

test('unfocused without a game drops only the decorative loops', () => {
  assert.deepEqual(panelCalm({ reason: 'blur' }), { calm: true, deep: false });
});

test('a locked screen stops everything, game or not', () => {
  assert.deepEqual(panelCalm({ reason: 'locked' }), { calm: true, deep: true });
});

test('in front and nothing going on, the panel animates fully', () => {
  assert.deepEqual(panelCalm({}), { calm: false, deep: false });
});
