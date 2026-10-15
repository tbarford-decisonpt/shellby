// "Fix this" on a reef signal (docs/REEF.md): a prompt for the project's chat
// box, naming where the problem is (reef/detail.js), what better means, and how
// to check it. Nothing is sent: the panel puts it in a new conversation in the
// project's folder for you to read first. "Fix the worst" picks the signal with
// the most room to get better. Pure. See test/reef-prompts.test.js.

const { SIGNALS, needFor } = require('./signals');

const TOP = 5; // places named in a prompt

const fmt = v => (Number.isInteger(v) ? String(v) : Number(v).toFixed(1));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = rows => rows.map(r => `- ${r}`).join('\n');
const day = ms => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);

/** How much room a signal has to get better, 0 (none) to 1 (lots). */
const ROOM_SCALE = { escapes: 50, lint: 50, flaky: 5, deps: 5, nests: 3 };
function roomOf(sig, s) {
  if (!s || !SIGNALS[sig] || !Number.isFinite(s.last)) return 0;
  if (sig === 'coverage') return Math.max(0, (90 - s.last) / 90);
  if (sig === 'ci') return Math.max(0, (100 - s.last) / 100);
  if (sig === 'tests') return 0.05; // more tests is always welcome, but rarely the worst thing
  return s.last > 0 ? Math.min(1, s.last / ROOM_SCALE[sig]) : 0;
}

/** Can this signal still get better? */
const canImprove = (sig, s) => roomOf(sig, s) > 0;

/** The signal with the most room, in the reef's order when they tie: sig id or null. */
function worstOf(p) {
  let best = null;
  for (const sig of Object.keys(SIGNALS)) {
    const r = roomOf(sig, p?.signals?.[sig]);
    if (r > 0 && (!best || r > best.r)) best = { sig, r };
  }
  return best?.sig || null;
}

const where = (files, unit) => list(files.slice(0, TOP).map(([f, c]) => `${f} (${plural(c, unit)})`));

