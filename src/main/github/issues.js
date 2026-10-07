// Issues Shellby could take a crack at: open issues assigned to you, and ones
// labelled `shellby` in repositories you can push to. A new one starts the
// workflows with an Issue trigger (workflows/triggers.js); what happens next
// (asking you, a copy, a draft pull request) is up to the workflow.
//
// The label is only looked for in your own repositories and the ones cloned on
// this PC (a global `label:shellby` search would let anyone on GitHub hand him
// work), and only counts where you can push: where you could open the pull
// request yourself. Whoever has triage there can still label an issue, which
// is why the template asks you first.
//
// Search only says what's open now, sorted by when it last changed. So an
// issue he hasn't seen is checked against its own history before it's
// offered: it must have been assigned to you, or labelled, since he started
// watching. An old issue that shows up because another closed (or someone
// commented) isn't offered; one assigned while Shellby was closed is.
//
// queries(), issueRef(), fresh(), combine() and becameOurs() are pure (test/issues.test.js).
const { EventEmitter } = require('events');

const POLL_MS = 5 * 60 * 1000;
const FIRST_POLL_MS = 30 * 1000;
const MAX_ISSUES = 20;     // per search
const MAX_SEEN = 400;
const MAX_CHECKS = 5;      // unseen issues looked into per poll; the rest wait for the next one
const MAX_QUERY = 240;     // GitHub refuses search queries over 256 characters
const MAX_REPO_QUERIES = 2; // cloned repos past these aren't searched for the label
const BODY_MAX = 4000;
const LABEL = 'shellby';
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/; // no . or .. segments
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
// Bidi overrides and invisible characters too: a title shows in notifications
// and the "take a crack at it?" question, where they could make it read as something else.
const clip = (s, n) => (typeof s === 'string'
  ? s.replace(/[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, n)
  : '');
// An issue's body keeps its lines; everything else that could hide text goes.
const clipBody = s => (typeof s === 'string'
  ? s.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, '').trim().slice(0, BODY_MAX)
  : '');

/**
 * The searches for one poll: [{ reason, q }]. repos: owner/name of the
 * projects cloned here (ones you own are already covered by user:).
 */
function queries(login, repos = []) {
  if (!LOGIN_RE.test(login || '')) return [];
  const base = 'is:issue is:open archived:false';
  const out = [
    { reason: 'assigned', q: `${base} assignee:${login}` },
    { reason: 'labelled', q: `${base} label:${LABEL} user:${login}` },
  ];
  const own = `${login.toLowerCase()}/`;
  const others = [...new Set((repos || []).filter(r => REPO_RE.test(r || '') && !r.toLowerCase().startsWith(own)))];
  let q = `${base} label:${LABEL}`;
  let n = 0;
  for (const r of others) {
    if (`${q} repo:${r}`.length > MAX_QUERY) {
      if (q.includes(' repo:')) out.push({ reason: 'labelled', q });
      if (++n >= MAX_REPO_QUERIES) return out;
      q = `${base} label:${LABEL}`;
    }
    q += ` repo:${r}`;
  }
  if (q.includes(' repo:')) out.push({ reason: 'labelled', q });
  return out;
}

/** A search hit -> the issue as workflows see it, or null (a pull request, or not GitHub's shape). */
function issueRef(item, { api, web }) {
  if (!item || typeof item !== 'object' || item.pull_request) return null;
  const base = `${api}/repos/`;
  const repo = typeof item.repository_url === 'string' && item.repository_url.startsWith(base) ? item.repository_url.slice(base.length) : '';
  if (!REPO_RE.test(repo) || !Number.isInteger(item.number) || item.number < 1) return null;
  const labels = (Array.isArray(item.labels) ? item.labels : [])
    .map(l => clip(typeof l === 'string' ? l : l?.name, 50)).filter(Boolean).slice(0, 20);
  const author = typeof item.user?.login === 'string' && LOGIN_RE.test(item.user.login) ? item.user.login : '';
  return {
    key: `${repo}#${item.number}`,
    repo,
    number: item.number,
    title: clip(item.title, 200),
    body: clipBody(item.body),
    labels,
    author,
    url: `${web}/${repo}/issues/${item.number}`,
  };
}

/**
 * Which of this poll's issues he hasn't seen. state: { primed, primedAt, seen: [keys] }.
 * Unprimed (the first poll ever, or after the feature was off) only learns.
 * Nothing is marked seen here: the caller does that once it has looked (see()).
 * -> { unseen: [issue], state }
 */
function fresh(state, issues, now) {
  if (!state?.primed) return { unseen: [], state: see({ primed: true, primedAt: now, seen: [] }, issues.map(i => i.key)) };
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  // Kept from before primedAt was: counts from now.
  const primedAt = Number.isFinite(state.primedAt) ? state.primedAt : now;
  return { unseen: issues.filter(i => !seen.has(i.key)), state: { primed: true, primedAt, seen: [...seen] } };
}

/** Remember these keys, newest first, so the oldest fall off the end. */
function see(state, keys) {
  return { ...state, seen: [...new Set([...keys, ...(state.seen || [])])].slice(0, MAX_SEEN) };
}

