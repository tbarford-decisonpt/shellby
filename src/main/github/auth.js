// GitHub sign-in with the OAuth device flow (like `gh auth login`): Shellby
// shows a short code, you approve it on github.com, Shellby gets a token. No
// server and no client secret are involved. Scopes are added only when you
// turn a feature on. The token is encrypted with the OS (Electron safeStorage:
// DPAPI on Windows) in its own file, never in settings.json.
const fs = require('fs');

// Public identifier of Shellby's GitHub OAuth app (not a secret; device flow
// needs no secret). Dev/test builds may point at a mock GitHub instead.
const CLIENT_ID = 'Ov23liUNwzgYRhQoado8';

const FEATURE_SCOPES = Object.freeze({
  profile: ['read:user'],      // name + avatar
  sync: ['gist'],              // private gist with your progress
  publish: ['public_repo'],    // fork shellby-packs and open a PR
  claude: ['repo'],            // Claude Code tasks can push and open PRs (private repos too)
  ci: [],                      // watch CI on your pull requests (public repos; private ones ride on `repo`)
  // GitHub refuses any push that touches .github/workflows without this, even
  // with `repo`. Kept separate from `claude` on purpose: a workflow decides what
  // runs in CI, where the repository's secrets are, so it is its own decision.
  workflows: ['workflow'],
});

/** The scopes needed for a set of features (repo covers public_repo). */
function scopesFor(features) {
  const s = new Set(['read:user']);
  for (const f of features) for (const x of FEATURE_SCOPES[f] || []) s.add(x);
  if (s.has('repo')) s.delete('public_repo');
  return [...s].sort();
}

/** Does a granted scope list cover what a feature needs? */
function covers(granted, feature) {
  const g = new Set(granted || []);
  return (FEATURE_SCOPES[feature] || []).every(x => g.has(x) || (x === 'public_repo' && g.has('repo')));
}

const parseScopes = header => String(header || '').split(',').map(s => s.trim()).filter(Boolean);

// ------------------------------------------------------------------ device flow

/**
 * Start sign-in. Returns { device_code, user_code, verification_uri, interval, expires_in }.
 * http: { web } base URL (https://github.com, or a mock in tests); fetchImpl injectable.
 */
async function startDeviceFlow({ scopes, clientId = CLIENT_ID, web = 'https://github.com', fetchImpl = fetch }) {
  const res = await fetchImpl(`${web}/login/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: scopes.join(' ') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code || !data.user_code) throw new Error(data.error_description || 'GitHub sign-in is unavailable right now.');
  return data;
}

/**
 * Poll until approved, denied or expired. Resolves { token, scopes } or throws
 * with a friendly message. `signal` (AbortSignal) cancels.
 */
async function pollForToken({ device_code, interval = 5, expires_in = 900 }, { clientId = CLIENT_ID, web = 'https://github.com', fetchImpl = fetch, signal, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let wait = Math.max(1, interval) * 1000;
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    const res = await fetchImpl(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.access_token) return { token: data.access_token, scopes: parseScopes(data.scope) };
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { wait += 5000; continue; }
    if (data.error === 'access_denied') throw new Error('You declined the sign-in on GitHub.');
    if (data.error === 'expired_token') throw new Error('The code expired. Try signing in again.');
    throw new Error(data.error_description || 'GitHub sign-in failed.');
  }
  throw new Error('The code expired. Try signing in again.');
}

// ------------------------------------------------------------------ token store

/**
 * Encrypted token file. crypto: Electron's safeStorage (or a stand-in in tests).
 * Stores { token, scopes } as one encrypted blob.
 */
class TokenStore {
  constructor(file, crypto) { this.file = file; this.crypto = crypto; }

  get available() { return !!this.crypto?.isEncryptionAvailable?.(); }

  save(data) {
    if (!this.available) throw new Error("Windows can't encrypt the sign-in here, so Shellby won't store it.");
    const blob = this.crypto.encryptString(JSON.stringify({ token: data.token, scopes: data.scopes || [] }));
    fs.writeFileSync(this.file, blob, { mode: 0o600 });
  }

  load() {
    try {
      if (!this.available || !fs.existsSync(this.file)) return null;
      const d = JSON.parse(this.crypto.decryptString(fs.readFileSync(this.file)));
      return typeof d?.token === 'string' && d.token ? { token: d.token, scopes: Array.isArray(d.scopes) ? d.scopes : [] } : null;
    } catch { return null; }
  }

  clear() { try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ } }
}

module.exports = { CLIENT_ID, FEATURE_SCOPES, scopesFor, covers, parseScopes, startDeviceFlow, pollForToken, TokenStore };
