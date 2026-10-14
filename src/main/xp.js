// XP and levels. Shellby earns XP when tasks finish, tests pass, code ships or
// deploys, and most of all when he writes himself a new skill or agent; and,
// with or without Claude, when you pet him, play with him, he digs you up a
// gift or the two of you grow closer. Enough XP and he levels up, and past
// level 99 he earns marks (★). Turning failing tests green, the first push of
// the day to a project, a running streak and coming back after a break all pay extra;
// doing the same thing over and over pays less and less. Pure: no I/O, no
// clock (callers pass `now`). See test/xp.test.js.
//
// XP is kept per PC (byDevice) so sync can add PCs together without counting
// anything twice: each PC only ever grows its own count, and merging takes the
// larger of each. XP earned before that existed sits in the 'legacy' bucket.
// Titles, badge colours, the level curve and what each level unlocks live in levels.js.
const levels = require('./levels');
const { TITLES, RANKS, UNLOCKS, MAX_LEVEL, xpForLevel, titleFor, rankFor, unlocksBetween, nextUnlock } = levels;
const { progressBounties, bountiesView, CLEAR_ALL_XP } = require('./bounties');
const { characterSheet } = require('./character');

// `claude`: only Claude Code work earns it, so just-the-crab mode leaves it off
// the list of ways to earn (panel/xp.js).
const AWARDS = Object.freeze({
  // Quest chapters (quests.js) and review mastery tiers (review-mastery.js).
  chapter: { xp: 100, perHour: 1, label: 'Finished a quest chapter', way: 'Finishes a chapter of quests', claude: true },
  reviewtier: { xp: 100, perHour: 1, label: 'Reached a new review tier', way: 'Reaches a new review mastery tier', claude: true },
  // Bug nests (bugdex/nests.js): 14 days with no recurrence.
  nest: { xp: 80, perHour: 1, label: 'Cleared a bug nest', way: 'Clears a bug nest (14 days with no recurrence)', claude: true },
  questline: { xp: 150, perHour: 1, label: 'Finished the quest line', way: 'Finishes the whole quest line', claude: true },
  // Tide events (events.js): every goal finished while it was on.
  medal: { xp: 150, perHour: 1, label: 'Finished a tide event', way: 'Finishes every goal of a tide event while it\'s on' },
  // Crab eggs (eggs.js): a friend you invited hatched one.
  hatch: { xp: 100, perHour: 2, label: 'An egg hatched', way: 'A crab egg you gave someone hatches, or you hatch one' },
  trick: { xp: 150, perHour: 3, label: 'Wrote himself a new trick', way: 'Writes himself a new skill or agent', claude: true },
  deploy: { xp: 50, perHour: 4, label: 'Deployed', way: 'Deploys or publishes', claude: true },
  merged: { xp: 50, perHour: 4, label: 'Pull request merged', way: 'Gets one of your pull requests merged', claude: true },
  bond: { xp: 50, perHour: 1, label: 'Grew closer', way: 'The two of you grow closer' },
  // A sparkly find or bug (gifts.js, bugdex.js): rare, so the roll is the limit.
  sparkle: { xp: 50, perHour: 3, label: 'Found a sparkly one', way: 'Now and then a find or a catch comes up sparkly' },
  // Surprises (surprises.js): rare, so the roll is the limit, not the hour.
  crit: { xp: 60, perHour: 3, label: 'Critical hit', way: 'Now and then, when one turn takes a red suite to green', claude: true },
  landing: { xp: 40, perHour: 3, label: 'Clean landing', way: 'Now and then, when a copy comes home green on the first try', claude: true },
  fixed: { xp: 40, perHour: 6, label: 'Tests green again', way: 'Turns failing tests green', claude: true },
  cifix: { xp: 40, perHour: 3, label: 'CI back to green', way: 'Gets a red CI build on your pull request green again', claude: true },
  flakefix: { xp: 40, perHour: 2, label: 'Fixed a flaky test', way: 'Fixes a flaky test for good', claude: true },
  quest: { xp: 40, perHour: 4, label: 'Finished a quest', way: 'Finishes a quest (each one teaches a hidden trick)', claude: true },
  issue: { xp: 40, perHour: 3, label: 'Turned an issue into a pull request', way: 'Takes an issue all the way to a pull request', claude: true },
  // The Bugdex (bugdex.js): a kind of bug it hadn't caught yet, then repeats. Small,
  // because the same fix usually pays 'fixed' or 'tests' too.
  newbug: { xp: 40, perHour: 3, label: 'A new bug for the Bugdex', way: 'Catches a kind of bug the Bugdex hasn\'t caught yet', claude: true },
  ship: { xp: 40, perHour: 4, label: 'Pushed code', way: 'Pushes code (+20 first push of the day)', claude: true },
  // A project's reef health (reef.js) reached a new best.
  reef: { xp: 30, perHour: 1, label: 'Reef reached a new best', way: "A project's reef reaches a new best", claude: true },
  deps: { xp: 30, perHour: 2, label: 'Clean dependency audit', way: 'A dependency audit comes back clean', claude: true },
  // Lean Shell (efficiency.js): only for things that cost nothing in quality. Never
  // for cheaper tasks, shorter replies or fewer turns, which would reward cutting corners.
  tidy: { xp: 30, perHour: 6, label: 'Tidied his toolbox', way: 'Turns off a plugin or MCP server that sits idle', claude: true },
  treasure: { xp: 30, perHour: 2, label: 'He dug up something rare', way: 'Digs up something rare' },
  // Fix reports (bugdex/quality.js) and review mastery (review-mastery.js).
  cleanfix: { xp: 25, perHour: 4, label: 'A clean fix', way: 'A fix with a new test that proves it, at the root', claude: true },
  caught: { xp: 25, perHour: 3, label: 'Caught something in review', way: 'Catches something in review before it merges', claude: true },
  held: { xp: 20, perHour: 3, label: 'A fix held', way: 'A fix holds for 14 days', claude: true },
  home: { xp: 20, perHour: 6, label: 'Brought work home green', way: "Brings a copy's work home with its tests passing", claude: true },
  helped: { xp: 15, perHour: 6, label: "Put a helper's find to use", way: 'Acts on what one of his helper agents found', claude: true },
  trophy: { xp: 20, perHour: 30, label: 'Earned a trophy', way: 'Earns a trophy' },
  fresh: { xp: 20, perHour: 2, label: 'Started a crowded chat fresh', way: 'Starts a crowded conversation fresh with a summary', claude: true },
  tests: { xp: 15, perHour: 6, label: 'Tests passed', way: 'Tests pass', claude: true },
  quiz: { xp: 15, perHour: 3, label: "Passed a quiz on Claude's work", way: 'You pass a quiz on a change Claude made', claude: true },
  focus: { xp: 15, perHour: 3, label: 'Finished a focus session', way: 'Finishes a focus session' },
  // Swaps with friends (swaps.js).
  swap: { xp: 15, perHour: 3, label: 'Swapped finds with a friend', way: 'Swaps a find with a friend' },
  catch: { xp: 10, perHour: 6, label: 'Caught a bug', way: 'Fixes a bug and catches it for the Bugdex', claude: true },
  play: { xp: 10, perHour: 4, label: 'Played a game with him', way: 'Plays hide and seek or fetch with you' },
  find: { xp: 8, perHour: 4, label: 'He dug you up a gift', way: 'Digs you up a gift' },
  // Tasks and test runs come by the dozen on a busy day, so they pay the least of Claude's work.
  task: { xp: 5, perHour: 60, label: 'Finished a task', way: 'Finishes a task', claude: true },
  day: { xp: 5, perHour: 1, label: 'Another day together', way: 'Each day you use him' },
  feed: { xp: 3, perHour: 3, label: 'Fed Shellby a snack', way: 'You feed him a snack' },
  care: { xp: 3, perHour: 2, label: 'Looked after Shellby', way: 'You rinse him or tuck him in' },
  pet: { xp: 2, perHour: 5, label: 'Petted Shellby', way: 'You pet him' },
});
// Log-only kinds: paid by the day's bounties, not by an event.
const LOG_KINDS = new Set([...Object.keys(AWARDS), 'bounty']);

