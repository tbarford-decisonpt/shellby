/* Shellby panel — tabs, composer, mode/folder chips, usage meter, slash menu. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const input = $('input');

  // ------------------------------------------------------------ tabs

  let drag = null;   // the tab being dragged along the strip (see "drag to reorder")
  let renaming = null;  // the tab whose name is being edited in the strip (see "rename")

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
      pending: summary.pending || 0, crew: summary.crew || 0, outcome: summary.outcome ?? tab.outcome,
      unread: !!summary.unread, saved: summary.saved ?? tab.saved, named: summary.named ?? tab.named, routineId: summary.routineId ?? tab.routineId,
      worktree: summary.worktree !== undefined ? summary.worktree : tab.worktree || null,
      branchOf: summary.branchOf !== undefined ? summary.branchOf : tab.branchOf || null,
      context: summary.context !== undefined ? summary.context : tab.context || null,
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
    syncContextUi();
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
    if (active) applyFolderLabel(active.cwd || state.cwd, active); // its first change can move it into its own copy
    syncContextUi();
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
    // Redrawing would throw away the name being typed; finishing the edit redraws.
    if (renaming && strip.querySelector('.title-edit')) return;
    strip.replaceChildren(...[...state.tabs.values()].map(t => {
      const active = t.id === state.activeTab;
      const btn = h('div', {
        class: `tab${active ? ' active' : ''}${t.unread && !active ? ' unread' : ''}${t.pending ? ' asking' : ''}${t.id === drag?.id && drag.moved ? ' dragging' : ''}`,
        role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1',
        title: [t.title, t.branchOf ? `Branched from "${t.branchOf.title}"` : null, t.context ? contextText(t.context) : null].filter(Boolean).join('\n'),
        'data-tab-id': t.id,
        onclick: () => SB.activate(t.id),
        onauxclick: e => { if (e.button === 1) SB.closeTab(t.id); },
        onpointerdown: e => dragStart(e, t.id),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') SB.activate(t.id); else if (e.key === 'F2') { e.preventDefault(); SB.renameTab(t.id); } },
      },
      tabIcon(t),
      h('span', { class: 'tab-title', text: shownTitle(t) }),
      h('button', { class: 'tab-x', type: 'button', 'aria-label': `Close ${t.title}`, title: 'Close (Ctrl+W)', onclick: e => { e.stopPropagation(); SB.closeTab(t.id); } }, '×'),
      t.context ? h('span', { class: `tab-ctx ${contextLevel(t.context)}`, 'aria-hidden': 'true', style: `--fill: ${t.context.pct / 100}` }) : null);
      return btn;
    }));
    // Not while dragging: following the active tab would fight the strip's own
    // scrolling as the dragged tab is pulled past the edge.
    if (!drag) strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Title bar shows total running count at a glance.
    const running = [...state.tabs.values()].filter(t => t.busy).length;
    document.body.classList.toggle('busy', running > 0);
  };
  const shownTitle = t => t.isEmpty && !t.saved && !t.named ? 'New task' : t.title;

  // ------------------------------------------------------------ rename

  // Double-click a tab (or F2 on it) to name it. Watched on the strip rather than
  // with dblclick on the tab, because the first click activates the tab, which
  // redraws the strip, and the second click lands on a different element.
  const DOUBLE_MS = 400;
  let lastClick = null;
  $('tabs').addEventListener('click', e => {
    const el = e.target.closest('.tab');
    if (!el || e.target.closest('.tab-x, .title-edit')) return;
    const id = el.dataset.tabId;
    const again = lastClick && lastClick.id === id && e.timeStamp - lastClick.at < DOUBLE_MS;
    lastClick = again ? null : { id, at: e.timeStamp };
    if (again) SB.renameTab(id);
  });

  SB.renameTab = (tabId) => {
    const tab = state.tabs.get(tabId);
    const el = [...$('tabs').children].find(c => c.dataset.tabId === tabId)?.querySelector('.tab-title');
    if (!tab || !el || renaming) return;
    renaming = tabId;
    SB.editTitle(el, shownTitle(tab), async title => {
      renaming = null;
      if (title) {
        tab.title = title;
        if (!tab.saved) tab.named = true;
        state.sessions = await api.renameSession(tabId, title);
      }
      SB.renderTabStrip();
      if (state.view === 'history') SB.views.history.redraw?.();
    });
  };

  // Swaps `el` for a text field holding `current`. Enter or leaving the field
  // saves, Escape doesn't; done(name) gets the new name, or null for no change.
  SB.editTitle = (el, current, done) => {
    const field = h('input', { class: 'title-edit', type: 'text', maxlength: 70, spellcheck: 'false', 'aria-label': 'Conversation name' });
    field.value = current;
    let over = false;
    const finish = save => {
      if (over) return;
      over = true;
      const name = field.value.replace(/\s+/g, ' ').trim();
      done(save && name && name !== current ? name : null);
    };
    field.addEventListener('keydown', e => {
      e.stopPropagation(); // Escape, Ctrl+W and friends belong to the field while it's open
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    field.addEventListener('blur', () => finish(true));
    // Not a click on the tab or row underneath, and not the start of a drag.
    for (const type of ['click', 'pointerdown', 'auxclick']) field.addEventListener(type, e => e.stopPropagation());
    el.replaceWith(field);
    field.focus();
    field.select();
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
    tickClock();
    renderQueue();
  }

  // How long the current prompt has been running, like Claude Code's "(12s · esc
  // to interrupt)". One timer, alive only while the tab on screen is working.
  let clockTimer = null;
  function tickClock() {
    const tab = SB.activeTab();
    const since = tab?.busy && tab.busySince;
    $('statusTime').textContent = since ? SB.clock(Date.now() - since) : '';
    if (since && !clockTimer) clockTimer = setInterval(tickClock, 1000);
    if (!since && clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }
  SB.syncBusyUi = syncBusyUi;

  // ------------------------------------------------------------ composer

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input.addEventListener('input', () => { autosize(); updateSlash(); SB.composerInput?.(); });
  SB.autosize = autosize;

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
    // !! is how a message that starts with ! reaches Claude; it shows (and is sent) with one.
    tab.render({ kind: 'user', text: text.startsWith('!!') ? text.slice(1) : text, attachments, turnId: r.turnId });
    SB.notePrompt?.(text);
    tab.busy = true;
    tab.busySince = Date.now();
    tab.saved = true;
    tab.statusText = 'Working…';
    if (tab.title === 'New task' && !tab.named) tab.title = text.length > 70 ? text.slice(0, 67) + '…' : text || (attachments.every(f => /\.(png|jpe?g|gif|webp)$/i.test(f)) ? 'Screenshot' : 'Attached files');
    if (tab.isActive) syncBusyUi();
    SB.renderTabStrip();
    return true;
  }

  function clearComposer(tab) {
    input.value = '';
    tab.attachments = [];
    renderAttachments();
    autosize();
    SB.composerInput?.();
  }
  SB.clearComposer = clearComposer;
  SB.renderAttachments = renderAttachments;

  SB.send = async (text) => {
    const tab = SB.activeTab();
    if (!tab) return;
    text = (text ?? input.value).trim();
    if (!text && !tab.attachments.length) return;
    const attachments = [...tab.attachments];
    // /export, /rewind, ! commands and friends happen here, not in Claude (composer.js).
    if (!attachments.length && SB.runLocal?.(text, tab)) { clearComposer(tab); return; }
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
    if (SB.pickKeydown?.(e)) return;
    if (slashKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); SB.send(); }
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); SB.cycleMode(); return; }
    // Up in an empty box pulls back the last queued message, like Claude Code.
    const tab = SB.activeTab();
    if (e.key === 'ArrowUp' && !input.value && tab?.queue.length) { e.preventDefault(); editQueued(tab, tab.queue.length - 1); return; }
    // Otherwise Up and Down walk back through what you've sent before.
    SB.historyKeydown?.(e);
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
      if (['slashMenu', 'pickMenu', 'modeMenu', 'folderMenu', 'branchMenu', 'ctxMenu', 'usageMenu', 'effortMenu', 'rewindMenu'].some(id => !$(id).hidden)) return SB.closeMenus();
      if (tab?.busy && state.view === 'chat') return stop();
      // Esc twice, like the terminal: back to an earlier message (composer.js).
      if (state.view === 'chat' && SB.escRewind?.(tab, e)) return;
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
  // Only files: dragging a sticker onto his shell (stickers.js) is not an attachment.
  const carriesFiles = e => !!e.dataTransfer?.types?.includes('Files');
  window.addEventListener('dragenter', e => { if (!carriesFiles(e)) return; e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', e => { if (!carriesFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    if (e.dataTransfer.files.length) attachFrom(e.dataTransfer.files);
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
    const tb = state.toolbox || { skills: [], commands: [] };
    // Shellby's own commands come first, so a skill with the same name can't hide them.
    const all = [...(SB.LOCAL_COMMANDS || []), ...tb.skills.map(t => ({ ...t, kind: 'skill' })), ...tb.commands.map(t => ({ ...t, kind: 'command' }))];
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
    // Typed out in full, Enter runs it, like the terminal; otherwise it completes the name.
    if (e.key === 'Enter' && input.value.trim().toLowerCase() === `/${slashItems[slashIndex]?.name}`.toLowerCase()) { SB.hideSlash(); return false; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashIndex); return true; }
    return false;
  }

  SB.hideSlash = () => { $('slashMenu').hidden = true; };
  // Put text in the box (not sent) with the caret at the end, ready to add to.
  SB.prefill = (text) => {
    SB.setView('chat');
    input.value = text;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  SB.useTool = (t) => {
    const prefix = t.kind === 'agent' ? `Use the ${t.name} agent to ` : `/${t.name} `;
    SB.prefill(prefix + input.value.replace(/^\/\S*\s*/, ''));
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
      SB.showSettingsTab('claude');
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
      ...repoItems(tab),
    ];
  }));

  // ------------------------------------------------------------ the repository: push it, bring every copy home

  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

  // Filled in as the status comes back: first as of the last fetch, then
  // again once the remote has been asked.
  function repoItems(tab) {
    const sep = h('div', { class: 'menu-sep', hidden: true });
    const label = h('div', { class: 'menu-label', text: 'This repository', hidden: true });
    const pushTitle = h('div', { class: 'mi-title', text: 'Push' });
    const pushSub = h('div', { class: 'mi-sub' });
    const pushBtn = h('button', { class: 'menu-item', hidden: true, disabled: true, onclick: () => { SB.closeMenus(); pushRepo(tab); } },
      h('span', { class: 'mi-check', text: '⇡' }), h('span', {}, pushTitle, pushSub));
    const homeSub = h('div', { class: 'mi-sub' });
    const homeBtn = h('button', { class: 'menu-item', hidden: true, onclick: () => { SB.closeMenus(); bringAll(tab); } },
      h('span', { class: 'mi-check', text: '↩' }), h('span', {}, h('div', { class: 'mi-title', text: 'Bring all home' }), homeSub));
    const bothSub = h('div', { class: 'mi-sub' });
    const bothBtn = h('button', { class: 'menu-item', hidden: true, onclick: () => { SB.closeMenus(); bringAll(tab, { push: true }); } },
      h('span', { class: 'mi-check', text: '⇈' }), h('span', {}, h('div', { class: 'mi-title', text: 'Bring all home and push' }), bothSub));

    const show = s => {
      if (!s?.ok) return; // not a repository, or not on a branch: nothing to offer
      sep.hidden = label.hidden = pushBtn.hidden = false;
      pushTitle.textContent = `Push ${s.branch}`;
      const checking = s.fetched || !s.remote ? '' : ' (checking…)';
      const bits = [];
      if (s.ahead) bits.push(`${plural(s.ahead, 'commit')} to push`);
      if (s.behind) bits.push(`${s.behind} to take in from ${s.remote} first`);
      pushSub.textContent = !s.remote ? 'No remote to push to.' : bits.length ? `${bits.join(' · ')}${checking}` : `Up to date with ${s.upstream}${checking}`;
      pushBtn.disabled = !s.remote || (!s.ahead && !s.behind);

      homeBtn.hidden = bothBtn.hidden = !s.copies;
      const ready = s.copies - s.copiesBusy;
      const busy = s.copiesBusy ? `; ${s.copiesBusy} still working, left for later` : '';
      homeSub.textContent = `${plural(s.copies, 'copy', 'copies')} with work not in ${s.branch} yet${busy}. Merged one at a time`;
      bothSub.textContent = s.remote ? `Then push ${s.branch} to ${s.remote}` : 'No remote to push to.';
      homeBtn.disabled = !ready;
      bothBtn.disabled = !ready || !s.remote;
    };
    api.repoStatus(tab?.id).then(s => {
      show(s);
      if (s?.ok && s.remote) api.repoStatus(tab?.id, { fetch: true }).then(f => show(f?.ok ? f : { ...s, fetched: true }));
    });
    return [sep, label, pushBtn, homeBtn, bothBtn];
  }

  function pushNews(r) {
    if (r.pushed) return `Pushed ${plural(r.pushed, 'commit')} to ${r.remote}/${r.branch}${r.pulled ? `, after taking in ${r.pulled} from ${r.remote}` : ''}.`;
    if (r.pulled) return `Took in ${plural(r.pulled, 'commit')} from ${r.remote}; nothing of yours to push.`;
    return `${r.branch} is already up to date with ${r.remote}.`;
  }

  // A push that fails: a clash can be handed to Claude; a hook's refusal is
  // written into the conversation by main, in full.
  function pushTrouble(tab, r) {
    if (r?.conflict && tab) {
      SB.toast(r.error, { ms: 12000, action: 'Ask him to sort it out', onAction: () => {
        SB.activate(tab.id);
        SB.send(`Run git fetch, then merge ${r.upstream} into this branch (git merge ${r.upstream}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready${tab.worktree ? ' to bring home and push' : ' to push'}.`);
      } });
      return;
    }
    SB.toast(`${r?.error || "Couldn't push."}${r?.detail ? ' What git said is in the conversation.' : ''}`, { ms: 10000 });
  }

  async function pushRepo(tab) {
    SB.toast('Pushing…', { ms: 30000 });
    const r = await api.pushRepo(tab?.id);
    if (r?.ok) return SB.toast(pushNews(r), { ms: 6000 });
    pushTrouble(tab, r);
  }

  async function bringAll(tab, { push = false } = {}) {
    SB.toast(push ? 'Bringing them all home, then pushing…' : 'Bringing them all home…', { ms: 30000 });
    const r = await api.bringAllHome(tab?.id, { push });
    if (!r || (r.error && !r.results && !r.stopped && r.merged === undefined)) return SB.toast(r?.error || "Couldn't bring them home.", { ms: 8000 });
    const bits = [r.merged ? `Merged ${plural(r.merged, 'copy', 'copies')} (${plural(r.commits, 'commit')}).` : 'Nothing new to merge.'];
    if (r.skipped) bits.push(`${r.skipped} started from another branch and ${r.skipped === 1 ? 'was' : 'were'} left alone.`);
    if (r.busy) bits.push(`${r.busy} still working, left for later.`);
    const s = r.stopped;
    if (s) {
      const open = s.tabId && state.tabs.get(s.tabId);
      bits.push(s.conflict ? `"${s.title || s.branch}" clashes with ${s.base}, so it stopped there.` : `Stopped at "${s.title || s.branch}": ${s.error}`);
      if (s.conflict && open) {
        return SB.toast(bits.join(' '), { ms: 14000, action: 'Ask him to sort it out', onAction: () => {
          SB.activate(open.id);
          SB.send(`Merge ${s.base} into this branch (git merge ${s.base}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready to bring home.`);
        } });
      }
      if (s.conflict) bits.push('Open it from History to sort it out.');
      return SB.toast(bits.join(' '), { ms: 14000 });
    }
    if (r.push && !r.push.ok) { SB.toast(bits.join(' '), { ms: 5000 }); return pushTrouble(tab, r.push); }
    if (r.push) bits.push(pushNews(r.push));
    SB.toast(bits.join(' '), { ms: 8000 });
  }

  // ------------------------------------------------------------ its own copy (worktrees.js)

  $('branchChip').addEventListener('click', async () => {
    const tab = SB.activeTab();
    const w = tab?.worktree;
    if (!w) return;
    // Other tries at the same thing (branching.js): compare with them, or keep this one.
    const family = $('branchMenu').hidden ? await api.branchFamily(tab.id).catch(() => []) : [];
    const others = family.filter(f => !f.current);
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
        h('span', {}, h('div', { class: 'mi-title', text: 'Bring it home' }), h('div', { class: 'mi-sub', text: `Commit what's left and merge into ${w.base}. The conversation carries on` }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); bringHome(tab, { push: true }); } },
        h('span', { class: 'mi-check', text: '⇡' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Bring it home and push' }), h('div', { class: 'mi-sub', text: `Merge into ${w.base}, then push ${w.base} to its remote. The conversation carries on` }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); bringHome(tab, { finish: true }); } },
        h('span', { class: 'mi-check', text: '✓' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Bring it home and finish' }), h('div', { class: 'mi-sub', text: 'Merge, then tidy the copy away. The conversation and its diffs stay in History' }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); throwAway(tab); } },
        h('span', { class: 'mi-check', text: '✕' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Throw it away' }), h('div', { class: 'mi-sub', text: 'Delete the copy and its branch, without merging' }))),
      ...(others.length ? [
        h('div', { class: 'menu-sep' }),
        h('div', { class: 'menu-label', text: `Other tries at this (${others.length})` }),
        ...others.slice(0, 7).map(o => h('button', { class: 'menu-item branch-family', onclick: () => { SB.closeMenus(); compareWith(tab, o); } },
          h('span', { class: 'mi-check', text: '⇄' }),
          h('span', {}, h('div', { class: 'mi-title', text: `Compare with "${o.title}"` }),
            h('div', { class: 'mi-sub', text: [o.depth === 0 ? 'the original' : o.at === 'after' ? 'branched after a reply' : 'branched before a message', o.copy ? o.copy.branch : 'in your checkout', o.busy ? 'working' : o.open ? 'open' : 'in History'].join(' · ') })))),
        others.some(o => o.copy)
          ? h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); keepThisOne(tab); } },
            h('span', { class: 'mi-check', text: '★' }),
            h('span', {}, h('div', { class: 'mi-title', text: 'Keep this one' }), h('div', { class: 'mi-sub', text: `Bring it home into ${w.base}, and throw away the other tries' copies` })))
          : null,
      ] : []),
    ]);
  });

  // What this try has that the other doesn't, file by file, into the feed.
  async function compareWith(tab, other) {
    SB.toast(`Comparing with "${other.title}"…`, { ms: 8000 });
    const r = await api.compareBranches(tab.id, other.id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't compare them.", { ms: 8000 });
    SB.toast(r.same ? 'Exactly the same files.' : `${plural(r.files.length + (r.more || 0), 'file')} differ: see below.`);
    tab.renderCompare(other, r);
  }

  async function keepThisOne(tab) {
    if (tab.busy) return SB.toast('Let him finish first.');
    const r = await api.keepBranch(tab.id);
    if (r?.cancelled) return;
    if (!r?.ok) {
      if (r?.conflict) {
        return SB.toast(`${r.error} Nothing was thrown away.`, { ms: 12000, action: 'Ask him to sort it out', onAction: () => {
          SB.activate(tab.id);
          SB.send(`Merge ${tab.worktree.base} into this branch (git merge ${tab.worktree.base}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready to bring home.`);
        } });
      }
      return SB.toast(r?.error || "Couldn't keep it.", { ms: 8000 });
    }
    const home = r.home ? (r.home.merged ? `Merged ${plural(r.home.commits, 'commit')} into ${r.base}.` : `${r.base} already had all of it.`) : '';
    const gone = r.discarded ? ` Threw away ${plural(r.discarded, 'other try', 'other tries')}.` : '';
    const failed = r.failed?.length ? ` Couldn't remove ${r.failed.join(', ')}.` : '';
    if (r.home?.tidied) await SB.closeTab(tab.id);
    SB.toast(`${home}${gone}${failed} The conversations stay in History.`.trim(), { ms: 8000 });
  }

  async function bringHome(tab, { finish = false, push = false } = {}) {
    if (tab.busy) return SB.toast('Let him finish first.');
    SB.toast(push ? 'Bringing it home, then pushing…' : 'Bringing it home…', { ms: push ? 30000 : 8000 });
    const r = await api.bringWorktreeHome(tab.id, { finish, push });
    const merged = `Merged ${r?.commits} commit${r?.commits === 1 ? '' : 's'} into ${r?.base}.`;
    if (r?.ok && r.push) {
      if (r.push.ok) return SB.toast(`${r.merged ? `${merged} ` : ''}${pushNews(r.push)}`, { ms: 7000 });
      if (r.merged) SB.toast(`${merged} The push didn't go through, so it's only on this computer for now.`, { ms: 5000 });
      return pushTrouble(tab, r.push);
    }
    if (r?.ok && r.kept) {
      SB.toast(r.merged ? `${merged} Carry on here and bring it home again any time.` : `Nothing new to merge; ${r.base} already has all of it.`, { ms: 6000 });
      return;
    }
    if (r?.ok) {
      await SB.closeTab(tab.id);
      SB.toast(r.merged ? `${merged} The conversation is in History, marked done.` : 'Nothing new to merge, so the copy was just tidied away.', { ms: 6000 });
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

  // ------------------------------------------------------------ how full each conversation is

  // Past CROWDED (src/main/context.js) he says so, and the composer offers to
  // make room. Dismissing it holds until the tab drops back under the mark.
  const CROWDED = 80;
  const contextLevel = c => (c.pct >= 95 ? 'hot' : c.pct >= CROWDED ? 'warn' : '');
  const contextText = c => `Context ${c.pct}% full · ${SB.compact(c.tokens)} of ${SB.compact(c.window)} tokens`;

  function syncContextUi() {
    const tab = SB.activeTab();
    const c = tab?.context;
    const chip = $('ctxChip');
    chip.hidden = !c;
    if (c) {
      chip.className = `ctx-chip ${contextLevel(c)}`;
      chip.querySelector('.meter-fill').style.transform = `scaleX(${c.pct / 100})`;
      $('ctxLabel').textContent = `${c.pct}%`;
      chip.title = contextText(c);
      chip.setAttribute('aria-label', `${contextText(c)}: make room`);
    }
    if (tab && (!c || c.pct < CROWDED)) tab.crowdDismissed = false;
    const box = $('crowded');
    const show = !!c && c.pct >= CROWDED && !tab.crowdDismissed;
    box.hidden = !show;
    if (!show) { box.replaceChildren(); return; }
    box.replaceChildren(
      h('span', { class: 'crowded-text', text: `Getting crowded: ${c.pct}% full.` }),
      h('button', { class: 'btn slim-btn', type: 'button', onclick: () => compact(tab) }, 'Compact'),
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => startFresh(tab) }, 'Start fresh with a summary'),
      h('button', { class: 'queue-x icon-btn', type: 'button', 'aria-label': 'Not now', title: 'Not now', onclick: () => { tab.crowdDismissed = true; syncContextUi(); } },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })));
  }
  SB.syncContextUi = syncContextUi;

  // Claude Code's own /compact: it sums the conversation up in place and carries on.
  function compact(tab) {
    if (tab.busy) return SB.toast('Let him finish first.');
    SB.activate(tab.id);
    SB.send('/compact');
  }

  // Claude writes a handoff summary, then the tab starts a new conversation with it.
  async function startFresh(tab) {
    if (tab.busy) return SB.toast('Let him finish first.');
    const r = await api.freshTab(tab.id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start fresh.");
    tab.render({ kind: 'user', text: r.text });
    tab.busy = true;
    tab.busySince = Date.now();
    tab.statusText = 'Writing a summary…';
    if (tab.isActive) syncBusyUi();
    SB.renderTabStrip();
  }

  $('ctxChip').addEventListener('click', () => {
    const tab = SB.activeTab();
    const c = tab?.context;
    if (!c) return;
    SB.openMenu($('ctxMenu'), $('ctxChip'), () => [
      h('div', { class: 'menu-label', text: contextText(c) }),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); compact(tab); } },
        h('span', { class: 'mi-check', text: '⇣' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Compact' }), h('div', { class: 'mi-sub', text: 'Claude sums up the conversation so far and carries on in the room it frees' }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); startFresh(tab); } },
        h('span', { class: 'mi-check', text: '↻' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Start fresh with a summary' }), h('div', { class: 'mi-sub', text: 'Claude writes a handoff note, then a new conversation picks it up in this tab' }))),
    ]);
  });

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

  // Who used it: each window's split by tab and routine, or by project (src/main/spend.js).
  let usageBy = 'task';
  const pctText = share => (share >= 0.995 ? '100%' : share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

  function usageRows(windows) {
    const toggle = h('div', { class: 'usage-by', role: 'group', 'aria-label': 'Group by' },
      ...[['task', 'Tabs & routines'], ['project', 'Projects']].map(([by, text]) => h('button', {
        type: 'button', class: `usage-by-btn${usageBy === by ? ' on' : ''}`, 'aria-pressed': String(usageBy === by), text,
        onclick: () => { usageBy = by; $('usageMenu').replaceChildren(...usageRows(windows)); $('usageMenu').querySelector('.usage-by-btn.on')?.focus(); },
      })));
    const sections = windows.map(w => {
      const rows = usageBy === 'project' ? w.projects : w.tasks;
      const head = h('div', { class: 'menu-label', text: `${w.name}${w.pct != null ? ` · ${w.pct}% used` : ''}` });
      if (!rows.length) return [head, h('div', { class: 'usage-empty', text: 'Nothing Shellby ran in this window yet.' })];
      return [head, ...rows.map(r => h('div', { class: `usage-row kind-${r.kind}`, title: r.detail ? SB.tildify(r.detail) : r.label },
        h('span', { class: 'usage-name', text: r.kind === 'routine' ? `⟳ ${r.label}` : r.label }),
        h('span', { class: 'usage-bar' }, h('span', { class: 'usage-bar-fill', style: `transform: scaleX(${r.share})` })),
        h('span', { class: 'usage-share', text: pctText(r.share) })))];
    });
    return [toggle, ...sections.flat(), h('div', { class: 'menu-sep' }),
      h('div', { class: 'usage-empty', text: 'Shares of what Shellby ran. Claude used elsewhere fills the meters too.' })];
  }

  let usageLoading = false;
  $('usage').addEventListener('click', async () => {
    const menu = $('usageMenu');
    if (!menu.hidden) return SB.closeMenus();
    if (usageLoading) return; // a second click while it loads would open and shut it at once
    usageLoading = true;
    const windows = await api.usageBreakdown().catch(() => []);
    usageLoading = false;
    SB.openMenu(menu, $('usage'), () => usageRows(windows));
  });

  // The plan's usage limit: Shellby naps until it resets, then says so (src/main/limits.js).
  api.onLimit(e => {
    if (e.phase === 'hit') SB.toast(`Your ${e.name} Claude limit is reached. Shellby will tap you when it resets, ${e.at}.`, { ms: 8000 });
    if (e.phase === 'reset') SB.toast(`Your ${e.name} limit just reset. Go ahead!`, { ms: 6000 });
  });
})();
