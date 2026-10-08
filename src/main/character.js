// The character sheet: RPG-style stats worked out from the XP he already
// keeps (xp.js byKind, lifetime XP per kind, and dailyKinds, the last 30
// days of it). Four stats, each fed by the XP kinds that show it:
//   Shipping  pushes, deploys and issues taken to a pull request
//   Rigour    green test runs, flaky tests fixed, clean dependency audits
//   Craft     skills, agents and mods he writes himself
//   Tidiness  Lean Shell: idle plugins turned off, crowded chats started fresh
// A class falls out of whichever is highest (two close together make a dual
// class, all four together a Polymath). Nothing new is stored but the classes
// he has been, so each one is announced only the first time.
// Pure: no I/O, no clock (callers pass `now`). See test/character.test.js.

// scale: XP for a stat of 10. Stats grow with the square root of XP, so 4x the
// XP doubles a stat. Scales differ because the kinds do: tricks pay 150 XP but
// are rare; test runs pay 25 and come by the dozen; there are only so many
// idle plugins to turn off.
const STATS = Object.freeze([
  { id: 'shipping', name: 'Shipping', short: 'SHP', icon: '⬆️', kinds: ['ship', 'deploy', 'issue'], scale: 400, what: 'Pushes, deploys and issues taken all the way to a pull request' },
  { id: 'rigour', name: 'Rigour', short: 'RIG', icon: '✅', kinds: ['tests', 'fixed', 'flakefix', 'deps'], scale: 500, what: 'Green test runs, flaky tests fixed and clean dependency audits' },
  { id: 'craft', name: 'Craft', short: 'CRF', icon: '🧠', kinds: ['trick'], scale: 300, what: 'Skills, agents and mods he writes himself' },
  { id: 'tidiness', name: 'Tidiness', short: 'TDY', icon: '🧹', kinds: ['tidy', 'fresh'], scale: 120, what: 'Idle plugins turned off and crowded chats started fresh' },
].map(s => Object.freeze({ ...s, kinds: Object.freeze(s.kinds) })));

const MAX_STAT = 99;
const MIN_CLASS = 5;      // a stat this high before he has a class at all
const DUAL_SHARE = 0.85;  // the runner-up this close to the top: a dual class
const ALL_SHARE = 0.75;   // every stat this close to the top: Polymath
const WEEK = 7;

const CLASSES = Object.freeze({
  shipping: { name: 'Shipper', icon: '🚢', blurb: 'Gets it out the door.' },
  rigour: { name: 'Tester', icon: '🧪', blurb: "Doesn't trust it until it's green." },
  craft: { name: 'Toolsmith', icon: '🛠️', blurb: 'Builds the tools that build the thing.' },
  tidiness: { name: 'Curator', icon: '🧹', blurb: 'Keeps the toolbox lean.' },
  'shipping-rigour': { name: 'Release Engineer', icon: '🏁', blurb: 'Ships often, and ships green.' },
  'shipping-craft': { name: 'Inventor', icon: '💡', blurb: 'Makes new tools and ships with them.' },
  'shipping-tidiness': { name: 'Streamliner', icon: '⚡', blurb: 'Ships fast and travels light.' },
  'rigour-craft': { name: 'Artificer', icon: '⚙️', blurb: 'Builds careful tools and proves they work.' },
  'rigour-tidiness': { name: 'Auditor', icon: '🔍', blurb: 'Checks everything, keeps nothing idle.' },
  'craft-tidiness': { name: 'Architect', icon: '📐', blurb: "Adds the tools that help, drops the ones that don't." },
  polymath: { name: 'Polymath', icon: '🦀', blurb: 'A claw in everything.' },
  wanderer: { name: 'Wanderer', icon: '🐚', blurb: 'Still finding his calling. Ship, test, write a trick or tidy up.' },
});
const CLASS_IDS = Object.freeze(Object.keys(CLASSES));

const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const own = (map, key) => (map && Object.hasOwn(map, key) ? count(map[key]) : 0);
const xpOf = (stat, byKind) => stat.kinds.reduce((n, k) => n + own(byKind, k), 0);

/** The stat a total of XP makes: 10 at `scale`, then with the square root, at most 99. */
function statValue(xp, scale) {
  return Math.min(MAX_STAT, Math.floor(10 * Math.sqrt(count(xp) / scale)));
}

