// Bug history: each species' record in each project, so a bug that comes back
// is a rematch with a memory ("It's back! Last time: no test."), and a fix that
// stays fixed for HELD_DAYS is noticed and paid (the 'held' award).
//
// State, kept in config bugNests.history (local, not synced):
//   { [project + '|' + species]: { n, catches: [{ at, q, held, sealed }], lastSeenAt, lastCaughtAt } }
// n counts sightings; q is the fix report's letters (quality.js lettersOf).
//
// Pure: no clock (callers pass `now`), never mutates what it's given.
// See test/bugdex-history.test.js.

const DAY = 24 * 60 * 60 * 1000;
const HELD_DAYS = 14;
const MAX_KEYS = 200;
const MAX_CATCHES = 10;
const KEY_MAX = 200;
const Q_RE = /^[pfrw]{0,4}$/;

const keyOf = (project, species) => `${String(project || '')}|${String(species || '')}`.slice(0, KEY_MAX);
const splitKey = key => {
  const i = String(key).lastIndexOf('|');
  return i < 0 ? { project: '', species: String(key) } : { project: key.slice(0, i), species: key.slice(i + 1) };
};

const fin = v => (Number.isFinite(v) ? v : null);

function cleanCatch(c) {
  if (!c || !Number.isFinite(c.at)) return null;
  return { at: c.at, q: typeof c.q === 'string' && Q_RE.test(c.q) ? c.q : '', held: c.held === true, sealed: c.sealed === true };
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const catches = (Array.isArray(e.catches) ? e.catches : []).map(cleanCatch).filter(Boolean).slice(-MAX_CATCHES);
  return {
    n: Number.isInteger(e.n) && e.n >= 0 ? e.n : 0,
    catches,
    lastSeenAt: fin(e.lastSeenAt),
    lastCaughtAt: fin(e.lastCaughtAt),
  };
}

/** Whatever came out of config, made safe: bad entries dropped, the oldest past MAX_KEYS let go. */
function normalizeHistory(h) {
  const src = h && typeof h === 'object' && !Array.isArray(h) ? h : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof k !== 'string' || !k.includes('|') || k.length > KEY_MAX) continue;
    const e = cleanEntry(v);
    if (e) out[k] = e;
  }
  return trim(out);
}

const lastTouch = e => Math.max(e.lastSeenAt || 0, e.lastCaughtAt || 0);

function trim(h) {
  const keys = Object.keys(h);
  if (keys.length <= MAX_KEYS) return h;
  const keep = new Set(keys.sort((a, b) => lastTouch(h[b]) - lastTouch(h[a])).slice(0, MAX_KEYS));
  return Object.fromEntries(Object.entries(h).filter(([k]) => keep.has(k)));
}

const entryOf = (h, key) => h[key] || { n: 0, catches: [], lastSeenAt: null, lastCaughtAt: null };

/** It surfaced (a new encounter, caught or not later). */
function recordSeen(h, key, now) {
  const e = entryOf(h, key);
  return trim({ ...h, [key]: { ...e, n: e.n + 1, lastSeenAt: now } });
}

/**
 * It was caught. report: quality.js fixReport (or null, for a catch with no diff).
 * opts.sealed: a rematch won with a proof.
 */
function recordCatch(h, key, report, now, { sealed = false } = {}) {
  const e = entryOf(h, key);
  const c = { at: now, q: typeof report?.q === 'string' && Q_RE.test(report.q) ? report.q : '', held: false, sealed: !!sealed };
  return trim({ ...h, [key]: { ...e, catches: [...e.catches, c].slice(-MAX_CATCHES), lastCaughtAt: now } });
}

/**
 * Is this a rematch? It is when it was caught here before.
 * -> { n (which rematch: 1 for the first time back), last: { at, q } } | null
 */
function rematchOf(h, key, _now) {
  const e = h[key];
  if (!e || !e.catches.length) return null;
  const last = e.catches[e.catches.length - 1];
  return { n: e.catches.length, last: { at: last.at, q: last.q } };
}

/**
 * Catches that have held: older than HELD_DAYS, the species not seen in that
 * project since, not yet marked.  -> [{ key, at, q }]
 */
function heldDue(h, now) {
  const due = [];
  for (const [key, e] of Object.entries(h)) {
    for (const c of e.catches) {
      if (c.held || now - c.at < HELD_DAYS * DAY) continue;
      if (e.lastSeenAt != null && e.lastSeenAt > c.at) continue; // it came back
      due.push({ key, at: c.at, q: c.q });
    }
  }
  return due;
}

/** Mark those catches held, so each pays once. due: heldDue's list. */
function markHeld(h, due) {
  const by = new Map();
  for (const d of due || []) {
    if (!by.has(d.key)) by.set(d.key, new Set());
    by.get(d.key).add(d.at);
  }
  const out = { ...h };
  for (const [key, ats] of by) {
    const e = out[key];
    if (!e) continue;
    out[key] = { ...e, catches: e.catches.map(c => (ats.has(c.at) ? { ...c, held: true } : c)) };
  }
  return out;
}

/** Past report letters, oldest first, for the rematch history list. */
const lettersFor = (h, key) => (h[key]?.catches || []).map(c => ({ at: c.at, q: c.q, held: c.held, sealed: c.sealed }));

/** The species fought most in a project, or anywhere: the nemesis (Wrapped, the nests screen). */
function nemesis(h, project = null) {
  /** @type {{ project: string, species: string, n: number, caught: number } | null} */
  let best = null;
  for (const [key, e] of Object.entries(h)) {
    const k = splitKey(key);
    if (project != null && k.project !== project) continue;
    if (!best || e.n > best.n) best = { ...k, n: e.n, caught: e.catches.length };
  }
  return best;
}

module.exports = {
  HELD_DAYS, MAX_KEYS, MAX_CATCHES, DAY,
  keyOf, splitKey, normalizeHistory, recordSeen, recordCatch, rematchOf, heldDue, markHeld, lettersFor, nemesis,
};
