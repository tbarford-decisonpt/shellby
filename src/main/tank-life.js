// His life in the tank, the part main keeps (src/main/tank.js keeps where things
// stand). What he uses most becomes his favourite; a new piece gets a look and
// a word; moving into a bigger tank is moving day; a complete set of finds on
// show is a set on display; and now and then, on the desktop, he mentions it.
//
// Kept in its own config key (`tankLife`), per PC and never synced or shared,
// so the layout in `tank` stays exactly what you arranged.
//
// What he does from moment to moment (hide, sit, climb...) is picked in the
// panel, only while the tank is on screen: src/renderer/panel/tank-life.js.
//
// Pure: no I/O, no clock (callers pass `now`), no randomness of its own.
// See test/tank-life.test.js.

const MAX_USES = 999;          // per piece: enough to tell a favourite, never a big file
const MAX_TRACKED = 64;        // tank.js HARD_CAP
const FAVOURITE_AFTER = 3;     // uses before a piece can be his favourite
const MAX_SEEN_REFS = 300;
const MAX_LINE = 24;           // voice.js MAX_LINE: the bubble's width
const PLANT = 'plant';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const count = v => (Number.isInteger(v) && v > 0 ? Math.min(v, MAX_USES) : 0);
const REF_RE = /^[a-z0-9:/-]{1,90}$/;
const SET_RE = /^[a-z0-9-]{1,40}$/;

/** A stored tankLife made safe. Never throws. */
function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  const uses = {};
  if (isObj(r.uses)) {
    for (const [k, v] of Object.entries(r.uses).slice(0, MAX_TRACKED)) {
      if (/^\d{1,10}$/.test(k) && count(v)) uses[k] = count(v);
    }
  }
  const strings = (a, re, max) => (Array.isArray(a) ? [...new Set(a.filter(x => typeof x === 'string' && re.test(x)))].slice(0, max) : []);
  return {
    uses,
    // Refs he's already had a look at, so a piece put away and back in isn't new again.
    seen: strings(r.seen, REF_RE, MAX_SEEN_REFS),
    // The biggest tank he's moved into (index into tank.SIZES), for moving day.
    biggest: Number.isInteger(r.biggest) && r.biggest >= 0 && r.biggest < 16 ? r.biggest : 0,
    // Sets he's ever had on display (they stay counted when taken down).
    shown: strings(r.shown, SET_RE, 32),
    naps: count(r.naps),
  };
}

/**
 * Uses reported by the panel ({ uid: n } since it last told us), added on.
 * Only pieces still in the tank count; a piece put away takes its uses with it.
 */
function addUses(stateIn, report, placed) {
  const state = normalize(stateIn);
  const here = new Set((placed || []).map(p => String(p.uid)));
  const uses = {};
  for (const [k, n] of Object.entries(state.uses)) if (here.has(k)) uses[k] = n;
  if (isObj(report)) {
    for (const [k, v] of Object.entries(report).slice(0, MAX_TRACKED)) {
      if (!here.has(k) || !Number.isInteger(v) || v <= 0) continue;
      uses[k] = Math.min(MAX_USES, (uses[k] || 0) + Math.min(v, 50));
    }
  }
  return { ...state, uses };
}

/** The piece he uses most (its uid), once he's used it a few times; ties go to the older piece. */
function favourite(stateIn, placed) {
  const state = normalize(stateIn);
  let best = null;
  for (const p of placed || []) {
    const n = state.uses[String(p.uid)] || 0;
    if (n < FAVOURITE_AFTER) continue;
    if (!best || n > best.n || (n === best.n && p.uid < best.uid)) best = { uid: p.uid, n };
  }
  return best ? best.uid : null;
}

/** Sets with every member in the tank as a find, by id. */
function setsOnDisplay(placed, sets) {
  const finds = new Set((placed || []).filter(p => typeof p.ref === 'string' && p.ref.startsWith('find:')).map(p => p.ref.slice(5)));
  return (sets || []).filter(s => s.members.length && s.members.every(id => finds.has(id))).map(s => s.id);
}

/** How many different plants are in the tank (Aquascaper). */
function plantKinds(placed, lib) {
  return new Set((placed || []).filter(p => lib.get(p.ref)?.category === PLANT).map(p => p.ref)).size;
}

const sizeIndex = (sizes, id) => Math.max(0, sizes.findIndex(s => s.id === id));

