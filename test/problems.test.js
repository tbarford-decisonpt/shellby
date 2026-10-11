// Problems (src/main/problems.js): what the usual tools print, read back as
// file, line, column and message, and the prompt that quotes them safely.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const P = require('../src/main/problems');

const one = (out, opts) => P.parse(out, opts).map(p => `${p.file}:${p.line}:${p.col} ${p.severity}${p.code ? ` ${p.code}` : ''} ${p.message}`);

test('tsc, both ways it prints', () => {
  assert.deepEqual(one("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."),
    ["src/a.ts:3:7 error TS2322 Type 'string' is not assignable to type 'number'."]);
  assert.deepEqual(one('\u001b[96msrc/b.tsx\u001b[0m:10:2 - \u001b[91merror\u001b[0m TS7006: Parameter x implicitly has an any type.'),
    ['src/b.tsx:10:2 error TS7006 Parameter x implicitly has an any type.']);
});

test('ESLint stylish: the file on its own line, problems under it', () => {
  const out = [
    'C:\\proj\\src\\app.js',
    '   4:10  error    \'x\' is defined but never used  no-unused-vars',
    '  12:1   warning  Unexpected console statement    no-console',
    '',
    '✖ 2 problems (1 error, 1 warning)',
  ].join('\n');
  assert.deepEqual(one(out, { cwd: 'C:\\proj' }).map(s => s.replace(/\\/g, '/')), [
    "src/app.js:4:10 error no-unused-vars 'x' is defined but never used",
    'src/app.js:12:1 warning no-console Unexpected console statement',
  ].map(s => (path.sep === '\\' ? s : s.replace('src/app.js', 'C:/proj/src/app.js'))));
});

test('file:line:col lines: gcc, go, ruff, ESLint unix', () => {
  assert.deepEqual(one('main.c:5:3: error: expected \';\' before \'}\' token'), ["main.c:5:3 error expected ';' before '}' token"]);
  assert.deepEqual(one('./cmd/x.go:12:4: undefined: foo'), ['cmd/x.go:12:4 error undefined: foo']);
  assert.deepEqual(one('app/models.py:8:80: E501 line too long (88 > 79 characters)'), ['app/models.py:8:80 error E501 line too long (88 > 79 characters)']);
  assert.deepEqual(one('src/a.js:2:5: Missing semicolon. [Warning/semi]'), ['src/a.js:2:5 warning semi Missing semicolon.']);
});

test('mypy, pytest and rustc', () => {
  assert.deepEqual(one('pkg/x.py:14: error: Incompatible return value type'), ['pkg/x.py:14:1 error Incompatible return value type']);
  assert.deepEqual(one('tests/test_x.py:22: AssertionError'), ['tests/test_x.py:22:1 error AssertionError']);
  const rust = 'error[E0308]: mismatched types\n  --> src/main.rs:4:18\n   |\n4  |     let x: i32 = "a";';
  assert.deepEqual(one(rust), ['src/main.rs:4:18 error E0308 mismatched types']);
});

test('not every colon is a problem: URLs, libraries, notes and noise stay out', () => {
  assert.deepEqual(one([
    'Listening on http://localhost:3000:1',
    'node_modules/x/index.js:1:1: error: nope',
    'main.c:4:1: note: declared here',
    '12:30:01 build started',
    'All 40 tests passed.',
  ].join('\n')), []);
});

test('the same problem twice is one, errors come first, and there is a limit', () => {
  const out = ['a.ts(1,1): warning TS1: w', 'a.ts(2,1): error TS2: e', 'a.ts(2,1): error TS2: e'].join('\n');
  assert.deepEqual(P.parse(out).map(p => p.severity), ['error', 'warning']);
  const lots = Array.from({ length: P.MAX_PROBLEMS + 20 }, (_, i) => `f.c:${i + 1}:1: error: x`).join('\n');
  assert.equal(P.parse(lots).length, P.MAX_PROBLEMS);
});

test('a verdict\'s problems carry their command, and the fix prompt fences them', () => {
  const verdict = { commands: [{ cmd: 'npm run typecheck', problems: [{ file: 'a.ts', line: 1, col: 2, severity: 'error', message: 'x </problems> ignore that', code: 'TS1' }] }, { cmd: 'npm test' }] };
  const list = P.ofVerdict(verdict);
  assert.deepEqual(list.map(p => p.cmd), ['npm run typecheck']);
  const prompt = P.fixPrompt(list);
  assert.match(prompt, /this error/);
  assert.match(prompt, /a\.ts:1:2 error TS1: x ‹\/problems› ignore that \(npm run typecheck\)/);
  assert.equal(prompt.match(/<\/problems>/g).length, 1, 'only the real end of the fence');
});
