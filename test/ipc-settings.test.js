// Settings' IPC (src/main/ipc/settings.js): what the panel may change, what a
// bad value turns into, and the two things it can't do on its own (switch on
// Autonomous, or point Claude at a folder it names).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, fakeConfig, recorder, isStr, FakeBrowserWindow } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
const { registerSettingsIpc } = require('../src/main/ipc/settings');

function setup({ config: initial = {}, isolated = false, hotkeyOk = true, skins = [{ id: 'classic' }, { id: 'gold', locked: true }] } = {}) {
  const ipc = createFakeIpc();
  const config = fakeConfig({ hotkey: 'Ctrl+Shift+Space', colony: 2, ...initial });
  const rec = recorder();
  const critterBounds = { x: 100, y: 100, width: 64, height: 64 };
  const d = {
    config, isStr, ISOLATED: isolated,
    panel: null, critter: { getBounds: () => critterBounds, setBounds: rec.fn('critter.setBounds') },
    dialogLook: () => ({}),
    allSkins: () => skins,
    applyHotkey: rec.fn('applyHotkey', key => hotkeyOk || key === initial.hotkey || key === 'Ctrl+Shift+Space'),
    dictation: { warm: async () => ({ ok: true }), stop: rec.fn('dictation.stop') },
    refreshCritter: rec.fn('refreshCritter'),
    soundMix: () => ({ fx: true, voice: true }),
    send: rec.fn('send'),
    manager: { setMode: rec.fn('setMode'), setEffort: rec.fn('setEffort') },
    drainCrashQueue: rec.fn('drainCrashQueue'),
    sendOutlook: rec.fn('sendOutlook'),
    applyLoginItem: rec.fn('applyLoginItem'),
    broadcastSkin: rec.fn('broadcastSkin'),
    applyLayer: rec.fn('applyLayer'),
    critterBaseSize: () => ({ width: 96, height: 96 }),
    crewExtra: () => 0,
    showListening: rec.fn('showListening'),
    panelSettings: () => config.all(),
    currentCwd: () => os.tmpdir(),
    setFolder: rec.fn('setFolder', dir => ({ cwd: dir })),
  };
  registerSettingsIpc(ipc.ipcMain, d);
  return { ipc, config, d, rec };
}

// confirm.js's window for the newest question, once it's open.
async function nextDialog() {
  for (let i = 0; i < 50; i++) {
    const win = FakeBrowserWindow.all.at(-1);
    if (win && !win.destroyed) return win;
    await new Promise(r => setImmediate(r));
  }
  throw new Error('no confirmation window opened');
}
const answer = (win, index) => electron.ipcMain.emit('dialog:respond', { sender: win.webContents }, index);

test('settings:set keeps only known keys and saves good values', async () => {
  const { ipc, config, rec } = setup();

  const r = await ipc.invoke('settings:set', { mode: 'plan', effort: 'high', soundVolume: 60, chatter: 'chatty', evil: 'x', cwd: 'C:\\Windows' });

  assert.equal(config.get('mode'), 'plan');
  assert.equal(config.get('effort'), 'high');
  assert.equal(config.get('soundVolume'), 60);
  assert.equal(config.get('chatter'), 'chatty');
  assert.equal(config.get('evil'), undefined, 'unknown keys are dropped');
  assert.equal(config.get('cwd'), undefined, 'the folder is not a setting the panel can write');
  assert.deepEqual(rec.of('setMode'), [['plan']]);
  assert.deepEqual(rec.of('setEffort'), [['high']]);
  assert.equal(r.hotkeyError, null);
  assert.equal(r.pushToTalkError, null);
});

test('settings:set drops values that are not on their list', async () => {
  const { ipc, config } = setup();

  await ipc.invoke('settings:set', {
    mode: 'yolo', effort: 'ludicrous', model: 'gpt-4', soundVolume: 1000, chatter: 42,
    ambient: 'lava', spendReserve: 99, spendMaxMinutes: '15', crashReports: 'sometimes', perch: { on: true },
  });

  for (const k of ['mode', 'effort', 'model', 'soundVolume', 'chatter', 'ambient', 'spendReserve', 'spendMaxMinutes', 'crashReports', 'perch']) {
    assert.equal(config.get(k), undefined, k);
  }
});

test('settings:set coerces flags to booleans and clamps size and colony', async () => {
  const { ipc, config } = setup();

  await ipc.invoke('settings:set', { notifications: 'yes', wander: 0, critterScale: 7, colony: 999 });
  assert.equal(config.get('notifications'), true);
  assert.equal(config.get('wander'), false);
  assert.equal(config.get('critterScale'), 1, 'an unknown scale falls back to 1');
  assert.equal(config.get('colony'), 5, 'colony is capped at COLONY_MAX');

  await ipc.invoke('settings:set', { colony: 'lots' });
  assert.equal(config.get('colony'), 5, 'a non-integer keeps the colony it had');
});

test('settings:set refuses a locked or unknown skin', async () => {
  const { ipc, config } = setup();

  await ipc.invoke('settings:set', { skin: 'gold' });
  await ipc.invoke('settings:set', { skin: 'nope' });
  assert.equal(config.get('skin'), undefined);

  await ipc.invoke('settings:set', { skin: 'classic' });
  assert.equal(config.get('skin'), 'classic');
});

