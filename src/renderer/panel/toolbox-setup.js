/* Shellby panel — Toolbox → Hooks and Memory: the hooks in Claude Code's settings
   and the CLAUDE.md files that load for this folder, each with a small editor.
   The main process re-checks every write, and hook changes ask in the confirm window. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const STALE_MS = 5000;
  const KINDS = new Set(['hook', 'memory']);
  let loading = null;
  let lastTry = 0;
  // One open editor per tab, so opening one never throws away the other's unsaved text.
  let hookEd = null;  // { entry (null = new), draft: the form's values, error }
  let memEd = null;   // { entry, original, text, mtimeMs, error, conflict, leaving }

  const SOURCE = { user: 'yours', project: 'this project', local: 'just you', 'user-rule': 'your rule', 'project-rule': 'project rule', parent: 'folder above' };
  const MEMORY_TITLE = {
    user: 'Your memory', project: 'Project memory', local: 'Your notes for this project',
    'user-rule': 'Your rule', 'project-rule': 'Project rule', parent: 'From a folder above',
  };
  const MEMORY_WHEN = {
    user: 'Loads in every project.', project: 'Loads for anyone working in this project.', local: 'Loads in this project, just for you.',
    'user-rule': 'Loads in every project.', 'project-rule': 'Loads in this project.', parent: 'Loads for every project inside that folder.',
  };
  const WHERE = {
    user: 'Your settings (every project)',
    project: 'This project, shared (.claude/settings.json)',
    local: 'This project, just you (settings.local.json)',
  };

  const sourceLabel = src => (src.startsWith('plugin:') ? src.slice(7) : SOURCE[src] || src);
  const size = n => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);
  const rerender = () => { if (state.view === 'toolbox') SB.views.toolbox.render(); };

  // Fetch when stale (or never fetched); re-render once it lands.
  function refresh(force = false) {
    const fresh = !force && Date.now() - Math.max(lastTry, state.setup?.scannedAt || 0) < STALE_MS;
    if (loading || fresh) return loading;
    lastTry = Date.now();
    loading = api.getClaudeSetup()
      .then(s => { state.setup = s; })
      .catch(() => {})
      .finally(() => { loading = null; rerender(); });
    return loading;
  }
  const reload = () => refresh(true);

  const count = k => {
    const s = state.setup;
    if (!s) return '';
    return k === 'hook' ? s.hooks.length : s.memory.filter(m => m.exists).length;
  };

  const folderBtn = p => h('button', { class: 'icon-btn', type: 'button', title: 'Show file', 'aria-label': 'Show file', onclick: () => api.revealSetupFile(p) },
    SB.icon(SB.ICONS.folder, { width: 1.3 }));

  // Results from main carry a fresh scan; keep it whatever happened. A call that
  // fails outright (the panel reloading under it) reads as a plain failure.
  async function call(fn) {
    try {
      const r = await fn();
      if (r?.setup) state.setup = r.setup;
      return r || { ok: false };
    } catch { return { ok: false, error: "Shellby couldn't do that. Try again." }; }
  }

  // ================================================================ hooks

  function hookRow(t) {
    const ours = Object.hasOwn(WHERE, t.source);
    const event = state.setup.events.find(e => e.name === t.event);
    return h('li', { class: 'tool-row hook-row' },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name' },
          h('code', { text: t.event, title: event ? `Runs ${event.when}` : 'An event Shellby doesn\'t know' }),
          t.matcher ? h('span', { class: 'matcher-pill', text: t.matcher, title: `Only for ${t.matcher}` }) : null,
          t.type !== 'command' ? h('span', { class: 'matcher-pill', text: t.type }) : null,
          h('span', { class: 'src-pill', text: sourceLabel(t.source), title: ours ? t.path : `Comes with the ${sourceLabel(t.source)} plugin` })),
        h('p', { class: 'tool-desc hook-cmd', text: t.command || '(empty)', title: t.command })),
      h('div', { class: 'tool-actions' },
        t.editable ? h('button', { class: 'btn slim-btn', type: 'button', onclick: () => { hookEd = { entry: t, error: '' }; rerender(); } }, 'Edit') : null,
        ours ? h('button', {
          class: 'icon-btn', type: 'button', title: 'Remove this hook', 'aria-label': 'Remove this hook',
          onclick: async () => {
            const r = await call(() => api.removeHook(t.source, t.at, t.fp));
            if (r.ok) SB.toast('Hook removed');
            else if (!r.cancelled) SB.toast(r.error || "Couldn't remove that hook");
            rerender();
          },
        }, h('span', { text: '✕' })) : null,
        folderBtn(t.path)));
  }

  function hookForm(ed) {
    const s = state.setup;
    const entry = ed.entry;
    const scopes = s.settings.filter(f => f.state !== 'unreadable').map(f => f.scope);
    const field = (label, control, hint) => h('label', { class: 'field-label' }, label, control, hint || null);
    // The values live in ed.draft, so switching tabs and back keeps what was typed.
    ed.draft = ed.draft || {
      event: entry ? entry.event : 'PreToolUse', matcher: entry?.matcher || '', command: entry?.command || '',
      timeout: entry?.timeout ?? '', where: entry ? entry.source : scopes[0],
    };
    const d = ed.draft;
    const keep = (el, key) => {
      el.value = d[key];
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { d[key] = el.value; });
      return el;
    };

    const event = keep(h('select', { class: 'field', name: 'event' }, s.events.map(e => h('option', { value: e.name, text: e.name }))), 'event');
    const when = h('span', { class: 'field-hint' });
    const matcher = keep(h('input', { class: 'field mono', name: 'matcher', type: 'text', spellcheck: 'false', placeholder: 'Bash, Edit|Write… blank for all' }), 'matcher');
    const matcherRow = field('Only for', matcher, h('span', { class: 'field-hint', text: 'A tool name or pattern. Leave blank to run for every one.' }));
    const command = keep(h('input', { class: 'field mono', name: 'command', type: 'text', spellcheck: 'false', placeholder: 'node "%USERPROFILE%\\.claude\\hooks\\check.js"' }), 'command');
    const timeout = keep(h('input', { class: 'field', name: 'timeout', type: 'number', min: '1', max: '3600', placeholder: '60' }), 'timeout');
    const where = keep(h('select', { class: 'field', name: 'where', disabled: !!entry }, (entry ? [entry.source] : scopes).map(k => h('option', { value: k, text: WHERE[k] }))), 'where');
    const status = h('p', { class: `setup-status${ed.error ? ' err' : ''}`, role: 'status', text: ed.error || '' });
    const syncEvent = () => {
      const e = s.events.find(x => x.name === event.value);
      when.textContent = e ? `Runs ${e.when}.` : '';
      matcherRow.hidden = !e?.matcher;
    };
    event.addEventListener('change', syncEvent);
    syncEvent();

    const save = h('button', { class: 'btn primary slim-btn', type: 'submit' }, entry ? 'Save hook…' : 'Add hook…');
    const form = h('form', {
      class: 'setup-form',
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        const hook = { event: event.value, matcher: matcher.value, command: command.value, timeout: timeout.value };
        const r = await call(() => api.saveHook(where.value, hook, entry?.at || null, entry?.fp || null));
        save.disabled = false;
        if (r.ok) { hookEd = null; SB.toast(entry ? 'Hook saved' : 'Hook added'); rerender(); return; }
        if (r.cancelled) return;
        ed.error = r.error || "Couldn't save that hook.";
        status.textContent = ed.error;
        status.classList.add('err');
      },
    },
    h('div', { class: 'setup-head' },
      h('button', { class: 'back-btn', type: 'button', onclick: () => { hookEd = null; rerender(); } }, '← Hooks'),
      h('strong', { text: entry ? 'Edit hook' : 'New hook' })),
    field('When', event, when),
    matcherRow,
    field('Run this command', command, h('span', { class: 'field-hint', text: 'One line. Claude Code passes the event as JSON on stdin, and exit code 2 blocks the step and tells Claude why. For anything longer, put it in a script and run that.' })),
    h('div', { class: 'row setup-pair' },
      field('Timeout (seconds)', timeout),
      field('Save in', where)),
    status,
    h('div', { class: 'row setup-actions' },
      h('span', { class: 'field-hint', text: 'You\'ll be asked to confirm. Hooks run on their own, without asking.' }),
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { hookEd = null; rerender(); } }, 'Cancel'),
      save));
    return form;
  }

  function renderHooks(q) {
    const s = state.setup;
    const pane = $('setupPane');
    const list = $('toolList');
    if (hookEd) {
      const key = `hook:${hookEd.entry?.id || 'new'}`;
      if (pane.dataset.mounted !== key) { pane.replaceChildren(hookForm(hookEd)); pane.dataset.mounted = key; }
      list.hidden = true;
      return;
    }
    list.hidden = false;
    const unreadable = s.settings.filter(f => f.state === 'unreadable');
    const canAdd = s.settings.some(f => f.state !== 'unreadable');
    pane.dataset.mounted = 'hooks';
    pane.replaceChildren(
      h('div', { class: 'setup-intro' },
        h('p', { text: 'Hooks run a command of yours at set moments: before Claude uses a tool, when a turn ends, when a session starts. Plugin hooks are listed but are managed in Get more.' }),
        canAdd ? h('button', { class: 'btn slim-btn', type: 'button', onclick: () => { hookEd = { entry: null, error: '' }; rerender(); } }, '+ Add a hook') : null),
      unreadable.map(f => h('p', { class: 'setup-warn', text: `Couldn't read ${SB.tildify(f.path)}, so its hooks aren't listed and Shellby won't change it.` })));
    const items = s.hooks.filter(t => !q || [t.event, t.matcher, t.command, t.source].some(v => v.toLowerCase().includes(q)));
    list.replaceChildren(...(items.length ? items.slice(0, 300).map(hookRow)
      : [h('li', { class: 'history-empty', text: q ? 'No matches.' : 'No hooks yet.' })]));
  }

  // ================================================================ memory

  // The claude-md-management plugin's improver skill, if it's installed (plugin
  // skills are listed as "plugin:skill", so match on the end of the name).
  const reviewSkill = () => (state.toolbox?.skills || []).find(t => /(^|:)claude-md-improver$/.test(t.name));

  // Hand the review to Claude: the box is filled in, not sent, so you can say
  // what you'd like changed first.
  function askClaude(file) {
    const what = file ? file : 'the CLAUDE.md files that load for this folder (including my own in ~/.claude)';
    const ask = `Look over ${what} and suggest what to tighten, add or cut. Show me the changes before you make them.`;
    const skill = reviewSkill();
    SB.prefill(skill ? `/${skill.name} ${ask} ` : `${ask} `);
  }

  function askBtn(file, label) {
    const skill = reviewSkill();
    return h('button', {
      class: 'btn ghost slim-btn', type: 'button',
      title: skill ? `Starts a task with /${skill.name}` : 'Starts a task asking Claude to review it',
      onclick: () => askClaude(file),
    }, label);
  }

  async function openMemory(entry) {
    const r = await call(() => api.readMemory(entry.path));
    if (!r.ok) { SB.toast(r.error || "Couldn't open that file"); return; }
    memEd = { entry, original: r.text, text: r.text, mtimeMs: r.mtimeMs, error: '', conflict: false, leaving: false };
    const pane = $('setupPane');
    pane.dataset.mounted = '';
    rerender();
    // Only if the editor is what's showing (not when you've moved to another tab meanwhile).
    if (pane.dataset.mounted === `memory:${entry.path}` && !pane.hidden) pane.querySelector('.mem-text')?.focus();
  }

  function memoryEditor(ed) {
    const area = h('textarea', { class: 'field area mono mem-text', spellcheck: 'false', 'aria-label': `Edit ${ed.entry.path}`, placeholder: '# Notes for Claude\n\n- Use pnpm, not npm.\n- Run the tests before saying it works.' });
    area.value = ed.text;
    const dirty = () => ed.text !== ed.original;
    const hint = () => ed.error || `${MEMORY_WHEN[ed.entry.scope] || ''} Ctrl+S saves.`;
    const status = h('p', { class: `setup-status${ed.error ? ' err' : ''}`, role: 'status', text: hint() });
    const save = h('button', { class: 'btn primary slim-btn', type: 'button', disabled: !dirty() }, ed.entry.exists ? 'Save' : 'Create');
    const back = h('button', { class: 'back-btn', type: 'button' }, '← Memory');
    const reloadBtn = h('button', { class: 'btn ghost slim-btn', type: 'button', hidden: !ed.conflict, onclick: () => openMemory(ed.entry) }, 'Reload');

    const setStatus = (text, err) => { status.textContent = text; status.classList.toggle('err', !!err); };
    async function doSave() {
      if (!dirty() || save.disabled) return;
      save.disabled = true;
      const r = await call(() => api.writeMemory(ed.entry.path, ed.text, ed.mtimeMs));
      if (r.ok) {
        Object.assign(ed, { original: ed.text, mtimeMs: r.mtimeMs, error: '', conflict: false, entry: { ...ed.entry, exists: true } });
        save.textContent = 'Save';
        setStatus(hint());
        SB.toast(`Saved ${SB.basename(ed.entry.path)}`);
      } else {
        Object.assign(ed, { error: r.error || "Couldn't save that file.", conflict: !!r.conflict });
        setStatus(ed.error, true);
        reloadBtn.hidden = !ed.conflict;
      }
      save.disabled = !dirty();
    }

    area.addEventListener('input', () => {
      ed.text = area.value;
      save.disabled = !dirty();
      if (ed.leaving) { ed.leaving = false; back.textContent = '← Memory'; }
    });
    area.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
    });
    save.addEventListener('click', doSave);
    // Leaving with unsaved text takes a second click, so nothing is lost by accident.
    back.addEventListener('click', () => {
      if (dirty() && !ed.leaving) { ed.leaving = true; back.textContent = 'Discard changes?'; return; }
      memEd = null;
      rerender();
    });

    return h('div', { class: 'setup-form mem-editor' },
      h('div', { class: 'setup-head' },
        back,
        h('strong', { text: MEMORY_TITLE[ed.entry.scope] || 'Memory' }),
        h('code', { class: 'mem-path', text: SB.shortPath(ed.entry.path, 46), title: ed.entry.path }),
        ed.entry.exists ? folderBtn(ed.entry.path) : null),
      area,
      h('div', { class: 'row setup-actions' }, status, reloadBtn, ed.entry.exists ? askBtn(ed.entry.path, 'Ask Claude') : null, save));
  }

  function memoryRow(m) {
    return h('li', { class: 'tool-row mem-row' },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name' },
          h('strong', { class: 'mem-title', text: MEMORY_TITLE[m.scope] || 'Memory' }),
          h('span', { class: 'src-pill', text: sourceLabel(m.scope) })),
        h('p', { class: 'tool-desc mem-where' }, h('code', { text: SB.shortPath(m.path, 44), title: m.path })),
        h('p', { class: 'tool-desc', text: m.exists ? `${MEMORY_WHEN[m.scope]} ${size(m.size)} · edited ${SB.relTime(m.mtimeMs)}` : `${MEMORY_WHEN[m.scope]} Not created yet.` })),
      h('div', { class: 'tool-actions' },
        h('button', { class: 'btn slim-btn', type: 'button', onclick: () => openMemory(m) }, m.exists ? 'Edit' : 'Create'),
        m.exists ? folderBtn(m.path) : null));
  }

  function renderMemory(q) {
    const s = state.setup;
    const pane = $('setupPane');
    const list = $('toolList');
    if (memEd) {
      const key = `memory:${memEd.entry.path}`;
      if (pane.dataset.mounted !== key) { pane.replaceChildren(memoryEditor(memEd)); pane.dataset.mounted = key; }
      list.hidden = true;
      return;
    }
    list.hidden = false;
    pane.dataset.mounted = 'memory';
    pane.replaceChildren(h('div', { class: 'setup-intro' },
      h('p', { text: 'CLAUDE.md files are instructions Claude Code reads at the start of every session: how you like to work, how a project builds, what to avoid.' }),
      s.memory.some(m => m.exists) ? askBtn(null, 'Review with Claude') : null));
    const items = s.memory.filter(m => !q || m.path.toLowerCase().includes(q) || (MEMORY_TITLE[m.scope] || '').toLowerCase().includes(q));
    list.replaceChildren(...(items.length ? items.map(memoryRow) : [h('li', { class: 'history-empty', text: 'No matches.' })]));
  }

  // ================================================================ entry points (called from toolbox.js)

  function render(kind, q) {
    if (!state.setup) {
      $('setupPane').replaceChildren();
      $('setupPane').dataset.mounted = '';
      $('toolList').hidden = false;
      $('toolList').replaceChildren(h('li', { class: 'history-empty', text: 'Scanning…' }));
      return;
    }
    if (kind === 'hook') renderHooks(q);
    else renderMemory(q);
  }

  // Leaving the Hooks/Memory tabs: show the plain list again (an open editor keeps its text).
  function hide() {
    $('setupPane').hidden = true;
    $('toolList').hidden = false;
  }

  SB.toolboxSetup = { owns: k => KINDS.has(k), count, refresh, reload, render, hide };
})();
