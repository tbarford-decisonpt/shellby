// Your GitLab merge requests, watched the way github/ci.js watches pull
// requests: a red pipeline makes him worry, a fixed one makes him dance, a
// review request makes him raise a claw, and the Projects page's inbox gets
// what's waiting on your review and what's new on yours.
//
// Everything goes through the glab CLI (glab.js) with the sign-in glab already
// has, on gitlab.com and any self-managed host you work with. Its view and
// events have github/ci.js's shape, with forge: 'gitlab', the host, and keys
// written GitLab's way ("group/project!12"), so the inbox, the CI sign,
// "Fix this build" and "Address the review" take both alike (ci-hub.js).
//
// pipelineState(), parseMr(), talkOf() and openDiscussions() are pure
// (test/gitlab.test.js); GitLabWatcher fetches.
const { EventEmitter } = require('events');
const { transitions } = require('../github/ci');
const comments = require('../github/comments');
const { checkPath, mrKey, mrUrl } = require('./remote');

const POLL_MS = 3 * 60 * 1000;
const FIRST_POLL_MS = 20 * 1000;
const MAX_MRS = 10;
const MAX_REVIEWS = 10;
const MERGE_TRIES = 3;
const AT_ONCE = 4;          // glab calls in flight per host
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./+-]{1,200}$/;
// GitLab usernames: letters, digits, _ . -, not starting with - (bots included: project_12_bot_ab12).
const LOGIN_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/;
const BOT_RE = /^(project|group)_\d+_bot(_[0-9a-f]+)?$|(^|[-_.])bot$/i;
const KEY_RE = /^.{1,600}![0-9]{1,9}$/;

const PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'waiting_for_callback']);

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const stamp = s => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const idOf = v => (Number.isInteger(v) && v > 0 ? v : null);
const login = u => (typeof u?.username === 'string' && LOGIN_RE.test(u.username) ? u.username : null);

/**
 * A pipeline's status -> 'failing' | 'pending' | 'passing' | 'none'. Cancelled,
 * skipped and manual (waiting on someone to press play) aren't a verdict.
 */
function pipelineState(status) {
  if (status === 'success') return 'passing';
  if (status === 'failed') return 'failing';
  if (PENDING.has(status)) return 'pending';
  return 'none';
}

/** The failed jobs' names, the ones that count (allow_failure jobs don't fail a pipeline). */
function failedJobs(jobs) {
  const names = (Array.isArray(jobs) ? jobs : [])
    .filter(j => j?.status === 'failed' && j.allow_failure !== true)
    .map(j => clip(j.name, 80) || 'job');
  return [...new Set(names)].slice(0, 8);
}

/**
 * One merge request from a list or a read of it, on `host` ->
 * { key, ref, repo, number, title, url, projectId, sourceProjectId, sha, branch, author, createdAt, updatedAt, draft, forge, host }
 * or null if it doesn't look like GitLab's.
 */
function parseMr(raw, host) {
  const iid = idOf(raw?.iid);
  const projectId = idOf(raw?.project_id);
  const full = typeof raw?.references?.full === 'string' ? raw.references.full : '';
  const at = full.lastIndexOf('!');
  const repo = at > 0 && full.slice(at + 1) === String(iid) ? checkPath(full.slice(0, at)) : null;
  if (!iid || !projectId || !repo) return null;
  return {
    key: mrKey(host, repo, iid),
    ref: `${repo}!${iid}`,
    repo, number: iid, title: clip(raw.title, 120),
    url: mrUrl(host, repo, iid),
    projectId, sourceProjectId: idOf(raw.source_project_id) || projectId,
    sha: typeof raw.sha === 'string' && SHA_RE.test(raw.sha) ? raw.sha : null,
    branch: typeof raw.source_branch === 'string' && BRANCH_RE.test(raw.source_branch) ? raw.source_branch : null,
    author: login(raw.author),
    createdAt: stamp(raw.created_at), updatedAt: stamp(raw.updated_at),
    draft: raw.draft === true || raw.work_in_progress === true,
    forge: 'gitlab', host,
  };
}

/**
 * A merge request's discussions -> comments.js's entries (oldest first), so the
 * inbox counts what's new the same way for both. System notes ("added 1
 * commit") aren't anyone talking; a bot's note on the conversation doesn't
 * count, a bot's note on the code does (as on GitHub).
 */
