// Shellby's voice and his little habits: the short lines he says in his bubble,
// and what he gets up to when nothing's happening. Every line is his own —
// Shellby never quotes Claude.
//
// Pure: no I/O, no clock, no randomness of its own (callers pass `now` and
// `rand`), so the whole personality is testable. See test/voice.test.js.
//
// Three rules keep him a pet instead of a nuisance:
//   1. 'quiet' says nothing at all, ever — exactly the glyph-only Shellby
//      ('work' says only what's about the work).
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
// 'work' only speaks up about the work (WORK_OCCASIONS) and has no idle habits:
// Work mode's voice (workmode.js), and a choice of its own.
const CHATTER = Object.freeze(['quiet', 'work', 'normal', 'chatty']);
// Smallest gap between any two lines, whatever the occasion.
const GAP = Object.freeze({ quiet: Infinity, work: 40 * SECOND, normal: 40 * SECOND, chatty: 12 * SECOND });
// 'chatty' shortens every cooldown; 'normal' uses them as written.
const COOLDOWN_SCALE = Object.freeze({ quiet: Infinity, work: 1, normal: 1, chatty: 0.4 });
// What 'work' still says: a task done or failed, a new trick, a trophy's one
// line, a dev server falling over, a fix or a merge. Asking is the raised claw (see OCCASIONS),
// and a red build is the renderer's, so both show whatever he's set to.
const WORK_OCCASIONS = new Set(['success', 'error', 'learned', 'newTricks', 'unlocked', 'serverDown', 'fixed', 'merged', 'todosAll', 'jobFailed']);
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
  newTricks: { every: 0, ttl: 8 * SECOND }, // Claude Code updated and can do new things (claude/tricks.js)
  unlocked: { every: 0, ttl: 7 * SECOND },
  petted: { every: 20 * SECOND, ttl: 3 * SECOND },

  // --- what the work actually is (from the tool stream)
  tests: { every: 3 * MINUTE, ttl: 5 * SECOND },
  passed: { every: 2 * MINUTE, ttl: 6 * SECOND },
  fixed: { every: 2 * MINUTE, ttl: 7 * SECOND }, // red tests green again, on changed code (xp.js 'fixed')
  merged: { every: 2 * MINUTE, ttl: 7 * SECOND }, // one of your pull requests merged
  push: { every: 2 * MINUTE, ttl: 6 * SECOND },
  deploy: { every: 2 * MINUTE, ttl: 7 * SECOND },
  bigWrite: { every: 5 * MINUTE, ttl: 5 * SECOND },
  sameFile: { every: 10 * MINUTE, ttl: 6 * SECOND },
  searching: { every: 6 * MINUTE, ttl: 5 * SECOND, only: 'chatty' },
  web: { every: 6 * MINUTE, ttl: 5 * SECOND, only: 'chatty' },
  crew: { every: 4 * MINUTE, ttl: 6 * SECOND },
  longTask: { every: 8 * MINUTE, ttl: 6 * SECOND },
  serverDown: { every: 2 * MINUTE, ttl: 7 * SECOND }, // a dev server fell over (devservers/service.js)

  // --- what Claude Code does by itself (wiring/native.js)
  todoDone: { every: 90 * SECOND, ttl: 4 * SECOND },  // a to-do on Claude's own list ticked off
  todosAll: { every: 0, ttl: 6 * SECOND },            // ...and that was the last one
  jobDone: { every: MINUTE, ttl: 6 * SECOND },        // a command it left running in the background finished
  jobFailed: { every: MINUTE, ttl: 7 * SECOND },
  remembered: { every: 5 * MINUTE, ttl: 6 * SECOND }, // it wrote a memory down (auto memory)
  compacted: { every: 5 * MINUTE, ttl: 6 * SECOND }, // the conversation was compacted (/compact, or by itself)
  skillFirst: { every: 0, ttl: 7 * SECOND },          // the first time it used a skill here
  planning: { every: 5 * MINUTE, ttl: 5 * SECOND },   // it switched itself to planning

  // --- he's on your wallpaper all day; he may as well notice
  morning: { every: 20 * HOUR, ttl: 8 * SECOND },
  latenight: { every: 6 * HOUR, ttl: 8 * SECOND },
  back: { every: 20 * HOUR, ttl: 10 * SECOND },

  // --- your day, not just your code (see surroundings.js). Only ever the kind
  // of app, never what's in it.
  gameOver: { every: 30 * MINUTE, ttl: 7 * SECOND },
  callOver: { every: 20 * MINUTE, ttl: 7 * SECOND },
  sheetStretch: { every: 3 * HOUR, ttl: 7 * SECOND },
  docStretch: { every: 3 * HOUR, ttl: 7 * SECOND },
  slideStretch: { every: 3 * HOUR, ttl: 7 * SECOND },
  friday: { every: 20 * HOUR, ttl: 8 * SECOND },
  weekend: { every: 20 * HOUR, ttl: 8 * SECOND },
  monday: { every: 20 * HOUR, ttl: 8 * SECOND },
  // His tank (tank/life.js): a piece you just put in, moving day, and now and then a word about it on the desktop.
  tank: { every: 3 * HOUR, ttl: 7 * SECOND },
  tankNew: { every: 0, ttl: 6 * SECOND },

  // --- things he digs up (gifts.js) and remembers (bond.js)
  found: { every: 0, ttl: 7 * SECOND },
  memory: { every: 3 * HOUR, ttl: 8 * SECOND },
  milestone: { every: 0, ttl: 10 * SECOND },

  // --- nothing happening. Normal hears it now and then; chatty mutters more.
  idle: { every: 25 * MINUTE, ttl: 6 * SECOND },
  oops: { every: 10 * MINUTE, ttl: 4 * SECOND }, // a clumsy habit (trip, stuck)

  // --- up on your windows (see perch.js)
  perch: { every: 3 * MINUTE, ttl: 5 * SECOND },
  ride: { every: 2 * MINUTE, ttl: 4 * SECOND },
  shaken: { every: 30 * SECOND, ttl: 4 * SECOND },
  dropped: { every: 30 * SECOND, ttl: 4 * SECOND },
  dizzy: { every: MINUTE, ttl: 5 * SECOND },
  pop: { every: MINUTE, ttl: 4 * SECOND },
  caught: { every: 30 * SECOND, ttl: 5 * SECOND },

  // --- you, typing (typing.js): a burst he watched you finish
  typingBurst: { every: 10 * MINUTE, ttl: 5 * SECOND },
  typingRecord: { every: 0, ttl: 7 * SECOND },

  // --- the weather outside (weather.js remarkFor), as it turns
  rainStart: { every: 2 * HOUR, ttl: 7 * SECOND },
  snowStart: { every: 2 * HOUR, ttl: 7 * SECOND },
  stormStart: { every: 2 * HOUR, ttl: 7 * SECOND },
  rainStopped: { every: 2 * HOUR, ttl: 6 * SECOND },

  // --- up the edges of the screen (see climb.js)
  climb: { every: 3 * MINUTE, ttl: 4 * SECOND },
  stuck: { every: 30 * SECOND, ttl: 4 * SECOND },
  leap: { every: MINUTE, ttl: 4 * SECOND },
  letgo: { every: MINUTE, ttl: 4 * SECOND },

  // --- mischief, if you asked for it (see mischief.js)
  pinched: { every: 0, ttl: 3 * SECOND },
  yanked: { every: 0, ttl: 3 * SECOND },
  shoved: { every: 0, ttl: 3 * SECOND },
  noteOff: { every: MINUTE, ttl: 3 * SECOND },
  note: { every: 0, ttl: 5 * SECOND },
  behave: { every: 0, ttl: 4 * SECOND },
  noPrank: { every: 0, ttl: 3 * SECOND },

  // --- his needs (see needs.js). The needy ones are rare by design: needs.js
  // keeps 45 minutes between them on top of these.
  peckish: { every: HOUR, ttl: 5 * SECOND },
  sandy: { every: HOUR, ttl: 5 * SECOND },
  sleepy: { every: HOUR, ttl: 5 * SECOND },
  mopey: { every: HOUR, ttl: 5 * SECOND },
  fed: { every: 0, ttl: 4 * SECOND },
  stuffed: { every: 0, ttl: 4 * SECOND },
  pantryEmpty: { every: 0, ttl: 5 * SECOND },
  snackEarned: { every: 10 * MINUTE, ttl: 4 * SECOND },
  tide: { every: 0, ttl: 6 * SECOND },
  rinsed: { every: 0, ttl: 4 * SECOND },
  tuckedIn: { every: 0, ttl: 4 * SECOND },
  notSleepy: { every: 0, ttl: 4 * SECOND },
  cheered: { every: 5 * MINUTE, ttl: 4 * SECOND },
});

