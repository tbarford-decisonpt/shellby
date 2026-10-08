// Keeping Claude Code itself up to date. The CLI checks for its own updates
// only in an interactive terminal session, and the sessions Shellby starts
// aren't interactive, so a copy that only ever runs under Shellby would stay on
// whatever version it was installed with, and miss the releases the nightly
// compatibility check is tested against.
//
// Once a day Shellby asks the npm registry which version is newest (one small
// GET with nothing about you in it), and compares it with the one he found.
// With "Tell me" (the default) a newer one is said once, in a notification and
// in Settings → About, with an Update button. With "Update it for me"
// he runs `claude update` himself, but only while no conversation is working.
// "Leave it to me" asks the registry nothing.
//
// The update is the CLI's own `claude update`, which knows how it was installed
// (native or npm) and updates that copy. The parsers and the schedule are pure
// (test/claude-update.test.js); fetching and running are passed in.
const { EventEmitter } = require('events');

const PACKAGE = '@anthropic-ai/claude-code';
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIRST_TICK_MS = 5 * MINUTE;  // not in the rush of startup
const TICK_MS = HOUR;              // a sleeping PC skips timers: an hourly look catches up
const EVERY = DAY;                 // how often the registry is asked
const RETRY_MS = 6 * HOUR;         // after a check that got nothing back (offline, registry down)
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024; // the manifest is a few KB; anything bigger isn't it
const UPDATE_TIMEOUT_MS = 5 * MINUTE;

const MODES = ['tell', 'auto', 'off'];
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

const version = v => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
const time = t => (Number.isFinite(t) && t > 0 ? t : null);
const clip = (s, n) => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, n);
const messageOf = e => clip((e && e.message) || e || 'Something went wrong', 200);

/** Is `b` a newer release than `a`? Both plain x.y.z; anything else is "no". */
function newer(a, b) {
  if (!version(a) || !version(b)) return false;
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] > x[i];
  return false;
}

/** The registry's `/latest` manifest -> its version, or null for anything that isn't one. */
function parseLatest(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim() || 'null'); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.name !== PACKAGE) return null;
  return version(data.version);
}

/**
 * What `claude update` printed -> { from, to, updated, current }.
 * `updated`: it installed one. `current`: it checked and had nothing newer.
 * Neither: it didn't get that far (the caller has the exit code and the text).
 */
function parseUpdate(text) {
  const out = String(text || '');
  const from = version((out.match(/Current version:\s*(\d+\.\d+\.\d+)/) || [])[1]);
  const done = out.match(/Successfully updated from (\d+\.\d+\.\d+) to version (\d+\.\d+\.\d+)/);
  const same = out.match(/is up to date \((\d+\.\d+\.\d+)\)/);
  if (done) return { from: version(done[1]) || from, to: version(done[2]), updated: true, current: false };
  if (same) return { from: version(same[1]) || from, to: version(same[1]) || from, updated: false, current: true };
  return { from, to: null, updated: false, current: false };
}

/** Tolerate anything read from disk. */
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: MODES.includes(s.mode) ? s.mode : 'tell',
    latest: version(s.latest),
    lastCheckAt: time(s.lastCheckAt),
    lastAttemptAt: time(s.lastAttemptAt),
    lastUpdateAt: time(s.lastUpdateAt),
    told: version(s.told),    // the version the notification already mentioned
    tried: version(s.tried),  // the version an automatic update already went for
    error: typeof s.error === 'string' ? clip(s.error, 200) : null,
  };
}

