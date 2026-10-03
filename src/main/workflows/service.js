// Workflows, wired to Shellby: where they're kept, what starts them, the real
// effects behind each step, and everything the panel, Claude (MCP), the
// `shellby` command and web hooks can ask of them. main.js builds one of these
// with the few Shellby functions it needs (deps) and forwards events to it.
// See docs/plans/workflows.md.
const path = require('path');
const { randomUUID } = require('crypto');
const { validateWorkflow, describeTrigger, capabilities, riskSignature, riskDetail, walkSteps } = require('./schema');
const { Engine } = require('./engine');
const { RunStore, SecretStore, summary } = require('./store');
const { matchEvent, byWebhook, nextStart, RateLimit, ScheduleTicker, FolderWatch } = require('./triggers');
const { templates } = require('./templates');
const draft = require('./draft');
const crypto = require('crypto');
const fs = require('fs');
const fx = require('./effects');

const MAX_WORKFLOWS = 100;
const MAX_ACTIVE = 4;              // top-level runs at once; the rest wait their turn
const MAX_QUEUED = 20;
const MAX_QUEUED_EACH = 5;
const FOLDER_GRACE_MS = 10000;     // a folder workflow ignores its own changes for a moment after it ends
const PROPOSE_COOLDOWN_MS = 30000; // after a no to Claude's proposal
const MAX_IMPORT = 256 * 1024;
const MAX_HOOK_DATA = 64 * 1024;
const MAX_CONFIRM_DETAIL = 12000;  // what the confirmation window shows in full
const PUSH_MS = 150;
const MODE_NAMES = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ').trim();

class WorkflowService {
  /**
   * deps: {
   *   config, dataDir, home, manager, maxTabs,
   *   openTab({ tabId, cwd, mode, workflowRunId, title }), closeTab(tabId),
   *   currentCwd(), claudeReady() -> bool, allowAutonomous() -> bool,
   *   confirm(spec) -> Promise<button index>, notify(title, body, onClick, { urgent }),
   *   tellPhone(event), say(text), showWorkflows(runId?), toPanel(channel, payload),
   *   runCommand(cwd, command, { timeoutMs, signal }), runClaude(args, timeoutMs, { input }) -> { stdout, timedOut, ... },
   *   copy(text), crypto: { available, encrypt, decrypt }, webhookPort() -> number | null,
   *   log: { info, warn }, now(), fetchImpl?
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

  /**
   * What's in settings.json, checked again: it's a file anything on this PC
   * can write. A workflow that no longer validates is kept as it was (never
   * run, never lost). One that can act unasked must carry the approval Shellby
   * signed when you said yes to it; without one it's paused until you save it
   * again, which asks.
   */
  loadWorkflows() {
    const raw = this.deps.config.get('workflows');
    const out = [];
    this.broken = [];
    for (const w of Array.isArray(raw) ? raw : []) {
      const r = validateWorkflow(w, { allowAutonomous: this.deps.allowAutonomous(), now: w?.updatedAt || this.now() });
      if (!r.ok) {
        this.broken.push(w);
        this.deps.log.warn(`workflow "${clean(w?.name).slice(0, 60)}" not loaded: ${r.errors.map(e => e.message).join('; ')}`);
        continue;
      }
      const wf = { ...r.workflow, updatedAt: w.updatedAt || r.workflow.updatedAt };
      if (wf.enabled && !this.approved(wf)) {
        wf.enabled = false;
        wf.needsApproval = true;
        this.deps.log.warn(`workflow "${wf.name}" paused: what it may do was never approved here`);
      }
      out.push(wf);
    }
    return out;
  }

  persist(list) {
    this.workflows = list;
    this.deps.config.set({ workflows: [...list.map(({ needsApproval: _flag, ...w }) => w), ...this.broken] });
    this.folders.sync(list);
    this.pushView();
  }

