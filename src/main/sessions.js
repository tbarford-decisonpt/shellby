// Parallel conversations. Each tab owns one ClaudeSession (one CLI process);
// the manager persists transcripts, tracks per-tab status and rolls everything
// up into one state for the desktop critter.
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { ClaudeSession } = require('./session');
const { cleanTitle } = require('./history');

const MAX_TABS = 8;
const TAB_ID = /^[\w-]{1,64}$/;

class SessionManager extends EventEmitter {
  // prepareTurn(tab): an optional promise each turn waits for before Claude
  // sees it (main.js snapshots the folder, for the turn's diff).
  constructor({ getExe, history, getMode, getModel, getEffort = () => '', getOutputStyle = () => '', argsPrefix = [], getEnv = () => ({}), prepareTurn = null }) {
    super();
    Object.assign(this, { getExe, history, getMode, getModel, getEffort, getOutputStyle, argsPrefix, getEnv, prepareTurn });
    this.tabs = new Map();
  }

  // Creates (or returns) a tab. `historyEntry` resumes a saved conversation.
  open({ tabId, cwd, historyEntry = null, mode = null, routineId = null, title = null }) {
    if (!TAB_ID.test(tabId || '')) throw new Error('bad tab id');
    if (this.tabs.has(tabId)) return this.tabs.get(tabId);
    if (this.tabs.size >= MAX_TABS) throw new Error(`Shellby can run up to ${MAX_TABS} conversations at once. Close one first.`);
    const exe = this.getExe();
    if (!exe) throw new Error('Claude Code is not installed.');
    const session = new ClaudeSession({
      exe, argsPrefix: this.argsPrefix,
      cwd: historyEntry?.cwd || cwd,
      mode: mode || this.getMode(),
      model: this.getModel() || null,
      effort: this.getEffort() || '',
      outputStyle: this.getOutputStyle() || '',
      resumeId: historyEntry?.claudeSessionId || null,
      resumeAt: historyEntry?.resumeAt || null,
      extraEnv: () => this.getEnv(),
      context: historyEntry?.context || null,
    });
    const tab = {
      id: tabId, session, routineId,
      pinnedMode: !!mode,          // routines keep their own mode
      title: historyEntry?.title || title || 'New task',
      saved: !!historyEntry,       // has a history entry (created on first send)
      named: false,                // renamed before its first send: keep that name
      outcome: null,               // 'ok' | 'error' | 'stopped' after the last turn
      unread: false,
      worktree: historyEntry?.worktree || null, // its own copy of the repo (worktrees.js)
    };
    this.tabs.set(tabId, tab);

    session.on('item', item => this.onItem(tab, item));
    session.on('spend', s => this.emit('spend', tab.id, s, tab));
    session.on('context', (now, before) => { this.emit('context', tab.id, now, before, tab); this.changed(); });
    session.on('busy', () => this.changed());
    session.on('crew', () => this.changed());
    session.on('exit', () => this.changed());
    this.changed();
    return tab;
  }

  onItem(tab, item) {
    // A rewind's fork exists once Claude Code reports its id: from then on it's an ordinary resume.
    if (item.kind === 'init' && tab.saved) this.history.update(tab.id, { claudeSessionId: item.sessionId, resumeAt: null });
    if (item.kind === 'result') {
      tab.outcome = item.interrupted ? 'stopped' : item.ok ? 'ok' : 'error';
      tab.unread = true;
      if (tab.saved) this.history.update(tab.id, { lastOutcome: tab.outcome, context: tab.session.context });
    }
    if (tab.saved) this.history.append(tab.id, item);
    this.emit('item', tab.id, item, tab);
    if (['permission', 'decision', 'result', 'error'].includes(item.kind)) this.changed();
  }

  send(tabId, prompt, userItem) {
    const tab = this.require(tabId);
    if (!tab.saved) {
      this.history.create({ id: tab.id, title: tab.named ? tab.title : userItem.title || userItem.text || tab.title, cwd: tab.session.cwd, mode: tab.session.mode, routineId: tab.routineId });
      tab.title = this.history.get(tab.id).title;
      tab.saved = true;
    } else if (this.history.get(tab.id)?.done) {
      // You've just given it more to do, so it plainly isn't done any more.
      this.history.setDone(tab.id, false);
    }
    // Each message you send gets an id of its own, so it can be rewound to later.
    userItem = { ...userItem, turnId: userItem.turnId || randomUUID() };
    this.history.append(tab.id, userItem);
    tab.turnId = userItem.turnId; // the turn now starting, for what main.js notes about it (its diff)
    tab.outcome = null;
    tab.session.send(prompt, this.prepareTurn?.(tab) || null);
    this.changed();
    return userItem.turnId;
  }

  // A name of your own for an open tab. One not yet sent anything has no History
  // entry to hold it, so `named` stops the first message from replacing it.
  rename(tabId, title) {
    const tab = this.tabs.get(tabId);
    const t = cleanTitle(title);
    if (!tab || !t) return false;
    tab.title = t;
    if (tab.saved) this.history.rename(tab.id, t); else tab.named = true;
    this.changed();
    return true;
  }

  // Something main.js worked out about a tab (what its last turn changed):
  // kept in the transcript and shown just like the CLI's own items.
  note(tabId, item) {
    const tab = this.tabs.get(tabId);
    if (tab) this.onItem(tab, item);
  }

  respond(tabId, requestId, decision, message, answers, via) {
    return this.tabs.get(tabId)?.session.respond(requestId, decision, message, answers, via) || false;
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

  /** Close a tab and wait until its CLI process has really gone (up to timeoutMs). */
  closeAndWait(tabId, timeoutMs = 8000) {
    const proc = this.tabs.get(tabId)?.session.proc;
    this.close(tabId);
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  closeAll() { for (const id of [...this.tabs.keys()]) this.close(id); }

  setMode(mode) {
    for (const tab of this.tabs.values()) if (!tab.pinnedMode) tab.session.setMode(mode);
  }

  setEffort(effort) {
    for (const tab of this.tabs.values()) tab.session.setEffort(effort);
  }

  require(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error('That conversation is closed.');
    return tab;
  }

  isBusy(tabId) { return !!this.tabs.get(tabId)?.session.busy; }

  get summary() {
    return [...this.tabs.values()].map(t => ({
      id: t.id, title: t.title, cwd: t.session.cwd, busy: t.session.busy, busySince: t.session.busySince,
      pending: t.session.pending.size, crew: t.session.runningCrew().length,
      outcome: t.outcome, unread: t.unread, routineId: t.routineId, saved: t.saved, named: t.named, context: t.session.context,
      worktree: t.worktree ? { branch: t.worktree.branch, base: t.worktree.base, originalCwd: t.worktree.originalCwd } : null,
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
