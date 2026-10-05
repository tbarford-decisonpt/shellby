// What a turn cost, and what a conversation has cost so far. On a Pro or Max
// plan that isn't money: it's tokens, a share of the 5-hour window, and room in
// the context window. Built from what Shellby already counts: each call's token
// counts (stream.js spendFrom), the model-weighted spend ledger (spend.js) and
// the 5-hour reading Claude Code reports (limits.js).
//
// A turn's share of the 5-hour window is an estimate. Claude Code only says how
// full the window is, in whole percents, so a turn's share is its part of what
// Shellby spent in this window, times how full the window is. Claude used
// outside Shellby fills the window too, so the estimate leans high, never low.
//
// Also when to nudge before a conversation gets crowded: the pace it's been
// filling at says how many turns like the last few it has left.
// Pure functions: no Electron, no I/O — see test/turncost.test.js.

const { CROWDED_PCT } = require('./context');

// Past this, a conversation that will be crowded within SOON_TURNS gets a nudge.
const SOON_PCT = 60;
const SOON_TURNS = 2;
const RECENT_TURNS = 3;  // the pace is the average growth of the last few turns
const TOP_TURNS = 3;     // the costliest turns the context menu lists

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

/**
 * One call's usage after another event for the same call: Claude Code repeats
 * a call's usage on each of its events, growing as it writes, so the larger of
 * each count is the call so far.
 */
function mergeUsage(prev, next) {
  const out = {};
  for (const f of USAGE_FIELDS) out[f] = Math.max(num(prev?.[f]), num(next?.[f]));
  return out;
}

/**
 * Tokens over a turn's calls: { fresh, read }. fresh is what the turn sent and
 * wrote for the first time (input, cache writes, output); read is what it
 * re-read from the prompt cache, at a tenth of the price.
 */
function tokensOf(usages) {
  let fresh = 0, read = 0;
  for (const u of usages || []) {
    fresh += num(u?.input_tokens) + num(u?.cache_creation_input_tokens) + num(u?.output_tokens);
    read += num(u?.cache_read_input_tokens);
  }
  return { fresh, read };
}

/**
 * A share of the 5-hour window, in percent, or null with nothing to go on.
 * weight: what the turn (or tab) spent; windowWeight: everything Shellby spent
 * in this window, the turn included; windowPct: how full the window is.
 */
function windowShare({ weight, windowWeight, windowPct }) {
  if (!num(weight) || !Number.isFinite(windowPct) || windowPct < 0) return null;
  const total = Math.max(num(windowWeight), weight);
  return Math.min(windowPct, (weight / total) * windowPct);
}

/**
 * What one turn cost, as the result item carries it, or null for a turn that
 * made no calls (a local command, one stopped before it started).
 * turn: { usages, weight }; context: the conversation's reading after it.
 */
function turnCost(turn, context) {
  const { fresh, read } = tokensOf(turn?.usages);
  if (!fresh && !read) return null;
  return { tokens: fresh, read, weight: num(turn?.weight), share: null, contextPct: Number.isFinite(context?.pct) ? context.pct : null };
}

