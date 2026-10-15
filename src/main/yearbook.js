// The yearbook: a year of you and Shellby, recorded as it happens, so that on
// January 2nd he can show you the year before as Shellby Wrapped (wrapped.js in
// the panel, docs/WRAPPED.md). Each calendar year (local time) keeps counts,
// not details: XP by kind, days together, what you shipped (project names, which
// never leave this PC), bugs caught, nests, review, the reef, tides, levels and
// molts, the trophies and tank pieces earned, and when in the day and week it
// all happened.
//
// State lives in config `yearbook`, on this PC only (never synced or on a card):
//   { years: { 'YYYY': Year }, shown: ['YYYY'], last: { level, medals, molts }, backfilled }
// `last` carries the running totals some stats report (the level now, medals and
// molts ever) so a year counts only what changed in it.
//
// Pure: no I/O, no clock (callers pass `now`). See test/yearbook.test.js.

const KEEP_YEARS = 10;
const MIN_ACTIVE_DAYS = 3;        // a year needs this many days together to get a Wrapped
const SHOW_DAY = 2;               // ...and it opens on this day of January, the year after
const MAX_PROJECTS = 40;
const MAX_SPECIES = 120;
const MAX_KINDS = 60;
const MAX_LIST = 200;             // trophies and pieces earned in a year
const MAX_COUNT = 1e9;

const YEAR_RE = /^\d{4}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KIND_RE = /^[a-z]{1,12}$/;
const KEY_RE = /^[a-z0-9][a-z0-9/-]{0,80}$/;
const NAME_MAX = 80;

// Plain "+1" stats, straight from the achievement events (wardrobe/achievements.js).
const STAT_COUNTS = Object.freeze({
  'task-completed': 'tasks', 'nest-cleared': 'nestsCleared', 'clean-fix': 'cleanFixes', 'fix-held': 'held',
  'rematch-won': 'rematchesWon', 'review-caught': 'reviewCaught', 'reef-best': 'reefBests', 'tide-perfect': 'tidePerfect',
  'focus-completed': 'focusSessions', 'find-made': 'finds', deployed: 'deploys', 'sparkle-found': 'shiny',
});
// High-water marks within the year: payload { n }.
const STAT_MAXIMA = Object.freeze({ 'review-tier': 'reviewTier', 'reef-thriving': 'thrivingMax' });
// XP kinds (progression/xp.js AWARDS) that are counted as well as paid.
const KIND_COUNTS = Object.freeze({ merged: 'merged', quiz: 'quizzes' });

const COUNTS = ['xp', 'tasks', 'tideOuts', 'deploys', 'merged', 'catches', 'newSpecies', 'shiny', 'nestsCleared', 'cleanFixes', 'held',
  'rematchesWon', 'quizzes', 'reviewCaught', 'reviewTier', 'medals', 'tidePerfect', 'levelsGained', 'startLevel', 'endLevel', 'molts',
  'reefBests', 'thrivingMax', 'focusSessions', 'finds'];
const MAX_TIME = 8.64e15; // the last moment a Date can hold
const time = v => (Number.isInteger(v) && v > 0 && v <= MAX_TIME ? v : 0);

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const count = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(MAX_COUNT, Math.floor(v)) : 0);
const pad = n => String(n).padStart(2, '0');
const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const yearOf = d => String(d.getFullYear());
const asDate = now => (now instanceof Date ? now : new Date(now));

function emptyYear(since = null) {
  const y = { since, partial: false, days: [], byKind: {}, ships: {}, bySpecies: {}, dayXp: {}, piecesEarned: [], trophies: [],
    hours: Array(24).fill(0), weekdays: Array(7).fill(0) };
  for (const k of COUNTS) y[k] = 0;
  y.firstTaskAt = 0;
  return y;
}

