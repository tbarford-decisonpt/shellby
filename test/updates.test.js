const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Updates, trayLabel, installedBy, plainError, RETRY_AFTER, EVERY } = require('../src/main/updates');

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

const noTimers = { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} };
const make = (opts = {}) => {
  const updater = new FakeUpdater(opts.updater || {});
  const views = [];
  const logged = [];
  const u = new Updates({ updater, version: '0.18.0', prepare: opts.prepare, timers: opts.timers || noTimers, log: m => logged.push(m) });
  u.on('changed', v => views.push(v));
  return { u, updater, views, logged };
};

test('idle until started, and a dev run with no updater stays off', () => {
  const { u } = make();
  assert.equal(u.view().state, 'idle');
  const off = new Updates({ version: '0.18.0' });
  assert.deepEqual(off.view(), { state: 'off', version: null, percent: 0, error: null, checkedAt: null, current: '0.18.0', retryAt: null, busy: false });
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
  const { u, updater, views } = make();
  const ready = [];
  u.on('ready', v => ready.push(v.version));
  u.start();
  updater.emit('update-downloaded', { version: '0.19.0' });
  const before = views.length;
  await u.check();
  // electron-updater re-finds the cached file: available, progress, downloaded.
  updater.emit('checking-for-update');
  updater.emit('update-available', { version: '0.19.0' });
  updater.emit('download-progress', { percent: 100 });
  updater.emit('update-downloaded', { version: '0.19.0' });
  assert.deepEqual(ready, ['0.19.0'], 'one notification, not one per check');
  assert.equal(updater.checks, 2, 'the check still asks GitHub');
  assert.ok(views.slice(before).every(v => v.state === 'ready'), 'the install button never flickers away');
});

test('a release that lands after one is ready replaces it without a restart', async () => {
  const { u, updater } = make();
  const ready = [];
  u.on('ready', v => ready.push(v.version));
  u.start();
  updater.emit('update-downloaded', { version: '0.19.0' });
  await u.check();
  updater.emit('update-available', { version: '0.20.0' });
  assert.deepEqual([u.view().state, u.view().version], ['downloading', '0.20.0']);
  updater.emit('update-downloaded', { version: '0.20.0' });
  assert.deepEqual([u.view().state, u.view().version], ['ready', '0.20.0']);
  assert.deepEqual(ready, ['0.19.0', '0.20.0'], 'the newer one is announced too');
  assert.equal(trayLabel(u.view()), 'Update to 0.20.0 and restart');
});

test('a failed or empty re-check keeps the downloaded update installable', async () => {
  const { u, updater } = make();
  u.start();
  updater.emit('update-downloaded', { version: '0.19.0' });
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  updater.emit('update-not-available', { version: '0.18.0' });
  assert.deepEqual([u.view().state, u.view().version, u.view().error], ['ready', '0.19.0', null]);
  assert.equal(u.install(), true);
});

test('a failed check says so, and the next one clears it', async () => {
  const { u, updater, logged } = make();
  u.start();
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n  at Object.request'));
  assert.deepEqual([u.view().state, u.view().error], ['error', "Couldn't reach GitHub. Is this PC online?"]);
  assert.deepEqual(logged, ['net::ERR_INTERNET_DISCONNECTED'], 'the raw error goes to the log');
  assert.equal(trayLabel(u.view()), 'Check for updates', 'still pressable');

  const after = await u.check();
  assert.equal(after.state, 'checking', 'the error is gone while it retries');
  assert.equal(after.error, null);
});

test('a rejection with no error event still reaches the user', async () => {
  const { u, logged } = make({ updater: { fail: new Error('404 not found') } });
  const view = await u.check();
  assert.deepEqual([view.state, view.error], ['error', "Couldn't check for updates."]);
  assert.deepEqual(logged, ['404 not found']);
});

test('common errors come out in plain words', () => {
  assert.equal(plainError('getaddrinfo ENOTFOUND github.com'), "Couldn't reach GitHub. Is this PC online?");
  assert.equal(plainError('net::ERR_INTERNET_DISCONNECTED'), "Couldn't reach GitHub. Is this PC online?");
  assert.equal(plainError('HttpError: 403 Forbidden "rate limit exceeded"'), 'GitHub asked him to slow down for a bit.');
  assert.equal(plainError('HttpError: 429 Too Many Requests'), 'GitHub asked him to slow down for a bit.');
  assert.equal(plainError('net::ERR_CONTENT_LENGTH_MISMATCH'), "The download didn't finish.");
  assert.equal(plainError('socket hang up', { downloading: true }), "The download didn't finish.");
  assert.equal(plainError('net::ERR_NETWORK_CHANGED', { downloading: true }), 'The download stopped: this PC went offline.');
  assert.equal(plainError('something odd'), "Couldn't check for updates.");
});

