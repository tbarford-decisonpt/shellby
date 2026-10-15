'use strict';

// ClaudeSession's side of the control protocol once a process runs: answering
// permission prompts and hooks, interrupting, steering, and Shellby's own
// requests. Mixed into its prototype by session/index.js.

const { randomUUID } = require('crypto');
const { CLI_MODE } = require('../config');
const crabmcp = require('../crabmcp');
const todos = require('../../renderer/shared/todos');
const { EFFORTS } = require('../cli-contract');

const DENY_MESSAGE = 'The user declined this action in Shellby. Ask them how they would like to proceed.';
// How long Shellby waits for the CLI to answer one of its own control requests.
const REQUEST_TIMEOUT_MS = 15000;
// How long Stop gives the CLI to wind down before it's killed.
const INTERRUPT_KILL_MS = 8000;

const control = {
  // decision: 'allow' | 'always' | 'deny'. answers: AskUserQuestion's
  // { [question text]: chosen label(s) or the user's own words }. via: 'phone'
  // when it was answered from a notification (channels/replies.js), 'deck' from a Stream
  // Deck key (deck.js), so the card says so. afterPlan: the mode an approved
  // plan's work goes on in (a note's Plan, sessions.js), else Claude Code's default.
  respond(requestId, decision, message, answers, via, afterPlan = null) {
    const item = this.pending.get(requestId);
    if (!item) return false;
    this.pending.delete(requestId);
    let response;
    if (decision === 'deny') {
      response = { behavior: 'deny', message: message || DENY_MESSAGE };
    } else {
      response = { behavior: 'allow', updatedInput: item.input };
      // Claude reads the user's choices from updatedInput.answers (checked against the real CLI).
      if (item.toolName === 'AskUserQuestion' && answers) {
        const asked = new Set((item.input?.questions || []).map(q => q?.question));
        const clean = {};
        for (const [q, a] of Object.entries(answers)) if (asked.has(q) && typeof a === 'string' && a.trim()) clean[q] = a.trim().slice(0, 2000);
        response.updatedInput = { ...item.input, answers: clean };
      }
      if (decision === 'always' && item.suggestions.length) response.updatedPermissions = item.suggestions;
      if (item.toolName === 'ExitPlanMode') this.setPlanning(false); // the plan's approved: on to the work
      // As Claude Code's own "Yes, and auto-accept edits" does: the mode rides on the approval.
      if (item.toolName === 'ExitPlanMode' && afterPlan && afterPlan !== 'plan' && CLI_MODE[afterPlan]) {
        response.updatedPermissions = [...(response.updatedPermissions || []), { type: 'setMode', mode: CLI_MODE[afterPlan], destination: 'session' }];
        this.mode = afterPlan;
      }
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emitItem({ kind: 'decision', requestId, decision, toolName: item.toolName, ...(via === 'phone' || via === 'deck' ? { via } : {}) });
    return true;
  },

  cancelPending() {
    for (const id of this.pending.keys()) this.emit('item', { kind: 'decision', requestId: id, decision: 'cancelled' });
    this.pending.clear();
  },

  interrupt() {
    if (this.busy && this.waiting) {
      // Claude never saw it, so there's nothing to interrupt: the turn just ends.
      this.waiting = null;
      this.setBusy(false);
      this.emitItem({ kind: 'result', ok: false, interrupted: true, error: null, durationMs: 0 });
      return;
    }
    if (!this.proc || !this.busy) return;
    this.interrupting = true;
    for (const id of [...this.pending.keys()]) this.respond(id, 'deny', 'Interrupted by the user.');
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    // If the CLI doesn't wind down promptly, kill it; the session can be resumed.
    const proc = this.proc;
    setTimeout(() => { if (this.proc === proc && this.busy) this.kill(); }, INTERRUPT_KILL_MS);
  },

  /**
   * Ask the running CLI something over the control protocol and wait for its
   * answer. -> { ok: true, response } | { ok: false, error }. Never throws.
   * @param {string} subtype
   * @returns {Promise<{ ok: true, response: any } | { ok: false, error: string }>}
   */
  request(subtype, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.proc) return Promise.resolve({ ok: false, error: "This conversation isn't running right now." });
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answered({ request_id: id, subtype: 'error', error: "Claude Code didn't answer." }), timeoutMs);
      this.requests.set(id, { resolve, timer });
      this.write({ type: 'control_request', request_id: id, request: { subtype, ...payload } });
    });
  },

  answered(r) {
    const waiting = r && this.requests.get(r.request_id);
    if (!waiting) return;
    this.requests.delete(r.request_id);
    clearTimeout(waiting.timer);
    waiting.resolve(r.subtype === 'success' ? { ok: true, response: r.response || {} } : { ok: false, error: String(r.error || 'Claude Code said no.') });
  },

  /**
   * Ask Claude Code to stop one background command or watch, the way its own
   * TaskStop does. -> { ok } | { ok: false, error }.
   */
  async stopJob(taskId) {
    const job = this.jobs.byId.get(taskId);
    if (!job || job.status !== 'running') return { ok: false, error: "That isn't running any more." };
    const r = await this.request('stop_task', { task_id: taskId });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },

  // Effort for this conversation: the flag for the next start, and the running
  // process told now, so the very next turn thinks harder (or less).
  setEffort(effort) {
    this.effort = EFFORTS.includes(effort) ? effort : '';
    if (this.proc) this.request('apply_flag_settings', { settings: { effortLevel: this.effort || null } });
  },

  /**
   * Make the next start pick the conversation up only as far as `anchor` (a
   * transcript entry from an earlier result), as a new fork. No anchor: the
   * next message starts a new conversation.
   */
  async rewindTo(anchor) {
    await this.stop();
    if (anchor) this.resumeAt = anchor;
    else this.sessionId = null;
    this.lastUuid = null;
    this.setContext(0);
    // The panel rebuilds the list from what's left of the feed; here it starts over.
    this.todos = todos.create();
    this.emit('todos', todos.summary(this.todos));
  },

  setMode(mode) {
    this.mode = mode;
    this.setPlanning(mode === 'plan');
    if (this.proc) {
      this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode: CLI_MODE[mode] } });
    }
  },

  // A tool call on the main thread has finished (or failed). What you queued
  // meanwhile goes in now, written ahead of this answer so the CLI has it before
  // it hands the tool's result back: Claude reads it before its next step, like
  // Claude Code's own queue. Only once nothing else of this step is still
  // running (until Claude has read it, Stop can't take it back), not for a
  // subagent's tools, whose steer would wait on the whole subagent, and not
  // once you've pressed Stop.
  steer(requestId, input) {
    try {
      this.openTools.delete(input?.tool_use_id);
      const stopping = this.interrupting || input?.is_interrupt;
      if (this.busy && !stopping && !input?.agent_id && !this.openTools.size && this.proc?.stdin.writable) {
        for (const s of this.takeSteers?.() || []) {
          this.write({ type: 'user', message: { role: 'user', content: s.content } });
          this.steered.push(s.item);
        }
      }
    } catch { /* it waits for the next step, or goes when the turn ends */ }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
  },

  async answerHook(requestId, input) {
    let response = {};
    try { response = (await this.beforeWork?.(input || {})) || {}; } catch { /* let the tool run */ }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  },

  async answerMcp(event) {
    const response = await crabmcp.handle(event.request.message, this.mcp);
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { mcp_response: response } } });
  },
};

module.exports = { control, DENY_MESSAGE };
