// Tide events: a short, named week or so inside a season, with a countdown,
// its own bug (bugdex/species.js `event`), its own finds (gifts.js `event`),
// four goals and a medal stamped with the year. Seasons (wardrobe/seasons.js)
// come round every year with the same things; an event is the bit you can
// miss. Its trophy and reward item come back next year; the medal for a year
// never does. See docs/plans/viral.md §1.
//
// Every goal is counted from things Shellby already sees (the stats in
// wardrobe/achievements.js): a bug caught is a fix Claude proved, a task is a
// task. Nothing here can be bought or ground out by clicking.
//
// Pure: no I/O, no clock, no randomness (callers pass the date). Windows are
// local time, inclusive, like the seasons'. The `nature` ones follow their
// season south of the equator ({ south: true }). See test/events.test.js.

const DAY = 24 * 60 * 60 * 1000;
const MAX_RUNS = 24;               // past events remembered (four years of six)
const MAX_DISTINCT = 12;           // ids remembered per goal for "two different..."
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const freeze = o => Object.freeze(o);

// Medals are 7×7 emblems (the badge format in bugdex/species.js).
const EVENTS = freeze([
  {
    id: 'harvest', name: 'Harvest Moon', emoji: '🌾', season: 'autumn', nature: true, start: [10, 1], end: [10, 9],
    blurb: 'The nights draw in and everything you ship is worth more.',
    twist: 'Every catch pays half again in XP.',
    bug: 'harvest-mouse', bugRule: 'A first-try fix while Harvest Moon is on.',
    finds: ['golden-wheat', 'lantern-gourd'], trophy: 'harvest-home',
    boosts: { xp: 1.5 },
    goals: [
      { id: 'tasks', text: 'Finish 10 tasks', on: 'task-completed', goal: 10 },
      { id: 'green', text: 'Get a red test suite green', on: 'tests-fixed', goal: 1 },
      { id: 'mouse', text: 'Catch the Harvest Mouse', on: 'event-bug', goal: 1 },
      { id: 'finds', text: 'Dig up its two finds', on: 'find-made', where: { event: true }, distinct: true, goal: 2 },
    ],
    medal: { palette: { a: '#e9a23b', b: '#ffe8a3', c: '#7f5539' }, pixels: ['..aaa..', '.abbba.', 'abcbcba', 'abbcbba', 'abcbcba', '.abbba.', '..aaa..'] },
  },
  {
    id: 'haunting', name: 'The Haunting', emoji: '🎃', season: 'halloween', start: [10, 24], end: [11, 1],
    blurb: 'Something is moving in the wreck. Bugs fixed after dark don\'t come alone.',
    twist: 'Ghosts caught in the Haunted Wreck are twice as likely to sparkle.',
    bug: 'will-o-wisp', bugRule: 'Any fix after 9 pm while The Haunting is on.',
    finds: ['ghost-lantern', 'cursed-doubloon'], trophy: 'the-haunted',
    boosts: { shiny: { wreck: 2 } },
    goals: [
      { id: 'bugs', text: 'Catch 3 bugs', on: 'bug-caught', goal: 3 },
      { id: 'ghost', text: 'Catch a ghost in the Haunted Wreck', on: 'bug-caught', where: { habitat: 'wreck' }, goal: 1 },
      { id: 'wisp', text: 'Catch the Will-o\'-Wisp', on: 'event-bug', goal: 1 },
      { id: 'finds', text: 'Dig up its two finds', on: 'find-made', where: { event: true }, distinct: true, goal: 2 },
    ],
    medal: { palette: { a: '#ff9f1c', b: '#2b2d42', c: '#57cc99' }, pixels: ['...c...', '.aaaaa.', 'aabaaba', 'aaaaaaa', 'abababa', '.abbba.', '..aaa..'] },
  },
  {
    id: 'frostbite', name: 'Frostbite', emoji: '❄️', season: 'winter', start: [12, 18], end: [1, 1],
    blurb: 'The tide pools are freezing over. Busy days bring something up from the ice.',
    twist: 'Snow piles up on his shell a little with every catch.',
    bug: 'frost-mite', bugRule: 'Your third catch in one day while Frostbite is on.',
    finds: ['ice-crystal', 'frozen-bug'], trophy: 'snowed-in',
    boosts: {},
    goals: [
      { id: 'bugs', text: 'Catch 5 bugs', on: 'bug-caught', goal: 5 },
      { id: 'tasks', text: 'Finish 8 tasks', on: 'task-completed', goal: 8 },
      { id: 'mite', text: 'Catch the Frost Mite', on: 'event-bug', goal: 1 },
      { id: 'finds', text: 'Dig up its two finds', on: 'find-made', where: { event: true }, distinct: true, goal: 2 },
    ],
    medal: { palette: { a: '#8ecae6', b: '#e0fbfc', c: '#ffffff' }, pixels: ['a..a..a', '.a.a.a.', '..bab..', 'aaacaaa', '..bab..', '.a.a.a.', 'a..a..a'] },
  },
  {
    id: 'penpal', name: 'Pen Pal Week', emoji: '💌', season: 'valentine', start: [2, 9], end: [2, 15],
    blurb: 'Nobody fixes bugs alone this week. Send a helper, wave at a friend.',
    twist: 'Swaps between friends count double toward the trophies.',
    bug: 'lovebug', bugRule: 'A bug beaten with a helper crab in the fight while Pen Pal Week is on.',
    finds: ['love-letter', 'paired-shells'], trophy: 'pen-pals-forever',
    boosts: { swaps: 2 },
    goals: [
      { id: 'helpers', text: 'Send out 5 helper crabs', on: 'helper-spawned', goal: 5 },
      { id: 'wave', text: 'Wave at a friend', on: 'wave-sent', goal: 1 },
      { id: 'lovebug', text: 'Catch the Lovebug', on: 'event-bug', goal: 1 },
      { id: 'finds', text: 'Dig up its two finds', on: 'find-made', where: { event: true }, distinct: true, goal: 2 },
    ],
    medal: { palette: { a: '#ff5d8f', b: '#ffb3c6', c: '#ffffff' }, pixels: ['.......', '.aa.aa.', 'abbabba', 'abcbbba', '.abbba.', '..aba..', '...a...'] },
  },
  {
    id: 'spring-clean', name: 'Spring Clean', emoji: '🌸', season: 'spring', nature: true, start: [3, 22], end: [4, 2],
    blurb: 'Out with the old. The best fixes this week take code away.',
    twist: 'Something lives in the code you delete.',
    bug: 'dust-bunny', bugRule: 'A fix that deletes more lines than it adds while Spring Clean is on.',
    finds: ['feather-duster', 'pressed-flower'], trophy: 'spick-and-span',
    boosts: {},
    goals: [
      { id: 'tasks', text: 'Finish 8 tasks', on: 'task-completed', goal: 8 },
      { id: 'green', text: 'Get a red test suite green', on: 'tests-fixed', goal: 1 },
      { id: 'bunny', text: 'Catch the Dust Bunny', on: 'event-bug', goal: 1 },
      { id: 'finds', text: 'Dig up its two finds', on: 'find-made', where: { event: true }, distinct: true, goal: 2 },
    ],
    medal: { palette: { a: '#ffb3c6', b: '#fff0f3', c: '#ffd166' }, pixels: ['...a...', '..aba..', 'aaacaaa', 'abcccba', 'aaacaaa', '..aba..', '...a...'] },
  },
  {
    id: 'low-tide', name: 'Low Tide', emoji: '🌊', season: 'summer', nature: true, start: [7, 10], end: [7, 21],
    blurb: 'The sea\'s gone out further than anyone remembers. Everything\'s washing up.',
    twist: 'He digs twice as often, and finds are twice as likely to sparkle.',
    bug: 'tide-pool-nudibranch', bugRule: 'Any catch in the Shallows while Low Tide is on.',
    finds: ['stranded-jelly', 'pearl-oyster'], trophy: 'beachcombed',
    boosts: { dig: 2, shiny: { all: 2 } },
    goals: [
      { id: 'dig', text: 'Dig up 10 finds', on: 'find-made', goal: 10 },
      { id: 'tasks', text: 'Finish 5 tasks', on: 'task-completed', goal: 5 },
      { id: 'nudi', text: 'Catch the Tide-Pool Nudibranch', on: 'event-bug', goal: 1 },
      { id: 'finds', text: 'Dig up its two finds', on: 'find-made', where: { event: true }, distinct: true, goal: 2 },
    ],
    medal: { palette: { a: '#4ea8de', b: '#caf0f8', c: '#ffd166' }, pixels: ['..ccc..', '.ccccc.', '..ccc..', '.......', 'a.a.a.a', '.b.b.b.', 'aaaaaaa'] },
  },
].map(e => freeze({
  nature: false, boosts: {}, ...e,
  start: freeze([...e.start]), end: freeze([...e.end]),
  finds: freeze([...e.finds]),
  goals: freeze(e.goals.map(g => freeze({ where: null, distinct: false, ...g }))),
  boosts: freeze({ ...e.boosts }),
  medal: freeze({ palette: freeze({ ...e.medal.palette }), pixels: freeze([...e.medal.pixels]) }),
})));

