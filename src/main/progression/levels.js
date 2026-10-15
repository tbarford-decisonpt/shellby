// Levels 1 to 99 and everything each one unlocks: titles, badge colours, shells,
// tank decor and effects (src/wardrobe/depths.json), perks, quest chapters and
// tank sizes, plus the ceremony a milestone level gets
// (docs/GAMIFICATION-PLAN.md section 2.3). Kept apart from progression/xp.js so the
// catalogue can grow without it; progression/xp.js re-exports what it always had.
//
// Every gate reads everLevel: the highest level ever reached. A molt
// (progression/molting.js) starts the number again at 1 but keeps everything, so after any
// molt everLevel is 99.
// Pure: no I/O, no clock. See test/levels.test.js.
const shells = require('./shells');
/** @type {{ decor?: Array<{ id: string, name: string }>, effects?: Array<{ id: string, name: string }> }} */
// @ts-ignore: noResolve leaves the json out of the program
const depths = require('../../wardrobe/depths.json');

const MAX_LEVEL = 99;

const TITLES = Object.freeze(/** @type {Array<[number, string]>} */ ([
  [1, 'Hatchling'], [2, 'Tide-pooler'], [3, 'Shell Seeker'], [4, 'Reef Runner'], [5, 'Claw Coder'],
  [6, 'Kelp Hacker'], [7, 'Shell Engineer'], [8, 'Reef Architect'], [9, 'Deep Diver'], [10, 'Coral Commander'],
  [12, 'Abyssal Admin'], [15, 'Leviathan'], [20, 'Legend of the Tides'],
  [25, 'Tidecaller'], [30, 'Reef Warden'], [35, 'Current Rider'], [40, 'Trench Explorer'], [45, 'Pearl Diver'],
  [50, 'Kraken Tamer'], [55, 'Storm Shell'], [60, 'Lighthouse Keeper'], [65, 'Sunken Sage'], [70, 'Maelstrom'],
  [75, 'Tsunami'], [80, 'Ocean Sovereign'], [85, 'Mariana Monarch'], [90, 'Elder of the Deep'], [95, 'Mythic Mariner'],
  [99, 'Shellby Supreme'],
]).map(r => Object.freeze(r)));
// The level badge changes colour every ten levels.
const RANKS = Object.freeze(/** @type {Array<[number, string, string]>} */ ([
  [1, 'Sunlit', '#ffd23f'], [10, 'Coral', '#ff8c69'], [20, 'Lagoon', '#3fd0c9'], [30, 'Kelp', '#7bd389'],
  [40, 'Deep', '#4ea8ff'], [50, 'Amethyst', '#b388ff'], [60, 'Ruby', '#ff5d73'], [70, 'Pearl', '#f3eadf'],
  [80, 'Abyss', '#8c9eff'], [90, 'Prism', '#ff9ec4'],
]).map(r => Object.freeze(r)));

// Quality of life and looks only: none of them earns XP faster from doing more.
const PERKS = Object.freeze({
  'rested-plus': { level: 22, name: 'Deeper rest', text: 'Coming back after a break pays double for up to 200 XP, not 150' },
  'bounty-reroll': { level: 28, name: 'Bounty reroll', text: 'Swap one of the day\'s bounties for another, once a day' },
  'fourth-bounty': { level: 33, name: 'Fourth bounty', text: 'Four daily bounties instead of three' },
  'battle-replay': { level: 38, name: 'Battle replays', text: 'Replay any past battle from the Bugdex history' },
  'tide-out-plus': { level: 44, name: 'Longer tides', text: 'Two tide-out days a week keep the streak, not one' },
  'reef-forecast': { level: 52, name: 'Reef forecast', text: 'The reef shows a four-week trend line' },
  'golden-jar': { level: 58, name: 'Golden jars', text: 'Jars in the tank can show their best form' },
  'crew-cosmetics': { level: 66, name: 'Crew colours', text: 'Helper crabs wear your title colour' },
  'card-foil': { level: 77, name: 'Foil cards', text: 'The crab card and Wrapped card get a foil border' },
  'wrapped-extra': { level: 88, name: 'Deep cuts', text: 'Wrapped gets a bonus "deep cuts" slide' },
  molting: { level: 99, name: 'The Molt', text: 'Start again at level 1 with everything kept, for a tier shell of his own' },
});

// Quest chapters (quests/chapters.js, WP4) open by level too; named here so a level can say so.
/** @type {ReadonlyArray<[number, string, string]>} */
const CHAPTERS = Object.freeze([
  [5, 'reef-wakes', 'Chapter 2: The Reef Wakes'], [8, 'bug-hunter', 'Chapter 3: Bug Hunter'],
  [10, 'clockwork', 'Chapter 4: Clockwork'], [15, 'second-opinions', 'Chapter 5: Second Opinions'],
  [20, 'home-improvement', 'Chapter 6: Home Improvement'], [25, 'tides-and-friends', 'Chapter 7: Tides and Friends'],
  [30, 'keeper', 'Chapter 8: Keeper'], [40, 'long-watch', 'Chapter 9: The Long Watch'],
  [60, 'the-deep', 'Chapter 10: The Deep'], [90, 'molting-season', 'Chapter 11: Molting Season'],
]);

