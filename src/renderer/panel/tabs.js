/* Shellby panel — tabs: opening, closing, ordering and switching between
   conversations, and the keys that do it. The strip is drawn by tab-strip.js,
   the box and sending by tab-send.js, the queue by tab-queue.js, the slash menu
   by slash-menu.js and the mode and folder chips by tab-chips.js; the folder
   chip's repository items live in tab-git.js, the context and usage meters in
   tab-meters.js (all loaded after this). */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const L = window.ShellbyTabLogic;
  const input = $('input');
  // Theirs, reached when they're called (the files load after this one).
  const syncContextUi = () => SB.syncContextUi();
  const applyFolderLabel = (cwd, tab) => SB.applyFolderLabel(cwd, tab);
  const syncBusyUi = () => SB.syncBusyUi();
  const autosize = () => SB.autosize();
  // Empty, idle and holding nothing for the reset (shared/outlook-format.js).
  const isBlank = tab => window.ShellbyOutlookFormat.isBlank(tab, state.outlook);
  SB.isBlankTab = isBlank;
  const renderAttachments = () => SB.renderAttachments();

  // ------------------------------------------------------------ tabs


  SB.activeTab = () => state.tabs.get(state.activeTab) || null;

  SB.ensureTab = (summary) => {
    let tab = state.tabs.get(summary.id);
    if (!tab) {
      tab = new SB.Tab(summary.id, { title: summary.title, cwd: summary.cwd, saved: summary.saved, routineId: summary.routineId });
      tab.el.hidden = true;
      $('feeds').append(tab.el);
      state.tabs.set(summary.id, tab);
    }
    Object.assign(tab, {
      title: summary.title ?? tab.title, cwd: summary.cwd ?? tab.cwd, busy: !!summary.busy, busySince: summary.busySince ?? (summary.busy ? tab.busySince : null),
      turnTokens: summary.turnTokens ?? tab.turnTokens ?? 0,
      pending: summary.pending || 0, crew: summary.crew || 0, outcome: summary.outcome ?? tab.outcome,
      unread: !!summary.unread, saved: summary.saved ?? tab.saved, named: summary.named ?? tab.named, routineId: summary.routineId ?? tab.routineId,
      worktree: summary.worktree !== undefined ? summary.worktree : tab.worktree || null,
      branchOf: summary.branchOf !== undefined ? summary.branchOf : tab.branchOf || null,
      context: summary.context !== undefined ? summary.context : tab.context || null,
      cache: summary.cache !== undefined ? summary.cache : tab.cache || null,
      // The tests' last verdict and the latest changes' review (main's review-inbox.js), for the review inbox.
      checks: summary.checks !== undefined ? summary.checks : tab.checks || null,
      ready: summary.ready !== undefined ? summary.ready : tab.ready || null,
      nudge: summary.nudge !== undefined ? summary.nudge : tab.nudge || null,
      inTerminal: summary.inTerminal !== undefined ? summary.inTerminal : tab.inTerminal || null,
    });
    return tab;
  };

  SB.activate = (tabId) => {
    const prev = SB.activeTab();
    if (prev) { prev.draft = input.value; }
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    SB.showInPane(tabId); // on screen already, or in the focused pane (tab-panes.js)
    state.activeTab = tabId;
    SB.renderPanes();
    input.value = tab.draft || '';
    autosize();
    renderAttachments();
    applyFolderLabel(tab.cwd || state.cwd, tab);
    syncContextUi();
    syncBusyUi();
    SB.renderBattleChip?.(); // a bug battle in this conversation (bugdex-battle.js)
    if (tab.unread) api.seenTab(tabId);
    tab.unread = false;
    SB.renderTabStrip();
    if (state.view !== 'chat') SB.setView('chat'); else input.focus();
  };

  // state.tabs' order is the order the strip shows. Reordered in place, never
  // replaced: boot.js and settings.js hold on to the Map itself.
  function orderTabs(ids) {
    const order = ids.map(id => [id, state.tabs.get(id)]);
    state.tabs.clear();
    for (const [id, tab] of order) state.tabs.set(id, tab);
  }

  // Move a tab in front of `beforeId` (null = the end of the strip). Main keeps
  // the same order and writes it to disk, so a reorder outlives the session.
  SB.moveTab = (tabId, beforeId = null) => {
    if (!state.tabs.has(tabId)) return false;
    const order = L.reorder([...state.tabs.keys()], tabId, beforeId);
    if (!order) return false; // an unknown neighbour, itself, or already sitting there
    orderTabs(order);
    SB.renderTabStrip();
    api.moveTab(tabId, beforeId);
    return true;
  };

  // One place left or right, for the keyboard and the palette.
  SB.nudgeTab = (tabId, step) => {
    const before = L.nudgeBefore([...state.tabs.keys()], tabId, step);
    return before === undefined ? false : SB.moveTab(tabId, before);
  };

  SB.syncTabs = (summaries) => {
    // A popped-out conversation belongs to its own window, and that window to it alone (tab-panes.js).
    state.popped = new Set(summaries.filter(s => s.popped).map(s => s.id));
    summaries = summaries.filter(s => (SB.solo ? s.id === SB.solo : !s.popped));
    const ids = new Set(summaries.map(s => s.id));
    for (const s of summaries) SB.ensureTab(s);
    // A tab created locally may not be in this snapshot yet; only drop tabs the
    // main process no longer knows about once they've been reported at least once.
    for (const [id, tab] of state.tabs) if (!ids.has(id) && tab.reported) SB.forgetTab(id);
    for (const s of summaries) { const t = state.tabs.get(s.id); if (t) t.reported = true; }
    // Main owns the order; a tab created here that isn't in the snapshot yet waits
    // at the end. A drag in progress wins, so a background tab reporting progress
    // mid-drag can't snap the strip back from under the pointer.
    if (!SB.isDraggingTab()) orderTabs([...summaries.map(s => s.id).filter(id => state.tabs.has(id)), ...[...state.tabs.keys()].filter(id => !ids.has(id))]);
    if (!state.tabs.has(state.activeTab)) {
      const next = [...state.tabs.keys()].pop();
      if (next) SB.activate(next); else if (!SB.solo) SB.newTab();
    }
    syncBusyUi();
    const active = SB.activeTab();
    if (active) applyFolderLabel(active.cwd || state.cwd, active); // its first change can move it into its own copy
    syncContextUi();
    SB.renderTabStrip();
  };

  // All tab creation funnels through here. Concurrent callers (e.g. closing the
  // last tab while the main process reports "no tabs") share one in-flight
  // request, so they can never produce two blank tabs.
  let creating = null;
  SB.newTab = ({ focus = true, reuse = true } = {}) => {
    const cur = SB.activeTab();
    if (reuse && isBlank(cur)) { if (focus) SB.activate(cur.id); return Promise.resolve(cur); } // reuse a blank tab
    if (creating) return creating;
    creating = (async () => {
      const r = await api.newTab();
      if (!r.ok) { SB.toast(r.error); return null; }
      const tab = SB.ensureTab({ id: r.tabId, title: 'New task', cwd: state.cwd });
      if (focus) SB.activate(r.tabId);
      return tab;
    })().finally(() => { creating = null; });
    return creating;
  };

  // A fresh tab in a known project (or the usual folder), with a prompt ready to
  // send (from a nudge).
  SB.newTabIn = async ({ cwd, draft } = {}) => {
    const r = await api.newTab(cwd ? { cwd } : {});
    if (!r.ok) return SB.toast(r.error);
    SB.ensureTab({ id: r.tabId, title: 'New task', cwd: cwd || state.cwd });
    SB.activate(r.tabId);
    input.value = draft || '';
    autosize();
    input.focus();
  };
  api.onNewTabIn(o => { if (o?.cwd) SB.newTabIn(o); });

  SB.closeTab = async (tabId, { quiet = false } = {}) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    SB.forgetTab(tabId); // and its pane; the next one shown takes the focus (tab-panes.js)
    await api.closeTab(tabId);
    SB.renderTabStrip();
    if (tab.saved && !quiet) SB.toast('Closed. It is still in History.');
  };

  // Ctrl+W (and the palette) on a conversation that's still working asks first:
  // a second press within a few seconds stops it and closes it. The × and a
  // middle-click are aimed, so they close straight away as they always have.
  const CLOSE_ARM_MS = 4000;
  let closeArmed = null;
  SB.closeTabSafely = (tabId) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    if (tab.busy && closeArmed !== tabId) {
      closeArmed = tabId;
      setTimeout(() => { if (closeArmed === tabId) closeArmed = null; }, CLOSE_ARM_MS);
      SB.toast(`"${L.shownTitle(tab)}" is still working. Press ${SB.shortcuts.primary('closeTab')} again to stop it and close it.`,
        { ms: CLOSE_ARM_MS, action: 'Stop and close', onAction: () => { closeArmed = null; SB.closeTab(tabId); } });
      return;
    }
    closeArmed = null;
    SB.closeTab(tabId);
  };

  // One step along the strip, wrapping round at the ends.
  function stepTab(step) {
    const to = L.stepTarget([...state.tabs.keys()], state.activeTab, step);
    if (to !== undefined) SB.activate(to);
  }

  // The newer shortcuts for the conversation you're in (shortcuts.js has their keys).
  const TAB_KEYS = {
    tryAgain: tab => SB.tryAgain(tab),
    showChanges: tab => SB.showChanges(tab),
    bringHome: tab => (tab.worktree ? SB.bringHome(tab) : SB.toast('This conversation works in your own checkout, so there’s nothing to bring home.')),
  };

  document.addEventListener('keydown', e => {
    const tab = SB.activeTab();
    const K = SB.shortcuts;
    if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (tab) SB.closeTabSafely(tab.id); return; }
    // A popped-out window has its one conversation: no strip to add to, split or walk along.
    if (SB.solo && ['newTab', 'splitPane', 'moveTab', 'nextTab', 'prevTab'].some(id => K.matches(e, id))) { e.preventDefault(); return; }
    if (K.matches(e, 'newTab')) { e.preventDefault(); SB.newTab(); return; }
    if (K.matches(e, 'splitPane')) { e.preventDefault(); SB.splitPane(); return; }
    // Reordering from the keyboard, where a browser puts it too — and the only way
    // to do it without a pointer.
    if (K.matches(e, 'moveTab')) {
      e.preventDefault();
      if (tab) SB.nudgeTab(tab.id, e.key === 'PageUp' ? -1 : 1);
      return;
    }
    if (K.matches(e, 'nextTab')) { e.preventDefault(); stepTab(1); return; }
    if (K.matches(e, 'prevTab')) { e.preventDefault(); stepTab(-1); return; }
    const own = Object.keys(TAB_KEYS).find(id => K.matches(e, id));
    if (own) {
      e.preventDefault();
      // Not over a dialog, and not before there's a conversation to act on.
      if (!tab || state.view === 'onboarding' || SB.isCrabOnly() || document.querySelector('.card-sheet:not([hidden])')) return;
      SB.inChat(() => TAB_KEYS[own](tab));
      return;
    }
    // Esc backs out one level and stops at home; it never hides the panel, since
    // a stray press there made the whole window vanish. The hotkey and × do that.
    if (e.key === 'Escape') {
      if (SB.anyMenuOpen()) return SB.closeMenus({ refocus: true });
      if (tab?.busy && state.view === 'chat') return SB.stopTask();
      // Esc twice, like the terminal: back to an earlier message (composer.js).
      if (state.view === 'chat' && SB.escRewind?.(tab, e)) return;
      if (state.view !== SB.homeView() && state.view !== 'onboarding') return SB.goBack();
      return;
    }
    // Y / A / N answer the newest open permission card in the active tab.
    if (e.target.closest('textarea, input, select') || e.ctrlKey || e.metaKey || e.altKey || state.view !== 'chat') return;
    if (e.target.closest('.card-sheet')) return; // not through a dialog (the shortcut list, the share card)
    const open = tab?.openAsk();
    const btn = open?.querySelector(`[data-key="${e.key.toLowerCase()}"]`);
    if (btn) { e.preventDefault(); btn.click(); }
  });

  // Run fn on the chat screen. Coming from another screen, after the switch has
  // put the keyboard in the box, so a menu fn opens keeps it instead.
  const SWITCH_SETTLE_MS = 60;
  SB.inChat = (fn) => {
    if (state.view === 'chat') return fn();
    SB.setView('chat');
    setTimeout(fn, SWITCH_SETTLE_MS);
  };

  // ------------------------------------------------------------ the last turn, from the keyboard

  const lastChanges = tab => [...tab.el.querySelectorAll('details.changes')].pop() || null;
  SB.hasChanges = tab => !!tab && !!lastChanges(tab);

  // The last turn's "files changed" block: opened, in view, and the keyboard on
  // its first file, so Enter shows that file's diff and Tab reaches Undo.
  SB.showChanges = (tab) => {
    const block = tab && lastChanges(tab);
    if (!block) return SB.toast('Nothing in this conversation has changed any files yet.');
    block.open = true;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    block.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    (block.querySelector('.chg-file') || block.querySelector('summary'))?.focus({ preventScroll: true });
  };

  // Your last message, tried again in a new tab: change it first, or run it as is.
  SB.tryAgain = (tab) => {
    if (!tab) return;
    if (tab.busy) return SB.toast('Let him finish first (or press Stop), then try it another way.');
    return SB.openBranch(tab, tab.lastTurnId, 'before');
  };
})();
