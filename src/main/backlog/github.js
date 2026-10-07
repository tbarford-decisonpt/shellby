// A repository's open issues and milestones, for its Next up list
// (docs/plans/next-up.md). Read when the project's page opens, never polled:
// telling you about new issues is the IssueWatcher's job (github/issues.js).
//
//   milestones   the open ones, soonest due first
//   issues       the 100 most recently updated, plus every one assigned to you
//                and every one in the nearest milestone (so a busy repository
//                doesn't hide those past the first page)
//
// Each issue goes through issues.js's issueRef, so titles and bodies are
// cleaned the same way the Issue helper's are.
//
// Takes gh as a dependency. test/backlog-github.test.js.
const { issueRef, clip, REPO_RE, LOGIN_RE } = require('../github/issues');
const { nearestMilestone } = require('./rank');

const PER_PAGE = 100;
const MAX_MILESTONES = 20;

const time = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

/** A milestone as GitHub gives it -> { number, title, dueOn, open, closed, url }, or null. */
function milestoneOf(m) {
  if (!m || typeof m !== 'object' || !Number.isInteger(m.number)) return null;
  return {
    number: m.number,
    title: clip(m.title, 80) || `Milestone ${m.number}`,
    dueOn: time(m.due_on),
    open: Number.isInteger(m.open_issues) ? m.open_issues : 0,
    closed: Number.isInteger(m.closed_issues) ? m.closed_issues : 0,
    url: typeof m.html_url === 'string' && /^https:\/\//.test(m.html_url) ? m.html_url : null,
  };
}

/** An issue from the REST list -> the item rank.js reads, or null (a pull request, or not GitHub's shape). */
function issueOf(raw, { api, web, login }) {
  const base = issueRef(raw, { api, web });
  if (!base) return null;
  const assignees = (Array.isArray(raw.assignees) ? raw.assignees : [])
    .map(a => a?.login).filter(l => typeof l === 'string' && LOGIN_RE.test(l)).slice(0, 10);
  const m = raw.milestone ? milestoneOf(raw.milestone) : null;
  return {
    ...base,
    assignees,
    mine: !!login && assignees.some(a => a.toLowerCase() === login.toLowerCase()),
    milestone: m ? { number: m.number, title: m.title, dueOn: m.dueOn } : null,
    comments: Number.isInteger(raw.comments) ? raw.comments : 0,
    thumbs: Number.isInteger(raw.reactions?.['+1']) ? raw.reactions['+1'] : 0,
    updatedAt: time(raw.updated_at),
  };
}

/** Several lists of the same issues -> one, by key, first seen wins. */
function combine(lists) {
  const byKey = new Map();
  for (const list of lists) for (const i of list) if (!byKey.has(i.key)) byKey.set(i.key, i);
  return [...byKey.values()];
}

/** What went wrong, in words for the card. */
function errorText(e) {
  if (e?.status === 401) return 'GitHub signed Shellby out.';
  if (e?.status === 404) return "Shellby can't see this repository's issues with your sign-in. Turn on Let Claude tasks push in Settings → GitHub.";
  if (e?.status === 410) return 'Issues are turned off for this repository.';
  if (e?.status === 403) return 'GitHub is limiting how often Shellby can ask. Try again in a few minutes.';
  return `Couldn't read its issues: ${clip(e?.message, 120) || 'GitHub didn\'t answer.'}`;
}

/**
 * -> { ok: true, issues, milestones } | { ok: false, error, status }
 *   deps: { gh, login, api, web }
 */
async function fetchBacklog(repo, { gh, login = null, api = 'https://api.github.com', web = 'https://github.com' }) {
  if (!REPO_RE.test(String(repo || ''))) return { ok: false, error: 'That isn\'t a GitHub repository.', status: 400 };
  let full = false; // the recent list came back a whole page long: there may be open issues past it
  const list = async (query, { counts = false } = {}) => {
    const r = await gh.get(`/repos/${repo}/issues?state=open&per_page=${PER_PAGE}&${query}`);
    const raw = Array.isArray(r) ? r : [];
    if (counts) full = raw.length >= PER_PAGE;
    return raw.map(i => issueOf(i, { api, web, login })).filter(Boolean);
  };
  try {
    const [rawMilestones, recent, mine] = await Promise.all([
      gh.get(`/repos/${repo}/milestones?state=open&sort=due_on&direction=asc&per_page=${MAX_MILESTONES}`),
      list('sort=updated&direction=desc', { counts: true }),
      login && LOGIN_RE.test(login) ? list(`assignee=${encodeURIComponent(login)}`) : Promise.resolve([]),
    ]);
    const milestones = (Array.isArray(rawMilestones) ? rawMilestones : []).map(milestoneOf).filter(Boolean);
    const nearest = nearestMilestone(milestones);
    const inNearest = nearest ? await list(`milestone=${nearest.number}`) : [];
    // complete: every open issue is in the list, so one that isn't has been closed.
    return { ok: true, issues: combine([mine, inNearest, recent]), milestones, complete: !full };
  } catch (e) {
    return { ok: false, error: errorText(e), status: e?.status || 0 };
  }
}

module.exports = { fetchBacklog, issueOf, milestoneOf, combine, errorText };
