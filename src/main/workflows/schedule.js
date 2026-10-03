// When a workflow's schedule triggers fire. Daily, weekly and every-few-hours
// are exactly a routine's schedule (routines.js does the maths, DST and all);
// workflows add "every N minutes", since a workflow made only of commands and
// requests can sensibly run far more often than a Claude task.
const { nextRun, previousRun, describeSchedule } = require('../routines');

const MINUTE = 60000;
const MIN_MINUTES = 5;
const MAX_MINUTES = 1440;

function minutesError(s) {
  const n = s.every;
  return Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES ? null : `Every must be ${MIN_MINUTES}-${MAX_MINUTES} whole minutes`;
}

// A routine-shaped stand-in, so routines.js can do the maths.
const asRoutine = (schedule, anchor) => ({ enabled: true, schedule, createdAt: anchor });

/** Next time strictly after fromMs, or null. `anchor` (ms) aligns intervals. */
function nextAt(schedule, anchor, fromMs) {
  if (!schedule || !Number.isFinite(fromMs)) return null;
  if (schedule.type === 'minutes') {
    if (minutesError(schedule) || !Number.isFinite(anchor)) return null;
    const step = schedule.every * MINUTE;
    const k = Math.max(1, Math.floor((fromMs - anchor) / step) + 1);
    return anchor + k * step;
  }
  return nextRun(asRoutine(schedule, anchor), fromMs);
}

/** Most recent time <= beforeMs, or null. */
function previousAt(schedule, anchor, beforeMs) {
  if (!schedule || !Number.isFinite(beforeMs)) return null;
  if (schedule.type === 'minutes') {
    if (minutesError(schedule) || !Number.isFinite(anchor)) return null;
    const step = schedule.every * MINUTE;
    const k = Math.floor((beforeMs - anchor) / step);
    return k >= 1 ? anchor + k * step : null;
  }
  return previousRun(asRoutine(schedule, anchor), beforeMs);
}

function describe(schedule) {
  if (schedule?.type === 'minutes') return schedule.every % 60 === 0 ? `Every ${schedule.every / 60} hour${schedule.every === 60 ? '' : 's'}` : `Every ${schedule.every} minutes`;
  return describeSchedule(schedule);
}

module.exports = { nextAt, previousAt, describe, minutesError, MIN_MINUTES, MAX_MINUTES };
