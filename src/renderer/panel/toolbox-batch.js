/* Shellby panel — Toolbox, many at once (main's toolbatch.js does the work).
   Your own skills, agents and commands get a checkbox; with some picked, a bar
   offers Pin, Unpin, Park, Remove and Export for all of them. With none picked
   it offers Select all shown, Pick unused (from lean.js usage) and Import.
   Parked ones (turned off, kept in Shellby) list at the bottom with Restore.
   A health line above the list counts what needs a look: servers that won't
   connect, skills with no description, and copies one scope hides from another.
   toolbox.js draws the rows and calls in here; this file owns the selection. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const DETAIL_TOAST_MS = 9000;
  const PIN_ROOM = 12; // the start screen keeps the last 12 pins (main's toolbox:pin)
  const keyOf = t => `${t.kind}:${t.name}`;
  const label = t => (t.kind === 'agent' ? t.name : `/${t.name}`);
  const isOwn = t => (t.source === 'user' || t.source === 'project') && !!t.path;

  const picked = new Set(); // 'kind:name'
  let anchor = null;        // the last box clicked, for Shift+click ranges
  let busy = false;
  let parked = [];
  let ctx = null;           // from toolbox.js: { render, isIdle(t) }

  function init(c) {
    ctx = c;
    loadParked();
  }

  async function loadParked() {
    try { parked = (await api.parkedTools()) || []; } catch { parked = []; }
    if (state.view === 'toolbox') ctx?.render();
  }

  // Only what you can see stays picked: a search, filter or tab that hides one unpicks
  // it, so the bar never acts on something off screen.
  function prune(shownOwn) {
    const live = new Set(shownOwn.map(keyOf));
    for (const k of [...picked]) if (!live.has(k)) picked.delete(k);
    if (anchor && !live.has(anchor)) anchor = null;
  }

  // ------------------------------------------------------------ a row's checkbox

  function checkbox(t, shownOwn) {
    if (!isOwn(t)) return h('span', { class: 'tool-check-gap', 'aria-hidden': 'true' });
    const key = keyOf(t);
    const box = h('input', { type: 'checkbox', class: 'tool-check', 'aria-label': `Pick ${label(t)}`, checked: picked.has(key) });
    box.addEventListener('click', e => {
      const on = box.checked;
      // Shift+click picks (or unpicks) everything between this box and the last one.
      const keys = shownOwn.map(keyOf);
      const from = anchor ? keys.indexOf(anchor) : -1;
      const to = keys.indexOf(key);
      const range = e.shiftKey && from >= 0 && to >= 0 ? keys.slice(Math.min(from, to), Math.max(from, to) + 1) : [key];
      for (const k of range) { if (on) picked.add(k); else picked.delete(k); }
      anchor = key;
      ctx.render();
      SB.$('toolList').querySelector(`.tool-item[data-key="${CSS.escape(key)}"] .tool-check`)?.focus({ preventScroll: true });
    });
    return box;
  }

  // ------------------------------------------------------------ the bar

  const refsOf = list => list.map(t => ({ kind: t.kind, name: t.name }));

  async function act(fn, after) {
    if (busy) return;
    busy = true;
    ctx.render();
    let r;
    try { r = await fn(); } catch { r = { ok: false, error: "Shellby couldn't do that." }; }
    busy = false;
    if (r?.toolbox) state.toolbox = r.toolbox;
    if (Array.isArray(r?.parkedList)) parked = r.parkedList;
    if (r?.ok) after(r);
    else if (!r?.cancelled) SB.toast(r?.error || "Couldn't do that.", { ms: DETAIL_TOAST_MS });
    SB.refreshEmptyStates();
    ctx.render();
  }

  const unpinAll = gone => {
    state.pinned = (state.pinned || []).filter(p => !gone.some(g => g.kind === p.kind && g.name === p.name));
  };
  const andMore = (r, verb) => {
    const notes = [];
    if (r.failed?.length) notes.push(`${r.failed.length} couldn't be ${verb}`);
    if (r.skipped?.length) notes.push(`${r.skipped.length} left alone (a plugin's or built in)`);
    return notes.length ? ` ${notes.join('; ')}.` : '';
  };

  async function pinMany(list, on) {
    if (busy) return;
    busy = true;
    ctx.render();
    const before = (state.pinned || []).length;
    try {
      for (const t of list.slice(0, PIN_ROOM)) state.pinned = await api.pinTool(t.kind, t.name, on);
    } catch { /* the toast below counts what landed */ }
    busy = false;
    // The start screen keeps the newest PIN_ROOM: pinning more pushes the oldest off.
    const bumped = on ? Math.max(0, before + Math.min(list.length, PIN_ROOM) - PIN_ROOM) : 0;
    SB.toast(on && list.length > PIN_ROOM ? `Pinned the first ${PIN_ROOM}: the start screen holds ${PIN_ROOM}.`
      : `${on ? 'Pinned' : 'Unpinned'} ${list.length}.${bumped ? ` ${bumped} older ${bumped === 1 ? 'pin' : 'pins'} made room.` : ''}`);
    SB.refreshEmptyStates();
    ctx.render();
  }

  function bar(shownOwn) {
    prune(shownOwn);
    const sel = shownOwn.filter(t => picked.has(keyOf(t)));
    const btn = (text, attrs) => h('button', { class: 'btn ghost slim-btn', type: 'button', disabled: busy, ...attrs }, text);
    if (!sel.length) {
      const idle = shownOwn.filter(ctx.isIdle);
      return h('li', { class: 'tool-batch' },
        btn(`Select all shown (${shownOwn.length})`, { disabled: busy || !shownOwn.length, onclick: () => { for (const t of shownOwn) picked.add(keyOf(t)); ctx.render(); } }),
        idle.length ? btn(`Pick unused (${idle.length})`, {
          title: "Your own ones Claude hasn't reached for lately: park them to save room in every conversation",
          onclick: () => { for (const t of idle) picked.add(keyOf(t)); ctx.render(); },
        }) : null,
        h('span', { class: 'tool-batch-gap' }),
        btn('Import…', { title: 'Add skills, agents and commands from a Shellby tools file', onclick: () => act(() => api.importTools(), r => SB.toast(`Added ${r.added.length} to your Claude folder.${r.skipped?.length ? ` ${r.skipped.length} you already had.` : ''}`)) }));
    }
    const refs = refsOf(sel);
    const clear = () => { picked.clear(); anchor = null; };
    return h('li', { class: 'tool-batch on', role: 'toolbar', 'aria-label': 'Picked tools' },
      h('strong', { class: 'tool-batch-n', text: `${sel.length} picked` }),
      btn('Pin', { onclick: () => pinMany(sel, true) }),
      btn('Unpin', { onclick: () => pinMany(sel, false) }),
      btn('Park', {
        title: "Turn them off without deleting: Shellby keeps them, and Restore puts them back",
        onclick: () => act(() => api.parkTools(refs), r => { unpinAll(r.parked); clear(); SB.toast(`Parked ${r.parked.length}. New conversations won't load them; Restore is at the bottom of the list.${andMore(r, 'parked')}`, { ms: DETAIL_TOAST_MS }); }),
      }),
      btn('Export…', { onclick: () => act(() => api.exportTools(refs), r => SB.toast(`Exported ${r.count} to ${SB.shortPath(r.path, 40)}.${andMore(r, 'exported')}`, { ms: DETAIL_TOAST_MS })) }),
      btn('Remove…', {
        class: 'btn ghost slim-btn danger-hover', title: 'Shellby asks first, and they go to the Recycle Bin',
        onclick: () => act(() => api.removeTools(refs), r => { unpinAll(r.removed); clear(); SB.toast(`Moved ${r.removed.length} to the Recycle Bin.${andMore(r, 'removed')}`, { ms: DETAIL_TOAST_MS }); }),
      }),
      h('span', { class: 'tool-batch-gap' }),
      btn('Clear', { onclick: () => { clear(); ctx.render(); } }));
  }

  // ------------------------------------------------------------ parked

  // Parked ones that belong in this list (its kind, its search), as a group at the bottom.
  function parkedRows(kinds, q) {
    const list = parked.filter(p => kinds.includes(p.kind) && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
    if (!list.length) return [];
    const restore = ids => act(() => api.restoreTools(ids), r => {
      const why = r.failed?.[0]?.why;
      SB.toast(`Restored ${r.restored.length}.${why ? ` ${r.failed.length} stayed parked: ${why}.` : ''}`, { ms: DETAIL_TOAST_MS });
    });
    return [
      h('li', { class: 'tool-group tool-parked-head' },
        h('span', { text: 'Parked' }),
        h('span', { class: 'tool-group-kind', text: "off, kept by Shellby" }),
        list.length > 1 ? h('button', { class: 'btn ghost slim-btn', type: 'button', disabled: busy, onclick: () => restore(list.map(p => p.id)) }, 'Restore all') : null),
      ...list.map(p => h('li', { class: 'tool-row tool-parked' },
        h('div', { class: 'tool-main' },
          h('span', { class: 'tool-name' },
            h('span', { class: `kind-dot k-${p.kind}` }),
            h('code', { text: label(p) }),
            h('span', { class: 'src-pill', text: `parked ${SB.relTime(p.at)}`, title: p.from })),
          p.description ? h('span', { class: 'tool-desc', text: p.description }) : null),
        h('div', { class: 'tool-actions' },
          h('button', { class: 'btn slim-btn', type: 'button', disabled: busy, 'aria-label': `Restore ${label(p)}`, onclick: () => restore([p.id]) }, 'Restore')))),
    ];
  }

  // ------------------------------------------------------------ health

  /** What needs a look, as clickable counts: [{ key, text }]. */
  function health(tb) {
    if (!tb) return [];
    const merged = [...(tb.skills || []), ...(tb.agents || []), ...(tb.commands || [])];
    const mcpDown = (tb.mcp || []).filter(m => /failed|needs-auth/.test(m.status || '')).length;
    const noDesc = merged.filter(t => isOwn(t) && !t.description).length;
    const dupes = merged.filter(t => t.hides?.length).length;
    return [
      mcpDown ? { key: 'mcp', text: `${mcpDown} MCP ${mcpDown === 1 ? 'server' : 'servers'} down`, title: "Won't connect or waiting for sign-in" } : null,
      noDesc ? { key: 'nodesc', text: `${noDesc} without a description`, title: 'Claude picks skills by description, so these rarely get used' } : null,
      dupes ? { key: 'dupes', text: `${dupes} hiding another copy`, title: 'Same name in more than one place: only one of them loads' } : null,
    ].filter(Boolean);
  }

  function healthLine(tb, only, pick) {
    const parts = health(tb);
    if (!parts.length && !only) return null;
    return h('li', { class: 'tool-health', role: 'status' },
      ...parts.map(p => h('button', {
        class: `tool-health-btn${only === p.key ? ' on' : ''}`, type: 'button', title: p.title, 'aria-pressed': String(only === p.key),
        onclick: () => pick(only === p.key ? null : p.key),
      }, p.text)),
      only && only !== 'mcp' ? h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => pick(null) }, 'Show all') : null);
  }

  SB.toolboxBatch = { init, checkbox, bar, parkedRows, healthLine, isOwn, loadParked, pickedCount: () => picked.size };
})();
