// What Shellby already knows about each project, gathered for the Projects
// page: time this week, the last commit, dependency watch, flaky tests, pull
// request CI, its sticker, git and dev servers. Every source is read where it
// already lives; this only joins them to the projects by folder (or GitHub
// repository) and says which ones need you. Pure.
const path = require('path');
const { caseKey } = require('./merge');

const DAY = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 30;     // a quiet project only counts if you touched it this month
const MAX_PRS = 8;
const MAX_FLAKY = 8;
const MAX_SESSIONS = 5;

// How much each kind of trouble weighs when sorting by "needs attention".
const WEIGHT = Object.freeze({ down: 5, ci: 4, vulnHigh: 4, vuln: 2, unpushed: 2, flaky: 1, outdated: 1 });

const lower = s => String(s || '').toLowerCase();
const repoOf = p => (p.key.startsWith('github:') ? p.key.slice('github:'.length) : null);
const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
const maxOf = (list, f) => list.reduce((m, x) => Math.max(m, f(x) || 0), 0);

/** Is `dir` the folder `root` or inside it? Both case-folded the way merge.js does. */
function inside(dir, root) {
  if (typeof dir !== 'string' || typeof root !== 'string' || !dir || !root) return false;
  const d = caseKey(dir);
  const r = caseKey(root);
  return d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * sources: {
 *   now
 *   streaks:  { [caseKey(root)]: { lastSeen, lastCommitAt, muted } }, afterDays
 *   time:     null (tracking off) | { days: [dayKey], projects: [{ key: root, seconds, days: [{ day, seconds }] }] }
 *   deps:     [{ key: root, manager, label, ok, outdatedTotal, vulnTotal, vulns, summary, attention, worst, at, hasTests }]
 *   flaky:    [{ key, root, id, label, week, total, status, retry, lastAt }]
 *   prs:      [{ key, repo, number, title, state, failing, url }]
 *   stickers: [{ root, tierName, ships, marks: [{ icon, name }], art }]
 *   servers:  [{ root, status, port }]
 *   git:      Map(caseKey(root) -> { dirty, unpushed, stashes, copies })  (what's been read so far)
 * }
 * -> the facts for one project's row and page.
 */
function insightsFor(p, sources) {
  const s = sources || {};
  const now = s.now || Date.now();
  const roots = p.local.map(c => c.root);
  const keys = new Set(roots.map(caseKey));
  const own = root => typeof root === 'string' && keys.has(caseKey(root));

  const streaks = roots.map(r => s.streaks?.[caseKey(r)]).filter(Boolean);
  const lastCommitAt = maxOf(streaks, x => x.lastCommitAt) || null;
  const lastWorkedAt = Math.max(p.lastWorkedAt || 0, maxOf(streaks, x => x.lastSeen)) || null;
  const afterDays = Number.isFinite(s.afterDays) ? s.afterDays : 5;
  const quietDays = lastCommitAt ? Math.floor((now - lastCommitAt) / DAY) : null;
  const recent = lastWorkedAt && now - lastWorkedAt < RECENT_DAYS * DAY;

  const time = s.time ? weekOf(s.time, own) : null;
  // The latest check; of a folder's two managers (pnpm and Rust, say), the one that needs something.
  const deps = (s.deps || []).filter(r => own(r.key)).sort((a, b) => (b.at || 0) - (a.at || 0) || !!b.attention - !!a.attention)[0] || null;
  const flaky = (s.flaky || []).filter(r => own(r.root) && r.status !== 'fixed').slice(0, MAX_FLAKY);
  const repo = repoOf(p);
  const prs = repo ? (s.prs || []).filter(r => lower(r.repo) === repo).slice(0, MAX_PRS) : [];
  const sticker = (s.stickers || []).find(x => own(x.root)) || null;
  const servers = (s.servers || []).filter(x => own(x.root));
  const gits = roots.map(r => s.git?.get(caseKey(r))).filter(Boolean);
  const git = gits.length ? {
    dirty: sum(gits, g => g.dirty),
    unpushed: sum(gits, g => g.unpushed),
    stashes: sum(gits, g => g.stashes),
    copies: sum(gits, g => g.copies),
  } : null;

  const reasons = [];
  const down = servers.filter(x => x.status === 'crashed' || x.status === 'failed').length;
  if (down) reasons.push({ id: 'down', weight: WEIGHT.down, count: down });
  const failing = prs.filter(r => r.state === 'failing').length;
  if (failing) reasons.push({ id: 'ci', weight: WEIGHT.ci, count: failing });
  if (deps?.ok && deps.vulnTotal) {
    const high = (deps.vulns?.critical || 0) + (deps.vulns?.high || 0);
    reasons.push({ id: 'vuln', weight: high ? WEIGHT.vulnHigh : WEIGHT.vuln, count: deps.vulnTotal, worst: deps.worst || null });
  }
  if (git?.unpushed) reasons.push({ id: 'unpushed', weight: WEIGHT.unpushed, count: git.unpushed });
  const flakyWeek = flaky.filter(r => r.week > 0 && r.status !== 'quarantined').length;
  if (flakyWeek) reasons.push({ id: 'flaky', weight: WEIGHT.flaky, count: flakyWeek });
  if (deps?.ok && deps.outdatedTotal) reasons.push({ id: 'outdated', weight: WEIGHT.outdated, count: deps.outdatedTotal });

  return {
    lastWorkedAt, lastCommitAt,
    quiet: !!(recent && quietDays != null && quietDays >= afterDays && !streaks.some(x => x.muted)),
    quietDays,
    muted: streaks.length > 0 && streaks.every(x => x.muted),
    // The streaks entry (its folder) that nudges and "where did we leave off" go by.
    nudgeKey: roots.map(caseKey).find(k => s.streaks?.[k]) || null,
    time, deps, flaky, prs, sticker, git,
    reasons,
    attention: sum(reasons, r => r.weight),
  };
}

// This week's seconds for the clones in one project, day by day.
function weekOf(time, own) {
  const mine = (time.projects || []).filter(t => own(t.key));
  const byDay = new Map((time.days || []).map(d => [d, 0]));
  for (const t of mine) for (const d of t.days || []) if (byDay.has(d.day)) byDay.set(d.day, byDay.get(d.day) + (d.seconds || 0));
  return { seconds: sum(mine, t => t.seconds), days: [...byDay].map(([day, seconds]) => ({ day, seconds })) };
}

/** The list with each project's insights on it. */
function withInsights(projects, sources) {
  return projects.map(p => ({ ...p, insights: insightsFor(p, sources) }));
}

/**
 * The conversations that happened in a project: in one of its clones or in one
 * of Shellby's copies of it. sessions: History's index (newest first).
 */
function sessionsFor(sessions, roots, copies = []) {
  return sessionsIn(sessions, roots, copies)
    .slice(0, MAX_SESSIONS)
    .map(e => ({ id: e.id, title: e.title || 'Conversation', updatedAt: e.updatedAt || e.createdAt || 0, done: !!e.done, copy: !roots.some(r => inside(e.cwd, r)) }));
}

/**
 * Every History entry from a project, newest first: in a clone, in a copy
 * still on disk, or in a copy made from a clone that has since been cleaned
 * up (the entry keeps the folder it was copied from).
 */
function sessionsIn(sessions, roots, copies = []) {
  const places = [...roots, ...copies];
  return (Array.isArray(sessions) ? sessions : [])
    .filter(e => e && typeof e.id === 'string' && (places.some(r => inside(e.cwd, r)) || roots.some(r => inside(e.worktree?.originalCwd, r))))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

module.exports = { insightsFor, withInsights, sessionsFor, sessionsIn, inside, WEIGHT };
