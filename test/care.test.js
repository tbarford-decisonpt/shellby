const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCare, NEED_BITS } = require('../src/main/care');
const needs = require('../src/main/needs');

const T0 = new Date(2026, 9, 4, 9, 0, 0).getTime();
const MIN = 60 * 1000;

// A care with fake deps: a settings store that counts writes, and spies for
// everything it tells his life to do.
function setup({ settings = {}, idleS = 5, isIdle = true, free = true } = {}) {
  let t = T0;
  const store = { needsOn: true, crabOnly: false, ...settings };
  const calls = { writes: 0, said: [], stats: [], xp: [], grow: [], remember: [], toCrab: [], performed: [], naps: [], refresh: 0, changed: 0 };
  const d = {
    config: { get: k => store[k], set: patch => { calls.writes++; Object.assign(store, patch); } },
    systemIdleSeconds: () => idleS,
    calm: () => false,
    isIdle: () => isIdle,
    speak: (occasion, opts) => { calls.said.push(occasion); return { text: occasion, opts }; },
    toCrab: (ch, payload) => calls.toCrab.push([ch, payload]),
    stat: (e, p) => calls.stats.push([e, p]),
    awardXp: kind => calls.xp.push(kind),
    refresh: () => { calls.refresh++; },
  };
  const h = {
    now: () => t,
    later: (_ms, fn) => fn(),
    free: () => free,
    perform: (id, ms, steps) => { calls.performed.push(id); steps.forEach(s => s.run()); },
    napFor: ms => calls.naps.push(ms),
    napping: () => false,
    wake: () => {},
    grow: kind => { calls.grow.push(kind); return { gained: 1 }; },
    remember: (kind, data) => calls.remember.push([kind, data]),
    changed: () => { calls.changed++; },
  };
  const care = createCare(d, h);
  return { care, store, calls, advance: ms => { t += ms; } };
}

test('ticks are batched: no settings write on every 15 s tick', () => {
  const { care, calls, advance } = setup();
  for (let i = 0; i < 12; i++) { advance(15 * 1000); care.tick(); }
  assert.ok(calls.writes <= 1, `wrote ${calls.writes} times in 3 minutes`);
  advance(5 * MIN);
  care.tick();
  assert.ok(calls.writes >= 1);
  care.flush();
  assert.ok(calls.writes >= 2, 'flush always writes');
});

test('a finished task earns a snack and tires him a little', () => {
  const { care, store, calls } = setup();
  care.onStat('task-completed');
  care.flush();
  const s = needs.normalize(store.needs);
  assert.equal(s.pantry.plankton, 1);
  assert.equal(s.meters.energy, 100 + needs.WEAR.task.energy);
  assert.ok(calls.said.includes('snackEarned'));
  assert.ok(calls.toCrab.some(([ch, p]) => ch === 'critter:prop' && p.prop === 'plankton-drop'));
});

test('crab-only: focus sessions and the daily hello fill the pantry without any tasks', () => {
  const { care, store } = setup({ settings: { crabOnly: true } });
  care.earn('new-day');
  care.onStat('focus-completed');
  care.onStat('fetched');
  care.flush();
  assert.equal(needs.pantryTotal(needs.normalize(store.needs)), 5);
});

test('feeding: munches, counts the trophy, grows the bond and pays XP', () => {
  const { care, store, calls } = setup({ settings: { needs: { meters: { fullness: 40 }, pantry: { plankton: 1 } } } });
  const r = care.feed();
  assert.equal(r.ok, true);
  assert.deepEqual(calls.performed, ['feed']);
  assert.ok(calls.toCrab.some(([ch, p]) => ch === 'critter:bit' && p.bit === 'munch'));
  assert.ok(calls.toCrab.some(([ch, p]) => ch === 'critter:hold' && Array.isArray(p?.pixels)), 'the snack in his claw');
  assert.ok(calls.stats.some(([e]) => e === 'fed'));
  assert.deepEqual(calls.grow, ['feed']);
  assert.deepEqual(calls.xp, ['feed']);
  assert.ok(calls.remember.some(([k]) => k === 'first-snack'));
  assert.ok(calls.said.includes('fed'));
  assert.equal(needs.normalize(store.needs).pantry.plankton, 0);
});

test('work done while you are away wears him out not one bit', () => {
  const { care, store } = setup({ idleS: 600 });
  care.onStat('task-completed');
  care.onStat('thrown');
  care.wear('dig');
  care.flush();
  const s = needs.normalize(store.needs);
  for (const k of needs.METERS) assert.equal(s.meters[k], 100, k);
  assert.equal(s.pantry.plankton, 1, '...though the snack it earned is waiting for you');
});

test('a tuck-in while he is busy (a game, a find) is turned down before anything counts', () => {
  const { care, calls } = setup({ free: false, settings: { needs: { meters: { energy: 35 } } } });
  const r = care.tuckIn();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
  assert.deepEqual(calls.stats, []);
  assert.deepEqual(calls.grow, []);
  assert.deepEqual(calls.naps, []);
});

