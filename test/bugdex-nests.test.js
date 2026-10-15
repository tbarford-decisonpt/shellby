const { test } = require('node:test');
const assert = require('node:assert/strict');
const nests = require('../src/main/bugdex/nests');

const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const DAY = nests.DAY;
const ENC = { project: 'proj-1', species: 'ghost-moth' };
const KEY = 'proj-1|ghost-moth';

function seen(s, ...days) {
  let r = { nests: s, formed: null };
  for (const d of days) r = nests.observe(r.nests, ENC, T0 + d * DAY);
  return r;
}

test('a nest forms at the third sighting within 30 days', () => {
  let r = seen({}, 0, 5);
  assert.equal(r.nest, null);
  r = seen(r.nests, 10);
  assert.ok(r.formed);
  assert.equal(r.formed.count, 3);
  assert.equal(r.formed.generation, 1);
});

test('sightings spread over more than 30 days never form one', () => {
  const r = seen({}, 0, 20, 40, 60);
  assert.equal(r.nest, null);
});

test('it never mutates what it is given', () => {
  const s = Object.freeze({});
  const r = nests.observe(s, ENC, T0);
  assert.deepEqual(s, {});
  assert.ok(r.nests[KEY]);
});

test('an open nest needs a catch before it can clear', () => {
  const { nests: s } = seen({}, 0, 1, 2);
  assert.deepEqual(nests.sweep(s, T0 + 40 * DAY).cleared, []);
});

test('it clears 14 days after the last sighting once caught', () => {
  let { nests: s } = seen({}, 0, 1, 2);
  s = nests.onCatch(s, KEY, null, T0 + 2 * DAY + 1000);
  assert.deepEqual(nests.sweep(s, T0 + 15 * DAY).cleared, []);
  const out = nests.sweep(s, T0 + 16 * DAY + 1);
  assert.equal(out.cleared.length, 1);
  assert.equal(out.cleared[0].generation, 1);
  assert.equal(out.nests[KEY].nest, null);
  assert.equal(nests.totalCleared(out.nests), 1);
});

test('a sealed catch clears it in 7 days', () => {
  let { nests: s } = seen({}, 0, 1, 2);
  s = nests.onCatch(s, KEY, null, T0 + 2 * DAY + 1000, { sealed: true });
  assert.equal(nests.sweep(s, T0 + 9 * DAY + 1).cleared.length, 1);
});

test('coming back after a catch resets the clock and the seal', () => {
  let { nests: s } = seen({}, 0, 1, 2);
  s = nests.onCatch(s, KEY, null, T0 + 2 * DAY + 1000, { sealed: true });
  s = seen(s, 5).nests;
  assert.equal(s[KEY].nest.sealed, false);
  assert.equal(s[KEY].nest.count, 4);
  assert.deepEqual(nests.sweep(s, T0 + 30 * DAY).cleared, []); // not caught since it came back
});

test('it reforms as a new generation and the old clear is kept', () => {
  let { nests: s } = seen({}, 0, 1, 2);
  s = nests.onCatch(s, KEY, null, T0 + 2 * DAY + 1);
  s = nests.sweep(s, T0 + 20 * DAY).nests;
  const r = seen(s, 40, 41, 42);
  assert.equal(r.formed.generation, 2);
  assert.equal(r.nests[KEY].cleared.length, 1);
  assert.equal(nests.totalCleared(r.nests), 1);
});

test('the view shows progress toward clearing and the cleared list', () => {
  let { nests: s } = seen({}, 0, 1, 2);
  let v = nests.nestsView(s, { project: () => 'Shellby', species: () => 'Ghost Moth' }, T0 + 3 * DAY);
  assert.equal(v.open.length, 1);
  assert.equal(v.open[0].name, 'Ghost Moth');
  assert.equal(v.open[0].project, 'Shellby');
  assert.equal(v.open[0].progress, 0);
  assert.equal(v.open[0].daysLeft, null);
  s = nests.onCatch(s, KEY, null, T0 + 2 * DAY + 1);
  v = nests.nestsView(s, {}, T0 + 9 * DAY);
  assert.ok(v.open[0].progress > 0.4 && v.open[0].progress < 0.6);
  assert.equal(v.open[0].daysLeft, 7);
  s = nests.sweep(s, T0 + 30 * DAY).nests;
  v = nests.nestsView(s, {}, T0 + 30 * DAY);
  assert.equal(v.open.length, 0);
  assert.equal(v.cleared.length, 1);
  assert.equal(v.clearedTotal, 1);
});

test('the reef signal counts one project only', () => {
  let { nests: s } = seen({}, 0, 1, 2);
  s = nests.observe(s, { project: 'other', species: 'x' }, T0).nests;
  assert.deepEqual(nests.nestSignal(s, 'proj-1'), { open: 1, cleared: 0 });
  assert.deepEqual(nests.nestSignal(s, 'none'), { open: 0, cleared: 0 });
});

test('normalize keeps what is good', () => {
  const { nests: s } = seen({}, 0, 1, 2);
  assert.deepEqual(nests.normalizeNests(JSON.parse(JSON.stringify(s))), s);
  assert.deepEqual(nests.normalizeNests('junk'), {});
});
