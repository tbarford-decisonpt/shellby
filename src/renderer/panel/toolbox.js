/* Shellby panel — Toolbox: everything Claude Code can use, and what Shellby just learned.
   MCP servers can be added, removed, reconnected and turned on or off here (/mcp),
   and your prompt snippets saved, edited and run (/snippets; toolbox-snippets.js).
   Skills, agents and commands show how often they're used and what they cost
   (lean.js usage), can be filtered by where they come from and sorted by use,
   and your own can be edited here or moved to the Recycle Bin (skillremove.js).
   The Hooks, Rules and Memory tabs live in toolbox-setup.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const NEW_FOR_MS = 3 * 24 * 3600 * 1000;
  const PAGE = 150;               // rows drawn at a time: plugins can bring hundreds of skills
  const SEARCH_WAIT_MS = 120;
  const USAGE_RETRY_MS = 30 * 1000;
  let kind = 'skill';
  const listKey = { skill: 'skills', agent: 'agents', command: 'commands', mcp: 'mcp' };
  const LISTED = new Set(['skill', 'agent', 'command']); // the kinds with source and order pickers
  const SEARCH_WHAT = {
    skill: 'skills', agent: 'agents', command: 'commands', mcp: 'MCP servers', snippet: 'snippets',
    hook: 'hooks', rule: 'rules', memory: 'memory files', lean: 'plugins, servers and skills',
  };

  const isNew = t => (state.learned || []).some(l => l.kind === t.kind && l.name === t.name && Date.now() - l.at < NEW_FOR_MS);
  const isPinned = t => (state.pinned || []).some(p => p.kind === t.kind && p.name === t.name);

  // ------------------------------------------------------------ usage and cost

  let usage = null;        // { tools: { 'kind:name': { uses, lastUsed, listTokens, useTokens } }, watchedFrom }
  let usageLoading = null;
  let usageTried = false;  // asked once; after one retry, a failure waits for Rescan
  let usageFailed = false;
  let usageRetried = false;
  let usageRetry = null;
  const removing = new Set();

  function loadUsage(refresh = false) {
    if (usageLoading) return usageLoading;
    usageTried = true;
    clearTimeout(usageRetry);
    usageRetry = null;
    usageLoading = api.leanUsage(refresh)
      .then(r => { usageFailed = !r?.ok; if (r?.ok) usage = r; })
      .catch(() => { usageFailed = true; })
      .finally(() => {
        usageLoading = null;
        if (usageFailed && !usageRetried) {
          usageRetried = true;
          usageRetry = setTimeout(() => loadUsage(), USAGE_RETRY_MS);
        }
        if (state.view === 'toolbox') render();
      });
    return usageLoading;
  }

  const usageOf = t => usage?.tools?.[`${t.kind}:${t.name}`] || null;
  const num = v => (Number.isFinite(v) ? v : 0);

  // ------------------------------------------------------------ where from, and in what order

  // Per kind, so a source that one tab lacks doesn't reset the others: 'all',
  // 'user', 'project', 'cli', 'plugins' or 'plugin:<name>'.
  const sources = { skill: 'all', agent: 'all', command: 'all' };
  let sort = 'name';
  const SOURCE_NAMES = { user: 'Yours', project: 'This project', cli: 'Built in' };

  const fromSource = t => {
    const s = sources[kind] || 'all';
    return s === 'all' || (s === 'plugins' ? (t.source || '').startsWith('plugin:') : t.source === s);
  };

  const byName = (a, b) => a.name.localeCompare(b.name);
  const SORTS = {
    name: (a, b) => (isNew(b) - isNew(a)) || (isPinned(b) - isPinned(a)) || byName(a, b),
    used: (a, b) => (num(usageOf(b)?.uses) - num(usageOf(a)?.uses)) || (num(usageOf(b)?.lastUsed) - num(usageOf(a)?.lastUsed)) || byName(a, b),
    // Never used, the ones costing the most in every conversation first: what's worth a look.
    unused: (a, b) => (!!num(usageOf(a)?.uses) - !!num(usageOf(b)?.uses)) || (num(usageOf(b)?.listTokens) - num(usageOf(a)?.listTokens)) || byName(a, b),
  };

  // The picker lists where this kind's items come from, with counts; rebuilt only when that changes.
  function syncSourcePicker(all) {
    const sel = $('toolSource');
    const counts = new Map();
    for (const t of all) counts.set(t.source, (counts.get(t.source) || 0) + 1);
    const plugins = [...counts.keys()].filter(s => (s || '').startsWith('plugin:')).sort();
    const pluginTotal = plugins.reduce((n, s) => n + counts.get(s), 0);
    const opts = [
      ['all', `All (${all.length})`],
      ...['user', 'project', 'cli'].filter(s => counts.has(s)).map(s => [s, `${SOURCE_NAMES[s]} (${counts.get(s)})`]),
      ...(plugins.length ? [['plugins', `All plugins (${pluginTotal})`]] : []),
    ];
    const pluginOpts = plugins.map(s => [s, `${s.slice(7)} (${counts.get(s)})`]);
    const key = JSON.stringify([opts, pluginOpts]);
    if (sel.dataset.key !== key) {
      sel.replaceChildren(
        ...opts.map(([v, t]) => h('option', { value: v, text: t })),
        pluginOpts.length ? h('optgroup', { label: 'One plugin' }, pluginOpts.map(([v, t]) => h('option', { value: v, text: t }))) : null);
      sel.dataset.key = key;
    }
    // Gone from this tab (its last one removed, a plugin uninstalled): back to all of them.
    if (![...sel.options].some(o => o.value === sources[kind])) sources[kind] = 'all';
    sel.value = sources[kind];
  }

  // A line above the list when the order needs usage that isn't here (yet).
  function sortNote() {
    if (sort === 'name' || usage) return null;
    const text = usageLoading || !usageTried ? 'Counting uses from Claude Code history…'
      : usageRetry ? "Couldn't read usage yet. Trying again shortly; A to Z until then."
        : "Couldn't read usage, so this is A to Z. Rescan to try again.";
    return h('li', { class: 'tool-note', role: 'status', text });
  }

  const tok = n => `~${SB.compact(n)} tokens`;

  function statsLine(t) {
    const u = usage?.tools?.[`${t.kind}:${t.name}`];
    if (!u) return null;
    const parts = [
      u.uses ? `used ${u.uses}× lately` : usage.watchedFrom ? 'not used lately' : null,
      Number.isFinite(u.lastUsed) ? `last ${SB.relTime(u.lastUsed)}` : null,
      u.listTokens ? `${tok(u.listTokens)} in every conversation` : null,
      u.useTokens ? `${tok(u.useTokens)} each use` : null,
    ].filter(Boolean);
    if (!parts.length) return null;
    const text = parts.join(' · ');
    return h('p', { class: `tool-stats${u.uses ? '' : ' unused'}`, text: text[0].toUpperCase() + text.slice(1),
      title: `From the last ${usage.lookbackDays} days or so of this PC's Claude Code history, Shellby and the terminal both. Its name and description are listed for Claude in every conversation; the rest of its file is read only when it's used.` });
  }

  async function removeTool(t) {
    const key = `${t.kind}:${t.name}`;
    if (removing.has(key)) return;
    removing.add(key);
    render();
    let r;
    try { r = await api.removeTool(t.kind, t.name); } catch { r = { ok: false, error: "Shellby couldn't do that." }; }
    removing.delete(key);
    if (r?.ok) {
      if (r.toolbox) state.toolbox = r.toolbox;
      if (toolEd?.path === t.path) toolEd = null;
      state.pinned = (state.pinned || []).filter(p => !(p.kind === t.kind && p.name === t.name));
      SB.refreshEmptyStates();
      SB.toast(`Moved ${t.kind === 'agent' ? t.name : `/${t.name}`} to the Recycle Bin. Restore it from there if you change your mind.`, { ms: 8000 });
    } else if (!r?.cancelled) SB.toast(r?.error || "Couldn't remove that.", { ms: 8000 });
    render();
  }

  // ------------------------------------------------------------ editing your own

  // One open editor, kept while you look at other tabs. Named by its file: saving a
  // new name: in the frontmatter renames the tool but not the file.
  let toolEd = null; // { kind, path, name, original, text, mtimeMs, error, conflict, leaving }
  const NOUN = { skill: 'skill', agent: 'agent', command: 'command' };
  const ownTool = t => LISTED.has(t.kind) && (t.source === 'user' || t.source === 'project') && !!t.path;

  async function openTool(t) {
    let r;
    try { r = await api.readTool(t.kind, t.path); } catch { r = null; }
    if (!r?.ok) { SB.toast(r?.error || "Couldn't open that file.", { ms: 8000 }); return; }
    toolEd = { kind: t.kind, path: t.path, name: t.name, original: r.text, text: r.text, mtimeMs: r.mtimeMs, error: '', conflict: false, leaving: false };
    $('setupPane').dataset.mounted = '';
    render();
    if (kind === t.kind) $('setupPane').querySelector('.mem-text')?.focus();
  }

  function toolEditor(ed) {
    const area = h('textarea', { class: 'field area mono mem-text', spellcheck: 'false', 'aria-label': `Edit ${ed.path}` });
    area.value = ed.text;
    const dirty = () => ed.text !== ed.original;
    const saveable = () => dirty() && !ed.gone;
    const hint = () => ed.error || 'The name and description at the top are what Claude sees in every conversation. Ctrl+S saves.';
    const status = h('p', { class: `setup-status${ed.error ? ' err' : ''}`, role: 'status', text: hint() });
    const save = h('button', { class: 'btn primary slim-btn', type: 'button', disabled: !saveable() }, 'Save');
    const back = h('button', { class: 'back-btn', type: 'button' }, `← ${SEARCH_WHAT[ed.kind][0].toUpperCase()}${SEARCH_WHAT[ed.kind].slice(1)}`);
    const reloadBtn = h('button', { class: 'btn ghost slim-btn', type: 'button', hidden: !ed.conflict, onclick: () => openTool(ed) }, 'Reload');
    const setStatus = (text, err) => { status.textContent = text; status.classList.toggle('err', !!err); };

    async function doSave() {
      if (!saveable() || save.disabled) return;
      save.disabled = true;
      let r;
      try { r = await api.writeTool(ed.kind, ed.path, ed.text, ed.mtimeMs); } catch { r = null; }
      if (r?.ok) {
        if (r.toolbox) state.toolbox = r.toolbox;
        const now = state.toolbox?.[listKey[ed.kind]]?.find(t => t.path === ed.path);
        Object.assign(ed, { original: ed.text, mtimeMs: r.mtimeMs, error: '', conflict: false, name: now?.name || ed.name });
        setStatus(hint());
        SB.toast(`Saved ${ed.kind === 'agent' ? ed.name : `/${ed.name}`}. New conversations use this version.`);
      } else {
        Object.assign(ed, { error: r?.error || "Couldn't save that file.", conflict: !!r?.conflict });
        setStatus(ed.error, true);
        reloadBtn.hidden = !ed.conflict;
      }
      save.disabled = !saveable();
    }

    area.addEventListener('input', () => {
      ed.text = area.value;
      save.disabled = !saveable();
      if (ed.leaving) { ed.leaving = false; back.textContent = back.dataset.label; }
    });
    area.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
    });
    save.addEventListener('click', doSave);
    // Leaving with unsaved text takes a second click, as in Memory.
    back.dataset.label = back.textContent;
    back.addEventListener('click', () => {
      if (dirty() && !ed.leaving) { ed.leaving = true; back.textContent = 'Discard changes?'; return; }
      toolEd = null;
      render();
    });

    return h('div', { class: 'setup-form mem-editor' },
      h('div', { class: 'setup-head' },
        back,
        h('strong', { text: `${ed.kind === 'agent' ? ed.name : `/${ed.name}`}` }),
        h('code', { class: 'mem-path', text: SB.shortPath(ed.path, 46), title: ed.path }),
        h('button', { class: 'icon-btn', type: 'button', title: 'Show file', 'aria-label': 'Show file', onclick: () => api.revealTool(ed.path) },
          SB.icon(SB.ICONS.folder, { width: 1.3 }))),
      area,
      h('div', { class: 'row setup-actions' }, status, reloadBtn, save));
  }

  function sourceLabel(src) {
    if (!src) return '';
    if (src.startsWith('plugin:')) return src.slice(7);
    return { user: 'yours', project: 'this project', cli: 'built in' }[src] || src;
  }

  SB.toolChip = (p) => h('button', {
    class: 'trick-chip', type: 'button', title: p.kind === 'agent' ? `Use the ${p.name} agent` : `/${p.name}`,
    onclick: () => SB.useTool(p),
  }, h('span', { class: `kind-dot k-${p.kind}` }), p.name);

  function toolRow(t) {
    const pinned = isPinned(t);
    const usable = t.kind !== 'mcp';
    return h('li', { class: `tool-row${isNew(t) ? ' is-new' : ''}` },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name' },
          t.kind === 'mcp' ? h('span', { class: `mcp-dot s-${(t.status || 'unknown').replace(/[^\w-]/g, '')}`, title: t.status || '' }) : null,
          h('code', { text: t.kind === 'command' || t.kind === 'skill' ? `/${t.name}` : t.name }),
          isNew(t) ? h('span', { class: 'new-pill', text: 'new' }) : null,
          h('span', { class: 'src-pill', text: t.kind === 'mcp' ? (t.status || '') : sourceLabel(t.source) })),
        t.description ? h('p', { class: 'tool-desc', text: t.description, title: t.description }) : null,
        usable ? statsLine(t) : null),
      h('div', { class: 'tool-actions' },
        t.kind === 'mcp' ? mcpActions(t) : null,
        usable ? h('button', { class: 'btn slim-btn', type: 'button', onclick: () => SB.useTool(t) }, 'Use') : null,
        usable ? h('button', {
          class: `icon-btn pin${pinned ? ' on' : ''}`, type: 'button', title: pinned ? 'Unpin' : 'Pin to the start screen', 'aria-pressed': String(pinned),
          onclick: async () => { state.pinned = await api.pinTool(t.kind, t.name, !pinned); SB.views.toolbox.render(); SB.refreshEmptyStates(); },
        }, h('span', { text: pinned ? '★' : '☆' })) : null,
        t.path ? h('button', { class: 'icon-btn', type: 'button', title: 'Show file', 'aria-label': 'Show file', onclick: () => api.revealTool(t.path) },
          SB.icon(SB.ICONS.folder, { width: 1.3 })) : null,
        ownTool(t) ? h('button', { class: 'icon-btn', type: 'button', title: `Edit this ${NOUN[t.kind]}`, 'aria-label': `Edit ${t.name}`, onclick: () => openTool(t) },
          SB.icon(SB.ICONS.edit, { width: 1.3 })) : null,
        usable && (t.source === 'user' || t.source === 'project') ? h('button', {
          class: 'icon-btn', type: 'button', title: 'Remove (Shellby asks first, and it goes to the Recycle Bin)', 'aria-label': `Remove ${t.name}`,
          disabled: removing.has(`${t.kind}:${t.name}`), onclick: () => removeTool(t),
        }, h('span', { text: '✕' })) : null));
  }

  // ------------------------------------------------------------ MCP servers

  const mcpBusy = new Set();
  let mcpForm = null; // { name, transport, target, scope, env, headers, error } while the Add form is open

  async function mcpCall(name, fn, done) {
    if (mcpBusy.has(name)) return;
    mcpBusy.add(name);
    render();
    let r;
    try { r = await fn(); } catch { r = { ok: false, error: "Shellby couldn't do that." }; }
    mcpBusy.delete(name);
    if (r?.ok) { if (done) SB.toast(done); } else if (!r?.cancelled) SB.toast(r?.error || "Couldn't do that.", { ms: 8000 });
    state.toolbox = await api.getToolbox();
    render();
    return r;
  }

  function mcpActions(t) {
    const tabId = state.activeTab;
    const busy = mcpBusy.has(t.name);
    const off = t.status === 'disabled';
    const broken = /failed|needs-auth|pending/.test(t.status || '');
    return [
      broken || busy ? h('button', { class: 'btn slim-btn', type: 'button', disabled: busy, onclick: () => mcpCall(t.name, () => api.reconnectMcp(tabId, t.name), `Reconnected ${t.name}`) }, busy ? '…' : 'Reconnect') : null,
      h('button', { class: 'btn ghost slim-btn', type: 'button', disabled: busy, title: off ? 'Turn it on for open conversations' : 'Turn it off for open conversations',
        onclick: () => mcpCall(t.name, () => api.toggleMcp(tabId, t.name, off), `${t.name} turned ${off ? 'on' : 'off'}`) }, off ? 'Turn on' : 'Turn off'),
      h('button', { class: 'icon-btn', type: 'button', title: 'Remove this server', 'aria-label': `Remove ${t.name}`, disabled: busy,
        onclick: () => mcpCall(t.name, () => api.removeMcp(state.activeTab, t.name), `Removed ${t.name}. New conversations won't have it.`) }, h('span', { text: '✕' })),
    ];
  }

  function mcpPane() {
    const bar = h('div', { class: 'mcp-bar' },
      h('span', { class: 'muted small', text: 'Servers Claude Code connects to. Statuses come from a running conversation.' }),
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => mcpCall('*', () => api.refreshMcp(state.activeTab), 'Statuses refreshed') }, 'Refresh'),
      h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => { mcpForm = mcpForm ? null : { transport: 'stdio', scope: 'local' }; render(); } }, mcpForm ? 'Close' : 'Add server'));
    if (!mcpForm) return [bar];
    const f = mcpForm;
    const bind = (el, key) => { el.value = f[key] || ''; el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { f[key] = el.value; if (key === 'transport') render(); }); return el; };
    const stdio = (f.transport || 'stdio') === 'stdio';
    const add = async () => {
      const r = await mcpCall(f.name || 'new', () => api.addMcp({ ...f, tabId: state.activeTab }), null);
      if (r?.ok) { mcpForm = null; SB.toast(`Added ${r.name}. ${r.note}`, { ms: 8000 }); render(); } else if (r && !r.cancelled) { f.error = r.error; render(); }
    };
    return [bar, h('div', { class: 'mcp-form' },
      h('div', { class: 'row2' },
        bind(h('input', { class: 'field slim', type: 'text', spellcheck: 'false', placeholder: 'Name, like github', 'aria-label': 'Server name' }), 'name'),
        bind(h('select', { class: 'field slim', 'aria-label': 'How it connects' }, [['stdio', 'Runs a program'], ['http', 'HTTP URL'], ['sse', 'SSE URL']].map(([v, t]) => h('option', { value: v, text: t }))), 'transport'),
        bind(h('select', { class: 'field slim', 'aria-label': 'Who gets it' }, [['local', 'Just me, here'], ['project', 'This project (shared)'], ['user', 'Me, everywhere']].map(([v, t]) => h('option', { value: v, text: t }))), 'scope')),
      bind(h('input', { class: 'field mono slim', type: 'text', spellcheck: 'false', placeholder: stdio ? 'npx -y @modelcontextprotocol/server-github' : 'https://mcp.example.com/mcp', 'aria-label': stdio ? 'Command' : 'URL' }), 'target'),
      bind(h('textarea', { class: 'field', spellcheck: 'false', placeholder: stdio ? 'Environment, one per line: GITHUB_TOKEN=…' : 'Headers, one per line: Authorization: Bearer …', 'aria-label': stdio ? 'Environment variables' : 'Headers' }), stdio ? 'env' : 'headers'),
      h('p', { class: `setup-status${f.error ? ' err' : ''}`, role: 'status', text: f.error || 'Shellby asks you to confirm before Claude Code adds it.' }),
      h('div', {}, h('button', { class: 'btn primary slim-btn', type: 'button', onclick: add }, 'Add it')))];
  }

  function render() {
    const tb = state.toolbox;
    const list = $('toolList');
    const setup = SB.toolboxSetup;
    setup.refresh(); // hooks and memory: rescanned when stale, re-renders when it lands
    // counts
    document.querySelectorAll('#toolTabs [data-kind]').forEach(b => {
      const k = b.dataset.kind;
      b.querySelector('.n').textContent = setup.owns(k) ? setup.count(k) : k === 'lean' ? SB.lean.count() : k === 'snippet' ? (state.snippets || []).length : tb ? tb[listKey[k]].length : '';
      b.setAttribute('aria-selected', String(k === kind));
    });
    // recently learned
    const recent = (state.learned || []).filter(l => Date.now() - l.at < NEW_FOR_MS).slice(0, 6);
    $('learnedBox').hidden = !recent.length;
    $('learnedBox').replaceChildren(
      h('div', { class: 'row-label' }, '✦ Recently learned'),
      h('div', { class: 'pinned-chips' }, recent.map(l => SB.toolChip(l))));
    $('toolboxBadge').hidden = true;

    const search = $('toolSearch');
    const what = SEARCH_WHAT[kind] || 'tools';
    if (search.placeholder !== `Search ${what}…`) { search.placeholder = `Search ${what}…`; search.setAttribute('aria-label', `Search ${what}`); }
    const listed = LISTED.has(kind) && !(toolEd && toolEd.kind === kind);
    $('toolSource').hidden = $('toolSort').hidden = !listed;

    const q = search.value.trim().toLowerCase();
    if (setup.owns(kind)) { $('setupPane').hidden = false; setup.render(kind, q); return; }
    setup.hide();
    if (kind === 'lean') return SB.lean.render(q);
    if (kind === 'snippet') return SB.toolboxSnippets.render(q);
    if (toolEd && toolEd.kind === kind) {
      // Rebuilt only for another file, so a toolbox update can't take the cursor out of it,
      // or once to say the file has gone (your text stays, to copy somewhere).
      const pane = $('setupPane');
      const gone = !!tb && !tb[listKey[kind]].some(t => t.path === toolEd.path);
      if (gone && !toolEd.gone) {
        Object.assign(toolEd, { gone: true, error: 'This file was moved or removed outside Shellby, so it can\'t be saved here. Copy your text if you need it.' });
        pane.dataset.mounted = '';
      }
      const key = `tool:${toolEd.path}`;
      pane.hidden = false;
      list.hidden = true;
      if (pane.dataset.mounted !== key) { pane.replaceChildren(toolEditor(toolEd)); pane.dataset.mounted = key; }
      return;
    }
    if (kind === 'mcp') {
      // Rebuilt only when the form itself changes, so a toolbox update can't
      // take the cursor out of a field you're typing in.
      const key = `mcp:${mcpForm ? `${mcpForm.transport}:${mcpForm.error || ''}` : 'closed'}`;
      $('setupPane').hidden = false;
      if ($('setupPane').dataset.mounted !== key) { $('setupPane').replaceChildren(...mcpPane()); $('setupPane').dataset.mounted = key; }
    }
    if (!tb) { list.replaceChildren(h('li', { class: 'history-empty', text: 'Scanning…' })); return; }
    if (kind !== 'mcp' && !usageTried) loadUsage();
    const all = tb[listKey[kind]];
    if (listed) syncSourcePicker(all);
    const order = listed && usage ? SORTS[sort] : SORTS.name;
    const items = all
      .filter(t => !listed || fromSource(t))
      .filter(t => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
      .sort(order);
    if (!items.length) {
      const hint = q || (listed && sources[kind] !== 'all') ? 'No matches.' : {
        skill: 'No skills yet. Ask Shellby: "build yourself a skill that…"',
        agent: 'No custom agents yet. Ask Shellby to create one in ~/.claude/agents.',
        command: 'No custom slash commands yet.',
        mcp: 'No MCP servers connected.',
      }[kind];
      list.replaceChildren(h('li', { class: 'history-empty', text: hint }));
      return;
    }
    list.replaceChildren(...[listed ? sortNote() : null, ...page(items)].filter(Boolean));
  }

  // The first PAGE rows, then a line saying how many more there are.
  let shown = PAGE;
  let shownFor = '';
  function page(items) {
    const forKey = `${kind}|${$('toolSearch').value.trim().toLowerCase()}|${sources[kind] || ''}|${sort}`;
    if (forKey !== shownFor) { shown = PAGE; shownFor = forKey; }
    const rows = items.slice(0, shown).map(toolRow);
    if (items.length <= shown) return rows;
    const more = n => () => {
      const first = shown;
      shown = n;
      render();
      // Carry on from the first new row rather than dropping the keyboard at the top.
      $('toolList').querySelectorAll('.tool-row')[first]?.querySelector('button')?.focus();
    };
    return [...rows, h('li', { class: 'tool-more', role: 'status' },
      `Showing ${shown} of ${items.length}.`,
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: more(shown + PAGE) }, `Show ${Math.min(PAGE, items.length - shown)} more`),
      items.length - shown > PAGE ? h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: more(items.length) }, 'Show all') : null)];
  }

  let searchWait = null;
  document.querySelectorAll('#toolTabs [data-kind]').forEach(b => b.addEventListener('click', () => { clearTimeout(searchWait); kind = b.dataset.kind; render(); }));
  $('toolSearch').addEventListener('input', () => {
    clearTimeout(searchWait);
    searchWait = setTimeout(() => { if (state.view === 'toolbox') render(); }, SEARCH_WAIT_MS);
  });
  $('toolSource').addEventListener('change', e => { sources[kind] = e.target.value; render(); });
  $('toolSort').addEventListener('change', e => {
    sort = e.target.value;
    if (sort !== 'name' && !usage && !usageLoading) { usageRetried = false; loadUsage(); }
    render();
  });
  $('rescanBtn').addEventListener('click', async () => {
    [state.toolbox] = await Promise.all([api.rescanToolbox(), SB.toolboxSetup.reload()]);
    usageRetried = false;
    loadUsage(true);
    render();
    SB.toast('Toolbox rescanned');
  });

  SB.onLearned = (trick) => {
    state.learned = [{ ...trick, at: Date.now() }, ...(state.learned || []).filter(l => !(l.kind === trick.kind && l.name === trick.name))];
    const noun = { skill: 'skill', agent: 'helper agent', command: 'command' }[trick.kind] || 'trick';
    if (state.view === 'toolbox') render();
    else $('toolboxBadge').hidden = false;
    SB.toast(`✦ Shellby learned a new ${noun}: ${trick.name}`, { action: 'Pin it', onAction: async () => {
      state.pinned = await api.pinTool(trick.kind, trick.name, true);
      SB.refreshEmptyStates();
      SB.toast(`Pinned ${trick.name}`);
    } });
  };

  // /permissions, /mcp: straight to that tab.
  SB.showToolbox = (k) => {
    kind = k;
    SB.setView('toolbox');
    render();
  };

  SB.views.toolbox = { render };
})();
