/* Shellby panel — tools beside the chat: a pane that shows something other
   than a conversation (shared/panes.js says which tab ids are tools). The one
   kind so far is a dev server's log ('server:srv-…'), opened from its card on
   the Project page: the log as it grows, the server's state, Restart, Stop and
   Open, and, once it has crashed, the way to its card, where the approval
   sheet is still the only way its error goes to Claude (projects-servers.js).
   tab-panes.js asks here for a tool's element and title; a tool isn't in
   state.tabs and the box never goes to its pane. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const P = SB.panes;
  const L = window.ShellbyProjectsLogic;
  const LOG_REFRESH_MS = 1500; // a running server's log is read again this often while its pane is open

  const mounted = new Map(); // toolId -> { el, title, draw, destroy }
  let servers = [];

  const serverOf = toolId => servers.find(s => s.id === P.toolOf(toolId)?.target) || null;
  const nameOf = s => (s.kind === 'install' ? `${s.manager || 'npm'} install` : `${s.manager} run ${s.script}`);

  // ------------------------------------------------------------ a server's log

  function serverTool(toolId) {
    const status = h('span', { class: 'tp-status', role: 'status' });
    const dot = h('span', { class: 'pj-dot', 'aria-hidden': 'true' });
    const name = h('code', { class: 'tp-name' });
    const actions = h('div', { class: 'row wrap tp-actions' });
    const pre = h('pre', { class: 'pj-log tp-log', tabindex: '0' });
    const el = h('div', { class: 'tool-pane', dataset: { tool: toolId } },
      h('div', { class: 'tp-head' }, dot, name, status), actions, pre);
    let lastRead = 0, timer = null;
    let readFor = null; // the status of a stopped server whose log has been read: it won't change

    const act = (text, fn, cls = 'btn ghost slim-btn') => h('button', { type: 'button', class: cls, text, onclick: fn });
    const run = async (method, id) => {
      const r = await api[method](id);
      if (r && r.ok === false && r.error) SB.toast(r.error);
    };

    // At the end it stays at the end as lines come in; scrolled up, it stays put.
    async function readLog(id) {
      lastRead = Date.now();
      const l = await api.serverLog(id).catch(() => null);
      if (!l || !el.isConnected) return;
      const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      const errors = new Set(l.errors);
      pre.replaceChildren(...(l.lines.length ? l.lines.map((line, i) => h('span', { class: errors.has(i) ? 'err' : null, text: `${line}\n` })) : [h('span', { class: 'muted', text: 'Nothing printed yet.' })]));
      if (atEnd) pre.scrollTop = pre.scrollHeight;
      // Main says when a server's state changes, not when it prints: while it runs, look again.
      const s = serverOf(toolId);
      if (s && L.isLive(s) && mounted.has(toolId)) pullLog(s.id);
    }

    // One read at a time, at most every LOG_REFRESH_MS, however often the servers change.
    function pullLog(id) {
      if (timer) return;
      timer = setTimeout(() => { timer = null; readLog(id); }, Math.max(0, lastRead + LOG_REFRESH_MS - Date.now()));
    }

    function draw() {
      const s = serverOf(toolId);
      if (!s) {
        dot.className = 'pj-dot off';
        status.textContent = 'Stopped';
        actions.replaceChildren(act('Close', () => close(toolId)));
        return;
      }
      const live = L.isLive(s);
      const crashed = s.status === 'crashed' || s.status === 'failed';
      dot.className = `pj-dot ${s.status}`;
      name.textContent = nameOf(s);
      status.textContent = L.statusText(s, SB.relTime);
      pre.setAttribute('aria-label', `Output of ${s.script || 'the install'}`);
      actions.replaceChildren(...[
        s.status === 'up' && s.url && act('Open', () => api.openServer(s.id), 'btn slim-btn'),
        s.kind === 'server' && (live || crashed) && act('Restart', () => run('restartServer', s.id), crashed ? 'btn primary slim-btn' : undefined),
        live && act('Stop', () => run('stopServer', s.id)),
        crashed && s.canFix && act('Ask Claude to fix it…', () => { SB.setView('projects'); SB.pj.showServer(s.id); }, 'btn slim-btn'),
        act('Open the log file', () => api.openServerLog(s.id), 'link-btn small'),
      ].filter(Boolean));
      if (!live && readFor === s.status) return;
      readFor = live ? null : s.status;
      pullLog(s.id);
    }

    return {
      el, draw,
      title: () => { const s = serverOf(toolId); return s ? nameOf(s) : 'Server log'; },
      destroy: () => { clearTimeout(timer); el.remove(); },
    };
  }

  const KINDS = { server: serverTool };

  // ------------------------------------------------------------ opening and closing

  function elOf(toolId) {
    let t = mounted.get(toolId);
    if (!t) {
      const make = KINDS[P.toolOf(toolId)?.kind];
      if (!make) return null;
      t = make(toolId);
      mounted.set(toolId, t);
      t.draw();
    }
    return t.el;
  }

  // Beside the focused pane, growing the window if it needs to (as Split does).
  async function openServer(serverId) {
    const toolId = `server:${serverId}`;
    if (SB.solo || !P.isTool(toolId)) return false;
    servers = (await api.getServers().catch(() => null))?.servers || servers;
    SB.setView('chat');
    SB.unzoom();
    const next = P.openTool(state.grid, toolId, SB.focusedPane());
    if (next === state.grid && !P.paneWith(state.grid, toolId)) { SB.toast(SB.NO_ROOM); return false; }
    const room = SB.roomFor(next);
    if (!room.ok) { SB.toast(SB.NO_ROOM); return false; }
    if (room.want) await api.fitPanel(room.want);
    const grid = P.openTool(state.grid, toolId, SB.focusedPane());
    state.paneSizes = room.space ? SB.atLeastMin(grid, P.fitSizes(grid, state.paneSizes), room.space) : P.fitSizes(grid, state.paneSizes);
    state.grid = grid;
    SB.renderPanes();
    SB.renderTabStrip();
    return true;
  }

  function close(toolId) {
    if (!P.paneWith(state.grid, toolId)) return;
    state.grid = P.leave(state.grid, toolId);
    mounted.get(toolId)?.destroy();
    mounted.delete(toolId);
    SB.renderPanes();
    SB.renderTabStrip();
  }

  // Every tool no longer in a pane (`kept`: the ones still there) stops and goes.
  function prune(kept) {
    const keep = new Set(kept);
    for (const [id, t] of mounted) if (!keep.has(id)) { t.destroy(); mounted.delete(id); }
  }

  api.onServersChanged(v => {
    servers = v?.servers || [];
    for (const t of mounted.values()) t.draw();
    if (mounted.size) SB.renderTabStrip(); // the chips' names
  });
  if (!SB.solo) api.getServers().then(v => { servers = v?.servers || []; for (const t of mounted.values()) t.draw(); }, () => {});

  SB.tools = {
    elOf,
    // Its pane's strip (tab-strip.js): its name, alone. The pane's x closes it.
    chip: toolId => h('span', { class: 'tool-chip', role: 'tab', 'aria-selected': 'true', text: mounted.get(toolId)?.title() || 'Tool' }),
    openServer,
    close,
    prune,
  };
})();
