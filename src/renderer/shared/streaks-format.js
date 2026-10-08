// The words on the streak card and badge (panel/streaks.js). No DOM, so it
// runs in the browser and in Node (for tests).
(function (root) {
  /** How long a project has been quiet: "no commits yet", "committed today", "3 days since a commit". */
  const quiet = p => (p.quietDays == null ? 'no commits yet'
    : p.quietDays === 0 ? 'committed today'
      : `${p.quietDays} day${p.quietDays === 1 ? '' : 's'} since a commit`);

  /** Quiet for as long as the nudge waits, or longer. A project never committed to isn't late. */
  const isLate = (p, afterDays) => p.quietDays != null && p.quietDays >= afterDays;

  /** The streak card's title, "best" line and sentence under it. */
  const card = v => {
    const on = v.current > 0;
    return {
      on,
      title: on ? `${v.current}-day streak` : 'No streak yet',
      best: v.longest ? `best ${v.longest}d` : '',
      sub: on
        ? (v.today ? "You've kept it going today." : 'Finish a task today to keep it going.')
        : 'Finish a Claude task on consecutive days to build one.',
    };
  };

  /** The Trophies badge: whether it shows, and its words. */
  const badge = v => ({
    hidden: !(v.current > 0),
    text: `🔥 ${v.current}`,
    title: `${v.current}-day streak${v.longest ? `, best ${v.longest}` : ''}. See your projects on Time`,
    label: `${v.current}-day streak. Open it on Time`,
  });

  const api = { quiet, isLate, card, badge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyStreaksFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
