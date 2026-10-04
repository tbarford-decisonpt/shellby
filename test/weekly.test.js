const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWeekly, recordDay, markWrapped, weekSummary, wrapUpDue, dayKey, KEEP_DAYS } = require('../src/main/weekly');
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

test('the Friday wrap-up: once a week, only for a week that shipped', () => {
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
  // A Wednesday, or a week with nothing shipped: never.
  assert.equal(wrapUpDue(s, new Date(2026, 8, 30, 17).getTime(), w), null);
  assert.equal(wrapUpDue(null, friAfternoon, weekSummary(null, friAfternoon)), null);
});
