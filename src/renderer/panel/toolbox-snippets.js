/* Shellby panel — Toolbox > Snippets: your saved prompts, run as /name in the box
   or `shellby do @name` in a terminal. Main keeps and re-checks them (snippets.js);
   this is the list, the editor, and running one.

   The editor checks as you type (the name, the blanks, the length) so Save is
   rarely refused, and paints $ARGUMENTS and $1 to $9 in the prompt with a layer
   drawn behind a transparent textarea, so it stays a plain, native text box. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  // As snippets.js has them. Main has the last word; these only make the editor helpful.
  const SLOT = /\$ARGUMENTS|(?<![\w$])\$([1-9])(?!\w|[.,]\d)/g;
  const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const MAX_TEXT = 4000;
  const MAX_HINT = 60;
  const NEAR_MAX = 3500;

  let editor = null; // { id, was, name, text, hint, newTab, start } while it's open
  let opened = 0;
  let flash = null;  // { name, until }: a snippet just saved, lit up in the list for a moment

  const list = () => state.snippets || [];
  const rerender = () => { if (state.view === 'toolbox') SB.views.toolbox?.render(); };

  function slots(text) {
    let all = false;
    let count = 0;
    for (const m of String(text).matchAll(SLOT)) { if (m[1]) count = Math.max(count, Number(m[1])); else all = true; }
    return { all, count };
  }

  /** Does the box's text start with one of your snippets (/review …)? */
  SB.isSnippetCall = text => {
    const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/i.exec(text || '');
    return !!m && list().some(s => s.name === m[1].toLowerCase());
  };

  SB.applySnippets = (v) => {
    if (!Array.isArray(v?.snippets)) return; // a refusal, not a new list
    state.snippets = v.snippets;
    if (v.pinned) state.pinned = v.pinned;
    rerender();
    SB.refreshEmptyStates?.();
  };

  /**
   * Run from a chip or the Run button. Whatever's in the box goes with it, and a
   * snippet that needs something ($ARGUMENTS, $1…) waits in the box for it.
   */
  SB.runSnippet = (name) => {
    const s = list().find(x => x.name === name);
    if (!s) return;
    const draft = $('input').value.replace(/^\/\S*\s*/, '').trim();
    if (draft || s.needsInput) return SB.prefill(`/${s.name} ${draft}`);
    SB.setView('chat');
    SB.send(`/${s.name}`);
  };

  /** The editor, open on a new snippet (with a prompt already in it, from /snippets save). */
  SB.newSnippet = ({ text = '', name = '' } = {}) => {
    if (editorBusy()) return;
    openEditor({ name, text });
    SB.showToolbox('snippet');
    focusEditor(name ? 'snipText' : 'snipName');
  };

  // Claude Code's own commands, before a conversation has told the Toolbox about them.
  const CLAUDE_COMMANDS = new Set(['review', 'security-review', 'init', 'help', 'cost', 'context', 'memory', 'config', 'status', 'doctor', 'pr-comments', 'agents', 'hooks', 'resume']);

  // A skill or command the snippet runs instead of, in the box.
  function shadowed(name) {
    const tb = state.toolbox;
    if (tb?.skills.some(t => t.name.toLowerCase() === name)) return 'skill';
    if (tb?.commands.some(t => t.name.toLowerCase() === name) || CLAUDE_COMMANDS.has(name)) return 'command';
    return null;
  }

  const isPinned = name => (state.pinned || []).some(p => p.kind === 'snippet' && p.name === name);

  async function pin(name, on) {
    state.pinned = await api.pinTool('snippet', name, on);
    rerender();
    SB.refreshEmptyStates();
  }

  // ------------------------------------------------------------ the list

  function statsLine(s) {
    const parts = [
      s.uses ? `Used ${s.uses}×` : 'Not used yet',
      s.uses && Number.isFinite(s.lastUsed) ? `last ${SB.relTime(s.lastUsed)}` : null,
      s.newTab ? 'opens a new conversation' : null,
    ].filter(Boolean);
    return h('p', { class: `tool-stats${s.uses ? '' : ' unused'}`, text: parts.join(' · ') });
  }

  function snippetRow(s) {
    const pinned = isPinned(s.name);
    const hides = shadowed(s.name);
    const more = h('button', {
      class: 'icon-btn snip-more', type: 'button', title: 'More', 'aria-label': `More for /${s.name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => openMenu(more, () => rowMenu(s, pinned)),
    }, h('span', { text: '⋯' }));
    const editing = editor?.was === s.name;
    const lit = flash?.name === s.name && Date.now() < flash.until;
    return h('li', { class: `tool-row snippet-row${editing ? ' is-editing' : ''}${lit ? ' just-saved' : ''}`, dataset: { name: s.name } },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name', title: `Type /${s.name} in the box, or shellby do @${s.name} in a terminal` },
          h('code', { text: `/${s.name}` }),
          s.hint ? h('span', { class: 'snip-hint', text: `<${s.hint}>` }) : null),
        h('p', { class: 'tool-desc', text: s.text, title: s.text }),
        statsLine(s),
        hides ? h('p', { class: 'snip-note', text: `In the box, this runs instead of the /${s.name} ${hides}.` }) : null),
      h('div', { class: 'tool-actions' },
        h('button', { class: 'btn slim-btn', type: 'button', title: s.needsInput ? 'Put it in the box, to add what it is about' : s.newTab ? 'Send it in a new conversation' : 'Send it in this conversation', onclick: () => SB.runSnippet(s.name) }, 'Run'),
        h('button', { class: 'btn ghost slim-btn', type: 'button', disabled: editing, onclick: () => { if (editorBusy()) return; openEditor({ ...s, was: s.name }); rerender(); focusEditor('snipText'); } }, 'Edit'),
        h('button', {
          class: `icon-btn pin${pinned ? ' on' : ''}`, type: 'button', title: pinned ? 'Unpin' : 'Pin to the start screen', 'aria-pressed': String(pinned),
          onclick: () => pin(s.name, !pinned),
        }, h('span', { text: pinned ? '★' : '☆' })),
        more));
  }

  function rowMenu(s, pinned) {
    return [
      menuItem('Duplicate', 'A copy to change, kept beside this one', async () => {
        if (editorBusy()) return;
        const r = await api.duplicateSnippet(s.name);
        if (!r?.ok) return SB.toast(r?.error || "Couldn't copy it.", { ms: 6000 });
        SB.applySnippets(r);
        const copy = list().find(x => x.name === r.name);
        if (copy) { openEditor({ ...copy, was: copy.name }); rerender(); focusEditor('snipName', true); }
      }),
      menuItem('Copy prompt', 'The words, to paste somewhere else', () => { api.copyText(s.text); SB.toast(`Copied /${s.name}'s prompt`); }),
      h('div', { class: 'menu-sep', role: 'separator' }),
      menuItem(`Delete /${s.name}`, 'Undo is on the message that follows', () => removeSnippet(s, pinned), { tone: 'danger' }),
    ];
  }

  async function removeSnippet(s, pinned) {
    if (editor?.was === s.name) editor = null;
    SB.applySnippets(await api.removeSnippet(s.name));
    SB.toast(`Deleted /${s.name}`, { action: 'Undo', ms: 8000, onAction: async () => {
      const r = await api.saveSnippet({ name: s.name, text: s.text, hint: s.hint, newTab: s.newTab });
      if (!r?.ok) return SB.toast(r?.error || "Couldn't bring it back.", { ms: 6000 });
      SB.applySnippets(r);
      if (pinned) await pin(s.name, true);
    } });
  }

  function menuItem(title, sub, onclick, { tone = '', disabled = false } = {}) {
    return h('button', { class: `menu-item${tone ? ` ${tone}` : ''}`, type: 'button', role: 'menuitem', disabled, onclick: () => { SB.closeMenus(); onclick(); } },
      h('span', {}, h('div', { class: 'mi-title', text: title }), sub ? h('div', { class: 'mi-sub', text: sub }) : null));
  }

  function openMenu(anchor, build) {
    SB.openMenu($('snipMenu'), anchor, build);
  }

  // ------------------------------------------------------------ the bar above it

  function paneBar() {
    const more = h('button', {
      class: 'icon-btn snip-more', type: 'button', title: 'Import, export and starters', 'aria-label': 'More snippet options', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => openMenu(more, barMenu),
    }, h('span', { text: '⋯' }));
    return h('div', { class: 'mcp-bar snip-bar' },
      h('span', { class: 'muted small', text: 'Prompts you send again and again. Type /name in the box, or shellby do @name in a terminal.' }),
      h('button', { class: 'btn primary slim-btn', type: 'button', disabled: !!editor && !editor.was, onclick: () => SB.newSnippet() }, 'New snippet'),
      more);
  }

  function barMenu() {
    return [
      menuItem('Import from a file…', 'Adds to yours; nothing is replaced', async () => {
        const r = await api.importSnippets();
        if (r?.cancelled) return;
        if (!r?.ok) return SB.toast(r?.error || "Couldn't import that.", { ms: 8000 });
        SB.applySnippets(r);
        SB.toast(importedText(r), { ms: 8000 });
      }),
      menuItem('Export to a file…', list().length ? `All ${list().length}, to keep or share` : 'Nothing to export yet', async () => {
        const r = await api.exportSnippets();
        if (r?.cancelled) return;
        if (!r?.ok) return SB.toast(r?.error || "Couldn't export them.", { ms: 8000 });
        SB.toast(`Exported ${r.count} snippet${r.count === 1 ? '' : 's'} to ${SB.tildify(r.path)}`, { ms: 6000 });
      }, { disabled: !list().length }),
      h('div', { class: 'menu-sep', role: 'separator' }),
      menuItem('Add the starters', 'review, tests, explain, commit and pr, if they are missing', addStarters),
    ];
  }

  function importedText(r) {
    if (!r.added.length) return r.skipped ? 'Nothing new in that file: you have all of those already.' : 'There were no snippets in that file.';
    const head = `Added ${r.added.length}: ${r.added.slice(0, 6).map(n => `/${n}`).join(', ')}${r.added.length > 6 ? ', …' : ''}.`;
    const ren = r.renamed.length ? ` ${r.renamed.map(x => `/${x.from} came in as /${x.to}`).slice(0, 2).join(', ')}, as you have one by that name.` : '';
    return head + ren;
  }

  async function addStarters() {
    const r = await api.restoreStarterSnippets();
    if (!r?.ok) return SB.toast(r?.error || "Couldn't add them.", { ms: 6000 });
    SB.applySnippets(r);
    SB.toast(r.added.length ? `Added ${r.added.map(n => `/${n}`).join(', ')}` : 'You have all the starters already.');
  }

  // ------------------------------------------------------------ the editor

  /** Opening another would lose what's typed in this one: say so, and go back to it. */
  function editorBusy() {
    if (!dirty()) return false;
    SB.showToolbox('snippet');
    SB.toast('Save or cancel the snippet you are editing first.');
    focusEditor('snipText');
    return true;
  }

  function openEditor(s) {
    const f = { name: s.name || '', text: s.text || '', hint: s.hint || '', newTab: !!s.newTab };
    editor = { id: ++opened, was: s.was || null, ...f, start: JSON.stringify(f) };
  }

  const dirty = () => !!editor && JSON.stringify({ name: editor.name, text: editor.text, hint: editor.hint, newTab: editor.newTab }) !== editor.start;

  function closeEditor() {
    editor = null;
    rerender();
  }

  function focusEditor(id, select = false) {
    requestAnimationFrame(() => {
      const el = $(id);
      if (!el) return;
      el.focus();
      if (select) el.select();
      else if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
      el.closest('form')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  }

  /** What's wrong with the name so far: { err } stops a save, { warn } doesn't. */
  function checkName(n) {
    if (!n) return {};
    if (n.length > 32) return { err: 'Keep it to 32 characters.' };
    if (!NAME.test(n)) return { err: n.startsWith('-') ? 'Start with a letter or a digit.' : 'Lowercase letters, digits and dashes only.' };
    if ((SB.LOCAL_COMMANDS || []).some(c => c.name === n) || n === 'compact' || n === 'clear') return { err: `/${n} is one of Shellby's own commands.` };
    if (n !== editor.was && list().some(s => s.name === n)) return { err: `You already have a /${n}.` };
    const hides = shadowed(n);
    return hides ? { warn: `Typed in the box, it runs instead of the /${n} ${hides}.` } : {};
  }

  function editorForm() {
    const f = editor;
    const nameIn = h('input', { id: 'snipName', type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: '40', placeholder: 'review', 'aria-describedby': 'snipNameNote' });
    const nameNote = h('p', { class: 'field-hint', id: 'snipNameNote', 'aria-live': 'polite' });
    const backdrop = h('div', { class: 'snip-backdrop', 'aria-hidden': 'true' });
    const textIn = h('textarea', { id: 'snipText', class: 'snip-text', rows: '3', placeholder: 'Review my uncommitted changes and point out anything risky.', 'aria-describedby': 'snipTextNote' });
    const count = h('span', { class: 'snip-count' });
    const textNote = h('p', { class: 'field-hint', id: 'snipTextNote' });
    const numBtn = h('button', { type: 'button', class: 'snip-token', title: 'One word typed after the name. The last numbered blank takes whatever is left.' });
    const usage = h('p', { class: 'snip-usage', id: 'snipUsage' });
    const hintIn = h('input', { id: 'snipHint', class: 'field', type: 'text', maxlength: String(MAX_HINT), placeholder: 'a file or function', 'aria-describedby': 'snipUsage' });
    const hintBox = h('div', { class: 'snip-hint-box' },
      h('label', { class: 'field-label', for: 'snipHint' }, 'What goes after the name'),
      hintIn,
      usage);
    const newTab = h('input', { type: 'checkbox', id: 'snipNewTab' });
    const status = h('p', { class: 'setup-status', role: 'status' });
    const saveBtn = h('button', { class: 'btn primary slim-btn', type: 'submit' }, f.was ? 'Save changes' : 'Save snippet');
    let armed = false; // Esc pressed once on unsaved changes

    nameIn.value = f.name;
    textIn.value = f.text;
    hintIn.value = f.hint;
    newTab.checked = f.newTab;

    const setStatus = (text, tone = '') => { status.textContent = text; status.className = `setup-status${tone ? ` ${tone}` : ''}`; };

    function update() {
      // Whatever Save last said is out of date once anything changes.
      if (!armed && !saveBtn.disabled) setStatus('');
      const n = f.name.trim().replace(/^[/@]/, '').toLowerCase();
      const c = checkName(n);
      const call = n && !c.err ? `/${n}` : '/name';
      nameNote.textContent = c.err || c.warn || (n ? `Type /${n} in the box, or shellby do @${n} in a terminal.` : 'Lowercase letters, digits and dashes, like fix-ci.');
      nameNote.className = `field-hint${c.err ? ' err' : c.warn ? ' warn' : ''}`;
      nameIn.closest('.snip-name').classList.toggle('bad', !!c.err);

      const { all, count: num } = slots(f.text);
      textNote.textContent = num === 1 ? `$1 becomes whatever is typed after ${call}.`
        : num === 2 ? `$1 is the first word typed after ${call}, and $2 the rest. "Quoted words" count as one.`
        : num ? `$1 is the first word typed after ${call}, $2 the next, and so on. $${num} takes the rest; "quoted words" count as one.`
        : all ? `$ARGUMENTS becomes whatever is typed after ${call}.`
          : `Anything typed after ${call} goes on the end. Add a blank to put it somewhere else.`;
      numBtn.textContent = `$${Math.min(9, num + 1)}`;
      numBtn.disabled = num >= 9;
      const len = f.text.trim().length;
      count.textContent = len > NEAR_MAX ? `${len} / ${MAX_TEXT}` : '';
      count.className = `snip-count${len > MAX_TEXT ? ' over' : ''}`;

      hintBox.hidden = !(all || num);
      const hint = f.hint.trim().replace(/^<(.*)>$/, '$1');
      usage.textContent = `Shown as ${call} <${hint || 'what it needs'}> in the slash menu and the terminal.`;
      paint();
    }

    // The layer behind the textarea: the same text, invisible, with the blanks marked.
    function paint() {
      const v = textIn.value;
      const parts = [];
      let last = 0;
      for (const m of v.matchAll(SLOT)) { parts.push(v.slice(last, m.index), h('mark', { text: m[0] })); last = m.index + m[0].length; }
      parts.push(`${v.slice(last)}\n`);
      backdrop.replaceChildren(...parts);
      textIn.style.height = 'auto';
      textIn.style.height = `${textIn.scrollHeight}px`;
      backdrop.scrollTop = textIn.scrollTop;
    }

    function insert(token) {
      const { selectionStart: a, selectionEnd: b, value } = textIn;
      const before = value.slice(0, a);
      // A space after a word ("tests for $ARGUMENTS"), none after "#" or "(".
      const pad = /[\p{L}\p{N}]$/u.test(before) ? ' ' : '';
      textIn.setRangeText(pad + token, a, b, 'end');
      f.text = textIn.value;
      textIn.focus();
      update();
    }

    nameIn.addEventListener('input', () => {
      // Typed the way it'll be called: lowercase, dashes for spaces, no leading / or @.
      const at = nameIn.selectionStart;
      const lead = /^[/@]/.test(nameIn.value) ? 1 : 0;
      const next = nameIn.value.slice(lead).toLowerCase().replace(/\s/g, '-');
      if (next !== nameIn.value) { nameIn.value = next; nameIn.setSelectionRange(Math.max(0, at - lead), Math.max(0, at - lead)); }
      f.name = nameIn.value;
      armed = false;
      update();
    });
    textIn.addEventListener('input', () => { f.text = textIn.value; armed = false; update(); });
    textIn.addEventListener('scroll', () => { backdrop.scrollTop = textIn.scrollTop; });
    hintIn.addEventListener('input', () => { f.hint = hintIn.value; armed = false; update(); });
    newTab.addEventListener('change', () => { f.newTab = newTab.checked; armed = false; update(); });
    numBtn.addEventListener('click', () => insert(numBtn.textContent));

    async function save() {
      const n = f.name.trim().replace(/^[/@]/, '').toLowerCase();
      const c = checkName(n);
      if (!n || c.err) { setStatus(c.err || 'Give it a name first.', 'err'); return nameIn.focus(); }
      if (!f.text.trim()) { setStatus('What should it ask Claude?', 'err'); return textIn.focus(); }
      if (f.text.trim().length > MAX_TEXT) { setStatus(`Keep it under ${MAX_TEXT} characters.`, 'err'); return textIn.focus(); }
      saveBtn.disabled = true;
      setStatus('Saving…');
      let r;
      try { r = await api.saveSnippet({ name: n, text: f.text, hint: f.hint, newTab: f.newTab }, f.was); } catch { r = null; }
      saveBtn.disabled = false;
      if (!r?.ok) { setStatus(r?.error || "Couldn't save it.", 'err'); return; }
      const was = f.was;
      editor = null;
      flash = { name: r.name, until: Date.now() + 1500 };
      SB.applySnippets(r);
      SB.toast(was ? `Saved /${r.name}` : `Saved. Type /${r.name} in the box, or shellby do @${r.name} in a terminal.`, { ms: 6000 });
    }

    const form = h('form', {
      class: 'snip-editor', 'aria-label': f.was ? `Edit /${f.was}` : 'New snippet',
      onsubmit: e => { e.preventDefault(); save(); },
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); return; }
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (!dirty() || armed) return closeEditor();
        armed = true;
        setStatus('You have changes. Press Esc again to throw them away.', 'warn');
      },
    },
      h('div', { class: 'snip-head' },
        h('h3', { text: f.was ? `Edit /${f.was}` : 'New snippet' }),
        h('span', { class: 'field-hint', text: 'Ctrl+Enter saves · Esc closes' })),
      h('div', { class: 'field-label' },
        h('label', { for: 'snipName', text: 'Name' }),
        h('div', { class: 'field snip-name' }, h('span', { class: 'snip-slash', 'aria-hidden': 'true', text: '/' }), nameIn),
        nameNote),
      h('div', { class: 'field-label' },
        h('div', { class: 'snip-label-row' },
          h('label', { for: 'snipText', text: 'Prompt' }),
          count),
        h('div', { class: 'snip-prompt' }, backdrop, textIn),
        h('div', { class: 'snip-tools' },
          h('span', { class: 'snip-tools-label', text: 'Add a blank' }),
          h('button', { type: 'button', class: 'snip-token', title: 'Everything typed after the name goes here', onclick: () => insert('$ARGUMENTS') }, '$ARGUMENTS'),
          numBtn),
        textNote),
      hintBox,
      h('label', { class: 'toggle snip-toggle', for: 'snipNewTab' }, newTab, h('span', { class: 'switch' }),
        h('span', {}, 'Start a new conversation each time', h('span', { class: 'field-hint snip-toggle-sub', text: 'Leaves the one you are in as it is. Good for /pr and /commit.' }))),
      h('div', { class: 'snip-foot' },
        status,
        h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: closeEditor }, 'Cancel'),
        saveBtn));

    // Measured once it's on the page: the autosize needs a width.
    requestAnimationFrame(update);
    queueMicrotask(update);
    return form;
  }

  // ------------------------------------------------------------ the tab

  function emptyState(q) {
    if (q) return h('li', { class: 'history-empty', text: 'No matches.' });
    return h('li', { class: 'history-empty snip-empty' },
      h('p', { text: 'No snippets yet. Write one with New snippet, or send Claude something and type /snippets save to keep it.' }),
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: addStarters }, 'Add the five starters'));
  }

  function render(q) {
    const pane = $('setupPane');
    // Rebuilt only when the editor opens or closes, so a refresh can't take the cursor out of it.
    const key = `snippet:${editor ? editor.id : 'closed'}`;
    pane.hidden = false;
    if (pane.dataset.mounted !== key) {
      pane.replaceChildren(paneBar(), ...(editor ? [editorForm()] : []));
      pane.dataset.mounted = key;
    }
    const items = list().filter(s => !q || s.name.includes(q) || s.text.toLowerCase().includes(q) || (s.hint || '').toLowerCase().includes(q));
    $('toolList').replaceChildren(...(items.length ? items.map(snippetRow) : [emptyState(q)]));
  }

  SB.toolboxSnippets = { render };
})();
