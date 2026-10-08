// The flaky detective lives in flaky/ (ids, parsers, store, text) behind
// src/main/flaky.js. test/flaky.test.js covers the behaviour through the index;
// these pin that each part works on its own and the index hands out the same
// functions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/main/flaky');
const ids = require('../src/main/flaky/ids');
const parsers = require('../src/main/flaky/parsers');
const store = require('../src/main/flaky/store');
const text = require('../src/main/flaky/text');

const HOUR = 3600000;
const KEY = 'abcdef012345';
const TREE = 'a'.repeat(40);

test('the index re-exports each part as the same function', () => {
  for (const [part, names] of [
    [ids, ['cleanId', 'labelOf', 'normalizeCmd', 'cmdKey', 'masked']],
    [parsers, ['frameworkOf', 'parse', 'readRun']],
    [store, ['normalizeFlaky', 'recordRun', 'setStatus', 'setIssue', 'forget', 'flakyView', 'findTest', 'due', 'markSaid']],
    [text, ['sayLine', 'fixPrompt', 'quarantinePrompt', 'unquarantinePrompt', 'issueDraft', 'redactCmd']],
  ]) {
    for (const name of names) assert.equal(F[name], part[name], name);
  }
  assert.equal(F.SUITE, ids.SUITE);
  assert.equal(F.MANY_FAILED, store.MANY_FAILED);
});

test('ids: a command with a pipe and redirect keys the same as the bare one', () => {
  assert.equal(ids.cmdKey('npm test 2>&1 | tail -30'), ids.cmdKey('npm test'));
  assert.notEqual(ids.cmdKey('npm test -- auth'), ids.cmdKey('npm test'));
  assert.equal(ids.masked('npm test | tail'), true);
  assert.equal(ids.cleanId('__proto__'), null);
});

test('parsers: reads the failing test from node --test output', () => {
  const out = 'not ok 1 - signs in\n# tests 2\n# pass 1\n# fail 1\n';
  const r = parsers.readRun({ cmd: 'node --test', output: out, isError: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ['signs in']);
  assert.equal(r.framework, 'node');
});

test('parsers: a timed-out command says nothing about the tests', () => {
  assert.equal(parsers.readRun({ cmd: 'npm test', output: 'Command timed out after 120s', isError: true }), null);
});

test('store: a fail then a pass on the same tree is a flake', () => {
  const now = Date.now();
  const project = { key: KEY, name: 'shellby', root: null };
  const fail = { cmd: ids.cmdKey('npm test'), tree: TREE, ok: false, failed: ['auth › signs in'], parsed: true, complete: true };
  const pass = { ...fail, ok: true, failed: [], parsed: false };
  const first = store.recordRun({}, project, fail, now);
  assert.deepEqual(first.flakes, []);
  const second = store.recordRun(first.state, project, pass, now + HOUR);
  assert.deepEqual(second.fresh, ['auth › signs in']);
  assert.equal(store.flakyView(second.state, now + HOUR)[0].id, 'auth › signs in');
});

test('text: the bubble and the issue read right', () => {
  assert.equal(text.sayLine({ label: 'auth.spec', week: 1 }), 'auth.spec flaked once this week');
  assert.equal(text.sayLine({ label: 'auth.spec', week: 3 }), 'auth.spec flaked 3 times this week');
  assert.equal(text.redactCmd('TOKEN=abc npm test --password hunter2'), 'TOKEN=… npm test --password …');
  const row = { id: 'a', label: 'a', project: 'p', framework: 'jest', total: 2, week: 2, lastAt: 0, suite: false };
  assert.equal(text.issueDraft(row).title, 'Flaky test: a');
});
