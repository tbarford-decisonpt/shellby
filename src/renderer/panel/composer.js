/* Shellby panel — the message box's terminal conveniences, as Claude Code has them:
   @ file mentions, Up/Down and Ctrl+R through what you've sent, ! to run a
   command yourself, Shellby's own slash commands (/export, /rewind, /effort…),
   the effort chip, and rewinding to an earlier message (Esc Esc).
   tabs.js owns the box itself and calls in here (SB.pickKeydown, SB.runLocal…). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const input = $('input');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ------------------------------------------------------------ the pick menu (@ files, Ctrl+R history)

  // mode: null | 'files' | 'history'. One menu serves both, since they never overlap.
  const pick = { mode: null, items: [], index: 0, start: 0, query: '', original: '', seq: 0 };

  function renderPick() {
    const menu = $('pickMenu');
    if (!pick.mode || !pick.items.length) {
      menu.hidden = !pick.mode || pick.mode === 'files';
      if (pick.mode === 'history') menu.replaceChildren(h('div', { class: 'pick-empty', text: pick.query ? `Nothing you've sent matches "${pick.query}".` : "Nothing sent yet." }));
      return;
    }
    menu.hidden = false;
    const head = pick.mode === 'history'
      ? h('div', { class: 'pick-head', text: `Search what you've sent${pick.query ? `: "${pick.query}"` : ''} · Enter to use · Ctrl+R for older` })
      : null;
    menu.replaceChildren(...[head, ...pick.items.map((it, i) => h('button', {
      type: 'button', role: 'option', class: `slash-item pick-item${i === pick.index ? ' on' : ''}`, 'aria-selected': String(i === pick.index),
      onmousedown: e => { e.preventDefault(); choose(i); },
    }, pick.mode === 'files'
      ? [h('span', { class: 'pick-glyph', text: it.dir ? '▸' : '·' }), h('span', { class: 'slash-name', text: it.path }), h('span')]
      : [h('span', { class: 'pick-glyph', text: it.startsWith('!') ? '!' : '›' }), h('span', { class: 'pick-text', text: it.replace(/\s+/g, ' ').slice(0, 200) }), h('span')]))].filter(Boolean));
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  // Closing Ctrl+R without choosing keeps whatever is in the box; Esc puts back what was there (pickKeydown).
  SB.hidePick = () => {
    pick.mode = null;
    pick.items = [];
    $('pickMenu').hidden = true;
  };

  function choose(i) {
    const it = pick.items[i];
    if (it == null) return;
    if (pick.mode === 'history') {
      input.value = it;
      SB.hidePick();
    } else {
      const caret = input.selectionStart;
      const text = it.dir ? it.mention : `${it.mention} `;
      input.value = input.value.slice(0, pick.start) + text + input.value.slice(caret);
      const at = pick.start + text.length;
      input.setSelectionRange(at, at);
      SB.hidePick();
      if (it.dir) mentionCheck(); // keep going inside the folder
    }
    SB.autosize();
    input.focus();
    shellMode();
  }

  SB.pickKeydown = (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (pick.mode === 'history') { if (pick.items.length) { pick.index = (pick.index + 1) % pick.items.length; renderPick(); } return true; }
      openHistorySearch();
      return true;
    }
    if (!pick.mode || $('pickMenu').hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!pick.items.length) return true;
      e.preventDefault();
      pick.index = (pick.index + (e.key === 'ArrowDown' ? 1 : -1) + pick.items.length) % pick.items.length;
      renderPick();
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (!pick.items.length) { SB.hidePick(); return e.key === 'Tab'; }
      e.preventDefault();
      choose(pick.index);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (pick.mode === 'history') { input.value = pick.original; SB.autosize(); }
      SB.hidePick();
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------ @ file mentions

  // What's being typed after an @ just before the caret: a bare path, or a
  // quoted one with spaces in it.
  const MENTION = /(?:^|\s)@("[^"]*|[^\s"]*)$/;

  let mentionTimer = null;
  function mentionCheck() {
    const tab = SB.activeTab();
    const before = input.value.slice(0, input.selectionStart);
    const m = input.selectionStart === input.selectionEnd && MENTION.exec(before);
    if (!m || !tab) { if (pick.mode === 'files') SB.hidePick(); return; }
    const query = m[1].replace(/^"/, '');
    pick.start = before.length - m[1].length - 1;
    clearTimeout(mentionTimer);
    const seq = ++pick.seq;
    mentionTimer = setTimeout(async () => {
      const items = await api.suggestFiles(tab.id, query).catch(() => []);
      if (seq !== pick.seq) return; // typed on since
      pick.mode = 'files';
      pick.items = items;
      pick.index = 0;
      pick.query = query;
      renderPick();
    }, 70);
  }

  // ------------------------------------------------------------ what you've sent (Up / Down, Ctrl+R)

  let sent = [];
  let walk = -1;        // where Up/Down is in `sent`; -1 = your own draft
  let draft = '';
  api.promptHistory().then(list => { if (Array.isArray(list)) sent = [...list, ...sent.filter(s => !list.includes(s))]; }).catch(() => {});

  SB.notePrompt = (text) => {
    const t = String(text || '').trim();
    if (!t) return;
    sent = [...sent.filter(s => s !== t), t].slice(-200);
    walk = -1;
  };

  SB.historyKeydown = (e) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    // Inside a message of several lines, the arrows move between its lines first.
    if (e.key === 'ArrowUp' && input.value.slice(0, input.selectionStart).includes('\n')) return;
    if (e.key === 'ArrowDown' && input.value.slice(input.selectionEnd).includes('\n')) return;
    if (e.key === 'ArrowDown' && walk < 0) return;
    if (e.key === 'ArrowUp' && !sent.length) return;
    e.preventDefault();
    if (walk < 0) { draft = input.value; walk = sent.length; }
    walk += e.key === 'ArrowUp' ? -1 : 1;
    if (walk < 0) walk = 0;
    if (walk >= sent.length) { walk = -1; input.value = draft; } else input.value = sent[walk];
    input.setSelectionRange(input.value.length, input.value.length);
    SB.autosize();
    shellMode();
  };

  function historyMatches(q) {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (let i = sent.length - 1; i >= 0 && out.length < 12; i--) if (!needle || sent[i].toLowerCase().includes(needle)) out.push(sent[i]);
    return out;
  }

  function openHistorySearch() {
    pick.mode = 'history';
    pick.original = input.value;
    pick.query = input.value;
    pick.items = historyMatches(pick.query);
    pick.index = 0;
    renderPick();
  }

  // ------------------------------------------------------------ ! runs a command yourself

  const SHELL_HINT = '! runs this in PowerShell here · the output goes to Claude with your next message';
  let wasShell = false;
  function shellMode() {
    const on = input.value.startsWith('!') && !input.value.startsWith('!!');
    $('composer').classList.toggle('shell-mode', on);
    if (on) $('sendHint').textContent = SHELL_HINT;
    else if (wasShell) SB.syncBusyUi();
    wasShell = on;
  }

  // Every change to the box's text (typing, pasting, clearing after a send).
  SB.composerInput = () => {
    walk = -1;
    shellMode();
    if (pick.mode === 'history') {
      pick.query = input.value;
      pick.items = historyMatches(pick.query);
      pick.index = 0;
      renderPick();
      return;
    }
    mentionCheck();
  };
  input.addEventListener('click', () => { if (pick.mode === 'files') mentionCheck(); });

  async function runShell(tab, command) {
    if (!command) { SB.toast('Type a command after the !, like: !git status'); return; }
    SB.notePrompt(`!${command}`);
    tab.renderShellPending(command);
    const r = await api.runShell(tab.id, command);
    if (!r?.ok) { tab.renderShellPending(null); if (!r?.cancelled) SB.toast(r?.error || "Couldn't run that."); }
  }

  // ------------------------------------------------------------ Shellby's own slash commands

  const EFFORTS = [
    { id: '', title: 'Auto', sub: 'Claude Code decides how hard to think' },
    { id: 'low', title: 'Low', sub: 'Quick answers, the least thinking' },
    { id: 'medium', title: 'Medium', sub: 'A balance of speed and care' },
    { id: 'high', title: 'High', sub: 'Thinks things through' },
    { id: 'xhigh', title: 'Extra high', sub: 'For hard problems' },
    { id: 'max', title: 'Max', sub: 'Thinks the longest. Uses your limits fastest' },
  ];
  const effortName = id => (EFFORTS.find(x => x.id === (id || '')) || EFFORTS[0]).title;

  SB.LOCAL_COMMANDS = [
    { name: 'rewind', kind: 'shellby', description: 'Go back to an earlier message: the conversation, the code, or both (Esc Esc)' },
    { name: 'export', kind: 'shellby', description: 'Save this conversation as Markdown (/export clipboard copies it)' },
    { name: 'effort', kind: 'shellby', description: 'How hard Claude thinks: low, medium, high, xhigh, max or auto' },
    { name: 'permissions', kind: 'shellby', description: 'The allow, ask and deny rules Claude Code follows' },
    { name: 'mcp', kind: 'shellby', description: 'MCP servers: add, remove, reconnect, turn on or off' },
    { name: 'model', kind: 'shellby', description: 'Pick the model for new conversations' },
    { name: 'output-style', kind: 'shellby', description: 'How Claude talks while it works (Explanatory, Learning…)' },
  ];

  const LOCAL = {
    rewind: (tab) => SB.openRewind(tab),
    export: async (tab, arg) => {
      if (!tab.saved) return SB.toast('Send it something first: there is nothing to export yet.');
      const to = /^clip/i.test(arg) ? 'clipboard' : 'file';
      const r = await api.exportSession(tab.id, to);
      if (r?.ok) SB.toast(to === 'clipboard' ? 'Copied the conversation as Markdown.' : `Saved to ${SB.tildify(r.path)}`, { ms: 5000 });
      else if (!r?.cancelled) SB.toast(r?.error || "Couldn't export it.");
    },
    effort: (tab, arg) => {
      const want = arg.toLowerCase().replace(/^extra[\s-]?high$/, 'xhigh').replace(/^(auto|default)$/, '');
      if (arg && EFFORTS.some(x => x.id === want)) return SB.chooseEffort(want);
      if (arg) return SB.toast('Effort is one of: auto, low, medium, high, xhigh, max.');
      SB.openMenu($('effortMenu'), $('effortChip'), effortItems);
    },
    permissions: () => SB.showToolbox?.('permissions'),
    mcp: () => SB.showToolbox?.('mcp'),
    model: () => SB.showSetting?.('modelSelect'),
    'output-style': () => SB.showSetting?.('styleSelect'),
  };

  /** Handles a message that's for Shellby, not Claude. true = handled. */
  // !! sends Claude a message that starts with a single !.
  SB.runLocal = (text, tab) => {
    if (text.startsWith('!!')) return false;
    if (text.startsWith('!')) { runShell(tab, text.slice(1).trim()); return true; }
    const m = /^\/([\w-]+)(?:\s+(.*))?$/s.exec(text);
    const fn = m && LOCAL[m[1].toLowerCase()];
    if (!fn) return false;
    SB.notePrompt(text);
    fn(tab, (m[2] || '').trim());
    return true;
  };

  // ------------------------------------------------------------ effort chip

  function effortItems() {
    const cur = state.settings?.effort || '';
    return [
      h('div', { class: 'menu-label', text: 'How hard Claude thinks' }),
      ...EFFORTS.map(x => h('button', { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(cur === x.id), onclick: () => { SB.closeMenus(); SB.chooseEffort(x.id); } },
        h('span', { class: 'mi-check', text: cur === x.id ? '●' : '' }),
        h('span', {}, h('div', { class: 'mi-title', text: x.title }), h('div', { class: 'mi-sub', text: x.sub })))),
    ];
  }

  SB.applyEffort = () => {
    const id = state.settings?.effort || '';
    $('effortLabel').textContent = id ? effortName(id).toLowerCase() : 'auto';
    $('effortChip').classList.toggle('on', !!id);
    $('effortChip').title = `Effort: ${effortName(id)}. How hard Claude thinks, in every open conversation (/effort)`;
  };

  SB.chooseEffort = async (id) => {
    const r = await api.setSettings({ effort: id });
    state.settings = r.settings;
    SB.applyEffort();
    SB.toast(`Effort: ${effortName(state.settings.effort)} (all open conversations)`);
  };

  $('effortChip').addEventListener('click', () => SB.openMenu($('effortMenu'), $('effortChip'), effortItems));

  // ------------------------------------------------------------ rewind

  // Menus open below their anchor; this one belongs above the box.
  function openAboveBox(build) {
    const menu = $('rewindMenu');
    SB.openMenu(menu, $('form'), build);
    if (menu.hidden) return;
    const r = $('form').getBoundingClientRect();
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, r.left)}px`;
  }

  SB.openRewind = async (tab, turnId = null) => {
    if (!tab) return;
    if (tab.busy) return SB.toast('Let him finish first (or press Stop), then rewind.');
    const { points = [] } = await api.rewindPoints(tab.id).catch(() => ({}));
    if (!points.length) return SB.toast('Nothing to rewind to yet.');
    const chosen = turnId && points.find(p => p.turnId === turnId);
    if (chosen) return rewindOptions(tab, chosen);
    openAboveBox(() => [
      h('div', { class: 'menu-label', text: 'Rewind to just before…' }),
      ...points.slice(0, 30).map(p => h('button', { class: 'menu-item rewind-point', onclick: () => rewindOptions(tab, p) },
        h('span', { class: 'mi-check', text: '↶' }),
        h('span', {},
          h('div', { class: 'mi-title rewind-text', text: p.text || '(no text)' }),
          h('div', { class: 'mi-sub', text: [p.at ? SB.ago?.(p.at) || new Date(p.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null, p.code ? `${plural(p.code, 'turn')} of file changes after it` : 'no file changes after it'].filter(Boolean).join(' · ') })))),
    ]);
  };

  function rewindOptions(tab, p) {
    const option = (glyph, title, sub, opts, enabled = true) => h('button', { class: 'menu-item', disabled: !enabled, onclick: () => { SB.closeMenus(); doRewind(tab, p, opts); } },
      h('span', { class: 'mi-check', text: glyph }), h('span', {}, h('div', { class: 'mi-title', text: title }), h('div', { class: 'mi-sub', text: sub })));
    const files = p.code ? `undoes ${plural(p.code, 'turn')} of file changes` : 'no files changed after it';
    const older = p.conversation ? null : 'From before Shellby could rewind conversations';
    SB.closeMenus();
    openAboveBox(() => [
      h('div', { class: 'menu-label', text: 'Rewind to just before' }),
      h('div', { class: 'menu-item path rewind-quote', text: p.text || '(no text)' }),
      h('div', { class: 'menu-sep' }),
      option('⟲', 'Conversation and code', older || `Forget everything after it, and ${files}`, { conversation: true, code: true }, p.conversation && p.code > 0),
      option('💬', 'Conversation only', older || 'Forget everything after it. Files stay as they are now', { conversation: true, code: false }, p.conversation),
      option('⎌', 'Code only', p.code ? `Put the files back; the conversation carries on` : 'No files changed after it', { conversation: false, code: true }, p.code > 0),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => SB.closeMenus() }, h('span', { class: 'mi-check', text: '' }), h('span', { class: 'mi-title', text: 'Never mind' })),
    ]);
  }

  async function doRewind(tab, p, opts) {
    SB.toast('Rewinding…', { ms: 15000 });
    const r = await api.rewind(tab.id, p.turnId, opts);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't rewind.", { ms: 9000 });
    const files = r.restored ? ` Put ${plural(r.restored, 'file')} back.` : '';
    if (r.kept) return SB.toast(`Code rewound.${files}`, { ms: 6000 });
    tab.reset(r.items || []);
    tab.queue = [];
    if (tab.isActive) {
      // Like the terminal: what you said comes back, ready to change and send again.
      if (!input.value.trim()) input.value = r.text || '';
      for (const f of r.attachments || []) if (!tab.attachments.includes(f)) tab.attachments.push(f);
      SB.renderAttachments();
      SB.autosize();
      input.focus();
      shellMode();
      SB.syncBusyUi();
    } else if (!tab.draft) tab.draft = r.text || '';
    SB.toast(`Rewound.${files} Your message is back in the box.`, { ms: 6000 });
  }

  // Esc twice in an empty box (not working), within a moment: the rewind
  // picker. A single Esc still hides the panel, just a beat later.
  const DOUBLE_ESC_MS = 420;
  let escAt = 0;
  let escTimer = null;
  SB.escRewind = (tab, e) => {
    if (e?.repeat) return true; // a held-down Esc is one press, not a double
    if (!tab?.saved || tab.busy || input.value.trim() || document.activeElement !== input) return false;
    const now = Date.now();
    if (escTimer && now - escAt < DOUBLE_ESC_MS) {
      clearTimeout(escTimer);
      escTimer = null;
      SB.openRewind(tab);
      return true;
    }
    escAt = now;
    clearTimeout(escTimer);
    escTimer = setTimeout(() => { escTimer = null; if (state.view === 'chat') api.hide(); }, DOUBLE_ESC_MS);
    return true;
  };
})();
