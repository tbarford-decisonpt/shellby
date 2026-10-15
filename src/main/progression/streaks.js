// Streaks and nudges. A streak is the days with at least one finished Claude
// task (in Shellby or, via the plugin, anywhere). Projects are the git repos
// you work in; when one you've been working on goes quiet, Shellby nudges:
// "You haven't committed to 3d-rack in 5 days 🐚".
//
// A streak never punishes a life (docs/GAMIFICATION-PLAN.md section 2.2):
//   - rest days (Saturday and Sunday unless changed) hold it, and changing them
//     only counts from that day on (restLog), so the past never moves;
//   - one missed working day a week (two with the tide-out-plus perk) is a
//     tide-out: it holds too, applied by the walk itself, never spent ahead;
//   - only worked days add to it, and the XP bonus counts weeks with at least
//     3 worked days, so a Monday-to-Friday week is a full week;
//   - when it does break, the bonus ebbs 5% per missed working day instead of
//     dropping to nothing (ebbMultiplier).
// Pure: no I/O, no clock (callers pass `now`). See test/streaks.test.js.

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 400;
const MAX_PROJECTS = 50;
const MAX_REST_LOG = 24;
const FORGET_AFTER = 60 * DAY;      // projects untouched this long are dropped
const ACTIVE_WITHIN = 30 * DAY;     // only nudge about projects you touched recently
const NUDGE_EVERY = 20 * 60 * 60 * 1000;
const NUDGE_HOURS = [9, 21];        // local hours when nudges may fire
const TIDE_OUTS_PER_WEEK = 1;
const FULL_WEEK_DAYS = 3;           // worked days that make a week count for the bonus
const STREAK_STEP = 0.05;           // +5% per full week...
const STREAK_MAX = 0.25;            // ...up to +25% (progression/xp.js clamps it again)
const EBB_STEP = 0.05;              // the bonus slides this much per missed working day
const SINCE_ALWAYS = '0000-01-01';

const DEFAULTS = Object.freeze({ nudges: true, afterDays: 5, restDays: Object.freeze([0, 6]) });

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parts = key => key.split('-').map(Number);
// Calendar arithmetic through the Date constructor, so a DST change never skips or repeats a day.
const shift = (key, n) => { const [y, m, d] = parts(key); return dayKey(new Date(y, m - 1, d + n).getTime()); };
const weekdayOf = key => { const [y, m, d] = parts(key); return new Date(y, m - 1, d).getDay(); };
/** The ISO week a day is in, named by its Monday. */
const weekOf = key => shift(key, -((weekdayOf(key) + 6) % 7));
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Weekdays 0 (Sunday) to 6, unique and sorted; anything else is dropped. */
function cleanRestDays(raw) {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
}

