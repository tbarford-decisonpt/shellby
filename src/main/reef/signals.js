// The reef's signals (reef/index.js): what each one is, which way is better, the
// smallest change that counts as a new best, and the readers that turn what's
// already lying around into a number. Nothing here runs anything: the counts
// come from output Claude's own commands printed, coverage files a test run
// already wrote, `git grep` lines the wiring read (wiring/reef.js), and ledgers
// Shellby keeps anyway (flaky, depwatch, CI). Pure. See test/reef-signals.test.js.
//
// Whole-text patterns use [ \t], never \s, so none can run across lines (a
// flood of blank lines would make that quadratic, on Electron's main thread).

const { SUPPRESS_ADD } = require('../bugdex/cheats');

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_TEXT = 256 * 1024; // only the tail of a long output is read
const MAX_COUNT = 1e6;

const clean = text => String(text || '').slice(-MAX_TEXT).replace(ANSI_RE, '');
const count = v => (Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? Math.round(v) : null);
const pct = v => (Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 10) / 10 : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ what each signal is

/**
 * id -> { label, better: 'lower' | 'higher', unit, step(best) -> the smallest
 * change that beats best, next(need) -> what to do, in a few words }.
 */
const SIGNALS = Object.freeze({
  escapes: {
    label: 'Escape hatches', better: 'lower', unit: '', step: () => 1,
    hint: 'ts-ignore, any, eslint-disable and noqa in tracked files',
    next: n => `Remove ${plural(n, 'escape hatch', 'escape hatches')} (a ts-ignore, an any, an eslint-disable)`,
  },
  lint: {
    label: 'Lint problems', better: 'lower', unit: '', step: () => 1,
    hint: 'from the last lint run Claude did',
    next: n => `Fix ${plural(n, 'lint problem')}`,
  },
  coverage: {
    label: 'Line coverage', better: 'higher', unit: '%', step: () => 0.5,
    hint: 'from the coverage file your last test run wrote',
    next: (n, best) => `Get line coverage to ${Math.round((best + 0.5) * 10) / 10}%`,
  },
  ci: {
    label: 'CI green rate', better: 'higher', unit: '%', step: () => 5,
    hint: 'checks on your last 20 pull request runs',
    next: (n, best) => `Get CI green on ${Math.min(100, best + 5)}% of runs`,
  },
  flaky: {
    label: 'Flaky tests', better: 'lower', unit: '', step: () => 1,
    hint: 'open on the Flaky page',
    next: n => `Fix ${plural(n, 'flaky test')}`,
  },
  deps: {
    label: 'Vulnerable packages', better: 'lower', unit: '', step: () => 1,
    hint: 'from the weekly dependency check',
    next: n => `Update ${plural(n, 'vulnerable package')}`,
  },
  nests: {
    label: 'Bug nests', better: 'lower', unit: '', step: () => 1,
    hint: 'open nests in the Bugdex',
    next: n => `Clear ${plural(n, 'bug nest')}`,
  },
  tests: {
    label: 'Tests', better: 'higher', unit: '', step: best => Math.max(3, Math.ceil(best * 0.01)),
    hint: 'how many tests your last test run counted',
    next: n => `Add ${plural(n, 'test')}`,
  },
});
const SIGNAL_IDS = Object.freeze(Object.keys(SIGNALS));
const isSignal = id => typeof id === 'string' && Object.hasOwn(SIGNALS, id);

/** Does `v` beat `best` by at least the signal's step? */
function beats(sig, best, v) {
  const s = SIGNALS[sig];
  if (!s || !Number.isFinite(best) || !Number.isFinite(v)) return false;
  const step = s.step(best);
  return s.better === 'lower' ? v <= best - step : v >= best + step - 1e-9;
}

/** Is `v` at best, or within one step of it? (health counts those as healthy) */
function nearBest(sig, best, v) {
  const s = SIGNALS[sig];
  if (!s || !Number.isFinite(best) || !Number.isFinite(v)) return false;
  const step = s.step(best);
  return s.better === 'lower' ? v <= best + step : v >= best - step;
}