test('feeding while he is busy (mid-task, mid-game): no animation cutting in, just a thank-you', () => {
  const { care, calls } = setup({ free: false, isIdle: false, settings: { needs: { meters: { fullness: 40 }, pantry: { plankton: 1 } } } });
  assert.equal(care.feed().ok, true);
  assert.deepEqual(calls.performed, []);
  assert.ok(calls.said.includes('fed'));
});

test('an empty pantry or a full tummy: a friendly no, nothing taken away', () => {
  const empty = setup({ settings: { needs: { meters: { fullness: 40 } } } });
  const r = empty.care.feed();
  assert.equal(r.ok, false);
  assert.match(r.error, /getting things done/);
  assert.deepEqual(empty.calls.grow, []);
  const full = setup({ settings: { needs: { pantry: { plankton: 2 } } } });
  assert.equal(full.care.feed().reason, 'stuffed');
  assert.ok(full.calls.said.includes('stuffed'));
});

test('a golden plankton is remembered and counts for its trophy', () => {
  const { care, calls } = setup({ settings: { needs: { meters: { fullness: 40 }, pantry: { golden: 1 } } } });
  assert.equal(care.feed().ate, 'golden');
  assert.ok(calls.stats.some(([e]) => e === 'golden-snack'));
  assert.ok(calls.remember.some(([k]) => k === 'golden-snack'));
});

test('rinse and tuck in: their scenes, trophies and care points', () => {
  const { care, calls } = setup({ settings: { needs: { meters: { tidiness: 35, energy: 35 } } } });
  assert.equal(care.rinse().ok, true);
  assert.equal(care.rinse().reason, 'clean');
  assert.equal(care.tuckIn().ok, true);
  assert.deepEqual(calls.naps.length, 1);
  assert.ok(calls.stats.some(([e]) => e === 'rinsed'));
  assert.ok(calls.stats.some(([e]) => e === 'tucked'));
  assert.deepEqual(calls.grow, ['care', 'care']);
});

test('the bond is only ever grown, never touched otherwise, however neglected he is', () => {
  const { care, calls, advance } = setup();
  for (let i = 0; i < 2 * 24 * 60; i++) { advance(MIN); care.tick(); }
  assert.deepEqual(calls.grow, []);
  assert.deepEqual(calls.xp, []);
  assert.equal(care.view().mood, 'mopey');
  for (const m of care.view().meters) assert.ok(m.value >= m.floor);
});

test('when he\'s mopey, an idle habit can be his mood showing', () => {
  const { care, calls } = setup({ settings: { needs: { meters: { cheer: 36 } } } });
  const realRandom = Math.random;
  Math.random = () => 0;
  try { assert.equal(care.idleBit(), true); } finally { Math.random = realRandom; }
  assert.ok(calls.toCrab.some(([ch, p]) => ch === 'critter:bit' && p.bit === NEED_BITS.mopey));
  assert.ok(calls.said.includes('mopey'));
});

test('a pet lifts a mopey crab and he says so', () => {
  const { care, calls } = setup({ settings: { needs: { meters: { cheer: 36 } } } });
  care.attend('pet');
  assert.notEqual(care.view().mood, 'mopey');
  assert.ok(calls.said.includes('cheered'));
});

test('switched off: nothing shows, nothing counts, no menu', () => {
  const { care, store, calls } = setup({ settings: { needsOn: false } });
  care.tick();
  care.onStat('task-completed');
  assert.equal(care.look(), null);
  assert.equal(care.menu(), null);
  assert.deepEqual(care.view(), { on: false });
  assert.equal(care.feed().ok, false);
  assert.equal(store.needs, undefined);
  assert.equal(calls.said.length, 0);
});

test('switched back on, he comes back full', () => {
  const { care, store } = setup({ settings: { needs: { meters: { fullness: 25, cheer: 35 } } } });
  care.switched(true);
  for (const k of needs.METERS) assert.equal(needs.normalize(store.needs).meters[k], 100);
});

test('every need habit and snack prop he is sent has an animation', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '../src/renderer/critter');
  const css = ['critter.css', 'charm.css', 'life.css', 'needs.css'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const bit of [...Object.values(NEED_BITS), 'munch', 'polish']) assert.ok(css.includes(`body.bit-${bit} `), `no animation for bit-${bit}`);
  const draw = fs.readFileSync(path.join(dir, 'life.js'), 'utf8');
  for (const prop of ['plankton-drop', 'crumbs', 'suds', 'hearts', 'sparkle']) {
    assert.ok(draw.includes(`'${prop}':`), `life.js can't draw ${prop}`);
    assert.ok(css.includes(`.prop-${prop}`), `no style for prop-${prop}`);
  }
  for (const snack of needs.SNACK_ORDER) {
    const s = needs.SNACKS[snack];
    for (const row of s.pixels) for (const c of row) assert.ok(c === '.' || s.palette[c], `${snack}: no colour for "${c}"`);
  }
});

test('the menu explains itself', () => {
  const { care } = setup({ settings: { crabOnly: true, needs: { meters: { fullness: 40 } } } });
  const m = care.menu();
  assert.equal(m.feed.enabled, false);
  assert.match(m.feed.label, /focus/);
  assert.equal(m.care.length, 2);
});
