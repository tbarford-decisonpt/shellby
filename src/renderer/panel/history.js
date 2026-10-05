/* Shellby panel — the History view: past conversations, open again, renamed,
   marked done or deleted. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  // ------------------------------------------------------------ history

  // Which bucket the list shows. 'todo' hides what you've marked done, which is
  // the point of marking it; the filter row only appears once something is done,
  // so it's never in the way for anyone who doesn't use this.
  let historyFilter = 'todo';
  const inBucket = (s, f) => f === 'all' || (f === 'done' ? !!s.done : !s.done);

  // Recently deleted shares the list and the search box; showingBin swaps what
  // they're over. state.trash is fetched alongside the sessions.
  let showingBin = false;
  state.trash = [];
  const matches = q => s => !q || s.title.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q);

  function renderHistory() {
    const q = $('historySearch').value.trim().toLowerCase();
    if (!state.trash.length) showingBin = false;
    $('historyBinBar').hidden = !showingBin;
    $('historyBinOpen').hidden = showingBin || !state.trash.length;
    $('historyBinOpen').querySelector('.n').textContent = state.trash.length;
    $('historyClear').hidden = showingBin || (!state.sessions.length && !state.trash.length);
    if (showingBin) return renderBin(q);
    const found = state.sessions.filter(matches(q));
    const anyDone = state.sessions.some(s => s.done);
    if (!anyDone) historyFilter = 'todo';
    $('historyTabs').hidden = !anyDone;
    for (const b of $('historyTabs').querySelectorAll('[data-filter]')) {
      // Counted over the search results, so a tab never promises rows the search has hidden.
      b.querySelector('.n').textContent = found.filter(s => inBucket(s, b.dataset.filter)).length;
      b.setAttribute('aria-selected', String(b.dataset.filter === historyFilter));
    }
    // Sort is stable, so All keeps its order within each half and only sinks the done ones.
    const list = found.filter(s => inBucket(s, historyFilter)).sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
    const ul = $('historyList');
    if (!list.length) {
      ul.replaceChildren(h('li', { class: 'history-empty', text: historyEmpty(q) }));
      return;
    }
    ul.replaceChildren(...list.map(historyRow));
  }

  function historyEmpty(q) {
    if (q) return 'No matches.';
    if (!state.sessions.length) return 'No conversations yet. Give Shellby a task!';
    return historyFilter === 'done' ? 'Nothing marked done yet.' : 'Everything here is done.';
  }

  function historyRow(s) {
    const open = state.tabs.has(s.id);
    const tick = s.done ? 'Mark as not done' : 'Mark as done';
    return h('li', { class: `history-item${open ? ' current' : ''}${s.done ? ' done' : ''}` },
      h('button', { class: 'history-open', type: 'button', onclick: () => SB.openHistory(s.id) },
        h('div', { class: 'h-title' }, s.lastOutcome === 'error' ? h('span', { class: 'h-dot err', title: 'Ended with an error' }) : null, s.title),
        h('div', { class: 'h-meta' },
          h('span', { text: SB.relTime(s.updatedAt) }),
          h('span', { text: SB.shortPath(s.cwd, 30) }),
          s.done ? h('span', { class: 'h-done', text: '✓ done' }) : null,
          open ? h('span', { class: 'h-open', text: 'open' }) : null)),
      h('button', { class: 'history-rename', type: 'button', title: 'Rename', 'aria-label': `Rename ${s.title}`, onclick: e => renameHistory(s, e.currentTarget) }, '✎'),
      h('button', { class: 'history-tick', type: 'button', title: tick, 'aria-pressed': String(!!s.done), 'aria-label': `${tick}: ${s.title}`, onclick: () => markDone(s.id, !s.done) }, '✓'),
      h('button', { class: 'history-del', type: 'button', title: 'Delete', 'aria-label': `Delete ${s.title}`, onclick: () => deleteHistory(s.id) }, '✕'));
  }
  $('historySearch').addEventListener('input', renderHistory);
  for (const b of $('historyTabs').querySelectorAll('[data-filter]')) {
    b.addEventListener('click', () => { historyFilter = b.dataset.filter; renderHistory(); });
  }

  SB.openHistory = async (id) => {
    if (state.tabs.has(id)) { SB.activate(id); return; }
    const r = await api.openSession(id);
    if (!r || r.error) return SB.toast(r?.error || "Couldn't open that conversation.");
    const tab = SB.ensureTab({ id: r.tabId, title: r.entry.title, cwd: r.entry.cwd, saved: true, routineId: r.entry.routineId });
    for (const item of r.items) tab.render(item, { replay: true });
    tab.cancelOpenAsks();
    for (const lane of tab.lanes.values()) if (lane.status === 'running') lane.finish({ ok: true });
    SB.activate(r.tabId);
    SB.toast('Picked up where you left off');
  };

  // A row ticked off leaves the default list straight away, so the toast says
  // where it went and offers the way back.
  async function markDone(id, done) {
    state.sessions = await api.setSessionDone(id, done);
    renderHistory();
    if (done) SB.toast('Marked done.', { action: 'Undo', onAction: () => markDone(id, false) });
  }

  // For the places that tick a conversation off on their own (bringing a copy
  // home and tidying it away): their toast points here, so the chat that just
  // left the default list is one click from where it went.
  SB.showDoneHistory = () => { historyFilter = 'done'; SB.setView('history'); };

  // The row's open button becomes the name field; the rest of the row stays put.
  function renameHistory(s, btn) {
    const row = btn.closest('.history-item');
    SB.editTitle(row.querySelector('.history-open'), s.title, async title => {
      if (title) {
        state.sessions = await api.renameSession(s.id, title);
        const tab = state.tabs.get(s.id);
        if (tab) { tab.title = title; SB.renderTabStrip(); }
      }
      renderHistory();
    });
  }

  // Into Recently deleted, not gone: the toast's Undo is the quick way back,
  // the bin under the list the slow one.
  async function deleteHistory(id) {
    state.sessions = await api.deleteSession(id);
    state.trash = await api.listTrash();
    const tab = state.tabs.get(id);
    if (tab) { tab.destroy(); state.tabs.delete(id); if (state.activeTab === id) { state.activeTab = null; await SB.newTab(); } SB.renderTabStrip(); }
    renderHistory();
    SB.toast('Moved to Recently deleted.', { action: 'Undo', onAction: () => restoreHistory(id) });
  }

  async function restoreHistory(id) {
    const r = await api.restoreSession(id);
    state.sessions = r.sessions;
    state.trash = r.trash;
    renderHistory();
  }

  // Deleting for good takes a second click within a few seconds (as Forget
  // its time does in time.js), since there's no undo after it.
  function armed(btn, sure, act) {
    let timer = null;
    const label = btn.textContent;
    return () => {
      if (!timer) {
        btn.textContent = sure;
        timer = setTimeout(() => { timer = null; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      timer = null;
      act();
    };
  }

  function renderBin(q) {
    const list = state.trash.filter(matches(q));
    const ul = $('historyList');
    if (!list.length) {
      ul.replaceChildren(h('li', { class: 'history-empty', text: 'No matches.' }));
      return;
    }
    ul.replaceChildren(...list.map(binRow));
  }

  function binRow(s) {
    const days = Math.max(1, Math.ceil((s.purgeAt - Date.now()) / 86400000));
    const purge = h('button', { class: 'history-del', type: 'button', title: 'Delete forever', 'aria-label': `Delete ${s.title} forever` }, '✕');
    purge.onclick = armed(purge, 'Sure?', async () => { state.trash = await api.purgeSession(s.id); renderHistory(); });
    return h('li', { class: 'history-item binned' },
      h('div', { class: 'history-open' },
        h('div', { class: 'h-title', text: s.title }),
        h('div', { class: 'h-meta' },
          h('span', { text: `deleted ${SB.relTime(s.deletedAt)}` }),
          h('span', { text: `gone in ${days} day${days > 1 ? 's' : ''}` }),
          h('span', { text: SB.shortPath(s.cwd, 24) }))),
      h('button', { class: 'history-restore', type: 'button', 'aria-label': `Restore ${s.title}`, onclick: () => restoreHistory(s.id) }, 'Restore'),
      purge);
  }

  $('historyBinOpen').addEventListener('click', () => { showingBin = true; renderHistory(); $('historyBinBack').focus(); });
  $('historyBinBack').addEventListener('click', () => { showingBin = false; renderHistory(); $('historySearch').focus(); });
  $('historyBinEmpty').addEventListener('click', armed($('historyBinEmpty'), 'Sure? All of them', async () => {
    state.trash = await api.purgeSession();
    renderHistory();
  }));

  // Main asks "are you sure?" in a native box and does nothing on Cancel. On
  // yes it has closed the open conversations, so their tabs go here too.
  $('historyClear').addEventListener('click', async () => {
    const before = state.sessions.map(s => s.id);
    const r = await api.clearSessions();
    if (!r?.cleared) return;
    state.sessions = r.sessions;
    state.trash = r.trash;
    let lostActive = false;
    for (const id of before) {
      const tab = state.tabs.get(id);
      if (!tab) continue;
      tab.destroy();
      state.tabs.delete(id);
      if (state.activeTab === id) { state.activeTab = null; lostActive = true; }
    }
    if (lostActive) await SB.newTab();
    SB.renderTabStrip();
    renderHistory();
    SB.toast('History cleared.');
  });

  SB.views.history = {
    render: async () => {
      [state.sessions, state.trash] = await Promise.all([api.listSessions(), api.listTrash()]);
      renderHistory();
    },
    redraw: () => renderHistory(),
  };
})();
