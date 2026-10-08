// The Bugdex: a collection book of the bugs you've beaten. Every kind of
// failure Claude fixes is a pixel creature (bugdex/species.js); you catch one
// by fixing it, never by seeing it. Seen ones are silhouettes, caught ones
// are in colour with their stats, and catching the same kind again grows it
// through evolution stages. Habitats are its sets, like the finds shelf's
// (gifts.js). See docs/plans/bugdex.md.
//
// Kept per PC like XP (xp.js byDevice), so sync adds PCs together without
// counting a catch twice. No error text is ever kept: a species id, a short
// hash and a project id.
//
// Pure: no I/O, no clock, no randomness of its own (callers pass `now` and
// `rand`). The encounters themselves are bugdex/lifecycle.js. See
// test/bugdex.test.js.
const { SPECIES, HABITATS, RARITY, TYPES, BY_ID, LEAGUE, speciesById, live, leagueOf, bossOf } = require('./bugdex/species');
const { loreOf } = require('./bugdex/lore');
const lifecycle = require('./bugdex/lifecycle');
const art = require('./bugdex/art');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const STAGES = Object.freeze([1, 5, 15, 40]);   // catches to reach stage I, II, III and the master crown
const CATCH_COOLDOWN = 12 * HOUR;               // the same bug in the same project counts once in this long
const PAY_COOLDOWN = 7 * DAY;                   // ...and pays XP once in this long
const SPECIES_DAY_CAP = 3;                      // catches of one species a day that count
const DAY_CAP = 12;                             // catches a day that count
const ESCAPE_MS = 3 * DAY;                      // a caught bug back this soon got away
const SWIFT_MS = 5 * MINUTE;
const SHINY_CHANCE = 1 / 64;
const MOMENT_GAP = 10 * MINUTE;                 // repeat catches: one jar moment in this long
const MAX_RECENT = 200;
const MAX_LOG = 30;
const MAX_PROJECTS = 12;
const MAX_DEVICES = 20;
const MAX_GIFTS = 40;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const FORMS = Object.freeze(['first-try', 'swift', 'golden', 'nocturnal', 'spectral', 'shiny']);
const LANGS = Object.freeze(['js', 'ts', 'py', 'rust', 'go', 'jvm', 'cs', 'rb', 'php', 'git', 'ci']);
const DEVICE_RE = /^[a-z0-9-]{4,40}$/;
const PROJECT_RE = /^[0-9a-z]{6,40}$/i;
const HEX12 = /^[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 3;                           // this month and the two before, for the friends' board (board.js)
const LOCAL = 'local';

const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);
// Bounded: a corrupt or hostile gist can't make a count Infinity (merge keeps the larger).
const MAX_COUNT = 1e6;
const count = v => Math.min(MAX_COUNT, Math.floor(pos(v)));
const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : 0);
const sum = map => Object.values(map).reduce((n, v) => n + v, 0);
const monthKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** A { device: n } map: known-looking device ids, positive counts, at most MAX_DEVICES. */
function deviceMap(raw, { keepLocal = true } = {}) {
  return Object.fromEntries(Object.entries(obj(raw))
    .filter(([k, v]) => DEVICE_RE.test(k) && (keepLocal || k !== LOCAL) && count(v) > 0)
    .map(([k, v]) => [k, count(v)]).sort((a, b) => b[1] - a[1]).slice(0, MAX_DEVICES));
}

const listOf = (raw, allowed, max) => [...new Set((Array.isArray(raw) ? raw : []).filter(x => allowed.includes(x)))].slice(0, max);

function cleanEntry(raw, { keepLocal = true } = {}) {
  const e = obj(raw);
  return {
    byDevice: deviceMap(e.byDevice, { keepLocal }),
    seen: count(e.seen),
    first: pos(e.first), last: pos(e.last), fastest: pos(e.fastest),
    escapes: deviceMap(e.escapes, { keepLocal }),
    forms: listOf(e.forms, FORMS, FORMS.length),
    langs: listOf(e.langs, LANGS, LANGS.length),
    projects: (Array.isArray(e.projects) ? e.projects : []).filter(p => typeof p === 'string' && PROJECT_RE.test(p)).slice(0, MAX_PROJECTS),
    seenAt: pos(e.seenAt), lastEscapeAt: pos(e.lastEscapeAt),
  };
}

const HABITAT_IDS = new Set(HABITATS.map(h => h.id));

/** One PC's count for a month. */
function cleanTally(raw) {
  const r = obj(raw);
  const habitats = {};
  for (const [id, n] of Object.entries(obj(r.habitats))) if (HABITAT_IDS.has(id) && count(n)) habitats[id] = count(n);
  return { jars: count(r.jars), shinies: count(r.shinies), habitats };
}

