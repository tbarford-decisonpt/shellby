// What the Projects page knows about each project (src/main/projects/insights.js):
// each source joined by folder or GitHub repository, and what needs you.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { insightsFor, withInsights, sessionsFor, inside, WEIGHT } = require('../src/main/projects/insights');
const { caseKey } = require('../src/main/projects/merge');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-04T12:00:00');
const ROOT = path.resolve('C:\\code\\Site');
const OTHER = path.resolve('C:\\code\\other');
const project = (extra = {}) => ({ key: 'github:me/site', name: 'site', github: null, local: [{ root: ROOT, branch: 'main', main: true }], lastWorkedAt: 0, ...extra });

test('nothing known: no reasons, nothing needs you', () => {
  const i = insightsFor(project(), { now: NOW });
  assert.equal(i.attention, 0);
  assert.deepEqual(i.reasons, []);
  assert.equal(i.time, null);
  assert.equal(i.deps, null);
  assert.equal(i.git, null);
  assert.equal(i.quiet, false);
});

test('each source is joined by folder, whatever its case, and never from another project', () => {
  const lowered = ROOT.toLowerCase();
  const i = insightsFor(project(), {
    now: NOW,
    deps: [{ key: lowered, ok: true, outdatedTotal: 3, vulnTotal: 0, at: NOW }, { key: OTHER, ok: true, outdatedTotal: 9, vulnTotal: 9 }],
    flaky: [{ key: 'abc', root: ROOT.toUpperCase(), id: 't', label: 't', week: 2, total: 2, status: 'watching' }, { key: 'x', root: OTHER, id: 'u', week: 5, status: 'watching' }],
    stickers: [{ root: lowered, tierName: 'Gold', ships: 12, marks: [{ icon: '🧼', name: 'Fresh' }] }],
    servers: [{ root: ROOT, status: 'crashed' }, { root: OTHER, status: 'crashed' }],
  });
  assert.equal(i.deps.outdatedTotal, 3);
  assert.equal(i.flaky.length, 1);
  assert.equal(i.sticker.tierName, 'Gold');
  assert.deepEqual(i.reasons.map(r => r.id), ['down', 'flaky', 'outdated']);
  assert.equal(i.attention, WEIGHT.down + WEIGHT.flaky + WEIGHT.outdated);
});

test('pull requests come by repository, from the project key, so they show without the GitHub list on', () => {
  const prs = [
    { key: 'Me/Site#3', repo: 'Me/Site', number: 3, state: 'failing', failing: ['test'] },
    { key: 'me/site#4', repo: 'me/site', number: 4, state: 'passing' },
    { key: 'me/other#1', repo: 'me/other', number: 1, state: 'failing' },
  ];
  const i = insightsFor(project(), { now: NOW, prs });
  assert.deepEqual(i.prs.map(p => p.number), [3, 4]);
  assert.deepEqual(i.reasons, [{ id: 'ci', weight: WEIGHT.ci, count: 1 }]);
  assert.deepEqual(insightsFor(project({ key: `local:${caseKey(ROOT)}` }), { now: NOW, prs }).prs, [], 'a repo with no GitHub remote has none');
});

test('vulnerabilities weigh more when the worst is high or critical', () => {
  const dep = vulns => ({ key: ROOT, ok: true, outdatedTotal: 0, vulnTotal: 2, vulns, worst: vulns.high ? 'high' : 'low' });
  assert.equal(insightsFor(project(), { now: NOW, deps: [dep({ high: 1, low: 1 })] }).reasons[0].weight, WEIGHT.vulnHigh);
  assert.equal(insightsFor(project(), { now: NOW, deps: [dep({ low: 2 })] }).reasons[0].weight, WEIGHT.vuln);
  assert.deepEqual(insightsFor(project(), { now: NOW, deps: [{ key: ROOT, ok: false, error: 'offline' }] }).reasons, [], "a check that failed isn't trouble");
});

test('quarantined and fixed flaky tests are not trouble', () => {
  const flaky = [
    { root: ROOT, id: 'a', week: 3, status: 'quarantined' },
    { root: ROOT, id: 'b', week: 3, status: 'fixed' },
  ];
  const i = insightsFor(project(), { now: NOW, flaky });
  assert.deepEqual(i.flaky.map(f => f.id), ['a'], 'fixed ones are left off the page');
  assert.deepEqual(i.reasons, []);
});

test('git adds up across clones; unpushed work needs you, uncommitted work does not', () => {
  const p = project({ local: [{ root: ROOT }, { root: OTHER }] });
  const git = new Map([[caseKey(ROOT), { dirty: 2, unpushed: 1, stashes: 0, copies: 1 }], [caseKey(OTHER), { dirty: 1, unpushed: 2, stashes: 1, copies: 0 }]]);
  const i = insightsFor(p, { now: NOW, git });
  assert.deepEqual(i.git, { dirty: 3, unpushed: 3, stashes: 1, copies: 1 });
  assert.deepEqual(i.reasons, [{ id: 'unpushed', weight: WEIGHT.unpushed, count: 3 }]);
  const clean = insightsFor(project(), { now: NOW, git: new Map([[caseKey(ROOT), { dirty: 4, unpushed: 0, stashes: 0, copies: 0 }]]) });
  assert.equal(clean.attention, 0);
});

