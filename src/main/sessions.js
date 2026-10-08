// Parallel conversations. Each tab owns one ClaudeSession (one CLI process);
// the manager persists transcripts, tracks per-tab status and rolls everything
// up into one state for the desktop critter.
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { ClaudeSession } = require('./session');
const workPose = require('./work-pose');
const { cleanTitle } = require('./history');
const review = require('./review-inbox');
const turncost = require('./turncost');
const mods = require('./mods');

// Tabs left quiet shed their process (stopIdle), so an open tab is cheap; a busy
// one is a running CLI, and nothing limits how many of those run at once. The cap
// is where routines and workflows start recycling old tabs to make room.
const MAX_TABS = 32;
const IN_TERMINAL = 'This conversation is carrying on in a terminal. Close it there (/exit), then choose Pick it up here.';
const TAB_ID = /^[\w-]{1,64}$/;

class SessionManager extends EventEmitter {
  // prepareTurn(tab): an optional promise each turn waits for before Claude
  // sees it (main.js snapshots the folder, for the turn's diff).
  // compose(text, files): the content Claude gets for a steer (attachments.js composeContent).
  // windowShare(weight): a turn's share of the 5-hour window, or null (turncost.js),
  // put on its result before History keeps it.
  // Claude knowing it's in Shellby (see selfaware.js, crabmcp.js), all optional:
  //   getSelfAware() -> { note, tools } | null, read when a tab's process is made
  //   onTool(tab, name, args) -> Promise<{ text, isError? }>, a crab tool was called
  //   decorate(tab, prompt) -> the prompt Claude actually receives
  constructor({ getExe, history, getMode, getModel, getEffort = () => '', getOutputStyle = () => '', argsPrefix = [], getEnv = () => ({}), prepareTurn = null, compose = text => text, windowShare = null, getSelfAware = () => null, onTool = null, decorate = null }) {
    super();
    Object.assign(this, { getExe, history, getMode, getModel, getEffort, getOutputStyle, argsPrefix, getEnv, prepareTurn, compose, windowShare, getSelfAware, onTool, decorate });
    this.tabs = new Map();
  }

