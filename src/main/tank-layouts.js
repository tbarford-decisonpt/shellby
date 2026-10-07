// Saved layouts for his tank (docs/plans/tank-decor.md §7): up to three named
// ones ("Everyday", "Spooky", "Reef"), each a whole tank: its size, floor,
// back glass, light and pieces. Put one up and it goes through tank.sanitize
// like any edit, so a layout can never give him what he hasn't got.
//
// A layout tagged to a season goes up by itself when that season starts and
// comes down when it ends, putting back the tank he had before. What was up
// before (`seasonal`) belongs to this PC; the list syncs through the private
// gist (github/sync.js), newest change winning, and never goes on a card.
//
// Kept as config `tankLayouts`, apart from `tank`, so the calling card
// (tank-share.js) can't reach it. Pure: no I/O, no clock (callers pass `now`).
// See test/tank-layouts.test.js.

const tank = require('./tank');
const { SEASONS } = require('./wardrobe/seasons');

const MAX = 3;
const NAME_MAX = 24;
const ID_RE = /^[a-z0-9]{1,12}$/;
const SEASON_IDS = new Set(SEASONS.map(s => s.id));

// Control characters, zero-width ones and direction overrides: never in a name you'll see.
const INVISIBLE = [[0x0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]];
const visible = ch => { const c = ch.codePointAt(0); return !INVISIBLE.some(([a, b]) => c >= a && c <= b); };

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const pos = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A name you typed, made safe to show: no control characters, squeezed spaces, at most NAME_MAX. Empty if nothing's left. */
function cleanName(v) {
  if (typeof v !== 'string') return '';
  return [...v.replace(/\s+/g, ' ')].filter(visible).join('').trim().slice(0, NAME_MAX).trim();
}

const seasonOf = v => (typeof v === 'string' && SEASON_IDS.has(v) ? v : null);

/** Just the tank's look: what a layout holds, cleaned by tank.normalize. */
function shapeOf(raw) {
  const t = tank.normalize(raw);
  return { size: t.size, style: t.style, placed: t.placed };
}

function normalizeOne(raw) {
  if (!isObj(raw)) return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  return { id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '', name, season: seasonOf(raw.season), ...shapeOf(raw), savedAt: pos(raw.savedAt) };
}

// Ids and names are each one of a kind: a repeated id gets a fresh one, a repeated name is dropped.
function unique(list) {
  const ids = new Set(), names = new Set();
  let n = 0;
  const out = [];
  for (const l of list) {
    const key = l.name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    let id = l.id;
    while (!id || ids.has(id)) id = `l${++n}`;
    ids.add(id);
    out.push({ ...l, id });
  }
  return out;
}

/** Stored layouts made safe (from disk, the gist or the panel). Never throws. */
function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  const list = unique((Array.isArray(r.list) ? r.list : []).slice(0, MAX * 2).map(normalizeOne).filter(Boolean)).slice(0, MAX);
  const s = isObj(r.seasonal) ? r.seasonal : null;
  const seasonal = s && list.some(l => l.id === s.id) && seasonOf(s.season)
    ? { id: s.id, season: s.season, before: shapeOf(s.before) } : null;
  return { list, seasonal, editedAt: pos(r.editedAt) };
}

const nextId = list => { let n = 1; while (list.some(l => l.id === `l${n}`)) n++; return `l${n}`; };

/**
 * Keep the tank as it is under a name. The same name (any case) is replaced;
 * a fourth is refused. Returns { ok, state, error }.
 */
function save(stateIn, { name, season = null, tank: tankState, now = 0 }) {
  const s = normalize(stateIn);
  const n = cleanName(name);
  if (!n) return { ok: false, state: s, error: 'Give it a name first.' };
  const same = s.list.find(l => l.name.toLowerCase() === n.toLowerCase());
  if (!same && s.list.length >= MAX) return { ok: false, state: s, error: `He keeps ${MAX} layouts. Remove one first.` };
  const entry = { id: same?.id || nextId(s.list), name: n, season: seasonOf(season) ?? same?.season ?? null, ...shapeOf(tankState), savedAt: pos(now) };
  const list = same ? s.list.map(l => (l.id === same.id ? entry : l)) : [...s.list, entry];
  return { ok: true, state: { ...s, list, editedAt: pos(now) }, error: null };
}

/** Forget one. If it's the season's, the tank from before stays as it is. */
function remove(stateIn, id, now = 0) {
  const s = normalize(stateIn);
  if (!s.list.some(l => l.id === id)) return s;
  return { list: s.list.filter(l => l.id !== id), seasonal: s.seasonal?.id === id ? null : s.seasonal, editedAt: pos(now) };
}

/** Tag one to a season (or none). One layout a season: tagging another takes it from the first. */
function tag(stateIn, id, season, now = 0) {
  const s = normalize(stateIn);
  if (!s.list.some(l => l.id === id)) return s;
  const want = seasonOf(season);
  const list = s.list.map(l => (l.id === id ? { ...l, season: want } : want && l.season === want ? { ...l, season: null } : l));
  return { ...s, list, editedAt: pos(now) };
}

/** The layout's tank, for tank.sanitize. */
const asTank = l => ({ size: l.size, style: { ...l.style }, placed: l.placed.map(p => ({ ...p })) });

/**
 * What the seasons say about the tank today. `active` is the ids of the
 * seasons running now, highest first (wardrobe/seasons.js activeSeasons).
 * Returns { put: tank to put up, or null, state: the layouts after }:
 *   a season with a tagged layout started: put it up, keeping the tank from before;
 *   the season it went up for ended: put the tank from before back.
 * The same season seen again does nothing, so you can redecorate in the middle of it.
 */
function seasonStep(stateIn, { tank: current, active = [] }) {
  const s = normalize(stateIn);
  const running = new Set(active.filter(seasonOf));
  if (s.seasonal) {
    if (running.has(s.seasonal.season)) return { put: null, state: s };
    return { put: s.seasonal.before, state: { ...s, seasonal: null } };
  }
  const pick = active.map(id => s.list.find(l => l.season === id)).find(Boolean);
  if (!pick) return { put: null, state: s };
  return { put: asTank(pick), state: { ...s, seasonal: { id: pick.id, season: pick.season, before: shapeOf(current) } } };
}

// ------------------------------------------------------------------ sync

/** What goes in the private sync gist: the list and when it changed. Not what the season put up on this PC. */
function syncable(raw) {
  const s = normalize(raw);
  return { list: s.list, editedAt: s.editedAt };
}

/** Two PCs' layouts: the one changed last wins, whole. */
function merge(aIn, bIn) {
  const a = syncable(aIn), b = syncable(bIn);
  return b.editedAt > a.editedAt ? b : a;
}

/** A merged list onto this PC's: newer replaces it, and this PC's season keeps what it put up. */
function applySync(localIn, merged) {
  const local = normalize(localIn);
  const m = syncable(merged);
  if (m.editedAt <= local.editedAt) return local;
  return normalize({ ...m, seasonal: local.seasonal });
}

/** For the panel: names, seasons and what's in each, no art. */
function view(stateIn) {
  const s = normalize(stateIn);
  return {
    max: MAX,
    list: s.list.map(l => ({ id: l.id, name: l.name, season: l.season, size: l.size, pieces: l.placed.length, savedAt: l.savedAt, up: s.seasonal?.id === l.id })),
    seasons: SEASONS.map(x => ({ id: x.id, name: x.name, emoji: x.emoji })),
  };
}

module.exports = { MAX, NAME_MAX, cleanName, normalize, save, remove, tag, asTank, seasonStep, syncable, merge, applySync, view };