/** The last few months' catches, per PC: { 'YYYY-MM': { device: tally } }. */
function cleanMonths(raw, { keepLocal = true } = {}) {
  const out = {};
  const keys = Object.keys(obj(raw)).filter(k => MONTH_RE.test(k)).sort().slice(-MAX_MONTHS);
  for (const k of keys) {
    const devs = {};
    for (const [dev, t] of Object.entries(obj(raw[k])).slice(0, MAX_DEVICES)) {
      if (!DEVICE_RE.test(dev) || (!keepLocal && dev === LOCAL)) continue;
      const tally = cleanTally(t);
      if (tally.jars) devs[dev] = tally;
    }
    if (Object.keys(devs).length) out[k] = devs;
  }
  return out;
}

const maxTally = (a, b) => {
  const x = cleanTally(a), y = cleanTally(b);
  const habitats = {};
  for (const id of new Set([...Object.keys(x.habitats), ...Object.keys(y.habitats)])) habitats[id] = Math.max(own(x.habitats, id), own(y.habitats, id));
  return { jars: Math.max(x.jars, y.jars), shinies: Math.max(x.shinies, y.shinies), habitats };
};
function mergeMonths(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const devs = {};
    for (const dev of new Set([...Object.keys(a[k] || {}), ...Object.keys(b[k] || {})])) devs[dev] = maxTally(a[k]?.[dev], b[k]?.[dev]);
    out[k] = devs;
  }
  return cleanMonths(out);
}

/** A month's catches, every PC together: { jars, shinies, habitats }. */
function monthOf(stateIn, key) {
  const s = normalize(stateIn);
  const devs = Object.values(s.months[key] || {});
  const habitats = {};
  for (const t of devs) for (const [id, n] of Object.entries(t.habitats)) habitats[id] = (habitats[id] || 0) + n;
  return { jars: devs.reduce((n, t) => n + t.jars, 0), shinies: devs.reduce((n, t) => n + t.shinies, 0), habitats };
}

const caughtOf = entry => sum(entry?.byDevice || {});
const stageOf = caught => STAGES.filter(n => caught >= n).length;

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = obj(raw);
  const species = {};
  for (const [id, e] of Object.entries(obj(r.species))) if (BY_ID.has(id)) species[id] = cleanEntry(e);
  const habitats = {};
  for (const [id, h] of Object.entries(obj(r.habitats))) {
    if (HABITATS.some(x => x.id === id) && pos(h?.doneAt)) habitats[id] = { doneAt: pos(h.doneAt), of: count(h.of) };
  }
  const recent = {};
  for (const [k, v] of Object.entries(obj(r.recent)).slice(-MAX_RECENT)) {
    const [p, fp] = k.split('|');
    if (PROJECT_RE.test(p || '') && HEX12.test(fp || '')) recent[k] = { caughtAt: pos(v?.caughtAt), paidAt: pos(v?.paidAt), escapedAt: pos(v?.escapedAt) };
  }
  const day = typeof r.day === 'string' && DAY_RE.test(r.day) ? r.day : null;
  const todayBySpecies = Object.fromEntries(Object.entries(obj(r.todayBySpecies)).filter(([k, v]) => BY_ID.has(k) && count(v)).map(([k, v]) => [k, count(v)]));
  return {
    v: 1,
    species, habitats,
    open: lifecycle.normalizeOpen(r.open),
    recent,
    day, today: count(r.today), todayBySpecies,
    log: (Array.isArray(r.log) ? r.log : []).filter(e => e && BY_ID.has(e.species) && pos(e.at))
      .map(e => ({ at: e.at, species: e.species, form: FORMS.includes(e.form) ? e.form : null, new: e.new === true, project: typeof e.project === 'string' ? e.project.slice(0, 80) : null }))
      .slice(0, MAX_LOG),
    favourite: BY_ID.has(r.favourite) && caughtOf(species[r.favourite]) > 0 ? r.favourite : null,
    unseen: (Array.isArray(r.unseen) ? r.unseen : []).filter(id => caughtOf(species[id]) > 0).slice(-60),
    lastMomentAt: pos(r.lastMomentAt),
    // When the book was started over: sync drops counts from before it (see merge).
    resetAt: pos(r.resetAt),
    // Catches per month, per PC, for the friends' board (board.js). Synced like the counts.
    months: cleanMonths(r.months),
    // Jars friends brought when they visited: decoration, never a catch (and never synced).
    gifts: (Array.isArray(r.gifts) ? r.gifts : [])
      .filter(g => g && BY_ID.has(g.species) && g.species !== 'missingno' && typeof g.from === 'string' && LOGIN_RE.test(g.from) && pos(g.at))
      .map(g => ({ species: g.species, from: g.from, at: g.at })).slice(0, MAX_GIFTS),
  };
}

const entryOf = (state, id) => state.species[id] || cleanEntry(null);
const totalCaught = state => Object.values(state.species).reduce((n, e) => n + caughtOf(e), 0);

// ------------------------------------------------------------------ seeing

/**
 * A failure showed a bug. It's seen (a silhouette from now on); and if this
 * very bug was caught in this project lately, it got away.
 *   enc: { species, fp, project }
 * -> { state, escaped }
 */