// A { key: n } map read from disk: good keys, whole positive counts, at most `max` (the biggest kept).
function countMap(raw, keyOk, max) {
  if (!isObj(raw)) return {};
  const rows = Object.entries(raw).filter(([k, v]) => keyOk(k) && count(v) > 0).map(([k, v]) => [k, count(v)]);
  return Object.fromEntries(rows.sort((a, b) => b[1] - a[1]).slice(0, max));
}
const fixedArray = (raw, n) => Array.from({ length: n }, (_, i) => count(Array.isArray(raw) ? raw[i] : 0));
const strings = (raw, re, max) => [...new Set((Array.isArray(raw) ? raw : []).filter(s => typeof s === 'string' && re.test(s)))].slice(0, max);
const projectOk = k => typeof k === 'string' && k.length > 0 && k.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(k);

function normalizeYear(raw) {
  const r = isObj(raw) ? raw : {};
  const y = emptyYear(typeof r.since === 'string' && DAY_RE.test(r.since) ? r.since : null);
  for (const k of COUNTS) y[k] = count(r[k]);
  y.firstTaskAt = time(r.firstTaskAt);
  y.partial = r.partial === true;
  y.days = strings(r.days, DAY_RE, 400).sort();
  y.byKind = countMap(r.byKind, k => KIND_RE.test(k), MAX_KINDS);
  y.ships = countMap(r.ships, projectOk, MAX_PROJECTS);
  y.bySpecies = countMap(r.bySpecies, k => KEY_RE.test(k), MAX_SPECIES);
  y.dayXp = countMap(r.dayXp, k => DAY_RE.test(k), 400);
  y.piecesEarned = strings(r.piecesEarned, KEY_RE, MAX_LIST);
  y.trophies = strings(r.trophies, KEY_RE, MAX_LIST);
  y.hours = fixedArray(r.hours, 24);
  y.weekdays = fixedArray(r.weekdays, 7);
  return y;
}

/** A stored yearbook made safe: anything read from disk. Never throws. */
function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  const years = {};
  const keys = Object.keys(isObj(r.years) ? r.years : {}).filter(k => YEAR_RE.test(k)).sort().slice(-KEEP_YEARS);
  for (const k of keys) years[k] = normalizeYear(r.years[k]);
  const last = isObj(r.last) ? r.last : {};
  const known = v => (Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null);
  return {
    years,
    shown: strings(r.shown, YEAR_RE, 50).sort(),
    last: { level: known(last.level), medals: known(last.medals), molts: known(last.molts) },
    backfilled: r.backfilled === true,
  };
}

// The year `now` falls in, made if it's new: a new year starts at the level he's at.
function withYear(s, now) {
  const key = yearOf(now);
  if (s.years[key]) return { s, key };
  const y = emptyYear(dayOf(now));
  y.startLevel = s.last.level ?? 0;
  y.endLevel = y.startLevel;
  const years = { ...s.years, [key]: y };
  const keep = Object.keys(years).sort().slice(-KEEP_YEARS);
  return { s: { ...s, years: Object.fromEntries(keep.map(k => [k, years[k]])) }, key };
}

const add = (map, key, n, max) => {
  const next = { ...map, [key]: Math.min(MAX_COUNT, (map[key] || 0) + n) };
  const rows = Object.entries(next);
  return rows.length > max ? Object.fromEntries(rows.sort((a, b) => b[1] - a[1]).slice(0, max)) : next;
};
const markDay = (y, now) => (y.days.includes(dayOf(now)) ? y : { ...y, days: [...y.days, dayOf(now)].sort() });
// When in the day and the week things happened (for the heatmap slide).
const markTime = (y, now) => ({
  ...y,
  hours: y.hours.map((n, i) => (i === now.getHours() ? n + 1 : n)),
  weekdays: y.weekdays.map((n, i) => (i === now.getDay() ? n + 1 : n)),
});

