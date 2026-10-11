/* Shellby panel — the outline (Ctrl+Shift+O), as an editor lists a file's
   symbols: every message you sent in this conversation, with the files its
   turn touched under it. Type to narrow it to a message or a file, Enter to
   go there: a message scrolls into view, a file opens its diff in that turn's
   changes (or in your editor, where there's no diff). Main reads it from the
   transcript (src/main/outline.js), so it covers what the feed has trimmed. */
'use strict';
(function () {
  const { h, api, $, state } = SB;
  const sheet = $('outlineSheet');
  const input = $('outlineInput');
  const list = $('outlineList');
  const LANDED_MS = 2400;

  let tab = null;
  let turns = [];
  let rows = [];    // what's listed: { turn, n, file? }
  let at = 0;       // the row picked
  let back = null;  // what had the keyboard before

  SB.openOutline = async (t = SB.activeTab()) => {
    if (!t || state.view === 'onboarding') return;
    if (!t.saved) return SB.toast('Nothing has been sent in this conversation yet.');
    const r = await api.outline(t.id);
    turns = r?.turns || [];
    if (!turns.length) return SB.toast('Nothing has been sent in this conversation yet.');
    tab = t;
    back = document.activeElement;
    SB.closeMenus?.();
    input.value = '';
    sheet.hidden = false;
    filter();
    // The newest message first in reach, as you're most likely after something recent.
    at = Math.max(0, rows.findLastIndex(r => !r.file));
    paint();
    input.focus();
  };

  function close({ refocus = true } = {}) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    if (refocus && back?.isConnected) back.focus({ preventScroll: true });
    back = null;
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const base = p => String(p).split(/[\\/]/).pop();

  function filter() {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = s => words.every(w => String(s).toLowerCase().includes(w));
    rows = [];
    turns.forEach((turn, i) => {
      const all = !words.length || hit(turn.text);
      const files = all ? turn.files : turn.files.filter(f => hit(f.path));
      if (!all && !files.length) return;
      rows.push({ turn, n: i + 1 });
      for (const f of files) rows.push({ turn, n: i + 1, file: f });
    });
    at = Math.min(at, Math.max(0, rows.length - 1));
  }

  function paint() {
    list.replaceChildren(...rows.map((r, i) => {
      const li = r.file
        ? h('li', { class: 'ol-row ol-file', role: 'option', id: `ol-${i}`, 'aria-selected': String(i === at), title: r.file.path },
          h('span', { class: `chg-badge s-${r.file.status || 'M'}`, text: r.file.status || '✎', 'aria-hidden': 'true' }),
          h('span', { class: 'ol-name', text: base(r.file.path) }),
          h('span', { class: 'ol-dir', text: r.file.path.slice(0, -base(r.file.path).length) }),
          r.file.added != null ? h('span', { class: 'ol-stat' }, h('span', { class: 'chg-add', text: `+${r.file.added}` }), h('span', { class: 'chg-del', text: `−${r.file.removed}` })) : null)
        : h('li', { class: 'ol-row ol-turn', role: 'option', id: `ol-${i}`, 'aria-selected': String(i === at) },
          h('span', { class: 'ol-n', text: String(r.n), 'aria-hidden': 'true' }),
          h('span', { class: 'ol-text', text: r.turn.text || '(no text)' }),
          h('span', { class: 'ol-meta', text: [r.turn.files.length ? plural(r.turn.files.length, 'file') : '', r.turn.tools ? plural(r.turn.tools, 'step') : ''].filter(Boolean).join(' · ') }));
      li.addEventListener('mousedown', e => e.preventDefault()); // the keyboard stays in the box
      li.addEventListener('click', () => { at = i; go(); });
      return li;
    }));
    if (!rows.length) list.append(h('li', { class: 'ol-empty', text: `No message or file matches “${input.value.trim()}”.` }));
    input.setAttribute('aria-activedescendant', rows.length ? `ol-${at}` : '');
    list.children[at]?.scrollIntoView({ block: 'nearest' });
  }

  function go() {
    const r = rows[at];
    const t = tab;
    if (!r || !t) return;
    close({ refocus: false });
    SB.activate(t.id);
    SB.inChat(() => (r.file ? showFile(t, r.turn, r.file) : showTurn(t, r.turn)));
  }

  const land = (el) => {
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.add('history-landed');
    setTimeout(() => el.classList.remove('history-landed'), LANDED_MS);
  };

  function showTurn(t, turn) {
    const el = t.el.querySelector(`.msg.user[data-turn="${CSS.escape(turn.turnId)}"]`);
    if (!el) return SB.toast("That message is further back than this conversation shows. It's still in History.");
    land(el);
  }

  // Its diff in the turn's changes, opened; with no diff (no git), the file in your editor.
  function showFile(t, turn, f) {
    const block = t.el.querySelector(`details.changes[data-turn="${CSS.escape(turn.turnId)}"]`);
    const row = block && [...block.querySelectorAll('.chg-file')].find(b => b.title === f.path);
    if (!row) {
      if (f.status) return SB.toast("That turn's changes are further back than this conversation shows.");
      return SB.openFile(f.path, { tabId: t.id });
    }
    block.open = true;
    if (row.getAttribute('aria-expanded') !== 'true') row.click();
    land(row);
    row.focus({ preventScroll: true });
  }

  input.addEventListener('input', () => { at = 0; filter(); paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) at = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      return paint();
    }
    if (e.key === 'Enter') { e.preventDefault(); return go(); }
    if (e.key === 'Tab') e.preventDefault(); // the box is the only stop
  });
  sheet.addEventListener('mousedown', (e) => { if (e.target === sheet) close(); });
  $('outlineClose').addEventListener('click', () => close());
})();
