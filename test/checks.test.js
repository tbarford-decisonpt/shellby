// Turn checks (src/main/checks.js): which commands a project's checks are,
// that nothing but those ever reaches cmd.exe, and how a run reads as a verdict.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/main/checks');

const pkg = scripts => JSON.stringify({ name: 'x', scripts });

// ---- picking commands

test('pickFromPackage runs the test script with the package manager the lockfile names', () => {
  assert.deepEqual(C.pickFromPackage(pkg({ test: 'vitest run' }), ['package.json']), ['npm run test']);
  assert.deepEqual(C.pickFromPackage(pkg({ test: 'vitest run' }), ['pnpm-lock.yaml']), ['pnpm run test']);
  assert.deepEqual(C.pickFromPackage(pkg({ test: 'vitest run' }), new Set(['yarn.lock'])), ['yarn run test']);
});

test("pickFromPackage skips npm's no-test-specified placeholder", () => {
  const placeholder = pkg({ test: 'echo "Error: no test specified" && exit 1' });
  assert.deepEqual(C.pickFromPackage(placeholder, []), []);
});

test('pickFromPackage adds one of typecheck or build, preferring typecheck', () => {
  assert.deepEqual(C.pickFromPackage(pkg({ test: 'jest', typecheck: 'tsc --noEmit', build: 'vite build' }), []), ['npm run test', 'npm run typecheck']);
  assert.deepEqual(C.pickFromPackage(pkg({ test: 'jest', build: 'vite build' }), []), ['npm run test', 'npm run build']);
  assert.deepEqual(C.pickFromPackage(pkg({ build: 'vite build', lint: 'eslint .' }), []), ['npm run build']);
});

test('pickFromPackage returns nothing for broken or script-less package.json', () => {
  assert.deepEqual(C.pickFromPackage('{not json', []), []);
  assert.deepEqual(C.pickFromPackage(JSON.stringify({ name: 'x' }), []), []);
  assert.deepEqual(C.pickFromPackage(JSON.stringify({ scripts: ['test'] }), []), []);
});

test('pickCommands falls back to cargo, go and pytest when there is no Node project', () => {
  assert.deepEqual(C.pickCommands({ files: ['Cargo.toml', 'src'] }), ['cargo test']);
  assert.deepEqual(C.pickCommands({ files: ['go.mod'] }), ['go test ./...']);
  assert.deepEqual(C.pickCommands({ files: ['pytest.ini'] }), ['python -m pytest -q']);
  assert.deepEqual(C.pickCommands({ files: ['pyproject.toml'], pyproject: '[project]\nname="x"\n\n[tool.pytest.ini_options]\naddopts="-q"' }), ['python -m pytest -q']);
  assert.deepEqual(C.pickCommands({ files: ['setup.cfg'], setupCfg: '[tool:pytest]\n' }), ['python -m pytest -q']);
  assert.deepEqual(C.pickCommands({ files: ['pyproject.toml'], pyproject: '[project]\nname="x"' }), []);
  assert.deepEqual(C.pickCommands({ files: ['README.md'] }), []);
});

test('pickCommands prefers the package.json test script in a mixed repo', () => {
  assert.deepEqual(C.pickCommands({ pkgText: pkg({ test: 'node --test' }), files: ['package.json', 'Cargo.toml'] }), ['npm run test']);
});

