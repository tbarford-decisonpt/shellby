/* Shellby panel — Workflows: triggers start a list of steps (docs/plans/workflows.md).
   One view, four screens: the list, the editor, one workflow's runs, and one
   run. The editor and a run can each be seen as a map (workflow-canvas.js draws
   it) or as a list. Everything a workflow or a run says is untrusted text: it
   only ever reaches the page through SB.h / textContent (Claude replies go
   through the escaping markdown renderer).

   The view is spread over several files, loaded in this order, that share what
   they need through SB.wfKit (W): this one (words, small helpers, the menu,
   moving between screens), wf-model.js (the editor's model and validation),
   wf-list.js, wf-fields.js (field builders), wf-steps.js (each step type's
   fields), wf-runs.js, wf-save.js (JSON, Save, Build it with Claude) and
   workflows.js (the editor screen and the wiring). A file takes what an earlier
   one made when it loads; what a later one makes it reaches as W.name() when it
   runs. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const W = SB.wfKit = {};
  const G = window.ShellbyWfGraph;
  // replaceChildren() writes a null as the text "null": optional parts are dropped instead.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  const view = $('workflowsView');
  const screen = $('wfScreen');
  const menu = $('wfMenu');

  // ================================================================ vocabulary

  const STEP_INFO = {
    claude: { name: 'Ask Claude', sub: 'Claude works on it, and can hand back fields' },
    run: { name: 'Run a command', sub: 'A PowerShell command' },
    http: { name: 'Web request', sub: 'Call a web address' },
    mcp: { name: 'MCP tool', sub: 'Call one tool of an MCP server, with no Claude turn' },
    file: { name: 'File', sub: 'Read, write or add to a file' },
    ask: { name: 'Ask me', sub: 'Wait for your answer' },
    tell: { name: 'Tell me', sub: 'A notification, your phone, Shellby or a file' },
    if: { name: 'If', sub: 'Only do some steps when something is true' },
    each: { name: 'Repeat for each', sub: 'Go through a list one item at a time' },
    set: { name: 'Set values', sub: 'Remember values for later steps' },
    wait: { name: 'Wait', sub: 'Pause before the next step' },
    workflow: { name: 'Run a workflow', sub: 'Start another workflow and wait for it' },
    stop: { name: 'Stop', sub: 'End the run here' },
    worktree: { name: 'Make a copy', sub: 'A copy of a GitHub repository to work in, on its own branch' },
    pr: { name: 'Open a pull request', sub: 'Push the copy\'s branch and open a draft pull request' },
  };
  const STEP_GROUPS = [['Claude', ['claude']], ['Do', ['run', 'http', 'mcp', 'file']], ['GitHub', ['worktree', 'pr']], ['Talk', ['ask', 'tell']], ['Logic', ['if', 'each', 'set', 'wait', 'workflow', 'stop']]];
  const CONTAINERS = { if: ['then', 'else'], each: ['steps'] };

  const TRIGGER_INFO = {
    schedule: { name: 'On a schedule', sub: 'Every day, certain days, or every few hours or minutes' },
    ci: { name: 'When a build changes', sub: 'A pull request fails, goes green, is merged…' },
    issue: { name: 'When an issue comes in', sub: 'Assigned to you, or labelled shellby' },
    shipped: { name: 'When something ships', sub: 'A push, deploy, release or merge' },
    task: { name: 'When a task finishes', sub: 'One of your Shellby conversations' },
    health: { name: 'When the PC needs attention', sub: 'Something overheats or fills up' },
    folder: { name: 'When files change', sub: 'Files added or changed in a folder' },
    workflow: { name: 'After another workflow', sub: 'When it finishes, succeeds or fails' },
    startup: { name: 'When Shellby starts', sub: 'Each time Shellby opens' },
    webhook: { name: 'From a script', sub: 'A web hook on this PC only' },
    claude: { name: 'When Claude Code asks', sub: 'Claude Code (MCP) or the shellby command' },
  };
  const ONCE_TRIGGERS = ['claude', 'startup', 'health', 'webhook'];
  const MAX = { triggers: 8, steps: 60, depth: 4, inputs: 10, choices: 4 };

  // What each trigger hands to the steps as trigger.*
  const TRIGGER_FIELDS = {
    schedule: { at: 'When it was due' },
    ci: { event: 'What happened', forge: 'github or gitlab', ref: 'owner/name#12 (or group/project!12)', repo: 'owner/name', number: 'Pull or merge request number', title: 'Pull or merge request title', url: 'Link', branch: 'Branch', failing: 'Failing checks (a list)' },
    issue: { event: 'assigned or labelled', reasons: 'Every reason it came in (a list)', repo: 'owner/name', number: 'Issue number', title: 'Issue title', body: 'What the issue says', labels: 'Its labels (a list)', author: 'Who opened it', url: 'Link' },
    shipped: { kind: 'push, deploy, release or merge', project: 'Project', version: 'Version, if any' },
    task: { title: 'Task title', outcome: 'ok or error', folder: 'Its folder', error: 'The error, if it failed' },
    health: { title: 'What happened', body: 'The details' },
    folder: { folder: 'The folder', files: 'The files (a list)' },
    workflow: { name: 'Workflow name', status: 'ok or error', runId: 'Its run', vars: 'Its values' },
  };
  // What each step type hands on as <id>.*
  const STEP_OUTPUTS = {
    claude: s => ({ reply: 'Claude\'s reply', ...Object.fromEntries(Object.entries(s.output || {}).map(([k, f]) => [k, f.description || f.type])) }),
    run: () => ({ output: 'What it printed', code: 'Exit code', ok: 'true if it worked' }),
    http: () => ({ status: 'Status code', ok: 'true for 2xx', body: 'The response', json: 'The response, read as JSON' }),
    mcp: () => ({ ok: 'true unless the tool reported a problem', text: 'What the tool said', json: 'Its answer as data, when it gives one' }),
    ask: () => ({ choice: 'Your answer' }),
    file: s => (s.action === 'read' || !s.action ? { text: 'What the file says' } : { path: 'The file' }),
    workflow: () => ({ status: 'ok or error', vars: 'Its values' }),
    each: () => ({ count: 'How many it went through' }),
    worktree: () => ({ path: 'The copy\'s folder', branch: 'Its branch', base: 'The branch it started from', repo: 'owner/name' }),
    pr: () => ({ url: 'Link to the pull request', number: 'Pull request number', branch: 'Its branch', repo: 'owner/name', draft: 'true if it\'s a draft' }),
  };

  const MODE_NAME = Object.fromEntries(SB.MODES.map(m => [m.id, m.title]));
  const TELL_TO = [['notification', 'A notification'], ['phone', 'My phone'], ['crab', 'Shellby says it'], ['file', 'A file']];
  const FILE_ACTIONS = [['read', 'Read it'], ['write', 'Write it (replace)'], ['append', 'Add to the end']];
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  const FIELD_TYPES = ['string', 'number', 'boolean', 'list', 'object'];
  const WAIT_UNITS = [['seconds', 1], ['minutes', 60], ['hours', 3600], ['days', 86400]];
  const RUN_TRIGGER = { manual: 'By hand', step: 'From a workflow step', ...Object.fromEntries(Object.entries(TRIGGER_INFO).map(([k, v]) => [k, v.name])) };
  const STATUS_GLYPH = { pending: '○', running: '◐', waiting: '⏸', retrying: '↻', ok: '✓', error: '✕', skipped: '–', stopped: '■', interrupted: '!' };
  const STATUS_WORD = { pending: 'Not yet', running: 'Running', waiting: 'Waiting', retrying: 'Retrying', ok: 'Done', error: 'Failed', skipped: 'Skipped', stopped: 'Stopped', interrupted: 'Interrupted' };

  const ICON = {
    claude: 'M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l1.9 1.9M9.9 9.9l1.9 1.9M11.8 4.2L9.9 6.1M6.1 9.9l-1.9 1.9',
    run: 'M2.5 3.5h11v9h-11zM4.8 6.4l2 1.6-2 1.6M8.3 9.8h2.9',
    http: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M2.5 8h11M8 2.5c-2.2 2.4-2.2 8.6 0 11M8 2.5c2.2 2.4 2.2 8.6 0 11',
    file: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8.5h4M6 11h4',
    mcp: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2',
    ask: 'M2.5 4c0-.8.7-1.5 1.5-1.5h8c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5H7l-3 2.5v-2.5c-.8 0-1.5-.7-1.5-1.5zM6.6 5.4a1.4 1.4 0 1 1 1.9 1.3c-.4.2-.5.5-.5.9M8 8.9v.1',
    tell: 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.6 13.6a1.4 1.4 0 0 0 2.8 0',
    if: 'M4 2.5v11M4 8.5c0-2.2 1.8-3.5 4-3.5h4.5M10.5 3l2 2-2 2',
    each: 'M3 6.8a4.2 4.2 0 0 1 7.4-2.5l1.2 1.2M11.6 2.6v2.9H8.7M13 9.2a4.2 4.2 0 0 1-7.4 2.5l-1.2-1.2M4.4 13.4v-2.9h2.9',
    set: 'M3 5h10M3 11h10M6 3v4M10 9v4',
    wait: 'M4 2.5h8M4 13.5h8M5 2.5c0 3 6 2.9 6 5.5s-6 2.5-6 5.5M11 2.5c0 3-6 2.9-6 5.5s6 2.5 6 5.5',
    workflow: 'M2.5 3h4.5v3.5H2.5zM9 9.5h4.5V13H9zM4.8 6.5v4.8H9',
    stop: 'M4.5 4.5h7v7h-7z',
    worktree: 'M4.5 2.5v11M4.5 9.5c0-2 1.6-3 3.5-3h1c1.4 0 2.5-1.1 2.5-2.5V2.5',
    pr: 'M4.5 2.5v11M11.5 13.5V7c0-1.4-1.1-2.5-2.5-2.5H7M8.5 3l-1.8 1.5L8.5 6',
    play: 'M5 3.5v9l7-4.5z',
    up: 'M4 10l4-4 4 4',
    down: 'M4 6l4 4 4-4',
    more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
    plus: 'M8 3.5v9M3.5 8h9',
    close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
    trigger: 'M9 1.8L3.6 9h4l-1 5.2L12.4 7h-4z',
    minus: 'M3.5 8h9',
    fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
    flag: 'M4 14V2.5M4 3h7.5L9.7 5.8l1.8 2.8H4',
    settings: 'M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3',
    expand: 'M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9',
    shrink: 'M13 3L9 7M9 3.5V7h3.5M3 13l4-4M7 12.5V9H3.5',
    // What starts a workflow, for the tile on its row in the list.
    schedule: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 5v3.2l2.1 1.3',
    ci: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M5.6 8.1l1.7 1.7 3.2-3.4',
    issue: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M7 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    shipped: 'M8 10.5V2.8M5 5.6l3-3 3 3M3 9.5v3.5h10V9.5',
    task: 'M3 8.4l3 3 7-7',
    health: 'M1.5 8.5h3l1.5-4 3 8 1.5-4h4',
    folder: 'M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z',
    startup: 'M8 2v5.5M5 4a5 5 0 1 0 6 0',
    webhook: 'M7 9l2-2M6.2 5.8l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5l-1.3 1.3M9.8 10.2l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5l1.3-1.3',
  };
  const icon = (name, width = 1.4) => SB.icon(ICON[name] || ICON.stop, { width: name === 'more' ? 2.6 : width });

  // ================================================================ small helpers

  let uidN = 0;
  const uid = p => `wf-${p}-${++uidN}`;
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const firstLine = t => String(t || '').split('\n')[0].trim();
  const { plural } = SB;
  const putOrDrop = (obj, key, v) => { if (v === undefined || v === null || v === '' || v === false) delete obj[key]; else obj[key] = v; };
  const toInt = v => (String(v).trim() === '' ? undefined : Math.round(Number(v)));

  function throttle(fn, ms) {
    let timer = null;
    let again = false;
    const tick = () => { if (again) { again = false; fn(); timer = setTimeout(tick, ms); } else timer = null; };
    return () => { if (timer) { again = true; return; } fn(); timer = setTimeout(tick, ms); };
  }

  function debounce(fn, ms) {
    let timer = null;
    const call = () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
    call.cancel = () => clearTimeout(timer);
    return call;
  }

  function humanSeconds(n) {
    if (!Number.isFinite(n)) return '…';
    const unit = [...WAIT_UNITS].reverse().find(([, f]) => n % f === 0) || WAIT_UNITS[0];
    return plural(n / unit[1], unit[0].replace(/s$/, ''));
  }

  // Re-render without losing your place: the focused control (by data-fk) and the scroll.
  const keepFocus = fn => SB.keepFocus(screen, fn, { attr: 'fk', scroller: view, preventScroll: true });
  const focusFk = fk => SB.focusKept(screen, fk, { attr: 'fk', preventScroll: true });

  const editing = el => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

  // How you like to see things, kept on this PC: Map or List, and whether the map makes room.
  const PREF = { layout: 'shellby.wf.layout', runLayout: 'shellby.wf.runLayout', roomy: 'shellby.wf.roomy' };
  const { pref } = SB;

  // Map | List, for the editor and for a run.
  function layoutSwitch(value, onPick, label) {
    const name = uid('lay');
    const radio = (v, text) => h('label', {},
      h('input', { type: 'radio', name, value: v, checked: value === v, 'data-fk': `lay-${v}`, onchange: () => onPick(v) }),
      h('span', { text }));
    return h('div', { class: 'seg wf-seg wf-layout', role: 'radiogroup', 'aria-label': label }, radio('map', 'Map'), radio('list', 'List'));
  }

  // Make room: the panel widens while a map is open, and goes back when you leave it.
  const room = { on: false, want: pref(PREF.roomy, '') === '1' };

  async function applyRoom(on) {
    if (on === room.on || !api.setPanelRoomy) return;
    room.on = on;
    let res;
    try { res = await api.setPanelRoomy(on); } catch { res = null; }
    if (on && !res?.roomy) room.on = false; // already as wide as the screen allows
    for (const b of document.querySelectorAll('[data-room-btn]')) paintRoomBtn(b);
  }

  function roomBtn() {
    const b = h('button', {
      type: 'button', class: 'icon-btn wfc-tool', 'data-room-btn': '', 'data-fk': 'room',
      onclick: async () => {
        room.want = !room.on;
        pref.set(PREF.roomy, room.want ? '1' : '');
        await applyRoom(room.want);
        if (room.want && !room.on) SB.toast('The panel is already as wide as this screen allows.');
      },
    });
    paintRoomBtn(b);
    return b;
  }

  function paintRoomBtn(b) {
    const label = room.on ? 'Give the room back' : 'Make room: widen the panel';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(room.on));
    b.replaceChildren(icon(room.on ? 'shrink' : 'expand'));
  }

  // You resized the widened panel yourself: that's your size now, and maps stop asking for room.
  api.onPanelRoomyLost?.(() => {
    room.on = false;
    room.want = false;
    pref.set(PREF.roomy, '');
    for (const b of document.querySelectorAll('[data-room-btn]')) paintRoomBtn(b);
  });

  // A map fills the view (no page scroll; it pans instead).
  function setMapMode(on) {
    view.classList.toggle('map-mode', on);
    applyRoom(on && room.want);
  }
  new MutationObserver(() => { if (document.body.dataset.view !== 'workflows') setMapMode(false); })
    .observe(document.body, { attributes: true, attributeFilter: ['data-view'] });

  function iconBtn(name, label, onclick, attrs = {}) {
    return h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick, ...attrs }, icon(name));
  }

  function statusPill(status, when) {
    const word = { running: 'running', waiting: 'waiting', ok: 'ran', error: 'failed', stopped: 'stopped', interrupted: 'interrupted' }[status] || status;
    const cls = { ok: 'ok', error: 'err', running: 'running', waiting: 'wait', interrupted: 'warn' }[status] || '';
    const live = status === 'running' || status === 'waiting';
    return h('span', { class: `r-pill ${cls}`, text: live || !when ? word : `${word} ${SB.relTime(when)}` });
  }

  const runDuration = r => (r.startedAt ? SB.duration((r.endedAt || Date.now()) - r.startedAt) : '');

  // ================================================================ menu (one popover for the whole view)

  let menuAnchor = null;
  function popup(anchor, build) {
    if (!menu.hidden && menuAnchor !== anchor) closePopup();
    SB.openMenu(menu, anchor, build);
    if (menu.hidden) return;
    menuAnchor = anchor;
    const r = menu.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
      const a = anchor.getBoundingClientRect();
      menu.style.top = `${Math.max(8, a.top - r.height - 6)}px`;
    }
  }

  function closePopup({ refocus = false } = {}) {
    const a = menuAnchor;
    SB.closeMenus();
    if (refocus && a?.isConnected) a.focus();
  }

  // SB.closeMenus only knows its own anchors; keep ours honest however the menu closes.
  new MutationObserver(() => {
    if (menu.hidden && menuAnchor) { menuAnchor.setAttribute('aria-expanded', 'false'); menuAnchor = null; }
  }).observe(menu, { attributes: true, attributeFilter: ['hidden'] });

  // Arrows, Home and End are core.js's, as in every menu.
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup({ refocus: true }); return; }
    if (e.key === 'Tab') { closePopup({ refocus: true }); e.preventDefault(); }
  });

  // Every item here has the check column, so the titles line up.
  const menuItem = (title, sub, onPick, opts = {}) => SB.menuItem(title, sub, onPick, { ...opts, glyph: opts.glyph || '' });
  const menuLabel = text => h('div', { class: 'menu-label', text });

  // ================================================================ navigation inside the view

  // A stack of screens: [{ name: 'list' }, { name: 'runs', id }, { name: 'run', runId }…]
  // Changed in place (resetNav), never replaced: the other files hold it too.
  const nav = [{ name: 'list' }];
  const resetNav = (...screens) => { nav.splice(0, nav.length, { name: 'list' }, ...screens); };
  const current = () => nav[nav.length - 1];
  const SCREEN_NAME = { list: 'Workflows', editor: 'Editor', runs: 'Runs', run: 'Run' };

  function go(name, params = {}) {
    closePopup();
    nav.push({ name, ...params });
    show();
  }

  function home() {
    resetNav();
    show();
  }

  function up() {
    if (nav.length <= 1) return SB.goBack();
    const leave = () => { nav.pop(); show(); };
    return current().name === 'editor' ? W.leaveEditor(leave) : leave();
  }

  function show({ focusHeading = true } = {}) {
    if (state.view !== 'workflows') return SB.setView('workflows');
    render();
    view.scrollTop = 0;
    if (focusHeading) requestAnimationFrame(() => { const hd = screen.querySelector('h2'); if (hd) { hd.tabIndex = -1; hd.focus({ preventScroll: true }); } });
  }

  function backBtn() {
    const prev = nav[nav.length - 2];
    return h('button', { type: 'button', class: 'back-btn', onclick: up }, `← ${SCREEN_NAME[prev?.name] || 'Back'}`);
  }

  function render() {
    closePopup();
    const s = current().name;
    if (!state.workflows && s !== 'run') { loadView(); return renderLoading(); }
    if (s === 'editor' && W.ed.def) return W.renderEditor();
    if (s === 'runs') return W.renderRuns();
    if (s === 'run') return W.renderRun();
    resetNav();
    W.renderList();
    // Pushes keep it current; this catches anything that changed while the panel was shut.
    api.listWorkflows().then(W.applyView).catch(() => {});
  }

  function renderLoading(text = 'Loading…') {
    setMapMode(false);
    fill(screen, h('p', { class: 'muted small', role: 'status', text }));
  }

  let loadingView = false;
  async function loadView() {
    if (loadingView) return;
    loadingView = true;
    try {
      state.workflows = await api.listWorkflows();
      if (state.view === 'workflows') render();
    } catch {
      renderLoading('Workflows aren\'t available right now. Try again in a moment.');
    } finally {
      loadingView = false;
    }
  }

  // Esc goes up one level inside the view; from the list it leaves as usual.
  view.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || nav.length <= 1) return;
    if (document.querySelector('.card-sheet:not([hidden])')) return;
    e.preventDefault();
    e.stopPropagation();
    up();
  });

  // The Workflows | Routines switch: Routines is wired by nav.js (data-view-btn);
  // these two take you to the workflow list.
  for (const b of document.querySelectorAll('[data-goto-workflows]')) {
    b.addEventListener('click', () => {
      if (state.view !== 'workflows') { resetNav(); return SB.setView('workflows'); }
      if (nav.length > 1) leaveEditorIfNeeded(home);
    });
  }
  const leaveEditorIfNeeded = then => (current().name === 'editor' ? W.leaveEditor(then) : then());

  // The file an Ask step names, opened in your editor while it waits.
  const openFileBtn = file => h('button', {
    type: 'button', class: 'btn ghost slim-btn', title: `Open ${file} · Shift+click shows it in its folder`,
    onclick: e => SB.openFile(file, { reveal: e.shiftKey }),
  }, `Open ${SB.basename(file)}`);

  Object.assign(W, {
    pref, PREF, CONTAINERS, clone, current, nav, go, focusFk, keepFocus, debounce, plural, fill, STEP_INFO,
    setMapMode, screen, throttle, editing, uid, TRIGGER_INFO, icon, ICON, iconBtn, popup, menuItem, toInt,
    TRIGGER_FIELDS, STEP_OUTPUTS, menuLabel, putOrDrop, METHODS, FILE_ACTIONS, TELL_TO, FIELD_TYPES, MAX,
    WAIT_UNITS, backBtn, home, RUN_TRIGGER, runDuration, statusPill, firstLine, layoutSwitch, G, STATUS_WORD,
    STATUS_GLYPH, roomBtn, loadView, up, ONCE_TRIGGERS, STEP_GROUPS, MODE_NAME, humanSeconds, leaveEditorIfNeeded,
    resetNav, show, render, openFileBtn,
  });
})();
