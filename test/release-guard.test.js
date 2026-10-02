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