const BY_ID = new Map(EVENTS.map(e => [e.id, e]));
const eventById = id => BY_ID.get(id) || null;
const KNOWN_EVENTS = new Set(BY_ID.keys());

// ------------------------------------------------------------------ the calendar

// Six months on, a day the new month doesn't have coming back to its last (as seasons.js does).
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const halfYear = ([m, d]) => { const to = ((m + 5) % 12) + 1; return [to, Math.min(d, MONTH_DAYS[to - 1])]; };
const md = ([m, d]) => m * 100 + d;

/** The event's dates where you are: [start, end] as [month, day]. */
function datesOf(ev, { south = false } = {}) {
  return south && ev.nature ? [halfYear(ev.start), halfYear(ev.end)] : [ev.start, ev.end];
}

const validDate = d => (d instanceof Date && !Number.isNaN(d.getTime()) ? d : null);
const startOf = (year, [m, d]) => new Date(year, m - 1, d);
const endOf = (year, [m, d]) => new Date(year, m - 1, d, 23, 59, 59, 999);

/** The run of `ev` that starts in `year`: { start, end, year, key }. */
function runIn(ev, year, opts) {
  const [a, b] = datesOf(ev, opts);
  const wraps = md(a) > md(b);
  return { start: startOf(year, a), end: endOf(wraps ? year + 1 : year, b), year, key: `${ev.id}@${year}` };
}