  // ---- approvals: an HMAC of each workflow's risk signature, under a key
  // kept encrypted by Windows. A risky workflow written into settings.json by
  // anything other than Shellby's own Save has no valid one.
  approvalKey() {
    if (this.key !== undefined) return this.key;
    const file = path.join(this.deps.dataDir, 'approval.key');
    this.key = null;
    try {
      if (!this.deps.crypto.available()) return this.key;
      if (fs.existsSync(file)) this.key = Buffer.from(this.deps.crypto.decrypt(fs.readFileSync(file)), 'hex');
      else {
        const key = crypto.randomBytes(32);
        fs.mkdirSync(this.deps.dataDir, { recursive: true });
        fs.writeFileSync(file, this.deps.crypto.encrypt(key.toString('hex')));
        this.key = key;
      }
    } catch (e) {
      this.deps.log.warn(`workflow approvals unavailable: ${e.message}`);
    }
    return this.key;
  }

  sign(wf) {
    const key = this.approvalKey();
    return key ? crypto.createHmac('sha256', key).update(`${wf.id}\n${riskSignature(wf)}`).digest('hex') : null;
  }

  approved(wf) {
    if (!riskSignature(wf)) return true;
    const want = this.sign(wf);
    const have = (this.deps.config.get('workflowApprovals') || {})[wf.id];
    // No key (Windows' encrypted storage is unavailable): nothing can be
    // checked, so nothing that acts unasked is trusted. It fails closed.
    if (!want) return false;
    return typeof have === 'string' && have.length === want.length && crypto.timingSafeEqual(Buffer.from(have), Buffer.from(want));
  }

  approve(wf) {
    const all = { ...(this.deps.config.get('workflowApprovals') || {}) };
    const sig = riskSignature(wf) ? this.sign(wf) : null;
    if (sig) all[wf.id] = sig; else delete all[wf.id];
    for (const id of Object.keys(all)) if (id !== wf.id && !this.workflows.some(w => w.id === id)) delete all[id];
    this.deps.config.set({ workflowApprovals: all });
  }

  get(id) { return this.workflows.find(w => w.id === id) || null; }

  byName(name) { return this.workflows.find(w => same(w.name, name)) || null; }