/** The same issue found by several searches -> one, with every reason it was found for. */
function combine(results) {
  const byKey = new Map();
  for (const { reason, issues } of results) {
    for (const i of issues) {
      const have = byKey.get(i.key);
      if (have) { if (!have.reasons.includes(reason)) have.reasons.push(reason); } else byKey.set(i.key, { ...i, reasons: [reason] });
    }
  }
  return [...byKey.values()];
}

/**
 * Of the reasons an issue was found for, the ones that happened at or after
 * `since`, from its events: assigned to `login`, or the label added.
 */
function becameOurs(events, reasons, login, since) {
  const out = new Set();
  for (const e of Array.isArray(events) ? events : []) {
    const at = Date.parse(e?.created_at);
    if (!Number.isFinite(at) || at < since) continue;
    if (e.event === 'assigned' && reasons.includes('assigned') && same(e.assignee?.login, login)) out.add('assigned');
    if (e.event === 'labeled' && reasons.includes('labelled') && same(e.label?.name, LABEL)) out.add('labelled');
  }
  return reasons.filter(r => out.has(r));
}

class IssueWatcher extends EventEmitter {
  /**
   * gh: () => GitHubApi; login: () => string|null; repos: () => Promise<[owner/name]>
   * (projects cloned here); load/save: what he has seen (config); web/api: GitHub (mockable).
   */
  constructor({ gh, login, repos = async () => [], load, save, web = 'https://github.com', api = 'https://api.github.com', now = () => Date.now() }) {
    super();
    Object.assign(this, { gh, login, repos, load, save, web, api, now });
    this.timer = null;
    this.first = null;
    this.polling = null;
    this.epoch = 0;
    this.pushable = new Map(); // repo -> can you push there (asked once per session)
    this.state = { issues: [], lastPollAt: null, error: null };
  }

  get running() { return !!this.timer; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), POLL_MS);
    this.first = setTimeout(() => this.poll().catch(() => {}), FIRST_POLL_MS);
  }

  /** Turned off or signed out: forget what he's seen, so turning it on again doesn't offer a backlog. */
  stop() {
    this.epoch++;
    clearInterval(this.timer); clearTimeout(this.first);
    this.timer = null; this.first = null;
    this.pushable.clear();
    this.save({ primed: false, seen: [] });
    this.state = { issues: [], lastPollAt: null, error: null };
    this.emit('change', this.view());
  }

  view() {
    return { ...this.state, issues: this.state.issues.map(({ body: _body, ...i }) => i) };
  }

  async canPush(gh, repo, login) {
    if (repo.toLowerCase().startsWith(`${login.toLowerCase()}/`)) return true;
    if (!this.pushable.has(repo)) {
      const info = await gh.get(`/repos/${repo}`).catch(() => null);
      if (!info) return false; // asked again next time
      this.pushable.set(repo, !!info.permissions?.push);
    }
    return this.pushable.get(repo);
  }

  // Why an unseen issue is his to offer now, or [] if it isn't; null if GitHub didn't say (try again).
  async why(gh, issue, login, since) {
    // The first 100 events: an issue busier than that is rarely a new one.
    const events = await gh.get(`/repos/${issue.repo}/issues/${issue.number}/events?per_page=100`).catch(() => null);
    if (!Array.isArray(events)) return null;
    const reasons = becameOurs(events, issue.reasons, login, since);
    if (reasons.includes('labelled') && !(await this.canPush(gh, issue.repo, login))) return reasons.filter(r => r !== 'labelled');
    return reasons;
  }

  poll() {
    if (this.polling) return this.polling;
    const epoch = this.epoch;
    this.polling = (async () => {
      try {
        const login = this.login();
        if (!login) return this.view();
        const gh = this.gh();
        // A failure here fails the poll: priming without the cloned repos would offer their issues next time.
        const repos = await this.repos();
        const results = await Promise.all(queries(login, repos).map(async ({ reason, q }) => {
          const r = await gh.get(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${MAX_ISSUES}`);
          return { reason, issues: (r?.items || []).map(i => issueRef(i, this)).filter(Boolean) };
        }));
        if (epoch !== this.epoch) return this.view();
        const issues = combine(results);
        const { unseen, state } = fresh(this.load(), issues, this.now());
        const offers = [];
        const looked = [];
        for (const issue of unseen.slice(0, MAX_CHECKS)) {
          const reasons = await this.why(gh, issue, login, state.primedAt);
          if (!reasons) continue;
          looked.push(issue.key);
          if (reasons.length) offers.push({ ...issue, reasons });
        }
        if (epoch !== this.epoch) return this.view();
        this.save(see(state, looked));
        this.state = { issues, lastPollAt: this.now(), error: null };
        for (const issue of offers) this.emit('event', { type: issue.reasons[0], issue });
        this.emit('change', this.view());
      } catch (e) {
        if (epoch !== this.epoch) return this.view();
        const out = e.status === 401;
        this.state = { ...this.state, ...(out ? { issues: [] } : {}), lastPollAt: this.now(), error: out ? 'GitHub signed Shellby out.' : `Couldn't check issues: ${clip(e.message, 120)}` };
        this.emit('change', this.view());
      } finally {
        this.polling = null;
      }
      return this.view();
    })();
    return this.polling;
  }
}

module.exports = { IssueWatcher, queries, issueRef, fresh, see, combine, becameOurs, clip, clipBody, LABEL, POLL_MS, REPO_RE, LOGIN_RE };
