const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roster, tracksOn, COLONY_MAX, NAMES } = require('../src/main/floor');

const configOf = obj => ({ get: k => obj[k] });

test('the roster is as big as the colony, with stable pals', () => {
  const three = roster(3);
  assert.equal(three.length, 3);
  assert.deepEqual(three.map(p => p.name), NAMES.slice(0, 3));
  assert.deepEqual(roster(5).slice(0, 3), three, 'adding pals does not change the first ones');
  assert.deepEqual(roster(3), three, 'same every time');
});

test('every pal has its own id, name and colour', () => {
  const all = roster(COLONY_MAX);
  assert.equal(new Set(all.map(p => p.id)).size, COLONY_MAX);
  assert.equal(new Set(all.map(p => p.name)).size, COLONY_MAX);
  assert.equal(new Set(all.map(p => p.hue)).size, COLONY_MAX);
});

test('the colony is capped', () => {
  assert.equal(roster(COLONY_MAX + 10).length, COLONY_MAX);
  assert.equal(roster(1).length, 1);
});

test('junk sizes give no pals', () => {
  for (const junk of [0, -1, 'x', null, undefined, 2.5, NaN, {}]) assert.equal(roster(junk).length, 0, String(junk));
});

test('footprints are on when mischief is, unless tracks are switched off', () => {
  assert.equal(tracksOn(configOf({ mischief: 'cheeky' })), true);
  assert.equal(tracksOn(configOf({ mischief: 'gremlin', mischiefPranks: { pinch: false } })), true);
  assert.equal(tracksOn(configOf({ mischief: 'cheeky', mischiefPranks: { tracks: false } })), false);
});

test('no footprints while mischief is off', () => {
  assert.equal(tracksOn(configOf({ mischief: 'off' })), false);
  assert.equal(tracksOn(configOf({})), false);
  assert.equal(tracksOn(configOf({ mischief: 'bogus' })), false);
});