function recordSeen(stateIn, { species, fp, project }, now, { device = LOCAL } = {}) {
  const state = normalize(stateIn);
  if (!BY_ID.has(species)) return { state, escaped: false };
  const e = entryOf(state, species);
  const key = `${project}|${fp}`;
  const r = state.recent[key];
  // Once per catch: a bug that keeps failing after it got away got away once.
  const escaped = !!r?.caughtAt && now - r.caughtAt < ESCAPE_MS && caughtOf(e) > 0 && !(r.escapedAt > r.caughtAt);
  const dev = DEVICE_RE.test(device) ? device : LOCAL;
  const next = {
    ...e, seen: e.seen + 1, seenAt: now,
    ...(escaped ? { escapes: { ...e.escapes, [dev]: own(e.escapes, dev) + 1 }, lastEscapeAt: now } : {}),
  };
  const recent = escaped ? { ...state.recent, [key]: { ...r, escapedAt: now } } : state.recent;
  return { state: { ...state, species: { ...state.species, [species]: next }, recent }, escaped };
}

// ------------------------------------------------------------------ catching

const isNight = t => new Date(t).getHours() < 5;

/**
 * Habitats this catch just finished: every live member caught, and not done before.
 * A habitat stays done when later phases add members; it shows how many are new.
 */
function finishedHabitats(state, now) {
  const done = [];
  const habitats = { ...state.habitats };
  for (const h of HABITATS) {
    if (habitats[h.id]) continue;
    const members = h.members.filter(id => live().some(s => s.id === id));
    if (members.length && members.every(id => caughtOf(state.species[id]) > 0)) {
      habitats[h.id] = { doneAt: now, of: members.length };
      done.push(h.id);
    }
  }
  return { habitats, done };
}

/**
 * A bug was fixed: catch it.
 *   c: { species, fp, project, name?, firstAt, firstTry, remedy, lang, device, seasons, rand, shinyBoost }
 *   shinyBoost: a tide event's (events.js boostsAt), 1 to 4 times the odds
 * -> { state, counted, pays, isNew, forms, stage, evolved, completed, moment }
 *   counted: false inside the cooldown or past the day's caps ("seen again", nothing else)
 *   pays:    whether it pays XP (once a week per bug and project)
 *   evolved: the new stage when this catch reached one (2-4), else 0
 *   moment:  whether he should make a show of it (new, evolved, rare, or not lately)
 */
function recordCatch(stateIn, c, now) {
  let state = normalize(stateIn);
  const sp = speciesById(c.species);
  const none = { state, counted: false, pays: false, isNew: false, forms: [], stage: 0, evolved: 0, completed: [], moment: false, badge: null, league: null, fame: false };
  if (!sp || !Number.isFinite(now)) return none;
  const key = `${c.project}|${c.fp}`;
  const r = state.recent[key] || { caughtAt: 0, paidAt: 0 };
  const today = dayKey(now);
  if (state.day !== today) state = { ...state, day: today, today: 0, todayBySpecies: {} };
  if ((r.caughtAt && now - r.caughtAt < CATCH_COOLDOWN) || state.today >= DAY_CAP || own(state.todayBySpecies, sp.id) >= SPECIES_DAY_CAP) {
    return { ...none, state };
  }
  const rand = typeof c.rand === 'function' ? c.rand : Math.random;
  const firstTry = !!c.firstTry && !c.remedy;
  const swift = !c.remedy && pos(c.firstAt) > 0 && now - c.firstAt <= SWIFT_MS;
  const forms = [
    ...(firstTry ? ['first-try'] : []), ...(swift ? ['swift'] : []), ...(firstTry && swift ? ['golden'] : []),
    ...(isNight(now) ? ['nocturnal'] : []),
    ...(sp.habitat === 'wreck' && (c.seasons || []).includes('halloween') ? ['spectral'] : []),
    ...(rand() < SHINY_CHANCE * Math.max(1, Math.min(4, Number(c.shinyBoost) || 1)) ? ['shiny'] : []),
  ];
  const e = entryOf(state, sp.id);
  const before = caughtOf(e);
  const dev = DEVICE_RE.test(c.device || '') ? c.device : LOCAL;
  const took = pos(c.firstAt) ? Math.max(1, now - c.firstAt) : 0;
  const next = {
    ...e,
    byDevice: { ...e.byDevice, [dev]: own(e.byDevice, dev) + 1 },
    first: e.first || now, last: now,
    fastest: took && (!e.fastest || took < e.fastest) ? took : e.fastest,
    forms: listOf([...e.forms, ...forms], FORMS, FORMS.length),
    langs: listOf([...e.langs, c.lang], LANGS, LANGS.length),
    projects: PROJECT_RE.test(c.project || '') ? [...new Set([...e.projects, c.project])].slice(0, MAX_PROJECTS) : e.projects,
    seen: Math.max(e.seen, 1),
  };
  const pays = !r.paidAt || now - r.paidAt >= PAY_COOLDOWN;
  const stageBefore = stageOf(before), stage = stageOf(before + 1);
  const isNew = before === 0;
  state = {
    ...state,
    species: { ...state.species, [sp.id]: next },
    recent: Object.fromEntries([...Object.entries(state.recent).filter(([k]) => k !== key), [key, { caughtAt: now, paidAt: pays ? now : r.paidAt, escapedAt: 0 }]].slice(-MAX_RECENT)),
    today: state.today + 1,
    todayBySpecies: { ...state.todayBySpecies, [sp.id]: own(state.todayBySpecies, sp.id) + 1 },
    unseen: [...state.unseen.filter(id => id !== sp.id), sp.id].slice(-60),
    log: [{ at: now, species: sp.id, form: forms.includes('golden') ? 'golden' : forms[0] || null, new: isNew, project: typeof c.name === 'string' ? c.name.slice(0, 80) : null }, ...state.log].slice(0, MAX_LOG),
    months: tallied(state.months, monthKey(now), dev, sp, forms.includes('shiny')),
  };
  const fin = finishedHabitats(state, now);
  state = { ...state, habitats: fin.habitats };
  // A boss's first catch is its habitat's badge; the league's first catches count toward the Hall of Fame.
  const badge = isNew && bossOf(sp.id) ? bossOf(sp.id).id : null;
  const league = isNew ? leagueOf(sp.id) : null;
  const fame = !!(badge || league) && !hallOf(stateIn) && !!hallOf(state);
  const evolved = stage > stageBefore && stage >= 2 ? stage : 0;
  const loud = isNew || evolved || fin.done.length || sp.rarity === 'rare' || sp.rarity === 'legendary' || forms.includes('golden') || forms.includes('shiny') || badge || league;
  const moment = !!loud || now - state.lastMomentAt >= MOMENT_GAP;
  if (moment) state = { ...state, lastMomentAt: now };
  return { state, counted: true, pays, isNew, forms, stage, evolved, completed: fin.done, moment, badge, league, fame };
}

