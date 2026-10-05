// What each turn cost, so usage can plan itself. Every turn that ends leaves a
// row: which project, what kind of ask it was (a fix, a review, a question…),
// on which model, and how much of the 5-hour window it took. From those rows
// estimate() says what a message you're typing usually costs, before you send
// it, and whether it would carry you past the line you keep for yourself.
//
// The prompt itself is never kept: only its category and a size bucket. The
// ledger stays on this PC (config.turnCosts) and Clear all history wipes it.
//
// Claude Code only reports how full the window is, so a turn's share comes two
// ways: the rise in the 5-hour reading its own conversation reported while it
// ran (pctRise, whole percent, may be null), and the model-weighted tokens it
// spent (spend.js weightOf). Rows without a rise are turned into percent with
// the weight-per-percent ratio the rows with both have shown.
//
// Pure: callers pass `now` (test/turncost.test.js).

const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 60 * DAY;
const MAX_ROWS = 2000;
const MIN_SAMPLES = 3;     // fewer than this and a guess would only be noise
const RECENT = 30;         // the newest rows of a tier are the ones that count
const RATIO_ROWS = 200;    // rows with both a rise and a weight, for the weight→% ratio
const WINDOW_SLACK_MS = 10 * 60 * 1000;

const CATEGORIES = ['question', 'review', 'tests', 'fix', 'feature', 'refactor', 'docs', 'tidy', 'other'];
const SIZES = ['s', 'm', 'l'];
const KINDS = ['tab', 'routine', 'workflow'];

// First match wins, so the order settles "fix the failing test" (a fix) and
// "review the docs" (a review).
const RULES = [
  ['review', /\b(review|look over|code review|audit|critique|sanity[- ]check|go over)\b/],
  ['fix', /\b(fix(es|ed|ing)?|bug(s|gy)?|broken|crash(es|ing)?|error(s)?|fail(s|ing|ed|ure)?|debug|regression|doesn'?t work|not working|issue)\b/],
  ['tests', /\b(tests?|testing|spec(s)?|coverage|unit test|e2e|jest|vitest|pytest)\b/],
  ['refactor', /\b(refactor(ing)?|restructure|rename|extract|split (up|out)|clean ?up the code|simplify|reorgani[sz]e|move .* into)\b/],
  ['docs', /\b(docs?|documentation|readme|changelog|comments?|docstrings?|jsdoc)\b/],
  ['tidy', /\b(tidy|lint|format(ting)?|prettier|typos?|bump|upgrade|update (the )?dep(endencie)?s|sort|organi[sz]e|summari[sz]e|summary|commit|push)\b/],
  ['feature', /\b(add|build|create|implement|make|new|support|write|introduce|feature|wire up)\b/],
];
const QUESTION = /^(what|why|how|where|when|who|which|is|are|does|do|can|could|should|would|explain|tell me|show me)\b/;

/** What kind of ask a prompt is. Only this word is kept, never the prompt. */
function classify(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return 'other';
  const asked = QUESTION.test(t) || t.endsWith('?');
  for (const [cat, re] of RULES) {
    // A question about something ("why does this fail?") is still that something,
    // but "how do I add…" or "what's new" is just a question.
    if (re.test(t) && !(asked && cat === 'feature')) return cat;
  }
  return asked ? 'question' : 'other';
}

/** A prompt's length as a bucket: short, medium or long. */
function sizeOf(text) {
  const n = String(text || '').length;
  return n < 200 ? 's' : n < 1000 ? 'm' : 'l';
}

/** 'claude-opus-4-8' -> 'opus', 'sonnet' -> 'sonnet'; '' when there's nothing to go on. */
function modelFamily(id) {
  const m = String(id || '').toLowerCase().match(/opus|sonnet|haiku|fable/);
  return m ? m[0] : '';
}

const num = v => (Number.isFinite(v) && v >= 0 ? v : null);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

function cleanTokens(t) {
  if (!t || typeof t !== 'object') return null;
  const out = { input: num(t.input) || 0, output: num(t.output) || 0, cacheRead: num(t.cacheRead) || 0, cacheWrite: num(t.cacheWrite) || 0 };
  return out.input + out.output + out.cacheRead + out.cacheWrite ? out : null;
}

/** One row read from disk or handed in, cleaned, or null if it can't be used. */
function normalizeRow(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.at)) return null;
  const weight = num(r.weight) || 0;
  const pctRise = num(r.pctRise);
  if (!weight && pctRise === null) return null;
  return {
    at: r.at,
    pk: clip(r.pk, 400).toLowerCase() || null,
    project: clip(r.project, 80) || null,
    model: clip(r.model, 60),
    category: CATEGORIES.includes(r.category) ? r.category : 'other',
    size: SIZES.includes(r.size) ? r.size : 's',
    kind: KINDS.includes(r.kind) ? r.kind : 'tab',
    rid: typeof r.rid === 'string' && /^[\w-]{1,64}$/.test(r.rid) ? r.rid : null,
    weight: Math.round(weight),
    pctRise,
    durationMs: num(r.durationMs),
    turns: num(r.turns),
    tokens: cleanTokens(r.tokens),
    ok: r.ok !== false,
  };
}