// His lines. Short, dry, and his own. Every pool needs at least three or the
// anti-repeat has nothing to choose from.
const LINES = Object.freeze({
  working: ['on it', 'claws out', 'digging in', 'leave it to me'],
  success: ['done!', 'nailed it', 'all yours', "that'll do"],
  error: ['uh oh', 'that broke', 'hm.', 'ow'],
  learned: ['new trick!', 'ooh, useful', 'mine now'],
  newTricks: ['claude leveled up!', 'new tricks!', 'ooh, upgrades'],
  unlocked: ['shiny!', 'for me?', 'ooh'],
  petted: ['hee', 'again?', 'mm'],
  tests: ['tests again?', 'fingers crossed', 'moment of truth'],
  passed: ['all green!', 'told you', 'green!'],
  fixed: ['fixed it!', 'red to green!', 'squashed it'],
  merged: ['merged!', 'it landed!', 'in it goes'],
  push: ['shipped it', 'off it goes', "it's out there"],
  deploy: ["it's live!", 'live!', 'launched'],
  bigWrite: ['big one', "that's a lot", 'phew'],
  sameFile: ['this file again?', 'old friend', 'third time lucky'],
  searching: ['rummaging…', 'somewhere here', 'digging…'],
  web: ['surfacing…', 'back in a tick', 'off to look'],
  crew: ['all claws in', "it's crowded", 'the lads'],
  longTask: ['still going…', 'bear with me', 'nearly'],
  serverDown: ['your server tipped over', 'server down!', 'it fell over'],
  todoDone: ['one down', 'ticked it', 'next!', 'check!'],
  todosAll: ['list done!', 'every box ticked', 'all ticked off'],
  jobDone: ['that one finished', 'background done', "it's back"],
  jobFailed: ['the background one broke', 'that one failed', 'background: ow'],
  remembered: ['noted!', "I'll remember", 'into my notebook'],
  compacted: ['packed it down', 'travelling light', 'room to think'],
  skillFirst: ['first time with that!', 'new trick in use!', 'ooh, a skill'],
  planning: ['plotting…', 'drawing a map', 'thinking it through'],
  morning: ['morning', "you're up", 'morning!'],
  latenight: ['you too?', 'late one', 'still up?'],
  back: ["you're back!", 'missed you', 'where were you?'],
  gameOver: ['gg', 'did we win?', 'good game?', 'rematch?'],
  callOver: ['phew, over', "how'd it go?", 'can I talk now?', 'shh no more'],
  sheetStretch: ['numbers again?', 'cells, cells, cells', 'spreadsheet day?', 'sum it up'],
  docStretch: ['still writing?', 'big essay?', 'word by word'],
  slideStretch: ['big presentation?', 'next slide!', 'add a crab slide'],
  friday: ['friday!', 'nearly weekend', 'home stretch'],
  tank: ['my tank is cosy', 'thinking about my tank', 'I like my tank'],
  tankNew: ['ooh, something new', 'for me?', 'my tank!'],
  weekend: ["it's the weekend", 'lazy day?', 'weekend crab'],
  monday: ['monday again', 'new week', 'need coffee'],
  found: ['found something!', 'ooh, look', 'for you!', 'treasure!'],
  memory: ['remember that?', 'good times', 'us two'],
  milestone: ['look how far!', 'what a run', 'us two!'],
  idle: ['all quiet', "tide's out", 'anything?', 'hm', 'nice day'],
  oops: ['oops', 'nobody saw that', 'meant to do that', 'ahem'],
  perch: ['nice view', 'comfy up here', 'my spot now', "what's this one?"],
  ride: ['wheee', 'steady!', 'faster!', 'whoa'],
  shaken: ['rude!', 'HEY', 'oof', 'was that needed?'],
  dropped: ['oh no', '…huh', 'where did it go?', 'not again'],
  dizzy: ['the room spins', 'whoa…', 'which way is up'],
  pop: ['boing!', 'squashed!', 'okay okay'],
  caught: ['caught it!', 'stuck the landing', 'ta-da'],
  typingBurst: ['whoa, fast', 'claws are tired', 'look at you go', 'keyboard on fire'],
  typingRecord: ['new record!', 'fastest yet!', 'personal best!'],
  rainStart: ["it's raining out", 'brolly time', 'rain! my favourite', 'hear that rain?'],
  snowStart: ["it's snowing!", 'snow!', 'hat on, then'],
  stormStart: ['thunder…', 'storm coming', 'hold the brolly'],
  rainStopped: ['rain stopped', 'dry again', 'puddles now'],
  climb: ['going up', 'hup!', 'to the top!', 'sticky feet'],
  stuck: ['stuck it!', 'sticky feet!', 'got a grip', 'splat. hi'],
  leap: ['geronimo!', 'wheee', 'catch me!'],
  letgo: ['bombs away', 'oops, let go', 'down I go'],
  pinched: ['snip!', 'mine now', 'hehe', 'gotcha'],
  yanked: ['fine, fine', 'aww', 'strong one'],
  shoved: ['hup!', 'a little to the left', 'better there', 'heave!'],
  noteOff: ['brb', 'one sec', 'got something for you'],
  note: ['for you', 'special delivery', 'read it!', 'a note!'],
  behave: ['ok… fine', 'I’ll be good', 'promise'],
  noPrank: ['nothing to pinch', 'not now', 'maybe later'],

  peckish: ["tummy's rumbling…", 'is that plankton?', 'snack o\'clock?', 'bit peckish'],
  sandy: ['bit sandy here', 'sand everywhere', 'could use a rinse'],
  sleepy: ['*yawn*', 'so sleepy…', 'nap soon?'],
  mopey: ['…', 'hey… you there?', 'bit quiet today', 'just me then'],
  fed: ['nom nom nom', 'best. snack. ever.', 'mmm, plankton', 'thank you!'],
  stuffed: ['stuffed. saving it.', "couldn't eat a thing", 'later, maybe'],
  pantryEmpty: ['no snacks left…', 'pantry\'s empty', 'later then'],
  snackEarned: ['snack!', 'ooh, plankton', 'one for later'],
  tide: ['the tide brought snacks!', 'look what washed up', 'free plankton!'],
  rinsed: ['squeaky clean!', 'so shiny', 'ahh, fresh'],
  tuckedIn: ['night night', 'just five minutes', 'g\'night'],
  notSleepy: ['not sleepy!', 'wide awake', 'maybe later'],
  cheered: ['there you are!', 'yay, you!', 'missed you'],
});

