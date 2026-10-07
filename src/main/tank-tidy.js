// Tidying up (docs/plans/tank-decor.md §5): very occasionally, when you open
// his tank, he's carried one of his finds a few pixels over, next to
// something he likes it near. Only finds: never structures, plants or
// anything else, and never in a tank you changed in the last day. At most
// once a day, and only some days. "Put it back" (or Ctrl+Z) undoes it, and
// "Let him tidy up" turns it off. Nothing decays and nothing is lost.
//
// Config `tankTidy` ({ on, at, last }) belongs to each PC and never syncs.
// Pure: no I/O, no clock, no Math.random (callers pass `now` and `rand`).
// See test/tank-tidy.test.js.

const tank = require('./tank');

const DAY = 24 * 60 * 60 * 1000;
const CHANCE = 0.35;       // of a day he could, the share he does
const STEP_MIN = 2;        // art px
const STEP_MAX = 6;
const NEAR = 3;            // how close he puts it to what he's moving it towards

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const pos = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const isInt = v => Number.isInteger(v) && v >= 0 && v <= 1e9;

function normalizeMove(m) {
  if (!isObj(m) || !isInt(m.uid) || !m.uid || !isInt(m.from) || !isInt(m.to) || typeof m.ref !== 'string' || !tank.REF_RE.test(m.ref)) return null;
  return { uid: m.uid, ref: m.ref, from: m.from, to: m.to };
}

/** This PC's tidying: on unless you turned it off, when he last did, and what he moved. Never throws. */
function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  return { on: r.on !== false, at: pos(r.at), last: normalizeMove(r.last) };
}

/**
 * Whether he tidies now, and what: null, or { uid, ref, from, to }.
 *   state: the tank (config `tank`)   lib: tank.library()   tidy: normalize()
 */
function pick(stateIn, { lib, tidy: tidyIn = null, now = 0, rand = () => 1 }) {
  const t = normalize(tidyIn);
  const s = tank.normalize(stateIn);
  if (!t.on || now - s.editedAt < DAY || now - t.at < DAY) return null;
  if (rand() >= CHANCE) return null;
  const size = tank.sizeOf(s.size);
  const known = s.placed.map(p => ({ p, e: lib.get(p.ref) })).filter(x => x.e && x.e.layer !== 'float' && x.e.category !== 'sticker');
  const finds = known.filter(x => x.p.ref.startsWith('find:'));
  if (!finds.length) return null;
  const { p, e } = finds[Math.min(finds.length - 1, Math.floor(rand() * finds.length))];
  // Towards the nearest other piece in its row, or the middle of the tank if it's alone there.
  const others = known.filter(x => x.p.uid !== p.uid && x.p.row === p.row);
  const centre = p.x + e.w / 2;
  const target = others.length
    ? others.map(x => x.p.x + x.e.w / 2).sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre))[0]
    : size.w / 2;
  const gap = target - centre;
  if (Math.abs(gap) <= NEAR) return null;
  const step = Math.min(Math.abs(gap) - NEAR, STEP_MIN + Math.floor(rand() * (STEP_MAX - STEP_MIN + 1)));
  const to = Math.max(0, Math.min(size.w - e.w, Math.round(p.x + Math.sign(gap) * step)));
  return to === p.x ? null : { uid: p.uid, ref: p.ref, from: p.x, to };
}

const moveTo = (stateIn, uid, ref, x) => {
  const s = tank.normalize(stateIn);
  return { ...s, placed: s.placed.map(p => (p.uid === uid && p.ref === ref ? { ...p, x } : p)) };
};

/** The tank with his move made (a new object). */
const apply = (state, move) => moveTo(state, move.uid, move.ref, move.to);

/** The tank with his last move undone, or null if that piece has moved on since (you moved it, or it's gone). */
function undo(stateIn, moveIn) {
  const m = normalizeMove(moveIn);
  if (!m) return null;
  const here = tank.normalize(stateIn).placed.find(p => p.uid === m.uid && p.ref === m.ref);
  return here && here.x === m.to ? moveTo(stateIn, m.uid, m.ref, m.from) : null;
}

module.exports = { DAY, CHANCE, normalize, pick, apply, undo };
