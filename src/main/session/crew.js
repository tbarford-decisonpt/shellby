'use strict';

// ClaudeSession's helpers (subagents) and their messages, mixed into its
// prototype by session/.

// How long a helper shows a message it sent or was sent (noteMessage).
const TALK_MS = 8000;
// Finished helpers a conversation remembers (pruneTasks): more than any lane or
// the desktop shows at once.
const MAX_ENDED_TASKS = 50;

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
    this.pruneTasks();
    this.emit('crew', this.crew);
  },

  // Helpers that finished long ago go, the oldest first, past MAX_ENDED_TASKS: a
  // long conversation sends hundreds, and every change copies the whole list
  // (crew) for the panel and the desktop. Running ones always stay.
  pruneTasks() {
    let ended = 0;
    for (const t of this.tasks.values()) if (t.status !== 'running') ended++;
    if (ended <= MAX_ENDED_TASKS) return;
    for (const [id, t] of this.tasks) {
      if (ended <= MAX_ENDED_TASKS) break;
      if (t.status !== 'running') { this.tasks.delete(id); ended--; }
    }
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
    this.talked();
  },

  // A helper wrote something (Claude Code forwards its words with
  // --forward-subagent-text): its crab says the first line of it, to nobody in particular.
  noteSaid(item) {
    const helper = [...this.tasks.values()].find(t => t.toolUseId === item.parent && t.status === 'running');
    const words = String(item.text || '').split('\n').map(l => l.replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim()).find(Boolean);
    if (!helper || !words) return;
    // A message between agents (noteMessage) says more: it keeps the bubble its few seconds.
    const now = Date.now();
    if ([helper.heard, helper.said?.to ? helper.said : null].some(m => m && now - m.at < TALK_MS)) return;
    this.tasks.set(helper.taskId, { ...helper, said: { text: words, to: null, at: now } });
    this.talked();
  },

  // Someone's talking: the crab window hears now, and again once it's gone quiet.
  talked() {
    this.emit('crew', this.crew);
    clearTimeout(this.talkTimer);
    this.talkTimer = setTimeout(() => this.emit('crew', this.crew), TALK_MS + 50);
    this.talkTimer.unref?.();
  },
};

module.exports = { crew, TALK_MS, MAX_ENDED_TASKS };
