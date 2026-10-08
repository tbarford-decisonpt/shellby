// The Tank view's frame loop (src/renderer/panel/tank.js): ten frames a second
// while you watch, and nothing but one still frame while the panel is calm
// (behind your windows, you're away, a game is up), the same as a hidden tab.
// tank.js runs here in a bare vm with just enough DOM: the timers are counted
// by hand so a test can see whether the loop keeps going.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TANK = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'tank.js'), 'utf8');
const flush = () => new Promise(r => setImmediate(r));

function element() {
  return {
    style: {}, hidden: false, clientWidth: 420, width: 0, height: 0,
    getContext: () => ({ setTransform() {}, clearRect() {}, fillRect() {} }),
    querySelector: () => null, querySelectorAll: () => [], replaceChildren() {}, after() {}, addEventListener() {},
  };
}

function loadTank() {
  const classes = new Set();
  let observe = null;
  const docListeners = {};
  const body = { classList: { contains: c => classes.has(c) } };
  const document = {
    body, hidden: false,
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    dispatchEvent() {}, querySelectorAll: () => [],
  };
  const timers = [];
  const paints = [];
  const byId = new Map();
  const world = { w: 120, h: 60, crabY: 50 };
  const SB = {
    h: () => element(), $: id => { if (!byId.has(id)) byId.set(id, element()); return byId.get(id); },
    state: { view: 'tank' }, views: {}, plural: (n, one) => `${n} ${one}`, keepFocus: (_el, fn) => fn(),
    api: { critter: {}, getTank: () => Promise.resolve({ layout: { placed: [] }, news: [], tray: [], sizes: [], size: {}, pieces: [] }) },
    tankPaint: { resolve: () => ({ world, pieces: [], style: {} }), paint: (_c, _s, o) => paints.push(o), timeOf: () => 'day' },
  };
  const context = vm.createContext({
    SB, document, window: { addEventListener() {}, devicePixelRatio: 1 },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { observe() {} },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe(target, opts) { assert.equal(target, body); assert.equal(String(opts.attributeFilter), 'class'); observe = this.fn; } },
    CustomEvent: class {}, performance: { now: () => 1000 + timers.length * 100 },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
  });
  vm.runInContext(TANK, context, { filename: 'tank.js' });
  return {
    timers, paints, docListeners,
    // One timer at a time, the way the loop schedules them.
    step: () => { const fn = timers.shift(); if (fn) fn(); return !!fn; },
    setCalm: on => { if (on) classes.add('calm'); else classes.delete('calm'); observe?.(); },
  };
}

test('tank: the loop runs while you watch, and stops on one still frame while the panel is calm', async () => {
  const t = loadTank();
  await flush(); // the tank arrives from main
  t.docListeners.visibilitychange(); // kick
  t.step();
  assert.equal(t.timers.length, 1, 'watching: the next frame is booked');
  t.step();
  assert.equal(t.timers.length, 1, '...and the next');

  t.setCalm(true);
  const painted = t.paints.length;
  t.step(); // the frame already booked sees the calm
  assert.equal(t.timers.length, 0, 'calm: no next frame');
  assert.equal(t.paints.length, painted + 1, '...just the one still frame');

  t.setCalm(false);
  assert.equal(t.timers.length, 1, 'the calm lifting kicks the loop');
  t.step();
  assert.equal(t.timers.length, 1, '...and it keeps going');
});
