const { test } = require('node:test');
const assert = require('node:assert/strict');
const ciProposals = require('../src/main/ci-proposals');

const NOW = 1_790_000_000_000;
const MIN = 60 * 1000;

test('offers news once', () => {
  let s = ciProposals.create();
  const first = ciProposals.decide(s, { type: 'review', key: 'o/r#1', stamp: 1 }, NOW);
  assert.equal(first.propose, true);
  s = first.state;
  assert.equal(ciProposals.decide(s, { type: 'review', key: 'o/r#1', stamp: 1 }, NOW + 5 * 60 * MIN).propose, false, 'the same news, even much later');
});

test('new news on the same pull request waits out the cooldown', () => {
  const s = ciProposals.decide(ciProposals.create(), { type: 'review', key: 'o/r#1', stamp: 1 }, NOW).state;
  assert.equal(ciProposals.decide(s, { type: 'review', key: 'o/r#1', stamp: 2 }, NOW + 5 * MIN).propose, false);
  assert.equal(ciProposals.decide(s, { type: 'review', key: 'o/r#1', stamp: 2 }, NOW + ciProposals.COOLDOWN_MS).propose, true);
});

test('other pull requests and other kinds are their own', () => {
  const s = ciProposals.decide(ciProposals.create(), { type: 'review', key: 'o/r#1', stamp: 1 }, NOW).state;
  assert.equal(ciProposals.decide(s, { type: 'review', key: 'o/r#2', stamp: 1 }, NOW).propose, true);
  assert.equal(ciProposals.decide(s, { type: 'build', key: 'o/r#1', stamp: 1 }, NOW).propose, true);
});

test('leaves the state it was given alone', () => {
  const s = ciProposals.create();
  ciProposals.decide(s, { type: 'review', key: 'o/r#1', stamp: 1 }, NOW);
  assert.equal(s.size, 0);
});

test('nothing to go on: no offer', () => {
  assert.equal(ciProposals.decide(ciProposals.create(), null, NOW).propose, false);
  assert.equal(ciProposals.decide(ciProposals.create(), { type: 'review', key: '' }, NOW).propose, false);
  assert.equal(ciProposals.decide(undefined, { type: 'review', key: 'o/r#1' }, NOW).propose, true);
});

test('keeps a bounded memory', () => {
  let s = ciProposals.create();
  for (let i = 0; i < ciProposals.MAX_KEPT + 20; i++) s = ciProposals.decide(s, { type: 'review', key: `o/r#${i}`, stamp: 1 }, NOW).state;
  assert.equal(s.size, ciProposals.MAX_KEPT);
  assert.equal(ciProposals.decide(s, { type: 'review', key: 'o/r#0', stamp: 1 }, NOW).propose, true, 'the oldest was forgotten');
});