/** Whatever was saved, as rows oldest first, within the last 60 days and the cap. */
function normalize(raw, now) {
  return (Array.isArray(raw) ? raw : []).map(normalizeRow).filter(r => r && now - r.at < KEEP_MS)
    .sort((a, b) => a.at - b.at).slice(-MAX_ROWS);
}

/** The ledger plus one turn's row (a new array; old rows pruned, capped). */
function record(ledger, row, now) {
  const kept = (Array.isArray(ledger) ? ledger : []).filter(r => now - r.at < KEEP_MS);
  const clean = normalizeRow({ ...row, at: now });
  return (clean ? [...kept, clean] : kept).slice(-MAX_ROWS);
}

/**
 * How far the 5-hour window rose between two readings ({ pct, resetsAt }),
 * or null with nothing to compare. A new window starts from nothing, so all
 * of its level is the rise; resets a few minutes apart are the same window.
 */
function riseOf(prev, next) {
  if (!prev || !next || !Number.isFinite(prev.pct) || !Number.isFinite(next.pct)) return null;
  const same = Number.isFinite(prev.resetsAt) && Number.isFinite(next.resetsAt)
    ? Math.abs(prev.resetsAt - next.resetsAt) < WINDOW_SLACK_MS
    : next.pct >= prev.pct;
  return same ? Math.max(0, next.pct - prev.pct) : next.pct;
}

/** Percent of the window per unit of weight, from rows that have both; null without enough. */
function ratioOf(ledger) {
  const both = ledger.filter(r => r.pctRise !== null && r.weight > 0).slice(-RATIO_ROWS);
  if (both.length < MIN_SAMPLES) return null;
  const pct = both.reduce((n, r) => n + r.pctRise, 0);
  const weight = both.reduce((n, r) => n + r.weight, 0);
  return pct > 0 && weight > 0 ? pct / weight : null;
}

/** What one row cost as % of the window, or null when it can't be said. */
function pctOf(row, ratio) {
  if (row.pctRise !== null) return row.pctRise;
  return ratio !== null && row.weight > 0 ? row.weight * ratio : null;
}

/** The p-th quantile (0..1) of sorted numbers, interpolated. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round1 = n => Math.round(n * 10) / 10;

/**
 * What a turn like this usually costs. query: { pk, category, model, now }.
 * -> { pct, low, high, samples, basis } where pct is the median % of the
 * 5-hour window and low/high the middle half. basis says what it's drawn
 * from: 'project+kind' (this project, this kind of ask), 'project', 'kind'
 * (this kind of ask anywhere), or 'none' (fewer than 3 to go on).
 * Within a tier, rows on the same model family are preferred when there are enough.
 */
