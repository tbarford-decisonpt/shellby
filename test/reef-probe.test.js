const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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

// A small repo of its own: the probe keeps each escape's file, never its text.
function tempRepo(t) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-reef-probe-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

test('escapes keeps the files and kinds behind the count', async t => {
  const repo = tempRepo(t);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@shellby.test', '-c', 'user.name=t', ...args], { windowsHide: true, stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), '// @ts-ignore\nconst a: any = 1;\n');
  fs.writeFileSync(path.join(repo, 'b.py'), 'import os  # noqa\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const r = await probe.escapes(repo);
  assert.equal(r.count, 3);
  assert.deepEqual(r.detail.files, [['src/a.ts', 2], ['b.py', 1]]);
  assert.ok(!JSON.stringify(r.detail).includes('import os'));
});

test('coverage keeps the files with the most uncovered lines', async t => {
  const repo = tempRepo(t);
  fs.mkdirSync(path.join(repo, 'coverage'));
  fs.writeFileSync(path.join(repo, 'coverage', 'lcov.info'), 'SF:src/x.js\nLF:4\nLH:1\nend_of_record\nSF:src/y.js\nLF:6\nLH:6\nend_of_record\n');
  const c = await probe.coverage(repo, 0);
  assert.equal(c.pct, 70);
  assert.deepEqual(c.files, [['src/x.js', 25, 3]]);
});