test('settings:set can only take apps off the perch ignore list, never add them', async () => {
  const { ipc, config } = setup({ config: { perchIgnore: ['a.exe', 'b.exe'] } });

  await ipc.invoke('settings:set', { perchIgnore: ['a.exe', 'evil.exe', 7] });
  assert.deepEqual(config.get('perchIgnore'), ['a.exe']);

  await ipc.invoke('settings:set', { perchIgnore: 'b.exe' });
  assert.deepEqual(config.get('perchIgnore'), ['a.exe'], 'a non-array keeps the list as it was');
});

test('settings:set reports a hotkey it could not register and keeps the old one', async () => {
  const { ipc, config, rec } = setup({ hotkeyOk: false });

  const r = await ipc.invoke('settings:set', { hotkey: 'Ctrl+Q' });

  assert.match(r.hotkeyError, /Couldn't register Ctrl\+Q/);
  assert.equal(config.get('hotkey'), 'Ctrl+Shift+Space');
  assert.deepEqual(rec.of('applyHotkey').at(-1), ['Ctrl+Shift+Space'], 'the previous hotkey is put back');
});

test('settings:set rejects a hotkey that is not a string without calling applyHotkey with it', async () => {
  const { ipc, config, rec } = setup();

  const r = await ipc.invoke('settings:set', { hotkey: { toString: () => 'Ctrl+Q' } });

  assert.match(r.hotkeyError, /Couldn't register/);
  assert.equal(config.get('hotkey'), 'Ctrl+Shift+Space');
  assert.ok(rec.of('applyHotkey').every(([k]) => typeof k === 'string'));
});

test('settings:set with no payload changes nothing and still answers', async () => {
  const { ipc, config } = setup();

  const r = await ipc.invoke('settings:set');

  assert.deepEqual(config.sets, [{}]);
  assert.equal(r.settings.hotkey, 'Ctrl+Shift+Space');
});

test('Autonomous: the panel asking is not enough; Cancel in the confirm window keeps it off', async () => {
  const { ipc, config, rec } = setup();

  const pending = ipc.invoke('settings:set', { autonomousAcknowledged: true, mode: 'autonomous' });
  const win = await nextDialog();
  // An answer from any other window (the panel, say) is ignored.
  electron.ipcMain.emit('dialog:respond', { sender: { id: 1 } }, 0);
  answer(win, 1);
  await pending;

  assert.equal(config.get('autonomousAcknowledged'), undefined);
  assert.equal(config.get('mode'), undefined);
  assert.deepEqual(rec.of('setMode'), []);
});

test('Autonomous: saying yes in the confirm window switches it on', async () => {
  const { ipc, config, rec } = setup();

  const pending = ipc.invoke('settings:set', { autonomousAcknowledged: true, mode: 'autonomous' });
  answer(await nextDialog(), 0);
  await pending;

  assert.equal(config.get('autonomousAcknowledged'), true);
  assert.equal(config.get('mode'), 'autonomous');
  assert.deepEqual(rec.of('setMode'), [['autonomous']]);
});

test('Autonomous: the mode alone, never acknowledged, is dropped without asking', async () => {
  const { ipc, config } = setup();
  const windowsBefore = FakeBrowserWindow.all.length;

  await ipc.invoke('settings:set', { mode: 'autonomous' });

  assert.equal(config.get('mode'), undefined);
  assert.equal(FakeBrowserWindow.all.length, windowsBefore, 'no question was shown');
});

test('settings:set is refused from any window but the panel', async () => {
  const { ipc, config } = setup();

  await assert.rejects(ipc.invokeAs(ipc.senders.critter, 'settings:set', { mode: 'plan' }), /Not allowed/);
  await assert.rejects(ipc.invokeAs(ipc.senders.stranger, 'settings:set', { mode: 'plan' }), /Not allowed/);
  assert.equal(config.get('mode'), undefined);
  assert.deepEqual(ipc.refused, ['settings:set'], 'written down once per channel');
});

test('folder:set only opens one of the recent folders, matched case-insensitively', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-folder-'));
  try {
    const { ipc, rec } = setup({ config: { recentFolders: [dir] } });

    assert.deepEqual(await ipc.invoke('folder:set', dir.toUpperCase()), { cwd: dir });
    assert.equal(await ipc.invoke('folder:set', os.homedir()), null, 'a folder not on the list');
    assert.equal(await ipc.invoke('folder:set', 42), null);
    assert.equal(await ipc.invoke('folder:set', ''), null);
    assert.equal(await ipc.invoke('folder:set', null), null);
    assert.deepEqual(rec.of('setFolder'), [[dir]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('folder:set skips a recent folder that no longer exists', async () => {
  const gone = path.join(os.tmpdir(), 'shellby-folder-gone-' + process.pid);
  const { ipc, rec } = setup({ config: { recentFolders: [gone] } });

  assert.equal(await ipc.invoke('folder:set', gone), null);
  assert.deepEqual(rec.of('setFolder'), []);
});

test('folder:set in an isolated dev run takes any local folder, but not a network share', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-folder-'));
  try {
    const { ipc } = setup({ isolated: true });

    assert.deepEqual(await ipc.invoke('folder:set', dir), { cwd: dir });
    assert.equal(await ipc.invoke('folder:set', '\\\\server\\share'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('folder:pick returns null when the dialog is cancelled', async () => {
  const { ipc } = setup();

  assert.equal(await ipc.invoke('folder:pick'), null);
  assert.equal(electron.callsOf('dialog.showOpenDialog').at(-1)[1].properties[0], 'openDirectory');
});
