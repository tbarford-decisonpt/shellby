/* Shellby panel — keeping a lot of open conversations in reach. Markers at each
   end of the tab strip say what's scrolled out of sight (and whether any of it
   needs you), and a list of every open conversation, grouped by what it needs
   from you, opens from the strip or with Ctrl+Shift+A. Sorting is tab-sort.js. */
'use strict';
(function () {
  const { h, state, $ } = SB;
  const S = window.ShellbyTabSort;
  const strip = $('tabs');
  const list = $('tabList');
  const allBtn = $('tabAllBtn');

  const SHOW_LIST_AT = 2;                              // open conversations before the list button shows
  const URGENT = new Set(['asking', 'review', 'finished']);  // an edge marker jumps straight to these
  const SAY = { asking: 'needs your OK', review: 'is ready to review', finished: 'has finished' };
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { plural } = SB;

  // ------------------------------------------------------------ edge markers

  const watched = new Map();   // a strip -> its [left, right] markers

  function paintEdges(onStrip, left, right) {
    const items = [...onStrip.querySelectorAll('[data-tab-id]')].map(el => {
      const t = state.tabs.get(el.dataset.tabId);
      return t && { id: t.id, left: el.offsetLeft, width: el.offsetWidth, standing: S.standing(t) };
    }).filter(Boolean);
    const e = S.edges(items, { scrollLeft: onStrip.scrollLeft, width: onStrip.clientWidth });
    paintEdge(left, e.left, 'left');
    paintEdge(right, e.right, 'right');
  }

  // Every strip with markers; a pane's goes when its pane closes.
  function paintAllEdges() {
    for (const [s, [left, right]] of watched) {
      if (!s.isConnected) { watched.delete(s); continue; }
      paintEdges(s, left, right);
    }
  }

  function paintEdge(el, side, dir) {
    el.hidden = !side;
    if (!side) return;
    const urgent = URGENT.has(side.standing);
    const target = urgent && state.tabs.get(side.target);
    el.className = `tab-edge ${dir} ${side.standing}`;
    el.dataset.target = target ? target.id : '';
    const lines = [`${plural(side.count, 'more conversation', 'more conversations')} to the ${dir}`];
    if (target) lines.push(`Go to "${SB.shownTitle(target)}", which ${SAY[side.standing]}`);
    el.title = lines.join('\n');
    el.setAttribute('aria-label', lines.join('. '));
    el.replaceChildren(h('span', { class: 'tab-edge-pill' }, urgent ? h('i', { 'aria-hidden': 'true' }) : null, `+${side.count}`));
  }

  // Urgent: open it. Otherwise scroll its strip that way by most of a strip.
  function edgeClick(e) {
    const el = e.currentTarget;
    if (el.dataset.target && state.tabs.has(el.dataset.target)) return SB.activate(el.dataset.target);
    const onStrip = el.parentElement.querySelector('.tabs');
    const step = onStrip.clientWidth * 0.8 * (el.classList.contains('left') ? -1 : 1);
    onStrip.scrollBy({ left: step, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // A strip's markers follow its scrolling and its size.
  function watchEdges(onStrip, left, right) {
    if (watched.has(onStrip)) return; // once per strip, or its listeners stack
    watched.set(onStrip, [left, right]);
    let frame = 0;
    const queue = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; paintEdges(onStrip, left, right); }); };
    onStrip.addEventListener('scroll', queue, { passive: true });
    new ResizeObserver(queue).observe(onStrip);
    for (const el of [left, right]) el.addEventListener('click', edgeClick);
  }
  watchEdges(strip, $('tabEdgeLeft'), $('tabEdgeRight'));
  SB.watchEdges = watchEdges;

  // ------------------------------------------------------------ every open conversation

  const field = h('input', {
    class: 'tl-find', type: 'search', placeholder: 'Find an open conversation', spellcheck: 'false', autocomplete: 'off',
    role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': 'tlRows', 'aria-describedby': 'tlHint',
    'aria-label': 'Find an open conversation',
  });
  const rowsEl = h('div', { class: 'tl-rows', id: 'tlRows', role: 'listbox', 'aria-label': 'Open conversations' });
  const foot = h('div', { class: 'tl-foot' });
  // Finished work waiting for you opens the review inbox (review-view.js).
  const reviewBar = h('button', {
    class: 'tl-review', type: 'button', hidden: true, 'aria-keyshortcuts': 'Control+Shift+R',
    onmousedown: e => e.preventDefault(),         // keep the keyboard in the find field
    onclick: () => { SB.closeMenus(); SB.openReview?.(); },
  });
  let query = '';
  let order = [];          // tab ids as listed
  let picked = null;       // the highlighted one, by id so a redraw keeps it
  let drawn = '';          // what the list last showed; a working tab redraws the strip far more often than this changes

  function row(t) {
    return h('div', {
      class: `tl-row${t.id === state.activeTab ? ' here' : ''}`, role: 'option', id: `tl-${t.id}`, 'aria-selected': 'false',
      onmousemove: () => { if (picked !== t.id) { picked = t.id; paintPick(); } },
      onmousedown: e => { if (!e.target.closest('.tl-x')) { e.preventDefault(); go(t.id); } },
    },
    h('span', { class: 'tl-icon' }, SB.tabIcon(t) || h('span', { class: 'tl-dot' })),
    h('span', { class: 'tl-text' },
      h('span', { class: 'tl-title', text: SB.shownTitle(t) }),
      h('span', { class: 'tl-sub', text: SB.shortPath(t.cwd || state.cwd, 36) }),
      SB.clashLine(t.id) ? h('span', { class: 'tl-clash', text: `⚠ ${SB.clashLine(t.id)}` }) : null,
      SB.laneLine?.(t.id) ? h('span', { class: 'tl-lane', text: SB.laneLine(t.id) }) : null),
    // For the pointer; the keyboard closes the highlighted one with Ctrl+Delete.
    h('button', {
      class: 'tl-x', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: 'Close',
      onmousedown: e => e.preventDefault(),         // keep the keyboard in the find field
      onclick: e => { e.stopPropagation(); close(t.id); },
    }, '×'));
  }

  // Rebuilt only when what it shows changes, so a click isn't lost to a rebuild
  // between press and release, and the list doesn't jump while you scroll it.
  function renderRows({ force = false } = {}) {
    const tabs = [...state.tabs.values()];
    const now = JSON.stringify([query, state.activeTab, tabs.map(t => [t.id, S.standing(t), SB.shownTitle(t), t.cwd, S.closable(t, state.activeTab), SB.clashLine(t.id), SB.laneLine?.(t.id)])]);
    if (!force && now === drawn) return;
    drawn = now;
    const gs = S.groups(tabs, query);
    order = gs.flatMap(g => g.tabs.map(t => t.id));
    if (!order.includes(picked)) picked = order[0] ?? null;
    rowsEl.replaceChildren(...(gs.length
      ? gs.map(g => h('div', { role: 'group', 'aria-labelledby': `tlg-${g.standing}` },
        h('div', { class: `tl-group ${g.standing}`, id: `tlg-${g.standing}` }, h('span', { text: g.title }), h('span', { class: 'tl-n', text: String(g.tabs.length) })),
        ...g.tabs.map(row)))
      : [h('p', { class: 'tl-empty', text: `No open conversation matches "${query.trim()}". Ctrl+K searches History too.` })]));
    paintPick();
    renderFoot(tabs);
    renderReviewBar();
  }

  function renderReviewBar() {
    const n = SB.reviewCount?.() || 0;
    reviewBar.hidden = !n;
    reviewBar.replaceChildren(
      h('span', { class: 'tl-review-n', text: String(n) }),
      h('span', { text: n === 1 ? 'Review 1 finished conversation' : `Review ${n} finished conversations` }),
      h('kbd', { text: 'Ctrl+Shift+R' }));
  }

  // scroll: bring the highlighted row into view (the keyboard moved it, or the list just opened).
  function paintPick({ scroll = false } = {}) {
    for (const el of rowsEl.querySelectorAll('.tl-row')) el.setAttribute('aria-selected', String(el.id === `tl-${picked}`));
    const el = picked && $(`tl-${picked}`);
    if (el) field.setAttribute('aria-activedescendant', el.id);
    else field.removeAttribute('aria-activedescendant');
    if (el && scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function renderFoot(tabs) {
    const quiet = tabs.filter(t => S.closable(t, state.activeTab));
    foot.replaceChildren(
      h('button', {
        class: 'tl-sweep', type: 'button', disabled: !quiet.length,
        title: quiet.length ? 'Closes the ones with nothing going on and nothing unsent. Saved ones stay in History.' : null,
        onmousedown: e => e.preventDefault(),
        onclick: () => sweep(quiet),
      }, quiet.length ? `Close ${plural(quiet.length, 'quiet conversation', 'quiet conversations')}` : 'Nothing quiet to close'),
      h('span', { class: 'tl-hint', id: 'tlHint', text: 'Ctrl+Delete closes' }));
  }

  function go(id) {
    SB.closeMenus();
    SB.activate(id);
  }

  async function close(id) {
    // Taken first: closing the open tab activates another, which redraws the list.
    const was = order.slice();
    const at = was.indexOf(id);
    picked = was[at + 1] ?? was[at - 1] ?? null;
    const closing = SB.closeTab(id);
    renderRows();
    paintPick({ scroll: true });
    field.focus();
    await closing;
  }

  function sweep(tabs) {
    const saved = tabs.filter(t => t.saved).length;
    for (const t of tabs) SB.closeTab(t.id, { quiet: true });
    renderRows();
    field.focus();
    const where = !saved ? '' : saved === tabs.length ? ' They are still in History.' : ' The saved ones are still in History.';
    SB.toast(`Closed ${plural(tabs.length, 'conversation', 'conversations')}.${where}`);
  }

  field.addEventListener('input', () => { query = field.value; picked = null; renderRows(); paintPick({ scroll: true }); });
  field.addEventListener('keydown', e => {
    const i = order.indexOf(picked);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!order.length) return;
      picked = order[(i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
      paintPick({ scroll: true });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (picked) go(picked);
    } else if (e.key === 'Delete' && e.ctrlKey) {
      e.preventDefault();
      if (picked) close(picked);
    } else if (e.key === 'Escape') {
      // Kept from the panel's own Escape, which would stop a working tab once no menu is open.
      e.preventDefault();
      e.stopPropagation();
      SB.closeMenus();
      $('input').focus();
    }
  });

  SB.openTabList = () => {
    if (SB.isCrabOnly?.() || !state.tabs.size) return;
    if (state.view !== 'chat') SB.setView('chat');
    query = '';
    field.value = '';
    picked = state.activeTab;
    SB.openMenu(list, allBtn.hidden ? $('newTabBtn') : allBtn, () => { renderRows({ force: true }); return [reviewBar, SB.boardPart?.(), field, rowsEl, foot].filter(Boolean); });
    if (list.hidden) return;
    paintPick({ scroll: true });
    field.focus();
  };
  allBtn.addEventListener('click', SB.openTabList);
  // For tab-board.js: its lanes arrive after the list opens.
  SB.tabListOpen = () => !list.hidden;
  SB.refreshTabList = () => { if (!list.hidden) renderRows(); };

  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || !SB.shortcuts.matches(e, 'tabList')) return;
    e.preventDefault();
    if (list.hidden) SB.openTabList(); else SB.closeMenus();
  });

  // ------------------------------------------------------------ keep up with the strip

  const drawStrip = SB.renderTabStrip;
  SB.renderTabStrip = () => {
    drawStrip();
    // Split, the top strip hides: the list's button, and the review inbox's,
    // move to the end of the bar under it (review-view.js anchors to them).
    const where = SB.panes.count(state.grid) > 1 ? $('subbar') : $('tabstrip');
    if (allBtn.parentElement !== where) where.append($('reviewBtn'), allBtn);
    const tabs = [...state.tabs.values()];
    allBtn.hidden = tabs.length < SHOW_LIST_AT;
    $('tabAllCount').textContent = String(tabs.length);
    allBtn.classList.toggle('asking', tabs.some(t => S.standing(t) === 'asking'));
    allBtn.setAttribute('aria-label', `Every open conversation: ${tabs.length} (${SB.shortcuts.primary('tabList')})`);
    paintAllEdges();         // now, not next frame: a hidden panel gets no frames
    if (!list.hidden) renderRows();
  };
})();
