const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canMolt, molt, curveMult, moltBadge, moltView, tierShell } = require('../src/main/progression/molting');
const { xpForLevel, levelFor, levelOf, normalizeXp, award, mergeXpCounts, mergeMolt } = require('../src/main/progression/xp');
const { everLevel } = require('../src/main/progression/levels');

const T0 = new Date(2026, 9, 14, 12).getTime();
const at99 = () => normalizeXp({ total: xpForLevel(99), byKind: { task: 5 } });

test('canMolt only at 99', () => {
  assert.equal(canMolt(normalizeXp({ total: xpForLevel(98) })), false);
  assert.equal(canMolt(at99()), true);
  assert.deepEqual(molt(normalizeXp({ total: 10 }), T0).ok, false);
});

test('a molt keeps total XP and byKind, and starts the level at 1', () => {
  const s = at99();
  const r = molt(s, T0);
  assert.equal(r.ok, true);
  assert.equal(r.tier, 1);
  assert.equal(r.state.total, s.total);
  assert.deepEqual(r.state.byKind, s.byKind);
  assert.deepEqual(r.state.molt, { count: 1, base: s.total, at: [T0] });
  assert.equal(levelOf(r.state).level, 1);
  assert.equal(everLevel(r.state), 99, 'every unlock is still his');
  assert.equal(canMolt(r.state), false);
});

test('the molt curve: quicker first, then slowly steeper, at most double', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 8, 30].map(curveMult), [1, 0.8, 0.9, 1, 1.1, 1.5, 2]);
  assert.equal(xpForLevel(99, 1), Math.round(xpForLevel(99) * 0.8));
  assert.equal(levelFor(xpForLevel(99, 1), 1).level, 99);
});

test('marks only start again at 99 after a molt; award levels up on the new curve', () => {
  const s = molt(at99(), T0).state;
  const r = award(s, 'trick', T0 + 1000);
  assert.equal(r.before.level, 1);
  assert.equal(r.after.level, 2, '150 XP on the 0.8 curve passes level 2 (80)');
  assert.equal(r.after.marks, 0);
});

test('the badge: roman to XII, numbers after, in the tier colour', () => {
  assert.equal(moltBadge(0), null);
  assert.deepEqual([1, 4, 12, 13].map(k => moltBadge(k).text), ['I', 'IV', 'XII', '13']);
  assert.match(moltBadge(3).color, /^#[0-9a-f]{6}$/i);
});

test('moltView: the next tier shell, how far to 99, the tiers earned', () => {
  const v = moltView(molt(at99(), T0).state);
  assert.equal(v.count, 1);
  assert.equal(v.next.id, 'molt-2');
  assert.equal(v.current.name, tierShell(1).name);
  assert.deepEqual(v.tiers.map(t => t.id), ['molt-1']);
  assert.equal(v.xpTo99, xpForLevel(99, 1));
});

test('sync: the side that molted more wins; for the same count, the lower base', () => {
  assert.equal(mergeMolt({ count: 2, base: 900 }, { count: 1, base: 10 }).count, 2);
  assert.equal(mergeMolt({ count: 1, base: 900, at: [2] }, { count: 1, base: 500, at: [1] }).base, 500);
  const m = mergeXpCounts({ byDevice: { 'pc-aaaa': 10 }, molt: { count: 1, base: 5 } }, { byDevice: { 'pc-bbbb': 20 } });
  assert.deepEqual(m.molt, { count: 1, base: 5, at: [] });
});
