// Who has said what on your open pull requests since you last answered, for
// the Projects page's inbox. "New" means newer than both your own last word on
// the pull request (a comment or a review) and the last time you opened it from
// Shellby or marked it read: a reply on github.com clears it without Shellby
// having to be told.
//
// Comments by bots on the conversation (deploy previews, coverage) don't count;
// a bot's review or line comment does, since that's someone reviewing the code.
// A review with no text of its own is only the wrapper for its line comments,
// which are counted already.
//
// entries() and summarize() are pure (test/comments.test.js); read() fetches.

const PAGE = 100;
const MAX_ENTRIES = 300;
const MAX_PEOPLE = 3;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

const lower = s => String(s || '').toLowerCase();
const stamp = s => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const isBot = user => user?.type === 'Bot' || /\[bot\]$/.test(user?.login || '');

/** One GitHub comment or review -> { at, by, kind, state? } | null. */
function entry(raw, kind) {
  const by = typeof raw?.user?.login === 'string' && LOGIN_RE.test(raw.user.login) ? raw.user.login : null;
  const at = stamp(kind === 'review' ? raw?.submitted_at : raw?.created_at);
  if (!by || at === null) return null;
  return { at, by, kind, bot: isBot(raw.user) };
}

/**
 * GitHub's three lists for one pull request -> one list, oldest first:
 * [{ at, by, kind: 'comment'|'line'|'review', bot, state? }].
 */
function entries({ comments = [], lineComments = [], reviews = [] } = {}) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const e = entry(c, 'comment');
    if (e && !e.bot) out.push(e);
  }
  for (const c of Array.isArray(lineComments) ? lineComments : []) {
    const e = entry(c, 'line');
    if (e) out.push(e);
  }
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (!REVIEW_STATES.has(r?.state)) continue; // PENDING: a draft only its author can see
    const e = entry(r, 'review');
    if (!e) continue;
    const said = typeof r.body === 'string' && r.body.trim();
    if (r.state === 'COMMENTED' && !said) { out.push({ ...e, wrapper: true }); continue; }
    out.push({ ...e, state: r.state });
  }
  return out.sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES);
}

/**
 * Where the conversation on one pull request stands for `me`:
 * { unread, lastAt, people: [logins], verdict: 'approved'|'changes'|null }.
 * seenAt: when you last opened it from Shellby or marked it read (ms, or 0).
 */
function summarize(list, me, seenAt = 0) {
  const mine = lower(me);
  const all = Array.isArray(list) ? list : [];
  // A wrapper review is still you having your say (you answered in line comments).
  const spoke = all.filter(e => lower(e.by) === mine).reduce((t, e) => Math.max(t, e.at), 0);
  const since = Math.max(spoke, Number.isFinite(seenAt) ? seenAt : 0);
  const fresh = all.filter(e => lower(e.by) !== mine && !e.wrapper && e.at > since);
  const people = [...new Set(fresh.slice().reverse().map(e => e.by))].slice(0, MAX_PEOPLE);
  // The newest approve / request-changes from anyone else, as GitHub shows it.
  const last = all.filter(e => lower(e.by) !== mine && (e.state === 'APPROVED' || e.state === 'CHANGES_REQUESTED')).pop();
  return {
    unread: fresh.length,
    lastAt: fresh.length ? fresh[fresh.length - 1].at : null,
    people,
    verdict: last ? (last.state === 'APPROVED' ? 'approved' : 'changes') : null,
  };
}

/**
 * The three lists for one pull request, newest page of each (GitHub lists
 * oldest first). counts: { comments, lineComments } from the pull itself.
 * -> entries() | null when GitHub wouldn't say.
 */
async function read(gh, repo, number, { comments = 0, lineComments = 0 } = {}) {
  const page = n => Math.max(1, Math.ceil(n / PAGE));
  const base = `/repos/${repo}`;
  try {
    const [c, l, r] = await Promise.all([
      comments > 0 ? gh.get(`${base}/issues/${number}/comments?per_page=${PAGE}&page=${page(comments)}`) : [],
      lineComments > 0 ? gh.get(`${base}/pulls/${number}/comments?per_page=${PAGE}&page=${page(lineComments)}`) : [],
      gh.get(`${base}/pulls/${number}/reviews?per_page=${PAGE}`),
    ]);
    return entries({ comments: c, lineComments: l, reviews: r });
  } catch {
    return null;
  }
}

module.exports = { entries, summarize, read };
