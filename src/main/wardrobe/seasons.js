// Seasonal events. Each season is a yearly window of [month, day] dates
// (inclusive, local time) that may wrap the new year. While a season is active
// its items can be unlocked ({"unlock": {"season": "<id>"}}) and its outfit is
// suggested. Outfit values are item keys in the built-in pack.

const freeze = s => Object.freeze({ ...s, start: Object.freeze(s.start), end: Object.freeze(s.end), outfit: Object.freeze(s.outfit) });

const SEASONS = Object.freeze([
  { id: 'halloween', name: 'Spooky Season', emoji: '🎃', start: [10, 1], end: [11, 2], priority: 3, outfit: { hat: 'witch-hat', held: 'pumpkin-pail', shell: 'bat-wings', effect: 'bats' } },
  { id: 'winter', name: 'Winter Holidays', emoji: '❄️', start: [12, 1], end: [1, 7], priority: 3, outfit: { hat: 'santa-hat', neck: 'striped-scarf', held: 'candy-cane', effect: 'snow' } },
  { id: 'valentine', name: 'Valentine’s', emoji: '💘', start: [2, 7], end: [2, 15], priority: 3, outfit: { held: 'rose', effect: 'hearts' } },
  { id: 'spring', name: 'Spring', emoji: '🌱', start: [3, 20], end: [5, 31], priority: 1, outfit: { hat: 'flower-crown', shell: 'sprout' } },
  { id: 'summer', name: 'Summer', emoji: '☀️', start: [6, 21], end: [8, 31], priority: 1, outfit: { face: 'sunglasses', held: 'ice-cream', effect: 'fireflies' } },
  { id: 'autumn', name: 'Autumn', emoji: '🍂', start: [9, 15], end: [11, 30], priority: 2, outfit: { neck: 'autumn-scarf', effect: 'leaves' } },
].map(freeze));

const KNOWN_SEASONS = new Set(SEASONS.map(s => s.id));
const byId = id => SEASONS.find(s => s.id === id) || null;

// [month, day] -> comparable number, e.g. [10, 1] -> 1001
const md = ([m, d]) => m * 100 + d;
const wraps = s => md(s.start) > md(s.end);

function validDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
}

function inWindow(season, date) {
  const today = (date.getMonth() + 1) * 100 + date.getDate();
  const a = md(season.start);
  const b = md(season.end);
  return wraps(season) ? today >= a || today <= b : today >= a && today <= b;
}

const startIn = (season, year) => new Date(year, season.start[0] - 1, season.start[1]);

/** Is `seasonId` running on `date`? Unknown ids are never active. */
function isActive(seasonId, date = new Date()) {
  const s = byId(seasonId);
  return !!s && inWindow(s, validDate(date));
}

/** Every season running on `date`, highest priority first (ties by id). */
function activeSeasons(date = new Date()) {
  const d = validDate(date);
  return SEASONS.filter(s => inWindow(s, d))
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The one season to feature in the UI, or null. */
function featuredSeason(date = new Date()) {
  return activeSeasons(date)[0] || null;
}

/**
 * Start (local midnight) of the current window if the season is active,
 * otherwise of the next window strictly after `date`. Unknown id → null.
 */
function nextStart(seasonId, date = new Date()) {
  const s = byId(seasonId);
  if (!s) return null;
  const d = validDate(date);
  const year = d.getFullYear();
  if (inWindow(s, d)) {
    // A wrapping window seen from January started the previous year.
    const today = (d.getMonth() + 1) * 100 + d.getDate();
    return startIn(s, wraps(s) && today < md(s.start) ? year - 1 : year);
  }
  const thisYear = startIn(s, year);
  return thisYear > d ? thisYear : startIn(s, year + 1);
}

module.exports = { SEASONS, KNOWN_SEASONS, activeSeasons, featuredSeason, isActive, nextStart };
