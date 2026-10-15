const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latest, DEFAULT_MIN_MS } = require('../src/renderer/shared/latest');

// A clock and timers we move by hand.
function rig(minMs = 100) {
  let clock = 1000;
  let nextId = 1;
  const timers = new Map();
  const seen = [];
  const l = latest(v => seen.push(v), {
    minMs,
    now: () => clock,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
  });
  const advance = ms => {
    clock += ms;
    for (const [id, t] of Array.from(timers)) {
      if (clock > t.at - 1) { timers.delete(id); t.fn(); }
    }
  };
  return { l, seen, advance, pending: () => timers.size };
}

test('a value after a quiet spell is handled at once', () => {
  const r = rig();
  r.l.offer('a');
  assert.deepEqual(r.seen, ['a']);
  assert.equal(r.pending(), 0);
});

test('a flood of values collapses into the last one', () => {
  const r = rig();
  r.l.offer(1);
  r.l.offer(2);
  r.l.offer(3);
  r.l.offer(4);
  assert.deepEqual(r.seen, [1], 'nothing else ran yet');
  assert.equal(r.pending(), 1, 'one timer, not one per value');
  r.advance(100);
  assert.deepEqual(r.seen, [1, 4]);
});

test('a long flood is handled once per pace and ends on a recent value', () => {
  const r = rig();
  for (let ms = 0; ms < 10000; ms += 2) {
    r.l.offer(ms);
    r.advance(2);
  }
  assert.ok(r.seen.length < 102, r.seen.length + ' runs in 10 s');
  assert.ok(r.seen.length > 98, 'it keeps up with the pace');
  assert.ok(r.seen[r.seen.length - 1] > 9890, 'the last run is a recent value');
});

test('nothing is held back once the quiet has passed', () => {
  const r = rig();
  r.l.offer(1);
  r.advance(150);
  r.l.offer(2);
  assert.deepEqual(r.seen, [1, 2]);
});

test('flush handles the held value now and cancel drops it', () => {
  const r = rig();
  r.l.offer(1);
  r.l.offer(2);
  r.l.flush();
  assert.deepEqual(r.seen, [1, 2]);
  r.l.offer(3);
  r.l.cancel();
  r.advance(500);
  assert.deepEqual(r.seen, [1, 2]);
  assert.equal(r.pending(), 0);
});

test('flush with nothing held does nothing', () => {
  const r = rig();
  r.l.flush();
  assert.deepEqual(r.seen, []);
});

test('the default pace is short enough to feel instant', () => {
  assert.ok(DEFAULT_MIN_MS < 101);
});
