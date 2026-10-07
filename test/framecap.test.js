const { test } = require('node:test');
const assert = require('node:assert/strict');
const ShellbyFrameCap = require('../src/renderer/shared/framecap');
const { cap, loops, DEFAULT_FPS } = ShellbyFrameCap;

// A stand-in for a Web Animation: enough of the API for the clock.
function anim({ endTime = Infinity, iterations = Infinity, rate = 1, playState = 'running' } = {}) {
  return {
    playState, currentTime: 0, playbackRate: rate, finished: false,
    effect: { getComputedTiming: () => ({ endTime, iterations }) },
    pause() { this.playState = 'paused'; },
    finish() { this.playState = 'finished'; this.currentTime = endTime; this.finished = true; },
  };
}

function rig(animations, opts = {}) {
  let clock = 0, ticker = null, every = null;
  const doc = { getAnimations: () => animations.filter(a => a.playState !== 'finished') };
  const fc = cap(doc, {
    ...opts,
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

test('with the loops filter, takes the loops and leaves a hover to the screen', () => {
  const spinner = anim();
  const hover = anim({ endTime: 150, iterations: 1 });
  const r = rig([spinner, hover], { filter: loops });
  r.advance(10);
  assert.equal(spinner.playState, 'paused');
  assert.equal(hover.playState, 'running');
  r.advance(100);
  assert.equal(spinner.currentTime, 100);
  assert.equal(hover.currentTime, 0);
});

// A CSS-like animation with keyframes, as getKeyframes() reports them.
function keyed(frames, timing = {}) {
  const a = anim();
  const t = { duration: 1000, delay: 0, iterations: Infinity, direction: 'normal', easing: 'linear', iterationStart: 0, endTime: Infinity, ...timing };
  a.effect = { getKeyframes: () => frames, getComputedTiming: () => t };
  return a;
}
const kf = (offset, transform, easing = 'linear') => ({ offset, computedOffset: offset, easing, composite: 'auto', transform });

test('a blink is only moved around the moment the eyes shut', () => {
  // blink: open for 95%, shut at 97%, open again; steps(1)
  const a = keyed([kf(0, 'scaleY(1)', 'steps(1)'), kf(0.95, 'scaleY(1)', 'steps(1)'), kf(0.97, 'scaleY(0.1)', 'steps(1)'), kf(1, 'scaleY(1)', 'steps(1)')]);
  const r = rig([a]);
  r.advance(0); // caught
  const writes = [];
  let last = a.currentTime;
  for (let i = 0; i < 12; i++) { r.advance(83); if (a.currentTime !== last) { writes.push(i); last = a.currentTime; } }
  assert.equal(writes.length, 1, 'one move in a second: just before the iteration ends'); // the shut at 950-970 ms
  assert.ok(a.currentTime >= 950);
});

test('a smooth stretch moves every tick', () => {
  const a = keyed([kf(0, 'translateY(0px)'), kf(1, 'translateY(-2px)')]);
  const r = rig([a]);
  r.advance(0);
  r.advance(83);
  r.advance(83);
  assert.equal(a.currentTime, 166);
});

test('a stepped breathe moves only when it crosses a step', () => {
  const info = ShellbyFrameCap.changesOf(keyed([kf(0, 'translateY(0px)', 'steps(2)'), kf(0.5, 'translateY(-2px)', 'steps(2)'), kf(1, 'translateY(0px)', 'steps(2)')]).effect);
  assert.deepEqual(info.live, []);
  const timing = { duration: 1000, iterations: Infinity, direction: 'normal' };
  assert.equal(ShellbyFrameCap.changes(info, timing, 0, 200), false);
  assert.equal(ShellbyFrameCap.changes(info, timing, 200, 260), true); // the step at 250
  assert.equal(ShellbyFrameCap.changes(info, timing, 900, 1100), true); // coming round
});

test('keyframes it cannot read keep the old every-tick behaviour', () => {
  assert.equal(ShellbyFrameCap.changesOf(keyed([kf(0.2, 'none'), kf(1, 'rotate(1deg)')]).effect), null); // no 0% keyframe
  assert.equal(ShellbyFrameCap.changesOf(keyed([kf(0, 'none'), kf(1, 'rotate(1deg)')], { easing: 'ease-in' }).effect), null);
  assert.equal(ShellbyFrameCap.changes(null, {}, 0, 10), true);
});

test('carries on from where a script moved it', () => {
  const a = keyed([kf(0, 'translateY(0px)'), kf(1, 'translateY(-2px)')]);
  const r = rig([a]);
  r.advance(0);
  r.advance(100);
  a.currentTime = 500;
  r.advance(100);
  assert.equal(a.currentTime, 600);
});

test('loops is false for an animation without timing', () => {
  assert.equal(loops({}), false);
  assert.equal(loops({ effect: null }), false);
});