// Past the top level, XP keeps counting in marks (★): the first costs MARK_XP,
// and each one after costs MARK_STEP more than the one before.
const MARK_XP = 5000;
const MARK_STEP = 500;
const MAX_MARKS = 999;
const LOG_MAX = 40;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LEGACY = 'legacy';
const DEVICE_RE = /^[a-z0-9-]{4,40}$/;
const MAX_DEVICES = 20;
const RED_FOR = DAY;             // a failing run counts toward "green again" for a day
const MAX_RED = 50;
const FIRST_SHIP_XP = 20;
const STREAK_STEP = 0.05;        // +5% per full week of streak...
const STREAK_MAX = 0.25;         // ...up to +25%
const RESTED_AFTER = 3 * DAY;    // away this long and the next XP is doubled...
const RESTED_POOL = 150;         // ...until this much extra has been paid
const RESTED_POOL_MAX = 200;     // the rested-plus perk's pool (levels.js PERKS), passed in as meta.restedPool
const MAX_MOLT_STAMPS = 50;
const DAILY_DAYS = 30;
const CLASS_RE = /^[a-z-]{1,24}$/;
const MAX_CLASSES = 16;
// Within an hour: full XP up to perHour, then half, then a quarter, then none.
const FALLOFF = [[1, 1], [2, 0.5], [4, 0.25]];

