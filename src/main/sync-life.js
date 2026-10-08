// His life, following you between PCs (github/sync.js): finds on the shelf,
// the bond, games played, quests, the scenes he's done, his personality and
// your typing best.
//
// Counts more than one PC adds to (each find, digs, bond points, games) are
// kept in the gist as each PC's own share, the way XP is (xp.js), so finds dug
// on two PCs add up. A PC only ever writes its own share, with when it last
// changed, so the newest of each PC's shares wins: a find given away in a swap
// (swaps.js) stays given away, even though the count went down. This PC keeps
// every PC's last share too (syncStamps.life), so a deleted gist loses nothing.
//
// The rest merges the way it can only grow: the earliest first find and hatch
// day, the best records, unions of quests, scenes, memories and firsts. His
// seed (which decides his temperament, voice.js) is the oldest crab's, so he's
// the same crab on every PC.
//
// What stays on each PC: today's caps and cooldowns, finds set aside for a swap
// and the shelf's "new" marks, open swaps and eggs (they ride on the calling
// card, social.js), the beach, his perches and the surprises' luck.
// Pure. See test/sync-life.test.js.
const bond = require('./bond');
const gifts = require('./gifts');
const play = require('./play');
const quests = require('./quests');
const { SCENES } = require('./scenes');
const voice = require('./voice');

const DEVICE_RE = /^[a-z0-9-]{4,40}$/;
const KEY_RE = /^[a-z][a-z0-9.*-]{0,80}$/;
const MAX_DEVICES = 20;
const MAX_KEYS = 400;
const SCENE_IDS = new Set(SCENES.map(s => s.id));
const FIND_IDS = new Set(gifts.FINDS.map(f => f.id));

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);
const int = v => (Number.isFinite(v) ? Math.trunc(v) : 0);
const minPos = (a, b) => (pos(a) && pos(b) ? Math.min(a, b) : pos(a) || pos(b));
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// ---------------------------------------------------------------- the tally

/** This PC's counts, flat: { 'finds.pebble': 3, 'finds.pebble*': 1, 'bond.points': 120, ... }. */
function countsOf(get) {
  const out = {};
  const f = gifts.normalize(get('finds'));
  for (const [id, it] of Object.entries(f.items)) { out[`finds.${id}`] = it.n; if (it.shiny) out[`finds.${id}*`] = it.shiny; }
  if (f.digs) out['finds.digs'] = f.digs;
  const b = bond.normalize(get('bond'));
  if (b.points) out['bond.points'] = b.points;
  const p = play.normalize(get('play'));
  for (const k of ['games', 'found', 'won']) if (p.hide[k]) out[`play.hide.${k}`] = p.hide[k];
  for (const k of ['throws', 'fetched']) if (p.fetch[k]) out[`play.fetch.${k}`] = p.fetch[k];
  return out;
}

/** { key: n } with sane keys and whole numbers (a share can be below 0: finds given away). */
function cleanCounts(raw) {
  const out = {};
  for (const [k, v] of Object.entries(isObj(raw) ? raw : {}).slice(0, MAX_KEYS)) if (KEY_RE.test(k) && int(v)) out[k] = Math.max(-1e9, Math.min(1e9, int(v)));
  return out;
}