/** This month's tally with one more catch in it. */
function tallied(months, key, dev, sp, shiny) {
  const was = cleanTally(months[key]?.[dev]);
  const habitats = sp.habitat ? { ...was.habitats, [sp.habitat]: own(was.habitats, sp.habitat) + 1 } : was.habitats;
  return cleanMonths({ ...months, [key]: { ...(months[key] || {}), [dev]: { jars: was.jars + 1, shinies: was.shinies + (shiny ? 1 : 0), habitats } } });
}

// ------------------------------------------------------------------ encounters (see lifecycle.js)

/** Open (or refresh) an encounter, and count the species as seen. -> { state, isNew, escaped } */
function spot(stateIn, enc, now, opts = {}) {
  const state = normalize(stateIn);
  const o = lifecycle.open(state.open, enc, now);
  if (!o.enc) return { state, isNew: false, escaped: false };
  const s = recordSeen({ ...state, open: o.list }, enc, now, opts);
  return { state: s.state, isNew: o.isNew, escaped: s.escaped };
}

const withOpen = (stateIn, fn) => { const s = normalize(stateIn); return { ...s, open: fn(s.open) }; };
const engage = (s, project, now) => withOpen(s, l => lifecycle.engage(l, project, now));
const engageKey = (s, source, key) => withOpen(s, l => lifecycle.engageKey(l, source, key));
const refuse = (s, id, reason) => withOpen(s, l => lifecycle.refuse(l, id, reason));
const closeEncounter = (s, id) => withOpen(s, l => lifecycle.close(l, id));
const prune = (s, now) => withOpen(s, l => lifecycle.prune(l, now));

// ------------------------------------------------------------------ words

/** His line when he jars it: 24 characters at most, like gifts.foundLine. */
function catchLine(id, { isNew = false, forms = [], evolved = 0, rand = Math.random } = {}) {
  const sp = speciesById(id);
  if (!sp) return 'gotcha!';
  const pick = xs => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];
  const short = sp.name.toLowerCase();
  let options;
  if (forms.includes('golden')) options = ['golden catch!', 'first try, too!'];
  else if (forms.includes('shiny')) options = ['a shiny one!!', 'it sparkles!'];
  else if (evolved) options = ['it evolved!', 'look, it grew!'];
  else if (sp.rarity === 'legendary') options = ['LEGENDARY!!', 'we got it!!'];
  else if (sp.rarity === 'rare') options = ['a rare one!!', `${short}!!`];
  else if (isNew) options = ['new one for the dex!', 'gotcha!!', `${short}!`];
  else options = ['in the jar!', 'gotcha', 'another one!'];
  const fits = options.filter(l => l.length <= 24);
  return pick(fits.length ? fits : ['gotcha!']);
}

/** What a species' tile says until it's caught. */
function hintFor(sp, entry) {
  if (entry?.seen) return `${sp.hint} Fix one to catch it.`;
  return sp.hint;
}

