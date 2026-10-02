// Shellby's voice and his little habits: the short lines he says in his bubble,
// and what he gets up to when nothing's happening. Every line is his own —
// Shellby never quotes Claude.
//
// Pure: no I/O, no clock, no randomness of its own (callers pass `now` and
// `rand`), so the whole personality is testable. See test/voice.test.js.
//
// Three rules keep him a pet instead of a nuisance:
//   1. 'quiet' says nothing at all, ever — exactly the glyph-only Shellby.
//   2. Every occasion has a cooldown, and a global gap sits between any two
//      lines, so he can't chatter.
//   3. He never repeats a line while another one in the pool is unused.
// A fourth rule lives in the renderer: anything that matters (a health alert, a
// red build, a countdown) outranks everything here.

const { classifyCommand } = require('./xp');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// How talkative he is. 'quiet' is the pre-voice Shellby, kept as a real choice.
const CHATTER = Object.freeze(['quiet', 'normal', 'chatty']);
// Smallest gap between any two lines, whatever the occasion.
const GAP = Object.freeze({ quiet: Infinity, normal: 40 * SECOND, chatty: 12 * SECOND });
// 'chatty' shortens every cooldown; 'normal' uses them as written.
const COOLDOWN_SCALE = Object.freeze({ quiet: Infinity, normal: 1, chatty: 0.4 });
// The bubble holds two short lines. Longer than this and he'd be clipped.
const MAX_LINE = 24;

/**
 * Everything he has an opinion about.
 *   every: cooldown for this occasion (ms)
 *   ttl:   how long the line stays in the bubble (ms)
 *   only:  'chatty' when the occasion is too chirpy for 'normal'
 * Deliberately absent: 'asking'. A raised claw and a '?' is a call to action,
 * and a joke in its place would only soften it.
 */
const OCCASIONS = Object.freeze({
  // --- the moods he already had, in words
  working: { every: 4 * MINUTE, ttl: 5 * SECOND },
  success: { every: 0, ttl: 6 * SECOND },
  error: { every: 0, ttl: 7 * SECOND },
  learned: { every: 0, ttl: 8 * SECOND },
  unlocked: { every: 0, ttl: 7 * SECOND },
  petted: { every: 20 * SECOND, ttl: 3 * SECOND },

  // --- what the work actually is (from the tool stream)
  tests: { every: 3 * MINUTE, ttl: 5 * SECOND },
  passed: { every: 2 * MINUTE, ttl: 6 * SECOND },
  push: { every: 2 * MINUTE, ttl: 6 * SECOND },
  deploy: { every: 2 * MINUTE, ttl: 7 * SECOND },
  bigWrite: { every: 5 * MINUTE, ttl: 5 * SECOND },
  sameFile: { every: 10 * MINUTE, ttl: 6 * SECOND },
  searching: { every: 6 * MINUTE, ttl: 5 * SECOND, only: 'chatty' },
  web: { every: 6 * MINUTE, ttl: 5 * SECOND, only: 'chatty' },
  crew: { every: 4 * MINUTE, ttl: 6 * SECOND },
  longTask: { every: 8 * MINUTE, ttl: 6 * SECOND },

  // --- he's on your wallpaper all day; he may as well notice
  morning: { every: 20 * HOUR, ttl: 8 * SECOND },
  latenight: { every: 6 * HOUR, ttl: 8 * SECOND },
  back: { every: 20 * HOUR, ttl: 10 * SECOND },

  // --- nothing happening
  idle: { every: 9 * MINUTE, ttl: 6 * SECOND, only: 'chatty' },
});

// His lines. Short, dry, and his own. Every pool needs at least three or the
// anti-repeat has nothing to choose from.
const LINES = Object.freeze({
  working: ['on it', 'claws out', 'digging in', 'leave it to me'],
  success: ['done!', 'nailed it', 'all yours', "that'll do"],
  error: ['uh oh', 'that broke', 'hm.', 'ow'],
  learned: ['new trick!', 'ooh, useful', 'mine now'],
  unlocked: ['shiny!', 'for me?', 'ooh'],
  petted: ['hee', 'again?', 'mm'],
  tests: ['tests again?', 'fingers crossed', 'moment of truth'],
  passed: ['all green!', 'told you', 'green!'],
  push: ['shipped it', 'off it goes', "it's out there"],
  deploy: ["it's live!", 'live!', 'launched'],
  bigWrite: ['big one', "that's a lot", 'phew'],
  sameFile: ['this file again?', 'old friend', 'third time lucky'],
  searching: ['rummaging…', 'somewhere here', 'digging…'],
  web: ['surfacing…', 'back in a tick', 'off to look'],
  crew: ['all claws in', "it's crowded", 'the lads'],
  longTask: ['still going…', 'bear with me', 'nearly'],
  morning: ['morning', "you're up", 'morning!'],
  latenight: ['you too?', 'late one', 'still up?'],
  back: ["you're back!", 'missed you', 'where were you?'],
  idle: ['all quiet', "tide's out", 'anything?', 'hm', 'nice day'],
});

