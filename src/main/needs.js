// His needs: a tummy, a shine, his pep and his cheer. He gets peckish, a bit
// sandy, sleepy, and a little mopey when you're right there and ignore him.
// Plankton snacks, earned by getting things done, a rinse, a tuck-in and plain
// attention put him right.
//
// Gentle by design, and the tests hold it to that (test/needs.test.js):
//   - every meter has a floor; he never gets worse than peckish and a bit mopey
//   - nothing goes down while you're away from the PC
//   - nothing here touches the bond, XP, finds or trophies, and nothing is ever
//     blocked by a low meter
//   - one kind act lifts him; recovery is quick and the decay is slow
//
// Pure: no I/O, no clock, no randomness of its own (callers pass `now` and
// `rand`). src/main/life.js keeps it.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const METERS = Object.freeze(['fullness', 'tidiness', 'energy', 'cheer']);
const FULL = 100;
// Never lower than this, however long he's left.
const FLOOR = Object.freeze({ fullness: 25, tidiness: 30, energy: 30, cheer: 35 });
// Below this, it shows.
const LOW = Object.freeze({ fullness: 45, tidiness: 45, energy: 40, cheer: 45 });
const HAPPY = 70;                  // every meter at or above: a happy crab
const STUFFED = 95;                // a snack past this is saved, not eaten
const RESTED = 90;                 // too awake to be tucked in

// Per hour. The "here" rates only run while you're at the PC.
const RATES = Object.freeze({
  fullness: { here: -7 },
  tidiness: { here: -1.5 },
  energy: { here: -2, away: 20, napping: 30 },
  cheer: { here: -9 },             // you're here and haven't paid him any mind
});
// life.js ticks every 15 s. A longer gap means the app was closed, the PC
// asleep or his window gone: none of that was time you spent ignoring him.
const MAX_STEP = 2 * MINUTE;
const BACK_AFTER = HOUR;           // away this long: he's just glad you're back

// What the day does to him (life.js reports these).
const WEAR = Object.freeze({
  dig: { tidiness: -6 },
  thrown: { tidiness: -4, energy: -3 },
  ride: { tidiness: -3 },
  shaken: { tidiness: -3 },
  task: { energy: -2 },
  focus: { energy: -8 },
  game: { energy: -5 },
});

// Kind acts, and how much cheer each is worth.
const ATTEND = Object.freeze({ pet: 20, play: 30 });

// Each snack's pixel art travels with it: the Us page draws it, and so does his
// claw when he eats it (care.js sends the pixels, like a find).
const SNACKS = Object.freeze({
  plankton: Object.freeze({ name: 'Plankton', icon: '🦐', fill: 25, cheer: 25, palette: { a: '#7fd6c2', b: '#c8f3e8', k: '#2a9d8f' }, pixels: ['.ab.', 'aaak', '.ak.'] }),
  krill: Object.freeze({ name: 'Krill', icon: '🦞', fill: 45, cheer: 30, palette: { r: '#ff7a5c', p: '#ffb199', k: '#2b2d42' }, pixels: ['p...', '.rrk', 'rrr.', 'r.r.'] }),
  golden: Object.freeze({ name: 'Golden plankton', icon: '✨', fill: 60, cheer: 40, palette: { a: '#ffd23f', b: '#fff4b3', c: '#c99700' }, pixels: ['.ab.', 'aaac', '.ac.'] }),
});
const SNACK_ORDER = Object.freeze(['plankton', 'krill', 'golden']); // plainest first
const PANTRY_MAX = 12;
const TIDE_EVERY = 3 * HOUR;       // an empty pantry and a hungry crab: the tide brings one
const RINSE_EVERY = HOUR;
const TUCK_EVERY = HOUR;
const TUCK_PEP = 35;               // a tuck-in's nap is short; this is what it's worth
const NEEDY_GAP = 45 * MINUTE;     // between needy lines, whatever the need

