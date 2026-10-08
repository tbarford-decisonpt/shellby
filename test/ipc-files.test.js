// Ctrl+= / Ctrl+- (ipc/files.js): the window that asked is the one a step is
// taken from, and the panel and every popped-out conversation end up at it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, fakeConfig } = require('./helpers/fake-ipc');

installFakeElectron();
const { guardIpc, windowPolicy } = require('../src/main/ipc-guard');
const { registerFilesIpc } = require('../src/main/ipc/files');

const zoomable = (id, at = 1) => ({ id, at, getZoomFactor() { return this.at; }, setZoomFactor(z) { this.at = z; } });

function setup({ withPopouts = true } = {}) {
  const panel = { webContents: zoomable(1), isDestroyed: () => false };
  const popout = { webContents: zoomable(2), isDestroyed: () => false };
  const handlers = new Map();
  const raw = { handle: (c, fn) => handlers.set(c, fn), on: () => {} };
  const ipcMain = guardIpc(raw, windowPolicy(() => ({ panel: panel.webContents, isPopout: wc => wc === popout.webContents })));
  const config = fakeConfig();
  registerFilesIpc(ipcMain, {
    config, panel, isStr: s => typeof s === 'string', manager: { tabs: new Map() }, currentCwd: () => 'C:\\',
    ...(withPopouts ? { everyWindow: () => [panel, popout] } : {}),
  });
  const zoom = (sender, step) => handlers.get('panel:zoom')({ sender }, step);
  return { panel, popout, config, zoom };
}

test('zooming a popped-out conversation zooms it, not just the panel, and the panel follows', async () => {
  const { panel, popout, config, zoom } = setup();
  popout.webContents.at = 1.1; // opened before anything was saved, say
  assert.equal(await zoom(popout.webContents, 1), 1.25, 'a step from where the popout is');
  assert.equal(popout.webContents.at, 1.25);
  assert.equal(panel.webContents.at, 1.25, 'every window at the one saved zoom');
  assert.deepEqual(config.sets.at(-1), { panelZoom: 1.25 });
});

test('the panel zooming takes its popped-out conversations with it, and 0 puts them all back', async () => {
  const { panel, popout, zoom } = setup();
  assert.equal(await zoom(panel.webContents, -1), 0.9);
  assert.equal(popout.webContents.at, 0.9);
  assert.equal(await zoom(popout.webContents, 0), 1);
  assert.equal(panel.webContents.at, 1);
});

test('before popouts are wired, the sender alone is zoomed and nothing throws', async () => {
  const { panel, zoom } = setup({ withPopouts: false });
  assert.equal(await zoom(panel.webContents, 1), 1.1);
  assert.equal(panel.webContents.at, 1.1);
});
