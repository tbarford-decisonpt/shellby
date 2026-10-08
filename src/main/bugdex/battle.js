// Bug battles: while a bug is on the loose, Claude's work on it plays out as a
// battle. The bug has HP; what Claude does in that project is a move (reading
// round is Scout, an edit is Patch, re-running the command that failed is
// that command's own move), and the bug only faints when the Bugdex really
// catches it (lifecycle.js, cheats.js). Everything before that can wear it
// down, never out: HP stops at FLOOR until the fix is proven.
//
// The honest parts: a re-run that fails with fewer failing tests takes HP off
// in proportion, one that fails as before misses, one that fails worse heals
// it, and a fix that didn't count (a skipped test) "doesn't count".
// Scouting and patching are effort, so they chip at it, a little, and only
// while the bug is in play: within FOCUS_MS of it last showing itself (it
// surfaced, or its command failed again). Work long after that is about
// something else, and the bug just waits.
//
// Kept in memory only (wiring/bugdex.js): a restart starts a fresh battle with
// whatever is still on the loose. Pure: no clock, no randomness. See
// test/bugdex-battle.test.js.

// What a move is called, by what it was (detect.js commandKind for commands).
const MOVES = Object.freeze({
  scout: 'Scout', patch: 'Patch', tests: 'Test Run', typecheck: 'Type Check', lint: 'Lint Sweep',
  build: 'Rebuild', install: 'Install', git: 'Git Fu', run: 'Run It', remedy: 'Remedy', assist: 'Assist',
});
const COMMAND_MOVES = new Set(['tests', 'typecheck', 'lint', 'build', 'install', 'git', 'run']);

// The type chart: which moves hit each type of bug hardest. A command is
// "the right tool for the job" for that kind of bug, and does double.
const SUPER = Object.freeze({
  runtime: ['tests', 'run'], io: ['run', 'remedy'], net: ['run', 'tests', 'remedy'], vcs: ['git'],
  ci: ['git', 'tests'], build: ['build', 'install', 'lint'], types: ['typecheck'], py: ['tests', 'run'],
  sys: ['build', 'tests'], test: ['tests'], sec: ['git', 'install'], ghost: ['tests', 'remedy'],
});

const HP = Object.freeze({ common: 40, uncommon: 60, rare: 90, legendary: 140, special: 99 });
const LEVEL = Object.freeze({ common: 6, uncommon: 14, rare: 28, legendary: 50, special: 77 });
const BOSS_HP = 1.5;
const BOSS_LEVELS = 10;
const FLOOR = 0.12;        // of max: how low HP goes before a proven fix
const SCOUT = 0.03;        // of max, per look round...
const SCOUT_MAX = 0.15;    // ...up to this much in all
const PATCH = 0.08;
const ASSIST = 0.1;
const REMEDY = 0.1;
const RESIST_HEAL = 0.2;
const CRIT_SHARE = 0.5;    // one re-run that clears half the failing tests is a big one
const COALESCE_MS = 20 * 1000;
const FOCUS_MS = 10 * 60 * 1000; // reads, edits and helpers count this long after it last showed itself
const MAX_MOVES = 40;
const MAX_PARTY = 6;

const FX = new Set(['appear', 'hit', 'super', 'crit', 'miss', 'heal', 'resist', 'ko', 'caught', 'fled']);

const count = v => (Number.isInteger(v) && v >= 0 ? v : null);
const floorOf = b => Math.ceil(b.max * FLOOR);
const clampHp = (b, hp) => Math.max(floorOf(b), Math.min(b.max, Math.round(hp)));

/** Is this move the right tool against this type of bug? */
const isSuper = (move, type) => (SUPER[type] || []).includes(move);

/**
 * A bug surfaces.
 *   enc: { species, rarity, type, project?, tabId? } (id is lifecycle.encId)
 *   opts: { id, boss, league ('elite' | 'champion' | null), stage (your own of it, 0-4), failed, now }
 */
function start(enc, { id, boss = false, league = null, stage = 0, failed = null, now }) {
  const rarity = HP[enc.rarity] ? enc.rarity : 'common';
  const big = boss || !!league;
  const max = Math.round(HP[rarity] * (big ? BOSS_HP : 1));
  const level = Math.min(100, LEVEL[rarity] + (big ? BOSS_LEVELS : 0) + Math.max(0, Math.min(4, stage | 0)) * 2);
  return {
    id, species: enc.species, type: enc.type, rarity, boss: !!boss, league: league === 'elite' || league === 'champion' ? league : null,
    max, hp: max, level, startedAt: now, seenAt: now, seq: 1,
    firstFailed: count(failed), lastFailed: count(failed), scouted: 0,
    party: [],
    moves: [{ seq: 1, move: 'appear', fx: 'appear', dmg: 0, hp: max, at: now, n: 1, by: null }],
    over: null,
  };
}

