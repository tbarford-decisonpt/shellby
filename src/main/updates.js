// Shellby's self-update. electron-updater does the fetching; this is the one
// small state machine the panel renders and the tray menu reads, so a new
// version is a button you press rather than something you discover by quitting
// twice. No Electron imports: main.js passes the updater in, which also lets
// test/updates.test.js drive it with a fake.

const { EventEmitter } = require('events');

const EVERY = 6 * 60 * 60 * 1000;

const clampPercent = n => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);
const versionOf = info => (info && typeof info.version === 'string' ? info.version.slice(0, 40) : null);
// electron-updater errors carry a stack and sometimes a whole HTTP response.
const messageOf = e => String((e && e.message) || e || 'Update check failed').split('\n')[0].slice(0, 200);

/**
 * States: `off` (a dev run, no updater at all) · `idle` (not asked yet) ·
 * `checking` · `current` (nothing newer) · `downloading` · `ready` (downloaded,
 * waiting for a restart) · `error` (until the next check).
 */
class Updates extends EventEmitter {
  constructor({ updater = null, version = '', every = EVERY, prepare = null, timers = null } = {}) {
    super();
    this.updater = updater;
    this.version = version;
    this.every = every;
    this.prepare = prepare;
    this.timers = timers || { setInterval, clearInterval };
    this.timer = null;
    this.state = updater ? 'idle' : 'off';
    this.offered = null;     // the version on offer, once the check names one
    this.percent = 0;
    this.error = null;
    this.checkedAt = null;
    this.announced = null;   // last version we fired `ready` for
    this.sent = null;        // last view we emitted, so idle progress stays quiet
  }

  view() {
    return {
      state: this.state, version: this.offered, percent: this.percent, error: this.error,
      checkedAt: this.checkedAt, current: this.version,
      busy: this.state === 'checking' || this.state === 'downloading',
    };
  }

  start() {
    const u = this.updater;
    if (!u) return this;
    u.on('checking-for-update', () => this.#set('checking', { error: null }));
    // autoDownload is on, so "available" already means the download has begun.
    u.on('update-available', info => this.#set('downloading', { offered: versionOf(info) || this.offered, percent: 0 }));
    u.on('update-not-available', () => this.#set('current', { offered: null, percent: 0, checkedAt: Date.now() }));
    u.on('download-progress', p => {
      if (this.state === 'ready') return; // an already-cached file reports progress after the fact
      this.#set('downloading', { percent: clampPercent(p && p.percent) });
    });
    u.on('update-downloaded', info => {
      this.#set('ready', { offered: versionOf(info) || this.offered, percent: 100, checkedAt: Date.now() });
      // A restart-less day means every later check finds the same file again.
      if (this.announced !== this.offered) {
        this.announced = this.offered;
        this.emit('ready', this.view());
      }
    });
    u.on('error', e => this.#set('error', { error: messageOf(e) }));
    this.check();
    this.timer = this.timers.setInterval(() => this.check(), this.every);
    return this;
  }

  /** Ask GitHub. Resolves once the check has settled; any download carries on behind it. */
  async check() {
    // Already downloaded, or already busy: nothing a second check could add.
    if (!this.updater || this.state === 'ready' || this.view().busy) return this.view();
    this.#set('checking', { error: null });
    try {
      await this.updater.checkForUpdates();
    } catch (e) {
      // The `error` event normally beats us here; this covers a bare rejection.
      if (this.state === 'checking') this.#set('error', { error: messageOf(e) });
    }
    return this.view();
  }

  /** Install now: the installer runs silently and Shellby comes back on the new version. */
  install() {
    if (!this.updater || this.state !== 'ready') return false;
    if (this.prepare) this.prepare();
    this.updater.quitAndInstall(true, true);
    return true;
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  #set(state, patch = {}) {
    Object.assign(this, patch, { state });
    const view = this.view();
    const json = JSON.stringify(view);
    if (json === this.sent) return; // rounded progress repeats itself; don't wake the panel for it
    this.sent = json;
    this.emit('changed', view);
  }
}

/** One line for the tray menu, which has no room for a status line and a button. */
function trayLabel(view) {
  if (!view || view.state === 'off') return null;
  if (view.state === 'ready') return `Update to ${view.version || 'the new version'} and restart`;
  if (view.state === 'downloading') return `Downloading update… ${view.percent}%`;
  if (view.state === 'checking') return 'Checking for updates…';
  return 'Check for updates';
}

/**
 * A scripted stand-in for electron-updater, so a dev run can walk the whole
 * sequence (offer → download → ready, or a failure) without cutting a release:
 * `SHELLBY_FAKE_UPDATE=1 npm start`. Set it to `fail` for the offline path.
 */
function fakeUpdater({ version = '99.0.0', mode = 'ok', step = 600 } = {}) {
  const u = new EventEmitter();
  u.quitAndInstall = (...args) => console.log('[shellby] fake updater would install now', args);
  u.checkForUpdates = async () => {
    u.emit('checking-for-update');
    await new Promise(r => setTimeout(r, step));
    if (mode === 'fail') return u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    if (mode === 'current') return u.emit('update-not-available', { version });
    u.emit('update-available', { version });
    for (const percent of [8, 24, 51, 77, 96]) {
      await new Promise(r => setTimeout(r, step));
      u.emit('download-progress', { percent });
    }
    await new Promise(r => setTimeout(r, step));
    u.emit('update-downloaded', { version });
    return { updateInfo: { version } };
  };
  return u;
}

module.exports = { Updates, trayLabel, fakeUpdater, EVERY };
