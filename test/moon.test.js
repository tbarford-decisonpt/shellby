const { test } = require('node:test');
const assert = require('node:assert/strict');
const moon = require('../src/main/moon');

const at = iso => Date.parse(iso);

test('known new and full moons read as such', () => {
  // The total solar eclipse of 8 April 2024 was a new moon; 23 April 2024 and 13 January 2025 were full.
  assert.equal(moon.phase(at('2024-04-08T18:21Z')).special, 'new');
  assert.equal(moon.phase(at('2024-04-08T18:21Z')).name, 'new moon');
  assert.equal(moon.phase(at('2024-04-23T23:49Z')).special, 'full');
  assert.equal(moon.phase(at('2025-01-13T22:27Z')).name, 'full moon');
  assert.ok(moon.phase(at('2024-04-23T23:49Z')).lit > 0.99);
});

test('in between, a quarter moon is neither, half lit, and waxing or waning', () => {
  const q = moon.phase(at('2024-04-15T19:13Z')); // first quarter
  assert.equal(q.special, null);
  assert.equal(q.name, 'first quarter');
  assert.equal(q.waxing, true);
  assert.ok(Math.abs(q.lit - 0.5) < 0.1);
  assert.equal(moon.phase(at('2024-05-01T11:27Z')).name, 'last quarter');
  assert.equal(moon.phase(at('2024-05-01T11:27Z')).waxing, false);
});

test('each full and new moon lasts a couple of nights, and a month has one of each', () => {
  const start = at('2026-10-01T00:00Z');
  const days = Array.from({ length: 30 }, (_, i) => moon.special(start + i * 864e5));
  const full = days.filter(d => d === 'full').length, fresh = days.filter(d => d === 'new').length;
  assert.ok(full >= 2 && full <= 3, `full on ${full} days`);
  assert.ok(fresh >= 2 && fresh <= 3, `new on ${fresh} days`);
});

test('before the date it counts from, and junk, still give a phase', () => {
  assert.ok(moon.NAMES.includes(moon.phase(at('1969-07-20T20:17Z')).name));
  const p = moon.phase(NaN);
  assert.ok(p.fraction >= 0 && p.fraction < 1);
});