// Where snacks come from, by the stat event that already fires for it (main.js
// stat()), plus two of life.js's own: 'new-day' (the first time he sees you each
// day) and 'bond-up'. Sources sharing a `group` share its daily cap. `claude`
// ones only happen with Claude Code, so crab-only users aren't told about them.
const SOURCES = Object.freeze({
  'task-completed': { group: 'task', snack: 'plankton', n: 1, perDay: 8, claude: true },
  'focus-completed': { group: 'focus', snack: 'plankton', n: 2, perDay: 3 },
  'new-day': { group: 'hello', snack: 'plankton', n: 2, perDay: 1 },
  'health-cooled': { group: 'health', snack: 'plankton', n: 1, perDay: 3 },
  'health-space-freed': { group: 'health', snack: 'plankton', n: 1, perDay: 3 },
  'hide-found': { group: 'game', snack: 'plankton', n: 1, perDay: 3 },
  fetched: { group: 'game', snack: 'plankton', n: 1, perDay: 3 },
  'find-made': { group: 'find', snack: 'krill', n: 1, perDay: 2, chance: 0.25 },
  'legendary-find': { group: 'treasure', snack: 'golden', n: 1, perDay: 1 },
  'set-completed': { group: 'treasure', snack: 'golden', n: 1, perDay: 1 },
  'ci-fixed': { group: 'work', snack: 'plankton', n: 1, perDay: 3, claude: true },
  'bug-caught': { group: 'work', snack: 'plankton', n: 1, perDay: 3, claude: true },
  'routine-run': { group: 'work', snack: 'plankton', n: 1, perDay: 3, claude: true },
  'bond-up': { group: 'bond', snack: 'golden', n: 1, perDay: 3 },
});

// For the Us page: where snacks come from, in words.
const SOURCE_TEXT = Object.freeze([
  { text: 'Finished tasks', claude: true },
  { text: 'Focus sessions' },
  { text: 'Saying hello each day' },
  { text: 'Fixing things in Health' },
  { text: 'Hide and seek and fetch' },
  { text: 'Now and then, with a find' },
  { text: 'The tide, if the pantry runs dry' },
]);

const WORDS = Object.freeze({
  fullness: ['peckish', 'satisfied', 'full'],
  tidiness: ['a bit sandy', 'fine', 'shiny'],
  energy: ['sleepy', 'okay', 'full of beans'],
  cheer: ['a bit mopey', 'content', 'happy'],
});
const LABELS = Object.freeze({
  fullness: { name: 'Tummy', icon: '🦐' },
  tidiness: { name: 'Shine', icon: '🧼' },
  energy: { name: 'Pep', icon: '💤' },
  cheer: { name: 'Cheer', icon: '💛' },
});

// The mood that shows, first match wins.
const MOOD_ORDER = Object.freeze([
  ['mopey', 'cheer'], ['peckish', 'fullness'], ['sleepy', 'energy'], ['sandy', 'tidiness'],
]);
const NEEDY_MOODS = Object.freeze(MOOD_ORDER.map(([m]) => m));

const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clampMeter = (k, v) => Math.min(FULL, Math.max(FLOOR[k], v));
const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const at = v => (Number.isFinite(v) && v > 0 ? v : 0);
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Tolerate anything read from disk. A new crab starts full and happy. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const m = r.meters && typeof r.meters === 'object' ? r.meters : {};
  const meters = {};
  for (const k of METERS) meters[k] = fin(m[k]) == null ? FULL : clampMeter(k, m[k]);
  const p = r.pantry && typeof r.pantry === 'object' ? r.pantry : {};
  const pantry = {};
  let room = PANTRY_MAX;
  for (const k of SNACK_ORDER) { pantry[k] = Math.min(room, count(p[k])); room -= pantry[k]; }
  const t = r.today && typeof r.today === 'object' ? r.today : {};
  const earned = {};
  for (const [g, n] of Object.entries(t.earned && typeof t.earned === 'object' ? t.earned : {})) {
    if (Object.values(SOURCES).some(s => s.group === g)) earned[g] = count(n);
  }
  const tot = r.totals && typeof r.totals === 'object' ? r.totals : {};
  return {
    v: 1,
    meters,
    updatedAt: at(r.updatedAt),
    awayAt: at(r.awayAt) || null,
    pantry,
    today: { date: typeof t.date === 'string' ? t.date : null, earned },
    lastFedAt: at(r.lastFedAt),
    lastRinseAt: at(r.lastRinseAt),
    lastTuckAt: at(r.lastTuckAt),
    lastTideAt: at(r.lastTideAt),
    lastNeedyAt: at(r.lastNeedyAt),
    totals: { fed: count(tot.fed), rinsed: count(tot.rinsed), tucked: count(tot.tucked), earned: count(tot.earned), golden: count(tot.golden) },
    introduced: r.introduced === true,
  };
}