/** The newest release on the registry. Throws on anything but a clean answer. */
async function fetchLatest({ fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, url = LATEST_URL } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch available');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } });
    } catch {
      throw new Error(ctrl.signal.aborted ? 'The npm registry took too long to answer.' : "Couldn't reach the npm registry.");
    }
    if (!res.ok) throw new Error(`The npm registry answered with HTTP ${res.status}.`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("The npm registry's answer was too big to be the manifest.");
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("The npm registry's answer was too big to be the manifest.");
    const latest = parseLatest(text);
    if (!latest) throw new Error("The npm registry's answer wasn't the Claude Code manifest.");
    return latest;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * States the panel renders: `mode`, the `installed` version (null when Claude
 * Code isn't found), the `latest` the registry named, and `available` when the
 * latter is newer. `checking` and `updating` while either is in flight.
 */
class ClaudeUpdates extends EventEmitter {
  /**
   * deps: { config, status: () => claudeStatus | null, busy: () => number, run(exe, args, timeoutMs),
   *         recheck: () => Promise<status>, notify(title, body), toPanel(channel, payload),
   *         log?, isOff?: () => bool, fetchImpl?, now? }
   */
  constructor(deps) {
    super();
    this.deps = { isOff: () => false, busy: () => 0, toPanel: () => {}, notify: () => {}, now: () => Date.now(), ...deps };
    this.checking = null;
    this.updating = null;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    /** @type {NodeJS.Timeout | null} */
    this.first = null;
  }

  get settings() { return normalizeSettings(this.deps.config.get('claudeUpdates')); }

  save(patch) {
    this.deps.config.set({ claudeUpdates: { ...this.settings, ...patch } });
    this.changed();
  }

  changed() {
    const v = this.view();
    this.deps.toPanel('claude:update', v);
    this.emit('changed', v);
  }

  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.settings.mode) return this.view();
    // Switching off forgets what the registry said, so nothing is left to offer.
    this.save(mode === 'off' ? { mode, latest: null, told: null, tried: null, error: null } : { mode });
    return this.view();
  }

  view() {
    const s = this.settings;
    const installed = version(this.deps.status()?.version);
    return {
      mode: s.mode,
      installed,
      latest: s.latest,
      available: !!installed && !!s.latest && newer(installed, s.latest),
      checking: !!this.checking,
      updating: !!this.updating,
      lastCheckAt: s.lastCheckAt,
      lastUpdateAt: s.lastUpdateAt,
      error: s.error,
    };
  }

  start() {
    if (this.timer) return;
    this.first = setTimeout(() => this.tick(), FIRST_TICK_MS);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.first.unref?.();
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(/** @type {any} */ (this.first)); clearInterval(/** @type {any} */ (this.timer));
    this.first = null; this.timer = null;
  }

  /** Time to ask the registry again? Daily, and not for 6 hours after a failed try. */
  due() {
    const s = this.settings;
    const now = this.deps.now();
    if (s.mode === 'off' || this.deps.isOff() || !this.deps.status()?.installed) return false;
    if (s.lastAttemptAt && now - s.lastAttemptAt < RETRY_MS) return false;
    return !s.lastCheckAt || now - s.lastCheckAt >= EVERY;
  }

  /** Time to update without being asked? Only in auto mode, once per release, while nothing is working. */
  dueUpdate() {
    const s = this.settings;
    if (s.mode !== 'auto' || this.deps.isOff() || this.updating) return false;
    const v = this.view();
    return v.available && s.tried !== s.latest && this.deps.busy() === 0;
  }

  async tick() {
    try {
      if (this.due()) await this.check();
      if (this.dueUpdate()) await this.update({ auto: true });
    } catch (err) {
      this.deps.log?.warn?.('Claude Code update check failed', messageOf(err));
    }
  }

  /** Ask the registry now. Resolves to the view; a failure lands in `error`, never throws. */
  check() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      this.changed();
      const now = this.deps.now();
      try {
        const latest = await fetchLatest({ fetchImpl: this.deps.fetchImpl });
        this.save({ latest, lastCheckAt: now, lastAttemptAt: now, error: null });
        const v = this.view();
        if (v.available && this.settings.mode === 'tell' && this.settings.told !== latest) {
          this.save({ told: latest });
          this.deps.notify('Claude Code update', `Claude Code ${latest} is out; you have ${v.installed}. Update it from Settings → About.`);
        }
      } catch (err) {
        this.save({ lastAttemptAt: now, error: messageOf(err) });
      }
    })().finally(() => { this.checking = null; this.changed(); }).then(() => this.view());
    return this.checking;
  }

  /**
   * Run `claude update` on the copy Shellby uses, then look at the version again.
   * -> { ok, from, to, updated, error }
   */
  update({ auto = false } = {}) {
    if (this.updating) return this.updating;
    const exe = this.deps.status()?.exe;
    if (!exe) return Promise.resolve({ ok: false, from: null, to: null, updated: false, error: 'Claude Code not found.' });
    const before = version(this.deps.status()?.version);
    this.updating = (async () => {
      this.changed();
      const s = this.settings;
      if (auto) this.save({ tried: s.latest });
      const r = await this.deps.run(exe, ['update'], UPDATE_TIMEOUT_MS);
      const parsed = parseUpdate(`${r.stdout}\n${r.stderr}`);
      /** @type {any} */
      let status = null;
      try { status = await this.deps.recheck(); } catch { /* the next check will tell */ }
      const to = version(status?.version) || parsed.to || before;
      const from = parsed.from || before;
      const ok = r.ok && (parsed.updated || parsed.current || (!!to && to !== from));
      const updated = !!to && !!from && to !== from;
      /** @type {string | null} */
      let error = null;
      if (!ok) {
        error = r.timedOut ? 'Claude Code took too long to update.'
          : clip((r.stderr || r.stdout || r.err?.message || '').split(/\r?\n/).filter(Boolean).pop(), 200) || "Claude Code didn't update.";
      } else if (!updated && s.latest && newer(to, s.latest)) {
        // The registry names a newer release than the installer will hand out
        // yet: not a failure, and nothing to do until the installer catches up.
        error = `Claude Code says ${to} is the latest it can install right now; ${s.latest} is on its way.`;
      }
      this.save({ lastUpdateAt: this.deps.now(), error, ...(updated && to ? { told: null } : {}) });
      if (updated) this.deps.log?.info?.('Claude Code updated', `${from} → ${to}${auto ? ' (automatically)' : ''}`);
      else if (!ok) this.deps.log?.warn?.('Claude Code update failed', error);
      if (auto && updated) this.deps.notify('Claude Code updated', `Now on ${to} (was ${from}). New conversations use it.`);
      return { ok, from, to, updated, error };
    })().finally(() => { this.updating = null; this.changed(); });
    return this.updating;
  }
}

module.exports = {
  ClaudeUpdates, fetchLatest, newer, normalizeSettings, parseLatest, parseUpdate,
  MODES, PACKAGE, LATEST_URL, EVERY, RETRY_MS, UPDATE_TIMEOUT_MS,
};
