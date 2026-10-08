// GitLab through the glab CLI: `glab api` with the sign-in you already gave
// glab (`glab auth login`), for gitlab.com and any self-managed host it knows.
// Shellby never sees or keeps a GitLab token: glab holds it, and every call is
// glab's own, with fixed arguments and no shell.
//
// A GlabApi is bound to one host and answers like github/api.js's GitHubApi
// (get, text), so what reads it can be tested with a stand-in.
const os = require('os');
const { execFile } = require('child_process');

const CALL_MS = 30000;
const MAX_JSON = 16 * 1024 * 1024;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*(?::\d{1,5})?$/;
// What `glab api` is given: an API path under /api/v4, never a full URL or a flag,
// and no colon, which glab would read as a placeholder (:id) to fill from a repository.
const PATH_RE = /^(?![-/])[A-Za-z0-9_.~%/?&=[\]+,-]{1,1500}$/;

const firstLine = s => String(s || '').trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || '';

/** A host as glab names it ("gitlab.com", "gitlab.example.org:8443"), or null. */
function checkHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return HOST_RE.test(h) ? h : null;
}

/** The HTTP status glab's error names ("404 Not Found", "HTTP 401"), or null. */
function statusOf(text) {
  const t = String(text || '');
  const m = /\bHTTP\s*([45]\d\d)\b/.exec(t)
    || /\b([45]\d\d)\s+(?:Not Found|Unauthorized|Forbidden|Bad Request|Gone|Conflict|Unprocessable|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.exec(t);
  return m ? Number(m[1]) : null;
}

/**
 * Run glab once. -> { ok, out, error, missing } (missing: glab isn't installed,
 * or isn't on PATH). Nothing it says is shown to Claude, only to you.
 */
function runGlab(args, { timeout = CALL_MS, maxBuffer = MAX_JSON } = {}) {
  return new Promise(resolve => {
    execFile('glab', args, {
      windowsHide: true, timeout, maxBuffer, encoding: 'utf8',
      // Outside any repository, so glab never picks a host or project from where Shellby runs.
      cwd: os.homedir(),
      env: { ...process.env, NO_PROMPT: '1', NO_COLOR: '1', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, out: String(stdout || '') });
      resolve({ ok: false, out: String(stdout || ''), error: firstLine(stderr) || err.message || 'glab failed', missing: err.code === 'ENOENT' });
    });
  });
}

class GlabApi {
  /** host: which GitLab ("gitlab.com"). run: runGlab, or a stand-in in tests. */
  constructor({ host = 'gitlab.com', run = runGlab } = {}) {
    const h = checkHost(host);
    if (!h) throw new Error('That isn\'t a GitLab host name.');
    this.host = h;
    this.run = run;
  }

  /** The web address of a page on this host. */
  web(rest = '') { return `https://${this.host}${rest ? `/${String(rest).replace(/^\/+/, '')}` : ''}`; }

  async call(path, opts) {
    const p = String(path || '').replace(/^\/+/, '');
    if (!PATH_RE.test(p)) throw Object.assign(new Error('Shellby asked glab for an odd path.'), { status: 400 });
    const r = await this.run(['api', p, '--hostname', this.host], opts);
    if (r.ok) return r.out;
    const status = r.missing ? null : statusOf(r.error);
    const err = new Error(r.missing ? 'glab isn\'t installed' : r.error);
    err.status = status;
    err.missing = !!r.missing;
    // Not signed in to this host at all: glab says so before it asks GitLab anything.
    err.signedOut = status === 401 || /auth(entication)?\s+(required|login)|no token|not (logged|signed) in|glab auth login/i.test(r.error || '');
    throw err;
  }

  /** GET an API path (projects/12/merge_requests/3) -> its JSON. */
  async get(path) {
    const out = await this.call(path);
    try { return out.trim() ? JSON.parse(out) : null; } catch { throw Object.assign(new Error('glab answered with something that isn\'t JSON.'), { status: 502 }); }
  }

  /** Plain text (a job's log), the last `maxChars` of it. */
  async text(path, { maxChars = 4000000 } = {}) {
    const out = await this.call(path, { maxBuffer: Math.max(MAX_JSON, maxChars * 4) });
    return out.length > maxChars ? out.slice(-maxChars) : out;
  }
}

module.exports = { GlabApi, runGlab, checkHost, statusOf };
