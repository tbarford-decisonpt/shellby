const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const n = require('../src/main/needs');

const T0 = new Date(2026, 9, 4, 9, 0, 0).getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Tick every `step` for `ms`, the way life.js's watch loop does.
function run(state, from, ms, ctx, step = 15 * 1000) {
  let s = state;
  let t = from;
  for (; t < from + ms; t += step) s = n.tick(s, t, ctx).state;
  return { state: s, t };
}
const meters = s => n.normalize(s).meters;
const withMeters = m => ({ ...n.normalize(null), meters: { ...n.normalize(null).meters, ...m }, updatedAt: T0 });

test('a new crab starts full, happy and with an empty pantry', () => {
  const s = n.normalize(null);
  for (const k of n.METERS) assert.equal(s.meters[k], 100);
  assert.equal(n.pantryTotal(s), 0);
  assert.equal(n.mood(s).mood, 'happy');
});

test('normalize survives garbage from disk and never mutates its input', () => {
  const raw = Object.freeze({ meters: Object.freeze({ fullness: 'lots', tidiness: -50, energy: NaN, cheer: 9999 }), pantry: { plankton: -3, krill: 2.7, golden: 40 }, totals: 'x', today: { date: 5, earned: { task: -1, nope: 3 } } });
  const s = n.normalize(raw);
  assert.equal(s.meters.fullness, 100);
  assert.equal(s.meters.tidiness, n.FLOOR.tidiness);
  assert.equal(s.meters.energy, 100);
  assert.equal(s.meters.cheer, 100);
  assert.equal(s.pantry.plankton, 0);
  assert.equal(s.pantry.krill, 2);
  assert.ok(n.pantryTotal(s) <= n.PANTRY_MAX);
  assert.deepEqual(s.today.earned, { task: 0 });
  assert.equal(s.totals.fed, 0);
  for (const bad of [undefined, 42, 'x', [], { meters: [] }]) assert.equal(n.normalize(bad).meters.cheer, 100);
});

test('no meter ever goes below its floor, even after a fortnight at the PC without a break', () => {
  let s = { ...n.normalize(null), updatedAt: T0 };
  for (let i = 1; i <= 14 * 24 * 60; i++) s = n.tick(s, T0 + i * MIN, { present: true }).state;
  for (const k of n.METERS) assert.equal(meters(s)[k], n.FLOOR[k], k);
  for (let i = 0; i < 200; i++) for (const e of Object.keys(n.WEAR)) s = n.wear(s, e);
  for (const k of n.METERS) assert.ok(meters(s)[k] >= n.FLOOR[k], k);
});

test('nothing goes down while you are away, however long', () => {
  const start = withMeters({ fullness: 60, tidiness: 60, cheer: 60, energy: 60 });
  const { state } = run(start, T0, 7 * DAY, { present: false }, MIN);
  assert.equal(meters(state).fullness, 60);
  assert.equal(meters(state).tidiness, 60);
  assert.equal(meters(state).cheer, 60);
  assert.ok(meters(state).energy > 60, 'he rests while you are away');
});

test('a gap in the ticks (app closed, PC asleep) costs him nothing', () => {
  const s = { ...n.normalize(null), updatedAt: T0 };
  for (const gap of [3 * DAY, 10 * MIN, n.MAX_STEP + 1]) {
    const r = n.tick(s, T0 + gap, { present: true }).state;
    assert.equal(meters(r).fullness, 100, `a ${gap} ms gap`);
    assert.equal(r.updatedAt, T0 + gap, 'and the clock catches up');
  }
  assert.ok(meters(n.tick(s, T0 + MIN, { present: true }).state).fullness < 100, 'a normal tick still counts');
});

test('decay is slow: half a working day leaves him fine', () => {
  const { state } = run({ ...n.normalize(null), updatedAt: T0 }, T0, 4 * HOUR, { present: true }, MIN);
  assert.ok(meters(state).fullness > 70);
  assert.ok(meters(state).cheer > 60);
  assert.notEqual(n.mood(state).mood, 'mopey');
});

test('coming back after an hour away: cheer is full again and it says so', () => {
  let s = withMeters({ cheer: 40 });
  s = n.tick(s, T0 + MIN, { present: false }).state;
  const r = n.tick(s, T0 + 2 * HOUR, { present: true });
  assert.equal(r.back, true);
  assert.equal(meters(r.state).cheer, 100);
  const again = n.tick(r.state, T0 + 2 * HOUR + MIN, { present: true });
  assert.equal(again.back, false);
});

test('napping brings his pep back', () => {
  const { state } = run(withMeters({ energy: 35 }), T0, HOUR, { present: true, napping: true }, MIN);
  assert.ok(meters(state).energy >= 60);
});

