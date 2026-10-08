// Swaps: friends trade finds (gifts.js), one for one. Never bugs: a catch comes
// from a fix Claude really made, so it can't change hands. Offers, answers and
// call-offs are letters on each other's calling cards (github/mail.js); this
// keeps the book of what's open, and says what each letter does to your shelf.
//
// The shape of a swap: you offer one of your spare copies for one of theirs.
// Yours is set aside (gifts.hold) until they answer. If they accept, their
// Shellby hands theirs over and writes back; yours goes when that letter comes.
// A week with no answer, and yours comes back. See docs/plans/viral.md §4.
//
// Pure: no I/O, no clock, no randomness (the caller makes the swap's id). See
// test/swaps.test.js.

const gifts = require('./gifts');

const DAY = 24 * 60 * 60 * 1000;
const EXPIRE_MS = 7 * DAY;
const MAX_OPEN = 3;           // offers of yours waiting at once
const WEEK_CAP = 10;          // offers you can make in a week
const MAX_INBOX = 12;         // offers to you waiting
const MAX_DONE = 30;
const SID_RE = /^[a-z0-9]{8}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,39})$/;
const CARD_ITEM_RE = /^([a-z0-9](?:[a-z0-9-]{0,39}))(\*?)$/;

const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const weekOf = t => Math.floor(t / (7 * DAY));

/** { id, shiny } for a find that exists and could be swapped at all. */
function cleanItem(raw) {
  const r = obj(raw);
  const f = ID_RE.test(r.id || '') ? gifts.findById(r.id) : null;
  return f && !f.special ? { id: f.id, shiny: r.shiny === true } : null;
}
const cleanRow = (r, who) => {
  const give = cleanItem(r?.give), get = cleanItem(r?.get);
  if (!SID_RE.test(r?.sid || '') || !LOGIN_RE.test(r?.[who] || '') || !give || !get || !pos(r.at)) return null;
  return { sid: r.sid, [who]: r[who], give, get, at: r.at };
};

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = obj(raw);
  const out = (Array.isArray(r.out) ? r.out : []).map(x => cleanRow(x, 'to')).filter(Boolean).slice(0, MAX_OPEN);
  const inbox = (Array.isArray(r.in) ? r.in : []).map(x => cleanRow(x, 'from')).filter(Boolean).slice(0, MAX_INBOX);
  const done = (Array.isArray(r.done) ? r.done : []).filter(d => SID_RE.test(d?.sid || '') && LOGIN_RE.test(d?.with || '') && cleanItem(d.gave) && cleanItem(d.got) && pos(d.at))
    .map(d => ({ sid: d.sid, with: d.with, gave: cleanItem(d.gave), got: cleanItem(d.got), at: d.at })).slice(0, MAX_DONE);
  const w = obj(r.week);
  return { out, in: inbox, done, week: { n: Math.floor(pos(w.n)), key: Math.floor(pos(w.key)) } };
}

const label = it => `${it.shiny ? 'sparkly ' : ''}${gifts.findById(it.id).name.toLowerCase()}`;
const token = it => `${it.id}${it.shiny ? '*' : ''}`;

/** The marker and the words for each letter (github/mail.js sendLetter). */
const letters = {
  offer: s => ({ marker: `shellby-swap:offer:${s.sid}:give=${token(s.give)}:get=${token(s.get)}`, words: `would like to swap their ${label(s.give)} for your ${label(s.get)}` }),
  accept: s => ({ marker: `shellby-swap:accept:${s.sid}`, words: 'said yes to the swap 🤝' }),
  decline: s => ({ marker: `shellby-swap:decline:${s.sid}`, words: 'said no thanks to the swap' }),
  cancel: s => ({ marker: `shellby-swap:cancel:${s.sid}`, words: 'called the swap off' }),
};

/** A friend's card says what they'd swap and what they're after. -> { offers: [{ id, shiny }], wants: [id] } */
function cleanCardSwap(raw) {
  const r = obj(raw);
  const offers = [];
  for (const x of (Array.isArray(r.offers) ? r.offers : []).slice(0, 12)) {
    const m = typeof x === 'string' ? CARD_ITEM_RE.exec(x) : null;
    const it = m && cleanItem({ id: m[1], shiny: m[2] === '*' });
    if (it && !offers.some(o => o.id === it.id && o.shiny === it.shiny)) offers.push(it);
  }
  const wants = [...new Set((Array.isArray(r.wants) ? r.wants : []).filter(id => typeof id === 'string' && cleanItem({ id })))];
  return { offers: offers.slice(0, 6), wants: wants.slice(0, 6) };
}
/** For your own card: gifts.swapLists, as tokens ('pebble', 'pearl*'). */
const forCard = finds => gifts.swapLists(finds);

