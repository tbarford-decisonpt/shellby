const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeToday, parseDay } = require('../src/main/today');

const clock = () => new Date(2026, 5, 1, 14, 30, 5);

test('a real date only', () => {
  assert.deepEqual(parseDay('2026-10-28'), [2026, 10, 28]);
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(parseDay('28/10/2026'), null);
  assert.equal(parseDay(undefined), null);
});

test('dev runs can pick the day, keeping the time of day', () => {
  const d = makeToday({ packaged: false, env: { SHELLBY_TODAY: '2026-10-28' }, clock })();
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 28);
  assert.equal(d.getHours(), 14);
});

test('a packaged Shellby never reads the override', () => {
  const d = makeToday({ packaged: true, env: { SHELLBY_TODAY: '2026-10-28' }, clock })();
  assert.equal(d.getMonth(), 5);
});

test('a screenshot run\'s date wins', () => {
  const capture = { now: new Date(2026, 11, 25, 12) };
  assert.equal(makeToday({ packaged: false, env: { SHELLBY_TODAY: '2026-10-28' }, capture, clock })().getDate(), 25);
  capture.now = null;
  assert.equal(makeToday({ packaged: false, env: {}, capture, clock })().getDate(), 1);
});
