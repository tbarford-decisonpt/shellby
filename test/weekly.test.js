const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWeekly, recordDay, recordWork, recordTrophy, markWrapped, weekSummary, wrapUpDue, dayKey, KEEP_DAYS } = require('../src/main/weekly');
const { normalizeXp } = require('../src/main/xp');
const stickers = require('../src/main/stickers');

// Friday 2 October 2026, mid-morning (local time).
const FRI = new Date(2026, 9, 2, 10, 0).getTime();
const at = (daysBack, hour = 10) => new Date(2026, 9, 2 - daysBack, hour, 0).getTime();
const A = { id: 'aaaaaaaaaaaa', name: 'shellby' };
const B = { id: 'bbbbbbbbbbbb', name: 'rack-builder' };

test('counts each kind per day, and remembers which projects shipped', () => {
  let s = recordDay(null, at(0), 'ship', A);
  s = recordDay(s, at(0), 'ship', A);
  s = recordDay(s, at(0), 'deploy', B);
  s = recordDay(s, at(0), 'fixed');
  const d = s.days[dayKey(at(0))];
  assert.equal(d.ship, 2);
  assert.equal(d.deploy, 1);
  assert.equal(d.fixed, 1);
  assert.deepEqual(d.projects, { [A.id]: 'shellby', [B.id]: 'rack-builder' });
  assert.equal(s.since, dayKey(at(0)));
  // Not a shipping kind: no project kept, even if one is passed.
  assert.equal(recordDay(null, at(0), 'task', A).days[dayKey(at(0))].projects, undefined);
});

test('flaky tests caught and fixed are counted for the card', () => {
  let s = recordDay(null, at(1), 'flaky');
  s = recordDay(s, at(0), 'flaky');
  s = recordDay(s, at(0), 'flakefix');
  s = recordDay(s, at(9), 'flaky'); // last week
  const w = weekSummary(s, FRI, { xp: normalizeXp(null) });
  assert.equal(w.counts.flaky, 2);
  assert.equal(w.counts.flakeFixes, 1);
});

test('bugs caught for the Bugdex, and the new kinds among them, are counted for the card', () => {
  let s = recordDay(null, at(2), 'caught');
  s = recordDay(s, at(2), 'newbug');
  s = recordDay(s, at(0), 'caught');
  s = recordDay(s, at(0), 'caught');
  s = recordDay(s, at(8), 'caught'); // last week
  s = recordDay(s, at(8), 'newbug');
  assert.equal(s.days[dayKey(at(0))].caught, 2);
  const w = weekSummary(s, FRI, { xp: normalizeXp(null) });
  assert.equal(w.counts.caught, 3);
  assert.equal(w.counts.newBugs, 1);
  const quiet = weekSummary(normalizeWeekly(null), FRI, { xp: normalizeXp(null) });
  assert.equal(quiet.counts.caught, 0);
  assert.equal(quiet.counts.newBugs, 0);
});

test('junk kinds, clocks and state are ignored', () => {
  assert.deepEqual(recordDay(null, at(0), 'nap'), normalizeWeekly(null));
  assert.deepEqual(recordDay(null, NaN, 'ship'), normalizeWeekly(null));
  const s = normalizeWeekly({ days: { nope: { ship: 1 }, '2026-10-01': { ship: -3, tests: 'x', projects: { bad: 'x', [A.id]: '' } } }, since: 'later', wrapped: 5 });
  assert.deepEqual(s, { days: {}, since: null, wrapped: null });
});

test('keeps about ten weeks of days', () => {
  let s = null;
  for (let i = 0; i < KEEP_DAYS + 20; i++) s = recordDay(s, at(i), 'task');
  assert.equal(Object.keys(normalizeWeekly(s).days).length, KEEP_DAYS);
  assert.ok(normalizeWeekly(s).days[dayKey(at(0))], 'today survives');
});