/** XP past level 99 needed for `n` marks (1 = 5,000, 2 = 10,500, 3 = 16,500). */
function xpForMarks(n) {
  const m = Math.max(0, Math.min(MAX_MARKS, Math.floor(n)));
  return m * MARK_XP + (MARK_STEP * m * (m - 1)) / 2;
}

/** How many marks `over` XP past level 99 has earned. */
function marksFor(overIn) {
  const over = Math.max(0, Number(overIn) || 0);
  // xpForMarks(n) = (STEP/2)n² + (XP - STEP/2)n: solve for n, then step off any rounding.
  const b = MARK_XP - MARK_STEP / 2;
  let n = Math.min(MAX_MARKS, Math.floor((Math.sqrt(b * b + 2 * MARK_STEP * over) - b) / MARK_STEP));
  while (n > 0 && xpForMarks(n) > over) n--;
  while (n < MAX_MARKS && xpForMarks(n + 1) <= over) n++;
  return n;
}

/**
 * { level, marks, title, rank, xp, floor, next, into, needed, progress (0..1) } for
 * a total. At level 99, floor/next/progress are toward the next mark.
 *   molts: how many times he has molted. Then `total` is the XP since the last
 *   molt (levelOf does the subtraction) on that molt's curve (levels.js curveMult).
 */
function levelFor(total, molts = 0) {
  const xp = Math.max(0, Math.floor(Number(total) || 0));
  const level = levels.levelNumber(xp, molts);
  const top = xpForLevel(MAX_LEVEL, molts);
  const marks = level === MAX_LEVEL ? marksFor(xp - top) : 0;
  const floor = level < MAX_LEVEL ? xpForLevel(level, molts) : top + xpForMarks(marks);
  const next = level < MAX_LEVEL ? xpForLevel(level + 1, molts) : marks < MAX_MARKS ? top + xpForMarks(marks + 1) : floor;
  return {
    level, marks, title: titleFor(level), rank: rankFor(level), xp, floor, next,
    into: xp - floor, needed: next - floor,
    progress: next > floor ? (xp - floor) / (next - floor) : 1,
  };
}

/** The streak bonus as a multiplier: 1 + 5% per full week, at most 1.25. */
const streakMultiplier = days => 1 + Math.min(STREAK_MAX, STREAK_STEP * Math.floor(Math.max(0, Number(days) || 0) / 7));

