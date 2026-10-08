// The themed confirmation windows (src/main/confirm.js): an answer counts only
// from that question's own window and only once, a bad answer is Cancel, and a
// pile of questions past the limit is answered Cancel without being shown.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, FakeBrowserWindow } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
const confirm = require('../src/main/confirm');

const SPEC = { title: 'Sure?', message: 'Really?', buttons: [{ label: 'Yes', style: 'danger' }, { label: 'Maybe' }, { label: 'Cancel' }] };

const tick = () => new Promise(r => setImmediate(r));
async function openedAfter(count) {
  for (let i = 0; i < 50; i++) {
    if (FakeBrowserWindow.all.length > count) return FakeBrowserWindow.all[count];
    await tick();
  }
  throw new Error('no confirmation window opened');
}
const respond = (sender, index) => electron.ipcMain.emit('dialog:respond', { sender }, index);
const resize = (sender, height) => electron.ipcMain.emit('dialog:resize', { sender }, height);

test('ask resolves with the button its own window chose, then closes the window', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, SPEC);
  const win = await openedAfter(count);

  respond(win.webContents, 0);

  assert.equal(await answer, 0);
  assert.equal(win.destroyed, true);
});

test('the window is sandboxed, isolated, and refuses new windows and navigation', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, SPEC);
  const win = await openedAfter(count);
  const prefs = win.opts.webPreferences;

  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.match(prefs.preload, /dialog-preload\.js$/);
  assert.deepEqual(win.webContents.openHandler(), { action: 'deny' });
  let prevented = false;
  win.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);

  respond(win.webContents, 2);
  await answer;
});

test('once loaded, the window is sent the question with its cancel button filled in', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, SPEC);
  const win = await openedAfter(count);
  await tick();

  assert.deepEqual(win.webContents.sent, [{ channel: 'dialog:show', payload: { ...SPEC, cancelId: 2 } }]);

  respond(win.webContents, 1);
  assert.equal(await answer, 1);
});

test('an answer from any other window is ignored', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, SPEC);
  const win = await openedAfter(count);

  respond({ id: 1 }, 0); // the panel
  respond({ id: win.webContents.id + 1000 }, 0);
  await tick();
  assert.equal(win.destroyed, false, 'still waiting');

  respond(win.webContents, 1);
  assert.equal(await answer, 1);
});

test('a non-integer answer is ignored, and an out-of-range one is Cancel', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, SPEC);
  const win = await openedAfter(count);

  for (const bad of ['0', 0.5, null, { index: 0 }, NaN]) respond(win.webContents, bad);
  await tick();
  assert.equal(win.destroyed, false, 'none of those answered');

  respond(win.webContents, 99);
  assert.equal(await answer, 2);
});

test('only the first answer counts', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, { ...SPEC, cancelId: 1 });
  const win = await openedAfter(count);

  respond(win.webContents, 0);
  respond(win.webContents, 1);

  assert.equal(await answer, 0);
});

test('closing the window is Cancel', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, { ...SPEC, cancelId: 1 });
  const win = await openedAfter(count);

  win.close();

  assert.equal(await answer, 1);
});

test('questions are shown one at a time, and past three waiting the rest are Cancel unseen', async () => {
  const count = FakeBrowserWindow.all.length;
  const answers = [1, 2, 3, 4].map(() => confirm.ask(null, SPEC));

  assert.equal(await answers[3], 2, 'the fourth is answered Cancel straight away');
  const first = await openedAfter(count);
  await tick();
  assert.equal(FakeBrowserWindow.all.length, count + 1, 'only the first is showing');

  respond(first.webContents, 0);
  const second = await openedAfter(count + 1);
  respond(second.webContents, 1);
  const third = await openedAfter(count + 2);
  respond(third.webContents, 0);

  assert.deepEqual(await Promise.all(answers.slice(0, 3)), [0, 1, 0]);
});

test('dialog:resize keeps the height between 160 and 760 and shows the window', async () => {
  const count = FakeBrowserWindow.all.length;
  const answer = confirm.ask(null, SPEC);
  const win = await openedAfter(count);

  resize(win.webContents, 5000);
  assert.equal(win.getBounds().height, 760);
  assert.equal(win.isVisible(), true);
  resize(win.webContents, 10);
  assert.equal(win.getBounds().height, 160);
  resize(win.webContents, 'tall');
  resize({ id: 1 }, 300);
  assert.equal(win.getBounds().height, 160, 'a bad height, or one from another window, changes nothing');

  respond(win.webContents, 2);
  await answer;
});

test('a window whose page never reports its size is shown after 1.5 seconds anyway', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const count = FakeBrowserWindow.all.length;
    const answer = confirm.ask(null, SPEC);
    const win = await openedAfter(count);
    assert.equal(win.isVisible(), false);

    mock.timers.tick(1499);
    assert.equal(win.isVisible(), false);
    mock.timers.tick(1);
    assert.equal(win.isVisible(), true);

    respond(win.webContents, 2);
    await answer;
  } finally { mock.timers.reset(); }
});
