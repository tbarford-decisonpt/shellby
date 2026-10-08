/* Shellby panel — conversations side by side, and in windows of their own.
   The chat view shows the tabs in state.grid (shared/panes.js decides the
   shapes: one pane, two side by side, up to a 2x2 grid), each pane with a slim
   header that hides while there's only one. The box belongs to the focused
   pane. A tab dragged out of the window (tab-strip.js) or sent out with its
   button gets a window of its own (main's wiring/popouts.js). tabs.js owns
   the tabs themselves. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const P = SB.panes;
  const input = $('input');
  const PLACEHOLDER = input.placeholder;
  const POP_ICON = 'M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3.2c0 .4-.4.8-.8.8H3.3c-.4 0-.8-.4-.8-.8V4.8c0-.4.4-.8.8-.8h3.2';

  SB.isShown = tabId => P.has(state.grid, tabId);

  // ------------------------------------------------------------ panes

  const paneHeads = new Map();   // tabId -> header, for the tabs on screen

  // `tabId` takes the focused pane, unless it's on screen already: then its
  // pane takes the focus. With the focused tab just gone, it takes that one's
  // place. tabs.js calls this as it activates a tab.
  SB.showInPane = (tabId) => {
    const into = state.activeTab ?? P.ids(state.grid).find(id => !state.tabs.has(id));
    state.grid = P.keep(P.replace(state.grid, into, tabId), id => state.tabs.has(id));
  };

  SB.renderPanes = () => {
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
    SB.refreshPaneHeads();
    // A hidden feed loses its place; it comes back showing the latest.
    requestAnimationFrame(() => { for (const t of appearing) t.scrollToEnd(); });
  };

  function paneHead(t) {
    return h('div', { class: 'pane-head', dataset: { tab: t.id }, onpointerdown: e => SB.dragTab(e, t.id) },
      h('span', { class: 'pane-state' }),
      h('span', { class: 'pane-title' }),
      h('button', { class: 'pane-btn', type: 'button', title: 'Open in its own window', 'aria-label': 'Open in its own window', onclick: () => SB.popOut(t.id) },
        SB.icon(POP_ICON)),
      h('button', { class: 'pane-btn', type: 'button', title: 'Close this pane (the conversation keeps its tab)', 'aria-label': 'Close this pane', onclick: () => SB.closePane(t.id) },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })));
  }

  // Names and working/asking marks change all the time; the headers are updated
  // in place, so a button being pressed is never swapped out from under you.
  // tab-strip.js calls this whenever it redraws.
  SB.refreshPaneHeads = () => {
    const split = paneHeads.size > 1;
    for (const [id, head] of paneHeads) {
      const t = state.tabs.get(id);
      if (!t) continue;
      const focused = split && id === state.activeTab;
      head.classList.toggle('focused', focused);
      t.el.classList.toggle('focused', focused);
      head.querySelector('.pane-state').replaceChildren(...[SB.tabIcon(t)].filter(Boolean));
      const title = head.querySelector('.pane-title');
      title.textContent = SB.shownTitle(t);
      title.title = t.title;
    }
    // Which pane you're typing to, when there's more than one it could be.
    const tab = SB.activeTab();
    input.placeholder = split && tab ? `Give "${SB.shownTitle(tab).slice(0, 40)}" a task…` : PLACEHOLDER;
    // A popped-out window is named for its conversation, on the taskbar too.
    if (SB.solo && tab) document.title = $('winTitle').textContent = SB.shownTitle(tab);
  };

  // Clicking into a pane makes it the one the box talks to.
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
    else { SB.renderPanes(); SB.renderTabStrip(); }
  };

  // The split shortcut and button: the newest conversation that isn't on screen
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

  // ------------------------------------------------------------ where a dragged tab lands

  const OUT = 24;   // px past the window's edge before letting go pops the tab out

  // What letting go here would do: reorder the strip, split or swap a pane, pop
  // the tab out (well outside the window), or nothing. For tab-strip.js's drag.
  SB.dropAt = (x, y, dragId) => {
    const w = window.innerWidth, ht = window.innerHeight;
    if (x < -OUT || y < -OUT || x > w + OUT || y > ht + OUT) return SB.solo ? null : { kind: 'out' };
    x = Math.min(Math.max(x, 0), w - 1);
    y = Math.min(Math.max(y, 0), ht - 1);
    if (y < $('tabstrip').getBoundingClientRect().bottom) return { kind: 'strip' };
    if (state.view !== 'chat') return null;
    for (const id of P.ids(state.grid)) {
      const pane = paneRect(id);
      if (x < pane.left || x >= pane.left + pane.width || y < pane.top || y >= pane.top + pane.height) continue;
      if (id === dragId) return null;
      const zone = P.zoneAt(pane, x, y, P.zones(state.grid, id, dragId));
      return { kind: 'pane', target: id, zone, rect: P.previewRect(zone, pane, $('feeds').getBoundingClientRect()) };
    }
    return null;
  };

  // A pane is its header (when it shows) and its feed.
  function paneRect(id) {
    const feed = state.tabs.get(id).el.getBoundingClientRect();
    const head = paneHeads.get(id)?.getBoundingClientRect();
    const top = head?.height ? head.top : feed.top;
    return { left: feed.left, top, width: feed.width, height: feed.bottom - top };
  }

  // The preview of where it will land, or none.
  SB.showDrop = (drop) => {
    const hint = $('dropHint');
    hint.hidden = drop?.kind !== 'pane';
    if (hint.hidden) return;
    const r = drop.rect;
    Object.assign(hint.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };

  // ------------------------------------------------------------ a window of its own

  // What's typed but not sent travels with a conversation between windows,
  // queued messages with the ids main's steering knows them by.
  SB.carryOf = tab => ({ draft: tab.draft, attachments: tab.attachments, queue: tab.queue, turnId: tab.turnId || null });
  SB.takeCarry = (tab, carry) => {
    if (!carry) return;
    Object.assign(tab, { draft: carry.draft, attachments: carry.attachments, queue: carry.queue });
    if (carry.turnId) tab.turnId = carry.turnId;
    // A turn that ended on the way over would have sent the next queued message;
    // one still running hears about the queue from this window now.
    if (!tab.busy && tab.queue.length) SB.onTurnEnded(tab, { ok: tab.outcome !== 'error', interrupted: tab.outcome === 'stopped' });
    else SB.syncSteers?.(tab);
  };

  // `at`: where it was dropped, in screen pixels, so the window opens there.
  SB.popOut = async (tabId, at = {}) => {
    const tab = state.tabs.get(tabId);
    if (!tab || SB.solo) return;
    if (tab.isActive) tab.draft = input.value;
    const r = await api.popOutTab(tabId, { ...at, carry: SB.carryOf(tab) });
    if (!r?.ok) return SB.toast(r?.error || "Couldn't open that in its own window.");
    state.popped.add(tabId);
    SB.forgetTab(tabId);
    SB.renderTabStrip();
  };

  // A tab leaves this window: closed, popped out, or gone from main.
  SB.forgetTab = (tabId) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    tab.destroy();
    paneHeads.get(tabId)?.remove();
    paneHeads.delete(tabId);
    state.tabs.delete(tabId);
    state.grid = P.remove(state.grid, tabId);
    if (state.activeTab !== tabId) return SB.renderPanes();
    state.activeTab = null;
    const next = P.ids(state.grid)[0] || [...state.tabs.keys()].pop();
    if (next) SB.activate(next);
    else if (!SB.solo) SB.newTab();
  };

  // A popped-out conversation's window closed: it's a tab here again.
  api.onTabReturned(({ summary, items, carry }) => {
    if (!summary) return;
    state.popped.delete(summary.id);
    if (state.tabs.has(summary.id)) return;
    const tab = SB.ensureTab(summary);
    for (const item of items || []) tab.render(item, { replay: true });
    SB.takeCarry(tab, carry);
    SB.renderTabStrip();
  });

  $('splitBtn').addEventListener('click', () => SB.splitPane());
  $('popOutBtn').addEventListener('click', () => { if (state.activeTab) SB.popOut(state.activeTab); });
  $('maxBtn').addEventListener('click', () => api.maximize());
})();
