const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/main/progression/streaks');

const DAY = 24 * 60 * 60 * 1000;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime(); // October 2026, local time

// October 2026: the 1st is a Thursday, the 5th a Monday, the 10th and 11th a weekend.
const work = (days, s = null) => days.reduce((st, d) => S.recordWorkDay(st, at(d)), s);
const pick = (v, keys) => Object.fromEntries(keys.map(k => [k, v[k]]));

test('streak counts worked days and survives until the day after', () => {
  const s = work([5, 6]);
  assert.deepEqual(pick(S.streakOf(s, at(6)), ['current', 'longest', 'today']), { current: 2, longest: 2, today: true });
  assert.deepEqual(pick(S.streakOf(s, at(7)), ['current', 'today']), { current: 2, today: false }, 'still alive tomorrow');
  assert.deepEqual(pick(S.streakOf(null, at(1)), ['current', 'longest', 'today']), { current: 0, longest: 0, today: false });
});

test('a Friday-to-Monday weekend keeps the streak; rest days add nothing to it', () => {
  const s = work([5, 6, 7, 8, 9, 12]);
  assert.equal(S.streakOf(s, at(10)).current, 5, 'Saturday: still 5');
  assert.equal(S.streakOf(s, at(10)).restToday, true);
  assert.equal(S.streakOf(s, at(12)).current, 6, 'Monday: the weekend held');
});

test('one missed Wednesday is a tide-out', () => {
  const s = work([5, 6, 8, 9]);
  const v = S.streakOf(s, at(9));
  assert.equal(v.current, 4);
  assert.deepEqual(v.tideOutDays, ['2026-10-07']);
  assert.equal(v.tideOutsLeftThisWeek, 0);
  assert.equal(S.streakOf(work([5, 6]), at(6)).tideOutsLeftThisWeek, 1);
  assert.equal(S.streakOf(work([5, 8]), at(8), { perWeek: 2 }).current, 2, 'the tide-out-plus perk: two a week');
  assert.equal(S.streakOf(work([5, 8]), at(8)).current, 1, 'without it, two missed days break it');
});

test('two missed days in one week break the streak, but the bonus only ebbs 0.05 a day', () => {
  let s = work([5, 8, 9]);
  assert.equal(S.streakOf(s, at(9)).current, 2);
  s = S.noteEbb(s, 1.2, at(5));
  assert.equal(S.ebbMultiplier(s, at(9)), 1.1, 'Tuesday and Wednesday missed: 1.20 - 2 x 0.05');
  const paid = S.noteEbb(null, 1.25, at(1));
  assert.equal(S.ebbMultiplier(paid, at(1)), 1.25, 'the day it was paid');
  assert.equal(S.ebbMultiplier(paid, at(5)), 1.2, 'Friday missed, the weekend is rest: one step down by Monday');
  assert.ok(S.ebbMultiplier(s, at(9)) >= 1);
});

test('the bonus counts weeks with 3 or more worked days', () => {
  const s = work([5, 6, 7, 8, 9, 12, 13, 14]);
  const v = S.streakOf(s, at(14));
  assert.equal(v.weeks, 2);
  assert.equal(v.mult, 1.1);
});

test('changing rest days mid-streak only counts from that day on', () => {
  let s = work([5, 6, 7, 8, 9]);
  const before = S.streakOf(work([12], s), at(12)).current;
  s = S.setRestDays(s, [], at(12));
  s = work([12], s);
  assert.equal(S.streakOf(s, at(12)).current, before, 'last weekend still held');
  assert.deepEqual(s.restDays, []);
  assert.deepEqual(S.normalize(null).restDays, [0, 6]);
  assert.deepEqual(S.setRestDays(s, [0, 1, 2, 3], at(13)).restDays, [], 'at most three days off a week');
});

test('settleTideOuts writes the tide-outs down, and is idempotent', () => {
  const s = work([5, 6, 8, 9]);
  const r = S.settleTideOuts(s, at(9));
  assert.deepEqual(r.added, ['2026-10-07']);
  assert.deepEqual(S.settleTideOuts(r.state, at(9)).added, []);
  assert.equal(S.streakOf(r.state, at(9)).current, 4);
});

