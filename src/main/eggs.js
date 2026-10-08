// Crab eggs: your crab lays one for someone who doesn't have Shellby yet. You
// send them the code (EGG-crabfan-7kq2mxab) or the link; they install, paste
// it, and it hatches into a baby crab that both of you keep. It's how one crab
// brings in another. See docs/plans/viral.md §3.
//
// It all rides on calling cards (github/card.js) and letters (github/mail.js):
//   - laying puts a *hash* of the egg's id on your public card, never the id,
//     so the card alone can't hatch it: only someone you gave the code to can;
//   - hatching checks the hash is on the parent's card, then leaves a hatch
//     letter on it with the id; the parent's Shellby checks the id against the
//     eggs it laid, and the first one to hatch it is the only one.
// The baby is worked out from the egg's id, so both crabs get the same one.
//
// Pure apart from hashing (no I/O, no clock, no randomness: the caller makes
// the id). See test/eggs.test.js.
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const LAY_EVERY = 7 * DAY;     // one egg a week
const MAX_OPEN = 3;            // waiting to hatch at once
const MAX_LAID = 20;
const MAX_CLUTCH = 24;
const LEVEL_TO_LAY = 5;
const EGG_RE = /^[a-z0-9]{8}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const HASH_RE = /^[0-9a-f]{16}$/;
const CODE_RE = /\bEGG-([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))-([a-z0-9]{8})\b/i;
const LINK_RE = /^shellby:\/\/hatch\/?\?(.*)$/i;

const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** What goes on the card for an egg: enough to check a code against, not enough to hatch it. */
const hashOf = (login, id) => crypto.createHash('sha256').update(`shellby-egg:${String(login).toLowerCase()}:${id}`).digest('hex').slice(0, 16);

// ------------------------------------------------------------------ the baby

const NAMES = ['Pip', 'Barnacle', 'Nibbles', 'Scuttle', 'Pebble', 'Kelpie', 'Bubbles', 'Snip', 'Tidbit', 'Coral', 'Sandy', 'Limpet',
  'Pinch', 'Doodle', 'Mussel', 'Winkle', 'Sprat', 'Dabble', 'Cockle', 'Splash', 'Noodle', 'Shrimpy', 'Periwinkle', 'Clawdia'];
const SHELLS = ['#ff7a5c', '#ffc15e', '#7fd6c2', '#c77dff', '#4ea8de', '#ff8fab', '#57cc99', '#e9a23b'];
const BODIES = ['#ff9f80', '#ffd2c2', '#f3e6cc', '#ffb4a2', '#b8f2e6', '#ffe8a3'];
// A hatchling: 7×5, shell on its back, little claws.
const BABY = ['..sss..', '.sSsSs.', 'c.bkbk.', 'cbbbbbc', '.b.b.b.'];

const hashNum = s => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0; return h; };

/** The baby that hatches from an egg: the same for both crabs. */
function hatchling(id) {
  const h = hashNum(id);
  const shell = SHELLS[h % SHELLS.length];
  const dark = shell.replace(/[0-9a-f]{2}/gi, x => Math.round(parseInt(x, 16) * 0.72).toString(16).padStart(2, '0'));
  return {
    name: NAMES[(h >>> 8) % NAMES.length],
    pixels: BABY,
    palette: { s: shell, S: dark, b: BODIES[(h >>> 16) % BODIES.length], c: BODIES[(h >>> 20) % BODIES.length], k: '#2b2d42' },
  };
}

/** An egg, drawn: speckled in the baby's shell colour. */
function eggArt(id) {
  const b = hatchling(id);
  return { pixels: ['..www..', '.wwsww.', 'wswwwsw', 'wwwswww', 'wswwwww', '.wwwsw.', '..www..'], palette: { w: '#fff4e4', s: b.palette.s } };
}

// ------------------------------------------------------------------ state

