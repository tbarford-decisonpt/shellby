// Usage limits. When Claude Code reports that your plan's limit is reached,
// Shellby naps until it resets, then wakes up and taps you so queued work can
// go. Works from the rate-limit events Claude Code already sends (see
// stream.js usageFrom): { status, fiveHour: { pct, resetsAt }, sevenDay }.
//
// Pure: callers pass `now` (test/limits.test.js).

const WINDOWS = { fiveHour: '5-hour', sevenDay: 'weekly' };
const STALE_MS = 6 * 60 * 60 * 1000; // a reset missed longer ago than this isn't news
const MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Has a usage report hit the limit? Returns { window, resetsAt } for the
 * window that's holding you back (the later reset when both are full), or null.
 */
function limitFrom(u, now) {
  if (!u || typeof u !== 'object') return null;
  const full = Object.keys(WINDOWS)
    .map(window => ({ window, ...u[window] }))
    .filter(w => Number.isFinite(w.pct) && Number.isFinite(w.resetsAt) && w.resetsAt > now && w.resetsAt - now < MAX_WAIT_MS);
  const hit = full.filter(w => w.pct >= 100);
  // "rejected" without a full window: the fullest one is the reason.
  const blocking = hit.length ? hit : u.status === 'rejected' ? [...full].sort((a, b) => b.pct - a.pct).slice(0, 1) : [];
  if (!blocking.length) return null;
  const w = blocking.sort((a, b) => b.resetsAt - a.resetsAt)[0];
  return { window: w.window, resetsAt: w.resetsAt };
}

/** Does a usage report say you're clearly under the limit again? */
function cleared(u) {
  if (!u || u.status === 'rejected') return false;
  const wins = Object.keys(WINDOWS).map(k => u[k]).filter(w => w && Number.isFinite(w.pct));
  return wins.length > 0 && wins.every(w => w.pct < 100);
}

/** Tolerate anything read from disk: { window, resetsAt } or null. */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !WINDOWS[raw.window] || !Number.isFinite(raw.resetsAt)) return null;
  return { window: raw.window, resetsAt: raw.resetsAt };
}

/**
 * Where a saved wait stands now: 'waiting' (still limited), 'reset' (it reset
 * recently: tell them), or 'gone' (nothing, or a reset long past).
 */
function status(raw, now) {
  const w = normalize(raw);
  if (!w) return 'gone';
  if (now < w.resetsAt) return 'waiting';
  return now - w.resetsAt < STALE_MS ? 'reset' : 'gone';
}

/** "2h 05m", "14m", "40s" until the reset. */
function left(resetsAt, now) {
  const s = Math.max(0, Math.ceil((resetsAt - now) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.ceil(s / 60)}m`;
  return `${s}s`;
}

const windowName = w => WINDOWS[w] || 'usage';

module.exports = { limitFrom, cleared, normalize, status, left, windowName, STALE_MS };
