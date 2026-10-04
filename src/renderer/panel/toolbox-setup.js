/* Shellby panel — Toolbox → Hooks, Rules and Memory: the hooks in Claude Code's
   settings (drawn by toolbox-hooks.js), its allow / ask / deny permission rules
   (/permissions in the terminal), and the CLAUDE.md files that load for this
   folder, each with a small editor. The main process re-checks every write, and
   hook changes ask in the confirm window. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const STALE_MS = 5000;
  const KINDS = new Set(['hook', 'rule', 'memory']);
  let loading = null;
  let lastTry = 0;
  // One open editor per tab, so opening one never throws away the other's unsaved text.
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
    if (k === 'rule') return s.permissions?.rules.length || 0;
    return k === 'hook' ? s.hooks.length + (s.paused?.length || 0) : s.memory.filter(m => m.exists).length;
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
    SB.prefillNew(skill ? `/${skill.name} ${ask} ` : `${ask} `);
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

  // ================================================================ permission rules

  const LISTS = {
    allow: { label: 'Allow', sub: 'runs without asking' },
    ask: { label: 'Ask', sub: 'always asks first' },
    deny: { label: 'Deny', sub: 'never runs' },
  };
  let ruleDraft = { scope: null, list: 'allow', rule: '', error: '' };
  // Which rules are opened up, so a rescan or a removal doesn't fold them all shut.
  const openRules = new Set();
  const ruleKey = r => `${r.scope}\n${r.list}\n${r.rule}`;

  async function removeRule(r) {
    const res = await call(() => api.removeRule(r.scope, r.list, r.rule));
    if (res.ok) { openRules.delete(ruleKey(r)); SB.toast('Rule removed'); }
    else if (!res.cancelled) SB.toast(res.error || "Couldn't remove that rule");
    rerender();
  }

  // One line that opens to the whole rule, what it does, and where it's saved.
  function ruleRow(r) {
    const key = ruleKey(r);
    const row = h('details', { class: 'rule-row', open: openRules.has(key) },
      h('summary', { class: 'rule-sum', title: 'Show the whole rule' },
        h('span', { class: `rule-pill l-${r.list}`, text: r.list, title: LISTS[r.list].sub }),
        h('code', { text: r.rule }),
        h('span', { class: 'src-pill', text: SOURCE[r.scope] || r.scope }),
        h('button', {
          class: 'icon-btn danger-hover', type: 'button', title: 'Remove this rule', 'aria-label': `Remove the rule ${r.rule}`,
          // A click inside the summary would also open the row; this button only removes.
          onclick: e => { e.preventDefault(); e.stopPropagation(); removeRule(r); },
        }, h('span', { text: '✕' }))),
      h('div', { class: 'rule-detail' },
        h('pre', { class: 'rule-full', text: r.rule }),
        h('p', { class: 'rule-what', text: r.what || `${LISTS[r.list].label}: ${LISTS[r.list].sub}.` }),
        h('p', { class: 'muted small' }, 'Saved in ', h('code', { text: SB.tildify(r.path), title: r.path })),
        h('div', { class: 'row rule-actions' },
          h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => api.revealSetupFile(r.path) }, 'Show file'),
          h('button', { class: 'btn danger slim-btn', type: 'button', onclick: () => removeRule(r) }, 'Remove rule'))));
    row.addEventListener('toggle', () => { if (row.open) openRules.add(key); else openRules.delete(key); });
    return h('li', {}, row);
  }

  function ruleForm() {
    const s = state.setup;
    const scopes = s.permissions.files.filter(f => f.state !== 'unreadable').map(f => f.scope);
    const d = ruleDraft;
    if (!scopes.includes(d.scope)) d.scope = scopes.includes('local') ? 'local' : scopes[0];
    const list = h('select', { class: 'field slim', 'aria-label': 'Kind of rule' }, Object.entries(LISTS).map(([k, v]) => h('option', { value: k, text: v.label })));
    list.value = d.list;
    list.addEventListener('change', () => { d.list = list.value; });
    const where = h('select', { class: 'field slim', 'aria-label': 'Where it is saved' }, scopes.map(k => h('option', { value: k, text: WHERE[k] })));
    where.value = d.scope;
    where.addEventListener('change', () => { d.scope = where.value; });
    const rule = h('input', { class: 'field mono slim', type: 'text', spellcheck: 'false', placeholder: 'Bash(npm run test:*)  ·  Edit(src/**)  ·  WebFetch(domain:github.com)', 'aria-label': 'Rule' });
    rule.value = d.rule;
    rule.addEventListener('input', () => { d.rule = rule.value; });
    const status = h('p', { class: `setup-status${d.error ? ' err' : ''}`, role: 'status', text: d.error });
    const add = async () => {
      const r = await call(() => api.saveRule(d.scope, d.list, d.rule));
      if (r.ok) { ruleDraft = { scope: d.scope, list: d.list, rule: '', error: '' }; SB.toast('Rule saved. New conversations follow it.'); }
      else if (!r.cancelled) d.error = r.error || "Couldn't save that rule.";
      rerender();
    };
    rule.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return h('div', {},
      h('div', { class: 'rule-form' }, list, where, rule, h('button', { class: 'btn primary slim-btn', type: 'button', onclick: add }, 'Add')),
      status);
  }

  function renderRules(q) {
    const s = state.setup;
    const pane = $('setupPane');
    const list = $('toolList');
    pane.hidden = false;
    list.hidden = false;
    pane.dataset.mounted = 'rule';
    const modes = s.permissions.files.filter(f => f.defaultMode).map(f => `${WHERE[f.scope]}: starts in ${f.defaultMode}`);
    pane.replaceChildren(
      h('div', { class: 'setup-intro' },
        h('p', { text: 'Rules Claude Code follows before your permission mode: deny wins, then ask, then allow. Adding an allow rule, or taking away an ask or deny, asks you first.' }),
        modes.length ? h('p', { class: 'muted small', text: modes.join(' · ') }) : null),
      ruleForm());
    const rows = (s.permissions.rules || []).filter(r => !q || [r.rule, r.list, r.what || ''].some(v => v.toLowerCase().includes(q)));
    const order = { deny: 0, ask: 1, allow: 2 };
    rows.sort((a, b) => order[a.list] - order[b.list] || a.rule.localeCompare(b.rule));
    list.replaceChildren(...(rows.length ? [h('li', {}, h('ul', { class: 'rule-list' }, rows.map(ruleRow)))]
      : [h('li', { class: 'history-empty', text: q ? 'No matches.' : 'No rules yet. Claude asks according to your permission mode.' })]));
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
    if (kind === 'hook') SB.toolboxHooks.render(q);
    else if (kind === 'rule') renderRules(q);
    else renderMemory(q);
  }

  // Leaving the Hooks/Memory tabs: show the plain list again (an open editor keeps its text).
  function hide() {
    $('setupPane').hidden = true;
    $('toolList').hidden = false;
  }

  SB.toolboxSetup = { owns: k => KINDS.has(k), count, refresh, reload, render, hide };
  // What toolbox-hooks.js shares with the other tabs.
  SB.setupKit = { call, rerender, sourceLabel, WHERE };
})();
