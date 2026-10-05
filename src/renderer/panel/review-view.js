/* Shellby panel — the review inbox. With a lot of tabs working at once, finished
   work piles up faster than you can look at it, so it queues here: every tab
   that finished a turn which changed files, oldest first, until you've opened
   it and said so (Mark reviewed), brought its copy home, or sent it back with
   what should change. Red tests and clashes are marked loud but keep their place.

   Opens from the count at the end of the tab strip, the Ctrl+Shift+A list, or
   Ctrl+Shift+R. Main keeps who's waiting (src/main/review-inbox.js), so a
   reload or a restart doesn't forget; the sorting is review-queue.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const Q = window.ShellbyReviewQueue;
  const list = $('reviewList');
  const btn = $('reviewBtn');
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
  document.body.append(live);

  const checking = new Map();   // tabId -> the tree a check is running on now
  let order = [];               // tab ids as listed
  let picked = null;            // the highlighted row, by id so a redraw keeps it
  let drawn = '';               // what the list last showed
  let sendingTo = null;         // the row whose Send back box is open
  const drafts = new Map();     // tabId -> what you'd typed into its box

  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const say = text => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); };
  const waiting = () => Q.queue([...state.tabs.values()]);
  const itemOf = t => Q.item(t, { title: SB.shownTitle(t), running: checking.get(t.id) || null, clash: SB.clashLine(t.id) });

  // ------------------------------------------------------------ one row

  function verdictPill(it) {
    const v = Q.VERDICTS[it.verdict];
    if (it.verdict === 'none') return h('span', { class: 'rv-verdict none', text: v.text });
    return h('span', { class: `rv-verdict ${it.verdict}` }, h('span', { 'aria-hidden': 'true', text: v.icon }), ` ${v.text}`);
  }

  function actionBtn(label, key, onclick, { primary = false, hint } = {}) {
    return h('button', {
      class: `btn slim-btn${primary ? ' primary' : ' ghost'}`, type: 'button',
      'aria-keyshortcuts': key, title: hint ? `${hint} (${key})` : `${label} (${key})`, onclick,
    }, label);
  }

  function sendBox(t) {
    const comments = SB.pendingComments?.(t) || 0;
    const field = h('input', {
      class: 'rv-send-field', type: 'text', spellcheck: 'true', autocomplete: 'off', maxlength: '2000',
      placeholder: comments ? 'Anything to add? (optional)' : 'What should change?',
      'aria-label': `What should change in "${SB.shownTitle(t)}"`,
      value: drafts.get(t.id) || '',
      oninput: e => drafts.set(t.id, e.target.value),
    });
    const go = h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => sendBack(t.id, field.value) }, 'Send');
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); sendBack(t.id, field.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSend(t.id); }
    });
    return h('div', { class: 'rv-send' },
      h('div', { class: 'rv-send-row' }, field, go),
      comments ? h('p', { class: 'rv-send-note', text: `Your ${comments === 1 ? 'line comment goes' : `${comments} line comments go`} with it.` }) : null);
  }

  function row(t) {
    const it = itemOf(t);
    const age = SB.relTime(it.at);
    const isCopy = !!it.branch;
    return h('li', {
      class: `rv-item${it.flagged ? ' flagged' : ''}${it.id === picked ? ' picked' : ''}`, id: `rv-${it.id}`,
      tabindex: it.id === picked ? '0' : '-1', 'aria-label': Q.label(it, age), dataset: { id: it.id },
      onfocus: e => { if (e.target === e.currentTarget && picked !== it.id) { picked = it.id; paintPick(); } },
      onmousedown: e => { if (!e.target.closest('button, input')) { picked = it.id; paintPick(); } },
    },
    h('div', { class: 'rv-top' },
      h('span', { class: 'rv-title', text: it.title }),
      h('time', { class: 'rv-age', text: age, title: new Date(it.at).toLocaleString() })),
    h('div', { class: 'rv-facts' },
      isCopy ? h('span', { class: 'rv-branch', title: `Its own copy, on branch ${it.branch}`, text: `⑂ ${it.branch}` }) : null,
      h('span', { class: 'rv-files' },
        `${it.files === 1 ? '1 file' : `${it.files} files`} `,
        h('span', { class: 'chg-add', text: `+${it.added}` }), ' ',
        h('span', { class: 'chg-del', text: `−${it.removed}` })),
      verdictPill(it)),
    it.paths.length ? h('ul', { class: 'rv-paths', 'aria-label': 'Files changed' },
      it.paths.map(p => h('li', { title: p, text: p })),
      it.more ? h('li', { class: 'rv-more', text: `…and ${it.more} more` }) : null) : null,
    it.clash ? h('p', { class: 'rv-clash' }, h('span', { 'aria-hidden': 'true', text: '⚠ ' }), it.clash) : null,
    h('div', { class: 'rv-actions' },
      actionBtn('Open', 'Enter', () => open(it.id), { primary: true, hint: 'Go to it, at its latest changes' }),
      isCopy ? actionBtn('Bring it home', 'B', () => bringHome(it.id), { hint: `Merge ${it.branch} into ${t.worktree.base}` }) : null,
      actionBtn('Send back', 'S', () => openSend(it.id), { hint: 'Tell him what should change' }),
      actionBtn('Mark reviewed', 'R', () => markReviewed(it.id), { hint: 'Takes it off this list' })),
    sendingTo === it.id ? sendBox(t) : null);
  }

  // ------------------------------------------------------------ the list

  const head = h('div', { class: 'rv-head' },
    h('h2', { class: 'rv-heading', id: 'rvHeading', text: 'Ready to review' }),
    h('span', { class: 'rv-sub', text: 'Oldest first' }));
  const rowsEl = h('ul', { class: 'rv-items', 'aria-labelledby': 'rvHeading' });
  const foot = h('p', { class: 'rv-hint', text: '↑↓ move · Enter opens · B brings home · S sends back · R reviewed' });
  const empty = h('p', { class: 'rv-empty', tabindex: '-1', text: "Nothing waiting for you. He'll put finished work here." });

  // Rebuilt only when what it shows changes, and never under your typing.
  function render({ force = false } = {}) {
    const tabs = waiting();
    const now = JSON.stringify([sendingTo, tabs.map(t => [t.id, itemOf(t), SB.relTime(t.ready.at), SB.pendingComments?.(t) || 0])]);
    if (!force && now === drawn) return;
    const typing = document.activeElement?.classList.contains('rv-send-field') && list.contains(document.activeElement);
    if (typing && !force) return;
    drawn = now;
    order = tabs.map(t => t.id);
    if (!order.includes(picked)) picked = order[0] ?? null;
    if (sendingTo && !order.includes(sendingTo)) sendingTo = null;
    const hadFocus = list.contains(document.activeElement);
    rowsEl.replaceChildren(...tabs.map(row));
    paintPick();
    rowsEl.hidden = !tabs.length;
    empty.hidden = !!tabs.length;
    foot.hidden = !tabs.length;
    if (hadFocus) focusPicked();
  }

  // One row in the Tab order at a time (arrows move between them), and its buttons with it.
  function paintPick() {
    for (const el of rowsEl.querySelectorAll('.rv-item')) {
      const on = el.dataset.id === picked;
      el.classList.toggle('picked', on);
      el.tabIndex = on ? 0 : -1;
      for (const b of el.querySelectorAll('.rv-actions button')) b.tabIndex = on ? 0 : -1;
    }
  }

  function focusPicked() {
    paintPick();
    const el = picked && $(`rv-${picked}`);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); return; }
    empty.focus?.();
  }

  // ------------------------------------------------------------ what you can do

  // Go to it, opened and scrolled to the changes this is about.
  function open(id) {
    const t = state.tabs.get(id);
    if (!t) return;
    const after = t.ready?.after;
    SB.closeMenus();
    SB.activate(id);
    // After activate's own scroll to the bottom has happened.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const block = after && [...t.el.querySelectorAll('details.changes')].reverse().find(d => d.dataset.after === after);
      if (!block) return;
      block.open = true;
      block.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }));
  }

  async function markReviewed(id) {
    const t = state.tabs.get(id);
    if (!t?.ready) return;
    const title = SB.shownTitle(t);
    picked = Q.landOn(order, id);
    t.ready = { ...t.ready, reviewed: true };      // straight away; main agrees in a moment
    render({ force: true });
    focusPicked();
    SB.renderTabStrip();
    const left = waiting().length;
    say(`Marked "${title}" reviewed. ${left ? Q.countLine(left) : 'That was the last one.'}`);
    const ok = await api.markReviewed(id, true).catch(() => false);
    if (ok) SB.toast(`"${title}" marked reviewed.`, { ms: 5000, action: 'Undo', onAction: () => api.markReviewed(id, false) });
  }

  function bringHome(id) {
    const t = state.tabs.get(id);
    if (!t?.worktree || !SB.bringHome) return;
    say(`Bringing "${SB.shownTitle(t)}" home.`);
    // Merged: main marks it reviewed (a 'home' item) and it leaves the list.
    // Red tests stop it, with the usual offer to bring it anyway or ask for a fix.
    SB.bringHome(t);
  }

  function openSend(id) {
    sendingTo = id;
    picked = id;
    render({ force: true });
    $(`rv-${id}`)?.querySelector('.rv-send-field')?.focus();
  }

  function closeSend(id) {
    if (sendingTo !== id) return;
    sendingTo = null;
    render({ force: true });
    focusPicked();
  }

  async function sendBack(id, note) {
    const t = state.tabs.get(id);
    if (!t) return;
    const typed = String(note || '').trim();
    if (!typed && !(SB.pendingComments?.(t))) { SB.toast('Say what should change first.'); return; }
    const sent = await SB.sendBack(t, typed);
    if (!sent) return;
    drafts.delete(id);
    sendingTo = null;
    picked = Q.landOn(order, id);
    render({ force: true });
    focusPicked();
    say(`Sent back to "${SB.shownTitle(t)}". It comes back here when he's done.`);
  }

  // ------------------------------------------------------------ keyboard

  rowsEl.addEventListener('keydown', e => {
    const item = e.target.closest('.rv-item');
    if (!item || e.target.closest('.rv-send')) return;
    const onRow = e.target === item;
    const id = item.dataset.id;
    const i = order.indexOf(id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      picked = order[(i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
      focusPicked();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); picked = e.key === 'Home' ? order[0] : order[order.length - 1]; focusPicked(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Enter' && onRow) { e.preventDefault(); open(id); return; }
    const key = e.key.toLowerCase();
    if (key === 'b' && state.tabs.get(id)?.worktree) { e.preventDefault(); bringHome(id); }
    else if (key === 'r') { e.preventDefault(); markReviewed(id); }
    else if (key === 's') { e.preventDefault(); openSend(id); }
  });

  list.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Kept from the panel's own Escape, which would stop a working tab once no menu is open.
    e.preventDefault();
    e.stopPropagation();
    SB.closeMenus();
    $('input').focus();
  });

  // ------------------------------------------------------------ opening it

  SB.openReview = () => {
    if (SB.isCrabOnly?.()) return;
    if (state.view !== 'chat') SB.setView('chat');
    const anchor = [btn, $('tabAllBtn'), $('newTabBtn')].find(b => !b.hidden);
    picked = null;
    SB.openMenu(list, anchor, () => { render({ force: true }); return [head, rowsEl, empty, foot]; });
    if (list.hidden) return;
    say(Q.countLine(order.length));
    focusPicked();
  };
  SB.reviewCount = () => waiting().length;

  btn.addEventListener('click', SB.openReview);
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || !e.ctrlKey || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'r') return;
    e.preventDefault();
    if (list.hidden) SB.openReview(); else SB.closeMenus();
  });

  api.onChecksRunning?.(({ tabId, after, running }) => {
    if (running && after) checking.set(tabId, after);
    else if (checking.get(tabId) === after || !after) checking.delete(tabId);
    if (!list.hidden) render();
  });

  // ------------------------------------------------------------ keep up with the strip

  const drawStrip = SB.renderTabStrip;
  SB.renderTabStrip = () => {
    drawStrip();
    const n = waiting().length;
    btn.hidden = !n;
    $('reviewCount').textContent = String(n);
    btn.setAttribute('aria-label', `${Q.countLine(n)} (Ctrl+Shift+R)`);
    if (!list.hidden) render();
  };
})();