/** 18000 -> "18k", 1240000 -> "1.2M", as the panel's other counts read. */
function compact(n) {
  const v = num(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

/** A share of the window in words: "<1%", "~3%". Always "~": it's an estimate. */
const shareText = pct => (!Number.isFinite(pct) ? null : pct < 1 ? '<1%' : `~${Math.round(pct)}%`);

/** "this turn: 18k tokens · ~3% of your 5-hour window · 41% of context" */
function costLine(cost) {
  if (!cost) return '';
  const share = shareText(cost.share);
  return [
    `this turn: ${compact(cost.tokens)} tokens`,
    share ? `${share} of your 5-hour window` : null,
    Number.isFinite(cost.contextPct) ? `${cost.contextPct}% of context` : null,
  ].filter(Boolean).join(' · ');
}

/** The longer version, for the line's tooltip: what each number means. */
function costDetail(cost) {
  if (!cost) return '';
  return [
    `${cost.tokens.toLocaleString('en-GB')} new tokens: what this turn sent and Claude wrote.`,
    cost.read ? `Plus ${compact(cost.read)} re-read from the prompt cache, at a tenth of the price.` : null,
    Number.isFinite(cost.share) ? 'The share of your 5-hour window is an estimate: Claude Code only says how full the window is, and Claude used outside Shellby fills it too.' : null,
  ].filter(Boolean).join('\n');
}

const PROMPT_CHARS = 60;
const promptOf = text => {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return t.length > PROMPT_CHARS ? `${t.slice(0, PROMPT_CHARS - 1)}…` : t;
};

/**
 * A conversation's turns from its transcript: [{ turnId, prompt, tokens, read,
 * weight, share }] in order, each result with a cost paired with the message
 * that started it. A turn with no message id (an old transcript) has turnId null.
 */
function turnsOf(items) {
  const out = [];
  let turnId = null, prompt = '';
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.kind === 'user') {
      turnId = typeof it.turnId === 'string' ? it.turnId : null;
      prompt = promptOf(it.text);
    }
    if (it?.kind !== 'result' || !it.cost || typeof it.cost !== 'object') continue;
    out.push({ turnId, prompt, tokens: num(it.cost.tokens), read: num(it.cost.read), weight: num(it.cost.weight), share: Number.isFinite(it.cost.share) ? it.cost.share : null });
  }
  return out;
}

/** The n costliest turns, by weight (what fills the window), then tokens. */
function topTurns(turns, n = TOP_TURNS) {
  return [...(turns || [])]
    .filter(t => t.weight || t.tokens)
    .sort((a, b) => b.weight - a.weight || b.tokens - a.tokens)
    .slice(0, n);
}

/** { tokens, read, turns, top } over a conversation's transcript. */
function tabTotal(items) {
  const turns = turnsOf(items);
  return {
    tokens: turns.reduce((s, t) => s + t.tokens, 0),
    read: turns.reduce((s, t) => s + t.read, 0),
    turns: turns.length,
    top: topTurns(turns),
  };
}

/** Recent context growth per turn, newest last, for the pace: add one turn's rise. */
function addGrowth(growths, before, after) {
  const list = Array.isArray(growths) ? growths : [];
  if (!Number.isFinite(before) || !Number.isFinite(after) || after <= before) return list;
  return [...list, after - before].slice(-RECENT_TURNS);
}

/** Turns like the last few until the crowded mark: 0 when there already, null with no pace. */
function turnsLeft(context, growths) {
  if (!num(context?.tokens) || !num(context?.window)) return null;
  const room = (CROWDED_PCT / 100) * context.window - context.tokens;
  if (room <= 0) return 0;
  const recent = (growths || []).filter(num);
  if (!recent.length) return null;
  const pace = recent.reduce((s, g) => s + g, 0) / recent.length;
  return Math.ceil(room / pace);
}

/**
 * The nudge above the box, or null: 'soon' when a conversation past SOON_PCT
 * will be crowded within a couple of turns at its pace, 'crowded' past the mark.
 * One nudge, worded for where it is, so there's never a second warning.
 */
function nudge(context, growths) {
  const pct = context?.pct;
  if (!Number.isFinite(pct) || pct < SOON_PCT) return null;
  if (pct >= CROWDED_PCT) {
    return { level: 'crowded', text: `Getting crowded: ${pct}% full. Making room now keeps the replies sharp.` };
  }
  const left = turnsLeft(context, growths);
  if (left === null || left > SOON_TURNS) return null;
  const turns = left <= 1 ? 'a turn' : `${left} turns`;
  return { level: 'soon', text: `Filling up: ${pct}% full, about ${turns} from crowded at this pace.` };
}

module.exports = {
  mergeUsage, tokensOf, windowShare, turnCost, compact, shareText, costLine, costDetail,
  turnsOf, topTurns, tabTotal, addGrowth, turnsLeft, nudge,
  SOON_PCT, SOON_TURNS, RECENT_TURNS, TOP_TURNS,
};
