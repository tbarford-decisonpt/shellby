// Your pull requests on GitHub (github/ci.js) and merge requests on GitLab
// (gitlab/watcher.js) as one watcher, so everything that reads d.ci (the
// inbox, the CI sign, "Fix this build", the Health card, standups) takes both
// without knowing there are two.
//
// Each item says which forge it's on (forge: 'github' | 'gitlab') and how to
// name it (ref: "owner/repo#12" or "group/project!12"). Keys never collide:
// GitHub's have "#", GitLab's "!". Pure apart from the watchers it's given.
const { EventEmitter } = require('events');
const { isMrKey } = require('./gitlab/remote');

const tag = p => ({ ...p, forge: p.forge || 'github', ref: p.ref || `${p.repo}#${p.number}` });
const EMPTY = { prs: [], reviews: [], reviewsTotal: 0, lastPollAt: null, error: null };

class CiHub extends EventEmitter {
  /** github, gitlab: watchers with view(), poll(), markSeen(), stop() and 'change' / 'event'. */
  constructor({ github = null, gitlab = null } = {}) {
    super();
    this.github = github;
    this.gitlab = gitlab;
    for (const w of [github, gitlab].filter(Boolean)) {
      w.on('change', () => this.emit('change', this.view()));
      w.on('event', e => this.emit('event', e.pr ? { ...e, pr: tag(e.pr) } : e));
    }
  }

  get running() { return !!(this.github?.running || this.gitlab?.running); }

  /** The watcher a key belongs to. */
  of(key) { return isMrKey(key) ? this.gitlab : this.github; }

  view() {
    const a = this.github ? this.github.view() : EMPTY;
    const b = this.gitlab ? this.gitlab.view() : EMPTY;
    const prs = [...a.prs, ...b.prs].map(tag);
    return {
      prs,
      reviews: [...a.reviews, ...b.reviews].map(tag),
      reviewsTotal: (a.reviewsTotal || 0) + (b.reviewsTotal || 0),
      lastPollAt: Math.max(a.lastPollAt || 0, b.lastPollAt || 0) || null,
      // GitHub's error stays where it always was; GitLab's has its own place.
      error: a.error || null,
      failing: prs.filter(p => p.state === 'failing').length,
      unread: prs.filter(p => p.talk?.unread > 0).length,
      gitlab: { running: !!this.gitlab?.running, error: b.error || null, lastPollAt: b.lastPollAt || null, hosts: b.hosts || [] },
    };
  }

  markSeen(key) { return !!this.of(key)?.markSeen(key); }

  /** Check now: each watcher that's on. */
  async poll() {
    await Promise.all([this.github, this.gitlab].filter(w => w?.running).map(w => w.poll().catch(() => null)));
    return this.view();
  }

  stop() { this.github?.stop(); this.gitlab?.stop(); }
}

module.exports = { CiHub };
