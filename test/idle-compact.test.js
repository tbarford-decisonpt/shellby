const { test } = require('node:test');
const assert = require('node:assert/strict');
const ic = require('../src/main/idle-compact');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const AT = new Date(2026, 9, 14, 12, 0).getTime();
const tab = (over = {}) => ({ saved: true, cache: { at: AT, ttlMs: HOUR }, tokens: 250000, ...over });

test('due: a big quiet tab is compacted 54 minutes after its last call, not before', () => {
  assert.equal(ic.due(tab(), { now: AT + 53 * MIN }), false);
  assert.equal(ic.due(tab(), { now: AT + 54 * MIN }), true);
  assert.equal(ic.due(tab(), { now: AT + 59 * MIN }), true);
});

test('due: once the cache has run out there is nothing left to save', () => {
  assert.equal(ic.due(tab(), { now: AT + HOUR }), false);
});

test('due: only an hour-long cache, and only at or over the token floor', () => {
  const now = AT + 55 * MIN;
  assert.equal(ic.due(tab({ cache: { at: AT, ttlMs: 5 * MIN } }), { now }), false);
  assert.equal(ic.due(tab({ cache: null }), { now }), false);
  assert.equal(ic.due(tab({ tokens: 199999 }), { now }), false);
  assert.equal(ic.due(tab({ tokens: 200000 }), { now }), true);
  assert.equal(ic.due(tab({ tokens: 150000 }), { now, floor: 120000 }), true);
});

test('due: leaves alone tabs that are working, waiting, unsaved, routines or in a terminal', () => {
  const now = AT + 55 * MIN;
  for (const over of [{ busy: true }, { waiting: true }, { saved: false }, { routine: true }, { inTerminal: 123 }]) {
    assert.equal(ic.due(tab(over), { now }), false, JSON.stringify(over));
  }
});

test('due: tries once per cache, so a compaction that failed is not retried in a loop', () => {
  assert.equal(ic.due(tab({ lastFor: AT }), { now: AT + 55 * MIN }), false);
  assert.equal(ic.due(tab({ lastFor: AT - HOUR }), { now: AT + 55 * MIN }), true);
});

test('minTokens: the env var sets the floor, never below 100K; junk is ignored', () => {
  assert.equal(ic.minTokens({}), 200000);
  assert.equal(ic.minTokens({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '300000' }), 300000);
  assert.equal(ic.minTokens({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '5000' }), 100000);
  assert.equal(ic.minTokens({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: 'lots' }), 200000);
  assert.equal(ic.minTokens({}, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '400000' }), 400000, 'falls through to the next env');
});

test('fromSettings: idleCompaction false turns it off, and the most specific file wins', () => {
  assert.equal(ic.fromSettings([]).off, false);
  assert.equal(ic.fromSettings([{ idleCompaction: false }]).off, true);
  assert.equal(ic.fromSettings([{ idleCompaction: false }, { idleCompaction: true }]).off, false);
  assert.equal(ic.fromSettings([{ idleCompaction: true }, {}, { idleCompaction: false }]).off, true);
  assert.equal(ic.fromSettings([null, { idleCompaction: 'no' }]).off, false, 'only a boolean counts');
});

test('fromSettings: env blocks merge, later files over earlier ones', () => {
  const s = ic.fromSettings([{ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '300000', A: '1' } }, { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '500000' } }]);
  assert.deepEqual(s.env, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '500000', A: '1' });
});
