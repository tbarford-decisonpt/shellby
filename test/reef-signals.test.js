const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/main/reef/signals');

test('eslint, ruff, biome and clippy counts are read from the output', () => {
  assert.equal(s.lintCount('\n/src/a.js\n  1:1  error  x\n\n✖ 12 problems (3 errors, 9 warnings)\n'), 12);
  assert.equal(s.lintCount('✖ 1 problem (1 error, 0 warnings)'), 1);
  assert.equal(s.lintCount('a.py:1:1: F401 unused\nFound 3 errors.\n[*] 2 fixable'), 3);
  assert.equal(s.lintCount('All checks passed!'), 0);
  assert.equal(s.lintCount('Checked 40 files in 20ms.\nFound 2 errors.\nFound 5 warnings.'), 7);
  assert.equal(s.lintCount('warning: unused variable\nwarning: `app` (lib) generated 4 warnings\n'), 4);
  assert.equal(s.lintCount('error: could not compile `app` (lib) due to 2 previous errors; 3 warnings emitted\nwarning: `app` (lib) generated 3 warnings'), 5);
});

test('a clean lint run that says nothing is 0 only when it passed', () => {
  assert.equal(s.lintCount('', { ok: true }), 0);
  assert.equal(s.lintCount('> eslint .\n', { ok: true }), 0);
  assert.equal(s.lintCount('', { ok: false }), null);
  assert.equal(s.lintCount('something about an error', { ok: true }), null);
});

test('ANSI colours never hide a count', () => {
  assert.equal(s.lintCount('\x1b[31m\x1b[1m✖ 4 problems\x1b[22m\x1b[39m'), 4);
});

test('test counts come from each runner summary', () => {
  assert.equal(s.testCount('Test Suites: 3 passed, 3 total\nTests:       2 failed, 1 skipped, 40 passed, 43 total'), 42);
  assert.equal(s.testCount(' Test Files  4 passed (4)\n      Tests  31 passed | 2 failed (33)'), 33);
  assert.equal(s.testCount('# tests 120\n# suites 9\n# pass 118\n# fail 2\n# cancelled 0'), 120);
  assert.equal(s.testCount('ℹ tests 50\nℹ pass 50\nℹ fail 0'), 50);
  assert.equal(s.testCount('  14 passing (30ms)\n  1 failing'), 15);
  assert.equal(s.testCount('==== 1 failed, 99 passed, 2 skipped in 3.21s ===='), 100);
  assert.equal(s.testCount('test result: ok. 10 passed; 0 failed; 0 ignored\ntest result: ok. 5 passed; 1 failed; 0 ignored'), 16);
  assert.equal(s.testCount('no summary here'), null);
});

test('coverage-summary.json, lcov.info and Cobertura XML are read', () => {
  assert.equal(s.coverageSummary(JSON.stringify({ total: { lines: { total: 200, covered: 167, pct: 83.5 } } })), 83.5);
  assert.equal(s.coverageSummary('{not json'), null);
  assert.equal(s.coverageSummary('{"total":{"lines":{"pct":"Unknown"}}}'), null);
  assert.equal(s.coverageLcov('SF:a.js\nLF:10\nLH:5\nend_of_record\nSF:b.js\nLF:30\nLH:30\nend_of_record'), 87.5);
  assert.equal(s.coverageLcov('SF:a.js\nend_of_record'), null);
  assert.equal(s.coverageXml('<?xml version="1.0" ?>\n<coverage version="7.4" timestamp="1" lines-valid="10" line-rate="0.7123" branch-rate="0">'), 71.2);
  assert.equal(s.coverageXml('<report/>'), null);
});

test('escape hatches are the battle regex, not the wide git grep', () => {
  const lines = ['// @ts-ignore', 'const x = y as any;', 'company: "acme"', '# noqa: E501', 'const any = 1', '/* eslint-disable no-console */'].join('\n');
  assert.equal(s.countEscapes(lines), 4);
  assert.equal(s.countEscapes(''), 0);
});

test('shortstat reads files, insertions and deletions', () => {
  assert.deepEqual(s.shortstat(' 12 files changed, 300 insertions(+), 40 deletions(-)'), { files: 12, insertions: 300, deletions: 40 });
  assert.deepEqual(s.shortstat(' 1 file changed, 1 deletion(-)'), { files: 1, insertions: 0, deletions: 1 });
});

test('the CI green rate needs a few runs', () => {
  assert.equal(s.ciRate([['a', true], ['b', false]]), null);
  assert.equal(s.ciRate([['a', true], ['b', false], ['c', true], ['d', true]]), 75);
});

test('open flaky tests and vulnerable packages come from their ledgers', () => {
  const flaky = { projects: { abcdef012345: { tests: { a: { flakes: [1], status: 'watching' }, b: { flakes: [2], status: 'fixed' }, c: { flakes: [], status: 'watching' }, d: { flakes: [3], status: 'quarantined' } } } } };
  assert.equal(s.openFlaky(flaky, 'abcdef012345'), 2);
  assert.equal(s.openFlaky(flaky, '000000000000'), null);
  const results = [{ key: 'C:\\code\\app', ok: true, vulnTotal: 3 }, { key: 'c:\\code\\app', ok: true, vulnTotal: 1 }, { key: 'C:\\other', ok: true, vulnTotal: 9 }, { key: 'C:\\code\\app', ok: false, vulnTotal: 50 }];
  assert.equal(s.vulnsFor(results, ['C:\\Code\\App']), 4);
  assert.equal(s.vulnsFor(results, ['D:\\nope']), null);
});

test('steps: what beats a best, what is near it, and how far there is to go', () => {
  assert.equal(s.beats('escapes', 10, 9), true);
  assert.equal(s.beats('escapes', 10, 10), false);
  assert.equal(s.beats('coverage', 80, 80.4), false);
  assert.equal(s.beats('coverage', 80, 80.5), true);
  assert.equal(s.beats('ci', 70, 74), false);
  assert.equal(s.beats('ci', 70, 75), true);
  assert.equal(s.beats('tests', 100, 102), false);
  assert.equal(s.beats('tests', 100, 103), true);
  assert.equal(s.beats('tests', 1000, 1009), false); // +1% is 10 here
  assert.equal(s.beats('tests', 1000, 1010), true);
  assert.equal(s.nearBest('lint', 5, 6), true);
  assert.equal(s.nearBest('lint', 5, 8), false);
  assert.equal(s.needFor('lint', 5, 7), 3);
  assert.equal(s.needFor('coverage', 80, 79), 1.5);
  assert.equal(s.beats('nope', 1, 0), false);
});
