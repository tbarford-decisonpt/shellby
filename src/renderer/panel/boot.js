/* Shellby panel — wiring and startup. Loaded last. */
'use strict';
(function () {
  const { api, state, $ } = SB;

  $('closeBtn').addEventListener('click', () => api.hide());
  $('minBtn').addEventListener('click', () => api.minimize());

  SB.renderCrabs = () => {
    for (const id of ['brandCrab', 'helloCrab', 'dockCrab']) $(id).replaceChildren(SB.sprite());
    SB.syncHomeMark();
    SB.refreshEmptyStates();
  };
  // The gutter mark on his messages is the shell he lives in, so moving house
  // re-marks the whole feed, and so does a new skin (his own shell takes its
  // colours). CSS reads --home-mark; see shared/minishell.js.
  SB.syncHomeMark = () => {
    const id = state.outfit?.home?.id || 'home';
    document.body.dataset.home = id;
    document.body.style.setProperty('--home-mark', SB.MiniShell.markUrl(id, state.skin));
  };
  SB.refreshEmptyStates = () => { for (const tab of state.tabs.values()) tab.renderEmpty(); };

  // ------------------------------------------------------------ events from main

  api.onTabItem(({ tabId, item }) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    tab.render(item);
    if (item.kind === 'user' && item.steerId) SB.onSteered(tab, item.steerId);
    if (item.kind === 'result') {
      tab.busy = false;
      if (!tab.isActive) tab.unread = true;
      SB.onTurnEnded(tab, item);
      api.listSessions().then(s => { state.sessions = s; });
    }
    if (item.kind === 'decision' || item.kind === 'result') SB.syncBusyUi();
  });
  api.onTabSteering(({ tabId, ids }) => {
    const tab = state.tabs.get(tabId);
    if (tab && Array.isArray(ids)) SB.onSteering(tab, ids);
  });
  api.onTabs(summaries => SB.syncTabs(summaries));
  api.onTabOpened(({ tabId, entry, items, background, busy = true, draft = '', attachments = [] }) => {
    const tab = SB.ensureTab({ id: tabId, title: entry?.title || 'Routine', cwd: entry?.cwd, saved: true, routineId: entry?.routineId, busy, inTerminal: entry?.inTerminal || null });
    for (const item of items || []) tab.render(item, { replay: true });
    // A branch from before a message opens with it back in the box (branching.js).
    if (draft) tab.draft = draft;
    for (const f of attachments) if (typeof f === 'string' && !tab.attachments.includes(f)) tab.attachments.push(f);
    tab.cancelOpenAsks?.();
    if (!background || !state.activeTab) SB.activate(tabId);
    else SB.renderTabStrip();
  });
  api.onTabFocus(tabId => { if (state.tabs.has(tabId)) SB.activate(tabId); });
  api.onNewTabRequest(() => SB.newTab());
  api.onUsage(SB.applyUsage);
  api.onRecap(d => SB.showRecap(d));
  api.onToolbox(tb => { state.toolbox = tb; if (state.view === 'toolbox') SB.views.toolbox.render(); });
  api.onLearned(SB.onLearned);
  api.onSnippets(SB.applySnippets);
  api.onRoutines(list => { state.routines = list; if (state.view === 'routines') SB.views.routines.render(); });
  api.onWorkflows(view => SB.applyWorkflows(view));
  api.onWorkflowRun(summary => SB.onWorkflowRun(summary));
  api.onWorkflowOpen(runId => SB.views.workflows.openRun(runId));
  api.onNotes(v => { state.notes = v; if (state.view === 'notes') SB.views.notes.refresh(); });
  api.onAttach(files => {
    if (SB.isCrabOnly()) return SB.claudeUpsell('files');
    if (state.view !== 'onboarding') SB.setView('chat');
    SB.addAttachments(files);
  });
  api.onFocusInput(() => { if (state.view === 'chat') $('input').focus(); });
  // Push-to-talk: added after whatever's already typed, and not sent.
  api.onDictated(text => {
    const typed = $('input').value.trimEnd();
    SB.prefill(typed ? `${typed} ${text}` : text);
  });
  api.onView(v => SB.setView(v));
  // Nobody is looking: pause what's only there to be looked at. `deep` (the
  // screen is locked, or a game covers the panel) stops the lot; otherwise the
  // spinners and progress that say work is happening keep going. See
  // panelCalm in desktop-layer.js.
  api.onCalm(({ calm, deep }) => {
    document.body.classList.toggle('calm', !!calm);
    document.body.classList.toggle('calm-deep', !!deep);
  });
  // Even in front, the loops (spinners, hops, the drifting light) only need a
  // few frames a second; at the screen's 60 they were most of the panel's GPU,
  // and far more with a game running beside it (shared/framecap.js).
  window.ShellbyFrameCap.cap(document, { filter: window.ShellbyFrameCap.loops });
  api.onSkin(({ skin, outfit }) => {
    state.skin = skin;
    state.outfit = outfit;
    SB.renderCrabs();
    for (const tab of state.tabs.values()) for (const lane of tab.lanes.values()) lane.el.querySelector('.lane-crab')?.replaceChildren(SB.helperSprite(lane.index));
    if (state.view === 'settings') SB.renderSkins();
    if (state.view === 'wardrobe') SB.views.wardrobe.render();
    SB.refreshHealthCrab?.();
  });
  api.onWardrobe(view => SB.applyWardrobe(view));
  api.onHomes(view => SB.applyHomes(view));
  api.onUnlocked(e => SB.onUnlocked(e));
  api.onCollected(items => SB.onCollected(items));
  api.onPackInstalled(r => SB.onPackInstalled(r));
  api.onUpdates(view => {
    const wasReady = state.updates?.state === 'ready';
    state.updates = view;
    SB.renderUpdates();
    // Say it once, when it lands, with the restart a click away.
    if (view.state === 'ready' && !wasReady) {
      SB.toast(`Update ${view.version} is ready.`, { ms: 8000, action: 'Restart and update', onAction: () => api.installUpdate() });
    }
  });
  api.onJump(nav => SB.jumpToSettingByName(nav));
  // `npm run screenshots` drives the UI with scripted data (see src/main/capture.js).
  api.onDemo(demo => {
    for (const tab of state.tabs.values()) tab.destroy();
    state.tabs.clear();
    state.activeTab = null;
    Object.assign(state, { toolbox: demo.toolbox ?? state.toolbox, routines: demo.routines ?? state.routines, learned: demo.learned ?? [], pinned: demo.pinned ?? [] });
    for (const t of demo.tabs) {
      const tab = SB.ensureTab({ id: t.id, title: t.title, cwd: t.cwd, saved: true, busy: t.busy, pending: t.pending, crew: t.crew, outcome: t.outcome, unread: t.unread, routineId: t.routineId });
      for (const item of t.items) tab.render(item, { replay: item.kind !== 'permission' });
      if (t.status) tab.statusText = t.status;
    }
    if (demo.usage) SB.applyUsage(demo.usage);
    SB.activate(demo.active || demo.tabs[0].id);
    SB.refreshEmptyStates();
    SB.clearCelebrations();
    SB.setView(demo.view || 'chat');
    if (demo.slash) { $('input').value = demo.slash; $('input').dispatchEvent(new Event('input')); }
    requestAnimationFrame(() => { const t = SB.activeTab(); if (t && demo.scroll !== 'top') t.el.scrollTop = t.el.scrollHeight; });
  });

  // Routine "next run" times drift into the past while the panel is open.
  setInterval(() => { if (state.view === 'routines' && !document.hidden) api.listRoutines().then(l => { state.routines = l; SB.views.routines.render(); }); }, 60000);

  // ------------------------------------------------------------ boot

  (async function init() {
    const b = await api.bootstrap();
    Object.assign(state, {
      settings: b.settings, status: b.status, skins: b.skins, skin: b.skin, outfit: b.outfit, sessions: b.sessions,
      home: b.home, version: b.version, packaged: b.packaged, models: b.models, cwd: b.cwd, registryUrl: b.registryUrl,
      toolbox: b.toolbox, pinned: b.pinned, learned: b.learned, routines: b.routines, updates: b.updates, claudeUpdate: b.claudeUpdate,
      snippets: b.snippets || [],
    });
    if (b.outlook) SB.applyOutlook(b.outlook);
    SB.renderUpdates(); // an update downloaded before the panel opened is waiting on the gear
    $('settingsFolder').textContent = b.cwd;
    SB.applyMode(state.settings.mode);
    SB.applyEffort?.();
    SB.applyCrabOnly();
    SB.applyUsage(state.settings.lastUsage);
    if (b.homes) SB.applyHomes(b.homes);
    if (b.stickers) SB.applyStickers(b.stickers);
    if (b.wardrobe) SB.applyWardrobe(b.wardrobe);
    if (b.welcomeTrophies?.length) {
      const names = b.welcomeTrophies.map(t => `${t.icon} ${t.name}`).join(', ');
      setTimeout(() => SB.toast(`Welcome to the Wardrobe! Your history already earned: ${names}`, { action: 'Try it on', ms: 8000, onAction: () => SB.setView('wardrobe') }), 1200);
    }
    SB.renderCrabs();

    // Restore tabs that were open last time, then pick one to show.
    for (const s of b.tabs) {
      const tab = SB.ensureTab(s);
      for (const item of b.tabItems[s.id] || []) tab.render(item, { replay: true });
      tab.cancelOpenAsks();
      for (const lane of tab.lanes.values()) if (lane.status === 'running') lane.finish({ ok: true });
    }
    if (state.tabs.size) SB.activate([...state.tabs.keys()].pop());
    else await SB.newTab();

    SB.setView(SB.needsOnboarding() ? 'onboarding' : b.startView || state.view === 'wardrobe' && 'wardrobe' || 'chat');
    performance.mark('shellby:panel-ready'); // booted, tabs back: scripts/perf-budget.js times app-ready to here
  })();
})();
