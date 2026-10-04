// Claude's help with routines: Describe it, Fix with Claude, and the editor's
// chat with its dry runs. The prompts and answers are routine-draft.js; this
// makes the calls, keeps them one at a time, and runs the dry runs.
//
// A dry run is the editor's routine (saved or not) run once in Plan mode in a
// background tab: Claude Code looks around and plans but changes nothing, and
// any permission it asks for is refused on the spot, since nobody is watching
// and a test has no business changing things. Its transcript goes back to the
// chat so Claude can tighten the prompt.
//
// deps: {
//   runClaude(args, timeoutMs, { input }) -> { stdout, stderr, timedOut, err }
//   context() -> { home, defaultFolder, places, today }   (routine-draft.js context)
//   folderOk(path), routines(), allowAutonomous(), signedIn()
//   lastRun(routineId) -> transcript items of its latest run, or null
//   loadTranscript(tabId) -> items
//   openTest({ cwd, prompt, title }) -> tabId (throws if it can't)
//   deny(tabId, requestId, message), interrupt(tabId), stopSession(tabId)
//   toPanel(channel, payload), log
//   timer(fn, ms) -> { cancel }
// }
const { validateRoutine } = require('./routines');
const rd = require('./routine-draft');

const MODES = ['ask', 'smart', 'acceptEdits', 'plan', 'autonomous'];
const MAX_TESTS = 10; // finished dry runs remembered, for the chat to read
// Looking around and planning is quick. One still going after this is stuck or wandering.
const DRY_RUN_MAX_MS = 20 * 60 * 1000;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

const DENY_PLAN = 'This is a dry run: the plan is all that was wanted. Stop here and say in a few lines what you found and what you would do.';
const DENY_ANY = "This is a dry run in Plan mode: nothing may be changed and nobody is here to answer. Don't ask again. Carry on without it, and finish by saying what you found and exactly what you would have done.";

class RoutineAssist {
  constructor(deps) {
    this.d = deps;
    this.busy = false;
    this.tests = new Map(); // tabId -> { status: 'running' | 'ok' | 'error' | 'stopped', error }
    this.timers = new Map(); // tabId -> { cancel } for a running dry run's time limit
  }

