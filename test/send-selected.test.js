// The file picked in All files goes to Claude as one line after what you typed, only when main
// finds it is a file inside the conversation's folder (ipc/tabs.js task:send, viewer.js
// selectedNote, wiring/timetrack.js sendToTab). The chat shows only what you typed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, isStr } = require('./helpers/fake-ipc');

installFakeElectron();
const { wireTimetrack } = require('../src/main/wiring/timetrack');
const { registerTabsIpc } = require('../src/main/ipc/tabs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-send-selected-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const tabs = new Map();
  const sent = [];
  const d = {
    claudeStatus: { installed: true, loggedIn: true },
    remoteService: { placeOf: () => null },
    currentCwd: () => dir,
    isStr,
    PANEL_MAX_TEXT: 10000,
    manager: { tabs, send: (tabId, prompt, item) => { sent.push({ tabId, prompt, item }); return 'turn-1'; } },
    rememberPrompt: () => {},
    wake: () => {},
  };
  d.openTab = ({ tabId = 'tab-1' } = {}) => {
    const tab = { id: tabId, session: { cwd: dir }, shellRuns: [] };
    tabs.set(tabId, tab);
    return tab;
  };
  Object.assign(d, { sendToTab: wireTimetrack(d).sendToTab });
  const ipc = createFakeIpc();
  registerTabsIpc(ipc.ipcMain, d);
  return { d, ipc, sent, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a picked file goes along as one line, after what you typed', async () => {
  const s = setup();
  try {
    s.d.openTab({ tabId: 't' });
    const r = await s.ipc.invoke('task:send', { tabId: 't', text: 'fix this', selected: 'a.txt' });
    assert.equal(r.ok, true, r.error);
    assert.equal(s.sent[0].prompt, 'fix this\n\n[Shellby: the user has the file "a.txt" selected in the file tree; "this" or "it" may mean it.]');
    assert.equal(s.sent[0].item.text, 'fix this', 'the chat shows what you typed');
  } finally { s.done(); }
});

test('nothing is added for a file outside the folder, or with nothing picked', async () => {
  const s = setup();
  try {
    s.d.openTab({ tabId: 't' });
    await s.ipc.invoke('task:send', { tabId: 't', text: 'one', selected: '../elsewhere.txt' });
    await s.ipc.invoke('task:send', { tabId: 't', text: 'two' });
    assert.deepEqual(s.sent.map(x => x.prompt), ['one', 'two']);
  } finally { s.done(); }
});

test('a /command goes as typed, pick or no pick', async () => {
  const s = setup();
  try {
    s.d.openTab({ tabId: 't' });
    await s.ipc.invoke('task:send', { tabId: 't', text: '/compact', selected: 'a.txt' });
    assert.equal(s.sent[0].prompt, '/compact');
    s.d.sendToTab('t', '/model opus', [], { note: '[Shellby: x]' });
    assert.equal(s.sent[1].prompt, '/model opus', 'sendToTab itself keeps a command bare');
  } finally { s.done(); }
});