/** { device: { at, v } }: each PC's share, the newest kept. */
function cleanTally(raw) {
  const out = {};
  const entries = Object.entries(isObj(raw) ? raw : {}).filter(([dev, e]) => DEVICE_RE.test(dev) && isObj(e));
  for (const [dev, e] of entries.sort((x, y) => pos(y[1].at) - pos(x[1].at)).slice(0, MAX_DEVICES)) out[dev] = { at: pos(e.at), v: cleanCounts(e.v) };
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

const add = (into, counts, sign = 1) => { for (const [k, n] of Object.entries(counts)) into[k] = (into[k] || 0) + sign * n; return into; };
const othersOf = (tally, device) => Object.entries(tally).filter(([dev]) => dev !== device).reduce((acc, [, e]) => add(acc, e.v), {});
const nonZero = counts => Object.fromEntries(Object.entries(counts).filter(([, n]) => n));

/**
 * This PC's tally: every PC's share it knows of (syncStamps.life.tally), with
 * its own worked out afresh: what it has, less what came from the others.
 */
function tallyOf(counts, known, device, now) {
  const tally = cleanTally(known);
  if (!DEVICE_RE.test(device || '')) return tally;
  const mine = nonZero(add(add({}, counts), othersOf(tally, device), -1));
  const was = tally[device];
  tally[device] = { at: was && same(was.v, mine) ? was.at : now, v: mine };
  return cleanTally(tally);
}

function mergeTally(a, b) {
  const x = cleanTally(a), y = cleanTally(b);
  const out = {};
  for (const dev of new Set([...Object.keys(x), ...Object.keys(y)])) out[dev] = !x[dev] || (y[dev] && y[dev].at > x[dev].at) ? y[dev] : x[dev];
  return cleanTally(out);
}

// ---------------------------------------------------------------- the rest

function cleanFinds(raw) {
  const r = isObj(raw) ? raw : {};
  const first = {}, last = {};
  for (const [id, t] of Object.entries(isObj(r.first) ? r.first : {})) if (FIND_IDS.has(id) && pos(t)) first[id] = t;
  for (const [id, t] of Object.entries(isObj(r.last) ? r.last : {})) if (FIND_IDS.has(id) && pos(t)) last[id] = t;
  return {
    first, last,
    specials: [...new Set((Array.isArray(r.specials) ? r.specials : []).filter(s => typeof s === 'string' && /^[a-z]+:\d{4}$/.test(s)))].sort().slice(-20),
    favourite: FIND_IDS.has(r.favourite) ? r.favourite : null,
    favouriteAt: pos(r.favouriteAt),
  };
}

function cleanBond(raw) {
  const r = isObj(raw) ? raw : {};
  const b = bond.normalize({ ...r, points: 0 });
  return {
    hatchedAt: b.hatchedAt, days: b.days, level: b.level, birthday: b.birthday, birthdayAt: pos(r.birthdayAt),
    celebrated: b.celebrated, journal: b.journal, firsts: b.firsts,
  };
}

/** Tolerate anything (remote data especially). */
function clean(raw) {
  const r = isObj(raw) ? raw : {};
  const p = play.normalize(r.play);
  const seed = voice.normalize(r.voice).seed;
  return {
    tally: cleanTally(r.tally),
    finds: cleanFinds(r.finds),
    bond: cleanBond(r.bond),
    play: { best: p.hide.best, longest: p.fetch.longest },
    quests: quests.normalizeQuests({ done: r.quests }).done,
    scenes: [...new Set((Array.isArray(r.scenes) ? r.scenes : []).filter(id => SCENE_IDS.has(id)))].sort(),
    voice: seed ? { seed, since: pos(r.voice?.since) } : null,
    typingBest: Math.min(400, Math.floor(pos(r.typingBest))),
  };
}

/**
 * This PC's part. get: config.get. device: this PC's id (xp.js). known: what
 * it last knew (syncStamps.life).
 */
function snapshot(get, device, known, now) {
  const k = isObj(known) ? known : {};
  const f = gifts.normalize(get('finds'));
  const b = bond.normalize(get('bond'));
  const p = play.normalize(get('play'));
  const seed = voice.normalize(get('voice')).seed;
  const firstsOf = key => Object.fromEntries(Object.entries(f.items).map(([id, it]) => [id, it[key]]));
  return clean({
    tally: tallyOf(countsOf(get), k.tally, device, now),
    finds: { first: firstsOf('first'), last: firstsOf('last'), specials: f.specials, favourite: f.favourite, favouriteAt: k.favouriteAt },
    bond: { ...b, birthdayAt: k.birthdayAt },
    play: p,
    quests: quests.normalizeQuests(get('quests')).done,
    scenes: get('scenesSeen'),
    voice: seed ? { seed, since: b.hatchedAt } : null,
    typingBest: get('typingBest'),
  });
}

const newer = (x, y, at) => (y[at] > x[at] ? y : x);

/** Both PCs' parts together: the newest share of each PC, the earliest firsts, the best records, unions. */
function merge(aIn, bIn) {
  const a = clean(aIn), b = clean(bIn);
  const union = (x, y) => [...new Set([...x, ...y])];
  const firsts = (x, y, pick) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].map(id => [id, pick(x[id], y[id])]));
  const fav = newer(a.finds, b.finds, 'favouriteAt');
  const bday = newer(a.bond, b.bond, 'birthdayAt');
  const done = firsts(a.quests, b.quests, minPos);
  // The older crab's seed; a tie goes by the seed itself, so both PCs pick the same one.
  const seeds = [a.voice, b.voice].filter(Boolean).sort((x, y) => (minPos(x.since, 9e15) - minPos(y.since, 9e15)) || (x.seed < y.seed ? -1 : 1));
  return clean({
    tally: mergeTally(a.tally, b.tally),
    finds: {
      first: firsts(a.finds.first, b.finds.first, minPos), last: firsts(a.finds.last, b.finds.last, Math.max),
      specials: union(a.finds.specials, b.finds.specials),
      favourite: fav.favourite || a.finds.favourite || b.finds.favourite, favouriteAt: fav.favouriteAt,
    },
    bond: {
      hatchedAt: minPos(a.bond.hatchedAt, b.bond.hatchedAt),
      // A day on both PCs is one day together: the larger count, never the sum.
      days: Math.max(a.bond.days, b.bond.days), level: Math.max(a.bond.level, b.bond.level),
      birthday: bday.birthday || a.bond.birthday || b.bond.birthday, birthdayAt: bday.birthdayAt,
      celebrated: union(a.bond.celebrated, b.bond.celebrated).sort(),
      journal: [...a.bond.journal, ...b.bond.journal].filter((e, i, all) => all.findIndex(x => x.kind === e.kind && x.at === e.at) === i).sort((x, y) => x.at - y.at),
      firsts: union(a.bond.firsts, b.bond.firsts),
    },
    play: { hide: { best: minPos(a.play.best, b.play.best) }, fetch: { longest: Math.max(a.play.longest, b.play.longest) } },
    quests: done,
    scenes: union(a.scenes, b.scenes),
    voice: seeds[0] || null,
    typingBest: Math.max(a.typingBest, b.typingBest),
  });
}

