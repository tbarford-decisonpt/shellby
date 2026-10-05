const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { manifest, render, setupHash } = require('../scripts/scoop-manifest');

const HASH = '013a1a3203cd39fec30a813ac1810bed2a9b6f8e76f5e3b1e8c67ea3b1f6858d';
const SUMS = [
  `${HASH.toUpperCase()}  Shellby-Setup-0.66.0.exe`,
  '0ed58395fa6c365441b5731c0334af1f389d5c0d8f3278239fb2e7aa76617401 *Shellby-Portable-0.66.0.exe',
  '',
].join('\r\n');

test('picks the setup exe out of the checksums, lowercased, whatever the line endings', () => {
  assert.equal(setupHash(SUMS, '0.66.0'), HASH);
});

test('a release without its setup exe in the checksums is an error, not a bad manifest', () => {
  assert.throws(() => setupHash(SUMS, '0.67.0'), /No SHA-256 for Shellby-Setup-0\.67\.0\.exe/);
  assert.throws(() => setupHash('', '0.66.0'), /No SHA-256/);
});

test('the manifest points at this release and unpacks the app out of the installer', () => {
  const m = manifest({ version: '0.66.0', hash: HASH });
  assert.equal(m.version, '0.66.0');
  assert.equal(m.architecture['64bit'].url,
    'https://github.com/x-salmon/shellby/releases/download/v0.66.0/Shellby-Setup-0.66.0.exe#/dl.7z');
  assert.equal(m.architecture['64bit'].hash, HASH);
  assert.match(m.installer.script[0], /Expand-7zipArchive "\$dir\\`\$PLUGINSDIR\\app-64\.7z" "\$dir"/);
  assert.deepEqual(m.shortcuts, [['Shellby.exe', 'Shellby']]);
});

test("autoupdate leaves $version for Scoop's tooling to fill in", () => {
  const { url, hash } = manifest({ version: '0.66.0', hash: HASH }).autoupdate.architecture['64bit'];
  assert.equal(url, 'https://github.com/x-salmon/shellby/releases/download/v$version/Shellby-Setup-$version.exe#/dl.7z');
  assert.equal(hash.url, '$baseurl/SHA256SUMS.txt');
  // Scoop swaps $sha256 for a 64-hex group and $version for the new version.
  const re = new RegExp(hash.regex.replace('$sha256', '([0-9a-f]{64})').replace('$version', '0\\.66\\.0'), 'i');
  assert.equal(re.exec(SUMS)[1], HASH.toUpperCase());
});

test('versions compare by number, so a re-run of an old release never wins', () => {
  const { olderThan } = require('../scripts/scoop-manifest');
  assert.equal(olderThan('0.65.2', '0.66.0'), true);
  assert.equal(olderThan('0.9.0', '0.10.0'), true);
  assert.equal(olderThan('0.66.0', '0.66.0'), false);
  assert.equal(olderThan('1.0.0', '0.66.0'), false);
});

test('refuses a version or hash that would publish a broken manifest', () => {
  assert.throws(() => manifest({ version: 'v0.66.0', hash: HASH }), /Not a version/);
  assert.throws(() => manifest({ version: '0.66.0', hash: HASH.toUpperCase() }), /Not a SHA-256/);
  assert.throws(() => manifest({ version: '0.66.0', hash: '' }), /Not a SHA-256/);
});

test('the committed bucket/shellby.json is exactly what the script writes for its version', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'bucket', 'shellby.json'), 'utf8');
  const committed = JSON.parse(file);
  assert.equal(file, render(manifest({ version: committed.version, hash: committed.architecture['64bit'].hash })));
});