/** The name it goes by at a stage: the starters evolve into new names. */
function nameAt(sp, stage) {
  if (!sp.evolves || stage < 2) return sp.name;
  return stage === 2 ? sp.evolves[0] : sp.evolves[1];
}

/** The one he shows off: the one you picked, else the rarest caught (latest first on a tie). */
const RANK = { legendary: 4, special: 3, rare: 2, uncommon: 1, common: 0 };
function favourite(stateIn) {
  const s = normalize(stateIn);
  if (s.favourite) return s.favourite;
  const caught = Object.entries(s.species).filter(([, e]) => caughtOf(e) > 0).map(([id, e]) => ({ id, sp: BY_ID.get(id), last: e.last }));
  caught.sort((a, b) => RANK[b.sp.rarity] - RANK[a.sp.rarity] || b.last - a.last);
  return caught[0]?.id || null;
}

/** The art a species shows: its best form, at its stage. */
function artFor(sp, entry) {
  const forms = entry?.forms || [];
  return art.staged(art.formed(sp, forms), stageOf(caughtOf(entry)), sp.rarity);
}

/** The jar he holds up for a catch. */
function jarFor(id, forms = []) {
  const sp = speciesById(id);
  return sp ? art.jarArt(art.formed(sp, forms)) : null;
}

// ------------------------------------------------------------------ badges and the league

const firstOf = (state, id) => (caughtOf(state.species[id]) > 0 ? state.species[id].first || 1 : 0);

/**
 * When you made the Hall of Fame (every badge, the Deep Four and the
 * champion), or 0. Worked out from the book, so sync needs nothing new.
 */
function hallOf(stateIn) {
  const s = normalize(stateIn);
  const ids = [...HABITATS.map(h => h.boss), ...LEAGUE.elite, LEAGUE.champion];
  const firsts = ids.map(id => firstOf(s, id));
  return firsts.every(Boolean) ? Math.max(...firsts) : 0;
}

/** The badge case and the league, as the page draws them (nothing you haven't earned in colour). */
function leagueView(stateIn) {
  const s = normalize(stateIn);
  const known = id => caughtOf(s.species[id]) > 0 || !!s.species[id]?.seen;
  const badges = HABITATS.map(h => {
    const at = firstOf(s, h.boss);
    return {
      habitat: h.id, habitatName: h.name, icon: h.icon, name: h.badge.name, earned: !!at, at,
      boss: known(h.boss) ? BY_ID.get(h.boss).name : null,
      ...(at ? { pixels: h.badge.pixels, palette: h.badge.palette } : art.silhouette(h.badge)),
    };
  });
  const member = (id, rank) => {
    const sp = BY_ID.get(id);
    const at = firstOf(s, id);
    return { id, rank, at, beaten: !!at, name: known(id) ? sp.name : '???', ...(at ? { pixels: sp.pixels, palette: sp.palette } : known(id) ? art.silhouette(sp) : {}) };
  };
  const earned = badges.filter(b => b.earned).length;
  return {
    badges, earned, of: badges.length,
    // The league opens once you hold every badge; until then it's who's waiting.
    open: earned === badges.length,
    elite: LEAGUE.elite.map(id => member(id, 'elite')),
    champion: member(LEAGUE.champion, 'champion'),
    hall: hallOf(s),
  };
}

// ------------------------------------------------------------------ friends

/**
 * What a visiting friend brings: a jar of one of their own catches, picked by
 * who they are and the day, preferring one you haven't caught. Null when their
 * card doesn't share their Bugdex, they've caught nothing, or they already
 * brought one today.
 */
function giftFor(stateIn, login, theirs, now) {
  const s = normalize(stateIn);
  const ids = (Array.isArray(theirs) ? theirs : []).filter(id => BY_ID.has(id) && id !== 'missingno');
  if (!ids.length || !LOGIN_RE.test(login || '')) return null;
  const day = dayKey(now);
  if (s.gifts.some(g => g.from.toLowerCase() === login.toLowerCase() && dayKey(g.at) === day)) return null;
  const fresh = ids.filter(id => !(caughtOf(s.species[id]) > 0));
  const pool = [...(fresh.length ? fresh : ids)].sort();
  let h = 2166136261;
  for (const ch of `${login.toLowerCase()}|${day}`) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return pool[h % pool.length];
}

/** Keep a friend's gift jar. */
function addGift(stateIn, { species, from }, now) {
  const s = normalize(stateIn);
  if (!BY_ID.has(species) || species === 'missingno' || !LOGIN_RE.test(from || '') || !pos(now)) return s;
  return normalize({ ...s, gifts: [{ species, from, at: now }, ...s.gifts] });
}

/** How many gift jars of each species: { id: n }. */
function giftCounts(stateIn) {
  const out = {};
  for (const g of normalize(stateIn).gifts) out[g.species] = (out[g.species] || 0) + 1;
  return out;
}

