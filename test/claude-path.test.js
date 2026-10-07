// Finding the Claude Code CLI, including the path a user picks by hand when the
// usual places don't have it (a portable copy, another drive, a company image).
// Before this, the only way out was an undocumented environment variable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findClaude, verifyClaude, candidatePaths, currentClaude } = require('../src/main/claude-cli');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));

test('a configured path is tried before the usual places', () => {
  const dir = tmp();
  const picked = path.join(dir, 'claude.exe');
  fs.writeFileSync(picked, '');
  // Somewhere the normal search would also find one.
  const onPath = tmp();
  fs.writeFileSync(path.join(onPath, 'claude.exe'), '');

  assert.equal(findClaude({ PATH: onPath }, picked), picked);
  assert.equal(findClaude({ PATH: onPath }), path.join(onPath, 'claude.exe'), 'and is ignored when not set');
});

test('the environment variable still wins, for dev and e2e runs', () => {
  const dir = tmp();
  const env = path.join(dir, 'from-env.exe');
  const picked = path.join(dir, 'from-settings.exe');
  fs.writeFileSync(env, '');
  fs.writeFileSync(picked, '');
  assert.equal(findClaude({ SHELLBY_CLAUDE_PATH: env }, picked), env);
  assert.deepEqual(candidatePaths({ SHELLBY_CLAUDE_PATH: env }, picked).slice(0, 2), [env, picked]);
});

test('a configured path that has gone away falls back to the search', () => {
  const onPath = tmp();
  const real = path.join(onPath, 'claude.exe');
  fs.writeFileSync(real, '');
  // Uninstalled, moved, or an unplugged drive.
  assert.equal(findClaude({ PATH: onPath }, 'Z:\\gone\\claude.exe'), real);
});

test('a configured path is not trusted blindly', () => {
  assert.equal(findClaude({ PATH: tmp() }, 'Z:\\nothing\\here.exe'), null);
  assert.equal(findClaude({ PATH: tmp() }, ''), null);
  assert.equal(findClaude({ PATH: tmp() }, null), null);
});

test('verify accepts a program that reports a version', async () => {
  // node is standing in for the CLI: the point is that it runs and answers.
  const r = await verifyClaude(process.execPath);
  assert.equal(r.ok, true);
  assert.match(r.version, /^\d+\.\d+\.\d+$/);
  assert.equal(r.exe, process.execPath);
});

test('verify rejects a file that is not a program, naming it', async () => {
  const dir = tmp();
  const notACli = path.join(dir, 'readme.txt');
  fs.writeFileSync(notACli, 'just text');
  const r = await verifyClaude(notACli);
  assert.equal(r.ok, false);
  assert.match(r.error, /readme\.txt/, 'the message says which file');
});

test('verify rejects a folder, a missing file and nothing at all', async () => {
  const dir = tmp();
  assert.match((await verifyClaude(dir)).error, /folder/);
  assert.match((await verifyClaude(path.join(dir, 'nope.exe'))).error, /there any more/);
  assert.match((await verifyClaude('')).error, /No file chosen/);
  assert.match((await verifyClaude(null)).error, /No file chosen/);
});

// Claude Code's own installer can move it while Shellby runs: the native
// updater takes an npm copy away, say. The path found at boot is kept only
// while it's still there; otherwise the search runs again, then and there.
test('a found path is kept while it is still there', () => {
  const dir = tmp();
  const found = path.join(dir, 'claude.exe');
  fs.writeFileSync(found, '');
  const onPath = tmp();
  fs.writeFileSync(path.join(onPath, 'claude.exe'), '');
  assert.equal(currentClaude(found, { PATH: onPath }), found, 'not swapped for another the search would find');
});

test('a found path that has gone away gives way to a fresh search', () => {
  const onPath = tmp();
  const real = path.join(onPath, 'claude.exe');
  fs.writeFileSync(real, '');
  assert.equal(currentClaude('Z:\\removed\\claude.exe', { PATH: onPath }), real);
  assert.equal(currentClaude(null, { PATH: onPath }), real, 'nothing found yet: the search runs');
  assert.equal(currentClaude('Z:\\removed\\claude.exe', { PATH: tmp() }), null, 'and says so when there is none');
});
