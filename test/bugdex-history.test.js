const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/main/bugdex/history');

const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const DAY = h.DAY;
const KEY = h.keyOf('proj-1', 'ghost-moth');

test('keys join project and species, and split back', () => {
  assert.equal(KEY, 'proj-1|ghost-moth');
  assert.deepEqual(h.splitKey(KEY), { project: 'proj-1', species: 'ghost-moth' });
});

test('a species never caught here is no rematch', () => {
  let s = h.recordSeen({}, KEY, T0);
  assert.equal(s[KEY].n, 1);
  assert.equal(h.rematchOf(s, KEY, T0), null);
  s = h.recordSeen(s, KEY, T0 + DAY);
  assert.equal(h.rematchOf(s, KEY, T0 + DAY), null);
});

test('after a catch it comes back as rematch #n with the last report', () => {
  let s = h.recordSeen({}, KEY, T0);
  s = h.recordCatch(s, KEY, { q: 'fr' }, T0 + 1000);
  assert.deepEqual(h.rematchOf(s, KEY, T0 + DAY), { n: 1, last: { at: T0 + 1000, q: 'fr' } });
  s = h.recordCatch(s, KEY, null, T0 + 2 * DAY);
  assert.deepEqual(h.rematchOf(s, KEY, T0 + 3 * DAY), { n: 2, last: { at: T0 + 2 * DAY, q: '' } });
});

test('it never mutates what it is given', () => {
  const s = Object.freeze({});
  const a = h.recordSeen(s, KEY, T0);
  assert.deepEqual(s, {});
  const b = h.recordCatch(a, KEY, { q: 'p' }, T0);
  assert.equal(a[KEY].catches.length, 0);
  assert.equal(b[KEY].catches.length, 1);
});

test('a catch holds after 14 days with no recurrence, and is marked once', () => {
  let s = h.recordSeen({}, KEY, T0);
  s = h.recordCatch(s, KEY, { q: 'p' }, T0 + 1000);
  assert.deepEqual(h.heldDue(s, T0 + 13 * DAY), []);
  const due = h.heldDue(s, T0 + 15 * DAY);
  assert.deepEqual(due, [{ key: KEY, at: T0 + 1000, q: 'p' }]);
  s = h.markHeld(s, due);
  assert.equal(s[KEY].catches[0].held, true);
  assert.deepEqual(h.heldDue(s, T0 + 30 * DAY), []);
});

test('a catch that came back since never holds', () => {
  let s = h.recordSeen({}, KEY, T0);
  s = h.recordCatch(s, KEY, { q: 'p' }, T0 + 1000);
  s = h.recordSeen(s, KEY, T0 + 5 * DAY);
  assert.deepEqual(h.heldDue(s, T0 + 20 * DAY), []);
});

test('catches and keys are capped, the oldest let go', () => {
  let s = {};
  for (let i = 0; i < 15; i++) s = h.recordCatch(s, KEY, { q: 'p' }, T0 + i);
  assert.equal(s[KEY].catches.length, h.MAX_CATCHES);
  for (let i = 0; i < h.MAX_KEYS + 5; i++) s = h.recordSeen(s, h.keyOf('p', `s${i}`), T0 + 100 + i);
  assert.equal(Object.keys(s).length, h.MAX_KEYS);
  assert.equal(s[h.keyOf('p', 's0')], undefined);
});

test('normalize drops junk and keeps good entries', () => {
  const s = h.normalizeHistory({ nokey: { n: 1 }, [KEY]: { n: 2, catches: [{ at: T0, q: 'zz' }, { at: 'x' }], lastSeenAt: T0 } });
  assert.deepEqual(Object.keys(s), [KEY]);
  assert.deepEqual(s[KEY].catches, [{ at: T0, q: '', held: false, sealed: false }]);
  assert.deepEqual(h.normalizeHistory(null), {});
});

test('the nemesis is the species seen most', () => {
  let s = h.recordSeen({}, KEY, T0);
  s = h.recordSeen(s, KEY, T0);
  s = h.recordSeen(s, h.keyOf('proj-1', 'nullfish'), T0);
  assert.equal(h.nemesis(s).species, 'ghost-moth');
  assert.equal(h.nemesis(s, 'other'), null);
});
