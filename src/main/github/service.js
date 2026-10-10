// GitHub in Shellby: sign-in state, the profile (name + avatar), the features
// you turned on, progress sync, history sync (history-gist.js, through the
// syncHistory it's given), and the git access Claude tasks may borrow.
// The token stays in the main process: the panel only ever sees the view().
const { EventEmitter } = require('events');
const { scopesFor, covers, startDeviceFlow, pollForToken, CLIENT_ID } = require('./auth');
const { GitHubApi } = require('./api');
const { syncNow } = require('./sync');

const FEATURES = ['profile', 'sync', 'history', 'friends', 'profileCard', 'prBadge', 'publish', 'claude', 'ci', 'issues', 'workflows', 'projects'];
const SYNC_EVERY_MS = 15 * 60 * 1000;
const SYNC_SOON_MS = 20 * 1000;          // after a local change worth sharing
const AVATAR_MAX_BYTES = 200 * 1024;
const AVATAR_HOST = 'https://avatars.githubusercontent.com/';
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

// fetch's own words when there's no network (Node puts the cause's code beside them).
const OFFLINE = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT/i;

// "12 conversations in step; 2 too long to send." from a history sync's result.
function historyNote(h) {
  const n = h?.synced || 0;
  const parts = [`${n} conversation${n === 1 ? '' : 's'} in step across your PCs`];
  if (h?.tooBig) parts.push(`${h.tooBig} too long to send`);
  if (h?.forked) parts.push(`${h.forked} changed on two PCs at once, so kept twice`);
  return `${parts.join('; ')}.`;
}

function normalizeState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const features = {};
  for (const f of FEATURES) features[f] = f === 'profile' ? true : !!r.features?.[f];
  return {
    features,
    login: typeof r.login === 'string' && LOGIN_RE.test(r.login) ? r.login : null,
    name: clip(r.name, 80),
    avatar: typeof r.avatar === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(r.avatar) ? r.avatar : null,
    lastSyncAt: Number.isFinite(r.lastSyncAt) ? r.lastSyncAt : null,
    lastSyncError: clip(r.lastSyncError, 200) || null,
    // What the last history sync left in step ("12 conversations in step"), or null.
    historyNote: clip(r.historyNote, 200) || null,
    // GitHub turned the sign-in down (401) since it was made: it needs doing again.
    authLost: r.authLost === true,
  };
}

/**
 * Environment for a Claude Code process that may use your GitHub sign-in:
 * GH_TOKEN for the gh CLI, GITHUB_PERSONAL_ACCESS_TOKEN for the official GitHub
 * plugin's MCP tools (its .mcp.json reads that variable), and a git credential helper (via GIT_CONFIG_*, so
 * nothing is written to your git config) that answers for github.com only.
 */
function gitEnv(token, base = process.env) {
  if (!token) return {};
  const n = Number(base.GIT_CONFIG_COUNT) || 0;
  const key = 'credential.https://github.com.helper';
  return {
    GH_TOKEN: token,
    GITHUB_PERSONAL_ACCESS_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: key,
    [`GIT_CONFIG_VALUE_${n}`]: '', // an empty helper clears the ones before it (for github.com only)
    [`GIT_CONFIG_KEY_${n + 1}`]: key,
    [`GIT_CONFIG_VALUE_${n + 1}`]: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f',
  };
}

class GitHubService extends EventEmitter {
  /**
   * config: Shellby's Config. store: TokenStore. web/api/clientId: GitHub (or a
   * mock in tests). openUrl/copy: shell helpers. onSynced(before): called after a pull,
   * with the settings (config.data) from before the sync. syncHistory(gh): one
   * history sync (history-gist.js), resolving to its result; null where there's none.
   */
  constructor({ config, store, web = 'https://github.com', api = 'https://api.github.com', clientId = CLIENT_ID, fetchImpl = fetch, now = () => Date.now(), onSynced = () => {}, syncHistory = null }) {
    super();
    Object.assign(this, { config, store, web, api, clientId, fetchImpl, now, onSynced, syncHistory });
    this.auth = this.store.load();
    this.flow = null;       // { user_code, verification_uri, expiresAt, features, abort }
    this.syncing = null;
    this.timer = null;
    this.soon = null;
    this.stopped = false;   // after stop(), a sign-in finishing late starts nothing
  }

  get state() { return normalizeState(this.config.get('github')); }
  save(patch) {
    this.config.set({ github: { ...this.state, ...patch } });
    if (patch.features && this.signedIn) this.keepFeatures();
    this.emit('change', this.view());
  }