// Tank sizes (tank/index.js SIZES) past the first few, named for the level that opens them.
/** @type {ReadonlyArray<[number, string, string]>} */
const SIZES = Object.freeze([[5, 'ten-gallon', '10 gallon tank'], [15, 'thirty-gallon', '30 gallon tank'], [30, 'reef', 'Reef tank'], [50, 'grand', 'Grand aquarium']]);

// Decor and effects by level: the art is in src/wardrobe/depths.json, keyed by id.
/** @type {ReadonlyArray<[number, string, string]>} */
const ITEMS = Object.freeze([
  [21, 'decor', 'lagoon-lantern'], [23, 'effect', 'bubble-trail'], [26, 'decor', 'kelp-arch'], [27, 'effect', 'ripple-step'],
  [29, 'decor', 'tide-clock'], [31, 'decor', 'brain-coral'], [34, 'effect', 'plankton-glow'], [36, 'decor', 'sunken-terminal'],
  [37, 'effect', 'ink-puff'], [39, 'decor', 'sea-fan'], [41, 'decor', 'anglerfish-lamp'], [43, 'effect', 'deep-sparkle'],
  [46, 'decor', 'pearl-oyster'], [47, 'effect', 'pressure-shimmer'], [48, 'decor', 'diving-bell'], [50, 'decor', 'kraken-arm'],
  [51, 'effect', 'amethyst-aura'], [53, 'decor', 'geode-cluster'], [56, 'decor', 'lightning-jar'], [57, 'effect', 'rain-cloud'],
  [59, 'decor', 'shipwreck-mast'], [60, 'decor', 'lighthouse-beacon'], [61, 'effect', 'beam-sweep'], [63, 'decor', 'message-buoy'],
  [64, 'effect', 'ember-float'], [67, 'decor', 'sage-scroll'], [69, 'effect', 'rune-glow'], [70, 'decor', 'whirlpool'],
  [71, 'effect', 'vortex-idle'], [73, 'decor', 'moon-jelly'], [74, 'effect', 'tidal-wake'], [76, 'decor', 'wave-crest'],
  [79, 'decor', 'drowned-bell'], [80, 'decor', 'sovereign-throne'], [81, 'effect', 'abyss-eyes'], [83, 'decor', 'bioluminescent-garden'],
  [84, 'effect', 'crown-glint'], [86, 'decor', 'trench-vent'], [89, 'effect', 'deep-current'], [91, 'decor', 'prism-crystal'],
  [92, 'effect', 'prism-trail'], [94, 'decor', 'elder-statue'], [96, 'effect', 'myth-halo'], [97, 'decor', 'world-shell'],
  [98, 'effect', 'countdown-sparks'], [99, 'decor', 'supreme-pedestal'],
]);

const ICONS = Object.freeze({ title: '📜', rank: '🎖️', shell: '🐚', decor: '🪸', effect: '✨', perk: '⭐', chapter: '📖', size: '🐠' });
// Within a level, the shell leads (it's the headline), then the title and badge.
const KIND_ORDER = ['shell', 'title', 'rank', 'decor', 'effect', 'perk', 'size', 'chapter'];

// What depths.json actually has: an unlock whose art hasn't landed is left out, never shown broken.
const ART = new Map([
  ...(depths.decor || []).map(x => /** @type {[string, { id: string, name: string }]} */ ([`decor:${x.id}`, x])),
  ...(depths.effects || []).map(x => /** @type {[string, { id: string, name: string }]} */ ([`effect:${x.id}`, x])),
]);
/** Level unlocks the table names but depths.json doesn't have yet (test/levels.test.js lists them). */
const MISSING_ART = Object.freeze(ITEMS.filter(([, kind, id]) => !ART.has(`${kind}:${id}`)).map(([level, kind, id]) => ({ level, kind, id })));

const UNLOCKS = Object.freeze([
  ...TITLES.filter(([l]) => l > 1).map(([level, name]) => ({ level, kind: 'title', name })),
  ...RANKS.filter(([l]) => l > 1).map(([level, name, color]) => ({ level, kind: 'rank', name: `${name} badge`, color })),
  ...shells.SHELLS.map(s => ({ level: s.level, kind: 'shell', name: s.name, id: s.id })),
  ...ITEMS.filter(([, kind, id]) => ART.has(`${kind}:${id}`)).map(([level, kind, id]) => ({ level, kind, name: /** @type {{ name: string }} */ (ART.get(`${kind}:${id}`)).name, id })),
  ...Object.entries(PERKS).map(([id, p]) => ({ level: p.level, kind: 'perk', name: p.name, id, text: p.text })),
  ...SIZES.map(([level, id, name]) => ({ level, kind: 'size', name, id })),
  ...CHAPTERS.map(([level, id, name]) => ({ level, kind: 'chapter', name, id })),
].sort((a, b) => a.level - b.level || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  .map(u => Object.freeze({ ...u, icon: ICONS[u.kind] })));

/**
 * How much more (or less) each level costs on the k-th time round: the first
 * replay is quicker, then it slowly gets steeper, at most double.
 */
function curveMult(kIn) {
  const k = Math.max(0, Math.floor(Number(kIn) || 0));
  if (k === 0 || k === 3) return 1;
  if (k === 1) return 0.8;
  if (k === 2) return 0.9;
  return Math.min(2, 1 + 0.1 * (k - 3));
}

/** XP needed to reach `level` (level 1 = 0, 2 = 100, 3 = 250, 10 = 2,700), times curveMult(molts). */
function xpForLevel(level, molts = 0) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return Math.round(25 * (l - 1) * (l + 2) * curveMult(molts));
}

