const { test } = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../src/main/turncost');

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// A ledger row as endTurn would leave it, a little before NOW.
const row = (over = {}) => ({
  at: NOW - HOUR, pk: 'c:\\code\\shellby', project: 'shellby', model: 'claude-opus-4-8',
  category: 'fix', size: 's', kind: 'tab', weight: 1000, pctRise: 4, ok: true, ...over,
});

// ---- classify

test('classify sorts prompts into the kind of ask they are', () => {
  const cases = {
    'Review the changes on this branch': 'review',
    'fix the failing login test': 'fix',
    'Why does the build fail on Windows?': 'fix',
    'write unit tests for the parser': 'tests',
    'refactor the auth module into smaller files': 'refactor',
    'update the README with the new flags': 'docs',
    'tidy up the imports and run lint': 'tidy',
    'add a dark mode toggle to settings': 'feature',
    'what does this function do?': 'question',
    'explain how the scheduler picks the next run': 'question',
    'hello there': 'other',
    '': 'other',
  };
  for (const [prompt, want] of Object.entries(cases)) assert.equal(tc.classify(prompt), want, prompt);
});

test('classify treats "how do I add…" as a question, not a feature', () => {
  assert.equal(tc.classify('how do I add a new route?'), 'question');
});

test('sizeOf buckets prompt length into short, medium and long', () => {
  assert.equal(tc.sizeOf('x'.repeat(50)), 's');
  assert.equal(tc.sizeOf('x'.repeat(500)), 'm');
  assert.equal(tc.sizeOf('x'.repeat(5000)), 'l');
});

test('modelFamily reads the family from an alias or a full id', () => {
  assert.equal(tc.modelFamily('claude-opus-4-8'), 'opus');
  assert.equal(tc.modelFamily('sonnet'), 'sonnet');
  assert.equal(tc.modelFamily(''), '');
  assert.equal(tc.modelFamily(null), '');
});

// ---- the ledger

test('record adds a cleaned row stamped now and keeps the prompt out', () => {
  const out = tc.record([], { ...row(), prompt: 'secret words', pk: 'C:\\Code\\Shellby' }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].at, NOW);
  assert.equal(out[0].pk, 'c:\\code\\shellby');
  assert.equal('prompt' in out[0], false);
});

test('record never mutates the ledger it was given', () => {
  const before = [row()];
  const out = tc.record(before, row(), NOW);
  assert.equal(before.length, 1);
  assert.equal(out.length, 2);
});

test('record drops rows older than 60 days', () => {
  const old = row({ at: NOW - 61 * DAY });
  const recent = row({ at: NOW - 59 * DAY });
  const out = tc.record([old, recent], row(), NOW);
  assert.deepEqual(out.map(r => r.at), [recent.at, NOW]);
});

test('record keeps at most MAX_ROWS rows, newest last', () => {
  const full = Array.from({ length: tc.MAX_ROWS }, (_, i) => row({ at: NOW - tc.MAX_ROWS + i }));
  const out = tc.record(full, row({ weight: 7 }), NOW);
  assert.equal(out.length, tc.MAX_ROWS);
  assert.equal(out[out.length - 1].weight, 7);
});

test('record skips a turn that spent nothing at all', () => {
  assert.deepEqual(tc.record([], row({ weight: 0, pctRise: null }), NOW), []);
});

test('normalize tolerates junk from disk and sorts oldest first', () => {
  const out = tc.normalize([null, 'x', { at: 'soon' }, row({ at: NOW - 2 }), row({ at: NOW - 5, category: 'nonsense' })], NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].at, NOW - 5);
  assert.equal(out[0].category, 'other');
  assert.deepEqual(tc.normalize(undefined, NOW), []);
});

// ---- rises

test('riseOf measures a rise within one window and none for a fall', () => {
  const resetsAt = NOW + HOUR;
  assert.equal(tc.riseOf({ pct: 10, resetsAt }, { pct: 14, resetsAt }), 4);
  assert.equal(tc.riseOf({ pct: 10, resetsAt }, { pct: 9, resetsAt: resetsAt + 60000 }), 0);
});

