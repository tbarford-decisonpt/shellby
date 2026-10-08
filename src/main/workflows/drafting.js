// Claude writes and repairs workflows: a sentence -> a draft, a failed run ->
// a fix, and the editor's chat. Nothing here saves or runs anything. Mixed
// into WorkflowService (service.js); `this` is the service.
const { validateWorkflow } = require('./schema');
const draft = require('./draft');

class Drafting {
  async callDraft(prompt, { schema = draft.SCHEMA, parse = draft.parse } = {}) {
    const res = await this.deps.runClaude(draft.args(schema), draft.DRAFT_TIMEOUT_MS, { input: prompt });
    if (res.timedOut) return { ok: false, error: 'Claude took too long. Try again.' };
    if (!res.stdout?.trim()) {
      this.deps.log.warn(`workflow draft failed: ${String(res.stderr || res.err?.message || '').trim().split('\n').slice(-3).join(' ')}`);
      return { ok: false, error: 'Claude Code didn\'t answer. Check it\'s signed in, in Settings.' };
    }
    return parse(res.stdout);
  }

  draftContext() {
    const d = new Date(this.now());
    let mcp = [];
    try { mcp = this.mcpServerList(null).map(x => x.name); } catch { /* the draft does without */ }
    return { home: this.deps.home, defaultFolder: this.deps.currentCwd(), workflows: this.workflows.map(w => w.name), today: d.toDateString(), mcpServers: mcp };
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

  /**
   * Build it with Claude: the editor's workflow and the chat so far -> Claude's
   * reply, maybe a changed (unsaved) workflow, and whether it wants a test run.
   * `runId` is the test run that just finished: its details are read here, and
   * only if it's a run of this same saved workflow. Nothing is saved or run here.
   */
  async chat({ workflow, messages, runId } = {}) {
    const turns = draft.checkTurns(messages);
    if (!turns.ok) return turns;
    const base = workflow && typeof workflow === 'object' && !Array.isArray(workflow) ? workflow : {};
    const saved = typeof base.id === 'string' ? this.get(base.id) : null;
    const rec = typeof runId === 'string' && saved ? this.store.get(runId) : null;
    const run = rec && rec.workflowId === saved.id ? draft.runBrief(rec) : '';
    if (this.drafting) return { ok: false, error: 'Claude is already working on one. Give it a moment.' };
    this.drafting = true;
    try {
      // Hook tokens are secrets: Claude never sees them, and they go back where they were.
      const when = Array.isArray(base.when) ? base.when : [];
      const tokens = when.filter(t => t?.type === 'webhook').map(t => t.token);
      const shown = { ...base, when: when.map(t => (t?.type === 'webhook' ? { type: 'webhook' } : t)) };
      const prompt = draft.chatPrompt(shown, turns.turns, this.draftContext(), run);
      const chatCall = p => this.callDraft(p, { schema: draft.CHAT_SCHEMA, parse: draft.parseChat });
      let r = await chatCall(prompt);
      if (!r.ok || !r.workflow) return r.ok ? { ok: true, reply: r.reply, test: r.test } : r;

      const keep = raw => {
        const out = { ...raw, id: saved ? saved.id : undefined, createdAt: base.createdAt, enabled: base.enabled !== false };
        if (Array.isArray(out.when)) out.when = out.when.map(t => (t?.type === 'webhook' ? { type: 'webhook', token: tokens.shift() } : t));
        if (!out.id) delete out.id;
        return out;
      };
      const check = wf => {
        const v = validateWorkflow(wf, { allowAutonomous: this.deps.allowAutonomous(), now: this.now() });
        if (v.ok && !saved) delete v.workflow.id; // still new to the editor
        return v;
      };
      let wf = keep(r.workflow);
      let v = check(wf);
      if (!v.ok) {
        const again = await chatCall(draft.withFixes(prompt, r.json, v.errors));
        if (again.ok && again.workflow) {
          r = again;
          wf = keep(r.workflow);
          v = check(wf);
        }
      }
      if (v.ok) return { ok: true, reply: r.reply, test: r.test, workflow: v.workflow };
      // Close enough for the editor, which marks the problems; no test until they're fixed.
      if (typeof wf.name === 'string' && Array.isArray(wf.steps)) return { ok: true, reply: r.reply, test: false, workflow: wf, errors: v.errors };
      return { ok: false, error: `Claude's change didn't fit: ${v.errors.slice(0, 3).map(e => e.message).join(' ')}` };
    } finally { this.drafting = false; }
  }
}

module.exports = { Drafting };