  // The features you turned on go beside the token too (TokenStore), so a
  // settings.json lost to a power cut doesn't send you through every approval
  // again. Only when they changed: each save re-encrypts the file.
  keepFeatures() {
    const on = Object.fromEntries(FEATURES.filter(f => f !== 'profile' && this.state.features[f]).map(f => [f, true]));
    if (JSON.stringify(on) === JSON.stringify(this.auth.features || {})) return;
    try { this.store.save({ ...this.auth, features: on }); this.auth = { ...this.auth, features: on }; } catch { /* settings.json still has them */ }
  }

  /**
   * At boot. The sign-in lives in its own file and outlives settings.json: when
   * the settings were lost (no `github` in them at all), the features come back
   * from beside the token. A sign-in with no account (the settings lost, or the
   * profile fetch failed) fetches who you are again, so Settings never says
   * "signed in" with nobody in it.
   */
  restore() {
    if (!this.signedIn) return;
    if (this.config.get('github') == null && this.auth.features) {
      const features = { ...this.state.features };
      for (const f of FEATURES) if (f !== 'profile' && this.auth.features[f] === true) features[f] = true;
      this.save({ features });
    }
    if (!this.state.login) this.refreshProfile().catch(() => { /* offline: the next boot tries again */ });
  }
  get signedIn() { return !!this.auth?.token; }
  gh() { return new GitHubApi({ token: this.auth.token, api: this.api, fetchImpl: this.fetchImpl, onUnauthorized: () => this.lostAuth() }); }

  // Any call that GitHub answers 401 (sync, CI, issues, a pull request): the
  // sign-in has expired or been revoked, so Settings offers "Sign in again".
  lostAuth() {
    if (this.signedIn && !this.state.authLost) this.save({ authLost: true });
  }
  can(feature) { return this.signedIn && this.state.features[feature] && covers(this.auth.scopes, feature); }

  view() {
    const s = this.state;
    return {
      signedIn: this.signedIn,
      encryption: this.store.available,
      login: this.signedIn ? s.login : null,
      name: this.signedIn ? s.name : '',
      avatar: this.signedIn ? s.avatar : null,
      features: Object.fromEntries(FEATURES.map(f => [f, { on: s.features[f], granted: this.signedIn && covers(this.auth.scopes, f) }])),
      lastSyncAt: s.lastSyncAt,
      lastSyncError: s.lastSyncError,
      historyNote: this.signedIn ? s.historyNote : null,
      authLost: this.signedIn && s.authLost,
      syncing: !!this.syncing,
      flow: this.flow ? { code: this.flow.user_code, url: this.flow.verification_uri, expiresAt: this.flow.expiresAt } : null,
    };
  }

  /** The verification page must be GitHub's own (it's opened in your browser). */
  safeVerificationUrl(u) {
    try {
      const url = new URL(u);
      const web = new URL(this.web);
      return url.origin === web.origin && url.pathname.startsWith('/login/device') ? url.toString() : null;
    } catch { return null; }
  }