/** A friend's shared Bugdex as their card carries it (github/card.js), cleaned. */
function cleanShared(raw) {
  const r = obj(raw);
  const caught = [...new Set((Array.isArray(r.caught) ? r.caught : []).filter(id => typeof id === 'string' && BY_ID.has(id)))].slice(0, SPECIES.length);
  const m = obj(r.month);
  const month = MONTH_RE.test(m.key || '') ? { key: m.key, ...cleanTally(m) } : null;
  return { caught, badges: Math.min(HABITATS.length, count(r.badges)), hall: r.hall === true, month };
}

/**
 * What your card says about your Bugdex when you share it: which kinds, badges,
 * and this month's catches for the friends' board (how many, how many
 * sparkly, in which habitats). No projects, no errors, no bug's own count.
 */
function shared(stateIn, now = Date.now()) {
  const s = normalize(stateIn);
  const l = leagueView(s);
  const key = monthKey(now);
  return { caught: Object.keys(s.species).filter(id => caughtOf(s.species[id]) > 0).sort(), badges: l.earned, hall: !!l.hall, month: { key, ...monthOf(s, key) } };
}

// ------------------------------------------------------------------ the view

/**
 * Everything the Bugdex page shows. Unknown species come with no pixels (no
 * spoilers); seen ones as silhouettes.
 *   opts: { names: { projectId: name }, tabs: Set of open tab ids,
 *           event: { on: the tide event going on or null, back: { eventId: when it's next on (ms) } } }
 */
function view(stateIn, now, { names = {}, tabs = null, friends = [], event = null } = {}) {
  const state = prune(stateIn, now);
  // Friends who share their Bugdex: who has caught what.
  const pals = (Array.isArray(friends) ? friends : []).filter(f => f && LOGIN_RE.test(f.login || '')).slice(0, 30)
    .map(f => ({ login: f.login, ...cleanShared(f.bugdex) }));
  const reporters = id => pals.filter(f => f.caught.includes(id)).map(f => f.login).slice(0, 3);
  const gifts = giftCounts(state);
  const giftFrom = id => [...new Set(state.gifts.filter(g => g.species === id).map(g => g.from))].slice(0, 3);
  const fav = favourite(state);
  const ids = new Set(live().map(s => s.id));
  // A tide event's own bug is in the book while its event is on, and for good once caught.
  const eventOn = event && typeof event.on === 'string' ? event.on : null;
  const backOf = sp => (sp.event && event?.back && Number.isFinite(event.back[sp.event]) ? event.back[sp.event] : 0);
  const shown = SPECIES.filter(sp => ids.has(sp.id) || caughtOf(state.species[sp.id]) > 0 || (sp.event && sp.event === eventOn));
  const species = shown.map(sp => {
    const e = state.species[sp.id];
    const caught = caughtOf(e);
    const st = caught > 0 ? 'caught' : e?.seen ? 'seen' : 'unknown';
    const stage = stageOf(caught);
    const next = STAGES.find(n => n > caught);
    const base = {
      no: sp.no, id: sp.id, state: st, habitat: sp.habitat, rarity: sp.rarity, rarityLabel: RARITY[sp.rarity].label,
      type: sp.type, typeLabel: TYPES[sp.type]?.label || '', typeColor: TYPES[sp.type]?.color || '#888888',
      isNew: state.unseen.includes(sp.id),
      boss: bossOf(sp.id)?.id || null, league: leagueOf(sp.id),
      reportedBy: reporters(sp.id), gifts: gifts[sp.id] || 0, giftFrom: giftFrom(sp.id),
      event: sp.event, eventOn: !!sp.event && sp.event === eventOn, back: backOf(sp),
    };
    // Out now: its name and shape are the point (the event says how to catch it).
    if (st === 'unknown' && base.eventOn) return { ...base, state: 'event', name: sp.name, blurb: sp.hint, ...art.silhouette(sp) };
    // A friend's report (or a jar they brought) puts a name and a silhouette to one you've never met.
    if (st === 'unknown' && (base.reportedBy.length || base.gifts)) return { ...base, state: 'reported', name: sp.name, blurb: sp.hint, ...art.silhouette(sp) };
    if (st === 'unknown') return { ...base, name: '???', blurb: sp.habitat ? `Lives in ${HABITATS.find(h => h.id === sp.habitat).name}.` : 'Nobody knows where it lives.' };
    if (st === 'seen') return { ...base, name: sp.name, blurb: hintFor(sp, e), ...art.silhouette(sp), seenCount: e.seen, seenAt: e.seenAt };
    const forGood = now - e.last >= ESCAPE_MS && e.lastEscapeAt < e.last;
    return {
      ...base, name: nameAt(sp, stage), baseName: sp.name,
      nextName: sp.evolves && stage < 3 ? sp.evolves[Math.max(0, stage - 1)] : null,
      blurb: sp.blurb, ...artFor(sp, e),
      stage, toNext: next ? next - caught : 0,
      caught, seenCount: e.seen, first: e.first, last: e.last, fastest: e.fastest, escapes: sum(e.escapes),
      forms: [...e.forms, ...(forGood ? ['for-good'] : [])], langs: e.langs,
      firstProject: names[e.projects[0]] || null,
      // The field note at stage II, the tip at stage III: until then, how many catches off they are.
      ...loreAt(sp.id, caught),
    };
  });
  const loose = state.open.map(enc => {
    const sp = BY_ID.get(enc.species);
    return {
      id: lifecycle.encId(enc), species: enc.species, name: sp.name, project: enc.name || names[enc.project] || '',
      at: enc.at, engaged: enc.engaged, refused: enc.refused, source: enc.source,
      tabId: enc.tabId && (!tabs || tabs.has(enc.tabId)) ? enc.tabId : null,
      ...art.silhouette(sp),
    };
  });
  const habitats = HABITATS.map(h => {
    const members = h.members.filter(id => ids.has(id));
    const have = members.filter(id => caughtOf(state.species[id]) > 0).length;
    const done = state.habitats[h.id];
    return { id: h.id, name: h.name, icon: h.icon, have, of: members.length, done: !!done, added: done && done.of < members.length ? members.length - done.of : 0, members };
  });
  const caughtList = species.filter(s => s.state === 'caught');
  return {
    caught: caughtList.filter(s => ids.has(s.id)).length,
    seen: species.filter(s => s.state === 'caught' || s.state === 'seen').length, // a friend's report isn't your sighting
    of: ids.size,
    jars: totalCaught(state),
    favourite: fav,
    unseen: state.unseen,
    loose, habitats, species,
    log: state.log.slice(0, 10).map(l => ({ ...l, name: BY_ID.get(l.species).name })),
    types: Object.entries(TYPES).map(([id, t]) => ({ id, ...t })),
    league: leagueView(state),
    friends: pals.map(f => ({ login: f.login, caught: f.caught.filter(id => ids.has(id)).length, badges: f.badges, hall: f.hall })),
  };
}

