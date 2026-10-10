/* Shellby panel — the tab strip: each conversation's tab, its icon and name,
   renaming it, its right-click menu, and dragging it: along the strip, into a
   pane of the chat, or out of the window (where it lands: tab-panes.js).
   tabs.js owns the tabs themselves. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const L = window.ShellbyTabLogic;
  // Theirs, reached when they're called (the file loads after this one).
  const contextText = c => SB.contextText(c);
  const contextLevel = c => SB.contextLevel(c);

  // ------------------------------------------------------------ the strip

  let drag = null;   // the tab being dragged along the strip (see "drag to reorder")
  let renaming = null;  // the tab whose name is being edited in the strip (see "rename")
  let shownActive = null;  // the tab the strip last scrolled into view

  // The strip is redrawn from scratch, and a new element starts its animation
  // from the top. Backdated to when the page loaded, every redraw picks the
  // spin up where the last one left off.
  const onPageClock = () => `animation-delay: -${Math.round(performance.now())}ms`;

  function tabIcon(t) {
    const icon = L.icon(t, window.ShellbyTabSort.activity(t));
    if (!icon) return null;
    if (icon.kind === 'busy') return h('span', { class: 'ti ti-busy', style: onPageClock(), title: icon.title }, t.crew ? h('b', { text: t.crew }) : null);
    if (icon.kind === 'bg') return h('span', { class: 'ti ti-bg', style: onPageClock(), title: icon.title });
    return h('span', { class: `ti ti-${icon.kind}`, title: icon.title, text: icon.text });
  }
  SB.tabIcon = tabIcon;

  // The strip is one Tab stop: arrow keys, Home and End walk the conversations.
  function tabKey(e, id) {
    if (e.target !== e.currentTarget) return; // keys in the rename box are the box's
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return SB.activate(id); }
    if (e.key === 'F2') { e.preventDefault(); return SB.renameTab(id); }
    const to = L.keyTarget([...state.tabs.keys()], id, e.key);
    if (!to || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    SB.activate(to);
    [...$('tabs').querySelectorAll('[data-tab-id]')].find(el => el.dataset.tabId === to)?.querySelector('[role="tab"]').focus();
  }

  SB.renderTabStrip = () => {
    const strip = $('tabs');
    // Redrawing would throw away the name being typed; finishing the edit redraws.
    if (renaming && strip.querySelector('.title-edit')) return;
    // A busy tab redraws the strip as it streams; keep the keyboard on the tab (or ×) it was on.
    const focused = strip.contains(document.activeElement) ? document.activeElement : null;
    const keep = focused && { id: focused.closest('[data-tab-id]')?.dataset.tabId, x: focused.classList.contains('tab-x') };
    const split = SB.panes.ids(state.grid).length > 1;
    strip.replaceChildren(...[...state.tabs.values()].map(t => {
      const active = t.id === state.activeTab;
      const shown = split && SB.isShown(t.id);
      const clash = SB.clashLine?.(t.id) || '';
      // .tab draws the tab; inside it the role=tab part and its × sit side by
      // side (a button can't live inside a tab).
      const btn = h('div', {
        class: L.tabClass(t, { active, shown, clash, dragging: !!drag?.moved && t.id === drag.id }),
        role: 'presentation',
        'data-tab-id': t.id,
        onclick: () => SB.activate(t.id),
        onauxclick: e => { if (e.button === 1) SB.closeTab(t.id); },
        onpointerdown: e => dragStart(e, t.id),
        oncontextmenu: e => { e.preventDefault(); openTabMenu(t.id, e.currentTarget.querySelector('[role="tab"]')); },
      },
      h('div', {
        class: 'tab-main', role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1',
        title: [t.title, t.branchOf ? `Branched from "${t.branchOf.title}"` : null, t.agent ? `Run by your ${t.agent} agent` : null,
          t.safeMode ? 'Safe mode: without your CLAUDE.md, skills, plugins, hooks and MCP servers' : null, clash || null, t.context ? contextText(t.context) : null].filter(Boolean).join('\n'),
        onkeydown: e => tabKey(e, t.id),
      },
      tabIcon(t),
      h('span', { class: 'tab-title', text: shownTitle(t) }),
      t.safeMode ? h('span', { class: 'tab-safe', 'aria-label': ', safe mode', text: '🛟' }) : null,
      // Another copy changed the same files (clashes.js): a shape, not just a colour, and said aloud.
      clash ? h('span', { class: 'tab-clash', 'aria-hidden': 'true', text: '⚠' }) : null,
      clash ? h('span', { class: 'sr-only', text: `. ${clash}` }) : null),
      // Only the open tab's × is a Tab stop; Ctrl+W closes any of them.
      h('button', { class: 'tab-x', type: 'button', tabindex: active ? null : '-1', 'aria-label': `Close ${t.title}`, title: `Close (${SB.shortcuts.primary('closeTab')})`, onclick: e => { e.stopPropagation(); SB.closeTab(t.id); } }, '×'),
      t.context ? h('span', { class: `tab-ctx ${contextLevel(t.context)}`, 'aria-hidden': 'true', style: `--fill: ${t.context.pct / 100}` }) : null);
      return btn;
    }));
    if (keep?.id) {
      const tab = [...strip.querySelectorAll('[data-tab-id]')].find(el => el.dataset.tabId === keep.id);
      tab?.querySelector(keep.x ? '.tab-x' : '[role="tab"]')?.focus({ preventScroll: true });
    }
    // Only when the open tab changes, so a working tab redrawing the strip doesn't
    // snap it back while you're scrolling through the rest. Not while dragging:
    // following the active tab would fight the strip's own scrolling.
    if (!drag && shownActive !== state.activeTab) {
      shownActive = state.activeTab;
      strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    // Title bar shows total running count at a glance.
    const running = [...state.tabs.values()].filter(t => t.busy).length;
    document.body.classList.toggle('busy', running > 0);
    SB.refreshPaneHeads(); // the panes' headers show the same names and marks
  };
  const shownTitle = L.shownTitle;
  SB.shownTitle = shownTitle;
  // tabs.js leaves the order alone while a tab is being dragged.
  SB.isDraggingTab = () => !!drag;

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

  // Right-click a tab (or Shift+F10 on it) for the same things, spelled out.
  function openTabMenu(tabId, anchor) {
    SB.openMenu($('tabMenu'), anchor, () => [
      h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { SB.closeMenus(); SB.renameTab(tabId); } },
        h('span', { class: 'mi-check', text: '✎' }), h('span', { class: 'mi-title', text: 'Rename  (F2)' })),
      handoffItem(tabId),
      safeItem(tabId),
      h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { SB.closeMenus(); SB.closeTab(tabId); } },
        h('span', { class: 'mi-check', text: '×' }), h('span', { class: 'mi-title', text: `Close  (${SB.shortcuts.primary('closeTab')})` })),
    ].filter(Boolean));
  }

  // ------------------------------------------------------------ to a terminal and back (handoff.js)

  // Only once there's a conversation to carry on: a blank tab has nothing to resume.
  function handoffItem(tabId) {
    const t = state.tabs.get(tabId);
    if (!t?.saved) return null;
    const back = !!t.inTerminal;
    return h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { SB.closeMenus(); (back ? SB.pickUpHere : SB.continueInTerminal)(tabId); } },
      h('span', { class: 'mi-check', text: back ? '↩' : '›_' }), h('span', { class: 'mi-title', text: back ? 'Pick it up here' : 'Continue in a terminal' }));
  }

  // ------------------------------------------------------------ safe mode (claude --safe-mode)

  // Is something of yours (a hook, a plugin, CLAUDE.md, an MCP server) the
  // trouble? The same conversation without any of them says.
  function safeItem(tabId) {
    const t = state.tabs.get(tabId);
    if (!t) return null;
    return h('button', { class: 'menu-item', role: 'menuitem', title: t.safeMode ? 'Your CLAUDE.md, skills, plugins, hooks and MCP servers come back from the next message'
      : 'From the next message, without your CLAUDE.md, skills, plugins, hooks, MCP servers or custom agents: to see if one of them is the trouble',
    onclick: () => { SB.closeMenus(); SB.setSafeMode(tabId, !t.safeMode); } },
    h('span', { class: 'mi-check', text: '🛟' }), h('span', { class: 'mi-title', text: t.safeMode ? 'Turn safe mode off' : 'Try it in safe mode' }));
  }

  SB.setSafeMode = async (tabId, on) => {
    const r = await api.setSafeMode({ tabId, on }).catch(() => null);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't switch safe mode.", { ms: 6000 });
    const tab = state.tabs.get(tabId);
    if (tab) { tab.safeMode = on; SB.renderTabStrip(); }
  };

  // id: an open tab, or a History row that may be closed.
  SB.continueInTerminal = async (id) => {
    const r = await api.continueInTerminal(id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't open a terminal.", { ms: 5000 });
    const tab = state.tabs.get(id);
    if (tab) { tab.inTerminal = Date.now(); SB.renderTabStrip(); }
    SB.toast(`${r.text} When you're done there, type /exit and pick it up here.`, { ms: 6000 });
    state.sessions = await api.listSessions();
    if (state.view === 'history') SB.views.history.redraw?.();
  };

  SB.pickUpHere = async (tabId) => {
    const r = await api.pickUpHere(tabId);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't pick it up.");
    const tab = state.tabs.get(tabId);
    if (tab) tab.inTerminal = null;
    SB.renderTabStrip();
    if (r.warning) SB.toast(r.warning, { ms: 6000 });
    state.sessions = await api.listSessions();
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

  // ------------------------------------------------------------ drag to reorder, split or pop out

  // The strip reorders live as the pointer crosses a neighbour's midpoint, and the
  // dragged tab keeps its place in the flow (just lifted). Nothing is positioned by
  // hand, so there's nothing to re-apply when a working tab redraws the strip
  // mid-drag — and pointermove/up are on the window, so replacing the tab's element
  // underneath the pointer doesn't cut the drag short.
  //
  // Pulled down into the chat, the tab splits a pane (a preview shows where it
  // will land); let go well outside the window, it opens in a window of its own.
  // A pane's header drags the same way (tab-panes.js).
  const EDGE = 26;            // px from a strip edge where dragging starts scrolling it
  const SLOP = 5;             // px of movement before a click becomes a drag

  function dragStart(e, tabId) {
    if (e.button !== 0 || e.target.closest('button') || SB.solo) return;
    drag = { id: tabId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false, drop: null };
    window.addEventListener('pointermove', dragMove);
    window.addEventListener('pointerup', dragEnd);
    window.addEventListener('pointercancel', dragEnd);
  }
  SB.dragTab = dragStart;

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
    drag.drop = SB.dropAt(drag.x, drag.y, drag.id);
    SB.showDrop(drag.drop);
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
    SB.showDrop(null);
    if (e.type === 'pointercancel') return;
    if (d.drop?.kind === 'pane') SB.placeTab(d.id, d.drop.target, d.drop.zone);
    if (d.drop?.kind === 'out') SB.popOut(d.id, { x: e.screenX, y: e.screenY });
    // On the strip, the click that follows this pointerup is left alone on purpose:
    // you grabbed that tab, so ending up in its conversation is what you asked for.
    // That also means not redrawing the strip here — replacing the element the
    // pointer came up on would lose the click.
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

  // A full strip of conversations doesn't fit at the default width, so holding a tab against
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

})();
