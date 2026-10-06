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

test('byCopy lists each other copy once with every file it shares', () => {
  const a = m('t1', 'shellby/a-1a2b3c'), b = m('t2', 'shellby/b-1a2b3c'), c = m('t3', 'shellby/c-1a2b3c');
  const clashes = [clash([a, b], ['package.json']), clash([a, b, c], ['README.md']), clash([a, c], ['src/main.js', 'README.md'], { more: 2 })];
  const r = T.byCopy(clashes, 't1');
  assert.deepEqual(r.map(x => x.copy.tabId), ['t2', 't3']);
  assert.deepEqual(r[0].files, ['package.json', 'README.md']);
  assert.deepEqual(r[1].files, ['README.md', 'src/main.js']);
  assert.equal(r[1].more, 2);
  assert.equal(T.line(clashes, 't1'), 'Also changed in ⑂ b: package.json and README.md; ⑂ c: README.md, src/main.js and 2 more');
});

test('line names your checkout when that is the clash', () => {
  assert.equal(T.line([clash([m('t1', 'shellby/a-1a2b3c'), yours], ['x.js'])], 't1'), 'Also changed in your checkout: x.js');
});

test('toast heads with the file and names both tabs in the text', () => {
  assert.deepEqual(T.toast(pair), {
    title: 'Clash in src/main/merge.js',
    text: 'Tabs ‘fix-login’ and ‘new-nav’ both changed it. Bringing both home will clash.',
  });
});

test('toast uses the name a tab has now', () => {
  assert.match(T.toast(pair, id => (id === 't2' ? 'Renamed' : null)).text, /‘fix-login’ and ‘Renamed’/);
});

test('toast cuts long tab titles short', () => {
  const long = id => (id === 't1' ? 'Can we integrate this fully? 1. Helper crabs that build up a record' : null);
  assert.match(T.toast(pair, long).text, /^Tabs ‘Can we integrate this…’ and ‘new-nav’/);
});

test('toast says "them" when several files overlap', () => {
  const many = clash([m('a', 'shellby/a-1a2b3c'), m('b', 'shellby/b-1a2b3c')], ['x.js', 'y.js', 'z.js']);
  assert.deepEqual(T.toast(many), {
    title: 'Clash in x.js, y.js and 1 more',
    text: 'Tabs ‘a’ and ‘b’ both changed them. Bringing both home will clash.',
  });
});

test('toast for three tabs and for your checkout', () => {
  const three = clash([m('a', 'shellby/a-1a2b3c'), m('b', 'shellby/b-1a2b3c'), m('c', 'shellby/c-1a2b3c')], ['x.js']);
  assert.equal(T.toast(three).text, 'Tabs ‘a’, ‘b’ and ‘c’ all changed it. Bringing them all home will clash.');
  const mine = clash([m('a', 'shellby/a-1a2b3c'), yours], ['x.js']);
  assert.equal(T.toast(mine).text, 'Tab ‘a’ and your checkout (not committed) both changed it. Bringing it home will clash.');
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
