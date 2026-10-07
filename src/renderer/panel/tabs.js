/* Shellby panel — tabs, composer, mode/folder chips, usage meter, slash menu. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const P = SB.panes;
  const input = $('input');
  const PLACEHOLDER = input.placeholder;

  // ------------------------------------------------------------ tabs

  let drag = null;   // the tab being dragged along the strip (see "drag to reorder")

  SB.activeTab = () => state.tabs.get(state.activeTab) || null;
  SB.isShown = tabId => P.has(state.grid, tabId);

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
    // On screen already: its pane takes the focus. Otherwise it opens in the
    // focused pane, or in the pane of a tab that has just gone.
    const into = state.activeTab ?? P.ids(state.grid).find(id => !state.tabs.has(id));
    state.grid = P.keep(P.replace(state.grid, into, tabId), id => state.tabs.has(id));
    state.activeTab = tabId;
    renderPanes();
    input.value = tab.draft || '';
    autosize();
    renderAttachments();
    applyFolderLabel(tab.cwd || state.cwd);
    syncBusyUi();
    if (tab.unread) api.seenTab(tabId);
    tab.unread = false;
    SB.renderTabStrip();
    if (state.view !== 'chat') SB.setView('chat'); else input.focus();
  };

  // ------------------------------------------------------------ panes

  // The chat view shows the tabs in state.grid side by side (shared/panes.js
  // decides the shapes). Each pane has a slim header, hidden while there's
  // only one; the composer belongs to whichever pane has the focus.
  const paneHeads = new Map();   // tabId -> header, for the tabs on screen

  function renderPanes() {
    const feeds = $('feeds');
    const { cols, rows, cells } = P.layout(state.grid);
    const at = new Map(cells.map(c => [c.id, c]));
    feeds.dataset.panes = cells.length;
    feeds.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    feeds.style.gridTemplateRows = `repeat(${rows}, auto minmax(0, 1fr))`;
    for (const [id, head] of paneHeads) if (!at.has(id)) { head.remove(); paneHeads.delete(id); }
    const appearing = [];
    for (const t of state.tabs.values()) {
      const cell = at.get(t.id);
      if (cell && t.el.hidden) appearing.push(t);
      t.el.hidden = !cell;
      if (!cell) continue;
      Object.assign(t.el.style, { gridColumn: cell.col, gridRow: cell.feed });
      let head = paneHeads.get(t.id);
      if (!head) { head = paneHead(t); paneHeads.set(t.id, head); feeds.append(head); }
      Object.assign(head.style, { gridColumn: cell.col, gridRow: cell.head });
    }
    refreshHeads();
    // A hidden feed loses its place; it comes back showing the latest.
    requestAnimationFrame(() => { for (const t of appearing) t.scrollToEnd(); });
  }

  function paneHead(t) {
    return h('div', { class: 'pane-head', dataset: { tab: t.id }, onpointerdown: e => dragStart(e, t.id) },
      h('span', { class: 'pane-state' }),
      h('span', { class: 'pane-title' }),
      h('button', { class: 'pane-btn', type: 'button', title: 'Open in its own window', 'aria-label': 'Open in its own window', onclick: () => SB.popOut(t.id) },
        SB.icon('M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3.2c0 .4-.4.8-.8.8H3.3c-.4 0-.8-.4-.8-.8V4.8c0-.4.4-.8.8-.8h3.2')),
      h('button', { class: 'pane-btn', type: 'button', title: 'Close this pane (the conversation keeps its tab)', 'aria-label': 'Close this pane', onclick: () => SB.closePane(t.id) },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })));
  }

  // Titles and working/asking marks change all the time; the headers are
  // updated in place, so a button being pressed is never swapped out.
  function refreshHeads() {
    const split = paneHeads.size > 1;
    for (const [id, head] of paneHeads) {
      const t = state.tabs.get(id);
      if (!t) continue;
      const focused = split && id === state.activeTab;
      head.classList.toggle('focused', focused);
      t.el.classList.toggle('focused', focused);
      head.querySelector('.pane-state').replaceChildren(...[tabIcon(t)].filter(Boolean));
      const title = head.querySelector('.pane-title');
      title.textContent = tabLabel(t);
      title.title = t.title;
    }
    // Which pane you're typing to, when there's more than one it could be.
    const tab = SB.activeTab();
    input.placeholder = split && tab ? `Give "${tabLabel(tab).slice(0, 40)}" a task…` : PLACEHOLDER;
  }

  // Clicking into a pane makes it the one the composer talks to.
  $('feeds').addEventListener('pointerdown', e => {
    const id = e.target.closest('[data-tab]')?.dataset.tab;
    if (id && id !== state.activeTab && state.tabs.has(id)) SB.activate(id);
  });

  // Drop `tabId` on `target`'s pane (`zone`: see panes.place) and focus it there.
  SB.placeTab = (tabId, target, zone) => {
    state.grid = P.place(state.grid, tabId, target, zone);
    SB.activate(tabId);
  };

  // Off screen, but still a tab.
  SB.closePane = (tabId) => {
    if (!SB.isShown(tabId) || P.ids(state.grid).length < 2) return;
    state.grid = P.remove(state.grid, tabId);
    if (state.activeTab === tabId) SB.activate(P.ids(state.grid)[0]);
    else { renderPanes(); SB.renderTabStrip(); }
  };

  // Ctrl+\ and the split button: the newest conversation that isn't on screen
  // (or a fresh one) goes beside the focused pane, or below one if there are
  // two columns already.
  SB.splitPane = async () => {
    if (SB.solo || !state.activeTab) return;
    const spots = [state.activeTab, ...P.ids(state.grid)];
    const side = spots.find(id => P.zones(state.grid, id).includes('right'));
    const below = spots.find(id => P.zones(state.grid, id).includes('bottom'));
    if (!side && !below) return SB.toast('Four is as many as fit. Close a pane first.');
    let next = [...state.tabs.keys()].reverse().find(id => !SB.isShown(id));
    if (!next) next = (await SB.newTab({ focus: false, reuse: false }))?.id;
    if (next) SB.placeTab(next, side || below, side ? 'right' : 'bottom');
  };

  // ------------------------------------------------------------ own window

  // What's typed but not sent travels with a conversation between windows.
  SB.carryOf = tab => ({ draft: tab.draft, attachments: tab.attachments, queue: tab.queue });
  SB.takeCarry = (tab, carry) => {
    if (!carry) return;
    Object.assign(tab, { draft: carry.draft, attachments: carry.attachments, queue: carry.queue });
    // A turn that ended on the way over would have sent the next queued message.
    if (!tab.busy && tab.queue.length) SB.onTurnEnded(tab, { ok: tab.outcome !== 'error', interrupted: tab.outcome === 'stopped' });
  };

  // `at`: where it was dropped, in screen pixels, so the window opens there.
  SB.popOut = async (tabId, at = {}) => {
    const tab = state.tabs.get(tabId);
    if (!tab || SB.solo) return;
    if (tab.isActive) tab.draft = input.value;
    const r = await api.popOutTab(tabId, { ...at, carry: SB.carryOf(tab) });
    if (!r?.ok) return SB.toast(r?.error || "Couldn't open that in its own window.");
    forgetTab(tabId);
    SB.renderTabStrip();
  };

  // A tab leaves this window: closed, popped out, or gone from main.
  function forgetTab(tabId) {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    tab.destroy();
    paneHeads.get(tabId)?.remove();
    paneHeads.delete(tabId);
    state.tabs.delete(tabId);
    state.grid = P.remove(state.grid, tabId);
    if (state.activeTab !== tabId) return renderPanes();
    state.activeTab = null;
    const next = P.ids(state.grid)[0] || [...state.tabs.keys()].pop();
    if (next) SB.activate(next);
    else if (!SB.solo) SB.newTab();
  }

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
    // A popped-out conversation belongs to its own window, and that window to it alone.
    summaries = summaries.filter(s => (SB.solo ? s.id === SB.solo : !s.popped));
    const ids = new Set(summaries.map(s => s.id));
    for (const s of summaries) SB.ensureTab(s);
    // A tab created locally may not be in this snapshot yet; only drop tabs the
    // main process no longer knows about once they've been reported at least once.
    for (const [id, tab] of state.tabs) if (!ids.has(id) && tab.reported) forgetTab(id);
    for (const s of summaries) { const t = state.tabs.get(s.id); if (t) t.reported = true; }
    // Main owns the order; a tab created here that isn't in the snapshot yet waits
    // at the end. A drag in progress wins, so a background tab reporting progress
    // mid-drag can't snap the strip back from under the pointer.
    if (!drag) orderTabs([...summaries.map(s => s.id).filter(id => state.tabs.has(id)), ...[...state.tabs.keys()].filter(id => !ids.has(id))]);
    if (!state.tabs.has(state.activeTab)) {
      const next = [...state.tabs.keys()].pop();
      if (next) SB.activate(next); else if (!SB.solo) SB.newTab();
    }
    syncBusyUi();
    SB.renderTabStrip();
  };

  // All tab creation funnels through here. Concurrent callers (e.g. closing the
  // last tab while the main process reports "no tabs") share one in-flight
  // request, so they can never produce two blank tabs.
  let creating = null;
  SB.newTab = ({ focus = true, reuse = true } = {}) => {
    const cur = SB.activeTab();
    if (reuse && cur && cur.isEmpty && !cur.busy) { if (focus) SB.activate(cur.id); return Promise.resolve(cur); } // reuse a blank tab
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
    forgetTab(tabId);
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

  const tabLabel = t => (t.isEmpty && !t.saved ? 'New task' : t.title);

  SB.renderTabStrip = () => {
    const strip = $('tabs');
    const split = P.ids(state.grid).length > 1;
    strip.replaceChildren(...[...state.tabs.values()].map(t => {
      const active = t.id === state.activeTab;
      const shown = SB.isShown(t.id);
      const btn = h('div', {
        class: `tab${active ? ' active' : ''}${split && shown && !active ? ' shown' : ''}${t.unread && !shown ? ' unread' : ''}${t.pending ? ' asking' : ''}${t.id === drag?.id && drag.moved ? ' dragging' : ''}`,
        role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1', title: t.title,
        'data-tab-id': t.id,
        onclick: () => SB.activate(t.id),
        onauxclick: e => { if (e.button === 1) SB.closeTab(t.id); },
        onpointerdown: e => dragStart(e, t.id),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') SB.activate(t.id); },
      },
      tabIcon(t),
      h('span', { class: 'tab-title', text: tabLabel(t) }),
      h('button', { class: 'tab-x', type: 'button', 'aria-label': `Close ${t.title}`, title: 'Close (Ctrl+W)', onclick: e => { e.stopPropagation(); SB.closeTab(t.id); } }, '×'));
      return btn;
    }));
    // Not while dragging: following the active tab would fight the strip's own
    // scrolling as the dragged tab is pulled past the edge.
    if (!drag) strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Title bar shows total running count at a glance.
    const running = [...state.tabs.values()].filter(t => t.busy).length;
    document.body.classList.toggle('busy', running > 0);
    refreshHeads();
    // A popped-out window is named for its conversation, on the taskbar too.
    const solo = SB.solo && SB.activeTab();
    if (solo) document.title = $('winTitle').textContent = tabLabel(solo);
  };
  $('tabs').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  $('newTabBtn').addEventListener('click', () => SB.newTab());
  $('splitBtn').addEventListener('click', () => SB.splitPane());
  $('popOutBtn').addEventListener('click', () => { if (state.activeTab) SB.popOut(state.activeTab); });

  // ------------------------------------------------------------ drag to reorder, split or pop out

  // The strip reorders live as the pointer crosses a neighbour's midpoint, and the
  // dragged tab keeps its place in the flow (just lifted). Nothing is positioned by
  // hand, so there's nothing to re-apply when a working tab redraws the strip
  // mid-drag — and pointermove/up are on the window, so replacing the tab's element
  // underneath the pointer doesn't cut the drag short.
  //
  // Pulled down into the chat, the tab splits a pane (a preview shows where it
  // will land); let go outside the window, it opens in a window of its own.
  // A pane's header drags the same way.
  const EDGE = 26;            // px from a strip edge where dragging starts scrolling it
  const SLOP = 5;             // px of movement before a click becomes a drag
  const OUT = 24;             // px past the window's edge before letting go pops the tab out

  function dragStart(e, tabId) {
    if (e.button !== 0 || e.target.closest('button') || SB.solo) return;
    drag = { id: tabId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false, drop: null };
    window.addEventListener('pointermove', dragMove);
    window.addEventListener('pointerup', dragEnd);
    window.addEventListener('pointercancel', dragEnd);
  }

  function dragMove(e) {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    // A click that wobbles a few pixels is still a click.
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < SLOP) return;
    if (!drag.moved) {
      drag.moved = true;
      document.body.classList.add('reordering');
      lift();
      requestAnimationFrame(edgeScroll);
    }
    drag.drop = dropAt(drag.x, drag.y);
    showDrop(drag.drop);
    if (drag.drop?.kind === 'strip') SB.moveTab(drag.id, dropBefore(drag.x));
  }

  function dragEnd(e) {
    const d = drag;
    drag = null;
    window.removeEventListener('pointermove', dragMove);
    window.removeEventListener('pointerup', dragEnd);
    window.removeEventListener('pointercancel', dragEnd);
    if (!d?.moved) return;
    document.body.classList.remove('reordering');
    lift();
    showDrop(null);
    if (e.type === 'pointercancel') return;
    if (d.drop?.kind === 'pane') SB.placeTab(d.id, d.drop.target, d.drop.zone);
    if (d.drop?.kind === 'out') SB.popOut(d.id, { x: e.screenX, y: e.screenY });
    // On the strip, the click that follows this pointerup is left alone on purpose:
    // you grabbed that tab, so ending up in its conversation is what you asked for.
    // That also means not redrawing the strip here — replacing the element the
    // pointer came up on would lose the click.
  }

  // What letting go here would do: reorder the strip, split or swap a pane,
  // pop the tab out (outside the window), or nothing.
  function dropAt(x, y) {
    // Clearly outside, not just overshooting the edge while scrolling the strip.
    const w = window.innerWidth, ht = window.innerHeight;
    if (x < -OUT || y < -OUT || x > w + OUT || y > ht + OUT) return { kind: 'out' };
    x = Math.min(Math.max(x, 0), w - 1);
    y = Math.min(Math.max(y, 0), ht - 1);
    if (y < $('tabstrip').getBoundingClientRect().bottom) return { kind: 'strip' };
    if (state.view !== 'chat') return null;
    for (const id of P.ids(state.grid)) {
      const pane = paneRect(id);
      if (x < pane.left || x >= pane.left + pane.width || y < pane.top || y >= pane.top + pane.height) continue;
      if (id === drag.id) return null;
      const zone = P.zoneAt(pane, x, y, P.zones(state.grid, id, drag.id));
      return { kind: 'pane', target: id, zone, rect: P.previewRect(zone, pane, $('feeds').getBoundingClientRect()) };
    }
    return null;
  }

  // A pane is its header (when it shows) and its feed.
  function paneRect(id) {
    const feed = state.tabs.get(id).el.getBoundingClientRect();
    const head = paneHeads.get(id)?.getBoundingClientRect();
    const top = head?.height ? head.top : feed.top;
    return { left: feed.left, top, width: feed.width, height: feed.bottom - top };
  }

  function showDrop(drop) {
    const hint = $('dropHint');
    hint.hidden = drop?.kind !== 'pane';
    if (hint.hidden) return;
    const r = drop.rect;
    Object.assign(hint.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
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
    const onStrip = drag.drop?.kind === 'strip';
    const dx = !onStrip ? 0 : drag.x < r.left + EDGE ? -9 : drag.x > r.right - EDGE ? 9 : 0;
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
    if (tab.title === 'New task') tab.title = text.length > 70 ? text.slice(0, 67) + '…' : text || 'Attached files';
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
    if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (tab) SB.closeTab(tab.id); return; }
    // A popped-out window has its one conversation: no strip to add to or walk along.
    const strip = !SB.solo;
    if (strip && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); SB.newTab(); return; }
    if (strip && e.ctrlKey && !e.shiftKey && e.key === '\\') { e.preventDefault(); SB.splitPane(); return; }
    // Reordering from the keyboard, where a browser puts it too — and the only way
    // to do it without a pointer.
    if (strip && e.ctrlKey && e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      if (tab) SB.nudgeTab(tab.id, e.key === 'PageUp' ? -1 : 1);
      return;
    }
    if (strip && e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const ids = [...state.tabs.keys()];
      const i = ids.indexOf(state.activeTab);
      SB.activate(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
      return;
    }
    // Esc backs out one level and stops at home; it never hides the panel, since
    // a stray press there made the whole window vanish. The hotkey and × do that.
    if (e.key === 'Escape') {
      if (!$('slashMenu').hidden || !$('modeMenu').hidden || !$('folderMenu').hidden) return SB.closeMenus();
      if (tab?.busy && state.view === 'chat') return stop();
      if (state.view !== SB.homeView() && state.view !== 'onboarding') return SB.goBack();
      return;
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
      if (SB.solo) return SB.toast('Turn Autonomous on from Settings in the main panel first.');
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
    if (SB.solo) {
      applyFolderLabel(tab?.cwd || r.cwd);
      SB.toast(`New conversations will start in ${SB.basename(r.cwd)}`);
    } else if (tab && tab.isEmpty && !tab.busy) {
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

  // The plan's usage limit: Shellby naps until it resets, then says so (src/main/limits.js).
  api.onLimit(e => {
    if (e.phase === 'hit') SB.toast(`Your ${e.name} Claude limit is reached. Shellby will tap you when it resets, ${e.at}.`, { ms: 8000 });
    if (e.phase === 'reset') SB.toast(`Your ${e.name} limit just reset. Go ahead!`, { ms: 6000 });
  });
})();
