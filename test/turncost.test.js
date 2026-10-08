const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const tc = require('../src/main/turncost');
const spend = require('../src/main/spend');
const { CROWDED_PCT } = require('../src/main/context');
const { ClaudeSession } = require('../src/main/session');

const ctxAt = (tokens, window = 200000) => ({ tokens, window, pct: Math.round((tokens / window) * 100) });

test('a call repeated across events counts once, at its largest', () => {
  const a = tc.mergeUsage(null, { input_tokens: 10, output_tokens: 5 });
  const b = tc.mergeUsage(a, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 900 });
  assert.deepEqual(b, { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 40 });
  assert.deepEqual(tc.mergeUsage(b, { output_tokens: 'lots', input_tokens: -3 }), b);
});

test('new tokens and cache re-reads are kept apart', () => {
  const t = tc.tokensOf([
    { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: 300 },
    { input_tokens: 20, cache_read_input_tokens: 52000, output_tokens: 80 },
  ]);
  assert.deepEqual(t, { fresh: 2500, read: 102000 });
  assert.deepEqual(tc.tokensOf(null), { fresh: 0, read: 0 });
});

test("a turn's share of the window is its part of what Shellby spent, times how full it is", () => {
  assert.equal(tc.windowShare({ weight: 100, windowWeight: 1000, windowPct: 30 }), 3);
  // Spent nothing else this window: the whole reading is put down to it.
  assert.equal(tc.windowShare({ weight: 100, windowWeight: 100, windowPct: 12 }), 12);
  // A ledger that lags the turn can't make it more than the whole window.
  assert.equal(tc.windowShare({ weight: 500, windowWeight: 100, windowPct: 12 }), 12);
  assert.equal(tc.windowShare({ weight: 100, windowWeight: 1000, windowPct: 0 }), 0);
});

test('no share without something spent or a reading to go on', () => {
  assert.equal(tc.windowShare({ weight: 0, windowWeight: 1000, windowPct: 30 }), null);
  assert.equal(tc.windowShare({ weight: 100, windowWeight: 1000, windowPct: null }), null);
  assert.equal(tc.windowShare({ weight: 100, windowWeight: 1000, windowPct: -1 }), null);
});

test('a turn that made no calls has no cost', () => {
  assert.equal(tc.turnCost({ usages: [], weight: 0 }, ctxAt(1000)), null);
  assert.equal(tc.turnCost(null, null), null);
  const c = tc.turnCost({ usages: [{ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000 }], weight: 42 }, ctxAt(82000));
  assert.deepEqual(c, { tokens: 1500, read: 4000, weight: 42, share: null, contextPct: 41 });
});

test('numbers read the way the panel writes them', () => {
  assert.equal(tc.compact(0), '0');
  assert.equal(tc.compact(950), '950');
  assert.equal(tc.compact(1500), '1.5k');
  assert.equal(tc.compact(2000), '2k');
  assert.equal(tc.compact(18432), '18k');
  assert.equal(tc.compact(1240000), '1.2M');
  assert.equal(tc.compact(23000000), '23M');
  assert.equal(tc.compact(NaN), '0');
});

test('a share is always said as an estimate', () => {
  assert.equal(tc.shareText(0.4), '<1%');
  assert.equal(tc.shareText(3.4), '~3%');
  assert.equal(tc.shareText(12.6), '~13%');
  assert.equal(tc.shareText(null), null);
});

test('the turn line says what it has and leaves out what it lacks', () => {
  const full = { tokens: 18000, read: 900000, weight: 1, share: 3.2, contextPct: 41 };
  assert.equal(tc.costLine(full), 'this turn: 18k tokens · ~3% of your 5-hour window · 41% of context');
  assert.equal(tc.costLine({ ...full, share: null }), 'this turn: 18k tokens · 41% of context');
  assert.equal(tc.costLine({ ...full, share: null, contextPct: null }), 'this turn: 18k tokens');
  assert.equal(tc.costLine(null), '');
  assert.match(tc.costDetail(full), /18,000 new tokens/);
  assert.match(tc.costDetail(full), /900k re-read from the prompt cache/);
  assert.match(tc.costDetail(full), /estimate/);
  assert.doesNotMatch(tc.costDetail({ ...full, share: null, read: 0 }), /estimate|cache/);
});

