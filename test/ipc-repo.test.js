// The repository's IPC (src/main/ipc/repo.js): a tab's copy is only acted on
// when it lives in Shellby's own worktree folder, a double click is one action,
// and a copy is never mistaken for your checkout.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, fakeConfig, recorder, isStr } = require('./helpers/fake-ipc');

installFakeElectron();
const { registerRepoIpc } = require('../src/main/ipc/repo');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-repo-ipc-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const worktreeHome = path.join(root, 'worktrees');
fs.mkdirSync(worktreeHome);

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function setup({ tabs = {}, busy = [], retire = async () => ({ ok: true }) } = {}) {
  const ipc = createFakeIpc();
  const rec = recorder();
  const d = {
    isStr, config: fakeConfig({ cwd: root }),
    manager: { tabs: new Map(Object.entries(tabs)), isBusy: id => busy.includes(id), note: rec.fn('note') },
    history: { list: () => [], setDone: rec.fn('setDone') },
    worktreeHome: () => worktreeHome,
    retireWorktree: rec.fn('retireWorktree', retire),
    log: { info: () => {}, warn: () => {} },
    turnEnds: new Map(), turnStarts: new Map(),
  };
  registerRepoIpc(ipc.ipcMain, d);
  return { ipc, rec };
}

const NO_COPY = 'That conversation has no copy of its own.';
const ours = { path: path.join(worktreeHome, 'abc123', 'proj'), root: path.join(root, 'proj'), branch: 'shellby/x-abc123', base: 'main' };
const theirs = { path: path.join(root, 'elsewhere', 'proj'), root: path.join(root, 'proj'), branch: 'feature', base: 'main' };

test('worktree:status refuses a tab id that is not a string or not open', async () => {
  const { ipc } = setup({ tabs: { a: { worktree: ours } } });

  for (const tabId of [undefined, null, 42, '', 'missing', { id: 'a' }]) {
    assert.deepEqual(await ipc.invoke('worktree:status', tabId), { ok: false, error: NO_COPY }, String(tabId));
  }
});

test('worktree:discard refuses a copy outside Shellby\'s worktree folder', async () => {
  const { ipc, rec } = setup({ tabs: { t: { worktree: theirs } } });

  assert.deepEqual(await ipc.invoke('worktree:discard', 't'), { ok: false, error: NO_COPY });
  assert.deepEqual(rec.of('retireWorktree'), []);
});

test('worktree:discard refuses a path that only starts with the folder\'s name', async () => {
  const sibling = { ...ours, path: `${worktreeHome}-evil${path.sep}proj` };
  const { ipc, rec } = setup({ tabs: { t: { worktree: sibling } } });

  assert.deepEqual(await ipc.invoke('worktree:discard', 't'), { ok: false, error: NO_COPY });
  assert.deepEqual(rec.of('retireWorktree'), []);
});

test('worktree:discard refuses a worktree record whose path is not a string', async () => {
  const { ipc } = setup({ tabs: { t: { worktree: { ...ours, path: [worktreeHome, 'x'] } } } });

  assert.deepEqual(await ipc.invoke('worktree:discard', 't'), { ok: false, error: NO_COPY });
});

test('worktree:discard throws away Shellby\'s own copy, and a double click is one discard', async () => {
  let release;
  const { ipc, rec } = setup({ tabs: { t: { worktree: ours } }, retire: () => new Promise(r => { release = r; }) });

  const first = ipc.invoke('worktree:discard', 't');
  const second = await ipc.invoke('worktree:discard', 't');
  await new Promise(r => setImmediate(r));
  release({ ok: true });

  assert.deepEqual(second, { ok: false, error: 'Already on it.' });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(rec.of('retireWorktree'), [['t', ours, { force: true }]]);
});

test('worktree:home waits while the tab is busy', async () => {
  const { ipc, rec } = setup({ tabs: { t: { worktree: ours } }, busy: ['t'] });

  assert.deepEqual(await ipc.invoke('worktree:home', 't'), { ok: false, error: 'Let him finish first.' });
  assert.deepEqual(rec.of('note'), []);
});

test('repo:status and repo:push say so when the folder is not a git repository', async () => {
  const plain = fs.mkdtempSync(path.join(root, 'plain-'));
  const { ipc } = setup({ tabs: { t: { session: { cwd: plain } } } });

  assert.deepEqual(await ipc.invoke('repo:status', 't'), { ok: false, error: 'Not a git repository.' });
  assert.deepEqual(await ipc.invoke('repo:push', 't'), { ok: false, error: 'Not a git repository.' });
  assert.deepEqual(await ipc.invoke('repo:home-all', 't'), { ok: false, error: 'Not a git repository.' });
});

test('repo:push never treats a repository inside the worktree folder as your checkout', async () => {
  const copy = gitRepo(path.join(worktreeHome, 'zzz999', 'proj'));
  const { ipc } = setup({ tabs: { t: { session: { cwd: copy } } } });

  assert.deepEqual(await ipc.invoke('repo:push', 't'), { ok: false, error: 'Not a git repository.' });
});

test('repo:status names the checkout of a real repository', async () => {
  const repo = gitRepo(path.join(root, 'proj'));
  const { ipc } = setup({ tabs: { t: { session: { cwd: repo } } } });

  const r = await ipc.invoke('repo:status', 't');

  assert.equal(r.name, 'proj');
  assert.equal(r.copies, 0);
  assert.equal(path.resolve(r.root).toLowerCase(), path.resolve(repo).toLowerCase());
});

test('repo channels are refused from the crab window', async () => {
  const { ipc, rec } = setup({ tabs: { t: { worktree: ours } } });

  await assert.rejects(ipc.invokeAs(ipc.senders.critter, 'worktree:discard', 't'), /Not allowed/);
  assert.deepEqual(rec.of('retireWorktree'), []);
});