function talkOf(discussions) {
  const out = [];
  for (const d of Array.isArray(discussions) ? discussions : []) {
    for (const n of Array.isArray(d?.notes) ? d.notes : []) {
      if (!n || n.system) continue;
      const by = login(n.author);
      const at = stamp(n.created_at);
      if (!by || at === null) continue;
      const bot = n.author?.bot === true || BOT_RE.test(by);
      const kind = n.type === 'DiffNote' || n.position ? 'line' : 'comment';
      if (kind === 'comment' && bot) continue;
      out.push({ at, by, kind, bot });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-300);
}

/** Threads someone still has to answer: resolvable, and not every note in them resolved. */
function openDiscussions(discussions) {
  return (Array.isArray(discussions) ? discussions : []).filter(d => {
    const notes = (Array.isArray(d?.notes) ? d.notes : []).filter(n => n && !n.system);
    const resolvable = notes.filter(n => n.resolvable);
    return resolvable.length > 0 && resolvable.some(n => !n.resolved);
  });
}

/** Reviewers' states -> 'changes' | 'approved' | null, leaving yours out. */
function verdictOf(reviewers, me) {
  const others = (Array.isArray(reviewers) ? reviewers : []).filter(r => login(r?.user) && login(r.user).toLowerCase() !== String(me || '').toLowerCase());
  if (others.some(r => r.state === 'requested_changes')) return 'changes';
  if (others.some(r => r.state === 'approved')) return 'approved';
  return null;
}

/** config.gitlabSeen -> { key: ms }: when you last opened or marked each merge request read. */
function normalizeSeen(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw).slice(0, MAX_MRS * 8)) if (KEY_RE.test(k) && Number.isFinite(v) && v > 0) out[k] = v;
  return out;
}

// fn over each item, a few at a time.
async function each(list, fn, n = AT_ONCE) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}

/** In words, why a host gave nothing. */
function whyNot(e, host) {
  if (e?.missing) return 'glab isn\'t installed. Get it from gitlab.com/gitlab-org/cli, then run glab auth login.';
  if (e?.signedOut) return `glab isn't signed in to ${host}. Run glab auth login${host === 'gitlab.com' ? '' : ` --hostname ${host}`}.`;
  return `Couldn't check ${host}: ${clip(e?.message, 120) || 'glab failed'}`;
}

const EMPTY = () => ({ prs: [], reviews: [], reviewsTotal: 0, lastPollAt: null, error: null, hosts: [] });

class GitLabWatcher extends EventEmitter {
  /**
   * api(host): a GlabApi (or a stand-in). hosts(): the GitLab hosts to look at
   * (gitlab.com, ones you listed, ones your clones point at), or a promise of them.
   * seen: { load, save } for config.gitlabSeen.
   */
  constructor({ api, hosts, now = () => Date.now(), seen = null }) {
    super();
    Object.assign(this, { api, hosts, now });
    this.seenStore = seen || { load: () => null, save: () => {} };
    this.seen = normalizeSeen(this.seenStore.load());
    this.talk = new Map(); // key -> { updatedAt, list, open, verdict }
    this.timer = null;
    this.first = null;
    this.polling = null;
    this.epoch = 0;
    this.memory = null;
    this.logins = new Map(); // host -> username
    this.state = EMPTY();
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
    this.state = EMPTY();
    this.emit('change', this.view());
  }

  view() {
    return {
      ...this.state,
      failing: this.state.prs.filter(p => p.state === 'failing').length,
      unread: this.state.prs.filter(p => p.talk?.unread > 0).length,
    };
  }

  /** Your username on a host, as the last poll learned it. */
  loginOn(host) { return this.logins.get(host) || null; }

  markSeen(key) {
    const pr = this.state.prs.find(p => p.key === key);
    if (!pr) return false;
    const cached = this.talk.get(key);
    const newest = cached?.list?.length ? cached.list[cached.list.length - 1].at : 0;
    this.seen = { ...this.seen, [key]: Math.max(this.now(), newest) };
    this.seenStore.save(this.seen);
    const talk = cached ? this.summary(cached, pr.host, key) : pr.talk;
    this.state = { ...this.state, prs: this.state.prs.map(p => (p.key === key ? { ...p, talk } : p)) };
    this.emit('change', this.view());
    return true;
  }

  summary(cached, host, key = null) {
    const me = this.loginOn(host);
    const s = comments.summarize(cached.list, me, this.seen[key] || 0);
    return { ...s, verdict: cached.verdict ?? s.verdict };
  }