const withMeters = (state, patch) => {
  const meters = { ...state.meters };
  for (const [k, d] of Object.entries(patch)) if (METERS.includes(k)) meters[k] = clampMeter(k, meters[k] + d);
  return { ...state, meters };
};

/**
 * Time passes. Meters only go down while you're at the PC; his pep comes back
 * while he naps or you're away. Returns { state, back } where `back` means you
 * just came back after a while away (he's glad, not cross).
 *   ctx: { present, napping }
 */
function tick(stateIn, now, { present = false, napping = false } = {}) {
  const state = normalize(stateIn);
  const t = Number(now);
  if (!Number.isFinite(t)) return { state, back: false };
  const last = state.updatedAt || t;
  const gap = Math.max(0, t - last);
  const hours = gap > MAX_STEP ? 0 : gap / HOUR;
  const delta = {};
  if (present) {
    for (const k of METERS) if (RATES[k].here) delta[k] = RATES[k].here * hours;
  }
  if (napping) delta.energy = RATES.energy.napping * hours;
  else if (!present) delta.energy = RATES.energy.away * hours;
  let next = { ...withMeters(state, delta), updatedAt: t };
  let back = false;
  if (present) {
    if (state.awayAt && t - state.awayAt >= BACK_AFTER) {
      back = true;
      next = { ...next, meters: { ...next.meters, cheer: FULL } };
    }
    next = { ...next, awayAt: null };
  } else if (!state.awayAt) {
    next = { ...next, awayAt: t };
  }
  return { state: next, back };
}

/** Something in his day takes it out of him (WEAR). Unknown events change nothing. */
function wear(stateIn, event) {
  const state = normalize(stateIn);
  return WEAR[event] ? withMeters(state, WEAR[event]) : state;
}

/** A kind act cheers him up (ATTEND). */
function attend(stateIn, kind) {
  const state = normalize(stateIn);
  return ATTEND[kind] ? withMeters(state, { cheer: ATTEND[kind] }) : state;
}

const pantryTotal = state => SNACK_ORDER.reduce((n, k) => n + state.pantry[k], 0);

const addSnacks = (state, kind, n) => {
  const room = PANTRY_MAX - pantryTotal(state);
  const add = Math.max(0, Math.min(room, n));
  return {
    state: { ...state, pantry: { ...state.pantry, [kind]: state.pantry[kind] + add }, totals: { ...state.totals, earned: state.totals.earned + add } },
    added: add,
  };
};

/**
 * Something got done that earns a snack. Returns { state, snack, n, reason }:
 * snack is the kind added (null when none), reason 'capped' (today's share is
 * used up), 'pantry-full', 'luck' (a chance source that didn't come up) or null.
 */
function earn(stateIn, source, now, rand = Math.random) {
  let state = normalize(stateIn);
  const rule = SOURCES[source];
  const t = Number(now);
  const none = reason => ({ state, snack: null, n: 0, reason });
  if (!rule || !Number.isFinite(t)) return none(null);
  const day = dayKey(t);
  if (state.today.date !== day) state = { ...state, today: { date: day, earned: {} } };
  const used = state.today.earned[rule.group] || 0;
  if (used >= rule.perDay) return none('capped');
  if (pantryTotal(state) >= PANTRY_MAX) return none('pantry-full');
  if (rule.chance != null && rand() >= rule.chance) return none('luck');
  const r = addSnacks(state, rule.snack, rule.n);
  const next = { ...r.state, today: { date: day, earned: { ...state.today.earned, [rule.group]: used + 1 } } };
  return { state: next, snack: rule.snack, n: r.added, reason: null };
}

