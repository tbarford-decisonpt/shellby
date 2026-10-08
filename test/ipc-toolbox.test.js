// The Toolbox's IPC (src/main/ipc/toolbox.js): pins and snippets checked
// before they're saved, and files it only reads, writes or reveals when a
// scan of its own listed them, never a path the panel makes up.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, fakeConfig, recorder, isStr } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
const { registerToolboxIpc } = require('../src/main/ipc/toolbox');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-toolbox-ipc-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const memoryFile = path.join(home, '.claude', 'CLAUDE.md');
fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
fs.writeFileSync(memoryFile, '# Mine\n');
const skillFile = path.join(home, '.claude', 'skills', 'review', 'SKILL.md');

function setup({ snippets = [{ name: 'review', text: 'Review it' }], pinned = [] } = {}) {
  const ipc = createFakeIpc();
  const config = fakeConfig({ pinnedTools: pinned });
  const rec = recorder();
  let list = snippets;
  const d = {
    config, isStr, PANEL_MAX_TEXT: 1000,
    TRICKS_KIND: new Set(['skill', 'agent', 'command']),
    toolbox: { current: { skills: [{ name: 'review', path: skillFile }], agents: [], commands: [] }, rescan: rec.fn('rescan') },
    pinnedTools: () => config.get('pinnedTools'),
    snippetList: () => list,
    allSnippets: () => list,
    setSnippets: rec.fn('setSnippets', (next, renamed) => { list = next; return { snippets: next, renamed }; }),
    noteSnippetUse: rec.fn('noteSnippetUse'),
    expandSnippet: rec.fn('expandSnippet', (name, args) => ({ ok: true, text: `${name}:${args}` })),
    manager: { tabs: new Map() },
    currentCwd: () => home,
    setupWhere: () => ({ home, cwd: home }),
    setupView: () => ({ memory: [{ path: memoryFile, exists: true }], hooks: [], paused: [] }),
    stat: rec.fn('stat'),
    shopBlocked: () => null,
    shop: {
      list: rec.fn('shop.list', o => o),
      find: id => (id === 'good@market' ? { url: 'https://example.com/plugin' } : null),
    },
  };
  registerToolboxIpc(ipc.ipcMain, d);
  return { ipc, config, rec };
}

test('toolbox:pin pins a known kind and unpins it again', async () => {
  const { ipc, config } = setup();

  await ipc.invoke('toolbox:pin', { kind: 'skill', name: 'review', pinned: true });
  assert.deepEqual(config.get('pinnedTools'), [{ kind: 'skill', name: 'review' }]);

  await ipc.invoke('toolbox:pin', { kind: 'skill', name: 'review', pinned: false });
  assert.deepEqual(config.get('pinnedTools'), []);
});

test('toolbox:pin ignores unknown kinds, bad names and a snippet that does not exist', async () => {
  const { ipc, config } = setup();

  for (const req of [{ kind: 'shell', name: 'rm', pinned: true }, { kind: 'skill', name: 42, pinned: true },
    { kind: 'skill', name: '', pinned: true }, { kind: 'snippet', name: 'nope', pinned: true }]) {
    await ipc.invoke('toolbox:pin', req);
  }

  assert.deepEqual(config.sets, []);
});

test('toolbox:pin keeps the last 12 pins', async () => {
  const pinned = Array.from({ length: 12 }, (_, i) => ({ kind: 'skill', name: `s${i}` }));
  const { ipc, config } = setup({ pinned });

  await ipc.invoke('toolbox:pin', { kind: 'agent', name: 'newest', pinned: true });

  const after = config.get('pinnedTools');
  assert.equal(after.length, 12);
  assert.deepEqual(after.at(-1), { kind: 'agent', name: 'newest' });
  assert.equal(after[0].name, 's1');
});

test('handlers that take an object answer a null or string payload instead of throwing', async () => {
  const { ipc, rec } = setup();

  assert.deepEqual(await ipc.invoke('toolbox:pin', null), []);
  assert.equal((await ipc.invoke('snippets:save', null)).ok, false);
  assert.equal((await ipc.invoke('setup:write-memory', 'C:\\x.md')).ok, false);
  await ipc.invoke('shop:list', null);
  assert.deepEqual(rec.of('shop.list'), [[{ refresh: false }]]);
});

