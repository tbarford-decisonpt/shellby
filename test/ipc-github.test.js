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

function signInSetup({ yes = true } = {}) {
  const ipc = createFakeIpc();
  const rec = recorder();
  const d = {
    isStr, panel: null,
    send: rec.fn('send'),
    askGitHubFeature: rec.fn('ask', async () => yes),
    github: { can: () => false, signIn: rec.fn('signIn', async () => ({ ok: true })), signOut: rec.fn('signOut'), view: () => ({ signedIn: false }) },
    friends: null,
    profileCard: { isUp: false, takeDown: async () => ({ ok: true }) },
  };
  registerGithubIpc(ipc.ipcMain, d);
  return { ipc, rec };
}

test('a first sign-in leaves out guarded features nobody agreed to', async () => {
  const { ipc, rec } = signInSetup();
  await ipc.invoke('github:sign-in', ['sync', 'claude', 'prBadge']);
  assert.deepEqual(rec.of('signIn')[0][0], ['sync']);
});

test('guarded features agreed to before signing in ride on the one sign-in', async () => {
  const { ipc, rec } = signInSetup();
  assert.equal((await ipc.invoke('github:want-feature', 'claude', true)).ok, true);
  assert.equal((await ipc.invoke('github:want-feature', 'workflows', true)).ok, true);
  await ipc.invoke('github:want-feature', 'prBadge', true);
  await ipc.invoke('github:sign-in', ['sync', 'claude', 'workflows', 'prBadge']);
  assert.deepEqual(rec.of('signIn')[0][0], ['sync', 'claude', 'workflows', 'prBadge']);
  assert.equal(rec.of('ask').length, 3);
});

test('workflows needs claude agreed first, and unticking claude drops it', async () => {
  const { ipc, rec } = signInSetup();
  assert.equal((await ipc.invoke('github:want-feature', 'workflows', true)).ok, false);
  await ipc.invoke('github:want-feature', 'claude', true);
  await ipc.invoke('github:want-feature', 'workflows', true);
  await ipc.invoke('github:want-feature', 'claude', false);
  await ipc.invoke('github:sign-in', ['claude', 'workflows']);
  assert.deepEqual(rec.of('signIn')[0][0], []);
});

test('saying no to the question keeps the feature out of the sign-in', async () => {
  const { ipc, rec } = signInSetup({ yes: false });
  assert.equal((await ipc.invoke('github:want-feature', 'friends', true)).canceled, true);
  await ipc.invoke('github:sign-in', ['friends']);
  assert.deepEqual(rec.of('signIn')[0][0], []);
});

test('signing out forgets what was agreed', async () => {
  const { ipc, rec } = signInSetup();
  await ipc.invoke('github:want-feature', 'history', true);
  await ipc.invoke('github:sign-out');
  await ipc.invoke('github:sign-in', ['history']);
  assert.deepEqual(rec.of('signIn')[0][0], []);
});
