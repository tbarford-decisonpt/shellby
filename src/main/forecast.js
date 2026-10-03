// Usage-window forecast: "at this pace you'll hit the limit around 3:40; it
// resets at 4:15". Built from the 5-hour readings recap.js already keeps, so
// it costs nothing extra: no polling, no API calls of its own.
//
// Pace is the rise over the last hour of readings in the current window,
// straight-line. Claude Code reports whole percents, a reading per call, so a
// pace needs a span of time and a real rise before it means anything; and
// one with no reading for a while is about work that has stopped, not work in
// progress. Claude Code used outside Shellby fills the same window and shows
// up in the next reading here, so the pace includes it.
//
// Pure: callers pass `now` (test/forecast.test.js).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const LOOKBACK_MS = HOUR;         // the pace is the rise over this long
const MIN_SPAN_MS = 10 * MINUTE;  // readings closer together than this are too few to call it a pace
const MIN_RISE = 3;               // percentage points: less is rounding, not a trend
const STALE_MS = 20 * MINUTE;     // no reading for this long: nothing's running, so no pace
const HORIZON_MS = 2 * HOUR;      // a hit further off than this is too uncertain to warn about
const MIN_GAP_MS = 10 * MINUTE;   // stopped for less than this before the reset isn't worth a warning
const ROUND_MS = 5 * MINUTE;      // "around 3:40", not "3:43"
const WINDOW_SLACK_MS = 10 * MINUTE; // resets this close are the same window (as recap.js)

const sameWindow = (a, b) => Math.abs(a.resetsAt - b.resetsAt) < WINDOW_SLACK_MS;

/**
 * Where the 5-hour window is heading, from the recap ledger: { pct, resetsAt,
 * perHour, hitAt, warn } or null when there's no current pace to go on.
 *
 * hitAt is when the window fills at this pace, rounded down to five minutes
 * (never before now). warn is true when that's soon (within HORIZON_MS) and
 * well before the reset (by MIN_GAP_MS or more): worth telling you about.
 */
function outlook(log, now) {
  const points = (Array.isArray(log) ? log : [])
    .filter(e => e && e.kind === 'usage' && Number.isFinite(e.t) && Number.isFinite(e.pct) && Number.isFinite(e.resetsAt) && e.t <= now)
    .sort((a, b) => a.t - b.t);
  if (!points.length) return null;
  const last = points[points.length - 1];
  if (last.resetsAt <= now || now - last.t > STALE_MS) return null;

  const recent = points.filter(p => p.t >= last.t - LOOKBACK_MS && sameWindow(p, last));
  const first = recent[0];
  // Tabs report independently, so a late one can carry an older, lower level.
  const pct = Math.max(...recent.map(p => p.pct));
  if (pct >= 100) return null; // full already: limits.js takes it from here
  const span = last.t - first.t;
  const rise = pct - first.pct;
  if (span < MIN_SPAN_MS || rise < MIN_RISE) return null;

  const perMs = rise / span;
  const exact = last.t + (100 - pct) / perMs;
  const hitAt = Math.max(now, Math.floor(exact / ROUND_MS) * ROUND_MS);
  const warn = hitAt - now <= HORIZON_MS && last.resetsAt - hitAt >= MIN_GAP_MS;
  return { pct, resetsAt: last.resetsAt, perHour: Math.round(perMs * HOUR), hitAt, warn };
}

/**
 * The warning, in words. clock(t) formats a time ("3:40 PM"); it's passed in
 * so main.js and the panel say times the same way.
 */
function message(o, now, clock) {
  const when = o.hitAt - now < ROUND_MS * 2 ? 'in the next few minutes' : `around ${clock(o.hitAt)}`;
  return `At this pace you'll hit your 5-hour limit ${when}. It resets at ${clock(o.resetsAt)}.`;
}

module.exports = {
  outlook, message,
  LOOKBACK_MS, MIN_SPAN_MS, MIN_RISE, STALE_MS, HORIZON_MS, MIN_GAP_MS,
};
