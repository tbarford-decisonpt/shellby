const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Updates, trayLabel } = require('../src/main/updates');

// Stands in for electron-updater: emits what it's told to, records the rest.
class FakeUpdater extends EventEmitter {
  constructor({ fail = null } = {}) {
    super();
    this.checks = 0;
    this.installs = [];
    this.fail = fail;
  }
  async checkForUpdates() {
    this.checks++;
    if (this.fail) throw this.fail;
    return {};
  }
  quitAndInstall(...args) { this.installs.push(args); }
}

const noTimers = { setInterval: () => 1, clearInterval: () => {} };
const make = (opts = {}) => {
  const updater = new FakeUpdater(opts.updater || {});
  const views = [];
  const u = new Updates({ updater, version: '0.18.0', prepare: opts.prepare, timers: noTimers });
  u.on('changed', v => views.push(v));
  return { u, updater, views };
};

test('idle until started, and a dev run with no updater stays off', () => {
  const { u } = make();
  assert.equal(u.view().state, 'idle');
  const off = new Updates({ version: '0.18.0' });
  assert.deepEqual(off.view(), { state: 'off', version: null, percent: 0, error: null, checkedAt: null, current: '0.18.0', busy: false });
  assert.equal(off.install(), false, 'nothing to install');
  assert.equal(trayLabel(off.view()), null, 'and nothing in the tray');
});

test('a check that finds nothing ends up up to date', async () => {
  const { u, updater, views } = make();
  u.start();
  updater.emit('checking-for-update');
  updater.emit('update-not-available', { version: '0.18.0' });
  assert.equal(u.view().state, 'current');
  assert.equal(u.view().version, null);
  assert.ok(u.view().checkedAt, 'the "checked just now" timestamp is set');
  assert.deepEqual(views.map(v => v.state), ['checking', 'current']);
  assert.equal(trayLabel(u.view()), 'Check for updates');
});

test('an available update downloads, reports progress and becomes installable', () => {
  const prepared = [];
  const { u, updater, views } = make({ prepare: () => prepared.push('closed the tabs') });
  u.start();
  updater.emit('update-available', { version: '0.19.0' });
  assert.deepEqual([u.view().state, u.view().version, u.view().percent], ['downloading', '0.19.0', 0]);
  assert.equal(u.install(), false, 'not until it has landed');

  updater.emit('download-progress', { percent: 41.6 });
  assert.equal(u.view().percent, 42);
  assert.equal(trayLabel(u.view()), 'Downloading update… 42%');

  updater.emit('update-downloaded', { version: '0.19.0' });
  assert.deepEqual([u.view().state, u.view().percent, u.view().busy], ['ready', 100, false]);
  assert.equal(trayLabel(u.view()), 'Update to 0.19.0 and restart');

  assert.equal(u.install(), true);
  assert.deepEqual(prepared, ['closed the tabs'], 'tabs close before the installer takes over');
  assert.deepEqual(updater.installs, [[true, true]], 'silent install, then relaunch');
  assert.deepEqual(views.map(v => v.state), ['checking', 'downloading', 'downloading', 'ready']);
});

test('progress only wakes the panel when the rounded percent moves', () => {
  const { u, updater, views } = make();
  u.start();
  updater.emit('update-available', { version: '0.19.0' });
  for (const percent of [10, 10.2, 10.4, 11]) updater.emit('download-progress', { percent });
  assert.deepEqual(views.map(v => v.percent), [0, 0, 10, 11]);
});

test('a ready update is announced once, however often the check finds it again', async () => {
  const { u, updater } = make();
  const ready = [];
  u.on('ready', v => ready.push(v.version));
  u.start();
  updater.emit('update-downloaded', { version: '0.19.0' });
  await u.check();
  updater.emit('update-downloaded', { version: '0.19.0' });
  assert.deepEqual(ready, ['0.19.0'], 'one notification, not one per check');
  assert.equal(updater.checks, 1, 'and no pointless re-download once it is on disk');
});

test('a failed check says so, and the next one clears it', async () => {
  const { u, updater } = make();
  u.start();
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n  at Object.request'));
  assert.deepEqual([u.view().state, u.view().error], ['error', 'net::ERR_INTERNET_DISCONNECTED']);
  assert.equal(trayLabel(u.view()), 'Check for updates', 'still pressable');

  const after = await u.check();
  assert.equal(after.state, 'checking', 'the error is gone while it retries');
  assert.equal(after.error, null);
});

test('a rejection with no error event still reaches the user', async () => {
  const { u } = make({ updater: { fail: new Error('404 not found') } });
  const view = await u.check();
  assert.deepEqual([view.state, view.error], ['error', '404 not found']);
});

test('pressing check twice only asks once', async () => {
  const { u, updater } = make();
  const first = u.check();
  await u.check();
  await first;
  assert.equal(updater.checks, 1);
});
