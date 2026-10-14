const { test } = require('node:test');
const assert = require('node:assert/strict');
const Y = require('../src/main/yearbook');
const { slides, cardTiles } = require('../src/main/yearbook-slides');

// Local times, as the app sees them: the year turns at local midnight.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);
const stat = (event, payload = {}) => ({ event, payload });

// A year with `n` active days in it, starting on Mar 1.
function yearWith(year, n, state = undefined) {
  let s = state;
  for (let i = 0; i < n; i++) s = Y.note(s, 'stat', stat('task-completed'), at(year, 3, 1 + i));
  return s;
}

test('normalize turns junk into an empty yearbook and never throws', () => {
  for (const raw of [undefined, null, 7, 'x', [], { years: 'lots' }, { years: { abc: {}, 2026: 5 } }, { shown: [1, '2025', 'nope'] }]) {
    const s = Y.normalize(raw);
    assert.ok(s.years && typeof s.years === 'object');
    assert.ok(Array.isArray(s.shown));
    assert.equal(s.backfilled, false);
  }
  assert.deepEqual(Y.normalize({ shown: [1, '2025', 'nope'] }).shown, ['2025']);
  const y = Y.normalize({ years: { 2026: { xp: -5, tasks: 'many', hours: [1, 'x'], ships: { ok: 2, '': 3, 'bad\u0000': 1 } } } }).years['2026'];
  assert.equal(y.xp, 0);
  assert.equal(y.tasks, 0);
  assert.equal(y.hours.length, 24);
  assert.equal(y.hours[0], 1);
  assert.deepEqual(y.ships, { ok: 2 });
});

test('note aggregates XP, kinds, ships, days and when in the day it happened', () => {
  let s;
  s = Y.note(s, 'xp', { kind: 'ship', gained: 40, project: 'shellby' }, at(2026, 5, 4, 9));
  s = Y.note(s, 'xp', { kind: 'ship', gained: 0, project: 'shellby' }, at(2026, 5, 4, 10));
  s = Y.note(s, 'xp', { kind: 'task', gained: 5 }, at(2026, 5, 5, 22));
  s = Y.note(s, 'xp', { kind: 'merged', gained: 50, project: 'rack' }, at(2026, 5, 5, 22));
  s = Y.note(s, 'xp', { kind: 'quiz', gained: 15 }, at(2026, 5, 5, 22));
  s = Y.note(s, 'xp', { kind: 'NOPE', gained: 99 }, at(2026, 5, 5, 22));
  const y = s.years['2026'];
  assert.equal(y.xp, 110);
  assert.deepEqual(y.byKind, { ship: 40, task: 5, merged: 50, quiz: 15 });
  assert.deepEqual(y.ships, { shellby: 2 }, 'a push counts even when repetition paid nothing');
  assert.equal(y.merged, 1);
  assert.equal(y.quizzes, 1);
  assert.deepEqual(y.days, ['2026-05-04', '2026-05-05']);
  assert.equal(y.hours[22], 3);
  assert.equal(y.hours[10], 0, 'nothing paid, no mark on the heatmap');
  assert.deepEqual(y.dayXp, { '2026-05-04': 40, '2026-05-05': 70 });
});

test('note counts stats: tasks, catches by species, nests, fixes, review and the reef', () => {
  let s;
  const t = at(2026, 6, 1);
  for (const [e, p] of [
    ['task-completed'], ['task-completed'], ['bug-caught', { species: 'nullfish', fresh: true }], ['bug-caught', { species: 'nullfish' }],
    ['bug-caught', { species: 'off-by-one' }], ['nest-cleared'], ['clean-fix'], ['fix-held'], ['fix-held'], ['rematch-won'],
    ['review-caught'], ['review-tier', { n: 3 }], ['review-tier', { n: 2 }], ['reef-best'], ['reef-thriving', { n: 2 }],
    ['tide-perfect'], ['focus-completed'], ['find-made'], ['deployed'], ['sparkle-found'], ['not-a-stat'],
  ]) s = Y.note(s, 'stat', stat(e, p), t);
  const y = s.years['2026'];
  assert.equal(y.tasks, 2);
  assert.equal(y.catches, 3);
  assert.deepEqual(y.bySpecies, { nullfish: 2, 'off-by-one': 1 });
  assert.equal(y.newSpecies, 1);
  assert.equal(y.nestsCleared, 1);
  assert.equal(y.cleanFixes, 1);
  assert.equal(y.held, 2);
  assert.equal(y.rematchesWon, 1);
  assert.equal(y.reviewCaught, 1);
  assert.equal(y.reviewTier, 3, 'a high-water mark');
  assert.equal(y.reefBests, 1);
  assert.equal(y.thrivingMax, 2);
  assert.equal(y.tidePerfect, 1);
  assert.equal(y.focusSessions, 1);
  assert.equal(y.finds, 1);
  assert.equal(y.deploys, 1);
  assert.equal(y.shiny, 1);
  assert.equal(y.firstTaskAt, t.getTime());
});