test('the week: the last seven days against the seven before', () => {
  let s = null;
  s = recordDay(s, at(0), 'ship', A);
  s = recordDay(s, at(2), 'deploy', B);
  s = recordDay(s, at(2), 'minted', B);
  s = recordDay(s, at(3), 'fixed');
  s = recordDay(s, at(3), 'fixed');
  s = recordDay(s, at(5), 'task');
  s = recordDay(s, at(6), 'deps');
  s = recordDay(s, at(7), 'ship', A); // last week
  s = recordDay(s, at(7), 'fixed');
  const xp = normalizeXp({ total: 500, daily: { [dayKey(at(0))]: 120, [dayKey(at(3))]: 80, [dayKey(at(9))]: 100 } });
  const w = weekSummary(s, FRI, { xp, streak: { current: 5, longest: 9 }, level: { level: 4, title: 'Reef Runner', rank: { color: '#fff' } } });
  assert.equal(w.fromDay, dayKey(at(6)));
  assert.equal(w.toDay, dayKey(at(0)));
  assert.equal(w.days.length, 7);
  assert.equal(w.counts.projects, 2);
  assert.equal(w.counts.ships, 2);
  assert.equal(w.counts.deploys, 1);
  assert.equal(w.counts.green, 2);
  assert.equal(w.counts.tasks, 1);
  assert.equal(w.counts.checkups, 1);
  assert.equal(w.counts.newStickers, 1);
  assert.equal(w.xp, 200);
  assert.equal(w.xpPrev, 100);
  assert.equal(w.prev.projects, 1);
  assert.equal(w.prev.green, 1);
  assert.equal(w.streak.current, 5);
  assert.deepEqual(w.level, { level: 4, title: 'Reef Runner', color: '#fff' });
  assert.equal(w.activeDays, 2 + 1); // XP on two days, and a ship on a third
  assert.equal(w.headline, 'Shipped 2 projects');
  assert.equal(w.quiet, false);
});

test('before the ledger: the XP log and the stickers fill in', () => {
  const xp = normalizeXp({
    total: 300,
    log: [
      { at: at(1), kind: 'fixed', xp: 40, label: 'Tests green again' },
      { at: at(2), kind: 'task', xp: 10, label: 'Finished a task' },
      { at: at(10), kind: 'fixed', xp: 40, label: 'too old' },
    ],
  });
  let st = stickers.recordShip(null, { id: A.id, name: A.name }, 'ship', at(4)).state;
  st = stickers.recordShip(st, { id: B.id, name: B.name }, 'ship', at(30)).state; // shipped long ago
  const w = weekSummary(null, FRI, { xp, stickers: stickers.normalize(st) });
  assert.equal(w.counts.green, 1);
  assert.equal(w.counts.tasks, 1);
  assert.deepEqual(w.shipped.map(p => p.name), ['shellby']);
  assert.equal(w.shipped[0].isNew, true);
  assert.equal(w.counts.newStickers, 1);
  assert.equal(w.headline, 'Shipped shellby');
});

test('days the ledger kept are never counted twice from the XP log', () => {
  const s = recordDay(null, at(1), 'fixed');
  const xp = normalizeXp({ log: [{ at: at(1), kind: 'fixed', xp: 40, label: 'x' }] });
  assert.equal(weekSummary(s, FRI, { xp }).counts.green, 1);
});

test('the ledger starts at its earliest day, whatever order days arrive in', () => {
  // Today first, then an earlier day (a sync, a clock change): earlier still counts as kept.
  let s = recordDay(null, at(0), 'task');
  s = recordDay(s, at(4), 'fixed');
  assert.equal(s.since, dayKey(at(4)));
  const xp = normalizeXp({ log: [{ at: at(4), kind: 'fixed', xp: 40, label: 'x' }] });
  const st = stickers.recordShip(null, { id: A.id, name: A.name }, 'ship', at(4)).state;
  s = recordDay(recordDay(s, at(4), 'ship', A), at(4), 'minted', A);
  const w = weekSummary(s, FRI, { xp, stickers: stickers.normalize(st) });
  assert.equal(w.counts.green, 1, 'not again from the XP log');
  assert.equal(w.counts.newStickers, 1, 'not again from the sticker');
});

test('a friend\'s sticker is a gift, not your shipping', () => {
  const gift = { name: 'their-thing', tier: 'paper', palette: { a: '#ff0000' }, pixels: ['a'] };
  const st = stickers.receiveGuest(null, 'octocat', gift, at(1)).state;
  assert.equal(weekSummary(null, FRI, { stickers: stickers.normalize(st) }).counts.projects, 0);
});