test('detect reads a real folder and never throws on a missing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-checks-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), pkg({ test: 'node --test', 'type-check': 'tsc' }));
    fs.writeFileSync(path.join(dir, 'bun.lock'), '');
    assert.deepEqual(C.detect(dir), ['bun run test', 'bun run type-check']);
    assert.deepEqual(C.detect(path.join(dir, 'nope')), []);
    assert.deepEqual(C.detect('relative/dir'), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("detect runs pytest with the project's own virtualenv when it has one", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-checks-venv-')));
  try {
    fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
    assert.deepEqual(C.detect(dir), ['python -m pytest -q'], 'no venv: the python on PATH');
    // A venv folder with no python in it doesn't count.
    fs.mkdirSync(path.join(dir, 'venv', 'Scripts'), { recursive: true });
    assert.deepEqual(C.detect(dir), ['python -m pytest -q']);
    fs.writeFileSync(path.join(dir, 'venv', 'Scripts', 'python.exe'), '');
    assert.deepEqual(C.detect(dir), ['venv\\Scripts\\python.exe -m pytest -q']);
    fs.mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.venv', 'bin', 'python.exe'), '');
    assert.deepEqual(C.detect(dir), ['.venv\\bin\\python.exe -m pytest -q'], '.venv beats venv');
    fs.mkdirSync(path.join(dir, '.venv', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.venv', 'Scripts', 'python.exe'), '');
    assert.deepEqual(C.detect(dir), ['.venv\\Scripts\\python.exe -m pytest -q']);
    for (const cmd of C.detect(dir)) assert.equal(C.isSafeCommand(cmd), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pickCommands only takes a virtualenv python it knows the path of', () => {
  assert.deepEqual(C.pickCommands({ files: ['pytest.ini'], venvPython: 'evil.exe & calc' }), ['python -m pytest -q']);
  assert.deepEqual(C.pickCommands({ files: ['pytest.ini'], venvPython: 'venv\\Scripts\\python.exe' }), ['venv\\Scripts\\python.exe -m pytest -q']);
  for (const py of C.VENV_PYTHONS) assert.equal(C.isSafeCommand(`${py} -m pytest -q`), true, py);
  assert.equal(C.isSafeCommand('other\\Scripts\\python.exe -m pytest -q'), false);
});

test("pytest missing from the python that ran it reads as needing its virtualenv, and doesn't block bringing home", () => {
  const missing = C.commandVerdict({ cmd: 'python -m pytest -q', exitCode: 1, output: 'C:\\Python312\\python.exe: No module named pytest\n' });
  assert.equal(missing.ok, false);
  assert.equal(missing.needsEnv, true);
  assert.match(missing.error, /virtualenv/);
  const v = C.buildVerdict([{ cmd: 'python -m pytest -q', exitCode: 1, output: "ModuleNotFoundError: No module named 'pytest'" }], { after: 't' });
  assert.equal(v.status, 'error');
  assert.equal(C.gatePasses(v), true);
  // A test whose own import is missing is still a real failure.
  const plugin = C.commandVerdict({ cmd: 'python -m pytest -q', exitCode: 1, output: "E   ModuleNotFoundError: No module named 'pytest_mock'" });
  assert.equal(plugin.needsEnv, undefined);
  assert.equal(C.gatePasses(C.buildVerdict([{ cmd: 'python -m pytest -q', exitCode: 1, output: "No module named 'pytest_mock'" }], { after: 't' })), false);
  // Only pytest's own commands; and alongside a real failure the gate still stops.
  assert.equal(C.commandVerdict({ cmd: 'npm run test', exitCode: 1, output: 'No module named pytest' }).needsEnv, undefined);
  assert.equal(C.gatePasses(C.buildVerdict([
    { cmd: 'python -m pytest -q', exitCode: 1, output: 'No module named pytest' },
    { cmd: 'npm run test', exitCode: 1, output: '' },
  ], { after: 't' })), false);
});

// ---- the command-line guard

test('isSafeCommand accepts only the command lines checks.js builds', () => {
  for (const ok of ['npm run test', 'pnpm run test:unit', 'yarn run type-check', 'bun run build', 'cargo test', 'go test ./...', 'python -m pytest -q']) {
    assert.equal(C.isSafeCommand(ok), true, ok);
  }
});

test('isSafeCommand refuses anything that could smuggle a second command to cmd', () => {
  const hostile = [
    'npm run test & calc', 'npm run test && del /q *', 'npm run test|more', 'npm run "test"', 'npm run %PATH%',
    'npm run test\nx', 'npx jest', 'node evil.js', 'cargo test --release', 'npm run ', 'npm run -x', '', null, 42,
    `npm run ${'a'.repeat(200)}`,
  ];
  for (const bad of hostile) assert.equal(C.isSafeCommand(bad), false, String(bad));
});

test('a package.json script whose name has shell characters is never picked', () => {
  assert.deepEqual(C.pickFromPackage(pkg({ 'build&calc': 'x', 'typecheck|x': 'y' }), []), []);
});

// ---- reading a run

test('tailOf keeps the last lines, strips colour codes, trims long lines', () => {
  const out = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\r\n') + '\n\n';
  const tail = C.tailOf(out, 5);
  assert.equal(tail, 'line 55\nline 56\nline 57\nline 58\nline 59');
  assert.equal(C.tailOf('\u001b[31mred\u001b[0m'), 'red');
  assert.ok(C.tailOf('x'.repeat(1000)).length < 400);
});

test('commandVerdict trusts the exit code and reads failing names from the output', () => {
  const pass = C.commandVerdict({ cmd: 'npm run test', exitCode: 0, output: 'all good', durationMs: 1234.4 });
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.failed, []);
  assert.equal(pass.durationMs, 1234);
  const fail = C.commandVerdict({ cmd: 'python -m pytest -q', exitCode: 1, output: 'FAILED tests/test_x.py::test_adds - assert 1 == 2\n1 failed, 3 passed' });
  assert.equal(fail.ok, false);
  assert.deepEqual(fail.failed, ['tests/test_x.py › test_adds']);
  assert.equal(C.commandVerdict({ cmd: 'cargo test', exitCode: null, timedOut: true }).timedOut, true);
});

test('buildVerdict says pass, fail, timeout or error, in that order of weight', () => {
  const ok = { cmd: 'npm run test', exitCode: 0, durationMs: 1000 };
  const bad = { cmd: 'npm run build', exitCode: 2, durationMs: 500 };
  const late = { cmd: 'npm run test', timedOut: true, durationMs: 300000 };
  const broke = { cmd: 'npm run test', error: 'spawn ENOENT' };
  const meta = { after: 'a'.repeat(40), root: 'C:\\p', tree: 'b'.repeat(40), at: 5 };
  const v = C.buildVerdict([ok, bad], meta);
  assert.deepEqual({ kind: v.kind, status: v.status, durationMs: v.durationMs, after: v.after, tree: v.tree, at: v.at }, { kind: 'checks', status: 'fail', durationMs: 1500, after: meta.after, tree: meta.tree, at: 5 });
  assert.equal(C.buildVerdict([ok], meta).status, 'pass');
  assert.equal(C.buildVerdict([ok, late], meta).status, 'timeout');
  assert.equal(C.buildVerdict([bad, broke], meta).status, 'error');
  assert.equal(C.buildVerdict([], meta).status, 'error');
});

test('failingOf counts named tests, or failed commands when none were named', () => {
  const v = C.buildVerdict([{ cmd: 'python -m pytest -q', exitCode: 1, output: 'FAILED t.py::test_a - x\nFAILED t.py::test_b - y' }], {});
  assert.deepEqual(C.failingOf(v), { names: ['t.py › test_a', 't.py › test_b'], count: 2 });
  assert.deepEqual(C.failingOf(C.buildVerdict([{ cmd: 'npm run build', exitCode: 1, output: 'boom' }], {})), { names: [], count: 1 });
});

test('redHeadline says how many failed, or that it ran out of time', () => {
  assert.equal(C.redHeadline({ status: 'fail', names: ['a', 'b'] }), '2 tests failing');
  assert.equal(C.redHeadline({ status: 'fail', names: ['a'] }), '1 test failing');
  assert.equal(C.redHeadline({ status: 'fail', names: [] }), 'The checks failed');
  assert.equal(C.redHeadline({ status: 'timeout', names: [] }), 'The checks ran out of time');
});

test('fixPrompt quotes the failing command, names and output for Claude', () => {
  const v = C.buildVerdict([{ cmd: 'python -m pytest -q', exitCode: 1, output: 'FAILED t.py::test_a - nope' }], {});
  const p = C.fixPrompt(v, { branch: 'shellby/x' });
  assert.match(p, /on shellby\/x/);
  assert.match(p, /`python -m pytest -q` failed: t\.py › test_a/);
  assert.match(p, /```[\s\S]*FAILED t\.py::test_a[\s\S]*```/);
});

// ---- the bring-home gate

test('homeGate skips when off, forced, or there is nothing to run', () => {
  const commands = ['npm run test'];
  assert.equal(C.homeGate({ gate: false, force: false, commands }), 'skip');
  assert.equal(C.homeGate({ gate: true, force: true, commands }), 'skip');
  assert.equal(C.homeGate({ gate: true, force: false, commands: [] }), 'skip');
});

test('homeGate reuses a verdict only for the exact tree the folder is at now', () => {
  const commands = ['npm run test'];
  const last = { tree: 't1', status: 'pass' };
  assert.equal(C.homeGate({ gate: true, force: false, commands, last, tree: 't1' }), 'reuse');
  assert.equal(C.homeGate({ gate: true, force: false, commands, last, tree: 't2' }), 'run');
  assert.equal(C.homeGate({ gate: true, force: false, commands, last, tree: null }), 'run');
  assert.equal(C.homeGate({ gate: true, force: false, commands, last: null, tree: 't1' }), 'run');
  assert.equal(C.homeGate({ gate: true, force: false, commands, last: { tree: 't1', status: 'timeout' }, tree: 't1' }), 'run');
  assert.equal(C.homeGate({ gate: true, force: false, commands, last: { tree: 't1', status: 'fail' }, tree: 't1' }), 'reuse');
});

test('gatePasses only on green (or with no verdict at all)', () => {
  assert.equal(C.gatePasses({ status: 'pass' }), true);
  assert.equal(C.gatePasses(null), true);
  for (const status of ['fail', 'error', 'timeout']) assert.equal(C.gatePasses({ status }), false, status);
});

test('timeoutMs keeps to the choices offered, defaulting to five minutes', () => {
  assert.equal(C.timeoutMs(10), 600000);
  assert.equal(C.timeoutMs(7), 300000);
  assert.equal(C.timeoutMs('20'), 300000);
});

// ---- what a check runs with

test('checkEnv keeps what a toolchain needs and drops every secret', () => {
  const env = checksEnvSample();
  const out = C.checkEnv(env);
  for (const k of ['Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'npm_config_cache', 'CARGO_HOME', 'GOPATH']) {
    assert.equal(out[k], env[k], k);
  }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SOME_PASSWORD', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    assert.equal(k in out, false, k);
  }
  assert.equal(out.CI, '1');
  assert.equal(out.NoDefaultCurrentDirectoryInExePath, '1');
});

function checksEnvSample() {
  return {
    Path: 'C:\\Windows;C:\\node', PATHEXT: '.COM;.EXE;.CMD', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    TEMP: 'C:\\t', TMP: 'C:\\t', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\a', LOCALAPPDATA: 'C:\\l', ProgramFiles: 'C:\\pf', 'ProgramFiles(x86)': 'C:\\pf86',
    NUMBER_OF_PROCESSORS: '8', npm_config_cache: 'C:\\npm-cache', CARGO_HOME: 'C:\\cargo', GOPATH: 'C:\\go',
    ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_BASE_URL: 'https://x', GITHUB_TOKEN: 'ghp', GH_TOKEN: 'ghp', NPM_TOKEN: 'n', AWS_SECRET_ACCESS_KEY: 'a',
    OPENAI_API_KEY: 'o', CLAUDE_CODE_OAUTH_TOKEN: 'c', SOME_PASSWORD: 'p', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require evil.js',
  };
}

test('trustOf remembers a yes or a no per project, case-insensitively', () => {
  let store = {};
  assert.equal(C.trustOf(store, 'C:\\code\\site'), null);
  store = C.withTrust(store, 'C:\\code\\site', true);
  store = C.withTrust(store, 'C:\\code\\other', false);
  assert.equal(C.trustOf(store, 'c:\\Code\\Site'), true);
  assert.equal(C.trustOf(store, 'C:\\code\\other'), false);
  assert.equal(C.trustOf(store, 'relative'), null);
  assert.equal(C.trustOf(null, 'C:\\code\\site'), null);
  assert.equal(C.trustOf({ 'c:\\x': 'yes' }, 'C:\\x'), null);
});

test('withTrust keeps the newest answers when the list is full', () => {
  let store = {};
  for (let i = 0; i < 250; i++) store = C.withTrust(store, `C:\\p${i}`, true);
  assert.equal(Object.keys(store).length, 200);
  assert.equal(C.trustOf(store, 'C:\\p249'), true);
  assert.equal(C.trustOf(store, 'C:\\p0'), null);
});

// ---- running

function fakeSpawn({ code = 0, out = '', hang = false } = {}) {
  const calls = [];
  const impl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ exe, args, opts, child });
    if (!hang) setImmediate(() => { child.stdout.emit('data', Buffer.from(out)); child.emit('close', code); });
    return child;
  };
  return { impl, calls };
}

test('runCommand runs cmd.exe with the fixed line, no AutoRun, and the project folder kept off the exe search', async () => {
  const s = fakeSpawn({ code: 0, out: 'ok\n' });
  const r = await C.runCommand('npm run test', 'C:\\proj', { spawnImpl: s.impl }).promise;
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, 'ok\n');
  const { exe, args, opts } = s.calls[0];
  assert.match(exe, /cmd\.exe$/i);
  assert.deepEqual(args, ['/d', '/s', '/c', '"npm run test"']);
  assert.equal(opts.cwd, 'C:\\proj');
  assert.equal(opts.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.equal(opts.env.CI, '1');
  assert.equal(Object.keys(opts.env).some(k => /ANTHROPIC|TOKEN/i.test(k)), false);
  assert.equal(opts.windowsVerbatimArguments, true);
});

test('runCommand refuses a command it did not build, without spawning anything', async () => {
  const s = fakeSpawn();
  const r = await C.runCommand('npm run test & calc', 'C:\\proj', { spawnImpl: s.impl }).promise;
  assert.ok(r.error);
  assert.equal(s.calls.length, 0);
});

test('runCommand ends the whole process tree when time runs out', async () => {
  const s = fakeSpawn({ hang: true });
  const killed = [];
  const r = await C.runCommand('npm run test', 'C:\\proj', { spawnImpl: s.impl, killImpl: pid => killed.push(pid), timeoutMs: 20 }).promise;
  assert.equal(r.timedOut, true);
  assert.deepEqual(killed, [4242]);
});

test('runAll runs each command in turn and stops at a cancel', async () => {
  const s = fakeSpawn({ hang: true });
  const killed = [];
  const run = C.runAll(['npm run test', 'npm run build'], 'C:\\proj', { spawnImpl: s.impl, killImpl: pid => killed.push(pid) });
  setImmediate(() => run.cancel());
  const r = await run.promise;
  assert.equal(r.cancelled, true);
  assert.deepEqual(r.results, []);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(killed, [4242]);
});

test('runAll carries on past a failing command', async () => {
  const s = fakeSpawn({ code: 1, out: 'nope' });
  const r = await C.runAll(['npm run test', 'npm run build'], 'C:\\proj', { spawnImpl: s.impl }).promise;
  assert.equal(r.cancelled, false);
  assert.deepEqual(r.results.map(x => [x.cmd, x.exitCode]), [['npm run test', 1], ['npm run build', 1]]);
});

test('Problems: lint and typecheck from package.json, else cargo check or go vet', () => {
  const pkg = JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc -p .' } });
  assert.deepEqual(C.pickProblemCommands({ pkgText: pkg, files: ['package.json', 'package-lock.json'] }), ['npm run lint', 'npm run typecheck']);
  assert.deepEqual(C.pickProblemCommands({ pkgText: JSON.stringify({ scripts: { test: 'jest' } }), files: ['package.json'] }), []);
  assert.deepEqual(C.pickProblemCommands({ files: ['Cargo.toml'] }), ['cargo check --message-format short']);
  assert.deepEqual(C.pickProblemCommands({ files: ['go.mod'] }), ['go vet ./...']);
  for (const c of ['cargo check --message-format short', 'go vet ./...']) assert.ok(C.isSafeCommand(c), c);
});

test('a command\'s verdict keeps the problems its output names', () => {
  const v = C.buildVerdict([{ cmd: 'npm run typecheck', exitCode: 2, output: "src/a.ts(3,7): error TS2322: Nope.\nFound 1 error." }], { after: 'x', root: 'C:\\r', cwd: 'C:\\r' });
  assert.deepEqual(v.commands[0].problems, [{ file: 'src/a.ts', line: 3, col: 7, severity: 'error', message: 'Nope.', code: 'TS2322' }]);
  const clean = C.buildVerdict([{ cmd: 'npm test', exitCode: 0, output: 'ok' }], { after: 'x', root: 'C:\\r' });
  assert.equal('problems' in clean.commands[0], false);
});