test('levels, medals and molts count only what went up within the year', () => {
  let s;
  s = Y.note(s, 'stat', stat('level', { n: 12 }), at(2026, 1, 5));   // first sighting: the baseline
  s = Y.note(s, 'stat', stat('level', { n: 12 }), at(2026, 1, 6));
  s = Y.note(s, 'stat', stat('level', { n: 14 }), at(2026, 2, 1));
  s = Y.note(s, 'stat', stat('event-medal', { n: 1 }), at(2026, 2, 1)); // the first medal ever, nothing seeded: one
  s = Y.note(s, 'stat', stat('event-medal', { n: 1 }), at(2026, 2, 2)); // the same total again: nothing
  s = Y.note(s, 'stat', stat('event-medal', { n: 2 }), at(2026, 4, 1));
  s = Y.note(s, 'stat', stat('molted', { n: 1 }), at(2026, 9, 1));
  s = Y.note(s, 'stat', stat('level', { n: 1 }), at(2026, 9, 1));  // a Molt starts the number again
  s = Y.note(s, 'stat', stat('level', { n: 3 }), at(2026, 9, 2));
  const y = s.years['2026'];
  assert.equal(y.startLevel, 12);
  assert.equal(y.endLevel, 3);
  assert.equal(y.levelsGained, 4, '12 → 14, then 1 → 3');
  assert.equal(y.medals, 2);
  assert.equal(y.molts, 1, 'the first molt counts');
  // The next year starts where this one ended.
  s = Y.note(s, 'stat', stat('event-medal', { n: 3 }), at(2027, 1, 3));
  assert.equal(s.years['2027'].startLevel, 3);
  assert.equal(s.years['2027'].medals, 1);
});

test('backfill seeds the medal and molt totals, so an old total reported again adds nothing', () => {
  let s = Y.backfill(undefined, { medals: 5, molts: 2 }, at(2026, 6, 1));
  s = Y.note(s, 'stat', stat('event-medal', { n: 5 }), at(2026, 6, 2));
  s = Y.note(s, 'stat', stat('molted', { n: 2 }), at(2026, 6, 2));
  assert.equal(s.years['2026'].medals, 0);
  assert.equal(s.years['2026'].molts, 0);
  s = Y.note(s, 'stat', stat('event-medal', { n: 6 }), at(2026, 7, 1));
  assert.equal(s.years['2026'].medals, 1);
});

test('trophies and tank pieces earned are listed once each', () => {
  let s;
  s = Y.note(s, 'trophy', { id: 'nest-warden', pieces: ['nest-cairn'] }, at(2026, 7, 1));
  s = Y.note(s, 'trophy', { id: 'nest-warden', pieces: ['nest-cairn'] }, at(2026, 7, 2));
  s = Y.note(s, 'trophy', { id: 'Bad Id!', pieces: ['x'] }, at(2026, 7, 2));
  assert.deepEqual(s.years['2026'].trophies, ['nest-warden']);
  assert.deepEqual(s.years['2026'].piecesEarned, ['nest-cairn']);
});

test('note never changes the state it was given', () => {
  const s = yearWith(2026, 2);
  const copy = JSON.stringify(s);
  Y.note(s, 'xp', { kind: 'task', gained: 5 }, at(2026, 8, 1));
  assert.equal(JSON.stringify(s), copy);
});

