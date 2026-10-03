/* Shellby panel — Toolbox: everything Claude Code can use, and what Shellby just learned.
   MCP servers can be added, removed, reconnected and turned on or off here (/mcp).
   The Hooks, Rules and Memory tabs live in toolbox-setup.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const NEW_FOR_MS = 3 * 24 * 3600 * 1000;
  let kind = 'skill';
  const listKey = { skill: 'skills', agent: 'agents', command: 'commands', mcp: 'mcp' };

  const isNew = t => (state.learned || []).some(l => l.kind === t.kind && l.name === t.name && Date.now() - l.at < NEW_FOR_MS);
  const isPinned = t => (state.pinned || []).some(p => p.kind === t.kind && p.name === t.name);

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
        t.description ? h('p', { class: 'tool-desc', text: t.description, title: t.description }) : null),
      h('div', { class: 'tool-actions' },
        t.kind === 'mcp' ? mcpActions(t) : null,
        usable ? h('button', { class: 'btn slim-btn', type: 'button', onclick: () => SB.useTool(t) }, 'Use') : null,
        usable ? h('button', {
          class: `icon-btn pin${pinned ? ' on' : ''}`, type: 'button', title: pinned ? 'Unpin' : 'Pin to the start screen', 'aria-pressed': String(pinned),
          onclick: async () => { state.pinned = await api.pinTool(t.kind, t.name, !pinned); SB.views.toolbox.render(); SB.refreshEmptyStates(); },
        }, h('span', { text: pinned ? '★' : '☆' })) : null,
        t.path ? h('button', { class: 'icon-btn', type: 'button', title: 'Show file', 'aria-label': 'Show file', onclick: () => api.revealTool(t.path) },
          SB.icon(SB.ICONS.folder, { width: 1.3 })) : null));
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
      b.querySelector('.n').textContent = setup.owns(k) ? setup.count(k) : tb ? tb[listKey[k]].length : '';
      b.setAttribute('aria-selected', String(k === kind));
    });
    // recently learned
    const recent = (state.learned || []).filter(l => Date.now() - l.at < NEW_FOR_MS).slice(0, 6);
    $('learnedBox').hidden = !recent.length;
    $('learnedBox').replaceChildren(
      h('div', { class: 'row-label' }, '✦ Recently learned'),
      h('div', { class: 'pinned-chips' }, recent.map(l => SB.toolChip(l))));
    $('toolboxBadge').hidden = true;

    const q = $('toolSearch').value.trim().toLowerCase();
    if (setup.owns(kind)) { $('setupPane').hidden = false; setup.render(kind, q); return; }
    setup.hide();
    if (kind === 'mcp') {
      // Rebuilt only when the form itself changes, so a toolbox update can't
      // take the cursor out of a field you're typing in.
      const key = `mcp:${mcpForm ? `${mcpForm.transport}:${mcpForm.error || ''}` : 'closed'}`;
      $('setupPane').hidden = false;
      if ($('setupPane').dataset.mounted !== key) { $('setupPane').replaceChildren(...mcpPane()); $('setupPane').dataset.mounted = key; }
    }
    if (!tb) { list.replaceChildren(h('li', { class: 'history-empty', text: 'Scanning…' })); return; }
    const items = tb[listKey[kind]]
      .filter(t => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
      .sort((a, b) => (isNew(b) - isNew(a)) || (isPinned(b) - isPinned(a)) || a.name.localeCompare(b.name));
    if (!items.length) {
      const hint = q ? 'No matches.' : {
        skill: 'No skills yet. Ask Shellby: "build yourself a skill that…"',
        agent: 'No custom agents yet. Ask Shellby to create one in ~/.claude/agents.',
        command: 'No custom slash commands yet.',
        mcp: 'No MCP servers connected.',
      }[kind];
      list.replaceChildren(h('li', { class: 'history-empty', text: hint }));
      return;
    }
    list.replaceChildren(...items.slice(0, 300).map(toolRow));
  }

  document.querySelectorAll('#toolTabs [data-kind]').forEach(b => b.addEventListener('click', () => { kind = b.dataset.kind; render(); }));
  $('toolSearch').addEventListener('input', render);
  $('rescanBtn').addEventListener('click', async () => {
    [state.toolbox] = await Promise.all([api.rescanToolbox(), SB.toolboxSetup.reload()]);
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
