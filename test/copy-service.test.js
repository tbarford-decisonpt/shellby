// copy-service.js: what a diff block from the renderer may point git at, and
// which tabs get the "make a copy first" hook.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { createCopies, NAME_THE_BRANCH } = require('../src/main/copy-service');

const ROOT = os.tmpdir(); // a folder that exists
const GONE = path.join(os.tmpdir(), 'shellby-copy-that-was-tidied-away');

function setup({ items = [], entry = null, data = { worktrees: true } } = {}) {
  const d = {
    config: { get: k => data[k] },
    manager: null,
    history: { load: () => items, get: () => entry },
    remote: null,
    CAPTURE: false,
    log: { info: () => {} },
    isStr: s => typeof s === 'string' && s.length > 0,
    worktreeHome: () => path.join(os.tmpdir(), 'shellby-worktrees'),
    claudeConfigDir: () => path.join(os.tmpdir(), '.claude'),
    routineTabs: new Map(), queueTabs: new Map(), queueWaits: new Map(), turnStarts: new Map(),
  };
  return createCopies(d);
}

const change = { kind: 'changes', root: ROOT, before: 'a1', after: 'b2', files: [{ path: 'src/x.js' }] };

test('a diff the tab reported is passed through', () => {
  const copies = setup({ items: [change] });

  const ref = copies.changeRef({ tabId: 't1', root: ROOT, before: 'a1', after: 'b2', file: 'src/x.js' });

  assert.deepEqual(ref, { tabId: 't1', root: ROOT, before: 'a1', after: 'b2', file: 'src/x.js' });
});

test('a diff the tab never reported, or a file outside it, is refused', () => {
  const copies = setup({ items: [change] });

  assert.equal(copies.changeRef({ tabId: 't1', root: ROOT, before: 'a1', after: 'zz' }), null);
  assert.equal(copies.changeRef({ tabId: 't1', root: ROOT, before: 'a1', after: 'b2', file: '../secrets' }), null);
  assert.equal(copies.changeRef({ root: ROOT, before: 'a1', after: 'b2' }), null);
});

test('a diff from a copy that has since gone reads from the repo it came from', () => {
  const copies = setup({
    items: [{ ...change, root: GONE }],
    entry: { copies: [{ path: GONE, root: ROOT }] },
  });

  const ref = copies.changeRef({ tabId: 't1', root: GONE, before: 'a1', after: 'b2' });

  assert.equal(ref.root, ROOT);
  assert.equal(ref.retired, true);
});

test('routine and workflow tabs, and tabs that opted out, get no copy hook', async () => {
  const copies = setup();
  for (const extra of [{ routineId: 'r1' }, { workflowRunId: 'w1' }, { noCopy: true }]) {
    const tab = { id: 't1', session: { cwd: ROOT, beforeWork: () => ({}) }, ...extra };

    await copies.armCopy(tab);

    assert.equal(tab.session.beforeWork, null);
  }
});

test('with copies turned off, no tab gets the hook', async () => {
  const copies = setup({ data: { worktrees: false } });
  const tab = { id: 't1', session: { cwd: ROOT, beforeWork: () => ({}) } };

  await copies.armCopy(tab);

  assert.equal(tab.session.beforeWork, null);
});

test('the branch-naming request asks for one "Branch:" line', () => {
  assert.match(NAME_THE_BRANCH, /"Branch: <name>"/);
});
