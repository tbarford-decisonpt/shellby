// The crab, in a line, for places other people read: the "Built with
// Shellby" badge on your pull requests (github/pr-badge.js) and the trailer on
// Shellby's own bring-home commits (worktrees.js). Only what's already public
// about him (level, title, class) and a count of bugs Claude fixed this week.
// Never a project, a file or an error. See docs/plans/viral.md §6.
//
// Pure. See test/crab-line.test.js.

const DAY = 24 * 60 * 60 * 1000;
const WORDS_RE = /^[A-Za-z][A-Za-z' -]{0,39}$/;

const words = s => (typeof s === 'string' && WORDS_RE.test(s.trim()) ? s.trim() : null);
const lvl = v => (Number.isFinite(v) ? Math.min(99, Math.max(1, Math.floor(v))) : 1);
const n = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

/** Bugs jarred in the last week, from the Bugdex's log (bugdex.js normalize: newest first, at most 30). */
function bugsThisWeek(log, now) {
  return (Array.isArray(log) ? log : []).filter(e => e && Number.isFinite(e.at) && now - e.at < 7 * DAY && now >= e.at).length;
}

/**
 * The parts, cleaned: { level, title, cls, bugs, emoji }.
 *   s: { level, title, cls, bugs, event: { emoji } | null }
 */
function parts(s = {}) {
  const emoji = typeof s.event?.emoji === 'string' && s.event.emoji.length <= 4 ? s.event.emoji : null;
  return { level: lvl(s.level), title: words(s.title), cls: words(s.cls), bugs: n(s.bugs), emoji };
}

/** "Lv 12 Abyssal Admin · Tester · 3 bugs jarred this week · 🎃" (the badge's line, after "Built with Shellby"). */
function badgeText(s) {
  const p = parts(s);
  return [
    `Lv ${p.level}${p.title ? ` ${p.title}` : ''}`,
    p.cls,
    p.bugs ? `${plural(p.bugs, 'bug', 'bugs')} jarred this week` : null,
    p.emoji,
  ].filter(Boolean).join(' · ');
}

/** "Shipped-with: Shellby (Lv 12 Abyssal Admin)": a git trailer, one line, plain. */
function trailer(s) {
  const p = parts(s);
  return `Shipped-with: Shellby (Lv ${p.level}${p.title ? ` ${p.title}` : ''})`;
}

module.exports = { bugsThisWeek, parts, badgeText, trailer };
