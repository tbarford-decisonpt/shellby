const { test } = require('node:test');
const assert = require('node:assert/strict');
const queueWhen = require('../src/main/queue-when');

const H = 60 * 60 * 1000;
const at = (h, m = 0, day = 9) => new Date(2026, 9, day, h, m).getTime(); // local time

test('tonight is the next 1am', () => {
  assert.equal(queueWhen.nextNight(at(15)), at(1, 0, 10));
  assert.equal(queueWhen.nextNight(at(0, 30)), at(1, 0, 9), 'past midnight: later this night');
  assert.equal(queueWhen.nextNight(at(23, 59)), at(1, 0, 10));
});

test('queued in the small hours, tonight is now', () => {
  const now = at(2);
  assert.ok(queueWhen.nextNight(now) - now <= 60 * 1000);
});

test('a reset task starts at the reset', () => {
  assert.deepEqual(queueWhen.startAt({ when: 'reset', resetAt: at(17) }, at(15)), { at: at(17) });
});

test('a reset task with no window running says so, and points at tonight', () => {
  const r = queueWhen.startAt({ when: 'reset', resetAt: null, sawWindow: true }, at(15));
  assert.equal(r.idle, true);
  assert.match(r.error, /tonight/);
  assert.ok(!queueWhen.startAt({ when: 'reset', resetAt: null }, at(15)).idle);
});

test('tonight needs no known window', () => {
  assert.deepEqual(queueWhen.startAt({ when: 'tonight', resetAt: null }, at(15)), { at: at(1, 0, 10) });
});

test('tonight at the limit waits for a reset that comes after 1am', () => {
  const now = at(23);
  const reset = at(1, 0, 10) + 2 * H;
  assert.deepEqual(queueWhen.startAt({ when: 'tonight', resetAt: reset, limited: true }, now), { at: reset });
  assert.deepEqual(queueWhen.startAt({ when: 'tonight', resetAt: reset, limited: false }, now), { at: at(1, 0, 10) }, 'not limited: tonight as asked');
});

test('anything else is the reset', () => {
  assert.deepEqual(queueWhen.startAt({ when: 'someday', resetAt: at(17) }, at(15)), { at: at(17) });
});
