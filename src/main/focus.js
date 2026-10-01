// Focus sessions: "Shellby, guard my focus for 25 minutes." He puts on a helmet
// and stands guard, Shellby holds back the notifications that can wait, and
// when time's up he curls up for a short break. A finished session earns XP,
// counts toward the streak and toward the Deep Focus trophy.
//
// Pure: no timers, no I/O, callers pass `now` (test/focus.test.js). The session
// is persisted in settings so a restart mid-session picks up where it was.

const LENGTHS = Object.freeze([15, 25, 50]);       // minutes on offer
const BREAKS = Object.freeze({ 15: 3, 25: 5, 50: 10 });
const MIN = 60 * 1000;

/** A new focus session of `minutes` (one of LENGTHS) starting now. */
function start(now, minutes) {
  const m = LENGTHS.includes(minutes) ? minutes : 25;
  return { phase: 'focus', minutes: m, breakMinutes: BREAKS[m], startedAt: now, endsAt: now + m * MIN };
}

/** Tolerate anything read from disk. null when there's no session. */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !['focus', 'break'].includes(raw.phase)) return null;
  if (!LENGTHS.includes(raw.minutes) || !Number.isFinite(raw.startedAt) || !Number.isFinite(raw.endsAt)) return null;
  return { phase: raw.phase, minutes: raw.minutes, breakMinutes: BREAKS[raw.minutes], startedAt: raw.startedAt, endsAt: raw.endsAt };
}

/**
 * Move the session along the clock. Returns { session, events } where events
 * is any of 'focus-done' (time to award it) and 'break-done', in order. A
 * break that also ran out while Shellby was closed reports both.
 */
function advance(raw, now) {
  let s = normalize(raw);
  const events = [];
  if (s?.phase === 'focus' && now >= s.endsAt) {
    events.push('focus-done');
    s = { ...s, phase: 'break', endsAt: s.endsAt + s.breakMinutes * MIN };
  }
  if (s?.phase === 'break' && now >= s.endsAt) {
    events.push('break-done');
    s = null;
  }
  return { session: s, events };
}

/** Is Shellby guarding your focus right now (not on a break)? */
const guarding = (raw, now) => normalize(raw)?.phase === 'focus' && now < raw.endsAt;

/** What the panel and the critter show. */
function view(raw, now) {
  const s = normalize(raw);
  if (!s) return { phase: null, lengths: [...LENGTHS] };
  return { ...s, remainingMs: Math.max(0, s.endsAt - now), lengths: [...LENGTHS] };
}

/** "18m" / "45s" for a countdown bubble. */
function shortLeft(ms) {
  if (ms >= MIN) return `${Math.ceil(ms / MIN)}m`;
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

module.exports = { LENGTHS, BREAKS, start, normalize, advance, guarding, view, shortLeft };
