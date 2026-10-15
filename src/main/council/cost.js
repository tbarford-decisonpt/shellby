// What a sitting costs: a range before it sits, and what it did cost after.
// Before, each call is priced from a low and a high guess at its tokens, at the
// model's rate (spend.js weightOf, so the prices live in one place); the read is
// anything from a short look to its cap. After, it's the cost Claude Code
// reports for each call, and a call that reported none makes the total "at least".
// Pure: see test/council-cost.test.js.

const { weightOf, USD_PER_WEIGHT } = require('../spend');
const { LOOK_BUDGET_USD } = require('./look');

// Tokens one call reads and writes: [low, high]. The brief (question, project
// notes, facts) is a few thousand tokens; the answers are the schema's sizes.
const CALL_TOKENS = {
  quick: { input: [2000, 6000], output: [2000, 5000] },   // every advisor and the chair at once
  seat: { input: [1500, 5000], output: [400, 1200] },     // one advisor, in Debate
  rebut: { input: [3000, 8000], output: [800, 2000] },    // the round of rebuttals
  chair: { input: [3000, 9000], output: [600, 1500] },    // the chair, after the debate
  pick: { input: [1000, 2000], output: [50, 200] },       // picking who sits, without a read
};
const PICK_MODEL = 'haiku';
// The least a read spends: a short look at a few files. Its most is its cap.
const READ_LOW_USD = 0.03;
const LOW = 0, HIGH = 1;

const usd = weight => weight * USD_PER_WEIGHT;
const callUsd = (kind, model, end) => usd(weightOf({ input_tokens: CALL_TOKENS[kind].input[end], output_tokens: CALL_TOKENS[kind].output[end] }, model));

/** One end of the range: end is LOW or HIGH, seated how many sit. */
function oneEnd({ mode, model, seatModel, seated, read, pick }, end) {
  let total = 0;
  if (read) total += end === LOW ? READ_LOW_USD : LOOK_BUDGET_USD;
  // Without a read, picking is a call of its own; after one, only when the read's pick falls short.
  if (pick && (!read || end === HIGH)) total += callUsd('pick', PICK_MODEL, end);
  if (mode === 'quick') return total + callUsd('quick', model, end);
  return total + seated * callUsd('seat', seatModel, end) + callUsd('rebut', seatModel, end) + callUsd('chair', model, end);
}

/**
 * What a sitting should cost, in dollars: { low, high }.
 * s: { mode, model, seatModel, seats: [fewest, most], read, pick }.
 */
function estimate({ mode, model, seatModel = model, seats, read = false, pick = false }) {
  const [fewest, most] = Array.isArray(seats) ? seats : [seats, seats];
  const base = { mode, model, seatModel, read, pick };
  return { low: oneEnd({ ...base, seated: fewest }, LOW), high: oneEnd({ ...base, seated: most }, HIGH) };
}

/**
 * A sitting's running total after one more call: { cost, unpriced, weight }.
 * r: parse()'s answer ({ cost, usage }), or null for a call with no answer at all.
 * cost is what the calls reported; unpriced counts the calls that reported none,
 * so the total is a floor; weight is their spend.js weight, for the usage meters.
 */
function addCall(totals, r, model) {
  const priced = Number.isFinite(r?.cost);
  return {
    cost: totals.cost + (priced ? r.cost : 0),
    unpriced: totals.unpriced + (priced ? 0 : 1),
    weight: totals.weight + weightOf(r?.usage, model),
  };
}

const NO_CALLS = Object.freeze({ cost: 0, unpriced: 0, weight: 0 });

module.exports = { estimate, addCall, NO_CALLS, CALL_TOKENS, READ_LOW_USD, PICK_MODEL };