// ------------------------------------------------------------------ molting
// xp.molt (molting.js): { count, base (the total at the last molt), at: [when] }.
// Kept in the XP state so it syncs with it.

function normalizeMolt(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const at = (Array.isArray(src.at) ? src.at : []).filter(t => Number.isFinite(t) && t > 0).slice(-MAX_MOLT_STAMPS);
  return { count: Math.min(9999, count(src.count)), base: count(src.base), at };
}

/**
 * Two PCs' molts: the side that molted more wins; for the same count, the lower
 * base (the earlier molt, so no XP since it is lost from the new level).
 */
function mergeMolt(a, b) {
  const x = normalizeMolt(a), y = normalizeMolt(b);
  if (x.count !== y.count) return x.count > y.count ? x : y;
  const win = x.base <= y.base ? x : y;
  return { ...win, at: [...new Set([...x.at, ...y.at])].sort((p, q) => p - q).slice(-MAX_MOLT_STAMPS) };
}

/** levelFor for a whole XP state: the XP since the last molt, on that molt's curve. */
function levelOf(stateIn) {
  const s = stateIn?.molt && Number.isFinite(stateIn.total) ? stateIn : normalizeXp(stateIn);
  const m = normalizeMolt(s.molt);
  return levelFor(Math.max(0, s.total - m.base), m.count);
}

// ------------------------------------------------------------------ per-PC XP

const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const sum = obj => Object.values(obj).reduce((n, v) => n + v, 0);
const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : 0); // never Object.prototype's "constructor"
const LOCAL = 'local'; // XP earned before this PC has its id (withDevice moves it)

/**
 * Clean a { device: xp } map. A `total` higher than the map adds up to (from
 * an older Shellby that only knew totals) is kept by topping up 'legacy'.
 *   keepLocal: false for another PC's map, whose 'local' means nothing here
 */
function cleanByDevice(raw, total = 0, { keepLocal = true } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = Object.entries(src).filter(([k, v]) => DEVICE_RE.test(k) && (keepLocal || k !== LOCAL) && count(v) > 0).map(([k, v]) => [k, count(v)]);
  const byDevice = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_DEVICES));
  const short = count(total) - sum(byDevice);
  if (short > 0) byDevice[LEGACY] = own(byDevice, LEGACY) + short;
  return byDevice;
}

/**
 * Merge two PCs' XP: the larger count for each PC.
 *
 * 'legacy' is XP from before PCs were counted apart. When a PC upgrades, its
 * whole total becomes its legacy, and that total may already include other
 * PCs' newer counts (an older Shellby synced them in as one number). Until it
 * has synced once (legacyPending), such a legacy only counts for what the
 * other side's own PC counts don't already cover.
 *
 * A side with only a total (a gist an older Shellby wrote) is a floor,
 * applied after the merge: it can't be lost, nor counted on top.
 *   a, b: { byDevice?, total?, legacyPending? }
 */
function mergeXpCounts(a, b) {
  const x = cleanByDevice(a?.byDevice);
  const y = cleanByDevice(b?.byDevice);
  const others = m => sum(m) - own(m, LEGACY);
  const legacyOf = (m, pending, other) => (pending ? Math.max(0, own(m, LEGACY) - others(other)) : own(m, LEGACY));
  const merged = { [LEGACY]: Math.max(legacyOf(x, a?.legacyPending === true, y), legacyOf(y, b?.legacyPending === true, x)) };
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (k !== LEGACY) merged[k] = Math.max(own(x, k), own(y, k));
  const floor = Math.max(0, ...[[a, x], [b, y]].filter(([, m]) => !Object.keys(m).length).map(([s]) => count(s?.total)));
  const byDevice = cleanByDevice(merged, floor);
  return { byDevice, total: sum(byDevice), molt: mergeMolt(a?.molt, b?.molt) };
}

// ------------------------------------------------------------------ state

const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clip = s => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) : '');

