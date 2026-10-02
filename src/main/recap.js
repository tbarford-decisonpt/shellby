// "While you were away": when you come back after an hour or more, a short
// digest of what finished, what failed, what's waiting on you, and where the
// 5-hour usage window went.
//
// Three pieces, all pure (callers pass `now`; see test/recap.test.js):
//   - watch():  is anyone at the keyboard? Turns idle readings into "you left
//               at X and you're back now".
//   - record(): a small ledger of finished runs and usage readings, kept in
//               memory for the last day.
//   - build():  the digest for one absence, or null when nothing happened.
//
// Usage is attributed by difference. Claude Code only ever reports how full
// the window is, never what one turn cost, so each reading's rise over the
// one before is charged to the conversation that reported it. Claude Code
// running outside Shellby fills the same window, and its share lands on
// whichever tab reports next: the panel calls these numbers "about".

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const AWAY_MS = HOUR;            // gone at least this long earns a recap
const IDLE_MS = 2 * MINUTE;      // no input for this long and you've stepped away
const KEEP_MS = 24 * HOUR;       // the ledger forgets anything older
const MAX_EVENTS = 500;
const WINDOW_SLACK_MS = 10 * MINUTE; // two readings whose resets are this close share a window
const MAX_LISTED = 6;            // per section; the rest become "and N more"

/**
 * One idle reading. state: { since } (when you left, or null while you're here).
 * Returns { state, back } where back is { since, until } on the reading that
 * finds you returned after AWAY_MS or more, else null.
 *
 * The start of an absence is backdated to your last input, so a poll that runs
 * every minute (or a lock screen) still gets the real time you left.
 */
function watch(state, { now, idleMs = 0, locked = false }) {
  const since = Number.isFinite(state?.since) ? state.since : null;
  const idle = Math.max(0, Number(idleMs) || 0);
  if (locked || idle >= IDLE_MS) {
    const left = now - idle;
    return { state: { since: since === null ? left : Math.min(since, left) }, back: null };
  }
  if (since !== null && now - since >= AWAY_MS) return { state: { since: null }, back: { since, until: now } };
  return { state: { since: null }, back: null };
}

/** The ledger plus one event, trimmed to the last day. Never mutates `log`. */
function record(log, event, now) {
  const kept = (Array.isArray(log) ? log : []).filter(e => e.t > now - KEEP_MS);
  return [...kept, { t: now, ...event }].slice(-MAX_EVENTS);
}

/** A finished turn, as the ledger keeps it. outcome: 'ok' | 'error' | 'stopped'. */
function runEvent(tabId, title, outcome, { routine = false, error = null } = {}) {
  return { kind: 'run', tabId, title: String(title || 'Untitled'), outcome, routine: !!routine, error: error ? String(error).slice(0, 160) : null };
}

/** A usage reading for the 5-hour window, or null when the report has none. */
function usageEvent(tabId, title, usage) {
  const w = usage?.fiveHour;
  if (!w || !Number.isFinite(w.pct)) return null;
  return { kind: 'usage', tabId, title: String(title || 'Untitled'), pct: w.pct, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null };
}

// Same 5-hour window? Resets a few minutes apart are the same reset; with no
// reset time to go on, a falling number is the only sign of a new window.
function sameWindow(a, b) {
  if (Number.isFinite(a.resetsAt) && Number.isFinite(b.resetsAt)) return Math.abs(a.resetsAt - b.resetsAt) < WINDOW_SLACK_MS;
  return b.pct >= a.pct;
}

/**
 * Where the window went between since and until: { spent, from, to, resetsAt,
 * rolledOver, by: [{ tabId, title, pct }] } or null with no readings at all.
 * The last reading before `since` is the baseline; without one, the first
 * reading during the absence is (its level so far can't be put down to anyone).
 */