function loreAt(id, caught) {
  const l = loreOf(id);
  if (!l) return { note: null, tip: null, noteIn: 0, tipIn: 0 };
  return {
    note: caught >= STAGES[1] ? l.note : null, noteIn: Math.max(0, STAGES[1] - caught),
    tip: caught >= STAGES[2] ? l.tip : null, tipIn: Math.max(0, STAGES[2] - caught),
  };
}

/** The page has been looked at. */
const markSeen = stateIn => ({ ...normalize(stateIn), unseen: [] });

/** Pick the one he shows off (null goes back to the rarest). */
function setFavourite(stateIn, id) {
  const s = normalize(stateIn);
  if (id != null && !(caughtOf(s.species[id]) > 0)) return s;
  return { ...s, favourite: id || null };
}

/** A short line for the crab card and the week: "Bugdex 14/66". */
function summary(stateIn) {
  const s = normalize(stateIn);
  const ids = new Set(live().map(x => x.id));
  return { caught: Object.entries(s.species).filter(([id, e]) => ids.has(id) && caughtOf(e) > 0).length, of: ids.size, jars: totalCaught(s) };
}

/** The tide pool's swimmers: the most recently caught species, as specks. */
function poolOf(stateIn, max = 8) {
  const s = normalize(stateIn);
  return Object.entries(s.species).filter(([, e]) => caughtOf(e) > 0).sort((a, b) => b[1].last - a[1].last).slice(0, max)
    .map(([id, e]) => ({ id, name: BY_ID.get(id).name, ...art.micro(artFor(BY_ID.get(id), { ...e, byDevice: { x: 1 } })) }));
}

// ------------------------------------------------------------------ sync

/** What goes in the sync gist: species counts and habitats, nothing about projects or bugs. */
function syncable(stateIn) {
  const s = normalize(stateIn);
  const species = {};
  for (const [id, e] of Object.entries(s.species)) {
    const { byDevice, seen, first, last, fastest, escapes, forms, langs } = e;
    species[id] = { byDevice, seen, first, last, fastest, escapes, forms, langs };
  }
  return { species, habitats: s.habitats, resetAt: s.resetAt, months: s.months };
}

/** Another PC's syncable part, cleaned (its 'local' bucket means nothing here). */
function normalizeSync(raw) {
  const r = obj(raw);
  const species = {};
  for (const [id, e] of Object.entries(obj(r.species))) {
    if (!BY_ID.has(id)) continue;
    const { projects: _p, seenAt: _s, lastEscapeAt: _l, ...rest } = cleanEntry(e, { keepLocal: false });
    species[id] = rest;
  }
  return { species, habitats: normalize({ habitats: r.habitats }).habitats, resetAt: Math.min(pos(r.resetAt), 8.64e15), months: cleanMonths(r.months, { keepLocal: false }) };
}

const minPos = (a, b) => (a && b ? Math.min(a, b) : a || b);
const maxMap = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, Math.max(own(a, k), own(b, k))]));