test('wrappedDue waits for January 2nd, local time', () => {
  const s = yearWith(2026, 5);
  assert.equal(Y.wrappedDue(s, at(2026, 12, 31, 23)), null);
  assert.equal(Y.wrappedDue(s, at(2027, 1, 1, 0)), null, 'New Year\'s Day is for the year itself');
  assert.equal(Y.wrappedDue(s, at(2027, 1, 1, 23)), null);
  assert.equal(Y.wrappedDue(s, new Date(2027, 0, 2, 0, 0, 0)), 2026, 'midnight on the 2nd');
  assert.equal(Y.wrappedDue(s, at(2027, 3, 15)), 2026, 'a late first launch still gets it');
  const shown = Y.markShown(s, 2026);
  assert.equal(Y.wrappedDue(shown, at(2027, 1, 5)), null, 'once a year');
  assert.deepEqual(Y.markShown(shown, 2026), shown, 'marking twice changes nothing');
});

test('a year needs at least three days together', () => {
  assert.equal(Y.wrappedDue(yearWith(2026, 2), at(2027, 1, 2)), null);
  assert.equal(Y.wrappedDue(yearWith(2026, 3), at(2027, 1, 2)), 2026);
});

test('missed years: the newest opens by itself, the rest wait in available', () => {
  let s = yearWith(2024, 4);
  s = yearWith(2025, 4, s);
  s = yearWith(2026, 4, s);
  const now = at(2027, 2, 1);
  assert.equal(Y.wrappedDue(s, now), 2026);
  assert.deepEqual(Y.available(s, now).map(a => [a.year, a.shown]), [[2026, false], [2025, false], [2024, false]]);
  s = Y.markShown(s, 2026);
  assert.equal(Y.wrappedDue(s, now), 2025, 'the one before is next');
  assert.deepEqual(Y.available(s, now).map(a => a.year), [2026, 2025, 2024], 'a shown year can be opened again');
  assert.equal(Y.available(s, at(2026, 6, 1)).some(a => a.year === 2026), false, 'never the year still going');
});

test('the yearbook keeps ten years', () => {
  let s;
  for (let y = 2010; y < 2026; y++) s = Y.note(s, 'stat', stat('task-completed'), at(y, 3, 1));
  assert.equal(Object.keys(s.years).length, Y.KEEP_YEARS);
  assert.ok(!s.years['2010'] && s.years['2025']);
});

test('backfill fills this year once from what Shellby kept, and marks it partial', () => {
  const now = at(2026, 10, 14);
  const sources = {
    days: ['2025-12-30', '2026-08-05', '2026-08-06', '2026-10-01', '2026-11-30'],
    xpDaily: { '2026-10-01': 120, '2026-10-02': 30, '2025-12-31': 999 },
    xpDailyKinds: { '2026-10-01': { task: 20, ship: 100 } },
    bugMonths: { '2026-09': { local: { jars: 4, shinies: 1 }, other: { jars: 2, shinies: 0 } }, '2025-11': { local: { jars: 9 } } },
    bugFirsts: [at(2026, 9, 3).getTime(), at(2025, 2, 1).getTime()],
    level: 17,
  };
  const s = Y.backfill(undefined, sources, now);
  const y = s.years['2026'];
  assert.equal(s.backfilled, true);
  assert.equal(y.partial, true);
  assert.equal(y.since, '2026-08-05', 'the earliest day found this year');
  assert.deepEqual(y.days, ['2026-08-05', '2026-08-06', '2026-10-01', '2026-10-02'], 'no other years, nothing after today');
  assert.equal(y.xp, 150);
  assert.deepEqual(y.byKind, { ship: 100, task: 20 });
  assert.equal(y.catches, 6);
  assert.equal(y.shiny, 1);
  assert.equal(y.newSpecies, 1);
  assert.equal(y.startLevel, 17);
  assert.deepEqual(Y.backfill(s, { ...sources, xpDaily: { '2026-10-03': 500 } }, now), s, 'only ever once');
  const sum = Y.summary(s, 2026);
  assert.equal(sum.partial, true);
  assert.equal(slides(sum, {})[0].lines.some(l => l.includes('since Aug 5')), true, 'the first slide says since when');
});

test('backfill never doubles a day already recorded', () => {
  let s = Y.note(undefined, 'xp', { kind: 'task', gained: 10 }, at(2026, 10, 1));
  s = Y.backfill(s, { xpDaily: { '2026-10-01': 10, '2026-09-30': 5 } }, at(2026, 10, 1, 13));
  assert.equal(s.years['2026'].xp, 15);
});