test('a failed check is tried again at 10, 30 and 60 minutes, then every six hours', async () => {
  const waits = [];
  const pending = [];
  const timers = {
    setInterval: (fn, ms) => { waits.push(['every', ms]); return 1; }, clearInterval: () => {},
    setTimeout: (fn, ms) => { waits.push(['once', ms]); pending.push(fn); return pending.length; }, clearTimeout: () => {},
  };
  const { u } = make({ updater: { fail: new Error('net::ERR_INTERNET_DISCONNECTED') }, timers });
  u.start();
  await new Promise(r => setImmediate(r));
  assert.ok(u.view().retryAt > Date.now(), 'Settings can say when');
  for (let i = 0; i < 3; i++) { pending.shift()(); await new Promise(r => setImmediate(r)); }
  assert.deepEqual(waits, [['every', EVERY], ...RETRY_AFTER.map(ms => ['once', ms])]);
  assert.deepEqual(RETRY_AFTER, [10, 30, 60].map(m => m * 60 * 1000));
  assert.equal(pending.length, 0, 'after the third retry, only the six-hourly check is left');
  assert.equal(u.view().retryAt, null);
});

test('a check that works resets the retries', async () => {
  const waits = [];
  const timers = { ...noTimers, setTimeout: (fn, ms) => { waits.push(ms); return 1; } };
  const { u, updater } = make({ timers });
  u.start();
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  updater.emit('update-not-available', { version: '0.18.0' });
  assert.equal(u.view().state, 'current');
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.deepEqual(waits, [RETRY_AFTER[0], RETRY_AFTER[0]], 'back to the first, short wait');
});

test('pressing check twice only asks once', async () => {
  const { u, updater } = make();
  const first = u.check();
  await u.check();
  await first;
  assert.equal(updater.checks, 1);
});

test('a Scoop install is spotted by its path, under the default root or a custom one', () => {
  const p = String.raw;
  assert.equal(installedBy(p`C:\Users\a\scoop\apps\shellby\current\Shellby.exe`, {}), 'scoop');
  assert.equal(installedBy(p`C:\Users\a\scoop\apps\shellby\0.66.0\Shellby.exe`, {}), 'scoop');
  assert.equal(installedBy(p`D:\tools\apps\shellby\current\Shellby.exe`, { SCOOP: 'D:\\tools\\' }), 'scoop');
  assert.equal(installedBy(p`C:\ProgramData\scoop\apps\shellby\current\Shellby.exe`, { SCOOP_GLOBAL: p`C:\ProgramData\scoop` }), 'scoop');
  assert.equal(installedBy(p`D:\Tools\apps\Shellby\current\Shellby.exe`, { SCOOP: 'd:/tools/' }), 'scoop', 'forward slashes and case in the root');
  assert.equal(installedBy('C:/Users/a/scoop/apps/shellby/current/Shellby.exe', {}), 'scoop');
  assert.equal(installedBy(p`C:\Users\a\AppData\Local\Programs\Shellby\Shellby.exe`, {}), null, 'the NSIS install updates itself');
  assert.equal(installedBy(p`D:\tools2\apps\shellby\current\Shellby.exe`, { SCOOP: 'D:\\tools' }), null, 'a sibling folder with the same prefix');
  assert.equal(installedBy(p`D:\tools\apps\shellby\current\Shellby.exe`, {}), null, 'apps\\shellby alone is not enough');
  assert.equal(installedBy(undefined, {}), null);
});

test('under Scoop the app leaves updating to Scoop: no checks, no installs, nothing in the tray', async () => {
  const updater = new FakeUpdater();
  const u = new Updates({ updater, managedBy: 'scoop', version: '0.66.0', timers: noTimers }).start();
  assert.equal(u.view().state, 'scoop');
  assert.equal(u.view().busy, false);
  assert.equal((await u.check()).state, 'scoop');
  assert.equal(updater.checks, 0, 'never asks GitHub');
  assert.equal(u.install(), false);
  assert.equal(updater.installs.length, 0);
  assert.equal(trayLabel(u.view()), null);
});