// A total some stat reports (medals ever, molts ever) as one more is won: the year
// counts what it went up by. With no total known yet (backfill seeds it), the
// report itself is the one more.
function fromTotal(s, y, field, lastKey, n) {
  const total = count(n);
  const was = s.last[lastKey] ?? Math.max(0, total - 1);
  const s2 = { ...s, last: { ...s.last, [lastKey]: Math.max(was, total) } };
  if (total <= was) return { s: s2, y };
  return { s: s2, y: { ...y, [field]: y[field] + (total - was) } };
}

function noteXp(y, p, now) {
  const kind = typeof p.kind === 'string' && KIND_RE.test(p.kind) ? p.kind : null;
  if (!kind) return y;
  let next = y;
  if (KIND_COUNTS[kind]) next = { ...next, [KIND_COUNTS[kind]]: next[KIND_COUNTS[kind]] + 1 };
  if (kind === 'ship' && projectOk(p.project)) next = { ...next, ships: add(next.ships, p.project, 1, MAX_PROJECTS) };
  const gained = count(p.gained);
  if (!gained) return next;
  next = { ...next, xp: next.xp + gained, byKind: add(next.byKind, kind, gained, MAX_KINDS), dayXp: add(next.dayXp, dayOf(now), gained, 400) };
  return markTime(markDay(next, now), now);
}

function noteStat(s, y, event, p, now) {
  if (event === 'active') return { s, y: markDay(y, now) };
  if (event === 'task-completed') {
    const next = markDay({ ...y, tasks: y.tasks + 1 }, now);
    return { s, y: next.firstTaskAt ? next : { ...next, firstTaskAt: now.getTime() } };
  }
  if (event === 'bug-caught') {
    let next = { ...y, catches: y.catches + 1 };
    if (typeof p.species === 'string' && KEY_RE.test(p.species)) next = { ...next, bySpecies: add(next.bySpecies, p.species, 1, MAX_SPECIES) };
    if (p.fresh === true) next = { ...next, newSpecies: next.newSpecies + 1 };
    return { s, y: next };
  }
  if (Object.prototype.hasOwnProperty.call(STAT_COUNTS, event)) return { s, y: { ...y, [STAT_COUNTS[event]]: y[STAT_COUNTS[event]] + 1 } };
  if (Object.prototype.hasOwnProperty.call(STAT_MAXIMA, event)) return { s, y: { ...y, [STAT_MAXIMA[event]]: Math.max(y[STAT_MAXIMA[event]], count(p.n)) } };
  if (event === 'event-medal') return fromTotal(s, y, 'medals', 'medals', p.n);
  if (event === 'molted') return fromTotal(s, y, 'molts', 'molts', p.n);
  if (event === 'level') {
    // Reported on every award with the level now: levels gained are the steps up (a Molt starts again at 1).
    const n = count(p.n);
    if (!n) return { s, y };
    const was = s.last.level;
    const up = was !== null && n > was ? n - was : 0;
    return { s: { ...s, last: { ...s.last, level: n } }, y: { ...y, endLevel: n, levelsGained: y.levelsGained + up, startLevel: y.startLevel || was || n } };
  }
  return { s, y };
}

/**
 * Record one moment. Returns a new state; `state` is never changed.
 *   'xp'      { kind, gained, project? }   an award paid (d.onAward)
 *   'stat'    { event, payload }           an achievement stat (d.onStat)
 *   'trophy'  { id, pieces: [key] }        a trophy earned, with the tank pieces it brought
 *   'tideout' {}                           a tide-out day used (progression/streaks.js)
 */
