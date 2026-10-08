// The words and numbers on the Time tab (panel/time.js): durations, money,
// days, and the checks on the "add time" form. No DOM, so it runs in the
// browser and in Node (for tests).
(function (root) {
  const MAX_MINUTES_A_DAY = 24 * 60;

  /** Seconds as "1h 05m" or "42m" (rounded to the minute; negative is 0). */
  const dur = s => {
    const m = Math.round(Math.max(0, s || 0) / 60);
    const hrs = Math.floor(m / 60);
    return hrs ? `${hrs}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };

  /** Seconds as decimal hours to two places, for invoices: 5400 -> "1.50". */
  const decimal = s => (Math.round(((s || 0) / 3600) * 100) / 100).toFixed(2);

  /** An amount in a currency; an unknown currency code still reads as "12.00 XYZ". */
  const money = (n, cur) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); } catch { return `${n.toFixed(2)} ${cur}`; }
  };

  /** "2026-10-05" as a local Date at midnight. */
  const dateOf = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };

  /** A local Date as "YYYY-MM-DD" (today when none is given). */
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** A bar's length in percent of the biggest: 0 for nothing, else at least `min` so it shows. */
  const barPercent = (seconds, max, min) => (seconds ? Math.max(min, Math.round((seconds / Math.max(max, 1)) * 100)) : 0);

  /** The chart's label under a day: weekday when few, else only the 1st and Mondays. */
  const chartLabel = (day, many) => {
    const date = dateOf(day);
    if (!many) return date.toLocaleDateString(undefined, { weekday: 'short' });
    return date.getDate() === 1 || date.getDay() === 1 ? String(date.getDate()) : '';
  };

  /** Where a day's time came from: ["1h 00m tracked", "+15m by hand"], or the estimate from commits. */
  const dayParts = r => [
    r.tracked ? `${dur(r.tracked)} tracked` : '',
    r.manual ? `${r.manual > 0 ? '+' : '−'}${dur(Math.abs(r.manual))} by hand` : '',
    !r.tracked && !r.manual && r.estimate ? `~${dur(r.estimate)} from commits` : '',
  ].filter(Boolean);

  /** A day's commits as a bulleted tooltip, with how many more weren't listed. */
  const commitsTip = r => (r.commits.length
    ? r.commits.map(c => `• ${c.subject}`).join('\n') + (r.commitCount > r.commits.length ? `\n…and ${r.commitCount - r.commits.length} more` : '')
    : '');

  /** "3 commits", "1 commit". */
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** What a project earns, as the summary row shows it. */
  const payLabel = (p, currency) => (p.billable && p.rate ? money(p.amount, currency) : p.billable ? '' : 'not billable');

  /** The rounding choices as "minutes|mode" values: 0 once (no rounding), then each mode per step. */
  const roundValues = (round, modes) => round.flatMap(m => (m ? modes.map(mode => `${m}|${mode}`) : ['0|nearest']));
  const roundLabel = value => {
    const [m, mode] = value.split('|');
    return m === '0' ? "Don't round" : `${mode === 'up' ? 'Up' : 'To the nearest'} ${m} min`;
  };

  /** A currency as typed, or null if it isn't three letters. */
  const currencyCode = typed => {
    const cur = String(typed || '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(cur) ? cur : null;
  };

  /** What's wrong with an "add time" entry, or null when it can be sent. */
  const addTimeProblem = ({ key, day, minutes, note }) => (!key ? 'Pick a project.'
    : !day ? 'Pick a day.'
      : !minutes && !note ? 'How much time?'
        : minutes > MAX_MINUTES_A_DAY ? "That's more than a day."
          : null);

  const api = { dur, decimal, money, dateOf, dayKey, barPercent, chartLabel, dayParts, commitsTip, plural, payLabel, roundValues, roundLabel, currencyCode, addTimeProblem };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyTimeFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
