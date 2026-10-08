// The Projects page's inbox: one list, across every repository, of what's
// waiting on you. Pull requests you've been asked to review, your own with
// something new said on them (both from github/ci.js), branches gone stale
// (branches.js) and copies Shellby made that nobody has gone back to.
//
// Only joins and words what's been read elsewhere. Pure.
const { caseKey } = require('./merge');
const { inside } = require('./insights');

const DAY = 24 * 60 * 60 * 1000;
const ABANDON_DAYS = 3;     // a copy whose conversation is closed and quiet this long
const MAX_EACH = 20;

/** The key a dismissal is filed under: it comes back if the thing moves (a new commit, more work). */
const branchId = (root, name, at) => `b:${caseKey(root)}|${name}|${at || 0}`;
const copyId = (path, at) => `c:${caseKey(path)}|${at || 0}`;

// The newest History entry that worked in this copy.
function sessionIn(sessions, path) {
  return sessions
    .filter(e => e && typeof e.id === 'string' && ((e.worktree?.path && caseKey(e.worktree.path) === caseKey(path)) || inside(e.cwd, path)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

/**
 * input: {
 *   now
 *   ci:        ci.view() + enabled  (prs with talk, reviews, reviewsTotal, error)
 *   repos:     [{ project, root, read: branches.read() | null, git: { copyList } | null }]
 *   sessions:  History's index
 *   open:      [folder] every open tab works in: a copy one of them is in isn't abandoned
 *   dismissed: Set of ids
 * }
 */
function build({ now = Date.now(), ci = null, repos = [], sessions = [], open = [], dismissed = new Set() } = {}) {
  const on = !!ci?.enabled;
  const reviews = on ? (ci.reviews || []).map(r => ({
    key: r.key, repo: r.repo, number: r.number, title: r.title, url: r.url,
    author: r.author || null, updatedAt: r.updatedAt || null, draft: !!r.draft,
  })) : [];
  const talk = on ? (ci.prs || []).filter(p => p.talk?.unread > 0).map(p => ({
    key: p.key, repo: p.repo, number: p.number, title: p.title, url: p.url, state: p.state,
    unread: p.talk.unread, people: p.talk.people || [], lastAt: p.talk.lastAt, verdict: p.talk.verdict,
  })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)) : [];

  const branches = [];
  const copies = [];
  for (const r of repos) {
    for (const b of r.read?.branches || []) {
      const id = branchId(r.root, b.name, b.at);
      if (dismissed.has(id)) continue;
      branches.push({ id, project: r.project, root: r.root, name: b.name, at: b.at, merged: !!b.merged, gone: !!b.gone, only: b.only });
    }
    const dirty = new Map((r.git?.copyList || []).map(w => [caseKey(w.path), w.changed || 0]));
    for (const c of r.read?.copies || []) {
      if (open.some(p => inside(p, c.path))) continue;
      const s = sessionIn(sessions, c.path);
      const lastAt = Math.max(c.at || 0, s?.updatedAt || 0) || null;
      if (!lastAt || now - lastAt < ABANDON_DAYS * DAY) continue;
      const id = copyId(c.path, lastAt);
      if (dismissed.has(id)) continue;
      const changed = dirty.has(caseKey(c.path)) ? dirty.get(caseKey(c.path)) : null;
      copies.push({
        id, project: r.project, root: r.root, path: c.path, branch: c.branch, lastAt,
        changed, merged: c.merged, only: c.only,
        // Nothing would be lost: no uncommitted files, and every commit is somewhere else too.
        empty: changed === 0 && c.only === 0,
        sessionId: s?.id || null, title: s?.title || null,
      });
    }
  }
  branches.sort((a, b) => Number(b.merged) - Number(a.merged) || (a.at || 0) - (b.at || 0));
  copies.sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0));

  const out = {
    github: { enabled: on, error: on ? ci.error || null : null, lastPollAt: on ? ci.lastPollAt || null : null },
    reviews: reviews.slice(0, MAX_EACH),
    reviewsMore: on ? Math.max(0, (ci.reviewsTotal || 0) - reviews.length) : 0,
    talk: talk.slice(0, MAX_EACH),
    branches: branches.slice(0, MAX_EACH),
    branchesMore: Math.max(0, branches.length - MAX_EACH),
    copies: copies.slice(0, MAX_EACH),
  };
  out.total = out.reviews.length + out.reviewsMore + out.talk.length + branches.length + copies.length;
  return out;
}

module.exports = { build, branchId, copyId, ABANDON_DAYS };
