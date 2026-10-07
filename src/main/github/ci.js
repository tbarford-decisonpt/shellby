// Shellby keeps an eye on your pull requests: when CI goes red he looks
// worried and holds up a sign, when a red build turns green he dances, and a
// review request makes him raise a claw. Polls GitHub with your sign-in (the
// profile scope is enough for public repos; private ones need the `repo` scope
// that "Let Claude tasks push" asks for).
//
// It also keeps the Projects page's inbox: pull requests waiting on your
// review (who asked, how long ago), and new comments on yours (comments.js).
//
// verdict() and transitions() are pure (test/ci.test.js); CiWatcher fetches.
const { EventEmitter } = require('events');
const comments = require('./comments');

const POLL_MS = 3 * 60 * 1000;
const FIRST_POLL_MS = 15 * 1000;
const MAX_PRS = 10;
const MAX_REVIEWS = 10;
const MERGE_TRIES = 3;     // asking whether a closed PR was merged, before giving up
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const KEY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#\d{1,9}$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

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

/** What a search hit says about who opened it and when: { author, createdAt, updatedAt, draft }. */
function searchFacts(item) {
  const at = s => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
  const author = typeof item?.user?.login === 'string' && LOGIN_RE.test(item.user.login) ? item.user.login : null;
  return { author, createdAt: at(item?.created_at), updatedAt: at(item?.updated_at), draft: item?.draft === true };
}

/** config.ciSeen -> { 'owner/repo#12': ms }: when you last opened or marked each PR read. */
function normalizeSeen(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw).slice(0, MAX_PRS * 4)) if (KEY_RE.test(k) && Number.isFinite(v) && v > 0) out[k] = v;
  return out;
}

class CiWatcher extends EventEmitter {
  /**
   * gh: () => GitHubApi; login: () => string|null; web/api: GitHub base URLs (mockable).
   * seen: { load, save } for when each PR was last opened or marked read (config.ciSeen).
   */
  constructor({ gh, login, web = 'https://github.com', api = 'https://api.github.com', now = () => Date.now(), seen = null }) {
    super();
    Object.assign(this, { gh, login, web, api, now });
    this.seenStore = seen || { load: () => null, save: () => {} };
    this.seen = normalizeSeen(this.seenStore.load());
    this.talk = new Map(); // key -> { updatedAt, list }: comments.read() again only when the PR moved
    this.timer = null;
    this.first = null;
    this.polling = null;
    this.epoch = 0;     // bumped by stop(), so a poll that was in flight discards its results
    this.memory = null;
    this.state = { prs: [], reviews: [], reviewsTotal: 0, lastPollAt: null, error: null };
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
    this.talk.clear();
    this.state = { prs: [], reviews: [], reviewsTotal: 0, lastPollAt: null, error: null };
    this.emit('change', this.view());
  }

  view() {
    return {
      ...this.state,
      failing: this.state.prs.filter(p => p.state === 'failing').length,
      unread: this.state.prs.filter(p => p.talk?.unread > 0).length,
    };
  }

