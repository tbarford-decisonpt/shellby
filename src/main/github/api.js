// A tiny GitHub REST client for Shellby's own calls (profile, gists, pack PRs).
// Base URLs are injectable so tests run against a local mock GitHub.
class GitHubApi {
  constructor({ token, api = 'https://api.github.com', fetchImpl = fetch }) {
    this.token = token; this.api = api; this.fetchImpl = fetchImpl;
  }

  async request(method, path, body) {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Shellby',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = new Error(data?.message || `GitHub answered ${res.status}`);
      err.status = res.status;
      // "Validation Failed" says little: what failed is in errors[] ("A pull request already exists…").
      const detail = Array.isArray(data?.errors) ? data.errors.map(e => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean).join(' ') : '';
      if (detail) err.detail = detail.slice(0, 300);
      throw err;
    }
    return { data, scopes: res.headers.get('x-oauth-scopes') };
  }

  get(path) { return this.request('GET', path).then(r => r.data); }
  post(path, body) { return this.request('POST', path, body).then(r => r.data); }
  patch(path, body) { return this.request('PATCH', path, body).then(r => r.data); }
  put(path, body) { return this.request('PUT', path, body).then(r => r.data); }
  delete(path) { return this.request('DELETE', path).then(r => r.data); }
}

module.exports = { GitHubApi };