/** A { key: number } map with at most `max` keys matching `re` (the largest/newest kept). */
function numberMap(raw, re, max, keep = (a, b) => b[0].localeCompare(a[0])) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(Object.entries(src).filter(([k, v]) => re.test(k) && count(v) > 0).map(([k, v]) => [k, count(v)]).sort(keep).slice(0, max));
}

// XP per kind per day, for the last DAILY_DAYS days: what the character sheet's
// "this week" is made of (character.js). byKind alone is all time.
function cleanDailyKinds(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const days = Object.keys(src).filter(k => DAY_RE.test(k)).sort().slice(-DAILY_DAYS);
  const out = {};
  for (const k of days) {
    const day = numberMap(src[k], /^[a-z]{1,12}$/, LOG_KINDS.size);
    if (Object.keys(day).length) out[k] = day;
  }
  return out;
}

/** Tolerate anything read from disk. */
function normalizeXp(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const device = typeof src.device === 'string' && DEVICE_RE.test(src.device) && src.device !== LEGACY && src.device !== LOCAL ? src.device : null;
  const counted = cleanByDevice(src.byDevice, src.total);
  const { [LOCAL]: local = 0, ...rest } = counted;
  const byDevice = device && local ? addTo(rest, device, local) : counted;
  // Only a total: this PC is upgrading, and its total becomes legacy until it syncs (mergeXpCounts).
  const hadCounts = src.byDevice && typeof src.byDevice === 'object' && !Array.isArray(src.byDevice);
  const legacyPending = hadCounts ? src.legacyPending === true && own(byDevice, LEGACY) > 0 : own(byDevice, LEGACY) > 0;
  const recent = {};
  for (const k of Object.keys(AWARDS)) {
    const list = Array.isArray(src.recent?.[k]) ? src.recent[k].filter(Number.isFinite) : [];
    recent[k] = list.slice(-AWARDS[k].perHour * FALLOFF[FALLOFF.length - 1][0]);
  }
  const log = (Array.isArray(src.log) ? src.log : []).filter(e => e && LOG_KINDS.has(e.kind) && Number.isFinite(e.at)).slice(0, LOG_MAX);
  const lastDay = typeof src.lastDay === 'string' ? src.lastDay : null;
  const red = numberMap(src.red, /^.{1,80}$/s, MAX_RED, (a, b) => b[1] - a[1]);
  const shipped = Object.fromEntries(Object.entries(src.shipped && typeof src.shipped === 'object' ? src.shipped : {})
    .filter(([k, v]) => k.length <= 80 && typeof v === 'string' && DAY_RE.test(v)).slice(-MAX_RED));
  return {
    total: sum(byDevice), device, byDevice, legacyPending, recent, log, lastDay,
    lastAt: count(src.lastAt), rested: Math.min(RESTED_POOL_MAX, count(src.rested)),
    molt: normalizeMolt(src.molt),
    red, shipped,
    daily: numberMap(src.daily, DAY_RE, DAILY_DAYS),
    dailyKinds: cleanDailyKinds(src.dailyKinds),
    byKind: numberMap(src.byKind, /^[a-z]{1,12}$/, LOG_KINDS.size, (a, b) => b[1] - a[1]),
    // The character sheet's classes he has been (character.js), each announced once.
    classes: [...new Set((Array.isArray(src.classes) ? src.classes : []).filter(c => typeof c === 'string' && CLASS_RE.test(c)))].slice(0, MAX_CLASSES),
    bounties: src.bounties && typeof src.bounties === 'object' ? src.bounties : null,
  };
}

/** Give this PC its id (once). XP earned before then moves to it from 'local'. */
function withDevice(stateIn, id) {
  const state = normalizeXp(stateIn);
  if (state.device || !DEVICE_RE.test(id || '') || id === LEGACY || id === LOCAL) return state;
  return normalizeXp({ ...state, device: id });
}

/** A test run failed in `project`: the next pass there within a day is "green again". */
function markRed(stateIn, project, now) {
  const state = normalizeXp(stateIn);
  const p = clip(project);
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!p || !Number.isFinite(t)) return state;
  return { ...state, red: numberMap({ ...state.red, [p]: t }, /^.{1,80}$/s, MAX_RED, (a, b) => b[1] - a[1]) };
}