  async locked(fn) {
    if (this.busy) return { ok: false, error: 'Claude is already working on one. Give it a moment.' };
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  async call(prompt, { schema, model, timeout, parse, opts }) {
    const res = await this.d.runClaude(rd.args(schema, model), timeout, { input: prompt });
    if (res.timedOut) return { ok: false, error: 'Claude took too long. Try again.' };
    if (!res.stdout?.trim()) {
      this.d.log.warn('Routine help failed', String(res.stderr || res.err?.message || '').trim().split('\n').slice(-3).join(' '));
      return { ok: false, error: 'Claude Code didn\'t answer. Check it\'s signed in, in Settings.' };
    }
    return parse(res.stdout, opts);
  }

  // A mode from the panel is only passed on as "unchanged" if the user could have chosen it.
  trustedMode(mode) {
    if (!MODES.includes(mode)) return null;
    return mode === 'autonomous' && !this.d.allowAutonomous() ? null : mode;
  }

  /** Describe it: a sentence -> { ok, draft, workflow: { why } | null }. */
  draft(text) {
    const checked = rd.checkDescription(text);
    if (!checked.ok) return checked;
    return this.locked(() => this.call(rd.draftPrompt(checked.text, this.d.context()), {
      schema: rd.SCHEMA, model: rd.DRAFT_MODEL, timeout: rd.DRAFT_TIMEOUT_MS, parse: rd.parseDraft, opts: { folderOk: this.d.folderOk },
    }));
  }

  /** Fix with Claude: the routine's last (failed) run -> { ok, draft, note } for the editor. */
  repair(id) {
    const r = this.d.routines().find(x => x.id === id);
    if (!r) return { ok: false, error: 'That routine is gone.' };
    const items = this.d.lastRun(id);
    if (!items?.length) return { ok: false, error: 'Shellby no longer has that run\'s conversation, so there\'s nothing to go on. Run it again, then try.' };
    return this.locked(() => this.call(rd.repairPrompt(r, rd.transcriptBrief(items), this.d.context()), {
      schema: rd.REPAIR_SCHEMA, model: rd.CHAT_MODEL, timeout: rd.CHAT_TIMEOUT_MS, parse: rd.parseRepair,
      opts: { folderOk: this.d.folderOk, currentMode: r.mode },
    }));
  }

  /**
   * One turn of the editor's chat -> { ok, reply, test, workflow, routine, problem? }.
   * `runId` is a dry run that just finished; only one of ours is read.
   */
  chat({ routine, messages, runId } = {}) {
    const turns = rd.checkTurns(messages);
    if (!turns.ok) return turns;
    const base = isObj(routine) ? routine : {};
    const t = typeof runId === 'string' ? this.tests.get(runId) : null;
    const run = t && t.status !== 'running' ? rd.transcriptBrief(this.d.loadTranscript(runId)) : '';
    const opts = { folderOk: this.d.folderOk, currentMode: this.trustedMode(base.mode) };
    const how = { schema: rd.CHAT_SCHEMA, model: rd.CHAT_MODEL, timeout: rd.CHAT_TIMEOUT_MS, parse: rd.parseChat, opts };
    return this.locked(async () => {
      const prompt = rd.chatPrompt(base, turns.turns, this.d.context(), run);
      let r = await this.call(prompt, how);
      if (r.ok && r.problem) {
        const again = await this.call(rd.withFixes(prompt, r.problem), how);
        if (again.ok && !again.problem) r = again;
      }
      if (!r.ok) return r;
      return { ok: true, reply: r.reply, test: r.test, workflow: r.workflow, routine: r.draft, ...(r.problem ? { problem: r.problem } : {}) };
    });
  }

  // ---------------------------------------------------------------- dry runs

  /** The editor's routine, run once in Plan mode -> { ok, runId } (the tab's id). */
  test(input) {
    if (!isObj(input)) return { ok: false, error: 'Nothing to run.' };
    if (!this.d.signedIn()) return { ok: false, error: 'Claude Code is not signed in.' };
    if ([...this.tests.values()].some(t => t.status === 'running')) return { ok: false, error: 'A dry run is already going. Give it a moment.' };
    const { routine, errors } = validateRoutine({ name: input.name, prompt: input.prompt, schedule: input.schedule, cwd: input.cwd || null, mode: 'plan' });
    if (!routine) return { ok: false, error: errors.join(' ') };
    if (routine.cwd && !this.d.folderOk(routine.cwd)) return { ok: false, error: `That folder doesn't exist: ${routine.cwd}` };
    let tabId;
    try {
      tabId = this.d.openTest({ cwd: routine.cwd, prompt: routine.prompt, title: `⟳ Dry run: ${routine.name}` });
    } catch (err) {
      return { ok: false, error: `The dry run didn't start: ${err.message}` };
    }
    this.tests.set(tabId, { status: 'running', error: null });
    this.timers.set(tabId, this.d.timer(() => {
      this.d.interrupt(tabId);
      this.finish(tabId, 'stopped', `It was still going after ${DRY_RUN_MAX_MS / 60000} minutes, so Shellby stopped it.`);
    }, DRY_RUN_MAX_MS));
    this.d.toPanel('routines:test-changed', { id: tabId, status: 'running' });
    return { ok: true, runId: tabId };
  }

  prune() {
    const done = [...this.tests.entries()].filter(([, t]) => t.status !== 'running');
    for (const [id] of done.slice(0, Math.max(0, done.length - MAX_TESTS))) this.tests.delete(id);
  }

  isTest(tabId) { return this.tests.has(tabId); }

  getTest(id) {
    const t = this.tests.get(id);
    return t ? { id, status: t.status, error: t.error } : null;
  }

  /**
   * The one way a dry run ends: its status, the panel told, the timer and the
   * idle process gone (nothing more will be said in it). false if it wasn't running.
   */
  finish(tabId, status, error = null) {
    const t = this.tests.get(tabId);
    if (t?.status !== 'running') return false;
    t.status = status;
    t.error = error;
    this.timers.get(tabId)?.cancel();
    this.timers.delete(tabId);
    this.d.toPanel('routines:test-changed', { id: tabId, status, error });
    this.d.stopSession(tabId);
    this.prune();
    return true;
  }

  // Stop ends it here and now, whether or not Claude Code answers the interrupt.
  stopTest(id) {
    if (this.tests.get(id)?.status !== 'running') return false;
    this.d.interrupt(id);
    return this.finish(id, 'stopped');
  }

  /** A permission prompt in one of our dry runs: refused at once. true when it was ours. */
  onPermission(tabId, item) {
    if (this.tests.get(tabId)?.status !== 'running') return false;
    this.d.deny(tabId, item.requestId, item.toolName === 'ExitPlanMode' ? DENY_PLAN : DENY_ANY);
    return true;
  }

  /**
   * A turn ended. true when it ended one of our dry runs, so it gets no
   * "finished" notification, XP or task event. A later turn in that tab (you
   * replied to it) is an ordinary one.
   */
  onResult(tabId, item) {
    return this.finish(tabId, item.interrupted ? 'stopped' : item.ok ? 'ok' : 'error', item.ok ? null : (item.error || null));
  }

  /** Claude Code went away mid-run (session.js says so with an error and no result). */
  onError(tabId, item) {
    this.finish(tabId, 'error', String(item?.text || 'Claude Code stopped.').slice(0, 600));
  }

  /** The tabs changed: a dry run whose tab has gone, however it went, counts as stopped. */
  sweep(isOpen) {
    for (const [id, t] of this.tests) if (t.status === 'running' && !isOpen(id)) this.finish(id, 'stopped');
  }
}

/**
 * The PreToolUse fence on a dry run's session (session.js beforeWork). Plan
 * mode asks before changing things, and those asks are refused, but tools the
 * user pre-approved in Claude Code's settings never ask: this stops those too.
 */
const DRY_RUN_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*';
const dryRunFence = () => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'This is a dry run: Shellby refuses anything that changes files, runs commands or uses outside tools. Say what you would have done instead.',
  },
});

module.exports = { RoutineAssist, DENY_PLAN, DENY_ANY, DRY_RUN_TOOLS, DRY_RUN_MAX_MS, dryRunFence };