test('headlines: the most impressive true thing', () => {
  const base = { counts: { projects: 0, green: 0, tasks: 0 }, shipped: [], xp: 0 };
  const w = weekSummary(null, FRI);
  assert.equal(w.headline, 'A quiet week in the tide pool');
  assert.equal(w.quiet, true);
  const { headline } = require('../src/main/weekly');
  assert.equal(headline({ ...base, counts: { ...base.counts, green: 3 } }), 'Turned 3 test suites green');
  assert.equal(headline({ ...base, counts: { ...base.counts, tasks: 1 } }), '1 task done');
  assert.equal(headline({ ...base, xp: 1250 }), '1,250 XP earned');
});

test('the top project: most tasks finished, else the busiest one shipped', () => {
  let s = recordWork(null, at(1), 'shellby');
  s = recordWork(s, at(0), 'rack-builder');
  s = recordWork(s, at(0), 'rack-builder');
  s = recordWork(s, at(8), 'shellby'); // last week
  s = recordWork(s, at(8), 'shellby');
  assert.deepEqual(weekSummary(s, FRI).topProject, { name: 'rack-builder', tasks: 2 });
  // No tasks anywhere this week: the project that shipped.
  assert.deepEqual(weekSummary(recordDay(null, at(1), 'ship', A), FRI).topProject, { name: 'shellby', tasks: 0 });
  assert.equal(weekSummary(null, FRI).topProject, null);
  // Junk names are skipped, and a long one is cut.
  assert.deepEqual(recordWork(null, at(0), ''), normalizeWeekly(null));
  assert.equal(Object.keys(recordWork(null, at(0), 'x'.repeat(90)).days[dayKey(at(0))].work)[0].length, 60);
});

test('new trophies: each counted once, in the order earned', () => {
  const owl = { id: 'night-owl', name: 'Night Owl', icon: '🦉' };
  let s = recordTrophy(null, at(3), owl);
  s = recordTrophy(s, at(1), { id: 'first-task', name: 'First Task', icon: '✅' });
  s = recordTrophy(s, at(0), owl); // the same one again can't count twice
  s = recordTrophy(s, at(9), { id: 'loyal', name: 'Loyal', icon: '💛' }); // last week
  s = recordTrophy(s, at(0), { id: 'Bad Id!', name: 'x' });
  const w = weekSummary(s, FRI);
  assert.deepEqual(w.trophies.map(t => t.id), ['night-owl', 'first-task']);
  assert.equal(w.trophies[0].icon, '🦉');
  assert.equal(w.counts.trophies, 2);
  assert.equal(w.headline, 'Earned 2 trophies');
  // Read back from disk, junk is dropped.
  assert.deepEqual(normalizeWeekly({ days: { [dayKey(at(0))]: { trophies: { ok: { name: '' }, 'a-b': { name: 'AB' } } } } }).days[dayKey(at(0))].trophies, { 'a-b': { name: 'AB', icon: '🏆' } });
});

test('the Friday wrap-up: once a week, for any week with something done in it', () => {
  const friAfternoon = new Date(2026, 9, 2, 16, 30).getTime();
  // Tasks alone are enough for a recap now, and so is a trophy.
  const tasks = recordDay(null, at(1), 'task');
  assert.equal(wrapUpDue(tasks, friAfternoon, weekSummary(tasks, friAfternoon)), '2026-10-02');
  const trophy = recordTrophy(null, at(1), { id: 'night-owl', name: 'Night Owl', icon: '🦉' });
  assert.equal(wrapUpDue(trophy, friAfternoon, weekSummary(trophy, friAfternoon)), '2026-10-02');
  // XP just for showing up isn't.
  const xp = normalizeXp({ total: 10, daily: { [dayKey(at(1))]: 10 } });
  assert.equal(wrapUpDue(null, friAfternoon, weekSummary(null, friAfternoon, { xp })), null);
});

