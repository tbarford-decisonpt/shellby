// Review mastery (docs/CLAUDE-CODE.md#review-mastery): a track for really
// reading what Claude changed. Points come from three things, each held to a
// rule so they can't be farmed:
//   - a quiz passed on a turn's changes (quiz.js): +3, once per turn
//   - line comments sent on a turn's diff: +1 per turn, when at least one says
//     something (12+ characters, not "lgtm") on a diff of 10+ lines
//   - caught before merge: Claude's next turn on that tab rewrites lines you
//     commented on (within 3 lines), with nothing pushed in between: +5
// Tiers need points and, higher up, catches and a quiz run. Nothing is ever
// taken back: a failed quiz ends the current run but never lowers the best.
//
// State (config `reviewMastery`, this PC only):
//   { points, tier, caught, quiz: { streak, best, lastTurnIds: [≤20] },
//     comments: { turns: { [turnId]: { at, tabId, n, files, lines: [[file, a, b]], open } } }, log: [≤30] }
// turnId: "<tabId>:<tree after the turn>", the same for a turn's quiz and its comments.
//
// Pure: no I/O, no clock (callers pass `now`). See test/review-mastery.test.js.

const QUIZ_POINTS = 3;
const COMMENT_POINTS = 1;
const CAUGHT_POINTS = 5;
const MIN_COMMENT_CHARS = 12;    // non-space characters
const MIN_DISTINCT_CHARS = 6;    // "aaaaaaaaaaaa" says nothing either
const MIN_DIFF_LINES = 10;
const MIN_QUIZ_LINES = 30;       // quiz.MIN_LINES: a turn too small for a quiz isn't one
const NEAR_LINES = 3;            // an edit this close to a commented line counts
const CAUGHT_WINDOW = 6 * 60 * 60 * 1000; // the next turn has to come within this
const MAX_TURNS = 50;
const MAX_QUIZ_TURNS = 20;
const MAX_LOG = 30;
const MAX_LINES_PER_TURN = 40;
const TURN_RE = /^[^:\s]{1,80}:[0-9a-f]{40}$/;

// What's said to mean "fine" without saying anything.
const STOPLIST = new Set([
  'lgtm', 'ok', 'okay', 'nice', '+1', 'looks good', 'looks good to me', 'ship it', 'thanks', 'thank you', 'good', 'great',
  'cool', 'yes', 'no', 'done', 'fine', 'nit', 'same', 'same here', 'agreed', 'approved', 'nice one', 'good job', 'well done',
]);

const TIERS = Object.freeze([
  { n: 1, name: 'Tide-pool Reader', points: 10, caught: 0, quizBest: 0, reward: null },
  { n: 2, name: 'Diff Diver', points: 30, caught: 0, quizBest: 3, reward: "Diver's Goggles Stand for the tank" },
  { n: 3, name: 'Line Hawk', points: 75, caught: 5, quizBest: 0, reward: 'Hawk Perch for the tank' },
  { n: 4, name: 'Merge Guardian', points: 150, caught: 15, quizBest: 5, reward: 'The "Guardian" flair' },
  { n: 5, name: 'Abyssal Auditor', points: 300, caught: 40, quizBest: 0, reward: "Auditor's Lantern for the tank" },
].map(t => Object.freeze(t)));

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const nat = (v, max = 1e7) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);
const pos = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const isTurn = id => typeof id === 'string' && TURN_RE.test(id);
const fileKey = f => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

// ------------------------------------------------------------------ state

function normalizeTurn(raw) {
  if (!isObj(raw)) return null;
  const lines = (Array.isArray(raw.lines) ? raw.lines : [])
    .filter(l => Array.isArray(l) && typeof l[0] === 'string' && l[0].length <= 1000 && Number.isInteger(l[1]) && Number.isInteger(l[2]) && l[1] >= 1 && l[2] >= l[1])
    .slice(0, MAX_LINES_PER_TURN).map(([f, a, b]) => [f, a, b]);
  return {
    at: pos(raw.at), tabId: typeof raw.tabId === 'string' ? raw.tabId.slice(0, 80) : '',
    n: nat(raw.n, 1000), files: (Array.isArray(raw.files) ? raw.files : []).filter(f => typeof f === 'string').slice(0, 20).map(f => f.slice(0, 1000)),
    lines, open: raw.open === true,
  };
}

