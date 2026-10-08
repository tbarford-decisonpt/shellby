// The flaky test detective's ledger: per-project runs and tests, who flaked,
// what's proven fixed, and what he should say. Pure: no I/O, no clock
// (callers pass `now`). See ../flaky.js.
const { SUITE, MAX_FAILED, FRAMEWORKS, cleanId, labelOf } = require('./ids');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MAX_PROJECTS = 30;
const MAX_RUNS = 20;              // per project...
const RUN_FOR = DAY;              // ...and only this recent: a tree rarely lives longer
// More failures than this in one run is the world, not a flaky test: a server
// that wasn't up yet, a database, a missing env var. It counts for the suite.
const MANY_FAILED = 5;
const MAX_TESTS = 60;             // per project
const MAX_FLAKES = 20;            // flake times kept per test
const FLAKE_FOR = 30 * DAY;       // older flakes are forgotten
const SAY_AT = 2;                 // flakes in a week before he says anything
const SAY_GAP = 20 * HOUR;        // the same test at most once a day
const SAY_A_DAY = 3;              // and three bubbles a day in all
const DISMISS_FOR = 30 * DAY;     // "Not flaky" hides a test this long...
const DISMISS_UNTIL = 3;          // ...or until it flakes this many more times
const RETRY_AFTER = 14 * DAY;     // a quarantined test is worth another try after this
const FIXED_RUNS = 20;            // clean runs that prove a fix...
const FIXED_TREES = 3;            // ...across at least this many versions of the code new since "Fix it"
const MAX_FLAKE_TREES = 5;        // the code it flaked on: runs of that never count as proof
const MAX_OLD = MAX_RUNS + MAX_FLAKE_TREES;
const FIXED_SHOWN = 7 * DAY;      // how long a fixed test stays on the list
const STATUSES = ['watching', 'fixing', 'quarantined', 'dismissed', 'fixed'];
const MAX_CMDS = 3;
const KEY_RE = /^[0-9a-f]{12}$/;   // gitinfo.projectOf().id: the same for a repo and its worktrees
const HASH_RE = /^[0-9a-f]{12}$/;
const TREE_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const dayKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ state

function cleanRun(r) {
  if (!r || typeof r !== 'object' || !HASH_RE.test(r.cmd) || !TREE_RE.test(r.tree) || !num(r.at)) return null;
  const failed = Array.isArray(r.failed) ? [...new Set(r.failed.map(cleanId).filter(Boolean))].slice(0, MAX_FAILED) : [];
  const settled = Array.isArray(r.settled) ? [...new Set(r.settled.filter(s => s === SUITE || cleanId(s)))].slice(0, MAX_FAILED + 1) : [];
  return { at: r.at, cmd: r.cmd, tree: r.tree, ok: r.ok === true, failed, parsed: r.parsed === true && failed.length > 0, complete: r.complete !== false, settled };
}

function cleanTest(t) {
  if (!t || typeof t !== 'object') return null;
  const flakes = Array.isArray(t.flakes) ? t.flakes.filter(num).sort((a, b) => b - a).slice(0, MAX_FLAKES) : [];
  return {
    flakes,
    framework: FRAMEWORKS.includes(t.framework) ? t.framework : null,
    status: STATUSES.includes(t.status) ? t.status : 'watching',
    statusAt: num(t.statusAt),
    lastSaidAt: num(t.lastSaidAt),
    since: Math.min(99, Math.floor(num(t.since))),          // flakes since "Not flaky"
    cmds: Array.isArray(t.cmds) ? t.cmds.filter(c => HASH_RE.test(c)).slice(0, MAX_CMDS) : [],
    clean: Math.min(999, Math.floor(num(t.clean))),         // runs without it failing, while fixing
    trees: Array.isArray(t.trees) ? t.trees.filter(x => TREE_RE.test(x)).slice(0, FIXED_TREES) : [],
    ftrees: Array.isArray(t.ftrees) ? t.ftrees.filter(x => TREE_RE.test(x)).slice(0, MAX_FLAKE_TREES) : [],
    old: Array.isArray(t.old) ? t.old.filter(x => TREE_RE.test(x)).slice(0, MAX_OLD) : [],  // trees from before "Fix it"
    issue: cleanIssue(t.issue),                              // the GitHub issue filed for it, if any
  };
}

