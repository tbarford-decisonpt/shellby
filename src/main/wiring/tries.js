// Try it N ways (tries.js): the same message in 2-4 new tabs at once, each in
// its own copy of the project, grouped as one family so the branch chip's
// Compare and Keep this one work on them. As each finishes, its tests run
// (checks.js, local and free); once they all have, a card in the first try's
// tab ranks them. You pick: nothing is kept or thrown away here.
//
// It burns N tasks' worth of usage, so nothing here ever starts by itself:
// start() is only reached from tries:start (the /tries command or the send
// button's menu), and it always asks in the isolated confirmation window
// first, with what it usually costs. Kept out of main.js, which only wires it up.
const path = require('path');
const { MAX_TABS } = require('../sessions');
const tries = require('../tries');

const MAX_RUNS = 20; // finished runs remembered, for their cards' Stop and status

/**
 * d: what main shares (main.js `shared`).
 * opts.ask(spec) -> button index (the confirmation window); opts.rootOf(dir) -> git root | null;
 * opts.maxTabs (tests).
 */
function wireTries(d, opts = {}) {
  const ask = opts.ask || (spec => require('../confirm').ask(d.panel, { ...d.dialogLook(), ...spec }));
  const rootOf = opts.rootOf || (dir => require('../changes').rootOf(dir));
  const maxTabs = opts.maxTabs || MAX_TABS;
  const runs = new Map();    // runId -> run
  const byTab = new Map();   // tabId -> runId
  let starting = false;      // one at a time: a double click is one set of tries
  let watching = false;

  const isStr = s => typeof s === 'string' && s.length > 0;
  const inHome = dir => (path.resolve(dir) + path.sep).toLowerCase().startsWith(path.resolve(d.worktreeHome()).toLowerCase() + path.sep);

  // ------------------------------------------------------------ the card

  function view(run) {
    const rows = run.tries.map(t => ({
      tabId: t.tabId, title: t.title, state: t.state, files: t.files, added: t.added, removed: t.removed,
      durationMs: t.durationMs, checks: t.checks, failing: t.failing,
    }));
    const final = tries.allDone(rows);
    return {
      kind: 'tries', runId: run.id, firstId: run.firstId, n: run.tries.length, title: run.title, final,
      startedAt: run.startedAt, rows: final ? tries.rank(rows) : rows,
    };
  }

  // A card in the first try's transcript, every time something changes: the
  // panel swaps it in place, and a replay shows the latest.
  function publish(run) {
    const item = { ...view(run), t: Date.now() };
    try {
      if (d.manager.tabs.has(run.firstId)) d.manager.note(run.firstId, item);
      else if (d.history.get(run.firstId)) d.history.append(run.firstId, item);
    } catch (err) { d.log.info(`tries: ${err.message}`); }
    return item;
  }

  function finish(run) {
    if (run.finished) return;
    run.finished = true;
    const item = publish(run);
    const line = tries.doneLine(item.rows);
    d.send(d.panel, 'tries:done', { runId: run.id, firstId: run.firstId, text: line });
    const focused = !!(d.panel && !d.panel.isDestroyed?.() && d.panel.isVisible?.() && d.panel.isFocused?.());
    if (!focused) d.notify?.(`${tries.MARK} Tries done: ${run.title}`, line, () => d.showPanel({ focusInput: false, tabId: run.firstId }), { action: 'Have a look' });
    d.stat?.('tries-done', { n: run.tries.length });
    while (runs.size > MAX_RUNS) {
      const old = [...runs.values()].find(r => r.finished);
      if (!old) break;
      runs.delete(old.id);
      for (const t of old.tries) if (byTab.get(t.tabId) === old.id) byTab.delete(t.tabId);
    }
  }

  function settle(run) {
    // Still starting the rest: a quick first try mustn't finish the run early.
    if (!run.launching && tries.allDone(run.tries)) finish(run);
    else publish(run);
  }

  // However a try's tab closes, the run doesn't wait for it.
  function watchCloses() {
    if (watching || !d.manager?.on) return;
    watching = true;
    d.manager.on('tabs', summary => {
      const open = new Set((summary || []).map(t => t.id));
      for (const run of runs.values()) {
        if (run.finished) continue;
        const gone = run.tries.filter(t => t.state === 'running' && !open.has(t.tabId));
        if (!gone.length) continue;
        for (const t of gone) t.state = 'gone';
        settle(run);
      }
    });
  }

  // ------------------------------------------------------------ starting

  /**
   * req: { tabId, n, text, attachments } from the panel.
   * -> { ok: true, runId, firstId, started, n, error? } | { ok: false, error?, cancelled? }
   */
  async function start(req) {
    const tabId = isStr(req?.tabId) ? req.tabId : null;
    const n = Number(req?.n);
    const text = typeof req?.text === 'string' ? req.text.trim() : '';
    const tab = tabId ? d.manager.tabs.get(tabId) : null;
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    if (d.config.get('crabOnly') || !d.claudeStatus?.installed || !d.claudeStatus?.loggedIn) return { ok: false, error: 'That needs Claude Code: set it up first.' };
    const attachments = Array.isArray(req?.attachments) ? req.attachments.length : 0;
    const why = tries.problem({ n, text, tabsOpen: d.manager.tabs.size, maxTabs, attachments });
    if (why) return { ok: false, error: why };
    if (starting) return { ok: false, error: 'Already starting some tries.' };
    starting = true;
    try {
      // From your checkout: a tab already in a copy tries from the checkout it came from.
      const w = tab.worktree && typeof tab.worktree.originalCwd === 'string' && inHome(tab.worktree.path || '') ? tab.worktree : null;
      const dir = w ? w.originalCwd : tab.session?.cwd;
      const root = dir ? await rootOf(dir) : null;
      if (!root || inHome(root)) return { ok: false, error: "Tries need a git project: each one works in its own copy, and this folder isn't in a git repository." };

      const mode = tab.session?.mode || null; // the same as this tab's, never more
      let estimate = null; // no guess is fine: the question says so (tries.costQuestion)
      try { estimate = d.usagePlan?.estimateFor(tabId, text) || null; } catch (err) { d.log.info(`tries: estimate: ${err.message}`); }
      const q = tries.costQuestion({ n, estimate, mode });
      const { over, total: _total, ...spec } = q;
      d.wake?.();
      const answer = await ask({ icon: tries.MARK, ...spec });
      if (answer !== 0) return { ok: false, cancelled: true };
      // Tabs may have opened while you were deciding.
      const late = tries.problem({ n, text, tabsOpen: d.manager.tabs.size, maxTabs });
      if (late) return { ok: false, error: late };
      return await launch({ n, text, dir, mode, over });
    } finally {
      starting = false;
    }
  }

  async function launch({ n, text, dir, mode, over }) {
    const title = tries.titleFor(text);
    const run = { id: d.randomUUID(), title, startedAt: Date.now(), firstId: null, tries: [], finished: false, launching: true };
    // Known before the first copy is made: a try can finish (or close) while the
    // next is still being copied, and turnEnded must find it.
    runs.set(run.id, run);
    watchCloses();
    let error = null;
    for (let i = 1; i <= n; i++) {
      const name = tries.tryTitle(i, n, title);
      const r = await d.startTaskInCopy(dir, name, () => text, { mode });
      if (!r?.ok) { error = r?.error || "Couldn't start it."; break; }
      const open = d.manager.tabs.get(r.tabId);
      if (!run.firstId) run.firstId = r.tabId;
      else {
        // Grouped with the first, so the branch chip's Compare and Keep this one see them all.
        const branchOf = { id: run.firstId, title: tries.tryTitle(1, n, title), at: null, tries: run.id };
        d.history.update(r.tabId, { branchOf });
        if (open) open.branchOf = branchOf;
      }
      run.tries.push({ tabId: r.tabId, title: name, turnId: open?.turnId || null, startedAt: Date.now(), state: 'running', files: 0, added: 0, removed: 0, durationMs: null, checks: null, failing: 0 });
      byTab.set(r.tabId, run.id);
    }
    run.launching = false;
    if (!run.tries.length) { runs.delete(run.id); return { ok: false, error: error || "Couldn't start the tries." }; }
    d.manager.changed?.();
    settle(run); // any that finished while the others were starting
    d.stat?.('tries', { n: run.tries.length, over: !!over });
    d.log.info(`tries: started ${run.tries.length} of ${n}`);
    return {
      ok: true, runId: run.id, firstId: run.firstId, started: run.tries.length, n,
      ...(error ? { error: `Only ${run.tries.length} of ${n} could start: ${error}` } : {}),
    };
  }

  // ------------------------------------------------------------ as each one ends

  /** A turn has ended and its diff is noted (timetrack onResult). Never throws. */
  async function turnEnded(tabId, result) {
    try {
      const run = runs.get(byTab.get(tabId));
      const t = run?.tries.find(x => x.tabId === tabId);
      if (!t || t.state !== 'running') return;
      t.durationMs = Number.isFinite(result?.durationMs) ? result.durationMs : Date.now() - t.startedAt;
      if (result?.interrupted || run.stopping) { t.state = 'stopped'; return settle(run); }
      if (!result?.ok) { t.state = 'failed'; return settle(run); }
      const items = d.history.load(tabId) || [];
      const ch = [...items].reverse().find(i => i?.kind === 'changes' && (!t.turnId || !i.turnId || i.turnId === t.turnId));
      if (!ch) { t.state = 'done'; t.checks = null; return settle(run); }
      t.files = Array.isArray(ch.files) ? ch.files.length + (Number(ch.more) || 0) : 0;
      t.added = Number(ch.added) || 0;
      t.removed = Number(ch.removed) || 0;
      t.state = 'checking';
      publish(run);
      const ref = d.changeRef({ tabId, root: ch.root, before: ch.before, after: ch.after });
      const c = await d.checkTry(ref);
      t.checks = c?.status || (c?.none ? 'none' : c?.declined ? 'declined' : c?.cancelled ? 'cancelled' : 'error');
      t.failing = Number(c?.failing) || 0;
      t.state = 'done';
      settle(run);
    } catch (err) {
      d.log.info(`tries: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ stopping

  /** "Stop all tries": every one still working stops, and so do their tests. */
  function stop(runId) {
    const run = isStr(runId) ? runs.get(runId) : null;
    if (!run || run.finished) return { ok: false, error: 'Those tries have finished.' };
    run.stopping = true;
    let stopped = 0;
    for (const t of run.tries) {
      if (t.state === 'running' && d.manager.tabs.has(t.tabId)) { d.manager.interrupt(t.tabId); stopped++; }
      if (t.state === 'checking') { d.cancelChecks?.(t.tabId); stopped++; }
    }
    d.log.info(`tries: stopped ${stopped}`);
    return { ok: true, stopped };
  }

  /** The live card for a run, or null once Shellby has forgotten it (closed since). */
  function status(runId) {
    const run = isStr(runId) ? runs.get(runId) : null;
    return run ? view(run) : null;
  }

  return { start, stop, status, turnEnded };
}

module.exports = { wireTries };
