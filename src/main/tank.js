// His tank (Shellby's screen → Tank): a home you decorate. Castles, plants,
// rocks and treasures come from wardrobe packs (the `decor` kind in
// wardrobe/catalog.js), so they unlock, badge and sync like everything else in
// the Wardrobe; his finds (gifts.js) can go in too, as many as he's dug up.
// This only keeps where things stand.
//
// The floor has three rows: the back, the middle (where he walks) and the
// front, so he passes behind what's in front and in front of what's behind.
// Back-layer pieces stand against the back glass; floating ones hang in the
// water. Everything is in art pixels; src/renderer/panel/tank-paint.js paints.
//
// Not called `home`: that's the shell he wears (config.home, shells.js).
// Pure: no I/O, no clock (callers pass `now`). See test/tank.test.js.

const SIZES = Object.freeze([
  { id: 'nano', name: 'Nano tank', w: 96, h: 56, cap: 10, level: 1, shipped: 0 },
  { id: 'ten-gallon', name: '10 gallon', w: 128, h: 56, cap: 18, level: 5, shipped: 0 },
  { id: 'thirty-gallon', name: '30 gallon', w: 160, h: 64, cap: 28, level: 15, shipped: 0 },
  { id: 'reef', name: 'Reef tank', w: 200, h: 72, cap: 40, level: 30, shipped: 10 },
  { id: 'grand', name: 'Grand aquarium', w: 240, h: 80, cap: 56, level: 50, shipped: 0 },
].map(s => Object.freeze(s)));
const BY_SIZE = new Map(SIZES.map(s => [s.id, s]));

const ROWS = Object.freeze(['back', 'middle', 'front']);
const CRAB_ROW = 1;
const SAND = 12;                 // the substrate's depth at the bottom of the tank
const ROW_DEPTH = [9, 5, 1];     // each row's baseline, up from the bottom
const FLOAT_Y = [16, 24, 32];    // how far down from the top floating pieces hang, per row
const HARD_CAP = 64;             // pieces, whatever the size (a damaged file can't hold more)
const MAX_Z = 999;
const MAX_UID = 1e9;
const LIGHTS = Object.freeze(['clock', 'day', 'night']);
const STYLES = Object.freeze(['substrate', 'backdrop']);
const DEFAULT_STYLE = Object.freeze({ substrate: 'soft-sand', backdrop: 'plain-water' });
// The tray's order, and what each shelf of it is called.
const CATEGORIES = Object.freeze([
  ['structure', 'Structures'], ['plant', 'Plants'], ['rock', 'Rocks'], ['treasure', 'Treasures'],
  ['bubbler', 'Bubblers & lights'], ['find', 'His finds'], ['substrate', 'Floor'], ['backdrop', 'Back glass'],
]);
const CATEGORY_ORDER = new Map(CATEGORIES.map(([id], i) => [id, i]));

// A decor key (a built-in "castle-keep" or a pack's "my-pack/castle"), or "find:<id>".
const REF_RE = /^(?:find:[a-z0-9][a-z0-9-]{0,39}|(?:[a-z0-9][a-z0-9-]{1,39}\/)?[a-z0-9][a-z0-9-]{0,39})$/;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isRef = v => typeof v === 'string' && REF_RE.test(v);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const int = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);
// Whole numbers past the edge come back to it; anything else is the fallback.
const within = (v, min, max, fallback) => (Number.isInteger(v) ? clamp(v, min, max) : fallback);
const pos = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Which tank sizes he's grown into: a level, and for the reef some projects shipped too. */
const sizeUnlocked = (size, level = 1, shipped = 0) => !!size && level >= size.level && shipped >= size.shipped;
const sizeOf = id => BY_SIZE.get(id) || SIZES[0];

/** The baseline (bottom row of pixels) a piece stands on. */
function baseline(layer, row, h) {
  if (layer === 'float') return FLOAT_Y[row] ?? FLOAT_Y[0];
  if (layer === 'back') return h - SAND + 1;
  return h - (ROW_DEPTH[row] ?? ROW_DEPTH[CRAB_ROW]);
}

function geometry(size) {
  return {
    w: size.w, h: size.h, sandTop: size.h - SAND,
    rows: ROWS.map((_, i) => baseline('floor', i, size.h)),
    backY: baseline('back', 0, size.h),
    floatY: [...FLOAT_Y],
    crabY: baseline('floor', CRAB_ROW, size.h),
    crabRow: CRAB_ROW,
  };
}

function normalizePiece(p) {
  if (!isObj(p) || !isRef(p.ref)) return null;
  return {
    uid: int(p.uid, 1, MAX_UID, 0),
    ref: p.ref,
    x: within(p.x, 0, SIZES.at(-1).w, 0),
    row: int(p.row, 0, ROWS.length - 1, CRAB_ROW),
    z: within(p.z, 0, MAX_Z, 0),
    flip: p.flip === true,
  };
}

