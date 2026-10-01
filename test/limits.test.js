const { test } = require('node:test');
const assert = require('node:assert/strict');
const limits = require('../src/main/limits');

const NOW = 1_790_000_000_000;
const H = 60 * 60 * 1000;
const usage = (status, five, week) => ({ kind: 'usage', status, fiveHour: five, sevenDay: week });

test('a full window is a limit, and the later reset is the one that counts', () => {
  assert.equal(limits.limitFrom(usage('allowed', { pct: 40, resetsAt: NOW + H }, { pct: 60, resetsAt: NOW + 50 * H }), NOW), null);
  assert.deepEqual(limits.limitFrom(usage('rejected', { pct: 100, resetsAt: NOW + 2 * H }, { pct: 70, resetsAt: NOW + 50 * H }), NOW), { window: 'fiveHour', resetsAt: NOW + 2 * H });
  assert.deepEqual(limits.limitFrom(usage('rejected', { pct: 100, resetsAt: NOW + 2 * H }, { pct: 100, resetsAt: NOW + 50 * H }), NOW), { window: 'sevenDay', resetsAt: NOW + 50 * H });
});

test('"rejected" without a full window blames the fullest one', () => {
  assert.deepEqual(limits.limitFrom(usage('rejected', { pct: 97, resetsAt: NOW + H }, { pct: 30, resetsAt: NOW + 9 * H }), NOW), { window: 'fiveHour', resetsAt: NOW + H });
});

test('resets in the past, absurdly far off, or missing are ignored', () => {
  assert.equal(limits.limitFrom(usage('rejected', { pct: 100, resetsAt: NOW - 1 }, null), NOW), null);
  assert.equal(limits.limitFrom(usage('rejected', { pct: 100, resetsAt: NOW + 30 * 24 * H }, null), NOW), null);
  assert.equal(limits.limitFrom(usage('rejected', { pct: 100, resetsAt: null }, null), NOW), null);
  assert.equal(limits.limitFrom(null, NOW), null);
});

test('cleared: clearly under every limit again', () => {
  assert.equal(limits.cleared(usage('allowed', { pct: 3, resetsAt: NOW + H }, { pct: 80, resetsAt: NOW + H })), true);
  assert.equal(limits.cleared(usage('allowed', { pct: 100, resetsAt: NOW + H }, null)), false);
  assert.equal(limits.cleared(usage('rejected', { pct: 3, resetsAt: NOW + H }, null)), false);
  assert.equal(limits.cleared(usage('allowed', null, null)), false, 'no numbers, no news');
});

test('a saved wait is waiting, just reset, or gone', () => {
  const w = { window: 'fiveHour', resetsAt: NOW };
  assert.equal(limits.status(w, NOW - 1), 'waiting');
  assert.equal(limits.status(w, NOW + 1), 'reset');
  assert.equal(limits.status(w, NOW + limits.STALE_MS + 1), 'gone');
  assert.equal(limits.status({ window: 'nope', resetsAt: NOW }, NOW), 'gone');
  assert.equal(limits.status(null, NOW), 'gone');
});

test('countdown text', () => {
  assert.equal(limits.left(NOW + 2 * H + 5 * 60000, NOW), '2h 05m');
  assert.equal(limits.left(NOW + 14 * 60000, NOW), '14m');
  assert.equal(limits.left(NOW + 40000, NOW), '40s');
  assert.equal(limits.windowName('sevenDay'), 'weekly');
});