function usageDuring(log, since, until) {
  const points = log.filter(e => e.kind === 'usage' && e.t <= until);
  let prev = [...points].reverse().find(p => p.t < since) || null;
  const during = points.filter(p => p.t >= since);
  if (!during.length) return null;
  const from = prev ? prev.pct : during[0].pct;
  const by = new Map();
  let spent = 0, rolledOver = false;
  for (const p of during) {
    let rise = 0;
    if (prev && sameWindow(prev, p)) {
      // A late reading from another tab can be older than the last one; taking
      // it as the new baseline would charge the same rise twice.
      if (p.pct < prev.pct) continue;
      rise = p.pct - prev.pct;
    } else if (prev) { rise = p.pct; rolledOver = true; } // a fresh window starts from nothing
    if (rise > 0) {
      const had = by.get(p.tabId);
      by.set(p.tabId, { tabId: p.tabId, title: p.title, pct: (had?.pct || 0) + rise });
      spent += rise;
    }
    prev = p;
  }
  const last = prev; // the newest reading that counted
  return {
    spent, from, to: last.pct, resetsAt: last.resetsAt, rolledOver,
    by: [...by.values()].sort((a, b) => b.pct - a.pct),
  };
}

// One row per conversation: its latest outcome, and how many turns ended while you were out.
function runsDuring(log, since, until) {
  const latest = new Map();
  for (const e of log) {
    if (e.kind !== 'run' || e.t < since || e.t > until) continue;
    const had = latest.get(e.tabId);
    latest.set(e.tabId, { tabId: e.tabId, title: e.title, outcome: e.outcome, routine: e.routine, error: e.error, at: e.t, runs: (had?.runs || 0) + 1 });
  }
  return [...latest.values()].sort((a, b) => b.at - a.at);
}

const capped = list => ({ items: list.slice(0, MAX_LISTED), more: Math.max(0, list.length - MAX_LISTED) });

/**
 * The digest for one absence, or null when there's nothing worth saying.
 * waiting: [{ tabId, title, what: 'question' | 'approval', external? }], from
 * main.js at the moment you come back. limit: { window, resetsAt } while you're
 * held at a usage limit.
 */
function build(log, { since, until, waiting = [], limit = null }) {
  const runs = runsDuring(Array.isArray(log) ? log : [], since, until);
  const finished = runs.filter(r => r.outcome === 'ok');
  const failed = runs.filter(r => r.outcome === 'error');
  const usage = usageDuring(Array.isArray(log) ? log : [], since, until);
  if (!finished.length && !failed.length && !waiting.length && !usage?.spent && !limit) return null;
  return {
    since, until, awayMs: until - since,
    finished: capped(finished), failed: capped(failed), waiting: capped(waiting),
    usage: usage && (usage.spent || usage.rolledOver) ? { ...usage, by: usage.by.slice(0, MAX_LISTED) } : null,
    limit,
  };
}

/** "1h 20m", "3h", "2 days": how long you were gone. */
function awayFor(ms) {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m >= 48 * 60) return `${Math.floor(m / (24 * 60))} days`;
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${m}m`;
  return r ? `${h}h ${String(r).padStart(2, '0')}m` : `${h}h`;
}

/** One line for a notification: "3 finished · 1 failed · 2 waiting on you". */
function headline(d) {
  const total = s => s.items.length + s.more;
  const parts = [];
  if (total(d.finished)) parts.push(`${total(d.finished)} finished`);
  if (total(d.failed)) parts.push(`${total(d.failed)} failed`);
  if (total(d.waiting)) parts.push(`${total(d.waiting)} waiting on you`);
  if (d.usage?.spent) parts.push(`about ${d.usage.spent}% of your 5-hour window used`);
  if (!parts.length && d.limit) parts.push('Paused at your usage limit');
  return parts.join(' · ');
}

module.exports = {
  watch, record, runEvent, usageEvent, usageDuring, build, awayFor, headline,
  AWAY_MS, IDLE_MS, KEEP_MS, MAX_EVENTS, MAX_LISTED,
};