  /** You've seen what's been said on this PR (opened it, or marked it read). */
  markSeen(key) {
    const pr = this.state.prs.find(p => p.key === key);
    if (!pr) return false;
    // GitHub's clock, not only this PC's: one running slow mustn't leave what you just read unread.
    const list = this.talk.get(key)?.list;
    const newest = list?.length ? list[list.length - 1].at : 0;
    this.seen = { ...this.seen, [key]: Math.max(this.now(), newest) };
    this.seenStore.save(this.seen);
    const talk = list ? comments.summarize(list, this.login(), this.seen[key]) : pr.talk;
    this.state = { ...this.state, prs: this.state.prs.map(p => (p.key === key ? { ...p, talk } : p)) };
    this.emit('change', this.view());
    return true;
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
        const hits = (list, max) => (list?.items || []).map(i => { const r = prRef(i, this.api); return r && { ...r, ...searchFacts(i) }; }).filter(Boolean).slice(0, max);
        const checked = await Promise.all(hits(mine, MAX_PRS).map(r => this.check(gh, r)));
        const prs = await Promise.all(checked.map(p => this.withTalk(gh, p, login)));
        const reviews = hits(asked, MAX_REVIEWS).map(r => ({ ...r, url: this.url(r.repo, r.number) }));
        const reviewsTotal = Number.isInteger(asked?.total_count) ? Math.max(asked.total_count, reviews.length) : reviews.length;
        if (epoch !== this.epoch) return this.view(); // stopped (signed out, turned off) meanwhile
        // Worked out again now: a "Mark read" while this poll was out must not come undone.
        for (const [i, p] of prs.entries()) {
          const list = this.talk.get(p.key)?.list;
          if (list) prs[i] = { ...p, talk: comments.summarize(list, login, this.seen[p.key] || 0) };
        }
        const unreadBefore = new Map(this.state.prs.map(p => [p.key, p.talk?.unread || 0]));
        const firstPoll = !this.memory;
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
        this.forget(prs);
        this.state = { prs, reviews, reviewsTotal, lastPollAt: this.now(), error: null };
        const find = key => prs.find(p => p.key === key) || reviews.find(r => r.key === key);
        for (const e of events) this.emit('event', { ...e, pr: find(e.key) });
        for (const pr of merged) this.emit('event', { type: 'merged', key: pr.key, pr });
        // Someone said something new on one of yours (the first poll only learns what's there).
        if (!firstPoll) for (const pr of prs) if ((pr.talk?.unread || 0) > (unreadBefore.get(pr.key) || 0)) this.emit('event', { type: 'comment', key: pr.key, pr });
        this.emit('change', this.view());
      } catch (e) {
        if (epoch !== this.epoch) return this.view();
        const out = e.status === 401;
        this.state = { ...this.state, ...(out ? { prs: [], reviews: [], reviewsTotal: 0 } : {}), lastPollAt: this.now(), error: out ? 'GitHub signed Shellby out.' : `Couldn't check CI: ${clip(e.message, 120)}` };
        if (out) { this.memory = null; this.talk.clear(); }
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
    // The conversation's own comments, and when anything last happened on it (withTalk reads them when it moves).
    const comments = Number.isInteger(pull?.comments) && pull.comments > 0 ? pull.comments : 0;
    const movedAt = typeof pull?.updated_at === 'string' ? pull.updated_at.slice(0, 40) : null;
    const out = { ...ref, url: this.url(ref.repo, ref.number), sha, branch, reviewComments, comments, movedAt };
    if (!sha) return { ...out, state: 'none', failing: [] };
    const [runs, status] = await Promise.all([
      gh.get(`${base}/commits/${sha}/check-runs?per_page=100`).catch(() => null),
      gh.get(`${base}/commits/${sha}/status`).catch(() => null),
    ]);
    return { ...out, ...verdict(runs?.check_runs, status?.statuses) };
  }

  // What's been said on it since you last had your say: read again only when
  // GitHub says the PR moved; one GitHub won't show keeps what was read before.
  async withTalk(gh, pr, login) {
    let cached = this.talk.get(pr.key);
    if (pr.movedAt && cached?.updatedAt !== pr.movedAt) {
      const list = await comments.read(gh, pr.repo, pr.number, { comments: pr.comments, lineComments: pr.reviewComments });
      if (list) { cached = { updatedAt: pr.movedAt, list }; this.talk.set(pr.key, cached); }
    }
    const { movedAt: _moved, comments: _count, ...rest } = pr;
    return { ...rest, talk: cached ? comments.summarize(cached.list, login, this.seen[pr.key] || 0) : null };
  }

  // PRs no longer open: their comments and read marks go.
  forget(prs) {
    const open = new Set(prs.map(p => p.key));
    for (const key of this.talk.keys()) if (!open.has(key)) this.talk.delete(key);
    const kept = Object.fromEntries(Object.entries(this.seen).filter(([k]) => open.has(k)));
    if (Object.keys(kept).length !== Object.keys(this.seen).length) { this.seen = kept; this.seenStore.save(kept); }
  }
}

module.exports = { CiWatcher, verdict, transitions, prRef, searchFacts, normalizeSeen, POLL_MS };
