// Turn checks (checks.js): the project's tests after a turn that changed
// files, "Run checks" on any turn's diff, and the check before a copy is
// brought home. Kept out of main.js, which only wires it up.
//
// One run per tab at a time, and never while Claude is working in it: a new
// turn cancels the run (sessions.js prepareTurn), and the newest request for a
// tab replaces an older one still going. A project's checks are its own
// scripts, so the first run in each project asks first (confirm.js), and they
// run with a pared-down environment (checks.checkEnv).
const path = require('path');
const changes = require('../changes');
const checks = require('../checks');
const confirm = require('../confirm');

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

  // The project a run belongs to, for asking once: a copy counts as the clone it came from.
  const projectOf = (tabId, root) => d.manager.tabs.get(tabId)?.worktree?.root || root;

  // ---- asking once per project
  let asking = null;
  /**
   * -> true to run. quiet: an automatic run, which never asks at all once there's
   * a question open, nor again after a no. once: asked for, but a no already
   * given stands (each of several tries finishing mustn't ask it again).
   */
  async function trusted(project, commands, { quiet = false, once = false } = {}) {
    const was = checks.trustOf(d.config.get('checksTrusted'), project);
    if (was === true) return true;
    if (was === false && (quiet || once)) return false;
    if (asking) {
      // One question at a time. One you asked for waits its turn (its
      // project's answer may be the one being given), an automatic run doesn't.
      if (quiet) return false;
      await asking;
      return trusted(project, commands, { quiet, once });
    }
    asking = confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '🧪',
      title: `Run ${path.basename(project)}'s tests?`,
      message: "Checks run the project's own scripts on this PC, with your account, like typing them in a terminal.",
      detail: commands.join('\n'),
      note: 'Shellby keeps sign-in tokens and keys out of their environment, and asks this once per project. Only say yes for code you trust.',
      buttons: [{ label: 'Run its tests' }, { label: 'Not this project' }], defaultId: 1, cancelId: 1,
    }).catch(() => 1);
    try {
      const yes = (await asking) === 0;
      d.config.set({ checksTrusted: checks.withTrust(d.config.get('checksTrusted'), project, yes) });
      return yes;
    } finally { asking = null; }
  }

  // The panel, or the conversation's own window (wiring/popouts.js).
  const windowOf = tabId => d.tabWindow?.(tabId) || d.panel;

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
    d.surprises?.noteChecks(tabId, verdict); // red, then a turn, then green: a crit
  }

  /**
   * Run a folder's checks for a tab.
   * -> { verdict } | { none: true } | { cancelled: true } | { declined: true }.
   * after: the turn's tree the verdict stamps (null: the folder as it is).
   */
  async function run(tabId, { cwd, after = null, project, quiet = false, once = false }) {
    const commands = checks.detect(cwd);
    if (!commands.length) return { none: true };
    if (!await trusted(project || cwd, commands, { quiet, once })) return { declined: true };
    if (d.manager.isBusy(tabId)) return { cancelled: true };
    running.get(tabId)?.cancel(); // the newest wins
    let settle;
    const entry = { after, open: d.manager.tabs.has(tabId), done: new Promise(r => { settle = r; }), cancel: () => { entry.cancelled = true; entry.handle?.cancel(); } };
    watchCloses();
    running.set(tabId, entry);
    try {
      d.send(windowOf(tabId), 'checks:running', { tabId, after, running: true, commands });
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
      settle();
      const now = running.get(tabId);
      if (now === entry) running.delete(tabId);
      // A newer run for the same turn has already said "Checking…": leave that be.
      if (now === entry || now?.after !== after) d.send(windowOf(tabId), 'checks:running', { tabId, after, running: false });
    }
  }

  /** A turn that changed files has ended (sessions.js noteTurnChanges). Never throws. */
  function afterTurn(tabId, summary) {
    try {
      if (!checksOn() || !summary?.files?.length || d.manager.isBusy(tabId)) return;
      const tab = d.manager.tabs.get(tabId);
      // Not a run that's stopped, a routine's or a workflow's, or a turn whose helpers are still at it.
      if (!tab || tab.routineId || tab.workflowRunId || tab.outcome === 'stopped' || tab.session?.runningCrew?.().length) return;
      const project = projectOf(tabId, summary.root);
      // Started from the phone, so likely nobody's at the desk: never leave the
      // "run its tests?" question waiting there. Projects you've said yes to still run.
      if (tab.fromPhone && checks.trustOf(d.config.get('checksTrusted'), project) !== true) return;
      run(tabId, { cwd: folderFor(tabId, summary.root), after: summary.after, project, quiet: true })
        .catch(err => d.log.info(`checks: ${err.message}`));
    } catch (err) {
      d.log.info(`checks: ${err.message}`);
    }
  }

  /** "Run checks" on a turn's diff. ref: from changeRef. */
  async function runFor(ref) {
    if (ref.retired) return { ok: false, error: 'That copy has been tidied away, so there is nothing to check it in.' };
    if (d.manager.isBusy(ref.tabId)) return { ok: false, error: 'Let him finish first, then check.' };
    if (running.get(ref.tabId)?.after === ref.after) return { ok: false, error: 'Already checking.' };
    const r = await run(ref.tabId, { cwd: folderFor(ref.tabId, ref.root), after: ref.after, project: projectOf(ref.tabId, ref.root) });
    if (r.none) return { ok: false, none: true, error: "Shellby couldn't find any tests to run here (a package.json test script, cargo, go or pytest)." };
    if (r.declined) return { ok: false, declined: true };
    if (r.cancelled) return { ok: false, cancelled: true, error: 'Stopped: he started on something new.' };
    return { ok: true, status: r.verdict.status };
  }

  /**
   * One of "Try it N ways"' tries has finished its turn (wiring/tries.js): its
   * checks, whatever the "check each turn" setting says, sharing a run already
   * going for the same turn. Asks once per project, like "Run checks".
   * ref: from changeRef. -> { status, failing } | { none } | { declined } | { cancelled } | { error }
   */
  async function checkTry(ref) {
    if (!ref) return { error: 'That turn changed nothing that was noted.' };
    if (ref.retired) return { error: 'That copy has been tidied away.' };
    const going = running.get(ref.tabId);
    if (going && going.after === ref.after) {
      await going.done;
      const v = verdicts.get(ref.tabId);
      return v && v.after === ref.after && !going.cancelled ? { status: v.status, failing: checks.failingOf(v).count } : { cancelled: true };
    }
    if (d.manager.isBusy(ref.tabId)) return { cancelled: true };
    const r = await run(ref.tabId, { cwd: folderFor(ref.tabId, ref.root), after: ref.after, project: projectOf(ref.tabId, ref.root), once: true });
    return r.verdict ? { status: r.verdict.status, failing: checks.failingOf(r.verdict).count } : r;
  }

  /**
   * Before a copy is brought home. -> { ok: true, verdict? } to carry on, or
   * { ok: false, red: true, checks } / { ok: false, error } to stop.
   *   check: ticked for this one (a boolean), or undefined to follow the setting
   */
  async function gateHome(tabId, w, { check, force } = {}) {
    const gate = typeof check === 'boolean' ? check : checksOn();
    if (!gate || force) return { ok: true };
    const cwd = d.manager.tabs.has(tabId) ? folderFor(tabId, w.path) : w.cwd || w.path;
    const commands = checks.detect(cwd);
    if (!commands.length) return { ok: true };
    const snap = await snapshotWithin(cwd);
    const last = verdicts.get(tabId) || null;
    const decision = checks.homeGate({ gate, force, commands, last, tree: snap?.tree || null });
    let verdict = last;
    if (decision === 'run') {
      const r = await run(tabId, { cwd, after: null, project: w.root });
      if (r.none) return { ok: true };
      if (r.declined) return { ok: false, error: "Not brought home: its tests weren't run. Untick \"Check before bringing home\" on the branch chip to skip them." };
      if (r.cancelled) return { ok: false, error: 'Stopped checking: he started on something new.' };
      verdict = r.verdict;
    }
    if (decision === 'skip' || checks.gatePasses(verdict)) return { ok: true, verdict };
    return { ok: false, red: true, checks: summaryOf(verdict), fix: checks.fixPrompt(verdict, { branch: w.branch }) };
  }

  const summaryOf = v => ({ status: v.status, ...checks.failingOf(v), commands: v.commands.map(c => ({ cmd: c.cmd, ok: c.ok, failed: c.failed, timedOut: !!c.timedOut })) });

  function cancel(tabId) { running.get(tabId)?.cancel(); }
  function cancelAll() { for (const r of running.values()) r.cancel(); }
  // However a tab closes (its ✕, History, a project, branching), its tests stop
  // with it. Not a run for a copy that was never open (Bring all home).
  let watching = false;
  function watchCloses() {
    if (watching || !d.manager) return;
    watching = true;
    d.manager.on('tabs', summary => {
      const open = new Set(summary.map(t => t.id));
      for (const [id, r] of running) if (r.open && !open.has(id)) r.cancel();
    });
  }

  /**
   * A copy's checks as it stands now, for lining copies up (wiring/lanes.js).
   * Asks once per project, like "Run checks". -> { status } where status is a
   * verdict's, or 'none' | 'declined' | 'cancelled'.
   */
  async function checkCopy(tabId, cwd) {
    const r = await run(tabId, { cwd, project: projectOf(tabId, cwd), once: true });
    if (r.verdict) return { status: r.verdict.status };
    return { status: r.none ? 'none' : r.declined ? 'declined' : 'cancelled' };
  }

  return { checksOn, afterTurnChecks: afterTurn, runChecksFor: runFor, checkTry, gateHome, checkCopy, cancelChecks: cancel, cancelAllChecks: cancelAll };
}

module.exports = { wireChecks };
