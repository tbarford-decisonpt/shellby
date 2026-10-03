// Local repos + GitHub repos -> one list of projects (src/main/projects/merge.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { merge, caseKey } = require('../src/main/projects/merge');

const root = (...p) => path.resolve('C:\\code', ...p);
const gh = (repo, extra = {}) => ({ repo, private: false, url: `https://github.com/${repo}`, description: '', pushedAt: 0, archived: false, fork: false, ...extra });

test('a clone and its GitHub repository are one project', () => {
  const list = merge([{ root: root('site'), name: 'site', remote: 'me/site', branch: 'main' }], [gh('me/site')]);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'github:me/site');
  assert.equal(list[0].github.repo, 'me/site');
  assert.deepEqual(list[0].local, [{ root: root('site'), branch: 'main', main: true }]);
});

test('two clones of one repository are one project, the one worked in last first', () => {
  const lastWorked = new Map([[caseKey(root('b', 'site')), 200], [caseKey(root('a', 'site')), 100]]);
  const [p] = merge([
    { root: root('a', 'site'), name: 'site', remote: 'me/site' },
    { root: root('b', 'site'), name: 'site', remote: 'Me/Site' },
  ], [], { lastWorked });
  assert.equal(p.local.length, 2);
  assert.equal(p.local[0].root, root('b', 'site'));
  assert.equal(p.local[0].main, true);
  assert.equal(p.local[1].main, false);
  assert.equal(p.lastWorkedAt, 200);
});

test('a repo with no GitHub remote is a project of its own, by folder', () => {
  const [p] = merge([{ root: root('thing'), name: 'thing', remote: null }], []);
  assert.equal(p.key, `local:${caseKey(root('thing'))}`);
  assert.equal(p.github, null);
});

test('a GitHub repo that is not on this PC is listed with no clones', () => {
  const [p] = merge([], [gh('me/elsewhere', { description: 'hi' })]);
  assert.deepEqual(p.local, []);
  assert.equal(p.name, 'elsewhere');
});

test('the same folder twice is listed once', () => {
  const list = merge([{ root: root('x'), name: 'x' }, { root: root('X'), name: 'x' }], []);
  assert.equal(list.length, process.platform === 'win32' ? 1 : 2);
});

test('hidden projects are left out', () => {
  const list = merge([{ root: root('x'), name: 'x', remote: 'me/x' }], [gh('me/y')], { hidden: new Set(['github:me/x']) });
  assert.deepEqual(list.map(p => p.key), ['github:me/y']);
});

test('order: worked on lately, then running, then on this PC, then last push, then name', () => {
  const lastWorked = new Map([[caseKey(root('recent')), 50]]);
  const running = new Set([caseKey(root('busy'))]);
  const list = merge([
    { root: root('plain'), name: 'plain' },
    { root: root('busy'), name: 'busy' },
    { root: root('recent'), name: 'recent' },
  ], [gh('me/pushed', { pushedAt: 9 }), gh('me/old', { pushedAt: 1 })], { lastWorked, running });
  assert.deepEqual(list.map(p => p.name), ['recent', 'busy', 'plain', 'pushed', 'old']);
  assert.equal(list[1].running, true);
});

test('garbage from either side is skipped', () => {
  const list = merge([null, { name: 'no root' }, { root: root('ok'), name: 'ok', remote: 'not a repo' }], [null, { repo: '../../x' }, gh('me/fine')]);
  assert.deepEqual(list.map(p => p.name).sort(), ['fine', 'ok']);
});