test('summary works out streaks, the busiest day and hour, the nemesis and the top projects', () => {
  let s;
  for (const d of [1, 2, 3, 5, 6]) s = Y.note(s, 'stat', stat('active'), at(2026, 3, d));
  s = Y.note(s, 'xp', { kind: 'ship', gained: 40, project: 'a' }, at(2026, 3, 2, 15));
  s = Y.note(s, 'xp', { kind: 'ship', gained: 40, project: 'b' }, at(2026, 3, 2, 15));
  s = Y.note(s, 'xp', { kind: 'ship', gained: 40, project: 'b' }, at(2026, 3, 3, 9));
  s = Y.note(s, 'stat', stat('bug-caught', { species: 'nullfish' }), at(2026, 3, 3));
  const sum = Y.summary(s, 2026);
  assert.equal(sum.activeDays, 5);
  assert.equal(sum.longestStreak, 3);
  assert.deepEqual(sum.busiestDay, { day: '2026-03-02', xp: 80 });
  assert.equal(sum.busiestHour, 15);
  assert.equal(sum.busiestWeekday, 1, 'Mar 2 2026 is a Monday');
  assert.deepEqual(sum.topProjects, [{ name: 'b', n: 2 }, { name: 'a', n: 1 }]);
  assert.deepEqual(sum.nemesis, { id: 'nullfish', n: 1 });
  assert.equal(Y.summary(s, 1999), null);
  assert.equal(Y.longestRun(['2026-02-28', '2026-03-01', '2026-03-02']), 3, 'across a month end');
  assert.equal(Y.longestRun(['2024-12-31', '2025-01-01']), 2, 'across a year end');
});

test('slides leave out what has nothing to say, and always start with the year and end with the card', () => {
  const quiet = Y.summary(yearWith(2026, 3), 2026);
  assert.deepEqual(slides(quiet, {}).map(x => x.id), ['year', 'days', 'card']);
  let s = yearWith(2026, 3);
  s = Y.note(s, 'xp', { kind: 'ship', gained: 40, project: 'shellby' }, at(2026, 4, 1, 10));
  s = Y.note(s, 'stat', stat('bug-caught', { species: 'nullfish' }), at(2026, 4, 1));
  s = Y.note(s, 'stat', stat('fix-held'), at(2026, 4, 1));
  s = Y.note(s, 'stat', stat('review-caught'), at(2026, 4, 1));
  s = Y.note(s, 'stat', stat('event-medal', { n: 1 }), at(2026, 4, 1));
  s = Y.note(s, 'stat', stat('reef-best'), at(2026, 4, 1));
  s = Y.note(s, 'trophy', { id: 'nest-warden', pieces: ['nest-cairn'] }, at(2026, 4, 1));
  const busy = Y.summary(s, 2026);
  const ctx = { speciesName: id => (id === 'nullfish' ? 'Nullfish' : null), pieceName: () => 'Cairn of Ten Nests', deepCuts: true };
  const list = slides(busy, ctx);
  assert.deepEqual(list.map(x => x.id), ['year', 'days', 'when', 'shipped', 'bugdex', 'fixes', 'reef', 'review', 'tides', 'pieces', 'deep', 'card']);
  assert.ok(list.find(x => x.id === 'bugdex').lines.some(l => l.includes('Nullfish')));
  assert.equal(list.find(x => x.id === 'pieces').pieces[0].name, 'Cairn of Ten Nests');
  assert.ok(list.find(x => x.id === 'when').heat.hours.length === 24);
  assert.ok(!slides(busy, {}).some(x => x.id === 'deep'), 'deep cuts need the perk');
  for (const x of list) assert.ok(x.title && Array.isArray(x.lines), `${x.id} has words`);
});

test('the card has six tiles, XP and days first, then the biggest of the rest', () => {
  let s = yearWith(2026, 4);
  s = Y.note(s, 'stat', stat('bug-caught', { species: 'x' }), at(2026, 4, 1));
  const tiles = cardTiles(Y.summary(s, 2026));
  assert.deepEqual(tiles.slice(0, 3).map(t => t[0]), ['XP', 'days together', 'bugs caught']);
  assert.ok(tiles.length <= 6);
  assert.ok(tiles.every(([, v]) => typeof v === 'string'));
});