// An issue link GitHub gave back: https, /owner/repo/issues/N, N matching.
// Any host, so GitHub Enterprise works; only https links open anyway.
const ISSUE_URL_RE = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/(\d{1,9})$/i;
function cleanIssue(i) {
  if (!i || typeof i !== 'object' || typeof i.url !== 'string' || i.url.length > 300) return null;
  const m = i.url.match(ISSUE_URL_RE);
  const number = Math.floor(num(i.number));
  return m && number > 0 && Number(m[1]) === number ? { number, url: i.url, at: num(i.at) } : null;
}

const lastActive = p => Math.max(0, ...p.runs.map(r => r.at), ...Object.values(p.tests).flatMap(t => [t.flakes[0] || 0, t.statusAt]));

function cleanProject(p) {
  if (!p || typeof p !== 'object') return null;
  const name = cleanId(p.name) || 'project';
  const root = typeof p.root === 'string' && p.root.length <= 400 ? p.root : null;
  const runs = (Array.isArray(p.runs) ? p.runs : []).map(cleanRun).filter(Boolean).sort((a, b) => a.at - b.at).slice(-MAX_RUNS);
  const tests = {};
  const entries = p.tests && typeof p.tests === 'object' ? Object.entries(p.tests) : [];
  for (const [id, t] of entries) {
    const k = id === SUITE ? SUITE : cleanId(id);
    const c = k && k === id && cleanTest(t);
    if (c) tests[k] = c;
  }
  const kept = Object.entries(tests).sort((a, b) => (b[1].flakes[0] || b[1].statusAt) - (a[1].flakes[0] || a[1].statusAt)).slice(0, MAX_TESTS);
  return { name, root, runs, tests: Object.fromEntries(kept) };
}

/** Untrusted state in, a valid one out. */
function normalizeFlaky(src) {
  const s = src && typeof src === 'object' ? src : {};
  const projects = {};
  const entries = s.projects && typeof s.projects === 'object' ? Object.entries(s.projects) : [];
  for (const [k, p] of entries) {
    const c = KEY_RE.test(k) && cleanProject(p);
    if (c) projects[k] = c;
  }
  const kept = Object.entries(projects).sort((a, b) => lastActive(b[1]) - lastActive(a[1])).slice(0, MAX_PROJECTS);
  const said = s.said && DAY_RE.test(s.said.day) ? { day: s.said.day, n: Math.min(99, Math.floor(num(s.said.n))) } : { day: '', n: 0 };
  return { projects: Object.fromEntries(kept), said };
}

// What a test's status really is now: "Not flaky" wears off.
function statusOf(t, now) {
  if (t.status === 'dismissed' && (t.since >= DISMISS_UNTIL || now - t.statusAt > DISMISS_FOR)) return 'watching';
  return t.status;
}

const emptyTest = () => cleanTest({});
const weekOf = (t, now) => t.flakes.filter(at => now - at < WEEK).length;

// Whether run `b` says test `id`, which failed in `a`, passed.
function contradicts(id, b) {
  if (b.ok) return true;
  if (id === SUITE) return false;
  return b.parsed && b.complete && !b.failed.includes(id);
}

/**
 * Record one finished test run in a project.
 *   run: from readRun, plus { tree } (the git tree when it started)
 *   project: { key, name, root }
 * Returns { state, flakes: [{ id, week }], fresh: [id], fixed: [id] }
 *   fresh: tests that just started flaking (new, or back after being fixed or dismissed)
 *   fixed: tests whose fix just proved itself
 */
