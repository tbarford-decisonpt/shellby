const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/main/tank/gauges');

const snap = (sample, thresholds = { gpuWarn: 83, cpuWarn: 90 }) => ({ sample, thresholds });

test('normalizeLive turns every gauge on unless it was turned off, and never throws', () => {
  for (const junk of [null, undefined, 'x', 3, [], { __proto__: { thermometer: false } }]) {
    assert.deepEqual(G.normalizeLive(junk), { thermometer: true, bubbler: true, lighthouse: true, moods: true, tide: true, chest: true, bottle: true });
  }
  assert.deepEqual(G.normalizeLive({ bubbler: false, moods: 'no', extra: false }), { thermometer: true, bubbler: false, lighthouse: true, moods: true, tide: true, chest: true, bottle: true });
});

test('the thermometer reads the hottest GPU, red past the GPU line', () => {
  const t = G.tempOf(snap({ gpus: [{ temp: 61.4 }, { temp: 84.6 }], cpu: { temp: 95 } }));
  assert.deepEqual(t, { value: 85, warn: 83, hot: true, of: 'gpu' });
});

test('the thermometer falls back to the CPU and its own line', () => {
  assert.deepEqual(G.tempOf(snap({ gpus: [{ temp: null }], cpu: { temp: 70 } })), { value: 70, warn: 90, hot: false, of: 'cpu' });
});

test('the thermometer shows nothing for no reading or a nonsense one', () => {
  assert.equal(G.tempOf(null), null);
  assert.equal(G.tempOf(snap({ gpus: [], cpu: {} })), null);
  assert.equal(G.tempOf(snap({ gpus: [{ temp: 400 }], cpu: { temp: NaN } })), null);
  assert.deepEqual(G.tempOf({ sample: { gpus: [], cpu: { temp: 50 } } }), { value: 50, warn: null, hot: false, of: 'cpu' });
});

test('bubbles step up with CPU load in coarse notches', () => {
  const at = load => G.loadStep(snap({ cpu: { load } }));
  assert.deepEqual([0, 24.9, 25, 60, 75, 100].map(at), [0, 0, 1, 2, 3, 3]);
  assert.equal(G.loadStep(snap({ cpu: {} })), null);
});

test('only the moods the water has a look for reach it', () => {
  assert.equal(G.moodOf({ mood: 'hot', level: 'warn' }), 'hot');
  assert.equal(G.moodOf('dizzy'), 'dizzy');
  assert.equal(G.moodOf({ mood: 'calm' }), null);
  assert.equal(G.moodOf(null), null);
});

test('the lighthouse is lit while a server runs and blinks while one is down', () => {
  assert.deepEqual(G.lighthouseOf({ up: 2, down: 0 }), { lit: true, blink: false });
  assert.deepEqual(G.lighthouseOf({ up: 0, down: 1 }), { lit: true, blink: true });
  assert.deepEqual(G.lighthouseOf({ up: 0, down: 0 }), { lit: false, blink: false });
  assert.equal(G.lighthouseOf(null), null);
});

test('gauges leaves out whatever is turned off', () => {
  const health = snap({ gpus: [{ temp: 90 }], cpu: { load: 80 } });
  const all = G.gauges({ health, mood: { mood: 'scorching' }, servers: { up: 1, down: 0 } });
  assert.equal(all.thermometer.value, 90);
  assert.equal(all.bubbler, 3);
  assert.deepEqual(all.lighthouse, { lit: true, blink: false });
  assert.equal(all.mood, 'scorching');
  const off = Object.fromEntries(G.KEYS.map(k => [k, false]));
  const none = G.gauges({ health, mood: { mood: 'hot' }, servers: { up: 1 }, usage: { fiveHour: { pct: 10 } }, mergedAt: 1000, unread: ['recap'], now: 2000, live: off });
  assert.deepEqual({ ...none, live: null }, { thermometer: null, bubbler: null, lighthouse: null, mood: null, tide: null, chest: null, bottle: null, live: null });
});

test('readings that look the same in the tank are the same, so nothing is pushed', () => {
  const a = G.gauges({ health: snap({ gpus: [{ temp: 70.2 }], cpu: { load: 30 } }) });
  const b = G.gauges({ health: snap({ gpus: [{ temp: 69.8 }], cpu: { load: 44 } }) });
  assert.ok(G.same(a, b));
  const c = G.gauges({ health: snap({ gpus: [{ temp: 70.2 }], cpu: { load: 55 } }) });
  assert.ok(!G.same(a, c));
});

test('a reading carries nothing but what the tank draws', () => {
  const g = G.gauges({ health: snap({ gpus: [{ temp: 70, name: 'RTX secret' }], cpu: { load: 30, name: 'cpu' } }), servers: { up: 1, upPort: 5173, firstId: 'proj' } });
  assert.doesNotMatch(JSON.stringify(g), /secret|5173|proj/);
});

test('the tide gauge shows how much of the 5-hour window is left, in tenths', () => {
  const now = 1_000_000;
  const at = pct => G.tideOf({ fiveHour: { pct, resetsAt: now + 60_000 } }, now)?.left;
  assert.deepEqual([0, 4, 6, 37, 81, 100, 130, -5].map(at), [100, 100, 90, 60, 20, 0, 0, 100]);
});

test('a window that already reset is a full tide, and no reading is no gauge', () => {
  const now = 1_000_000;
  assert.deepEqual(G.tideOf({ fiveHour: { pct: 90, resetsAt: now - 1 } }, now), { left: 100 });
  assert.deepEqual(G.tideOf({ fiveHour: { pct: 30 } }, now), { left: 70 });
  for (const junk of [null, {}, { fiveHour: null }, { fiveHour: { pct: 'x' } }, { sevenDay: { pct: 10 } }]) assert.equal(G.tideOf(junk, now), null);
});

test('the chest glints for a minute after a merge and not before it', () => {
  assert.equal(G.chestOf(1000, 1000), true);
  assert.equal(G.chestOf(1000, 1000 + G.GLINT_MS - 1), true);
  assert.equal(G.chestOf(1000, 1000 + G.GLINT_MS), false);
  assert.equal(G.chestOf(1000, 999), false);
  assert.equal(G.chestOf(null, 1000), false);
});

test('the bottle brings a recap first, then a weekly card, and nothing else', () => {
  assert.equal(G.bottleOf(['week', 'recap']), 'recap');
  assert.equal(G.bottleOf(['week']), 'week');
  assert.equal(G.bottleOf(['other']), null);
  assert.equal(G.bottleOf('recap'), null);
  assert.equal(G.bottleOf(null), null);
});

test('gauges reads the tide, the chest and the bottle', () => {
  const g = G.gauges({ usage: { fiveHour: { pct: 75, resetsAt: 5000 } }, mergedAt: 1000, unread: ['week'], now: 2000 });
  assert.deepEqual([g.tide, g.chest, g.bottle], [{ left: 30 }, true, 'week']);
});
