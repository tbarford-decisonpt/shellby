// A tiny GitHub REST client for Shellby's own calls (profile, gists, pack PRs).
// Base URLs are injectable so tests run against a local mock GitHub.
class GitHubApi {
  // onUnauthorized: GitHub said the sign-in is no good (expired or revoked), whichever call found out.
  constructor({ token, api = 'https://api.github.com', fetchImpl = fetch, onUnauthorized = null }) {
    this.token = token; this.api = api; this.fetchImpl = fetchImpl; this.onUnauthorized = onUnauthorized;
  }

  headers(body) {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Shellby',
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
  }

  async request(method, path, body) {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: this.headers(body),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.();
      const err = new Error(data?.message || `GitHub answered ${res.status}`);
      err.status = res.status;
      // "Validation Failed" says little: what failed is in errors[] ("A pull request already exists…").
      const detail = Array.isArray(data?.errors) ? data.errors.map(e => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean).join(' ') : '';
      if (detail) err.detail = detail.slice(0, 300);
      throw err;
    }
    return { data, scopes: res.headers.get('x-oauth-scopes') };
  }

  /**
   * Plain text (a job's log), the last `maxChars` of it. GitHub answers with a
   * redirect to short-lived signed storage, which is followed here by hand
   * with no sign-in header: the token never leaves for another host.
   */
  async text(path, { maxChars = 4000000 } = {}) {
    const url = `${this.api}${path}`;
    let res = await this.fetchImpl(url, { method: 'GET', headers: this.headers(), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const where = res.headers.get('location');
      const to = where ? new URL(where, url) : null;
      // https only (a dev mock on http may send you to http).
      if (!to || (to.protocol !== 'https:' && !(to.protocol === 'http:' && this.api.startsWith('http:')))) throw Object.assign(new Error('GitHub sent Shellby somewhere odd.'), { status: 502 });
      res = await this.fetchImpl(to.href, { method: 'GET', headers: { 'user-agent': 'Shellby' }, redirect: 'follow' });
    }
    if (!res.ok) {
      const err = new Error(`GitHub answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  get(path) { return this.request('GET', path).then(r => r.data); }
  post(path, body) { return this.request('POST', path, body).then(r => r.data); }
  patch(path, body) { return this.request('PATCH', path, body).then(r => r.data); }
  put(path, body) { return this.request('PUT', path, body).then(r => r.data); }
  delete(path) { return this.request('DELETE', path).then(r => r.data); }
}

module.exports = { GitHubApi };