  // Creates (or returns) a tab. `historyEntry` resumes a saved conversation.
  // allowedTools / mcpConfig: a routine's or workflow step's MCP servers (mcpservers.js),
  // fixed for the life of its process.
  open({ tabId, cwd, historyEntry = null, mode = null, routineId = null, workflowRunId = null, title = null, allowedTools = [], mcpConfig = null }) {
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
      effort: this.getEffort() || '',
      outputStyle: this.getOutputStyle() || '',
      resumeId: historyEntry?.claudeSessionId || null,
      resumeAt: historyEntry?.resumeAt || null,
      extraEnv: () => this.getEnv(),
      context: historyEntry?.context || null,
      allowedTools, mcpConfig,
      systemNote: aware?.note || null,
      mcp: aware?.tools && this.onTool ? { tools: aware.tools, call: (name, args) => this.onTool(tab, name, args) } : null,
    });
    tab = {
      id: tabId, session, routineId,
      workflowRunId,               // a workflow run's conversation (workflows/service.js)
      pinnedMode: !!mode,          // routines and workflows keep their own mode
      title: historyEntry?.title || title || 'New task',
      saved: !!historyEntry,       // has a history entry (created on first send)
      named: false,                // renamed before its first send: keep that name
      outcome: null,               // 'ok' | 'error' | 'stopped' after the last turn
      unread: false,
      worktree: historyEntry?.worktree || null, // its own copy of the repo (worktrees.js)
      // A branch of another conversation (branch.js): where it came from, the
      // folders it must keep out of, and what Claude is told before its first
      // message (where it is now). All kept in History so a restart keeps them.
      branchOf: historyEntry?.branchOf || null,
      fence: historyEntry?.fence || null,
      preamble: typeof historyEntry?.preamble === 'string' ? historyEntry.preamble : null,
      // Its latest finished work and whether you've looked (review-inbox.js): the review inbox.
      ready: review.restore(historyEntry?.ready),
      // When it was carried on in a terminal (handoff.js): until it's picked up
      // again, nothing is sent from here, or two processes would share it.
      inTerminal: Number.isFinite(historyEntry?.inTerminal) ? historyEntry.inTerminal : null,
      activeAt: Date.now(),        // when it last sent or heard anything, for stopIdle()
      steers: [],                  // what the panel has queued for this turn's next step (steer())
      steeredIds: new Set(),       // ...and what of it has gone in already
      usageTold: 0,                // the usage level Claude was last told about (selfaware.usageNote)
      offered: new Set(),          // features suggested in this conversation
    };
    // A reopened conversation remembers what it already offered.
    if (historyEntry) for (const i of this.history.load?.(tabId) || []) if (i?.kind === 'suggest') tab.offered.add(i.feature);
    this.tabs.set(tabId, tab);
    session.takeSteers = () => this.takeSteers(tab);

    session.on('item', item => this.onItem(tab, item));
    session.on('spend', s => this.emit('spend', tab.id, s, tab));
    session.on('call', c => this.emit('call', tab.id, c, tab));
    session.on('cache', () => this.changed());
    session.on('context', (now, before) => { this.emit('context', tab.id, now, before, tab); this.changed(); });
    session.on('busy', () => this.changed());
    session.on('tokens', () => this.changed());
    session.on('crew', () => this.changed());
    session.on('tool', () => this.changed());
    session.on('exit', () => {
      // Its mods ended with it: their status lines go too (plugin null: all of them).
      this.emit('item', tab.id, { kind: 'modstatus', plugin: null, text: null }, tab);
      this.changed();
    });
    this.changed();
    return tab;
  }

  onItem(tab, raw) {
    // A long tool result's tail is only for main to read (flaky.js): it's
    // neither saved with the tab nor sent to the panel.
    let { tail, ...item } = raw;
    // A mod's lines and toasts, within its budget: one that says something on
    // every step would bury the conversation and its history (mods.js).
    if (item.kind === 'modlog' || item.kind === 'modtoast') {
      tab.modLines ??= new Map();
      const say = mods.modLineAllowed(tab.modLines, item.plugin);
      if (say === 'drop') return;
      if (say === 'last') item = { kind: 'modlog', plugin: item.plugin, text: 'is saying a lot, so Shellby hides the rest of what it says this minute.' };
    }
    tab.activeAt = Date.now();
    // A rewind's fork exists once Claude Code reports its id: from then on it's an ordinary resume.
    if (item.kind === 'init' && tab.saved) this.history.update(tab.id, { claudeSessionId: item.sessionId, resumeAt: null });
    if (item.kind === 'init' && tab.preambleSent) {
      tab.preamble = null;
      tab.preambleSent = false;
      if (tab.saved) this.history.update(tab.id, { preamble: null });
    }
    // What the turn cost, in words the panel shows as they are.
    if (item.kind === 'result' && item.cost) {
      let share = null;
      try { share = this.windowShare?.(item.cost.weight, tab) ?? null; } catch { /* no reading to go on: tokens and context still show */ }
      const cost = { ...item.cost, share: Number.isFinite(share) ? share : null };
      item.cost = { ...cost, line: turncost.costLine(cost), detail: turncost.costDetail(cost) };
    }
    if (item.kind === 'result') {
      tab.outcome = item.interrupted ? 'stopped' : item.ok ? 'ok' : 'error';
      tab.unread = true;
      if (tab.saved) this.history.update(tab.id, { lastOutcome: tab.outcome, context: tab.session.context });
    }
    if (tab.saved) this.history.append(tab.id, item);
    const ready = review.next(tab.ready, item);
    if (ready !== tab.ready) this.setReady(tab, ready);
    this.emit('item', tab.id, item, tab, tail);
    if (['permission', 'decision', 'result', 'error'].includes(item.kind)) this.changed();
  }

  // Kept in History without bumping updatedAt (history.setReady): looking at work isn't work on it.
  setReady(tab, ready) {
    tab.ready = ready;
    if (tab.saved) this.history.setReady(tab.id, ready);
    this.changed();
  }

  /** Mark a tab's latest changes reviewed (or put them back in the inbox). -> whether anything changed. */
  setReviewed(tabId, reviewed = true, after = null) {
    const tab = this.tabs.get(tabId);
    if (!tab?.ready) return false;
    if (after && tab.ready.after !== after) return false; // a newer turn's changes: not the ones you saw
    const ready = review.setReviewed(tab.ready, reviewed);
    if (ready === tab.ready) return false;
    this.setReady(tab, ready);
    return true;
  }

  send(tabId, prompt, userItem) {
    const tab = this.require(tabId);
    // Before anything below touches History or the turn: session.send would
    // refuse anyway, but only after a message Claude never saw was saved.
    if (tab.session.busy) throw new Error('Shellby is still working on the last task.');
    if (tab.inTerminal) throw new Error(IN_TERMINAL);
    tab.activeAt = Date.now();
    if (!tab.saved) {
      this.history.create({ id: tab.id, title: tab.named ? tab.title : userItem.title || userItem.text || tab.title, cwd: tab.session.cwd, mode: tab.session.mode, routineId: tab.routineId });
      // A tab that opened in its own copy before its first message (a Next up draft):
      // the copy goes in History with it, or reopening it would lose Bring home.
      if (tab.worktree) this.history.update(tab.id, { worktree: tab.worktree });
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
    tab.steers = [];
    tab.steeredIds = new Set();
    // Who sent it: a routine's run, a workflow's step, a task you queued for
    // the reset, or you (main.js armGuard).
    tab.turnFrom = { routine: userItem.routine || null, workflow: userItem.workflow || null, queued: userItem.queued || null };
    // What was asked, for its category in the per-turn ledger (usage-ledger.js). Read once as the turn starts.
    tab.turnText = typeof userItem.text === 'string' ? userItem.text : '';
    tab.outcome = null;
    // The note goes with the first real message (a /command must still start
    // with its slash), and is only forgotten once Claude has started with it:
    // if the process never starts, the next message takes it instead.
    if (tab.preamble && !(typeof prompt === 'string' && prompt.trimStart().startsWith('/'))) {
      prompt = withPreamble(prompt, tab.preamble);
      tab.preambleSent = true;
    }
    if (this.decorate) prompt = this.decorate(tab, prompt);
    tab.session.send(prompt, this.prepareTurn?.(tab) || null);
    this.changed();
    return userItem.turnId;
  }

  /**
   * The panel's queue while a turn runs, [{ id, text, attachments }] in order:
   * it goes to Claude at its next step (session.js steer). Only for the turn it
   * was queued behind: one the panel has since sent on its own isn't steered
   * in too. What has gone in already this turn stays out, should the panel not
   * have heard yet. -> whether it was taken.
   */
  steer(tabId, turnId, list) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.session.busy || !turnId || turnId !== tab.turnId) return false;
    tab.steers = list.filter(m => !tab.steeredIds.has(m.id));
    return true;
  }

  /**
   * Take a queued message back before Claude has it (the panel's × on its chip).
   * By id, here, where takeSteers() runs: the panel's own list can be a step
   * behind. -> false when it's too late (it went in this turn), else true.
   */
  unsteer(tabId, id) {
    const tab = this.tabs.get(tabId);
    if (!tab) return true; // nothing of it can reach Claude
    if (tab.steeredIds.has(id)) return false;
    tab.steers = tab.steers.filter(m => m.id !== id);
    return true;
  }

  // What the session hands Claude now, taken off the list ('steering' tells the
  // panel, so its chip can't be edited any more). The chip goes once Claude has
  // read it: the 'user' item carries its steerId. One that can't be put
  // together stays queued, and so does all after it.
  //
  // It has no rewind point of its own: Shellby keeps the code as it stood
  // between turns, not mid-turn, so "just before it" can't be put back. turnOf
  // is the message whose turn it went into, which the panel offers instead.
  takeSteers(tab) {
    const taken = [];
    for (const m of tab.steers) {
      let content;
      try { content = this.compose(m.text, m.attachments); } catch { break; }
      taken.push({ content, item: { kind: 'user', text: m.text, attachments: m.attachments, steerId: m.id, turnOf: tab.turnId || null } });
    }
    tab.steers = tab.steers.slice(taken.length);
    for (const t of taken) tab.steeredIds.add(t.item.steerId);
    if (taken.length) this.emit('steering', tab.id, taken.map(t => t.item.steerId));
    return taken;
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

  /** Mark a tab as carried on in a terminal (at: a time), or picked back up (null). */
  setInTerminal(tabId, at) {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.inTerminal = Number.isFinite(at) ? at : null;
    if (tab.saved) this.history.update(tab.id, { inTerminal: tab.inTerminal });
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

  // kill: end the process tree now instead of letting it wind down (quitting).
  close(tabId, { kill = false } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.session.removeAllListeners();
    if (kill) tab.session.kill();
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

  closeAll(opts) { for (const id of [...this.tabs.keys()]) this.close(id, opts); }

  /**
   * Stop the process of every tab that has sat quiet for idleMs. Each one holds
   * a claude process and a full set of MCP servers (dozens of processes, over a
   * GB) for nothing; the tab stays open, and its next message resumes it. Not a
   * tab that's working, waiting on you, or has something running in the
   * background. -> the ids of the tabs stopped.
   */
  stopIdle(idleMs, now = Date.now()) {
    const stopped = [];
    for (const tab of this.tabs.values()) {
      const s = tab.session;
      if (!s.proc || s.busy || s.pending.size || s.runningCrew().length) continue;
      if (now - tab.activeAt < idleMs) continue;
      s.stop().catch(() => {});
      stopped.push(tab.id);
    }
    return stopped;
  }

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
      turnTokens: t.session.turn?.tokens || 0, // the running turn's so far, beside its clock
      pending: t.session.pending.size, crew: t.session.runningCrew().length,
      outcome: t.outcome, unread: t.unread, routineId: t.routineId, workflowRunId: t.workflowRunId || null, saved: t.saved, named: t.named, context: t.session.context, cache: t.session.cache,
      nudge: turncost.nudge(t.session.context, t.session.growths),
      worktree: t.worktree ? { branch: t.worktree.branch, base: t.worktree.base, originalCwd: t.worktree.originalCwd } : null,
      branchOf: t.branchOf ? { id: t.branchOf.id, title: t.branchOf.title, at: t.branchOf.at } : null,
      // The last time Shellby ran its tests (wiring/checks.js): for anything that wants a verdict at a glance.
      checks: t.checks ? { status: t.checks.status, after: t.checks.after, at: t.checks.at } : null,
      // Its latest changes and whether you've reviewed them (review-inbox.js): the panel's review inbox.
      ready: t.ready ? { ...t.ready, paths: [...t.ready.paths] } : null,
      inTerminal: t.inTerminal || null,
    }));
  }

  // One state for the critter: asking beats working beats idle.
  get aggregate() {
    let pending = 0, busy = 0;
    const crew = [], tools = [];
    for (const t of this.tabs.values()) {
      pending += t.session.pending.size;
      if (t.session.busy) { busy++; tools.push({ tool: t.session.tool, toolAt: t.session.toolAt }); }
      for (const c of t.session.runningCrew()) {
        crew.push({ id: c.taskId, tabId: t.id, label: c.activity || c.description || c.subagentType || 'helper', type: c.subagentType || 'general-purpose' }); // Claude Code's own default
      }
    }
    // What the busy tab that moved last is doing, for how the crab works (work-pose.js).
    const latest = workPose.latest(tools);
    return { state: pending ? 'asking' : (busy || crew.length) ? 'working' : 'idle', pending, busy, crew, tool: latest?.tool || null, toolAt: latest?.toolAt || null };
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

// A note for Claude ahead of what you typed, as a block of its own so your
// words reach it exactly as you wrote them (a prompt, or blocks when pictures go with it).
function withPreamble(prompt, preamble) {
  return [{ type: 'text', text: preamble }, ...(Array.isArray(prompt) ? prompt : [{ type: 'text', text: String(prompt) }])];
}

module.exports = { SessionManager, MAX_TABS, IN_TERMINAL, withPreamble };