/** XP a stat needs to reach `value`. */
const xpForStat = (value, scale) => Math.ceil(scale * (value / 10) ** 2);

/**
 * The class for a set of { id, score } (score: the stat, unfloored). The
 * highest stat names it; a runner-up within DUAL_SHARE makes a dual class;
 * every stat within ALL_SHARE makes a Polymath. Below MIN_CLASS: Wanderer.
 */
function classFor(scores, min = MIN_CLASS) {
  const order = STATS.map(s => s.id);
  const ranked = [...scores].sort((a, b) => b.score - a.score || order.indexOf(a.id) - order.indexOf(b.id));
  const top = ranked[0];
  if (!top || !(top.score >= min)) return classView('wanderer', []);
  if (ranked.length === STATS.length && ranked.every(s => s.score >= top.score * ALL_SHARE)) return classView('polymath', order);
  const second = ranked[1];
  if (second && second.score >= top.score * DUAL_SHARE) {
    const pair = [top.id, second.id].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return classView(pair.join('-'), pair);
  }
  return classView(top.id, [top.id]);
}

const classView = (id, stats) => ({ id, ...CLASSES[id], stats });

// XP per kind over the last `days` days (today included), from dailyKinds.
function recentByKind(dailyKinds, now, days) {
  const out = {};
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return out;
  for (let i = 0; i < days; i++) {
    const d = new Date(t);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = dailyKinds?.[key];
    if (!day || typeof day !== 'object') continue;
    for (const [k, n] of Object.entries(day)) out[k] = (out[k] || 0) + count(n);
  }
  return out;
}

/**
 * Everything the sheet shows, from a normalized XP state (xp.js normalizeXp):
 * { stats: [{ id, name, short, icon, what, value, xp, week, gain, next, progress }],
 *   cls, weekCls (null for a week with no stat XP), seen: [{ id, name, icon } of classes met] }
 *   week: XP into the stat over the last seven days; gain: stat points it added
 */
function characterSheet(xp, now) {
  const byKind = xp?.byKind || {};
  const week = recentByKind(xp?.dailyKinds, now, WEEK);
  const stats = STATS.map(s => {
    const total = xpOf(s, byKind);
    // A week can't have earned more than all time (sync, or a PC's clock).
    const weekXp = Math.min(total, xpOf(s, week));
    const value = statValue(total, s.scale);
    const floor = xpForStat(value, s.scale), next = xpForStat(value + 1, s.scale);
    return {
      id: s.id, name: s.name, short: s.short, icon: s.icon, what: s.what,
      value, xp: total, week: weekXp, gain: value - statValue(total - weekXp, s.scale),
      next: value < MAX_STAT ? next - total : 0,
      progress: value < MAX_STAT ? (total - floor) / (next - floor) : 1,
    };
  });
  const score = (s, n) => 10 * Math.sqrt(n / s.scale);
  const weekScores = STATS.map((s, i) => ({ id: s.id, score: score(s, stats[i].week) }));
  return {
    stats,
    cls: classFor(STATS.map((s, i) => ({ id: s.id, score: score(s, stats[i].xp) }))),
    // This week's class: what the week looked like, with any stat XP at all.
    weekCls: weekScores.some(s => s.score > 0) ? classFor(weekScores, 0) : null,
    seen: (xp?.classes || []).filter(id => CLASS_IDS.includes(id)).map(id => ({ id, name: CLASSES[id].name, icon: CLASSES[id].icon })),
  };
}

/** Does XP of this kind feed a stat? Only those can change his class. */
const isStatKind = kind => STATS.some(s => s.kinds.includes(kind));

/** The XP state with `id` added to the classes he has been. */
function noteClass(xp, id) {
  const seen = Array.isArray(xp?.classes) ? xp.classes : [];
  return seen.includes(id) || !CLASS_IDS.includes(id) ? xp : { ...xp, classes: [...seen, id] };
}

/**
 * A class he has never been before, now that `after` (a normalized XP state) is his state: the class,
 * or null. Wanderer is where everyone starts, so it never counts.
 */
function newClass(after, now) {
  const { cls, seen } = characterSheet(after, now);
  return cls.id !== 'wanderer' && !seen.some(x => x.id === cls.id) ? cls : null;
}

module.exports = { STATS, CLASSES, CLASS_IDS, MAX_STAT, MIN_CLASS, statValue, xpForStat, classFor, characterSheet, isStatKind, noteClass, newClass };
