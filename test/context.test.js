const { test } = require('node:test');
const assert = require('node:assert/strict');
const ctx = require('../src/main/context');
const { toItems } = require('../src/main/stream');

const reply = (usage, extra = {}) => ({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [] }, parent_tool_use_id: null, ...extra });

test('counts everything the call read and wrote as the conversation so far', () => {
  const t = ctx.tokensFrom(reply({ input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: 300 }));
  assert.deepEqual(t, { tokens: 52310, model: 'claude-opus-5-5' });
});

test('ignores subagent replies, other events and empty usage', () => {
  assert.equal(ctx.tokensFrom(reply({ input_tokens: 999 }, { parent_tool_use_id: 'tu_agent' })), null);
  assert.equal(ctx.tokensFrom({ type: 'result' }), null);
  assert.equal(ctx.tokensFrom(reply({})), null);
  assert.equal(ctx.tokensFrom(reply({ input_tokens: -5, output_tokens: 'x' })), null);
  assert.equal(ctx.tokensFrom(null), null);
});

test('reads context windows from the result event', () => {
  assert.deepEqual(ctx.windowsFrom({ type: 'result', modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 }, 'claude-haiku-4-5': { contextWindow: 200000 } } }),
    { 'claude-opus-5-5': 1000000, 'claude-haiku-4-5': 200000 });
  assert.equal(ctx.windowsFrom({ type: 'result', modelUsage: { x: { inputTokens: 5 } } }), null);
  assert.equal(ctx.windowsFrom({ type: 'result' }), null);
});

test('picks the window for the model, then the largest reported, then a guess from the setting', () => {
  const known = { 'claude-opus-5-5': 1000000, 'claude-haiku-4-5-20251001': 200000 };
  assert.equal(ctx.windowFor('claude-opus-5-5', known), 1000000);
  assert.equal(ctx.windowFor('claude-haiku-4-5', known), 200000);   // prefix match
  assert.equal(ctx.windowFor('something-else', known), 1000000);    // largest
  assert.equal(ctx.windowFor(null, null, 'opus[1m]'), ctx.LONG_WINDOW);
  assert.equal(ctx.windowFor(null, null, 'sonnet'), ctx.DEFAULT_WINDOW);
  assert.equal(ctx.windowFor(null, null, null), ctx.DEFAULT_WINDOW);
});

test('view rounds to a percentage and never shows more than full', () => {
  assert.deepEqual(ctx.view(50000, 200000), { tokens: 50000, window: 200000, pct: 25 });
  assert.equal(ctx.view(250000, 200000).pct, 100);
  assert.equal(ctx.view(0, 200000), null);
  assert.equal(ctx.view(1000, 0), null);
});

test('crossed fires once, on the way past the crowded mark', () => {
  const at = pct => ({ pct });
  assert.equal(ctx.crossed(at(79), at(80)), true);
  assert.equal(ctx.crossed(null, at(91)), true);    // a resumed tab's first reading
  assert.equal(ctx.crossed(at(80), at(85)), false);  // already past it
  assert.equal(ctx.crossed(at(85), at(40)), false);  // compacted
  assert.equal(ctx.crossed(at(40), null), false);
});

test('the handoff prompt carries the summary', () => {
  const p = ctx.handoffPrompt('  Goal: ship it.  ');
  assert.match(p, /Goal: ship it\.\n/);
  assert.match(ctx.HANDOFF_ASK, /Use no tools/);
});

test('a compact boundary becomes a transcript item', () => {
  assert.deepEqual(toItems({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 160000 } }),
    [{ kind: 'compacted', trigger: 'auto', preTokens: 160000 }]);
  assert.deepEqual(toItems({ type: 'system', subtype: 'compact_boundary' }), [{ kind: 'compacted', trigger: 'manual', preTokens: null }]);
});
