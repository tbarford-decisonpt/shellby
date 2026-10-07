// The crew: one lasting helper crab per agent type. Every subagent Claude sends
// out (Explore, code-reviewer, the agents you write yourself) is a run for the
// crew member of its type, who keeps a record: runs, failures, findings acted
// on, tokens, a level, a name and a hat. Pure: no I/O, no clock (callers pass
// `now`). See test/crew-roster.test.js; wiring/crew.js feeds it.
//
// "Acted on" is the closest honest signal there is: after the helper finished,
// Claude itself went on to change files in that turn (wiring/crew.js decides).

const MAX_MEMBERS = 40;
const RECENT_KEPT = 5;
const TYPE_MAX = 60;
const NAME_MAX = 24;
const WHAT_MAX = 120;
const MAX_LEVEL = 99;
// level = 1 + floor(sqrt(xp / XP_STEP)): early levels come quick, later ones slow.
const XP_STEP = 12;
const XP = Object.freeze({ completed: 10, failed: 2, actedOn: 15, beat: 8 });
// Bug battles (bugdex/battle.js): a member who helped beat this many bugs of
// one type is that type's specialist, and super effective against it.
const SPECIALTY_AT = 3;
const BUG_TYPES = new Set(Object.keys(require('./bugdex/species').TYPES));

// Hats a crew member earns by its own level (wardrobe ids from base.pack.json).
const HAT_LADDER = Object.freeze([
  [1, 'beanie'], [3, 'hard-hat'], [5, 'headphones'], [8, 'captains-hat'],
  [12, 'wizard-hat'], [16, 'top-hat'], [20, 'crown'],
]);
const HAT_CHOICES = new Set(['auto', 'none', 'match', ...HAT_LADDER.map(([, id]) => id)]);

const TITLES = Object.freeze([
  [1, 'Deckhand'], [3, 'Swabbie'], [5, 'Able Crab'], [8, 'Boatswain'],
  [12, 'Quartermaster'], [16, 'First Mate'], [20, 'Old Salt'], [30, 'Legend of the Fleet'],
]);

const NAMES = Object.freeze([
  'Pinchy', 'Barnacle', 'Clawdia', 'Kelpie', 'Scuttle', 'Pebble', 'Marina', 'Shelldon',
  'Bubbles', 'Nibbles', 'Coral', 'Periwinkle', 'Salty', 'Moss', 'Tidus', 'Sandy',
  'Wade', 'Brine', 'Nori', 'Skipper', 'Limpet', 'Cockle', 'Dory', 'Reef',
  'Sculpin', 'Wrack', 'Puddle', 'Mussel', 'Gill', 'Cove',
]);
// Helper crabs are his colours, hue-shifted; each crew member keeps its own shift.
const HUES = Object.freeze([0, 145, 250, 60, 300, 200, 30, 330]);

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** An agent type as a roster key: trimmed, capped, never a prototype name. */
function typeKey(type) {
  const t = String(type ?? '').trim().slice(0, TYPE_MAX);
  if (!t) return 'general-purpose';
  return BAD_KEYS.has(t) ? `agent-${t}` : t;
}

/** A name for a type, stable, skipping names already taken. */
function nameFor(type, taken = new Set()) {
  const start = hash(typeKey(type));
  for (let i = 0; i < NAMES.length; i++) {
    const n = NAMES[(start + i) % NAMES.length];
    if (!taken.has(n)) return n;
  }
  let k = 2;
  const base = NAMES[start % NAMES.length];
  while (taken.has(`${base} ${k}`)) k++;
  return `${base} ${k}`;
}

const count = n => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const time = n => (Number.isFinite(n) && n > 0 ? n : null);
// Control and format characters (bidi overrides, zero-widths) go: a name can't
// pretend to be something else on the desktop or in his speech bubble.
const text = (s, max) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, max) : '');

function cleanRecent(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(r => r && typeof r === 'object').slice(0, RECENT_KEPT).map(r => ({
    id: typeof r.id === 'string' ? r.id.slice(0, 80) : null,
    at: time(r.at), what: text(r.what, WHAT_MAX), ok: r.ok !== false, actedOn: r.actedOn === true,
  }));
}

function cleanMember(type, m) {
  const o = m && typeof m === 'object' ? m : {};
  return {
    type,
    name: text(o.name, NAME_MAX) || nameFor(type),
    hat: HAT_CHOICES.has(o.hat) ? o.hat : 'auto',
    runs: count(o.runs), completed: count(o.completed), failed: count(o.failed), actedOn: count(o.actedOn),
    tokens: count(o.tokens), toolUses: count(o.toolUses), durationMs: count(o.durationMs),
    joinedAt: time(o.joinedAt), lastAt: time(o.lastAt),
    recent: cleanRecent(o.recent),
    // Bugs it helped beat, by bug type.
    beat: Object.fromEntries(Object.entries(o.beat && typeof o.beat === 'object' ? o.beat : {}).filter(([k, v]) => BUG_TYPES.has(k) && count(v)).map(([k, v]) => [k, count(v)])),
  };
}