// A crab is a crab, but yours is a particular one. The temperament comes from
// the install's own seed, so it never changes on you, and it adds lines rather
// than replacing them.
const TEMPERAMENTS = Object.freeze(['chipper', 'fussy', 'cocky', 'sleepy']);
const FLAVOR = Object.freeze({
  chipper: {
    working: ['love this bit'], success: ['yay!'], error: ['we go again'],
    passed: ['knew it!'], morning: ['bright and early'], idle: ['lovely day', 'what next?'],
    ride: ['again! again!'], perch: ['hello up here!'],
    gameOver: ['you were great!'], callOver: ['nice chat?'], weekend: ['adventure day!'],
    friday: ['woo, friday!'], found: ['look look look!'], fed: ['yum yum yum!'],
  },
  fussy: {
    working: ['carefully now'], success: ['tidy'], error: ['I knew it'],
    bigWrite: ['too much'], sameFile: ['again? really?'], idle: ['dusty in here'],
    perch: ['dusty up here'], shaken: ['how undignified'], climb: ['wipe your walls'], shoved: ['crooked. fixed it'],
    sheetStretch: ['check cell B12'], gameOver: ['enough screen time'], monday: ['mondays. ugh.'],
    found: ['needs a polish'], sandy: ['this is unbearable'], rinsed: ['finally. thank you.'],
  },
  cocky: {
    working: ['watch this'], success: ['easy', 'obviously'], error: ['not my fault'],
    passed: ['never doubted it'], push: ["you're welcome"], idle: ['bored'],
    shaken: ['meant to do that'], caught: ['obviously'], pinched: ['too easy'], stuck: ['like a pro'],
    gameOver: ['I could beat that'], slideStretch: ['I should present'], found: ['you can thank me'],
    callOver: ['I was quiet. ask.'], fed: ['I deserved that'], mopey: ['fine. ignore me.'],
  },
  sleepy: {
    working: ['yawn… on it'], success: ['…done'], error: ['ugh'],
    longTask: ['so long…'], latenight: ['bedtime'], idle: ['nap time?', 'quiet…'],
    perch: ['good nap spot'], dropped: ['was asleep…'],
    weekend: ['sleep in?'], monday: ['five more minutes'], callOver: ['dozed off, sorry'],
    found: ['found it napping'], tuckedIn: ['finally…'], sleepy: ['eyes… closing…'],
  },
});