/** How much of the base XP the n-th event within the hour still earns. */
function falloff(n, perHour) {
  for (const [times, share] of FALLOFF) if (n < perHour * times) return share;
  return 0;
}

function addTo(map, key, n) { return n > 0 ? { ...map, [key]: own(map, key) + n } : map; }

/**
 * Award XP for one event. Returns { state, gained, before, after, levelUp,
 * markUp, kind, bonuses, bounties, changed } (state is a new object; the old
 * one is never mutated).
 *   kind: one of AWARDS ('tests' becomes 'fixed' after a failure in that project)
 *   meta: { label?, project?,
 *           mult? (the streak bonus to pay, already ebbed: streaks.js ebbMultiplier; at most 1.25),
 *           streak? (current streak in days, when there's no mult: older callers),
 *           restedPool? (the rested-plus perk's bigger pool, at most 200),
 *           bounties?: { count } (4 with the fourth-bounty perk, bounties.js),
 *           sameCode? (a test pass on the very code that failed: a flake, so not 'fixed'),
 *           boost?: { by: 1.5, label: 'Harvest Moon' } (a tide event's, events.js; at most 2×) }
 */
function award(stateIn, kindIn, now, meta = {}) {
  const state = normalizeXp(stateIn);
  const before = levelOf(state);
  const none = { state, gained: 0, before, after: before, levelUp: false, markUp: false, kind: kindIn, bonuses: [], bounties: [], changed: false };
  if (!AWARDS[kindIn]) return none;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return none;
  const today = dayKey(new Date(t));
  const project = clip(meta.project) || null;

  const next = { ...state };
  let kind = kindIn;
  // A pass on the very code that failed (meta.sameCode) is a flake, not a fix: it stays red.
  if (kind === 'tests' && project && next.red[project] && t - next.red[project] < RED_FOR && !meta.sameCode) {
    kind = 'fixed';
    const { [project]: _, ...rest } = next.red;
    next.red = rest;
  }
  const rule = AWARDS[kind];

  let base = rule.xp;
  if (kind === 'day') {
    if (next.lastDay === today) base = 0;
    else next.lastDay = today;
  }
  const recent = next.recent[kind].filter(at => t - at < HOUR);
  base = Math.round(base * falloff(recent.length, rule.perHour));
  const bonuses = [];
  if (base > 0) {
    next.recent = { ...next.recent, [kind]: [...recent, t] };
    if (kind === 'ship' && project && next.shipped[project] !== today) {
      bonuses.push({ label: 'first push today', xp: FIRST_SHIP_XP });
      next.shipped = { ...next.shipped, [project]: today };
    }
    // Back after a break: double XP until the rested pool runs out.
    const pool = Math.min(RESTED_POOL_MAX, Math.max(RESTED_POOL, Math.floor(Number(meta.restedPool) || 0)));
    const rested = state.lastAt && t - state.lastAt >= RESTED_AFTER ? pool : next.rested;
    const extra = Math.min(rested, base);
    if (extra) bonuses.push({ label: 'rested', xp: extra });
    next.rested = rested - extra;
    next.lastAt = Math.max(state.lastAt, t);
  }
  // Only what still pays counts toward the day's bounties, so spamming can't clear them.
  const b = base > 0 ? progressBounties(next.bounties, today, kind, project, { count: meta.bounties?.count }) : { state: next.bounties, completed: [], cleared: false, xp: 0 };
  next.bounties = b.state;
  // A tide event that pays more (events.js boosts): on what the event itself would pay.
  const by = Math.min(2, Number(meta.boost?.by) || 1);
  if (base > 0 && by > 1) bonuses.push({ label: clip(meta.boost.label) || 'tide event', xp: Math.round(base * (by - 1)) });
  const raw = base + bonuses.reduce((n, x) => n + x.xp, 0);
  const given = Number(meta.mult);
  const mult = Number.isFinite(given) ? Math.min(1 + STREAK_MAX, Math.max(1, given)) : streakMultiplier(meta.streak);
  const gainedEvent = raw > 0 ? Math.round(raw * mult) : 0;
  if (gainedEvent > raw) bonuses.push({ label: `×${mult.toFixed(2)} streak`, xp: gainedEvent - raw });
  const gained = gainedEvent + b.xp;

  const bucket = next.device || LOCAL;
  if (gained > 0) {
    next.byDevice = addTo(next.byDevice, bucket, gained);
    next.total = next.total + gained;
    next.daily = numberMap(addTo(next.daily, today, gained), DAY_RE, DAILY_DAYS);
    next.byKind = addTo(addTo(next.byKind, kind, gainedEvent), 'bounty', b.xp);
    // The event's own XP only: bounty XP is in `daily`, not a kind's, so the two needn't add up.
    if (gainedEvent) next.dailyKinds = cleanDailyKinds({ ...next.dailyKinds, [today]: addTo(next.dailyKinds[today] || {}, kind, gainedEvent) });
    // Newest first: the event, then the bounties it finished, then the clear-all on top.
    const entries = [
      ...(b.cleared ? [{ at: t, kind: 'bounty', xp: CLEAR_ALL_XP, label: "All of today's bounties", project: null }] : []),
      ...[...b.completed].reverse().map(done => ({ at: t, kind: 'bounty', xp: done.xp, label: `Bounty: ${done.text}`, project: null })),
      ...(gainedEvent ? [{
        at: t, kind, xp: gainedEvent, label: clip(meta.label) || rule.label, project,
        ...(bonuses.length ? { bonus: bonuses.map(x => x.label).join(' · ') } : {}),
      }] : []),
    ];
    next.log = [...entries, ...state.log].slice(0, LOG_MAX);
  }
  const after = levelOf(next);
  const changed = gained > 0 || JSON.stringify(next) !== JSON.stringify(state);
  return {
    state: next, gained, before, after, levelUp: after.level > before.level, markUp: after.marks > before.marks, kind, bonuses,
    bounties: [...b.completed.map(x => ({ id: x.id, text: x.text, xp: x.xp })), ...(b.cleared ? [{ id: 'all', text: "All of today's bounties", xp: CLEAR_ALL_XP }] : [])],
    changed,
  };
}