  poll() {
    if (this.polling) return this.polling;
    const epoch = this.epoch;
    this.polling = (async () => {
      try {
        const hosts = [...new Set((await this.hosts()) || [])];
        const results = await Promise.all(hosts.map(host => this.pollHost(host).then(r => ({ host, ...r }), e => ({ host, error: e }))));
        if (epoch !== this.epoch) return this.view();
        const ok = results.filter(r => !r.error);
        // One host you aren't signed in to (gitlab.com, when your work is on your own) is no error while another answers.
        const shown = ok.length ? results.filter(r => r.error && !r.error.signedOut && !r.error.missing) : results.filter(r => r.error);
        const error = shown.length ? whyNot(shown[0].error, shown[0].host) : null;
        const prs = ok.flatMap(r => r.prs);
        const reviews = ok.flatMap(r => r.reviews);
        const reviewsTotal = ok.reduce((n, r) => n + r.reviewsTotal, 0);
        // Worked out again now: a "Mark read" while this poll was out must not come undone.
        for (const [i, p] of prs.entries()) {
          const cached = this.talk.get(p.key);
          if (cached) prs[i] = { ...p, talk: this.summary(cached, p.host, p.key), reviewComments: cached.open };
        }
        const unreadBefore = new Map(this.state.prs.map(p => [p.key, p.talk?.unread || 0]));
        const firstPoll = !this.memory;
        // A host that didn't answer this time keeps what it had, rather than everything on it "closing".
        const silent = new Set(results.filter(r => r.error).map(r => r.host));
        const kept = this.state.prs.filter(p => silent.has(p.host));
        const keptReviews = this.state.reviews.filter(p => silent.has(p.host));
        const allPrs = [...prs, ...kept];
        const allReviews = [...reviews, ...keptReviews];
        const { events, memory, gone } = transitions(this.memory, {
          prs: Object.fromEntries(allPrs.map(p => [p.key, { state: p.state }])),
          reviews: allReviews.map(r => r.key),
        });
        const { merged, retry } = await this.mergedOf(gone.slice(0, MAX_MRS));
        if (epoch !== this.epoch) return this.view();
        for (const g of retry) if (g.tries + 1 < MERGE_TRIES) memory.prs[g.key] = { state: 'gone', wasFailing: false, fixed: g.fixed, tries: g.tries + 1, ...this.whereOf(g.key) };
        // Where each one lives, so one that closes can be asked about.
        for (const p of allPrs) if (memory.prs[p.key]) Object.assign(memory.prs[p.key], { host: p.host, projectId: p.projectId, repo: p.repo, number: p.number, title: p.title });
        this.memory = memory;
        this.forget(allPrs);
        this.state = {
          prs: allPrs, reviews: allReviews, reviewsTotal: reviewsTotal + keptReviews.length, lastPollAt: this.now(), error,
          hosts: results.map(r => ({ host: r.host, login: r.error ? null : r.login, error: r.error ? whyNot(r.error, r.host) : null, missing: !!r.error?.missing })),
        };
        const find = key => allPrs.find(p => p.key === key) || allReviews.find(r => r.key === key);
        for (const e of events) this.emit('event', { ...e, pr: find(e.key) });
        for (const pr of merged) this.emit('event', { type: 'merged', key: pr.key, pr });
        if (!firstPoll) for (const pr of allPrs) if ((pr.talk?.unread || 0) > (unreadBefore.get(pr.key) || 0)) this.emit('event', { type: 'comment', key: pr.key, pr });
        this.emit('change', this.view());
      } catch (e) {
        if (epoch !== this.epoch) return this.view();
        this.state = { ...this.state, lastPollAt: this.now(), error: `Couldn't check GitLab: ${clip(e?.message, 120)}` };
        this.emit('change', this.view());
      } finally {
        this.polling = null;
      }
      return this.view();
    })();
    return this.polling;
  }

  whereOf(key) {
    const m = this.memory?.prs?.[key];
    return m ? { host: m.host, projectId: m.projectId, repo: m.repo, number: m.number, title: m.title } : {};
  }