/**
 * Offer one of yours for one of theirs.
 *   o: { sid, to, give: { id, shiny }, get: { id, shiny }, theirCard: cleanCardSwap(...) }
 * -> { ok, swaps, finds, letter } or { ok: false, error }
 */
function offer(swapsIn, findsIn, o, now) {
  const s = normalize(swapsIn);
  const give = cleanItem(o.give), get = cleanItem(o.get);
  const no = error => ({ ok: false, error });
  if (!SID_RE.test(o.sid || '') || !LOGIN_RE.test(o.to || '')) return no('That swap doesn\'t look right.');
  if (!give || !get) return no('That isn\'t something that can be swapped.');
  if (!gifts.spare(findsIn, give.id, give.shiny)) return no('You need a spare one of those: you always keep one of everything.');
  if (!(o.theirCard?.offers || []).some(x => x.id === get.id && x.shiny === get.shiny)) return no(`@${o.to} isn't offering that one any more.`);
  if (s.out.length >= MAX_OPEN) return no(`That's ${MAX_OPEN} swaps waiting already. Wait for an answer, or call one off.`);
  if (s.out.some(x => same(x.to, o.to))) return no(`There's already a swap waiting with @${o.to}.`);
  const week = s.week.key === weekOf(now) ? s.week : { key: weekOf(now), n: 0 };
  if (week.n >= WEEK_CAP) return no(`That's ${WEEK_CAP} swaps this week. More next week.`);
  const row = { sid: o.sid, to: o.to, give, get, at: now };
  return {
    ok: true,
    swaps: normalize({ ...s, out: [...s.out, row], week: { key: week.key, n: week.n + 1 } }),
    finds: gifts.hold(findsIn, give.id, give.shiny),
    letter: letters.offer(row),
  };
}

/** Call off one of yours before they answer. -> { swaps, finds, letter } */
function cancel(swapsIn, findsIn, sid) {
  const s = normalize(swapsIn);
  const row = s.out.find(x => x.sid === sid);
  if (!row) return { swaps: s, finds: findsIn, letter: null };
  return { swaps: { ...s, out: s.out.filter(x => x.sid !== sid) }, finds: gifts.release(findsIn, row.give.id, row.give.shiny), letter: { ...letters.cancel(row), to: row.to } };
}

/**
 * A letter about a swap came (github/mail.js parseLetter).
 *   l: { from, at, act, sid, give?, get? }, friend: is \`from\` on your list?
 *   theirCard: their card's swap lists, to check an offer against
 * -> { swaps, finds, done: { with, gave, got, completed } | null, news: 'offer' | 'declined' | 'cancelled' | null }
 */
function onLetter(swapsIn, findsIn, l, { friend = false, theirCard = null } = {}, now) {
  const s = normalize(swapsIn);
  const keep = { swaps: s, finds: findsIn, done: null, news: null };
  if (!l || !SID_RE.test(l.sid || '') || !LOGIN_RE.test(l.from || '')) return keep;
  const mine = s.out.find(x => x.sid === l.sid);
  if (l.act === 'offer') {
    // From friends only, about a find they've said they'd swap, and one we could spare.
    const give = cleanItem(l.give), get = cleanItem(l.get);
    if (!friend || !give || !get || s.in.some(x => x.sid === l.sid) || s.done.some(x => x.sid === l.sid)) return keep;
    if (!(theirCard?.offers || []).some(x => x.id === give.id && x.shiny === give.shiny)) return keep;
    if (s.in.length >= MAX_INBOX) return keep;
    return { ...keep, swaps: { ...s, in: [...s.in, { sid: l.sid, from: l.from, give, get, at: l.at || now }] }, news: 'offer' };
  }
  if (l.act === 'cancel') {
    const was = s.in.find(x => x.sid === l.sid && same(x.from, l.from));
    return was ? { ...keep, swaps: { ...s, in: s.in.filter(x => x !== was) }, news: 'cancelled' } : keep;
  }
  // Answers to one of ours: only from who we offered it to.
  if (!mine || !same(mine.to, l.from)) return keep;
  if (l.act === 'decline') {
    return { ...keep, swaps: { ...s, out: s.out.filter(x => x !== mine) }, finds: gifts.release(findsIn, mine.give.id, mine.give.shiny), news: 'declined' };
  }
  if (l.act === 'accept') {
    let finds = gifts.handOver(findsIn, mine.give.id, mine.give.shiny);
    const r = gifts.receive(finds, mine.get.id, mine.get.shiny, now);
    finds = r.state;
    const row = { sid: mine.sid, with: mine.to, gave: mine.give, got: mine.get, at: now };
    return { swaps: { ...s, out: s.out.filter(x => x !== mine), done: [row, ...s.done].slice(0, MAX_DONE) }, finds, done: { ...row, isNew: r.isNew, completed: r.completed }, news: null };
  }
  return keep;
}

