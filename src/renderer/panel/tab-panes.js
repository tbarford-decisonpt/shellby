/* Shellby panel — conversations side by side, and in windows of their own.
   The chat view shows the tabs in state.grid (shared/panes.js decides the
   shapes: up to four columns of up to three), each pane with a slim
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

  const panes = new Map();   // tabId -> { el, head, slot }, for the tabs on screen
  let shape = '';            // the grid the pane elements were last put together for
  const box = $('composer');
  const home = $('chatView');

  const paneRow = () => $('feeds').querySelector(':scope > .pane-row') || $('feeds').appendChild(h('div', { class: 'pane-row' }));

  // A tab's pane: its header, its feed and the slot under it for the box.
  function paneOf(t) {
    let p = panes.get(t.id);
    if (!p) {
      const head = paneHead(t);
      const slot = h('div', { class: 'pane-slot' });
      p = { el: h('div', { class: 'pane', dataset: { tab: t.id } }, head, t.el, slot), head, slot };
      panes.set(t.id, p);
    } else if (t.el.parentElement !== p.el) p.el.insertBefore(t.el, p.slot);
    return p;
  }

  // A pane leaves the screen. Its feed goes back to waiting, hidden, in #feeds.
  function dropPane(id) {
    const p = panes.get(id);
    if (!p) return;
    if (p.slot.contains(box)) home.append(box);
    const t = state.tabs.get(id);
    if (t && t.el.parentElement === p.el) { t.el.hidden = true; $('feeds').append(t.el); }
    p.el.remove();
    panes.delete(id);
  }

  // `tabId` takes the focused pane, unless it's on screen already: then its
  // pane takes the focus. With the focused tab just gone, it takes that one's
  // place. tabs.js calls this as it activates a tab.
  SB.showInPane = (tabId) => {
    const into = state.activeTab ?? P.ids(state.grid).find(id => !state.tabs.has(id));
    state.grid = P.keep(P.replace(state.grid, into, tabId), id => state.tabs.has(id));
  };

  SB.renderPanes = () => {
    state.paneSizes = P.fitSizes(state.grid, state.paneSizes);
    const shown = new Set(P.ids(state.grid));
    $('feeds').dataset.panes = shown.size;
    for (const id of [...panes.keys()]) if (!shown.has(id) || !state.tabs.has(id)) dropPane(id);
    for (const t of state.tabs.values()) if (!shown.has(t.id)) t.el.hidden = true;
    const next = JSON.stringify(state.grid);
    // A tab made anew under an id already on screen (the screenshot demo) has a feed no pane holds yet.
    const loose = [...shown].some(id => state.tabs.get(id)?.el.parentElement !== panes.get(id)?.el);
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
        col.forEach((id, r) => {
          if (r) colEl.append(divider('h', c, r - 1));
          colEl.append(paneOf(state.tabs.get(id)).el);
        });
        nodes.push(colEl);
      });
      paneRow().replaceChildren(...nodes);
      for (const id of shown) state.tabs.get(id).el.hidden = false;
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
    SB.savePanes?.();
  };

  // Shares, not raw weights: a flex-grow sum under 1 leaves part of the row empty.
  function applySizes() {
    const { cols, rows } = P.shares(state.grid, state.paneSizes);
    for (const col of paneRow().querySelectorAll(':scope > .pane-col')) {
      const c = +col.dataset.col;
      col.style.flexGrow = cols[c] ?? 1;
      (state.grid[c] || []).forEach((id, r) => { const p = panes.get(id); if (p) p.el.style.flexGrow = rows[c]?.[r] ?? 1; });
    }
  }

  // While there's more than one pane the box lives in the focused one, and the
  // others show their own draft in its place: a stand-in that hands the box
  // over on a click or a key. With one pane it sits where it always has.
  function placeBox() {
    const split = panes.size > 1;
    const into = split ? panes.get(state.activeTab)?.slot : null;
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

  function standIn(id) {
    return h('button', {
      class: 'pane-standin', type: 'button', dataset: { tab: id },
      'aria-label': 'Type here to give this conversation a task',
      // The #feeds pointerdown below hands this pane the box and focuses it;
      // the press that follows would land on whatever is under the pointer once
      // the box has moved, and take the focus off it. Cancelling the pointerdown
      // keeps that press from happening.
      onpointerdown: e => e.preventDefault(),
      onkeydown: e => {
        if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
        e.preventDefault();
        SB.activate(id);
        input.setRangeText(e.key, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      },
    }, h('span', { class: 'standin-text' }), h('span', { class: 'standin-meta' }));
  }

  // ------------------------------------------------------------ room

  // What the panes take beyond P.MIN, measured from components.css with the
  // panes split: #feeds has 6 px of padding left, right and top; each column
  // after the first has a 6 px line before it, and each pane a 6 px margin
  // under it (the line between two in a column sits in that margin). So N
  // columns of M panes take N x 286 + 6 by M x 206 + 6 px. A pane's header
  // (28 px), border and stand-in or box are inside its MIN.
  const PANE_CHROME = { width: 6, height: 6 };
  const FEEDS_PAD = 6;
  // Main keeps a grown panel this far inside the screen's work area (wiring/panel.js ROOMY.gap).
  const SCREEN_GAP = 8 * 2;

  // Room for `grid` in this window: { ok: true } as it is, { ok: true, want }
  // once the window grows to `want` ({ width, height } in DIP, what main's
  // fitPanel takes), or { ok: false }: not on this screen. `space`: the CSS px
  // the panes get then. The DOM measures in CSS px, which the page's zoom
  // scales; the window and screen are in DIP.
  SB.roomFor = (grid) => {
    const f = $('feeds').getBoundingClientRect();
    const n = P.needs(grid, PANE_CHROME);
    const need = { width: n.width + FEEDS_PAD, height: n.height + FEEDS_PAD };
    // Split, the box moves into a pane and the feeds take its place.
    const avail = { width: f.width, height: f.height + (box.parentElement === home ? box.offsetHeight : 0) };
    const space = { width: Math.max(avail.width, need.width), height: Math.max(avail.height, need.height) };
    if (need.width <= avail.width && need.height <= avail.height) return { ok: true, space };
    const zoom = api.zoomFactor?.() || 1;
    // innerWidth x zoom is the window's own size (outerWidth adds Windows' invisible resize frame).
    const want = {
      width: Math.round(window.innerWidth * zoom) + Math.ceil(Math.max(0, need.width - avail.width) * zoom),
      height: Math.round(window.innerHeight * zoom) + Math.ceil(Math.max(0, need.height - avail.height) * zoom),
    };
    if (want.width > window.screen.availWidth - SCREEN_GAP || want.height > window.screen.availHeight - SCREEN_GAP) return { ok: false };
    return { ok: true, want, space };
  };

  // `sizes` for `grid`, with any axis that would leave a pane under P.MIN in
  // `space` px evened out. A split halves what it splits, so in a window only
  // just big enough the halves can come out under the minimum though the
  // panes fit side by side evenly (roomFor's sum).
  function atLeastMin(grid, sizes, space) {
    const { cols, rows } = P.shares(grid, sizes);
    const across = space.width - FEEDS_PAD - grid.length * PANE_CHROME.width;
    let s = sizes;
    if (cols.some(f => f * across < P.MIN.width - 0.5)) s = P.even(grid, s, 'w');
    grid.forEach((col, c) => {
      const down = space.height - FEEDS_PAD - col.length * PANE_CHROME.height;
      if (rows[c].some(f => f * down < P.MIN.height - 0.5)) s = P.even(grid, s, 'h', c);
    });
    return s;
  }

  const NO_ROOM = 'No room for another pane on this screen. Close one, or make the window bigger.';

  // The line between two columns (axis 'w', after column c) or two panes in
  // column c (axis 'h', after pane r). Drag it; double-click to even them out.
  function divider(axis, c, r = null) {
    return h('div', {
      class: `pane-divider ${axis === 'w' ? 'across' : 'down'}`, role: 'separator',
      'aria-orientation': axis === 'w' ? 'vertical' : 'horizontal',
      title: 'Drag to resize · double-click to even out',
      onpointerdown: e => dragDivider(e, axis, c, r),
      ondblclick: () => { state.paneSizes = P.even(state.grid, state.paneSizes, axis, c); applySizes(); SB.savePanes?.(); },
    });
  }

  function dragDivider(e, axis, c, r) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const across = axis === 'w';
    const ids = across ? [state.grid[c][0], state.grid[c + 1][0]] : [state.grid[c][r], state.grid[c][r + 1]];
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
      SB.savePanes?.();
    };
    line.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) line.addEventListener(type, up);
    document.addEventListener('lostpointercapture', up, true);
  }

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
    const split = panes.size > 1;
    for (const [id, p] of panes) {
      const head = p.head;
      const t = state.tabs.get(id);
      if (!t) continue;
      const focused = split && id === state.activeTab;
      head.classList.toggle('focused', focused);
      t.el.classList.toggle('focused', focused);
      p.el.classList.toggle('focused', focused);
      head.querySelector('.pane-state').replaceChildren(...[SB.tabIcon(t)].filter(Boolean));
      const title = head.querySelector('.pane-title');
      title.textContent = SB.shownTitle(t);
      title.title = t.title;
      const stand = p.slot.querySelector('.pane-standin');
      if (stand) {
        const text = String(t.draft || '').trim().split('\n')[0];
        stand.querySelector('.standin-text').textContent = text || 'Type to give it a task…';
        stand.classList.toggle('empty', !text);
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

  // Clicking into a pane makes it the one the box talks to.
  $('feeds').addEventListener('pointerdown', e => {
    const id = e.target.closest('[data-tab]')?.dataset.tab;
    if (id && id !== state.activeTab && state.tabs.has(id)) SB.activate(id);
  });

  // Drop `tabId` on `target`'s pane (`zone`: see panes.place) and focus it
  // there, growing the window first if the panes need it. -> placed?
  SB.placeTab = async (tabId, target, zone) => {
    const before = state.grid;
    let next = P.place(before, tabId, target, zone);
    if (next === before) return false;
    const room = SB.roomFor(next);
    if (!room.ok) { SB.toast(NO_ROOM); return false; }
    if (room.want) {
      await api.fitPanel(room.want);
      // The grid may have changed while the window grew (a tab closed, say).
      if (state.grid !== before && (next = P.place(state.grid, tabId, target, zone)) === state.grid) return false;
    }
    state.paneSizes = atLeastMin(next, P.placeSizes(state.grid, state.paneSizes, tabId, target, zone), room.space);
    state.grid = next;
    SB.activate(tabId);
    return true;
  };

  // Off screen, but still a tab.
  SB.closePane = (tabId) => {
    if (!SB.isShown(tabId) || P.ids(state.grid).length < 2) return;
    state.grid = P.remove(state.grid, tabId);
    if (state.activeTab === tabId) SB.activate(P.ids(state.grid)[0]);
    else { SB.renderPanes(); SB.renderTabStrip(); }
  };

  // The split shortcut and button: the newest conversation that isn't on screen
  // (or a fresh one) goes beside the focused pane while there's room for
  // another column, then below one. ('new' stands in for it: an id never in
  // the grid, so place treats it as a tab coming from off screen.)
  SB.splitPane = async () => {
    if (SB.solo || !state.activeTab) return;
    const spots = [state.activeTab, ...P.ids(state.grid)];
    const fits = zone => id => P.zones(state.grid, id).includes(zone) && SB.roomFor(P.place(state.grid, 'new', id, zone)).ok;
    const side = spots.find(fits('right'));
    const below = !side && spots.find(fits('bottom'));
    if (!side && !below) {
      return SB.toast(P.ids(state.grid).length >= P.MAX_COLS * P.MAX_ROWS ? 'Twelve is as many as there are. Close a pane first.' : NO_ROOM);
    }
    let next = [...state.tabs.keys()].reverse().find(id => !SB.isShown(id));
    if (!next) next = (await SB.newTab({ focus: false, reuse: false }))?.id;
    if (next) await SB.placeTab(next, side || below, side ? 'right' : 'bottom');
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
      if (!panes.has(id)) continue;
      const pane = paneRect(id);
      if (x < pane.left || x >= pane.left + pane.width || y < pane.top || y >= pane.top + pane.height) continue;
      if (id === dragId) return null;
      // Only where the panes would still fit on this screen.
      const allowed = P.zones(state.grid, id, dragId).filter(z => z === 'center' || SB.roomFor(P.place(state.grid, dragId, id, z)).ok);
      const zone = P.zoneAt(pane, x, y, allowed);
      const colRect = panes.get(id).el.parentElement.getBoundingClientRect();
      return { kind: 'pane', target: id, zone, rect: P.previewRect(zone, pane, colRect) };
    }
    return null;
  };

  // A pane: its header (when it shows), its feed and its box slot.
  const paneRect = id => panes.get(id).el.getBoundingClientRect();

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
    dropPane(tabId);
    tab.destroy();
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
