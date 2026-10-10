// scripts/release-cut.js: reading what you typed. The release itself is
// release-git.js's cutRelease, tested in projects-release-git.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, ciGate } = require('../scripts/release-cut');

test('a version first, then the title in as many words as you typed', () => {
  assert.deepEqual(parseArgs(['0.72.0', 'Change', 'notes']), { version: '0.72.0', title: 'Change notes', dryRun: false, wait: false, skipCi: false });
  assert.deepEqual(parseArgs(['0.72.0', 'Change notes']), { version: '0.72.0', title: 'Change notes', dryRun: false, wait: false, skipCi: false });
});

test('no version means the suggested one, and --dry-run can go anywhere', () => {
  assert.deepEqual(parseArgs(['The', 'inbox', '--dry-run']), { version: null, title: 'The inbox', dryRun: true, wait: false, skipCi: false });
  assert.deepEqual(parseArgs(['--dry-run']), { version: null, title: '', dryRun: true, wait: false, skipCi: false });
  assert.equal(parseArgs(['v0.72.0', 'x']).version, null, 'a tag is not a version: it becomes part of the title');
});

test('--wait and --skip-ci are flags, not words of the title', () => {
  assert.deepEqual(parseArgs(['0.78.0', 'Title', '--wait']), { version: '0.78.0', title: 'Title', dryRun: false, wait: true, skipCi: false });
  assert.equal(parseArgs(['--skip-ci', 'x']).skipCi, true);
});

// 0.78.0 was cut over 49 merged commits CI had never run together: three CI
// rounds, half an hour each, before it could ship. Now the cut waits for CI.
test('a release is cut only once CI has passed on what it releases', () => {
  const pushed = { upstream: { name: 'origin/main', ahead: 0, behind: 0 }, head: 'a'.repeat(40) };
  assert.equal(ciGate(pushed, { state: 'green' }), null);
  assert.match(ciGate({ ...pushed, upstream: { name: 'origin/main', ahead: 3 } }, null), /3 commits on this branch aren't pushed.*git push/s);
  assert.match(ciGate(pushed, { state: 'running', problem: 'CI is still running on aaaaaaa.' }), /still running.*--wait/s);
  assert.match(ciGate(pushed, { state: 'failed', problem: 'e2e (2/6) failed on aaaaaaa.' }), /e2e \(2\/6\) failed/);
  assert.match(ciGate(pushed, { state: 'missing', problem: "CI hasn't run on aaaaaaa." }), /hasn't run.*--wait/s);
  assert.match(ciGate({ ...pushed, upstream: null }, null), /no upstream/i);
});
