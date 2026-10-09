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
    if (showingBin) { $('historyFound').hidden = true; return renderBin(q); }
    scheduleFound();
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
    // Popped out into a window of its own, it's still open, just not a tab here (tab-panes.js).
    const popped = state.popped.has(s.id);
    const open = popped || state.tabs.has(s.id);
    const tick = s.done ? 'Mark as not done' : 'Mark as done';
    return h('li', { class: `history-item${open ? ' current' : ''}${s.done ? ' done' : ''}` },
      h('button', { class: 'history-open', type: 'button', onclick: () => SB.openHistory(s.id) },
        h('div', { class: 'h-title' }, s.lastOutcome === 'error' ? h('span', { class: 'h-dot err', title: 'Ended with an error' })
          : s.lastOutcome === 'cut' ? h('span', { class: 'h-dot cut', title: 'Cut off before it finished' }) : null, s.title),
        h('div', { class: 'h-meta' },
          h('span', { text: SB.relTime(s.updatedAt) }),
          h('span', { text: SB.shortPath(s.cwd, 30) }),
          s.done ? h('span', { class: 'h-done', text: '✓ done' }) : null,
          s.inTerminal ? h('span', { class: 'h-term', text: 'in a terminal' }) : null,
          // Synced from another PC (history-sync.js): Claude picks it up with a recap.
          s.elsewhere ? h('span', { class: 'h-term', text: `from ${s.elsewhere}` }) : null,
          open ? h('span', { class: 'h-open', text: popped ? 'open in a window' : 'open' }) : null)),
      // Only a conversation Claude Code has a record of can carry on elsewhere.
      s.claudeSessionId ? h('button', { class: 'history-term', type: 'button', title: 'Continue in a terminal', 'aria-label': `Continue ${s.title} in a terminal`, onclick: () => SB.continueInTerminal(s.id) }, '›_') : null,
      h('button', { class: 'history-rename', type: 'button', title: 'Rename', 'aria-label': `Rename ${s.title}`, onclick: e => renameHistory(s, e.currentTarget) }, '✎'),
      h('button', { class: 'history-tick', type: 'button', title: tick, 'aria-pressed': String(!!s.done), 'aria-label': `${tick}: ${s.title}`, onclick: () => markDone(s.id, !s.done) }, '✓'),
      h('button', { class: 'history-del', type: 'button', title: 'Delete', 'aria-label': `Delete ${s.title}`, onclick: () => deleteHistory(s.id) }, '✕'));
  }
  $('historySearch').addEventListener('input', renderHistory);
  for (const b of $('historyTabs').querySelectorAll('[data-filter]')) {
    b.addEventListener('click', () => { historyFilter = b.dataset.filter; renderHistory(); });
  }

  // at: the index of the message to land on (a hit from searching inside messages).
  SB.openHistory = async (id, at = null) => {
    if (state.tabs.has(id) && at == null) { SB.activate(id); return; }
    const r = await api.openSession(id);
    if (!r || r.error) return SB.toast(r?.error || "Couldn't open that conversation.");
    if (r.popped) return;
    const fresh = !state.tabs.has(r.tabId);
    const tab = SB.ensureTab({ id: r.tabId, title: r.entry.title, cwd: r.entry.cwd, saved: true, routineId: r.entry.routineId, inTerminal: r.entry.inTerminal || null });
    let target = null;
    if (fresh) {
      r.items.forEach((item, i) => {
        const before = i === at ? tab.el.lastElementChild : undefined;
        tab.render(item, { replay: true });
        if (i === at) target = before ? before.nextElementSibling : tab.el.firstElementChild;
      });
      tab.cancelOpenAsks();
      for (const lane of tab.lanes.values()) if (lane.status === 'running') lane.finish({ ok: true });
    }
    SB.activate(r.tabId);
    if (at == null) { SB.toast('Picked up where you left off'); return; }
    if (!target) target = findInFeed(tab, r.items[at]);
    if (!target?.isConnected) { SB.toast("That message is too far back to show here. It's still in the conversation."); return; }
    target.scrollIntoView({ block: 'center' });
    target.classList.add('history-landed');
    setTimeout(() => target.classList.remove('history-landed'), LANDED_MS);
  };
  const LANDED_MS = 2400;

  // An already open tab: the block whose text starts the way the message does.
  function findInFeed(tab, item) {
    const want = (item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!want) return null;
    return [...tab.el.children].reverse().find(el => el.textContent.replace(/\s+/g, ' ').includes(want)) || null;
  }

  // ------------------------------------------------------------ inside messages

  const FOUND_DELAY_MS = 200;
  const MIN_FOUND = 2;
  let foundTimer = null;
  let foundAsk = 0;

  function scheduleFound() {
    clearTimeout(foundTimer);
    foundTimer = setTimeout(searchFound, FOUND_DELAY_MS);
  }

  async function searchFound() {
    const q = $('historySearch').value.trim();
    const box = $('historyFound');
    if (showingBin || q.length < MIN_FOUND) { box.hidden = true; return; }
    const days = Number($('historyFoundWhen').value);
    const mine = ++foundAsk;
    const r = await api.searchSessions({
      query: q, project: $('historyFoundProject').value, pc: $('historyFoundPc').value,
      from: days ? Date.now() - days * 864e5 : undefined,
    }).catch(() => null);
    if (mine !== foundAsk) return; // a newer search went out meanwhile
    box.hidden = false;
    fillFacets(r?.facets);
    const list = $('historyFoundList');
    if (!r?.results?.length) {
      list.replaceChildren(h('li', { class: 'history-empty', text: r?.error || 'No message says that.' }));
      return;
    }
    list.replaceChildren(...r.results.map(foundRow));
  }

  function fillFacets(f) {
    const keep = (sel, values, fixed) => {
      const now = sel.value;
      const opts = values.map(v => h('option', { value: v, text: fixed === 'pc' ? `From ${v}` : v }));
      sel.replaceChildren(...[...sel.options].slice(0, fixed === 'pc' ? 2 : 1), ...opts);
      sel.value = [...sel.options].some(o => o.value === now) ? now : sel.options[0].value;
    };
    keep($('historyFoundProject'), f?.projects || [], 'project');
    keep($('historyFoundPc'), f?.pcs || [], 'pc');
  }

  // The snippet, with the matched words in <mark>.
  function marked(snip) {
    const parts = [];
    let i = 0;
    for (const [a, b] of snip.marks || []) {
      if (a > i) parts.push(snip.text.slice(i, a));
      parts.push(h('mark', { text: snip.text.slice(a, b) }));
      i = b;
    }
    parts.push(snip.text.slice(i));
    return parts;
  }

  function foundRow(c) {
    return h('li', { class: 'history-item history-found-item' },
      h('div', { class: 'h-title', text: c.title }),
      h('div', { class: 'h-meta' },
        h('span', { text: SB.relTime(c.updatedAt) }),
        c.project ? h('span', { text: c.project }) : null,
        c.pc ? h('span', { class: 'h-term', text: `from ${c.pc}` }) : null,
        c.count > c.hits.length ? h('span', { text: `${c.count} messages` }) : null),
      ...c.hits.map(hit => h('button', {
        class: 'history-hit', type: 'button', 'aria-label': `Open ${c.title} at this ${hit.kind === 'user' ? 'message of yours' : 'reply'}`,
        onclick: () => SB.openHistory(c.id, hit.at),
      }, h('span', { class: 'history-hit-who', text: hit.kind === 'user' ? 'You' : 'Claude' }), h('span', { class: 'history-hit-text' }, ...marked(hit.snippet)))));
  }

  for (const id of ['historyFoundProject', 'historyFoundPc', 'historyFoundWhen']) $(id).addEventListener('change', searchFound);
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

  // Conversations synced in from another PC, or deleted there.
  api.onSessionsSynced?.(list => {
    state.sessions = list;
    if (state.view === 'history') SB.views.history.render();
  });

  SB.views.history = {
    render: async () => {
      [state.sessions, state.trash] = await Promise.all([api.listSessions(), api.listTrash()]);
      renderHistory();
    },
    redraw: () => renderHistory(),
  };
})();