function recordRun(stateIn, project, run, now) {
  const state = normalizeFlaky(stateIn);
  const none = { state, flakes: [], fresh: [], fixed: [] };
  if (!project || !KEY_RE.test(project.key || '') || !run || !HASH_RE.test(run.cmd) || !TREE_RE.test(run.tree) || !num(now)) return none;
  const prev = own(state.projects, project.key) || { name: 'project', root: null, runs: [], tests: {} };
  const runs = prev.runs.filter(r => now - r.at < RUN_FOR).map(r => ({ ...r, settled: [...r.settled] }));
  const tests = Object.fromEntries(Object.entries(prev.tests).map(([k, t]) => [k, { ...t, flakes: t.flakes.filter(at => now - at < FLAKE_FOR) }]));
  const cur = cleanRun({ ...run, at: now, settled: [] });
  if (!cur) return none;

  // Who flaked: every disagreement between this run and an earlier one on the same code.
  const flaked = new Set(run.flaky?.map(cleanId).filter(Boolean) || []);
  for (const r of runs) {
    if (r.cmd !== cur.cmd || r.tree !== cur.tree) continue;
    const pair = (a, b) => {
      if (a.ok) return;
      const ids = a.parsed && a.failed.length <= MANY_FAILED ? a.failed : [SUITE];
      for (const id of ids) {
        if (a.settled.includes(id) || !contradicts(id, b)) continue;
        a.settled.push(id);
        flaked.add(id);
      }
    };
    pair(r, cur);
    pair(cur, r);
  }

  const fresh = [];
  const flakes = [];
  for (const id of flaked) {
    const t = own(tests, id) ? { ...tests[id] } : emptyTest();
    const was = own(tests, id) ? statusOf(tests[id], now) : null;
    if (t.status === 'dismissed') t.since += 1;
    t.flakes = [now, ...t.flakes].slice(0, MAX_FLAKES);
    t.framework = run.framework && FRAMEWORKS.includes(run.framework) ? run.framework : t.framework;
    t.cmds = [cur.cmd, ...t.cmds.filter(c => c !== cur.cmd)].slice(0, MAX_CMDS);
    t.ftrees = [cur.tree, ...t.ftrees.filter(x => x !== cur.tree)].slice(0, MAX_FLAKE_TREES);
    const status = statusOf(t, now);
    // A fix that didn't hold, or a test back from "Not flaky" or "fixed": watched again.
    if (status === 'fixing' || status === 'fixed' || (t.status === 'dismissed' && status === 'watching')) {
      Object.assign(t, { status: 'watching', statusAt: now, clean: 0, trees: [], since: 0 });
    }
    if (!was || was === 'fixed' || (tests[id]?.status === 'dismissed' && status === 'watching')) fresh.push(id);
    tests[id] = t;
    flakes.push({ id, week: weekOf(t, now) });
  }

  // A fix proves itself by runs that would have caught the flake and didn't,
  // on code that is new since "Fix it": the unfixed code passing again
  // (in your own checkout, while the fix sits on its branch) proves nothing.
  const fixed = [];
  for (const [id, t] of Object.entries(tests)) {
    if (t.status !== 'fixing' || flaked.has(id) || !t.cmds.includes(cur.cmd)) continue;
    if (t.ftrees.includes(cur.tree) || t.old.includes(cur.tree)) continue;
    if (!(cur.ok || (id !== SUITE && cur.parsed && cur.complete && !cur.failed.includes(id)))) continue;
    const trees = t.trees.includes(cur.tree) ? t.trees : [...t.trees, cur.tree].slice(-FIXED_TREES);
    const next = { ...t, clean: t.clean + 1, trees };
    if (next.clean >= FIXED_RUNS && next.trees.length >= FIXED_TREES) {
      Object.assign(next, { status: 'fixed', statusAt: now });
      fixed.push(id);
    }
    tests[id] = next;
  }

  const name = cleanId(project.name) || prev.name;
  // The first folder sticks: another clone claiming the same remote can't repoint "Fix it".
  const root = prev.root || (typeof project.root === 'string' && project.root.length <= 400 ? project.root : null);
  const p = { name, root, runs: [...runs, cur].slice(-MAX_RUNS), tests };
  const state2 = normalizeFlaky({ ...state, projects: { ...state.projects, [project.key]: p } });
  return { state: state2, flakes, fresh, fixed };
}

/** Set a test's status: 'watching', 'fixing', 'quarantined' or 'dismissed'. */
function setStatus(stateIn, key, id, status, now) {
  const state = normalizeFlaky(stateIn);
  const p = own(state.projects, key);
  const t = p && own(p.tests, id);
  if (!t || !['watching', 'fixing', 'quarantined', 'dismissed'].includes(status) || !num(now)) return state;
  // Every version of the code known when "Fix it" was pressed: none of them has the fix.
  const old = status === 'fixing' ? [...new Set([...t.ftrees, ...p.runs.map(r => r.tree)])].slice(0, MAX_OLD) : [];
  const next = { ...t, status, statusAt: now, clean: 0, trees: [], since: 0, old };
  return normalizeFlaky({ ...state, projects: { ...state.projects, [key]: { ...p, tests: { ...p.tests, [id]: next } } } });
}

