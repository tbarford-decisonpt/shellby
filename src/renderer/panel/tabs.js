/* Shellby panel — tabs, composer, mode/folder chips, usage meter, slash menu. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const input = $('input');

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
      title: summary.title ?? tab.title, cwd: summary.cwd ?? tab.cwd, busy: !!summary.busy,
      pending: summary.pending || 0, crew: summary.crew || 0, outcome: summary.outcome ?? tab.outcome,
      unread: !!summary.unread, saved: summary.saved ?? tab.saved, routineId: summary.routineId ?? tab.routineId,
    });
    return tab;
  };

  SB.activate = (tabId) => {
    const prev = SB.activeTab();
    if (prev) { prev.draft = input.value; }
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    state.activeTab = tabId;
    for (const t of state.tabs.values()) t.el.hidden = t !== tab;
    input.value = tab.draft || '';
    autosize();
    renderAttachments();
    applyFolderLabel(tab.cwd || state.cwd);
    syncBusyUi();
    if (tab.unread) api.seenTab(tabId);
    tab.unread = false;
    SB.renderTabStrip();
    requestAnimationFrame(() => { tab.el.scrollTop = tab.el.scrollHeight; });
    if (state.view !== 'chat') SB.setView('chat'); else input.focus();
  };

  SB.syncTabs = (summaries) => {
    const ids = new Set(summaries.map(s => s.id));
    for (const s of summaries) SB.ensureTab(s);
    for (const [id, tab] of state.tabs) if (!ids.has(id)) { tab.destroy(); state.tabs.delete(id); }
    if (!state.tabs.has(state.activeTab)) {
      const next = [...state.tabs.keys()].pop();
      if (next) SB.activate(next); else SB.newTab();
    }
    syncBusyUi();
    SB.renderTabStrip();
  };

  SB.newTab = async ({ focus = true } = {}) => {
    const cur = SB.activeTab();
    if (cur && cur.isEmpty && !cur.busy) { if (focus) SB.activate(cur.id); return cur; } // reuse a blank tab
    const r = await api.newTab();
    if (!r.ok) { SB.toast(r.error); return null; }
    const tab = SB.ensureTab({ id: r.tabId, title: 'New task', cwd: state.cwd });
    if (focus) SB.activate(r.tabId);
    return tab;
  };

  SB.closeTab = async (tabId) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    await api.closeTab(tabId);
    tab.destroy();
    state.tabs.delete(tabId);
    if (state.activeTab === tabId) {
      const next = [...state.tabs.keys()].pop();
      if (next) SB.activate(next); else await SB.newTab();
    }
    SB.renderTabStrip();
    if (tab.saved) SB.toast('Closed. It is still in History.');
  };

  function tabIcon(t) {
    if (t.pending) return h('span', { class: 'ti ti-ask', title: 'Needs your OK', text: '?' });
    if (t.busy || t.crew) return h('span', { class: 'ti ti-busy', title: t.crew ? `${t.crew} helper${t.crew > 1 ? 's' : ''} working` : 'Working' }, t.crew ? h('b', { text: t.crew }) : null);
    if (t.outcome === 'error') return h('span', { class: 'ti ti-err', title: 'Ended with an error', text: '!' });
    if (t.outcome === 'ok' && t.unread) return h('span', { class: 'ti ti-ok', title: 'Finished', text: '✓' });
    if (t.routineId) return h('span', { class: 'ti ti-routine', title: 'Routine', text: '⟳' });
    return null;
  }

  SB.renderTabStrip = () => {
    const strip = $('tabs');
    strip.replaceChildren(...[...state.tabs.values()].map(t => {
      const active = t.id === state.activeTab;
      const btn = h('div', {
        class: `tab${active ? ' active' : ''}${t.unread && !active ? ' unread' : ''}${t.pending ? ' asking' : ''}`,
        role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1', title: t.title,
        onclick: () => SB.activate(t.id),
        onauxclick: e => { if (e.button === 1) SB.closeTab(t.id); },
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') SB.activate(t.id); },
      },
      tabIcon(t),
      h('span', { class: 'tab-title', text: t.isEmpty && !t.saved ? 'New task' : t.title }),
      h('button', { class: 'tab-x', type: 'button', 'aria-label': `Close ${t.title}`, title: 'Close (Ctrl+W)', onclick: e => { e.stopPropagation(); SB.closeTab(t.id); } }, '×'));
      return btn;
    }));
    strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Title bar shows total running count at a glance.
    const running = [...state.tabs.values()].filter(t => t.busy).length;
    document.body.classList.toggle('busy', running > 0);
  };
  $('tabs').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  $('newTabBtn').addEventListener('click', () => SB.newTab());

  // ------------------------------------------------------------ busy / status

  function syncBusyUi() {
    const tab = SB.activeTab();
    const busy = !!tab?.busy;
    $('status').hidden = !busy;
    $('sendBtn').disabled = busy;
    if (tab) $('statusText').textContent = busy ? tab.statusText : '';
  }
  SB.syncBusyUi = syncBusyUi;

  // ------------------------------------------------------------ composer

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input.addEventListener('input', () => { autosize(); updateSlash(); });

  function renderAttachments() {
    const tab = SB.activeTab();
    const files = tab ? tab.attachments : [];
    $('attachments').hidden = !files.length;
    $('attachments').replaceChildren(...SB.attachmentChips(files, i => { files.splice(i, 1); renderAttachments(); }));
  }
  SB.addAttachments = files => {
    const tab = SB.activeTab();
    if (!tab) return;
    for (const f of files) if (!tab.attachments.includes(f)) tab.attachments.push(f);
    renderAttachments();
    input.focus();
  };

  SB.send = async (text) => {
    const tab = SB.activeTab();
    if (!tab) return;
    text = (text ?? input.value).trim();
    if ((!text && !tab.attachments.length) || tab.busy) return;
    const attachments = [...tab.attachments];
    const r = await api.sendTask(tab.id, text, attachments);
    if (!r.ok) return SB.toast(r.error);
    tab.render({ kind: 'user', text, attachments });
    tab.busy = true;
    tab.saved = true;
    tab.statusText = 'Working…';
    if (tab.title === 'New task') tab.title = text.length > 70 ? text.slice(0, 67) + '…' : text || 'Attached files';
    input.value = '';
    tab.attachments = [];
    renderAttachments();
    autosize();
    syncBusyUi();
    SB.renderTabStrip();
    SB.setView('chat');
  };

  $('form').addEventListener('submit', e => { e.preventDefault(); SB.send(); });
  input.addEventListener('keydown', e => {
    if (slashKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); SB.send(); }
  });
  $('stopBtn').addEventListener('click', stop);
  function stop() {
    const tab = SB.activeTab();
    if (!tab?.busy) return;
    api.stopTask(tab.id);
    tab.setStatus('Stopping…');
  }

  document.addEventListener('keydown', e => {
    const tab = SB.activeTab();
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); SB.newTab(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (tab) SB.closeTab(tab.id); return; }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const ids = [...state.tabs.keys()];
      const i = ids.indexOf(state.activeTab);
      SB.activate(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
      return;
    }
    if (e.key === 'Escape') {
      if (!$('slashMenu').hidden || !$('modeMenu').hidden || !$('folderMenu').hidden) return SB.closeMenus();
      if (tab?.busy && state.view === 'chat') return stop();
      if (state.view !== 'chat' && state.view !== 'onboarding') return SB.setView('chat');
      return api.hide();
    }
    // Y / A / N answer the newest open permission card in the active tab.
    if (e.target.closest('textarea, input, select') || e.ctrlKey || e.metaKey || e.altKey || state.view !== 'chat') return;
    const open = tab?.openAsk();
    const btn = open?.querySelector(`[data-key="${e.key.toLowerCase()}"]`);
    if (btn) { e.preventDefault(); btn.click(); }
  });

  // drag files onto the panel too
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    const paths = api.pathsForFiles(e.dataTransfer.files);
    if (paths.length) { SB.setView('chat'); SB.addAttachments(paths); }
  });

  // ------------------------------------------------------------ slash menu (skills + commands)

  let slashItems = [];
  let slashIndex = 0;

  function slashCandidates(q) {
    const tb = state.toolbox;
    if (!tb) return [];
    const all = [...tb.skills.map(t => ({ ...t, kind: 'skill' })), ...tb.commands.map(t => ({ ...t, kind: 'command' }))];
    const seen = new Set();
    const pinned = new Set((state.pinned || []).map(p => `${p.kind}:${p.name}`));
    return all
      .filter(t => { const k = t.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(t => {
        const n = t.name.toLowerCase();
        const score = pinned.has(`${t.kind}:${t.name}`) ? -1 : n.startsWith(q) ? 0 : n.includes(q) ? 1 : (t.description || '').toLowerCase().includes(q) ? 2 : 9;
        return { t, score };
      })
      .filter(x => x.score < 9 && (x.score >= 0 || !q || x.t.name.toLowerCase().includes(q)))
      .sort((a, b) => a.score - b.score || a.t.name.localeCompare(b.t.name))
      .slice(0, 8)
      .map(x => x.t);
  }

  function updateSlash() {
    const m = input.value.match(/^\/([\w:.-]*)$/);
    if (!m) return SB.hideSlash();
    slashItems = slashCandidates(m[1].toLowerCase());
    slashIndex = 0;
    renderSlash();
  }

  function renderSlash() {
    const menu = $('slashMenu');
    if (!slashItems.length) return SB.hideSlash();
    menu.hidden = false;
    menu.replaceChildren(...slashItems.map((t, i) => h('button', {
      type: 'button', role: 'option', class: `slash-item${i === slashIndex ? ' on' : ''}`, 'aria-selected': String(i === slashIndex),
      onmousedown: e => { e.preventDefault(); pickSlash(i); },
    }, h('span', { class: 'slash-name' }, '/', t.name), h('span', { class: `kind-pill k-${t.kind}`, text: t.kind }), h('span', { class: 'slash-desc', text: t.description || '' }))));
  }

  function pickSlash(i) {
    const t = slashItems[i];
    if (!t) return;
    input.value = `/${t.name} `;
    SB.hideSlash();
    autosize();
    input.focus();
  }

  function slashKeydown(e) {
    if ($('slashMenu').hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
      renderSlash();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashIndex); return true; }
    return false;
  }

  SB.hideSlash = () => { $('slashMenu').hidden = true; };
  SB.useTool = (t) => {
    SB.setView('chat');
    const prefix = t.kind === 'agent' ? `Use the ${t.name} agent to ` : `/${t.name} `;
    input.value = prefix + input.value.replace(/^\/\S*\s*/, '');
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  // ------------------------------------------------------------ mode chip

  SB.applyMode = (mode) => {
    document.body.dataset.mode = mode;
    const m = SB.MODES.find(x => x.id === mode) || SB.MODES[0];
    $('modeLabel').textContent = m.chip;
    $('modeHint').textContent = SB.MODE_HINTS[mode] || '';
    $('modeHint').classList.toggle('danger', mode === 'autonomous');
  };

  SB.chooseMode = async (mode, { quiet = false } = {}) => {
    if (mode === 'autonomous' && !state.settings.autonomousAcknowledged) {
      SB.setView('settings');
      $('autonomousConfirm').hidden = false;
      $('autonomousConfirm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const r = await api.setSettings({ mode });
    state.settings = r.settings;
    SB.applyMode(state.settings.mode);
    if (state.view === 'settings') SB.views.settings.render();
    if (!quiet) SB.toast(`Mode: ${SB.MODES.find(x => x.id === state.settings.mode).title} (all open conversations)`);
  };

  $('modeChip').addEventListener('click', () => SB.openMenu($('modeMenu'), $('modeChip'), () => SB.MODES.map(m =>
    h('button', { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(state.settings.mode === m.id), onclick: () => { SB.closeMenus(); SB.chooseMode(m.id); } },
      h('span', { class: 'mi-check', text: state.settings.mode === m.id ? '●' : '' }),
      h('span', {}, h('div', { class: 'mi-title', text: m.title }), h('div', { class: 'mi-sub', text: m.sub }))))));

  // ------------------------------------------------------------ folder chip

  function applyFolderLabel(cwd) {
    $('folderLabel').textContent = SB.shortPath(cwd);
    $('folderChip').title = `Working folder: ${cwd}`;
  }
  SB.applyFolderLabel = applyFolderLabel;

  SB.folderChanged = async (r) => {
    if (!r) return;
    if (r.error) return SB.toast(r.error);
    state.settings = r.settings;
    state.cwd = r.cwd;
    $('settingsFolder').textContent = r.cwd;
    // A blank tab moves to the new folder; a conversation in progress keeps its own.
    const tab = SB.activeTab();
    if (tab && tab.isEmpty && !tab.busy) {
      await api.closeTab(tab.id);
      tab.destroy();
      state.tabs.delete(tab.id);
      state.activeTab = null;
      await SB.newTab();
      SB.toast(`Now working in ${SB.basename(r.cwd)}`);
    } else {
      applyFolderLabel(tab?.cwd || r.cwd);
      SB.toast(`New conversations will start in ${SB.basename(r.cwd)}`, { action: 'Open one', onAction: () => SB.newTab() });
    }
  };

  $('folderChip').addEventListener('click', () => SB.openMenu($('folderMenu'), $('folderChip'), () => {
    const tab = SB.activeTab();
    const here = tab?.cwd || state.cwd;
    const recents = (state.settings.recentFolders || []).filter(d => d.toLowerCase() !== (here || '').toLowerCase());
    return [
      h('div', { class: 'menu-label', text: tab && !tab.isEmpty ? 'This conversation works in' : 'Working in' }),
      h('div', { class: 'menu-item path', text: here }),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: async () => { SB.closeMenus(); SB.folderChanged(await api.pickFolder()); } }, h('span', { class: 'mi-check', text: '+' }), h('span', { class: 'mi-title', text: 'Choose folder…' })),
      recents.length ? h('div', { class: 'menu-label', text: 'Recent' }) : null,
      ...recents.map(d => h('button', { class: 'menu-item path', title: d, onclick: async () => { SB.closeMenus(); SB.folderChanged(await api.setFolder(d)); } }, SB.tildify(d))),
    ];
  }));

  // ------------------------------------------------------------ usage meter

  SB.applyUsage = (u) => {
    if (!u || (!u.fiveHour && !u.sevenDay)) return;
    $('usage').hidden = false;
    const set = (el, win, name) => {
      if (!win) { el.hidden = true; return; }
      el.hidden = false;
      el.querySelector('.meter-fill').style.transform = `scaleX(${Math.min(100, win.pct) / 100})`;
      el.classList.toggle('warn', win.pct >= 70 && win.pct < 90);
      el.classList.toggle('hot', win.pct >= 90);
      const reset = win.resetsAt ? ` · resets ${new Date(win.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
      el.title = `${name} usage: ${win.pct}%${reset}`;
    };
    set($('meter5h'), u.fiveHour, '5-hour');
    set($('meter7d'), u.sevenDay, 'Weekly');
  };
})();
