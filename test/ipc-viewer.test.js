// The file viewer's channels (ipc/viewer.js): a conversation on this PC or a
// worktree the Project page listed, never a path the panel makes up; and a
// nudge when something in an open folder may have changed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, isStr } = require('./helpers/fake-ipc');

installFakeElectron();
const fileIndex = require('../src/main/fileindex');
const { registerViewerIpc } = require('../src/main/ipc/viewer');

function setup() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-ipc-viewer-')));
  const repo = path.join(base, 'proj');
  fs.mkdirSync(repo);
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@example.com');
  g(repo, 'config', 'user.name', 'T');
  g(repo, 'config', 'core.autocrlf', 'false'); // a Windows git would check the worktree out as CRLF
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'init');
  const wt = path.join(base, 'wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
  const stranger = path.join(base, 'stranger');
  fs.mkdirSync(stranger);
  const remoteDir = path.join(base, 'remote-stand-in');
  fs.mkdirSync(remoteDir);
  const tabs = new Map([
    ['t1', { id: 't1', session: { cwd: wt }, worktree: { base: 'main' } }],
    ['t2', { id: 't2', session: { cwd: remoteDir } }],
  ]);
  const sent = [];
  const listeners = {};
  const ipc = createFakeIpc();
  const d = {
    isStr, manager: { tabs, on: (ev, fn) => { listeners[ev] = fn; } },
    remoteService: { placeOf: cwd => (cwd === remoteDir ? { host: 'box' } : null) },
    projects: { knowsRoot: r => (typeof r === 'string' && r.toLowerCase() === repo.toLowerCase() ? repo : null) },
    panel: { isDestroyed: () => false },
    send: (_win, channel, payload) => sent.push({ channel, payload }),
  };
  registerViewerIpc(ipc.ipcMain, d);
  return { base, repo, wt, stranger, ipc, sent, d, listeners, g, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("a conversation's folder opens, with its copy's base", async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    assert.equal(h.ok, true);
    assert.equal(h.branch, 'feat');
    assert.equal(h.base, 'main');
    const tree = await s.ipc.invoke('viewer:tree', h.id);
    assert.ok(tree.entries.includes('a.txt'));
    assert.equal((await s.ipc.invoke('viewer:read', h.id, 'a.txt')).text, 'one\n');
  } finally { s.done(); }
});

test('a closed conversation, a remote one, and nothing at all are refused', async () => {
  const s = setup();
  try {
    assert.equal((await s.ipc.invoke('viewer:open', { tabId: 'gone' })).ok, false);
    const remote = await s.ipc.invoke('viewer:open', { tabId: 't2' });
    assert.equal(remote.ok, false);
    assert.match(remote.error, /another computer/);
    assert.equal((await s.ipc.invoke('viewer:open', {})).ok, false);
    assert.equal((await s.ipc.invoke('viewer:open', null)).ok, false);
    assert.deepEqual(await s.ipc.invoke('viewer:locate', 't2', 'a.txt'), { inside: false });
    assert.deepEqual(await s.ipc.invoke('viewer:branch', 't2'), { branch: null });
  } finally { s.done(); }
});

test("a project's own worktrees open; any other folder is refused", async () => {
  const s = setup();
  try {
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo })).ok, true, 'the main checkout');
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: s.wt })).ok, true);
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: s.stranger })).ok, false);
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.stranger })).ok, false, 'not a project the page showed');
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: '\\\\attacker.example\\share' })).ok, false, 'never a network path');
  } finally { s.done(); }
});

test('a worktree record planted in the project cannot vouch for a folder of another repo', async () => {
  const s = setup();
  try {
    // git worktree list reports a locked record whatever its folder holds; the folder must point back to this repo.
    const planted = path.join(s.repo, '.git', 'worktrees', 'evil');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, 'gitdir'), `${path.join(s.stranger, '.git').split(path.sep).join('/')}\n`);
    fs.writeFileSync(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(planted, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(planted, 'locked'), '');
    assert.match(s.g(s.repo, 'worktree', 'list', '--porcelain'), /stranger/, 'git does list it');
    assert.equal((await s.ipc.invoke('viewer:open', { projectRoot: s.repo, worktreePath: s.stranger })).ok, false);
  } finally { s.done(); }
});

test("a closed conversation's handles go with it", async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    s.listeners.tabs([{ id: 't2' }]);
    assert.deepEqual(await s.ipc.invoke('viewer:changes', h.id), { ok: false, expired: true });
  } finally { s.done(); }
});

test('viewerWrites nudges after a writing tool, and the @-mention list is left alone', async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    const forgot = [];
    fileIndex.onForget(cwd => forgot.push(cwd));
    s.d.viewerWrites({ kind: 'tool', id: 'w1', name: 'Write' }, s.wt);
    s.d.viewerWrites({ kind: 'tool_result', id: 'w1' }, s.wt);
    assert.deepEqual(s.sent.at(-1), { channel: 'viewer:stale', payload: { ids: [h.id] } });
    assert.deepEqual(forgot, [], 'fileIndex.forget was not called');
  } finally { s.done(); }
});

test('only the panel may call them', async () => {
  const s = setup();
  try {
    await assert.rejects(() => s.ipc.invokeAs(s.ipc.senders.critter, 'viewer:open', { tabId: 't1' }));
    assert.ok(s.ipc.refused.includes('viewer:open'));
  } finally { s.done(); }
});

test('forgetting a folder nudges the viewers open on it, and only those', async () => {
  const s = setup();
  try {
    const h = await s.ipc.invoke('viewer:open', { tabId: 't1' });
    fileIndex.forget(s.wt);
    assert.deepEqual(s.sent.at(-1), { channel: 'viewer:stale', payload: { ids: [h.id] } });
    const before = s.sent.length;
    fileIndex.forget(s.stranger);
    assert.equal(s.sent.length, before);
    await s.ipc.invoke('viewer:close', h.id);
    fileIndex.forget(s.wt);
    assert.equal(s.sent.length, before);
  } finally { s.done(); }
});
