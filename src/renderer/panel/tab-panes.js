/* Shellby panel — conversations side by side, and in windows of their own.
   The chat view shows the panes in state.grid (shared/panes.js decides the
   shapes: up to four columns of up to three). Each pane is a group of tabs:
   a header that is its own tab strip (tab-strip.js draws the tabs), the feed
   of the tab it shows, and a slot for the box. With one pane the header
   hides and the top strip holds every conversation, as it always has. The
   box belongs to the focused pane: the one holding state.activeTab. Room for
   the panes, and growing the panel to make it, is pane-room.js. A tab
   dragged out of the window (tab-strip.js) or sent out with its button gets
   a window of its own (main's wiring/popouts.js). tabs.js owns the tabs. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const P = SB.panes;
  const input = $('input');
  const PLACEHOLDER = input.placeholder;
  const POP_ICON = 'M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3.2c0 .4-.4.8-.8.8H3.3c-.4 0-.8-.4-.8-.8V4.8c0-.4.4-.8.8-.8h3.2';
  const PLUS_ICON = 'M8 3.5v9M3.5 8h9';
  const CLOSE_ICON = 'M4.5 4.5l7 7M11.5 4.5l-7 7';
  const EDGES = new Set(['left', 'right', 'top', 'bottom']);

  // On screen: the tab a pane shows.
  SB.isShown = tabId => P.shownTabs(state.grid).includes(tabId);
  // The pane holding the conversation the box talks to.
  const focusedPane = () => P.paneWith(state.grid, state.activeTab)?.id ?? null;
  SB.focusedPane = focusedPane;
  // Where a tab that turns up goes: the focused pane, or, with the focused tab
  // just taken away under the panes (a folder change, tab-chips.js; a History
  // delete, history.js), the pane that held it, so its replacement opens there.
  // A redraw can come before the replacement does (main's tab list, a busy
  // tab), and take the tab that went out of that pane, so it's remembered.
  let lastFocused = null;
  const homePane = () => focusedPane() ?? (P.byId(state.grid, lastFocused) ? lastFocused : null);
  const activeOf = paneId => P.byId(state.grid, paneId)?.active ?? null;

  // ------------------------------------------------------------ panes

  const panes = new Map();   // paneId -> { el, head, strip, slot }, for the panes on screen
  let shape = '';            // P.layoutKey of the grid the pane elements were last put together for
  const box = $('composer');
  const home = $('chatView');

  const paneRow = () => $('feeds').querySelector(':scope > .pane-row') || $('feeds').appendChild(h('div', { class: 'pane-row' }));
  SB.paneStripOf = id => panes.get(id)?.strip || null;

  // A pane's element: its header (its strip), the feed of the tab it shows,
  // and the slot under it for the box. Another tab's feed left in it goes
  // back to waiting, hidden, in #feeds.
  function paneOf(pane) {
    let p = panes.get(pane.id);
    if (!p) {
      const { head, strip } = paneHead(pane.id);
      const slot = h('div', { class: 'pane-slot' });
      p = { el: h('div', { class: 'pane', dataset: { pane: pane.id, tab: pane.active } }, head, slot), head, strip, slot };
      panes.set(pane.id, p);
    }
    const t = state.tabs.get(pane.active);
    for (const el of [...p.el.children]) if (el !== p.head && el !== p.slot && el !== t?.el) { el.hidden = true; $('feeds').append(el); }
    if (t && t.el.parentElement !== p.el) p.el.insertBefore(t.el, p.slot);
    p.el.dataset.tab = pane.active;
    return p;
  }

  // A pane leaves the screen. Its feed goes back to waiting, hidden, in #feeds.
  function dropPane(id) {
    const p = panes.get(id);
    if (!p) return;
    if (p.slot.contains(box)) home.append(box);
    for (const el of [...p.el.children]) if (el !== p.head && el !== p.slot) { el.hidden = true; $('feeds').append(el); }
    p.el.remove();
    panes.delete(id);
  }

  // Every open conversation in exactly one pane: one closed leaves its pane,
  // and one that turned up (a new tab, one back from its own window, one main
  // opened) joins the focused pane. One pane holds them in the strip's own
  // order, as main keeps it. -> whether the panes, or a pane's shown tab, changed.
  SB.settlePanes = () => {
    const open = [...state.tabs.keys()];
    const next = P.follow(P.settle(state.grid, open, homePane()), open);
    const changed = P.layoutKey(next) !== P.layoutKey(state.grid);
    state.grid = next;
    return changed;
  };

  // `tabId` shows in its pane, which takes the focus; one in no pane yet joins
  // the focused pane (homePane), after the tab it shows. tabs.js calls this as
  // it activates a tab, before state.activeTab changes.
  SB.showInPane = (tabId) => {
    state.grid = P.show(state.grid, tabId, homePane());
  };

  // Lays out the panes. Their strips are drawn by tab-strip.js (renderTabStrip
  // follows every call to this that changes them).
  SB.renderPanes = () => {
    SB.settlePanes();
    lastFocused = focusedPane() ?? lastFocused;
    state.paneSizes = P.fitSizes(state.grid, state.paneSizes);
    const live = new Set(P.paneIds(state.grid));
    const shown = new Set(P.shownTabs(state.grid));
    $('feeds').dataset.panes = live.size;
    document.body.classList.toggle('panes-split', live.size > 1);
    for (const id of [...panes.keys()]) if (!live.has(id)) dropPane(id);
    for (const t of state.tabs.values()) if (!shown.has(t.id)) t.el.hidden = true;
    const next = P.layoutKey(state.grid);
    // A tab made anew under an id already on screen (the screenshot demo) has a feed no pane holds yet.
    const loose = state.grid.flat().some(p => state.tabs.get(p.active)?.el.parentElement !== panes.get(p.id)?.el);
    if (next !== shape || loose) {
      shape = next;
      // Moving a feed in the page loses its scroll; put each back after.
      const kept = new Map();
      for (const id of shown) {
        const t = state.tabs.get(id);
        if (t && !t.el.hidden && t.el.isConnected) kept.set(id, t.stuck ? null : t.el.scrollTop);
      }
      const hadFocus = document.activeElement === input;
      const nodes = [];
      state.grid.forEach((col, c) => {
        if (c) nodes.push(divider('w', c - 1));
        const colEl = h('div', { class: 'pane-col', dataset: { col: c } });
        col.forEach((pane, r) => {
          if (r) colEl.append(divider('h', c, r - 1));
          colEl.append(paneOf(pane).el);
        });
        nodes.push(colEl);
      });
      paneRow().replaceChildren(...nodes);
      for (const id of shown) { const t = state.tabs.get(id); if (t) t.el.hidden = false; }
      requestAnimationFrame(() => {
        for (const id of shown) {
          const t = state.tabs.get(id);
          if (!t) continue;
          const top = kept.get(id);
          if (top == null) t.scrollToEnd(); // a hidden feed comes back showing the latest
          else t.el.scrollTop = top;
        }
      });
      if (hadFocus) input.focus();
    }
    applySizes();
    placeBox();
    SB.refreshPaneHeads();
    SB.savePanes();
  };

  // Shares, not raw weights: a flex-grow sum under 1 leaves part of the row empty.
  function applySizes() {
    const { cols, rows } = P.shares(state.grid, state.paneSizes);
    for (const col of paneRow().querySelectorAll(':scope > .pane-col')) {
      const c = +col.dataset.col;
      col.style.flexGrow = cols[c] ?? 1;
      (state.grid[c] || []).forEach((pane, r) => { const p = panes.get(pane.id); if (p) p.el.style.flexGrow = rows[c]?.[r] ?? 1; });
    }
  }
  SB.applyPaneSizes = applySizes;

  // The layout, for the next start: a moment after it settles, only while
  // split, never from a popped-out window. Back to one pane, it's cleared once,
  // so one pane writes nothing and starts as it always has.
  let saveTimer = null;
  SB.savePanes = () => {
    if (SB.solo) return;
    const split = P.count(state.grid) > 1;
    if (!split && !state.panesSaved) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.panesSaved = split;
      api.savePaneLayout(split ? { grid: state.grid, sizes: state.paneSizes } : null);
    }, 500);
  };

  // While there's more than one pane the box lives in the focused one, and the
  // others show their own draft in its place: a stand-in that hands the box
  // over on a click or a key. With one pane it sits where it always has.
  function placeBox() {
    const split = panes.size > 1;
    const into = split ? panes.get(focusedPane())?.slot : null;
    if (box.parentElement !== (into || home)) {
      const hadFocus = document.activeElement === input;
      SB.hideSlash?.(); // slash-menu.js and composer.js load after this file
      SB.hidePick?.();
      if (into) into.replaceChildren(box); else home.append(box);
      if (hadFocus) input.focus();
    }
    for (const [id, p] of panes) {
      if (p.slot === into) continue;
      if (!split) p.slot.replaceChildren();
      else if (!p.slot.querySelector('.pane-standin')) p.slot.replaceChildren(standIn(id));
    }
  }

  // Its name for a screen reader is what it shows: the draft, the mark and the
  // queue. The title says what it's for. It speaks for whichever tab its pane shows.
  function standIn(paneId) {
    return h('button', {
      class: 'pane-standin', type: 'button', dataset: { pane: paneId },
      title: 'Type here to give this conversation a task',
      // The #feeds pointerdown below hands this pane the box and focuses it;
      // the press that follows would land on whatever is under the pointer once
      // the box has moved, and take the focus off it. Cancelling the pointerdown
      // keeps that press from happening, and with it the press that closes an
      // open menu (core.js), so that's done here.
      onpointerdown: e => { SB.closeMenus(); e.preventDefault(); },
      // Enter or Space on it. After a pointer press the box has already moved in.
      onclick: () => { const id = activeOf(paneId); if (id) SB.activate(id); },
      onkeydown: e => {
        // AltGr comes as Ctrl+Alt, and types @, { or \ on many keyboards.
        if (e.key.length !== 1 || e.metaKey || ((e.ctrlKey || e.altKey) && !e.getModifierState('AltGraph'))) return;
        const id = activeOf(paneId);
        if (!id) return;
        e.preventDefault();
        SB.activate(id);
        input.setRangeText(e.key, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      },
    }, h('span', { class: 'standin-text' }), h('span', { class: 'standin-meta' }));
  }

  // The line between two columns (axis 'w', after column c) or two panes in
  // column c (axis 'h', after pane r). Drag it; double-click to even them out.
  function divider(axis, c, r = null) {
    return h('div', {
      class: `pane-divider ${axis === 'w' ? 'across' : 'down'}`, role: 'separator',
      'aria-orientation': axis === 'w' ? 'vertical' : 'horizontal',
      title: 'Drag to resize · double-click to even out',
      onpointerdown: e => dragDivider(e, axis, c, r),
      ondblclick: () => { state.paneSizes = P.even(state.grid, state.paneSizes, axis, c); applySizes(); SB.savePanes(); },
    });
  }

  function dragDivider(e, axis, c, r) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const across = axis === 'w';
    const ids = across ? [state.grid[c][0].id, state.grid[c + 1][0].id] : [state.grid[c][r].id, state.grid[c][r + 1].id];
    const els = across ? [...paneRow().querySelectorAll(':scope > .pane-col')].slice(c, c + 2) : ids.map(id => panes.get(id).el);
    const [aPx, bPx] = els.map(el => el.getBoundingClientRect()[across ? 'width' : 'height']);
    const s0 = P.fitSizes(state.grid, state.paneSizes);
    const [a, b] = ids.map(id => s0[axis][id]);
    const start = across ? e.clientX : e.clientY;
    const min = across ? P.MIN.width : P.MIN.height;
    const line = e.currentTarget;
    line.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-panes');
    const move = ev => {
      const [na, nb] = P.splitPair(a, b, aPx, bPx, (across ? ev.clientX : ev.clientY) - start, min);
      const s = P.setWeight(state.grid, s0, axis, c, across ? null : r, na);
      state.paneSizes = P.setWeight(state.grid, s, axis, across ? c + 1 : c, across ? null : r + 1, nb);
      applySizes();
    };
    // Lost capture ends it too: renderPanes may redraw the line away mid-drag,
    // and then no pointerup ever comes. A line no longer on the page loses it at
    // the document, so listen there as well. Whichever comes first ends it, once.
    let done = false;
    const up = ev => {
      if (done || ev.pointerId !== e.pointerId) return;
      done = true;
      line.removeEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) line.removeEventListener(type, up);
      document.removeEventListener('lostpointercapture', up, true);
      document.body.classList.remove('resizing-panes');
      SB.savePanes();
    };
    line.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) line.addEventListener(type, up);
    document.addEventListener('lostpointercapture', up, true);
  }

  // A pane's header is its tab strip, with its own edge markers (tab-overview.js),
  // then a new conversation in this pane, pop out the tab it shows, and close the pane.
  function paneHead(paneId) {
    const strip = h('div', { class: 'tabs pane-tabs', role: 'tablist', 'aria-label': 'Conversations in this pane' });
    const left = h('button', { type: 'button', class: 'tab-edge left', hidden: true });
    const right = h('button', { type: 'button', class: 'tab-edge right', hidden: true });
    const head = h('div', { class: 'pane-head', dataset: { pane: paneId } },
      h('div', { class: 'tabs-wrap' }, strip, left, right),
      h('button', { class: 'pane-btn', type: 'button', title: 'New conversation in this pane (Ctrl+T)', 'aria-label': 'New conversation in this pane', onclick: () => newTabIn(paneId) },
        SB.icon(PLUS_ICON, { width: 1.6 })),
      h('button', { class: 'pane-btn', type: 'button', title: 'Open in its own window', 'aria-label': 'Open in its own window', onclick: () => { const id = activeOf(paneId); if (id) SB.popOut(id); } },
        SB.icon(POP_ICON)),
      h('button', { class: 'pane-btn', type: 'button', title: 'Close this pane (its conversations move to the one beside it)', 'aria-label': 'Close this pane', onclick: () => SB.closePane(paneId) },
        SB.icon(CLOSE_ICON, { width: 1.5 })));
    SB.wireStrip(strip);
    SB.watchEdges(strip, left, right);
    return { head, strip };
  }

  // A strip's "+": a new conversation in that pane, after the tab it shows.
  function newTabIn(paneId) {
    const id = activeOf(paneId);
    if (id && id !== state.activeTab) SB.activate(id);
    SB.newTab();
  }

  // Working and asking marks change all the time; the panes are updated in
  // place, so a button being pressed is never swapped out from under you.
  // tab-strip.js calls this whenever it redraws.
  SB.refreshPaneHeads = () => {
    const split = panes.size > 1;
    const here = focusedPane();
    for (const [id, p] of panes) {
      const t = state.tabs.get(activeOf(id));
      if (!t) continue;
      const focused = split && id === here;
      p.head.classList.toggle('focused', focused);
      t.el.classList.toggle('focused', focused);
      p.el.classList.toggle('focused', focused);
      p.el.dataset.tab = t.id;
      const stand = p.slot.querySelector('.pane-standin');
      if (stand) {
        const text = String(t.draft || '').trim().split('\n')[0];
        stand.querySelector('.standin-text').textContent = text || 'Type to give it a task…';
        stand.classList.toggle('no-draft', !text); // not .empty: that's the empty chat's, which rises in (panel.css)
        const q = t.queue?.length || 0;
        // Working, asking or done: the same mark the strip shows (tab-strip.js tabIcon).
        stand.querySelector('.standin-meta').replaceChildren(...[SB.tabIcon(t), q ? `${q} queued` : null].filter(Boolean));
      }
    }
    // Which pane you're typing to, when there's more than one it could be.
    const tab = SB.activeTab();
    input.placeholder = split && tab ? `Give "${SB.shownTitle(tab).slice(0, 40)}" a task…` : PLACEHOLDER;
    // A popped-out window is named for its conversation, on the taskbar too.
    if (SB.solo && tab) document.title = $('winTitle').textContent = SB.shownTitle(tab);
  };

  // Clicking into a pane makes it the one the box talks to: on the press, so
  // the box is there to type in by the time it's let go. Not for a button or
  // link in a feed (Allow on a permission card, an answer): the box moving in
  // can scroll a feed kept at its end up under the pointer before it's let go,
  // and the click would miss. Those focus their pane as they're clicked. Not
  // for a pane's header either: its tabs and buttons do their own thing on the
  // click, which a redraw on the press would lose.
  const FEED_CONTROL = '.feed :is(button, a[href], input, select, textarea, summary, label, [role="button"], [role="menuitem"], [role="option"])';
  const paneTo = e => {
    if (e.target.closest?.('.pane-head')) return null;
    const id = e.target.closest?.('[data-tab]')?.dataset.tab;
    return id && id !== state.activeTab && state.tabs.has(id) ? id : null;
  };
  $('feeds').addEventListener('pointerdown', e => {
    const id = paneTo(e);
    if (id && !e.target.closest(FEED_CONTROL)) SB.activate(id);
  });
  // A field there that the press put the keyboard in (an answer of your own, a
  // note on a plan) keeps it: activating hands it to the box otherwise.
  $('feeds').addEventListener('click', e => {
    const id = paneTo(e);
    if (!id || !e.target.closest(FEED_CONTROL)) return;
    const field = document.activeElement;
    SB.activate(id);
    if (field !== document.activeElement && field?.isConnected && field.closest('.feed') && field.matches('input, textarea, select, [contenteditable]')) field.focus({ preventScroll: true });
  }, true);

  // Drop `tabId` on pane `target` (`zone`: see panes.place; 'strip' with
  // `before`, the tab to land in front of) and focus it there, growing the
  // window first if a new pane needs it. -> placed?
  SB.placeTab = async (tabId, target, zone, before = null) => {
    const was = state.grid;
    let next = P.place(was, tabId, target, zone, before);
    if (next === was) return false;
    let room = { ok: true, space: null };
    if (EDGES.has(zone)) {
      room = SB.roomFor(next);
      if (!room.ok) { SB.toast(SB.NO_ROOM); return false; }
      if (room.want) {
        await api.fitPanel(room.want);
        // The grid may have changed while the window grew (a tab closed, say): place it on that one.
        if (state.grid !== was) {
          if ((next = P.place(state.grid, tabId, target, zone, before)) === state.grid) return false;
          if (!(room = SB.roomFor(next)).ok) { SB.toast(SB.NO_ROOM); return false; }
        }
      }
    }
    const sizes = P.placeSizes(state.grid, state.paneSizes, tabId, target, zone);
    state.paneSizes = room.space ? SB.atLeastMin(next, sizes, room.space) : sizes;
    state.grid = next;
    SB.activate(tabId);
    return true;
  };

  // A pane's ×: the pane goes and its tabs move into the pane beside it
  // (panes.merge), so no conversation closes by accident. That pane keeps the
  // tab it shows, and takes the focus if the closed one had it.
  SB.closePane = (paneId) => {
    const { grid, into } = P.merge(state.grid, paneId);
    if (!into) return;
    const hadFocus = focusedPane() === paneId;
    state.grid = grid;
    if (hadFocus) SB.activate(P.byId(grid, into).active);
    else { SB.renderPanes(); SB.renderTabStrip(); }
  };

  // The split shortcut and button. The focused pane's tab goes into a pane of
  // its own when its pane holds others; otherwise a new conversation does.
  // Beside the focused pane while there's room for another column, then below
  // one. ('new' stands in for a new conversation while the room is measured:
  // an id in no pane, so place treats it as a tab coming from off screen.)
  SB.splitPane = async () => {
    if (SB.solo || !state.activeTab || !(await SB.chatShowing())) return;
    const here = P.paneWith(state.grid, state.activeTab);
    const take = here && here.tabs.length > 1 ? state.activeTab : null;
    const moving = take || 'new';
    const spots = [...new Set([here?.id, ...P.paneIds(state.grid)].filter(Boolean))];
    const fits = zone => id => P.zones(state.grid, id, moving).includes(zone) && SB.roomFor(P.place(state.grid, moving, id, zone)).ok;
    const side = spots.find(fits('right'));
    const below = !side && spots.find(fits('bottom'));
    if (!side && !below) {
      return SB.toast(P.count(state.grid) >= P.MAX_COLS * P.MAX_ROWS ? 'Twelve is as many as there are. Close a pane first.' : SB.NO_ROOM);
    }
    const target = side || below;
    const zone = side ? 'right' : 'bottom';
    if (take) return SB.placeTab(take, target, zone);
    const fresh = (await SB.newTab({ focus: false, reuse: false }))?.id;
    // Refused after all (the room went while the window grew): the tab made for it goes again.
    if (fresh && !(await SB.placeTab(fresh, target, zone))) SB.closeTab(fresh);
  };

  // Ctrl+Alt+arrow: this conversation moves into the pane that way, where it
  // joins that pane's tabs, or at the left or right edge takes a column of its
  // own (panes.moveToward decides; placeTab checks the room). From another view
  // the chat is shown and settled first, as for Split. -> moved?
  const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  SB.paneDir = key => DIRS[key] || null;
  SB.movePane = async (tabId, dir) => {
    if (SB.solo || !(await SB.chatShowing())) return false;
    const to = P.moveToward(state.grid, tabId, dir);
    if (to) return SB.placeTab(tabId, to.target, to.zone); // which toasts when the room's not there
    // At the left or right edge with something to leave behind (other tabs in
    // its pane, or a pane it shares a column with), but no fifth column: say so.
    const own = P.paneWith(state.grid, tabId);
    const at = own && P.find(state.grid, own.id);
    if ((dir === 'left' || dir === 'right') && at && !P.neighbor(state.grid, own.id, dir) && (own.tabs.length > 1 || state.grid[at.c].length > 1)) {
      SB.toast(state.grid.length >= P.MAX_COLS ? 'Four columns is as many as there are. Close a pane first.' : SB.NO_ROOM);
    }
    return false;
  };

  // Something on top of the chat that has the keyboard: the jump-anywhere
  // palette (#paletteSheet), a dialog sheet (.card-sheet: the shortcut list, the
  // share card and the rest) or an open menu or popover (core.js anyMenuOpen,
  // which counts the slash and @ menus too).
  SB.overlayOpen = () => !!document.querySelector('.palette-sheet:not([hidden]), .card-sheet:not([hidden])') || SB.anyMenuOpen();

  // ------------------------------------------------------------ where a dragged tab lands

  const OUT = 24;   // px past the window's edge before letting go pops the tab out

  // What letting go here would do: reorder the top strip or a pane's own
  // strip, join a pane (on its strip, where it's dropped; in its middle, at
  // the end), split one, pop the tab out (well outside the window), or
  // nothing. For tab-strip.js's drag.
  SB.dropAt = (x, y, dragId) => {
    const w = window.innerWidth, ht = window.innerHeight;
    if (x < -OUT || y < -OUT || x > w + OUT || y > ht + OUT) return SB.solo ? null : { kind: 'out' };
    x = Math.min(Math.max(x, 0), w - 1);
    y = Math.min(Math.max(y, 0), ht - 1);
    if (y < $('tabstrip').getBoundingClientRect().bottom) return { kind: 'strip' }; // hidden while split: a zero rect
    if (state.view !== 'chat') return null;
    const inside = r => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
    for (const pane of state.grid.flat()) {
      const p = panes.get(pane.id);
      if (!p) continue;
      // Its header is its strip (hidden, a zero rect, with one pane): its own
      // tab moves along it, any other joins the pane there.
      if (inside(p.head.getBoundingClientRect())) {
        const before = stripBefore(p.strip, x, dragId);
        if (pane.tabs.includes(dragId)) return { kind: 'strip', pane: pane.id, before };
        return { kind: 'join', target: pane.id, before, rect: barAt(p.strip, before) };
      }
      const r = p.el.getBoundingClientRect();
      if (!inside(r)) continue;
      // Only where the panes would still fit on this screen.
      const allowed = P.zones(state.grid, pane.id, dragId).filter(z => z === 'center' || SB.roomFor(P.place(state.grid, dragId, pane.id, z)).ok);
      const zone = P.zoneAt(r, x, y, allowed);
      if (!allowed.includes(zone)) return null; // the middle of the pane already showing it
      return { kind: 'pane', target: pane.id, zone, rect: P.previewRect(zone, r, p.el.parentElement.getBoundingClientRect()) };
    }
    return null;
  };

  // The tab to land in front of on a pane's strip: the first, other than the
  // one being dragged, whose midpoint is right of the pointer. null: the end.
  function stripBefore(strip, x, dragId) {
    for (const el of strip.children) {
      if (el.dataset.tabId === dragId) continue;
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) return el.dataset.tabId;
    }
    return null;
  }

  // Where on a strip a tab joining it lands, for the drop preview: a thin bar
  // in front of `before`, or after the strip's last tab.
  function barAt(strip, before) {
    const s = strip.getBoundingClientRect();
    const tabs = [...strip.children];
    const at = tabs.find(el => el.dataset.tabId === before);
    const last = tabs.at(-1)?.getBoundingClientRect();
    const left = at ? at.getBoundingClientRect().left : last ? last.right : s.left;
    return { left: Math.max(s.left, left - 2), top: s.top, width: 4, height: s.height };
  }

  // A tab dragged along its own pane's strip, while split: it moves as the
  // pointer goes, as on the top strip (tab-strip.js); the layout keeps the order.
  SB.reorderInPane = (tabId, before) => {
    const pane = P.paneWith(state.grid, tabId);
    const next = pane && P.join(state.grid, tabId, pane.id, before);
    if (!next || next === state.grid) return;
    state.grid = next;
    SB.renderTabStrip();
    SB.savePanes();
  };

  // The preview of where it will land (a pane's half, or a bar on a strip), or none.
  SB.showDrop = (drop) => {
    const hint = $('dropHint');
    hint.hidden = drop?.kind !== 'pane' && drop?.kind !== 'join';
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

  // The tab to show once the focused one has gone. Split: the one pane `was`
  // (the pane it was in) shows now, else the first pane's. With one pane, the
  // last tab in the strip, as it always was.
  function nextShown(was) {
    const split = P.count(state.grid) > 1;
    return (split && (activeOf(was) || P.shownTabs(state.grid)[0])) || [...state.tabs.keys()].pop();
  }
  // For main's tab list (tabs.js syncTabs) arriving with no tab focused: the
  // focused one taken away under the panes, its replacement not here yet.
  SB.nextShown = () => { SB.settlePanes(); return nextShown(homePane()); };

  // A tab leaves this window: closed, popped out, or gone from main. Split,
  // its pane shows its neighbour (a pane left with none closes) and, if it was
  // the one the box talked to, that neighbour takes the focus (nextShown).
  SB.forgetTab = (tabId) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    const was = P.paneWith(state.grid, tabId)?.id;
    tab.destroy();
    state.tabs.delete(tabId);
    state.grid = P.leave(state.grid, tabId);
    if (state.activeTab !== tabId) return SB.renderPanes();
    state.activeTab = null;
    const next = nextShown(was);
    if (next) SB.activate(next);
    else if (!SB.solo) SB.newTab();
  };

  // A popped-out conversation's window closed: it's a tab here again, in the
  // focused pane (renderTabStrip settles it there).
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