/** The run of `ev` going on at `date`, or null. */
function runAt(ev, date, opts = {}) {
  const d = validDate(date);
  if (!d || !ev) return null;
  for (const y of [d.getFullYear() - 1, d.getFullYear()]) {
    const r = runIn(ev, y, opts);
    if (d >= r.start && d <= r.end) return r;
  }
  return null;
}

/** The next run of `ev` that starts after `date` (or the one going on). */
function nextRun(ev, date, opts = {}) {
  const d = validDate(date);
  if (!d || !ev) return null;
  const now = runAt(ev, d, opts);
  if (now) return now;
  for (const y of [d.getFullYear(), d.getFullYear() + 1]) {
    const r = runIn(ev, y, opts);
    if (r.start > d) return r;
  }
  return null;
}

/** The event on at `date`, with its run, or null. Events never overlap. */
function activeEvent(date, opts = {}) {
  for (const ev of EVENTS) {
    const run = runAt(ev, date, opts);
    if (run) return { ev, run };
  }
  return null;
}

/** The next event to start after `date` (not the one going on). */
function upcoming(date, opts = {}) {
  const d = validDate(date);
  if (!d) return null;
  let best = null;
  for (const ev of EVENTS) {
    for (const y of [d.getFullYear(), d.getFullYear() + 1]) {
      const r = runIn(ev, y, opts);
      if (r.start > d && (!best || r.start < best.run.start)) { best = { ev, run: r }; break; }
    }
  }
  return best;
}

/** What the event going on changes: { xp, dig, swaps, shiny(habitat) }. All 1 with nothing on. */
function boostsAt(date, opts = {}) {
  const a = activeEvent(date, opts);
  const b = a ? a.ev.boosts : {};
  return {
    event: a ? a.ev.id : null,
    xp: b.xp || 1, dig: b.dig || 1, swaps: b.swaps || 1,
    shinyFor: habitat => (b.shiny ? (b.shiny.all || 1) * ((habitat && b.shiny[habitat]) || 1) : 1),
  };
}

// ------------------------------------------------------------------ the event bug

/**
 * Does this catch bring the event's bug along with it? Only a real catch can:
 * the rule is about how it was fixed, never how often you clicked.
 *   ctx: { hour, habitat, forms, party, trimmed, todayCount, species }
 */