function normalizeLog(raw) {
  return (Array.isArray(raw) ? raw : []).filter(e => isObj(e) && typeof e.kind === 'string' && typeof e.text === 'string')
    .slice(-MAX_LOG).map(e => ({ at: pos(e.at), kind: e.kind.slice(0, 20), text: e.text.slice(0, 200), points: nat(e.points, 100) }));
}

/** A stored track made safe. Never throws. */
function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  const q = isObj(r.quiz) ? r.quiz : {};
  const turns = {};
  const src = isObj(r.comments) && isObj(r.comments.turns) ? r.comments.turns : {};
  for (const [id, t] of Object.entries(src).slice(-MAX_TURNS)) {
    const n = isTurn(id) && normalizeTurn(t);
    if (n) turns[id] = n;
  }
  const streak = nat(q.streak, 1000);
  return {
    points: nat(r.points), tier: Math.min(TIERS.length, nat(r.tier)), caught: nat(r.caught),
    quiz: { streak, best: Math.max(streak, nat(q.best, 1000)), lastTurnIds: (Array.isArray(q.lastTurnIds) ? q.lastTurnIds : []).filter(isTurn).slice(-MAX_QUIZ_TURNS) },
    comments: { turns },
    log: normalizeLog(r.log),
  };
}

const logged = (log, entry) => [...log, entry].slice(-MAX_LOG);

/** The tier these numbers have earned (0 to 5). */
function earnedTier(s) {
  let tier = 0;
  for (const t of TIERS) {
    if (s.points >= t.points && s.caught >= t.caught && s.quiz.best >= t.quizBest) tier = t.n; else break;
  }
  return tier;
}

/** The tier reached: never lower than one reached before. */
const tierOf = s => { const n = normalize(s); return Math.max(n.tier, earnedTier(n)); };

// Settle the tier after a change: -> { state, tierUp: tier | null }.
function settle(s) {
  const tier = Math.max(s.tier, earnedTier(s));
  return tier > s.tier ? { state: { ...s, tier }, tierUp: TIERS[tier - 1] } : { state: s, tierUp: null };
}

// ------------------------------------------------------------------ the quiz

/**
 * A quiz finished. A pass on a turn not quizzed before, big enough for a quiz,
 * is worth points and adds to the run; a fail ends the run (the best stays).
 *   q: { turnId, lines, passed }   -> { state, points, tierUp, reason }
 */
function onQuiz(state, { turnId, lines, passed } = {}, now = 0) {
  const s = normalize(state);
  const no = reason => ({ state: s, points: 0, tierUp: null, reason });
  if (!isTurn(turnId)) return no('no-turn');
  if (!passed) return { state: { ...s, quiz: { ...s.quiz, streak: 0 } }, points: 0, tierUp: null, reason: 'failed' };
  if (s.quiz.lastTurnIds.includes(turnId)) return no('same-turn');
  if ((Number(lines) || 0) < MIN_QUIZ_LINES) return no('too-small');
  const streak = s.quiz.streak + 1;
  const quiz = { streak, best: Math.max(s.quiz.best, streak), lastTurnIds: [...s.quiz.lastTurnIds, turnId].slice(-MAX_QUIZ_TURNS) };
  const next = { ...s, points: s.points + QUIZ_POINTS, quiz, log: logged(s.log, { at: now, kind: 'quiz', text: `Passed a quiz (run of ${streak})`, points: QUIZ_POINTS }) };
  const r = settle(next);
  return { state: r.state, points: QUIZ_POINTS, tierUp: r.tierUp, reason: null };
}

// ------------------------------------------------------------------ line comments

/** Does a comment say something? 12+ non-space characters, 6+ different ones, not a stock "lgtm". */
function substantive(body) {
  const text = String(body || '').trim();
  const squeezed = text.replace(/\s+/g, '');
  if (squeezed.length < MIN_COMMENT_CHARS) return false;
  if (new Set(squeezed.toLowerCase()).size < MIN_DISTINCT_CHARS) return false;
  const plain = text.toLowerCase().replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return !STOPLIST.has(plain);
}

