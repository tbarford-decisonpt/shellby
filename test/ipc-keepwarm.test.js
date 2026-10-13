// Keep warm's channels (src/main/ipc/keepwarm.js): the button turns it on and
// off, the panel reads where it is, and before the service exists it answers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, createFakeIpc } = require('./helpers/fake-ipc');

installFakeElectron();
const { registerKeepWarmIpc } = require('../src/main/ipc/keepwarm');

test('the panel turns Keep warm on and off, and reads where it is', async () => {
  const asked = [];
  const ipc = createFakeIpc();
  registerKeepWarmIpc(ipc.ipcMain, { keepWarm: {
    set: on => { asked.push(on); return { ok: true, on, endsAt: null, tabs: [] }; },
    view: () => ({ on: false, endsAt: null, tabs: [] }),
  } });
  assert.deepEqual(await ipc.invoke('keepwarm:set', true), { ok: true, on: true, endsAt: null, tabs: [] });
  await ipc.invoke('keepwarm:set', 'anything truthy');
  await ipc.invoke('keepwarm:set', 0);
  assert.deepEqual(asked, [true, true, false]);
  assert.deepEqual(await ipc.invoke('keepwarm:get'), { on: false, endsAt: null, tabs: [] });
});

test('before the service is made, it answers rather than throws', async () => {
  const ipc = createFakeIpc();
  registerKeepWarmIpc(ipc.ipcMain, {});
  const r = await ipc.invoke('keepwarm:set', true);
  assert.equal(r.ok, false);
  assert.equal(r.on, false);
  assert.deepEqual(await ipc.invoke('keepwarm:get'), { on: false, endsAt: null, tabs: [] });
});
