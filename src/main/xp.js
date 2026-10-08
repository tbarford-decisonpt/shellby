// XP and levels. Shellby earns XP when tasks finish, tests pass, code ships or
// deploys, and most of all when he writes himself a new skill or agent; and,
// with or without Claude, when you pet him, play with him, he digs you up a
// gift or the two of you grow closer. Enough XP and he levels up. Turning failing tests green, the first push of the day
// to a project, a running streak and coming back after a break all pay extra;
// doing the same thing over and over pays less and less. Pure: no I/O, no
// clock (callers pass `now`). See test/xp.test.js.
//
// XP is kept per PC (byDevice) so sync can add PCs together without counting
// anything twice: each PC only ever grows its own count, and merging takes the
// larger of each. XP earned before that existed sits in the 'legacy' bucket.
const shells = require('./shells');
const { progressBounties, bountiesView, CLEAR_ALL_XP } = require('./bounties');
const { characterSheet } = require('./character');

// `claude`: only Claude Code work earns it, so just-the-crab mode leaves it off
// the list of ways to earn (panel/xp.js).
const AWARDS = Object.freeze({
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
  deps: { xp: 30, perHour: 2, label: 'Clean dependency audit', way: 'A dependency audit comes back clean', claude: true },
  // Lean Shell (efficiency.js): only for things that cost nothing in quality. Never
  // for cheaper tasks, shorter replies or fewer turns, which would reward cutting corners.
  tidy: { xp: 30, perHour: 6, label: 'Tidied his toolbox', way: 'Turns off a plugin or MCP server that sits idle', claude: true },
  treasure: { xp: 30, perHour: 2, label: 'He dug up something rare', way: 'Digs up something rare' },
  tests: { xp: 25, perHour: 6, label: 'Tests passed', way: 'Tests pass', claude: true },
  home: { xp: 20, perHour: 6, label: 'Brought work home green', way: "Brings a copy's work home with its tests passing", claude: true },
  helped: { xp: 15, perHour: 6, label: "Put a helper's find to use", way: 'Acts on what one of his helper agents found', claude: true },
  trophy: { xp: 20, perHour: 30, label: 'Earned a trophy', way: 'Earns a trophy' },
  fresh: { xp: 20, perHour: 2, label: 'Started a crowded chat fresh', way: 'Starts a crowded conversation fresh with a summary', claude: true },
  quiz: { xp: 15, perHour: 3, label: "Passed a quiz on Claude's work", way: 'You pass a quiz on a change Claude made', claude: true },
  focus: { xp: 15, perHour: 3, label: 'Finished a focus session', way: 'Finishes a focus session' },
  // Swaps with friends (swaps.js).
  swap: { xp: 15, perHour: 3, label: 'Swapped finds with a friend', way: 'Swaps a find with a friend' },
  task: { xp: 10, perHour: 60, label: 'Finished a task', way: 'Finishes a task', claude: true },
  catch: { xp: 10, perHour: 6, label: 'Caught a bug', way: 'Fixes a bug and catches it for the Bugdex', claude: true },
  play: { xp: 10, perHour: 4, label: 'Played a game with him', way: 'Plays hide and seek or fetch with you' },
  find: { xp: 8, perHour: 4, label: 'He dug you up a gift', way: 'Digs you up a gift' },
  day: { xp: 5, perHour: 1, label: 'Another day together', way: 'Each day you use him' },
  feed: { xp: 3, perHour: 3, label: 'Fed Shellby a snack', way: 'You feed him a snack' },
  care: { xp: 3, perHour: 2, label: 'Looked after Shellby', way: 'You rinse him or tuck him in' },
  pet: { xp: 2, perHour: 5, label: 'Petted Shellby', way: 'You pet him' },
});
// Log-only kinds: paid by the day's bounties, not by an event.
const LOG_KINDS = new Set([...Object.keys(AWARDS), 'bounty']);