test("a transcript's turns pair each cost with the message that started it", () => {
  const items = [
    { kind: 'user', text: 'Fix the login bug', turnId: 'a' },
    { kind: 'text', text: 'Done.' },
    { kind: 'result', ok: true, cost: { tokens: 1000, read: 5000, weight: 50, share: 1.5 } },
    { kind: 'user', text: '/compact', turnId: 'b' },
    { kind: 'result', ok: true },
    { kind: 'user', text: `Now write tests for ${'every single module '.repeat(5)}` },
    { kind: 'result', ok: true, cost: { tokens: 9000, read: 0, weight: 400, share: null } },
  ];
  const turns = tc.turnsOf(items);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], { turnId: 'a', prompt: 'Fix the login bug', tokens: 1000, read: 5000, weight: 50, share: 1.5 });
  assert.equal(turns[1].turnId, null, 'an old message without an id');
  assert.ok(turns[1].prompt.endsWith('…') && turns[1].prompt.length <= 60);
  assert.deepEqual(tc.turnsOf('junk'), []);
});

test('the costliest turns come by what they took from the window, then by tokens', () => {
  const turns = [
    { turnId: 'a', tokens: 50000, weight: 100 },
    { turnId: 'b', tokens: 1000, weight: 900 },
    { turnId: 'c', tokens: 3000, weight: 100 },
    { turnId: 'd', tokens: 0, weight: 0 },
    { turnId: 'e', tokens: 10, weight: 5 },
  ];
  assert.deepEqual(tc.topTurns(turns).map(t => t.turnId), ['b', 'a', 'c']);
  assert.deepEqual(tc.topTurns(turns, 10).map(t => t.turnId), ['b', 'a', 'c', 'e'], 'a turn that cost nothing is never listed');
  assert.deepEqual(tc.topTurns([]), []);
});

test("a tab's running total adds up its turns", () => {
  const items = [
    { kind: 'user', text: 'one', turnId: 'a' },
    { kind: 'result', cost: { tokens: 1000, read: 10, weight: 5 } },
    { kind: 'user', text: 'two', turnId: 'b' },
    { kind: 'result', cost: { tokens: 2500, read: 20, weight: 50 } },
  ];
  const t = tc.tabTotal(items);
  assert.equal(t.tokens, 3500);
  assert.equal(t.read, 30);
  assert.equal(t.turns, 2);
  assert.equal(t.top[0].turnId, 'b');
  assert.deepEqual(tc.tabTotal([]), { tokens: 0, read: 0, turns: 0, top: [] });
});

test('the pace keeps the last few turns that grew the context', () => {
  let g = [];
  g = tc.addGrowth(g, 1000, 5000);
  g = tc.addGrowth(g, 5000, 4000);   // compacted: not a pace
  g = tc.addGrowth(g, null, 9000);   // a brand-new conversation: its first turn is mostly setup
  assert.deepEqual(g, [4000]);
  for (let i = 0; i < 5; i++) g = tc.addGrowth(g, 0, i + 1);
  assert.equal(g.length, tc.RECENT_TURNS);
  assert.deepEqual(g, [3, 4, 5]);
});

test('turns left until crowded, at the pace of the last few', () => {
  const mark = (CROWDED_PCT / 100) * 200000;
  assert.equal(tc.turnsLeft(ctxAt(mark - 20000), [10000, 10000]), 2);
  assert.equal(tc.turnsLeft(ctxAt(mark - 20000), [15000]), 2, 'a part turn rounds up');
  assert.equal(tc.turnsLeft(ctxAt(mark + 1), [10000]), 0);
  assert.equal(tc.turnsLeft(ctxAt(mark - 20000), []), null, 'no pace yet');
  assert.equal(tc.turnsLeft(null, [1000]), null);
});

