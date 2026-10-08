// What day it is, for everything that goes by the calendar: seasons, tide
// events, the finds and bugs that only turn up in them. One clock, so a test
// can say "it's the 28th of October" and the whole app agrees.
//
// Screenshot runs pick a date (captureClock, capture.js). Dev and test runs
// can set SHELLBY_TODAY=2026-10-28: that day, at the real time of day. A
// packaged Shellby always reads the real clock.
//
// Pure apart from the clock it's given. See test/today.test.js.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** SHELLBY_TODAY as [year, month, day], or null when it isn't a real date. */
function parseDay(text) {
  const m = DAY_RE.exec(typeof text === 'string' ? text.trim() : '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(y, mo - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d ? [y, mo, d] : null;
}

/**
 * A today() for the app.
 *   packaged: app.isPackaged (an override is never read then)
 *   env: process.env
 *   capture: main's captureClock ({ now: Date | null })
 *   clock: () => Date (the real one by default)
 */
function makeToday({ packaged = true, env = {}, capture = null, clock = () => new Date() } = {}) {
  const fixed = packaged ? null : parseDay(env.SHELLBY_TODAY);
  return () => {
    if (capture?.now instanceof Date) return capture.now;
    const now = clock();
    if (!fixed) return now;
    return new Date(fixed[0], fixed[1] - 1, fixed[2], now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  };
}

module.exports = { makeToday, parseDay };