  // One host: who you are there, your open merge requests with their pipelines and talk, and the ones waiting on you.
  async pollHost(host) {
    const gl = this.api(host);
    const me = await gl.get('user');
    const username = login(me);
    const userId = idOf(me?.id);
    if (!username || !userId) throw Object.assign(new Error(`${host} didn't say who you are`), { status: 502 });
    this.logins.set(host, username);
    const [mine, asked] = await Promise.all([
      gl.get(`merge_requests?scope=created_by_me&state=opened&order_by=updated_at&per_page=${MAX_MRS}`),
      gl.get(`merge_requests?scope=all&state=opened&reviewer_id=${userId}&order_by=updated_at&per_page=${MAX_REVIEWS}`),
    ]);
    const list = (raw, max) => (Array.isArray(raw) ? raw : []).map(m => parseMr(m, host)).filter(Boolean).slice(0, max);
    const checked = await each(list(mine, MAX_MRS), mr => this.check(gl, mr));
    const prs = await each(checked, mr => this.withTalk(gl, mr, username));
    const reviews = list(asked, MAX_REVIEWS).filter(r => r.author?.toLowerCase() !== username.toLowerCase());
    return { login: username, prs, reviews, reviewsTotal: reviews.length };
  }

  // Its pipeline: the merge request's own read says which, and how it went.
  async check(gl, mr) {
    const full = await gl.get(`projects/${mr.projectId}/merge_requests/${mr.number}`).catch(() => null);
    const fresh = full ? parseMr(full, mr.host) : null;
    const base = { ...mr, ...(fresh ? { sha: fresh.sha || mr.sha, branch: fresh.branch || mr.branch, title: fresh.title || mr.title, updatedAt: fresh.updatedAt || mr.updatedAt } : {}), reviewComments: 0 };
    const pipe = full?.head_pipeline;
    const state = pipelineState(pipe?.status);
    const pipelineId = idOf(pipe?.id);
    const pipelineProject = idOf(pipe?.project_id) || mr.projectId;
    if (state !== 'failing' || !pipelineId) return { ...base, state, failing: [], pipelineId, pipelineProject };
    const jobs = await gl.get(`projects/${pipelineProject}/pipelines/${pipelineId}/jobs?scope[]=failed&per_page=100`).catch(() => null);
    return { ...base, state, failing: failedJobs(jobs), pipelineId, pipelineProject };
  }

  // What's been said, read again only when GitLab says the merge request moved.
  async withTalk(gl, mr, me) {
    let cached = this.talk.get(mr.key);
    const moved = mr.updatedAt || 0;
    if (!cached || cached.updatedAt !== moved) {
      const [discussions, reviewers] = await Promise.all([
        gl.get(`projects/${mr.projectId}/merge_requests/${mr.number}/discussions?per_page=100`).catch(() => null),
        gl.get(`projects/${mr.projectId}/merge_requests/${mr.number}/reviewers`).catch(() => null),
      ]);
      if (Array.isArray(discussions)) {
        cached = { updatedAt: moved, list: talkOf(discussions), open: openDiscussions(discussions).length, verdict: verdictOf(reviewers, me) };
        this.talk.set(mr.key, cached);
      }
    }
    return { ...mr, reviewComments: cached?.open || 0, talk: cached ? this.summary(cached, mr.host, mr.key) : null };
  }

  // Which merge requests that left the open list were merged: { merged, retry }.
  async mergedOf(gone) {
    const out = [];
    const retry = [];
    for (const g of gone) {
      const w = { ...this.whereOf(g.key), ...(this.state.prs.find(p => p.key === g.key) || {}) };
      if (!w.host || !w.projectId || !w.number) continue;
      const mr = await this.api(w.host).get(`projects/${w.projectId}/merge_requests/${w.number}`).catch(() => null);
      if (!mr) { retry.push(g); continue; }
      if (mr.state !== 'merged') continue;
      out.push({ key: g.key, ref: `${w.repo}!${w.number}`, repo: w.repo, number: w.number, title: clip(mr.title, 120) || w.title || '', url: mrUrl(w.host, w.repo, w.number), fixed: g.fixed, forge: 'gitlab', host: w.host });
    }
    return { merged: out, retry };
  }

  forget(prs) {
    const open = new Set(prs.map(p => p.key));
    for (const key of this.talk.keys()) if (!open.has(key)) this.talk.delete(key);
    const kept = Object.fromEntries(Object.entries(this.seen).filter(([k]) => open.has(k)));
    if (Object.keys(kept).length !== Object.keys(this.seen).length) { this.seen = kept; this.seenStore.save(kept); }
  }
}

module.exports = { GitLabWatcher, pipelineState, failedJobs, parseMr, talkOf, openDiscussions, verdictOf, normalizeSeen, whyNot, POLL_MS };