const lastAtOrBelow = (list, level) => list.reduce((hit, row) => (level >= row[0] ? row : hit), list[0]);
const titleFor = level => lastAtOrBelow(TITLES, level)[1];
function rankFor(level) {
  const [, name, color] = lastAtOrBelow(RANKS, level);
  return { name, color };
}

/** Just the level number for `xp` earned since the last molt, on the k-th curve. */
function levelNumber(xpIn, molts = 0) {
  const xp = Math.max(0, Math.floor(Number(xpIn) || 0));
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1, molts)) level++;
  return level;
}

/** Everything that unlocks exactly at `level`. */
const unlocksAt = level => UNLOCKS.filter(u => u.level === level);

/** What a level-up from `before` to `after` unlocks. */
const unlocksBetween = (before, after) => UNLOCKS.filter(u => u.level > before && u.level <= after);

/**
 * The next level that unlocks anything, with everything it unlocks; null at the top.
 *   fromLevel: the level of the unlock before it (where its progress bar starts)
 *   with { xp, molts }: also xpToGo and progress (0..1) from fromLevel's XP to its own
 * @param {number} level
 * @param {{ xp?: number | null, molts?: number }} [opts]
 */
function nextUnlock(level, { xp = null, molts = 0 } = {}) {
  const first = UNLOCKS.find(u => u.level > level);
  if (!first) return null;
  const before = [...UNLOCKS].reverse().find(u => u.level <= level);
  const fromLevel = before ? before.level : 1;
  const out = { level: first.level, unlocks: unlocksAt(first.level), fromLevel };
  if (xp == null) return out;
  const lo = xpForLevel(fromLevel, molts), hi = xpForLevel(first.level, molts);
  const have = Math.max(0, Math.floor(Number(xp) || 0));
  return { ...out, xpToGo: Math.max(0, hi - have), progress: hi > lo ? Math.min(1, Math.max(0, (have - lo) / (hi - lo))) : 1 };
}

/** The perks open at the level ever reached, by id. */
const perksFor = everLevel => new Set(Object.entries(PERKS).filter(([, p]) => everLevel >= p.level).map(([id]) => id));

const MAJOR = new Set([20, 30, 40, 60, 70, 80, 90]);
const LEGEND = new Set([50, 99]);

/**
 * The party a level gets: 'minor' (the usual level-up), 'major' (a full-panel
 * ceremony in the new rank's colour) or 'legend' (that, plus a card to share
 * and a journal entry). Null below level 2.
 */
function milestone(level) {
  if (!Number.isInteger(level) || level < 2 || level > MAX_LEVEL) return null;
  const tier = LEGEND.has(level) ? 'legend' : MAJOR.has(level) ? 'major' : 'minor';
  const rank = rankFor(level);
  return { tier, fanfare: { title: titleFor(level), rank: rank.name, color: rank.color, count: unlocksAt(level).length } };
}

/** The highest level ever reached: 99 after any molt, else the level now. */
function everLevel(xpState) {
  const molts = Math.max(0, Math.floor(Number(xpState?.molt?.count) || 0));
  if (molts > 0) return MAX_LEVEL;
  return levelNumber(Number(xpState?.total) || 0, 0);
}

/**
 * config.unlockSeen: { level (the everLevel the unlock list was last looked at),
 * worn: [shell ids he has worn, for the every-shell quest] }.
 */
function normalizeUnlockSeen(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const level = Number.isInteger(r.level) ? Math.max(1, Math.min(MAX_LEVEL, r.level)) : 1;
  const worn = [...new Set((Array.isArray(r.worn) ? r.worn : []).filter(id => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)))].slice(0, 200);
  return { level, worn };
}

/** The whole ladder for the Unlocks list: every level 2-99 with what it holds and whether it's his. */
function ladder(ever, seenLevel = ever) {
  const out = [];
  for (let level = 2; level <= MAX_LEVEL; level++) {
    out.push({ level, owned: ever >= level, isNew: ever >= level && level > seenLevel, tier: /** @type {{ tier: string }} */ (milestone(level)).tier, unlocks: unlocksAt(level) });
  }
  return out;
}

module.exports = {
  MAX_LEVEL, TITLES, RANKS, PERKS, CHAPTERS, UNLOCKS, MISSING_ART, ICONS,
  curveMult, xpForLevel, titleFor, rankFor, levelNumber,
  unlocksAt, unlocksBetween, nextUnlock, perksFor, milestone, everLevel, normalizeUnlockSeen, ladder,
};
