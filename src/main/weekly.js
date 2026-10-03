// The week in review: what shipped, which tests turned green, the streak and
// the XP, for the shareable "what we shipped" card (renderer week-card.js).
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
const KINDS = [...SHIP_KINDS, 'minted', 'fixed', 'tests', 'task', 'deps', 'focus', 'trick'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-f]{12}$/;

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
  const s = normalizeWeekly(stateIn);
  if (!KINDS.includes(kind) || !Number.isFinite(now)) return s;
  const key = dayKey(now);
  const d = { ...(s.days[key] || {}) };
  d[kind] = (d[kind] || 0) + 1;
  if (project && ID_RE.test(project.id || '') && (SHIP_KINDS.includes(kind) || kind === 'minted')) {
    d.projects = { ...(d.projects || {}), [project.id]: clip(project.name, 60) || 'project' };
  }
  // The earliest day it has counted, whatever order days arrive in.
  return normalizeWeekly({ ...s, since: !s.since || key < s.since ? key : s.since, days: { ...s.days, [key]: d } });
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
  return { totals, projects: [...projects.values()] };
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
    counts: {
      projects: shipped.length, ships: ships(cur), deploys: t.deploy, releases: t.release, merges: t.merge,
      newStickers: t.minted, green: t.fixed, tests: t.tests + t.fixed, tasks: t.task,
      checkups: t.deps, focus: t.focus, tricks: t.trick,
    },
    prev: { projects: prev.projects.length, ships: ships(prev), green: prev.totals.fixed, tasks: prev.totals.task },
    streak: { current: count(streak?.current), longest: count(streak?.longest) },
    level: level ? { level: level.level, title: level.title, color: level.rank?.color || null } : null,
  };
  return { ...summary, headline: headline(summary), quiet: isQuiet(summary) };
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Nothing to show off: no shipping, no green tests, no tasks, no XP. */
function isQuiet(w) {
  return !w.counts.projects && !w.counts.green && !w.counts.tasks && !w.xp;
}

/** The card's big line: the most impressive true thing about the week. */
function headline(w) {
  const c = w.counts;
  if (c.projects >= 2) return `Shipped ${plural(c.projects, 'project')}`;
  if (c.projects === 1) return `Shipped ${w.shipped[0].name}`;
  if (c.green) return `Turned ${plural(c.green, 'test suite')} green`;
  if (c.tasks) return `${plural(c.tasks, 'task')} done`;
  if (w.xp) return `${w.xp.toLocaleString('en-US')} XP earned`;
  return 'A quiet week in the tide pool';
}

/**
 * Should he announce the week's wrap-up now? Once a week, Friday from 16:00
 * (or any later day of that week if the PC was off), and only for a week with
 * something in it. Returns the day key to store with markWrapped, or null.
 */
function wrapUpDue(stateIn, now, summary) {
  const s = normalizeWeekly(stateIn);
  const d = new Date(now);
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  const friday = dow === 5 ? d.getHours() >= 16 : dow === 6 || dow === 0;
  if (!friday || !summary || summary.quiet || !summary.counts.projects) return null;
  // The week's key: its Friday, so Saturday and Sunday don't announce it again.
  const key = dayKey(addDays(startOfDay(now), dow === 5 ? 0 : dow === 6 ? -1 : -2));
  return s.wrapped === key ? null : key;
}

module.exports = { KINDS, SHIP_KINDS, KEEP_DAYS, normalizeWeekly, recordDay, markWrapped, weekSummary, headline, wrapUpDue, dayKey };
