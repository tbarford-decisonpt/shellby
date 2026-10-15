// Daily bounties: three small goals a day ("Push to 2 projects", "Get a test
// suite green"), picked from the date alone so every PC shows the same three.
// Clear one for its XP; clear all three for a bonus. Pure: no I/O, no clock
// (callers pass the day key). See test/bounties.test.js.

const BOUNTIES = Object.freeze([
  { id: 'tasks10', kinds: ['task'], goal: 10, xp: 40, text: 'Finish 10 tasks' },
  { id: 'tasks25', kinds: ['task'], goal: 25, xp: 60, text: 'Finish 25 tasks' },
  { id: 'tests3', kinds: ['tests', 'fixed'], goal: 3, xp: 40, text: 'Pass tests 3 times' },
  { id: 'green1', kinds: ['fixed'], goal: 1, xp: 75, text: 'Turn failing tests green' },
  { id: 'ship3', kinds: ['ship'], goal: 3, xp: 45, text: 'Push code 3 times' },
  { id: 'push2', kinds: ['ship'], goal: 2, xp: 50, text: 'Push to 2 different projects', distinct: true },
  { id: 'deploy1', kinds: ['deploy'], goal: 1, xp: 60, text: 'Deploy or publish something' },
  { id: 'deps1', kinds: ['deps'], goal: 1, xp: 50, text: 'Pass a dependency audit' },
  { id: 'fresh1', kinds: ['fresh'], goal: 1, xp: 40, text: 'Start a crowded conversation fresh' },
  { id: 'focus1', kinds: ['focus'], goal: 1, xp: 40, text: 'Finish a focus session' },
  { id: 'focus2', kinds: ['focus'], goal: 2, xp: 60, text: 'Finish 2 focus sessions' },
  // Review mastery and fix reports (docs/GAMIFICATION-PLAN.md section 1.3): the daily loop into the new systems.
  { id: 'review1', kinds: ['caught', 'quiz'], goal: 1, xp: 50, text: 'Catch something in review, or pass a quiz' },
  { id: 'held1', kinds: ['held', 'cleanfix'], goal: 1, xp: 60, text: 'Land a clean fix, or have one hold' },
].map(b => Object.freeze({ ...b, kinds: Object.freeze([...b.kinds]) })));
const PER_DAY = 3;
const CLEAR_ALL_XP = 50;
const MAX_PROJECTS = 10;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const byId = new Map(BOUNTIES.map(b => [b.id, b]));

// FNV-1a: a small, stable hash so the pick depends only on the date.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

const MAX_PER_DAY = 4; // the fourth-bounty perk (progression/levels.js PERKS)
const orderFor = day => BOUNTIES.map(b => b.id).sort((x, y) => hash(`${day}|${x}`) - hash(`${day}|${y}`));

/**
 * The day's bounties (ids), never two that count the same kind of thing.
 *   count: 3, or 4 with the fourth-bounty perk (the first three are the same either way)
 *   rerolled: { from, to } a bounty swapped today (reroll)
 */
function pickFor(day, count = PER_DAY, rerolled = null) {
  const n = Math.max(1, Math.min(MAX_PER_DAY, Math.floor(Number(count) || PER_DAY)));
  const picked = [];
  const kindsTaken = new Set();
  for (const id of orderFor(day)) {
    const b = byId.get(id);
    if (b.kinds.some(k => kindsTaken.has(k))) continue;
    picked.push(id);
    b.kinds.forEach(k => kindsTaken.add(k));
    if (picked.length === n) break;
  }
  if (!rerolled || !picked.includes(rerolled.from) || picked.includes(rerolled.to) || !byId.has(rerolled.to)) return picked;
  return picked.map(id => (id === rerolled.from ? rerolled.to : id));
}

/**
 * The bounty-reroll perk: swap one of today's bounties (not one already done)
 * for the next that counts something else. Once a day. -> { state, ok, to }
 */
