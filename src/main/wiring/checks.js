// Turn checks (checks.js): the project's tests after a turn that changed
// files, "Run checks" on any turn's diff, and the check before a copy is
// brought home. Kept out of main.js, which only wires it up.
//
// One run per tab at a time, and never while Claude is working in it: a new
// turn cancels the run (sessions.js prepareTurn), and the newest request for a
// tab replaces an older one still going.
const path = require('path');
const changes = require('../changes');
const checks = require('../checks');

const SNAPSHOT_WAIT_MS = 10000;

/** d: what main shares (main.js `shared`). */
function wireChecks(d) {
  const running = new Map();   // tabId -> { after, cancel, promise }
  const verdicts = new Map();  // tabId -> its last verdict in full (this run of Shellby)
  const MAX_VERDICTS = 100;

  const checksOn = () => !d.CAPTURE && !!d.config && d.config.get('checkEachTurn') === true && !d.config.get('crabOnly');
  const limitMs = () => checks.timeoutMs(d.config.get('checkTimeoutMin'));

  // Where to run: the tab's folder when it's inside the repo the change was
  // in (a package in a monorepo), else the repo's root.
  function folderFor(tabId, root) {
    const cwd = d.manager.tabs.get(tabId)?.session?.cwd;
    if (cwd && (path.resolve(cwd) + path.sep).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) return cwd;
    return root;
  }

  function snapshotWithin(dir) {
    let late = false;
    const taken = changes.snapshot(dir).catch(() => null).then(s => (late ? null : s));
    return Promise.race([taken, new Promise(r => setTimeout(() => { late = true; r(null); }, SNAPSHOT_WAIT_MS))]);
  }

  function remember(tabId, verdict) {
    verdicts.delete(tabId);
    verdicts.set(tabId, verdict);
    while (verdicts.size > MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value);
    const tab = d.manager.tabs.get(tabId);
    if (!tab) return;
    tab.checks = { status: verdict.status, after: verdict.after, tree: verdict.tree, at: verdict.at };
    d.manager.note(tabId, verdict);
    d.manager.changed();
  }

  /**
   * Run a folder's checks for a tab. -> { verdict } | { none: true } | { cancelled: true }.
   * after: the turn's tree the verdict stamps (null: the folder as it is).
   */
  async function run(tabId, { cwd, after = null }) {
    running.get(tabId)?.cancel(); // the newest wins
    const commands = checks.detect(cwd);
    if (!commands.length) return { none: true };
    const entry = { after, cancel: () => { entry.cancelled = true; entry.handle?.cancel(); } };
    running.set(tabId, entry);
    d.send(d.panel, 'checks:running', { tabId, after, running: true, commands });
    try {
      const snap = await snapshotWithin(cwd);
      if (entry.cancelled) return { cancelled: true };
      entry.handle = checks.runAll(commands, cwd, { timeoutMs: limitMs() });
      const { results, cancelled } = await entry.handle.promise;
      if (cancelled || entry.cancelled) return { cancelled: true };
      const tree = snap?.tree || null;
      const verdict = checks.buildVerdict(results, { after: after || tree, root: snap?.root || cwd, tree });
      remember(tabId, verdict);
      return { verdict };
    } finally {
      if (running.get(tabId) === entry) running.delete(tabId);
      d.send(d.panel, 'checks:running', { tabId, after, running: false });
    }
  }

  /** A turn that changed files has ended (sessions.js noteTurnChanges). */
  function afterTurn(tabId, summary) {
    if (!checksOn() || !summary?.files?.length || d.manager.isBusy(tabId)) return;
    const tab = d.manager.tabs.get(tabId);
    // Not a run that's stopped, a routine's or a workflow's, or a turn whose helpers are still at it.
    if (!tab || tab.routineId || tab.workflowRunId || tab.outcome === 'stopped' || tab.session?.runningCrew?.().length) return;
    run(tabId, { cwd: folderFor(tabId, summary.root), after: summary.after })
      .catch(err => d.log.info(`checks: ${err.message}`));
  }

  /** "Run checks" on a turn's diff. ref: from changeRef. */
  async function runFor(ref) {
    if (ref.retired) return { ok: false, error: 'That copy has been tidied away, so there is nothing to check it in.' };
    if (d.manager.isBusy(ref.tabId)) return { ok: false, error: 'Let him finish first, then check.' };
    if (running.get(ref.tabId)?.after === ref.after) return { ok: false, error: 'Already checking.' };
    const r = await run(ref.tabId, { cwd: folderFor(ref.tabId, ref.root), after: ref.after });
    if (r.none) return { ok: false, none: true, error: "Shellby couldn't find any tests to run here (a package.json test script, cargo, go or pytest)." };
    if (r.cancelled) return { ok: false, cancelled: true, error: 'Stopped: he started on something new.' };
    return { ok: true, status: r.verdict.status };
  }

  /**
   * Before a copy is brought home. -> { ok: true, verdict? } to carry on, or
   * { ok: false, red: true, checks } / { ok: false, error } to stop.
   *   check: ticked for this one (a boolean), or undefined to follow the setting
   */
  async function gateHome(tabId, w, { check, force } = {}) {
    const gate = typeof check === 'boolean' ? check : checksOn();
    if (!gate || force) return { ok: true };
    const cwd = w.cwd || w.path;
    const commands = checks.detect(cwd);
    if (!commands.length) return { ok: true };
    const snap = await snapshotWithin(cwd);
    const last = verdicts.get(tabId) || null;
    const decision = checks.homeGate({ gate, force, commands, last, tree: snap?.tree || null });
    let verdict = last;
    if (decision === 'run') {
      const r = await run(tabId, { cwd, after: null });
      if (r.none) return { ok: true };
      if (r.cancelled) return { ok: false, error: 'Stopped checking: he started on something new.' };
      verdict = r.verdict;
    }
    if (decision === 'skip' || checks.gatePasses(verdict)) return { ok: true, verdict };
    return { ok: false, red: true, checks: summaryOf(verdict), fix: checks.fixPrompt(verdict, { branch: w.branch }) };
  }

  const summaryOf = v => ({ status: v.status, ...checks.failingOf(v), commands: v.commands.map(c => ({ cmd: c.cmd, ok: c.ok, failed: c.failed, timedOut: !!c.timedOut })) });

  function cancel(tabId) { running.get(tabId)?.cancel(); }
  function cancelAll() { for (const r of running.values()) r.cancel(); }

  return { checksOn, afterTurnChecks: afterTurn, runChecksFor: runFor, gateHome, cancelChecks: cancel, cancelAllChecks: cancelAll };
}

module.exports = { wireChecks };