test('a DST change in between counts every day once', () => {
  const s = work([26, 27, 28, 29, 30, 33, 34, 35, 36, 37]); // past the 31st rolls into November
  assert.equal(S.streakOf(s, at(37)).current, 10);
});

test('the same day counts once; days are stored sorted and bounded', () => {
  let s = S.recordWorkDay(null, at(3, 9));
  s = S.recordWorkDay(s, at(3, 23));
  s = S.recordWorkDay(s, at(1));
  assert.deepEqual(s.days, ['2026-10-01', '2026-10-03']);
});

function project(lastCommitDay, { seen = 10, name = '3d-rack', key = 'c:\\code\\3d-rack' } = {}) {
  let s = S.recordProject(null, key, name, at(seen));
  if (lastCommitDay) s = S.recordCommit(s, key, at(lastCommitDay));
  return s;
}

test('nudge: a recently-touched project with no commit for 5+ days', () => {
  const s = project(5);
  assert.equal(S.dueNudge(s, at(9, 14)), null, '4 days is not enough');
  const n = S.dueNudge(s, at(10, 14));
  assert.deepEqual(n, { key: 'c:\\code\\3d-rack', name: '3d-rack', days: 5 });
  assert.equal(S.nudgeText(n), "You haven't committed to 3d-rack in 5 days 🐚");
});

test('nudges respect quiet hours, once a day, mute, the setting, and dormant projects', () => {
  const s = project(1);
  assert.equal(S.dueNudge(s, at(10, 7)), null, 'not before 9');
  assert.equal(S.dueNudge(s, at(10, 22)), null, 'not after 9pm');
  const nudged = S.markNudged(s, 'c:\\code\\3d-rack', at(10, 10));
  assert.equal(S.dueNudge(nudged, at(10, 18)), null, 'once a day');
  assert.ok(S.dueNudge(nudged, at(11, 10)), 'again the next day');
  assert.equal(S.dueNudge(S.setMuted(s, 'c:\\code\\3d-rack', true), at(10, 14)), null, 'muted');
  assert.equal(S.dueNudge({ ...s, nudges: false }, at(10, 14)), null, 'turned off');
  const dormant = project(1, { seen: 1 });
  assert.equal(S.dueNudge(dormant, at(1, 14) + 40 * DAY), null, 'not about projects you stopped touching a month ago');
  assert.equal(S.dueNudge(project(null), at(20, 14)), null, 'no commits known yet: no nudge');
});

test('the quietest project is nudged first; afterDays is adjustable', () => {
  let s = project(6, { key: 'a', name: 'alpha' });
  s = S.recordProject(s, 'b', 'beta', at(10));
  s = S.recordCommit(s, 'b', at(2));
  assert.equal(S.dueNudge(s, at(11, 12)).name, 'beta');
  assert.equal(S.dueNudge({ ...s, afterDays: 10 }, at(11, 12)), null);
});

test('projects: commit times only move forward, list stays bounded, junk is cleaned', () => {
  let s = project(5);
  s = S.recordCommit(s, 'c:\\code\\3d-rack', at(3));
  assert.equal(s.projects['c:\\code\\3d-rack'].lastCommitAt, at(5));
  assert.deepEqual(S.recordCommit(s, 'nope', at(9)).projects, s.projects, 'unknown project: no change');
  for (let i = 0; i < 80; i++) s = S.recordProject(s, `p${i}`, `p${i}`, at(10) + i);
  assert.equal(Object.keys(s.projects).length, 50);
  const junk = S.normalize({ days: ['x', 5, '2026-10-01'], projects: { a: null, b: { name: 'b\nx', lastSeen: 'no' } }, afterDays: 999 });
  assert.deepEqual(junk.days, ['2026-10-01']);
  assert.deepEqual(junk.projects, { b: { name: 'b x', lastSeen: 0, lastCommitAt: null, lastNudgeAt: null, muted: false } });
  assert.equal(junk.afterDays, 30);
});

test('pure: inputs are never mutated', () => {
  const s = S.normalize(project(5));
  const copy = JSON.stringify(s);
  S.recordWorkDay(s, at(12));
  S.recordProject(s, 'z', 'z', at(12));
  S.markNudged(s, 'c:\\code\\3d-rack', at(12));
  assert.equal(JSON.stringify(s), copy);
});
