const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/main/council/cost');
const R = require('../src/main/council/run');
const P = require('../src/main/council/prompts');
const { LOOK_BUDGET_USD } = require('../src/main/council/look');
const { weightOf, USD_PER_WEIGHT } = require('../src/main/spend');
const { estimateOf } = require('../src/main/ipc/council');

const usdOf = (kind, model, end) => weightOf({ input_tokens: C.CALL_TOKENS[kind].input[end], output_tokens: C.CALL_TOKENS[kind].output[end] }, model) * USD_PER_WEIGHT;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('a Quick estimate is one call priced at the model rate, low below high', () => {
  const e = C.estimate({ mode: 'quick', model: 'sonnet', seats: 4 });
  close(e.low, usdOf('quick', 'sonnet', 0));
  close(e.high, usdOf('quick', 'sonnet', 1));
  assert.ok(e.low > 0 && e.low < e.high);
});

test('a dearer model makes a dearer estimate', () => {
  const haiku = C.estimate({ mode: 'quick', model: 'haiku', seats: 4 });
  const opus = C.estimate({ mode: 'quick', model: 'opus', seats: 4 });
  assert.ok(opus.low > haiku.low && opus.high > haiku.high);
});

test('reading the project adds anything from a short look up to its cap', () => {
  const plain = C.estimate({ mode: 'quick', model: 'sonnet', seats: 4 });
  const read = C.estimate({ mode: 'quick', model: 'sonnet', seats: 4, read: true });
  close(read.low - plain.low, C.READ_LOW_USD);
  close(read.high - plain.high, LOOK_BUDGET_USD);
});

test('a Debate estimate grows with every seat, priced at the seats’ smaller model', () => {
  const at = n => C.estimate({ mode: 'debate', model: 'opus', seatModel: R.SEAT_MODEL.opus, seats: n });
  close(at(4).low - at(3).low, usdOf('seat', R.SEAT_MODEL.opus, 0));
  close(at(4).high - at(3).high, usdOf('seat', R.SEAT_MODEL.opus, 1));
  assert.ok(at(3).high > C.estimate({ mode: 'quick', model: 'opus', seats: 3 }).high);
});

test('when he picks, the range runs from the fewest seats to the most, with the pick call', () => {
  const e = C.estimate({ mode: 'debate', model: 'sonnet', seatModel: 'haiku', seats: [3, 5], pick: true });
  const fewest = C.estimate({ mode: 'debate', model: 'sonnet', seatModel: 'haiku', seats: 3 });
  const most = C.estimate({ mode: 'debate', model: 'sonnet', seatModel: 'haiku', seats: 5 });
  close(e.low, fewest.low + usdOf('pick', C.PICK_MODEL, 0));
  close(e.high, most.high + usdOf('pick', C.PICK_MODEL, 1));
});

test('the panel’s estimate follows the saved settings, and skips a read it can’t do', () => {
  const s = P.normalize({ mode: 'quick', model: 'sonnet', read: true, pick: false });
  const canRead = estimateOf(s, true), cannot = estimateOf(s, false);
  close(canRead.high - cannot.high, LOOK_BUDGET_USD);
  const picked = estimateOf(P.normalize({ mode: 'debate', model: 'sonnet', pick: true }), false);
  assert.ok(picked.high > estimateOf(P.normalize({ mode: 'debate', model: 'sonnet', pick: false, seated: P.DEFAULT_IDS.slice(0, 3) }), false).high);
});

test('addCall totals reported costs, counts the calls that reported none, and weighs usage', () => {
  let t = C.NO_CALLS;
  t = C.addCall(t, { cost: 0.02, usage: { input_tokens: 1000, output_tokens: 100 } }, 'sonnet');
  t = C.addCall(t, { cost: null, usage: null }, 'haiku');
  t = C.addCall(t, null, 'opus');
  t = C.addCall(t, { cost: 0.01, usage: { input_tokens: 500 } }, 'haiku');
  close(t.cost, 0.03);
  assert.equal(t.unpriced, 2);
  assert.equal(t.weight, weightOf({ input_tokens: 1000, output_tokens: 100 }, 'sonnet') + weightOf({ input_tokens: 500 }, 'haiku'));
  assert.deepEqual(C.NO_CALLS, { cost: 0, unpriced: 0, weight: 0 });
});

test('parse keeps a missing cost as null, not zero', () => {
  const r = R.parse(JSON.stringify({ structured_output: { a: 1 } }));
  assert.equal(r.cost, null);
  assert.equal(R.parse(JSON.stringify({ structured_output: { a: 1 }, total_cost_usd: 0.004, usage: { input_tokens: 5 } })).usage.input_tokens, 5);
});

const settings = { mode: 'debate', model: 'sonnet', read: false, pick: false, seated: P.DEFAULT_IDS.slice(0, 3) };
const flag = (args, name) => args[args.indexOf(name) + 1];
const schemaOf = args => JSON.parse(flag(args, '--json-schema'));
const opinion = { stance: 'Do it', argument: 'Yes.', risks: [], vote: 'for', condition: '', wouldChange: '', cites: [], confidence: 70 };
const chair = { decision: 'do', verdict: 'Go.', against: '', agree: [], split: [], next: [], open: [], cites: [], confidence: 70 };

function answer(args) {
  const p = schemaOf(args).properties;
  if (p.stance) return opinion;
  if (p.rebuttals) return { rebuttals: [] };
  return chair;
}

test('a sitting adds up every call it made, and says when some reported no cost', async () => {
  let n = 0;
  const run = async args => {
    n++;
    if (n === 2) return { stdout: JSON.stringify({ structured_output: answer(args) }), stderr: '', timedOut: false }; // no cost in it
    return { stdout: JSON.stringify({ structured_output: answer(args), total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 200 } }), stderr: '', timedOut: false };
  };
  const r = await R.convene({ question: 'Ship it?', settings, cwd: '.' }, run);
  assert.equal(r.ok, true);
  assert.equal(r.calls, 5);
  close(r.cost, 0.04);
  assert.equal(r.unpriced, 1);
  assert.ok(r.weight > 0);
});

test('a sitting that fails still says what it spent', async () => {
  const run = async () => ({ stdout: '', stderr: 'boom', timedOut: true });
  const r = await R.convene({ question: 'Ship it?', settings, cwd: '.' }, run);
  assert.equal(r.ok, false);
  assert.equal(r.cost, 0);
  assert.equal(r.unpriced, 3);
  assert.equal(r.calls, 3);
});

test('Past sessions list what each sitting cost, and the Council counts on the usage meters', () => {
  const { summary } = require('../src/main/council/store');
  const spend = require('../src/main/spend');
  const s = summary({ id: 'a', at: 1, question: 'q', mode: 'quick', tally: {}, cost: 0.12, unpriced: 1 });
  assert.equal(s.cost, 0.12);
  assert.equal(s.unpriced, 1);
  assert.equal(summary({ id: 'b', at: 1, question: 'q', mode: 'quick', tally: {} }).cost, null);
  const ledger = spend.record([], { key: 'c:council', kind: 'council', label: 'Council', project: 'shellby' }, 500, 1e12);
  assert.equal(spend.breakdown(ledger, 0, 'task')[0].kind, 'council');
});
