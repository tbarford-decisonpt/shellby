// Bug nests: a species that keeps turning up in the same project has made a
// nest there. A nest is a to-do list, never a penalty: it forms when the same
// species surfaces FORM_COUNT times within FORM_DAYS, and clears once it has
// been caught and stayed away CLEAR_DAYS since it was last seen (SEALED_DAYS
// when the last catch was sealed: a rematch won with a new test). A cleared
// nest stays credited for good; if it forms again later, that's a new
// generation.
//
// State, kept in config bugNests.nests (local, not synced):
//   { [project + '|' + species]: {
//       project, species, name (the project's), seen: [at],                       // sightings within FORM_DAYS
//       nest: { since, count, lastSeenAt, lastCaughtAt, sealed, generation } | null,
//       cleared: [{ generation, since, clearedAt, count, sealed }] } }
//
// Pure: no clock (callers pass `now`), never mutates what it's given.
// See test/bugdex-nests.test.js.

const { keyOf, splitKey } = require('./history');

const DAY = 24 * 60 * 60 * 1000;
const FORM_COUNT = 3;
const FORM_DAYS = 30;
const CLEAR_DAYS = 14;
const SEALED_DAYS = 7;
const MAX_KEYS = 200;
const MAX_SEEN = 10;
const MAX_CLEARED = 20;

const fin = v => (Number.isFinite(v) ? v : null);
const str = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : '');

function cleanNest(n) {
  if (!n || typeof n !== 'object' || !Number.isFinite(n.since)) return null;
  return {
    since: n.since, count: Number.isInteger(n.count) && n.count > 0 ? n.count : 1,
    lastSeenAt: fin(n.lastSeenAt) ?? n.since, lastCaughtAt: fin(n.lastCaughtAt),
    sealed: n.sealed === true, generation: Number.isInteger(n.generation) && n.generation > 0 ? n.generation : 1,
  };
}

function cleanCleared(c) {
  if (!c || !Number.isFinite(c.clearedAt)) return null;
  return {
    generation: Number.isInteger(c.generation) && c.generation > 0 ? c.generation : 1,
    since: fin(c.since) ?? c.clearedAt, clearedAt: c.clearedAt,
    count: Number.isInteger(c.count) && c.count > 0 ? c.count : 1, sealed: c.sealed === true,
  };
}

/** Whatever came out of config, made safe. */
function normalizeNests(s) {
  const src = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object' || !k.includes('|')) continue;
    const { project, species } = splitKey(k);
    out[k] = {
      project: str(v.project) || project, species: str(v.species, 60) || species, name: str(v.name, 80),
      seen: (Array.isArray(v.seen) ? v.seen : []).filter(Number.isFinite).slice(-MAX_SEEN),
      nest: cleanNest(v.nest),
      cleared: (Array.isArray(v.cleared) ? v.cleared : []).map(cleanCleared).filter(Boolean).slice(-MAX_CLEARED),
    };
  }
  return trim(out);
}

const touched = r => Math.max(r.seen.at(-1) || 0, r.nest?.lastSeenAt || 0, r.cleared.at(-1)?.clearedAt || 0);

// Over MAX_KEYS, the quietest records go, but never one with an open nest or a clear to its name.
function trim(s) {
  const keys = Object.keys(s);
  if (keys.length <= MAX_KEYS) return s;
  const loose = keys.filter(k => !s[k].nest && !s[k].cleared.length).sort((a, b) => touched(s[a]) - touched(s[b]));
  const drop = new Set(loose.slice(0, keys.length - MAX_KEYS));
  return Object.fromEntries(Object.entries(s).filter(([k]) => !drop.has(k)));
}

const recordOf = (s, project, species) => s[keyOf(project, species)] || { project, species, name: '', seen: [], nest: null, cleared: [] };

/**
 * It surfaced again in this project.  enc: { project, species, name (the project's) }
 * -> { nests, key, formed (the new nest, the moment it forms) | null, nest (open now) | null }
 */
function observe(s, enc, now) {
  const key = keyOf(enc.project, enc.species);
  const r = recordOf(s, String(enc.project || ''), String(enc.species || ''));
  const seen = [...r.seen, now].filter(at => now - at < FORM_DAYS * DAY).slice(-MAX_SEEN);
  let nest = r.nest;
  /** @type {any} */
  let formed = null;
  if (nest) {
    // Back again: one more in the nest, and a sealed catch no longer holds.
    nest = { ...nest, count: nest.count + 1, lastSeenAt: now, sealed: false };
  } else if (seen.length >= FORM_COUNT) {
    nest = formed = { since: now, count: seen.length, lastSeenAt: now, lastCaughtAt: null, sealed: false, generation: r.cleared.length + 1 };
  }
  const name = str(enc.name, 80) || r.name || '';
  return { nests: trim({ ...s, [key]: { ...r, name, seen, nest } }), key, formed, nest };
}