  ownsTab(tabId) { return this.tabRuns.has(tabId); }

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
   * Save from the panel ('panel') or a proposal from Claude ('claude'). Anything
   * that can act unasked is confirmed in the isolated window first: always for
   * Claude's, and for the panel's when what it may do has changed.
   */
  async save(input, { source = 'panel' } = {}) {
    const existing = input && typeof input === 'object' && input.id ? this.get(input.id) : null;
    const r = validateWorkflow({ ...input, createdAt: existing?.createdAt ?? input?.createdAt }, { allowAutonomous: this.deps.allowAutonomous(), now: this.now() });
    if (!r.ok) return { ok: false, errors: r.errors };
    const wf = r.workflow;
    if (this.workflows.some(w => w.id !== wf.id && same(w.name, wf.name))) return { ok: false, errors: [{ path: 'name', message: 'Another workflow already has that name.' }] };
    if (!existing && this.workflows.length >= MAX_WORKFLOWS) return { ok: false, errors: [{ path: '', message: `That's a lot of workflows. Delete some first (limit ${MAX_WORKFLOWS}).` }] };
    const selfLoop = wf.when.find(t => t.type === 'workflow' && same(t.name, wf.name));
    if (selfLoop) return { ok: false, errors: [{ path: 'when', message: 'A workflow can\'t start itself.' }] };

    const risk = riskSignature(wf);
    const ask = source !== 'panel' || (risk && (risk !== riskSignature(existing) || !this.approved(existing)));
    if (ask) {
      const verdict = await this.confirmSave(wf, existing, source);
      if (verdict === 'too-long') return { ok: false, errors: [{ path: '', message: 'This workflow is too long to show in full in the confirmation window, so it can\'t be proposed this way. Split it into smaller workflows (a workflow step can run another), or the user can build it on the Automate page.' }] };
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

  async confirmSave(wf, existing, source) {
    const auto = JSON.stringify(wf.steps).includes('"mode":"autonomous"');
    const triggers = wf.when.length ? wf.when.map(describeTrigger) : ['Only when you run it'];
    const steps = [];
    walkSteps(wf.steps, (s, _at, scope) => steps.push(`${'  '.repeat(scope.length)}${s.label || s.id} (${s.type}${s.mode ? `, ${MODE_NAMES[s.mode]}` : ''})`));
    const risky = riskDetail(wf);
    const who = source === 'claude' ? (existing ? 'Claude wants to change' : 'Claude wants to add') : 'Save';
    const caps = capabilities(wf);
    const detail = [
      `Starts: ${triggers.join('; ')}`,
      caps.length ? `\nWithout asking first, it can:\n${caps.map(c => `• ${c}`).join('\n')}` : '',
      `\nSteps:\n${steps.join('\n')}`,
      risky ? `\nIn full:\n\n${risky}` : '\nIt only looks and reports, or asks you before it acts.',
    ].filter(Boolean).join('\n');
    // A proposal too long to show in full is refused, never shortened: the
    // part left off is the part that could hide something.
    if (detail.length > MAX_CONFIRM_DETAIL && source !== 'panel') return 'too-long';
    const answer = await this.deps.confirm({
      icon: '⚡', danger: auto,
      title: existing ? 'Change a workflow?' : 'Add a workflow?',
      message: `${who} "${wf.name}".`,
      detail: detail.length > MAX_CONFIRM_DETAIL ? `${detail.slice(0, MAX_CONFIRM_DETAIL)}\n\n… it goes on: read the rest in the editor before saving.` : detail,
      note: 'Claude steps run on your Claude subscription. You can pause, edit or delete it on the Automate page.',
      buttons: [{ label: existing ? 'Save changes' : 'Add workflow', style: auto ? 'danger' : 'primary' }, { label: 'Cancel' }],
      defaultId: 1, cancelId: 1,
    });
    return answer === 0 ? 'yes' : 'no';
  }

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

  // ================================================================ starting runs

  /** Run by hand from the panel. */
  runManual(id, inputs = {}) {
    const wf = this.get(id);
    if (!wf) return { ok: false, error: 'That workflow is gone.' };
    return this.begin(wf, { type: 'manual', data: {} }, inputs, { manual: true });
  }

  /** A trigger fired: enabled workflows only, rate-limited, inputs from defaults. */
  trigger(wf, trigger, inputs = {}) {
    if (!wf.enabled) return { ok: false, error: `“${wf.name}” is paused.` };
    if (wf.concurrency !== 'queue' && this.isRunning(wf.id)) return { ok: false, error: `“${wf.name}” is already running.` };
    if (!this.rate.allow(wf.id, this.now())) {
      this.persist(this.workflows.map(w => (w.id === wf.id ? { ...w, enabled: false } : w)));
      this.deps.notify(`Paused “${wf.name}”`, 'It started more than 60 times in an hour, so Shellby paused it. Check its triggers on the Automate page.', () => this.deps.showWorkflows(), { urgent: true });
      return { ok: false, error: 'It started too often, so it was paused.' };
    }
    const r = this.begin(wf, trigger, inputs, {});
    if (!r.ok && !r.queued) this.deps.log.info(`workflow "${wf.name}" not started: ${r.error}`);
    return r;
  }

  event(type, data) {
    for (const { workflow } of matchEvent(this.workflows, type, data)) this.trigger(workflow, { type, data });
  }

  // Files that arrive while the workflow is busy (or just after) wait for it
  // to finish, then start it once, if they're still there.
  onFolder(wf, files) {
    const waiting = new Set([...(this.folderBacklog.get(wf.id) || []), ...files]);
    const wait = this.isRunning(wf.id) ? FOLDER_GRACE_MS : FOLDER_GRACE_MS - (this.now() - (this.endedAt.get(wf.id) || 0));
    if (wait > 0) {
      this.folderBacklog.set(wf.id, [...waiting].slice(0, 200));
      clearTimeout(this.folderTimers.get(wf.id));
      const t = setTimeout(() => {
        this.folderTimers.delete(wf.id);
        const left = (this.folderBacklog.get(wf.id) || []).filter(f => fs.existsSync(f));
        this.folderBacklog.delete(wf.id);
        const current = this.get(wf.id);
        if (left.length && current) this.onFolder(current, left);
      }, Math.max(wait, 1000));
      t.unref?.();
      this.folderTimers.set(wf.id, t);
      return;
    }
    const folder = (wf.when.find(t => t.type === 'folder') || {}).path;
    this.trigger(wf, { type: 'folder', data: { folder, files: [...waiting] } });
  }

  isRunning(workflowId) { return [...this.active.values()].some(r => r.workflowId === workflowId && !r.child); }

  // Runs that hold a slot: not ones waiting on you or a timer, and not workflows called by another.
  busyCount() { return [...this.active.values()].filter(r => !r.child && r.record.status !== 'waiting').length; }

  resolveInputs(wf, raw) {
    const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const i of wf.inputs) {
      const v = Object.prototype.hasOwnProperty.call(given, i.name) ? given[i.name] : undefined;
      const text = v === undefined || v === null || v === '' ? i.default : typeof v === 'string' ? v : JSON.stringify(v);
      if (i.required && !text) return { ok: false, error: `“${i.label}” is needed to run it.` };
      out[i.name] = String(text).slice(0, 2000);
    }
    return { ok: true, inputs: out };
  }

  /**
   * Start a top-level run now, queue it, or say why not.
   * -> { ok: true, runId } | { ok: false, queued?: true, error }
   */
  begin(wf, trigger, rawInputs, { manual = false } = {}) {
    if (this.deps.isOff?.()) return { ok: false, error: 'Workflows are off in just-the-crab mode.' };
    const inputs = this.resolveInputs(wf, rawInputs);
    if (!inputs.ok) return inputs;
    if (this.isRunning(wf.id)) {
      if (wf.concurrency !== 'queue' || manual) return { ok: false, error: `“${wf.name}” is already running.` };
      return this.enqueue(wf, trigger, inputs.inputs);
    }
    if (this.busyCount() >= MAX_ACTIVE) return this.enqueue(wf, trigger, inputs.inputs);
    const run = this.launch(wf, trigger, inputs.inputs, { origin: trigger.type });
    return { ok: true, runId: run.record.id };
  }

  enqueue(workflow, trigger, inputs) {
    if (this.queue.length >= MAX_QUEUED || this.queue.filter(q => q.workflow.id === workflow.id).length >= MAX_QUEUED_EACH) {
      return { ok: false, error: 'Too many runs are waiting already.' };
    }
    this.queue.push({ workflow, trigger, inputs });
    return { ok: false, queued: true, error: `Queued: “${workflow.name}” starts when a run finishes.` };
  }

  drain() {
    // Paused or deleted since it was queued: it doesn't run.
    this.queue = this.queue.filter(q => this.get(q.workflow.id)?.enabled);
    while (this.busyCount() < MAX_ACTIVE && this.queue.length) {
      const i = this.queue.findIndex(q => !this.isRunning(q.workflow.id));
      if (i < 0) return;
      const [next] = this.queue.splice(i, 1);
      this.launch(this.get(next.workflow.id), next.trigger, next.inputs, { origin: next.trigger.type });
    }
  }

  /** Create the record and engine, and set it going. Returns the run at once. */
  launch(wf, trigger, inputs, { depth = 0, parentRunId = null, record = null, origin = null, budget = { executions: 0 } } = {}) {
    const rec = record || {
      id: `run-${randomUUID()}`, workflowId: wf.id, workflowName: wf.name,
      trigger: { type: trigger.type, data: trigger.data ?? {} }, inputs,
      status: 'running', startedAt: this.now(), endedAt: null, error: null,
      steps: {}, order: [], vars: {}, depth, parentRunId, origin: origin || trigger.type,
    };
    // Never the definition itself: a run only ever runs a workflow from the checked list.
    delete rec.definition;
    const run = { record: rec, workflowId: wf.id, tabs: new Set(), tabId: null, engine: null, child: depth > 0, origin: rec.origin || origin || trigger.type, budget };
    run.engine = new Engine({
      workflow: wf, record: rec, effects: this.effectsFor(run), secrets: this.secrets.all(),
      onChange: r => { if (!this.frozen) { this.store.save(r); this.pushRun(r); } },
      now: this.now, depth, budget,
    });
    this.active.set(rec.id, run);
    this.pushView();
    run.done = run.engine.run()
      .catch(e => { this.deps.log.warn(`workflow run crashed: ${e.message}`); rec.status = 'error'; rec.error = e.message; return rec; })
      .then(final => this.finish(run, final));
    return run;
  }

  finish(run, rec) {
    this.active.delete(rec.id);
    this.endedAt.set(run.workflowId, this.now());
    if (this.frozen) return rec;
    // Its workflow was deleted while it ran (which is what stopped it): no record.
    if (!this.get(run.workflowId)) {
      this.store.remove(rec.id);
      this.pushView();
      this.drain();
      return rec;
    }
    this.store.save(rec);
    this.store.flushOne(rec.id);
    this.store.prune();
    this.pushRun(rec);
    this.pushView();
    // Their processes stop (a reply in the tab picks the conversation up again).
    for (const tabId of run.tabs) {
      const tab = this.deps.manager.tabs.get(tabId);
      if (tab && !tab.session.busy) tab.session.stop().catch(() => {});
    }
    if (!run.child && rec.status === 'error') {
      this.deps.notify(`Workflow failed: ${rec.workflowName}`, (rec.error || 'Click to see what happened.').slice(0, 200), () => this.deps.showWorkflows(rec.id));
    }
    if (!run.child && ['ok', 'error'].includes(rec.status)) {
      this.event('workflow', { name: rec.workflowName, status: rec.status, runId: rec.id, vars: rec.vars, chain: (rec.trigger?.type === 'workflow' ? (rec.trigger.data?.chain || 0) : 0) + 1 });
    }
    this.drain();
    return rec;
  }

  // ================================================================ runs

  listRuns(workflowId = null) { return this.store.list(workflowId || null); }

  getRun(id) { return this.store.get(id); }

  stopRun(id) {
    const run = this.active.get(id);
    if (!run) return { ok: false, error: 'That run isn\'t going.' };
    run.engine.stop();
    return { ok: true };
  }

  async answer(runId, key, choice) {
    let a = this.asks.get(`${runId}:${key}`);
    // Shellby has just started and this run hasn't come back yet: bring it back now.
    if (!a && !this.active.has(runId) && this.store.get(runId)?.status === 'waiting') {
      this.revive(runId);
      for (let i = 0; i < 40 && !a; i++) { await new Promise(r => setTimeout(r, 50)); a = this.asks.get(`${runId}:${key}`); }
    }
    if (!a) return { ok: false, error: 'That question has already been answered.' };
    if (!a.choices.includes(choice)) return { ok: false, error: 'That isn\'t one of the choices.' };
    this.asks.delete(`${runId}:${key}`);
    a.resolve(choice);
    return { ok: true };
  }

  /** Retry from the failed step: keep what finished, replay the rest. */
  resumeRun(id) {
    if (this.active.has(id)) return { ok: false, error: 'It\'s still going.' };
    const rec = this.store.get(id);
    if (!rec || !['error', 'interrupted', 'stopped'].includes(rec.status)) return { ok: false, error: 'Only a run that failed or was stopped can be resumed.' };
    if (rec.parentRunId) return { ok: false, error: 'Resume the workflow that called this one instead.' };
    const wf = this.get(rec.workflowId);
    if (!wf) return { ok: false, error: 'That workflow is gone.' };
    if (!wf.enabled && wf.needsApproval) return { ok: false, error: 'Save it again first: what it may do was never approved here.' };
    if (this.isRunning(wf.id)) return { ok: false, error: `“${wf.name}” is already running.` };
    for (const [key, s] of Object.entries(rec.steps || {})) {
      // An If that chose its branch keeps it; a failure it was told to carry on past stays done.
      if (s.type === 'if' && (s.output?.branch === 'then' || s.output?.branch === 'else')) { s.status = 'ok'; continue; }
      if (s.status !== 'ok' && s.status !== 'skipped' && !(s.status === 'error' && s.tolerated)) delete rec.steps[key];
    }
    rec.order = (rec.order || []).filter(k => rec.steps[k]);
    this.launch(wf, rec.trigger, rec.inputs, { record: rec, origin: rec.origin });
    return { ok: true, runId: rec.id };
  }

  /** A run that was waiting when Shellby closed carries on. */
  revive(id) {
    const rec = this.store.get(id);
    if (!rec || rec.status !== 'waiting' || this.active.has(id)) return;
    const wf = this.get(rec.workflowId);
    if (!wf || (wf.needsApproval && !wf.enabled)) {
      rec.status = 'interrupted';
      rec.error = 'Its workflow was changed or removed while Shellby was closed.';
      rec.endedAt = this.now();
      this.store.save(rec);
      return;
    }
    this.launch(wf, rec.trigger, rec.inputs, { record: rec, depth: rec.depth || 0, parentRunId: rec.parentRunId || null, origin: rec.origin });
  }

  // ================================================================ effects

  effectsFor(run) {
    const d = this.deps;
    return {
      claude: args => this.claudeStep(run, args),
      run: ({ command, env, cwd, timeoutMs, signal }) => d.runCommand(cwd || d.currentCwd(), command, { timeoutMs, signal, env, maxCommand: 12000 }),
      http: args => fx.http({ ...args, fetchImpl: d.fetchImpl || fetch, blockedPorts: [d.webhookPort()].filter(Boolean) }),
      ask: args => this.askStep(run, args),
      tell: args => this.tellStep(run, args),
      readFile: (p, signal) => fx.readFile(p, signal),
      writeFile: (p, content, opts) => fx.writeFile(p, content, { ...opts, forbidden: d.forbiddenDirs?.() || [] }),
      runWorkflow: args => this.childRun(run, args),
      sleep: (ms, signal) => fx.sleep(ms, signal),
    };
  }

  async claudeStep(run, { prompt, followUp, tabId: replyTo, mode, model, cwd, fresh, label, workflow, signal, onTab }) {
    const d = this.deps;
    if (!d.claudeReady()) throw new Error('Claude Code isn\'t set up and signed in. Set it up in Settings first.');
    const folder = cwd || d.currentCwd();
    const shared = run.tabId && d.manager.tabs.has(run.tabId) ? d.manager.tabs.get(run.tabId) : null;
    // A follow-up ("you forgot the JSON") goes to the conversation that answered.
    if (followUp) {
      const own = replyTo && d.manager.tabs.get(replyTo);
      if (!own) throw new Error('Its conversation was closed before it finished.');
      return fx.claudeTurn(d.manager, own.id, prompt, { kind: 'user', text: prompt, title: `⚡ ${workflow}`, workflow: { runId: run.record.id, step: label } }, signal);
    }
    // One conversation per run, unless a step wants a fresh one or works in another folder.
    let tab = !fresh && shared && path.resolve(shared.session.cwd) === path.resolve(folder) ? shared : null;
    if (!tab) {
      this.makeRoom();
      const tabId = randomUUID();
      tab = d.openTab({ tabId, cwd: folder, mode, workflowRunId: run.record.id, title: `⚡ ${workflow}` });
      run.tabs.add(tabId);
      this.tabRuns.set(tabId, run.record.id);
      if (!fresh && !shared) run.tabId = tabId;
      d.toPanel('tab:opened', { tabId, entry: null, items: [], background: true });
    }
    onTab(tab.id);
    if (tab.session.mode !== mode) tab.session.setMode(mode);
    if (model && !tab.session.proc) tab.session.model = model;
    const userItem = { kind: 'user', text: prompt, title: `⚡ ${workflow}`, workflow: { runId: run.record.id, step: label } };
    return fx.claudeTurn(d.manager, tab.id, prompt, userItem, signal);
  }

  // A workflow needs a free conversation slot: the oldest idle tab a finished
  // run left behind makes way. Yours are never closed for it.
  makeRoom() {
    const m = this.deps.manager;
    if (m.tabs.size < this.deps.maxTabs) return;
    // An idle tab of a finished run first; then an idle extra one (a fresh
    // conversation) of a run still going, never the one it's sharing.
    const idle = id => this.tabRuns.has(id) && !m.isBusy(id) && !m.tabs.get(id)?.session.pending?.size;
    const shared = new Set([...this.active.values()].map(r => r.tabId).filter(Boolean));
    const spare = [...m.tabs.keys()].find(id => idle(id) && !this.active.has(this.tabRuns.get(id)))
      || [...m.tabs.keys()].find(id => idle(id) && !shared.has(id));
    if (!spare) throw new Error(`All ${this.deps.maxTabs} conversations are open. Close one so the workflow can start Claude.`);
    this.deps.closeTab(spare);
    this.tabRuns.delete(spare);
  }

  askStep(run, { key, question, choices, workflow, signal }) {
    const id = `${run.record.id}:${key}`;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(fx.abortError()); return; }
      this.asks.set(id, { resolve, choices });
      signal?.addEventListener('abort', () => { this.asks.delete(id); reject(fx.abortError()); }, { once: true });
      this.deps.notify(`${workflow} needs you`, question.slice(0, 200), () => this.deps.showWorkflows(run.record.id), { urgent: true });
      this.deps.tellPhone({ kind: 'asking', project: workflow, message: question, deskOnly: 'Answer it on the Automate page.' });
      this.pushView();
    });
  }

  async tellStep(run, { to, title, text, path: file, workflow }) {
    const d = this.deps;
    if (to === 'notification') d.notify(title.slice(0, 80), text.slice(0, 250), () => d.showWorkflows(run.record.id));
    else if (to === 'phone') d.tellPhone({ kind: 'workflow', project: workflow, title, body: text });
    else if (to === 'crab') d.say(clean(text).slice(0, 140));
    else if (to === 'file') await fx.writeFile(file, `${text}\n`, { append: true, forbidden: d.forbiddenDirs?.() || [] });
  }

  async childRun(parent, { name, inputs, depth, signal }) {
    const wf = this.byName(name);
    if (!wf) throw new Error(`There's no workflow called “${name}”.`);
    if (!wf.enabled) throw new Error(`“${wf.name}” is paused.`);
    if (parent.origin === 'claude' && !wf.when.some(t => t.type === 'claude')) {
      throw new Error(`Claude Code started this run, and “${wf.name}” doesn't allow being started by Claude Code. Add the Claude Code trigger to it if it should.`);
    }
    const ins = this.resolveInputs(wf, inputs);
    if (!ins.ok) throw new Error(ins.error);
    const child = this.launch(wf, { type: 'workflow', data: { name: parent.record.workflowName, runId: parent.record.id } }, ins.inputs, { depth, parentRunId: parent.record.id, origin: parent.origin, budget: parent.budget });
    const onAbort = () => child.engine.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const rec = await child.done;
      return { status: rec.status, vars: rec.vars, runId: rec.id, error: rec.error };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

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

  // ================================================================ Claude writes and repairs

  async callDraft(prompt) {
    const res = await this.deps.runClaude(draft.args(), draft.DRAFT_TIMEOUT_MS, { input: prompt });
    if (res.timedOut) return { ok: false, error: 'Claude took too long. Try again.' };
    if (!res.stdout?.trim()) {
      this.deps.log.warn(`workflow draft failed: ${String(res.stderr || res.err?.message || '').trim().split('\n').slice(-3).join(' ')}`);
      return { ok: false, error: 'Claude Code didn\'t answer. Check it\'s signed in, in Settings.' };
    }
    return draft.parse(res.stdout);
  }

  draftContext() {
    const d = new Date(this.now());
    return { home: this.deps.home, defaultFolder: this.deps.currentCwd(), workflows: this.workflows.map(w => w.name), today: d.toDateString() };
  }

  /** Describe it: a sentence -> an unsaved workflow for the editor. One try to fix a draft that doesn't validate. */
  async draft(text) {
    const checked = draft.checkDescription(text);
    if (!checked.ok) return checked;
    if (this.drafting) return { ok: false, error: 'Already drafting one. Give it a moment.' };
    this.drafting = true;
    try {
      const ctx = this.draftContext();
      let r = await this.callDraft(draft.draftPrompt(checked.text, ctx));
      if (!r.ok) return r;
      let v = this.validateDraft(r.workflow);
      if (!v.ok) {
        const again = await this.callDraft(draft.fixPrompt(checked.text, r.json, v.errors, ctx));
        if (again.ok) { r = again; v = this.validateDraft(r.workflow); }
      }
      if (v.ok) return { ok: true, workflow: v.workflow, note: r.note };
      // Close enough to open in the editor, where the problems show beside the fields.
      if (typeof r.workflow.name === 'string' && Array.isArray(r.workflow.steps)) return { ok: true, workflow: r.workflow, note: r.note, errors: v.errors };
      return { ok: false, error: `Claude's draft didn't fit: ${v.errors.slice(0, 3).map(e => e.message).join(' ')}` };
    } finally { this.drafting = false; }
  }

  validateDraft(raw) {
    const input = { ...raw };
    delete input.id;
    if (Array.isArray(input.when)) input.when = input.when.map(t => (t?.type === 'webhook' ? { type: 'webhook' } : t));
    const r = validateWorkflow(input, { allowAutonomous: false, now: this.now() });
    if (r.ok) delete r.workflow.id; // the editor treats it as new
    return r;
  }

  /** Fix with Claude: a failed run -> a corrected workflow for the editor, same id. */
  async repair(runId) {
    const rec = this.store.get(runId);
    if (!rec) return { ok: false, error: 'That run is gone.' };
    const wf = this.get(rec.workflowId);
    if (!wf) return { ok: false, error: 'That workflow is gone.' };
    if (this.drafting) return { ok: false, error: 'Already working on one. Give it a moment.' };
    this.drafting = true;
    try {
      const tokens = wf.when.filter(t => t.type === 'webhook').map(t => t.token);
      const shown = { ...wf, when: wf.when.map(t => (t.type === 'webhook' ? { type: 'webhook' } : t)) };
      const r = await this.callDraft(draft.repairPrompt(shown, rec, this.draftContext()));
      if (!r.ok) return r;
      const fixed = { ...r.workflow, id: wf.id, createdAt: wf.createdAt, enabled: wf.enabled };
      if (Array.isArray(fixed.when)) fixed.when = fixed.when.map(t => (t?.type === 'webhook' ? { type: 'webhook', token: tokens.shift() } : t));
      const v = validateWorkflow(fixed, { allowAutonomous: this.deps.allowAutonomous(), now: this.now() });
      if (v.ok) return { ok: true, workflow: v.workflow, note: r.note };
      if (typeof fixed.name === 'string' && Array.isArray(fixed.steps)) return { ok: true, workflow: fixed, note: r.note, errors: v.errors };
      return { ok: false, error: `Claude's fix didn't fit: ${v.errors.slice(0, 3).map(e => e.message).join(' ')}` };
    } finally { this.drafting = false; }
  }

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

  exportText(id) {
    const wf = this.get(id);
    if (!wf) return { ok: false, error: 'That workflow is gone.' };
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = wf;
    const shareable = { ...rest, when: rest.when.map(t => (t.type === 'webhook' ? { type: 'webhook' } : t)) };
    this.deps.copy(JSON.stringify({ format: 'shellby-workflow', version: 1, workflow: shareable }, null, 2));
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
      if (run.tabId === tabId) run.tabId = null;
      run.tabs.delete(tabId);
    }
  }
}

module.exports = { WorkflowService, MAX_ACTIVE, MAX_WORKFLOWS };