const TITLES = [
  [1, 'Hatchling'], [2, 'Tide-pooler'], [3, 'Shell Seeker'], [4, 'Reef Runner'], [5, 'Claw Coder'],
  [6, 'Kelp Hacker'], [7, 'Shell Engineer'], [8, 'Reef Architect'], [9, 'Deep Diver'], [10, 'Coral Commander'],
  [12, 'Abyssal Admin'], [15, 'Leviathan'], [20, 'Legend of the Tides'],
  [25, 'Tidecaller'], [30, 'Reef Warden'], [35, 'Current Rider'], [40, 'Trench Explorer'], [45, 'Pearl Diver'],
  [50, 'Kraken Tamer'], [55, 'Storm Shell'], [60, 'Lighthouse Keeper'], [65, 'Sunken Sage'], [70, 'Maelstrom'],
  [75, 'Tsunami'], [80, 'Ocean Sovereign'], [85, 'Mariana Monarch'], [90, 'Elder of the Deep'], [95, 'Mythic Mariner'],
  [99, 'Shellby Supreme'],
];
// The level badge changes colour every ten levels.
const RANKS = [
  [1, 'Sunlit', '#ffd23f'], [10, 'Coral', '#ff8c69'], [20, 'Lagoon', '#3fd0c9'], [30, 'Kelp', '#7bd389'],
  [40, 'Deep', '#4ea8ff'], [50, 'Amethyst', '#b388ff'], [60, 'Ruby', '#ff5d73'], [70, 'Pearl', '#f3eadf'],
  [80, 'Abyss', '#8c9eff'], [90, 'Prism', '#ff9ec4'],
];
const MAX_LEVEL = 99;
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
const DAILY_DAYS = 30;
const CLASS_RE = /^[a-z-]{1,24}$/;
const MAX_CLASSES = 16;
// Within an hour: full XP up to perHour, then half, then a quarter, then none.
const FALLOFF = [[1, 1], [2, 0.5], [4, 0.25]];

/** Total XP needed to reach `level` (level 1 = 0, 2 = 100, 3 = 250, 5 = 700, 10 = 2,700). */
function xpForLevel(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 25 * (l - 1) * (l + 2);
}

const lastAtOrBelow = (list, level) => list.reduce((hit, row) => (level >= row[0] ? row : hit), list[0]);
const titleFor = level => lastAtOrBelow(TITLES, level)[1];
function rankFor(level) {
  const [, name, color] = lastAtOrBelow(RANKS, level);
  return { name, color };
}

// Everything a level can unlock, lowest first: titles, badge colours and shells.
const UNLOCKS = Object.freeze([
  ...TITLES.filter(([l]) => l > 1).map(([level, name]) => ({ level, kind: 'title', name })),
  ...RANKS.filter(([l]) => l > 1).map(([level, name, color]) => ({ level, kind: 'rank', name: `${name} badge`, color })),
  ...shells.SHELLS.map(s => ({ level: s.level, kind: 'shell', name: s.name, id: s.id })),
].sort((a, b) => a.level - b.level || a.kind.localeCompare(b.kind)).map(u => Object.freeze(u)));

/** What a level-up from `before` to `after` unlocks. */
const unlocksBetween = (before, after) => UNLOCKS.filter(u => u.level > before && u.level <= after);

/** The next level that unlocks anything, with everything it unlocks; null at the top. */
function nextUnlock(level) {
  const first = UNLOCKS.find(u => u.level > level);
  return first ? { level: first.level, unlocks: UNLOCKS.filter(u => u.level === first.level) } : null;
}

/** { level, title, rank, xp, floor, next, into, needed, progress (0..1) } for a total. */
function levelFor(total) {
  const xp = Math.max(0, Math.floor(Number(total) || 0));
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  const floor = xpForLevel(level);
  const next = level < MAX_LEVEL ? xpForLevel(level + 1) : floor;
  return {
    level, title: titleFor(level), rank: rankFor(level), xp, floor, next,
    into: xp - floor, needed: next - floor,
    progress: next > floor ? (xp - floor) / (next - floor) : 1,
  };
}