test('riseOf counts all of a new window as its rise', () => {
  assert.equal(tc.riseOf({ pct: 80, resetsAt: NOW - 1000 }, { pct: 3, resetsAt: NOW + 5 * HOUR }), 3);
});

test('riseOf has nothing to say without an earlier reading', () => {
  assert.equal(tc.riseOf(null, { pct: 5, resetsAt: NOW }), null);
});

// ---- estimate

test('estimate uses this project and this kind of ask when there are 3 or more', () => {
  const ledger = [row({ pctRise: 2 }), row({ pctRise: 4 }), row({ pctRise: 6 }), row({ category: 'docs', pctRise: 30 })];
  const e = tc.estimate(ledger, { pk: 'C:\\code\\shellby', category: 'fix', model: 'opus', now: NOW });
  assert.equal(e.basis, 'project+kind');
  assert.equal(e.samples, 3);
  assert.equal(e.pct, 4);
  assert.equal(e.low, 3);
  assert.equal(e.high, 5);
});

test('estimate falls back to the whole project when its kind has too few', () => {
  const ledger = [row({ category: 'docs', pctRise: 1 }), row({ category: 'tidy', pctRise: 3 }), row({ pctRise: 5 })];
  const e = tc.estimate(ledger, { pk: 'c:\\code\\shellby', category: 'feature', now: NOW });
  assert.equal(e.basis, 'project');
  assert.equal(e.pct, 3);
});

test('estimate falls back to the kind of ask across projects for a new project', () => {
  const ledger = [row({ pk: 'c:\\a', pctRise: 8 }), row({ pk: 'c:\\b', pctRise: 10 }), row({ pk: 'c:\\c', pctRise: 12 })];
  const e = tc.estimate(ledger, { pk: 'c:\\brand-new', category: 'fix', now: NOW });
  assert.equal(e.basis, 'kind');
  assert.equal(e.pct, 10);
});

test('estimate says none with fewer than 3 samples anywhere', () => {
  const e = tc.estimate([row(), row()], { pk: 'c:\\code\\shellby', category: 'fix', now: NOW });
  assert.deepEqual(e, { pct: null, low: null, high: null, samples: 0, basis: 'none' });
  assert.equal(tc.estimate([], {}).basis, 'none');
});

test('estimate converts weight to percent from rows that have both when a rise is missing', () => {
  // 1000 weight ~ 2% in the rows with both, so 5000 weight with no reading is ~10%.
  const ledger = [
    row({ category: 'docs', pk: 'c:\\other', weight: 1000, pctRise: 2 }),
    row({ category: 'docs', pk: 'c:\\other', weight: 1000, pctRise: 2 }),
    row({ category: 'docs', pk: 'c:\\other', weight: 1000, pctRise: 2 }),
    row({ weight: 5000, pctRise: null }), row({ weight: 5000, pctRise: null }), row({ weight: 5000, pctRise: null }),
  ];
  const e = tc.estimate(ledger, { pk: 'c:\\code\\shellby', category: 'fix', now: NOW });
  assert.equal(e.basis, 'project+kind');
  assert.equal(e.pct, 10);
});

test('estimate leaves out rows without a rise when there is no ratio to convert with', () => {
  const ledger = [row({ pctRise: null }), row({ pctRise: null }), row({ pctRise: null })];
  assert.equal(tc.estimate(ledger, { pk: 'c:\\code\\shellby', category: 'fix', now: NOW }).basis, 'none');
});

test('estimate prefers the same model family when it has enough of them', () => {
  const ledger = [
    row({ model: 'sonnet', pctRise: 1 }), row({ model: 'sonnet', pctRise: 1 }), row({ model: 'sonnet', pctRise: 1 }),
    row({ model: 'opus', pctRise: 9 }), row({ model: 'opus', pctRise: 9 }), row({ model: 'opus', pctRise: 9 }),
  ];
  assert.equal(tc.estimate(ledger, { pk: 'c:\\code\\shellby', category: 'fix', model: 'claude-sonnet-5', now: NOW }).pct, 1);
  assert.equal(tc.estimate(ledger, { pk: 'c:\\code\\shellby', category: 'fix', model: 'claude-opus-5', now: NOW }).pct, 9);
});