function reroll(raw, day, id, { count = PER_DAY } = {}) {
  const s = normalizeBounties(raw, day, { count });
  const ids = pickFor(day, count, s.rerolled);
  if (!s.day || s.rerolled || !ids.includes(id) || s.done.includes(id)) return { state: s, ok: false, to: null };
  const taken = new Set(ids.filter(x => x !== id).flatMap(x => byId.get(x).kinds));
  const to = orderFor(day).find(x => !ids.includes(x) && !byId.get(x).kinds.some(k => taken.has(k)));
  if (!to) return { state: s, ok: false, to: null };
  return { state: normalizeBounties({ ...s, rerolled: { from: id, to } }, day, { count }), ok: true, to };
}

/** Tolerate anything read from disk; a different day starts fresh. */
function normalizeBounties(raw, day, { count = PER_DAY } = {}) {
  if (!DAY_RE.test(day)) return { day: null, progress: {}, done: [], cleared: false, rerolled: null };
  const r = raw && typeof raw === 'object' && raw.day === day ? raw : {};
  const rr = r.rerolled && byId.has(r.rerolled.from) && byId.has(r.rerolled.to) ? { from: r.rerolled.from, to: r.rerolled.to } : null;
  const ids = pickFor(day, count, rr);
  const progress = {};
  for (const id of ids) {
    const v = r.progress?.[id];
    if (byId.get(id).distinct) progress[id] = [...new Set((Array.isArray(v) ? v : []).filter(p => typeof p === 'string' && p.length <= 80))].slice(0, MAX_PROJECTS);
    else progress[id] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  const done = [...new Set((Array.isArray(r.done) ? r.done : []).filter(id => ids.includes(id)))];
  return { day, progress, done, cleared: r.cleared === true && done.length === ids.length, rerolled: rr };
}

const countOf = (b, v) => (b.distinct ? (v || []).length : v || 0);

/**
 * Count one event toward the day's bounties. Returns { state, completed, cleared, xp }
 * where completed are the bounties this event finished and xp is what they pay.
 */
function progressBounties(raw, day, kind, project, { count = PER_DAY } = {}) {
  const s = normalizeBounties(raw, day, { count });
  const none = { state: s, completed: [], cleared: false, xp: 0 };
  if (!s.day) return none;
  const ids = pickFor(day, count, s.rerolled);
  const progress = { ...s.progress };
  const completed = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b.kinds.includes(kind) || s.done.includes(id)) continue;
    if (b.distinct) {
      if (!project || progress[id].includes(project)) continue;
      progress[id] = [...progress[id], project].slice(0, MAX_PROJECTS);
    } else {
      progress[id] = progress[id] + 1;
    }
    if (countOf(b, progress[id]) >= b.goal) completed.push(b);
  }
  const done = [...s.done, ...completed.map(b => b.id)];
  const cleared = !s.cleared && done.length === ids.length;
  const xp = completed.reduce((n, b) => n + b.xp, 0) + (cleared ? CLEAR_ALL_XP : 0);
  return { state: { ...s, progress, done, cleared: s.cleared || cleared }, completed, cleared, xp };
}

/** For the panel: the day's bounties with progress. canReroll: the perk is his and today's swap is unused. */
function bountiesView(raw, day, { count = PER_DAY, canReroll = false } = {}) {
  const s = normalizeBounties(raw, day, { count });
  if (!s.day) return { list: [], cleared: false, bonus: CLEAR_ALL_XP };
  return {
    canReroll: !!canReroll && !s.rerolled,
    list: pickFor(day, count, s.rerolled).map(id => {
      const b = byId.get(id);
      return { id, text: b.text, xp: b.xp, goal: b.goal, count: Math.min(b.goal, countOf(b, s.progress[id])), done: s.done.includes(id) };
    }),
    cleared: s.cleared,
    bonus: CLEAR_ALL_XP,
  };
}

module.exports = { BOUNTIES, CLEAR_ALL_XP, PER_DAY, MAX_PER_DAY, pickFor, normalizeBounties, progressBounties, bountiesView, reroll };