/** The streak chip: from a day count (older callers) or streaks.js streakOf(). */
function streakChip(streak) {
  const o = streak && typeof streak === 'object' ? streak : { current: streak };
  const days = Math.max(0, Math.floor(Number(o.current) || 0));
  const mult = Number(o.mult);
  return {
    days,
    multiplier: Number.isFinite(mult) ? Math.min(1 + STREAK_MAX, Math.max(1, mult)) : streakMultiplier(days),
    tideOutsLeft: Number.isInteger(o.tideOutsLeftThisWeek) ? o.tideOutsLeftThisWeek : null,
    tideOutDays: Array.isArray(o.tideOutDays) ? o.tideOutDays.filter(d => DAY_RE.test(d)) : [],
    restToday: o.restToday === true,
    restDays: Array.isArray(o.restDays) ? o.restDays.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [0, 6],
    weeks: Math.max(0, Math.floor(Number(o.weeks) || 0)),
  };
}

/**
 * What the progress bar under the XP bar works toward. Before the first molt,
 * the next level unlock; after it every level unlock is his, so the next
 * tier shell at 99 (tierName: molting.js tierShell(k + 1).name).
 */
function unlockAhead(s, v, tierName) {
  const m = s.molt;
  const into = Math.max(0, s.total - m.base);
  if (!m.count) return nextUnlock(v.level, { xp: into, molts: 0 });
  if (v.level >= MAX_LEVEL) return null;
  const hi = xpForLevel(MAX_LEVEL, m.count);
  return {
    level: MAX_LEVEL, fromLevel: 1, xpToGo: Math.max(0, hi - into), progress: hi ? Math.min(1, into / hi) : 1,
    unlocks: [{ level: MAX_LEVEL, kind: 'shell', icon: '🐚', name: tierName || `Molt ${m.count + 1} shell`, molt: m.count + 1 }],
  };
}

