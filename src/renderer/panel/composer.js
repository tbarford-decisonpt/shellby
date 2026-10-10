/* Shellby panel — the message box's terminal conveniences, as Claude Code has them:
   @ file mentions, Up/Down and Ctrl+R through what you've sent, ! to run a
   command yourself, Shellby's own slash commands (/export, /rewind, /effort…),
   the effort chip, and rewinding to an earlier message (Esc Esc).
   tabs.js owns the box itself and calls in here (SB.pickKeydown, SB.runLocal…). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const input = $('input');
  const { plural } = SB;

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
      ? h('div', { class: 'pick-head', text: `Search what you've sent${pick.query ? `: "${pick.query}"` : ''} · Enter to use · ${SB.shortcuts.primary('searchSent')} for older` })
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
    if (SB.shortcuts.matches(e, 'searchSent')) {
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
  SB.EFFORTS = EFFORTS; // the palette's Effort entries (nav.js)

  SB.LOCAL_COMMANDS = [
    { name: 'clear', kind: 'shellby', description: 'Start a new conversation in this tab: Claude forgets everything so far. /export still has it' },
    { name: 'rewind', kind: 'shellby', description: 'Go back to an earlier message: the conversation, the code, or both (Esc Esc)' },
    { name: 'branch', kind: 'shellby', description: 'Try again from an earlier message in a new tab, with its own copy of the files. This one stays as it is' },
    { name: 'tries', kind: 'shellby', description: 'Try a message 2, 3 or 4 ways at once, each in its own copy, then pick the best: /tries 3 fix the login. Asks first, with the cost' },
    { name: 'btw', kind: 'shellby', description: 'Ask a quick side question, even while Claude works. It sees the conversation but stays out of it' },
    { name: 'export', kind: 'shellby', description: 'Save this conversation as Markdown (/export clipboard copies it)' },
    { name: 'effort', kind: 'shellby', description: 'How hard Claude thinks here: low, medium, high, xhigh, max or auto. /effort new <level|pick> for new conversations' },
    { name: 'permissions', kind: 'shellby', description: 'The allow, ask and deny rules Claude Code follows' },
    { name: 'mcp', kind: 'shellby', description: 'MCP servers: add, remove, reconnect, turn on or off' },
    { name: 'model', kind: 'shellby', description: 'Pick the model for new conversations' },
    { name: 'output-style', kind: 'shellby', description: 'How Claude talks while it works (Explanatory, Learning…)' },
    { name: 'snippets', kind: 'shellby', description: 'Your saved prompts. /snippets save [name] keeps the last thing you sent; /snippets new writes one' },
  ];

  const LOCAL = {
    clear: (tab) => clearConversation(tab),
    rewind: (tab) => SB.openRewind(tab),
    branch: (tab) => SB.openBranch(tab),
    // Try it N ways (tries.js): main asks first, with what it usually costs.
    tries: (tab, arg) => startTries(tab, arg),
    try: (tab, arg) => startTries(tab, arg),
    btw: (tab, arg) => askBtw(tab, arg),
    export: async (tab, arg) => {
      if (!tab.saved) return SB.toast('Send it something first: there is nothing to export yet.');
      const to = /^clip/i.test(arg) ? 'clipboard' : 'file';
      const r = await api.exportSession(tab.id, to);
      if (r?.ok) SB.toast(to === 'clipboard' ? 'Copied the conversation as Markdown.' : `Saved to ${SB.tildify(r.path)}`, { ms: 5000 });
      else if (!r?.cancelled) SB.toast(r?.error || "Couldn't export it.");
    },
    effort: (tab, arg) => {
      const fresh = /^new\s+/i.test(arg);
      const want = arg.replace(/^new\s+/i, '').toLowerCase().replace(/^extra[\s-]?high$/, 'xhigh').replace(/^(auto|default)$/, '');
      if (fresh && want === 'pick') return SB.chooseNewEffort(true);
      if (arg && EFFORTS.some(x => x.id === want)) return fresh ? SB.chooseNewEffort(false, want) : SB.chooseEffort(want);
      if (arg) return SB.toast(fresh ? 'New conversations take: pick, auto, low, medium, high, xhigh or max.' : 'Effort is one of: auto, low, medium, high, xhigh, max.');
      SB.openMenu($('effortMenu'), $('effortChip'), effortItems);
    },
    permissions: () => SB.showToolbox?.('permissions'),
    mcp: () => SB.showToolbox?.('mcp'),
    model: () => SB.showSetting?.('modelSelect'),
    'output-style': () => SB.showSetting?.('styleSelect'),
    snippets: (tab, arg) => {
      if (!arg) return SB.showToolbox?.('snippet');
      if (/^new$/i.test(arg)) return SB.newSnippet();
      // Without a name: the editor, with the message in it, to name and tidy.
      if (/^save$/i.test(arg)) {
        const last = lastSent();
        return last ? SB.newSnippet({ text: last }) : SB.toast('Send Claude something first, then save it.');
      }
      const m = /^save\s+(\S+)$/i.exec(arg);
      if (!m) return SB.toast("That's /snippets, /snippets new, or /snippets save [name] to keep the last thing you sent.");
      saveLastAsSnippet(m[1].replace(/^[/@]/, ''));
    },
  };

  // /tries 3 fix the login: main reads the number and the message, and asks.
  // What's attached goes to every try.
  const TAKES_FILES = new Set(['tries', 'try']);
  function startTries(tab, arg) {
    if (!arg) {
      // The box is emptied once this returns: what was attached comes back.
      const files = [...(tab.attachments || [])];
      queueMicrotask(() => SB.giveBackAttachments?.(tab, files));
      return SB.toast('Say how many ways and what: /tries 3 fix the flaky login test');
    }
    SB.startTries?.(tab, { arg, attachments: [...(tab.attachments || [])] });
  }

  // /clear, as in the terminal: main ends Claude's conversation and notes
  // 'cleared', which empties the feed as it arrives (feed.js). The next message
  // starts a new one here, in the same folder and copy.
  async function clearConversation(tab) {
    if (!tab) return;
    if (tab.busy) return SB.toast('Let him finish first (or press Stop), then clear.');
    const r = await api.clearTab(tab.id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't clear it.");
    // Nothing sent yet: only ! output on screen, which main has let go of too.
    if (r.empty) { if (tab.isEmpty) SB.toast('Nothing to clear yet.'); else tab.wipe(); }
  }
  SB.clearConversation = clearConversation; // the palette's Clear (nav.js)

  // /btw what was that file called?: answered in a card of its own (feed-notes.js),
  // from a fork of the conversation that Claude never sees (btw.js).
  async function askBtw(tab, question) {
    if (!question) return SB.toast('Ask something after /btw, like: /btw what was that file called?');
    const card = tab.renderBtw(question);
    const r = await api.askBtw(tab.id, question);
    if (r?.ok) card.answer(r.answer);
    else card.fail(r?.error || "Couldn't ask that.");
  }

  // The last thing you asked Claude, kept as a snippet: "that worked, keep it".
  const lastSent = () => [...sent].reverse().find(s => !/^[/!]/.test(s));
  async function saveLastAsSnippet(name) {
    const last = lastSent();
    if (!last) return SB.toast('Send Claude something first, then save it.');
    const r = await api.saveSnippet({ name, text: last });
    if (!r?.ok) return SB.toast(r?.error || "Couldn't save it.", { ms: 6000 });
    SB.applySnippets(r);
    SB.toast(`Saved as /${r.name}. From a terminal: shellby do @${r.name}`, { ms: 6000 });
  }

  /** Handles a message that's for Shellby, not Claude. true = handled. */
  // !! sends Claude a message that starts with a single !.
  // With attachments, only the commands that take them run here (/tries); the
  // rest go to Claude with the files, as they always have.
  SB.runLocal = (text, tab, attachments = []) => {
    if (text.startsWith('!!')) return false;
    if (text.startsWith('!')) { if (attachments.length) return false; runShell(tab, text.slice(1).trim()); return true; }
    const m = /^\/([\w-]+)(?:\s+(.*))?$/s.exec(text);
    const fn = m && LOCAL[m[1].toLowerCase()];
    // Then Claude Code's own that print mode can't run (builtin-commands.js).
    if (!fn && !attachments.length) return !!SB.runBuiltin?.(text, tab);
    if (!fn || (attachments.length && !TAKES_FILES.has(m[1].toLowerCase()))) return false;
    SB.notePrompt(text);
    fn(tab, (m[2] || '').trim());
    return true;
  };

  // ------------------------------------------------------------ effort chip

  // Each conversation has its own effort (main's sessions.js). New ones start
  // on the default; on Auto with picking on, Shellby sizes each from its first
  // message (effort-pick.js), so a quick question doesn't think and fill its
  // context like a build.
  const picking = () => !state.settings?.effort && state.settings?.effortPick !== false;
  const tabEffort = tab => (tab && typeof tab.effort === 'string' ? tab.effort : state.settings?.effort || '');

  function effortItems() {
    const tab = SB.activeTab();
    const cur = tabEffort(tab);
    const pick = picking();
    return [
      h('div', { class: 'menu-label', text: 'How hard Claude thinks here' }),
      ...EFFORTS.map(x => h('button', { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(cur === x.id), onclick: () => { SB.closeMenus(); SB.chooseEffort(x.id); } },
        h('span', { class: 'mi-check', text: cur === x.id ? '●' : '' }),
        h('span', {}, h('div', { class: 'mi-title', text: x.title }), h('div', { class: 'mi-sub', text: x.sub })))),
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-label', text: 'New conversations' }),
      h('button', { class: 'menu-item', role: 'menuitemcheckbox', 'aria-checked': String(pick), onclick: () => { SB.closeMenus(); SB.chooseNewEffort(!pick); } },
        h('span', { class: 'mi-check', text: pick ? '✓' : '' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Pick to fit each one' }),
          h('div', { class: 'mi-sub', text: pick ? 'Low for a quick question, high for a big job, from its first message'
            : `Off: they start on ${effortName(state.settings?.effort).toLowerCase()}` }))),
    ];
  }

  SB.applyEffort = () => {
    const tab = SB.activeTab();
    const id = tabEffort(tab);
    const by = tab?.effortBy || null;
    const waiting = !by && !id && picking();
    $('effortLabel').textContent = id ? effortName(id).toLowerCase() : waiting ? 'fits' : 'auto';
    $('effortChip').classList.toggle('on', !!id);
    $('effortChip').title = waiting
      ? 'Effort: picked from your first message, to fit the job. Click to choose it yourself (/effort)'
      : `Effort: ${effortName(id)}${by === 'picked' ? ', picked to fit your first message' : ''}. How hard Claude thinks in this conversation (/effort)`;
  };

  // This conversation only. With none open yet, it's what new ones start on.
  SB.chooseEffort = async (id) => {
    const tab = SB.activeTab();
    if (!tab) return SB.chooseNewEffort(false, id);
    const r = await api.setTabEffort(tab.id, id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't change the effort.");
    Object.assign(tab, { effort: id, effortBy: 'you' }); // main's next summary says the same
    SB.applyEffort();
    SB.toast(`Effort: ${effortName(id)}, for this conversation`);
  };

  // pick: size each new conversation from its first message (on Auto).
  // Otherwise they start on `id` ('' is Auto), or the default as it is.
  SB.chooseNewEffort = async (pick, id = state.settings?.effort || '') => {
    const r = await api.setSettings(pick ? { effortPick: true, effort: '' } : { effortPick: false, effort: id });
    state.settings = r.settings;
    SB.applyEffort();
    SB.toast(pick ? 'New conversations get an effort picked to fit their first message.' : `New conversations start on ${effortName(state.settings.effort).toLowerCase()} effort.`);
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
    // A timeline, newest at the top: each stop is "before turn N", with what going back there undoes.
    openAboveBox(() => [
      h('div', { class: 'menu-label', text: 'Rewind to just before…' }),
      h('div', { class: 'rewind-timeline' }, points.slice(0, 30).map((p, i) => h('button', { class: `menu-item rewind-point${p.code ? ' has-code' : ''}`, onclick: () => rewindOptions(tab, p) },
        h('span', { class: 'rewind-stop', 'aria-hidden': 'true' }),
        h('span', {},
          h('div', { class: 'mi-title rewind-text', text: p.text || '(no text)' }),
          h('div', { class: 'mi-sub', text: [`before turn ${points.length - i}`, p.at ? SB.ago?.(p.at) || new Date(p.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null, codeAfter(p)].filter(Boolean).join(' · ') }))))),
    ]);
  };

  // "undoes 3 files, +40 −12" for a stop with code after it (rewind.js weight).
  function codeAfter(p) {
    if (!p.code) return 'no file changes after it';
    return p.files ? `undoes ${plural(p.files, 'file')}, +${p.added || 0} −${p.removed || 0}` : `${plural(p.code, 'turn')} of file changes after it`;
  }

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
      // The way back that loses nothing: this conversation and its files stay as they are.
      h('button', { class: 'menu-item', disabled: !p.conversation, onclick: () => { SB.closeMenus(); doBranch(tab, p.turnId, 'before'); } },
        h('span', { class: 'mi-check', text: '⑂' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Try it in a new tab instead' }), h('div', { class: 'mi-sub', text: older || 'Keeps this conversation and its files exactly as they are' }))),
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

  // ------------------------------------------------------------ branch (branching.js)
  //
  // Rewind's other half: instead of taking this conversation back, open a new
  // tab that remembers it up to a point, in its own copy of the files as they
  // were then. This one carries on untouched, so two tries can run side by side.

  // A conversation's name as a link that opens it (from History if it's closed).
  SB.historyLink = (id, text) => h('button', { class: 'link-btn', type: 'button', onclick: () => SB.openHistory(id) }, text);

  // turnId: the message to branch at (none: pick one, newest first).
  // at: 'before' the message (try it again) or 'after' its reply (carry on from there).
  SB.openBranch = async (tab, turnId = null, at = 'before') => {
    if (!tab) return;
    if (!tab.saved) return SB.toast('Send it something first: there is nothing to branch yet.');
    const { points = [] } = await api.rewindPoints(tab.id).catch(() => ({}));
    if (!points.length) return SB.toast('Nothing to branch from yet.');
    const chosen = turnId && points.find(p => p.turnId === turnId);
    if (chosen) return branchOptions(tab, chosen, at);
    openAboveBox(() => [
      h('div', { class: 'menu-label', text: 'Try again in a new tab from just before…' }),
      ...points.slice(0, 30).map(p => h('button', { class: 'menu-item rewind-point', disabled: !p.conversation, onclick: () => branchOptions(tab, p, 'before') },
        h('span', { class: 'mi-check', text: '⑂' }),
        h('span', {},
          h('div', { class: 'mi-title rewind-text', text: p.text || '(no text)' }),
          h('div', { class: 'mi-sub', text: p.conversation ? (p.at ? SB.ago?.(p.at) || new Date(p.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') : 'From before Shellby could branch conversations' })))),
    ]);
  };

  function branchOptions(tab, p, at) {
    const option = (glyph, title, sub, run, enabled = true) => h('button', { class: 'menu-item', disabled: !enabled, onclick: () => { SB.closeMenus(); run(); } },
      h('span', { class: 'mi-check', text: glyph }), h('span', {}, h('div', { class: 'mi-title', text: title }), h('div', { class: 'mi-sub', text: sub })));
    const older = p.conversation ? null : 'From before Shellby could branch conversations';
    const files = tab.worktree || tab.cwd ? 'its own copy of the files as they were then' : 'the files';
    SB.closeMenus();
    openAboveBox(() => [
      h('div', { class: 'menu-label', text: at === 'after' ? 'Branch after the reply to' : 'Try again from just before' }),
      h('div', { class: 'menu-item path rewind-quote', text: p.text || '(no text)' }),
      h('div', { class: 'menu-sep' }),
      ...(at === 'after'
        ? [option('⑂', 'Branch from here', older || `A new tab that carries on from this reply, with ${files}`, () => doBranch(tab, p.turnId, 'after'), p.conversation)]
        : [
          option('✎', 'Change it and try again', older || `A new tab from just before this message, with ${files}. Your message waits in the box`, () => doBranch(tab, p.turnId, 'before'), p.conversation),
          option('↻', 'Run it again in a new tab', older || 'The same message, sent again straight away: two takes side by side', () => doBranch(tab, p.turnId, 'before', { send: true }), p.conversation),
        ]),
      h('div', { class: 'small muted menu-note', text: 'This conversation and its files stay exactly as they are.' }),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => SB.closeMenus() }, h('span', { class: 'mi-check', text: '' }), h('span', { class: 'mi-title', text: 'Never mind' })),
    ]);
  }

  async function doBranch(tab, turnId, at, { send = false } = {}) {
    SB.toast('Making a branch…', { ms: 20000 });
    const r = await api.branch(tab.id, turnId, { at, send });
    if (!r?.ok) return r?.cancelled ? SB.toast('Not branched.') : SB.toast(r?.error || "Couldn't make the branch.", { ms: 9000 });
    // The new tab has opened itself (boot.js onTabOpened).
    const where = r.branch ? `its own copy on ${r.branch}` : 'the same folder as the original';
    const note = r.filesNow ? ' The files are as they are now: the ones from then had been tidied away.' : r.approx ? ' The files are as near to then as Shellby can tell.' : '';
    SB.toast(r.sent ? `Running it again in ${where}.${note}` : at === 'before' ? `Branched into ${where}. Change your message and send it.${note}` : `Branched into ${where}. Carry on from there.${note}`, { ms: 7000 });
  }

  // Esc twice in an empty box (not working), within a moment: the rewind
  // picker. A single Esc does nothing: home is where Esc stops (tabs.js), and
  // a stray press must never make the window vanish.
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
    escTimer = setTimeout(() => { escTimer = null; }, DOUBLE_ESC_MS);
    return true;
  };
})();
