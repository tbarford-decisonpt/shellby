// The arithmetic behind scripts/perf-budget.js, kept pure so it's tested
// (test/perf-report.test.js): medians over a run's samples, each number held
// against its budget with a tolerance, the table it prints and the JSON CI keeps.
//
// A metric passes at or under its budget. Over it but within the tolerance it
// is "near": still a pass, printed as a warning, because one noisy runner
// shouldn't fail a build but a number that sits there run after run is drifting.
// Past the tolerance it fails. A metric that couldn't be measured fails too:
// a check that silently measures nothing is worse than none.

/** The middle value (the mean of the middle two for an even count); null for none. */
function median(values) {
  const xs = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** { median, min, max, n, samples } for one metric's samples. */
function summarize(values) {
  const xs = (values || []).filter(Number.isFinite);
  return {
    median: median(xs),
    min: xs.length ? Math.min(...xs) : null,
    max: xs.length ? Math.max(...xs) : null,
    n: xs.length,
    samples: xs,
  };
}

/** The budget's tolerance: the metric's own, else the file's, never below 0. */
function toleranceOf(budget, budgets) {
  const t = Number.isFinite(budget?.tolerance) ? budget.tolerance : budgets?.tolerance;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * One row per metric, in the budget file's order, then anything measured that
 * isn't in it. A metric with `max: null`, or none in the file, is reported
 * but not judged (status 'info'):
 *   [{ key, label, unit, value, n, max, limit, status }]
 * status: pass | near | fail | missing | info. `measured` maps a key to a
 * number or to summarize()'s object (its median is the value).
 */
function evaluate(measured, budgets) {
  const metrics = budgets?.metrics || {};
  const valueOf = m => (m && typeof m === 'object' ? m.median : m);
  const countOf = m => (m && typeof m === 'object' ? m.n : Number.isFinite(m) ? 1 : 0);
  const rows = [];
  for (const [key, budget] of Object.entries(metrics)) {
    const value = valueOf(measured?.[key]);
    if (budget.max == null) {
      rows.push({ key, label: budget.label || key, unit: budget.unit || '', value: Number.isFinite(value) ? value : null, n: countOf(measured?.[key]), max: null, limit: null, status: 'info' });
      continue;
    }
    const max = Number(budget.max);
    const limit = max * (1 + toleranceOf(budget, budgets));
    let status;
    if (!Number.isFinite(value)) status = 'missing';
    else if (value <= max) status = 'pass';
    else if (value <= limit) status = 'near';
    else status = 'fail';
    rows.push({ key, label: budget.label || key, unit: budget.unit || '', value: Number.isFinite(value) ? value : null, n: countOf(measured?.[key]), max, limit, status });
  }
  for (const [key, m] of Object.entries(measured || {})) {
    if (key in metrics) continue;
    const value = valueOf(m);
    rows.push({ key, label: key, unit: '', value: Number.isFinite(value) ? value : null, n: countOf(m), max: null, limit: null, status: 'info' });
  }
  return rows;
}

/** { ok, failed: [keys], near: [keys] }: ok unless something failed or is missing. */
function verdict(rows) {
  const failed = rows.filter(r => r.status === 'fail' || r.status === 'missing').map(r => r.key);
  return { ok: failed.length === 0, failed, near: rows.filter(r => r.status === 'near').map(r => r.key) };
}

/**
 * The phases to measure again: those behind a metric that failed or went
 * missing, in the order first met. `phaseOf` maps a metric key to its phase.
 */
function retryPhases(rows, phaseOf) {
  const out = [];
  for (const r of rows) {
    if (r.status !== 'fail' && r.status !== 'missing') continue;
    const phase = phaseOf?.[r.key];
    if (phase && !out.includes(phase)) out.push(phase);
  }
  return out;
}

/** 1234.5 'ms' -> "1235 ms", 0.43 '% core' -> "0.4% core", 452 'MB' -> "452 MB". */
function formatValue(value, unit = '') {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) < 10 && value !== Math.round(value) ? 1 : 0;
  const n = value.toFixed(digits);
  if (!unit) return n;
  return unit.startsWith('%') ? `${n}${unit}` : `${n} ${unit}`;
}

const MARK = { pass: 'PASS', near: 'NEAR', fail: 'FAIL', missing: 'MISSING', info: 'info' };

/** The table perf-budget.js prints: one aligned line per row, then the verdict. */
function formatTable(rows) {
  const lines = rows.map(r => [
    MARK[r.status] || r.status,
    r.label,
    formatValue(r.value, r.unit),
    r.max == null ? '' : `budget ${formatValue(r.max, r.unit)}`,
    [r.n > 1 ? `median of ${r.n}` : '', r.retried ? '(after a retry)' : ''].filter(Boolean).join(' '),
  ]);
  const widths = [0, 1, 2, 3].map(i => Math.max(...lines.map(l => l[i].length), 0));
  const out = lines.map(l => `  ${l[0].padEnd(widths[0])}  ${l[1].padEnd(widths[1])}  ${l[2].padStart(widths[2])}  ${l[3].padEnd(widths[3])}  ${l[4]}`.trimEnd());
  const v = verdict(rows);
  out.push('');
  if (v.near.length) out.push(`  over budget but within tolerance: ${v.near.join(', ')}`);
  out.push(v.ok ? `  all ${rows.filter(r => r.status !== 'info').length} within budget` : `  OVER BUDGET: ${v.failed.join(', ')}`);
  return out.join('\n');
}

/** The machine-readable result CI uploads: the rows, the verdict and where it ran. */
function resultFile(rows, extra = {}) {
  return { ...extra, verdict: verdict(rows), metrics: rows };
}

module.exports = { median, summarize, evaluate, verdict, retryPhases, formatValue, formatTable, resultFile, toleranceOf };
