// He remembers you. A bond that grows with petting, playing and days spent
// together (it never shrinks: he can get peckish or a bit mopey, see needs.js,
// but that never costs a single point here), a
// journal of the moments worth keeping ("You shook me off Chrome"), the days
// worth marking (100 days together, his hatch day, your birthday if you tell
// him), and the odd line that brings one of them back up.
//
// Pure: no I/O, no clock, no randomness of its own (callers pass `now` and
// `rand`). src/main/life.js keeps it; see test/bond.test.js.

const DAY = 24 * 60 * 60 * 1000;

const LEVELS = Object.freeze([
  { at: 0, name: 'New friends', icon: '🥚' },
  { at: 25, name: 'Pals', icon: '🐚' },
  { at: 100, name: 'Buddies', icon: '🦀' },
  { at: 260, name: 'Close friends', icon: '💛' },
  { at: 600, name: 'Best friends', icon: '💞' },
  { at: 1300, name: 'Inseparable', icon: '🌟' },
].map(Object.freeze));

// What each level opens up. src/main/scenes.js and life.js check `bond` levels
// against the same numbers.
const UNLOCKS = Object.freeze([
  { level: 1, text: 'He starts bringing up things you did together.' },
  { level: 2, text: 'He shows off his favourite find, and asks to play hide and seek.' },
  { level: 3, text: 'He draws you hearts in the sand.' },
  { level: 4, text: 'He leans on your cursor for a cuddle. (And a trophy.)' },
  { level: 5, text: 'Golden hearts when you pet him.' },
].map(Object.freeze));

// How a bond grows. `perDay` caps the ones you could otherwise farm.
const EARN = Object.freeze({
  day: { points: 5 },                    // another day together (also counts the days)
  pet: { points: 1, perDay: 10 },
  play: { points: 3, perDay: 4 },        // hide and seek, fetch
  ride: { points: 1, perDay: 3 },        // riding a window you drag
  find: { points: 1, perDay: 5 },        // a gift he dug up for you
  visit: { points: 3, perDay: 2 },       // a friend's crab dropped by
  banter: { points: 1, perDay: 3 },
  feed: { points: 1, perDay: 3 },        // a snack (needs.js)
  care: { points: 1, perDay: 2 },        // a rinse or a tuck-in
});

const DAY_MILESTONES = Object.freeze([7, 30, 50, 100, 200, 365, 500, 730, 1000]);
const JOURNAL_MAX = 200;                 // repeatable moments kept; firsts are never let go
const RECALL_AFTER = 2 * DAY;            // a memory has to be a couple of days old to bring up
const MAX_LINE = 24;                     // voice.js MAX_LINE

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);
const clip = (s, n = 80) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

// ---------------------------------------------------------------- the journal
// Each kind of memory: how it reads on the Us page, and whether only the first
// one counts. `data` carries the few plain values the text needs.
const MEMORIES = Object.freeze({
  hatched: { first: true, icon: '🥚', text: () => 'Moved onto your desktop' },
  'first-pet': { first: true, icon: '♥', text: () => 'His first pet' },
  'first-throw': { first: true, icon: '🛩️', text: () => 'You threw him across the screen' },
  'first-perch': { first: true, icon: '🧗', text: d => `Climbed onto ${d.app || 'a window'} for the first time` },
  shaken: { icon: '🤠', text: d => `You shook him off ${d.app || 'a window'}` },
  'big-ride': { icon: '🎢', text: d => `Rode ${d.app || 'a window'} ${Math.round(d.px || 0).toLocaleString('en-US')} px` },
  'first-find': { first: true, icon: '🐚', text: d => `Dug up his first find: ${d.item || 'something'}` },
  'rare-find': { icon: '✨', text: d => `Found ${d.item || 'something rare'}` },
  'set-done': { icon: '🏆', text: d => `Finished the ${d.set || ''} set` },
  visitor: { icon: '🏡', text: d => `@${d.login}'s crab came to visit` },
  game: { icon: '🎮', text: d => (d.app ? `Watched you play ${d.app}` : 'Watched you play a game') },
  'first-call': { first: true, icon: '🤫', text: () => 'Kept quiet through your first call' },
  'hide-found': { icon: '🙈', text: d => `You found him in hide and seek in ${fmtTime(d.ms)}` },
  'hide-won': { first: true, icon: '🏅', text: () => 'Won his first game of hide and seek' },
  'first-fetch': { first: true, icon: '🎾', text: () => 'Your first game of fetch' },
  'first-snack': { first: true, icon: '🦐', text: () => 'You fed him his first snack' },
  'first-bath': { first: true, icon: '🧼', text: () => 'His first rinse' },
  'golden-snack': { first: true, icon: '✨', text: () => 'Shared a golden plankton' },
  // His tank (tank-life.js).
  'tank-gift': { first: true, icon: '🏰', text: d => `You gave him ${d.item ? `a ${d.item.toLowerCase()}` : 'something'} for his tank` },
  'moving-day': { icon: '📦', text: d => `Moving day: the ${d.size || 'bigger tank'}` },
  'set-shown': { icon: '🖼️', text: d => `Put the ${d.set || ''} set on display` },
  days: { icon: '🗓️', text: d => `${d.n} days together` },
  level: { icon: '💞', text: d => `Became ${d.name}` },
  birthday: { icon: '🎂', text: () => 'Wished you a happy birthday' },
  hatchday: { icon: '🕯️', text: d => `${d.years} year${d.years === 1 ? '' : 's'} on your desktop` },
  // Tide events, sparklies, eggs, swaps and the friends' board (docs/plans/viral.md).
  'event-medal': { icon: '🏅', text: d => `Finished ${d.event || 'a tide event'}` },
  'first-shiny': { first: true, icon: '✨', text: d => `His first sparkly one: ${d.item || 'something'}` },
  'egg-hatched': { icon: '🐣', text: d => (d.login ? `@${d.login} hatched one of his eggs: ${d.name || 'a baby crab'}` : `Hatched from @${d.from || 'a friend'}'s egg`) },
  'first-swap': { first: true, icon: '🤝', text: d => `Swapped finds with @${d.login || 'a friend'} for the first time` },
  'board-month': { icon: '🥇', text: d => `${d.place || 'On'} the friends' board in ${d.month || 'a month'}` },
});