/**
 * Line comments went back to Claude on one turn's diff.
 *   c: { turnId, tabId, comments: [{ file, body, start, end, side }], diffLines }
 * -> { state, points, tierUp, reason }. Points once per turn; the lines
 * commented on are kept, so the next turn can catch them.
 */
function onComments(state, { turnId, tabId, comments, diffLines } = {}, now = 0) {
  const s = normalize(state);
  const no = reason => ({ state: s, points: 0, tierUp: null, reason });
  if (!isTurn(turnId) || !Array.isArray(comments) || !comments.length) return no('no-turn');
  if (s.comments.turns[turnId]) return no('same-turn');
  if ((Number(diffLines) || 0) < MIN_DIFF_LINES) return no('small-diff');
  const real = comments.filter(c => c && typeof c.file === 'string' && substantive(c.body));
  if (!real.length) return no('says-nothing');
  const lines = real.filter(c => c.side !== 'old' && Number.isInteger(c.start) && Number.isInteger(c.end) && c.start >= 1 && c.end >= c.start)
    .slice(0, MAX_LINES_PER_TURN).map(c => [c.file.slice(0, 1000), c.start, c.end]);
  const entry = { at: now, tabId: String(tabId || '').slice(0, 80), n: real.length, files: [...new Set(real.map(c => c.file.slice(0, 1000)))].slice(0, 20), lines, open: lines.length > 0 };
  const turns = Object.fromEntries(Object.entries({ ...s.comments.turns, [turnId]: entry }).slice(-MAX_TURNS));
  const n = real.length;
  const next = { ...s, points: s.points + COMMENT_POINTS, comments: { turns }, log: logged(s.log, { at: now, kind: 'comment', text: `Reviewed a turn (${n} ${n === 1 ? 'comment' : 'comments'})`, points: COMMENT_POINTS }) };
  const r = settle(next);
  return { state: r.state, points: COMMENT_POINTS, tierUp: r.tierUp, reason: null };
}

/** Turns on this tab still waiting for the next one to show whether a comment caught something. */
function openTurns(state, tabId, now = 0) {
  const s = normalize(state);
  return Object.entries(s.comments.turns)
    .filter(([, t]) => t.open && t.tabId === tabId && now - t.at <= CAUGHT_WINDOW)
    .map(([id, t]) => ({ turnId: id, files: [...new Set(t.lines.map(l => l[0]))] }));
}

const overlaps = (a1, b1, a2, b2) => a1 <= b2 + NEAR_LINES && a2 <= b1 + NEAR_LINES;

/**
 * Claude's next turn on that tab ended. Did it rewrite lines you'd commented on?
 *   t: { forTurn, turnId, edits: [[file, a, b]] (non-whitespace lines, as numbered
 *        before this turn), shipped: bool (pushed or merged since the comments) }
 * -> { state, caught: bool, points, tierUp, reason }. One chance per reviewed
 * turn and one catch per turn.
 */
function onNextTurn(state, { forTurn, turnId, edits, shipped = false } = {}, now = 0) {
  const s = normalize(state);
  const t = s.comments.turns[forTurn];
  const no = reason => ({ state: s, caught: false, points: 0, tierUp: null, reason });
  if (!t || !t.open) return no('nothing-open');
  if (turnId === forTurn) return no('same-turn');
  const closed = { ...s, comments: { turns: { ...s.comments.turns, [forTurn]: { ...t, open: false } } } };
  const shut = reason => ({ state: closed, caught: false, points: 0, tierUp: null, reason });
  if (now - t.at > CAUGHT_WINDOW) return shut('too-late');
  if (shipped) return shut('shipped');
  const list = (Array.isArray(edits) ? edits : []).filter(e => Array.isArray(e) && typeof e[0] === 'string' && Number.isInteger(e[1]) && Number.isInteger(e[2]));
  const hit = t.lines.find(([f, a, b]) => list.some(([ef, ea, eb]) => fileKey(ef) === fileKey(f) && overlaps(a, b, ea, eb)));
  if (!hit) return shut('missed');
  const file = hit[0].split(/[\\/]/).pop();
  const next = {
    ...closed, points: s.points + CAUGHT_POINTS, caught: s.caught + 1,
    log: logged(s.log, { at: now, kind: 'caught', text: `Caught something in ${file} before it merged`, points: CAUGHT_POINTS }),
  };
  const r = settle(next);
  return { state: r.state, caught: true, points: CAUGHT_POINTS, tierUp: r.tierUp, reason: null, file };
}