test('quiet: worked in this month, no commit for afterDays, and nudges not muted', () => {
  const streaks = muted => ({ [caseKey(ROOT)]: { lastSeen: NOW - 2 * DAY, lastCommitAt: NOW - 6 * DAY, muted } });
  const i = insightsFor(project(), { now: NOW, streaks: streaks(false), afterDays: 5 });
  assert.equal(i.quiet, true);
  assert.equal(i.quietDays, 6);
  assert.equal(i.lastCommitAt, NOW - 6 * DAY);
  assert.equal(i.lastWorkedAt, NOW - 2 * DAY);
  assert.equal(i.nudgeKey, caseKey(ROOT));
  const muted = insightsFor(project(), { now: NOW, streaks: streaks(true), afterDays: 5 });
  assert.equal(muted.quiet, false);
  assert.equal(muted.muted, true);
  assert.equal(insightsFor(project(), { now: NOW, streaks: streaks(false), afterDays: 7 }).quiet, false);
  const old = { [caseKey(ROOT)]: { lastSeen: NOW - 60 * DAY, lastCommitAt: NOW - 60 * DAY, muted: false } };
  assert.equal(insightsFor(project(), { now: NOW, streaks: old, afterDays: 5 }).quiet, false, 'a project you left long ago is not nagged about');
});

test('time: only while tracking is on, the week day by day, summed across clones', () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30'];
  const time = {
    days,
    projects: [
      { key: ROOT.toLowerCase(), seconds: 3600, days: [{ day: '2026-09-28', seconds: 3600 }] },
      { key: OTHER, seconds: 600, days: [{ day: '2026-09-29', seconds: 600 }] },
      { key: path.resolve('C:\\elsewhere'), seconds: 9999, days: [{ day: '2026-09-29', seconds: 9999 }] },
    ],
  };
  const i = insightsFor(project({ local: [{ root: ROOT }, { root: OTHER }] }), { now: NOW, time });
  assert.equal(i.time.seconds, 4200);
  assert.deepEqual(i.time.days, [{ day: '2026-09-28', seconds: 3600 }, { day: '2026-09-29', seconds: 600 }, { day: '2026-09-30', seconds: 0 }]);
  assert.equal(insightsFor(project(), { now: NOW, time: null }).time, null);
});

test('a GitHub-only project has nothing on this PC to join', () => {
  const p = project({ local: [] });
  const i = insightsFor(p, { now: NOW, deps: [{ key: ROOT, ok: true, outdatedTotal: 1 }], streaks: { [caseKey(ROOT)]: { lastSeen: NOW } } });
  assert.equal(i.deps, null);
  assert.equal(i.lastWorkedAt, null);
});

test('withInsights keeps the order and adds insights to each', () => {
  const out = withInsights([project({ name: 'b' }), project({ name: 'a', key: 'github:me/a' })], { now: NOW });
  assert.deepEqual(out.map(p => p.name), ['b', 'a']);
  assert.ok(out.every(p => p.insights && typeof p.insights.attention === 'number'));
});

test('inside: the folder itself or below it, never a sibling that shares a prefix', () => {
  assert.equal(inside(ROOT, ROOT), true);
  assert.equal(inside(path.join(ROOT, 'src'), ROOT.toUpperCase()), true);
  assert.equal(inside(`${ROOT}-old`, ROOT), false);
  assert.equal(inside(null, ROOT), false);
});

test('sessionsFor: in a clone or one of Shellby\'s copies, newest first, five at most', () => {
  const copy = path.resolve('C:\\Users\\me\\AppData\\Roaming\\Shellby\\worktrees\\ab12\\site');
  const sessions = [
    { id: 'a', title: 'Old', cwd: ROOT, updatedAt: 1 },
    { id: 'b', title: 'In a copy', cwd: copy, updatedAt: 5, done: true },
    { id: 'c', title: 'Elsewhere', cwd: OTHER, updatedAt: 9 },
    { id: 'd', title: 'Deeper', cwd: path.join(ROOT, 'web'), updatedAt: 3 },
    ...Array.from({ length: 6 }, (_, n) => ({ id: `x${n}`, title: `x${n}`, cwd: ROOT, updatedAt: 0 })),
  ];
  const out = sessionsFor(sessions, [ROOT], [copy]);
  assert.equal(out.length, 5);
  assert.deepEqual(out.slice(0, 3).map(s => s.id), ['b', 'd', 'a']);
  assert.deepEqual(out[0], { id: 'b', title: 'In a copy', updatedAt: 5, done: true, copy: true });
  assert.equal(out[1].copy, false);
  assert.deepEqual(sessionsFor(null, [ROOT]), []);
});