test('no nudge while there is room, or while the pace is slow', () => {
  assert.equal(tc.nudge(ctxAt(100000), [30000]), null, 'under the soon mark');
  assert.equal(tc.nudge(ctxAt(130000), [1000, 1000]), null, 'past it, but many turns to go');
  assert.equal(tc.nudge(ctxAt(130000), []), null, 'past it, but no pace to judge');
  assert.equal(tc.nudge(null, [1000]), null);
});

test('a nudge before it gets crowded, then the crowded one, never both', () => {
  const soon = tc.nudge(ctxAt(140000), [10000]);
  assert.equal(soon.level, 'soon');
  assert.equal(soon.text, 'Filling up: 70% full, about 2 turns from crowded at this pace.');
  assert.match(tc.nudge(ctxAt(150000), [10000]).text, /about a turn from crowded/);
  const crowded = tc.nudge(ctxAt(170000), [1]);
  assert.equal(crowded.level, 'crowded');
  assert.match(crowded.text, /^Getting crowded: 85% full\./);
  assert.equal(tc.nudge(ctxAt(170000), []).level, 'crowded', 'crowded needs no pace');
});

test("the ledger says what everything, or one tab, spent in a window", () => {
  const NOW = 1_790_000_000_000;
  const src = key => ({ key, kind: 'tab', label: key, project: 'p' });
  let l = [];
  l = spend.record(l, src('t:a'), 100, NOW - 6 * 60 * 60 * 1000); // before the window
  l = spend.record(l, src('t:a'), 50, NOW);
  l = spend.record(l, src('t:b'), 30, NOW);
  const since = NOW - 60 * 60 * 1000;
  assert.equal(spend.weightSince(l, since), 80);
  assert.equal(spend.weightSince(l, since, 't:a'), 50);
  assert.equal(spend.weightSince(l, since, 't:c'), 0);
  assert.equal(spend.weightSince(null, since), 0);
});

test('a running turn reports its tokens so far, once per growth, as its result will count them', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  const seen = [];
  s.on('tokens', n => seen.push(n));
  s.turn = { usages: new Map(), weight: 0, tokens: 0, before: null };
  s.countSpend({ messageId: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 10 } });
  s.countSpend({ messageId: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 10 } }); // repeated: no news
  s.countSpend({ messageId: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 40000 } });
  s.countSpend({ messageId: 'sub1', model: 'claude-haiku-4-5', usage: { input_tokens: 300 } });
  assert.deepEqual(seen, [110, 150, 450]);
  assert.equal(s.turn.tokens, 450);
  // Between turns there's nothing running to count.
  s.turn = null;
  s.countSpend({ messageId: 'm2', model: 'claude-haiku-4-5', usage: { input_tokens: 5 } });
  assert.deepEqual(seen, [110, 150, 450]);
});

test("a session puts the turn's cost on its result, helpers' calls included", () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  const items = [];
  s.on('item', i => items.push(i));
  s.turn = { usages: new Map(), weight: 0, before: 40000 };
  s.countSpend({ messageId: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 10 } });
  s.countSpend({ messageId: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 40000 } });
  s.countSpend({ messageId: 'sub1', model: 'claude-haiku-4-5', usage: { input_tokens: 300 } });
  s.context = ctxAt(50000);
  s.handle({ kind: 'result', ok: true });
  const r = items.find(i => i.kind === 'result');
  assert.equal(r.cost.tokens, 450);
  assert.equal(r.cost.read, 40000);
  assert.equal(r.cost.contextPct, 25);
  assert.ok(r.cost.weight > 0);
  assert.deepEqual(s.growths, [10000]);
  assert.equal(s.turn, null);
  // A result with no turn behind it (Claude Code's own, after a restart) carries nothing.
  s.handle({ kind: 'result', ok: true });
  assert.equal(items.filter(i => i.kind === 'result')[1].cost, undefined);
});
