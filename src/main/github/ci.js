// Shellby keeps an eye on your pull requests: when CI goes red he looks
// worried and holds up a sign, when a red build turns green he dances, and a
// review request makes him raise a claw. Polls GitHub with your sign-in (the
// profile scope is enough for public repos; private ones need the `repo` scope
// that "Let Claude tasks push" asks for).
//
// verdict() and transitions() are pure (test/ci.test.js); CiWatcher fetches.
const { EventEmitter } = require('events');

const POLL_MS = 3 * 60 * 1000;
const FIRST_POLL_MS = 15 * 1000;
const MAX_PRS = 10;
const MAX_REVIEWS = 10;
const MERGE_TRIES = 3;     // asking whether a closed PR was merged, before giving up
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

/**
 * One verdict for a commit from its check runs and commit statuses:
 * 'failing' | 'pending' | 'passing' | 'none'. Also the names of what failed.
 */
function verdict(checkRuns = [], statuses = []) {
  const failing = [];
  let pending = false, any = false;
  for (const r of Array.isArray(checkRuns) ? checkRuns : []) {
    any = true;
    if (r?.status !== 'completed') pending = true;
    else if (FAILED.has(r.conclusion)) failing.push(clip(r.name, 80) || 'check');
  }
  for (const s of Array.isArray(statuses) ? statuses : []) {
    any = true;
    if (s?.state === 'pending') pending = true;
    else if (s?.state === 'failure' || s?.state === 'error') failing.push(clip(s.context, 80) || 'status');
  }
  const state = failing.length ? 'failing' : pending ? 'pending' : any ? 'passing' : 'none';
  return { state, failing: [...new Set(failing)].slice(0, 8) };
}

/**
 * What changed between two polls. prev/next: { prs: { key: { state, wasFailing } }, reviews: [keys] }.
 * The first poll (prev null) only learns the lay of the land: no events.
 * Returns { events: [{ type: 'failed'|'fixed'|'passed'|'review', key }], memory, gone } where
 * memory carries wasFailing forward (a red build that goes pending, then green, is "fixed"),
 * and `fixed` stays set once it has been. gone: open PRs that are no longer open (merged or
 * closed; the watcher asks which), each with whether it was ever fixed.
 */
function transitions(prev, next) {
  const memory = {};
  const events = [];
  for (const [key, pr] of Object.entries(next.prs)) {
    const p = prev?.prs?.[key];
    const wasFailing = pr.state === 'failing' || (!!p?.wasFailing && pr.state !== 'passing');
    const fixedNow = !!prev && pr.state === 'passing' && !!p?.wasFailing;
    memory[key] = { state: pr.state, wasFailing, fixed: !!p?.fixed || fixedNow };
    if (!prev) continue;
    if (pr.state === 'failing' && p?.state !== 'failing') events.push({ type: 'failed', key });
    else if (fixedNow) events.push({ type: 'fixed', key });
    else if (pr.state === 'passing' && p?.state === 'pending') events.push({ type: 'passed', key });
  }
  if (prev) for (const key of next.reviews) if (!prev.reviews.includes(key)) events.push({ type: 'review', key });
  const gone = prev ? Object.keys(prev.prs || {}).filter(key => !next.prs[key]).map(key => ({ key, fixed: !!prev.prs[key].fixed, tries: prev.prs[key].tries || 0 })) : [];
  return { events, memory: { prs: memory, reviews: [...next.reviews] }, gone };
}

/** "owner/repo#12" for a search hit, or null if it doesn't look like GitHub's. */
function prRef(item, api) {
  const base = `${api}/repos/`;
  const repo = typeof item?.repository_url === 'string' && item.repository_url.startsWith(base) ? item.repository_url.slice(base.length) : '';
  if (!REPO_RE.test(repo) || !Number.isInteger(item.number) || item.number < 1) return null;
  return { key: `${repo}#${item.number}`, repo, number: item.number, title: clip(item.title, 120) };
}

class CiWatcher extends EventEmitter {
  /** gh: () => GitHubApi; login: () => string|null; web/api: GitHub base URLs (mockable). */
  constructor({ gh, login, web = 'https://github.com', api = 'https://api.github.com', now = () => Date.now() }) {
    super();
    Object.assign(this, { gh, login, web, api, now });
    this.timer = null;
    this.first = null;
    this.polling = null;
    this.epoch = 0;     // bumped by stop(), so a poll that was in flight discards its results
    this.memory = null;
    this.state = { prs: [], reviews: [], lastPollAt: null, error: null };
  }