function estimate(ledger, { pk = null, category = 'other', model = '', now = Date.now() } = {}) {
  const rows = (Array.isArray(ledger) ? ledger : []).filter(r => now - r.at < KEEP_MS && r.ok !== false);
  const ratio = ratioOf(rows);
  const key = pk ? String(pk).toLowerCase() : null;
  const family = modelFamily(model);
  const tiers = [
    ['project+kind', r => !!key && r.pk === key && r.category === category],
    ['project', r => !!key && r.pk === key],
    ['kind', r => r.category === category],
  ];
  for (const [basis, match] of tiers) {
    let costs = rows.filter(match).map(r => ({ r, pct: pctOf(r, ratio) })).filter(x => x.pct !== null);
    const same = family ? costs.filter(x => modelFamily(x.r.model) === family) : [];
    if (same.length >= MIN_SAMPLES) costs = same;
    if (costs.length < MIN_SAMPLES) continue;
    const sorted = costs.slice(-RECENT).map(x => x.pct).sort((a, b) => a - b);
    return {
      pct: round1(quantile(sorted, 0.5)), low: round1(quantile(sorted, 0.25)), high: round1(quantile(sorted, 0.75)),
      samples: sorted.length, basis,
    };
  }
  return { pct: null, low: null, high: null, samples: 0, basis: 'none' };
}

/**
 * Would this estimate carry the 5-hour window past the line? The line is
 * 100 − reserve with the spending guard on (guard.js), else 100. usage is the
 * last reading (limits.js shape); a reading for a window already reset says
 * nothing. -> { over, line, now: current %, left, resetsAt } (over false, the
 * rest null, without a current reading).
 */
function advise(est, usage, { on = true, reserve = 25 } = {}, now = Date.now()) {
  const w = usage?.fiveHour;
  const line = on ? 100 - reserve : 100;
  if (!w || !Number.isFinite(w.pct) || !Number.isFinite(w.resetsAt) || w.resetsAt <= now) return { over: false, line, now: null, left: null, resetsAt: null };
  const left = Math.max(0, line - w.pct);
  const over = est?.basis !== 'none' && Number.isFinite(est?.pct) && est.pct > 0 && w.pct + est.pct > line;
  return { over, line, now: w.pct, left, resetsAt: w.resetsAt };
}

/**
 * Should a message be held for the reset instead of sent? Only when you've
 * asked for it, there's an estimate to go on, it would cross the line, and
 * it's yours: routines and workflows have the spending guard instead.
 */
function shouldHold({ enabled, estimate: est, advice, kind = 'tab' }) {
  return !!enabled && kind === 'tab' && est?.basis !== 'none' && !!advice?.over;
}

/**
 * A suggestion for a routine on a top model whose runs are small: 'sonnet'
 * (say "Runs like this usually suit Sonnet"), or null. Never changes anything.
 * routine: { id, model }; defaultModel: what '' means today (config.model).
 */
const SMALL_RUN_PCT = 3;
function routineSuggestion(ledger, routine, defaultModel = '', now = Date.now()) {
  if (!routine?.id) return null;
  const family = modelFamily(routine.model || defaultModel);
  // '' with no default set is Claude Code's own pick, which is usually the top model.
  if (family && family !== 'opus' && family !== 'fable') return null;
  const rows = (Array.isArray(ledger) ? ledger : []).filter(r => r.rid === routine.id && now - r.at < KEEP_MS);
  const ratio = ratioOf(Array.isArray(ledger) ? ledger : []);
  const costs = rows.map(r => pctOf(r, ratio)).filter(p => p !== null);
  if (costs.length < MIN_SAMPLES) return null;
  const mean = costs.reduce((n, p) => n + p, 0) / costs.length;
  return mean <= SMALL_RUN_PCT ? 'sonnet' : null;
}

module.exports = {
  classify, sizeOf, modelFamily, normalize, normalizeRow, record, riseOf, ratioOf, estimate, advise, shouldHold,
  routineSuggestion, quantile, CATEGORIES, KEEP_MS, MAX_ROWS, MIN_SAMPLES, SMALL_RUN_PCT,
};
