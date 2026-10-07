// His tank leaving this PC: on your public calling card (github/card.js), for
// friends to peek at, and in your private sync gist (github/sync.js), so every
// PC has the same tank. Pure: see test/tank-share.test.js.
//
// The calling card is public and a friend's is somebody else's file, so the
// card carries as little as can draw a tank: the size, the floor, the back
// glass, the light and up to CARD_MAX pieces as { ref, x, row, flip }. Refs are
// only built-in decor ids and finds, never colours, pixels, names, packs,
// specimen jars or anything else. A friend's tank is drawn from this PC's own
// art; a ref this PC doesn't know is drawn as a plain rock.
//
// It's on the card only while `shareCard` is on (off by default), and that
// choice belongs to this PC: it never syncs.
const tank = require('./tank');

const CARD_MAX = 24;
const BUILTIN_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;              // a built-in decor id (pack decor has a "pack/" in front)
const CARD_REF_RE = /^(?:find:)?[a-z0-9][a-z0-9-]{0,39}$/;   // ...or one of his finds (gifts.js FINDS ids)
const STAND_IN = 'rock-round';                               // what a piece this PC doesn't know looks like

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const builtin = v => (typeof v === 'string' && BUILTIN_RE.test(v) ? v : null);
const inPaintOrder = (a, b) => a.row - b.row || a.z - b.z || a.x - b.x || a.uid - b.uid;

// ------------------------------------------------------------------ the calling card

/**
 * What your calling card says about his tank: null unless you share it and
 * there's something in it. The first CARD_MAX pieces you put in, in paint order.
 */
function forCard(stateIn) {
  const s = tank.normalize(stateIn);
  if (!s.shareCard) return null;
  const size = tank.sizeOf(s.size);
  const placed = s.placed.filter(p => CARD_REF_RE.test(p.ref)).slice(0, CARD_MAX).sort(inPaintOrder)
    .map(p => ({ ref: p.ref, x: Math.min(p.x, size.w - 1), row: p.row, flip: p.flip }));
  if (!placed.length) return null;
  return { size: size.id, style: { substrate: builtin(s.style.substrate), backdrop: builtin(s.style.backdrop), light: s.style.light }, placed };
}

/**
 * A friend's card's tank, cleaned (it's somebody else's file). Anything off
 * the shape is dropped, never repaired into something else; null if there's
 * no tank left.
 */
function cleanCardTank(raw) {
  if (!isObj(raw) || !Array.isArray(raw.placed)) return null;
  const size = tank.SIZES.find(s => s.id === raw.size);
  if (!size) return null;
  const style = isObj(raw.style) ? raw.style : {};
  const placed = raw.placed.slice(0, CARD_MAX).map(p => {
    if (!isObj(p) || typeof p.ref !== 'string' || !CARD_REF_RE.test(p.ref)) return null;
    if (!Number.isInteger(p.x) || p.x < 0 || p.x >= size.w) return null;
    if (!Number.isInteger(p.row) || p.row < 0 || p.row >= tank.ROWS.length) return null;
    return { ref: p.ref, x: p.x, row: p.row, flip: p.flip === true };
  }).filter(Boolean);
  if (!placed.length) return null;
  return {
    size: size.id,
    style: { substrate: builtin(style.substrate), backdrop: builtin(style.backdrop), light: tank.LIGHTS.includes(style.light) ? style.light : 'clock' },
    placed,
  };
}

/**
 * A friend's tank, ready to paint (tank-paint.js): their layout with this PC's
 * art. Every built-in piece and every find can be drawn, whatever is unlocked
 * here; it's their tank. A piece this PC doesn't know (a newer Shellby's) is a
 * plain rock, and `strangers` counts them.
 *   decor: Wardrobe#decorView()   finds: gifts.FINDS
 */
function peekView(cardTank, { decor = [], finds = [] } = {}) {
  const t = cleanCardTank(cardTank);
  if (!t) return null;
  const lib = tank.library({
    decor: decor.filter(d => builtin(d?.key)).map(d => ({ ...d, locked: null, isNew: false })),
    findState: { items: Object.fromEntries(finds.map(f => [f.id, { n: CARD_MAX }])) },
    finds,
  });
  let strangers = 0;
  const placed = t.placed.map((p, i) => {
    const e = lib.get(p.ref);
    const known = !!e && !tank.STYLES.includes(e.category);
    if (!known) strangers++;
    return { uid: i + 1, ref: known ? p.ref : STAND_IN, x: p.x, row: p.row, z: i, flip: p.flip };
  });
  const top = tank.SIZES.at(-1);
  const v = tank.view({ state: { size: t.size, style: t.style, placed }, lib, level: top.level, shipped: top.shipped });
  return {
    size: { id: v.size.id, name: v.size.name, w: v.size.w, h: v.size.h },
    world: v.world,
    style: { substrate: v.style.substrate, backdrop: v.style.backdrop, light: v.style.light },
    pieces: v.pieces,
    strangers,
  };
}

// ------------------------------------------------------------------ the sync gist

/** What goes in the private sync gist: the layout and when it changed. Not whether it's on your card. */
function syncable(stateIn) {
  const s = tank.normalize(stateIn);
  return { size: s.size, style: s.style, placed: s.placed, editedAt: s.editedAt };
}

/** Two PCs' tanks: the one changed last wins, whole (like sticker layouts). */
function merge(aIn, bIn) {
  const a = syncable(aIn), b = syncable(bIn);
  return b.editedAt > a.editedAt ? b : a;
}

/** A merged tank onto this PC's own: newer replaces it, and sharing stays as this PC has it. */
function applySync(localIn, merged) {
  const local = tank.normalize(localIn);
  const m = syncable(merged);
  return m.editedAt > local.editedAt ? { ...m, shareCard: local.shareCard } : local;
}

module.exports = { CARD_MAX, STAND_IN, forCard, cleanCardTank, peekView, syncable, merge, applySync };
