const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { patchWindows, offScreenOptions, handOut, onlyHome, homeDisplay, toReal, toSeen, FAR_X } = require('../src/main/offscreen-windows');

const WORK = { x: 0, y: 0, width: 1920, height: 1040 };
const screen = { getDisplayMatching: () => ({ workArea: WORK }) };

// A BrowserWindow stand-in: real bounds, visibility and calls Windows would see.
function fakeElectron() {
  class BrowserWindow extends EventEmitter {
    constructor({ x = 100, y = 100, width = 400, height = 300, focusable = true } = {}) {
      super();
      this.real = { x, y, width, height };
      this.visible = false;
      this.focusable = focusable;
      this.calls = [];
    }
    getBounds() { return { ...this.real }; }
    setBounds(b) { this.real = { ...this.real, ...b }; this.emit('resize'); }
    getContentBounds() { return { ...this.real }; }
    setContentBounds(b) { this.real = { ...this.real, ...b }; }
    showInactive() { this.visible = true; this.calls.push('showInactive'); }
    show() { this.visible = true; this.calls.push('show'); }
    focus() { this.calls.push('focus'); }
    moveTop() { this.calls.push('moveTop'); }
    blur() {}
    hide() { this.visible = false; }
    maximize() { this.calls.push('maximize'); }
    unmaximize() {}
    isMaximized() { return false; }
    isFocused() { return false; }
    isVisible() { return this.visible; }
    isFocusable() { return this.focusable; }
    isDestroyed() { return false; }
  }
  const off = patchWindows(BrowserWindow, () => screen);
  // As keepOffScreen's subclass does: made off screen, then adopted.
  const make = opts => { const o = offScreenOptions(opts, WORK); const w = new BrowserWindow(o); off.adopt(w, opts?.focusable); return w; };
  return { BrowserWindow, off, make };
}

test('bounds go off screen by FAR_X and come back as they were asked for', () => {
  assert.deepEqual(toReal({ x: 10, y: 5, width: 1, height: 1 }), { x: 10 + FAR_X, y: 5, width: 1, height: 1 });
  assert.deepEqual(toSeen(toReal({ x: -300, y: 0 })), { x: -300, y: 0 });
  assert.deepEqual(toReal(toReal({ x: 10, y: 0 })), toReal({ x: 10, y: 0 })); // already off: unchanged
});

test('a new window is made off every screen with no thick frame, centred on the home display when not placed', () => {
  assert.deepEqual(offScreenOptions({ x: 10, y: 20, width: 100, height: 50, frame: false }, WORK),
    { x: 10 + FAR_X, y: 20, width: 100, height: 50, frame: false, thickFrame: false, center: false, focusable: false, skipTaskbar: true });
  const o = offScreenOptions({ width: 400, height: 300, show: false }, WORK);
  assert.deepEqual([o.x - FAR_X, o.y], [760, 370]);
  assert.equal(o.show, false);
});

test('a new window reports where Shellby put it, and moves off screen', () => {
  const { make } = fakeElectron();
  const w = make({ x: 1500, y: 700 });
  assert.equal(w.real.x, 1500 + FAR_X);
  w.real = { ...w.real, x: 1500 }; w.emit('move'); // Windows moved it back on screen
  assert.equal(w.real.x, 1500 + FAR_X, 'put back off');
  assert.deepEqual(w.getBounds(), { x: 1500, y: 700, width: 400, height: 300 });
  w.setPosition(20, 30);
  assert.deepEqual([w.real.x, w.real.y], [20 + FAR_X, 30]);
  assert.deepEqual(w.getPosition(), [20, 30]);
  w.setBounds({ width: 500 });
  assert.deepEqual(w.real, { x: 20 + FAR_X, y: 30, width: 500, height: 300 });
});

test('maximize fills the work area off screen and reads as maximized until unmaximized', async () => {
  const { make } = fakeElectron();
  const w = make({ x: 50, y: 60 });
  const seen = [];
  w.on('resize', () => seen.push(w.isMaximized()));
  w.on('maximize', () => seen.push('maximize'));
  w.on('unmaximize', () => seen.push('unmaximize'));
  w.maximize();
  assert.equal(w.isMaximized(), true);
  assert.deepEqual(w.getBounds(), WORK);
  assert.equal(w.real.x, FAR_X);
  assert.ok(!w.calls.includes('maximize'), 'never a real maximize');
  assert.ok(w.isVisible(), 'shown, as a real maximize does');
  w.unmaximize();
  assert.equal(w.isMaximized(), false);
  assert.deepEqual(w.getBounds(), { x: 50, y: 60, width: 400, height: 300 });
  assert.deepEqual(seen, [true, 'maximize', false, 'unmaximize']);
});

test('show never activates and focus is kept without Windows', () => {
  const { BrowserWindow, off, make } = fakeElectron();
  const a = make();
  assert.equal(a.focusable, false, 'WS_EX_NOACTIVATE underneath');
  assert.equal(a.isFocusable(), true, 'but focusable as far as Shellby knows');
  const b = make();
  const events = [];
  a.on('focus', () => events.push('a focus')); a.on('blur', () => events.push('a blur'));
  b.on('focus', () => events.push('b focus'));
  a.show();
  assert.deepEqual(a.calls, ['showInactive']);
  assert.equal(a.isFocused(), true);
  assert.equal(BrowserWindow.getFocusedWindow(), a);
  b.show(); b.focus(); b.moveTop();
  assert.ok(!b.calls.includes('focus') && !b.calls.includes('show') && !b.calls.includes('moveTop'), 'nothing that activates it');
  assert.equal(a.isFocused(), false);
  assert.equal(off.focused(), b);
  b.hide();
  assert.equal(BrowserWindow.getFocusedWindow(), null);
  assert.deepEqual(events, ['a focus', 'a blur', 'b focus']);
});

test('a window that takes no focus is shown without it', () => {
  const { make } = fakeElectron();
  const crab = make({ focusable: false });
  assert.equal(crab.focusable, false, 'Windows never activates any of them');
  crab.show(); crab.focus();
  assert.equal(crab.isVisible(), true);
  assert.equal(crab.isFocused(), false);
});

test('Shellby sees only the leftmost display, the one Windows gives a window far to its left', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 } };
  const left = { id: 2, bounds: { x: -1080, y: -290, width: 1080, height: 1920 } };
  const right = { id: 3, bounds: { x: 3840, y: 0, width: 2048, height: 1152 } };
  assert.equal(homeDisplay([primary, left, right]), left);
  const s = { getAllDisplays: () => [primary, left, right] };
  assert.equal(onlyHome(s), left);
  assert.deepEqual(s.getAllDisplays(), [left]);
  assert.equal(s.getPrimaryDisplay(), left);
  assert.equal(s.getDisplayNearestPoint({ x: 100, y: 100 }), left);
  assert.equal(s.getDisplayMatching({ x: 4000, y: 0, width: 10, height: 10 }), left);
});

test('require("electron") hands out the subclass and leaves the rest alone', t => {
  const load = Module._load;
  t.after(() => { Module._load = load; });
  const electron = { BrowserWindow: class {}, app: { name: 'app' } };
  class Sub extends electron.BrowserWindow {}
  Module._load = (request, ...rest) => (request === 'electron' ? electron : load(request, ...rest));
  handOut(electron, Sub);
  const got = require('electron');
  assert.equal(got.BrowserWindow, Sub);
  assert.equal(got.app, electron.app);
  assert.equal(require('node:path'), require('path'));
});