function bugComesAlong(evId, ctx = {}) {
  const forms = Array.isArray(ctx.forms) ? ctx.forms : [];
  switch (evId) {
    case 'harvest': return forms.includes('first-try');
    case 'haunting': return Number.isInteger(ctx.hour) && (ctx.hour >= 21 || ctx.hour < 5);
    case 'frostbite': return Number(ctx.todayCount) >= 3;
    case 'penpal': return Number(ctx.party) >= 1;
    case 'spring-clean': return ctx.trimmed === true;
    case 'low-tide': return ctx.habitat === 'shallows';
    default: return false;
  }
}

// ------------------------------------------------------------------ progress

const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const RUN_RE = /^([a-z0-9-]{1,40})@(\d{4})$/;

function cleanRun(raw, ev) {
  const r = obj(raw);
  const goals = {}, ids = {};
  for (const g of ev.goals) {
    const n = Math.min(g.goal, Math.floor(pos(obj(r.goals)[g.id])));
    if (n) goals[g.id] = n;
    const list = obj(r.ids)[g.id];
    if (g.distinct && Array.isArray(list)) ids[g.id] = [...new Set(list.filter(x => typeof x === 'string' && ID_RE.test(x)))].slice(0, MAX_DISTINCT);
  }
  return { started: pos(r.started), goals, ids, doneAt: pos(r.doneAt), lastCall: pos(r.lastCall) };
}

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = obj(raw);
  const runs = {};
  for (const [key, run] of Object.entries(obj(r.runs))) {
    const m = RUN_RE.exec(key);
    const ev = m && BY_ID.get(m[1]);
    if (ev) runs[key] = cleanRun(run, ev);
  }
  const kept = Object.entries(runs).sort((a, b) => (a[1].started || a[1].doneAt) - (b[1].started || b[1].doneAt)).slice(-MAX_RUNS);
  const medals = [...new Set((Array.isArray(r.medals) ? r.medals : []).filter(k => typeof k === 'string' && RUN_RE.test(k) && BY_ID.has(RUN_RE.exec(k)[1])))].sort();
  return { runs: Object.fromEntries(kept), medals };
}

const goalDone = (run, g) => (run.goals[g.id] || 0) >= g.goal;
const allDone = (run, ev) => ev.goals.every(g => goalDone(run, g));

function matches(g, ev, payload) {
  const p = obj(payload);
  if (!g.where) return true;
  if (g.where.event && p.event !== ev.id) return false;
  if (g.where.habitat && p.habitat !== g.where.habitat) return false;
  return true;
}

/**
 * Something happened (a stat event, as wardrobe/achievements.js gets them).
 * Counts it toward the goals of the event going on.
 *   payload: { habitat, event, id, n } as the event has them
 * -> { state, event, moved: [goal ids], finished: bool, key }
 */
function record(stateIn, statEvent, payload, date, opts = {}) {
  const state = normalize(stateIn);
  const a = activeEvent(date, opts);
  const none = { state, event: null, moved: [], finished: false, key: null };
  if (!a) return none;
  const { ev, run: r } = a;
  const run = state.runs[r.key] ? cleanRun(state.runs[r.key], ev) : cleanRun({ started: date.getTime() }, ev);
  if (run.doneAt) return { ...none, event: ev.id, key: r.key };
  const moved = [];
  const goals = { ...run.goals }, ids = { ...run.ids };
  for (const g of ev.goals) {
    if (g.on !== statEvent || goalDone({ goals }, g) || !matches(g, ev, payload)) continue;
    if (g.distinct) {
      const id = obj(payload).id;
      if (typeof id !== 'string' || !ID_RE.test(id) || (ids[g.id] || []).includes(id)) continue;
      ids[g.id] = [...(ids[g.id] || []), id].slice(0, MAX_DISTINCT);
      goals[g.id] = Math.min(g.goal, ids[g.id].length);
    } else {
      goals[g.id] = Math.min(g.goal, (goals[g.id] || 0) + 1);
    }
    moved.push(g.id);
  }
  if (!moved.length) return { ...none, event: ev.id, key: r.key };
  const next = { ...run, started: run.started || date.getTime(), goals, ids };
  const finished = allDone(next, ev);
  if (finished) next.doneAt = date.getTime();
  return {
    state: normalize({ runs: { ...state.runs, [r.key]: next }, medals: finished ? [...state.medals, r.key] : state.medals }),
    event: ev.id, moved, finished, key: r.key,
  };
}

