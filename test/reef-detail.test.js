// reef/detail.js: where a reef count comes from, for Fix this (names and counts only).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const detail = require('../src/main/reef/detail');

const HEAD = 'a'.repeat(40);

test('escapeScan counts escapes per file and kind, keeping no line text', () => {
  const out = [
    `${HEAD}:src/a.ts:// @ts-ignore`,
    `${HEAD}:src/a.ts:const x: any = 1;`,
    `${HEAD}:src/b.py:import os  # noqa`,
    `${HEAD}:src/c.ts:const anything = 1;`, // the grep's wide net; not an escape
    '',
  ].join('\n');
  const r = detail.escapeScan(out, HEAD);
  assert.equal(r.count, 3);
  assert.deepEqual(r.files, [['src/a.ts', 2], ['src/b.py', 1]]);
  assert.deepEqual(r.kinds.map(k => k[0]).sort(), ['any', 'noqa', 'ts-ignore']);
  assert.ok(!JSON.stringify(r).includes('import os'));
});

test('escapeScan still counts lines without a path', () => {
  const r = detail.escapeScan('// @ts-ignore\n', HEAD);
  assert.equal(r.count, 1);
  assert.deepEqual(r.files, []);
  assert.deepEqual(detail.escapeScan('', HEAD), { count: 0, files: [], kinds: [] });
});

test('lintDetail reads eslint stylish blocks, relative to the root', () => {
  const out = [
    'C:\\code\\app\\src\\a.js',
    '  3:5   error    \'x\' is assigned a value but never used  no-unused-vars',
    '  9:1   warning  Unexpected console statement           no-console',
    '',
    'C:\\code\\app\\src\\b.js',
    '  1:1  error  Missing semicolon  semi',
    '',
    '✖ 3 problems (2 errors, 1 warning)',
  ].join('\n');
  const r = detail.lintDetail(out, 'C:\\code\\app');
  assert.deepEqual(r.files, [['src/a.js', 2], ['src/b.js', 1]]);
  assert.deepEqual(r.rules.map(x => x[0]).sort(), ['no-console', 'no-unused-vars', 'semi']);
});

test('lintDetail reads ruff-style path:line:col lines and clippy arrows', () => {
  const ruff = 'app/x.py:1:8: F401 [*] `os` imported but unused\napp/x.py:4:1: E302 expected 2 blank lines\nFound 2 errors.';
  assert.deepEqual(detail.lintDetail(ruff), { files: [['app/x.py', 2]], rules: [['E302', 1], ['F401', 1]] });
  const clippy = 'warning: unused variable: `x`\n --> src/main.rs:3:9\n  |\nwarning: `demo` (bin "demo") generated 1 warning';
  assert.deepEqual(detail.lintDetail(clippy).files, [['src/main.rs', 1]]);
});

test('lintDetail with output it can not read is empty, never throws', () => {
  assert.deepEqual(detail.lintDetail(''), { files: [], rules: [] });
  assert.deepEqual(detail.lintDetail(null), { files: [], rules: [] });
  assert.deepEqual(detail.lintDetail('all good'), { files: [], rules: [] });
});

test('coverageFiles: the files with most uncovered lines, from summary json and lcov', () => {
  const json = JSON.stringify({
    total: { lines: { total: 30, covered: 20, pct: 66.6 } },
    'C:\\code\\app\\src\\a.js': { lines: { total: 10, covered: 9, pct: 90 } },
    'C:\\code\\app\\src\\b.js': { lines: { total: 20, covered: 11, pct: 55 } },
    'C:\\code\\app\\src\\c.js': { lines: { total: 5, covered: 5, pct: 100 } },
  });
  assert.deepEqual(detail.coverageFiles('coverage/coverage-summary.json', json, 'C:\\code\\app'), [['src/b.js', 55, 9], ['src/a.js', 90, 1]]);
  const lcov = 'SF:src/x.js\nLF:4\nLH:1\nend_of_record\nSF:src/y.js\nLF:2\nLH:2\nend_of_record\n';
  assert.deepEqual(detail.coverageFiles('coverage/lcov.info', lcov), [['src/x.js', 25, 3]]);
  assert.deepEqual(detail.coverageFiles('coverage.xml', '<coverage line-rate="0.5"/>'), []);
  assert.deepEqual(detail.coverageFiles('coverage/coverage-summary.json', 'not json'), []);
});

test('flakyTests, vulnPackages, ciFailing and openNests read the ledgers', () => {
  const flaky = { projects: { p: { tests: { 'adds two': { flakes: [1, 2, 3], status: 'watching' }, 'gone': { flakes: [1], status: 'fixed' }, 'quiet': { flakes: [] } } } } };
  assert.deepEqual(detail.flakyTests(flaky, 'p'), [['adds two', 3]]);
  assert.deepEqual(detail.flakyTests({}, 'p'), []);

  const results = [{ key: 'C:\\App', ok: true, manager: 'npm', vulnTotal: 2, vulnerable: [{ name: 'lodash', severity: 'low', direct: true, fix: 'minor' }, { name: 'minimist', severity: 'critical', direct: false, fix: 'major' }] }];
  const v = detail.vulnPackages(results, ['c:\\app']);
  assert.equal(v.manager, 'npm');
  assert.deepEqual(v.packages.map(p => p.name), ['minimist', 'lodash']);
  assert.deepEqual(detail.vulnPackages(null, []), { manager: '', packages: [] });

  const prs = [
    { repo: 'me/app', number: 4, title: 'Speed up', state: 'failing', failing: ['test (windows)', 'lint'] },
    { repo: 'me/app', number: 5, state: 'failing', failing: ['test (windows)'] },
    { repo: 'me/app', number: 6, state: 'passing', failing: [] },
    { repo: 'other/x', number: 1, state: 'failing', failing: ['build'] },
  ];
  assert.deepEqual(detail.ciFailing(prs, 'ME/app'), { jobs: [['test (windows)', 2], ['lint', 1]], prs: ['#4 Speed up', '#5'] });
  assert.deepEqual(detail.ciFailing(undefined, 'me/app'), { jobs: [], prs: [] });

  const nests = {
    'p|nullbug': { project: 'p', species: 'nullbug', nest: { count: 4, since: 1000 }, cleared: [{}, {}] },
    'p|race': { project: 'p', species: 'race', nest: null, cleared: [] },
    'q|nullbug': { project: 'q', species: 'nullbug', nest: { count: 9, since: 1 }, cleared: [] },
  };
  assert.deepEqual(detail.openNests(nests, 'p', id => (id === 'nullbug' ? 'Null Mite' : null)),
    [{ name: 'Null Mite', species: 'nullbug', count: 4, since: 1000, cleared: 2 }]);
});

test('normalizeDetail keeps only known keys, capped, and drops empty', () => {
  assert.equal(detail.normalizeDetail(null), null);
  assert.equal(detail.normalizeDetail({ files: [] }), null);
  assert.equal(detail.normalizeDetail({ secret: 'x' }), null);
  const many = Array.from({ length: 30 }, (_, i) => [`f${i}.js`, i]);
  const d = detail.normalizeDetail({ files: many, cmd: 'npm run lint\n', junk: 1, packages: [{ name: 'a', severity: 'weird' }, 'bad'] });
  assert.equal(d.files.length, detail.TOP);
  assert.equal(d.cmd, 'npm run lint');
  assert.deepEqual(d.packages, [{ name: 'a', severity: 'unrated' }]);
  assert.equal(d.junk, undefined);
});
