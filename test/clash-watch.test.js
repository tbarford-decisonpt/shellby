// The clash watch (src/main/wiring/clashes.js): which copies it looks at, when
// it tells the panel, and which clashes count as news.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createClashWatch } = require('../src/main/wiring/clashes');

const HOME = path.resolve('/sb/worktrees');
const ROOT = path.resolve('/code/shop');
const wt = (suffix, o = {}) => ({ path: path.join(HOME, suffix, 'shop'), cwd: path.join(HOME, suffix, 'shop'), branch: `shellby/${suffix}-abc123`, base: 'main', root: ROOT, originalCwd: ROOT, ...o });

function harness({ files = {}, checkout = [], enabled = true } = {}) {
  const tabs = new Map();
  const pushes = [];
  const scanned = [];
  const state = { files, checkout, enabled };
  const watch = createClashWatch({
    tabs: () => tabs, home: () => HOME, enabled: () => state.enabled, push: v => pushes.push(v), debounceMs: 0,
    scan: {
      changedInCopy: async w => { scanned.push(w.branch); return state.files[w.branch] ?? null; },
      changedInCheckout: async () => ({ branch: 'main', files: state.checkout }),
    },
  });
  const flush = async () => { await new Promise(r => setTimeout(r, 5)); await watch.settled(); await new Promise(r => setTimeout(r, 5)); await watch.settled(); };
  const open = (id, w, title = id) => tabs.set(id, { title, worktree: w, session: { cwd: w?.cwd || ROOT } });
  return { tabs, pushes, scanned, state, watch, flush, open };
}

test('pushes a clash, marked fresh, when two copies changed the same file', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['src/merge.js'], 'shellby/two-abc123': ['src/merge.js', 'x.js'] } });
  h.open('t1', wt('one'), 'fix-login');
  h.open('t2', wt('two'), 'new-nav');
  h.watch.tabsChanged();
  await h.flush();
  assert.equal(h.pushes.length, 1);
  const [c] = h.pushes[0].clashes;
  assert.deepEqual(c.files, ['src/merge.js']);
  assert.deepEqual(c.copies.map(x => x.title), ['fix-login', 'new-nav']);
  assert.deepEqual(h.pushes[0].fresh, [c.key]);
});

test('does not push again when nothing changed', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['a.js'], 'shellby/two-abc123': ['a.js'] } });
  h.open('t1', wt('one'));
  h.open('t2', wt('two'));
  h.watch.refresh();
  await h.flush();
  h.watch.refresh(ROOT);
  await h.flush();
  assert.equal(h.pushes.length, 1);
});

test('more files on the same pair push the new list without calling it fresh', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['a.js'], 'shellby/two-abc123': ['a.js'] } });
  h.open('t1', wt('one'));
  h.open('t2', wt('two'));
  h.watch.refresh();
  await h.flush();
  h.state.files = { 'shellby/one-abc123': ['a.js', 'b.js'], 'shellby/two-abc123': ['a.js', 'b.js'] };
  h.watch.turnEnded(h.tabs.get('t1'));
  await h.flush();
  assert.equal(h.pushes.length, 2);
  assert.deepEqual(h.pushes[1].fresh, []);
  assert.deepEqual(h.pushes[1].clashes[0].files, ['a.js', 'b.js']);
});

test('a copy closing clears its clash', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['a.js'], 'shellby/two-abc123': ['a.js'] } });
  h.open('t1', wt('one'));
  h.open('t2', wt('two'));
  h.watch.tabsChanged();
  await h.flush();
  h.tabs.delete('t2');
  h.watch.tabsChanged();
  await h.flush();
  assert.deepEqual(h.pushes.at(-1).clashes, []);
});

test('flags your checkout\'s uncommitted changes under a copy', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['a.js'] }, checkout: ['a.js'] });
  h.open('t1', wt('one'));
  h.watch.refresh();
  await h.flush();
  const [c] = h.pushes[0].clashes;
  assert.ok(c.copies.some(x => x.checkout));
});

test('skips copies that are not in Shellby\'s folder or can\'t be read', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['a.js'], 'shellby/two-abc123': null, 'shellby/out-abc123': ['a.js'] } });
  h.open('t1', wt('one'));
  h.open('t2', wt('two'));
  h.open('t3', wt('out', { path: path.resolve('/elsewhere/shop') }));
  h.open('t4', null);
  h.watch.refresh();
  await h.flush();
  assert.deepEqual(h.pushes, []);
  assert.ok(!h.scanned.includes('shellby/out-abc123'));
});

test('turned off, it clears what it showed and looks at nothing', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['a.js'], 'shellby/two-abc123': ['a.js'] } });
  h.open('t1', wt('one'));
  h.open('t2', wt('two'));
  h.watch.refresh();
  await h.flush();
  h.state.enabled = false;
  h.scanned.length = 0;
  h.watch.refresh();
  await h.flush();
  assert.deepEqual(h.pushes.at(-1), { clashes: [], fresh: [] });
  assert.deepEqual(h.scanned, []);
});

test('a turn in your checkout looks again at the repository it is in', async () => {
  const h = harness({ files: { 'shellby/one-abc123': ['a.js'] }, checkout: [] });
  h.open('t1', wt('one'));
  h.watch.refresh();
  await h.flush();
  assert.equal(h.pushes.length, 0);
  h.state.checkout = ['a.js'];
  h.tabs.set('home', { title: 'home', worktree: null, session: { cwd: path.join(ROOT, 'src') } });
  h.watch.turnEnded(h.tabs.get('home'));
  await h.flush();
  assert.equal(h.pushes.length, 1);
});

test('the slow timer only looks at repositories with two copies or more', async () => {
  const h = harness({ files: { 'shellby/one-abc123': [] } });
  h.open('t1', wt('one'));
  h.watch.refresh();
  await h.flush();
  h.scanned.length = 0;
  h.watch.tick();
  await h.flush();
  assert.deepEqual(h.scanned, []);
  h.state.files['shellby/two-abc123'] = [];
  h.open('t2', wt('two'));
  h.watch.tick();
  await h.flush();
  assert.deepEqual(h.scanned.sort(), ['shellby/one-abc123', 'shellby/two-abc123']);
});
