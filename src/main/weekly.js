// The week in review: what shipped, which tests turned green, the streak, the
// top project, new trophies and the XP, for the shareable weekly crab card
// (renderer week-card.js) that he hands you every Friday.
//
// Stickers keep running totals and XP keeps a short log, so neither can say
// what happened *this week*; this keeps a small per-day ledger of it. Days
// from before the ledger existed are filled in from what was already stored:
// XP per day (xp.daily), the XP log, and each sticker's last ship. Pure: no
// I/O, no clock (callers pass `now`). See test/weekly.test.js.
const KEEP_DAYS = 70;            // ten weeks: this one, last one, and room to spare
const MAX_PROJECTS_A_DAY = 20;
const WEEK = 7;

// What a day counts. Shipping kinds come from stickers (with the project);
// the rest from XP events.
const SHIP_KINDS = ['ship', 'deploy', 'release', 'merge'];
const KINDS = [...SHIP_KINDS, 'minted', 'fixed', 'tests', 'task', 'deps', 'focus', 'trick', 'flaky', 'flakefix'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const TROPHY_RE = /^[a-z0-9-]{1,40}$/;
const MAX_TROPHIES_A_DAY = 12;

const dayKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
// Calendar days, not 24-hour steps, so a DST change can't skip or repeat one.
const addDays = (t, n) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

function cleanDay(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  for (const k of KINDS) if (count(d[k])) out[k] = count(d[k]);
  const projects = {};
  for (const [id, name] of Object.entries(d.projects && typeof d.projects === 'object' ? d.projects : {}).slice(0, MAX_PROJECTS_A_DAY)) {
    if (ID_RE.test(id) && clip(name, 60)) projects[id] = clip(name, 60);
  }
  if (Object.keys(projects).length) out.projects = projects;
  // Tasks finished in each repo (by name), for the week's top project.
  const work = {};
  for (const [name, n] of Object.entries(d.work && typeof d.work === 'object' ? d.work : {}).slice(0, MAX_PROJECTS_A_DAY)) {
    if (clip(name, 60) === name && name && count(n)) work[name] = count(n);
  }
  if (Object.keys(work).length) out.work = work;
  // Trophies earned that day: the wardrobe only remembers *that* one was earned, not when.
  const trophies = {};
  for (const [id, t] of Object.entries(d.trophies && typeof d.trophies === 'object' ? d.trophies : {}).slice(0, MAX_TROPHIES_A_DAY)) {
    if (TROPHY_RE.test(id) && clip(t?.name, 40)) trophies[id] = { name: clip(t.name, 40), icon: clip(t.icon, 8) || '🏆' };
  }
  if (Object.keys(trophies).length) out.trophies = trophies;
  return Object.keys(out).length ? out : null;
}

/** Tolerate anything read from disk. { days: { 'YYYY-MM-DD': {...} }, since, wrapped } */
function normalizeWeekly(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const days = {};
  const keys = Object.keys(src.days && typeof src.days === 'object' ? src.days : {}).filter(k => DAY_RE.test(k)).sort().slice(-KEEP_DAYS);
  for (const k of keys) {
    const d = cleanDay(src.days[k]);
    if (d) days[k] = d;
  }
  return {
    days,
    // The first day the ledger was keeping count: earlier days are filled in from elsewhere.
    since: typeof src.since === 'string' && DAY_RE.test(src.since) ? src.since : null,
    // The last week whose wrap-up he announced ('YYYY-MM-DD' of its last day).
    wrapped: typeof src.wrapped === 'string' && DAY_RE.test(src.wrapped) ? src.wrapped : null,
  };
}

/**
 * Count one thing that happened. kind: one of KINDS; project: { id, name } for
 * shipping kinds (so the card can say which projects shipped).
 */
function recordDay(stateIn, now, kind, project = null) {
  if (!KINDS.includes(kind)) return normalizeWeekly(stateIn);
  return updateDay(stateIn, now, d => {
    const out = { ...d, [kind]: (d[kind] || 0) + 1 };
    if (project && ID_RE.test(project.id || '') && (SHIP_KINDS.includes(kind) || kind === 'minted')) {
      out.projects = { ...(d.projects || {}), [project.id]: clip(project.name, 60) || 'project' };
    }
    return out;
  });
}

// Change one day's entry. `since` is the earliest day counted, whatever order days arrive in.
function updateDay(stateIn, now, change) {
  const s = normalizeWeekly(stateIn);
  if (!Number.isFinite(now)) return s;
  const key = dayKey(now);
  const d = change({ ...(s.days[key] || {}) });
  return normalizeWeekly({ ...s, since: !s.since || key < s.since ? key : s.since, days: { ...s.days, [key]: d } });
}

/** A task finished in a repo (its folder's name), for the week's top project. */
function recordWork(stateIn, now, name) {
  const n = clip(name, 60);
  if (!n) return normalizeWeekly(stateIn);
  return updateDay(stateIn, now, d => ({ ...d, work: { ...(d.work || {}), [n]: (d.work?.[n] || 0) + 1 } }));
}

/** A trophy earned: { id, name, icon } from the achievement. */
function recordTrophy(stateIn, now, trophy) {
  if (!TROPHY_RE.test(trophy?.id || '') || !clip(trophy.name, 40)) return normalizeWeekly(stateIn);
  return updateDay(stateIn, now, d => ({ ...d, trophies: { ...(d.trophies || {}), [trophy.id]: { name: trophy.name, icon: trophy.icon } } }));
}

/** Mark a week's wrap-up as announced. */
const markWrapped = (stateIn, day) => ({ ...normalizeWeekly(stateIn), wrapped: DAY_RE.test(day) ? day : null });

// XP-log kinds the ledger also counts, for days from before it existed.
const LOG_KINDS = { fixed: 'fixed', tests: 'tests', task: 'task', deps: 'deps', focus: 'focus', trick: 'trick' };

/**
 * Tally a window of days [from, to) (ms, local midnights). Days the ledger
 * kept are read from it; earlier ones from the XP log and the stickers.
 *   xp: normalized XP state (xp.js); stickers: normalized sticker state (stickers.js)
 */
function tally(s, from, to, { xp, stickers } = {}) {
  const totals = Object.fromEntries(KINDS.map(k => [k, 0]));
  const projects = new Map(); // id -> { id, name, days }
  const work = new Map();     // repo name -> tasks finished there
  const trophies = new Map(); // id -> { id, name, icon }, in the order earned
  const since = s.since ? new Date(`${s.since}T00:00:00`).getTime() : Infinity;
  const kept = t => t >= since;
  for (let t = from; t < to; t = addDays(t, 1)) {
    const d = s.days[dayKey(t)];
    if (!d) continue;
    for (const k of KINDS) totals[k] += d[k] || 0;
    for (const [id, name] of Object.entries(d.projects || {})) {
      const p = projects.get(id) || { id, name, days: 0 };
      projects.set(id, { ...p, name, days: p.days + 1 });
    }
    for (const [name, n] of Object.entries(d.work || {})) work.set(name, (work.get(name) || 0) + n);
    for (const [id, tr] of Object.entries(d.trophies || {})) if (!trophies.has(id)) trophies.set(id, { id, ...tr });
  }
  // Before the ledger: the XP log's events, and stickers that shipped in the window.
  for (const e of xp?.log || []) {
    if (e.at < from || e.at >= to || kept(e.at) || !LOG_KINDS[e.kind]) continue;
    totals[LOG_KINDS[e.kind]] += 1;
  }
  for (const p of Object.values(stickers?.projects || {})) {
    if (p.from) continue; // a friend's gift isn't your shipping
    const shippedIn = p.lastShipAt >= from && p.lastShipAt < to && !kept(p.lastShipAt);
    if (shippedIn && !projects.has(p.id)) {
      projects.set(p.id, { id: p.id, name: p.name, days: 1 });
      totals.ship += 1; // at least once; how often isn't known from before the ledger
    }
    if (p.firstShipAt >= from && p.firstShipAt < to && !kept(p.firstShipAt)) totals.minted += 1;
  }
  return { totals, projects: [...projects.values()], work, trophies: [...trophies.values()] };
}

// The repo with the most tasks finished; failing that, the busiest one shipped.
function topProjectOf(work, shipped) {
  const [name, tasks] = [...work].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || [];
  if (name) return { name, tasks };
  return shipped[0] ? { name: shipped[0].name, tasks: 0 } : null;
}

/**
 * The last seven days (today included) and the seven before, for the card.
 *   streak: { current, longest } (streaks.js); level: levelFor() (xp.js)
 */
function weekSummary(stateIn, now, { xp = null, stickers = null, streak = null, level = null } = {}) {
  const s = normalizeWeekly(stateIn);
  const today = startOfDay(now);
  const from = addDays(today, -(WEEK - 1)), to = addDays(today, 1);
  const prevFrom = addDays(from, -WEEK);
  const cur = tally(s, from, to, { xp, stickers });
  const prev = tally(s, prevFrom, from, { xp, stickers });
  const daily = xp?.daily || {};
  const days = [];
  for (let t = from; t < to; t = addDays(t, 1)) {
    const key = dayKey(t);
    const d = s.days[key] || {};
    days.push({ day: key, xp: count(daily[key]), shipped: SHIP_KINDS.reduce((n, k) => n + (d[k] || 0), 0) });
  }
  const sumXp = (a, b) => { let n = 0; for (let t = a; t < b; t = addDays(t, 1)) n += count(daily[dayKey(t)]); return n; };
  const ships = c => SHIP_KINDS.reduce((n, k) => n + c.totals[k], 0);

  // Projects, busiest first, with their sticker's tier when there is one.
  const byId = stickers?.projects || {};
  const shipped = cur.projects
    .map(p => ({ ...p, isNew: !!byId[p.id] && byId[p.id].firstShipAt >= from, ships: byId[p.id]?.ships || 0 }))
    .sort((a, b) => b.days - a.days || b.ships - a.ships || a.name.localeCompare(b.name));

  const t = cur.totals;
  const summary = {
    from, to: to - 1, fromDay: dayKey(from), toDay: dayKey(today),
    xp: sumXp(from, to), xpPrev: sumXp(prevFrom, from),
    activeDays: days.filter(d => d.xp > 0 || d.shipped > 0).length,
    days,
    shipped,
    topProject: topProjectOf(cur.work, shipped),
    trophies: cur.trophies,
    counts: {
      projects: shipped.length, ships: ships(cur), deploys: t.deploy, releases: t.release, merges: t.merge,
      newStickers: t.minted, green: t.fixed, tests: t.tests + t.fixed, tasks: t.task,
      checkups: t.deps, focus: t.focus, tricks: t.trick, flaky: t.flaky, flakeFixes: t.flakefix,
      trophies: cur.trophies.length,
    },
    prev: { projects: prev.projects.length, ships: ships(prev), green: prev.totals.fixed, tasks: prev.totals.task },
    streak: { current: count(streak?.current), longest: count(streak?.longest) },
    level: level ? { level: level.level, title: level.title, color: level.rank?.color || null } : null,
  };
  return { ...summary, headline: headline(summary), quiet: isQuiet(summary) };
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Nothing to show off: no shipping, no green tests, no tasks, no trophies, no XP. */
function isQuiet(w) {
  return !hasNews(w) && !w.xp;
}

// Worth a weekly recap: something done, not just XP for showing up.
const hasNews = w => !!(w.counts.projects || w.counts.green || w.counts.tasks || w.counts.trophies);

/** The card's big line: the most impressive true thing about the week. */
function headline(w) {
  const c = w.counts;
  if (c.projects >= 2) return `Shipped ${plural(c.projects, 'project')}`;
  if (c.projects === 1) return `Shipped ${w.shipped[0].name}`;
  if (c.green) return `Turned ${plural(c.green, 'test suite')} green`;
  if (c.tasks) return `${plural(c.tasks, 'task')} done`;
  if (c.trophies) return `Earned ${plural(c.trophies, 'trophy', 'trophies')}`;
  if (w.xp) return `${w.xp.toLocaleString('en-US')} XP earned`;
  return 'A quiet week in the tide pool';
}

/**
 * Should he announce the week's wrap-up now? Once a week, Friday from 16:00
 * (or any later day of that week if the PC was off), and only for a week with
 * something done in it: a ship, green tests, a task or a trophy. Returns the
 * day key to store with markWrapped, or null.
 */
function wrapUpDue(stateIn, now, summary) {
  const s = normalizeWeekly(stateIn);
  const d = new Date(now);
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  const friday = dow === 5 ? d.getHours() >= 16 : dow === 6 || dow === 0;
  if (!friday || !summary?.counts || !hasNews(summary)) return null;
  // The week's key: its Friday, so Saturday and Sunday don't announce it again.
  const key = dayKey(addDays(startOfDay(now), dow === 5 ? 0 : dow === 6 ? -1 : -2));
  return s.wrapped === key ? null : key;
}

module.exports = { KINDS, SHIP_KINDS, KEEP_DAYS, normalizeWeekly, recordDay, recordWork, recordTrophy, markWrapped, weekSummary, headline, wrapUpDue, dayKey };