// Every piece gets its own uid: a missing or repeated one gets the next free number.
function withUids(placed) {
  const seen = new Set();
  let next = placed.reduce((m, p) => Math.max(m, p.uid), 0);
  return placed.map(p => {
    if (p.uid && !seen.has(p.uid)) { seen.add(p.uid); return p; }
    next = Math.min(MAX_UID, next + 1);
    seen.add(next);
    return { ...p, uid: next };
  });
}

/** A stored tank made safe: anything read from disk or sent by the panel. Never throws. */
function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  const s = isObj(r.style) ? r.style : {};
  const placed = (Array.isArray(r.placed) ? r.placed : []).slice(0, HARD_CAP).map(normalizePiece).filter(Boolean);
  return {
    size: BY_SIZE.has(r.size) ? r.size : SIZES[0].id,
    style: {
      substrate: isRef(s.substrate) ? s.substrate : null,
      backdrop: isRef(s.backdrop) ? s.backdrop : null,
      light: LIGHTS.includes(s.light) ? s.light : 'clock',
    },
    placed: withUids(placed),
    editedAt: pos(r.editedAt),
  };
}

const sizeOfPixels = pixels => ({ w: Math.max(1, ...pixels.map(r => r.length)), h: pixels.length });

/**
 * Everything that could go in the tank, by ref: the wardrobe's decor (from
 * Wardrobe#decorView, with `locked` and `isNew`) and the finds on his shelf
 * (gifts.js state and FINDS). A find can be placed as many times as he has it.
 */
function library({ decor = [], findState = null, finds = [] } = {}) {
  const lib = new Map();
  for (const d of decor) {
    if (!d || !isRef(d.key) || !d.category || !Array.isArray(d.pixels)) continue;
    lib.set(d.key, {
      ref: d.key, kind: 'decor', name: d.name, description: d.description || '', rarity: d.rarity || 'common',
      category: d.category, layer: d.layer || null,
      palette: d.palette, pixels: d.pixels, frames: d.frames || [], fps: d.fps || 0, spots: d.spots || [],
      ...sizeOfPixels(d.pixels), max: null, locked: d.locked || null, isNew: !!d.isNew,
      unlock: d.unlock ? { ...d.unlock } : { default: true },
    });
  }
  const items = findState?.items || {};
  const unseen = new Set(findState?.unseen || []);
  for (const f of finds) {
    const have = items[f.id]?.n || 0;
    if (!have) continue; // only what he's actually dug up
    lib.set(`find:${f.id}`, {
      ref: `find:${f.id}`, kind: 'find', name: f.name, description: f.blurb || '', rarity: f.rarity,
      category: 'find', layer: 'floor',
      palette: f.palette, pixels: f.pixels, frames: [], fps: 0, spots: [],
      ...sizeOfPixels(f.pixels), max: have, locked: null, isNew: unseen.has(f.id),
      unlock: null,
    });
  }
  return lib;
}

const placeable = e => !!e && !e.locked && !STYLES.includes(e.category);
const styleOk = (e, role) => !!e && !e.locked && e.category === role;

/**
 * Check a tank the panel wants to save against what he really has. Pieces
 * already in the tank whose decor is gone or locked again (a pack removed,
 * "unlock everything" switched off) are kept as they were, so nothing is lost;
 * anything new has to be unlocked, within what he owns and within the tank's room.
 * Returns { state, dropped: [{ ref, reason }] }.
 */
function sanitize(draft, { lib, level = 1, shipped = 0, previous = null, now = 0 }) {
  const prev = normalize(previous);
  const d = normalize(draft);
  const size = sizeUnlocked(sizeOf(d.size), level, shipped) && BY_SIZE.has(d.size) ? sizeOf(d.size)
    : sizeUnlocked(sizeOf(prev.size), level, shipped) ? sizeOf(prev.size) : SIZES[0];
  const dormant = new Map(prev.placed.map(p => [p.uid, p]));
  const used = new Map();
  const placed = [];
  const dropped = [];
  // Missing here but already in the tank: kept where it was, and its room with it, first.
  const isDormant = p => !placeable(lib.get(p.ref)) && dormant.get(p.uid)?.ref === p.ref && !STYLES.includes(lib.get(p.ref)?.category);
  for (const p of d.placed.filter(isDormant)) {
    const was = dormant.get(p.uid);
    placed.push({ ...was, x: Math.min(was.x, size.w - 1) });
  }
  for (const p of d.placed) {
    if (isDormant(p)) continue;
    const e = lib.get(p.ref);
    if (placed.length >= size.cap) { dropped.push({ ref: p.ref, reason: 'full' }); continue; }
    if (!placeable(e)) {
      dropped.push({ ref: p.ref, reason: e ? (e.locked ? 'locked' : 'not-a-piece') : 'unknown' });
      continue;
    }
    const n = (used.get(p.ref) || 0) + 1;
    if (e.max !== null && n > e.max) { dropped.push({ ref: p.ref, reason: 'not-enough' }); continue; }
    used.set(p.ref, n);
    placed.push({ ...p, x: clamp(p.x, 0, Math.max(0, size.w - e.w)), row: e.layer === 'back' ? 0 : p.row });
  }
  // A floor or back glass he has, or the one already there (kept even if its pack is gone).
  const keep = role => {
    const want = d.style[role];
    return want && styleOk(lib.get(want), role) ? want : want === prev.style[role] ? want : null;
  };
  const style = { substrate: keep('substrate'), backdrop: keep('backdrop'), light: d.style.light };
  return { state: { size: size.id, style, placed: withUids(placed), editedAt: pos(now) }, dropped };
}