// What each temperament is like, for the places that show it (Settings, the
// Us page, his crab card). Short and in his favour.
const TEMPERAMENT_INFO = Object.freeze({
  chipper: Object.freeze({ name: 'Chipper', emoji: '🌞', blurb: 'Delighted by everything. Digs a lot and peeks at what you’re doing.' }),
  fussy: Object.freeze({ name: 'Fussy', emoji: '🧽', blurb: 'Likes things just so. Polishes his shell and notices the dust.' }),
  cocky: Object.freeze({ name: 'Cocky', emoji: '😎', blurb: 'Never wrong, never worried. Shows off and takes the credit.' }),
  sleepy: Object.freeze({ name: 'Sleepy', emoji: '💤', blurb: 'In no hurry. Stretches, flops over and naps more than most.' }),
});

// What he does with his claws when there's nothing to do. The renderer animates
// these (critter.css); strolling is the one that moves his window (motion.js).
// The small fidgets (settling his shell, a scratch, a yawn) fill the gaps
// between the bigger habits; trip and stuck are the rare clumsy ones.
const BITS = Object.freeze(['dig', 'polish', 'peek', 'stretch', 'flop', 'shuffle', 'scratch', 'yawn', 'trip', 'stuck']);
const CLUMSY_BITS = Object.freeze(['trip', 'stuck']);
const BIT_WEIGHT = Object.freeze({
  chipper: { dig: 2, polish: 1, peek: 2, stretch: 1, flop: 1, shuffle: 1, scratch: 1, yawn: 0.5, trip: 0.5, stuck: 0.5 },
  fussy: { dig: 1, polish: 3, peek: 1, stretch: 1, flop: 1, shuffle: 2, scratch: 1, yawn: 0.5, trip: 0.5, stuck: 0.5 },
  cocky: { dig: 1, polish: 2, peek: 2, stretch: 2, flop: 1, shuffle: 1, scratch: 1, yawn: 0.5, trip: 0.5, stuck: 0.5 },
  sleepy: { dig: 1, polish: 1, peek: 1, stretch: 2, flop: 3, shuffle: 1, scratch: 1, yawn: 2, trip: 0.5, stuck: 0.5 },
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
// Scenes, digging, idle mutters and the rest of his own little life: only at
// 'normal' and 'chatty'.
const hasHabits = v => ['normal', 'chatty'].includes(chatterOf(v));

/** Your crab's temperament: stable for a given seed, so it's always the same crab. */
function temperamentOf(seed) {
  if (typeof seed !== 'string' || !seed) return TEMPERAMENTS[0];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return TEMPERAMENTS[(h >>> 0) % TEMPERAMENTS.length];
}

// A voice from a wardrobe pack ({ lines, flavor, fallback }, see
// wardrobe/dialogue.js) speaks for every occasion it has lines for.
const voiceCovers = (worn, occasion, temperament) => !!(worn?.lines?.[occasion] || worn?.flavor?.[temperament]?.[occasion]);

/**
 * Base lines plus the temperament's own, for one occasion. With a pack voice on
 * (`worn`), its lines instead. On occasions it has no lines for, his own lines
 * come back, or none at all with fallback 'quiet'.
 */
function poolFor(occasion, temperament, worn = null) {
  if (worn && voiceCovers(worn, occasion, temperament)) {
    return [...(worn.lines[occasion] || []), ...(worn.flavor?.[temperament]?.[occasion] || [])];
  }
  if (worn?.fallback === 'quiet') return [];
  const base = LINES[occasion] || [];
  const extra = FLAVOR[temperament]?.[occasion] || [];
  return [...base, ...extra];
}

/**
 * The line he says for `occasion`, or null when he should keep it to himself.
 * Returns { text, occasion, until, state } — `state` is a new voice state to
 * persist; the old one is never mutated.
 *   opts: { chatter, rand, force, text } — force skips the cooldowns (a level-up
 *   shouldn't lose its line because he said something 30 seconds ago). `text`
 *   is a line made elsewhere (a memory, a milestone) that still has to pass
 *   every rule here; it must fit the bubble. `voice` is the pack voice he's
 *   wearing, if any (see poolFor). With fallback 'quiet' its own line replaces
 *   `text`, or he keeps quiet.
 */
function say(stateIn, occasion, now, { chatter = 'normal', rand = Math.random, force = false, text: textIn = null, voice: worn = null } = {}) {
  const state = normalize(stateIn);
  const level = chatterOf(chatter);
  const rule = OCCASIONS[occasion];
  if (!rule || level === 'quiet') return null;
  if (rule.only === 'chatty' && level !== 'chatty') return null;
  if (level === 'work' && !WORK_OCCASIONS.has(occasion)) return null;
  const t = num(now, NaN);
  if (!Number.isFinite(t)) return null;
  if (!force) {
    if (t - state.lastSpokeAt < GAP[level]) return null;
    const last = state.said[occasion];
    if (last != null && t - last < rule.every * COOLDOWN_SCALE[level]) return null;
  }
  const temperament = temperamentOf(state.seed);
  // A line made elsewhere carries something real (which memory, which find, how
  // many days), so a character voice lets it through. A quiet voice is another
  // language: it says its own line for the occasion, or nothing.
  let text = textIn;
  if (text != null && worn?.fallback === 'quiet') {
    if (!voiceCovers(worn, occasion, temperament)) return null;
    text = null;
  }
  if (text != null) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_LINE) return null;
    return {
      text, occasion, until: t + rule.ttl,
      state: { ...state, lastSpokeAt: t, said: { ...state.said, [occasion]: t } },
    };
  }
  const pool = poolFor(occasion, temperament, worn);
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
  CHATTER, WORK_OCCASIONS, OCCASIONS, LINES, FLAVOR, TEMPERAMENTS, TEMPERAMENT_INFO, BITS, CLUMSY_BITS, MAX_LINE, GAP, SAME_FILE_AFTER,
  normalize, chatterOf, hasHabits, temperamentOf, poolFor, voiceCovers, say, timeOccasion, absenceOccasion, pickBit,
  occasionForTool, occasionForCommand,
};