test('the Friday wrap-up: once a week, at the right time', () => {
  const s = recordDay(null, at(1), 'ship', A);
  const w = weekSummary(s, FRI);
  const friAfternoon = new Date(2026, 9, 2, 16, 30).getTime();
  assert.equal(wrapUpDue(s, FRI, w), null, 'not before four');
  const key = wrapUpDue(s, friAfternoon, w);
  assert.equal(key, '2026-10-02');
  const done = markWrapped(s, key);
  assert.equal(wrapUpDue(done, friAfternoon + 3600000, w), null, 'not twice');
  // PC off on Friday: Saturday still gets it, and it's the same week.
  assert.equal(wrapUpDue(s, new Date(2026, 9, 3, 11).getTime(), w), '2026-10-02');
  assert.equal(wrapUpDue(done, new Date(2026, 9, 4, 11).getTime(), w), null);
  // A Wednesday, or a week with nothing in it: never.
  assert.equal(wrapUpDue(s, new Date(2026, 8, 30, 17).getTime(), w), null);
  assert.equal(wrapUpDue(null, friAfternoon, weekSummary(null, friAfternoon)), null);
});

test('what the plan bought: Claude\'s hours, tasks, and fixes that held', () => {
  const { recordTime, recordFix, recordRed, MAX_TURN_MS } = require('../src/main/weekly');
  const HOUR = 60 * 60 * 1000;
  let s = recordTime(null, at(0), 2 * HOUR);
  s = recordTime(s, at(1), HOUR / 2);
  s = recordTime(s, at(2), 99 * HOUR);       // a stuck clock counts as one long turn, no more
  s = recordTime(s, at(9), 5 * HOUR);        // last week
  s = recordTime(s, at(0), -4);              // junk
  s = recordDay(s, at(0), 'task');
  // Fixed Monday, broke again Wednesday: didn't hold. Fixed Thursday: holding.
  s = recordFix(s, at(4, 9), 't:shellby');
  s = recordRed(s, at(2, 9), 't:shellby');
  s = recordFix(s, at(1, 9), 't:shellby');
  s = recordFix(s, at(3), 'ci:x-salmon/shellby#12');
  // A red from before the fix doesn't undo it, and another key's red doesn't either.
  s = recordRed(s, at(5), 'ci:x-salmon/shellby#12');
  s = recordRed(s, at(0), 't:rack-builder');
  s = recordFix(s, at(0), 'nope');          // not a fix key
  const usage = { sevenDay: { pct: 61.6, resetsAt: FRI + 3 * 24 * HOUR }, fiveHour: { pct: 20, resetsAt: FRI - HOUR } };
  const p = weekSummary(s, FRI, { xp: normalizeXp(null), usage }).plan;
  assert.equal(p.ms, 2 * HOUR + HOUR / 2 + MAX_TURN_MS);
  assert.equal(p.hours, 8.5);
  assert.equal(p.msPrev, 5 * HOUR);
  assert.equal(p.tasks, 1);
  assert.equal(p.fixes, 3);
  assert.equal(p.held, 2);
  assert.equal(p.builds, 1, 'the pull request\'s checks, back to green and staying there');
  assert.deepEqual(p.weekly, { pct: 62, resetsAt: FRI + 3 * 24 * HOUR });
  assert.equal(p.fiveHour, null, 'a reading from before the reset says nothing');
});

test('the plan\'s fields survive a save and drop junk', () => {
  const s = normalizeWeekly({ days: { '2026-10-01': {
    ms: 1000, fixes: [{ at: 5, key: 't:a' }, { at: 'x', key: 't:a' }, { at: 6, key: 'bad' }, null],
    reds: { 't:a': 7, 'ci:b#1': 'x', junk: 3 },
  } } });
  assert.deepEqual(s.days['2026-10-01'], { ms: 1000, fixes: [{ at: 5, key: 't:a' }], reds: { 't:a': 7 } });
  assert.deepEqual(weekSummary(null, FRI).plan, { hours: 0, ms: 0, msPrev: 0, tasks: 0, fixes: 0, held: 0, builds: 0, weekly: null, fiveHour: null });
});

test('routines and held messages that ran while you were away: how many, and for how long', () => {
  const { recordAwayRun, MAX_TURN_MS } = require('../src/main/weekly');
  const MIN = 60 * 1000;
  let s = recordAwayRun(null, at(1), 95 * MIN);
  s = recordAwayRun(s, at(0), 95 * MIN);
  s = recordAwayRun(s, at(0), 30 * 1000, { held: true });
  s = recordAwayRun(s, at(9), 60 * MIN);     // last week
  const c = weekSummary(s, FRI, { xp: normalizeXp(null) }).counts;
  assert.equal(c.awayRuns, 3);
  assert.equal(c.awayRoutines, 2);
  assert.equal(c.awayHeld, 1);
  assert.equal(c.awayMs, 190 * MIN + 30 * 1000);
  // A stuck clock is one long turn at most.
  assert.equal(recordAwayRun(null, at(0), 99 * MAX_TURN_MS).days[dayKey(at(0))].awayMs, MAX_TURN_MS);
});

