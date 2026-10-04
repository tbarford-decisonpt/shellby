// The release workflow's guard: a release only goes out as the version it says
// it is, from the commit its tag points at, with every file auto-update needs.
// Each case below is one way 0.21.1 went wrong, or could have.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../scripts/release-guard');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('the tag has to match package.json exactly', () => {
  assert.equal(g.checkTagMatchesVersion('v0.21.1', '0.21.1'), null);
  assert.match(g.checkTagMatchesVersion('v0.21.1', '0.21.0'), /doesn't match package\.json's version 0\.21\.0/);
  assert.ok(g.checkTagMatchesVersion('0.21.1', '0.21.1'), 'the v is required');
});

test('ls-remote output gives the commit, peeled for annotated tags', () => {
  assert.equal(g.commitFromLsRemote(`${SHA}\trefs/tags/v1.0.0\n`, 'v1.0.0'), SHA);
  assert.equal(g.commitFromLsRemote(`${OTHER}\trefs/tags/v1.0.0\n${SHA}\trefs/tags/v1.0.0^{}\n`, 'v1.0.0'), SHA, 'the tag object is not the commit');
  assert.equal(g.commitFromLsRemote('', 'v1.0.0'), null);
  assert.equal(g.commitFromLsRemote(`${SHA}\trefs/tags/v1.0.00\n`, 'v1.0.0'), null, 'a different tag with the same prefix');
});

test('a re-tagged run stands down', () => {
  assert.equal(g.checkTagStillHere(SHA, SHA, 'v1'), null);
  assert.match(g.checkTagStillHere(OTHER, SHA, 'v1'), /newer run owns this tag/);
  assert.match(g.checkTagStillHere(null, SHA, 'v1'), /no longer exists/);
});

test('an already-published release blocks the build instead of going out empty', () => {
  assert.equal(g.checkExistingRelease(null, 'v1'), null);
  assert.equal(g.checkExistingRelease({ isDraft: true }, 'v1'), null);
  assert.match(g.checkExistingRelease({ isDraft: false }, 'v1'), /already published.*delete the release/);
});

test('publishing needs the installer, portable, blockmap, latest.yml and checksums', () => {
  const all = g.requiredAssets('0.21.1');
  assert.equal(g.checkAssets(all, '0.21.1'), null);
  assert.match(g.checkAssets(['SHA256SUMS.txt'], '0.21.1'), /missing latest\.yml, Shellby-Setup-0\.21\.1\.exe/, 'exactly what 0.21.1 shipped with');
  assert.match(g.checkAssets(g.requiredAssets('0.21.0'), '0.21.1'), /missing/, "another version's files don't count");
  assert.match(g.checkAssets(undefined, '1.0.0'), /missing/);
});

test('latest.yml has to name this version and its installer', () => {
  const yml = v => `version: ${v}\nfiles:\n  - url: Shellby-Setup-${v}.exe\n    sha512: x\npath: Shellby-Setup-${v}.exe\n`;
  assert.equal(g.checkLatestYml(yml('0.21.1'), '0.21.1'), null);
  assert.equal(g.checkLatestYml("version: '0.21.1'\npath: Shellby-Setup-0.21.1.exe\n", '0.21.1'), null, 'quoted');
  assert.match(g.checkLatestYml(yml('0.21.0'), '0.21.1'), /says version 0\.21\.0/);
  assert.match(g.checkLatestYml('version: 0.21.1\npath: other.exe\n', '0.21.1'), /doesn't point at/);
  assert.match(g.checkLatestYml('', '0.21.1'), /\(none\)/);
});

// 0.63.0 and 0.64.0 were tagged on commits whose CI on main had already
// failed, and both releases failed the same e2e check after a full build.
const run = (sha, status, conclusion, created_at = '2026-10-04T06:00:00Z') => ({ head_sha: sha, status, conclusion, created_at, html_url: `https://ci/${created_at}` });

test('a tag waits for CI on its own commit to finish green', () => {
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'success')], SHA).state, 'green');
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'success')], SHA).problem, null);
  const red = g.checkCiRuns([run(SHA, 'completed', 'failure')], SHA);
  assert.equal(red.state, 'failed');
  assert.match(red.problem, /ended "failure" on aaaaaaa \(https:\/\/ci\/.*Fix main first/);
  assert.equal(g.checkCiRuns([run(SHA, 'in_progress', null)], SHA).state, 'running');
  assert.equal(g.checkCiRuns([run(SHA, 'queued', null)], SHA).state, 'running');
  assert.equal(g.checkCiRuns([], SHA).state, 'missing');
  assert.equal(g.checkCiRuns(undefined, SHA).state, 'missing');
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'cancelled')], SHA).state, 'failed', 'cancelled is not green');
});

test("another commit's green CI doesn't count", () => {
  assert.equal(g.checkCiRuns([run(OTHER, 'completed', 'success')], SHA).state, 'missing');
});

test('the newest run on the commit decides', () => {
  const older = '2026-10-04T06:00:00Z', newer = '2026-10-04T07:00:00Z';
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'failure', older), run(SHA, 'completed', 'success', newer)], SHA).state, 'green', 'a re-run that passed');
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'success', newer), run(SHA, 'completed', 'failure', older)], SHA).state, 'green', 'in any order');
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'success', older), run(SHA, 'completed', 'failure', newer)], SHA).state, 'failed', 'a newer red run');
});

test('the release commit has its own CHANGELOG heading', () => {
  assert.equal(g.checkChangelog('# Changelog\n\n## 0.64.2: 0.64.0, delivered\n', '0.64.2'), null);
  assert.equal(g.checkChangelog('## 0.64.2\n', '0.64.2'), null);
  assert.match(g.checkChangelog('## 0.64.1: x\n', '0.64.2'), /no "## 0\.64\.2" section/);
  assert.match(g.checkChangelog('## 0.64.20: x\n', '0.64.2'), /no "## 0\.64\.2"/, 'a longer version with the same prefix');
  assert.match(g.checkChangelog('', '1.0.0'), /no "## 1\.0\.0"/);
});

test('a tag already on GitHub is never reused', () => {
  assert.equal(g.checkTagFree(null, 'v1.0.0'), null);
  assert.match(g.checkTagFree(SHA, 'v1.0.0'), /already on GitHub \(at aaaaaaa\).*next patch/);
});

test("a cancelled run proved nothing: re-run it, but it's not the code's fault", () => {
  const c = g.checkCiRuns([run(SHA, 'completed', 'cancelled')], SHA);
  assert.equal(c.state, 'failed', 'still not ready to tag');
  assert.equal(c.conclusion, 'cancelled');
  assert.match(c.problem, /Re-run it/);
  assert.doesNotMatch(c.problem, /Fix main/);
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'timed_out')], SHA).conclusion, 'timed_out');
  assert.match(g.checkCiRuns([run(SHA, 'completed', 'timed_out')], SHA).problem, /Fix main first/);
  assert.equal(g.checkCiRuns([run(SHA, 'completed', 'success')], SHA).conclusion, 'success');
});
