// ipc/github.js: signing out takes down what's public first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron, createFakeIpc, recorder, isStr } = require('./helpers/fake-ipc');

installFakeElectron();
const { registerGithubIpc } = require('../src/main/ipc/github');

function setup({ friendsOn = false, cardUp = false, downOk = true } = {}) {
  const ipc = createFakeIpc();
  const rec = recorder();
  const d = {
    isStr, panel: null,
    send: rec.fn('send'),
    github: { can: () => false, signOut: rec.fn('signOut'), view: () => ({ signedIn: false }) },
    friends: { enabled: friendsOn, isUp: cardUp, takeDown: rec.fn('friends.takeDown', async () => (downOk ? { ok: true } : { ok: false, error: 'offline' })) },
    profileCard: { isUp: false, takeDown: rec.fn('profileCard.takeDown', async () => ({ ok: true })) },
  };
  registerGithubIpc(ipc.ipcMain, d);
  return { ipc, rec };
}

test('sign-out takes down a calling card left up after Visiting crabs was turned off', async () => {
  const { ipc, rec } = setup({ cardUp: true });
  await ipc.invoke('github:sign-out');
  assert.equal(rec.of('friends.takeDown').length, 1);
  assert.equal(rec.of('signOut').length, 1);
});

test('sign-out leaves the friends alone when there is no card', async () => {
  const { ipc, rec } = setup();
  await ipc.invoke('github:sign-out');
  assert.equal(rec.of('friends.takeDown').length, 0);
});

test('sign-out says so when the card could not be taken down', async () => {
  const { ipc, rec } = setup({ friendsOn: true, downOk: false });
  await ipc.invoke('github:sign-out');
  assert.deepEqual(rec.of('send').map(c => c.slice(1)), [['github:error', 'offline']]);
});
