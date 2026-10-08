// Routines: the saved list, running one (on schedule, by hand, as a test, or
// after the reset), the scheduler, and Claude's help writing and fixing them
// (routine-draft.js) or adding one over MCP (crabtools.js).
// Moved out of main.js; holding a run for the reset is held-service.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crabtools = require('./crabtools');
const guard = require('./guard');
const limits = require('./limits');
const mcpServers = require('./mcpservers');
const routineDraft = require('./routine-draft');
const { isModel } = require('./models');
const { MAX_TABS } = require('./sessions');
const { missedOnStartup, nextRun, describeSchedule, Scheduler } = require('./routines');

const MAX_ROUTINES = 50;
const ROUTINE_TABS_KEPT = 6;             // finished routine tabs left open before the oldest closes
const MAX_ROUTINE_TESTS = 20;
// One routine question at a time, so a chatty session can't stack dialogs, and
// a quiet spell after a no, so anything on the port can't keep asking.
const ROUTINE_COOLDOWN_MS = 30 * 1000;
const CATCH_UP_FIRST_MS = 8000;          // missed runs wait for the app to settle...
const CATCH_UP_STAGGER_MS = 5000;        // ...and then go one after another
const MAX_PLACES = 20;
const PLACES_FROM_HISTORY = 200;

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const lastLines = s => String(s).trim().split('\n').slice(-3).join(' ');

/**
 * d: what this needs from main, read when it's used.
 *   config, panel, manager, history, claudeStatus, remote, usagePlan: getters
 *   log, send, notify, showPanel, sayText, wake, openTab, currentCwd, stat,
 *   dialogLook, confirm ({ ask }), runClaudeOnce, knownProjects, isFolder,
 *   randomUUID,
 *   from usage-service.js: limitWait, guardSettings, clockTime,
 *   from held-service.js: heldList, holdForReset, scheduleHeld, syncKeepAwake, queueTabs
 */