/** Remember the GitHub issue filed for a test. Nothing else about it changes. */
function setIssue(stateIn, key, id, issue, now) {
  const state = normalizeFlaky(stateIn);
  const p = own(state.projects, key);
  const t = p && own(p.tests, id);
  const clean = issue && cleanIssue({ ...issue, at: now });
  if (!t || !clean) return state;
  return normalizeFlaky({ ...state, projects: { ...state.projects, [key]: { ...p, tests: { ...p.tests, [id]: { ...t, issue: clean } } } } });
}

/** Forget one project, or everything. */
function forget(stateIn, key = null) {
  const state = normalizeFlaky(stateIn);
  if (key == null) return normalizeFlaky({});
  const { [key]: _gone, ...rest } = state.projects;
  return { ...state, projects: rest };
}

/**
 * The flaky list for the panel, most flaky first. Each row:
 *   { key, project, id, label, framework, week, total, lastAt, status, statusAt, suite, retry, clean }
 * Dismissed tests stay off it; fixed ones show for a week.
 */
function flakyView(stateIn, now) {
  const state = normalizeFlaky(stateIn);
  const rows = [];
  for (const [key, p] of Object.entries(state.projects)) {
    for (const [id, t] of Object.entries(p.tests)) {
      const status = statusOf(t, now);
      if (status === 'dismissed' || !t.flakes.length) continue;
      if (status === 'fixed' && now - t.statusAt > FIXED_SHOWN) continue;
      rows.push({
        key, project: p.name, id, label: labelOf(id), framework: t.framework,
        week: weekOf(t, now), total: t.flakes.length, lastAt: t.flakes[0],
        status, statusAt: t.statusAt, suite: id === SUITE,
        retry: status === 'quarantined' && now - t.statusAt > RETRY_AFTER,
        clean: status === 'fixing' ? { runs: t.clean, of: FIXED_RUNS, trees: t.trees.length } : null,
        issue: t.issue,
      });
    }
  }
  const rank = r => (r.status === 'fixed' ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || b.week - a.week || b.lastAt - a.lastAt);
}

/** One test in the view, or null: what the panel's buttons are checked against. */
function findTest(stateIn, key, id, now) {
  return flakyView(stateIn, now).find(r => r.key === key && r.id === id) || null;
}

/**
 * Which flaky test he should mention now, or null: a named test (not the
 * whole suite) still being watched, with SAY_AT or more flakes this week,
 * not mentioned in the last day, and fewer than SAY_A_DAY bubbles today.
 */
function due(stateIn, now) {
  const state = normalizeFlaky(stateIn);
  const today = dayKey(now);
  if (state.said.day === today && state.said.n >= SAY_A_DAY) return null;
  /** @type {{ key: string, id: string, project: any, label: any, week: any } | null} */
  let best = null;
  for (const [key, p] of Object.entries(state.projects)) {
    for (const [id, t] of Object.entries(p.tests)) {
      if (id === SUITE || statusOf(t, now) !== 'watching' || now - t.lastSaidAt < SAY_GAP) continue;
      const week = weekOf(t, now);
      if (week < SAY_AT || now - t.flakes[0] > HOUR) continue; // only right after it happens
      if (!best || week > best.week) best = { key, id, project: p.name, label: labelOf(id), week };
    }
  }
  return best;
}

/** He has just said it. */
function markSaid(stateIn, key, id, now) {
  const state = normalizeFlaky(stateIn);
  const p = own(state.projects, key);
  const t = p && own(p.tests, id);
  if (!t) return state;
  const today = dayKey(now);
  const said = { day: today, n: (state.said.day === today ? state.said.n : 0) + 1 };
  return normalizeFlaky({ ...state, said, projects: { ...state.projects, [key]: { ...p, tests: { ...p.tests, [id]: { ...t, lastSaidAt: now } } } } });
}

module.exports = {
  MANY_FAILED, SAY_AT, FIXED_RUNS, FIXED_TREES, RETRY_AFTER,
  normalizeFlaky, recordRun, setStatus, setIssue, forget, flakyView, findTest, due, markSaid,
};
