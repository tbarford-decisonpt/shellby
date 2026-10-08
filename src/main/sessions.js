// Parallel conversations. Each tab owns one ClaudeSession (one CLI process);
// the manager persists transcripts, tracks per-tab status and rolls everything
// up into one state for the desktop critter.
const { EventEmitter } = require('events');
const { ClaudeSession } = require('./session');

const MAX_TABS = 8;
const TAB_ID = /^[\w-]{1,64}$/;

class SessionManager extends EventEmitter {
  // Claude knowing it's in Shellby (see selfaware.js, crabmcp.js), all optional:
  //   getSelfAware() -> { note, tools } | null, read when a tab's process is made
  //   onTool(tab, name, args) -> Promise<{ text, isError? }>, a crab tool was called
  //   decorate(tab, prompt) -> the prompt Claude actually receives
  constructor({ getExe, history, getMode, getModel, argsPrefix = [], getEnv = () => ({}), getSelfAware = () => null, onTool = null, decorate = null }) {
    super();
    Object.assign(this, { getExe, history, getMode, getModel, argsPrefix, getEnv, getSelfAware, onTool, decorate });
    this.tabs = new Map();
  }

  // Creates (or returns) a tab. `historyEntry` resumes a saved conversation.
  open({ tabId, cwd, historyEntry = null, mode = null, routineId = null, title = null }) {
    if (!TAB_ID.test(tabId || '')) throw new Error('bad tab id');
    if (this.tabs.has(tabId)) return this.tabs.get(tabId);
    if (this.tabs.size >= MAX_TABS) throw new Error(`Shellby can run up to ${MAX_TABS} conversations at once. Close one first.`);
    const exe = this.getExe();
    if (!exe) throw new Error('Claude Code is not installed.');
    const aware = this.getSelfAware();
    let tab = null; // the tools are only ever called once it exists
    const session = new ClaudeSession({
      exe, argsPrefix: this.argsPrefix,
      cwd: historyEntry?.cwd || cwd,
      mode: mode || this.getMode(),
      model: this.getModel() || null,
      resumeId: historyEntry?.claudeSessionId || null,
      extraEnv: () => this.getEnv(),
      systemNote: aware?.note || null,
      mcp: aware?.tools && this.onTool ? { tools: aware.tools, call: (name, args) => this.onTool(tab, name, args) } : null,
    });
    tab = {
      id: tabId, session, routineId,
      pinnedMode: !!mode,          // routines keep their own mode
      title: historyEntry?.title || title || 'New task',
      saved: !!historyEntry,       // has a history entry (created on first send)
      outcome: null,               // 'ok' | 'error' | 'stopped' after the last turn
      unread: false,
      usageTold: 0,                // the usage level Claude was last told about (selfaware.usageNote)
      offered: new Set(),          // features suggested in this conversation
    };
    // A reopened conversation remembers what it already offered.
    if (historyEntry) for (const i of this.history.load?.(tabId) || []) if (i?.kind === 'suggest') tab.offered.add(i.feature);
    this.tabs.set(tabId, tab);

    session.on('item', item => this.onItem(tab, item));
    session.on('busy', () => this.changed());
    session.on('crew', () => this.changed());
    session.on('exit', () => this.changed());
    this.changed();
    return tab;
  }

  onItem(tab, item) {
    if (item.kind === 'init' && tab.saved) this.history.update(tab.id, { claudeSessionId: item.sessionId });
    if (item.kind === 'result') {
      tab.outcome = item.interrupted ? 'stopped' : item.ok ? 'ok' : 'error';
      tab.unread = true;
      if (tab.saved) this.history.update(tab.id, { lastOutcome: tab.outcome });
    }
    if (tab.saved) this.history.append(tab.id, item);
    this.emit('item', tab.id, item, tab);
    if (['permission', 'decision', 'result', 'error'].includes(item.kind)) this.changed();
  }

  send(tabId, prompt, userItem) {
    const tab = this.require(tabId);
    if (!tab.saved) {
      this.history.create({ id: tab.id, title: userItem.title || userItem.text || tab.title, cwd: tab.session.cwd, mode: tab.session.mode, routineId: tab.routineId });
      tab.title = this.history.get(tab.id).title;
      tab.saved = true;
    } else if (this.history.get(tab.id)?.done) {
      // You've just given it more to do, so it plainly isn't done any more.
      this.history.setDone(tab.id, false);
    }
    this.history.append(tab.id, userItem);
    tab.outcome = null;
    tab.session.send(this.decorate ? this.decorate(tab, prompt) : prompt);
    this.changed();
  }

  respond(tabId, requestId, decision, message, answers) {
    return this.tabs.get(tabId)?.session.respond(requestId, decision, message, answers) || false;
  }

  interrupt(tabId) { this.tabs.get(tabId)?.session.interrupt(); }

  markRead(tabId) {
    const tab = this.tabs.get(tabId);
    if (tab && tab.unread) { tab.unread = false; this.changed(); }
  }

  // The Map's order is the order the tab strip shows, and main.js persists it as
  // `openTabs`, so a reorder here is also what comes back next launch. `beforeId`
  // is the tab to land in front of; null means the end of the strip.
  reorder(tabId, beforeId = null) {
    if (!this.tabs.has(tabId)) return false;
    const was = [...this.tabs.keys()];
    const rest = was.filter(id => id !== tabId);
    const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
    if (at < 0) return false;                                  // unknown neighbour, or itself
    rest.splice(at, 0, tabId);
    if (rest.every((id, i) => id === was[i])) return false;     // already sitting there
    const order = rest.map(id => [id, this.tabs.get(id)]);
    this.tabs.clear();
    for (const [id, tab] of order) this.tabs.set(id, tab);
    this.changed();
    return true;
  }

  close(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.session.removeAllListeners();
    tab.session.close();
    this.tabs.delete(tabId);
    this.changed();
  }

  closeAll() { for (const id of [...this.tabs.keys()]) this.close(id); }

  setMode(mode) {
    for (const tab of this.tabs.values()) if (!tab.pinnedMode) tab.session.setMode(mode);
  }

  require(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error('That conversation is closed.');
    return tab;
  }

  isBusy(tabId) { return !!this.tabs.get(tabId)?.session.busy; }

  get summary() {
    return [...this.tabs.values()].map(t => ({
      id: t.id, title: t.title, cwd: t.session.cwd, busy: t.session.busy,
      pending: t.session.pending.size, crew: t.session.runningCrew().length,
      outcome: t.outcome, unread: t.unread, routineId: t.routineId, saved: t.saved,
    }));
  }

  // One state for the critter: asking beats working beats idle.
  get aggregate() {
    let pending = 0, busy = 0;
    const crew = [];
    for (const t of this.tabs.values()) {
      pending += t.session.pending.size;
      if (t.session.busy) busy++;
      for (const c of t.session.runningCrew()) {
        crew.push({ id: c.taskId, tabId: t.id, label: c.activity || c.description || c.subagentType || 'helper', type: c.subagentType || 'agent' });
      }
    }
    return { state: pending ? 'asking' : (busy || crew.length) ? 'working' : 'idle', pending, busy, crew };
  }

  changed() {
    // Coalesce bursts (progress events can be chatty) into one update per tick.
    if (this.pendingEmit) return;
    this.pendingEmit = setImmediate(() => {
      this.pendingEmit = null;
      this.emit('tabs', this.summary);
      this.emit('aggregate', this.aggregate);
    });
  }
}

module.exports = { SessionManager, MAX_TABS };