// Back glass first, then the rows back to front, then what floats; by z within each.
const depthOf = p => (p.layer === 'back' ? 0 : p.layer === 'float' ? 5 : 1 + p.row);

/** A copy of a library entry fit to cross IPC (its art included). */
const art = e => ({
  ref: e.ref, kind: e.kind, name: e.name, description: e.description, rarity: e.rarity, category: e.category, layer: e.layer,
  palette: { ...e.palette }, pixels: [...e.pixels], frames: e.frames.map(f => [...f]), fps: e.fps,
  spots: e.spots.map(s => ({ kind: s.kind, at: [...s.at] })), w: e.w, h: e.h,
  unlock: e.unlock ? { ...e.unlock } : null,
});

/**
 * The tank as the panel draws it: the size, its pieces in paint order with
 * their art and where they stand, what's in the tank but can't be shown here,
 * and the tray of everything that could go in.
 */
function view({ state, lib, level = 1, shipped = 0 }) {
  const st = normalize(state);
  const size = sizeOf(st.size);
  const geo = geometry(size);
  const pieces = [];
  const missing = [];
  const counts = new Map();
  for (const p of st.placed) {
    counts.set(p.ref, (counts.get(p.ref) || 0) + 1);
    const e = lib.get(p.ref);
    if (!placeable(e)) { missing.push({ uid: p.uid, ref: p.ref, name: e?.name || null, reason: e ? 'locked' : 'gone' }); continue; }
    const row = e.layer === 'back' ? 0 : p.row;
    pieces.push({ ...art(e), uid: p.uid, row, x: clamp(p.x, 0, Math.max(0, size.w - e.w)), y: baseline(e.layer, row, size.h), z: p.z, flip: p.flip });
  }
  pieces.sort((a, b) => depthOf(a) - depthOf(b) || a.z - b.z || a.x - b.x || a.uid - b.uid);

  const pick = role => {
    const chosen = st.style[role] && lib.get(st.style[role]);
    const e = styleOk(chosen, role) ? chosen : lib.get(DEFAULT_STYLE[role]);
    return styleOk(e, role) ? art(e) : null;
  };
  const tray = [...lib.values()]
    .map(e => ({ ...art(e), max: e.max, placed: counts.get(e.ref) || 0, locked: e.locked, isNew: e.isNew }))
    .sort((a, b) => (CATEGORY_ORDER.get(a.category) ?? 99) - (CATEGORY_ORDER.get(b.category) ?? 99)
      || Number(!!a.locked) - Number(!!b.locked) || a.name.localeCompare(b.name));
  // Where the porthole on the Health view looks: by the biggest thing on the floor.
  const anchor = pieces.filter(p => p.layer !== 'float').sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return {
    size: { ...size },
    world: geo,
    style: { substrate: pick('substrate'), backdrop: pick('backdrop'), light: st.style.light, chosen: { ...st.style } },
    pieces,
    missing,
    // What's stored, for the editor's draft (it lays pieces out itself as you move them).
    layout: { size: st.size, style: { ...st.style }, placed: st.placed.map(p => ({ ...p })) },
    count: st.placed.length,
    capacity: size.cap,
    focusX: anchor ? anchor.x + Math.round(anchor.w / 2) : Math.round(size.w / 2),
    tray,
    sizes: SIZES.map(s => ({ ...s, unlocked: sizeUnlocked(s, level, shipped), current: s.id === size.id })),
    categories: CATEGORIES.map(([id, name]) => ({ id, name })),
    rows: [...ROWS],
    news: tray.filter(e => e.isNew && !e.locked && e.kind === 'decor').map(e => e.ref),
    editedAt: st.editedAt,
  };
}

module.exports = {
  SIZES, ROWS, CRAB_ROW, SAND, HARD_CAP, LIGHTS, STYLES, DEFAULT_STYLE, CATEGORIES, REF_RE,
  normalize, library, sanitize, view, sizeUnlocked, sizeOf, baseline, geometry,
};