/** How far `v` must move to make a new best (always positive, in the signal's unit). */
function needFor(sig, best, v) {
  const s = SIGNALS[sig];
  if (!s || !Number.isFinite(best) || !Number.isFinite(v)) return null;
  const step = s.step(best);
  const target = s.better === 'lower' ? best - step : best + step;
  const need = s.better === 'lower' ? v - target : target - v;
  return need > 0 ? Math.round(need * 10) / 10 : 0;
}

// ------------------------------------------------------------------ lint output

/**
 * How many problems a lint run reported, from its output: eslint's
 * "✖ 12 problems", ruff's and biome's "Found 3 errors", clippy's
 * "generated 4 warnings". A clean run that says nothing reads as 0 when it
 * passed; anything else it can't read is null.
 */
function lintCount(output, { ok = false } = {}) {
  const t = clean(output);
  const eslint = t.match(/✖[ \t]+(\d+)[ \t]+problems?/);
  if (eslint) return count(Number(eslint[1]));
  if (/All checks passed!/.test(t)) return 0; // ruff
  const found = [...t.matchAll(/^Found[ \t]+(\d+)[ \t]+(?:errors?|warnings?|diagnostics?)\b/gim)];
  if (found.length) return count(found.reduce((n, m) => n + Number(m[1]), 0));
  const clippy = [...t.matchAll(/generated[ \t]+(\d+)[ \t]+warnings?/g)];
  const errs = t.match(/due to[ \t]+(\d+)[ \t]+previous errors?/);
  if (clippy.length || errs) return count(clippy.reduce((n, m) => n + Number(m[1]), 0) + (errs ? Number(errs[1]) : 0));
  if (ok && !/\b(warning|error)s?\b/i.test(t)) return 0;
  return null;
}

// ------------------------------------------------------------------ test output

/**
 * How many tests a run counted (passed and failed; skipped left out), from the
 * runner's own summary: jest, vitest, node:test, mocha, pytest, cargo. null
 * when there's no summary to trust.
 */
