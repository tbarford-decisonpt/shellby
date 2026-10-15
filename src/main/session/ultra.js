'use strict';

// ClaudeSession's ultracode runs (Claude Code's Workflow tool, ultracode.js),
// mixed into its prototype by session/index.js: each run's card as an
// 'ultracode' item, its agents out as helper crabs, and the spend Claude Code
// doesn't report itself counted towards the usage meters.

const ultracode = require('../ultracode');

const ultra = {
  /** @param {any} item a task item of an ultracode run */
  trackRun(item) {
    const started = !this.ultra.byId.has(item.taskId);
    const run = ultracode.track(this.ultra, item, Date.now());
    if (run) this.runChanged(run, { started });
  },

  /** The Workflow tool's result: the run id Claude would resume it by. */
  noteLaunch(launch) {
    const run = ultracode.noteLaunch(this.ultra, launch);
    if (run) this.runChanged(run);
  },

  /** Real usage under a run's Workflow call: its cost counts that (and the meters already have it). */
  runSpent(parent, weight) {
    const run = ultracode.noteSpend(this.ultra, parent, weight);
    if (run) this.runChanged(run);
  },

  runModel() {
    return this.lastModel || this.model || '';
  },

  runChanged(run, { started = false } = {}) {
    const now = Date.now();
    const weight = ultracode.meterDelta(run, this.runModel());
    if (weight) this.emit('spend', { messageId: `ultracode:${run.id}`, weight });
    if (ultracode.syncCrew(this.tasks, run, now)) this.emit('crew', this.crew);
    const { send, save } = ultracode.due(run, now, { started });
    if (!send && !save) return;
    // Only some of a running card's updates are kept in History (history/index.js): enough to restore it.
    this.emitItem({ kind: 'ultracode', ...ultracode.view(run, this.runModel()), ...(save ? {} : { live: true }) });
  },

  /** The process went: its runs went with it. */
  stopRuns() {
    for (const run of ultracode.stopAll(this.ultra, Date.now())) this.runChanged(run);
  },

  runningRuns() {
    return [...this.ultra.byId.values()].filter(r => r.status === 'running');
  },

  /** A run's card as it is now, or null when this process never saw it. */
  runView(id) {
    const run = this.ultra.byId.get(id);
    return run ? ultracode.view(run, this.runModel()) : null;
  },

  /** Agents of running runs that aren't out as crabs: the desktop's "+N more". */
  hiddenCrew() {
    return ultracode.hiddenCrabs(this.ultra);
  },

  /** Stop a run the way Claude Code's own TaskStop does. -> { ok } | { ok: false, error }. */
  async stopRun(id) {
    const run = this.ultra.byId.get(id);
    if (!run || run.status !== 'running') return { ok: false, error: "That run isn't going any more." };
    const r = await this.request('stop_task', { task_id: id });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

module.exports = { ultra };
