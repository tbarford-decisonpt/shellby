// A message into a conversation on another computer (remote/service.js): Claude
// Code runs there over ssh, so this PC needn't have it installed or signed in.
// One on this PC still needs it, and says so (wiring/timetrack.js sendToTab,
// ipc/tabs.js task:send).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, createFakeIpc, isStr } = require('./helpers/fake-ipc');

installFakeElectron();
const { wireTimetrack } = require('../src/main/wiring/timetrack');
const { registerTabsIpc } = require('../src/main/ipc/tabs');

const AWAY = 'C:\\Users\\me\\remote\\box\\code';
const HERE = 'C:\\code\\app';

function setup({ cwd, installed = false, loggedIn = false }) {
  const tabs = new Map();
  const sent = [];
  const d = {
    claudeStatus: { installed, loggedIn },
    remoteService: { placeOf: c => (c === AWAY ? { host: 'box', dir: '~/code', anchor: AWAY } : null) },
    currentCwd: () => cwd,
    isStr,
    PANEL_MAX_TEXT: 10000,
    manager: {
      tabs,
      send: (tabId, prompt) => { sent.push({ tabId, prompt }); return 'turn-1'; },
    },
    rememberPrompt: () => {},
    wake: () => {},
  };
  d.openTab = ({ tabId = 'tab-1' } = {}) => {
    const tab = { id: tabId, session: { cwd: d.currentCwd() }, shellRuns: [] };
    tabs.set(tabId, tab);
    return tab;
  };
  Object.assign(d, { sendToTab: wireTimetrack(d).sendToTab });
  const ipc = createFakeIpc();
  registerTabsIpc(ipc.ipcMain, d);
  return { d, ipc, sent };
}

test('a conversation on another computer sends without Claude Code on this PC', async () => {
  const { ipc, sent } = setup({ cwd: AWAY });
  const r = await ipc.invoke('task:send', { text: 'hello there' });
  assert.equal(r.ok, true, r.error);
  assert.equal(sent.length, 1);
});

test('a conversation on this PC still needs Claude Code here', async () => {
  const { ipc, sent } = setup({ cwd: HERE });
  const r = await ipc.invoke('task:send', { text: 'hello there' });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
});

test('an open conversation on this PC says Claude Code is missing', () => {
  const { d, sent } = setup({ cwd: HERE });
  d.openTab({ tabId: 't' });
  const r = d.sendToTab('t', 'hi', []);
  assert.equal(r.action, 'setup');
  assert.equal(sent.length, 0);
});