  /**
   * Sign in (or widen the sign-in) for these features. Resolves when the code
   * is ready to show; the rest happens in the background (watch 'change').
   */
  async signIn(features = []) {
    if (!this.store.available) return { ok: false, error: "Windows can't encrypt the sign-in on this PC, so Shellby won't keep it." };
    this.cancel();
    const wanted = [...new Set(['profile', ...features.filter(f => FEATURES.includes(f)), ...FEATURES.filter(f => this.state.features[f])])];
    let code;
    try {
      code = await startDeviceFlow({ scopes: scopesFor(wanted), clientId: this.clientId, web: this.web, fetchImpl: this.fetchImpl });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const url = this.safeVerificationUrl(code.verification_uri);
    if (!url) return { ok: false, error: 'GitHub sent an unexpected sign-in page, so Shellby stopped.' };
    const abort = new AbortController();
    this.flow = { user_code: String(code.user_code).slice(0, 20), verification_uri: url, expiresAt: this.now() + (code.expires_in || 900) * 1000, abort };
    this.emit('change', this.view());
    this.finish(code, wanted, abort);
    return { ok: true };
  }

  async finish(code, wanted, abort) {
    try {
      const got = await pollForToken(code, { clientId: this.clientId, web: this.web, fetchImpl: this.fetchImpl, signal: abort.signal });
      if (abort.signal.aborted) return;
      this.store.save(got);
      this.auth = got;
      this.flow = null;
      const features = { ...this.state.features };
      for (const f of wanted) if (covers(got.scopes, f)) features[f] = true;
      this.save({ features, lastSyncError: null, authLost: false });
      await this.refreshProfile().catch(() => {});
      if (this.stopped) return;
      this.emit('signed-in', this.view());
      this.schedule();
      if (this.syncsAnything()) this.sync().catch(() => {});
    } catch (e) {
      if (abort.signal.aborted) return;
      this.flow = null;
      this.emit('change', this.view());
      this.emit('error', e.message);
    }
  }

  cancel() {
    if (!this.flow) return;
    this.flow.abort.abort();
    this.flow = null;
    this.emit('change', this.view());
  }

  signOut() {
    this.cancel();
    this.store.clear();
    this.auth = null;
    clearInterval(this.timer); this.timer = null;
    clearTimeout(this.soon); this.soon = null;
    const f = this.state.features;
    this.save({ login: null, name: '', avatar: null, lastSyncAt: null, lastSyncError: null, authLost: false, features: { ...f, claude: false, friends: false, profileCard: false, prBadge: false } });
  }

  /** Turn a feature on/off. On needs a wider sign-in when the token lacks the scope. */
  async setFeature(feature, on) {
    if (!FEATURES.includes(feature) || feature === 'profile') return { ok: false };
    if (on && this.signedIn && !covers(this.auth.scopes, feature)) return { ...(await this.signIn([feature])), needsApproval: true };
    this.save({ features: { ...this.state.features, [feature]: !!on } });
    if (feature === 'sync' || feature === 'history') { this.schedule(); if (on && this.can(feature)) this.sync().catch(() => {}); }
    if (feature === 'history' && !on) this.save({ historyNote: null });
    return { ok: true };
  }

  async refreshProfile() {
    const me = await this.gh().get('/user');
    const login = typeof me?.login === 'string' && LOGIN_RE.test(me.login) ? me.login : null;
    this.save({ login, name: clip(me?.name, 80), avatar: await this.fetchAvatar(me?.avatar_url).catch(() => null) });
  }

  /** The avatar as a data: URL (the panel only loads images from itself or data:). */
  async fetchAvatar(u) {
    if (typeof u !== 'string' || !u.startsWith(AVATAR_HOST)) return null;
    const url = new URL(u);
    url.searchParams.set('s', '96');
    const res = await this.fetchImpl(url.toString());
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > AVATAR_MAX_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  }

  // ---------------------------------------------------------------- sync

  /** Progress or history: either one keeps the timer going. */
  syncsAnything() { return this.can('sync') || (this.can('history') && !!this.syncHistory); }

  schedule() {
    clearInterval(this.timer);
    this.timer = this.syncsAnything() && !this.stopped ? setInterval(() => this.sync().catch(() => {}), SYNC_EVERY_MS) : null;
  }

  /** Something worth sharing changed locally (outfit, skin, a trophy): sync shortly. */
  changedSoon() {
    if (!this.can('sync') || this.soon || this.stopped) return;
    this.soon = setTimeout(() => { this.soon = null; this.sync().catch(() => {}); }, SYNC_SOON_MS);
  }

  sync() {
    if (!this.syncsAnything()) return Promise.resolve({ ok: false, error: 'Sync is off.' });
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      this.emit('change', this.view());
      try {
        let r = {};
        if (this.can('sync')) {
          const before = this.config.data;
          r = await syncNow(this.gh(), { get: k => this.config.get(k), set: p => this.config.set(p), data: () => this.config.data });
          if (r.pulled) this.onSynced(before);
        }
        // History has its own gist: progress has synced whatever happens to it.
        if (this.can('history') && this.syncHistory) {
          try {
            const h = await this.syncHistory(this.gh());
            r = { ...r, history: h };
            this.save({ historyNote: historyNote(h) });
          } catch (e) {
            if (e.status === 401 || OFFLINE.test(`${e.message} ${e.cause?.code || ''}`)) throw e;
            this.save({ lastSyncAt: this.now(), lastSyncError: `History sync failed: ${clip(e.message, 150)}` });
            return { ok: false, error: this.state.lastSyncError };
          }
        }
        this.save({ lastSyncAt: this.now(), lastSyncError: null });
        return { ok: true, ...r };
      } catch (e) {
        const offline = !e.status && OFFLINE.test(`${e.message} ${e.cause?.code || ''}`);
        const error = e.status === 401 ? 'GitHub signed Shellby out. Sign in again to keep syncing.'
          : offline ? "Couldn't reach GitHub: this PC looks to be offline. Shellby tries again later."
            : `Sync failed: ${clip(e.message, 150)}`;
        this.save({ lastSyncError: error });
        return { ok: false, error };
      } finally {
        this.syncing = null;
        this.emit('change', this.view());
      }
    })();
    return this.syncing;
  }

  // ---------------------------------------------------------------- Claude

  /** Extra env for Shellby's own Claude Code tabs, when you allowed it. */
  claudeEnv() { return this.can('claude') ? gitEnv(this.auth.token) : {}; }

  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.soon); this.cancel(); }
}

module.exports = { GitHubService, gitEnv, normalizeState, FEATURES };