// The rest days in force from each date on; the first entry covers all time.
// No log yet (an older Shellby): `restDays`, or Saturday and Sunday, always.
function cleanRestLog(raw, restDays) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter(e => e && typeof e.from === 'string' && DAY_RE.test(e.from) && cleanRestDays(e.days))
    .map(e => ({ from: e.from, days: cleanRestDays(e.days) }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const byFrom = new Map(list.map(e => [e.from, e])); // the last word for a date wins
  const log = [...byFrom.values()].slice(-MAX_REST_LOG);
  if (!log.length || log[0].from !== SINCE_ALWAYS) log.unshift({ from: SINCE_ALWAYS, days: restDays || [...DEFAULTS.restDays] });
  return log;
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const days = [...new Set((Array.isArray(src.days) ? src.days : []).filter(d => typeof d === 'string' && DAY_RE.test(d)))].sort().slice(-MAX_DAYS);
  const projects = {};
  for (const [key, p] of Object.entries(src.projects && typeof src.projects === 'object' ? src.projects : {})) {
    if (!p || typeof p !== 'object' || typeof key !== 'string' || key.length > 400) continue;
    projects[key] = {
      name: clip(p.name, 60) || 'project',
      lastSeen: Number.isFinite(p.lastSeen) ? p.lastSeen : 0,
      lastCommitAt: Number.isFinite(p.lastCommitAt) ? p.lastCommitAt : null,
      lastNudgeAt: Number.isFinite(p.lastNudgeAt) ? p.lastNudgeAt : null,
      muted: !!p.muted,
    };
  }
  const n = Number(src.afterDays);
  const restLog = cleanRestLog(src.restLog, cleanRestDays(src.restDays));
  const ebbMult = Number(src.ebb?.mult);
  return {
    days, projects,
    nudges: src.nudges === undefined ? DEFAULTS.nudges : !!src.nudges,
    afterDays: Number.isFinite(n) ? Math.min(30, Math.max(1, Math.round(n))) : DEFAULTS.afterDays,
    restDays: restLog[restLog.length - 1].days,
    restLog,
    tideOuts: [...new Set((Array.isArray(src.tideOuts) ? src.tideOuts : []).filter(d => typeof d === 'string' && DAY_RE.test(d)))].sort().slice(-MAX_DAYS),
    ebb: {
      mult: Number.isFinite(ebbMult) ? Math.min(1 + STREAK_MAX, Math.max(1, ebbMult)) : 1,
      day: typeof src.ebb?.day === 'string' && DAY_RE.test(src.ebb.day) ? src.ebb.day : null,
    },
  };
}

/** A finished task today (keeps the streak alive). */
function recordWorkDay(stateIn, now) {
  const s = normalize(stateIn);
  return { ...s, days: [...new Set([...s.days, dayKey(now)])].sort().slice(-MAX_DAYS) };
}

/** Change the rest days from today on. Days already past keep the rest days they had. */
function setRestDays(stateIn, restDays, now) {
  const s = normalize(stateIn);
  const days = cleanRestDays(restDays);
  if (!days || days.length > 3) return s; // at most three days off a week, or a streak means nothing
  const today = dayKey(now);
  const kept = s.restLog.filter(e => e.from < today);
  const log = [kept[0], ...kept.slice(1).slice(-(MAX_REST_LOG - 2)), { from: today, days }];
  return { ...s, restLog: log, restDays: days };
}

const restDaysOn = (s, key) => s.restLog.reduce((hit, e) => (e.from <= key ? e.days : hit), s.restLog[0].days);

/**
 * The walk from the first worked day to today. Returns the run as it stands
 * and the best run, which days were tide-outs, and which working days broke it.
 *   perWeek: tide-outs allowed per ISO week (perksFor 'tide-out-plus' makes it 2)
 */
function walk(s, now, perWeek) {
  const worked = new Set(s.days);
  const saved = new Set(s.tideOuts);
  const today = dayKey(now);
  const used = new Map();       // week -> tide-outs used in it
  const tideOuts = new Set();   // tide-outs that held a run
  const missed = new Set();     // working days with no work that broke (or would have broken) a run
  let run = 0, longest = 0, runStart = null, runWeeks = new Map(), pending = [];
  const first = s.days.find(d => d <= today);
  if (!first) return { run: 0, longest: 0, tideOuts, missed, runStart: null, runWeeks, used };
  for (let key = first; key <= today; key = shift(key, 1)) {
    const wk = weekOf(key);
    if (worked.has(key)) {
      if (!run) { runStart = key; runWeeks = new Map(); }
      run++;
      runWeeks.set(wk, (runWeeks.get(wk) || 0) + 1);
      for (const p of pending) tideOuts.add(p);
      pending = [];
      longest = Math.max(longest, run);
      continue;
    }
    if (key === today) break; // today isn't over: it can't break anything yet
    if (restDaysOn(s, key).includes(weekdayOf(key))) continue;
    if (!run) { missed.add(key); continue; }
    const n = used.get(wk) || 0;
    if (saved.has(key) || n < perWeek) {
      used.set(wk, n + 1);
      pending.push(key);
      continue;
    }
    // The run breaks here. Tide-outs it took since its last worked day held nothing: give them back.
    for (const p of pending) used.set(weekOf(p), used.get(weekOf(p)) - 1);
    for (const p of pending) missed.add(p);
    missed.add(key);
    pending = [];
    run = 0;
    runStart = null;
  }
  // Tide-outs taken since the last worked day hold the run as it stands (yesterday off, today not yet).
  for (const p of pending) tideOuts.add(p);
  return { run, longest, tideOuts, missed, runStart, runWeeks, used };
}

/** Weeks in the run with at least FULL_WEEK_DAYS worked days -> the streak's own bonus. */
const multFromWeeks = runWeeks => 1 + Math.min(STREAK_MAX, STREAK_STEP * [...runWeeks.values()].filter(n => n >= FULL_WEEK_DAYS).length);

/**
 * The bonus to pay now: the streak's own, or what was paid last less 5% per
 * working day missed since, whichever is more. Never below 1.
 */
function ebbMultiplier(stateIn, now, { perWeek = TIDE_OUTS_PER_WEEK } = {}) {
  const s = normalize(stateIn);
  const w = walk(s, now, perWeek);
  const own = w.run ? multFromWeeks(w.runWeeks) : 1;
  if (!s.ebb.day || s.ebb.mult <= 1) return own;
  const today = dayKey(now);
  let misses = 0;
  for (let key = shift(s.ebb.day, 1); key < today; key = shift(key, 1)) {
    if (w.missed.has(key)) misses++;
    else if (!s.days.length || key < s.days[0]) {
      // Before any worked day the walk saw nothing: a working day there is a miss too.
      if (!restDaysOn(s, key).includes(weekdayOf(key))) misses++;
    }
  }
  return Math.max(own, Math.round((s.ebb.mult - EBB_STEP * misses) * 100) / 100, 1);
}

/** Remember the bonus as paid today, so a break ebbs from it (wiring/progress.js, on each award). */
function noteEbb(stateIn, mult, now) {
  const s = normalize(stateIn);
  const m = Math.min(1 + STREAK_MAX, Math.max(1, Number(mult) || 1));
  const day = dayKey(now);
  if (s.ebb.day === day && s.ebb.mult === m) return s;
  return { ...s, ebb: { mult: m, day } };
}

/**
 * { current, longest, today, tideOutsLeftThisWeek, tideOutDays, restToday, restDays, weeks, mult }.
 * current counts worked days only; rest days and tide-outs hold it.
 */
function streakOf(stateIn, now, { perWeek = TIDE_OUTS_PER_WEEK } = {}) {
  const s = normalize(stateIn);
  const today = dayKey(now);
  const w = walk(s, now, perWeek);
  const usedNow = w.used.get(weekOf(today)) || 0;
  return {
    current: w.run,
    longest: w.longest,
    today: s.days.includes(today),
    tideOutsLeftThisWeek: Math.max(0, perWeek - usedNow),
    tideOutDays: [...w.tideOuts].filter(d => d >= shift(today, -13)).sort(), // the last two weeks', for 🌊 on the chip
    restToday: restDaysOn(s, today).includes(weekdayOf(today)),
    restDays: s.restDays,
    weeks: w.run ? [...w.runWeeks.values()].filter(n => n >= FULL_WEEK_DAYS).length : 0,
    mult: ebbMultiplier(s, now, { perWeek }),
  };
}

/**
 * Write down the tide-outs the walk has used, so the panel can show 🌊 on them
 * and a later change can't take them back. Idempotent; the wiring calls it daily.
 * -> { state, added: ['YYYY-MM-DD'] }
 */
function settleTideOuts(stateIn, now, { perWeek = TIDE_OUTS_PER_WEEK } = {}) {
  const s = normalize(stateIn);
  const w = walk(s, now, perWeek);
  const added = [...w.tideOuts].filter(d => !s.tideOuts.includes(d)).sort();
  if (!added.length) return { state: s, added };
  return { state: { ...s, tideOuts: [...s.tideOuts, ...added].sort().slice(-MAX_DAYS) }, added };
}

/**
 * You worked in a project (a git repo root). key: its absolute path (case-folded
 * by the caller on Windows), name: its folder name.
 */
function recordProject(stateIn, key, name, now) {
  const s = normalize(stateIn);
  if (!key) return s;
  const prev = s.projects[key] || { name, lastSeen: 0, lastCommitAt: null, lastNudgeAt: null, muted: false };
  let projects = { ...s.projects, [key]: { ...prev, name: clip(name, 60) || prev.name, lastSeen: now } };
  // Keep the list small: drop long-untouched projects, then the oldest.
  projects = Object.fromEntries(Object.entries(projects)
    .filter(([, p]) => now - p.lastSeen < FORGET_AFTER)
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .slice(0, MAX_PROJECTS));
  return { ...s, projects };
}

/** The repo's newest commit time (from `git log`). */
function recordCommit(stateIn, key, at) {
  const s = normalize(stateIn);
  const p = s.projects[key];
  if (!p || !Number.isFinite(at)) return s;
  return { ...s, projects: { ...s.projects, [key]: { ...p, lastCommitAt: Math.max(at, p.lastCommitAt || 0) } } };
}

function setMuted(stateIn, key, muted) {
  const s = normalize(stateIn);
  if (!s.projects[key]) return s;
  return { ...s, projects: { ...s.projects, [key]: { ...s.projects[key], muted: !!muted } } };
}

/** Whole days since a time (floor). */
const daysSince = (t, now) => Math.floor((now - t) / DAY);

/**
 * The project worth a nudge right now, or null. At most one per project per
 * ~day, only 9:00–21:00, only for projects touched in the last month whose last
 * commit is at least `afterDays` old. The quietest project goes first.
 */
function dueNudge(stateIn, now, hour = new Date(now).getHours()) {
  const s = normalize(stateIn);
  if (!s.nudges) return null;
  if (hour < NUDGE_HOURS[0] || hour >= NUDGE_HOURS[1]) return null;
  const candidates = Object.entries(s.projects).filter(([, p]) =>
    !p.muted && p.lastCommitAt
    && now - p.lastSeen < ACTIVE_WITHIN
    && daysSince(p.lastCommitAt, now) >= s.afterDays
    && (!p.lastNudgeAt || now - p.lastNudgeAt >= NUDGE_EVERY));
  if (!candidates.length) return null;
  const [key, p] = candidates.sort((a, b) => a[1].lastCommitAt - b[1].lastCommitAt)[0];
  return { key, name: p.name, days: daysSince(p.lastCommitAt, now) };
}

function markNudged(stateIn, key, now) {
  const s = normalize(stateIn);
  if (!s.projects[key]) return s;
  return { ...s, projects: { ...s.projects, [key]: { ...s.projects[key], lastNudgeAt: now } } };
}

const nudgeText = n => `You haven't committed to ${n.name} in ${n.days} day${n.days === 1 ? '' : 's'} 🐚`;

module.exports = {
  normalize, recordWorkDay, recordProject, recordCommit, setMuted, streakOf, dueNudge, markNudged, nudgeText, daysSince,
  setRestDays, settleTideOuts, ebbMultiplier, noteEbb, weekOf,
  DEFAULTS, TIDE_OUTS_PER_WEEK,
};
