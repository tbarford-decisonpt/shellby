// Ultracode: Claude Code's keyword that opts a turn into its Workflow tool, a
// run of many agents in the background (docs/ULTRACODE.md). The words and sums
// both sides need: the keyword the prompt box adds to a message, what a run
// costs at the least, and what to expect before the first one. Pure, no DOM.
// Works in the browser and in Node (for tests).
(function (root) {
  const KEYWORD = 'ultracode';
  // Claude Code matches it as a word: not inside another word, a path or a flag.
  const WORD = /(^|[^\w/\\.?-])ultracode(?![\w-])/i;

  // What weights (spend.js weightOf) are in dollars: Haiku's rate of 1 is $1 per
  // million input tokens.
  const USD_PER_WEIGHT = 1e-6;
  // A token costs at least a cache read: a tenth of the model's input price.
  const CHEAPEST_SHARE = 0.1;
  const RATES = [[/haiku/i, 1], [/sonnet/i, 3], [/opus|fable/i, 5]];
  const DEFAULT_RATE = 3;

  // What a run usually is, for the warning before the first one: how many
  // agents, and the tokens each reads and writes. A guess, said as one.
  const EXPECT_AGENTS = [5, 30];
  const EXPECT_TOKENS = [30000, 200000];

  const hasKeyword = text => typeof text === 'string' && WORD.test(text);

  /** The message as sent with Ultracode on: the keyword on a line of its own at the end, once. */
  function withKeyword(text) {
    const t = typeof text === 'string' ? text.trimEnd() : '';
    if (!t || hasKeyword(t)) return t;
    return `${t}\n\n${KEYWORD}`;
  }

  const rateOf = model => (RATES.find(([re]) => re.test(model || '')) || [null, DEFAULT_RATE])[1];

  /** The least `tokens` can have cost on `model`, in dollars: every one a cache read. */
  const floorUsd = (tokens, model) => (Number.isFinite(tokens) && tokens > 0 ? tokens * rateOf(model) * CHEAPEST_SHARE * USD_PER_WEIGHT : 0);

  /** Weight (spend.js units) for tokens with no split, counted as input: for the usage meters. */
  const weightOfTokens = (tokens, model) => (Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens * rateOf(model)) : 0);

  /** A rough range before the first run, in dollars: { low, high, agents, tokens }. */
  function expect(model) {
    // Four parts read for every one written, priced in full (no cache).
    const usd = tokens => (tokens * 0.8 + tokens * 0.2 * 5) * rateOf(model) * USD_PER_WEIGHT;
    return {
      low: usd(EXPECT_AGENTS[0] * EXPECT_TOKENS[0]),
      high: usd(EXPECT_AGENTS[1] * EXPECT_TOKENS[1]),
      agents: EXPECT_AGENTS.slice(),
      tokens: EXPECT_TOKENS.slice(),
    };
  }

  function money(usd) {
    if (!Number.isFinite(usd) || usd <= 0) return '$0';
    if (usd < 0.01) return '<$0.01';
    return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
  }

  /**
   * The card's cost words. cost: { usd, exact }: exact only when every call
   * reported its price, which Claude Code doesn't do for a run's agents yet.
   */
  function costText(cost) {
    if (!cost || !(cost.usd > 0)) return 'no cost reported yet';
    return cost.exact ? money(cost.usd) : `at least ${money(cost.usd)}`;
  }

  const api = { KEYWORD, hasKeyword, withKeyword, rateOf, floorUsd, weightOfTokens, expect, money, costText, USD_PER_WEIGHT, CHEAPEST_SHARE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyUltracode = api;
})(typeof window !== 'undefined' ? window : globalThis);