/**
 * The safety net: an empty pantry and a crab at his hungriest. The tide washes
 * a plankton up, at most once every TIDE_EVERY. Returns { state, snack }.
 */
function tide(stateIn, now) {
  const state = normalize(stateIn);
  const t = Number(now);
  if (!Number.isFinite(t) || pantryTotal(state) > 0 || state.meters.fullness > FLOOR.fullness + 0.5) return { state, snack: null };
  if (state.lastTideAt && t - state.lastTideAt < TIDE_EVERY) return { state, snack: null };
  const r = addSnacks(state, 'plankton', 1);
  return { state: { ...r.state, lastTideAt: t }, snack: 'plankton' };
}

/** { mood, low }: the mood that shows (MOOD_ORDER) and every meter that's low. */
function mood(stateIn) {
  const state = normalize(stateIn);
  const low = METERS.filter(k => state.meters[k] < LOW[k]);
  for (const [m, k] of MOOD_ORDER) if (low.includes(k)) return { mood: m, low };
  return { mood: METERS.every(k => state.meters[k] >= HAPPY) ? 'happy' : 'content', low };
}

/**
 * Feed him. Picks the plainest snack you have unless `kind` names one.
 * Returns { state, ok, reason: 'empty'|'stuffed'|null, ate, was }.
 */
function feed(stateIn, now, kind = null) {
  const state = normalize(stateIn);
  const t = Number(now);
  const was = mood(state).mood;
  const no = reason => ({ state, ok: false, reason, ate: null, was });
  if (!Number.isFinite(t)) return no(null);
  if (state.meters.fullness >= STUFFED) return no('stuffed');
  const ate = kind && Object.hasOwn(SNACKS, kind) ?(state.pantry[kind] > 0 ? kind : null) : SNACK_ORDER.find(k => state.pantry[k] > 0);
  if (!ate) return no('empty');
  const s = SNACKS[ate];
  const fed = withMeters({ ...state, pantry: { ...state.pantry, [ate]: state.pantry[ate] - 1 } }, { fullness: s.fill, cheer: s.cheer });
  const totals = { ...state.totals, fed: state.totals.fed + 1, golden: state.totals.golden + (ate === 'golden' ? 1 : 0) };
  return { state: { ...fed, lastFedAt: t, totals }, ok: true, reason: null, ate, was };
}

const nextRinseAt = state => (state.lastRinseAt ? state.lastRinseAt + RINSE_EVERY : 0);

/** A rinse: shiny again. Returns { state, ok, reason: 'clean'|'cooldown'|null }. */
function rinse(stateIn, now) {
  const state = normalize(stateIn);
  const t = Number(now);
  if (!Number.isFinite(t)) return { state, ok: false, reason: null };
  if (state.meters.tidiness >= STUFFED) return { state, ok: false, reason: 'clean' };
  if (t < nextRinseAt(state)) return { state, ok: false, reason: 'cooldown' };
  const next = withMeters({ ...state, meters: { ...state.meters, tidiness: FULL } }, { cheer: 10 });
  return { state: { ...next, lastRinseAt: t, totals: { ...state.totals, rinsed: state.totals.rinsed + 1 } }, ok: true, reason: null };
}

const nextTuckAt = state => (state.lastTuckAt ? state.lastTuckAt + TUCK_EVERY : 0);

/**
 * Tuck him in for a nap (life.js starts it). The nap itself is short, so the
 * pep it's worth comes up front. Returns { state, ok, reason: 'rested'|'cooldown'|null }.
 */