/**
 * What to write into this PC's settings for a merged part (a patch for
 * config.set), with syncStamps.life to keep. The counts go in as a change on
 * top of what's here now, so anything earned while the sync ran stays.
 */
function patchFor(mergedIn, get, device, known) {
  const m = clean(mergedIn);
  const k = isObj(known) ? known : {};
  const patch = {};
  const stamp = { tally: m.tally, favouriteAt: m.finds.favouriteAt, birthdayAt: m.bond.birthdayAt };
  if (!DEVICE_RE.test(device || '')) return { patch, stamp: { ...stamp, tally: cleanTally(k.tally) } };
  // What the other PCs add now, less what they added when this PC last looked.
  const delta = add(othersOf(m.tally, device), othersOf(cleanTally(k.tally), device), -1);
  const n = key => delta[key] || 0;

  const f = gifts.normalize(get('finds'));
  const items = { ...f.items };
  for (const id of new Set([...Object.keys(items), ...Object.keys(m.finds.first)])) {
    const it = items[id] || { n: 0, first: 0, last: 0 };
    const count = it.n + n(`finds.${id}`), shiny = (it.shiny || 0) + n(`finds.${id}*`);
    if (count <= 0) { delete items[id]; continue; }
    items[id] = { ...it, n: count, first: minPos(it.first, m.finds.first[id]), last: Math.max(it.last, m.finds.last[id] || 0), ...(shiny > 0 ? { shiny, shinyFirst: it.shinyFirst || m.finds.last[id] || 0 } : { shiny: 0 }) };
  }
  const finds = gifts.normalize({
    ...f, items, digs: f.digs + n('finds.digs'),
    specials: [...new Set([...f.specials, ...m.finds.specials])],
    favourite: m.finds.favouriteAt > (k.favouriteAt || 0) ? m.finds.favourite : f.favourite,
  });
  if (!same(finds, f)) patch.finds = finds;

  const b = bond.normalize(get('bond'));
  const nb = bond.normalize({
    ...b,
    points: b.points + n('bond.points'),
    hatchedAt: minPos(b.hatchedAt, m.bond.hatchedAt), days: Math.max(b.days, m.bond.days), level: Math.max(b.level, m.bond.level),
    birthday: m.bond.birthdayAt > (k.birthdayAt || 0) ? m.bond.birthday : b.birthday,
    celebrated: [...new Set([...b.celebrated, ...m.bond.celebrated])].sort(),
    journal: [...b.journal, ...m.bond.journal].filter((e, i, all) => all.findIndex(x => x.kind === e.kind && x.at === e.at) === i).sort((x, y) => x.at - y.at),
    firsts: [...new Set([...b.firsts, ...m.bond.firsts])],
  });
  if (!same(nb, b)) patch.bond = nb;

  const p = play.normalize(get('play'));
  const np = play.normalize({
    hide: { games: p.hide.games + n('play.hide.games'), found: p.hide.found + n('play.hide.found'), won: p.hide.won + n('play.hide.won'), best: minPos(p.hide.best, m.play.best) },
    fetch: { throws: p.fetch.throws + n('play.fetch.throws'), fetched: p.fetch.fetched + n('play.fetch.fetched'), longest: Math.max(p.fetch.longest, m.play.longest) },
  });
  if (!same(np, p)) patch.play = np;

  const q = quests.normalizeQuests(get('quests'));
  const done = { ...q.done };
  for (const [id, at] of Object.entries(m.quests)) done[id] = minPos(done[id], at);
  if (!same(done, q.done)) patch.quests = { ...q, done };

  const seen = Array.isArray(get('scenesSeen')) ? get('scenesSeen') : [];
  const scenes = [...seen, ...m.scenes.filter(id => !seen.includes(id))];
  if (scenes.length !== seen.length) patch.scenesSeen = scenes;

  const v = voice.normalize(get('voice'));
  if (m.voice && m.voice.seed !== v.seed) patch.voice = { ...v, seed: m.voice.seed };

  if (m.typingBest > (Number(get('typingBest')) || 0)) patch.typingBest = m.typingBest;

  return { patch, stamp };
}

/** Whether a settings change touched anything synced here (config.onSet), to sync soon. */
function moved(patch, prev) {
  return ['finds', 'bond', 'play', 'quests', 'scenesSeen', 'typingBest'].some(k => k in patch && !same(patch[k], prev[k]));
}

module.exports = { clean, snapshot, merge, patchFor, moved, countsOf, tallyOf, mergeTally, cleanTally };