/** Everything the XP card shows. streak: a day count, or streaks.js streakOf(). tierName: see unlockAhead. */
function xpSummary(stateIn, now, streak = 0, { tierName = null, bounties = {} } = {}) {
  const s = normalizeXp(stateIn);
  const t = now instanceof Date ? now.getTime() : Number(now);
  const today = dayKey(new Date(t));
  const v = levelOf(s);
  const days = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const d = new Date(t);
    d.setDate(d.getDate() - i);
    const k = dayKey(d);
    days.push({ day: k, xp: s.daily[k] || 0 });
  }
  return {
    ...v,
    total: s.total, // every XP he has ever earned: a molt keeps it (v.xp counts from the last molt)
    log: s.log.slice(0, 15),
    unlock: unlockAhead(s, v, tierName),
    everLevel: levels.everLevel(s),
    molts: s.molt.count,
    milestone: levels.milestone(v.level),
    streak: streakChip(streak),
    rested: s.lastAt && t - s.lastAt >= RESTED_AFTER ? RESTED_POOL : s.rested,
    bounties: bountiesView(s.bounties, today, bounties),
    daily: days,
    byKind: Object.entries(s.byKind).map(([kind, xp]) => ({ kind, xp })),
    character: characterSheet(s, t),
    ways: Object.entries(AWARDS).map(([kind, a]) => ({ kind, text: a.way, xp: a.xp, claude: !!a.claude })),
  };
}

// ------------------------------------------------------------------ commands

// What a shell command means. Checked against the command text only (the
// caller knows whether it succeeded); the most rewarding match wins.
const DEPLOY_RE = /\b(vercel(\s+deploy)?\s+--prod|vercel\s+deploy|netlify\s+deploy|fly(ctl)?\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish|pages\s+deploy)|railway\s+up|heroku\s+(container:release|releases?)|gh\s+release\s+create|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|cargo\s+publish|twine\s+upload|docker\s+push|kubectl\s+(apply|rollout)|helm\s+(upgrade|install)|terraform\s+apply|pulumi\s+up|serverless\s+deploy|sls\s+deploy|cdk\s+deploy|eb\s+deploy|az\s+webapp\s+deploy|gcloud\s+(app|run|functions)\s+deploy)\b/i;
const SHIP_RE = /\bgit\s+push\b/i;
const TEST_RE = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test(:\w+)?|node\s+--test|pytest|python\d*\s+-m\s+(pytest|unittest)|jest|vitest|mocha|ava|tap|go\s+test|cargo\s+(test|nextest)|dotnet\s+test|mvn\s+(-\S+\s+)*(test|verify)|gradlew?\s+(test|check)|phpunit|rspec|rake\s+test|mix\s+test|deno\s+test|playwright\s+test|cypress\s+run|ctest|tox|nox|swift\s+test|flutter\s+test|bats)\b/i;

/** 'deploy' | 'ship' | 'tests' | null for a command. */
function classifyCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  const c = cmd.slice(0, 2000);
  if (/--dry-run|\s-n\s|--whatif|-WhatIf/i.test(c)) return null; // rehearsals don't count
  if (DEPLOY_RE.test(c)) return 'deploy';
  if (SHIP_RE.test(c)) return 'ship';
  if (TEST_RE.test(c)) return 'tests';
  return null;
}

module.exports = {
  AWARDS, TITLES, RANKS, UNLOCKS, MAX_LEVEL, MAX_MARKS, LEGACY,
  xpForLevel, xpForMarks, marksFor, titleFor, rankFor, levelFor, unlocksBetween, nextUnlock, streakMultiplier,
  normalizeXp, withDevice, markRed, award, xpSummary, mergeXpCounts, cleanByDevice, classifyCommand,
  levelOf, normalizeMolt, mergeMolt, everLevel: levels.everLevel, RESTED_POOL, RESTED_POOL_MAX,
};
