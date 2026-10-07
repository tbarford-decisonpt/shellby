// scripts/e2e-ci.js: which checks a run picks. CI splits them into shards
// across machines, so a check that lands in no shard would never run at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SUITE, pick } = require('../scripts/e2e-ci');

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

test('every check in the suite is a script that exists', () => {
  for (const name of SUITE) assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', `${name}.js`)), name);
});