/** Whatever was stored, as a roster: { members: { [type]: member } }. */
function normalize(state) {
  const members = {};
  const raw = state && typeof state === 'object' && state.members && typeof state.members === 'object' ? state.members : {};
  for (const [k, m] of Object.entries(raw)) {
    const type = typeKey(k);
    if (!k.trim() || Object.hasOwn(members, type)) continue;
    members[type] = cleanMember(type, m);
  }
  return { members };
}

// Over the limit, the members unseen longest step down.
function bounded(members) {
  const list = Object.values(members);
  if (list.length <= MAX_MEMBERS) return members;
  const keep = list.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, MAX_MEMBERS);
  return Object.fromEntries(keep.map(m => [m.type, m]));
}

const recruit = (s, type, now) => cleanMember(type, {
  name: nameFor(type, new Set(Object.values(s.members).map(m => m.name))),
  joinedAt: now, lastAt: now,
});

/**
 * A helper of a type never seen before went out: it joins the crew (with its
 * name) now, so its first trip already wears it. Known types: unchanged.
 */
function enlist(state, type, now) {
  const s = normalize(state);
  const key = typeKey(type);
  if (Object.hasOwn(s.members, key)) return state;
  return { members: bounded({ ...s.members, [key]: recruit(s, key, now) }) };
}

/**
 * A helper finished. run: { type, taskId, ok, what, tokens, toolUses, durationMs }.
 * Returns the new roster; the old one is left as it was.
 */
function recordRun(state, run, now) {
  const s = normalize(state);
  const type = typeKey(run?.type);
  const prev = s.members[type] || recruit(s, type, now);
  const ok = run?.ok !== false;
  const entry = { id: typeof run?.taskId === 'string' ? run.taskId.slice(0, 80) : null, at: now, what: text(run?.what, WHAT_MAX), ok, actedOn: false };
  const next = {
    ...prev,
    runs: prev.runs + 1,
    completed: prev.completed + (ok ? 1 : 0),
    failed: prev.failed + (ok ? 0 : 1),
    tokens: prev.tokens + count(run?.tokens),
    toolUses: prev.toolUses + count(run?.toolUses),
    durationMs: prev.durationMs + count(run?.durationMs),
    joinedAt: prev.joinedAt || now,
    lastAt: now,
    recent: [entry, ...prev.recent].slice(0, RECENT_KEPT),
  };
  return { members: bounded({ ...s.members, [type]: next }) };
}

/**
 * Claude went on to change files after these runs: credit each once.
 * credits: [{ type, taskId }], each a finished run the caller credits once
 * (wiring/crew.js). A run still in `recent` that was already credited, or
 * failed, is skipped; one a busy turn has pushed out of `recent` still counts.
 * Unknown members change nothing.
 */
function actedOn(state, credits) {
  const s = normalize(state);
  let members = s.members;
  let changed = false;
  for (const c of credits || []) {
    const type = typeKey(c?.type);
    const m = Object.hasOwn(members, type) ? members[type] : null;
    if (!m) continue;
    const i = m.recent.findIndex(r => r.id && r.id === c.taskId);
    if (i >= 0 && (m.recent[i].actedOn || !m.recent[i].ok)) continue;
    const recent = i < 0 ? m.recent : m.recent.map((r, j) => (j === i ? { ...r, actedOn: true } : r));
    members = { ...members, [type]: { ...m, actedOn: m.actedOn + 1, recent } };
    changed = true;
  }
  return changed ? { members } : state;
}

/** A new name, if it's not blank and no other crew member has it. */
function rename(state, type, name) {
  const s = normalize(state);
  const key = typeKey(type);
  const clean = text(name, NAME_MAX);
  if (!clean || !Object.hasOwn(s.members, key)) return state;
  const taken = Object.values(s.members).some(m => m.type !== key && m.name.toLowerCase() === clean.toLowerCase());
  if (taken) return state;
  return { members: { ...s.members, [key]: { ...s.members[key], name: clean } } };
}

function setHat(state, type, hat) {
  const s = normalize(state);
  const key = typeKey(type);
  if (!HAT_CHOICES.has(hat) || !Object.hasOwn(s.members, key)) return state;
  return { members: { ...s.members, [key]: { ...s.members[key], hat } } };
}