/** The streak bonus as a multiplier: 1 + 5% per full week, at most 1.25. */
const streakMultiplier = days => 1 + Math.min(STREAK_MAX, STREAK_STEP * Math.floor(Math.max(0, Number(days) || 0) / 7));

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
  return { byDevice, total: sum(byDevice) };
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
    lastAt: count(src.lastAt), rested: Math.min(RESTED_POOL, count(src.rested)),
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
 * kind, bonuses, bounties, changed } (state is a new object; the old one is
 * never mutated).
 *   kind: one of AWARDS ('tests' becomes 'fixed' after a failure in that project)
 *   meta: { label?, project?, streak? (current streak in days),
 *           sameCode? (a test pass on the very code that failed: a flake, so not 'fixed'),
 *           boost?: { by: 1.5, label: 'Harvest Moon' } (a tide event's, events.js; at most 2×) }
 */
function award(stateIn, kindIn, now, meta = {}) {
  const state = normalizeXp(stateIn);
  const before = levelFor(state.total);
  const none = { state, gained: 0, before, after: before, levelUp: false, kind: kindIn, bonuses: [], bounties: [], changed: false };
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
    const rested = state.lastAt && t - state.lastAt >= RESTED_AFTER ? RESTED_POOL : next.rested;
    const extra = Math.min(rested, base);
    if (extra) bonuses.push({ label: 'rested', xp: extra });
    next.rested = rested - extra;
    next.lastAt = Math.max(state.lastAt, t);
  }
  // Only what still pays counts toward the day's bounties, so spamming can't clear them.
  const b = base > 0 ? progressBounties(next.bounties, today, kind, project) : { state: next.bounties, completed: [], cleared: false, xp: 0 };
  next.bounties = b.state;
  // A tide event that pays more (events.js boosts): on what the event itself would pay.
  const by = Math.min(2, Number(meta.boost?.by) || 1);
  if (base > 0 && by > 1) bonuses.push({ label: clip(meta.boost.label) || 'tide event', xp: Math.round(base * (by - 1)) });
  const raw = base + bonuses.reduce((n, x) => n + x.xp, 0);
  const mult = streakMultiplier(meta.streak);
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
  const after = levelFor(next.total);
  const changed = gained > 0 || JSON.stringify(next) !== JSON.stringify(state);
  return {
    state: next, gained, before, after, levelUp: after.level > before.level, kind, bonuses,
    bounties: [...b.completed.map(x => ({ id: x.id, text: x.text, xp: x.xp })), ...(b.cleared ? [{ id: 'all', text: "All of today's bounties", xp: CLEAR_ALL_XP }] : [])],
    changed,
  };
}

/** Everything the XP card shows. */
function xpSummary(stateIn, now, streak = 0) {
  const s = normalizeXp(stateIn);
  const t = now instanceof Date ? now.getTime() : Number(now);
  const today = dayKey(new Date(t));
  const v = levelFor(s.total);
  const days = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const d = new Date(t);
    d.setDate(d.getDate() - i);
    const k = dayKey(d);
    days.push({ day: k, xp: s.daily[k] || 0 });
  }
  const up = nextUnlock(v.level);
  return {
    ...v,
    log: s.log.slice(0, 15),
    unlock: up && { ...up, xpToGo: Math.max(0, xpForLevel(up.level) - s.total) },
    streak: { days: Math.max(0, Math.floor(Number(streak) || 0)), multiplier: streakMultiplier(streak) },
    rested: s.lastAt && t - s.lastAt >= RESTED_AFTER ? RESTED_POOL : s.rested,
    bounties: bountiesView(s.bounties, today),
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
  AWARDS, TITLES, RANKS, UNLOCKS, MAX_LEVEL, LEGACY,
  xpForLevel, titleFor, rankFor, levelFor, unlocksBetween, nextUnlock, streakMultiplier,
  normalizeXp, withDevice, markRed, award, xpSummary, mergeXpCounts, cleanByDevice, classifyCommand,
};
