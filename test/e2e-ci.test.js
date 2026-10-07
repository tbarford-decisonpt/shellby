// scripts/e2e-ci.js: which checks a run picks. CI splits them into shards
// across machines, so a check that lands in no shard would never run at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SUITE, pick, reap, reapScript } = require('../scripts/e2e-ci');

test('every check is in exactly one shard, whatever the number of shards', () => {
  for (const n of [1, 2, 3, 4, 7]) {
    const shards = Array.from({ length: n }, (_, i) => pick(SUITE, [`--shard=${i + 1}/${n}`]).suite);
    assert.deepEqual(shards.flat().sort(), [...SUITE].sort(), `${n} shards`);
    const sizes = shards.map(s => s.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${n} shards are even: ${sizes}`);
  }
});

test('names narrow the run first, then the shard splits what is left', () => {
  assert.deepEqual(pick(SUITE, ['queue']).suite, ['e2e-queue']);
  const stickers = pick(SUITE, ['stickers']).suite;
  assert.deepEqual(pick(SUITE, ['stickers', '--shard=1/2']).suite, [stickers[0]]);
});

test('a shard that makes no sense, or a name that matches nothing, is refused', () => {
  for (const bad of ['--shard=0/4', '--shard=5/4', '--shard=2', '--shard']) assert.match(pick(SUITE, [bad]).error, /use --shard=i\/n/, bad);
  assert.match(pick(SUITE, ['nothing-like-this']).error, /No checks match/);
});

test('the clean-up walks only the check\'s own tree, from processes started since it began', () => {
  const ps = reapScript({ rootPid: 4242, sinceMs: 1760000000000 });
  assert.match(ps, /FromUnixTimeMilliseconds\(1760000000000\)/);
  assert.match(ps, /\$keep\.Add\(4242\)/);
  assert.match(ps, /\$keep\.Remove\(4242\)/, 'the check itself is gone already');
  assert.doesNotMatch(ps, /Name = /, 'nothing is matched by name, so no one else\'s Electron or node');
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('what a finished check left running is stopped', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const started = Date.now();
  // A stand-in for a check: it starts a helper that outlives it, says its pid, and exits.
  const orphan = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)";
  const r = spawnSync(process.execPath, ['-e', orphan], { encoding: 'utf8' });
  const helper = Number(r.stdout.trim());
  assert.ok(alive(helper), 'the helper outlived its check');
  try {
    assert.equal(reap(r.pid, started), 1);
    const deadline = Date.now() + 5000;
    while (alive(helper) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(alive(helper), false);
  } finally { if (alive(helper)) process.kill(helper); }
});

test('every check in the suite is a script that exists', () => {
  for (const name of SUITE) assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', `${name}.js`)), name);
});