test('estimate ignores failed turns and ones past 60 days', () => {
  const ledger = [row({ ok: false }), row({ ok: false }), row({ at: NOW - 70 * DAY }), row()];
  assert.equal(tc.estimate(ledger, { pk: 'c:\\code\\shellby', category: 'fix', now: NOW }).basis, 'none');
});

// ---- the line, and holding

const usage = (pct, resetsAt = NOW + 2 * HOUR) => ({ fiveHour: { pct, resetsAt } });
const est = pct => ({ pct, low: pct, high: pct, samples: 5, basis: 'project' });

test('advise says it crosses the line when the estimate passes 100 - reserve', () => {
  const a = tc.advise(est(20), usage(63), { on: true, reserve: 25 }, NOW);
  assert.deepEqual(a, { over: true, line: 75, now: 63, left: 12, resetsAt: NOW + 2 * HOUR });
});

test('advise uses 100 as the line with the spending guard off', () => {
  assert.equal(tc.advise(est(20), usage(63), { on: false, reserve: 25 }, NOW).over, false);
  assert.equal(tc.advise(est(20), usage(85), { on: false, reserve: 25 }, NOW).over, true);
});

test('advise has nothing to say for a window that has already reset', () => {
  const a = tc.advise(est(50), usage(90, NOW - 1), { on: true, reserve: 25 }, NOW);
  assert.equal(a.over, false);
  assert.equal(a.now, null);
});

test('advise never says over without an estimate', () => {
  assert.equal(tc.advise({ pct: null, basis: 'none' }, usage(99), { on: true, reserve: 25 }, NOW).over, false);
});

test('shouldHold only holds your own messages, when asked to, with an estimate that crosses', () => {
  const over = { over: true };
  assert.equal(tc.shouldHold({ enabled: true, estimate: est(20), advice: over }), true);
  assert.equal(tc.shouldHold({ enabled: false, estimate: est(20), advice: over }), false, 'off by default');
  assert.equal(tc.shouldHold({ enabled: true, estimate: est(20), advice: { over: false } }), false);
  assert.equal(tc.shouldHold({ enabled: true, estimate: { basis: 'none' }, advice: over }), false, 'no estimate yet');
  assert.equal(tc.shouldHold({ enabled: true, estimate: est(20), advice: over, kind: 'routine' }), false);
  assert.equal(tc.shouldHold({ enabled: true, estimate: est(20), advice: over, kind: 'workflow' }), false);
});

// ---- routine suggestion

test('routineSuggestion suggests Sonnet for a routine whose runs on Opus are small', () => {
  const runs = [1, 2, 1].map(p => row({ rid: 'r1', kind: 'routine', pctRise: p }));
  assert.equal(tc.routineSuggestion(runs, { id: 'r1', model: 'opus' }, '', NOW), 'sonnet');
  assert.equal(tc.routineSuggestion(runs, { id: 'r1', model: '' }, '', NOW), 'sonnet', 'the default counts as the top model');
});

test('routineSuggestion stays quiet for big runs, lighter models, or too few runs', () => {
  const big = [10, 12, 9].map(p => row({ rid: 'r1', pctRise: p }));
  const small = [1, 1, 1].map(p => row({ rid: 'r1', pctRise: p }));
  assert.equal(tc.routineSuggestion(big, { id: 'r1', model: 'opus' }, '', NOW), null);
  assert.equal(tc.routineSuggestion(small, { id: 'r1', model: 'sonnet' }, '', NOW), null);
  assert.equal(tc.routineSuggestion(small, { id: 'r1', model: '' }, 'haiku', NOW), null);
  assert.equal(tc.routineSuggestion(small.slice(0, 2), { id: 'r1', model: 'opus' }, '', NOW), null);
  assert.equal(tc.routineSuggestion(small, { id: 'other', model: 'opus' }, '', NOW), null);
});