/**
 * What a saved tank means to him. `before` and `after` are normalized tank
 * states; `lib` is tank.library(); `sizes` tank.SIZES; `sets` gifts.SETS.
 * Returns { state, news: [{ ref, name, category }], movedTo: size | null,
 * newSets: [set], shownCount, plants }.
 */
function afterSave(stateIn, { before, after, lib, sizes, sets }) {
  const state = normalize(stateIn);
  const seen = new Set(state.seen);
  const had = new Set((before?.placed || []).map(p => p.ref));
  const news = [];
  for (const p of after.placed) {
    if (had.has(p.ref) || seen.has(p.ref) || news.some(n => n.ref === p.ref)) continue;
    const e = lib.get(p.ref);
    if (e) news.push({ ref: p.ref, uid: p.uid, name: e.name, category: e.category });
  }
  for (const p of after.placed) seen.add(p.ref);
  const idx = sizeIndex(sizes, after.size);
  // A tank he was already in before any of this was kept is no moving day.
  const biggest = Math.max(state.biggest, before ? sizeIndex(sizes, before.size) : 0);
  const movedTo = idx > biggest ? sizes[idx] : null;
  const showing = setsOnDisplay(after.placed, sets);
  const newSets = showing.filter(id => !state.shown.includes(id)).map(id => sets.find(s => s.id === id));
  const shown = [...state.shown, ...newSets.map(s => s.id)];
  const next = {
    ...addUses(state, null, after.placed),
    seen: [...seen].slice(-MAX_SEEN_REFS),
    biggest: Math.max(biggest, idx),
    shown,
  };
  return { state: next, news, movedTo, newSets, shownCount: shown.length, plants: plantKinds(after.placed, lib) };
}

// ---------------------------------------------------------------- words

const fit = s => (typeof s === 'string' && s.length <= MAX_LINE ? s : null);
const short = name => String(name || '').toLowerCase().replace(/^(?:the|a|an) /, '');

// A new piece: something specific when it fits the bubble, else something about its kind.
const BY_CATEGORY = {
  structure: ['a new place to hide!', 'is that for me?', 'mine? all mine?'],
  plant: ['ooh, a snack. a plant.', 'something green!', 'smells like home'],
  rock: ['a rock! perfect.', 'good sitting rock', 'nice and smooth'],
  treasure: ['treasure!!', 'what’s inside?', 'shiny…'],
  bubbler: ['bubbles!', 'ooh, it glows'],
  find: ['my find! you kept it', 'that’s mine! hi!'],
  jar: ['got you, little bug', 'a bug in a jar!'],
};

/** What he says about a piece you just put in. */
function reactionLine(item, rand = Math.random) {
  const named = fit(`a ${short(item?.name)}! for me?`);
  const pool = BY_CATEGORY[item?.category] || ['ooh, something new'];
  if (named && rand() < 0.5) return named;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

/** The moving-day line. */
const movingLine = size => fit(`moving day! ${short(size?.name)}`) || 'moving day!';

/**
 * Now and then, on the desktop, a word about his tank: his favourite, a plant,
 * a find. Null when the tank is empty. `pieces` are library entries placed.
 */
function remark({ pieces, fav = null, rand = Math.random }) {
  if (!pieces?.length) return null;
  const pick = a => a[Math.min(a.length - 1, Math.floor(rand() * a.length))];
  const lines = ['I tidied my tank. ish.', 'my tank’s looking good', 'thinking about my tank'];
  if (fav) lines.push(fit(`I miss my ${short(fav.name)}`), fit(`my ${short(fav.name)} is the best`));
  const plant = pieces.find(p => p.category === PLANT);
  if (plant) lines.push(fit(`nibbled the ${short(plant.name)}`), 'the plants grew back!');
  const find = pieces.find(p => p.category === 'find');
  if (find) lines.push(fit(`moved the ${short(find.name)} back`), 'my finds look lonely');
  if (pieces.some(p => p.spots?.some(s => s.kind === 'hide'))) lines.push('my hidey-hole is cosy');
  return pick(lines.filter(Boolean));
}

module.exports = {
  FAVOURITE_AFTER, MAX_USES,
  normalize, addUses, favourite, setsOnDisplay, plantKinds, afterSave, reactionLine, movingLine, remark,
};
