/* Shellby panel — Notes: things you'd like to do, per project plus a General
   list, each one a click away from Plan, Build or Ask (see src/main/notes.js). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const GENERAL = 'general';
  const input = $('noteInput');
  let scope = null;        // the list on show: GENERAL or a project key (null until first render)
  let editing = null;      // id of the note being edited

  const RUN = {
    plan: { label: 'Plan', title: 'Have Claude plan this. Nothing changes until you approve the plan', done: 'Planned' },
    build: { label: 'Build', title: 'Send this to Claude as written, in your current mode', done: 'Built' },
    ask: { label: 'Ask', title: 'Ask Claude if this is a good idea. It reads and reports back, and changes nothing', done: 'Asked' },
  };

  const view = () => state.notes;
  const project = () => view()?.projects.find(p => p.key === scope) || null;
  const listNow = () => (scope === GENERAL ? view()?.general : project()?.notes) || [];
  const listName = () => (scope === GENERAL ? 'General' : project()?.name || 'this project');

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
      ? `General notes run in the folder you're working in: ${SB.tildify(v.cwd)}`
      : `Runs in ${SB.tildify(project()?.root || '')}`;
  }

  function render() {
    if (!view()) { api.listNotes().then(v => { state.notes = v; render(); }); return; }
    pickScope();
    renderScope();
    const notes = listNow();
    const list = $('noteList');
    if (!notes.length) {
      list.replaceChildren(h('li', { class: 'note-empty', text: scope === GENERAL
        ? "Nothing here yet. Jot down an idea that isn't tied to one project."
        : `Nothing noted for ${listName()} yet. What would you like to do here?` }));
      return;
    }
    // Ticked-off notes sink to the bottom.
    list.replaceChildren(...[...notes.filter(n => !n.done), ...notes.filter(n => n.done)].map(row));
  }

  function row(n) {
    return h('li', { class: `note${n.done ? ' done' : ''}`, 'data-note-id': n.id },
      h('input', { type: 'checkbox', class: 'note-check', checked: n.done, 'aria-label': n.done ? 'Not done yet' : 'Done',
        title: n.done ? 'Mark as not done' : 'Mark as done', onchange: e => setDone(n, e.target.checked) }),
      h('div', { class: 'note-main' }, editing === n.id ? editor(n) : h('div', {
        class: 'note-text', text: n.text, title: 'Click to edit', tabindex: '0', role: 'button',
        onclick: () => startEdit(n.id),
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); startEdit(n.id); } },
      }), meta(n)),
      h('div', { class: 'note-actions' },
        ...Object.entries(RUN).map(([kind, r]) => h('button', {
          class: `btn slim-btn note-run note-${kind}`, type: 'button', title: r.title, 'aria-label': `${r.label}: ${n.text.split('\n')[0]}`,
          onclick: () => run(n, kind),
        }, r.label)),
        h('button', { class: 'icon-btn note-more', type: 'button', title: 'More', 'aria-label': 'More for this note', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
          onclick: e => openMenu(n, e.currentTarget) }, SB.icon(SB.ICONS.more, { width: 2.6 }))));
  }

  function meta(n) {
    const r = n.lastRun;
    if (!r) return h('div', { class: 'note-meta', text: `added ${SB.relTime(n.createdAt)}` });
    return h('div', { class: 'note-meta' },
      h('button', { class: 'note-last', type: 'button', title: 'Open that conversation', onclick: () => SB.openHistory(r.tabId).then(() => SB.setView('chat')) },
        `${RUN[r.kind].done} ${SB.relTime(r.at)} · open`));
  }

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

  // ------------------------------------------------------------ run, move, delete

  async function run(n, kind) {
    const r = await api.runNote({ scope, id: n.id, kind });
    if (r?.needsClaude) return SB.claudeUpsell('notes');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    state.notes = r.view;
    SB.setView('chat');
  }

  function openMenu(n, anchor) {
    const others = [
      scope !== GENERAL && { key: GENERAL, name: 'General' },
      ...view().projects.filter(p => p.key !== scope).map(p => ({ key: p.key, name: p.name })),
    ].filter(Boolean);
    SB.openMenu($('noteMenu'), anchor, () => [
      others.length ? h('div', { class: 'menu-label', text: 'Move to' }) : null,
      ...others.map(o => h('button', { class: 'menu-item', type: 'button', onclick: async () => {
        SB.closeMenus();
        const r = await api.moveNote({ from: scope, id: n.id, to: o.key });
        apply(r);
        if (r?.ok) SB.toast(`Moved to ${o.name}`, { action: 'Show', onAction: () => { scope = o.key; render(); } });
      } }, h('span', { class: 'mi-title', text: o.name }))),
      others.length ? h('div', { class: 'menu-sep' }) : null,
      h('button', { class: 'menu-item danger-hover', type: 'button', onclick: async () => {
        SB.closeMenus();
        apply(await api.deleteNote({ scope, id: n.id }));
        SB.toast('Note deleted.');
      } }, h('span', { class: 'mi-title', text: 'Delete' })),
    ]);
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
  $('notesScope').addEventListener('change', e => { scope = e.target.value; editing = null; render(); });

  // Fresh each visit: the folder you're working in may have changed.
  // refresh: a push from main. It waits while you're editing a note, so typing isn't lost.
  SB.views.notes = {
    render: () => api.listNotes().then(v => { state.notes = v; render(); }),
    refresh: () => { if (!editing) render(); },
  };
})();