function cleanLaid(r) {
  const e = obj(r);
  if (!EGG_RE.test(e.id || '') || !pos(e.laidAt)) return null;
  return { id: e.id, laidAt: e.laidAt, hatchedBy: LOGIN_RE.test(e.hatchedBy || '') ? e.hatchedBy : null, hatchedAt: pos(e.hatchedAt) };
}
function cleanBaby(r) {
  const b = obj(r);
  if (!EGG_RE.test(b.id || '') || !LOGIN_RE.test(b.with || '') || !pos(b.at)) return null;
  return { id: b.id, with: b.with, at: b.at, mine: b.mine === true };
}

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = obj(raw);
  const from = obj(r.hatchedFrom);
  return {
    laid: (Array.isArray(r.laid) ? r.laid : []).map(cleanLaid).filter(Boolean).slice(0, MAX_LAID),
    lastLaidAt: pos(r.lastLaidAt),
    // The egg you hatched yourself, if you came from one.
    hatchedFrom: EGG_RE.test(from.id || '') && LOGIN_RE.test(from.login || '') ? { id: from.id, login: from.login, at: pos(from.at) } : null,
    // Codes pasted before GitHub was ready: hatched as soon as it is.
    pending: (() => { const p = obj(r.pending); return EGG_RE.test(p.egg || '') && LOGIN_RE.test(p.from || '') ? { from: p.from, egg: p.egg, at: pos(p.at) } : null; })(),
    // Every baby: ones from your eggs (mine: true) and the one you hatched.
    clutch: (Array.isArray(r.clutch) ? r.clutch : []).map(cleanBaby).filter(Boolean).slice(0, MAX_CLUTCH),
    follower: EGG_RE.test(r.follower || '') ? r.follower : null,
  };
}

const openEggs = s => s.laid.filter(e => !e.hatchedBy);

/** Can you lay one now? -> { ok, why, nextAt } */
function canLay(stateIn, { level = 1, cardOn = false, login = null } = {}, now) {
  const s = normalize(stateIn);
  if (!cardOn || !LOGIN_RE.test(login || '')) return { ok: false, why: 'Turn on Visiting crabs first: the egg sits on your calling card.' };
  if (level < LEVEL_TO_LAY) return { ok: false, why: `He lays his first egg at level ${LEVEL_TO_LAY}.` };
  if (openEggs(s).length >= MAX_OPEN) return { ok: false, why: `${MAX_OPEN} eggs are waiting to hatch already.` };
  const nextAt = s.lastLaidAt + LAY_EVERY;
  if (s.lastLaidAt && now < nextAt) return { ok: false, why: 'One egg a week.', nextAt };
  return { ok: true };
}

/** Lay an egg (id from the caller). -> { ok, state, egg: { id, code, link, ... } } */
function lay(stateIn, id, ctx, now) {
  const s = normalize(stateIn);
  const can = canLay(s, ctx, now);
  if (!can.ok) return { ok: false, error: can.why, nextAt: can.nextAt };
  if (!EGG_RE.test(id || '') || s.laid.some(e => e.id === id)) return { ok: false, error: 'That egg didn\'t come out right.' };
  const egg = { id, laidAt: now, hatchedBy: null, hatchedAt: 0 };
  return { ok: true, state: normalize({ ...s, laid: [egg, ...s.laid], lastLaidAt: now }), egg: { ...egg, ...share(ctx.login, id) } };
}

/** How you hand an egg over: a code to paste, and a link for anyone with Shellby already. */
function share(login, id) {
  const code = `EGG-${login}-${id}`;
  return { code, link: `shellby://hatch?egg=${encodeURIComponent(code)}` };
}

/** A pasted code or an opened link -> { from, egg } or null. */
function parseCode(text) {
  const t = typeof text === 'string' ? text.trim().slice(0, 300) : '';
  const link = LINK_RE.exec(t);
  const raw = link ? new URLSearchParams(link[1]).get('egg') || '' : t;
  const m = CODE_RE.exec(raw);
  return m ? { from: m[1], egg: m[2].toLowerCase() } : null;
}

