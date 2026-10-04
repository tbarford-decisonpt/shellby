const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cap, DEFAULT_FPS } = require('../src/renderer/shared/framecap');

// A stand-in for a Web Animation: enough of the API for the clock.
function anim({ endTime = Infinity, rate = 1, playState = 'running' } = {}) {
  return {
    playState, currentTime: 0, playbackRate: rate, finished: false,
    effect: { getComputedTiming: () => ({ endTime }) },
    pause() { this.playState = 'paused'; },
    finish() { this.playState = 'finished'; this.currentTime = endTime; this.finished = true; },
  };
}

function rig(animations) {
  let clock = 0, ticker = null, every = null;
  const doc = { getAnimations: () => animations.filter(a => a.playState !== 'finished') };
  const fc = cap(doc, {
    setInterval: (fn, ms) => { ticker = fn; every = ms; return 1; },
    clearInterval: () => { ticker = null; },
    now: () => clock,
  });
  return { fc, every: () => every, advance(ms) { clock += ms; ticker?.(); } };
}

test('ticks a dozen times a second by default', () => {
  const r = rig([]);
  assert.equal(DEFAULT_FPS, 12);
  assert.equal(r.every(), Math.round(1000 / 12));
});

test('takes over a running animation and moves it on by real time', () => {
  const a = anim();
  const r = rig([a]);
  r.advance(80); // caught: paused where it was
  assert.equal(a.playState, 'paused');
  r.advance(80);
  r.advance(90);
  assert.equal(a.currentTime, 170);
});

test('honours playback rate', () => {
  const a = anim({ rate: 2 });
  const r = rig([a]);
  r.advance(10);
  r.advance(100);
  assert.equal(a.currentTime, 200);
});

test('finishes a finite animation through the API, so its end events still fire', () => {
  const a = anim({ endTime: 500 });
  const r = rig([a]);
  r.advance(0);
  r.advance(300);
  assert.equal(a.finished, false);
  r.advance(300);
  assert.equal(a.finished, true);
  assert.equal(a.currentTime, 500);
});

test('an animation played backwards finishes at its start', () => {
  const a = anim({ endTime: 500, rate: -1 });
  a.currentTime = 500;
  const r = rig([a]);
  r.advance(0);
  r.advance(400);
  assert.equal(a.finished, false);
  r.advance(200);
  assert.equal(a.finished, true);
});

test('leaves alone an animation something else paused', () => {
  const a = anim({ playState: 'paused' });
  const r = rig([a]);
  r.advance(100);
  r.advance(100);
  assert.equal(a.currentTime, 0);
});

test('stop() ends the clock', () => {
  const a = anim();
  const r = rig([a]);
  r.advance(10);
  r.fc.stop();
  r.advance(100);
  assert.equal(a.currentTime, 0);
});