function push(b, entry) {
  const last = b.moves[b.moves.length - 1];
  // A run of reads (or edits) by the same hand is one move, done a few times.
  if (last && last.move === entry.move && (last.by?.type || null) === (entry.by?.type || null) && last.fx === entry.fx
    && (entry.move === 'scout' || entry.move === 'patch') && entry.at - last.at <= COALESCE_MS) {
    const merged = { ...last, n: last.n + 1, dmg: last.dmg + entry.dmg, hp: entry.hp, at: entry.at };
    return { ...b, hp: entry.hp, moves: [...b.moves.slice(0, -1), merged] };
  }
  const seq = b.seq + 1;
  return { ...b, seq, hp: entry.hp, moves: [...b.moves, { n: 1, by: null, ...entry, seq }].slice(-MAX_MOVES) };
}

const hitFor = (b, share) => {
  const hp = clampHp(b, b.hp - b.max * share);
  return { hp, dmg: b.hp - hp };
};

/**
 * Something Claude did while it's loose.
 *   m: { move, at, by ({ type, name, hue, special }), failed (failing tests now), reason }
 * Moves on a finished battle change nothing.
 */
function act(b, m) {
  if (!b || b.over || !MOVES[m.move] || !Number.isFinite(m.at)) return b;
  const at = m.at;
  const effort = m.move === 'scout' || m.move === 'patch' || m.move === 'assist';
  if (effort && at - (b.seenAt ?? b.startedAt) > FOCUS_MS) return b;
  if (m.move === 'scout') {
    const share = b.scouted < SCOUT_MAX ? Math.min(SCOUT, SCOUT_MAX - b.scouted) : 0;
    const { hp, dmg } = hitFor(b, share);
    return { ...push(b, { move: 'scout', fx: dmg ? 'hit' : 'miss', dmg, hp, at }), scouted: b.scouted + share };
  }
  if (m.move === 'patch' || m.move === 'remedy') {
    const { hp, dmg } = hitFor(b, m.move === 'patch' ? PATCH : REMEDY);
    return push(b, { move: m.move, fx: dmg ? (m.move === 'remedy' && isSuper('remedy', b.type) ? 'super' : 'hit') : 'miss', dmg, hp, at });
  }
  if (m.move === 'assist') {
    const by = cleanBy(m.by);
    if (!by) return b;
    const special = !!m.by.special;
    const { hp, dmg } = hitFor(b, ASSIST * (special ? 2 : 1));
    const party = [by, ...b.party.filter(p => p.type !== by.type)].slice(0, MAX_PARTY);
    return { ...push(b, { move: 'assist', fx: special && dmg ? 'super' : dmg ? 'hit' : 'miss', dmg, hp, at, by }), party };
  }
  // A command that failed again, the same bug still in it.
  const now = count(m.failed);
  const kind = COMMAND_MOVES.has(m.move) ? m.move : 'run';
  const sup = isSuper(kind, b.type);
  b = { ...b, seenAt: at }; // it showed itself again: in play
  if (now == null || b.lastFailed == null || !b.firstFailed) {
    return push(b, { move: kind, fx: 'miss', dmg: 0, hp: b.hp, at });
  }
  if (now > b.lastFailed) {
    const hp = clampHp(b, floorOf(b) + (b.max - floorOf(b)) * Math.min(1, now / b.firstFailed));
    return { ...push(b, { move: kind, fx: hp > b.hp ? 'heal' : 'miss', dmg: Math.min(0, b.hp - hp), hp: Math.max(hp, b.hp), at }), lastFailed: now };
  }
  if (now === b.lastFailed) return push(b, { move: kind, fx: 'miss', dmg: 0, hp: b.hp, at });
  const target = clampHp(b, floorOf(b) + (b.max - floorOf(b)) * (now / b.firstFailed));
  const dmg = Math.max(0, b.hp - target);
  const crit = (b.lastFailed - now) / b.firstFailed >= CRIT_SHARE;
  const fx = !dmg ? 'miss' : crit ? 'crit' : sup ? 'super' : 'hit';
  return { ...push(b, { move: kind, fx, dmg, hp: b.hp - dmg, at }), lastFailed: now };
}

/** A fix that didn't count (cheats.js): it doesn't count, and the bug gets some back. */
function resist(b, { at, reason }) {
  if (!b || b.over || !Number.isFinite(at)) return b;
  const hp = Math.min(b.max, Math.round(b.hp + b.max * RESIST_HEAL));
  return push(b, { move: 'patch', fx: 'resist', dmg: b.hp - hp, hp, at, reason: typeof reason === 'string' ? reason.slice(0, 20) : null });
}

