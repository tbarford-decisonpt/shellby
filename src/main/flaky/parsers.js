// The flaky test detective's readers: which tests a runner says failed, and
// what one finished test command amounts to. Pure. See ../flaky.js.
const { MAX_FAILED, FRAMEWORKS, ANSI_RE, cleanId, cmdKey, masked } = require('./ids');

// ------------------------------------------------------------------ parsers

/** @type {[string, RegExp][]} */
const FRAMEWORK_CMD = [
  ['playwright', /\bplaywright\s+test\b/i],
  ['vitest', /\bvitest\b/i],
  ['jest', /\bjest\b/i],
  ['mocha', /\bmocha\b/i],
  ['node', /\bnode\s+(--test|--run\s+test)\b/i],
  ['pytest', /\b(pytest|py\.test|python\d*(\.\d+)?\s+-m\s+pytest|tox|nox)\b/i],
  ['go', /\bgo\s+test\b/i],
  ['cargo', /\bcargo\s+(test|nextest)\b/i],
  ['rspec', /\brspec\b/i],
  ['dotnet', /\bdotnet\s+test\b/i],
  ['phpunit', /\bphpunit\b/i],
];
// Whole-text patterns: only [ \t], never \s, so none can run across lines
// (a flood of blank lines would make that quadratic, on Electron's main thread).
/** @type {[string, RegExp][]} */
const FRAMEWORK_OUT = [
  ['playwright', /\[(chromium|firefox|webkit)[^\]\n]*\] ›|Running \d+ tests? using \d+ workers?/],
  ['vitest', /^[ \t]*(RUN|DEV)[ \t]+v\d+\.\d+|^[ \t]*Test Files[ \t]+\d+/m],
  ['jest', /^Test Suites:[ \t]/m],
  ['pytest', /^=+ test session starts =+$|^=+ [^=\n]* in [\d.]+s[^=\n]* =+$/m],
  ['go', /^(--- (FAIL|PASS):|(ok|FAIL)[ \t]+\S+[ \t]+[\d.]+s$)/m],
  ['cargo', /^test result: (ok|FAILED)\./m],
  ['rspec', /^\d+ examples?, \d+ failures?/m],
  ['dotnet', /^[ \t]*(Passed|Failed)![ \t]+-[ \t]+Failed:/m],
  ['phpunit', /^PHPUnit \d+\.\d+/m],
  ['mocha', /^[ \t]*\d+ (passing|failing)\b/m],
  ['node', /^[#ℹ] (tests|pass|fail) \d+$/m],
];
const MAX_LINE = 500;               // a test name is 160 at most; past this a line is noise
const MAX_TEXT = 64 * 1024;

function frameworkOf(cmd, text) {
  for (const [name, re] of FRAMEWORK_CMD) if (typeof cmd === 'string' && re.test(cmd)) return name;
  for (const [name, re] of FRAMEWORK_OUT) if (re.test(text)) return name;
  return null;
}

// Each runner's failing tests, as ids. `lines` has ANSI codes already gone.
const PARSERS = {
  node(lines) {
    const out = [];
    for (const l of lines) {
      let m = l.match(/^\s*not ok \d+ - (.+?)(\s+#\s*(SKIP|TODO)\b.*)?$/i);
      if (m && !m[2]) out.push(m[1]);
      m = l.match(/^\s*✖ (.+?)(\s+\([\d.]+m?s\))?$/);
      if (m && !/^failing tests:?$/i.test(m[1])) out.push(m[1]);
    }
    return out;
  },
  jest(lines) {
    const out = [];
    let file = null;
    for (const l of lines) {
      const f = l.match(/^\s*FAIL\s+(\S+)(\s+\(.*\))?$/);
      if (f && !l.includes(' > ')) { file = f[1]; continue; }
      if (/^\s*PASS\s+\S+/.test(l)) { file = null; continue; }
      const m = l.match(/^\s*● (.+)$/);
      if (m && !/^Test suite failed to run$/i.test(m[1].trim()) && !/^Console$/.test(m[1].trim())) out.push(file ? `${file} › ${m[1]}` : m[1]);
    }
    return out;
  },
  vitest(lines) {
    const out = [];
    const inline = [];
    for (const l of lines) {
      const f = l.match(/^\s*FAIL\s+(\S+) > (.+?)(\s+\[[^\]]*\])?$/);
      if (f) { out.push(`${f[1]} › ${f[2].split(' > ').join(' › ')}`); continue; }
      const x = l.match(/^\s*[×✗] (.+?)(\s+\d+m?s)?$/);
      if (x) inline.push(x[1]);
    }
    return out.length ? out : inline;
  },
  mocha(lines) {
    const out = [];
    const start = lines.findIndex(l => /^\s*\d+ failing\b/.test(l));
    if (start < 0) return out;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s*\d+\) (.+)$/);
      if (!m) continue;
      const parts = [m[1].trim()];
      for (let j = i + 1; j < Math.min(lines.length, i + 8) && !parts[parts.length - 1].endsWith(':'); j++) {
        const t = lines[j].trim();
        if (!t) break;
        parts.push(t);
      }
      const last = parts[parts.length - 1];
      if (last.endsWith(':')) {
        parts[parts.length - 1] = last.slice(0, -1);
        out.push(parts.join(' › '));
      }
    }
    return out;
  },
  pytest(lines) {
    const out = [];
    for (const l of lines) {
      const m = l.match(/^(FAILED|ERROR)\s+(\S+?::\S+?)(\s+-\s.*)?$/);
      if (m) out.push(m[2].split('::').join(' › '));
    }
    return out;
  },
  go(lines) {
    const out = [];
    for (const l of lines) {
      const m = l.match(/^\s*--- FAIL: (\S+)/);
      if (m) out.push(m[1]);
    }
    return out;
  },
  cargo(lines) {
    const out = [];
    for (const l of lines) {
      let m = l.match(/^test (\S+) \.\.\. FAILED$/);
      if (m) out.push(m[1]);
      m = l.match(/^\s*FAIL \[\s*[\d.]+s\]\s+(?:\S+\s+)?(\S+)$/);
      if (m) out.push(m[1]);
    }
    return out;
  },
  playwright(lines) {
    const out = [];
    let flakyBlock = false;
    for (const l of lines) {
      if (/^\s*\d+ (flaky|passed|skipped|did not run)\b/.test(l)) flakyBlock = false;
      if (/^\s*\d+ failed\b/.test(l)) { flakyBlock = false; continue; }
      const m = l.match(/^\s*(?:\d+\)|✘\s+\d+)\s+\[[^\]]+\] › (.+?)(\s+[─-]{3,}.*|\s+\(\d[\d.]*m?s\))?$/);
      if (m && !flakyBlock) out.push(playwrightId(m[1]));
    }
    return out;
  },
  rspec(lines) {
    const out = [];
    for (const l of lines) {
      const m = l.match(/^rspec \.?\/?(\S+?):\d+ # (.+)$/);
      if (m) out.push(`${m[1]} › ${m[2]}`);
    }
    return out;
  },
  dotnet(lines) {
    const out = [];
    for (const l of lines) {
      const m = l.match(/^\s*Failed (\S+) \[[\d.<]+ ?m?s\]$/);
      if (m) out.push(m[1]);
    }
    return out;
  },
  phpunit(lines) {
    const out = [];
    let inFailures = false;
    for (const l of lines) {
      if (/^There (was|were) \d+ (failure|error)s?:$/.test(l)) { inFailures = true; continue; }
      if (/^(FAILURES!|ERRORS!|OK \()/.test(l)) inFailures = false;
      const m = inFailures && l.match(/^\d+\) (\S+::\S+)$/);
      if (m) out.push(m[1]);
    }
    return out;
  },
};