function note(state, event, payload = {}, now = new Date()) {
  const when = asDate(now);
  if (Number.isNaN(when.getTime())) return normalize(state);
  const p = isObj(payload) ? payload : {};
  const { s, key } = withYear(normalize(state), when);
  const y = s.years[key];
  let out = { s, y };
  if (event === 'xp') out = { s, y: noteXp(y, p, when) };
  else if (event === 'stat' && typeof p.event === 'string') out = noteStat(s, y, p.event, isObj(p.payload) ? p.payload : {}, when);
  else if (event === 'trophy' && typeof p.id === 'string' && KEY_RE.test(p.id)) {
    const pieces = strings(p.pieces, KEY_RE, 10);
    out = { s, y: { ...y, trophies: strings([...y.trophies, p.id], KEY_RE, MAX_LIST), piecesEarned: strings([...y.piecesEarned, ...pieces], KEY_RE, MAX_LIST) } };
  } else if (event === 'tideout') out = { s, y: { ...y, tideOuts: y.tideOuts + 1 } };
  return { ...out.s, years: { ...out.s.years, [key]: out.y } };
}

// ------------------------------------------------------------------ when Wrapped is due

// January 2nd of the year after, local midnight: when a year's Wrapped opens.
const opensAt = year => new Date(Number(year) + 1, 0, SHOW_DAY);

/** The years with a Wrapped to open (ended, opened, enough days together), newest first. */
function available(state, now = new Date()) {
  const s = normalize(state);
  const t = asDate(now).getTime();
  return Object.keys(s.years)
    .filter(k => opensAt(k).getTime() <= t && s.years[k].days.length >= MIN_ACTIVE_DAYS)
    .sort().reverse()
    .map(k => ({ year: Number(k), shown: s.shown.includes(k), partial: s.years[k].partial, since: s.years[k].since }));
}

/**
 * The year whose Wrapped should open by itself now, or null: the newest one
 * not yet shown. Older ones you missed stay in `available` (and on Trophies).
 */
function wrappedDue(state, now = new Date()) {
  return available(state, now).find(a => !a.shown)?.year ?? null;
}

function markShown(state, year) {
  const s = normalize(state);
  const key = String(year);
  if (!YEAR_RE.test(key) || s.shown.includes(key)) return s;
  return { ...s, shown: [...s.shown, key].sort() };
}

// ------------------------------------------------------------------ backfill

/**
 * Once, on the first run: fill in this year from what Shellby already kept,
 * so the first Wrapped isn't empty. sources (all optional, already normalized):
 *   days         ['YYYY-MM-DD']  active days (progression/streaks.js keeps 400, achievements 400)
 *   xpDaily      { day: xp }     progression/xp.js keeps 30 days
 *   xpDailyKinds { day: { kind: xp } }
 *   bugMonths    { 'YYYY-MM': { device: { jars, shinies } } }   bugdex/index.js months
 *   bugFirsts    [first catch time, ms]  one per species caught
 *   level        the level now
 *   medals, molts  tide medals and molts so far, so the next one counts as one
 * `since` becomes the earliest day found and the year is marked partial, so its
 * Wrapped says "since Aug 5". Counts already recorded are kept, never doubled:
 * a day already in dayXp keeps its own.
 */
