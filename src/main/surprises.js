// Crit hits and small surprises. Now and then, for a real outcome, a short
// fanfare: "Critical hit!" when one turn takes a red suite all the way to
// green, and "Clean landing" when a copy of the repo comes home with its
// checks green on the first try.
//
// Two rules make it work. It's tied to quality and never to speed: what
// qualifies is proven from test runs on exact git trees (red on the tree a
// turn started from, green on the tree it ended on), and nothing here reads how
// long anything took. And it's rare and unpredictable: a qualifying outcome
// only rolls for a surprise, with a cooldown, a few a day at most, and a little
// more luck after each miss so a dry spell ends. The first of each kind always
// lands, so you find out it exists.
//
// Pure: no I/O, no clock, no Math.random (callers pass `now` and `rng`).
// See test/surprises.test.js; wiring/surprises.js listens and plays it.

const KINDS = Object.freeze(['crit', 'landing']);

const MINUTE = 60000;
const COOLDOWN = 30 * MINUTE;     // never two surprises close together
const A_DAY = 3;                  // and only a few in a day
const BASE = Object.freeze({ crit: 0.4, landing: 0.3 });
const PER_FAILING = 0.03;         // a bigger mess put right is likelier to crit...
const SIZE_MAX = 0.2;             // ...up to this much
const PITY = 0.15;                // each qualifying miss adds this
const MAX_MISSES = 10;
const MAX_CHANCE = 0.85;          // never certain: then it isn't a surprise
const BIG_AT = 10;                // failing tests for the big version
const MAX_FAILING = 9999;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TREE_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const dayKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const perKind = (raw, max = Infinity) => Object.fromEntries(KINDS.map(k => [k, Math.min(max, count(raw?.[k]))]));

// ------------------------------------------------------------------ state

/** Whatever was saved -> { lastAt, day, today, misses, hits, lines }. */
function normalize(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const lines = Object.fromEntries(KINDS.map(k => [k, Number.isInteger(s.lines?.[k]) && s.lines[k] >= 0 ? s.lines[k] : -1]));
  return {
    lastAt: count(s.lastAt),
    day: typeof s.day === 'string' && DAY_RE.test(s.day) ? s.day : '',
    today: count(s.today),
    misses: perKind(s.misses, MAX_MISSES),
    hits: perKind(s.hits),
    lines,
  };
}

// ------------------------------------------------------------------ what qualifies

/**
 * Did one turn take a suite from red to fully green? -> { failing, via } | null.
 *   turn: { before, after }, the trees the turn started and ended on
 *   runs: [{ via: 'checks' | 'claude', cmd?, tree, ok, failing, names?, at }]
 *     'checks' is Shellby's own run of the project's checks; 'claude' is a test
 *     command Claude ran, compared only with the same command.
 *   prev: the tab's turn before this one ({ before, after }), if known
 *   since: only a green that came in after this (the previous turn's end) counts
 *   flaky: (name) -> true for a test known to flake
 * Red means named failing tests on the tree the turn started from (not a
 * timeout, not a broken build, not "it wouldn't start"), so a suite the turn
 * broke and mended itself doesn't count, and nor does one the turn before
 * broke from green. A red that's only known-flaky tests proves nothing either.
 * Green means a passing run on the tree it ended on, run for this turn: the
 * turn's last word, with nothing changed after it.
 */
function critOf({ turn, runs, prev = null, since = 0, flaky = () => false } = {}) {
  if (!turn || !TREE_RE.test(turn.before || '') || !TREE_RE.test(turn.after || '') || turn.before === turn.after) return null;
  const list = Array.isArray(runs) ? runs.filter(r => r && typeof r === 'object') : [];
  // The turn before took a green suite red: putting that right is no crit.
  const selfMade = !!prev && prev.after === turn.before && prev.before !== prev.after
    && list.some(g => g.ok === true && g.tree === prev.before);
  if (selfMade) return null;
  let best = null;
  for (const red of list) {
    if (red.ok || red.tree !== turn.before || count(red.failing) < 1) continue;
    const names = Array.isArray(red.names) ? red.names : [];
    if (names.length && names.every(n => flaky(n))) continue;
    const green = list.find(g => g.ok === true && g.tree === turn.after && count(g.at) >= count(red.at) && count(g.at) > count(since)
      && (g.via === 'checks' || (red.via === 'claude' && g.via === 'claude' && g.cmd && g.cmd === red.cmd)));
    if (!green) continue;
    const failing = Math.min(MAX_FAILING, count(red.failing));
    if (!best || failing > best.failing) best = { failing, via: green.via };
  }
  return best;
}

