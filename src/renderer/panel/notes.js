/* Shellby panel — Notes: things you'd like to do, per project plus a General
   list, each one a click away from Plan, Build or Ask (see src/main/notes.js).
   Pinned notes lead; ticked-off ones fold away under "Done". A long list gets
   a find box. A project's open notes show in its Next up too (backlog.js). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const GENERAL = 'general';
  const FILTER_FROM = 10;  // notes in a list before the find box shows
  const input = $('noteInput');
  const filterBox = $('notesFilter');
  let scope = null;        // the list on show: GENERAL or a project key (null until first render)
  let editing = null;      // id of the note being edited
  let doneOpen = false;    // the Done fold, open or shut
  let filter = '';

  const RUN = {
    plan: { label: 'Plan', title: 'Have Claude plan this in a copy on its own branch. Nothing changes until you approve the plan', done: 'Planned' },
    build: { label: 'Build', title: 'Send this to Claude as written, in a copy on its own branch, in your current mode', done: 'Built' },
    ask: { label: 'Ask', title: 'Ask Claude if this is a good idea. It reads and reports back, and changes nothing', done: 'Asked' },
  };
  const VERDICT = { do: 'Do it', differently: 'Do it differently', skip: 'Skip it' };

  const view = () => state.notes;
  const project = () => view()?.projects.find(p => p.key === scope) || null;
  const listNow = () => (scope === GENERAL ? view()?.general : project()?.notes) || [];
  const listName = () => (scope === GENERAL ? 'General' : project()?.name || 'this project');
  const firstLine = n => n.text.split('\n')[0];

  // Opens on the project you're working in, or General when you aren't in one.
  function pickScope() {
    const v = view();
    if (scope === GENERAL || v.projects.some(p => p.key === scope)) return;
    scope = v.current || GENERAL;
  }

  function apply(r) {
    if (r?.view) state.notes = r.view;
    else if (r && !('ok' in r)) state.notes = r;
    if (r?.ok === false) SB.toast(r.error || "Couldn't do that.");
    render();
  }

  function renderScope() {
    const v = view();
    const count = n => (n.length ? ` (${n.filter(x => !x.done).length})` : '');
    $('notesScope').replaceChildren(
      h('option', { value: GENERAL, text: `General${count(v.general)}` }),
      ...v.projects.map(p => h('option', { value: p.key, text: `${p.name}${p.key === v.current ? ' · here' : ''}${count(p.notes)}` })));
    $('notesScope').value = scope;
    $('notesWhere').textContent = scope === GENERAL
      ? "General notes run where you pick when you start one."
      : `Runs in ${SB.tildify(project()?.root || '')}`;
  }

  function render() {
    if (!view()) { api.listNotes().then(v => { state.notes = v; render(); }); return; }
    pickScope();
    renderScope();
    const notes = listNow();
    filterBox.hidden = notes.length <= FILTER_FROM;
    if (filterBox.hidden) { filter = ''; filterBox.value = ''; }
    const want = filter.trim().toLowerCase();
    const shown = want ? notes.filter(n => n.text.toLowerCase().includes(want)) : notes;
    // Pinned first, then the rest newest first; ticked-off notes fold away under Done.
    const open = [...shown.filter(n => !n.done && n.pinned), ...shown.filter(n => !n.done && !n.pinned)];
    const done = shown.filter(n => n.done);
    const list = $('noteList');
    if (!notes.length) {
      list.replaceChildren(h('li', { class: 'note-empty', text: scope === GENERAL
        ? "Nothing here yet. Jot down an idea that isn't tied to one project."
        : `Nothing noted for ${listName()} yet. What would you like to do here?` }));
    } else if (!open.length) {
      list.replaceChildren(h('li', { class: 'note-empty', text: want ? 'No note matches that.' : 'All done here. Nice.' }));
    } else {
      list.replaceChildren(...open.map(row));
    }
    renderDone(done, want);
  }

  function renderDone(done, searching) {
    const box = $('notesDone');
    box.hidden = !done.length;
    if (!done.length) return box.replaceChildren();
    const isOpen = doneOpen || !!searching;
    box.replaceChildren(
      h('div', { class: 'notes-done-head' },
        h('button', { class: 'link-btn notes-done-toggle', type: 'button', 'aria-expanded': String(isOpen),
          onclick: () => { doneOpen = !doneOpen; render(); } }, `${isOpen ? '▾' : '▸'} Done · ${done.length}`),
        // Not while finding: the list on show is only the matches, and Clear takes every done note.
        searching ? null : h('button', { class: 'link-btn notes-clear', type: 'button', title: 'Clear every ticked-off note from this list', onclick: clearDone }, 'Clear')),
      isOpen ? h('ul', { class: 'note-list' }, ...done.map(row)) : null);
  }

  function row(n) {
    return h('li', { class: `note${n.done ? ' done' : ''}${n.pinned && !n.done ? ' pinned' : ''}`, 'data-note-id': n.id },
      h('input', { type: 'checkbox', class: 'note-check', checked: n.done, 'aria-label': n.done ? 'Not done yet' : 'Done',
        title: n.done ? 'Mark as not done' : 'Mark as done', onchange: e => setDone(n, e.target.checked) }),
      h('div', { class: 'note-main' }, editing === n.id ? editor(n) : h('div', {
        class: 'note-text', text: n.text, title: 'Click to edit', tabindex: '0', role: 'button',
        onclick: () => startEdit(n.id),
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); startEdit(n.id); } },
      }), meta(n)),
      h('div', { class: 'note-actions' },
        ...Object.entries(RUN).map(([kind, r]) => h('button', {
          class: `btn slim-btn note-run note-${kind}`, type: 'button', title: r.title, 'aria-label': `${r.label}: ${firstLine(n)}`,
          onclick: e => run(n, kind, e.currentTarget),
        }, r.label)),
        h('button', { class: 'icon-btn note-more', type: 'button', title: 'More', 'aria-label': 'More for this note', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
          onclick: e => openMenu(n, e.currentTarget) }, SB.icon(SB.ICONS.more, { width: 2.6 }))));
  }

  function meta(n) {
    const last = n.runs?.[0];
    const verdict = n.runs?.find(r => r.kind === 'ask' && r.verdict)?.verdict;
    return h('div', { class: 'note-meta' },
      n.pinned && !n.done ? h('span', { class: 'note-tag note-pin', text: 'Pinned' }) : null,
      n.from === 'claude' ? h('span', { class: 'note-tag note-from', title: 'Claude noted this in a conversation. Plan, Build and Ask open it as a draft for you to read first', text: 'From Claude' }) : null,
      verdict ? h('span', { class: `note-tag note-verdict v-${verdict}`, title: 'What Claude said when you asked', text: VERDICT[verdict] }) : null,
      last
        ? h('button', { class: 'note-last', type: 'button', title: 'Open that conversation', onclick: () => openRun(last) },
          `${RUN[last.kind].done} ${SB.relTime(last.at)} · open`)
        : h('span', { text: `added ${SB.relTime(n.createdAt)}` }));
  }

  const openRun = r => SB.openHistory(r.tabId).then(() => SB.setView('chat'));

  // ------------------------------------------------------------ editing

  function editor(n) {
    const area = h('textarea', { class: 'field area note-edit', rows: '3', maxlength: '2000', 'aria-label': 'Edit note' });
    area.value = n.text;
    const save = async () => {
      if (editing !== n.id) return;
      editing = null;
      if (area.value.trim() && area.value !== n.text) apply(await api.updateNote({ scope, id: n.id, text: area.value }));
      else render();
    };
    area.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      // Esc cancels the edit rather than leaving the screen.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing = null; render(); }
    });
    area.addEventListener('blur', save);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); });
    return area;
  }

  function startEdit(id) { editing = id; render(); }

  async function setDone(n, done) {
    apply(await api.updateNote({ scope, id: n.id, done }));
    if (done) SB.toast('Done.', { action: 'Undo', onAction: () => setDone(n, false) });
  }

  async function setPinned(n, pinned) {
    apply(await api.updateNote({ scope, id: n.id, pinned }));
  }

  // ------------------------------------------------------------ run, move, delete

  // A General note isn't tied to a folder, so it asks where to run first.
  function run(n, kind, anchor) {
    if (scope !== GENERAL) return start(n, kind, null);
    const v = view();
    const here = v.projects.find(p => p.key === v.current);
    SB.openMenu($('noteMenu'), anchor, () => [
      h('div', { class: 'menu-label', text: `${RUN[kind].label} it in` }),
      SB.menuItem(here ? `${here.name} (where you're working)` : "Where you're working", SB.tildify(v.cwd), () => start(n, kind, 'here')),
      ...v.projects.filter(p => p.key !== v.current).map(p => SB.menuItem(p.name, SB.tildify(p.root), () => start(n, kind, p.key))),
    ]);
  }

  async function start(n, kind, where) {
    const r = await api.runNote({ scope, id: n.id, kind, ...(where ? { where } : {}) });
    if (r?.needsClaude) return SB.claudeUpsell('notes');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    state.notes = r.view;
    SB.setView('chat');
    if (r.draft) SB.toast('Claude wrote this note. Read it in the box, then send.');
  }

  function openMenu(n, anchor) {
    const others = [
      scope !== GENERAL && { key: GENERAL, name: 'General' },
      ...view().projects.filter(p => p.key !== scope).map(p => ({ key: p.key, name: p.name })),
    ].filter(Boolean);
    const earlier = (n.runs || []).slice(1);
    SB.openMenu($('noteMenu'), anchor, () => [
      !n.done ? SB.menuItem(n.pinned ? 'Unpin' : 'Pin to top', () => setPinned(n, !n.pinned)) : null,
      earlier.length ? h('div', { class: 'menu-sep' }) : null,
      earlier.length ? h('div', { class: 'menu-label', text: 'Earlier runs' }) : null,
      ...earlier.map(r => SB.menuItem(`${RUN[r.kind].done} ${SB.relTime(r.at)}`, r.verdict ? VERDICT[r.verdict] : null, () => openRun(r))),
      others.length ? h('div', { class: 'menu-sep' }) : null,
      others.length ? h('div', { class: 'menu-label', text: 'Move to' }) : null,
      ...others.map(o => SB.menuItem(o.name, async () => {
        const r = await api.moveNote({ from: scope, id: n.id, to: o.key });
        apply(r);
        if (r?.ok) SB.toast(`Moved to ${o.name}`, { action: 'Show', onAction: () => { scope = o.key; render(); } });
      })),
      h('div', { class: 'menu-sep' }),
      SB.menuItem('Delete', null, () => remove(n), { tone: 'danger-hover' }),
    ]);
  }

  // Delete and Clear done both say what went, with an Undo that puts it back where it was.
  async function remove(n) {
    const from = scope;
    const r = await api.deleteNote({ scope: from, id: n.id });
    apply(r);
    if (r?.removed?.length) SB.toast('Note deleted.', { action: 'Undo', onAction: () => restore(from, r.removed) });
  }

  async function clearDone() {
    const from = scope;
    const r = await api.clearDoneNotes({ scope: from });
    apply(r);
    const n = r?.removed?.length || 0;
    if (n) SB.toast(`Cleared ${n} done ${n === 1 ? 'note' : 'notes'}.`, { action: 'Undo', onAction: () => restore(from, r.removed) });
  }

  async function restore(from, removed) {
    apply(await api.restoreNotes({ scope: from, removed }));
  }

  // ------------------------------------------------------------ adding

  async function addNote() {
    const text = input.value;
    if (!text.trim()) return input.focus();
    const r = await api.addNote({ scope, text });
    if (!r?.ok) return SB.toast(r?.error || "Couldn't save that.");
    input.value = '';
    apply(r);
    input.focus();
  }

  $('noteAdd').addEventListener('submit', e => { e.preventDefault(); addNote(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); }
  });
  $('notesScope').addEventListener('change', e => { scope = e.target.value; editing = null; filter = ''; filterBox.value = ''; render(); });
  filterBox.addEventListener('input', () => { filter = filterBox.value; render(); });

  /** Notes, on one list (Next up's "Open in Notes"). */
  SB.openNotes = key => { scope = key; editing = null; filter = ''; filterBox.value = ''; SB.setView('notes'); };

  // Fresh each visit: the folder you're working in may have changed.
  // refresh: a push from main. It waits while you're editing a note, so typing isn't lost.
  SB.views.notes = {
    render: () => api.listNotes().then(v => { state.notes = v; render(); }),
    refresh: () => { if (!editing) render(); },
  };
})();
