const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/main/guard');

const NOW = 1_790_000_000_000;
const MIN = 60 * 1000;
const H = 60 * MIN;
const usage = pct => ({ kind: 'usage', status: 'allowed', fiveHour: { pct, resetsAt: NOW + H }, sevenDay: null });
const on = { on: true, reserve: 25, maxMinutes: 60 };
const settings = obj => guard.settingsOf(k => obj[k]);

test('settings: on by default, keeping a quarter back and capping routines at an hour', () => {
  assert.deepEqual(settings({}), { on: true, reserve: 25, maxMinutes: 60 });
  assert.deepEqual(settings({ spendGuard: false, spendReserve: 10, spendMaxMinutes: 240 }), { on: false, reserve: 10, maxMinutes: 240 });
  assert.deepEqual(settings({ spendReserve: 99, spendMaxMinutes: 'lots' }), { on: true, reserve: 25, maxMinutes: 60 }, 'odd values fall back');
});

test('the ceiling is what is left after your reserve, and only for the current window', () => {
  assert.equal(guard.overCeiling(usage(74), 25, NOW), false);
  assert.equal(guard.overCeiling(usage(75), 25, NOW), true);
  assert.equal(guard.overCeiling(usage(85), 10, NOW), false);
  assert.equal(guard.overCeiling({ fiveHour: { pct: 99, resetsAt: NOW - 1 } }, 25, NOW), false, 'a window that already reset');
  assert.equal(guard.overCeiling({ fiveHour: { pct: 99, resetsAt: null } }, 25, NOW), false);
  assert.equal(guard.overCeiling(null, 25, NOW), false, 'no reading yet');
});

test('a scheduled routine waits for the reset when past the ceiling, unless the guard is off', () => {
  assert.equal(guard.holdBeforeStart(on, usage(80), NOW), true);
  assert.equal(guard.holdBeforeStart(on, usage(40), NOW), false);
  assert.equal(guard.holdBeforeStart({ ...on, on: false }, usage(80), NOW), false);
});

test('routines and workflows stop when usage crosses the ceiling', () => {
  for (const kind of ['routine', 'workflow']) {
    const run = { kind, startedAt: NOW - MIN, exempt: false };
    assert.equal(guard.verdict(run, on, { usage: usage(60), now: NOW }), null);
    assert.deepEqual(guard.verdict(run, on, { usage: usage(76), now: NOW }), { reason: 'ceiling', pct: 76, resetsAt: NOW + H });
  }
});

test('a run you started by hand past the ceiling is yours to spend', () => {
  const run = { kind: 'routine', startedAt: NOW - MIN, exempt: true };
  assert.equal(guard.verdict(run, on, { usage: usage(90), now: NOW }), null);
});

test('a routine running past the time cap stops, even with no usage reading', () => {
  const run = { kind: 'routine', startedAt: NOW - 61 * MIN, exempt: true };
  assert.deepEqual(guard.verdict(run, on, { usage: null, now: NOW }), { reason: 'time', minutes: 60 });
  assert.equal(guard.verdict({ ...run, kind: 'workflow' }, on, { usage: null, now: NOW }), null, 'workflows keep their own step timeouts');
});

test('an Autonomous tab only counts as unattended once you have been away a while', () => {
  const run = { kind: 'autonomous', startedAt: NOW - MIN, exempt: false };
  assert.equal(guard.verdict(run, on, { usage: usage(90), now: NOW, idleMs: 2 * MIN }), null, 'you are at the PC');
  assert.equal(guard.verdict(run, on, { usage: usage(90), now: NOW, idleMs: guard.AWAY_MS })?.reason, 'ceiling');
  assert.equal(guard.verdict(run, on, { usage: usage(90), now: NOW, idleMs: Infinity })?.reason, 'ceiling', 'locked');
  assert.equal(guard.verdict({ ...run, startedAt: NOW - 5 * H }, on, { usage: usage(10), now: NOW, idleMs: Infinity }), null, 'no time cap on chats');
});

test('ordinary turns and a switched-off guard are never stopped', () => {
  assert.equal(guard.verdict({ kind: null, startedAt: NOW - 5 * H }, on, { usage: usage(99), now: NOW, idleMs: Infinity }), null);
  assert.equal(guard.verdict(null, on, { usage: usage(99), now: NOW }), null);
  assert.equal(guard.verdict({ kind: 'routine', startedAt: NOW - 5 * H }, { ...on, on: false }, { usage: usage(99), now: NOW }), null);
});

test('messages say why, and how to carry on', () => {
  const clock = () => '3:40 AM';
  const t = guard.message({ reason: 'time', minutes: 120 }, '⟳ Nightly', on, clock);
  assert.match(t.body, /2 hours/);
  const c = guard.message({ reason: 'ceiling', pct: 78, resetsAt: NOW + H }, '⟳ Nightly', on, clock);
  assert.match(c.body, /78%.*25%.*3:40 AM/);
  assert.equal(guard.minutesText(30), '30 minutes');
  assert.equal(guard.minutesText(60), '1 hour');
});
