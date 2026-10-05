// What clash warnings say (src/renderer/panel/clash-text.js): the line on a
// tab, the toast, and the prompt "Ask him to look" leaves in the box.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/renderer/panel/clash-text');

const m = (tabId, branch, title = tabId) => ({ tabId, title, branch });
const yours = { checkout: true, tabId: null, title: 'your checkout', branch: 'main' };
const clash = (copies, files = ['src/main/merge.js'], o = {}) => ({ key: 'k', root: 'C:\\code\\shop', base: 'main', files, more: 0, copies, ...o });

const pair = clash([m('t1', 'shellby/fix-login-1a2b3c', 'fix-login'), m('t2', 'shellby/new-nav-4d5e6f', 'new-nav')]);

test('shortBranch drops Shellby\'s prefix and suffix', () => {
  assert.equal(T.shortBranch('shellby/fix-login-1a2b3c'), 'fix-login');
  assert.equal(T.shortBranch('feature/x'), 'feature/x');
});

test('fileList reads naturally for one, two, and many files', () => {
  assert.equal(T.fileList(['a.js']), 'a.js');
  assert.equal(T.fileList(['a.js', 'b.js']), 'a.js and b.js');
  assert.equal(T.fileList(['a', 'b', 'c']), 'a, b and c');
  assert.equal(T.fileList(['a', 'b', 'c', 'd'], 2), 'a, b, c and 3 more');
});

test('forTab returns only the clashes a tab is in, with the others', () => {
  const r = T.forTab([pair, clash([m('x', 'b1'), m('y', 'b2')])], 't1');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].others.map(o => o.tabId), ['t2']);
  assert.deepEqual(T.forTab([pair], 'nope'), []);
  assert.deepEqual(T.forTab([pair], null), []);
});

test('line names the other copy by branch and the files', () => {
  assert.equal(T.line([pair], 't1'), 'Also changed in ⑂ new-nav: src/main/merge.js');
  assert.equal(T.line([pair], 'other'), '');
});

test('line names your checkout when that is the clash', () => {
  assert.equal(T.line([clash([m('t1', 'shellby/a-1a2b3c'), yours], ['x.js'])], 't1'), 'Also changed in your checkout: x.js');
});

test('toast names both tabs and says bringing them home will clash', () => {
  assert.equal(T.toast(pair), 'Tab ‘fix-login’ and ‘new-nav’ both changed src/main/merge.js. Bringing both home will clash.');
});

test('toast uses the name a tab has now', () => {
  assert.match(T.toast(pair, id => (id === 't2' ? 'Renamed' : null)), /‘fix-login’ and ‘Renamed’/);
});

test('toast for three tabs and for your checkout', () => {
  const three = clash([m('a', 'shellby/a-1a2b3c'), m('b', 'shellby/b-1a2b3c'), m('c', 'shellby/c-1a2b3c')], ['x.js']);
  assert.equal(T.toast(three), 'Tabs ‘a’, ‘b’ and ‘c’ all changed x.js. Bringing them all home will clash.');
  const mine = clash([m('a', 'shellby/a-1a2b3c'), yours], ['x.js']);
  assert.equal(T.toast(mine), 'Tab ‘a’ changed x.js, and so has your checkout (not committed). Bringing it home will clash.');
});

test('prompt names the other branch, the files, and how to see its changes', () => {
  const p = T.prompt([pair], 't1');
  assert.match(p, /^Another copy \(branch shellby\/new-nav-4d5e6f\) also changed src\/main\/merge\.js\./);
  assert.match(p, /git diff main\.\.\.shellby\/new-nav-4d5e6f/);
  assert.match(p, /Check whether our changes overlap and how to avoid a merge clash/);
  assert.equal(T.prompt([pair], 'other'), '');
});

test('prompt mentions your checkout\'s uncommitted files', () => {
  const p = T.prompt([clash([m('a', 'shellby/a-1a2b3c'), yours], ['x.js'])], 'a');
  assert.match(p, /My own checkout has uncommitted changes to x\.js/);
  assert.doesNotMatch(p, /Another copy/);
});