/** Two PCs' books together: each PC's own count, the larger; firsts the earliest; forms joined. Only ever grows. */
function merge(aIn, bIn) {
  // A book started over wins: whatever the other side counted before that is gone.
  const resetAt = Math.max(normalizeSync(aIn).resetAt, normalizeSync(bIn).resetAt);
  const kept = raw => { const x = normalizeSync(raw); return x.resetAt >= resetAt ? x : { species: {}, habitats: {}, resetAt, months: {} }; };
  const a = kept(aIn), b = kept(bIn);
  const species = {};
  for (const id of new Set([...Object.keys(a.species), ...Object.keys(b.species)])) {
    const x = a.species[id] || cleanEntry(null), y = b.species[id] || cleanEntry(null);
    species[id] = {
      byDevice: maxMap(x.byDevice, y.byDevice), seen: Math.max(x.seen, y.seen),
      first: minPos(x.first, y.first), last: Math.max(x.last, y.last), fastest: minPos(x.fastest, y.fastest),
      escapes: maxMap(x.escapes, y.escapes),
      forms: listOf([...x.forms, ...y.forms], FORMS, FORMS.length), langs: listOf([...x.langs, ...y.langs], LANGS, LANGS.length),
    };
  }
  const habitats = {};
  for (const id of new Set([...Object.keys(a.habitats), ...Object.keys(b.habitats)])) {
    const x = a.habitats[id], y = b.habitats[id];
    habitats[id] = { doneAt: minPos(x?.doneAt || 0, y?.doneAt || 0), of: Math.max(x?.of || 0, y?.of || 0) };
  }
  return { species, habitats, resetAt, months: mergeMonths(a.months, b.months) };
}

/** This PC's book with the merged counts in, keeping what never leaves it. */
function applySync(localIn, merged) {
  const m = normalizeSync(merged);
  const was = normalize(localIn);
  // Started over on another PC: this one starts over too (what's on the loose here stays).
  const local = was.resetAt < m.resetAt ? normalize({ open: was.open, resetAt: m.resetAt }) : was;
  const species = { ...local.species };
  for (const [id, e] of Object.entries(m.species)) {
    const mine = local.species[id] || cleanEntry(null);
    // This PC's own buckets (and its 'local' one) stay its own; the merge can only raise them.
    const both = merge({ species: { [id]: { ...mine, byDevice: Object.fromEntries(Object.entries(mine.byDevice).filter(([k]) => k !== LOCAL)) } } }, { species: { [id]: e } }).species[id];
    species[id] = { ...mine, ...both, byDevice: { ...both.byDevice, ...(own(mine.byDevice, LOCAL) ? { [LOCAL]: mine.byDevice[LOCAL] } : {}) }, projects: mine.projects, seenAt: mine.seenAt, lastEscapeAt: mine.lastEscapeAt };
  }
  return normalize({ ...local, species, habitats: { ...m.habitats, ...local.habitats }, months: mergeMonths(local.months, m.months) });
}

/** Move catches made before this PC had its id onto it (xp.js withDevice does the same for XP). */
function withDevice(stateIn, device) {
  const s = normalize(stateIn);
  if (!DEVICE_RE.test(device || '') || device === LOCAL) return s;
  let changed = false;
  const species = Object.fromEntries(Object.entries(s.species).map(([id, e]) => {
    const n = own(e.byDevice, LOCAL);
    if (!n) return [id, e];
    changed = true;
    const { [LOCAL]: _, ...rest } = e.byDevice;
    return [id, { ...e, byDevice: { ...rest, [device]: own(rest, device) + n } }];
  }));
  const months = {};
  let moved = false;
  for (const [k, devs] of Object.entries(s.months)) {
    const { [LOCAL]: mine, ...rest } = devs;
    if (mine) { moved = true; rest[device] = { ...maxTally(rest[device], null), jars: (rest[device]?.jars || 0) + mine.jars, shinies: (rest[device]?.shinies || 0) + mine.shinies, habitats: Object.fromEntries([...new Set([...Object.keys(mine.habitats), ...Object.keys(rest[device]?.habitats || {})])].map(id => [id, own(mine.habitats, id) + own(rest[device]?.habitats || {}, id)])) }; }
    months[k] = rest;
  }
  return changed || moved ? { ...s, species, months } : s;
}

module.exports = {
  STAGES, CATCH_COOLDOWN, PAY_COOLDOWN, SPECIES_DAY_CAP, DAY_CAP, ESCAPE_MS, SWIFT_MS, SHINY_CHANCE, MOMENT_GAP, FORMS,
  normalize, recordSeen, recordCatch, spot, engage, engageKey, refuse, closeEncounter, prune,
  catchLine, nameAt, favourite, jarFor, artFor, view, markSeen, setFavourite, summary, poolOf,
  hallOf, leagueView, giftFor, addGift, giftCounts, cleanShared, shared,
  syncable, normalizeSync, merge, applySync, withDevice, caughtOf, stageOf,
  monthKey, monthOf, MONTH_RE,
};
