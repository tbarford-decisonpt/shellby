const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/main/streaks');

const DAY = 24 * 60 * 60 * 1000;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime(); // October 2026, local time

test('streak counts consecutive work days, and survives until the day after', () => {
  let s = null;
  for (const d of [1, 2, 3, 5, 6]) s = S.recordWorkDay(s, at(d));
  assert.deepEqual(S.streakOf(s, at(6)), { current: 2, longest: 3, today: true });
  assert.deepEqual(S.streakOf(s, at(7)), { current: 2, longest: 3, today: false }, 'still alive tomorrow');
  assert.deepEqual(S.streakOf(s, at(8)), { current: 0, longest: 3, today: false }, 'broken after a missed day');
  assert.deepEqual(S.streakOf(null, at(1)), { current: 0, longest: 0, today: false });
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