  get running() { return !!this.timer; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), POLL_MS);
    this.first = setTimeout(() => this.poll().catch(() => {}), FIRST_POLL_MS);
  }

  stop() {
    this.epoch++;
    clearInterval(this.timer); clearTimeout(this.first);
    this.timer = null; this.first = null;
    this.memory = null;
    this.state = { prs: [], reviews: [], lastPollAt: null, error: null };
    this.emit('change', this.view());
  }

  view() {
    return { ...this.state, failing: this.state.prs.filter(p => p.state === 'failing').length };
  }

  url(repo, number) { return `${this.web}/${repo}/pull/${number}`; }

  poll() {
    if (this.polling) return this.polling;
    const epoch = this.epoch;
    this.polling = (async () => {
      try {
        const login = this.login();
        if (!login) return this.view();
        const gh = this.gh();
        const q = s => `/search/issues?q=${encodeURIComponent(s)}&per_page=`;
        const [mine, asked] = await Promise.all([
          gh.get(`${q(`is:pr is:open archived:false author:${login}`)}${MAX_PRS}`),
          gh.get(`${q(`is:pr is:open archived:false review-requested:${login}`)}${MAX_REVIEWS}`),
        ]);
        const refs = (mine?.items || []).map(i => prRef(i, this.api)).filter(Boolean).slice(0, MAX_PRS);
        const prs = await Promise.all(refs.map(r => this.check(gh, r)));
        const reviews = (asked?.items || []).map(i => prRef(i, this.api)).filter(Boolean).slice(0, MAX_REVIEWS)
          .map(r => ({ ...r, url: this.url(r.repo, r.number) }));
        if (epoch !== this.epoch) return this.view(); // stopped (signed out, turned off) meanwhile
        const { events, memory, gone } = transitions(this.memory, {
          prs: Object.fromEntries(prs.map(p => [p.key, { state: p.state }])),
          reviews: reviews.map(r => r.key),
        });
        // A PR that's no longer open was merged or closed: a merge ships its project.
        // One GitHub wouldn't tell us about is asked about again next time (a few times).
        const { merged, retry } = await this.mergedOf(gh, gone.slice(0, MAX_PRS));
        if (epoch !== this.epoch) return this.view();
        for (const g of retry) if (g.tries + 1 < MERGE_TRIES) memory.prs[g.key] = { state: 'gone', wasFailing: false, fixed: g.fixed, tries: g.tries + 1 };
        this.memory = memory;
        this.state = { prs, reviews, lastPollAt: this.now(), error: null };
        const find = key => prs.find(p => p.key === key) || reviews.find(r => r.key === key);
        for (const e of events) this.emit('event', { ...e, pr: find(e.key) });
        for (const pr of merged) this.emit('event', { type: 'merged', key: pr.key, pr });
        this.emit('change', this.view());
      } catch (e) {
        if (epoch !== this.epoch) return this.view();
        const out = e.status === 401;
        this.state = { ...this.state, ...(out ? { prs: [], reviews: [] } : {}), lastPollAt: this.now(), error: out ? 'GitHub signed Shellby out.' : `Couldn't check CI: ${clip(e.message, 120)}` };
        if (out) this.memory = null;
        this.emit('change', this.view());
      } finally {
        this.polling = null;
      }
      return this.view();
    })();
    return this.polling;
  }

  // Which of the PRs that left the open list were merged (not just closed):
  // { merged, retry }, retry being the ones GitHub didn't answer for.
  async mergedOf(gh, gone) {
    const was = new Map(this.state.prs.map(p => [p.key, p]));
    const out = [];
    const retry = [];
    for (const g of gone) {
      const m = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#(\d{1,9})$/.exec(g.key);
      if (!m || !REPO_RE.test(m[1])) continue;
      const pull = await gh.get(`/repos/${m[1]}/pulls/${m[2]}`).catch(() => null);
      if (!pull) { retry.push(g); continue; }
      if (!pull.merged_at) continue;
      const number = Number(m[2]);
      out.push({ key: g.key, repo: m[1], number, title: clip(pull.title, 120) || was.get(g.key)?.title || '', url: this.url(m[1], number), fixed: g.fixed });
    }
    return { merged: out, retry };
  }

  async check(gh, ref) {
    const base = `/repos/${ref.repo}`;
    // One PR GitHub won't show (an SSO-protected org, a moved repo) mustn't sink the others.
    const pull = await gh.get(`${base}/pulls/${ref.number}`).catch(() => null);
    const sha = typeof pull?.head?.sha === 'string' && /^[0-9a-f]{40}$/.test(pull.head.sha) ? pull.head.sha : null;
    // The branch, for a workflow that fixes it there (workflows: the ci trigger's trigger.branch).
    const branch = typeof pull?.head?.ref === 'string' && /^[\w./-]{1,200}$/.test(pull.head.ref) ? pull.head.ref : null;
    // Comments on its code (resolved ones too: only GraphQL says which), for "Address the review".
    const reviewComments = Number.isInteger(pull?.review_comments) && pull.review_comments > 0 ? pull.review_comments : 0;
    const out = { ...ref, url: this.url(ref.repo, ref.number), sha, branch, reviewComments };
    if (!sha) return { ...out, state: 'none', failing: [] };
    const [runs, status] = await Promise.all([
      gh.get(`${base}/commits/${sha}/check-runs?per_page=100`).catch(() => null),
      gh.get(`${base}/commits/${sha}/status`).catch(() => null),
    ]);
    return { ...out, ...verdict(runs?.check_runs, status?.statuses) };
  }
}

module.exports = { CiWatcher, verdict, transitions, prRef, POLL_MS };
