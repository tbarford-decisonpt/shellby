// Streaks and nudges. A streak is consecutive days with at least one finished
// Claude task (in Shellby or, via the plugin, anywhere). Projects are the git
// repos you work in; when one you've been working on goes quiet, Shellby
// nudges: "You haven't committed to 3d-rack in 5 days 🐚".
// Pure: no I/O, no clock (callers pass `now`). See test/streaks.test.js.

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 400;
const MAX_PROJECTS = 50;
const FORGET_AFTER = 60 * DAY;      // projects untouched this long are dropped
const ACTIVE_WITHIN = 30 * DAY;     // only nudge about projects you touched recently
const NUDGE_EVERY = 20 * 60 * 60 * 1000;
const NUDGE_HOURS = [9, 21];        // local hours when nudges may fire

const DEFAULTS = Object.freeze({ nudges: true, afterDays: 5 });

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const prevDay = key => { const [y, m, d] = key.split('-').map(Number); return dayKey(new Date(y, m - 1, d - 1).getTime()); };
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  return {
    days, projects,
    nudges: src.nudges === undefined ? DEFAULTS.nudges : !!src.nudges,
    afterDays: Number.isFinite(n) ? Math.min(30, Math.max(1, Math.round(n))) : DEFAULTS.afterDays,
  };
}

/** A finished task today (keeps the streak alive). */
function recordWorkDay(stateIn, now) {
  const s = normalize(stateIn);
  return { ...s, days: [...new Set([...s.days, dayKey(now)])].sort().slice(-MAX_DAYS) };
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

/** { current, longest, today } — a streak survives until the end of the day after the last work day. */
function streakOf(stateIn, now) {
  const { days } = normalize(stateIn);
  const set = new Set(days);
  const today = dayKey(now);
  let longest = 0, run = 0, prev = null;
  for (const d of days) { run = prev && prevDay(d) === prev ? run + 1 : 1; longest = Math.max(longest, run); prev = d; }
  let current = 0;
  let cursor = set.has(today) ? today : prevDay(today);
  while (set.has(cursor)) { current++; cursor = prevDay(cursor); }
  return { current, longest, today: set.has(today) };
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

module.exports = { normalize, recordWorkDay, recordProject, recordCommit, setMuted, streakOf, dueNudge, markNudged, nudgeText, daysSince, DEFAULTS };
