// Settings' side effects (wiring/settings.js): what the panel never sees, the
// hotkey swapped over, and a dev run left out of opening at login.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, recorder } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
const rec = recorder();
let refuse = null; // an accelerator register() throws on, as Electron does for a bad one
electron.globalShortcut = {
  register: rec.fn('register', accel => { if (accel === refuse) throw new Error('bad accelerator'); return true; }),
  unregister: rec.fn('unregister'),
};
electron.app.setLoginItemSettings = rec.fn('setLoginItemSettings');
const { wireSettings } = require('../src/main/wiring/settings');

function setup(data = {}, { sentry = null } = {}) {
  const warned = [];
  const d = {
    config: { data }, sentry, onHotkey: () => {},
    log: { warn: (...a) => warned.push(a) },
  };
  return { d, warned, ...wireSettings(d) };
}

test("the panel never sees the spend ledger, the phone's secret or the other bookkeeping", () => {
  const s = setup({
    hotkey: 'Ctrl+Shift+Space', spendLedger: [1], cacheDays: {}, setupWeights: {}, leanUsed: {}, pluginCosts: {},
    mcpSeen: {}, pluginEnabledAt: {}, turnCosts: [], phoneTasksSecret: 'shh',
  });
  const v = s.panelSettings();
  assert.equal(v.hotkey, 'Ctrl+Shift+Space');
  for (const k of ['spendLedger', 'cacheDays', 'setupWeights', 'leanUsed', 'pluginCosts', 'mcpSeen', 'pluginEnabledAt', 'turnCosts', 'phoneTasksSecret']) {
    assert.equal(k in v, false, k);
  }
  assert.equal(v.dockOrder, null, 'your own dock order, out of Work mode');
  assert.ok(Array.isArray(setup({ workMode: true }).panelSettings().dockOrder), "Work mode's, in it");
});

test('the crash reports row shows only in a build that can send them', () => {
  assert.equal(setup().panelSettings().crashReportsAvailable, false);
  assert.equal(setup({}, { sentry: {} }).panelSettings().crashReportsAvailable, true);
});

test('a new hotkey lets go of the old one first', () => {
  const s = setup();
  rec.calls.length = 0;
  assert.equal(s.applyHotkey('Ctrl+Alt+S', 'Ctrl+Shift+Space'), true);
  assert.deepEqual(rec.calls.map(c => [c.name, c.args[0]]), [['unregister', 'Ctrl+Shift+Space'], ['register', 'Ctrl+Alt+S']]);
  assert.equal(rec.calls[1].args[1], s.d.onHotkey);
});

test('no hotkey at all is fine, and one Electron refuses is a logged no', () => {
  const s = setup();
  assert.equal(s.applyHotkey('', 'Ctrl+Alt+S'), true);
  refuse = 'Nonsense+Q';
  assert.equal(s.applyHotkey('Nonsense+Q'), false);
  assert.equal(s.warned.length, 1);
  refuse = null;
});

test('a dev run never registers itself to open at login', () => {
  rec.calls.length = 0;
  setup().applyLoginItem(true);
  assert.equal(rec.of('setLoginItemSettings').length, 0);
});
