const { test } = require('node:test');
const assert = require('node:assert/strict');
const focus = require('../src/main/focus');

const T0 = new Date(2026, 9, 1, 10, 0, 0).getTime();
const MIN = 60 * 1000;

test('a session runs focus, then a break, then ends', () => {
  const s = focus.start(T0, 25);
  assert.deepEqual([s.phase, s.minutes, s.breakMinutes, s.endsAt], ['focus', 25, 5, T0 + 25 * MIN]);
  assert.equal(focus.guarding(s, T0 + MIN), true);

  let r = focus.advance(s, T0 + 24 * MIN);
  assert.deepEqual(r.events, []);
  assert.equal(r.session.phase, 'focus');

  r = focus.advance(s, T0 + 25 * MIN);
  assert.deepEqual(r.events, ['focus-done']);
  assert.deepEqual([r.session.phase, r.session.endsAt], ['break', T0 + 30 * MIN]);
  assert.equal(focus.guarding(r.session, T0 + 26 * MIN), false, 'a break is not guarded');

  r = focus.advance(r.session, T0 + 30 * MIN);
  assert.deepEqual(r, { session: null, events: ['break-done'] });
});

test('coming back after Shellby was closed reports both endings', () => {
  assert.deepEqual(focus.advance(focus.start(T0, 15), T0 + 2 * 60 * MIN).events, ['focus-done', 'break-done']);
});

test('only the offered lengths, and junk from disk is no session', () => {
  assert.equal(focus.start(T0, 7).minutes, 25);
  assert.deepEqual(focus.LENGTHS, [15, 25, 50]);
  assert.equal(focus.normalize({ phase: 'focus', minutes: 99, startedAt: 1, endsAt: 2 }), null);
  assert.equal(focus.normalize('nope'), null);
  assert.deepEqual(focus.advance(null, T0), { session: null, events: [] });
  assert.equal(focus.guarding(null, T0), false);
});

test('view and countdown text', () => {
  assert.deepEqual(focus.view(null, T0), { phase: null, lengths: [15, 25, 50] });
  const v = focus.view(focus.start(T0, 50), T0 + 10 * MIN);
  assert.equal(v.remainingMs, 40 * MIN);
  assert.equal(focus.shortLeft(40 * MIN), '40m');
  assert.equal(focus.shortLeft(61 * 1000), '2m');
  assert.equal(focus.shortLeft(45 * 1000), '45s');
});