// Green by taking the tests away isn't green. A turn that deletes a test file
// or adds a skip, an `.only` (which quietly skips the rest) or an ignore
// pattern doesn't get a fanfare, however it ends.
const TEST_FILE_RE = /(^|[\\/])(tests?|__tests__|specs?)[\\/]|[._-](test|spec)s?\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py|rs)$/i;
// Read only in test files: `fit(` or `{ skip }` mean something else elsewhere.
const SKIP_RES = Object.freeze([
  /\b(?:it|test|describe|context|suite|bench)\.(?:skip|only|todo)\b/,
  /(?:^|[^\w.$])(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.skip/,
  /#\[ignore\]/,
  /\bt\.Skip(?:Now|f)?\s*\(/,
  /\bskip\s*:\s*true\b|\{\s*skip\s*\}/,
]);
// Read anywhere: a runner's config or script told to leave tests out.
// (`|| true` only in a package.json test script: elsewhere it's everyday shell.)
const IGNORE_RE = /testPathIgnorePatterns|modulePathIgnorePatterns|--deselect\b|--ignore=\S*test|passWithNoTests|"test(?::[\w-]+)?"\s*:\s*".*\|\|\s*(?:true|exit 0)\b/i;
// A test case going away: `it(`, `test(`, a Python `def test_`, a Go `func Test`.
const CASE_RE = /^[-+]\s*(?:(?:it|test)\s*\(|(?:async\s+)?def\s+test_|func\s+Test[A-Z_])/;
const FILE_HEADER_RE = /^\+\+\+ (?:b\/)?(.+?)\s*$/;

/**
 * How a turn might have got to green without fixing anything, or null.
 *   files: the turn's changed files ({ path, status }); patch: its unified diff, if read
 */
function shortcutIn({ files = [], patch = '' } = {}) {
  const deleted = (Array.isArray(files) ? files : []).find(f => f?.status === 'D' && TEST_FILE_RE.test(String(f.path || '')));
  if (deleted) return `deleted ${deleted.path}`;
  let inTest = false;
  let cases = 0; // test cases added, less those taken away
  let prevLine = '';
  for (const line of String(patch || '').split('\n')) {
    // A file's header is "--- a/x" then "+++ b/x"; an added line that happens
    // to start "++" is still just a line.
    const header = prevLine.startsWith('--- ') ? FILE_HEADER_RE.exec(line) : null;
    prevLine = line;
    if (header) { inTest = TEST_FILE_RE.test(header[1]); continue; }
    if (line.startsWith('-')) { if (inTest && !line.startsWith('---') && CASE_RE.test(line)) cases--; continue; }
    if (!line.startsWith('+')) continue;
    if (IGNORE_RE.test(line)) return 'left tests out';
    if (inTest && CASE_RE.test(line)) cases++;
    if (inTest && SKIP_RES.some(re => re.test(line))) return 'skipped tests';
  }
  return cases < 0 ? 'removed tests' : null;
}

/**
 * Is this copy coming home green on the first try? -> boolean.
 *   verdict: the checks that just let it home; items: its conversation so far
 * Never red along the way (a turn's checks or a gate that stopped it), and
 * never brought home before.
 */
function firstTry(verdict, items = []) {
  if (verdict?.status !== 'pass') return false;
  const list = Array.isArray(items) ? items : [];
  return !list.some(i => (i?.kind === 'checks' && (i.status === 'fail' || i.status === 'timeout')) || i?.kind === 'home');
}

// ------------------------------------------------------------------ the roll

/** The chance a qualifying outcome is a surprise, 0..MAX_CHANCE. Pure. */
function chanceOf(kind, stateIn, { failing = 0 } = {}) {
  if (!KINDS.includes(kind)) return 0;
  const state = normalize(stateIn);
  const size = kind === 'crit' ? Math.min(SIZE_MAX, PER_FAILING * Math.max(0, count(failing) - 1)) : 0;
  return Math.min(MAX_CHANCE, BASE[kind] + size + PITY * state.misses[kind]);
}

/**
 * A qualifying outcome rolls for its surprise.
 * -> { hit, chance, state, reason? }; reason: 'cooldown' | 'daily' when it
 * couldn't roll at all (that doesn't count as a miss).
 */
function roll(stateIn, kind, { now, rng = () => 1, failing = 0 } = {}) {
  let state = normalize(stateIn);
  if (!KINDS.includes(kind) || !Number.isFinite(now)) return { hit: false, chance: 0, state };
  const today = dayKey(now);
  if (state.day !== today) state = { ...state, day: today, today: 0 };
  if (state.lastAt && now - state.lastAt < COOLDOWN && now >= state.lastAt) return { hit: false, chance: 0, state, reason: 'cooldown' };
  if (state.today >= A_DAY) return { hit: false, chance: 0, state, reason: 'daily' };
  const chance = state.hits[kind] === 0 ? 1 : chanceOf(kind, state, { failing });
  const r = Number(rng());
  const hit = chance >= 1 || (Number.isFinite(r) && r < chance);
  if (!hit) return { hit, chance, state: { ...state, misses: { ...state.misses, [kind]: Math.min(MAX_MISSES, state.misses[kind] + 1) } } };
  return {
    hit, chance,
    state: {
      ...state, lastAt: now, today: state.today + 1,
      misses: { ...state.misses, [kind]: 0 }, hits: { ...state.hits, [kind]: state.hits[kind] + 1 },
    },
  };
}

// ------------------------------------------------------------------ the fanfare

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What he says. Each is a function of what happened, so the line carries
// something real; never the same one twice running.
const LINES = Object.freeze({
  crit: [
    f => `Critical hit! ${plural(f.failing, 'red test')}, one turn, all green.`,
    () => 'CRIT! Red to green in a single turn.',
    f => `Critical hit! ${f.failing} failing, now 0. Clean.`,
    () => 'Critical hit! Red to green, and nothing skipped.',
    () => 'Crit! Not a red test left standing.',
  ],
  landing: [
    f => (f.branch ? `Clean landing! ${f.branch} came home green, first try.` : 'Clean landing! Home green, first try.'),
    () => 'Clean landing. Green the first time, not a red along the way.',
    () => 'Touchdown! Checks green on the very first go.',
    f => (f.copies > 1 ? `Clean landing! ${f.copies} copies home green, first try.` : 'Clean landing! Not one red test the whole trip.'),
  ],
});

const TITLES = Object.freeze({ crit: 'Critical hit!', landing: 'Clean landing' });
const ICONS = Object.freeze({ crit: '✦', landing: '🛬' });

/** The conversation's note: what happened, plainly. */
function noteText(kind, f) {
  if (kind === 'crit') return `This turn took ${plural(f.failing, 'failing test')} to green, without skipping any.`;
  if (f.copies > 1) return `${f.copies} copies came home with their checks green on the first try.`;
  return `Came home${f.base ? ` to ${f.base}` : ''} with its checks green on the first try.`;
}

/**
 * The surprise itself -> { kind, title, icon, badge, line, note, big, state }.
 * badge: the few letters that pop up over him.
 *   facts: { failing } for a crit; { branch, base, copies } for a landing
 *   state: the surprises state, so the line isn't the last one used
 */
function fanfare(kind, facts = {}, { rng = Math.random, state: stateIn } = {}) {
  const state = normalize(stateIn);
  const pool = LINES[kind] || LINES.crit;
  const f = { failing: Math.max(1, count(facts.failing)), branch: typeof facts.branch === 'string' ? facts.branch.slice(0, 40) : '', base: typeof facts.base === 'string' ? facts.base.slice(0, 40) : '', copies: count(facts.copies) || 1 };
  const choices = pool.map((_, i) => i).filter(i => i !== state.lines[kind]);
  const r = Number(rng());
  const index = choices[Math.min(choices.length - 1, Math.floor((Number.isFinite(r) ? Math.max(0, r) : 0) * choices.length))];
  const big = kind === 'crit' && f.failing >= BIG_AT;
  return {
    kind,
    title: big ? `Critical hit ×${f.failing}!` : TITLES[kind],
    icon: ICONS[kind],
    badge: kind === 'crit' ? (big ? `CRIT ×${f.failing}` : 'CRIT!') : 'CLEAN LANDING',
    line: pool[index](f).slice(0, 120),
    note: noteText(kind, f),
    big,
    state: { ...state, lines: { ...state.lines, [kind]: index } },
  };
}

module.exports = {
  KINDS, COOLDOWN, A_DAY, BASE, PITY, MAX_CHANCE, BIG_AT, LINES,
  normalize, critOf, shortcutIn, firstTry, chanceOf, roll, fanfare,
};
