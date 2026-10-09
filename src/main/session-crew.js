'use strict';

// ClaudeSession's helpers (subagents) and their messages, mixed into its
// prototype by session.js.

// How long a helper shows a message it sent or was sent (noteMessage).
const TALK_MS = 8000;

const crew = {
  // Keeps a live map of subagents so permission prompts can be attributed and
  // the desktop can show one helper crab per running agent.
  trackTask(item) {
    if (!item.taskId) return;
    const prev = this.tasks.get(item.taskId) || { taskId: item.taskId, status: 'running', startedAt: Date.now() };
    const next = { ...prev };
    for (const k of ['toolUseId', 'description', 'subagentType', 'background', 'lastTool', 'usage']) {
      if (item[k] == null || (k === 'description' && prev.description && item.phase === 'progress')) continue;
      // A helper sent another message (SendMessage) starts again under that call's
      // id, but its messages still point at the Agent call that made it.
      if (k === 'toolUseId' && prev.toolUseId && prev.toolUseId !== item.toolUseId) { next.messagedBy = item.toolUseId; continue; }
      next[k] = item[k];
    }
    if (item.phase === 'started' && prev.status !== 'running') { next.status = 'running'; next.startedAt = Date.now(); delete next.activity; }
    if (!next.name && this.agentNames.get(next.toolUseId)) next.name = this.agentNames.get(next.toolUseId);
    if (item.phase === 'progress' && item.description) next.activity = item.description;
    if (item.status) next.status = item.status === 'completed' ? 'completed' : item.status;
    if (item.phase === 'done' && !item.status) next.status = 'completed';
    if (prev.status === 'running' && next.status !== 'running') next.endedAt = Date.now(); // the crab window walks it home with how it went
    this.tasks.set(item.taskId, next);
    this.emit('crew', this.crew);
  },

  get crew() {
    return [...this.tasks.values()];
  },

  runningCrew() {
    return this.crew.filter(t => t.status === 'running');
  },

  nameAgent(item) {
    if (!item.agent.name) return;
    this.agentNames.set(item.id, item.agent.name);
    if (this.agentNames.size > 200) this.agentNames.delete(this.agentNames.keys().next().value);
  },

  // One agent wrote to another (SendMessage): the helper it's for heard it, and
  // a helper that sent it said it. The crab window shows both for a moment.
  noteMessage(item) {
    const { to, text, summary } = item.message;
    const helpers = [...this.tasks.values()];
    const target = helpers.find(t => t.name === to || t.taskId === to);
    const from = item.parent ? helpers.find(t => t.toolUseId === item.parent) : null;
    const words = summary || text;
    if (!words || (!target && !from)) return;
    const at = Date.now();
    if (target) this.tasks.set(target.taskId, { ...this.tasks.get(target.taskId), heard: { text: words, from: from ? (from.name || from.subagentType || 'a helper') : null, at } });
    if (from) this.tasks.set(from.taskId, { ...this.tasks.get(from.taskId), said: { text: words, to: target?.name || to, at } });
    this.emit('crew', this.crew);
    clearTimeout(this.talkTimer);
    this.talkTimer = setTimeout(() => this.emit('crew', this.crew), TALK_MS + 50);
    this.talkTimer.unref?.();
  },
};

module.exports = { crew, TALK_MS };
