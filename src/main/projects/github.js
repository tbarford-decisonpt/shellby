// Your repositories on GitHub, for the Projects page. Read with the sign-in you
// already have (github/service.js): public ones need no extra permission, and
// private ones appear only if `repo` was already granted for something else.
// Shellby never asks for more just for this list.
//
// Only a handful of fields are kept, each checked; nothing is written to disk.
const { checkRepo } = require('./remote');

const PER_PAGE = 100;
const MAX_PAGES = 3;
const CACHE_MS = 15 * 60 * 1000;

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, n) : '');

/** One page of `GET /user/repos` -> [{ repo, private, url, description, pushedAt, archived, fork }]. */
function parseRepos(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const r of data) {
    const repo = checkRepo(r?.full_name);
    if (!repo) continue;
    const url = `https://github.com/${repo}`;
    const pushedAt = Date.parse(r.pushed_at);
    out.push({
      repo,
      private: r.private === true,
      // Built from the checked name rather than taken from html_url.
      url,
      description: clip(r.description, 200),
      pushedAt: Number.isFinite(pushedAt) ? pushedAt : 0,
      archived: r.archived === true,
      fork: r.fork === true,
    });
  }
  return out;
}

/** gh: a GitHubApi (or anything with get(path)). -> [repo] (up to 300), or throws what the API threw. */
async function listRepos(gh, { maxPages = MAX_PAGES } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await gh.get(`/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=${PER_PAGE}&page=${page}`);
    const repos = parseRepos(data);
    all.push(...repos);
    if (!Array.isArray(data) || data.length < PER_PAGE) break;
  }
  const seen = new Set();
  return all.filter(r => !seen.has(r.repo.toLowerCase()) && seen.add(r.repo.toLowerCase()));
}

/** A 15-minute cache in front of listRepos, so opening the page doesn't hit the API each time. */
class RepoCache {
  constructor({ now = Date.now } = {}) { this.now = now; this.at = null; this.repos = []; this.error = null; this.loading = null; this.owner = null; }

  /** owner: whose list it is (the login), so signing in as someone else starts over. */
  async get(gh, owner, { force = false } = {}) {
    if (owner !== this.owner) { this.owner = owner; this.at = null; this.repos = []; }
    if (!force && this.at != null && this.now() - this.at < CACHE_MS) return this.repos;
    this.loading ||= listRepos(gh)
      .then(repos => { this.repos = repos; this.at = this.now(); this.error = null; return repos; })
      .catch(e => { this.error = String(e?.message || e).slice(0, 200); return this.repos; })
      .finally(() => { this.loading = null; });
    return this.loading;
  }

  clear() { this.at = null; this.repos = []; this.error = null; this.owner = null; }
}

module.exports = { parseRepos, listRepos, RepoCache, CACHE_MS };
