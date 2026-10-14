const { test } = require('node:test');
const assert = require('node:assert/strict');
const probe = require('../src/main/reef/probe');

const ROOT = process.platform === 'win32' ? 'C:\\code\\app' : '/code/app';

test('every git call switches off what a repository could make it run', () => {
  for (const cmd of [['diff', '--shortstat', 'a', 'b'], ['grep', '-h', 'x', 'HEAD'], ['rev-parse', 'HEAD'], ['ls-files', '-z']]) {
    const args = probe.gitArgs(ROOT, cmd);
    assert.ok(args.includes('core.fsmonitor=false'), cmd[0]);
    assert.ok(args.some(a => a.startsWith('core.hooksPath=')), cmd[0]);
    assert.ok(args.includes('--no-optional-locks'), cmd[0]);
    assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 3), ['-C', ROOT, cmd[0]]);
  }
});

test('diffs never use external diff or textconv drivers, and grep no textconv', () => {
  const diff = probe.gitArgs(ROOT, ['diff', '--shortstat', 'a', 'b']);
  assert.ok(diff.includes('--no-ext-diff') && diff.includes('--no-textconv'));
  assert.ok(diff.indexOf('--no-ext-diff') > diff.indexOf('diff'), 'after the subcommand');
  assert.ok(probe.gitArgs(ROOT, ['grep', 'x']).includes('--no-textconv'));
});

test('deletedShare refuses a folder that is not a plain local path', async () => {
  const sha = 'a'.repeat(40);
  assert.equal(await probe.deletedShare('\\\\server\\share', sha, 'b'.repeat(40)), 0);
  assert.equal(await probe.deletedShare('relative/dir', sha, 'b'.repeat(40)), 0);
});
