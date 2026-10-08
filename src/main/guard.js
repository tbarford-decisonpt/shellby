// Spending guard. Routines, workflows and Autonomous tabs run while nobody is
// watching: this stops one before it spends the part of your 5-hour window you
// asked to keep for yourself, and stops a routine that runs far longer than a
// routine should (a loop at 3am). Works from the usage readings Claude Code
// already sends (stream.js usageFrom, limits.js).
//
// Pure: callers pass `now` and how long the PC has been idle (test/guard.test.js).

const RESERVES = [10, 25, 50];              // % of the 5-hour window kept for you
const MAX_MINUTES = [15, 30, 60, 120, 240]; // longest a routine's run may take
const DEFAULTS = { spendGuard: true, spendReserve: 25, spendMaxMinutes: 60 };
const MIN = 60 * 1000;
// An Autonomous tab is only unattended once the PC has been idle this long (or is locked).
const AWAY_MS = 15 * MIN;

/** The guard's settings from config.get, anything odd falling back to the defaults. */
function settingsOf(get) {
  const reserve = get('spendReserve');
  const minutes = get('spendMaxMinutes');
  return {
    on: get('spendGuard') !== false,
    reserve: RESERVES.includes(reserve) ? reserve : DEFAULTS.spendReserve,
    maxMinutes: MAX_MINUTES.includes(minutes) ? minutes : DEFAULTS.spendMaxMinutes,
  };
}

/**
 * Is the 5-hour window past what unattended work may use? A reading for a
 * window that has already reset says nothing about the new one.
 */
function overCeiling(usage, reserve, now) {
  const w = usage?.fiveHour;
  return !!w && Number.isFinite(w.pct) && Number.isFinite(w.resetsAt) && w.resetsAt > now && w.pct >= 100 - reserve;
}

/** Should a scheduled routine wait for the reset instead of starting? */
function holdBeforeStart(settings, usage, now) {
  return settings.on && overCeiling(usage, settings.reserve, now);
}

/**
 * Should a run stop now? run: { kind: 'routine' | 'workflow' | 'autonomous',
 * startedAt, exempt } where `exempt` is a run you started by hand when already
 * past the ceiling (you chose to spend it). -> null, or { reason: 'time', minutes }
 * or { reason: 'ceiling', pct, resetsAt }.
 */
function verdict(run, settings, { usage, now, idleMs = 0 }) {
  if (!settings.on || !run?.kind) return null;
  if (run.kind === 'routine' && now - run.startedAt >= settings.maxMinutes * MIN) return { reason: 'time', minutes: settings.maxMinutes };
  if (run.exempt || !overCeiling(usage, settings.reserve, now)) return null;
  if (run.kind === 'autonomous' && !(idleMs >= AWAY_MS)) return null;
  return { reason: 'ceiling', pct: usage.fiveHour.pct, resetsAt: usage.fiveHour.resetsAt };
}

/** "1 hour", "30 minutes". */
function minutesText(m) {
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  return `${m} minutes`;
}

/** The notification for a stopped run. clock(t) -> "3:40 AM". */
function message(v, title, settings, clock) {
  if (v.reason === 'time') {
    return {
      title: `Shellby stopped a long routine: ${title}`,
      body: `It ran past ${minutesText(v.minutes)}, the most you set a routine to take. Its conversation is kept: reply to carry on.`,
    };
  }
  return {
    title: `Shellby stopped ${title} to save your limit`,
    body: `Your 5-hour window is at ${v.pct}%, and you asked to keep ${settings.reserve}% for yourself. It resets at ${clock(v.resetsAt)}. Reply in its conversation to carry on.`,
  };
}

module.exports = { settingsOf, overCeiling, holdBeforeStart, verdict, message, minutesText, RESERVES, MAX_MINUTES, DEFAULTS, AWAY_MS };