test('one kind act lifts him out of mopey', () => {
  const mopey = withMeters({ cheer: n.FLOOR.cheer });
  assert.equal(n.mood(mopey).mood, 'mopey');
  assert.notEqual(n.mood(n.attend(mopey, 'pet')).mood, 'mopey');
  assert.notEqual(n.mood(n.attend(mopey, 'play')).mood, 'mopey');
  const hungry = withMeters({ cheer: n.FLOOR.cheer, fullness: 60 });
  const fed = n.feed({ ...hungry, pantry: { plankton: 1, krill: 0, golden: 0 } }, T0);
  assert.ok(fed.ok);
  assert.equal(fed.was, 'mopey');
  assert.notEqual(n.mood(fed.state).mood, 'mopey');
});

test('mood shows the most important need first and lists every low one', () => {
  const s = withMeters({ fullness: 30, tidiness: 30, energy: 35, cheer: 40 });
  assert.deepEqual(n.mood(s), { mood: 'mopey', low: ['fullness', 'tidiness', 'energy', 'cheer'] });
  assert.equal(n.mood(withMeters({ fullness: 30, tidiness: 30 })).mood, 'peckish');
  assert.equal(n.mood(withMeters({ energy: 35, tidiness: 30 })).mood, 'sleepy');
  assert.equal(n.mood(withMeters({ tidiness: 30 })).mood, 'sandy');
  assert.equal(n.mood(withMeters({ fullness: 60 })).mood, 'content');
});

test('feeding: empty pantry says so, a stuffed crab keeps the snack', () => {
  const empty = n.feed(withMeters({ fullness: 50 }), T0);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
  const full = n.feed({ ...n.normalize(null), pantry: { plankton: 2, krill: 0, golden: 0 } }, T0);
  assert.equal(full.reason, 'stuffed');
  assert.equal(full.state.pantry.plankton, 2);
});

test('feeding eats the plainest snack unless one is named', () => {
  const s = { ...withMeters({ fullness: 40 }), pantry: { plankton: 1, krill: 1, golden: 1 } };
  const a = n.feed(s, T0);
  assert.equal(a.ate, 'plankton');
  assert.equal(a.state.pantry.plankton, 0);
  assert.equal(a.state.meters.fullness, 40 + n.SNACKS.plankton.fill);
  assert.equal(a.state.totals.fed, 1);
  const b = n.feed(s, T0, 'golden');
  assert.equal(b.ate, 'golden');
  assert.equal(b.state.totals.golden, 1);
  assert.equal(n.feed({ ...s, pantry: { plankton: 1, krill: 0, golden: 0 } }, T0, 'krill').reason, 'empty');
  assert.equal(s.pantry.plankton, 1, 'input untouched');
});

test('earning respects each source\'s daily cap, and a new day resets it', () => {
  let s = n.normalize(null);
  let got = 0;
  for (let i = 0; i < 20; i++) { const r = n.earn(s, 'task-completed', T0 + i); s = r.state; got += r.n; }
  assert.equal(got, n.SOURCES['task-completed'].perDay);
  assert.equal(n.earn(s, 'task-completed', T0 + 100).reason, 'capped');
  s = { ...s, pantry: { plankton: 0, krill: 0, golden: 0 } };
  assert.equal(n.earn(s, 'task-completed', T0 + DAY).n, 1);
});

test('sources in one group share the cap', () => {
  let s = n.normalize(null);
  s = n.earn(s, 'hide-found', T0).state;
  s = n.earn(s, 'fetched', T0).state;
  s = n.earn(s, 'fetched', T0).state;
  assert.equal(n.earn(s, 'hide-found', T0).reason, 'capped');
});

test('the pantry never holds more than PANTRY_MAX', () => {
  let s = n.normalize(null);
  for (let d = 0; d < 10; d++) for (const src of Object.keys(n.SOURCES)) s = n.earn(s, src, T0 + d * DAY, () => 0).state;
  assert.equal(n.pantryTotal(s), n.PANTRY_MAX);
  assert.equal(n.earn(s, 'new-day', T0 + 99 * DAY).reason, 'pantry-full');
});

test('a chance source only pays when luck says so', () => {
  const s = n.normalize(null);
  assert.equal(n.earn(s, 'find-made', T0, () => 0.9).reason, 'luck');
  const r = n.earn(s, 'find-made', T0, () => 0.1);
  assert.equal(r.snack, 'krill');
  assert.equal(n.earn(s, 'unknown-thing', T0).snack, null);
});