const FIRSTS = new Set(Object.keys(MEMORIES).filter(k => MEMORIES[k].first));

// Newest first, as the journal is kept. Firsts always stay (there are only a
// handful, each written once, oldest copy kept); the rest stop at JOURNAL_MAX.
function trim(journal) {
  const seen = new Set();
  let kept = 0;
  const out = [];
  for (let i = journal.length - 1; i >= 0; i--) { // oldest first, so a first keeps its real date
    const e = journal[i];
    if (FIRSTS.has(e.kind)) { if (!seen.has(e.kind)) { seen.add(e.kind); out.push(e); } } else out.push(e);
  }
  out.reverse();
  return out.filter(e => FIRSTS.has(e.kind) || ++kept <= JOURNAL_MAX);
}

const fmtTime = ms => { const s = Math.max(0, Math.round((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const cleanData = d => {
  const out = {};
  for (const [k, v] of Object.entries(d && typeof d === 'object' ? d : {})) {
    if (typeof v === 'string') out[k] = clip(v, 40);
    else if (Number.isFinite(v)) out[k] = v;
  }
  return out;
};

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const t = r.today && typeof r.today === 'object' ? r.today : {};
  const today = {};
  for (const k of Object.keys(EARN)) today[k] = Math.floor(pos(t[k]));
  today.date = typeof t.date === 'string' ? t.date : null;
  const bd = r.birthday && typeof r.birthday === 'object' ? r.birthday : null;
  const journal = trim((Array.isArray(r.journal) ? r.journal : [])
    .filter(e => e && MEMORIES[e.kind] && pos(e.at))
    .map(e => ({ kind: e.kind, at: e.at, data: cleanData(e.data) })));
  const birthday = bd && Number.isInteger(bd.m) && Number.isInteger(bd.d) && bd.m >= 1 && bd.m <= 12 && bd.d >= 1 && bd.d <= 31 ? { m: bd.m, d: bd.d } : null;
  return {
    hatchedAt: pos(r.hatchedAt),
    points: Math.floor(pos(r.points)),
    days: Math.floor(pos(r.days)),
    lastDay: typeof r.lastDay === 'string' ? r.lastDay : null,
    level: Math.min(LEVELS.length - 1, Math.floor(pos(r.level))),
    today,
    birthday,
    celebrated: (Array.isArray(r.celebrated) ? r.celebrated : []).filter(s => typeof s === 'string' && /^[a-z]+:\d{4}$/.test(s)).slice(-10),
    journal,
    // Every first he's written down, even one a journal from before firsts were
    // kept for good has lost: seeded from the journal, so it's never written twice.
    firsts: [...new Set([...(Array.isArray(r.firsts) ? r.firsts : []).filter(k => FIRSTS.has(k)), ...journal.filter(e => FIRSTS.has(e.kind)).map(e => e.kind)])],
    recalled: (Array.isArray(r.recalled) ? r.recalled : []).filter(n => Number.isFinite(n)).slice(-12),
  };
}

/** { index, name, icon, points, floor, next, progress } for a point total. */
function levelFor(points) {
  const p = Math.floor(pos(points));
  let index = 0;
  while (index < LEVELS.length - 1 && p >= LEVELS[index + 1].at) index++;
  const floor = LEVELS[index].at;
  const next = LEVELS[index + 1]?.at ?? null;
  return { index, name: LEVELS[index].name, icon: LEVELS[index].icon, points: p, floor, next, progress: next ? (p - floor) / (next - floor) : 1 };
}

/**
 * Write a moment down. Firsts are written once, ever. Returns the new state (the old
 * one is never mutated) and whether anything was added.
 */
function remember(stateIn, kind, now, data = {}) {
  const state = normalize(stateIn);
  const rule = MEMORIES[kind];
  const t = Number(now);
  if (!rule || !Number.isFinite(t)) return { state, added: false };
  if (rule.first && state.firsts.includes(kind)) return { state, added: false };
  const entry = { kind, at: t, data: cleanData(data) };
  const firsts = rule.first ? [...state.firsts, kind] : state.firsts;
  return { state: { ...state, journal: trim([entry, ...state.journal]), firsts }, added: true };
}

/**
 * The bond grows. Returns { state, gained, levelUp (the new level or null),
 * milestone (days, when 'day' reached one) }. Capped kinds stop counting for
 * the day once they hit their cap.
 */
function earn(stateIn, kind, now) {
  let state = normalize(stateIn);
  const rule = EARN[kind];
  const t = Number(now);
  const none = { state, gained: 0, levelUp: null, milestone: null };
  if (!rule || !Number.isFinite(t)) return none;
  const day = dayKey(t);
  let today = state.today.date === day ? state.today : { ...Object.fromEntries(Object.keys(EARN).map(k => [k, 0])), date: day };
  let milestone = null;
  if (kind === 'day') {
    if (state.lastDay === day) return none;
    const days = state.days + 1;
    state = { ...state, days, lastDay: day, hatchedAt: state.hatchedAt || t };
    if (DAY_MILESTONES.includes(days)) {
      milestone = days;
      state = remember(state, 'days', t, { n: days }).state;
    }
  } else if (rule.perDay && today[kind] >= rule.perDay) {
    return { ...none, state: { ...state, today } };
  }
  today = { ...today, [kind]: (today[kind] || 0) + 1 };
  const before = levelFor(state.points);
  const points = state.points + rule.points;
  const after = levelFor(points);
  state = { ...state, points, today };
  let levelUp = null;
  if (after.index > state.level) {
    levelUp = { index: after.index, name: after.name, icon: after.icon };
    state = { ...remember(state, 'level', t, { name: after.name }).state, level: after.index };
  }
  return { state, gained: points - before.points, levelUp, milestone };
}

/** First run (or the first run of this feature): when did he move in? */
function hatch(stateIn, now, { since = null } = {}) {
  const state = normalize(stateIn);
  if (state.hatchedAt) return state;
  const at = pos(since) && since < now ? since : now;
  return { ...remember({ ...state, hatchedAt: at }, 'hatched', at).state, hatchedAt: at };
}

/** Your birthday, from the Us page: { m, d } or null to forget it. */
function setBirthday(stateIn, bd) {
  const state = normalize(stateIn);
  if (bd == null) return { ...state, birthday: null };
  const m = Math.floor(Number(bd.m)), d = Math.floor(Number(bd.d));
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= new Date(2024, m, 0).getDate())) return state;
  return { ...state, birthday: { m, d } };
}

/**
 * 'birthday' | 'hatchday' when today is one (and it hasn't been celebrated
 * this year), else null. A 29 February birthday is kept on the 28th in other years.
 */
function specialDay(stateIn, now) {
  const state = normalize(stateIn);
  const d = new Date(Number(now));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  const leap = new Date(y, 1, 29).getMonth() === 1;
  const is = bd => bd && bd.m === m && (bd.d === day || (bd.m === 2 && bd.d === 29 && !leap && day === 28));
  if (is(state.birthday) && !state.celebrated.includes(`birthday:${y}`)) return 'birthday';
  if (state.hatchedAt) {
    const h = new Date(state.hatchedAt);
    if (h.getFullYear() < y && is({ m: h.getMonth() + 1, d: h.getDate() }) && !state.celebrated.includes(`hatchday:${y}`)) return 'hatchday';
  }
  return null;
}

/** Mark a special day done for this year, and write it down. */
function celebrate(stateIn, which, now) {
  const state = normalize(stateIn);
  const y = new Date(Number(now)).getFullYear();
  const tag = `${which}:${y}`;
  if (state.celebrated.includes(tag)) return state;
  const years = state.hatchedAt ? y - new Date(state.hatchedAt).getFullYear() : 0;
  const next = { ...state, celebrated: [...state.celebrated, tag].slice(-10) };
  return remember(next, which, now, which === 'hatchday' ? { years } : {}).state;
}

/** What he'd say on a special day or a milestone. */
function celebrationLine(which, { days = 0, years = 0 } = {}) {
  if (which === 'birthday') return 'happy birthday!!';
  if (which === 'hatchday') return years > 1 ? `${years} years together!` : 'happy hatch day!';
  if (which === 'days') return `${days} days together!`;
  return null;
}

// ---------------------------------------------------------------- bringing it back up
// Each kind of memory he can mention, as bubble-sized lines. Lines that come
// out too long for the bubble are simply skipped.
const RECALL = Object.freeze({
  shaken: d => (d.app ? [`remember ${d.app}?`, `${d.app} owes me one`] : []),
  'big-ride': d => (d.app ? [`that ${d.app} ride!`, 'what a ride that was'] : ['what a ride that was']),
  'first-perch': d => (d.app ? [`miss the ${d.app} view`] : []),
  'rare-find': d => (d.item ? [`my ${d.item.toLowerCase()}…`, 'still got my treasure'] : []),
  'first-find': () => ['my first find…'],
  visitor: d => [`miss @${d.login}`, 'when\'s the next visit?'],
  game: d => (d.app ? [`more ${d.app}?`, 'gg that time'] : ['gg that time']),
  'hide-found': d => [`you found me in ${fmtTime(d.ms)}`, 'hide and seek again?'],
  'first-fetch': () => ['fetch later?'],
  'first-pet': () => ['you pet me first'],
  'first-snack': () => ['my first snack…', 'still taste that plankton'],
  'golden-snack': () => ['that golden plankton!'],
});

/**
 * A memory to bring up, or null. Never one that's still fresh, and not the
 * same one again until a few others have had their turn. Returns { text, state }.
 *   extra: { days, throws, petted } for lines that come from counts, not the journal
 */
function recall(stateIn, now, rand = Math.random, { throws = 0 } = {}) {
  const state = normalize(stateIn);
  const t = Number(now);
  if (!Number.isFinite(t) || levelFor(state.points).index < 1) return null;
  const options = [];
  state.journal.forEach((e, i) => {
    if (t - e.at < RECALL_AFTER || !RECALL[e.kind] || state.recalled.includes(e.at)) return;
    for (const text of RECALL[e.kind](e.data)) if (text.length <= MAX_LINE) options.push({ text, at: e.at, i });
  });
  if (state.days >= 3) options.push({ text: `day ${state.days}, us two`, at: -state.days });
  if (throws >= 5) options.push({ text: `${throws} throws. ow.`, at: -throws - 100000 });
  const usable = options.filter(o => o.text.length <= MAX_LINE && !state.recalled.includes(o.at));
  if (!usable.length) return null;
  const pick = usable[Math.min(usable.length - 1, Math.floor(rand() * usable.length))];
  return { text: pick.text, state: { ...state, recalled: [...state.recalled, pick.at].slice(-12) } };
}

/** Everything the Us page shows. */
function view(stateIn, now = Date.now()) {
  const state = normalize(stateIn);
  const lvl = levelFor(state.points);
  const nextMilestone = DAY_MILESTONES.find(n => n > state.days) || null;
  return {
    level: lvl,
    levels: LEVELS.map((l, i) => ({ ...l, index: i, reached: i <= lvl.index })),
    unlocks: UNLOCKS.map(u => ({ ...u, open: lvl.index >= u.level, levelName: LEVELS[u.level].name })),
    days: state.days,
    hatchedAt: state.hatchedAt,
    birthday: state.birthday,
    nextMilestone,
    journal: state.journal.map(e => ({ kind: e.kind, at: e.at, icon: MEMORIES[e.kind].icon, text: MEMORIES[e.kind].text(e.data) })),
    now,
  };
}

module.exports = {
  LEVELS, UNLOCKS, EARN, DAY_MILESTONES, MEMORIES, RECALL_AFTER, JOURNAL_MAX,
  normalize, levelFor, remember, earn, hatch, setBirthday, specialDay, celebrate, celebrationLine, recall, view, fmtTime,
};
