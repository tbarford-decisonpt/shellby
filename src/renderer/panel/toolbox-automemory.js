/* Shellby panel — Toolbox → Memory, "What Claude remembers": the notes Claude
   Code writes down by itself (auto memory) for the project on screen, one file
   per thing it learned about you or the project, read back at the start of
   every conversation there. Shellby keeps none of it: it shows what Claude
   wrote, lets you fix one that's wrong or forget it (to the Recycle Bin), and
   main's automemory.js does the reading and writing. */
'use strict';
(function () {
  const { h, api, state } = SB;

  // Claude Code's four kinds of memory, in the order worth reading them.
  const KIND = [
    ['user', 'About you'],
    ['feedback', 'How you like it done'],
    ['project', 'About this project'],
    ['reference', 'Where to look'],
    ['other', 'Other notes'],
  ];
  const kindOf = m => (KIND.some(([k]) => k === m.type) ? m.type : 'other');

  const open = new Set(); // files shown in full
  let editing = null;    // { file, text, mtimeMs, error }
  let forgetting = null; // the file whose Forget was pressed once
  let last = null;       // the last list, so a re-render doesn't re-read every file
  let lastAt = 0;
  let lastTab = null;    // ...for this conversation's project
  const STALE_MS = 5000;

  const tabId = () => state.activeTab || null;

  async function load() {
    lastTab = tabId();
    lastAt = Date.now();
    try { last = await api.listMemory(lastTab); } catch { last = { memories: [], exists: false, error: true }; }
    return last;
  }

  function memoryItem(m, redraw) {
    const isOpen = open.has(m.file);
    const ed = editing?.file === m.file ? editing : null;
    const toggle = () => { if (isOpen) open.delete(m.file); else open.add(m.file); redraw(); };
    const body = ed
      ? h('div', { class: 'am-edit' },
          (() => {
            const area = h('textarea', { class: 'field area am-text', 'aria-label': `Edit what Claude remembers: ${m.name}`, spellcheck: 'true' });
            area.value = ed.text;
            area.addEventListener('input', () => { ed.text = area.value; });
            area.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
            requestAnimationFrame(() => area.focus());
            return area;
          })(),
          ed.error ? h('p', { class: 'setup-status err', role: 'alert', text: ed.error }) : null,
          h('div', { class: 'row am-actions' },
            h('span', { class: 'muted small', text: 'Claude reads it as you leave it. Ctrl+S saves.' }),
            h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { editing = null; redraw(); } }, 'Cancel'),
            h('button', { class: 'btn primary slim-btn', type: 'button', onclick: save }, 'Save')))
      : isOpen ? SB.renderMarkdownInto(h('div', { class: 'am-body msg assistant' }), m.body || '(empty)') : null;

    async function save() {
      const r = await api.saveMemory(tabId(), m.file, editing.text, m.mtimeMs).catch(() => null);
      if (!r?.ok) { editing.error = r?.error || "Couldn't save it."; redraw(); return; }
      editing = null;
      open.add(m.file);
      SB.toast('Saved. Claude reads it that way from its next conversation here.');
      await load();
      redraw();
    }

    async function forget() {
      if (forgetting !== m.file) { forgetting = m.file; redraw(); return; }
      forgetting = null;
      const r = await api.forgetMemory(tabId(), m.file).catch(() => null);
      if (!r?.ok) { SB.toast(r?.error || "Couldn't forget it."); return; }
      SB.toast(`Forgotten: ${m.name}. It's in the Recycle Bin if you want it back.`, { ms: 6000 });
      await load();
      redraw();
    }

    return h('li', { class: `am-item${isOpen || ed ? ' open' : ''}` },
      h('div', { class: 'am-head' },
        h('button', { class: 'am-toggle', type: 'button', 'aria-expanded': String(isOpen), onclick: toggle },
          h('strong', { text: m.name }),
          m.description ? h('span', { class: 'am-desc', text: m.description }) : null),
        h('span', { class: 'am-when muted small', text: SB.relTime(m.mtimeMs) }),
        ed ? null : h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { editing = { file: m.file, text: m.body, error: '' }; forgetting = null; redraw(); } }, 'Edit'),
        ed ? null : h('button', { class: `btn ghost slim-btn${forgetting === m.file ? ' danger' : ''}`, type: 'button', onclick: forget }, forgetting === m.file ? 'Forget it?' : 'Forget')),
      body);
  }

  function fill(box, view) {
    const redraw = () => fill(box, last);
    const mems = view?.memories || [];
    const where = view?.project ? ` for ${view.project}` : '';
    const head = h('div', { class: 'am-top' },
      h('h3', { text: `What Claude remembers${where}` }),
      h('span', { class: 'src-pill', text: mems.length ? `${mems.length}` : 'none yet' }),
      h('button', { class: 'btn ghost slim-btn', type: 'button', title: 'Read them again', onclick: async () => { await load(); redraw(); } }, 'Refresh'),
      view?.exists ? h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: async () => { const r = await api.openMemoryFolder(tabId()); if (!r?.ok) SB.toast(r?.error || "Couldn't open it."); } }, 'Open folder') : null);
    const intro = h('p', { class: 'muted small am-intro', text: mems.length
      ? "Claude Code writes these down by itself as you work: what you've told it, what it learned about the project. It reads them at the start of every conversation here. Fix one that's wrong, or forget it."
      : "Nothing yet. Tell Claude something worth keeping (\"always use pnpm here\", \"I'm new to Rust\") and it writes it down. It shows up here, and Shellby says so when it happens." });
    const groups = KIND.map(([k, title]) => {
      const list = mems.filter(m => kindOf(m) === k);
      return list.length ? h('div', { class: 'am-group' }, h('h4', { text: title }), h('ul', { class: 'am-list' }, list.map(m => memoryItem(m, redraw)))) : null;
    });
    box.hidden = false;
    box.replaceChildren(head, intro, ...groups.filter(Boolean)); // replaceChildren writes a null out as text
  }

  /** The section, filled in once the list arrives (toolbox-setup.js puts it under the CLAUDE.md files). */
  SB.autoMemorySection = () => {
    const box = h('section', { class: 'auto-memory', id: 'autoMemory', 'aria-label': 'What Claude remembers', hidden: true });
    const fresh = last && lastTab === tabId() && Date.now() - lastAt < STALE_MS;
    if (last && lastTab === tabId()) fill(box, last);
    if (!fresh) load().then(v => fill(box, v));
    return box;
  };

  /** From a "Remembered" line in a conversation: straight to the list, that note open. */
  SB.openMemories = (file) => {
    if (file) open.add(file);
    SB.showToolbox('memory');
    requestAnimationFrame(() => document.getElementById('autoMemory')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
})();
