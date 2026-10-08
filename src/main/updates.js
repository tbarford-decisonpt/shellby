// Shellby's self-update. electron-updater does the fetching; this is the one
// small state machine the panel renders and the tray menu reads, so a new
// version is a button you press rather than something you discover by quitting
// twice. No Electron imports: main.js passes the updater in, which also lets
// test/updates.test.js drive it with a fake.

const { EventEmitter } = require('events');
const { win32 } = require('path');

const EVERY = 6 * 60 * 60 * 1000;
// After a failed check: try again sooner, then fall back to EVERY. Wi-Fi that
// was down at startup shouldn't mean six hours without updates.
const RETRY_AFTER = [10, 30, 60].map(m => m * 60 * 1000);

const clampPercent = n => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);
const versionOf = info => (info && typeof info.version === 'string' ? info.version.slice(0, 40) : null);
// electron-updater errors carry a stack and sometimes a whole HTTP response.
const messageOf = e => String((e && e.message) || e || 'Update check failed').split('\n')[0].slice(0, 200);

const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED|TIMED_OUT)|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_TIMED_OUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT/;
const RATE_LIMITED = /\b(?:403|429)\b|rate limit/i;
const INTERRUPTED = /ERR_CONTENT_LENGTH_MISMATCH|ERR_INCOMPLETE_CHUNKED_ENCODING|sha512 checksum mismatch/i;

/**
 * The raw error in words for Settings (the log keeps the raw one).
 *   downloading: it failed partway through a download, not while asking
 */
function plainError(raw, { downloading = false } = {}) {
  const m = String(raw || '');
  if (/ENOSPC/.test(m)) return 'There was no room on the disk for the update.';
  if (OFFLINE.test(m)) return downloading ? 'The download stopped: this PC went offline.' : "Couldn't reach GitHub. Is this PC online?";
  if (RATE_LIMITED.test(m)) return 'GitHub asked him to slow down for a bit.';
  if (downloading || INTERRUPTED.test(m)) return "The download didn't finish.";
  return "Couldn't check for updates.";
}

const SCOOP_APP = /[\\/]scoop[\\/]apps[\\/]shellby[\\/]/i;
// Roots come from env vars, which may use forward slashes or end in one.
const underRoot = (exe, root) => !!root
  && exe.startsWith(`${win32.normalize(root).toLowerCase().replace(/\\+$/, '')}\\apps\\shellby\\`);

/**
 * Who installed this copy, when it isn't our own installer: 'scoop' or null.
 * Scoop unpacks the app under <root>\apps\shellby\ and updates it with
 * `scoop update`; electron-updater would install a second copy beside it.
 */
function installedBy(execPath, env = process.env) {
  if (!execPath) return null;
  const exe = win32.normalize(String(execPath)).toLowerCase();
  if (SCOOP_APP.test(exe) || underRoot(exe, env.SCOOP) || underRoot(exe, env.SCOOP_GLOBAL)) return 'scoop';
  return null;
}

/**
 * States: `off` (a dev run, no updater at all) · `scoop` (Scoop updates this
 * copy, so we never ask) · `idle` (not asked yet) ·
 * `checking` · `current` (nothing newer) · `downloading` · `ready` (downloaded,
 * waiting for a restart) · `error` (until the next check).
 */
class Updates extends EventEmitter {
  constructor({ updater = null, managedBy = null, version = '', every = EVERY, prepare = null, timers = null, log = null } = {}) {
    super();
    // A package manager owns this install: hold no updater, so check() and
    // install() are no-ops and start() schedules nothing.
    this.updater = managedBy ? null : updater;
    this.version = version;
    this.every = every;
    this.prepare = prepare;
    this.timers = { setInterval, clearInterval, setTimeout, clearTimeout, ...(timers || {}) };
    this.timer = null;
    this.retryTimer = null;
    this.failures = 0;       // failed checks in a row, for RETRY_AFTER
    this.retryAt = null;     // when the next early retry is, if one is due
    this.log = log || (m => console.warn('[shellby] update check failed:', m));
    this.state = managedBy || (updater ? 'idle' : 'off');
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
      checkedAt: this.checkedAt, current: this.version, retryAt: this.state === 'error' ? this.retryAt : null,
      busy: this.state === 'checking' || this.state === 'downloading',
    };
  }

  start() {
    const u = this.updater;
    if (!u) return this;
    // While an update sits downloaded, later checks run quietly behind the
    // install button: only a release newer than the one on disk moves it.
    u.on('checking-for-update', () => {
      if (this.state !== 'ready') this.#set('checking', { error: null });
    });
    // autoDownload is on, so "available" already means the download has begun.
    u.on('update-available', info => {
      this.#recovered();
      const offered = versionOf(info) || this.offered;
      if (this.state === 'ready' && offered === this.offered) return; // the cached file, found again
      this.#set('downloading', { offered, percent: 0 });
    });
    u.on('update-not-available', () => {
      this.#recovered();
      if (this.state === 'ready') return;
      this.#set('current', { offered: null, percent: 0, checkedAt: Date.now() });
    });
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
    // A failed re-check doesn't un-download what's already on disk.
    u.on('error', e => {
      if (this.state !== 'ready') this.#failed(e);
    });
    this.check();
    this.timer = this.timers.setInterval(() => this.check(), this.every);
    return this;
  }

  /**
   * Ask GitHub. Resolves once the check has settled; any download carries on
   * behind it. Still asks once an update is ready, so a release that lands
   * after the download replaces it rather than needing a second restart.
   */
  async check() {
    if (!this.updater || this.view().busy) return this.view();
    if (this.state !== 'ready') this.#set('checking', { error: null });
    try {
      await this.updater.checkForUpdates();
    } catch (e) {
      // The `error` event normally beats us here; this covers a bare rejection.
      if (this.state === 'checking') this.#failed(e);
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
    this.#cancelRetry();
  }

  // Plain words on screen, the raw error in the log, and an early retry while
  // there are any left (RETRY_AFTER); after that the usual six-hourly check.
  #failed(e) {
    const raw = messageOf(e);
    this.log(raw);
    const error = plainError(raw, { downloading: this.state === 'downloading' });
    this.#cancelRetry();
    const wait = RETRY_AFTER[this.failures];
    this.failures++;
    if (wait && this.updater) {
      this.retryAt = Date.now() + wait;
      this.retryTimer = this.timers.setTimeout(() => { this.retryTimer = null; this.retryAt = null; this.check(); }, wait);
      this.retryTimer?.unref?.(); // never what keeps Shellby (or a test) running
    }
    this.#set('error', { error });
  }

  #recovered() {
    this.failures = 0;
    this.#cancelRetry();
  }

  #cancelRetry() {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
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
  if (!view || view.state === 'off' || view.state === 'scoop') return null;
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

module.exports = { Updates, trayLabel, fakeUpdater, installedBy, plainError, EVERY, RETRY_AFTER };