function backfill(state, sources = {}, now = new Date()) {
  const s0 = normalize(state);
  if (s0.backfilled) return s0;
  const when = asDate(now);
  const { s, key } = withYear(s0, when);
  const inYear = d => typeof d === 'string' && DAY_RE.test(d) && d.startsWith(`${key}-`) && d <= dayOf(when);
  let y = s.years[key];
  const days = (Array.isArray(sources.days) ? sources.days : []).filter(inYear);
  y = { ...y, days: [...new Set([...y.days, ...days])].sort() };
  for (const [day, xp] of Object.entries(isObj(sources.xpDaily) ? sources.xpDaily : {})) {
    if (!inYear(day) || y.dayXp[day] || !count(xp)) continue;
    y = { ...y, xp: y.xp + count(xp), dayXp: add(y.dayXp, day, count(xp), 400) };
    const kinds = isObj(sources.xpDailyKinds?.[day]) ? sources.xpDailyKinds[day] : {};
    for (const [kind, n] of Object.entries(kinds)) if (KIND_RE.test(kind) && count(n)) y = { ...y, byKind: add(y.byKind, kind, count(n), MAX_KINDS) };
    if (!y.days.includes(day)) y = { ...y, days: [...y.days, day].sort() };
  }
  for (const [month, devices] of Object.entries(isObj(sources.bugMonths) ? sources.bugMonths : {})) {
    if (!month.startsWith(`${key}-`) || !isObj(devices)) continue;
    for (const t of Object.values(devices)) y = { ...y, catches: y.catches + count(t?.jars), shiny: y.shiny + count(t?.shinies) };
  }
  const firsts = (Array.isArray(sources.bugFirsts) ? sources.bugFirsts : []).filter(ms => count(ms) && yearOf(new Date(ms)) === key);
  y = { ...y, newSpecies: y.newSpecies + firsts.length };
  const level = count(sources.level);
  if (level && !y.startLevel) y = { ...y, startLevel: level, endLevel: Math.max(y.endLevel, level) };
  const earliest = [...y.days, y.since].filter(Boolean).sort()[0] || dayOf(when);
  y = { ...y, since: earliest, partial: true };
  const seed = v => (Number.isInteger(v) && v >= 0 ? Math.min(MAX_COUNT, v) : null);
  const last = {
    level: s.last.level ?? (level || null),
    medals: s.last.medals ?? seed(sources.medals),
    molts: s.last.molts ?? seed(sources.molts),
  };
  return { ...s, years: { ...s.years, [key]: y }, last, backfilled: true };
}

// ------------------------------------------------------------------ reading a year

// The longest run of consecutive days in a sorted list of 'YYYY-MM-DD'.
function longestRun(days) {
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

const topOf = (map, n) => Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
const peak = arr => (arr.some(n => n > 0) ? arr.indexOf(Math.max(...arr)) : null);

/** A year's numbers worked out: what the slides and the card read. */
function summary(state, year) {
  const s = normalize(state);
  const y = s.years[String(year)];
  if (!y) return null;
  const busiest = topOf(y.dayXp, 1)[0];
  const nemesis = topOf(y.bySpecies, 1)[0];
  return {
    year: Number(year), since: y.since, partial: y.partial,
    xp: y.xp, tasks: y.tasks, activeDays: y.days.length, longestStreak: longestRun(y.days), tideOuts: y.tideOuts,
    topKinds: topOf(y.byKind, 3).map(([kind, xp]) => ({ kind, xp })),
    topProjects: topOf(y.ships, 3).map(([name, n]) => ({ name, n })),
    ships: Object.values(y.ships).reduce((a, n) => a + n, 0), deploys: y.deploys, merged: y.merged,
    catches: y.catches, newSpecies: y.newSpecies, shiny: y.shiny, nemesis: nemesis ? { id: nemesis[0], n: nemesis[1] } : null,
    nestsCleared: y.nestsCleared, cleanFixes: y.cleanFixes, held: y.held, rematchesWon: y.rematchesWon,
    quizzes: y.quizzes, reviewCaught: y.reviewCaught, reviewTier: y.reviewTier,
    medals: y.medals, tidePerfect: y.tidePerfect,
    levelsGained: y.levelsGained, startLevel: y.startLevel, endLevel: y.endLevel, molts: y.molts,
    reefBests: y.reefBests, thrivingMax: y.thrivingMax,
    piecesEarned: [...y.piecesEarned], trophies: [...y.trophies], focusSessions: y.focusSessions, finds: y.finds,
    firstTaskAt: y.firstTaskAt || null,
    busiestDay: busiest ? { day: busiest[0], xp: busiest[1] } : null,
    busiestHour: peak(y.hours), busiestWeekday: peak(y.weekdays),
    hours: [...y.hours], weekdays: [...y.weekdays],
  };
}

module.exports = {
  KEEP_YEARS, MIN_ACTIVE_DAYS, SHOW_DAY, STAT_COUNTS, STAT_MAXIMA,
  normalize, note, available, wrappedDue, markShown, backfill, summary, longestRun, opensAt,
};