test('the tide only brings a snack to an empty pantry and a hungry crab, every few hours', () => {
  const hungry = withMeters({ fullness: n.FLOOR.fullness });
  const a = n.tide(hungry, T0);
  assert.equal(a.snack, 'plankton');
  assert.equal(n.tide({ ...a.state, pantry: { plankton: 0, krill: 0, golden: 0 } }, T0 + HOUR).snack, null);
  assert.equal(n.tide({ ...a.state, pantry: { plankton: 0, krill: 0, golden: 0 } }, T0 + n.TIDE_EVERY).snack, 'plankton');
  assert.equal(n.tide(withMeters({ fullness: 60 }), T0).snack, null);
  assert.equal(n.tide({ ...hungry, pantry: { plankton: 1, krill: 0, golden: 0 } }, T0).snack, null);
});

test('rinse: shiny again, then a cooldown; a clean crab doesn\'t need one', () => {
  const r = n.rinse(withMeters({ tidiness: 35 }), T0);
  assert.ok(r.ok);
  assert.equal(r.state.meters.tidiness, 100);
  assert.equal(n.rinse({ ...r.state, meters: { ...r.state.meters, tidiness: 50 } }, T0 + MIN).reason, 'cooldown');
  assert.ok(n.rinse({ ...r.state, meters: { ...r.state.meters, tidiness: 50 } }, T0 + n.RINSE_EVERY).ok);
  assert.equal(n.rinse(n.normalize(null), T0).reason, 'clean');
});

test('tuck in: only when he could use it, worth real pep, and not on repeat', () => {
  assert.equal(n.tuckIn(n.normalize(null), T0).reason, 'rested');
  const r = n.tuckIn(withMeters({ energy: 40 }), T0);
  assert.ok(r.ok);
  assert.equal(r.state.totals.tucked, 1);
  assert.equal(r.state.meters.energy, 40 + n.TUCK_PEP);
  assert.ok(!n.mood(r.state).low.includes('energy'), 'not sleepy any more');
  const tired = { ...r.state, meters: { ...r.state.meters, energy: 35 } };
  assert.equal(n.tuckIn(tired, T0 + MIN).reason, 'cooldown');
  assert.ok(n.tuckIn(tired, T0 + n.TUCK_EVERY).ok);
  assert.equal(n.view(r.state, T0 + MIN).nextTuckAt, T0 + n.TUCK_EVERY);
});

test('a snack name from outside can only ever be one of his snacks', () => {
  const s = { ...withMeters({ fullness: 40 }), pantry: { plankton: 1, krill: 0, golden: 0 } };
  for (const bad of ['constructor', '__proto__', 'toString']) {
    const r = n.feed(s, T0, bad);
    assert.equal(r.ate, 'plankton', `${bad} falls back to the plainest snack`);
  }
});

test('needy lines: only when a need shows, and not more than once every 45 minutes', () => {
  assert.equal(n.needyLine(n.normalize(null), T0), null);
  const s = withMeters({ fullness: 30 });
  assert.equal(n.needyLine(s, T0), 'peckish');
  const said = n.markNeedy(s, T0);
  assert.equal(n.needyLine(said, T0 + 10 * MIN), null);
  assert.equal(n.needyLine(said, T0 + n.NEEDY_GAP), 'peckish');
});

test('sleepier means likelier naps, within bounds', () => {
  assert.equal(n.napChance(n.normalize(null)), 1);
  assert.equal(n.napChance(withMeters({ energy: n.FLOOR.energy })), 2.5);
  const mid = n.napChance(withMeters({ energy: 35 }));
  assert.ok(mid > 1 && mid < 2.5);
});

test('refill: switched back on, he isn\'t hungry', () => {
  const s = n.refill(withMeters({ fullness: 25, cheer: 35 }), T0);
  for (const k of n.METERS) assert.equal(s.meters[k], 100);
});

test('view: words not numbers to live by, and crab-only sees only its own sources', () => {
  const v = n.view(withMeters({ fullness: 30 }), T0, { crabOnly: true });
  const tummy = v.meters.find(m => m.id === 'fullness');
  assert.equal(tummy.word, 'peckish');
  assert.equal(tummy.low, true);
  assert.ok(!v.sources.includes('Finished tasks'));
  assert.ok(n.view(n.normalize(null), T0).sources.includes('Finished tasks'));
  assert.equal(v.mood, 'peckish');
  for (const m of v.meters) for (const w of [m.word]) assert.ok(!/starv|sick|dying|sad/i.test(w));
});

test('feed label explains how to get snacks when there are none', () => {
  assert.match(n.feedLabel(withMeters({ fullness: 50 }), { crabOnly: true }), /focus/);
  assert.match(n.feedLabel(withMeters({ fullness: 50 })), /tasks/);
  assert.match(n.feedLabel({ ...withMeters({ fullness: 50 }), pantry: { plankton: 3, krill: 0, golden: 0 } }), /3/);
  assert.match(n.feedLabel(n.normalize(null)), /stuffed/);
});

test('needs.js stays out of the bond, XP, finds and trophies', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/needs.js'), 'utf8');
  assert.doesNotMatch(src, /require\(/, 'pure: needs.js requires nothing');
});
