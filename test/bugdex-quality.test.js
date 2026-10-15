const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixReport, lettersOf, isClean } = require('../src/main/bugdex/quality');
const { judge } = require('../src/main/bugdex/cheats');

const diff = (file, added = [], removed = []) => [
  `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@',
  ...removed.map(l => `-${l}`), ...added.map(l => `+${l}`),
].join('\n');

const OK = { ok: true };
const srcFix = diff('src/sum.js', ['  return a + b;'], ['  return a - b;']);
const newTest = diff('test/sum.test.js', ["test('adds two numbers', () => {", '  assert.equal(sum(1, 2), 3);', '});']);

test('a refused fix gets no report at all', () => {
  assert.equal(fixReport({ files: [{ path: 'src/sum.js', status: 'M' }], patch: srcFix, judged: { ok: false, reason: 'skipped' } }), null);
  assert.equal(fixReport({ files: [{ path: 'src/sum.js', status: 'M' }], patch: srcFix }), null);
});

test('the report is only computed after judge lets the fix through', () => {
  const patch = diff('test/a.test.js', ["it.skip('works', () => {})"]);
  const files = [{ path: 'test/a.test.js', status: 'M' }];
  const judged = judge({ files, patch, species: 'nullfish' });
  assert.equal(judged.ok, false);
  assert.equal(fixReport({ files, patch, judged }), null);
});

test('a source fix with a new test case and more tests passing has proof and a root cause', () => {
  const r = fixReport({
    files: [{ path: 'src/sum.js', status: 'M' }, { path: 'test/sum.test.js', status: 'M' }],
    patch: `${srcFix}\n${newTest}`, judged: OK, enc: { reruns: 0 }, counts: { before: 10, after: 11 }, failed: 1,
  });
  assert.deepEqual(r.qualities, { proof: true, firstTry: true, rootCause: true, wider: true });
  assert.equal(r.score, 4);
  assert.equal(r.q, 'pfrw');
  assert.ok(isClean(r));
});

test('a brand new test file is proof even when the runner gave no counts', () => {
  const r = fixReport({ files: [{ path: 'src/sum.js', status: 'M' }, { path: 'test/sum.test.js', status: 'A' }], patch: `${srcFix}\n${newTest}`, judged: OK });
  assert.equal(r.qualities.proof, true);
});

test('editing an assertion is not proof', () => {
  const patch = diff('test/sum.test.js', ['  assert.equal(sum(1, 2), 3);'], ['  assert.equal(sum(1, 2), 4);']);
  const r = fixReport({ files: [{ path: 'test/sum.test.js', status: 'M' }], patch, judged: OK, counts: { before: 10, after: 11 } });
  assert.equal(r.qualities.proof, false);
});

test('renaming a test case is not a new one', () => {
  const patch = diff('test/sum.test.js', ["test('adds numbers', () => {"], ["test('adds', () => {"]);
  const r = fixReport({ files: [{ path: 'test/sum.test.js', status: 'M' }], patch, judged: OK, counts: { before: 10, after: 11 } });
  assert.equal(r.qualities.proof, false);
});

test('a new test case with the test count unchanged and an old file is not proof', () => {
  const r = fixReport({ files: [{ path: 'test/sum.test.js', status: 'M' }], patch: newTest, judged: OK, counts: { before: 10, after: 10 } });
  assert.equal(r.qualities.proof, false);
});

test('proof is read in other languages too', () => {
  const py = diff('tests/test_sum.py', ['def test_adds():', '    assert add(1, 2) == 3']);
  assert.equal(fixReport({ files: [{ path: 'tests/test_sum.py', status: 'A' }], patch: py, judged: OK }).qualities.proof, true);
  const go = diff('sum_test.go', ['func TestAdds(t *testing.T) {']);
  assert.equal(fixReport({ files: [{ path: 'sum_test.go', status: 'A' }], patch: go, judged: OK }).qualities.proof, true);
});

test('a suppression anywhere is never a root cause', () => {
  const patch = diff('src/sum.js', ['  // @ts-ignore', '  return a + b;'], ['  return a - b;']);
  const r = fixReport({ files: [{ path: 'src/sum.js', status: 'M' }], patch, judged: OK });
  assert.equal(r.qualities.rootCause, false);
});

test('only raising a limit is never a root cause', () => {
  const patch = diff('src/net.js', ['const TIMEOUT = 30000;'], ['const TIMEOUT = 5000;']);
  const r = fixReport({ files: [{ path: 'src/net.js', status: 'M' }], patch, judged: OK });
  assert.equal(r.qualities.rootCause, false);
});

test('config, lockfiles, snapshots or tests alone are not a root cause', () => {
  const cfg = diff('package.json', ['  "type": "module",']);
  assert.equal(fixReport({ files: [{ path: 'package.json', status: 'M' }, { path: 'package-lock.json', status: 'M' }], patch: cfg, judged: OK }).qualities.rootCause, false);
  const snap = diff('test/__snapshots__/a.snap', ['x']);
  assert.equal(fixReport({ files: [{ path: 'test/__snapshots__/a.snap', status: 'M' }], patch: snap, judged: OK }).qualities.rootCause, false);
  assert.equal(fixReport({ files: [{ path: 'test/sum.test.js', status: 'M' }], patch: newTest, judged: OK }).qualities.rootCause, false);
});

test('a remedy catch (no files) has no proof and no root cause, but may be first try', () => {
  const r = fixReport({ files: [], patch: '', judged: OK, enc: { reruns: 0 } });
  assert.deepEqual(r.qualities, { proof: false, firstTry: true, rootCause: false, wider: false });
  assert.equal(r.q, 'f');
  assert.equal(isClean(r), false);
});

test('first try needs no re-runs, wider needs more tests than failed', () => {
  const r = fixReport({ files: [{ path: 'src/sum.js', status: 'M' }], patch: srcFix, judged: OK, enc: { reruns: 2 }, counts: { before: 3, after: 3 }, failed: 3 });
  assert.equal(r.qualities.firstTry, false);
  assert.equal(r.qualities.wider, false);
});

test('helpers are counted and capped', () => {
  assert.equal(fixReport({ judged: OK, crew: 2 }).crew, 2);
  assert.equal(fixReport({ judged: OK, crew: 99 }).crew, 6);
  assert.equal(fixReport({ judged: OK, crew: -1 }).crew, 0);
});

test('letters keep a fixed order', () => {
  assert.equal(lettersOf({ wider: true, proof: true }), 'pw');
  assert.equal(lettersOf(null), '');
});