// ------------------------------------------------------------------ diffs

/**
 * A unified diff -> each hunk's changed lines that aren't only whitespace, as
 * [file, a, b] in the numbering before the change (the numbering a comment on
 * the turn before used). Pure-whitespace hunks are left out.
 */
function editsOf(patch) {
  const out = [];
  let file = null;
  let hunk = null;
  // Each hunk's changed lines only (its 3 lines of context left out): the lowest
  // and highest old line removed, or where lines went in.
  const flush = () => {
    if (hunk && file && hunk.lo !== null) out.push([file, hunk.lo, hunk.hi]);
    hunk = null;
  };
  const touch = n => { const at = Math.max(1, n); hunk.lo = hunk.lo === null ? at : Math.min(hunk.lo, at); hunk.hi = Math.max(hunk.hi, at); };
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); file = null; continue; }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (h) { flush(); hunk = { old: Number(h[1]), lo: null, hi: 0 }; continue; }
    if (!hunk) {
      if (line.startsWith('--- ')) { const m = line.match(/^--- (?:a\/)?(.+)$/); if (m && m[1] !== '/dev/null') file = m[1]; }
      else if (line.startsWith('+++ ')) { const m = line.match(/^\+\+\+ (?:b\/)?(.+)$/); if (!file && m && m[1] !== '/dev/null') file = m[1]; }
      continue;
    }
    // An added line right after removed ones replaces them; anywhere else it goes in before `old`.
    if (line.startsWith('-')) { if (line.slice(1).trim()) touch(hunk.old); hunk.old++; hunk.minus = true; }
    else if (line.startsWith('+')) { if (line.slice(1).trim()) touch(hunk.minus ? hunk.old - 1 : hunk.old); }
    else if (line.startsWith(' ')) { hunk.old++; hunk.minus = false; }
  }
  flush();
  return out.slice(0, 500);
}

// ------------------------------------------------------------------ the view

/** Everything the Trophies card and the Logbook show. */
function masteryView(state, now = 0) {
  const s = normalize(state);
  const tier = Math.max(s.tier, earnedTier(s));
  const nextTier = TIERS[tier] || null;
  const need = nextTier && {
    points: Math.max(0, nextTier.points - s.points),
    caught: Math.max(0, nextTier.caught - s.caught),
    quizBest: Math.max(0, nextTier.quizBest - s.quiz.best),
  };
  return {
    tier, tierName: tier ? TIERS[tier - 1].name : 'Not yet ranked',
    points: s.points, caught: s.caught, quizStreak: s.quiz.streak, quizBest: s.quiz.best,
    flair: tier >= 4 ? 'Guardian' : null,
    next: nextTier && { tier: nextTier.n, name: nextTier.name, reward: nextTier.reward, need, goal: { points: nextTier.points, caught: nextTier.caught, quizBest: nextTier.quizBest } },
    tiers: TIERS.map(t => ({ ...t, reached: t.n <= tier })),
    watching: Object.values(s.comments.turns).filter(t => t.open && now - t.at <= CAUGHT_WINDOW).length,
    log: [...s.log].reverse().slice(0, 10),
  };
}

module.exports = {
  TIERS, STOPLIST, QUIZ_POINTS, COMMENT_POINTS, CAUGHT_POINTS, MIN_COMMENT_CHARS, MIN_DIFF_LINES, MIN_QUIZ_LINES, NEAR_LINES, CAUGHT_WINDOW,
  normalize, tierOf, substantive, onQuiz, onComments, openTurns, onNextTurn, editsOf, masteryView,
};
