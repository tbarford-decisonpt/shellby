/* Shellby panel — Toolbox: everything Claude Code can use, and what Shellby just learned.
   Two rows of tabs: a section (Tools, Setup, Lean, Team), then the kinds in it.
   Skills, agents and commands list together under All, or one kind at a time.
   MCP servers can be added, removed, reconnected and turned on or off here (/mcp),
   and your prompt snippets saved, edited and run (/snippets; toolbox-snippets.js).
   Skills, agents and commands show how often they're used and what they cost
   (lean.js usage), can be filtered by where they come from and sorted by use,
   and open up to show the rest: where they live, edit, remove (skillremove.js).
   The Hooks, Rules and Memory tabs live in toolbox-setup.js, and Team (the
   repo's .shellby/team.json) in toolbox-team.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const NEW_FOR_MS = 3 * 24 * 3600 * 1000;
  const PAGE = 150;               // rows drawn at a time: plugins can bring hundreds of skills
  const SEARCH_WAIT_MS = 120;
  const USAGE_RETRY_MS = 30 * 1000;
  const MIN_BAR_PCT = 3;          // a cost bar never shrinks to nothing, so every row has one to compare
  const listKey = { skill: 'skills', agent: 'agents', command: 'commands', mcp: 'mcp' };
  const MERGED = ['skill', 'agent', 'command'];   // listed together under All ('tool')
  const LISTED = new Set(['tool', ...MERGED]);     // the kinds with source and order pickers
  // Which section each kind sits in, and the kind a section opens on (the one you left it on).
  const GROUP = {
    tool: 'tools', skill: 'tools', agent: 'tools', command: 'tools', mcp: 'tools', snippet: 'tools',
    hook: 'setup', rule: 'setup', memory: 'setup', lean: 'lean', team: 'team',
  };
  const lastKind = { tools: 'tool', setup: 'hook', lean: 'lean', team: 'team' };
  const ALIAS = { permissions: 'rule' }; // /permissions in the composer
  let kind = 'tool';
  const SEARCH_WHAT = {
    tool: 'skills, agents and commands', skill: 'skills', agent: 'agents', command: 'commands', mcp: 'MCP servers', snippet: 'snippets',
    hook: 'hooks', rule: 'rules', memory: 'memory files', lean: 'plugins, servers and skills', team: 'the team pack',
  };
  const LIST_NAME = { tool: 'All tools', skill: 'Skills', agent: 'Agents', command: 'Commands' };
  const STAR = 'M8 2.3l1.75 3.6 3.95.55-2.86 2.77.68 3.93L8 11.3l-3.52 1.85.68-3.93L2.3 6.45l3.95-.55z';

  const isNew = t => (state.learned || []).some(l => l.kind === t.kind && l.name === t.name && Date.now() - l.at < NEW_FOR_MS);
  const isPinned = t => (state.pinned || []).some(p => p.kind === t.kind && p.name === t.name);
  const itemsOf = (tb, k) => (k === 'tool' ? MERGED.flatMap(m => tb[listKey[m]] || []) : tb[listKey[k]] || []);
  const shown = t => (t.kind === 'command' || t.kind === 'skill' ? `/${t.name}` : t.name);

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
  // Listed in every conversation and not once used lately: what a cleanup is after.
  const isIdle = u => !!u && !u.uses && !!usage?.watchedFrom;

  // ------------------------------------------------------------ where from, and in what order

  // Per kind, so a source that one tab lacks doesn't reset the others: 'all',
  // 'user', 'project', 'cli', 'plugins' or 'plugin:<name>'.
  const sources = { tool: 'all', skill: 'all', agent: 'all', command: 'all' };
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
    const u = usageOf(t);
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

  // What it costs every conversation, as a bar against the costliest one listed, and how often
  // it's earned that. Amber when it costs something and hasn't been used lately.
  let maxList = 0;
  function meter(u) {
    if (!u) return null;
    const idle = isIdle(u);
    const fill = h('i');
    const pct = maxList ? (100 * num(u.listTokens)) / maxList : 0;
    fill.style.setProperty('--w', `${Math.max(MIN_BAR_PCT, Math.round(pct))}%`);
    return h('span', { class: `tool-meter${idle ? ' idle' : ''}` },
      h('span', { class: 'cost-bar', 'aria-hidden': 'true' }, fill),
      u.listTokens ? h('span', { text: tok(u.listTokens) }) : null,
      h('span', { class: 'meter-uses', text: u.uses ? `${u.uses} ${u.uses === 1 ? 'use' : 'uses'} lately` : idle ? 'not used lately' : '' }));
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
      openRows.delete(key);
      state.pinned = (state.pinned || []).filter(p => !(p.kind === t.kind && p.name === t.name));
      SB.refreshEmptyStates();
      SB.toast(`Moved ${t.kind === 'agent' ? t.name : `/${t.name}`} to the Recycle Bin. Restore it from there if you change your mind.`, { ms: 8000 });
    } else if (!r?.cancelled) SB.toast(r?.error || "Couldn't remove that.", { ms: 8000 });
    render();
  }

  // ------------------------------------------------------------ editing your own

  // One open editor, kept while you look at other tabs. Named by its file: saving a
  // new name: in the frontmatter renames the tool but not the file. It belongs to
  // the list it was opened from (view), which may be All rather than its own kind.
  let toolEd = null; // { kind, view, path, name, original, text, mtimeMs, error, conflict, leaving }
  const NOUN = { skill: 'skill', agent: 'agent', command: 'command' };
  const ownTool = t => MERGED.includes(t.kind) && (t.source === 'user' || t.source === 'project') && !!t.path;

  async function openTool(t, view = kind) {
    // Another file open with unsaved changes: back to it, rather than losing them.
    if (toolEd && toolEd.path !== t.path && toolEd.text !== toolEd.original) {
      SB.toast(`Save or discard your changes to ${toolEd.kind === 'agent' ? toolEd.name : `/${toolEd.name}`} first.`, { ms: 6000 });
      choose(toolEd.view);
      return;
    }
    let r;
    try { r = await api.readTool(t.kind, t.path); } catch { r = null; }
    if (!r?.ok) { SB.toast(r?.error || "Couldn't open that file.", { ms: 8000 }); return; }
    toolEd = { kind: t.kind, view, path: t.path, name: t.name, original: r.text, text: r.text, mtimeMs: r.mtimeMs, error: '', conflict: false, leaving: false };
    $('setupPane').dataset.mounted = '';
    render();
    if (kind === view) $('setupPane').querySelector('.mem-text')?.focus();
  }

  function toolEditor(ed) {
    const area = h('textarea', { class: 'field area mono mem-text', spellcheck: 'false', 'aria-label': `Edit ${ed.path}` });
    area.value = ed.text;
    const dirty = () => ed.text !== ed.original;
    const saveable = () => dirty() && !ed.gone;
    const hint = () => ed.error || 'The name and description at the top are what Claude sees in every conversation. Ctrl+S saves.';
    const status = h('p', { class: `setup-status${ed.error ? ' err' : ''}`, role: 'status', text: hint() });
    const save = h('button', { class: 'btn primary slim-btn', type: 'button', disabled: !saveable() }, 'Save');
    const back = h('button', { class: 'back-btn', type: 'button' }, `← ${LIST_NAME[ed.view]}`);
    const reloadBtn = h('button', { class: 'btn ghost slim-btn', type: 'button', hidden: !ed.conflict, onclick: () => openTool(ed, ed.view) }, 'Reload');
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
      focusRow(`${ed.kind}:${ed.name}`, '.tool-toggle');
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

  // ------------------------------------------------------------ a row, and what it opens to

  const openRows = new Set(); // 'kind:name' of the rows showing their details
  let rowSeq = 0;

  const WHERE_FROM = {
    user: 'Yours: it\'s in your own Claude folder, so every project has it.',
    project: 'This project\'s: it\'s in the repo, so anyone working here has it too.',
    cli: 'Built into Claude Code.',
  };
  const MCP_SAYS = {
    connected: 'Connected.',
    failed: 'Couldn\'t connect. Reconnect to try again.',
    'needs-auth': 'Waiting for you to sign in. Reconnect to start that.',
    pending: 'Still connecting.',
    disabled: 'Turned off for open conversations.',
  };
  function whereFrom(t) {
    if (t.kind === 'mcp') return MCP_SAYS[t.status] || null;
    if ((t.source || '').startsWith('plugin:')) return `Comes with the ${t.source.slice(7)} plugin. Turn it off or remove it in Get more.`;
    return WHERE_FROM[t.source] || null;
  }

  const actBtn = (icon, label, attrs) => h('button', { class: 'btn ghost slim-btn tool-act', type: 'button', ...attrs },
    SB.icon(icon, { width: 1.4 }), label);

  function toolDetail(t, id) {
    const own = MERGED.includes(t.kind) && (t.source === 'user' || t.source === 'project');
    const acts = t.kind === 'mcp'
      ? [actBtn(SB.ICONS.trash, 'Remove', { class: 'btn ghost slim-btn tool-act danger-hover', 'aria-label': `Remove ${t.name}`, disabled: mcpBusy.has(t.name),
        onclick: () => mcpCall(t.name, () => api.removeMcp(state.activeTab, t.name), `Removed ${t.name}. New conversations won't have it.`) })]
      : [
        t.path ? actBtn(SB.ICONS.folder, 'Show file', { onclick: () => api.revealTool(t.path) }) : null,
        ownTool(t) ? actBtn(SB.ICONS.edit, 'Edit', { 'aria-label': `Edit ${t.name}`, onclick: () => openTool(t) }) : null,
        own ? actBtn(SB.ICONS.trash, 'Remove', { class: 'btn ghost slim-btn tool-act danger-hover', 'aria-label': `Remove ${t.name}`,
          title: 'Shellby asks first, and it goes to the Recycle Bin', disabled: removing.has(`${t.kind}:${t.name}`), onclick: () => removeTool(t) }) : null,
      ].filter(Boolean);
    const where = whereFrom(t);
    return h('div', { class: 'tool-detail', id },
      where ? h('p', { class: 'tool-where', text: where }) : null,
      t.kind === 'mcp' ? null : statsLine(t),
      t.path ? h('code', { class: 'tool-path', text: SB.shortPath(t.path, 64), title: t.path }) : null,
      acts.length ? h('div', { class: 'tool-detail-actions' }, acts) : null);
  }

  // What stays in reach with the row closed: Use and the pin, or a server's switches.
  function quickActions(t) {
    if (t.kind === 'mcp') return mcpActions(t);
    const pinned = isPinned(t);
    return [
      h('button', { class: 'btn slim-btn', type: 'button', 'aria-label': `Use ${t.name}`, onclick: () => SB.useTool(t) }, 'Use'),
      h('button', {
        class: `icon-btn pin${pinned ? ' on' : ''}`, type: 'button', title: pinned ? 'Unpin from the start screen' : 'Pin to the start screen',
        'aria-label': `Pin ${t.name}`, 'aria-pressed': String(pinned),
        onclick: async () => {
          state.pinned = await api.pinTool(t.kind, t.name, !pinned);
          render();
          focusRow(`${t.kind}:${t.name}`, '.pin');
          SB.refreshEmptyStates();
        },
      }, SB.icon(STAR, { width: 1.3 })),
    ];
  }

  // After a redraw, put the keyboard back on the same row's button.
  function focusRow(key, sel) {
    const li = [...$('toolList').querySelectorAll('.tool-item')].find(r => r.dataset.key === key);
    li?.querySelector(sel)?.focus({ preventScroll: true });
  }

  function toolRow(t) {
    const key = `${t.kind}:${t.name}`;
    const open = openRows.has(key);
    const u = t.kind === 'mcp' ? null : usageOf(t);
    const id = `tool-detail-${++rowSeq}`;
    const li = h('li', { class: `tool-row tool-item${isNew(t) ? ' is-new' : ''}${isIdle(u) ? ' is-unused' : ''}${open ? ' is-open' : ''}`, dataset: { key } });
    const toggle = h('button', {
      class: 'tool-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': open ? id : null,
      onclick: () => toggleRow(li, t),
    },
    h('span', { class: 'tool-name' },
      t.kind === 'mcp' ? h('span', { class: `mcp-dot s-${(t.status || 'unknown').replace(/[^\w-]/g, '')}`, title: t.status || '' })
        : kind === 'tool' ? h('span', { class: `kind-dot k-${t.kind}`, role: 'img', 'aria-label': NOUN[t.kind], title: NOUN[t.kind] }) : null,
      h('code', { text: shown(t) }),
      isNew(t) ? h('span', { class: 'new-pill', text: 'new' }) : null,
      h('span', { class: 'src-pill', text: t.kind === 'mcp' ? (t.status || '') : sourceLabel(t.source) })),
    t.description ? h('span', { class: 'tool-desc', text: t.description }) : null,
    meter(u));
    li.append(h('div', { class: 'tool-head' }, toggle, h('div', { class: 'tool-actions' }, quickActions(t))));
    if (open) li.append(toolDetail(t, id));
    return li;
  }

  // Open or close in place, so the list keeps its scroll and the keyboard stays on the row.
  function toggleRow(li, t) {
    const key = `${t.kind}:${t.name}`;
    if (!openRows.delete(key)) openRows.add(key);
    const next = toolRow(t);
    li.replaceWith(next);
    next.querySelector('.tool-toggle').focus();
  }

  // ------------------------------------------------------------ grouped by where they come from

  // When the list is everything in A to Z order, it's grouped by where each one comes
  // from. Plugins can bring hundreds, so theirs start folded; yours and the project's open.
  const folded = new Map(); // source → folded, for the groups you've opened or closed
  // (Picking "All plugins" means you came to see them, so they start open there.)
  const isFolded = src => folded.get(src) ?? (src.startsWith('plugin:') && sources[kind] !== 'plugins');
  const groupRank = s => ({ user: 0, project: 1, cli: 2 }[s] ?? 3);
  const groupName = s => (s.startsWith('plugin:') ? s.slice(7) : SOURCE_NAMES[s] || 'Other');

  function grouped(items, q) {
    const s = sources[kind];
    if (q || sort !== 'name' || (s !== 'all' && s !== 'plugins')) return items;
    const srcOf = t => t.source || '';
    const counts = new Map();
    for (const t of items) counts.set(srcOf(t), (counts.get(srcOf(t)) || 0) + 1);
    if (counts.size < 2) return items;
    const order = [...counts.keys()].sort((a, b) => (groupRank(a) - groupRank(b)) || groupName(a).localeCompare(groupName(b)));
    return order.flatMap(src => [{ head: true, src, count: counts.get(src) }, ...(isFolded(src) ? [] : items.filter(t => srcOf(t) === src))]);
  }

  function groupHead({ src, count }) {
    const open = !isFolded(src);
    return h('li', { class: 'tool-group' },
      h('button', {
        class: 'tool-group-btn', type: 'button', 'aria-expanded': String(open), dataset: { src },
        onclick: () => {
          folded.set(src, open);
          render();
          [...$('toolList').querySelectorAll('.tool-group-btn')].find(b => b.dataset.src === src)?.focus();
        },
      },
      h('span', { text: groupName(src) }),
      src.startsWith('plugin:') ? h('span', { class: 'tool-group-kind', text: 'plugin' }) : null,
      h('span', { class: 'tool-group-n', text: String(count) })));
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

  // ------------------------------------------------------------ the tabs, and drawing it all

  function countOf(k) {
    const setup = SB.toolboxSetup;
    if (setup.owns(k)) return setup.count(k);
    if (k === 'lean') return SB.lean.count();
    if (k === 'team') return SB.toolboxTeam.count();
    if (k === 'snippet') return (state.snippets || []).length;
    return state.toolbox ? itemsOf(state.toolbox, k).length : '';
  }

  // The section row, then only that section's kinds below it (none for Lean and Team).
  function syncTabs() {
    const group = GROUP[kind];
    document.querySelectorAll('#toolGroups [data-group]').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.group === group));
      const n = b.querySelector('.n');
      if (n) n.textContent = countOf(b.dataset.group);
    });
    document.querySelectorAll('#toolTabs [data-kind]').forEach(b => {
      const k = b.dataset.kind;
      b.hidden = GROUP[k] !== group;
      b.querySelector('.n').textContent = countOf(k);
      b.setAttribute('aria-selected', String(k === kind));
    });
    $('toolTabs').hidden = group === 'lean' || group === 'team';
  }

  function render() {
    const tb = state.toolbox;
    const list = $('toolList');
    const setup = SB.toolboxSetup;
    setup.refresh(); // hooks and memory: rescanned when stale, re-renders when it lands
    syncTabs();
    $('toolboxBadge').hidden = true;

    const search = $('toolSearch');
    const what = SEARCH_WHAT[kind] || 'tools';
    if (search.placeholder !== `Search ${what}…`) { search.placeholder = `Search ${what}…`; search.setAttribute('aria-label', `Search ${what}`); }
    const listed = LISTED.has(kind) && !(toolEd && toolEd.view === kind);
    $('toolSource').hidden = $('toolSort').hidden = !listed;

    const q = search.value.trim().toLowerCase();
    if (setup.owns(kind)) { $('setupPane').hidden = false; setup.render(kind, q); return; }
    setup.hide();
    if (kind === 'lean') return SB.lean.render(q);
    if (kind === 'snippet') return SB.toolboxSnippets.render(q);
    if (kind === 'team') return SB.toolboxTeam.render(q);
    if (toolEd && toolEd.view === kind) {
      // Rebuilt only for another file, so a toolbox update can't take the cursor out of it,
      // or once to say the file has gone (your text stays, to copy somewhere).
      const pane = $('setupPane');
      const gone = !!tb && !itemsOf(tb, toolEd.kind).some(t => t.path === toolEd.path);
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
    const all = itemsOf(tb, kind);
    if (listed) syncSourcePicker(all);
    const order = listed && usage ? SORTS[sort] : SORTS.name;
    const items = all
      .filter(t => !listed || fromSource(t))
      .filter(t => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
      .sort(order);
    if (!items.length) {
      const hint = q || (listed && sources[kind] !== 'all') ? 'No matches.' : {
        tool: 'No skills, agents or commands yet. Ask Shellby: "build yourself a skill that…"',
        skill: 'No skills yet. Ask Shellby: "build yourself a skill that…"',
        agent: 'No custom agents yet. Ask Shellby to create one in ~/.claude/agents.',
        command: 'No custom slash commands yet.',
        mcp: 'No MCP servers connected.',
      }[kind];
      list.replaceChildren(h('li', { class: 'history-empty', text: hint }));
      return;
    }
    maxList = items.reduce((m, t) => Math.max(m, num(usageOf(t)?.listTokens)), 0);
    list.replaceChildren(...[listed ? sortNote() : null, ...page(grouped(items, q))].filter(Boolean));
  }

  // The first PAGE rows, then a line saying how many more there are. Headings don't count,
  // and a folded group's heading always shows: it has no rows to wait for.
  let shownRows = PAGE;
  let shownFor = '';
  function page(entries) {
    const forKey = `${kind}|${$('toolSearch').value.trim().toLowerCase()}|${sources[kind] || ''}|${sort}`;
    if (forKey !== shownFor) { shownRows = PAGE; shownFor = forKey; }
    const total = entries.reduce((n, e) => n + (e.head ? 0 : 1), 0);
    const out = [];
    let n = 0;
    for (const e of entries) {
      if (e.head) { if (n < shownRows || total <= shownRows || isFolded(e.src)) out.push(groupHead(e)); }
      else if (n < shownRows) { out.push(toolRow(e)); n++; }
    }
    if (total <= shownRows) return out;
    const more = to => () => {
      const first = shownRows;
      shownRows = to;
      render();
      // Carry on from the first new row rather than dropping the keyboard at the top.
      $('toolList').querySelectorAll('.tool-row')[first]?.querySelector('button')?.focus();
    };
    return [...out, h('li', { class: 'tool-more', role: 'status' },
      `Showing ${shownRows} of ${total}.`,
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: more(shownRows + PAGE) }, `Show ${Math.min(PAGE, total - shownRows)} more`),
      total - shownRows > PAGE ? h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: more(total) }, 'Show all') : null)];
  }

  let searchWait = null;
  function choose(k) {
    clearTimeout(searchWait);
    kind = GROUP[ALIAS[k] || k] ? ALIAS[k] || k : 'tool';
    lastKind[GROUP[kind]] = kind;
    render();
  }
  document.querySelectorAll('#toolGroups [data-group]').forEach(b => b.addEventListener('click', () => choose(lastKind[b.dataset.group])));
  document.querySelectorAll('#toolTabs [data-kind]').forEach(b => b.addEventListener('click', () => choose(b.dataset.kind)));
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
    [state.toolbox] = await Promise.all([api.rescanToolbox(), SB.toolboxSetup.reload(), SB.toolboxTeam.refresh()]);
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
    SB.setView('toolbox');
    choose(k);
  };

  SB.views.toolbox = { render };
})();
