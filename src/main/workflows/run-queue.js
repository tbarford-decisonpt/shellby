// Starting runs: triggers, the queue for when too many are going, the engine
// each run gets, and stopping, answering, resuming and reviving them. Mixed
// into WorkflowService (service.js); `this` is the service.
const { randomUUID } = require('crypto');
const fs = require('fs');
const { Engine } = require('./engine');
const { matchEvent } = require('./triggers');

const MAX_ACTIVE = 4;              // top-level runs at once; the rest wait their turn
const MAX_QUEUED = 20;
const MAX_QUEUED_EACH = 5;
const FOLDER_GRACE_MS = 10000;     // a folder workflow ignores its own changes for a moment after it ends

class RunQueue {
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
    const run = { record: rec, workflowId: wf.id, tabs: new Set(), convos: new Map(), engine: null, child: depth > 0, origin: rec.origin || origin || trigger.type, budget };
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
      this.deps.notify(`Workflow failed: ${rec.workflowName}`, (rec.error || 'Click to see what happened.').slice(0, 200), () => this.deps.showWorkflows(rec.id), { tone: 'problem' });
    }
    if (!run.child && ['ok', 'error'].includes(rec.status)) {
      this.event('workflow', { name: rec.workflowName, status: rec.status, runId: rec.id, vars: rec.vars, chain: (rec.trigger?.type === 'workflow' ? (rec.trigger.data?.chain || 0) : 0) + 1 });
    }
    this.drain();
    return rec;
  }

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
}

module.exports = { RunQueue, MAX_ACTIVE, MAX_QUEUED, MAX_QUEUED_EACH, FOLDER_GRACE_MS };
