// Workflows, wired to Shellby: where they're kept, what starts them, the real
// effects behind each step, and everything the panel, Claude (MCP), the
// `shellby` command and web hooks can ask of them. main.js builds one of these
// with the few Shellby functions it needs (deps) and forwards events to it.
// See docs/plans/workflows.md.
//
// The service is one object; its larger parts live beside it and are mixed in:
// approvals.js (what's kept and trusted), run-queue.js (starting and queueing
// runs), steps.js (the effects behind steps), drafting.js (Claude writes them).
const path = require('path');
const { validateWorkflow, describeTrigger, capabilities, riskSignature } = require('./schema');
const { RunStore, SecretStore, summary } = require('./store');
const { byWebhook, nextStart, RateLimit, ScheduleTicker, FolderWatch } = require('./triggers');
const { templates } = require('./templates');
const fx = require('./effects');
const { same, clean, mixin } = require('./util');
const { Approvals } = require('./approvals');
const { RunQueue, MAX_ACTIVE } = require('./run-queue');
const { Steps } = require('./steps');
const { Drafting } = require('./drafting');

const MAX_WORKFLOWS = 100;
const PROPOSE_COOLDOWN_MS = 30000; // after a no to Claude's proposal
const MAX_IMPORT = 256 * 1024;
const MAX_HOOK_DATA = 64 * 1024;
const PUSH_MS = 150;
class WorkflowService {
  /**
   * deps: {
   *   config, dataDir, home, manager, maxTabs,
   *   openTab({ tabId, cwd, mode, workflowRunId, title }), closeTab(tabId),
   *   currentCwd(), claudeReady() -> bool, allowAutonomous() -> bool,
   *   confirm(spec) -> Promise<button index>, notify(title, body, onClick, { urgent, tone, action }),
   *   tellPhone(event), say(text), showWorkflows(runId?), toPanel(channel, payload),
   *   runCommand(cwd, command, { timeoutMs, signal }), runClaude(args, timeoutMs, { input }) -> { stdout, timedOut, ... },
   *   makeCopy({ repo, slug }) -> { ok, path, branch, base, repo } (a worktree to work in),
   *   openPullRequest({ folder, title, body, draft, workflow }) -> { ok, url, number, ... },
   *   copy(text), crypto: { available, encrypt, decrypt }, webhookPort() -> number | null,
   *   log: { info, warn }, now(), liveMcp() -> the Toolbox's MCP servers,
   *   fetchImpl?, callMcpTool?(def, tool, args, opts), listMcpTools?(def, opts) (tests)
   * }
   */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || (() => Date.now());
    this.store = new RunStore({ dir: path.join(deps.dataDir, 'runs'), log: m => deps.log.warn(m) });
    this.secrets = new SecretStore({ file: path.join(deps.dataDir, 'secrets.bin'), crypto: deps.crypto, log: m => deps.log.warn(m) });
    this.workflows = [];
    this.broken = [];            // entries that don't validate any more: kept as they were, never run
    this.active = new Map();     // runId -> { record, engine, tabs: Set, tabId, workflowId }
    this.queue = [];             // [{ workflow, trigger, inputs }]
    this.asks = new Map();       // `${runId}:${key}` -> { resolve, choices }
    this.tabRuns = new Map();    // tabId -> runId, for every tab a run has opened
    this.endedAt = new Map();    // workflowId -> when its last run ended (folder grace)
    this.folderBacklog = new Map(); // workflowId -> files that arrived while it was busy
    this.folderTimers = new Map();
    this.rate = new RateLimit();
    this.pushTimers = new Map();
    this.toolReads = new Map();   // server+folder -> a tools/list still being answered
    this.proposing = false;
    this.declinedAt = 0;
    this.frozen = false;
    this.ticker = new ScheduleTicker({
      getWorkflows: () => this.workflows,
      onDue: (wf, _t, slot) => this.trigger(wf, { type: 'schedule', data: { at: new Date(slot).toISOString() } }),
    });
    this.folders = new FolderWatch({
      onFiles: (wf, _t, files) => this.onFolder(wf, files),
      onError: (wf, t, e) => deps.log.warn(`workflow "${wf.name}": can't watch ${t.path}: ${e.message}`),
    });
  }

  // ================================================================ lifecycle

  start() {
    this.workflows = this.loadWorkflows();
    const unfinished = this.store.load();
    this.store.prune();
    // A run that was mid-step when Shellby closed can't know what that step
    // did, so it waits for you to Resume it. One waiting on you, or on a
    // timer, carries on by itself. (A workflow called by another comes back
    // with its caller: resuming the caller runs it again from where it was.)
    let n = 0;
    for (const rec of unfinished) {
      if (rec.status === 'waiting' && !rec.parentRunId) {
        setTimeout(() => this.revive(rec.id), 1500 + (n++) * 1000).unref?.();
      } else {
        rec.status = 'interrupted';
        rec.error = 'Shellby closed while this was running. Resume picks it up from the step it was on.';
        rec.endedAt = this.now();
        this.store.save(rec);
      }
    }
    this.ticker.start();
    this.folders.sync(this.workflows);
    // A watched folder that went away (an unplugged drive) is picked up again when it's back.
    this.resync = setInterval(() => this.folders.sync(this.workflows), 5 * 60 * 1000);
    this.resync.unref?.();
    setTimeout(() => this.event('startup', {}), 15000).unref?.();
  }

  /** Quitting: whatever's running stays "running" on disk and comes back as interrupted. */
  shutdown() {
    clearInterval(this.resync);
    this.ticker.stop();
    this.folders.closeAll();
    this.store.flush();
    this.frozen = true;
    for (const run of this.active.values()) run.engine.stop();
  }

  // loadWorkflows, persist and the approvals: approvals.js.

  get(id) { return this.workflows.find(w => w.id === id) || null; }

  byName(name) { return this.workflows.find(w => same(w.name, name)) || null; }

  ownsTab(tabId) { return this.tabRuns.has(tabId); }

  /** What started a running run ('manual', 'schedule', 'webhook'...), or null. */
  originOf(runId) { return this.active.get(runId)?.origin || null; }

  // ================================================================ views

  workflowView(wf, now = this.now()) {
    return {
      ...wf,
      triggers: wf.when.map(describeTrigger),
      next: nextStart(wf, now),
      running: [...this.active.values()].some(r => r.workflowId === wf.id),
      lastRun: this.store.last(wf.id),
      capabilities: capabilities(wf),
      claudeCanRun: wf.when.some(t => t.type === 'claude'),
    };
  }

  view() {
    const now = this.now();
    return {
      workflows: this.workflows.map(wf => this.workflowView(wf, now)),
      templates: templates({ home: this.deps.home }),
      secrets: this.secrets.names(),
      running: this.active.size,
      webhookPort: this.deps.webhookPort(),
    };
  }

  pushView() {
    this.debounce('view', () => this.deps.toPanel('workflows', this.view()));
  }

  pushRun(rec) {
    this.debounce(rec.id, () => this.deps.toPanel('workflows:run-changed', summary(rec)));
  }

  debounce(key, fn) {
    if (this.pushTimers.has(key)) return;
    const t = setTimeout(() => { this.pushTimers.delete(key); fn(); }, PUSH_MS);
    t.unref?.();
    this.pushTimers.set(key, t);
  }

  // ================================================================ editing

  validate(input) {
    return validateWorkflow(input, { allowAutonomous: this.deps.allowAutonomous(), now: this.now() });
  }

  /**
   * Save from the panel ('panel'), a proposal from Claude ('claude') or one added
   * from a repo's team pack ('team'). Anything that can act unasked is confirmed
   * in the isolated window first: always for Claude's and a team pack's, and for
   * the panel's when what it may do has changed.
   */
  async save(input, { source = 'panel', confirmed = false } = {}) {
    const existing = input && typeof input === 'object' && input.id ? this.get(input.id) : null;
    const r = validateWorkflow({ ...input, createdAt: existing?.createdAt ?? input?.createdAt }, { allowAutonomous: this.deps.allowAutonomous(), now: this.now() });
    if (!r.ok) return { ok: false, errors: r.errors };
    const wf = r.workflow;
    if (this.workflows.some(w => w.id !== wf.id && same(w.name, wf.name))) return { ok: false, errors: [{ path: 'name', message: 'Another workflow already has that name.' }] };
    if (!existing && this.workflows.length >= MAX_WORKFLOWS) return { ok: false, errors: [{ path: '', message: `That's a lot of workflows. Delete some first (limit ${MAX_WORKFLOWS}).` }] };
    const selfLoop = wf.when.find(t => t.type === 'workflow' && same(t.name, wf.name));
    if (selfLoop) return { ok: false, errors: [{ path: 'when', message: 'A workflow can\'t start itself.' }] };

    const risk = riskSignature(wf);
    // confirmed: main has already shown exactly this in a confirm window of its
    // own (a team pack's "Set it all up", with saveDetail's words). Never from the panel.
    const ask = !(confirmed && source === 'team') && (source !== 'panel' || (risk && (risk !== riskSignature(existing) || !this.approved(existing))));
    if (ask) {
      const verdict = await this.confirmSave(wf, existing, source);
      if (verdict === 'too-long') {
        return { ok: false, errors: [{ path: '', message: source === 'team'
          ? 'This workflow is too long to show in full in the confirmation window, so it can\'t be added from the team pack. Paste it on the Automate page (Import) and read it in the editor instead.'
          : 'This workflow is too long to show in full in the confirmation window, so it can\'t be proposed this way. Split it into smaller workflows (a workflow step can run another), or the user can build it on the Automate page.' }] };
      }
      if (verdict !== 'yes') return { ok: false, declined: true, errors: [{ path: '', message: 'Not saved.' }] };
    }
    // The list may have changed while the window was up.
    const now = this.get(wf.id);
    if ((now?.updatedAt ?? null) !== (existing?.updatedAt ?? null)) return { ok: false, errors: [{ path: '', message: 'It changed while you were deciding, so nothing was saved. Try again.' }] };
    const list = existing ? this.workflows.map(w => (w.id === wf.id ? wf : w)) : [...this.workflows, wf];
    this.approve(wf);
    this.persist(list);
    return { ok: true, workflow: wf, view: this.view() };
  }

  // saveDetail, confirmText and confirmSave: approvals.js.

  async remove(id) {
    const wf = this.get(id);
    if (!wf) return this.view();
    for (const run of this.active.values()) if (run.workflowId === id) run.engine.stop();
    this.queue = this.queue.filter(q => q.workflow.id !== id);
    this.persist(this.workflows.filter(w => w.id !== id));
    this.store.removeWorkflow(id);
    this.rate.forget(id);
    return this.view();
  }

  // ================================================================ runs

  // Starting, queueing, stopping, answering and resuming them: run-queue.js.
  // The effects behind their steps: steps.js.

  listRuns(workflowId = null) { return this.store.list(workflowId || null); }

  getRun(id) { return this.store.get(id); }

  // ================================================================ Claude, the CLI, web hooks

  claudeList() {
    return this.workflows.map(wf => {
      const v = this.workflowView(wf);
      return { name: v.name, description: v.description, enabled: v.enabled, triggers: v.triggers, inputs: v.inputs.map(i => ({ name: i.name, label: i.label, required: i.required })), claudeCanRun: v.claudeCanRun, lastRun: v.lastRun ? { status: v.lastRun.status, startedAt: v.lastRun.startedAt } : null };
    });
  }

  /** run_workflow from Claude, or `shellby flow run`: only workflows that allow it. */
  runFromClaude(name, inputs, via = 'claude') {
    const wf = this.byName(name);
    if (!wf) return { ok: false, error: `There's no workflow called “${clean(name).slice(0, 60)}”. Use list_workflows to see them.`, status: 404 };
    if (!wf.when.some(t => t.type === 'claude')) return { ok: false, error: `“${wf.name}” can only be started from Shellby. The user can add the “Claude Code” trigger to allow it.`, status: 403 };
    if (!wf.enabled) return { ok: false, error: `“${wf.name}” is paused.`, status: 409 };
    const r = this.trigger(wf, { type: 'claude', data: { via } }, inputs);
    if (r.ok) return { text: `Started “${wf.name}”. It runs in Shellby; the user sees its progress on the Automate page.` };
    return r.queued ? { text: r.error } : { ok: false, error: r.error, status: 409 };
  }

  /** add_workflow from Claude: one question at a time, a pause after a no. */
  async proposeFromClaude(raw) {
    if (this.proposing) return { ok: false, error: 'Shellby is already asking the user about a workflow. Wait for that answer first.', status: 409 };
    if (this.now() - this.declinedAt < PROPOSE_COOLDOWN_MS) return { ok: false, error: 'The user just turned down a workflow. Talk it over with them before proposing another.', status: 429 };
    const input = { ...raw };
    delete input.id;
    delete input.enabled;
    const replacing = this.byName(input.name);
    if (replacing) {
      input.id = replacing.id;
      input.enabled = replacing.enabled;
      // Keep its web hook address: Claude never sees or sets tokens.
      const tokens = replacing.when.filter(t => t.type === 'webhook').map(t => t.token);
      input.when = Array.isArray(input.when) ? input.when.map(t => (t?.type === 'webhook' ? { type: 'webhook', token: tokens.shift() } : t)) : input.when;
    } else if (Array.isArray(input.when)) {
      input.when = input.when.map(t => (t?.type === 'webhook' ? { type: 'webhook' } : t));
    }
    // Claude never gets Autonomous: only the user's own hand picks it.
    const check = validateWorkflow(input, { allowAutonomous: false, now: this.now() });
    if (!check.ok) return { ok: false, error: `That workflow isn't valid: ${check.errors.slice(0, 8).map(e => `${e.path || 'workflow'}: ${e.message}`).join('; ')}`, status: 400 };
    this.proposing = true;
    let r;
    try { r = await this.save(input, { source: 'claude' }); } finally { this.proposing = false; }
    if (r.declined) {
      this.declinedAt = this.now();
      return { text: `The user decided not to ${replacing ? 'change' : 'add'} the “${input.name}” workflow. Nothing was saved.` };
    }
    if (!r.ok) return { ok: false, error: r.errors.map(e => e.message).join(' '), status: 400 };
    this.deps.say(replacing ? `Updated the “${r.workflow.name}” workflow.` : `New workflow: ${r.workflow.name}.`);
    const next = nextStart(r.workflow, this.now());
    return { text: `${replacing ? 'Changed' : 'Added'} the “${r.workflow.name}” workflow (${r.workflow.when.map(describeTrigger).join('; ') || 'run by hand'}).${next ? ` Next scheduled start: ${new Date(next).toLocaleString()}.` : ''} The user can run, pause, edit or delete it on Shellby's Automate page.` };
  }

  /** POST /v1/flow { hook, data }. */
  webhook(body) {
    const hit = byWebhook(this.workflows, body?.hook);
    if (!hit) return { ok: false, error: 'No workflow has that hook.', status: 404 };
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
    let size;
    try { size = JSON.stringify(data).length; } catch { return { ok: false, error: 'That data can\'t be read.', status: 400 }; }
    if (size > MAX_HOOK_DATA) return { ok: false, error: `Send at most ${MAX_HOOK_DATA / 1024} KB of data.`, status: 413 };
    const inputs = {};
    for (const i of hit.workflow.inputs) if (data[i.name] !== undefined) inputs[i.name] = data[i.name];
    const r = this.trigger(hit.workflow, { type: 'webhook', data }, inputs);
    if (r.ok) return { text: `Started. Run ${r.runId}.` };
    return r.queued ? { text: r.error } : { ok: false, error: r.error, status: 409 };
  }

  // draft, repair and chat (Claude writes and repairs): drafting.js.

  // ================================================================ sharing

  /** Pasted JSON -> an unsaved workflow for the editor (never with an id or a hook token). */
  importText(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Paste a workflow first.' };
    if (text.length > MAX_IMPORT) return { ok: false, error: 'That is too big to be a workflow.' };
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'That isn\'t valid JSON.' }; }
    const raw = parsed && parsed.format === 'shellby-workflow' ? parsed.workflow : parsed;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'That isn\'t a workflow.' };
    const input = { ...raw, enabled: true };
    delete input.id;
    delete input.createdAt;
    if (Array.isArray(input.when)) input.when = input.when.map(t => (t?.type === 'webhook' ? { type: 'webhook' } : t));
    const r = this.validate(input);
    if (!r.ok) return { ok: false, error: `It doesn't fit: ${r.errors.slice(0, 3).map(e => `${e.path || 'workflow'}: ${e.message}`).join('; ')}` };
    delete r.workflow.id;
    // A webhook gets its token when it's saved, not now.
    r.workflow.when = r.workflow.when.map(t => (t.type === 'webhook' ? { type: 'webhook' } : t));
    return { ok: true, workflow: r.workflow };
  }

  async exportText(id) {
    const wf = this.get(id);
    if (!wf) return { ok: false, error: 'That workflow is gone.' };
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = wf;
    const shareable = { ...rest, when: rest.when.map(t => (t.type === 'webhook' ? { type: 'webhook' } : t)) };
    // copy is Electron's writeText, a promise since Electron 44: wait for it to land.
    try { await this.deps.copy(JSON.stringify({ format: 'shellby-workflow', version: 1, workflow: shareable }, null, 2)); } catch {
      return { ok: false, error: "Couldn't copy it: something else is holding the clipboard. Try again." };
    }
    return { ok: true };
  }

  setSecret(name, value) {
    const r = this.secrets.set(name, value);
    return r.ok ? { ok: true, view: this.view() } : r;
  }

  deleteSecret(name) {
    this.secrets.delete(name);
    return this.view();
  }

  // ================================================================ tabs

  /** Something happened in a tab (main.js forwards every item). */
  onTabItem(tabId, item) {
    const runId = this.tabRuns.get(tabId);
    if (!runId) return;
    const run = this.active.get(runId);
    if (!run) return;
    if (item.kind === 'permission' || item.kind === 'decision') {
      run.record.attention = run.engine && run.record.status === 'running' && this.deps.manager.tabs.get(tabId)?.session.pending.size ? { tabId } : null;
      this.pushRun(run.record);
    }
  }

  onTabClosed(tabId) {
    this.tabRuns.delete(tabId);
    fx.tabClosed(tabId);
    for (const run of this.active.values()) {
      for (const [key, id] of run.convos) if (id === tabId) run.convos.delete(key);
      run.tabs.delete(tabId);
    }
  }
}

mixin(WorkflowService, Approvals, RunQueue, Steps, Drafting);

module.exports = { WorkflowService, MAX_ACTIVE, MAX_WORKFLOWS };