test('the week\'s work: pull requests, branches home and turns taken back', () => {
  let s = recordDay(null, at(0), 'pr');
  s = recordDay(s, at(1), 'pr');
  s = recordDay(s, at(1), 'home', null, 3);    // Bring them all home: three at once
  s = recordDay(s, at(2), 'undone', null, 4);  // one rewind, four turns back
  s = recordDay(s, at(2), 'undone', null, 0);  // nothing went back: nothing counted
  s = recordDay(s, at(2), 'undone', null, 1e9); // capped
  s = recordDay(s, at(3), 'merge', A);
  const c = weekSummary(s, FRI, { xp: normalizeXp(null) }).counts;
  assert.equal(c.prs, 2);
  assert.equal(c.homes, 3);
  assert.equal(c.undone, 104);
  assert.equal(c.merges, 1);
});

test('work lines: only what happened, best first, at most four', () => {
  const { workLines, duration, recordAwayRun } = require('../src/main/weekly');
  const MIN = 60 * 1000;
  assert.deepEqual(weekSummary(null, FRI).work, [], 'a quiet week claims nothing');
  let s = recordAwayRun(null, at(1), 190 * MIN);
  s = recordDay(s, at(1), 'undone', null, 6);
  s = recordDay(s, at(1), 'home', null, 4);
  s = recordDay(s, at(1), 'pr', null, 5);
  s = recordDay(s, at(1), 'merge', A);
  s = recordDay(s, at(1), 'merge', B);
  const w = weekSummary(s, FRI, { xp: normalizeXp(null) });
  assert.deepEqual(w.work.map(l => l.text), [
    'Routines worked 3h 10m while you were away',
    'Opened 5 pull requests, merged 2',
    'Brought 4 branches home',
    'Took back 6 turns with Rewind',
  ]);
  assert.equal(workLines(w, 2).length, 2);
  // Held messages alone, and runs too short to put a time on.
  const held = weekSummary(recordAwayRun(null, at(0), 20 * 1000, { held: true }), FRI).work;
  assert.deepEqual(held.map(l => l.text), ['Held messages ran once while you were away']);
  const one = weekSummary(recordDay(null, at(0), 'merge', A), FRI).work;
  assert.deepEqual(one.map(l => l.text), ['Merged 1 pull request']);
  assert.equal(duration(45 * MIN), '45m');
  assert.equal(duration(120 * MIN), '2h');
  assert.equal(duration(0), '1m');
});

test('a week with only work in it still earns its Friday wrap-up', () => {
  const { recordAwayRun } = require('../src/main/weekly');
  const s = recordAwayRun(null, at(0), 60 * 60 * 1000);
  const fri = new Date(2026, 9, 2, 17, 0).getTime();
  assert.equal(wrapUpDue(s, fri, weekSummary(s, fri)), dayKey(fri));
});

test('state saved before the work fields existed reads as zeros, and keeps what it had', () => {
  const old = { days: { [dayKey(at(1))]: { task: 3, ms: 5000, fixes: [{ at: at(1), key: 'ci:a/b#1' }] } }, since: dayKey(at(9)), wrapped: null };
  const s = normalizeWeekly(old);
  assert.deepEqual(s.days[dayKey(at(1))], old.days[dayKey(at(1))]);
  const w = weekSummary(old, FRI, { xp: normalizeXp(null) });
  assert.equal(w.counts.tasks, 3);
  for (const k of ['prs', 'homes', 'undone', 'awayRuns', 'awayMs']) assert.equal(w.counts[k], 0, k);
  assert.equal(w.plan.builds, 1);
  assert.deepEqual(w.work.map(l => l.id), ['builds']);
  // Junk in the new fields is dropped, not trusted.
  const junk = normalizeWeekly({ days: { '2026-10-01': { pr: -2, home: 'x', away: 1.7, awayMs: -5, undone: NaN } } });
  assert.deepEqual(junk.days['2026-10-01'], { away: 1 });
});