// A crab is a crab, but yours is a particular one. The temperament comes from
// the install's own seed, so it never changes on you, and it adds lines rather
// than replacing them.
const TEMPERAMENTS = Object.freeze(['chipper', 'fussy', 'cocky', 'sleepy']);
const FLAVOR = Object.freeze({
  chipper: {
    working: ['love this bit'], success: ['yay!'], error: ['we go again'],
    passed: ['knew it!'], morning: ['bright and early'], idle: ['lovely day', 'what next?'],
  },
  fussy: {
    working: ['carefully now'], success: ['tidy'], error: ['I knew it'],
    bigWrite: ['too much'], sameFile: ['again? really?'], idle: ['dusty in here'],
  },
  cocky: {
    working: ['watch this'], success: ['easy', 'obviously'], error: ['not my fault'],
    passed: ['never doubted it'], push: ["you're welcome"], idle: ['bored'],
  },
  sleepy: {
    working: ['yawn… on it'], success: ['…done'], error: ['ugh'],
    longTask: ['so long…'], latenight: ['bedtime'], idle: ['nap time?', 'quiet…'],
  },
});

// What he does with his claws when there's nothing to do. The renderer animates
// these (critter.css); strolling is the one that moves his window (motion.js).
const BITS = Object.freeze(['dig', 'polish', 'peek', 'stretch', 'flop']);
const BIT_WEIGHT = Object.freeze({
  chipper: { dig: 2, polish: 1, peek: 2, stretch: 1, flop: 1 },
  fussy: { dig: 1, polish: 3, peek: 1, stretch: 1, flop: 1 },
  cocky: { dig: 1, polish: 2, peek: 2, stretch: 2, flop: 1 },
  sleepy: { dig: 1, polish: 1, peek: 1, stretch: 2, flop: 3 },
});

// ---------------------------------------------------------------- what the work is

// A finished shell command, scored the same way XP scores it (see xp.js), is
// the clearest signal of what just happened.
const RESULT_OCCASION = Object.freeze({ tests: 'passed', ship: 'push', deploy: 'deploy' });

const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const BIG_WRITE_CHARS = 2000;   // a write this size is worth a "phew"
const SAME_FILE_AFTER = 3;      // the third visit to one file earns a remark

/**
 * What he'd remark on as a tool call starts, or null. Everything it needs is a
 * plain value the caller already has, so this knows nothing about tool inputs:
 *   command: the shell command, for a Bash/PowerShell call
 *   chars:   how much a write tool is writing (stream.js writeChars)
 *   touches: times this conversation has now written to that same file
 */
function occasionForTool(name, { command = '', chars = 0, touches = 0 } = {}) {
  if (typeof name !== 'string') return null;
  if (chars > 0) {
    if (touches >= SAME_FILE_AFTER) return 'sameFile';
    if (chars >= BIG_WRITE_CHARS) return 'bigWrite';
    return null;
  }
  if (SHELL_TOOLS.has(name)) return classifyCommand(command) === 'tests' ? 'tests' : null;
  if (SEARCH_TOOLS.has(name)) return 'searching';
  if (WEB_TOOLS.has(name)) return 'web';
  return null;
}