/**
 * What to say about the event today, once each: 'start' on the first look at
 * a run, 'last-call' on its last day with goals left. Returns the marked state.
 * -> { state, say: 'start' | 'last-call' | null, ev }
 */
function announce(stateIn, date, opts = {}) {
  const state = normalize(stateIn);
  const a = activeEvent(date, opts);
  if (!a) return { state, say: null, ev: null };
  const { ev, run: r } = a;
  const run = state.runs[r.key] ? cleanRun(state.runs[r.key], ev) : null;
  const t = date.getTime();
  if (!run) return { state: normalize({ ...state, runs: { ...state.runs, [r.key]: cleanRun({ started: t }, ev) } }), say: 'start', ev };
  const lastDay = r.end - t < DAY;
  if (lastDay && !run.doneAt && !run.lastCall) return { state: normalize({ ...state, runs: { ...state.runs, [r.key]: { ...run, lastCall: t } } }), say: 'last-call', ev };
  return { state, say: null, ev };
}

// ------------------------------------------------------------------ the view

/** "3 days left", "ends tonight", "starts in 5 days". */
function timeLeft(to, now) {
  const ms = to - now;
  if (ms <= 0) return 'over';
  const days = Math.floor(ms / DAY);
  if (days < 1) return 'ends tonight';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

function startsIn(from, now) {
  const days = Math.ceil((from - now) / DAY);
  return days <= 1 ? 'starts tomorrow' : `starts in ${days} days`;
}

const medalOf = key => {
  const m = RUN_RE.exec(key);
  const ev = m && BY_ID.get(m[1]);
  return ev ? { key, id: ev.id, year: Number(m[2]), name: `${ev.name} ${m[2]}`, emoji: ev.emoji, pixels: ev.medal.pixels, palette: ev.medal.palette } : null;
};

/**
 * Everything the banner and the Us page show.
 *   extra: { bugCaught: bool, findsFound: [ids] } for the event going on
 */
function view(stateIn, date, opts = {}, extra = {}) {
  const state = normalize(stateIn);
  const d = validDate(date) || new Date(0);
  const t = d.getTime();
  const a = activeEvent(d, opts);
  let active = null;
  if (a) {
    const { ev, run: r } = a;
    const run = state.runs[r.key] ? cleanRun(state.runs[r.key], ev) : cleanRun(null, ev);
    active = {
      id: ev.id, key: r.key, name: ev.name, emoji: ev.emoji, year: r.year, blurb: ev.blurb, twist: ev.twist,
      startsAt: r.start.getTime(), endsAt: r.end.getTime(), left: timeLeft(r.end.getTime(), t), lastDay: r.end.getTime() - t < DAY,
      daysLeft: Math.max(0, Math.ceil((r.end.getTime() - t) / DAY)),
      goals: ev.goals.map(g => ({ id: g.id, text: g.text, n: run.goals[g.id] || 0, goal: g.goal, done: goalDone(run, g) })),
      done: !!run.doneAt, doneAt: run.doneAt || 0,
      bug: { id: ev.bug, rule: ev.bugRule, caught: !!extra.bugCaught },
      finds: ev.finds.map(id => ({ id, found: (extra.findsFound || []).includes(id) })),
      trophy: ev.trophy,
      medal: { pixels: ev.medal.pixels, palette: ev.medal.palette },
    };
  }
  const up = upcoming(d, opts);
  return {
    active,
    next: up ? { id: up.ev.id, name: up.ev.name, emoji: up.ev.emoji, startsAt: up.run.start.getTime(), when: startsIn(up.run.start.getTime(), t) } : null,
    medals: state.medals.map(medalOf).filter(Boolean).sort((x, y) => y.year - x.year || (x.id < y.id ? -1 : 1)),
  };
}

/** When the event's bug or finds come back, for a book or shelf that's missing them: a Date or null. */
function backOn(evId, date, opts = {}) {
  const ev = BY_ID.get(evId);
  const r = ev ? nextRun(ev, date, opts) : null;
  return r ? r.start : null;
}

/** Medal keys as a public card carries them, cleaned: ['haunting@2026']. */
function cleanMedals(raw) {
  return normalize({ medals: raw }).medals.slice(-24);
}

module.exports = {
  EVENTS, KNOWN_EVENTS, eventById, datesOf, runAt, nextRun, activeEvent, upcoming, boostsAt, bugComesAlong,
  normalize, record, announce, view, timeLeft, backOn, medalOf, cleanMedals,
};