// ---------------------------------------------------------------- levels and hats

const beatenOf = m => Object.values(m.beat || {}).reduce((n, v) => n + count(v), 0);
const xpOf = m => count(m.completed) * XP.completed + count(m.failed) * XP.failed + count(m.actedOn) * XP.actedOn + beatenOf(m) * XP.beat;

/** The bug type a member has beaten most (at least SPECIALTY_AT of), or null. Ties go to the first type in order. */
function specialtyOf(member) {
  const best = Object.entries(member?.beat || {}).filter(([k]) => BUG_TYPES.has(k)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best && best[1] >= SPECIALTY_AT ? best[0] : null;
}

/**
 * A bug was caught with these members' help (they assisted in its battle):
 * each gets it on its record. types: agent types; bugType: the bug's type.
 */
function recordBeat(state, types, bugType) {
  if (!BUG_TYPES.has(bugType)) return state;
  const s = normalize(state);
  let members = s.members;
  let changed = false;
  for (const t of new Set((types || []).map(typeKey))) {
    if (!Object.hasOwn(members, t)) continue;
    const m = members[t];
    members = { ...members, [t]: { ...m, beat: { ...m.beat, [bugType]: (m.beat[bugType] || 0) + 1 } } };
    changed = true;
  }
  return changed ? { members } : state;
}
const floorXp = level => XP_STEP * (level - 1) ** 2;

function levelForXp(xp) {
  const level = Math.min(MAX_LEVEL, 1 + Math.floor(Math.sqrt(Math.max(0, xp) / XP_STEP)));
  if (level === MAX_LEVEL) return { level, xp, progress: 0, nextXp: null };
  const lo = floorXp(level);
  const hi = floorXp(level + 1);
  return { level, xp, progress: (xp - lo) / (hi - lo), nextXp: hi };
}

const titleFor = level => TITLES.filter(([l]) => level >= l).at(-1)[1];
const hatsEarned = level => HAT_LADDER.filter(([l]) => level >= l).map(([, id]) => id);

/** What a member wears at a level: a wardrobe id, 'match' (Shellby's hat) or null. */
function hatFor(member, level) {
  const choice = member?.hat || 'auto';
  if (choice === 'none') return null;
  if (choice === 'match') return 'match';
  const earned = hatsEarned(level);
  return earned.includes(choice) ? choice : earned.at(-1);
}

const hueFor = type => HUES[hash(typeKey(type)) % HUES.length];

function memberView(m) {
  const lv = levelForXp(xpOf(m));
  const next = HAT_LADDER.find(([l]) => l > lv.level);
  return {
    ...m,
    level: lv.level, xp: lv.xp, progress: lv.progress, nextXp: lv.nextXp,
    title: titleFor(lv.level),
    wears: hatFor(m, lv.level),
    hats: hatsEarned(lv.level),
    nextHat: next ? { level: next[0], id: next[1] } : null,
    hue: hueFor(m.type),
    beaten: beatenOf(m), specialty: specialtyOf(m),
  };
}

/** The crew page: members by level, then most recently out. */
function view(state) {
  const members = Object.values(normalize(state).members).map(memberView)
    .sort((a, b) => b.level - a.level || (b.lastAt || 0) - (a.lastAt || 0));
  const sum = k => members.reduce((n, m) => n + m[k], 0);
  return { members, totals: { members: members.length, runs: sum('runs'), actedOn: sum('actedOn') } };
}

/** One member's look and level, for the helper crab on the desktop. Null if unknown. */
function memberOf(state, type) {
  const s = normalize(state);
  const key = typeKey(type);
  return Object.hasOwn(s.members, key) ? memberView(s.members[key]) : null;
}

/** Who went up a level between two rosters: [{ type, name, level }]. */
function levelUps(before, after) {
  const b = normalize(before).members;
  return Object.values(normalize(after).members).flatMap(m => {
    const now = levelForXp(xpOf(m)).level;
    const was = Object.hasOwn(b, m.type) ? levelForXp(xpOf(b[m.type])).level : 1;
    return now > was ? [{ type: m.type, name: m.name, level: now }] : [];
  });
}

module.exports = {
  MAX_MEMBERS, RECENT_KEPT, TYPE_MAX, NAME_MAX, MAX_LEVEL, XP, HAT_LADDER, TITLES,
  normalize, typeKey, nameFor, enlist, recordRun, actedOn, rename, setHat,
  xpOf, levelForXp, hatsEarned, hatFor, view, memberOf, levelUps, SPECIALTY_AT, specialtyOf, recordBeat,
};
