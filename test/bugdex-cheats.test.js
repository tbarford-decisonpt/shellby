const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/main/bugdex/cheats');

const diff = (file, added = [], removed = []) => [
  `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,3 +1,3 @@',
  ...removed.map(l => `-${l}`), ...added.map(l => `+${l}`),
].join('\n');

test('a real edit is a fix', () => {
  assert.deepEqual(c.judge({ files: [{ path: 'src/a.js', status: 'M' }], patch: diff('src/a.js', ['return user?.name;'], ['return user.name;']), species: 'nullfish' }), { ok: true });
});

test('no change is no fix, unless a remedy ran', () => {
  assert.equal(c.judge({ files: [], species: 'nullfish' }).reason, 'no-change');
  assert.deepEqual(c.judge({ files: [], species: 'stray-module-minnow', remedy: true }), { ok: true });
});

test('going back to how the code was before it broke is not a fix', () => {
  assert.equal(c.judge({ files: [{ path: 'a.js', status: 'M' }], species: 'nullfish', revert: true }).reason, 'revert');
});

test('a deleted test is named as such, even when it is also an undo', () => {
  assert.equal(c.judge({ files: [{ path: 'add.test.js', status: 'D' }], species: 'assertive-lobster', revert: true }).reason, 'deleted-tests');
});

test('a deleted test file is refused', () => {
  assert.equal(c.judge({ files: [{ path: 'test/auth.test.js', status: 'D' }], species: 'red-snapper' }).reason, 'deleted-tests');
  assert.equal(c.judge({ files: [{ path: 'pkg/auth_test.go', status: 'D' }], species: 'red-snapper' }).reason, 'deleted-tests');
});

test('skipping a test is refused, in several languages', () => {
  for (const line of ["it.skip('signs in', () => {", '@pytest.mark.skip(reason="later")', '#[ignore]', "xit('x', () => {})", 't.Skip("flaky")']) {
    const r = c.judge({ files: [{ path: 'tests/a.test.js', status: 'M' }], patch: diff('tests/a.test.js', [line]), species: 'red-snapper' });
    assert.equal(r.reason, 'skipped', line);
  }
});

test('suppressions: always for type and lint species, otherwise only when that is the whole change', () => {
  const ign = diff('src/a.ts', ['// @ts-ignore', 'const x: number = s;']);
  assert.equal(c.judge({ files: [{ path: 'src/a.ts', status: 'M' }], patch: ign, species: 'mismatched-mantis' }).reason, 'suppressed');
  assert.equal(c.judge({ files: [{ path: 'src/a.ts', status: 'M' }], patch: diff('src/a.ts', ['const v = (x as any).y;']), species: 'type-tangle' }).reason, 'suppressed');
  assert.equal(c.judge({ files: [{ path: 'a.js', status: 'M' }], patch: diff('a.js', ['// eslint-disable-next-line']), species: 'nullfish' }).reason, 'suppressed');
  assert.deepEqual(c.judge({ files: [{ path: 'a.js', status: 'M' }], patch: diff('a.js', ['// eslint-disable-next-line', 'if (!u) return;']), species: 'nullfish' }), { ok: true });
});

test('fewer passing tests is refused for test species', () => {
  assert.equal(c.judge({ files: [{ path: 'a.js', status: 'M' }], species: 'red-snapper', counts: { before: 10, after: 8 } }).reason, 'fewer-tests');
  assert.deepEqual(c.judge({ files: [{ path: 'a.js', status: 'M' }], species: 'red-snapper', counts: { before: 10, after: 11 } }), { ok: true });
});

test('updating snapshots is not fixing them', () => {
  assert.equal(c.judge({ files: [{ path: 'src/a.js', status: 'M' }], species: 'mirror-mullet', passCmd: 'npx jest -u' }).reason, 'snapshots-only');
  assert.equal(c.judge({ files: [{ path: 'src/__snapshots__/a.test.js.snap', status: 'M' }], species: 'mirror-mullet', passCmd: 'npx jest' }).reason, 'snapshots-only');
});

test('raising a timeout or the heap is not a fix', () => {
  assert.equal(c.judge({ files: [{ path: 'a.test.js', status: 'M' }], patch: diff('a.test.js', ['jest.setTimeout(30000);'], ['jest.setTimeout(5000);']), species: 'slowpoke-snail' }).reason, 'bigger-number');
  assert.equal(c.judge({ files: [{ path: 'package.json', status: 'M' }], patch: diff('package.json', ['"build": "node --max-old-space-size=8192 build.js"'], ['"build": "node build.js"']), species: 'heap-leviathan' }).reason, 'bigger-number');
  assert.deepEqual(c.judge({ files: [{ path: 'a.js', status: 'M' }], patch: diff('a.js', ['await Promise.all(jobs);'], ['for (const j of jobs) await j;']), species: 'slowpoke-snail' }), { ok: true });
});

test('turning off certificate checks is refused', () => {
  assert.equal(c.judge({ files: [{ path: 'a.js', status: 'M' }], patch: diff('a.js', ['const agent = new https.Agent({ rejectUnauthorized: false });']), species: 'cert-cuttlefish' }).reason, 'insecure');
});

test('splitPatch keeps added and removed lines per file', () => {
  const p = c.splitPatch(`${diff('a.js', ['x'], ['y'])}\n${diff('b.js', ['z'])}`);
  assert.deepEqual(p['a.js'], { added: ['x'], removed: ['y'] });
  assert.deepEqual(p['b.js'], { added: ['z'], removed: [] });
});

test('every reason has words', () => {
  for (const r of ['no-change', 'revert', 'deleted-tests', 'skipped', 'suppressed', 'fewer-tests', 'snapshots-only', 'bigger-number', 'insecure', 'tests-only']) assert.ok(c.REASONS[r], r);
});

test('a slept-through test is not fixed by a longer timeout, and no fewer tests may run', () => {
  const bigger = diff('jest.config.js', ['  testTimeout: 30000,'], ['  testTimeout: 5000,']);
  assert.equal(c.judge({ files: [{ path: 'jest.config.js', status: 'M' }], patch: bigger, species: 'sleepy-seahorse' }).reason, 'bigger-number');
  assert.equal(c.judge({ files: [{ path: 'a.js', status: 'M' }], species: 'hollow-halibut', counts: { before: 3, after: 1 } }).reason, 'fewer-tests');
});