const BODIES = {
  escapes(s, d) {
    const out = [`The reef counts ${plural(s.last, 'escape hatch', 'escape hatches')} in committed code (ts-ignore, ts-expect-error, any, eslint-disable, noqa and the like). Lower is better; the best so far is ${fmt(s.best)}.`];
    if (d?.files?.length) out.push(`Where most of them are:\n${where(d.files, 'escape')}`);
    if (d?.kinds?.length) out.push(`By kind: ${d.kinds.slice(0, TOP).map(([k, c]) => `${k} ${c}`).join(', ')}.`);
    out.push('Remove as many as you can by fixing what each one hides: give an `any` a real type, fix the error a ts-ignore or noqa silences, and drop an eslint-disable once its rule passes. Keep one only when it\'s truly needed, with a short comment saying why. Don\'t just move them somewhere else.');
    out.push('Then run the type check, the linter and the tests, and make sure they pass.');
    return out;
  },
  lint(s, d) {
    const out = [`The last lint run${d?.cmd ? ` (\`${d.cmd}\`)` : ''} reported ${plural(s.last, 'problem')}. Lower is better; the best so far is ${fmt(s.best)}.`];
    if (d?.files?.length) out.push(`The files with the most:\n${where(d.files, 'problem')}`);
    if (d?.rules?.length) out.push(`The rules hit most: ${d.rules.slice(0, TOP).map(([r, c]) => `${r} (${c})`).join(', ')}.`);
    out.push('Fix the problems in the code itself. Don\'t turn rules off or add disable comments to get the count down.');
    out.push(`Then run ${d?.cmd ? `\`${d.cmd}\`` : 'the linter'} again and the tests, and make sure the count went down and nothing broke.`);
    return out;
  },
  coverage(s, d) {
    const target = Math.min(100, Math.round((Math.max(s.best, s.last) + 0.5) * 10) / 10);
    const out = [`Line coverage is ${fmt(s.last)}%${d?.file ? ` (from ${d.file})` : ''}. Higher is better; the best so far is ${fmt(s.best)}%, so aim for at least ${fmt(target)}%.`];
    if (d?.files?.length) out.push(`The files with the most lines no test runs:\n${list(d.files.slice(0, TOP).map(([f, pct, miss]) => `${f}: ${fmt(pct)}% (${plural(miss, 'line')} uncovered)`))}`);
    out.push('Add tests that check real behaviour of those lines (edge cases, errors, the branches that matter), not tests that only run code to raise the number. Don\'t exclude files from coverage.');
    out.push('Then run the tests with coverage, make sure they pass and that the coverage file was written again.');
    return out;
  },
  ci(s, d) {
    const out = [`CI was green on ${fmt(s.last)}% of the last pull request runs. Higher is better; the best so far is ${fmt(s.best)}%.`];
    if (d?.jobs?.length) out.push(`The checks that failed most:\n${list(d.jobs.slice(0, TOP).map(([j, c]) => `${j} (failing on ${plural(c, 'pull request')})`))}`);
    if (d?.prs?.length) out.push(`Pull requests failing now: ${d.prs.join(', ')}.`);
    out.push(d?.jobs?.length
      ? 'Find out why those checks fail (read the workflow and reproduce the failing step locally, without pushing) and fix the cause: a real bug, a test that depends on timing or the machine, or a setup step. Don\'t skip, retry or loosen a check to make it pass.'
      : 'Look at the CI workflows and the recent failures, find what fails most often and fix the cause. Don\'t skip, retry or loosen a check to make it pass.');
    out.push('Then run the same steps locally (lint, type check, tests) and make sure they pass.');
    return out;
  },
  flaky(s, d) {
    const out = [`${plural(s.last, 'test')} ${s.last === 1 ? 'is' : 'are'} flaky: ${s.last === 1 ? 'it passes' : 'they pass'} and fail${s.last === 1 ? 's' : ''} on the same code. Lower is better; the best so far is ${fmt(s.best)}.`];
    if (d?.tests?.length) out.push(`The flakiest:\n${list(d.tests.slice(0, TOP).map(([t, c]) => `${t} (flaked ${plural(c, 'time')})`))}`);
    out.push('For each one, find the cause (timing, shared state between tests, order, the clock, the network, randomness) and fix it so the test is deterministic. Don\'t add retries or longer waits, and don\'t skip the test.');
    out.push('Then run each fixed test several times in a row, and the whole suite once, and make sure they all pass.');
    return out;
  },
  deps(s, d) {
    const cmd = d?.manager ? `${d.manager} audit` : 'the package manager\'s audit';
    const out = [`The dependency check found ${plural(s.last, 'vulnerable package')}. Lower is better; the best so far is ${fmt(s.best)}.`];
    if (d?.packages?.length) {
      out.push(`The packages:\n${list(d.packages.slice(0, TOP).map(p => `${p.name}: ${p.severity}${p.direct === false ? ' (indirect)' : ''}${p.fix === 'none' ? ', no fix published yet' : p.fix === 'major' ? ', fix needs a major bump' : ''}`))}`);
    }
    out.push('Update each to a version with the fix, the smallest bump that has it. For an indirect one, update the package that pulls it in. Where the fix needs a major version, read its changelog and change the code that uses it. Where there\'s no fix yet, say so and leave it.');
    out.push(`Then run ${cmd}, the build and the tests, and make sure they pass.`);
    return out;
  },
  nests(s, d) {
    const out = [`The Bugdex has ${plural(s.last, 'open bug nest')} here: the same kind of bug coming back again and again. Lower is better; the best so far is ${fmt(s.best)}.`];
    if (d?.nests?.length) {
      out.push(`The nests:\n${list(d.nests.slice(0, TOP).map(x => `${x.name}${x.species && x.species !== x.name ? ` (${x.species})` : ''}: seen ${plural(x.count, 'time')}${day(x.since) ? ` since ${day(x.since)}` : ''}${x.cleared ? `, cleared ${plural(x.cleared, 'time')} before and back again` : ''}`))}`);
    }
    out.push('For each, look for why this kind of bug keeps happening (a pattern in the code, a missing check, a helper used wrong) and fix the cause, not only the latest case. Add a test that would catch it coming back.');
    out.push('Then run the linter and the tests, and make sure they pass.');
    return out;
  },
  tests(s, d, p) {
    const need = needFor('tests', s.best, s.last) || SIGNALS.tests.step(s.best);
    const out = [`The last test run counted ${plural(s.last, 'test')}. More is better; the best so far is ${fmt(s.best)}, so add at least ${plural(Math.ceil(need), 'test')}.`];
    const cov = p?.detail?.coverage?.files;
    if (cov?.length) out.push(`Start where coverage is lowest:\n${list(cov.slice(0, TOP).map(([f, pct]) => `${f}: ${fmt(pct)}%`))}`);
    else out.push('Start with the code that changes most and has no tests yet.');
    out.push('Each test should check real behaviour and fail if that behaviour broke. No empty or duplicate tests.');
    out.push('Then run the whole suite and make sure it passes.');
    return out;
  },
};

/**
 * The prompt for one signal of one project (normalized, reef/index.js), or null
 * when that signal hasn't been read or can't get better.
 */
function promptFor(p, sig) {
  const s = p?.signals?.[sig];
  if (!BODIES[sig] || !canImprove(sig, s)) return null;
  const body = BODIES[sig](s, p.detail?.[sig] || null, p);
  return [`Help ${p.name || 'this project'}'s reef: ${SIGNALS[sig].label.toLowerCase()}.`, ...body,
    'Keep the change focused on this, and tell me what you changed and what the count is now.'].join('\n\n');
}

module.exports = { promptFor, worstOf, roomOf, canImprove, TOP };