/** What a successfully finished command was: 'tests' | 'ship' | 'deploy' -> occasion. */
const occasionForCommand = kind => RESULT_OCCASION[kind] || null;

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** Tolerate anything read from disk. */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const said = {};
  for (const [k, at] of Object.entries(src.said && typeof src.said === 'object' ? src.said : {})) {
    if (OCCASIONS[k] && Number.isFinite(at)) said[k] = at;
  }
  const recent = {};
  for (const [k, list] of Object.entries(src.recent && typeof src.recent === 'object' ? src.recent : {})) {
    if (OCCASIONS[k] && Array.isArray(list)) recent[k] = list.filter(Number.isInteger).slice(-8);
  }
  return {
    seed: typeof src.seed === 'string' && src.seed ? src.seed.slice(0, 64) : null,
    lastRunAt: Number.isFinite(src.lastRunAt) ? src.lastRunAt : null,
    lastSpokeAt: num(src.lastSpokeAt, 0),
    said, recent,
  };
}

/** The chattiness setting, tolerating anything. */
const chatterOf = v => (CHATTER.includes(v) ? v : 'normal');

/** Your crab's temperament: stable for a given seed, so it's always the same crab. */
function temperamentOf(seed) {
  if (typeof seed !== 'string' || !seed) return TEMPERAMENTS[0];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return TEMPERAMENTS[(h >>> 0) % TEMPERAMENTS.length];
}

/** Base lines plus the temperament's own, for one occasion. */
function poolFor(occasion, temperament) {
  const base = LINES[occasion] || [];
  const extra = FLAVOR[temperament]?.[occasion] || [];
  return [...base, ...extra];
}

/**
 * The line he says for `occasion`, or null when he should keep it to himself.
 * Returns { text, occasion, until, state } — `state` is a new voice state to
 * persist; the old one is never mutated.
 *   opts: { chatter, rand, force } — force skips the cooldowns (a level-up
 *   shouldn't lose its line because he said something 30 seconds ago).
 */
function say(stateIn, occasion, now, { chatter = 'normal', rand = Math.random, force = false } = {}) {
  const state = normalize(stateIn);
  const level = chatterOf(chatter);
  const rule = OCCASIONS[occasion];
  if (!rule || level === 'quiet') return null;
  if (rule.only === 'chatty' && level !== 'chatty') return null;
  const t = num(now, NaN);
  if (!Number.isFinite(t)) return null;
  if (!force) {
    if (t - state.lastSpokeAt < GAP[level]) return null;
    const last = state.said[occasion];
    if (last != null && t - last < rule.every * COOLDOWN_SCALE[level]) return null;
  }
  const pool = poolFor(occasion, temperamentOf(state.seed));
  if (!pool.length) return null;
  // Don't repeat a line while another one in the pool is still unused.
  const seen = new Set(state.recent[occasion] || []);
  let choices = pool.map((_, i) => i).filter(i => !seen.has(i));
  if (!choices.length) choices = pool.map((_, i) => i);
  const index = choices[Math.min(choices.length - 1, Math.floor(rand() * choices.length))];
  return {
    text: pool[index],
    occasion,
    until: t + rule.ttl,
    state: {
      ...state,
      lastSpokeAt: t,
      said: { ...state.said, [occasion]: t },
      recent: { ...state.recent, [occasion]: [...(state.recent[occasion] || []), index].slice(-Math.ceil(pool.length / 2)) },
    },
  };
}

/** 'morning' first thing, 'latenight' in the small hours, else null. */
function timeOccasion(now, hour = new Date(num(now, 0)).getHours()) {
  if (hour >= 5 && hour < 10) return 'morning';
  if (hour >= 1 && hour < 5) return 'latenight';
  return null;
}

/** 'back' when Shellby last ran days ago, else null. */
function absenceOccasion(lastRunAt, now, days = 3) {
  if (!Number.isFinite(lastRunAt) || !Number.isFinite(now)) return null;
  return now - lastRunAt >= days * 24 * HOUR ? 'back' : null;
}

/** One idle habit, weighted by temperament. */
function pickBit(seed, rand = Math.random) {
  const weights = BIT_WEIGHT[temperamentOf(seed)];
  const total = BITS.reduce((n, b) => n + weights[b], 0);
  let r = rand() * total;
  for (const b of BITS) { r -= weights[b]; if (r < 0) return b; }
  return BITS[0];
}

module.exports = {
  CHATTER, OCCASIONS, LINES, FLAVOR, TEMPERAMENTS, BITS, MAX_LINE, GAP, SAME_FILE_AFTER,
  normalize, chatterOf, temperamentOf, poolFor, say, timeOccasion, absenceOccasion, pickBit,
  occasionForTool, occasionForCommand,
};
