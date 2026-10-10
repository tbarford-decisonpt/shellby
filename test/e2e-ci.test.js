// scripts/e2e-ci.js: which checks a run picks. CI splits them into shards
// across machines, so a check that lands in no shard would never run at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const { SUITE, discover, pick, balance, reap, reapScript } = require('../scripts/e2e-ci');

test('a script is a check when its first line is a "// ci:" mark, and only then', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-ci-'));
  try {
    fs.writeFileSync(path.join(dir, 'e2e-b.js'), '// ci: the b screen\nconsole.log(1);\n');
    fs.writeFileSync(path.join(dir, 'a-check.js'), '// ci: a\n');
    fs.writeFileSync(path.join(dir, 'e2e-manual.js'), '// Needs a real Claude account.\n// ci: not on the first line\n');
    fs.writeFileSync(path.join(dir, 'e2e-empty.js'), '// ci: \n');
    fs.writeFileSync(path.join(dir, 'notes.md'), '// ci: not a script\n');
    assert.deepEqual(discover(dir), ['a-check', 'e2e-b']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the suite is the marked scripts in scripts/', () => {
  assert.ok(SUITE.includes('e2e-queue') && SUITE.includes('ui-regressions'));
  assert.ok(!SUITE.includes('e2e-ci') && !SUITE.includes('e2e-on-top'), 'the runner, and a check that needs the desktop to itself, are not');
});

test('every check is in exactly one shard, whatever the number of shards', () => {
  for (const n of [1, 2, 3, 4, 7]) {
    const shards = Array.from({ length: n }, (_, i) => pick(SUITE, [`--shard=${i + 1}/${n}`]).suite);
    assert.deepEqual(shards.flat().sort(), [...SUITE].sort(), `${n} shards`);
  }
});

// By name, one shard ran 7.2 minutes while another was done in 3.6.
test('shards are split by how long their checks take, slowest first', () => {
  const times = { a: 90, b: 40, c: 30, d: 20, e: 10 };
  assert.deepEqual(balance(Object.keys(times), 2, times), [['a', 'e'], ['b', 'c', 'd']], '100s and 90s');
  assert.deepEqual(balance(['x', 'y', 'z'], 3, {}), [['x'], ['y'], ['z']], 'no times: one each, by name');
  assert.deepEqual(balance(['a', 'new'], 2, { a: 5 }), [['a'], ['new']], 'a check with no time yet counts as a typical one');
  assert.deepEqual(balance(['b', 'a'], 1, {}), [['a', 'b']], 'a shard runs its checks by name');
});

test("the real suite's six shards come out close in time", () => {
  const times = require('../scripts/e2e-times.json');
  const secs = SUITE.map(c => times[c]).filter(Number.isFinite);
  const loads = balance(SUITE, 6).map(s => s.reduce((n, c) => n + (times[c] || 0), 0));
  assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...secs), `within one check: ${loads.map(Math.round)}`);
});

test('names narrow the run first, then the shard splits what is left', () => {
  assert.deepEqual(pick(SUITE, ['queue']).suite, ['e2e-queue']);
  const stickers = pick(SUITE, ['stickers']).suite;
  const halves = [1, 2].map(i => pick(SUITE, ['stickers', `--shard=${i}/2`]).suite);
  assert.deepEqual(halves.flat().sort(), [...stickers].sort());
});

test('a shard that makes no sense, or a name that matches nothing, is refused', () => {
  for (const bad of ['--shard=0/4', '--shard=5/4', '--shard=2', '--shard']) assert.match(pick(SUITE, [bad]).error, /use --shard=i\/n/, bad);
  assert.match(pick(SUITE, ['nothing-like-this']).error, /No checks match/);
  assert.match(pick(SUITE, ['queue', '--shard=2/2']).error, /leaves this shard none to run/);
});

test('the clean-up walks only the check\'s own tree, from processes started since it began', () => {
  const ps = reapScript({ rootPid: 4242, sinceMs: 1760000000000 });
  assert.match(ps, /FromUnixTimeMilliseconds\(1760000000000\)/);
  assert.match(ps, /\$keep\.Add\(4242\)/);
  assert.match(ps, /\$keep\.Remove\(4242\)/, 'the check itself is gone already');
  assert.doesNotMatch(ps, /Name = /, 'nothing is matched by name alone, so no one else\'s Electron or node');
  assert.ok(ps.includes(path.resolve(__dirname, '..') + path.sep), 'and only what runs from this checkout');
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('what a finished check left running is stopped', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const started = Date.now();
  // A stand-in for a check: it starts a helper that outlives it, says its pid, and exits.
  const orphan = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)',process.argv[1]],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)";
  // The helper names a file of this checkout, as the fake Claude CLI does.
  const r = spawnSync(process.execPath, ['-e', orphan, path.join(__dirname, 'fixtures', 'fake-claude.js')], { encoding: 'utf8' });
  const helper = Number(r.stdout.trim());
  assert.ok(alive(helper), 'the helper outlived its check');
  try {
    assert.equal(reap(r.pid, started), 1);
    const deadline = Date.now() + 5000;
    while (alive(helper) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(alive(helper), false);
  } finally { if (alive(helper)) process.kill(helper); }
});

test('a leftover that is not this checkout\'s is left alone, even in the tree', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const started = Date.now();
  const orphan = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)";
  const r = spawnSync(process.execPath, ['-e', orphan], { encoding: 'utf8', cwd: require('os').tmpdir() });
  const helper = Number(r.stdout.trim());
  try {
    assert.equal(reap(r.pid, started), 0);
    assert.ok(alive(helper));
  } finally { if (alive(helper)) process.kill(helper); }
});

test('every check in the suite is a script that exists', () => {
  for (const name of SUITE) assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', `${name}.js`)), name);
});