function testCount(output) {
  const t = clean(output);
  const jest = t.match(/^Tests:[ \t]+(.*)$/m);
  if (jest && /\btotal\b/.test(jest[1])) {
    const skipped = Number(jest[1].match(/(\d+)[ \t]+(?:skipped|todo)/)?.[1] || 0);
    return count(Number(jest[1].match(/(\d+)[ \t]+total/)[1]) - skipped);
  }
  const vitest = t.match(/^[ \t]*Tests[ \t]+(.*)$/m);
  if (vitest) {
    const p = Number(vitest[1].match(/(\d+)[ \t]+passed/)?.[1] || 0);
    const f = Number(vitest[1].match(/(\d+)[ \t]+failed/)?.[1] || 0);
    if (p + f) return count(p + f);
  }
  const node = t.match(/^(?:#|ℹ)[ \t]+pass[ \t]+(\d+)$/m);
  if (node) return count(Number(node[1]) + Number(t.match(/^(?:#|ℹ)[ \t]+fail[ \t]+(\d+)$/m)?.[1] || 0));
  const mocha = t.match(/^[ \t]*(\d+)[ \t]+passing\b/m);
  if (mocha) return count(Number(mocha[1]) + Number(t.match(/^[ \t]*(\d+)[ \t]+failing\b/m)?.[1] || 0));
  const pytest = [...t.matchAll(/^=+ ([^=\n]* in [\d.]+s[^=\n]*) =+$/gm)].at(-1);
  if (pytest) {
    const p = Number(pytest[1].match(/(\d+) passed/)?.[1] || 0);
    const f = Number(pytest[1].match(/(\d+) failed/)?.[1] || 0);
    if (p + f) return count(p + f);
  }
  const cargo = [...t.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)];
  if (cargo.length) return count(cargo.reduce((n, m) => n + Number(m[1]) + Number(m[2]), 0));
  return null;
}

// ------------------------------------------------------------------ coverage files

/** coverage/coverage-summary.json (istanbul, jest, vitest, c8): total.lines.pct. */
function coverageSummary(text) {
  try {
    const j = JSON.parse(String(text || ''));
    return pct(Number(j?.total?.lines?.pct));
  } catch { return null; }
}

/** lcov.info: lines hit over lines found, summed over every file. */
function coverageLcov(text) {
  let found = 0;
  let hit = 0;
  for (const m of String(text || '').matchAll(/^(LF|LH):(\d+)$/gm)) {
    if (m[1] === 'LF') found += Number(m[2]); else hit += Number(m[2]);
  }
  return found > 0 ? pct((hit / found) * 100) : null;
}

/** coverage.xml (Cobertura: coverage.py, jacoco's converters, cargo-tarpaulin): line-rate on the root. */
function coverageXml(text) {
  const m = String(text || '').slice(0, 4096).match(/<coverage\b[^>]*?\bline-rate="([\d.]+)"/);
  return m ? pct(Number(m[1]) * 100) : null;
}

// The files coverage could already be in, in the order they're trusted, relative to the repo.
const COVERAGE_FILES = Object.freeze([
  ['coverage/coverage-summary.json', coverageSummary],
  ['coverage/lcov.info', coverageLcov],
  ['lcov.info', coverageLcov],
  ['coverage.xml', coverageXml],
  ['coverage/cobertura-coverage.xml', coverageXml],
]);

// ------------------------------------------------------------------ escape hatches

// A cheap first pass for `git grep -E` (POSIX classes only, as git's ERE wants),
// wider than SUPPRESS_ADD; each line it finds is then held to SUPPRESS_ADD itself,
// so the reef and the bug battles (bugdex/cheats.js) agree on what an escape is.
const ESCAPE_GREP = [
  'ts-ignore', 'ts-expect-error', 'ts-nocheck', 'as any', ':[[:space:]]*any', 'eslint-disable', 'type:[[:space:]]*ignore',
  'noqa', 'allow\\(', 'nolint', 'SuppressWarnings', 'pragma warning disable', '//[[:space:]]*@ts-', 'biome-ignore', 'pylint: disable',
].join('|');

/** Lines `git grep -h` printed -> how many really are escape hatches. */
function countEscapes(text) {
  let n = 0;
  for (const line of String(text || '').split('\n')) if (line && SUPPRESS_ADD.test(line)) n++;
  return count(n);
}

/** `git diff --shortstat` -> { files, insertions, deletions }. */
function shortstat(text) {
  const t = String(text || '');
  const n = re => Number(t.match(re)?.[1] || 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) };
}

// ------------------------------------------------------------------ ledgers Shellby keeps anyway

const MIN_CI_RUNS = 3;

/** runs: [[key, ok]] (the last 20 finished PR check runs) -> percent green, or null with too few. */
function ciRate(runs) {
  const list = Array.isArray(runs) ? runs.filter(r => Array.isArray(r) && typeof r[1] === 'boolean') : [];
  if (list.length < MIN_CI_RUNS) return null;
  return Math.round((list.filter(r => r[1]).length / list.length) * 100);
}

const CLOSED = new Set(['fixed', 'dismissed']);

/** The flaky ledger (flaky.normalizeFlaky) -> open flaky tests in one project, or null if it has none on file. */
function openFlaky(flakyState, id) {
  const p = flakyState?.projects?.[id];
  if (!p || typeof p.tests !== 'object' || !p.tests) return null;
  return count(Object.values(p.tests).filter(t => t && Array.isArray(t.flakes) && t.flakes.length && !CLOSED.has(t.status)).length);
}

/** depwatch's results ([{ key: root, ok, vulnTotal }]) -> vulnerable packages across a project's clones, or null. */
function vulnsFor(results, roots) {
  const want = new Set((roots || []).map(r => String(r).toLowerCase()));
  const mine = (Array.isArray(results) ? results : []).filter(r => r?.ok && typeof r.key === 'string' && want.has(r.key.toLowerCase()));
  return mine.length ? count(mine.reduce((n, r) => n + (Number(r.vulnTotal) || 0), 0)) : null;
}

module.exports = {
  SIGNALS, SIGNAL_IDS, isSignal, beats, nearBest, needFor,
  lintCount, testCount, coverageSummary, coverageLcov, coverageXml, COVERAGE_FILES,
  ESCAPE_GREP, countEscapes, shortstat, ciRate, MIN_CI_RUNS, openFlaky, vulnsFor,
};