test('snippets:save saves a good snippet and refuses a bad one', async () => {
  const { ipc, rec } = setup();

  const ok = await ipc.invoke('snippets:save', { snippet: { name: 'Ship', text: 'Ship it' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'ship');

  for (const snippet of [{ name: 'has space', text: 'x' }, { name: 'empty', text: '   ' }, { name: 'review', text: 'dupe' }, 'ship', null]) {
    const r = await ipc.invoke('snippets:save', { snippet });
    assert.equal(r.ok, false, JSON.stringify(snippet));
    assert.equal(typeof r.error, 'string');
  }
  assert.equal(rec.of('setSnippets').length, 1);
});

test('snippets:save renaming one says what it was renamed from', async () => {
  const { ipc, rec } = setup();

  await ipc.invoke('snippets:save', { snippet: { name: 'check', text: 'Review it' }, was: 'review' });

  const [[list, renamed]] = rec.of('setSnippets');
  assert.deepEqual(list.map(s => s.name), ['check']);
  assert.deepEqual(renamed, { from: 'review', to: 'check' });
});

test('snippets:used only notes a string name', () => {
  const { ipc, rec } = setup();

  ipc.send('snippets:used', 'review');
  ipc.send('snippets:used', { name: 'review' });

  assert.deepEqual(rec.of('noteSnippetUse'), [['review']]);
});

test('snippets:expand expands /name args and passes anything else through as null', async () => {
  const { ipc, rec } = setup();

  assert.deepEqual(await ipc.invoke('snippets:expand', '/review the auth module'), { ok: true, text: 'review:the auth module' });
  assert.equal(await ipc.invoke('snippets:expand', 'just a message'), null);
  assert.equal(await ipc.invoke('snippets:expand', { text: '/review' }), null);
  assert.equal(rec.of('expandSnippet').length, 1);
});

test('toolbox:reveal shows only a file the toolbox scan reported', () => {
  const { ipc } = setup();
  const before = electron.callsOf('shell.showItemInFolder').length;

  ipc.send('toolbox:reveal', 'C:\\Windows\\System32\\cmd.exe');
  ipc.send('toolbox:reveal', skillFile.toUpperCase());
  ipc.send('toolbox:reveal', null);
  ipc.send('toolbox:reveal', skillFile);

  assert.deepEqual(electron.callsOf('shell.showItemInFolder').slice(before), [[skillFile]]);
});

test('setup:read-memory reads a memory file the scan lists, and nothing else', async () => {
  const { ipc } = setup();

  const mine = await ipc.invoke('setup:read-memory', memoryFile);
  assert.equal(mine.ok, true);
  assert.equal(mine.text, '# Mine\n');

  for (const p of [path.join(home, 'secrets.md'), path.join(home, '.claude', '..', '.ssh', 'id_rsa'), 'C:\\Windows\\win.ini', 7, null]) {
    assert.deepEqual(await ipc.invoke('setup:read-memory', p), { ok: false, error: "Shellby doesn't edit that file." }, String(p));
  }
});

test('setup:write-memory refuses unknown paths, non-string text and a missing mtime', async () => {
  const { ipc } = setup();
  const { mtimeMs } = fs.statSync(memoryFile);

  for (const req of [{ path: path.join(home, 'evil.md'), text: 'x', mtimeMs }, { path: memoryFile, text: 42, mtimeMs },
    { path: memoryFile, text: 'x' }, { path: memoryFile, text: 'x', mtimeMs: 'now' }]) {
    assert.equal((await ipc.invoke('setup:write-memory', req)).ok, false, JSON.stringify(req));
  }
  assert.equal(fs.readFileSync(memoryFile, 'utf8'), '# Mine\n');
});

test('setup:write-memory saves a listed file when the mtime matches', async () => {
  const { ipc, rec } = setup();
  const { mtimeMs } = fs.statSync(memoryFile);

  const r = await ipc.invoke('setup:write-memory', { path: memoryFile, text: '# Mine\nmore\n', mtimeMs });

  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(memoryFile, 'utf8'), '# Mine\nmore\n');
  assert.deepEqual(rec.of('stat'), [['memory-saved']]);
  assert.ok(r.setup, 'answers with the fresh setup view');
});

test('setup:sample-hook-input refuses an unknown hook event', async () => {
  const { ipc } = setup();

  assert.equal(await ipc.invoke('setup:sample-hook-input', { event: 'NotAnEvent' }), null);
  assert.equal(await ipc.invoke('setup:sample-hook-input', 'PreToolUse'), null);
});

test('shop:open only opens the link the CLI reported for a listed plugin', () => {
  const { ipc } = setup();
  const before = electron.callsOf('shell.openExternal').length;

  ipc.send('shop:open', 'evil@market');
  ipc.send('shop:open', 'https://evil.example');
  ipc.send('shop:open', 'good@market');

  assert.deepEqual(electron.callsOf('shell.openExternal').slice(before), [['https://example.com/plugin']]);
});

test('toolbox channels are refused from the crab window', async () => {
  const { ipc } = setup();

  await assert.rejects(ipc.invokeAs(ipc.senders.critter, 'setup:read-memory', memoryFile), /Not allowed/);
});