/** It was caught. opts.sealed: a rematch won with a proof, which clears it sooner. */
function onCatch(s, key, _report, now, { sealed = false } = {}) {
  const r = s[key];
  if (!r?.nest) return s;
  return { ...s, [key]: { ...r, nest: { ...r.nest, lastCaughtAt: now, sealed: r.nest.sealed || !!sealed } } };
}

const clearAfter = nest => (nest.sealed ? SEALED_DAYS : CLEAR_DAYS) * DAY;

/** Ready to clear: caught since it was last seen, and away long enough. */
const ready = (nest, now) => nest.lastCaughtAt != null && nest.lastCaughtAt >= nest.lastSeenAt && now - nest.lastSeenAt >= clearAfter(nest);

/** Clear the nests that are ready.  -> { nests, cleared: [{ key, project, species, generation, count, sealed }] } */
function sweep(s, now) {
  const cleared = [];
  const out = { ...s };
  for (const [key, r] of Object.entries(s)) {
    if (!r.nest || !ready(r.nest, now)) continue;
    const done = { generation: r.nest.generation, since: r.nest.since, clearedAt: now, count: r.nest.count, sealed: r.nest.sealed };
    out[key] = { ...r, nest: null, seen: [], cleared: [...r.cleared, done].slice(-MAX_CLEARED) };
    cleared.push({ key, project: r.project, species: r.species, ...done });
  }
  return { nests: cleared.length ? out : s, cleared };
}

/** How far a nest is toward clearing, 0..1, and the days left (null until it's caught). */
function progressOf(nest, now) {
  if (nest.lastCaughtAt == null || nest.lastCaughtAt < nest.lastSeenAt) return { progress: 0, daysLeft: null };
  const total = clearAfter(nest);
  const gone = Math.max(0, now - nest.lastSeenAt);
  return { progress: Math.min(1, gone / total), daysLeft: Math.max(0, Math.ceil((total - gone) / DAY)) };
}

const totalCleared = s => Object.values(s).reduce((n, r) => n + r.cleared.length, 0);

/**
 * What the Nests section draws.
 *   names: { project(id) -> name, species(id) -> name } (either may be missing)
 */
function nestsView(s, names = {}, now) {
  const pn = (id, own = '') => (typeof names.project === 'function' ? names.project(id) : null) || own || '';
  const sn = id => (typeof names.species === 'function' ? names.species(id) : null) || id;
  const open = [];
  const cleared = [];
  for (const [key, r] of Object.entries(s)) {
    if (r.nest) {
      open.push({
        key, project: pn(r.project, r.name), species: r.species, name: sn(r.species), count: r.nest.count, since: r.nest.since,
        generation: r.nest.generation, sealed: r.nest.sealed, caught: r.nest.lastCaughtAt != null && r.nest.lastCaughtAt >= r.nest.lastSeenAt,
        clearDays: clearAfter(r.nest) / DAY, ...progressOf(r.nest, now),
      });
    }
    for (const c of r.cleared) cleared.push({ key, project: pn(r.project, r.name), species: r.species, name: sn(r.species), ...c });
  }
  open.sort((a, b) => b.progress - a.progress || b.count - a.count);
  cleared.sort((a, b) => b.clearedAt - a.clearedAt);
  return { open, cleared: cleared.slice(0, MAX_CLEARED), clearedTotal: totalCleared(s), rules: { formCount: FORM_COUNT, formDays: FORM_DAYS, clearDays: CLEAR_DAYS, sealedDays: SEALED_DAYS } };
}

/** For the reef (WP3): one project's open and cleared nests. */
function nestSignal(s, project) {
  let open = 0;
  let cleared = 0;
  for (const r of Object.values(s)) {
    if (r.project !== project) continue;
    if (r.nest) open += 1;
    cleared += r.cleared.length;
  }
  return { open, cleared };
}

module.exports = {
  FORM_COUNT, FORM_DAYS, CLEAR_DAYS, SEALED_DAYS, MAX_KEYS, DAY,
  normalizeNests, observe, onCatch, sweep, nestsView, nestSignal, totalCleared, progressOf,
};