/**
 * Answer an offer made to you. Accepting checks you can still spare what they
 * asked for, then makes the swap on your side.
 * -> { ok, swaps, finds, letter, done } or { ok: false, error }
 */
function answer(swapsIn, findsIn, sid, yes, now) {
  const s = normalize(swapsIn);
  const row = s.in.find(x => x.sid === sid);
  if (!row) return { ok: false, error: 'That offer is gone. They may have called it off.' };
  const rest = { ...s, in: s.in.filter(x => x !== row) };
  if (!yes) return { ok: true, swaps: rest, finds: findsIn, letter: { ...letters.decline(row), to: row.from }, done: null };
  if (!gifts.spare(findsIn, row.get.id, row.get.shiny)) return { ok: false, error: 'You don\'t have a spare one of those any more: you always keep one of everything.' };
  let finds = gifts.hold(findsIn, row.get.id, row.get.shiny);
  finds = gifts.handOver(finds, row.get.id, row.get.shiny);
  const r = gifts.receive(finds, row.give.id, row.give.shiny, now);
  const done = { sid, with: row.from, gave: row.get, got: row.give, at: now };
  return {
    ok: true, swaps: { ...rest, done: [done, ...rest.done].slice(0, MAX_DONE) }, finds: r.state,
    letter: { ...letters.accept(row), to: row.from }, done: { ...done, isNew: r.isNew, completed: r.completed },
  };
}

/** Offers older than a week: yours come back, theirs go. -> { swaps, finds, expired: n } */
function expire(swapsIn, findsIn, now) {
  const s = normalize(swapsIn);
  const old = s.out.filter(x => now - x.at > EXPIRE_MS);
  let finds = findsIn;
  for (const x of old) finds = gifts.release(finds, x.give.id, x.give.shiny);
  const inbox = s.in.filter(x => now - x.at <= EXPIRE_MS);
  const expired = old.length + (s.in.length - inbox.length);
  return { swaps: expired ? { ...s, out: s.out.filter(x => !old.includes(x)), in: inbox } : s, finds, expired };
}

const itemView = it => {
  const f = gifts.findById(it.id);
  const look = it.shiny ? gifts.sparkly(f) : f;
  return { id: it.id, shiny: it.shiny, name: `${it.shiny ? '✨ ' : ''}${f.name}`, rarity: f.rarity, pixels: look.pixels, palette: look.palette };
};

/** What the panel shows: your offers out, offers in, and the last few done. */
function view(swapsIn, now) {
  const s = normalize(swapsIn);
  const left = at => Math.max(0, Math.ceil((at + EXPIRE_MS - now) / DAY));
  return {
    out: s.out.map(x => ({ sid: x.sid, to: x.to, give: itemView(x.give), get: itemView(x.get), daysLeft: left(x.at) })),
    in: s.in.map(x => ({ sid: x.sid, from: x.from, give: itemView(x.give), get: itemView(x.get), daysLeft: left(x.at) })),
    done: s.done.slice(0, 8).map(x => ({ with: x.with, gave: itemView(x.gave), got: itemView(x.got), at: x.at })),
    weekLeft: s.week.key === weekOf(now) ? Math.max(0, WEEK_CAP - s.week.n) : WEEK_CAP,
  };
}

/**
 * What you could swap with a friend: their offers (with which of your sets
 * each would finish) and your spare copies (marked if they're after one).
 */
function options(findsIn, theirCard) {
  const theirs = (theirCard?.offers || []).map(it => ({ ...itemView(it), finishes: gifts.finishes(findsIn, it.id), haveIt: !!gifts.normalize(findsIn).items[it.id] }));
  const wants = new Set(theirCard?.wants || []);
  const mine = gifts.swapLists(findsIn, { max: 24 }).offers.map(t => { const m = CARD_ITEM_RE.exec(t); return { ...itemView({ id: m[1], shiny: m[2] === '*' }), wanted: wants.has(m[1]) }; });
  return { theirs, mine };
}

module.exports = { EXPIRE_MS, MAX_OPEN, WEEK_CAP, normalize, cleanCardSwap, forCard, offer, cancel, onLetter, answer, expire, view, options, letters };
