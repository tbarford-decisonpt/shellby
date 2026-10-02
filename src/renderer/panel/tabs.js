/* Shellby panel — tabs, composer, mode/folder chips, usage meter, slash menu. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const input = $('input');

  // ------------------------------------------------------------ tabs

  let drag = null;   // the tab being dragged along the strip (see "drag to reorder")

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
      worktree: summary.worktree !== undefined ? summary.worktree : tab.worktree || null,
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
    applyFolderLabel(tab.cwd || state.cwd, tab);
    syncBusyUi();
    if (tab.unread) api.seenTab(tabId);
    tab.unread = false;
    SB.renderTabStrip();
    requestAnimationFrame(() => { tab.el.scrollTop = tab.el.scrollHeight; });
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
    const was = [...state.tabs.keys()];
    const rest = was.filter(id => id !== tabId);
    const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
    if (at < 0) return false;                                 // unknown neighbour, or itself
    rest.splice(at, 0, tabId);
    if (rest.every((id, i) => id === was[i])) return false;    // already sitting there
    orderTabs(rest);
    SB.renderTabStrip();
    api.moveTab(tabId, beforeId);
    return true;
  };

  // One place left or right, for the keyboard and the palette.
  SB.nudgeTab = (tabId, step) => {
    const ids = [...state.tabs.keys()];
    const to = ids.indexOf(tabId) + step;
    if (to < 0 || to >= ids.length) return false;
    return SB.moveTab(tabId, ids.filter(id => id !== tabId)[to] ?? null);
  };

  SB.syncTabs = (summaries) => {
    const ids = new Set(summaries.map(s => s.id));
    for (const s of summaries) SB.ensureTab(s);
    // A tab created locally may not be in this snapshot yet; only drop tabs the
    // main process no longer knows about once they've been reported at least once.
    for (const [id, tab] of state.tabs) if (!ids.has(id) && tab.reported) { tab.destroy(); state.tabs.delete(id); }
    for (const s of summaries) { const t = state.tabs.get(s.id); if (t) t.reported = true; }
    // Main owns the order; a tab created here that isn't in the snapshot yet waits
    // at the end. A drag in progress wins, so a background tab reporting progress
    // mid-drag can't snap the strip back from under the pointer.
    if (!drag) orderTabs([...summaries.map(s => s.id).filter(id => state.tabs.has(id)), ...[...state.tabs.keys()].filter(id => !ids.has(id))]);
    if (!state.tabs.has(state.activeTab)) {
      const next = [...state.tabs.keys()].pop();
      if (next) SB.activate(next); else SB.newTab();
    }
    syncBusyUi();
    const active = SB.activeTab();
    if (active) applyFolderLabel(active.cwd || state.cwd, active); // a first message can move it into its own copy
    SB.renderTabStrip();
  };

  // All tab creation funnels through here. Concurrent callers (e.g. closing the
  // last tab while the main process reports "no tabs") share one in-flight
  // request, so they can never produce two blank tabs.
  let creating = null;
  SB.newTab = ({ focus = true } = {}) => {
    const cur = SB.activeTab();
    if (cur && cur.isEmpty && !cur.busy) { if (focus) SB.activate(cur.id); return Promise.resolve(cur); } // reuse a blank tab
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

  // A fresh tab in a known project, with a prompt ready to send (from a nudge).
  SB.newTabIn = async ({ cwd, draft }) => {
    const r = await api.newTab({ cwd });
    if (!r.ok) return SB.toast(r.error);
    SB.ensureTab({ id: r.tabId, title: 'New task', cwd });
    SB.activate(r.tabId);
    input.value = draft || '';
    autosize();
    input.focus();
  };
  api.onNewTabIn(o => { if (o?.cwd) SB.newTabIn(o); });

  SB.closeTab = async (tabId) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    tab.destroy();
    state.tabs.delete(tabId);
    if (state.activeTab === tabId) {
      state.activeTab = null;
      const next = [...state.tabs.keys()].pop();
      if (next) SB.activate(next); else SB.newTab();
    }
    await api.closeTab(tabId);
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
        class: `tab${active ? ' active' : ''}${t.unread && !active ? ' unread' : ''}${t.pending ? ' asking' : ''}${t.id === drag?.id && drag.moved ? ' dragging' : ''}`,
        role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1', title: t.title,
        'data-tab-id': t.id,
        onclick: () => SB.activate(t.id),
        onauxclick: e => { if (e.button === 1) SB.closeTab(t.id); },
        onpointerdown: e => dragStart(e, t.id),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') SB.activate(t.id); },
      },
      tabIcon(t),
      h('span', { class: 'tab-title', text: t.isEmpty && !t.saved ? 'New task' : t.title }),
      h('button', { class: 'tab-x', type: 'button', 'aria-label': `Close ${t.title}`, title: 'Close (Ctrl+W)', onclick: e => { e.stopPropagation(); SB.closeTab(t.id); } }, '×'));
      return btn;
    }));
    // Not while dragging: following the active tab would fight the strip's own
    // scrolling as the dragged tab is pulled past the edge.
    if (!drag) strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Title bar shows total running count at a glance.
    const running = [...state.tabs.values()].filter(t => t.busy).length;
    document.body.classList.toggle('busy', running > 0);
  };
  $('tabs').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  $('newTabBtn').addEventListener('click', () => SB.newTab());

  // ------------------------------------------------------------ drag to reorder

  // The strip reorders live as the pointer crosses a neighbour's midpoint, and the
  // dragged tab keeps its place in the flow (just lifted). Nothing is positioned by
  // hand, so there's nothing to re-apply when a working tab redraws the strip
  // mid-drag — and pointermove/up are on the window, so replacing the tab's element
  // underneath the pointer doesn't cut the drag short.
  const EDGE = 26;            // px from a strip edge where dragging starts scrolling it
  const SLOP = 5;             // px of movement before a click becomes a drag

  function dragStart(e, tabId) {
    if (e.button !== 0 || e.target.closest('.tab-x') || state.tabs.size < 2) return;
    drag = { id: tabId, startX: e.clientX, x: e.clientX, moved: false };
    window.addEventListener('pointermove', dragMove);
    window.addEventListener('pointerup', dragEnd);
    window.addEventListener('pointercancel', dragEnd);
  }

  function dragMove(e) {
    if (!drag) return;
    drag.x = e.clientX;
    // A click that wobbles a few pixels is still a click.
    if (!drag.moved && Math.abs(e.clientX - drag.startX) < SLOP) return;
    if (!drag.moved) {
      drag.moved = true;
      document.body.classList.add('reordering');
      lift();
      requestAnimationFrame(edgeScroll);
    }
    SB.moveTab(drag.id, dropBefore(drag.x));
  }

  function dragEnd() {
    const moved = drag?.moved;
    drag = null;
    window.removeEventListener('pointermove', dragMove);
    window.removeEventListener('pointerup', dragEnd);
    window.removeEventListener('pointercancel', dragEnd);
    if (!moved) return;
    document.body.classList.remove('reordering');
    lift();
    // The click that follows this pointerup is left alone on purpose: you grabbed
    // that tab, so ending up in its conversation is what you asked for. That also
    // means not redrawing the strip here — replacing the element the pointer came
    // up on would lose the click.
  }

  // Marks the dragged tab in place, so starting and ending a drag don't have to
  // redraw the strip. A redraw in between re-applies it from `drag` itself.
  function lift() {
    for (const el of $('tabs').children) el.classList.toggle('dragging', !!drag?.moved && el.dataset.tabId === drag.id);
  }

  // The tab to land in front of: the first whose midpoint is still right of the
  // pointer. Nothing means past them all, i.e. the end of the strip.
  function dropBefore(clientX) {
    for (const el of $('tabs').children) {
      const r = el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return el.dataset.tabId;
    }
    return null;
  }

  // Eight conversations don't fit at the default width, so holding a tab against
  // either edge scrolls the strip until the slot you want comes into view.
  function edgeScroll() {
    if (!drag?.moved) return;
    const strip = $('tabs');
    const r = strip.getBoundingClientRect();
    const dx = drag.x < r.left + EDGE ? -9 : drag.x > r.right - EDGE ? 9 : 0;
    if (dx) {
      strip.scrollLeft += dx;
      SB.moveTab(drag.id, dropBefore(drag.x));
    }
    requestAnimationFrame(edgeScroll);
  }

  // ------------------------------------------------------------ busy / status

  function syncBusyUi() {
    const tab = SB.activeTab();
    const busy = !!tab?.busy;
    $('status').hidden = !busy;
    // While Shellby works you can keep typing: Enter queues the message.
    $('sendBtn').title = busy ? 'Queue: sends when Shellby finishes' : 'Send';
    $('sendBtn').classList.toggle('queueing', busy);
    $('sendHint').textContent = busy ? 'Enter to queue · Shift+Enter new line' : 'Enter to send · Shift+Enter new line';
    if (tab) $('statusText').textContent = busy ? tab.statusText + (tab.queue.length ? ` · ${tab.queue.length} queued` : '') : '';
    renderQueue();
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

  // Send to any tab: the active one, or a background tab draining its queue.
  async function sendNow(tab, text, attachments) {
    const r = await api.sendTask(tab.id, text, attachments);
    if (!r.ok) { SB.toast(r.error); return false; }
    tab.render({ kind: 'user', text, attachments });
    tab.busy = true;
    tab.saved = true;
    tab.statusText = 'Working…';
    if (tab.title === 'New task') tab.title = text.length > 70 ? text.slice(0, 67) + '…' : text || (attachments.every(f => /\.(png|jpe?g|gif|webp)$/i.test(f)) ? 'Screenshot' : 'Attached files');
    if (tab.isActive) syncBusyUi();
    SB.renderTabStrip();
    return true;
  }

  function clearComposer(tab) {
    input.value = '';
    tab.attachments = [];
    renderAttachments();
    autosize();
  }

  SB.send = async (text) => {
    const tab = SB.activeTab();
    if (!tab) return;
    text = (text ?? input.value).trim();
    if (!text && !tab.attachments.length) return;
    const attachments = [...tab.attachments];
    if (tab.busy) {
      tab.queue.push({ text, attachments });
      clearComposer(tab);
      syncBusyUi();
      return;
    }
    if (await sendNow(tab, text, attachments)) {
      clearComposer(tab);
      SB.setView('chat');
    }
  };

  // ------------------------------------------------------------ queued messages

  function renderQueue() {
    const tab = SB.activeTab();
    const q = tab?.queue || [];
    const box = $('queued');
    box.hidden = !q.length;
    if (!q.length) { box.replaceChildren(); return; }
    box.replaceChildren(...[
      tab.queuePaused ? h('div', { class: 'queue-paused' },
        h('span', { text: 'Paused: the last turn ended with an error.' }),
        h('button', { class: 'btn slim-btn', type: 'button', onclick: () => { tab.queuePaused = false; drain(tab); } }, 'Send next now')) : null,
      ...q.map((m, i) => h('div', { class: 'queue-item' },
        h('span', { class: 'queue-tag', text: i === 0 ? 'Next' : `#${i + 1}` }),
        h('button', { class: 'queue-text', type: 'button', title: 'Edit (puts it back in the box)', onclick: () => editQueued(tab, i) },
          m.text || `${m.attachments.length} attached file${m.attachments.length === 1 ? '' : 's'}`),
        h('button', { class: 'queue-x icon-btn', type: 'button', 'aria-label': 'Remove from queue', onclick: () => { tab.queue.splice(i, 1); syncBusyUi(); } },
          SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })))),
    ].filter(Boolean));
  }

  // Pull a queued message back into the box to edit (whatever was typed there is queued in its place).
  function editQueued(tab, i) {
    const [m] = tab.queue.splice(i, 1);
    if (input.value.trim() || tab.attachments.length) tab.queue.splice(i, 0, { text: input.value.trim(), attachments: [...tab.attachments] });
    input.value = m.text;
    tab.attachments = [...m.attachments];
    renderAttachments();
    autosize();
    syncBusyUi();
    input.focus();
  }

  async function drain(tab) {
    if (tab.busy || tab.queuePaused || !tab.queue.length) return;
    const next = tab.queue.shift();
    if (!(await sendNow(tab, next.text, next.attachments))) tab.queue.unshift(next);
    if (tab.isActive) syncBusyUi();
  }

  // A turn ended: send the next queued message, or hand the queue back after Stop.
  SB.onTurnEnded = (tab, result) => {
    if (!tab.queue.length) return;
    if (result.interrupted) {
      const back = tab.queue.map(m => m.text).filter(Boolean).join('\n\n');
      const files = tab.queue.flatMap(m => m.attachments);
      tab.queue = [];
      if (tab.isActive) {
        input.value = [input.value.trim(), back].filter(Boolean).join('\n\n');
        for (const f of files) if (!tab.attachments.includes(f)) tab.attachments.push(f);
        renderAttachments();
        autosize();
        syncBusyUi();
        SB.toast('Stopped. Your queued messages are back in the box.');
      } else {
        tab.draft = [tab.draft, back].filter(Boolean).join('\n\n');
      }
      return;
    }
    if (!result.ok) { tab.queuePaused = true; if (tab.isActive) syncBusyUi(); return; }
    drain(tab);
  };

  $('form').addEventListener('submit', e => { e.preventDefault(); SB.send(); });
  input.addEventListener('keydown', e => {
    if (slashKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); SB.send(); }
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); SB.cycleMode(); return; }
    // Up in an empty box pulls back the last queued message, like Claude Code.
    const tab = SB.activeTab();
    if (e.key === 'ArrowUp' && !input.value && tab?.queue.length) { e.preventDefault(); editQueued(tab, tab.queue.length - 1); }
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
    // Reordering from the keyboard, where a browser puts it too — and the only way
    // to do it without a pointer.
    if (e.ctrlKey && e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      if (tab) SB.nudgeTab(tab.id, e.key === 'PageUp' ? -1 : 1);
      return;
    }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const ids = [...state.tabs.keys()];
      const i = ids.indexOf(state.activeTab);
      SB.activate(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
      return;
    }
    if (e.key === 'Escape') {
      if (!$('slashMenu').hidden || !$('modeMenu').hidden || !$('folderMenu').hidden || !$('branchMenu').hidden) return SB.closeMenus();
      if (tab?.busy && state.view === 'chat') return stop();
      if (state.view !== SB.homeView() && state.view !== 'onboarding') return SB.goBack();
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
    attachFrom(e.dataTransfer.files);
  });

  // A picture with no file behind it (a snip, an image out of a browser) is saved
  // by main first, so everything attached ends up as a path.
  async function attachFrom(files) {
    const { paths, error } = await api.attachFiles([...files]); // a FileList doesn't cross the bridge; an array of Files does
    if (error) SB.toast(error);
    if (paths.length) { SB.setView('chat'); SB.addAttachments(paths); }
  }

  // Ctrl+V a Win+Shift+S snip (or files copied in Explorer) straight into the
  // composer. Anything that also carries text (a cell out of Excel brings a
  // picture of itself along) pastes as text, the way it always did.
  input.addEventListener('paste', e => {
    const data = e.clipboardData;
    if (!data?.files.length || data.getData('text/plain')) return;
    e.preventDefault();
    attachFrom(data.files);
  });

  $('attachBtn').addEventListener('click', async () => {
    const paths = await api.pickFiles();
    if (paths.length) SB.addAttachments(paths);
    else input.focus();
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

  // Shift+Tab in the composer steps through the modes, like Claude Code. Autonomous
  // stays out of the loop: holding a key down should never land on "never asks".
  // The chip flips before the save so quick presses build on each other.
  const CYCLE = SB.MODES.map(m => m.id).filter(id => id !== 'autonomous');
  SB.cycleMode = () => {
    const next = CYCLE[(CYCLE.indexOf(document.body.dataset.mode) + 1) % CYCLE.length];
    SB.applyMode(next);
    return SB.chooseMode(next);
  };

  $('modeChip').addEventListener('click', () => SB.openMenu($('modeMenu'), $('modeChip'), () => SB.MODES.map(m =>
    h('button', { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(state.settings.mode === m.id), onclick: () => { SB.closeMenus(); SB.chooseMode(m.id); } },
      h('span', { class: 'mi-check', text: state.settings.mode === m.id ? '●' : '' }),
      h('span', {}, h('div', { class: 'mi-title', text: m.title }), h('div', { class: 'mi-sub', text: m.sub }))))));

  // ------------------------------------------------------------ folder chip

  // A tab in its own copy (worktrees.js) still shows the project you know,
  // with the branch beside it, rather than a path inside Shellby's folder.
  function applyFolderLabel(cwd, tab = null) {
    const w = tab?.worktree;
    const shown = w?.originalCwd || cwd;
    $('folderLabel').textContent = SB.shortPath(shown);
    $('folderChip').title = w ? `Working folder: ${shown}\nThis conversation works in its own copy: ${cwd}` : `Working folder: ${cwd}`;
    $('branchChip').hidden = !w;
    if (w) {
      $('branchLabel').textContent = w.branch.replace(/^shellby\//, '');
      $('branchChip').title = `Its own copy, on branch ${w.branch} (from ${w.base})`;
    }
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

  // ------------------------------------------------------------ its own copy (worktrees.js)

  $('branchChip').addEventListener('click', () => {
    const tab = SB.activeTab();
    const w = tab?.worktree;
    if (!w) return;
    const status = h('span', { class: 'mi-sub', text: 'Looking at the copy…' });
    api.worktreeStatus(tab.id).then(s => {
      if (!s?.ok) { status.textContent = s?.error || ''; return; }
      const bits = [];
      if (s.ahead) bits.push(`${s.ahead} commit${s.ahead === 1 ? '' : 's'}`);
      if (s.uncommitted) bits.push(`${s.uncommitted} uncommitted file${s.uncommitted === 1 ? '' : 's'}`);
      status.textContent = (bits.length ? `${bits.join(' and ')} not in ${w.base} yet.` : 'Nothing new in it yet.')
        + (s.ignored?.length ? ` Ignored files (${s.ignored.slice(0, 3).join(', ')}${s.ignored.length > 3 ? '…' : ''}) go with the copy.` : '');
    });
    SB.openMenu($('branchMenu'), $('branchChip'), () => [
      h('div', { class: 'menu-label', text: 'This conversation works in its own copy' }),
      h('div', { class: 'menu-item branch-info' },
        h('span', { class: 'mi-check', 'aria-hidden': 'true' }),
        h('span', {}, h('div', { class: 'mi-branch', text: w.branch }), h('div', { class: 'mi-sub', text: `from ${w.base}` }), status)),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); bringHome(tab); } },
        h('span', { class: 'mi-check', text: '↩' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Bring it home' }), h('div', { class: 'mi-sub', text: `Commit what's left, merge into ${w.base}, tidy the copy away` }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); throwAway(tab); } },
        h('span', { class: 'mi-check', text: '✕' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Throw it away' }), h('div', { class: 'mi-sub', text: 'Delete the copy and its branch, without merging' }))),
    ]);
  });

  async function bringHome(tab) {
    if (tab.busy) return SB.toast('Let him finish first.');
    SB.toast('Bringing it home…', { ms: 8000 });
    const r = await api.bringWorktreeHome(tab.id);
    if (r?.ok) {
      await SB.closeTab(tab.id);
      SB.toast(r.merged ? `Merged ${r.commits} commit${r.commits === 1 ? '' : 's'} into ${r.base}. The conversation is in History.` : 'Nothing new to merge, so the copy was just tidied away.', { ms: 6000 });
      return;
    }
    if (r?.conflict) {
      // Nothing was merged; the copy's own branch is the safe place to sort it out.
      SB.toast(r.error, { ms: 12000, action: 'Ask him to sort it out', onAction: () => {
        SB.activate(tab.id);
        SB.send(`Merge ${tab.worktree.base} into this branch (git merge ${tab.worktree.base}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready to bring home.`);
      } });
      return;
    }
    SB.toast(r?.error || "Couldn't bring it home.", { ms: 8000 });
  }

  let discardArmed = null;
  async function throwAway(tab) {
    if (discardArmed !== tab.id) {
      discardArmed = tab.id;
      setTimeout(() => { if (discardArmed === tab.id) discardArmed = null; }, 6000);
      SB.toast('Throw away everything this copy did? Its branch is deleted too.', { ms: 6000, action: 'Throw it away', onAction: () => throwAway(tab) });
      return;
    }
    discardArmed = null;
    const r = await api.discardWorktree(tab.id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't remove the copy.", { ms: 8000 });
    await SB.closeTab(tab.id);
    SB.toast('Thrown away. The conversation is still in History.');
  }

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

  // The plan's usage limit: Shellby naps until it resets, then says so (src/main/limits.js).
  api.onLimit(e => {
    if (e.phase === 'hit') SB.toast(`Your ${e.name} Claude limit is reached. Shellby will tap you when it resets, ${e.at}.`, { ms: 8000 });
    if (e.phase === 'reset') SB.toast(`Your ${e.name} limit just reset. Go ahead!`, { ms: 6000 });
  });
})();
