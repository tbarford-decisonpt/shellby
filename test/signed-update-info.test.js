// After SignPath signs the installer, latest.yml has to describe the signed
// file, or every existing install refuses the update as corrupt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updateLatestYml } = require('../scripts/signed-update-info');

const FILE = 'Shellby-Setup-0.54.1.exe';
const YML = `version: 0.54.1
files:
  - url: ${FILE}
    sha512: OLDHASH==
    size: 100
path: ${FILE}
sha512: OLDHASH==
releaseDate: '2026-10-03T12:00:00.000Z'
`;

test('replaces the hash and size in the files entry and at the top level', () => {
  const out = updateLatestYml(YML, FILE, { sha512: 'NEW/HASH+==', size: 123 });
  assert.equal(out, YML.replaceAll('OLDHASH==', 'NEW/HASH+==').replace('size: 100', 'size: 123'));
});

test('leaves other entries alone', () => {
  const yml = YML.replace('files:\n', 'files:\n  - url: Other.exe\n    sha512: KEEP==\n    size: 5\n');
  const out = updateLatestYml(yml, FILE, { sha512: 'NEW==', size: 1 });
  assert.match(out, /url: Other\.exe\n {4}sha512: KEEP==\n {4}size: 5/);
  assert.match(out, new RegExp(`url: ${FILE}\\n {4}sha512: NEW==\\n {4}size: 1`));
});

test('refuses a latest.yml that describes a different installer', () => {
  assert.throws(() => updateLatestYml(YML, 'Shellby-Setup-9.9.9.exe', { sha512: 'X', size: 1 }), /no files entry/);
});

test('refuses a latest.yml whose top level points elsewhere', () => {
  const yml = YML.replace(`path: ${FILE}`, 'path: Other.exe');
  assert.throws(() => updateLatestYml(yml, FILE, { sha512: 'X', size: 1 }), /top-level/);
});

test('refuses an empty file', () => {
  assert.throws(() => updateLatestYml('', FILE, { sha512: 'X', size: 1 }));
});
