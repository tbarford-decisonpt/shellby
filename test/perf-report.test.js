const { test } = require('node:test');
const assert = require('node:assert/strict');
const { median, summarize, evaluate, verdict, retryPhases, formatValue, formatTable, resultFile, toleranceOf } = require('../scripts/perf-report');
const BUDGETS = require('../scripts/perf-budgets');

const budgets = {
  tolerance: 0.1,
  metrics: {
    startMs: { label: 'Start', unit: 'ms', max: 1000 },
    cpu: { label: 'Idle CPU', unit: '% core', max: 10, tolerance: 0.5 },
    firstMs: { label: 'First open', unit: 'ms', max: null },
  },
};

test('median: odd and even counts, unsorted input, junk ignored, null for nothing', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, null, NaN, undefined, 1, 3]), 3);
  assert.equal(median([]), null);
  assert.equal(median(null), null);
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2], 'the samples are left as they were');
});

test('summarize keeps the samples and their spread', () => {
  assert.deepEqual(summarize([30, 10, null, 20]), { median: 20, min: 10, max: 30, n: 3, samples: [30, 10, 20] });
  assert.deepEqual(summarize([]), { median: null, min: null, max: null, n: 0, samples: [] });
});

test('toleranceOf: the metric\'s own, else the file\'s, never negative', () => {
  assert.equal(toleranceOf(budgets.metrics.cpu, budgets), 0.5);
  assert.equal(toleranceOf(budgets.metrics.startMs, budgets), 0.1);
  assert.equal(toleranceOf({}, { tolerance: -1 }), 0);
  assert.equal(toleranceOf({}, {}), 0);
});

test('evaluate: at the budget passes, within tolerance is near, past it fails', () => {
  const at = evaluate({ startMs: 1000, cpu: 10 }, budgets);
  assert.deepEqual(at.slice(0, 2).map(r => r.status), ['pass', 'pass']);
  const near = evaluate({ startMs: 1100, cpu: 14.9 }, budgets);
  assert.deepEqual(near.slice(0, 2).map(r => r.status), ['near', 'near']);
  assert.ok(Math.abs(near[0].limit - 1100) < 1e-9);
  assert.equal(near[1].limit, 15, 'the metric\'s own tolerance');
  const over = evaluate({ startMs: 1101, cpu: 15.1 }, budgets);
  assert.deepEqual(over.slice(0, 2).map(r => r.status), ['fail', 'fail']);
});

test('evaluate: medians from summarize(), missing numbers, unbudgeted and unknown metrics', () => {
  const rows = evaluate({ startMs: summarize([900, 2000, 950]), firstMs: summarize([1200]), extra: 7 }, budgets);
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.equal(by.startMs.value, 950, 'the median, so one slow launch doesn\'t fail it');
  assert.equal(by.startMs.n, 3);
  assert.equal(by.startMs.status, 'pass');
  assert.equal(by.cpu.status, 'missing', 'asked for but never measured');
  assert.equal(by.cpu.value, null);
  assert.equal(by.firstMs.status, 'info', 'max: null is reported, not judged');
  assert.equal(by.firstMs.label, 'First open');
  assert.equal(by.extra.status, 'info');
  assert.deepEqual(rows.map(r => r.key), ['startMs', 'cpu', 'firstMs', 'extra'], 'budget file order, then the rest');
});

test('verdict: fails on a failure or a missing number, never on near or info', () => {
  assert.deepEqual(verdict(evaluate({ startMs: 1050, cpu: 1, firstMs: 99999 }, budgets)), { ok: true, failed: [], near: ['startMs'] });
  assert.deepEqual(verdict(evaluate({ startMs: 5000 }, budgets)), { ok: false, failed: ['startMs', 'cpu'], near: [] });
});

test('retryPhases names each failing phase once, in order', () => {
  const rows = evaluate({ startMs: 5000, cpu: 99, firstMs: 1 }, budgets);
  assert.deepEqual(retryPhases(rows, { startMs: 'cold', cpu: 'idle', firstMs: 'cold' }), ['cold', 'idle']);
  assert.deepEqual(retryPhases(evaluate({ startMs: 1, cpu: 1 }, budgets), { startMs: 'cold', cpu: 'idle' }), []);
  assert.deepEqual(retryPhases(rows, {}), [], 'a metric with no phase is not retried');
});

test('formatValue: units, and a decimal only for small fractions', () => {
  assert.equal(formatValue(1234.5, 'ms'), '1235 ms');
  assert.equal(formatValue(0.43, '% core'), '0.4% core');
  assert.equal(formatValue(12.4, '% core'), '12% core');
  assert.equal(formatValue(452, 'MB'), '452 MB');
  assert.equal(formatValue(null, 'ms'), '—');
  assert.equal(formatValue(3), '3');
});

test('formatTable: a line per metric and the verdict last', () => {
  const ok = formatTable(evaluate({ startMs: summarize([900, 950, 990]), cpu: 1.2, firstMs: 1300 }, budgets));
  assert.match(ok, /PASS\s+Start\s+950 ms\s+budget 1000 ms\s+median of 3/);
  assert.match(ok, /info\s+First open\s+1300 ms/);
  assert.match(ok, /all 2 within budget$/);
  const bad = formatTable(evaluate({ startMs: 1050 }, budgets).map(r => (r.key === 'cpu' ? r : { ...r, retried: true })));
  assert.match(bad, /NEAR\s+Start .*\(after a retry\)/);
  assert.match(bad, /MISSING\s+Idle CPU/);
  assert.match(bad, /over budget but within tolerance: startMs/);
  assert.match(bad, /OVER BUDGET: cpu$/);
});

test('resultFile carries the verdict, the rows and whatever else it is given', () => {
  const rows = evaluate({ startMs: 10, cpu: 1 }, budgets);
  const r = resultFile(rows, { at: 'now' });
  assert.equal(r.at, 'now');
  assert.equal(r.verdict.ok, true);
  assert.equal(r.metrics, rows);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('the real budget file: every metric labelled, with a unit and a number or null', () => {
  assert.ok(BUDGETS.tolerance > 0 && BUDGETS.tolerance < 1);
  for (const [key, b] of Object.entries(BUDGETS.metrics)) {
    assert.ok(b.label, `${key} has a label`);
    assert.ok(['ms', '% core', 'MB'].includes(b.unit), `${key} has a known unit`);
    assert.ok(b.max === null || (Number.isFinite(b.max) && b.max > 0), `${key} has a budget or null`);
  }
});