function createRoutines(d) {
  const routineTabs = new Map();     // tabId -> routine id (for lastStatus bookkeeping)
  // Build it with Claude's test runs: tab id -> routine id. Kept apart from
  // routineTabs, which forgets a tab once it closes, so a test is still read
  // after you've closed its tab. Only the last few are remembered.
  const routineTests = new Map();
  let scheduler = null;
  let routineAsking = false;
  let routineDeclinedAt = 0;
  let routineDrafting = false;

  function routines() { return Array.isArray(d.config.get('routines')) ? d.config.get('routines') : []; }

  function routinesView() {
    const now = Date.now();
    return routines().map(r => ({
      ...r, next: nextRun(r, now), scheduleText: describeSchedule(r.schedule),
      running: [...routineTabs.entries()].some(([tabId, id]) => id === r.id && d.manager.isBusy(tabId)),
      held: heldFor(r.id),
      // Small runs on a top model: the editor says a lighter one would do (never changes it).
      suggestModel: d.usagePlan?.routineSuggestion(r),
    }));
  }

  // A run of this routine waiting for the usage reset: { id, at, atText } or null.
  function heldFor(routineId) {
    const h = d.heldList().find(x => x.kind === 'routine' && x.routineId === routineId);
    return h ? { id: h.id, at: h.at, atText: d.clockTime(h.at) } : null;
  }

  function saveRoutines(list) {
    d.config.set({ routines: list });
    d.send(d.panel, 'routines', routinesView());
  }

  function updateRoutine(id, patch) {
    saveRoutines(routines().map(r => (r.id === id ? { ...r, ...patch } : r)));
  }

  // An hourly routine opens a tab every run; left alone they'd fill the strip
  // overnight, and at the cap the next run (and any tab of yours) couldn't open.
  // Past ROUTINE_TABS_KEPT finished ones, or at the cap, the oldest finished
  // routine tab closes. History keeps its transcript.
  function makeRoomForRoutine() {
    const { manager, queueTabs } = d;
    // A queue tab still on the list (it ran dry, and carries on later) is kept, and
    // so is one carrying on in a terminal (handoff.js): closing it loses its marker.
    const pending = new Set(d.heldList().map(h => h.tabId).filter(Boolean));
    const finished = [...routineTabs.keys(), ...queueTabs.keys()].filter(id => manager.tabs.has(id) && !manager.isBusy(id) && !pending.has(id) && !manager.tabs.get(id).inTerminal);
    if (manager.tabs.size < MAX_TABS && finished.length < ROUTINE_TABS_KEPT) return;
    const done = finished[0];
    if (!done) return;
    manager.close(done);
    routineTabs.delete(done);
    queueTabs.delete(done);
    d.remote?.settleTab(done);
  }

  // A routine's MCP servers -> what its conversation starts with: rules that let
  // Claude use them unasked, and with "only these", just their definitions.
  // Throws (runRoutine reports it) when one can't be loaded on its own.
  function routineTools(r, cwd) {
    if (!r.mcp?.length) return {};
    let mcpConfig = null;
    if (r.mcpOnly) {
      const res = mcpServers.configFor(r.mcp, { home: os.homedir(), cwd });
      if (!res.ok) throw new Error(res.error);
      mcpConfig = res.config;
    }
    return { allowedTools: mcpServers.allowRules(r.mcp), mcpConfig };
  }

  function runRoutine(r, { reason = 'scheduled' } = {}) {
    const busyTab = [...routineTabs.entries()].find(([tabId, id]) => id === r.id && d.manager.isBusy(tabId));
    if (busyTab) return { ok: false, skipped: true, error: `"${r.name}" is still running from last time.` };
    if (!d.claudeStatus?.loggedIn) return { ok: false, skipped: true, error: 'Claude Code is not signed in.' };
    try {
      makeRoomForRoutine();
      const tabId = d.randomUUID();
      const cwd = r.cwd && fs.existsSync(r.cwd) ? r.cwd : d.currentCwd();
      const tab = d.openTab({ tabId, cwd, mode: r.mode, routineId: r.id, title: `⟳ ${r.name}`, ...routineTools(r, cwd) });
      // Its own model, if it has one: set before the first message starts the process (--model).
      if (r.model && isModel(r.model) && !tab.session.proc) tab.session.model = r.model;
      routineTabs.set(tabId, r.id);
      const userItem = { kind: 'user', text: r.prompt, title: `⟳ ${r.name}`, routine: { id: r.id, name: r.name, reason } };
      d.manager.send(tabId, r.prompt, userItem);
      updateRoutine(r.id, { lastRunAt: Date.now(), lastStatus: null });
      d.stat('routine-run');
      d.send(d.panel, 'tab:opened', { tabId, entry: d.history.get(tabId), items: d.history.load(tabId), background: true });
      return { ok: true, tabId };
    } catch (err) {
      d.notify(`Routine "${r.name}" couldn't start`, err.message, null, { tone: 'problem' });
      return { ok: false, error: err.message };
    }
  }

  // A scheduled routine that comes due while you're at your limit would only
  // fail, and one past the spending guard's ceiling would eat the share you kept
  // for yourself: either way it waits for the reset, and says so the first time.
  function runOrHoldRoutine(r, reason) {
    const w = d.limitWait();
    const usage = d.config.get('lastUsage');
    const saving = !w && guard.holdBeforeStart(d.guardSettings(), usage, Date.now());
    if (!w && !saving) return runRoutine(r, { reason });
    const res = d.holdForReset({ kind: 'routine', routineId: r.id, name: r.name, auto: true });
    if (!res.ok) return { ok: false, skipped: true, error: res.error };
    if (res.added) {
      d.log.info('Routine held for the reset', `${r.name}${saving ? ' (spending guard)' : ''}`);
      const why = w ? `You're at your ${limits.windowName(w.window)} limit.`
        : `Your 5-hour window is at ${usage.fiveHour.pct}%, and you asked to keep ${d.guardSettings().reserve}% for yourself.`;
      d.notify(`Routine "${r.name}" will run after the reset`, `${why} It runs at ${res.atText}.`, () => d.showPanel({ focusInput: false }));
    }
    return { ok: true, held: true };
  }

  /**
   * An `add_routine` from Claude (MCP). A routine spends the user's subscription
   * on a schedule, and anything on this PC can reach the port it came in on, so
   * it is only saved once the user says yes in the isolated confirm window. A
   * routine with the same name is changed in place, keeping its history and
   * whether it's paused.
   */
  async function proposeRoutine(proposed, { modelGiven = true } = {}) {
    if (routineAsking) return { ok: false, error: 'Shellby is already asking the user about a routine. Wait for that answer first.', status: 409 };
    if (Date.now() - routineDeclinedAt < ROUTINE_COOLDOWN_MS) return { ok: false, error: 'The user just turned down a routine. Talk it over with them before proposing another.', status: 429 };
    if (proposed.cwd && !d.isFolder(proposed.cwd)) return { ok: false, error: `That folder doesn't exist: ${proposed.cwd}`, status: 400 };
    const replacing = routines().find(r => sameName(proposed.name, r.name)) || null;
    // Changing one without naming a model keeps the model it runs on, so a quiet
    // re-proposal can't move a routine pinned to a lighter model back to the default.
    const routine = replacing && !modelGiven ? { ...proposed, model: replacing.model || '' } : proposed;
    if (!replacing && routines().length >= MAX_ROUTINES) return { ok: false, error: `The user already has ${MAX_ROUTINES} routines, which is the limit.`, status: 400 };

    routineAsking = true;
    let response;
    try {
      d.wake();
      response = await d.confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '⟳',
        ...crabtools.routineQuestion(routine, { replacing, defaultFolder: d.currentCwd() }),
        buttons: [{ label: replacing ? 'Change it' : 'Add routine', style: 'primary' }, { label: 'No thanks' }], defaultId: 0, cancelId: 1,
      });
    } finally { routineAsking = false; }
    if (response !== 0) {
      routineDeclinedAt = Date.now();
      return { text: crabtools.routineReply(routine, { added: false, replaced: !!replacing }) };
    }

    // The list may have changed while the dialog was up. The yes was to adding,
    // or to changing one particular routine: anything else needs asking again.
    const current = routines().find(r => sameName(r.name, routine.name));
    if ((current?.id || null) !== (replacing?.id || null)) {
      return { ok: false, error: "The user's routines changed while they were deciding, so nothing was saved. Check list_routines and try again.", status: 409 };
    }
    const saved = current
      ? { ...routine, id: current.id, createdAt: current.createdAt, lastRunAt: current.lastRunAt, lastStatus: current.lastStatus, enabled: current.enabled }
      : routine;
    if (!current && routines().length >= MAX_ROUTINES) return { ok: false, error: `The user already has ${MAX_ROUTINES} routines, which is the limit.`, status: 400 };
    saveRoutines(current ? routines().map(r => (r.id === current.id ? saved : r)) : [...routines(), saved]);
    d.sayText(current ? `Updated the "${saved.name}" routine.` : `New routine: ${saved.name}.`, 'mcp');
    return { text: crabtools.routineReply(saved, { added: true, replaced: !!current, next: nextRun(saved, Date.now()) }) };
  }

  /**
   * "Describe it" on the Routines page: Claude fills in the editor from a
   * sentence. Only a draft comes back; the user saves it from the editor, so no
   * confirm window is needed. One at a time, since each is a (small) Claude call.
   */
  async function draftRoutine(text) {
    if (d.config.get('crabOnly')) return { ok: false, error: 'Routines are off in just-the-crab mode.' };
    const checked = routineDraft.checkDescription(text);
    if (!checked.ok) return checked;
    if (routineDrafting) return { ok: false, error: 'Already drafting one. Give it a moment.' };
    routineDrafting = true;
    try {
      const res = await d.runClaudeOnce(routineDraft.draftArgs(checked.text, { home: os.homedir(), defaultFolder: d.currentCwd(), places: routinePlaces() }),
        routineDraft.DRAFT_TIMEOUT_MS, { lean: true });
      if (res.timedOut) return { ok: false, error: 'Claude took too long. Try again.' };
      if (!res.stdout.trim()) {
        d.log.warn('Routine draft failed', lastLines(res.stderr) || res.err?.message);
        return { ok: false, error: 'Claude Code didn\'t answer. Check it\'s signed in, in Settings.' };
      }
      return routineDraft.parseDraft(res.stdout, { folderOk: d.isFolder });
    } finally { routineDrafting = false; }
  }

  /**
   * Build it with Claude, one turn of the routine editor's chat. `runId` is the
   * test run that just finished: its transcript is read here, and only if it was
   * a test of this same saved routine. Nothing is saved or run here.
   */
  async function chatRoutine({ routine, messages, runId } = {}) {
    if (d.config.get('crabOnly')) return { ok: false, error: 'Routines are off in just-the-crab mode.' };
    if (routineDrafting) return { ok: false, error: 'Claude is already working on one. Give it a moment.' };
    const saved = routine && typeof routine.id === 'string' ? routines().find(r => r.id === routine.id) : null;
    const run = runId && saved && routineTests.get(runId) === saved.id ? routineDraft.runBrief(d.history.load(runId)).text : '';
    routineDrafting = true;
    try {
      const res = await routineDraft.chat({ routine, messages, run }, routineClaudeDeps());
      if (res.stderr) d.log.warn('Routine chat failed', lastLines(res.stderr));
      const { stderr: _stderr, ...out } = res;
      return out;
    } finally { routineDrafting = false; }
  }

  const routineClaudeDeps = () => ({
    runClaude: d.runClaudeOnce, folderOk: d.isFolder, allowAutonomous: !!d.config.get('autonomousAcknowledged'),
    context: { home: os.homedir(), defaultFolder: d.currentCwd(), today: new Date().toDateString(), places: routinePlaces() },
  });

  // Where you work, so "my shellby repo" finds a real folder: recent conversations' folders first, then known projects.
  function routinePlaces() {
    const home = path.resolve(os.homedir()).toLowerCase();
    const seen = new Set();
    const out = [];
    const add = (dir, name) => {
      const key = path.resolve(dir).toLowerCase();
      if (seen.has(key) || key === home || !d.isFolder(dir)) return;
      seen.add(key);
      out.push({ name: name || path.basename(dir), path: dir });
    };
    for (const e of d.history.list().slice(0, PLACES_FROM_HISTORY)) if (e.cwd) add(e.cwd);
    for (const p of d.knownProjects()) add(p.key, p.name);
    return out.slice(0, MAX_PLACES);
  }

  /**
   * Fix with Claude, on a routine whose last run failed: Claude reads that run
   * (the newest History entry of this routine, a test run included) and the
   * corrected routine opens in the editor. Nothing is saved here.
   */
  async function repairRoutine(id) {
    if (d.config.get('crabOnly')) return { ok: false, error: 'Routines are off in just-the-crab mode.' };
    const r = routines().find(x => x.id === id);
    if (!r) return { ok: false, error: 'That routine is gone.' };
    const runs = d.history.list().filter(e => e.routineId === id);
    const latest = runs.reduce((a, b) => (!a || (b.createdAt || 0) > (a.createdAt || 0) ? b : a), null);
    const items = latest ? d.history.load(latest.id) : [];
    if (!items.length) return { ok: false, error: 'Shellby no longer has that run\'s conversation, so there\'s nothing to go on. Run it again, then try.' };
    if (routineDrafting) return { ok: false, error: 'Claude is already working on one. Give it a moment.' };
    routineDrafting = true;
    try {
      const res = await routineDraft.repair({ routine: r, brief: routineDraft.runBrief(items).text }, routineClaudeDeps());
      if (res.stderr) d.log.warn('Routine fix failed', lastLines(res.stderr));
      const { stderr: _stderr, ...out } = res;
      return out;
    } finally { routineDrafting = false; }
  }

  // How a test run is going, in the shape the editor's chat follows (wf-chat.js).
  function routineTestView(tabId) {
    const tab = d.manager.tabs.get(tabId);
    if (tab && d.manager.isBusy(tabId)) return { id: tabId, status: 'running', waiting: tab.session?.pending?.size ? { permission: true } : null };
    const { status, error } = routineDraft.runBrief(d.history.load(tabId));
    // No result: its tab was closed, or Claude Code quit partway (that tab is still open, and idle).
    if (status === 'unfinished') return tab ? { id: tabId, status: 'error', error: 'Claude Code stopped before it finished.' } : { id: tabId, status: 'interrupted' };
    return { id: tabId, status, error };
  }

  function testRoutine(id) {
    const r = routines().find(x => x.id === id);
    if (!r) return { ok: false, error: 'Save it first.' };
    const res = runRoutine(r, { reason: 'test' });
    if (!res.ok) return res;
    routineTests.set(res.tabId, r.id);
    while (routineTests.size > MAX_ROUTINE_TESTS) routineTests.delete(routineTests.keys().next().value);
    return { ok: true, runId: res.tabId };
  }

  function startScheduler() {
    scheduler = new Scheduler({ getRoutines: routines });
    scheduler.on('due', r => {
      // A start that fails outright (runRoutine catch) already said so; a skip
      // (signed out, last run still going) would otherwise vanish without a word.
      const res = runOrHoldRoutine(r, 'scheduled');
      if (!res.ok && res.skipped) {
        d.log.info('Routine skipped', `${r.name}: ${res.error}`);
        d.notify(`Routine "${r.name}" didn't run`, res.error, null, { tone: 'problem' });
      }
    });
    scheduler.start();
    // Catch up on slots missed while the PC was off, staggered so they don't stampede.
    const missed = routines().filter(r => missedOnStartup(r, Date.now()));
    missed.forEach((r, i) => setTimeout(() => runOrHoldRoutine(r, 'catch-up'), CATCH_UP_FIRST_MS + i * CATCH_UP_STAGGER_MS));
    // Anything held for a reset that came while Shellby was closed goes now.
    d.scheduleHeld();
    d.syncKeepAwake();
  }

  return {
    chatRoutine, draftRoutine, makeRoomForRoutine, proposeRoutine, repairRoutine, routineTabs,
    routineTestView, routineTests, routines, routinesView, runOrHoldRoutine, runRoutine,
    saveRoutines, startScheduler, testRoutine, updateRoutine,
    /** The scheduler is running (it starts once the CLI check at boot settles). */
    isScheduling: () => !!scheduler,
    stop: () => scheduler?.stop(),
  };
}

module.exports = { createRoutines, MAX_ROUTINES, ROUTINE_TABS_KEPT, ROUTINE_COOLDOWN_MS, MAX_ROUTINE_TESTS };