/**
 * It's over: caught (it faints, then the jar), or it got away.
 *   end: { at, outcome: 'caught' | 'fled', jar: { isNew, forms, badge, league, fame, reveal, counted } }
 */
function finish(b, { at, outcome, jar = null }) {
  if (!b || b.over || !Number.isFinite(at)) return b;
  if (outcome === 'caught') {
    const ko = push(b, { move: 'finish', fx: 'ko', dmg: b.hp, hp: 0, at });
    return { ...push(ko, { move: 'jar', fx: 'caught', dmg: 0, hp: 0, at, jar: cleanJar(jar) }), over: 'caught' };
  }
  return { ...push(b, { move: 'flee', fx: 'fled', dmg: 0, hp: b.hp, at }), over: 'fled' };
}

function cleanBy(by) {
  if (!by || typeof by.type !== 'string' || !by.type) return null;
  return {
    type: by.type.slice(0, 60), name: typeof by.name === 'string' ? by.name.slice(0, 24) : by.type.slice(0, 24),
    hue: Number.isFinite(by.hue) ? by.hue : 0, level: Number.isFinite(by.level) ? by.level : 1,
  };
}

function cleanJar(j) {
  const o = j && typeof j === 'object' ? j : {};
  return {
    isNew: o.isNew === true,
    forms: Array.isArray(o.forms) ? o.forms.filter(f => typeof f === 'string').slice(0, 6) : [],
    evolved: Number.isInteger(o.evolved) ? o.evolved : 0,
    badge: typeof o.badge === 'string' ? o.badge.slice(0, 40) : null,
    league: typeof o.league === 'string' ? o.league.slice(0, 20) : null,
    fame: o.fame === true,
    reveal: typeof o.reveal === 'string' ? o.reveal.slice(0, 40) : null, // what it really was (a zombie process)
    counted: o.counted !== false,                                          // false: fixed, but already jarred lately
  };
}

/** The words for a move, as the battle's text box says them. */
// Why a fix didn't count, as the text box puts it (cheats.js REASONS).
const WHY = {
  'no-change': 'the code didn’t change', revert: 'that only undid things', 'deleted-tests': 'a test was deleted',
  skipped: 'a test was skipped', suppressed: 'the error was silenced', 'fewer-tests': 'fewer tests ran',
  'snapshots-only': 'the snapshots were just updated', 'bigger-number': 'a limit was just raised',
  insecure: 'the checks were switched off', 'tests-only': 'only the tests changed',
};

function lineFor(b, m, name) {
  const who = m.by ? m.by.name : 'Claude';
  const times = m.n > 1 ? ` ×${m.n}` : '';
  switch (m.fx) {
    case 'appear': return b.league === 'champion' ? `${name}, the champion of the deep, stirs!`
      : b.league === 'elite' ? `${name}, one of the Deep Four, stirs!`
        : b.boss ? `${name}, the boss of these waters, won’t budge!` : `A wild ${name} appeared!`;
    case 'ko': return `${name} is out cold!`;
    case 'caught':
      if (m.jar?.reveal) return `Into the jar! It was a ${m.jar.reveal} all along!`;
      return m.jar && !m.jar.counted ? `${name} is fixed! (Already in a jar today.)` : `${name} is in the jar!`;
    case 'fled': return `${name} slipped away…`;
    default: break;
  }
  const used = m.move === 'assist' ? `${who} pitches in!` : `${who} tries ${MOVES[m.move] || 'something'}!${times}`;
  const after = {
    hit: '', super: ' Right tool for the job!', crit: ' A big one!', resist: ` That doesn’t count… ${WHY[m.reason] ? `(${WHY[m.reason]})` : ''}`.trimEnd(),
    heal: ` ${name} digs in!`, miss: m.move === 'scout' ? ` ${name} is being studied.` : ` ${name} holds on!`,
  }[m.fx] || '';
  return `${used}${after}`;
}

/** What the panel draws: no encounter internals, just the fight, each move with its line. */
function view(b, name) {
  if (!b) return null;
  return {
    id: b.id, species: b.species, type: b.type, rarity: b.rarity, boss: b.boss, league: b.league,
    max: b.max, hp: b.hp, level: b.level, startedAt: b.startedAt, seq: b.seq, over: b.over,
    party: b.party.map(p => ({ ...p })),
    moves: b.moves.filter(m => FX.has(m.fx)).map(m => ({ ...m, line: lineFor(b, m, name) })),
  };
}

module.exports = {
  MOVES, SUPER, HP, LEVEL, FLOOR, FOCUS_MS, MAX_MOVES, COMMAND_MOVES,
  isSuper, start, act, resist, finish, lineFor, view, floorOf,
};