function tuckIn(stateIn, now) {
  const state = normalize(stateIn);
  const t = Number(now);
  if (!Number.isFinite(t)) return { state, ok: false, reason: null };
  if (state.meters.energy >= RESTED) return { state, ok: false, reason: 'rested' };
  if (t < nextTuckAt(state)) return { state, ok: false, reason: 'cooldown' };
  const next = withMeters(state, { energy: TUCK_PEP, cheer: 10 });
  return { state: { ...next, lastTuckAt: t, totals: { ...state.totals, tucked: state.totals.tucked + 1 } }, ok: true, reason: null };
}

/** The need he'd mention now (a voice.js occasion), or null. At most one per NEEDY_GAP. */
function needyLine(stateIn, now) {
  const state = normalize(stateIn);
  const t = Number(now);
  if (!Number.isFinite(t) || t - state.lastNeedyAt < NEEDY_GAP) return null;
  const m = mood(state).mood;
  return NEEDY_MOODS.includes(m) ? m : null;
}

/** He mentioned it: the gap starts again. */
const markNeedy = (stateIn, now) => ({ ...normalize(stateIn), lastNeedyAt: Number(now) || 0 });

/** How much likelier a nap is (life.js maybeNap): 1 when he's got pep, up to 2.5 when he's sleepy. */
function napChance(stateIn) {
  const e = normalize(stateIn).meters.energy;
  if (e >= LOW.energy) return 1;
  return 1 + 1.5 * Math.min(1, (LOW.energy - e) / (LOW.energy - FLOOR.energy));
}

/** Every meter full again (needs switched back on, so he doesn't come back hungry). */
function refill(stateIn, now) {
  const state = normalize(stateIn);
  return { ...state, meters: Object.fromEntries(METERS.map(k => [k, FULL])), updatedAt: Number(now) || 0, awayAt: null };
}

const word = (k, v) => WORDS[k][v < LOW[k] ? 0 : v < HAPPY ? 1 : 2];

/** Everything the Us page card shows. `crabOnly` leaves out the sources that need Claude. */
function view(stateIn, now, { crabOnly = false } = {}) {
  const state = normalize(stateIn);
  const t = Number(now) || 0;
  const m = mood(state);
  return {
    mood: m.mood,
    low: m.low,
    meters: METERS.map(k => ({ id: k, ...LABELS[k], value: Math.round(state.meters[k]), floor: FLOOR[k], word: word(k, state.meters[k]), low: m.low.includes(k) })),
    pantry: { ...state.pantry, total: pantryTotal(state), max: PANTRY_MAX },
    snacks: SNACK_ORDER.map(k => ({ id: k, ...SNACKS[k], have: state.pantry[k] })),
    stuffed: state.meters.fullness >= STUFFED,
    clean: state.meters.tidiness >= STUFFED,
    rested: state.meters.energy >= RESTED,
    nextRinseAt: t < nextRinseAt(state) ? nextRinseAt(state) : null,
    nextTuckAt: t < nextTuckAt(state) ? nextTuckAt(state) : null,
    sources: SOURCE_TEXT.filter(s => !(crabOnly && s.claude)).map(s => s.text),
    totals: { ...state.totals },
    introduced: state.introduced,
  };
}

/** His menu's Feed item, in words. */
function feedLabel(stateIn, { crabOnly = false } = {}) {
  const state = normalize(stateIn);
  const n = pantryTotal(state);
  if (state.meters.fullness >= STUFFED) return 'Feed him (he\'s stuffed)';
  if (n) return `Feed him (🦐 ${n})`;
  return crabOnly ? 'Feed him (snacks come from focus sessions and games)' : 'Feed him (snacks come from finished tasks)';
}

module.exports = {
  METERS, FLOOR, LOW, HAPPY, STUFFED, RESTED, RATES, MAX_STEP, BACK_AFTER, WEAR, ATTEND,
  SNACKS, SNACK_ORDER, PANTRY_MAX, TIDE_EVERY, RINSE_EVERY, TUCK_EVERY, TUCK_PEP, NEEDY_GAP, SOURCES, NEEDY_MOODS,
  normalize, tick, wear, attend, earn, tide, mood, feed, rinse, tuckIn, needyLine, markNeedy, napChance, refill,
  pantryTotal, nextRinseAt, nextTuckAt, view, feedLabel,
};
