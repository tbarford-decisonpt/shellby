// Which GitHub repository a git remote is (src/main/projects/remote.js): every
// shape git writes for github.com, and nothing that isn't github.com.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { githubRepoOf, checkRepo, cloneUrl } = require('../src/main/projects/remote');

test('https, ssh and scp-style GitHub remotes, with or without .git', () => {
  for (const url of [
    'https://github.com/x-salmon/shellby',
    'https://github.com/x-salmon/shellby.git',
    'https://github.com/x-salmon/shellby/',
    'git@github.com:x-salmon/shellby.git',
    'git@github.com:x-salmon/shellby',
    'ssh://git@github.com/x-salmon/shellby.git',
    'ssh://git@github.com:22/x-salmon/shellby',
    'HTTPS://GITHUB.COM/x-salmon/shellby.git',
    '  https://github.com/x-salmon/shellby.git\n',
  ]) assert.equal(githubRepoOf(url), 'x-salmon/shellby', url);
});

test('names with dots, dashes and underscores survive', () => {
  assert.equal(githubRepoOf('https://github.com/some-org/my.site_v2.git'), 'some-org/my.site_v2');
  assert.equal(githubRepoOf('git@github.com:a/b.c.git'), 'a/b.c');
});

test('anything that is not github.com is not GitHub', () => {
  for (const url of [
    'https://gitlab.com/x/y.git',
    'https://github.com.evil.example/x/y',
    'https://evil.example/github.com/x/y',
    'https://token@github.com/x/y.git',
    'C:\\code\\repo',
    '../other',
    'https://github.com/x',
    'https://github.com/x/y/z',
    'https://github.com/x/y?tab=readme',
    '', null, undefined, 42,
  ]) assert.equal(githubRepoOf(url), null, String(url));
});

test('owner and name follow GitHub grammar', () => {
  assert.equal(checkRepo('a/b'), 'a/b');
  assert.equal(checkRepo('-a/b'), null);
  assert.equal(checkRepo('a/..'), null);
  assert.equal(checkRepo('a/.'), null);
  assert.equal(checkRepo('a/b c'), null);
  assert.equal(checkRepo('a/b;rm'), null);
  assert.equal(checkRepo(`${'a'.repeat(40)}/b`), null);
});

test('the clone URL is built here, from a checked name', () => {
  assert.equal(cloneUrl('x-salmon/shellby'), 'https://github.com/x-salmon/shellby.git');
  assert.equal(cloneUrl('x/--upload-pack=evil'), null);
  assert.equal(cloneUrl('../../etc'), null);
});
