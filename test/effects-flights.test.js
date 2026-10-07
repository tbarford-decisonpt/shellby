const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flights, FLIGHT } = require('../src/renderer/shared/effects');

// A fake clock: timers fire when advance() passes them.
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function record(c, opts) {
  const log = [];
  const f = flights({ ...opts, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout }, {
    show: () => log.push('show'), leave: () => log.push('leave'), hide: () => log.push('hide'),
  });
  return { f, log };
}

test('a flight starts at once, fades out before it ends and rests in between', () => {
  const c = clock();
  const { log } = record(c, { on: 1000, off: 5000, fade: 200 });
  assert.deepEqual(log, ['show']);
  c.advance(799);
  assert.deepEqual(log, ['show']);
  c.advance(1);
  assert.deepEqual(log, ['show', 'leave']);
  c.advance(200);
  assert.deepEqual(log, ['show', 'leave', 'hide']);
  c.advance(4999);
  assert.deepEqual(log, ['show', 'leave', 'hide']);
  c.advance(1);
  assert.deepEqual(log, ['show', 'leave', 'hide', 'show']);
});

test('stop() ends the rhythm and leaves no timer behind', () => {
  const c = clock();
  const { f, log } = record(c, { on: 1000, off: 5000, fade: 200 });
  f.stop();
  c.advance(60000);
  assert.deepEqual(log, ['show']);
  assert.equal(c.pending(), 0);
});

test('the default flight is a short share of the time, so the bats cost a fraction of what they did', () => {
  assert.ok(FLIGHT.on >= 5000, 'long enough to see them go round');
  assert.ok(FLIGHT.on / (FLIGHT.on + FLIGHT.off) <= 0.15);
  assert.ok(FLIGHT.fade < FLIGHT.on);
});

test('a fade longer than the flight is cut to the flight', () => {
  const c = clock();
  const { log } = record(c, { on: 100, off: 1000, fade: 500 });
  c.advance(0);
  assert.deepEqual(log, ['show', 'leave']);
  c.advance(100);
  assert.deepEqual(log, ['show', 'leave', 'hide']);
});
