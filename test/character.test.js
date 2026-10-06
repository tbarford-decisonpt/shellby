const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STATS, CLASSES, statValue, xpForStat, classFor, characterSheet, isStatKind, noteClass, newClass } = require('../src/main/character');
const { normalizeXp, award, xpSummary } = require('../src/main/xp');
const { weekSummary } = require('../src/main/weekly');

// Tuesday 6 October 2026, mid-morning (local time).
const NOW = new Date(2026, 9, 6, 10, 0).getTime();
const day = back => { const d = new Date(2026, 9, 6 - back); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const xpWith = (byKind, extra = {}) => normalizeXp({ total: 10000, byKind, ...extra });
const stat = (sheet, id) => sheet.stats.find(s => s.id === id);

test('stats are 10 at their scale and grow with the square root of XP', () => {
  for (const s of STATS) {
    assert.equal(statValue(0, s.scale), 0);
    assert.equal(statValue(s.scale, s.scale), 10);
    assert.equal(statValue(s.scale * 4, s.scale), 20);
    assert.equal(statValue(s.scale * 1e6, s.scale), 99);
    assert.equal(statValue(xpForStat(37, s.scale), s.scale), 37);
  }
  assert.equal(statValue(NaN, 100), 0);
  assert.equal(statValue(-50, 100), 0);
});

test('each stat adds up the XP kinds that feed it', () => {
  const sheet = characterSheet(xpWith({ ship: 300, deploy: 50, issue: 50, tests: 400, fixed: 100, trick: 300, tidy: 90, fresh: 30, pet: 999 }), NOW);
  assert.deepEqual(sheet.stats.map(s => [s.id, s.xp, s.value]), [
    ['shipping', 400, 10], ['rigour', 500, 10], ['craft', 300, 10], ['tidiness', 120, 10],
  ]);
  // Petting him is lovely, but it's not a stat.
  assert.equal(sheet.stats.reduce((n, s) => n + s.xp, 0), 1320);
});

test('the highest stat names the class', () => {
  assert.equal(characterSheet(xpWith({ ship: 4000 }), NOW).cls.name, 'Shipper');
  assert.equal(characterSheet(xpWith({ tests: 5000, ship: 400 }), NOW).cls.name, 'Tester');
  assert.equal(characterSheet(xpWith({ trick: 3000 }), NOW).cls.name, 'Toolsmith');
  assert.equal(characterSheet(xpWith({ tidy: 1200 }), NOW).cls.name, 'Curator');
});

test('two stats close together make a dual class, all four a Polymath', () => {
  const dual = characterSheet(xpWith({ ship: 4000, tests: 4600 }), NOW).cls;
  assert.equal(dual.id, 'shipping-rigour');
  assert.equal(dual.name, 'Release Engineer');
  assert.deepEqual(dual.stats, ['shipping', 'rigour']);
  // Pairs are named in STATS order whichever is higher.
  assert.equal(characterSheet(xpWith({ trick: 3000, ship: 3600 }), NOW).cls.id, 'shipping-craft');
  const all = characterSheet(xpWith({ ship: 4000, tests: 5000, trick: 3000, tidy: 1200 }), NOW).cls;
  assert.equal(all.id, 'polymath');
  assert.equal(all.stats.length, 4);
  // Every pair has a name.
  for (let i = 0; i < STATS.length; i++) {
    for (let j = i + 1; j < STATS.length; j++) assert.ok(CLASSES[`${STATS[i].id}-${STATS[j].id}`], `${STATS[i].id}-${STATS[j].id}`);
  }
});

test('too little XP to call it: a Wanderer', () => {
  assert.equal(characterSheet(normalizeXp(null), NOW).cls.id, 'wanderer');
  assert.equal(characterSheet(xpWith({ ship: 40 }), NOW).cls.id, 'wanderer');
  assert.equal(classFor([]).id, 'wanderer');
});

test("this week's XP shows as stat points gained and a class for the week", () => {
  const xp = xpWith({ ship: 1600, tests: 500 }, { dailyKinds: { [day(0)]: { tests: 300 }, [day(6)]: { tests: 100 }, [day(7)]: { ship: 1200 } } });
  const sheet = characterSheet(xp, NOW);
  assert.equal(stat(sheet, 'rigour').week, 400);
  assert.equal(stat(sheet, 'rigour').gain, 10 - statValue(100, 500));
  assert.equal(stat(sheet, 'shipping').week, 0); // eight days ago is last week
  assert.equal(stat(sheet, 'shipping').gain, 0);
  assert.equal(sheet.cls.name, 'Shipper');
  assert.equal(sheet.weekCls.name, 'Tester');
  assert.equal(characterSheet(xpWith({ ship: 1600 }), NOW).weekCls, null);
});

test('a week never counts for more than all time', () => {
  const sheet = characterSheet(xpWith({ ship: 40 }, { dailyKinds: { [day(0)]: { ship: 9999 } } }), NOW);
  assert.equal(stat(sheet, 'shipping').week, 40);
});

test('next and progress point at the next stat point', () => {
  const s = stat(characterSheet(xpWith({ ship: 500 }), NOW), 'shipping');
  assert.equal(s.value, 11);
  assert.equal(s.next, xpForStat(12, 400) - 500);
  assert.ok(s.progress > 0 && s.progress < 1);
});

test('a new class is found once, then remembered', () => {
  const xp = xpWith({ tests: 5000 });
  assert.equal(newClass(xp, NOW).name, 'Tester');
  const kept = normalizeXp(noteClass(xp, 'rigour'));
  assert.deepEqual(kept.classes, ['rigour']);
  assert.equal(newClass(kept, NOW), null);
  assert.deepEqual(characterSheet(kept, NOW).seen, [{ id: 'rigour', name: 'Tester', icon: '🧪' }]);
  // Wandering doesn't count, and unknown ids aren't kept.
  assert.equal(newClass(normalizeXp(null), NOW), null);
  assert.equal(noteClass(xp, 'necromancer'), xp);
  assert.equal(noteClass(kept, 'rigour'), kept);
});

test('only stat XP can change his class', () => {
  for (const k of ['ship', 'deploy', 'issue', 'tests', 'fixed', 'flakefix', 'deps', 'trick', 'tidy', 'fresh']) assert.ok(isStatKind(k), k);
  for (const k of ['pet', 'day', 'trophy', 'task', 'bounty', 'nope']) assert.ok(!isStatKind(k), k);
});

test('awarding XP records it per kind per day, for the sheet', () => {
  let s = award(null, 'ship', NOW, { project: 'shellby' }).state;
  s = award(s, 'tests', NOW + 1000, { project: 'shellby' }).state;
  assert.deepEqual(Object.keys(s.dailyKinds), [day(0)]);
  assert.equal(s.dailyKinds[day(0)].ship, s.byKind.ship);
  assert.equal(s.dailyKinds[day(0)].tests, s.byKind.tests);
  const v = xpSummary(s, NOW + 2000);
  assert.equal(stat(v.character, 'shipping').week, s.byKind.ship);
});

test('junk in dailyKinds and classes is dropped; old days roll off', () => {
  const days = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [day(i), { ship: 10 }]));
  const s = normalizeXp({ dailyKinds: { ...days, nope: { ship: 1 }, [day(0)]: { ship: -4, 'Bad Kind': 3, tests: 'x' } }, classes: ['rigour', 42, 'NO WAY', 'x'.repeat(40), 'rigour'] });
  // The newest 30 days are kept, and today, with nothing valid left, drops out.
  assert.equal(Object.keys(s.dailyKinds).length, 29);
  assert.equal(s.dailyKinds[day(0)], undefined);
  assert.equal(s.dailyKinds[day(30)], undefined);
  assert.ok(s.dailyKinds[day(1)]);
  assert.deepEqual(s.classes, ['rigour']);
  assert.deepEqual(normalizeXp('garbage').dailyKinds, {});
});

test('the week card carries the sheet', () => {
  const xp = xpWith({ tests: 5000 });
  assert.equal(weekSummary(null, NOW, { xp }).character.cls.name, 'Tester');
  assert.equal(weekSummary(null, NOW, {}).character, null);
});
