const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/main/progression/levels');
const depths = require('../src/wardrobe/depths.json');

test('every level from 20 to 99 unlocks something, with at most 5 gaps', () => {
  const gaps = [];
  for (let l = 20; l <= 99; l++) if (!L.unlocksAt(l).length) gaps.push(l);
  assert.ok(gaps.length <= 5, `levels with nothing: ${gaps.join(', ')}`);
});

test('art the table names but depths.json lacks is left out (listed, not failed)', () => {
  if (L.MISSING_ART.length) console.warn(`levels without art yet: ${L.MISSING_ART.map(m => `${m.level} ${m.id}`).join(', ')}`);
  const ids = new Set([...depths.decor, ...depths.effects].map(x => x.id));
  for (const u of L.UNLOCKS.filter(u => u.kind === 'decor' || u.kind === 'effect')) assert.ok(ids.has(u.id), `${u.id} is in depths.json`);
  for (const x of [...depths.decor, ...depths.effects]) {
    const u = L.UNLOCKS.find(v => v.id === x.id);
    assert.ok(u, `${x.id} is on the ladder`);
    assert.equal(x.unlock.level, u.level, `${x.id}: depths.json and levels.js agree on its level`);
  }
});

test('nextUnlock and its progress', () => {
  const n = L.nextUnlock(31, { xp: L.xpForLevel(31) });
  assert.equal(n.level, 32);
  assert.equal(n.fromLevel, 31);
  assert.equal(n.unlocks[0].kind, 'shell', 'the shell leads');
  assert.equal(n.progress, 0);
  assert.equal(n.xpToGo, L.xpForLevel(32) - L.xpForLevel(31));
  assert.equal(L.nextUnlock(31, { xp: L.xpForLevel(32) }).progress, 1);
  assert.equal(L.nextUnlock(99), null);
  assert.equal(L.nextUnlock(5).xpToGo, undefined, 'no XP given: no countdown');
});

test('perks open at the level ever reached', () => {
  assert.equal(L.perksFor(21).has('rested-plus'), false);
  assert.deepEqual([...L.perksFor(44)].sort(), ['bounty-reroll', 'battle-replay', 'fourth-bounty', 'rested-plus', 'tide-out-plus'].sort());
  assert.equal(L.perksFor(L.everLevel({ total: 0, molt: { count: 1 } })).has('molting'), true, 'after a molt, all of them');
});

test('milestone tiers', () => {
  assert.equal(L.milestone(1), null);
  assert.equal(L.milestone(21).tier, 'minor');
  assert.deepEqual([20, 30, 40, 60, 70, 80, 90].map(l => L.milestone(l).tier), Array(7).fill('major'));
  assert.deepEqual([50, 99].map(l => L.milestone(l).tier), ['legend', 'legend']);
  assert.equal(L.milestone(30).fanfare.rank, 'Kelp');
});

test('everLevel: 99 after any molt, else the level now', () => {
  assert.equal(L.everLevel({ total: L.xpForLevel(12) }), 12);
  assert.equal(L.everLevel({ total: 0, molt: { count: 2 } }), 99);
  assert.equal(L.everLevel(null), 1);
});

test('the ladder and the seen state', () => {
  const rows = L.ladder(30, 25);
  assert.equal(rows.length, 98);
  assert.deepEqual(rows.filter(r => r.isNew).map(r => r.level), [26, 27, 28, 29, 30]);
  assert.deepEqual(L.normalizeUnlockSeen({ level: 500, worn: ['snail', 'snail', 7] }), { level: 99, worn: ['snail'] });
});