// `tests/a.spec.ts:12:3 › suite › title` -> `tests/a.spec.ts › suite › title`
const playwrightId = s => s.replace(/^(\S+?):\d+:\d+ › /, '$1 › ');

/** The tests Playwright itself retried into a pass (its "N flaky" list). */
function playwrightFlaky(lines) {
  const out = [];
  let inBlock = false;
  for (const l of lines) {
    if (/^\s*\d+ flaky$/.test(l)) { inBlock = true; continue; }
    if (/^\s*\d+ (failed|passed|skipped|did not run)\b/.test(l)) inBlock = false;
    const m = inBlock && l.match(/^\s*\[[^\]]+\] › (.+?)(\s+[─-]{3,}.*)?$/);
    if (m) out.push(playwrightId(m[1]));
  }
  return out;
}

const int = s => (s == null ? 0 : Number(s));

/**
 * What the run came to, from the runner's own summary, line by line:
 * { fail, pass, count } where count is how many tests it says failed (null
 * when it doesn't say). Any failure signal wins over any pass signal.
 */
function summary(lines) {
  let fail = false;
  let pass = false;
  let count = null;
  const counted = n => { count = (count || 0) + n; };
  for (const l of lines) {
    const t = l.trimStart();
    let m;
    // jest "Tests:       1 failed, 5 passed", vitest "Tests  1 failed | 4 passed";
    // "Test Suites:" and "Test Files" say whether, not how many.
    if ((m = t.match(/^(Tests:?|Test Suites:|Test Files)[ \t]+(.*)$/))) {
      const failed = m[2].match(/\b(\d+) failed\b/);
      if (failed && int(failed[1]) > 0) fail = true;
      if (/\b\d+ passed\b/.test(m[2])) pass = true;
      if (m[1].startsWith('Tests') && /\b\d+ (passed|failed)\b/.test(m[2])) counted(int(failed?.[1]));
      // phpunit's "Tests: 4, Assertions: 4, Failures: 1, Errors: 1."
      for (const e of m[2].matchAll(/\b(Failures|Errors): (\d+)/g)) counted(int(e[2]));
    } else if ((m = l.match(/^=+ ([^=]+?) =+$/)) && / in [\d.]+s\b/.test(m[1])) {   // pytest
      const f = m[1].match(/\b(\d+) failed\b/);
      const e = m[1].match(/\b(\d+) errors?\b/);
      if (int(f?.[1]) + int(e?.[1]) > 0) { fail = true; counted(int(f?.[1]) + int(e?.[1])); }
      if (/\b\d+ passed\b/.test(m[1])) pass = true;
    } else if ((m = l.match(/^[#ℹ] fail (\d+)$/))) {                                 // node --test
      if (int(m[1]) > 0) fail = true; else pass = true;
      counted(int(m[1]));
    } else if ((m = t.match(/^(\d+) (failing|passing|failed|passed|flaky)\b/))) {    // mocha, playwright
      if (/^fail/.test(m[2]) && int(m[1]) > 0) { fail = true; counted(int(m[1])); }
      if (/^pass/.test(m[2])) pass = true;
    } else if ((m = l.match(/^test result: (ok|FAILED)\. \d+ passed; (\d+) failed/))) { // cargo
      if (m[1] === 'FAILED') { fail = true; counted(int(m[2])); } else pass = true;
    } else if ((m = l.match(/^(\d+) examples?, (\d+) failures?/))) {                 // rspec
      if (int(m[2]) > 0) { fail = true; counted(int(m[2])); } else pass = true;
    } else if ((m = t.match(/^(Passed|Failed)![ \t]+-[ \t]+Failed:[ \t]+(\d+)/))) {  // dotnet
      if (m[1] === 'Failed') { fail = true; counted(int(m[2])); } else pass = true;
    } else if (/^(FAILURES|ERRORS)!$/.test(l)) {                                     // phpunit
      fail = true;
    } else if (/^OK \(\d+ tests?/.test(l)) {
      pass = true;
    } else if (l === 'FAIL' || /^FAIL\t/.test(l) || l.startsWith('--- FAIL:')) {   // go
      fail = true;
    } else if (l === 'PASS' || /^ok[ \t]+\S+[ \t]+(\(cached\)|[\d.]+s)/.test(l)) {
      pass = true;
    }
  }
  return { fail, pass: pass && !fail, count };
}

// Stop at the first failure: what it didn't run, it can't vouch for.
const BAIL_RE = /(^|\s)(--bail|-x|--exitfirst|--maxfail(=|\s)|-failfast|--fail-fast|--max-failures?(=|\s))/i;

// The command ran out of time or never started: says nothing about the tests.
const NOT_A_RUN = /\bCommand timed out\b|\brunning in (the )?background\b|\btimed out after \d|is not recognized as (an internal|the name)|command not found|Cannot find module|ERR_MODULE_NOT_FOUND|No tests? (found|ran)|no tests ran/i;

/**
 * Read a test run's output.
 * Returns { framework, failed: [id], flaky: [id], outcome: 'pass'|'fail'|null, parsed, skip }
 *   failed: the failing tests it named (deduplicated, at most MAX_FAILED)
 *   flaky:  tests the runner itself reported as flaky (Playwright retries)
 *   parsed: whether it named any failing test at all
 *   skip:   true when the output says nothing about the tests (timeout, missing tool)
 */
function parse(output, cmd) {
  const raw = typeof output === 'string' ? output.slice(-MAX_TEXT) : '';
  // One line per line, none longer than a test name could need, no runs of blanks.
  const lines = raw.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').split('\n')
    .map(l => l.slice(0, MAX_LINE).trimEnd()).filter((l, i, a) => l || (i > 0 && a[i - 1]));
  const text = lines.join('\n');
  const framework = frameworkOf(cmd, text);
  const tried = framework ? [framework] : FRAMEWORKS;
  const seen = new Set();
  for (const name of tried) {
    for (const raw of PARSERS[name](lines)) {
      const id = cleanId(raw);
      if (id && seen.size < MAX_FAILED) seen.add(id);
    }
  }
  const flaky = framework === 'playwright' || !framework ? [...new Set(playwrightFlaky(lines).map(cleanId).filter(Boolean))].slice(0, MAX_FAILED) : [];
  const s = summary(lines);
  const outcome = s.fail || seen.size ? 'fail' : s.pass ? 'pass' : null;
  // Whether every failing test was named: not when the list hit its cap, the
  // command stops at the first failure, or the runner's count says otherwise.
  const exhaustive = seen.size < MAX_FAILED && !(typeof cmd === 'string' && BAIL_RE.test(cmd)) && (s.count == null || s.count === seen.size);
  return { framework, failed: [...seen], flaky, outcome, parsed: seen.size > 0, exhaustive, skip: !outcome && NOT_A_RUN.test(text) };
}

/**
 * What one finished test command amounts to, or null when it can't be told.
 *   output: what it printed (the head and, when long, the tail)
 *   isError: whether the tool call failed
 *   complete: false when the middle of the output was cut
 */
function readRun({ cmd, output, isError, complete = true }) {
  const key = cmdKey(cmd);
  if (!key) return null;
  const p = parse(output, cmd);
  if (p.skip) return null;
  let ok;
  if (p.outcome) ok = p.outcome === 'pass';
  else if (masked(cmd)) return null;    // `| tail` hides the exit code and nothing else says
  else ok = !isError;
  // `complete`: the run can vouch that a test it didn't name passed.
  return { cmd: key, ok, failed: ok ? [] : p.failed, parsed: !ok && p.parsed, complete: !!complete && p.exhaustive, framework: p.framework, flaky: p.flaky };
}

module.exports = { frameworkOf, parse, readRun };