/** What your card says about your eggs: the hashes of the open ones. */
function forCard(stateIn, login) {
  return LOGIN_RE.test(login || '') ? openEggs(normalize(stateIn)).map(e => hashOf(login, e.id)) : [];
}
const cleanCardEggs = raw => [...new Set((Array.isArray(raw) ? raw : []).filter(h => typeof h === 'string' && HASH_RE.test(h)))].slice(0, MAX_OPEN);

/**
 * Hatch a friend's egg. Their card has to list it (the hash of the code you
 * have), and you can only ever hatch one.
 *   parentCard: their cleaned calling card ({ login, eggs, find })
 * -> { ok, state, baby, letter: { marker, words, to }, gift: find id | null } or { ok: false, error }
 */
function hatch(stateIn, { from, egg }, parentCard, me, now) {
  const s = normalize(stateIn);
  if (s.hatchedFrom) return { ok: false, error: `You already hatched from @${s.hatchedFrom.login}'s egg. One crab, one egg.` };
  if (same(from, me)) return { ok: false, error: 'That\'s one of your own eggs. Send it to a friend!' };
  if (!parentCard || !same(parentCard.login, from)) return { ok: false, error: `@${from} has no calling card, so the egg can't be found.` };
  if (!(parentCard.eggs || []).includes(hashOf(from, egg))) return { ok: false, error: `That egg isn't on @${from}'s card. It may have hatched already.` };
  const baby = hatchling(egg);
  return {
    ok: true,
    state: normalize({ ...s, hatchedFrom: { id: egg, login: from, at: now }, pending: null, clutch: [{ id: egg, with: from, at: now, mine: false }, ...s.clutch] }),
    baby: { id: egg, with: from, ...baby },
    letter: { to: from, marker: `shellby-hatch:${egg}`, words: `hatched one of your eggs! Say hi to ${baby.name} 🐣` },
    gift: parentCard.find || null,
  };
}

/**
 * A hatch letter on your card (github/mail.js). From anyone, but only for an
 * egg you laid and nobody's hatched. -> { state, baby } (baby null when it did nothing)
 */
function onHatch(stateIn, letter, now) {
  const s = normalize(stateIn);
  const egg = s.laid.find(e => e.id === letter?.egg);
  if (!egg || egg.hatchedBy || !LOGIN_RE.test(letter?.from || '')) return { state: s, baby: null };
  const laid = s.laid.map(e => (e === egg ? { ...e, hatchedBy: letter.from, hatchedAt: now } : e));
  return {
    state: normalize({ ...s, laid, clutch: [{ id: egg.id, with: letter.from, at: now, mine: true }, ...s.clutch] }),
    baby: { id: egg.id, with: letter.from, ...hatchling(egg.id) },
  };
}

/** Keep a code until GitHub's ready to hatch it. */
const keepPending = (stateIn, code, now) => ({ ...normalize(stateIn), pending: code ? { ...code, at: now } : null });

/** Which baby follows him round the desk (null: his favourite catch, as before). */
function setFollower(stateIn, id) {
  const s = normalize(stateIn);
  return { ...s, follower: id && s.clutch.some(b => b.id === id) ? id : null };
}

/** What the Us page and Settings show. */
function view(stateIn, { login = null, level = 1, cardOn = false } = {}, now) {
  const s = normalize(stateIn);
  const can = canLay(s, { login, level, cardOn }, now);
  return {
    canLay: can.ok, why: can.ok ? null : can.why, nextAt: can.nextAt || 0, levelToLay: LEVEL_TO_LAY,
    open: openEggs(s).map(e => ({ id: e.id, laidAt: e.laidAt, ...(login ? share(login, e.id) : {}), ...eggArt(e.id) })),
    hatchedFrom: s.hatchedFrom,
    pending: s.pending,
    clutch: s.clutch.map(b => ({ ...b, ...hatchling(b.id) })),
    follower: s.follower,
  };
}

module.exports = {
  LAY_EVERY, MAX_OPEN, LEVEL_TO_LAY, hashOf, hatchling, eggArt, normalize, canLay, lay, share, parseCode, forCard, cleanCardEggs,
  hatch, onHatch, keepPending, setFollower, view,
};
