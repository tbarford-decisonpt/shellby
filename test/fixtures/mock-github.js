// A small in-memory GitHub for tests: the device flow, /user, gists, just
// enough of the repos API for publishing a pack (fork, ref, contents, pulls),
// and your open pull requests with their CI (search, pulls, check runs).
//   const gh = await startMockGitHub({ login: 'crabfan' }); ... gh.approve(); ... await gh.close();
const http = require('http');

async function startMockGitHub({ login = 'crabfan', autoApprove = false } = {}) {
  const state = {
    login, approved: autoApprove, denied: false, requestedScope: '', token: 'gho_mocktoken123',
    gists: new Map(), files: new Map(), refs: new Map([['x-salmon/shellby-packs:main', 'basesha1']]),
    forks: new Set(), pulls: [], requests: [], nextGist: 1,
    // Your open pull requests and the ones waiting for your review (see setCi()).
    ci: { prs: [], reviews: [] },
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const json = (() => { try { return body ? JSON.parse(body) : {}; } catch { return {}; } })();
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      state.requests.push({ method: req.method, path: p, body: json, auth: req.headers.authorization || '' });
      const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      const authed = req.headers.authorization === `Bearer ${state.token}`;

      // ---- device flow (web host)
      if (req.method === 'POST' && p === '/login/device/code') {
        state.requestedScope = json.scope || '';
        return send(200, { device_code: 'dev-code', user_code: 'CRAB-1234', verification_uri: `${base}/login/device`, interval: 1, expires_in: 60 });
      }
      if (req.method === 'POST' && p === '/login/oauth/access_token') {
        if (state.denied) return send(200, { error: 'access_denied' });
        if (!state.approved) return send(200, { error: 'authorization_pending' });
        return send(200, { access_token: state.token, token_type: 'bearer', scope: state.requestedScope.split(' ').join(',') });
      }

      // ---- api
      if (!authed) return send(401, { message: 'Bad credentials' });
      if (req.method === 'GET' && p === '/user') return send(200, { login: state.login, name: 'Crab Fan', avatar_url: 'https://example.invalid/a.png' }, { 'x-oauth-scopes': state.requestedScope.split(' ').join(', ') });

      if (p === '/gists' && req.method === 'GET') return send(200, [...state.gists.values()].map(g => ({ id: g.id, files: Object.fromEntries(Object.keys(g.files).map(f => [f, { filename: f }])) })));
      if (p === '/gists' && req.method === 'POST') {
        const id = `g${state.nextGist++}`;
        const files = Object.fromEntries(Object.entries(json.files || {}).map(([f, v]) => [f, { content: v.content, size: v.content.length }]));
        state.gists.set(id, { id, public: json.public, files });
        return send(201, { id });
      }
      let m = p.match(/^\/gists\/([^/]+)$/);
      if (m) {
        const g = state.gists.get(decodeURIComponent(m[1]));
        if (!g) return send(404, { message: 'Not Found' });
        if (req.method === 'PATCH') for (const [f, v] of Object.entries(json.files || {})) g.files[f] = { content: v.content, size: v.content.length };
        return send(200, g);
      }

      // ---- your pull requests and their CI
      if (req.method === 'GET' && p === '/search/issues') {
        const q = url.searchParams.get('q') || '';
        const hit = pr => ({ number: pr.number, title: pr.title, repository_url: `${base}/repos/${pr.repo}` });
        return send(200, { items: (q.includes('review-requested:') ? state.ci.reviews : state.ci.prs).map(hit) });
      }
      m = p.match(/^\/repos\/([^/]+\/[^/]+)\/(pulls\/(\d+)|commits\/([0-9a-f]{40})\/(check-runs|status))$/);
      const ciPr = m && state.ci.prs.find(pr => pr.repo === m[1] && (m[3] ? pr.number === Number(m[3]) : pr.sha === m[4]));
      if (ciPr) {
        if (m[3]) return send(200, { number: ciPr.number, head: { sha: ciPr.sha } });
        if (m[5] === 'status') return send(200, { state: 'success', statuses: [] });
        const done = ciPr.conclusion !== 'pending';
        return send(200, { check_runs: [{ name: 'test', status: done ? 'completed' : 'in_progress', conclusion: done ? ciPr.conclusion : null }] });
      }

      m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (m) {
        const repo = `${m[1]}/${m[2]}`;
        const rest = m[3] || '';
        const exists = repo === 'x-salmon/shellby-packs' || state.forks.has(repo);
        if (!exists && !(rest === '/forks')) return send(404, { message: 'Not Found' });
        if (rest === '' && req.method === 'GET') return send(200, { full_name: repo, default_branch: 'main' });
        if (rest === '/forks' && req.method === 'POST') { const f = `${state.login}/shellby-packs`; state.forks.add(f); state.refs.set(`${f}:main`, 'basesha1'); return send(202, { full_name: f }); }
        if (rest.startsWith('/git/ref/heads/')) {
          const sha = state.refs.get(`${repo}:${decodeURIComponent(rest.slice('/git/ref/heads/'.length))}`);
          return sha ? send(200, { object: { sha } }) : send(404, { message: 'Not Found' });
        }
        if (rest === '/git/refs' && req.method === 'POST') {
          const name = String(json.ref).replace('refs/heads/', '');
          if (state.refs.has(`${repo}:${name}`)) return send(422, { message: 'Reference already exists' });
          state.refs.set(`${repo}:${name}`, json.sha);
          return send(201, { ref: json.ref });
        }
        if (rest === '/merge-upstream' && req.method === 'POST') return send(200, {});
        const c = rest.match(/^\/contents\/(.+)$/);
        if (c) {
          const filePath = decodeURIComponent(c[1]);
          const ref = url.searchParams.get('ref') || json.branch || 'main';
          const key = `${repo}:${ref}:${filePath}`;
          if (req.method === 'GET') {
            const f = state.files.get(key);
            return f ? send(200, { sha: f.sha, content: f.content, encoding: 'base64' }) : send(404, { message: 'Not Found' });
          }
          if (req.method === 'PUT') {
            const prev = state.files.get(key);
            if (prev && json.sha !== prev.sha) return send(409, { message: 'sha mismatch' });
            state.files.set(key, { sha: `sha-${state.files.size + 1}`, content: json.content, message: json.message });
            return send(201, { content: { path: filePath } });
          }
        }
        if (rest === '/pulls' && req.method === 'POST') {
          const number = state.pulls.length + 1;
          state.pulls.push({ number, ...json });
          return send(201, { number, html_url: `https://github.com/${repo}/pull/${number}` });
        }
      }
      return send(404, { message: `mock: no route for ${req.method} ${p}` });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, state,
    approve() { state.approved = true; },
    deny() { state.denied = true; },
    /** Put a published pack on the gallery's main branch. */
    publish(id, json) { state.files.set(`x-salmon/shellby-packs:main:packs/${id}/pack.json`, { sha: 'pubsha', content: Buffer.from(JSON.stringify(json)).toString('base64') }); },
    /** Your open PRs: [{ repo, number, title, conclusion: 'success'|'failure'|'pending' }], and review requests. */
    setCi(prs, reviews = state.ci.reviews) {
      state.ci = { prs: prs.map((pr, i) => ({ ...pr, sha: (pr.sha || String(i + 1)).padEnd(40, 'a') })), reviews };
    },
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { startMockGitHub };

// `node test/fixtures/mock-github.js` runs one for manual/e2e use and prints its base URL.
if (require.main === module) {
  startMockGitHub({ autoApprove: process.argv.includes('--approve') }).then(gh => console.log(gh.base));
}
