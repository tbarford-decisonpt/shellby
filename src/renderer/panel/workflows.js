/* Shellby panel — Workflows: triggers start a list of steps (docs/plans/workflows.md).
   One view, four screens: the list, the editor, one workflow's runs, and one
   run. The editor and a run can each be seen as a map (workflow-canvas.js draws
   it) or as a list. Everything a workflow or a run says is untrusted text: it
   only ever reaches the page through SB.h / textContent (Claude replies go
   through the escaping markdown renderer). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
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
  const STEP_GROUPS = [['Claude', ['claude']], ['Do', ['run', 'http', 'file']], ['GitHub', ['worktree', 'pr']], ['Talk', ['ask', 'tell']], ['Logic', ['if', 'each', 'set', 'wait', 'workflow', 'stop']]];
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
    ci: { event: 'What happened', repo: 'owner/name', number: 'Pull request number', title: 'Pull request title', url: 'Link', branch: 'Branch', failing: 'Failing checks (a list)' },
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
  };
  const icon = (name, width = 1.4) => SB.icon(ICON[name] || ICON.stop, { width: name === 'more' ? 2.6 : width });

  // ================================================================ small helpers

  let uidN = 0;
  const uid = p => `wf-${p}-${++uidN}`;
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const firstLine = t => String(t || '').split('\n')[0].trim();
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
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
  function keepFocus(fn) {
    const a = document.activeElement;
    const fk = a && screen.contains(a) ? a.dataset.fk : null;
    const top = view.scrollTop;
    fn();
    view.scrollTop = top;
    if (fk) focusFk(fk);
  }

  function focusFk(fk) {
    const el = [...screen.querySelectorAll('[data-fk]')].find(e => e.dataset.fk === fk);
    if (!el) return false;
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  }

  const editing = el => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

  // How you like to see things, kept on this PC: Map or List, and whether the map makes room.
  const PREF = { layout: 'shellby.wf.layout', runLayout: 'shellby.wf.runLayout', roomy: 'shellby.wf.roomy' };
  const pref = (key, fallback) => { try { return window.localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const setPref = (key, value) => { try { window.localStorage.setItem(key, value); } catch { /* storage refused: it lasts this session */ } };

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
        setPref(PREF.roomy, room.want ? '1' : '');
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
    setPref(PREF.roomy, '');
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

  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup({ refocus: true }); return; }
    if (e.key === 'Tab') { closePopup({ refocus: true }); e.preventDefault(); return; }
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined || !items.length) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  });

  function menuItem(title, sub, onPick, { glyph = null, disabled = false, mono = false } = {}) {
    return h('button', {
      class: 'menu-item', type: 'button', role: 'menuitem', disabled: !!disabled,
      onclick: () => { closePopup({ refocus: true }); onPick(); },
    },
    h('span', { class: 'mi-check', 'aria-hidden': 'true' }, glyph || ''),
    h('span', {}, h('div', { class: `mi-title${mono ? ' wf-mono' : ''}`, text: title }), sub ? h('div', { class: 'mi-sub', text: sub }) : null));
  }
  const menuLabel = text => h('div', { class: 'menu-label', text });

  // ================================================================ navigation inside the view

  // A stack of screens: [{ name: 'list' }, { name: 'runs', id }, { name: 'run', runId }…]
  let nav = [{ name: 'list' }];
  const current = () => nav[nav.length - 1];
  const SCREEN_NAME = { list: 'Workflows', editor: 'Editor', runs: 'Runs', run: 'Run' };

  function go(name, params = {}) {
    closePopup();
    nav.push({ name, ...params });
    show();
  }

  function home() {
    nav = [{ name: 'list' }];
    show();
  }

  function up() {
    if (nav.length <= 1) return SB.goBack();
    const leave = () => { nav.pop(); show(); };
    return current().name === 'editor' ? leaveEditor(leave) : leave();
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
    if (s === 'editor' && ed.def) return renderEditor();
    if (s === 'runs') return renderRuns();
    if (s === 'run') return renderRun();
    nav = [{ name: 'list' }];
    renderList();
    // Pushes keep it current; this catches anything that changed while the panel was shut.
    api.listWorkflows().then(applyView).catch(() => {});
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
      if (state.view !== 'workflows') { nav = [{ name: 'list' }]; return SB.setView('workflows'); }
      if (nav.length > 1) leaveEditorIfNeeded(home);
    });
  }
  const leaveEditorIfNeeded = then => (current().name === 'editor' ? leaveEditor(then) : then());

  // ================================================================ the list

  const list = { rows: null, gallery: null, secrets: null, pending: false };
  let describeText = '';
  let drafting = false;
  let runFormFor = null;     // workflow id whose inputs form is open
  let runValues = {};

  const workflows = () => state.workflows?.workflows || [];
  const DEF_KEYS = ['id', 'name', 'description', 'enabled', 'cwd', 'concurrency', 'inputs', 'when', 'steps', 'createdAt'];
  const toDef = w => Object.fromEntries(DEF_KEYS.filter(k => w[k] !== undefined).map(k => [k, clone(w[k])]));

  function renderList() {
    setMapMode(false);
    list.rows = h('ul', { class: 'wf-list', 'aria-label': 'Your workflows' });
    list.gallery = h('div', { class: 'wf-gallery' });
    list.secrets = h('section', { class: 'wf-secrets', 'aria-labelledby': 'wfSecretsTitle' });
    fill(screen, 
      h('div', { class: 'view-head' },
        h('h2', { text: 'Workflows' }),
        h('div', { class: 'wf-head-actions' },
          h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: openImport }, 'Import'),
          h('button', { type: 'button', class: 'btn primary slim-btn', onclick: () => openEditor(blankWorkflow()) }, 'New workflow'))),
      h('p', { class: 'view-lede', text: 'Something happens, and Shellby does a list of steps: Claude, commands, web requests, questions for you. You can always run one by hand too.' }),
      describeBox(),
      list.rows,
      list.gallery,
      list.secrets);
    fillList();
    if (focusDescribe) requestAnimationFrame(takeDescribeFocus);
  }

  // Ctrl+K › Describe a workflow lands in the box, even if the list is still loading.
  let focusDescribe = false;
  function takeDescribeFocus() {
    const box = screen.querySelector('.wf-describe-text');
    if (!box) return;
    focusDescribe = false;
    box.focus();
  }

  // Live updates refill the rows, but never under your cursor: if you're typing
  // in a run form or the secrets box, it waits until you leave.
  function fillList() {
    if (!list.rows?.isConnected) return;
    const a = document.activeElement;
    if (editing(a) && (list.rows.contains(a) || list.secrets.contains(a))) { list.pending = true; return; }
    list.pending = false;
    keepFocus(() => {
      fill(list.rows, ...workflows().map(workflowRow));
      list.rows.hidden = !workflows().length;
      fillGallery();
      fillSecrets();
    });
  }
  screen.addEventListener('focusout', e => {
    if (list.pending && !(editing(e.relatedTarget) && screen.contains(e.relatedTarget))) setTimeout(fillList, 0);
  });

  // ------------------------------------------------------------ describe it

  function describeBox() {
    const id = uid('describe');
    const box = h('textarea', {
      class: 'field area wf-describe-text', id, rows: 3, maxlength: 2000, disabled: drafting,
      placeholder: 'When a build fails on my repo, have Claude find out why and tell me on my phone',
      oninput: e => { describeText = e.target.value; },
      onkeydown: e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); submit(); } },
    });
    box.value = describeText;
    const note = h('p', { class: 'wf-note', id: uid('note'), 'aria-live': 'polite', text: 'Claude drafts it for you to check. Nothing is saved until you press Save.' });
    box.setAttribute('aria-describedby', note.id);
    const btn = h('button', { type: 'submit', class: 'btn slim-btn', disabled: drafting }, drafting ? [h('span', { class: 'wf-spin', 'aria-hidden': 'true' }), 'Drafting…'] : 'Draft it');
    async function submit() {
      if (drafting) return;
      const text = describeText.trim();
      if (!text) { setNote('Say what should happen, and when.', true); box.focus(); return; }
      drafting = true;
      box.disabled = true;
      btn.disabled = true;
      fill(btn, h('span', { class: 'wf-spin', 'aria-hidden': 'true' }), 'Drafting…');
      setNote('Claude is drafting it…');
      let res;
      try { res = await api.draftWorkflow(text); } catch { res = { ok: false, error: 'Couldn\'t reach Claude. Try again.' }; }
      drafting = false;
      if (res?.ok && res.workflow) {
        describeText = '';
        openEditor(res.workflow, { title: 'Drafted workflow' });
        SB.toast('Drafted. Check it over, then press Save.');
        return;
      }
      if (!box.isConnected) {
        // You left the list while Claude worked: say how it went, and redraw the box if it's back on screen.
        SB.toast(res?.error || 'Claude couldn\'t draft that.');
        if (state.view === 'workflows' && current().name === 'list') renderList();
        return;
      }
      box.disabled = false;
      btn.disabled = false;
      fill(btn, 'Draft it');
      setNote(res?.error || 'Claude couldn\'t draft that. Try saying it another way.', true);
      box.focus();
    }
    function setNote(text, err = false) { note.textContent = text; note.classList.toggle('err', err); }
    return h('form', { class: `wf-describe${drafting ? ' busy' : ''}`, novalidate: true, onsubmit: e => { e.preventDefault(); submit(); } },
      h('label', { class: 'field-label', for: id, text: 'Describe a workflow' }),
      box,
      h('div', { class: 'wf-describe-foot' }, note, btn));
  }

  // ------------------------------------------------------------ rows

  function workflowRow(w) {
    const last = w.lastRun;
    const status = w.running ? 'running' : last?.status;
    const when = [w.triggers?.length ? w.triggers.join(' · ') : 'Run by hand'];
    if (!w.enabled) when.push('off');
    else if (w.next) when.push(`next ${SB.untilTime(w.next)}`);
    return h('li', { class: `wf-row${w.enabled ? '' : ' paused'}${last?.waiting ? ' waiting' : ''}`, 'data-workflow-id': w.id },
      h('div', { class: 'wf-row-top' },
        h('label', { class: 'toggle mini', title: w.enabled ? 'Turn off' : 'Turn on' },
          h('input', { type: 'checkbox', checked: w.enabled, 'aria-label': `Run “${w.name}” automatically`, 'data-fk': `en-${w.id}`, onchange: e => setEnabled(w, e.target) }),
          h('span', { class: 'switch' })),
        h('div', { class: 'wf-row-main' },
          h('div', { class: 'wf-row-name' }, h('span', { class: 'wf-row-title', text: w.name }), status ? statusPill(status, last?.endedAt || last?.startedAt) : h('span', { class: 'r-pill', text: 'never run' })),
          h('div', { class: 'wf-row-when', text: when.join(' · ') }),
          w.description ? h('div', { class: 'wf-row-desc', text: w.description, title: w.description }) : null),
        h('div', { class: 'wf-row-actions' },
          iconBtn('play', `Run “${w.name}” now`, () => startRun(w), { 'data-fk': `run-${w.id}`, 'aria-expanded': w.inputs?.length ? String(runFormFor === w.id) : null }),
          iconBtn('more', `More for “${w.name}”`, e => rowMenu(w, e.currentTarget), { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': `more-${w.id}` }))),
      last?.waiting ? waitingBox(last) : null,
      runFormFor === w.id ? runForm(w) : null);
  }

  function waitingBox(last) {
    const wt = last.waiting;
    if (wt.question || wt.choices) {
      const choices = wt.choices?.length ? wt.choices : ['Continue', 'Stop'];
      return h('div', { class: 'wf-waiting', role: 'group', 'aria-label': 'Waiting for you' },
        h('div', { class: 'wf-waiting-head', text: 'Waiting for you' }),
        h('p', { class: 'wf-waiting-q', text: wt.question || '' }),
        h('div', { class: 'row wrap' }, choices.map(c => h('button', {
          type: 'button', class: 'btn slim-btn',
          onclick: async ev => { ev.currentTarget.disabled = true; await answer(last.id, wt.key, c); },
        }, c))));
    }
    return h('div', { class: 'wf-waiting quiet' }, h('span', { text: wt.until ? `Waiting until ${SB.untilTime(wt.until)}` : 'Waiting for your OK in its conversation' }),
      h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => go('run', { runId: last.id }) }, 'Open the run'));
  }

  async function answer(runId, key, choice) {
    let res;
    try { res = await api.answerRun(runId, key, choice); } catch { res = { ok: false, error: 'Couldn\'t send that. Try again.' }; }
    SB.toast(res?.ok ? `Answered “${choice}”` : res?.error || 'Couldn\'t send that.');
  }

  async function setEnabled(w, input) {
    const enabled = input.checked;
    let res;
    try { res = await api.saveWorkflow({ ...toDef(w), enabled }); } catch { res = { ok: false, errors: [{ message: 'Couldn\'t save. Try again.' }] }; }
    if (res?.ok) {
      if (res.view) applyView(res.view);
      SB.toast(enabled ? `“${w.name}” is on` : `“${w.name}” is off`);
    } else {
      input.checked = !enabled;
      SB.toast(normErrors(res?.errors).map(e => e.message).join(' ') || 'Couldn\'t save that.');
    }
  }

  function rowMenu(w, anchor) {
    popup(anchor, () => [
      menuItem('Edit', null, () => openEditor(toDef(w))),
      menuItem('Runs', w.lastRun ? `Last ${SB.relTime(w.lastRun.startedAt)}` : 'None yet', () => go('runs', { id: w.id, name: w.name })),
      menuItem('Duplicate', 'Opens a copy in the editor', () => openEditor(duplicateOf(w), { title: 'Copy of a workflow' })),
      menuItem('Export', 'Copies it as JSON', () => exportWorkflow(w)),
      h('div', { class: 'menu-sep' }),
      menuItem('Delete', null, () => deleteWorkflow(w)),
    ]);
  }

  function duplicateOf(w) {
    const d = toDef(w);
    delete d.id;
    delete d.createdAt;
    d.name = `${w.name} copy`.slice(0, 60);
    // A web hook's token is its address: a copy gets its own when it's saved.
    d.when = (d.when || []).map(t => { const c = { ...t }; delete c.token; return c; });
    return d;
  }

  async function exportWorkflow(w) {
    let res;
    try { res = await api.exportWorkflow(w.id); } catch { res = { ok: false }; }
    SB.toast(res?.ok ? `Copied “${w.name}” as JSON` : res?.error || 'Couldn\'t copy it.');
  }

  async function deleteWorkflow(w) {
    const def = toDef(w);
    let v;
    try { v = await api.deleteWorkflow(w.id); } catch { SB.toast('Couldn\'t delete it. Try again.'); return; }
    if (v) applyView(v);
    SB.toast(`Deleted “${w.name}”`, {
      action: 'Undo', ms: 6000,
      onAction: async () => {
        let res;
        try { res = await api.saveWorkflow(def); } catch { res = { ok: false }; }
        if (res?.ok && res.view) applyView(res.view);
        SB.toast(res?.ok ? `“${w.name}” is back` : 'Couldn\'t bring it back.');
      },
    });
  }

  // ------------------------------------------------------------ running by hand

  function startRun(w) {
    if (w.inputs?.length) {
      runFormFor = runFormFor === w.id ? null : w.id;
      runValues = Object.fromEntries(w.inputs.map(i => [i.name, i.default || '']));
      fillList();
      if (runFormFor) requestAnimationFrame(() => list.rows.querySelector('.wf-runform .field')?.focus());
      return;
    }
    runNow(w, {});
  }

  async function runNow(w, inputs) {
    let res;
    try { res = await api.runWorkflow(w.id, inputs); } catch { res = { ok: false, error: 'Couldn\'t start it. Try again.' }; }
    if (!res?.ok) { SB.toast(res?.error || 'Couldn\'t start it.'); return false; }
    SB.toast(`Started “${w.name}”`, { action: 'Watch', onAction: () => go('run', { runId: res.runId }) });
    return true;
  }

  function runForm(w) {
    const err = h('p', { class: 'wf-err', role: 'alert', hidden: true });
    const fields = w.inputs.map(i => {
      const id = uid('in');
      const el = h('input', { class: 'field', id, type: 'text', autocomplete: 'off', spellcheck: 'false', required: i.required, 'data-fk': `rv-${w.id}-${i.name}`, oninput: e => { runValues[i.name] = e.target.value; } });
      el.value = runValues[i.name] ?? '';
      return h('div', { class: 'wf-field' }, h('label', { class: 'field-label', for: id, text: `${i.label || i.name}${i.required ? '' : ' (optional)'}` }), el);
    });
    return h('form', {
      class: 'wf-runform', novalidate: true, 'aria-label': `Run “${w.name}”`,
      onsubmit: async e => {
        e.preventDefault();
        const missing = w.inputs.filter(i => i.required && !String(runValues[i.name] || '').trim());
        if (missing.length) { err.hidden = false; err.textContent = `Fill in ${missing.map(i => i.label || i.name).join(', ')}.`; return; }
        if (await runNow(w, { ...runValues })) { runFormFor = null; fillList(); }
      },
      onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); runFormFor = null; fillList(); focusFk(`run-${w.id}`); } },
    },
    fields, err,
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => { runFormFor = null; fillList(); focusFk(`run-${w.id}`); } }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary slim-btn' }, 'Start')));
  }

  // ------------------------------------------------------------ templates

  function fillGallery() {
    const templates = state.workflows?.templates || [];
    if (!templates.length) { fill(list.gallery); return; }
    const cards = h('div', { class: 'templates' }, templates.map(t => h('button', {
      class: 'template wf-template', type: 'button', 'data-fk': `tpl-${t.key}`,
      onclick: () => openEditor(clone(t.workflow), { title: t.name }),
    },
    h('span', { class: 'wf-template-icon', 'aria-hidden': 'true', text: t.icon || '⚡' }),
    h('span', { class: 'wf-template-text' }, h('b', { text: t.name }), h('span', { text: t.description || '' })))));
    if (!workflows().length) {
      fill(list.gallery, h('p', { class: 'wf-empty', text: 'No workflows yet. Start from one of these:' }), cards);
      return;
    }
    const open = list.gallery.querySelector('details')?.open;
    fill(list.gallery, h('details', { class: 'wf-disclosure', open: !!open }, h('summary', { text: 'Start from a template' }), cards));
  }

  // ------------------------------------------------------------ secrets

  let secretError = '';
  function fillSecrets() {
    const names = state.workflows?.secrets || [];
    const nameId = uid('sname');
    const valueId = uid('sval');
    const nameEl = h('input', { class: 'field wf-mono', id: nameId, maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: 'GITHUB_TOKEN', 'data-fk': 'secret-name', oninput: e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); } });
    const valueEl = h('input', { class: 'field', id: valueId, type: 'password', autocomplete: 'off', 'data-fk': 'secret-value' });
    const err = h('p', { class: 'wf-err', role: 'alert', hidden: !secretError, text: secretError });
    fill(list.secrets, 
      h('h3', { id: 'wfSecretsTitle', class: 'wf-h3', text: 'Secrets' }),
      h('p', { class: 'field-hint' }, 'Use as ', h('code', { text: '{{ secrets.NAME }}' }), ' in commands and web requests. Kept encrypted by Windows.'),
      names.length ? h('ul', { class: 'wf-secret-list' }, names.map(n => h('li', {},
        h('code', { text: n }), h('span', { class: 'wf-dots', 'aria-hidden': 'true', text: '••••••' }),
        iconBtn('close', `Delete the secret ${n}`, () => deleteSecret(n), { 'data-fk': `sdel-${n}` })))) : null,
      h('form', {
        class: 'wf-secret-add', novalidate: true,
        onsubmit: async e => {
          e.preventDefault();
          const name = nameEl.value.trim();
          if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(name)) { showSecretError('Names are capitals, digits and _, starting with a letter (like GITHUB_TOKEN).', nameEl); return; }
          if (!valueEl.value) { showSecretError('Type the secret itself.', valueEl); return; }
          let v;
          try { v = await api.setWorkflowSecret(name, valueEl.value); } catch { showSecretError('Couldn\'t save it. Try again.', valueEl); return; }
          valueEl.value = '';
          secretError = '';
          if (v) applyView(v);
          SB.toast(`Saved the secret ${name}`);
          focusFk('secret-name');
        },
      },
      h('div', { class: 'wf-field' }, h('label', { class: 'field-label', for: nameId, text: 'Name' }), nameEl),
      h('div', { class: 'wf-field' }, h('label', { class: 'field-label', for: valueId, text: 'Value' }), valueEl),
      h('button', { type: 'submit', class: 'btn slim-btn', 'data-fk': 'secret-add' }, 'Add')),
      err);
    function showSecretError(text, el) { secretError = text; err.hidden = false; err.textContent = text; el.focus(); }
  }

  async function deleteSecret(name) {
    let v;
    try { v = await api.deleteWorkflowSecret(name); } catch { SB.toast('Couldn\'t delete it. Try again.'); return; }
    if (v) applyView(v);
    SB.toast(`Deleted the secret ${name}`);
  }

  // ------------------------------------------------------------ import

  function openImport() {
    const returnTo = document.activeElement;
    const titleId = uid('imp');
    const taId = uid('impta');
    const ta = h('textarea', { class: 'field area wf-json', id: taId, rows: 10, spellcheck: 'false', placeholder: '{ "name": "…", "steps": [ … ] }' });
    const err = h('p', { class: 'wf-err', role: 'alert', hidden: true });
    const go2 = h('button', { type: 'button', class: 'btn primary', onclick: doImport }, 'Open in the editor');
    const sheet = h('div', {
      class: 'card-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
      onmousedown: e => { if (e.target === sheet) close(); },
      onkeydown: e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Tab') trapTab(e, sheet);
      },
    },
    h('div', { class: 'card-box wf-import' },
      h('div', { class: 'card-head' }, h('h2', { id: titleId, text: 'Import a workflow' }), iconBtn('close', 'Close', () => close())),
      h('label', { class: 'field-label', for: taId, text: 'Paste a workflow\'s JSON' }),
      ta,
      h('p', { class: 'field-hint', text: 'It opens in the editor first. Nothing is saved until you press Save.' }),
      err,
      h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), go2)));
    document.body.append(sheet);
    ta.focus();
    async function doImport() {
      if (!ta.value.trim()) { err.hidden = false; err.textContent = 'Paste the JSON first.'; ta.focus(); return; }
      go2.disabled = true;
      let res;
      try { res = await api.importWorkflow(ta.value); } catch { res = { ok: false, error: 'Couldn\'t read that. Try again.' }; }
      go2.disabled = false;
      if (!res?.ok) { err.hidden = false; err.textContent = res?.error || 'That isn\'t a workflow Shellby can read.'; ta.focus(); return; }
      close(false);
      openEditor(res.workflow, { title: 'Imported workflow' });
    }
    function close(refocus = true) {
      sheet.remove();
      if (refocus && returnTo?.isConnected) returnTo.focus();
    }
  }

  function trapTab(e, box) {
    const f = [...box.querySelectorAll('button:not(:disabled), textarea, input, select')].filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ================================================================ the editor: model

  const ed = {
    def: null, title: '', isNew: true, dirty: false, touched: false,
    errors: [], failedSave: false, saving: false, json: false, jsonText: '', jsonError: '',
    layout: pref(PREF.layout, 'map'), // 'map' or 'list'
    sel: null,                        // the map node the inspector shows: 's<n>', 't<n>', 'manual', 'settings'
    map: null,                        // the map on screen, while there is one
    chat: null,                       // Build it with Claude (wf-chat.js), one per editor session
    trial: false,                     // saved only by Claude's test runs so far: kept switched off until you Save
  };
  const mapOn = () => !ed.json && ed.layout === 'map';
  const stepSel = s => `s${keyOf(s)}`;
  const trigSel = t => `t${keyOf(t)}`;
  // Where focus goes after a rebuild, in whichever layout is showing.
  const stepFk = s => (mapOn() ? `node-${stepSel(s)}` : `t-${keyOf(s)}`);
  const trigFk = t => (mapOn() ? `node-${trigSel(t)}` : `tr-${keyOf(t)}`);
  const openSteps = new WeakSet();
  const openAdvanced = new WeakSet();
  const waitUnits = new WeakMap();
  const serials = new WeakMap();
  let serialN = 0;
  const keyOf = obj => { if (!serials.has(obj)) serials.set(obj, ++serialN); return serials.get(obj); };

  function blankWorkflow() {
    return { name: '', description: '', enabled: true, cwd: '', concurrency: 'skip', inputs: [], when: [], steps: [] };
  }

  const STEP_DEFAULTS = {
    claude: () => ({ prompt: '', mode: 'smart' }),
    run: () => ({ command: '' }),
    http: () => ({ method: 'GET', url: '' }),
    file: () => ({ action: 'read', path: '' }),
    ask: () => ({ question: '' }),
    tell: () => ({ to: 'notification', text: '' }),
    if: () => ({ test: '', then: [], else: [] }),
    each: () => ({ over: '', as: 'item', max: 25, steps: [] }),
    set: () => ({ values: {} }),
    wait: () => ({ seconds: 300 }),
    workflow: () => ({ name: '' }),
    stop: () => ({ status: 'ok' }),
    worktree: () => ({ repo: '{{ trigger.repo }}', branch: '' }),
    pr: () => ({ folder: '', title: '', draft: true }),
  };

  const TRIGGER_DEFAULTS = {
    schedule: () => ({ schedule: { type: 'daily', time: '09:00' } }),
    ci: () => ({ on: 'failed', repo: '' }),
    issue: () => ({ on: 'any', repo: '' }),
    shipped: () => ({ kind: 'any', project: '' }),
    task: () => ({ outcome: 'any' }),
    folder: () => ({ path: '', pattern: '', events: 'added' }),
    workflow: () => ({ name: '', status: 'any' }),
  };

  function walk(steps, fn) {
    for (const s of steps || []) {
      fn(s);
      for (const k of CONTAINERS[s.type] || []) walk(s[k], fn);
    }
  }

  function countSteps() { let n = 0; walk(ed.def.steps, () => { n++; }); return n; }

  function takenIds() {
    const taken = new Set();
    walk(ed.def?.steps, s => { if (s.id) taken.add(s.id); });
    return taken;
  }

  // claude1, run2…: the same scheme the validator uses, so ids never jump on save.
  function nameSteps(steps, taken) {
    walk(steps, s => {
      if (s.id) return;
      let n = 0;
      let id;
      do { id = `${s.type}${++n}`; } while (taken.has(id));
      taken.add(id);
      s.id = id;
    });
  }

  function normalise(def) {
    const d = clone(def && typeof def === 'object' && !Array.isArray(def) ? def : {});
    for (const k of ['inputs', 'when', 'steps']) if (!Array.isArray(d[k])) d[k] = [];
    walk(d.steps, s => { for (const k of CONTAINERS[s.type] || []) if (!Array.isArray(s[k])) s[k] = []; });
    const taken = new Set();
    walk(d.steps, s => { if (s.id) taken.add(s.id); });
    nameSteps(d.steps, taken);
    return d;
  }

  function newStep(type) {
    const s = { type, ...STEP_DEFAULTS[type]() };
    nameSteps([s], takenIds());
    return s;
  }

  function copyStep(step) {
    const c = clone(step);
    walk([c], s => { delete s.id; });
    nameSteps([c], takenIds());
    return c;
  }

  // ================================================================ the editor: opening and leaving

  function openEditor(def, { title, note = null } = {}) {
    const d = normalise(def);
    // A blank new one shows its problems once you start; anything with content is checked straight away.
    const blank = !d.id && !d.name && !d.steps.length && !d.when.length;
    Object.assign(ed, {
      // What Claude said about a draft or a fix opens the chat, so you can carry on from it.
      def: d, isNew: !d.id, dirty: (!d.id && !blank) || !!note, touched: false,
      errors: [], failedSave: false, saving: false, json: false, jsonText: '', jsonError: '',
      title: title || (d.id ? `Edit “${d.name || 'workflow'}”` : 'New workflow'), sel: null, map: null, trial: false,
    });
    const host = chatHost();
    ed.chat = SB.wfChat.create(host, { greeting: note || '' });
    host.bind(ed.chat);
    if (d.steps.length === 1) openSteps.add(d.steps[0]);
    if (current().name === 'editor') nav.pop();
    go('editor');
    if (!blank) validateSoon.now();
    if (blank) requestAnimationFrame(() => focusFk('wf-name'));
  }

  function leaveEditor(then) {
    if (!ed.dirty) { validateSoon.cancel(); return then(); }
    SB.toast('You have changes that aren\'t saved.', {
      action: 'Discard them', ms: 5000,
      onAction: () => { ed.dirty = false; validateSoon.cancel(); then(); },
    });
  }

  let mapFrame = 0;
  function changed() {
    ed.dirty = true;
    ed.touched = true;
    validateSoon();
    // The map's nodes say what their steps do: keep them in step with what you type.
    cancelAnimationFrame(mapFrame);
    mapFrame = requestAnimationFrame(() => { if (ed.map?.el.isConnected) ed.map.update(); });
  }

  // Structural changes (add, move, delete, a different schedule kind) rebuild the editor.
  function rebuild(focus) {
    keepFocus(renderEditor);
    if (focus && !focusFk(focus)) focusFallback(focus);
  }
  function focusFallback(fk) {
    const m = /^(?:up|dn)-(\d+)$/.exec(fk);
    if (m) focusFk(`t-${m[1]}`);
  }

  // ================================================================ the editor: validation

  let validateSeq = 0;
  async function validate() {
    if (!ed.def || current().name !== 'editor') return;
    const seq = ++validateSeq;
    let res;
    try { res = await api.validateWorkflow(ed.def); } catch { return; }
    if (seq !== validateSeq || !res) return;
    ed.errors = res.ok ? [] : normErrors(res.errors);
    if (!ed.errors.length) ed.failedSave = false;
    paintErrors();
  }
  const validateSoon = debounce(validate, 400);
  validateSoon.now = () => { validateSoon.cancel(); validate(); };

  const normErrors = errs => (Array.isArray(errs) ? errs : errs ? [errs] : [])
    .map(e => (typeof e === 'string' ? { path: '', message: e } : { path: String(e?.path || ''), message: String(e?.message || '') }))
    .filter(e => e.message);

  // Error slots: validator path -> the message under that field.
  let slots = new Map();
  let cards = [];

  const parentPath = p => p.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
  const within = (p, at) => p === at || p.startsWith(`${at}.`) || p.startsWith(`${at}[`);

  function findSlot(path) {
    let p = path;
    while (p) {
      if (slots.has(p)) return slots.get(p);
      const up1 = parentPath(p);
      if (up1 === p) break;
      p = up1;
    }
    return null;
  }

  function paintErrors() {
    for (const s of slots.values()) { s.err.hidden = true; s.err.textContent = ''; s.control?.removeAttribute('aria-invalid'); }
    const loose = [];
    for (const e of ed.errors) {
      const slot = findSlot(e.path);
      if (!slot) { loose.push(e); continue; }
      slot.err.hidden = false;
      slot.err.textContent = slot.err.textContent ? `${slot.err.textContent} ${e.message}` : e.message;
      slot.control?.setAttribute('aria-invalid', 'true');
    }
    for (const c of cards) c.el.classList.toggle('has-err', ed.errors.some(e => within(e.path, c.at)));
    paintSummary(loose);
  }

  function paintSummary(loose) {
    const box = $('wfSummary');
    if (!box) return;
    const items = loose.map(e => h('li', {}, describeAt(e.path) ? h('b', { text: `${describeAt(e.path)}: ` }) : null, e.message));
    const marked = ed.errors.length - loose.length;
    const head = ed.failedSave && ed.errors.length
      ? (marked ? `Not saved yet. ${plural(ed.errors.length, 'thing')} to fix, marked ${mapOn() ? 'on the map' : 'below'}.` : 'Not saved yet.')
      : null;
    box.hidden = !items.length && !head;
    fill(box, head ? h('p', { class: 'wf-summary-head', text: head }) : null, items.length ? h('ul', {}, items) : null);
  }

  const pathTokens = path => [...String(path).matchAll(/([A-Za-z_]+)|\[(\d+)\]/g)].map(m => (m[2] !== undefined ? Number(m[2]) : m[1]));

  // The innermost step a validator path points into: "steps[2].then[0].prompt" -> that step.
  function stepAt(tokens) {
    if (tokens[0] !== 'steps') return null;
    let node = ed.def;
    let found = null;
    for (const t of tokens) {
      node = node?.[t];
      if (node && typeof node === 'object' && !Array.isArray(node) && node.type) found = node;
    }
    return found;
  }

  // "steps[2].then[0].prompt" -> "“Fix it”", for errors with no field to sit under.
  function describeAt(path) {
    const tokens = pathTokens(path);
    if (tokens[0] === 'when' && typeof tokens[1] === 'number') return `Trigger ${tokens[1] + 1}`;
    if (tokens[0] === 'inputs' && typeof tokens[1] === 'number') return `Input ${tokens[1] + 1}`;
    const found = stepAt(tokens);
    return found ? `“${found.label || found.id || STEP_INFO[found.type]?.name}”` : '';
  }

  // The map node that holds a problem, so a failed save can open it.
  function selFor(path) {
    const tokens = pathTokens(path);
    const step = stepAt(tokens);
    if (step) return stepSel(step);
    const t = tokens[0] === 'when' && ed.def.when[tokens[1]];
    if (t) return trigSel(t);
    if (tokens[0] === 'inputs') return 'manual';
    return ['description', 'cwd', 'concurrency'].includes(tokens[0]) ? 'settings' : null;
  }

  // ================================================================ the editor: field builders

  function slot(at, control) {
    const err = h('p', { class: 'wf-err', id: uid('err'), hidden: true });
    if (at) slots.set(at, { err, control });
    if (control) control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), err.id].filter(Boolean).join(' '));
    return err;
  }

  function wrap(labelText, control, { at, hint, insert, cls = '' } = {}) {
    if (!control.id) control.id = uid('f');
    let hintEl = null;
    if (hint) {
      hintEl = h('p', { class: 'field-hint', id: uid('hint'), text: hint });
      control.setAttribute('aria-describedby', hintEl.id);
    }
    const err = slot(at, control);
    const body = insert ? h('div', { class: 'wf-with-insert' }, control, insertBtn(control, insert, labelText)) : control;
    return h('div', { class: `wf-field ${cls}` }, h('label', { class: 'field-label', for: control.id, text: labelText }), body, hintEl, err);
  }

  function textControl(tag, value, onChange, attrs = {}) {
    const el = h(tag, { class: tag === 'textarea' ? 'field area' : 'field', autocomplete: 'off', spellcheck: 'false', ...(tag === 'input' ? { type: 'text' } : {}), ...attrs });
    el.value = value ?? '';
    el.addEventListener('input', () => { onChange(el.value); changed(); });
    return el;
  }
  const txt = (label, value, onChange, opts = {}) => wrap(label, textControl('input', value, onChange, opts.attrs), opts);
  const area = (label, value, onChange, opts = {}) => wrap(label, textControl('textarea', value, onChange, { rows: 3, ...opts.attrs }), opts);

  function num(label, value, onChange, opts = {}) {
    const el = h('input', { class: 'field', type: 'number', inputmode: 'numeric', ...opts.attrs });
    el.value = value ?? '';
    el.addEventListener('input', () => { onChange(toInt(el.value)); changed(); });
    return wrap(label, el, opts);
  }

  // options: [[value, label, disabled?]] or [{ group, options }]
  function selectControl(options, value, onChange, attrs = {}) {
    const opt = ([v, l, dis]) => h('option', { value: v, text: l, disabled: !!dis });
    const el = h('select', { class: 'field', ...attrs },
      options.map(o => (Array.isArray(o) ? opt(o) : h('optgroup', { label: o.group }, o.options.map(opt)))));
    el.value = value ?? '';
    el.addEventListener('change', () => { onChange(el.value); changed(); });
    return el;
  }
  const sel = (label, options, value, onChange, opts = {}) => wrap(label, selectControl(options, value, onChange, opts.attrs), opts);

  function check(label, checked, onChange, { hint, at } = {}) {
    const input = h('input', { type: 'checkbox', checked: !!checked, onchange: e => { onChange(e.target.checked); changed(); } });
    const hintEl = hint ? h('span', { class: 'field-hint', text: hint }) : null;
    return h('div', { class: 'wf-field' },
      h('label', { class: 'wf-check' }, input, h('span', {}, h('span', { text: label }), hintEl)),
      at ? slot(at, input) : null);
  }

  function folderField(label, value, onChange, { at, placeholder, hint } = {}) {
    const input = textControl('input', value, onChange, { placeholder });
    input.id = uid('dir');
    const choose = h('button', {
      type: 'button', class: 'btn slim-btn', 'aria-label': `Choose a folder for ${label.toLowerCase()}`,
      onclick: async () => {
        const dir = await api.pickAnyFolder();
        if (!dir) return;
        input.value = dir;
        onChange(dir);
        changed();
      },
    }, 'Choose…');
    const clear = h('button', {
      type: 'button', class: 'btn ghost slim-btn', 'aria-label': `Clear ${label.toLowerCase()}`,
      onclick: () => { input.value = ''; onChange(''); changed(); input.focus(); },
    }, 'Clear');
    const hintEl = hint ? h('p', { class: 'field-hint', id: uid('hint'), text: hint }) : null;
    if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
    const err = slot(at, input);
    return h('div', { class: 'wf-field' },
      h('label', { class: 'field-label', for: input.id, text: label }),
      h('div', { class: 'wf-folder' }, input, choose, clear), hintEl, err);
  }

  // A list of rows (inputs, headers, values, output fields…). Rows live in a
  // local array; every edit hands the whole list back through onChange.
  function rowsEditor({ legend, rows, columns, onChange, at, addText, hint, max = 20, blank }) {
    const box = h('div', { class: 'wf-rows' });
    const addBtn = h('button', { type: 'button', class: 'btn ghost slim-btn wf-add-row', onclick: () => { rows.push(blank()); emit(); draw(rows.length - 1); } }, `+ ${addText}`);
    const emit = () => { onChange(rows); changed(); addBtn.disabled = rows.length >= max; };
    function draw(focusRow = -1) {
      fill(box, ...rows.map((r, i) => rowEl(r, i)));
      addBtn.disabled = rows.length >= max;
      if (focusRow >= 0) box.children[focusRow]?.querySelector('input, select')?.focus();
    }
    function rowEl(r, i) {
      const cells = columns.map(c => cell(c, r, i));
      return h('div', { class: 'wf-row-edit', style: `--cols: ${columns.map(c => c.width || '1fr').join(' ')} auto` }, cells,
        iconBtn('close', `Remove ${(r[columns[0].key] || `row ${i + 1}`)}`, () => { rows.splice(i, 1); emit(); draw(); (box.children[Math.min(i, rows.length - 1)]?.querySelector('input') || addBtn).focus(); }));
    }
    function cell(c, r, i) {
      const label = `${c.label} ${i + 1}`;
      if (c.kind === 'check') {
        return h('label', { class: 'wf-check small' }, h('input', { type: 'checkbox', checked: !!r[c.key], onchange: e => { r[c.key] = e.target.checked; emit(); } }), h('span', { text: c.label }));
      }
      if (c.kind === 'select') {
        return h('select', { class: 'field', 'aria-label': label, onchange: e => { r[c.key] = e.target.value; emit(); } },
          c.options.map(o => h('option', { value: o, text: o, selected: r[c.key] === o })));
      }
      const input = h('input', { class: `field${c.mono ? ' wf-mono' : ''}`, type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': label, placeholder: c.placeholder || '', oninput: e => { r[c.key] = e.target.value; emit(); } });
      input.value = r[c.key] ?? '';
      return c.insert ? h('div', { class: 'wf-with-insert' }, input, insertBtn(input, c.insert, label)) : input;
    }
    draw();
    const legendId = uid('lg');
    const hintEl = hint ? h('p', { class: 'field-hint', text: hint }) : null;
    return h('div', { class: 'wf-field', role: 'group', 'aria-labelledby': legendId },
      h('div', { class: 'field-label', id: legendId, text: legend }), hintEl, box, addBtn, slot(at, null));
  }

  // { name: value } <-> rows
  const objRows = obj => Object.entries(obj || {}).map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v) }));
  const rowsObj = rows => Object.fromEntries(rows.filter(r => String(r.k || '').trim()).map(r => [r.k.trim(), r.v ?? '']));

  // ================================================================ the editor: insert value

  // What a templated field can refer to from where it sits: the trigger's
  // data, inputs, earlier steps' outputs, values set earlier, the loop it's in.
  function refsAt(ctx, { secrets }) {
    const groups = [];
    const d = ed.def;
    const add = (title, items) => { if (items.length) groups.push({ title, items }); };

    const trig = [];
    const seen = new Set();
    for (const t of d.when) {
      if (t.type === 'webhook' && !seen.has('webhook')) trig.push({ path: 'trigger.', sub: 'Any field of the JSON a script sends', partial: true });
      for (const [f, sub] of Object.entries(TRIGGER_FIELDS[t.type] || {})) {
        if (seen.has(`trigger.${f}`)) continue;
        seen.add(`trigger.${f}`);
        trig.push({ path: `trigger.${f}`, sub });
      }
      seen.add(t.type);
    }
    add('What started it', trig);
    add('Inputs', d.inputs.filter(i => i.name).map(i => ({ path: `inputs.${i.name}`, sub: i.label || '' })));

    const earlier = [];
    if (ctx) for (const { list: l, index } of ctx.chain) walk(l.slice(0, index), s => earlier.push(s));
    const outs = [];
    const vars = [];
    for (const s of earlier) {
      if (!s.id) continue;
      const fields = STEP_OUTPUTS[s.type]?.(s) || {};
      const who = s.label || STEP_INFO[s.type]?.name;
      for (const [f, sub] of Object.entries(fields)) outs.push({ path: `${s.id}.${f}`, sub: `${who}: ${sub}` });
      if (s.type === 'set') for (const k of Object.keys(s.values || {})) vars.push({ path: `vars.${k}`, sub: who });
    }
    add('Earlier steps', outs);
    add('Values', vars);

    const loops = [];
    if (ctx) {
      for (const { list: l, index } of ctx.chain.slice(0, -1)) {
        const a = l[index];
        if (a?.type === 'each') loops.push({ path: a.as || 'item', sub: 'This item' });
      }
      if (loops.length) loops.push({ path: 'loop.index', sub: 'Its position, from 0' }, { path: 'loop.number', sub: 'Its position, from 1' });
    }
    add('This loop', loops);
    add('Run', [{ path: 'now', sub: 'The date and time' }, { path: 'today', sub: 'Today, like 2026-10-03' }, { path: 'run.id', sub: 'This run' }]);
    if (secrets) add('Secrets', (state.workflows?.secrets || []).map(n => ({ path: `secrets.${n}`, sub: 'Kept out of the run\'s record' })));
    return groups;
  }

  function insertBtn(control, opts, labelText) {
    const btn = h('button', {
      type: 'button', class: 'icon-btn wf-insert', title: 'Insert a value', 'aria-label': `Insert a value into ${labelText}`,
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => popup(btn, () => {
        const groups = refsAt(opts.ctx, opts);
        if (!groups.length) return [menuLabel('Nothing to insert here yet')];
        return groups.flatMap(g => [menuLabel(g.title), ...g.items.map(it => menuItem(it.path, it.sub, () => insertRef(control, it, opts.cond), { mono: true }))]);
      }),
    }, h('span', { class: 'wf-braces', 'aria-hidden': 'true', text: '{ }' }));
    return btn;
  }

  function insertRef(control, item, cond) {
    const text = cond ? item.path : `{{ ${item.path} }}`;
    control.focus();
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? start;
    control.setRangeText(text, start, end, 'end');
    if (item.partial && !cond) { const p = control.selectionEnd - 3; control.setSelectionRange(p, p); }
    control.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ================================================================ the editor: screen

  function renderEditor() {
    slots = new Map();
    cards = [];
    ed.map = null;
    const d = ed.def;
    setMapMode(mapOn());
    fill(screen,
      h('div', { class: 'view-head' },
        backBtn(),
        h('h2', { class: 'wf-title', text: ed.title }),
        ed.json ? null : layoutSwitch(ed.layout, v => { ed.layout = v; setPref(PREF.layout, v); rebuild(`lay-${v}`); }, 'Show the workflow as'),
        h('button', {
          type: 'button', class: 'btn ghost slim-btn wf-json-toggle', 'aria-pressed': String(ed.json),
          title: 'See and edit the whole workflow as text', onclick: toggleJson,
        }, 'JSON')),
      h('div', { class: 'wf-summary', id: 'wfSummary', role: 'status', 'aria-live': 'polite', hidden: true }),
      // The chat sits beside the workflow when there's room, under it when not. It's the same
      // element every time, so a rebuild keeps the conversation and whatever you're typing.
      h('div', { class: 'wf-work' },
        ed.json ? jsonPane()
          : mapOn() ? mapPane(d)
            : h('div', { class: 'wf-editor' }, basicsSection(d), inputsSection(d), whenSection(d), stepsSection(d)),
        ed.chat?.el),
      editorFoot());
    paintErrors();
  }

  function editorFoot() {
    return h('div', { class: 'wf-foot' },
      h('p', { class: 'field-hint', text: ed.isNew ? 'Nothing is saved until you press Save.' : 'Saving replaces the workflow as it is now.' }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost', onclick: up }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary', id: 'wfSave', disabled: ed.saving, onclick: save }, ed.saving ? 'Saving…' : 'Save')));
  }

  const nameField = (d, cls) => txt('Name', d.name, v => { d.name = v; }, { at: 'name', cls, attrs: { maxlength: 60, placeholder: 'Red build fixer', 'data-fk': 'wf-name' } });

  // Description, folder and concurrency: in the list's first section, or the map's Settings.
  const aboutFields = d => [
    area('Description', d.description, v => { d.description = v; }, { at: 'description', attrs: { rows: 2, maxlength: 500, placeholder: 'Optional: what it\'s for' } }),
    folderField('Default folder', d.cwd, v => { d.cwd = v; }, { at: 'cwd', placeholder: 'Shellby\'s current folder', hint: 'Where Claude and commands work, unless a step says otherwise.' }),
    concurrencyField(d),
  ];

  function basicsSection(d) {
    return h('section', { class: 'wf-section', 'aria-label': 'About it' }, nameField(d), aboutFields(d));
  }

  function concurrencyField(d) {
    const name = uid('conc');
    const radio = (value, label) => h('label', { class: 'wf-radio' },
      h('input', { type: 'radio', name, value, checked: (d.concurrency || 'skip') === value, onchange: () => { d.concurrency = value; changed(); } }),
      h('span', { text: label }));
    return h('fieldset', { class: 'wf-fieldset' },
      h('legend', { class: 'field-label', text: 'If it\'s already running when triggered' }),
      h('div', { class: 'seg wf-seg' }, radio('skip', 'Skip'), radio('queue', 'Queue')),
      slot('concurrency', null));
  }

  function sectionHead(title, lede, at) {
    return [h('h3', { class: 'wf-h3', text: title }), lede ? h('p', { class: 'field-hint wf-lede', text: lede }) : null, at ? slot(at, null) : null];
  }

  function inputsSection(d) {
    return h('section', { class: 'wf-section' },
      sectionHead('Inputs', 'Asked for when it\'s run by hand, by Claude Code or by another workflow. Use them as {{ inputs.name }}.', null),
      rowsEditor({
        legend: 'Inputs', rows: d.inputs, at: 'inputs', addText: 'Add an input', max: MAX.inputs,
        blank: () => ({ name: '', label: '', default: '', required: false }),
        columns: [
          { key: 'name', label: 'Name', placeholder: 'branch', mono: true },
          { key: 'label', label: 'Label', placeholder: 'Branch' },
          { key: 'default', label: 'Default', placeholder: 'main' },
          { key: 'required', label: 'Required', kind: 'check', width: 'auto' },
        ],
        onChange: rows => { d.inputs = rows; },
      }));
  }

  // ------------------------------------------------------------ When

  function whenSection(d) {
    const addBtn = h('button', {
      type: 'button', class: 'btn slim-btn wf-add', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': 'add-trigger', disabled: d.when.length >= MAX.triggers,
      onclick: () => popup(addBtn, () => triggerMenu(d)),
    }, '+ Add a trigger');
    return h('section', { class: 'wf-section' },
      sectionHead('When', 'What starts it. Every workflow can also be run by hand.', 'when'),
      h('ul', { class: 'wf-cards', 'aria-label': 'Triggers' }, d.when.map((t, i) => triggerCard(t, i))),
      d.when.length ? null : h('p', { class: 'wf-empty small', text: 'No triggers: it runs only when you start it.' }),
      addBtn);
  }

  const triggerMenu = d => Object.entries(TRIGGER_INFO).map(([type, info]) => menuItem(info.name, info.sub, () => addTrigger(type), {
    glyph: icon('trigger'), disabled: ONCE_TRIGGERS.includes(type) && d.when.some(t => t.type === type),
  }));

  function addTrigger(type) {
    const t = { type, ...(TRIGGER_DEFAULTS[type]?.() || {}) };
    ed.def.when.push(t);
    changed();
    if (!mapOn()) { rebuild(`tr-${keyOf(t)}`); return; }
    ed.sel = trigSel(t);
    rebuild();
    focusInspector();
  }

  function removeTrigger(i) {
    const t = ed.def.when[i];
    if (!t) return;
    const info = TRIGGER_INFO[t.type] || { name: t.type };
    if (ed.sel === trigSel(t)) ed.sel = null;
    ed.def.when.splice(i, 1);
    changed();
    rebuild(ed.def.when.length ? trigFk(ed.def.when[Math.min(i, ed.def.when.length - 1)]) : 'add-trigger');
    SB.toast(`Removed “${info.name}”`, { action: 'Undo', onAction: () => { ed.def.when.splice(i, 0, t); changed(); rebuild(trigFk(t)); } });
  }

  function triggerCard(t, i) {
    const at = `when[${i}]`;
    const info = TRIGGER_INFO[t.type] || { name: t.type };
    const k = keyOf(t);
    const li = h('li', { class: 'wf-card wf-trigger' },
      h('div', { class: 'wf-card-head' },
        h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon('trigger')),
        h('h4', { class: 'wf-card-title', tabindex: '-1', 'data-fk': `tr-${k}`, text: info.name }),
        iconBtn('close', `Remove the trigger “${info.name}”`, () => removeTrigger(i))),
      h('div', { class: 'wf-card-body' }, triggerFields(t, at)),
      slot(at, null));
    cards.push({ at, el: li });
    return li;
  }

  function triggerFields(t, at) {
    switch (t.type) {
      case 'schedule': return scheduleFields(t, at);
      case 'ci': return [
        sel('When a build', [['failed', 'fails'], ['fixed', 'goes green again'], ['passed', 'passes'], ['merged', 'is merged'], ['review', 'needs your review'], ['any', 'changes at all']], t.on || 'failed', v => { t.on = v; }, { at: `${at}.on` }),
        txt('Repository (optional)', t.repo, v => { t.repo = v; }, { at: `${at}.repo`, attrs: { placeholder: 'owner/name' }, hint: 'Leave empty for every repository Shellby watches.' }),
      ];
      case 'issue': return [
        sel('When an issue is', [['any', 'assigned to me or labelled shellby'], ['assigned', 'assigned to me'], ['labelled', 'labelled shellby']], t.on || 'any', v => { t.on = v; }, { at: `${at}.on`, hint: 'The label counts in your own repositories and the ones cloned on this PC. Needs “Offer to take on issues” in Settings → GitHub.' }),
        txt('Repository (optional)', t.repo, v => { t.repo = v; }, { at: `${at}.repo`, attrs: { placeholder: 'owner/name' }, hint: 'Leave empty for every repository.' }),
      ];
      case 'shipped': return [
        sel('What ships', [['any', 'Anything'], ['push', 'A push'], ['deploy', 'A deploy'], ['release', 'A release'], ['merge', 'A merged pull request']], t.kind || 'any', v => { t.kind = v; }, { at: `${at}.kind` }),
        txt('Project (optional)', t.project, v => { t.project = v; }, { at: `${at}.project`, attrs: { placeholder: 'Any project' } }),
      ];
      case 'task': return [sel('When a task', [['any', 'finishes'], ['ok', 'succeeds'], ['error', 'fails']], t.outcome || 'any', v => { t.outcome = v; }, { at: `${at}.outcome`, hint: 'Your own conversations, not a workflow\'s.' })];
      case 'folder': return [
        folderField('Folder to watch', t.path, v => { t.path = v; }, { at: `${at}.path`, placeholder: 'C:\\Users\\you\\Downloads' }),
        h('div', { class: 'grid-2' },
          txt('Files (optional)', t.pattern, v => { t.pattern = v; }, { at: `${at}.pattern`, attrs: { placeholder: '*.pdf' } }),
          sel('When files are', [['added', 'added'], ['changed', 'changed'], ['any', 'added or changed']], t.events || 'added', v => { t.events = v; }, { at: `${at}.events` })),
      ];
      case 'workflow': return [
        h('div', { class: 'grid-2' },
          workflowPicker('Workflow', t.name, v => { t.name = v; }, { at: `${at}.name` }),
          sel('When it', [['any', 'finishes'], ['ok', 'succeeds'], ['error', 'fails']], t.status || 'any', v => { t.status = v; }, { at: `${at}.status` })),
      ];
      case 'webhook': return webhookFields(t);
      case 'claude': return [h('p', { class: 'field-hint', text: 'Claude Code (over MCP) or the shellby command can start it, passing its inputs. Only workflows with this trigger can be started that way.' })];
      case 'startup': return [h('p', { class: 'field-hint', text: 'Runs each time Shellby starts.' })];
      case 'health': return [h('p', { class: 'field-hint', text: 'Runs when Health spots something overheating or a drive filling up.' })];
      default: return [];
    }
  }

  function scheduleFields(t, at) {
    const s = t.schedule || (t.schedule = { type: 'daily', time: '09:00' });
    const k = keyOf(t);
    const kinds = [['daily', 'Every day'], ['weekly', 'On certain days'], ['interval', 'Every few hours'], ['minutes', 'Every few minutes']];
    const out = [h('div', { class: 'grid-2' },
      sel('Repeat', kinds, s.type, v => { t.schedule = defaultSchedule(v, s); rebuild(`sk-${k}`); }, { attrs: { 'data-fk': `sk-${k}` } }),
      s.type === 'daily' || s.type === 'weekly' ? timeField(s) : null,
      s.type === 'interval' ? num('Every (hours)', s.everyHours, v => { s.everyHours = v; }, { attrs: { min: 1, max: 168 } }) : null,
      s.type === 'minutes' ? num('Every (minutes)', s.every, v => { s.every = v; }, { attrs: { min: 5, max: 1440 } }) : null)];
    if (s.type === 'weekly') out.push(daysField(s));
    out.push(slot(`${at}.schedule`, null));
    return out;
  }

  function defaultSchedule(type, prev) {
    const time = prev.time || '09:00';
    if (type === 'weekly') return { type, time, days: prev.days?.length ? prev.days : [1] };
    if (type === 'interval') return { type, everyHours: 4 };
    if (type === 'minutes') return { type, every: 15 };
    return { type: 'daily', time };
  }

  function timeField(s) {
    const el = h('input', { class: 'field', type: 'time' });
    el.value = s.time || '09:00';
    el.addEventListener('input', () => { s.time = el.value; changed(); });
    return wrap('At', el);
  }

  function daysField(s) {
    const days = new Set(s.days || [1]);
    const box = (n, label) => h('label', {},
      h('input', { type: 'checkbox', checked: days.has(n), onchange: e => { if (e.target.checked) days.add(n); else days.delete(n); s.days = [...days].sort((a, b) => a - b); changed(); } }),
      h('span', { text: label }));
    return h('fieldset', { class: 'wf-fieldset' }, h('legend', { class: 'field-label', text: 'Days' }),
      h('div', { class: 'days' }, [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']].map(([n, l]) => box(n, l))));
  }

  function webhookFields(t) {
    const port = state.workflows?.webhookPort;
    const url = `http://127.0.0.1:${port || '<port>'}/v1/flow`;
    const token = t.token || '<token>';
    const example = `Invoke-RestMethod -Method Post -Uri ${url} -Headers @{ 'X-Shellby' = '1' } -ContentType 'application/json' -Body '{"hook":"${token}","data":{}}'`;
    return [
      h('div', { class: 'wf-field' }, h('div', { class: 'field-label', text: 'Address' }), h('code', { class: 'path wf-code-line', text: url })),
      h('div', { class: 'wf-field' },
        h('div', { class: 'field-label', text: 'Call it from PowerShell' }),
        h('pre', { class: 'wf-pre', tabindex: '0', 'aria-label': 'PowerShell example', text: example }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn slim-btn', onclick: () => { api.copyText(example); SB.toast('Copied'); } }, 'Copy'),
          h('span', { class: 'field-hint', text: t.token ? 'Whatever you put in "data" arrives as trigger.*' : 'The token appears here after the first save.' }))),
      port ? null : h('p', { class: 'field-hint', text: 'Shellby\'s local port isn\'t running right now, so the address is a placeholder.' }),
    ];
  }

  function workflowPicker(label, value, onChange, opts) {
    const others = workflows().filter(w => w.id !== ed.def.id).map(w => w.name);
    const options = [['', others.length ? 'Pick one…' : 'No other workflows yet'], ...others.map(n => [n, n])];
    if (value && !others.includes(value)) options.push([value, `${value} (not found)`]);
    return sel(label, options, value || '', onChange, opts);
  }

  // ------------------------------------------------------------ Steps

  function stepsSection(d) {
    return h('section', { class: 'wf-section' },
      sectionHead('Steps', 'They run from the top. Open one to change it.', 'steps'),
      stepList(d.steps, 'steps', 1, [], 'Add a step', 'Steps'));
  }

  function stepList(steps, at, depth, chain, addText, label) {
    const items = [];
    steps.forEach((s, i) => {
      if (i > 0) items.push(h('li', { class: 'wf-gap' }, addButton(steps, i, depth, `Add a step before “${s.label || STEP_INFO[s.type]?.name}”`, true)));
      items.push(stepCard(steps, i, `${at}[${i}]`, depth, [...chain, { list: steps, index: i }]));
    });
    items.push(h('li', { class: 'wf-end' }, addButton(steps, steps.length, depth, addText, false)));
    return h('ol', { class: `wf-steps depth-${depth}`, 'aria-label': label }, items);
  }

  function addButton(steps, index, depth, label, small) {
    const fk = `add-${keyOf(steps)}-${index}`;
    const btn = h('button', {
      type: 'button', class: small ? 'wf-gap-btn' : 'btn ghost slim-btn wf-add', 'aria-label': label, title: small ? label : null,
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': fk,
      onclick: () => popup(btn, () => typeMenu(type => insertStep(steps, index, type), depth)),
    }, small ? icon('plus', 1.6) : `+ ${label}`);
    return btn;
  }

  function typeMenu(pick, depth) {
    const full = countSteps() >= MAX.steps;
    return STEP_GROUPS.flatMap(([group, types]) => [menuLabel(group), ...types.map(type => menuItem(STEP_INFO[type].name, STEP_INFO[type].sub, () => pick(type), {
      glyph: icon(type), disabled: full || (CONTAINERS[type] && depth >= MAX.depth),
    }))]);
  }

  function insertStep(steps, index, type) {
    const s = newStep(type);
    steps.splice(index, 0, s);
    openSteps.add(s);
    changed();
    if (mapOn()) ed.sel = stepSel(s);
    rebuild();
    if (mapOn()) focusInspector(); else focusFirstIn(s);
  }

  // The first field after Label in the map's inspector: what the step or trigger actually does.
  function focusInspector() {
    const fields = [...screen.querySelectorAll('.wfc-insp-body .field')];
    const el = fields.find(f => !f.closest('.wfc-label-field')) || screen.querySelector('.wfc-insp-body button');
    el?.focus();
  }

  function focusFirstIn(step) {
    const card = screen.querySelector(`[data-card="${keyOf(step)}"]`);
    // The first field after Label: what the step actually does.
    const fields = card ? [...card.querySelectorAll(':scope > .wf-step-body .field')] : [];
    const el = fields[1] || fields[0] || card?.querySelector('.wf-step-toggle');
    el?.focus();
    card?.scrollIntoView({ block: 'nearest' });
  }

  function stepCard(steps, i, at, depth, chain) {
    const step = steps[i];
    const k = keyOf(step);
    const info = STEP_INFO[step.type] || { name: step.type };
    const open = openSteps.has(step);
    const name = () => step.label || info.name;
    const titleEl = h('span', { class: 'wf-step-title', text: name() });
    const ctx = { at, depth, chain, step };
    const li = h('li', { class: `wf-card wf-step${open ? ' open' : ''}`, 'data-type': step.type, 'data-card': k },
      h('div', { class: 'wf-card-head' },
        h('button', {
          type: 'button', class: 'wf-step-toggle', 'aria-expanded': String(open), 'data-fk': `t-${k}`,
          onclick: () => { if (open) openSteps.delete(step); else openSteps.add(step); rebuild(`t-${k}`); },
        },
        h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon(step.type)),
        h('span', { class: 'wf-step-text' }, titleEl, open ? null : h('span', { class: 'wf-step-sum', text: stepSummary(step) })),
        h('span', { class: 'wf-err-dot', 'aria-hidden': 'true' })),
        iconBtn('up', `Move “${name()}” up`, () => moveStep(steps, i, -1), { disabled: i === 0, 'data-fk': `up-${k}` }),
        iconBtn('down', `Move “${name()}” down`, () => moveStep(steps, i, 1), { disabled: i === steps.length - 1, 'data-fk': `dn-${k}` }),
        iconBtn('more', `More for “${name()}”`, e => stepMenu(steps, i, e.currentTarget), { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': `mo-${k}` })),
      slot(at, null),
      open ? h('div', { class: 'wf-step-body' },
        txt('Label', step.label, v => { putOrDrop(step, 'label', v); titleEl.textContent = name(); }, { at: `${at}.label`, attrs: { maxlength: 80, placeholder: info.name } }),
        STEP_FIELDS[step.type]?.(step, ctx) || [],
        containerLists(step, ctx),
        advanced(step, ctx)) : null);
    cards.push({ at, el: li });
    return li;
  }

  function containerLists(step, ctx) {
    if (step.type === 'if') {
      return [
        branch('Then', step.then, `${ctx.at}.then`, ctx, 'Add a step to Then'),
        branch('Otherwise', step.else, `${ctx.at}.else`, ctx, 'Add a step to Otherwise'),
      ];
    }
    if (step.type === 'each') return [branch('Repeat', step.steps, `${ctx.at}.steps`, ctx, 'Add a step to repeat')];
    return [];
  }

  function branch(label, steps, at, ctx, addText) {
    return h('div', { class: 'wf-branch' },
      h('div', { class: 'wf-branch-label', text: label }),
      slot(at, null),
      stepList(steps, at, ctx.depth + 1, ctx.chain, addText, label));
  }

  function moveStep(steps, i, by) {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const s = steps[i];
    steps.splice(i, 1);
    steps.splice(j, 0, s);
    changed();
    rebuild(`${by < 0 ? 'up' : 'dn'}-${keyOf(s)}`);
  }

  function stepMenu(steps, i, anchor) {
    const s = steps[i];
    popup(anchor, () => [
      menuItem('Duplicate', 'A copy right after it', () => {
        const c = copyStep(s);
        steps.splice(i + 1, 0, c);
        openSteps.add(c);
        changed();
        rebuild();
        focusFirstIn(c);
      }, { disabled: countSteps() >= MAX.steps }),
      menuItem('Move up', null, () => moveStep(steps, i, -1), { disabled: i === 0 }),
      menuItem('Move down', null, () => moveStep(steps, i, 1), { disabled: i === steps.length - 1 }),
      h('div', { class: 'menu-sep' }),
      menuItem('Delete', null, () => deleteStep(steps, i)),
    ]);
  }

  function deleteStep(steps, i) {
    const s = steps[i];
    walk([s], x => { if (ed.sel === stepSel(x)) ed.sel = null; }); // it, or a step inside it
    steps.splice(i, 1);
    changed();
    const next = steps[Math.min(i, steps.length - 1)];
    rebuild(next ? stepFk(next) : `add-${keyOf(steps)}-${steps.length}`);
    SB.toast(`Deleted “${s.label || STEP_INFO[s.type]?.name}”`, { action: 'Undo', onAction: () => { steps.splice(i, 0, s); changed(); rebuild(stepFk(s)); } });
  }

  function stepSummary(s) {
    switch (s.type) {
      case 'claude': return `${MODE_NAME[s.mode || 'smart'] || s.mode} · ${firstLine(s.prompt) || 'Nothing to do yet'}`;
      case 'run': return firstLine(s.command) || 'No command yet';
      case 'http': return `${s.method || 'GET'} ${s.url || '…'}`;
      case 'ask': return s.question || 'No question yet';
      case 'tell': return `${(TELL_TO.find(([v]) => v === (s.to || 'notification')) || [])[1] || s.to}: ${firstLine(s.text) || '…'}`;
      case 'set': return Object.keys(s.values || {}).join(', ') || 'Nothing set yet';
      case 'if': return `If ${s.test || '…'}`;
      case 'each': return `Each ${s.as || 'item'} in ${s.over || '…'}`;
      case 'wait': return `Wait ${humanSeconds(s.seconds)}`;
      case 'file': return `${(FILE_ACTIONS.find(([v]) => v === (s.action || 'read')) || [])[1] || s.action} · ${s.path || '…'}`;
      case 'workflow': return s.name ? `Run “${s.name}”` : 'No workflow picked';
      case 'stop': return s.status === 'error' ? `Stop as failed${s.message ? `: ${s.message}` : ''}` : `Stop${s.message ? `: ${s.message}` : ''}`;
      case 'worktree': return s.repo ? `Copy of ${s.repo}` : 'No repository yet';
      case 'pr': return `${s.draft === false ? 'Pull request' : 'Draft'}: ${firstLine(s.title) || '…'}`;
      default: return '';
    }
  }

  // A trigger in a line, for its node on the map (the server's wording is only for saved ones).
  function triggerSummary(t) {
    const s = t.schedule || {};
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    switch (t.type) {
      case 'schedule':
        if (s.type === 'weekly') return `${(s.days || []).map(n => DAYS[n]).join(', ') || 'No days'} at ${s.time || '09:00'}`;
        if (s.type === 'interval') return `Every ${plural(s.everyHours || 0, 'hour')}`;
        if (s.type === 'minutes') return `Every ${plural(s.every || 0, 'minute')}`;
        return `Every day at ${s.time || '09:00'}`;
      case 'ci': return `${{ failed: 'Fails', fixed: 'Goes green again', passed: 'Passes', merged: 'Is merged', review: 'Needs your review', any: 'Any change' }[t.on] || t.on}${t.repo ? ` · ${t.repo}` : ''}`;
      case 'issue': return `${{ assigned: 'Assigned to me', labelled: 'Labelled shellby', any: 'Assigned or labelled' }[t.on] || t.on}${t.repo ? ` · ${t.repo}` : ''}`;
      case 'shipped': return `${{ any: 'Anything', push: 'A push', deploy: 'A deploy', release: 'A release', merge: 'A merge' }[t.kind] || t.kind}${t.project ? ` · ${t.project}` : ''}`;
      case 'task': return { ok: 'A task succeeds', error: 'A task fails' }[t.outcome] || 'A task finishes';
      case 'folder': return `${t.pattern || 'Files'} ${t.events === 'changed' ? 'changed' : t.events === 'any' ? 'added or changed' : 'added'}${t.path ? ` in ${SB.shortPath(t.path, 28)}` : ''}`;
      case 'workflow': return t.name ? `“${t.name}” ${{ ok: 'succeeds', error: 'fails' }[t.status] || 'finishes'}` : 'No workflow picked';
      default: return TRIGGER_INFO[t.type]?.sub || '';
    }
  }

  // ================================================================ the editor: map

  // sel -> what it stands for ({ kind: 'step', step, place } / { kind: 'trigger', t, index }),
  // filled in as the map draws its nodes.
  let selInfo = new Map();

  function mapPane(d) {
    selInfo = new Map();
    const settingsBtn = h('button', {
      type: 'button', class: 'btn ghost slim-btn wf-settings-btn', 'aria-expanded': String(ed.sel === 'settings'), 'data-fk': 'wf-settings',
      onclick: e => ed.map?.select(ed.sel === 'settings' ? null : 'settings', { focus: e.detail === 0 }),
    }, icon('settings'), 'Settings');
    const canvas = SB.wfCanvas.mount({
      id: `ed-${keyOf(d)}`,
      label: 'The workflow as a map. Steps run from the top; an If splits into two lanes.',
      steps: d.steps,
      maxDepth: MAX.depth,
      sel: ed.sel,
      icon,
      triggers: [() => manualNode(d), ...d.when.map((t, i) => () => triggerNode(t, i))],
      step: (s, place) => {
        selInfo.set(stepSel(s), { kind: 'step', step: s, place });
        return {
          sel: stepSel(s), type: s.type, icon: s.type, at: place.at, removable: true,
          title: s.label || STEP_INFO[s.type]?.name || s.type,
          sub: stepSummary(s),
          badge: s.if ? 'only if' : '',
          note: s.if ? `Only if ${s.if}` : '',
          loopLabel: s.type === 'each' ? `Each ${s.as || 'item'}` : '',
        };
      },
      register: (at, cell) => { cards.push({ at, el: cell }); return slot(at, null); },
      select: sel => { ed.sel = sel; settingsBtn.setAttribute('aria-expanded', String(sel === 'settings')); },
      closed: was => { if (was === 'settings') settingsBtn.focus(); },
      inspect: (box, sel, close) => inspectEdit(box, sel, close),
      add: (list, index, btn, depth) => popup(btn, () => typeMenu(type => insertStep(list, index, type), depth)),
      addLabel: (list, index) => {
        const named = s => `“${s.label || STEP_INFO[s.type]?.name}”`;
        if (index < list.length) return `Add a step before ${named(list[index])}`;
        return list.length ? `Add a step after ${named(list[list.length - 1])}` : 'Add a step here';
      },
      addFk: (list, index) => `add-${keyOf(list)}-${index}`,
      addTrigger: d.when.length < MAX.triggers ? btn => popup(btn, () => triggerMenu(d)) : null,
      move: (step, list, index) => {
        if (!G.moveTo(d.steps, step, list, index, MAX.depth)) return;
        changed();
        rebuild(stepFk(step));
        SB.toast(`Moved “${step.label || STEP_INFO[step.type]?.name}”`);
      },
      remove: removeSel,
      tools: [roomBtn()],
    });
    ed.map = canvas;
    return h('div', { class: 'wf-mappane' },
      h('div', { class: 'wf-mapbar' }, nameField(d, 'wf-mapbar-name'), settingsBtn),
      canvas.el,
      h('p', { class: 'sr-only', text: 'Press a node to change it. Drag a step onto a + to move it. List shows the same workflow as a list.' }));
  }

  function manualNode(d) {
    selInfo.set('manual', { kind: 'manual' });
    return {
      sel: 'manual', kind: 'trigger', type: 'manual', icon: 'play', dashed: true, title: 'Run by hand',
      sub: d.inputs.length ? `Asks for ${plural(d.inputs.length, 'input')}` : 'Press Run any time',
    };
  }

  function triggerNode(t, index) {
    selInfo.set(trigSel(t), { kind: 'trigger', t, index });
    return {
      sel: trigSel(t), kind: 'trigger', type: t.type, icon: 'trigger', at: `when[${index}]`, removable: true,
      title: TRIGGER_INFO[t.type]?.name || t.type, sub: triggerSummary(t),
    };
  }

  function removeSel(sel) {
    const it = selInfo.get(sel);
    if (it?.kind === 'step') deleteStep(it.place.list, it.place.index);
    else if (it?.kind === 'trigger') removeTrigger(it.index);
  }

  // The inspector: the same fields the list shows, for the one node you picked.
  function inspectEdit(box, sel, close) {
    const it = sel === 'settings' ? { kind: 'settings' } : selInfo.get(sel);
    if (!it) return false;
    const d = ed.def;
    if (it.kind === 'step') fill(box, stepInspector(it.step, it.place, close));
    else if (it.kind === 'trigger') fill(box, triggerInspector(it.t, it.index, close));
    else if (it.kind === 'manual') {
      fill(box, inspRoot('manual', inspHead('play', 'Run by hand', null, close),
        h('p', { class: 'field-hint', text: 'Any workflow can be started with Run on the Workflows page, from another workflow, or by Claude Code when it has the Claude Code trigger. Inputs are what it asks for first.' }),
        inputsSection(d)));
    } else {
      fill(box, inspRoot('settings', inspHead('settings', 'Settings', null, close), aboutFields(d)));
    }
    return true;
  }

  const inspRoot = (type, ...kids) => h('div', { class: 'wf-step wfc-insp-root', 'data-type': type }, kids);

  function inspHead(iconName, title, actions, close) {
    const titleEl = typeof title === 'string' ? h('h3', { class: 'wfc-insp-title', text: title }) : title;
    return h('div', { class: 'wfc-insp-head' },
      h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon(iconName)),
      titleEl, actions,
      iconBtn('close', 'Close', close, { 'data-fk': 'insp-close', title: 'Close (Esc)' }));
  }

  function stepInspector(step, place, close) {
    const info = STEP_INFO[step.type] || { name: step.type };
    const ctx = { at: place.at, depth: place.depth, chain: place.chain, step };
    const name = () => step.label || info.name;
    const titleEl = h('h3', { class: 'wfc-insp-title', text: name() });
    const more = iconBtn('more', `More for “${name()}”`, e => stepMapMenu(place, e.currentTarget), { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': 'insp-more' });
    const inside = { if: 'Its steps are on the map, in the Then and Otherwise lanes under it. Press + in a lane to add one.', each: 'The steps it repeats are on the map, inside the loop under it.' }[step.type];
    return inspRoot(step.type,
      inspHead(step.type, titleEl, more, close),
      h('p', { class: 'field-hint wfc-insp-sub', text: info.sub }),
      slot(place.at, null),
      txt('Label', step.label, v => { putOrDrop(step, 'label', v); titleEl.textContent = name(); }, { at: `${place.at}.label`, cls: 'wfc-label-field', attrs: { maxlength: 80, placeholder: info.name } }),
      STEP_FIELDS[step.type]?.(step, ctx) || [],
      inside ? h('p', { class: 'field-hint', text: inside }) : null,
      advanced(step, ctx));
  }

  function stepMapMenu({ list, index }, anchor) {
    const s = list[index];
    popup(anchor, () => [
      menuItem('Duplicate', 'A copy right after it', () => {
        const c = copyStep(s);
        list.splice(index + 1, 0, c);
        changed();
        ed.sel = stepSel(c);
        rebuild();
        focusInspector();
      }, { disabled: countSteps() >= MAX.steps }),
      menuItem('Move up', null, () => moveStep(list, index, -1), { disabled: index === 0 }),
      menuItem('Move down', null, () => moveStep(list, index, 1), { disabled: index === list.length - 1 }),
      h('div', { class: 'menu-sep' }),
      menuItem('Delete', null, () => deleteStep(list, index)),
    ]);
  }

  function triggerInspector(t, index, close) {
    const at = `when[${index}]`;
    const info = TRIGGER_INFO[t.type] || { name: t.type };
    return inspRoot('trigger',
      inspHead('trigger', info.name, null, close),
      h('p', { class: 'field-hint wfc-insp-sub', text: info.sub || '' }),
      slot(at, null),
      triggerFields(t, at),
      h('button', { type: 'button', class: 'btn ghost slim-btn wfc-insp-remove', onclick: () => removeTrigger(index) }, 'Remove this trigger'));
  }

  // ------------------------------------------------------------ step types

  const ins = (ctx, extra = {}) => ({ ctx, ...extra });

  const STEP_FIELDS = {
    claude: (s, c) => [
      area('What should Claude do?', s.prompt, v => { s.prompt = v; }, { at: `${c.at}.prompt`, insert: ins(c), attrs: { rows: 5, maxlength: 8000, class: 'field area wf-prompt', placeholder: 'Find out why the build failed. Don\'t change anything yet.' } }),
      h('div', { class: 'grid-2' },
        sel('Permission mode', SB.MODES.map(m => [m.id, m.title, m.id === 'autonomous' && !state.settings.autonomousAcknowledged && s.mode !== 'autonomous']), s.mode || 'smart', v => { s.mode = v; }, { at: `${c.at}.mode` }),
        modelField(s, c)),
      folderField('Folder', s.cwd, v => putOrDrop(s, 'cwd', v), { at: `${c.at}.cwd`, placeholder: 'The workflow\'s folder' }),
      check('Fresh conversation', s.fresh, v => putOrDrop(s, 'fresh', v), { hint: 'Otherwise it carries on the conversation earlier Claude steps had, so it knows what they found.' }),
      outputFields(s, c),
    ],
    run: (s, c) => [
      area('Command (PowerShell)', s.command, v => { s.command = v; }, { at: `${c.at}.command`, insert: ins(c, { secrets: true }), attrs: { rows: 3, maxlength: 4000, class: 'field area wf-mono', placeholder: 'npm test' }, hint: 'Values go in as quoted text, so they can\'t become code.' }),
      folderField('Folder', s.cwd, v => putOrDrop(s, 'cwd', v), { at: `${c.at}.cwd`, placeholder: 'The workflow\'s folder' }),
      check('Carry on if it fails', s.allowFail, v => putOrDrop(s, 'allowFail', v), { hint: 'Later steps can check {{ id.ok }} and {{ id.code }}.' }),
    ],
    http: (s, c) => [
      h('div', { class: 'wf-http' },
        sel('Method', METHODS.map(m => [m, m]), s.method || 'GET', v => { s.method = v; }, { at: `${c.at}.method` }),
        txt('Address', s.url, v => { s.url = v; }, { at: `${c.at}.url`, insert: ins(c, { secrets: true }), attrs: { maxlength: 2000, placeholder: 'https://example.com/api', class: 'field wf-mono' } })),
      rowsEditor({
        legend: 'Headers', rows: objRows(s.headers), at: `${c.at}.headers`, addText: 'Add a header',
        blank: () => ({ k: '', v: '' }),
        columns: [{ key: 'k', label: 'Header', placeholder: 'Authorization', mono: true }, { key: 'v', label: 'Value', placeholder: 'Bearer {{ secrets.TOKEN }}', insert: ins(c, { secrets: true }) }],
        onChange: rows => putOrDrop(s, 'headers', Object.keys(rowsObj(rows)).length ? rowsObj(rows) : undefined),
      }),
      area('Body', s.body, v => putOrDrop(s, 'body', v), { at: `${c.at}.body`, insert: ins(c, { secrets: true }), attrs: { rows: 3, class: 'field area wf-mono', placeholder: '{ "text": "{{ fix.reply }}" }' } }),
      check('Carry on if it fails', s.allowFail, v => putOrDrop(s, 'allowFail', v), { hint: 'Later steps can check {{ id.ok }} and {{ id.status }}.' }),
    ],
    file: (s, c) => [
      sel('Do what', FILE_ACTIONS, s.action || 'read', v => { s.action = v; if (v === 'read') delete s.content; rebuild(`fa-${keyOf(s)}`); }, { at: `${c.at}.action`, attrs: { 'data-fk': `fa-${keyOf(s)}` } }),
      txt('File', s.path, v => { s.path = v; }, { at: `${c.at}.path`, insert: ins(c), attrs: { placeholder: 'C:\\Users\\you\\notes.md', class: 'field wf-mono' }, hint: 'A full path.' }),
      (s.action || 'read') === 'read' ? null : area('What to write', s.content, v => putOrDrop(s, 'content', v), { at: `${c.at}.content`, insert: ins(c), attrs: { rows: 4 } }),
    ],
    ask: (s, c) => [
      txt('Question', s.question, v => { s.question = v; }, { at: `${c.at}.question`, insert: ins(c), attrs: { maxlength: 300, placeholder: 'Push the fix?' } }),
      choicesField(s, c),
    ],
    tell: (s, c) => [
      sel('Send to', TELL_TO, s.to || 'notification', v => { s.to = v; if (v !== 'file') delete s.path; rebuild(`tt-${keyOf(s)}`); }, { at: `${c.at}.to`, attrs: { 'data-fk': `tt-${keyOf(s)}` } }),
      txt('Title (optional)', s.title, v => putOrDrop(s, 'title', v), { at: `${c.at}.title`, insert: ins(c), attrs: { maxlength: 100, placeholder: 'The workflow\'s name' } }),
      area('Message', s.text, v => { s.text = v; }, { at: `${c.at}.text`, insert: ins(c), attrs: { rows: 3, maxlength: 1000 } }),
      s.to === 'file' ? txt('File', s.path, v => { s.path = v; }, { at: `${c.at}.path`, insert: ins(c), attrs: { placeholder: 'C:\\Users\\you\\log.md', class: 'field wf-mono' }, hint: 'The message is added to the end.' }) : null,
    ],
    set: (s, c) => [rowsEditor({
      legend: 'Values', rows: objRows(s.values), at: `${c.at}.values`, addText: 'Add a value',
      hint: 'Later steps use them as {{ vars.name }}.',
      blank: () => ({ k: '', v: '' }),
      columns: [{ key: 'k', label: 'Name', placeholder: 'summary', mono: true, width: '.8fr' }, { key: 'v', label: 'Value', placeholder: '{{ brief.reply }}', insert: ins(c) }],
      onChange: rows => { s.values = rowsObj(rows); },
    })],
    if: (s, c) => [
      txt('Test', s.test, v => { s.test = v; }, { at: `${c.at}.test`, insert: ins(c, { cond: true }), attrs: { class: 'field wf-mono', placeholder: 'diagnose.fixable == true' }, hint: 'Compare with == != > < contains, and join with and, or, not.' }),
    ],
    each: (s, c) => [
      txt('Go through', s.over, v => { s.over = v; }, { at: `${c.at}.over`, insert: ins(c), attrs: { class: 'field wf-mono', placeholder: '{{ trigger.files }}' }, hint: 'A list from an earlier step or the trigger.' }),
      h('div', { class: 'grid-2' },
        txt('Call each one', s.as, v => putOrDrop(s, 'as', v), { at: `${c.at}.as`, attrs: { class: 'field wf-mono', placeholder: 'item' } }),
        num('At most', s.max, v => putOrDrop(s, 'max', v), { at: `${c.at}.max`, attrs: { min: 1, max: 100 } })),
    ],
    wait: (s, c) => [waitField(s, c)],
    workflow: (s, c) => [
      workflowPicker('Workflow', s.name, v => { s.name = v; prefillInputs(s, v); rebuild(`wn-${keyOf(s)}`); }, { at: `${c.at}.name`, attrs: { 'data-fk': `wn-${keyOf(s)}` } }),
      rowsEditor({
        legend: 'Its inputs', rows: objRows(s.inputs), at: `${c.at}.inputs`, addText: 'Add an input',
        blank: () => ({ k: '', v: '' }),
        columns: [{ key: 'k', label: 'Input', mono: true, width: '.8fr' }, { key: 'v', label: 'Value', insert: ins(c) }],
        onChange: rows => putOrDrop(s, 'inputs', Object.keys(rowsObj(rows)).length ? rowsObj(rows) : undefined),
      }),
    ],
    worktree: (s, c) => [
      txt('Repository', s.repo, v => { s.repo = v; }, { at: `${c.at}.repo`, insert: ins(c), attrs: { class: 'field wf-mono', placeholder: '{{ trigger.repo }}' }, hint: 'owner/name, cloned on this PC (the Projects page clones it). The copy starts from its main branch on GitHub; your checkout isn\'t touched.' }),
      txt('Branch name (optional)', s.branch, v => putOrDrop(s, 'branch', v), { at: `${c.at}.branch`, insert: ins(c), attrs: { maxlength: 60, placeholder: 'issue-{{ trigger.number }}' }, hint: 'Becomes shellby/<name>-<code>. Later steps work in {{ id.path }}.' }),
    ],
    pr: (s, c) => [
      txt('Copy', s.folder, v => { s.folder = v; }, { at: `${c.at}.folder`, insert: ins(c), attrs: { class: 'field wf-mono', placeholder: '{{ copy.path }}' }, hint: 'The folder a “Make a copy” step made. Whatever is left uncommitted there is committed first.' }),
      txt('Title', s.title, v => { s.title = v; }, { at: `${c.at}.title`, insert: ins(c), attrs: { maxlength: 250, placeholder: '{{ trigger.title }}' } }),
      area('Description (optional)', s.body, v => putOrDrop(s, 'body', v), { at: `${c.at}.body`, insert: ins(c), attrs: { rows: 4, placeholder: 'Closes #{{ trigger.number }}' } }),
      check('Open it as a draft', s.draft !== false, v => { s.draft = v; }, { hint: 'Needs “Let Claude tasks push code and open pull requests” in Settings → GitHub.' }),
    ],
    stop: (s, c) => [
      sel('Finish the run as', [['ok', 'Done (ok)'], ['error', 'Failed']], s.status || 'ok', v => { s.status = v; }, { at: `${c.at}.status` }),
      txt('Message (optional)', s.message, v => putOrDrop(s, 'message', v), { at: `${c.at}.message`, attrs: { maxlength: 1000 } }),
    ],
  };

  function modelField(s, c) {
    const models = state.models || [];
    const groups = [...new Set(models.map(m => m.group))];
    const options = [['', 'Default'], ...groups.map(g => ({ group: g, options: models.filter(m => m.group === g).map(m => [m.id, m.label]) }))];
    if (s.model && !models.some(m => m.id === s.model)) options.push([s.model, s.model]);
    return sel('Model', options, s.model || '', v => putOrDrop(s, 'model', v), { at: `${c.at}.model` });
  }

  function prefillInputs(s, name) {
    const target = workflows().find(w => w.name === name);
    if (!target?.inputs?.length) return;
    const now = { ...(s.inputs || {}) };
    for (const i of target.inputs) if (!(i.name in now)) now[i.name] = '';
    s.inputs = now;
  }

  function outputFields(s, c) {
    const rows = Object.entries(s.output || {}).map(([name, f]) => ({ name, type: f?.type || 'string', description: f?.description || '' }));
    return rowsEditor({
      legend: 'Output fields', rows, at: `${c.at}.output`, addText: 'Add a field',
      hint: 'Claude ends its reply with these, so later steps can use {{ id.field }}.',
      blank: () => ({ name: '', type: 'string', description: '' }),
      columns: [
        { key: 'name', label: 'Field', placeholder: 'fixable', mono: true, width: '.9fr' },
        { key: 'type', label: 'Type', kind: 'select', options: FIELD_TYPES, width: '.8fr' },
        { key: 'description', label: 'Description', placeholder: 'True if a small fix works', width: '1.3fr' },
      ],
      onChange: list2 => {
        const out = Object.fromEntries(list2.filter(r => r.name.trim()).map(r => [r.name.trim(), { type: r.type, description: r.description }]));
        putOrDrop(s, 'output', Object.keys(out).length ? out : undefined);
      },
    });
  }

  function choicesField(s, c) {
    const id = uid('choice');
    const chips = h('ul', { class: 'wf-chips', 'aria-label': 'Choices' });
    const input = h('input', { class: 'field', id, maxlength: 40, autocomplete: 'off', placeholder: 'Add a choice' });
    const addBtn = h('button', { type: 'button', class: 'btn slim-btn', onclick: add }, 'Add');
    const note = h('p', { class: 'field-hint' });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    function list2() { return s.choices ? [...s.choices] : []; }
    function set(next) { putOrDrop(s, 'choices', next.length ? next : undefined); changed(); draw(); }
    function add() {
      const v = input.value.trim();
      const cur = list2();
      if (!v || cur.length >= MAX.choices) return;
      if (cur.some(x => x.toLowerCase() === v.toLowerCase())) { input.select(); return; }
      input.value = '';
      set([...cur, v]);
      input.focus();
    }
    function draw() {
      const cur = list2();
      fill(chips, ...cur.map((ch, i) => h('li', { class: 'wf-chip' }, h('span', { text: ch }),
        h('button', { type: 'button', class: 'wf-chip-x', 'aria-label': `Remove the choice “${ch}”`, onclick: () => { const n = list2(); n.splice(i, 1); set(n); input.focus(); } }, '×'))));
      const full = cur.length >= MAX.choices;
      input.disabled = full;
      addBtn.disabled = full;
      note.textContent = !cur.length ? 'No choices: you get Continue or Stop, and Stop ends the run.'
        : cur.length === 1 ? 'Add at least one more (2 to 4).' : `Later steps can check {{ ${s.id || 'id'}.choice }}.`;
    }
    draw();
    return h('div', { class: 'wf-field' },
      h('label', { class: 'field-label', for: id, text: 'Choices (optional)' }),
      chips, h('div', { class: 'row' }, input, addBtn), note, slot(`${c.at}.choices`, input));
  }

  function waitField(s, c) {
    const seconds = Number.isFinite(s.seconds) ? s.seconds : 60;
    const unit = waitUnits.get(s) || ([...WAIT_UNITS].reverse().find(([, f]) => seconds % f === 0) || WAIT_UNITS[0])[0];
    const factor = () => WAIT_UNITS.find(([u]) => u === (waitUnits.get(s) || unit))[1];
    const amount = h('input', { class: 'field', type: 'number', min: 1, inputmode: 'numeric', 'aria-label': 'How long' });
    amount.value = String(seconds / WAIT_UNITS.find(([u]) => u === unit)[1]);
    const recompute = () => { const n = Number(amount.value); s.seconds = Number.isFinite(n) && amount.value !== '' ? Math.round(n * factor()) : undefined; changed(); };
    amount.addEventListener('input', recompute);
    const unitSel = selectControl(WAIT_UNITS.map(([u]) => [u, u]), unit, v => { waitUnits.set(s, v); recompute(); }, { 'aria-label': 'Unit' });
    return h('div', { class: 'wf-field', role: 'group', 'aria-label': 'How long to wait' },
      h('div', { class: 'field-label', text: 'Wait for' }),
      h('div', { class: 'grid-2' }, amount, unitSel),
      slot(`${c.at}.seconds`, amount));
  }

  // ------------------------------------------------------------ Advanced (per step)

  function advanced(step, c) {
    const det = h('details', { class: 'wf-advanced', open: openAdvanced.has(step) },
      h('summary', { text: 'Advanced' }),
      h('div', { class: 'wf-advanced-body' },
        txt('Name for later steps', step.id, v => putOrDrop(step, 'id', v.trim()), {
          at: `${c.at}.id`, attrs: { class: 'field wf-mono', maxlength: 32, placeholder: step.type },
          hint: `Later steps use its results as {{ ${step.id || 'name'}.… }}. Lowercase letters, digits and _.`,
        }),
        txt('Only if', step.if, v => putOrDrop(step, 'if', v), { at: `${c.at}.if`, insert: ins(c, { cond: true }), attrs: { class: 'field wf-mono', placeholder: 'inputs.branch == "main"' }, hint: 'Skipped when this is false.' }),
        h('div', { class: 'grid-2' },
          num('Retry (times)', step.retry?.times, v => setRetry(step, 'times', v), { at: `${c.at}.retry.times`, attrs: { min: 0, max: 5, placeholder: '0' } }),
          num('Between tries (seconds)', step.retry?.delaySec, v => setRetry(step, 'delaySec', v), { at: `${c.at}.retry.delaySec`, attrs: { min: 1, max: 3600, placeholder: '30' } })),
        num('Time limit (minutes)', step.timeoutMin, v => putOrDrop(step, 'timeoutMin', v), { at: `${c.at}.timeoutMin`, attrs: { min: 1, max: 720, placeholder: 'None' } }),
        check('Carry on after an error', step.continueOnError, v => putOrDrop(step, 'continueOnError', v), { hint: 'The error is recorded and the next step runs.' })));
    det.addEventListener('toggle', () => { if (det.open) openAdvanced.add(step); else openAdvanced.delete(step); });
    return det;
  }

  function setRetry(step, key, v) {
    const r = { ...(step.retry || {}) };
    putOrDrop(r, key, v);
    if (!r.times && !r.delaySec) delete step.retry; else step.retry = r;
  }

  // ------------------------------------------------------------ JSON

  function toggleJson() {
    if (!ed.json) {
      ed.json = true;
      ed.jsonText = JSON.stringify(ed.def, null, 2);
      ed.jsonError = '';
      rebuild();
      screen.querySelector('.wf-json')?.focus();
      return;
    }
    if (applyJson()) requestAnimationFrame(() => screen.querySelector('.wf-json-toggle')?.focus());
  }

  function applyJson() {
    let parsed;
    try { parsed = JSON.parse(ed.jsonText); } catch (e) { return jsonFail(`That isn't valid JSON: ${e.message}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonFail('A workflow is one { … } object.');
    // Editing keeps who it is, even if the pasted text left those out.
    if (ed.def.id && !parsed.id) parsed.id = ed.def.id;
    if (ed.def.createdAt && !parsed.createdAt) parsed.createdAt = ed.def.createdAt;
    ed.def = normalise(parsed);
    ed.json = false;
    ed.jsonError = '';
    changed();
    rebuild();
    validateSoon.now();
    return true;
  }

  function jsonFail(msg) {
    ed.jsonError = msg;
    const err = screen.querySelector('.wf-json-err');
    if (err) { err.hidden = false; err.textContent = msg; }
    screen.querySelector('.wf-json')?.focus();
    return false;
  }

  function jsonPane() {
    const id = uid('json');
    const ta = h('textarea', { class: 'field area wf-json', id, rows: 20, spellcheck: 'false', oninput: e => { ed.jsonText = e.target.value; ed.dirty = true; } });
    ta.value = ed.jsonText;
    return h('div', { class: 'wf-json-pane' },
      h('label', { class: 'field-label', for: id, text: 'The whole workflow as JSON' }),
      ta,
      h('p', { class: 'wf-err wf-json-err', role: 'alert', hidden: !ed.jsonError, text: ed.jsonError }),
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => { ed.json = false; ed.jsonError = ''; rebuild(); } }, 'Back to the form'),
        h('button', { type: 'button', class: 'btn slim-btn', onclick: applyJson }, 'Apply')));
  }

  // ------------------------------------------------------------ Save

  async function save() {
    if (ed.saving) return;
    if (ed.json && !applyJson()) return;
    validateSoon.cancel();
    ed.saving = true;
    const btn = $('wfSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    let res;
    try { res = await api.saveWorkflow(ed.def); } catch { res = { ok: false, errors: [{ path: '', message: 'Couldn\'t save. Try again.' }] }; }
    ed.saving = false;
    if (current().name !== 'editor') return;
    if (!res?.ok) {
      ed.errors = normErrors(res?.errors);
      if (!ed.errors.length) ed.errors = [{ path: '', message: 'Not saved.' }];
      ed.failedSave = true;
      openErrored();
      if (mapOn()) ed.sel = ed.errors.map(e => selFor(e.path)).find(Boolean) || ed.sel;
      rebuild();
      requestAnimationFrame(() => { const box = $('wfSummary'); if (box && !box.hidden) { box.tabIndex = -1; box.focus(); box.scrollIntoView({ block: 'nearest' }); } else screen.querySelector('[aria-invalid="true"]')?.focus(); });
      return;
    }
    ed.dirty = false;
    if (res.view) applyView(res.view); else loadView();
    SB.toast(`Saved “${res.workflow?.name || ed.def.name}”`);
    home();
  }

  // After a failed save, open every card with a problem in it (and their parents).
  function openErrored() {
    const visit = (steps, at) => steps.forEach((s, i) => {
      const here = `${at}[${i}]`;
      if (ed.errors.some(e => within(e.path, here) && e.path !== here)) openSteps.add(s);
      if (ed.errors.some(e => within(e.path, `${here}.retry`) || within(e.path, `${here}.if`) || within(e.path, `${here}.id`) || within(e.path, `${here}.timeoutMin`))) openAdvanced.add(s);
      for (const k of CONTAINERS[s.type] || []) visit(s[k] || [], `${here}.${k}`);
    });
    visit(ed.def.steps, 'steps');
  }

  // ------------------------------------------------------------ Build it with Claude (wf-chat.js)

  function chatHost() {
    let chat = null;
    const alive = () => !!chat && ed.chat === chat && nav.some(x => x.name === 'editor');
    return {
      alive,
      getDef: () => { if (ed.json) applyJson(); return clone(ed.def); },
      apply: (def, { since } = {}) => {
        if (!alive()) return false;
        if (ed.json) applyJson();
        if (since && JSON.stringify(ed.def) !== since) return 'conflict';
        const before = stepPrints(ed.def);
        ed.def = normalise(def);
        ed.dirty = true;
        ed.touched = true;
        ed.json = false;
        ed.sel = null;
        if (current().name !== 'editor') return true;
        rebuild();
        validateSoon.now();
        flashChanged(before);
        return true;
      },
      testSave: async () => {
        if (!alive()) return { ok: false, error: 'The editor was closed.' };
        if (ed.json && !applyJson()) return { ok: false, error: 'The JSON has a problem.' };
        // A new workflow is tested switched off, so its triggers can't fire before you Save it.
        const enabled = ed.def.enabled !== false;
        let res;
        try { res = await api.saveWorkflow({ ...ed.def, enabled: ed.def.id && !ed.trial ? enabled : false }); } catch { res = { ok: false, errors: [{ message: 'Couldn\'t save it.' }] }; }
        if (!res?.ok) {
          if (!res?.declined && alive()) { ed.errors = normErrors(res?.errors); if (current().name === 'editor') paintErrors(); }
          return { ok: false, declined: !!res?.declined, error: normErrors(res?.errors).map(e => e.message).join(' ') || 'Not saved.' };
        }
        if (res.view) applyView(res.view); else loadView();
        if (alive()) {
          if (!ed.def.id) ed.trial = true;
          // Saving gives it an id and hook addresses. Only those are copied in: anything you
          // changed while it saved stays, and so does your on/off.
          ed.def.id = res.workflow.id;
          ed.def.createdAt = res.workflow.createdAt;
          const tokens = res.workflow.when.filter(t => t.type === 'webhook').map(t => t.token);
          for (const t of ed.def.when.filter(x => x.type === 'webhook')) {
            const token = tokens.shift();
            if (!t.token) t.token = token;
          }
        }
        return { ok: true, id: res.workflow.id };
      },
      openRun: runId => { if (alive()) go('run', { runId }); },
      // The host is made before its chat, which is bound to it straight after.
      bind: c => { chat = c; },
    };
  }

  // Each step's own settings (not the steps inside it), by id: what Claude's change touched.
  function stepPrints(def) {
    const prints = new Map();
    walk(def?.steps, s => {
      const own = Object.fromEntries(Object.entries(s).filter(([k]) => !(CONTAINERS[s.type] || []).includes(k)));
      prints.set(s.id, JSON.stringify(own));
    });
    return prints;
  }

  function flashChanged(before) {
    const after = stepPrints(ed.def);
    walk(ed.def.steps, s => {
      if (before.get(s.id) === after.get(s.id)) return;
      const el = [...screen.querySelectorAll('[data-fk]')].find(e => e.dataset.fk === stepFk(s));
      const target = el?.closest('.wfc-cell, .wf-card');
      if (!target) return;
      target.classList.remove('wf-touched');
      void target.offsetWidth; // restart the animation
      target.classList.add('wf-touched');
    });
  }

  // ================================================================ runs of one workflow

  const runsState = { id: null, list: null, error: '' };

  function renderRuns() {
    setMapMode(false);
    const { id, name } = current();
    const w = workflows().find(x => x.id === id);
    if (runsState.id !== id) { runsState.id = id; runsState.list = null; runsState.error = ''; }
    if (!runsState.list && !runsState.error) loadRuns();
    const body = runsState.error ? h('p', { class: 'wf-err', text: runsState.error })
      : !runsState.list ? h('p', { class: 'muted small', role: 'status', text: 'Loading…' })
        : !runsState.list.length ? h('p', { class: 'wf-empty', text: 'No runs yet.' })
          : h('ul', { class: 'wf-runs', 'aria-label': 'Runs, newest first' }, runsState.list.map(runRow));
    fill(screen, 
      h('div', { class: 'view-head' }, backBtn(), h('h2', { text: 'Runs' }),
        w ? h('button', { type: 'button', class: 'btn primary slim-btn', onclick: () => startRunFromRuns(w) }, 'Run now') : null),
      h('p', { class: 'view-lede', text: w?.name || name || '' }),
      body);
  }

  function startRunFromRuns(w) {
    if (!w.inputs?.length) return runNow(w, {});
    home();
    startRun(w);
  }

  async function loadRuns() {
    const id = runsState.id;
    try {
      const l = await api.listRuns(id);
      if (runsState.id !== id) return;
      runsState.list = (Array.isArray(l) ? l : []).filter(r => r.workflowId === id).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    } catch {
      runsState.error = 'Couldn\'t load the runs.';
    }
    if (current().name === 'runs') keepFocus(renderRuns);
  }

  function runRow(r) {
    const meta = [RUN_TRIGGER[r.trigger?.type] || r.trigger?.type || '', r.startedAt ? SB.relTime(r.startedAt) : '', runDuration(r), r.steps ? `${r.done || 0}/${r.steps} steps` : ''].filter(Boolean);
    return h('li', {}, h('button', { type: 'button', class: 'wf-run-row', 'data-fk': `run-${r.id}`, onclick: () => go('run', { runId: r.id }) },
      statusPill(r.status, null),
      h('span', { class: 'wf-run-meta', text: meta.join(' · ') }),
      r.waiting ? h('span', { class: 'wf-run-wait', text: 'needs you' }) : null,
      r.error ? h('span', { class: 'wf-run-err', text: firstLine(r.error) }) : null));
  }

  // ================================================================ one run

  // sel: the map node whose inspector is open (undefined until the run first loads, then
  // whatever needs you: a question, or the step that failed).
  const runState = { id: null, rec: undefined, busy: '', sel: undefined };
  const openOutputs = new Set();

  function renderRun() {
    const { runId } = current();
    if (runState.id !== runId) { runState.id = runId; runState.rec = undefined; runState.busy = ''; runState.sel = undefined; openOutputs.clear(); }
    if (runState.rec === undefined) { loadRun(); }
    const r = runState.rec;
    // The map needs the workflow itself; one that's since been deleted can only be listed.
    const w = r && workflows().find(x => x.id === r.workflowId);
    const layout = w ? pref(PREF.runLayout, 'map') : 'list';
    const head = h('div', { class: 'view-head' }, backBtn(), h('h2', { class: 'wf-title', text: r?.workflowName || 'Run' }),
      w ? layoutSwitch(layout, v => { setPref(PREF.runLayout, v); keepFocus(renderRun); focusFk(`lay-${v}`); }, 'Show the run as') : null);
    if (r === undefined) return fill(screen, head, h('p', { class: 'muted small', role: 'status', text: 'Loading…' }));
    if (!r) { setMapMode(false); return fill(screen, head, h('p', { class: 'wf-empty', text: 'This run isn\'t kept any more.' })); }
    setMapMode(layout === 'map');
    const status = h('div', { class: 'wf-run-status', role: 'status', 'aria-live': 'polite' },
      statusPill(r.status, null),
      h('span', { class: 'wf-run-meta', text: [RUN_TRIGGER[r.trigger?.type] || r.trigger?.type, r.startedAt ? `started ${SB.relTime(r.startedAt)}` : '', runDuration(r)].filter(Boolean).join(' · ') }));
    if (layout === 'map') {
      fill(screen, head, status, r.error ? h('pre', { class: 'wf-run-error wf-run-error-map', text: r.error }) : null, runActions(r), runMap(r, w));
      return;
    }
    fill(screen, head, status,
      r.error ? h('pre', { class: 'wf-run-error', text: r.error }) : null,
      runActions(r),
      Object.keys(r.inputs || {}).length ? factsList('Inputs', r.inputs) : null,
      h('h3', { class: 'wf-h3', text: 'Steps' }),
      timeline(r),
      Object.keys(r.vars || {}).length ? outputDetails('vars', 'Values', h('pre', { class: 'wf-pre', text: pretty(r.vars) })) : null);
  }

  const END_TITLE = { ok: 'Done', error: 'Failed', stopped: 'Stopped', running: 'Still going', waiting: 'Waiting', interrupted: 'Interrupted' };

  // The run drawn on its workflow: every node shows how its step went.
  function runMap(r, w) {
    const def = normalise(toDef(w));
    const stats = G.statusMap(r);
    const strays = G.strays(def.steps, stats);
    const trig = r.trigger?.type;
    const byHand = !def.when.some(t => t.type === trig);
    if (runState.sel === undefined) runState.sel = firstConcern(r, stats);
    const canvas = SB.wfCanvas.mount({
      id: `run-${r.id}`,
      label: 'The run as a map. Each step shows how it went.',
      readOnly: true,
      steps: def.steps,
      maxDepth: MAX.depth,
      sel: runState.sel,
      icon,
      started: Object.keys(r.steps || {}).length > 0,
      triggers: [
        () => ({ sel: 'manual', kind: 'trigger', type: 'manual', icon: 'play', title: byHand ? RUN_TRIGGER[trig] || 'By hand' : 'Run by hand', sub: byHand ? 'Started this run' : '', dashed: !byHand, ran: byHand }),
        ...def.when.map((t, i) => () => ({
          sel: `t${i}`, kind: 'trigger', type: t.type, icon: 'trigger', title: TRIGGER_INFO[t.type]?.name || t.type,
          sub: t.type === trig ? 'Started this run' : triggerSummary(t), ran: t.type === trig,
        })),
      ],
      step: (s, place) => {
        const a = stats.get(place.key);
        const word = a ? STATUS_WORD[a.status] || a.status : 'Didn\'t run';
        return {
          sel: `k:${place.key}`, type: s.type, icon: s.type,
          title: s.label || STEP_INFO[s.type]?.name || s.type,
          sub: runNodeSub(s, a),
          status: a?.status || 'pending',
          ran: !!a && !['pending', 'skipped'].includes(a.status),
          badge: a ? `${STATUS_GLYPH[a.status] || ''}${a.passes > 1 ? ` ×${a.passes}` : ''}` : '',
          note: a?.passes > 1 ? `${word}, ${a.passes} times` : word,
          branches: a?.branches,
          loopLabel: s.type === 'each' ? `Each ${s.as || 'item'}` : '',
        };
      },
      end: { sel: 'end', type: 'end', title: END_TITLE[r.status] || r.status, sub: runDuration(r), status: r.status, ran: r.status === 'ok' },
      select: sel => { runState.sel = sel; },
      inspect: (box, sel, close) => inspectRun(box, sel, close, { r, def, stats, trig, byHand }),
      tools: [roomBtn()],
    });
    return h('div', { class: 'wf-mappane' },
      strays.length ? h('p', { class: 'field-hint wf-map-strays', text: `${plural(strays.length, 'step')} in this run ${strays.length === 1 ? 'isn\'t' : 'aren\'t'} in the workflow any more. List shows everything it did.` }) : null,
      canvas.el);
  }

  // What a node says under its name during a run: how long, how many, which way.
  function runNodeSub(s, a) {
    if (!a) return stepSummary(s);
    const e = a.entries[a.entries.length - 1];
    if (s.type === 'if' && a.branches.length === 1) return a.branches[0] === 'then' ? 'Went to Then' : 'Went to Otherwise';
    if (s.type === 'each' && e.output && Number.isFinite(e.output.count)) return e.output.total > e.output.count ? `${e.output.count} of ${e.output.total}` : plural(e.output.count, 'item');
    if (a.status === 'waiting') return e.question || (e.waitUntil ? `Until ${SB.untilTime(e.waitUntil)}` : 'Waiting for you');
    if (a.status === 'error' && e.error) return firstLine(e.error);
    return e.startedAt && e.endedAt ? SB.duration(e.endedAt - e.startedAt) : stepSummary(s);
  }

  // Open on what needs you: a step that's asking, else the one that failed.
  function firstConcern(r, stats) {
    if (r.waiting?.key) return `k:${G.keyTemplate(r.waiting.key)}`;
    for (const [key, a] of stats) if (a.status === 'error') return `k:${key}`;
    return null;
  }

  function inspectRun(box, sel, close, { r, def, stats, trig, byHand }) {
    if (sel === 'end') {
      fill(box, inspRoot('end', inspHead('flag', END_TITLE[r.status] || r.status, null, close),
        h('p', { class: 'field-hint', text: [r.endedAt ? `Ended ${SB.relTime(r.endedAt)}` : 'Not finished', runDuration(r)].filter(Boolean).join(' · ') }),
        r.error ? h('pre', { class: 'wf-run-error small', text: r.error }) : null,
        Object.keys(r.vars || {}).length ? factsList('Values', r.vars) : h('p', { class: 'field-hint', text: 'No values were set.' })));
      return true;
    }
    if (sel === 'manual' || /^t\d+$/.test(sel)) {
      const t = sel === 'manual' ? null : def.when[Number(sel.slice(1))];
      const started = t ? t.type === trig : byHand;
      const data = r.trigger?.data;
      fill(box, inspRoot('trigger', inspHead(t ? 'trigger' : 'play', t ? TRIGGER_INFO[t.type]?.name || t.type : 'Run by hand', null, close),
        started ? null : h('p', { class: 'field-hint', text: 'This didn\'t start this run.' }),
        started && data && Object.keys(data).length ? factsList('What started it', data) : null,
        started && Object.keys(r.inputs || {}).length ? factsList('Inputs', r.inputs) : null,
        started && !Object.keys(data || {}).length && !Object.keys(r.inputs || {}).length ? h('p', { class: 'field-hint', text: 'It started this run, with nothing to pass on.' }) : null));
      return true;
    }
    const key = sel.slice(2);
    const found = G.stepKeys(def.steps).find(x => x.key === key);
    if (!found) return false;
    const s = found.step;
    const a = stats.get(key);
    const items = [];
    for (const e of a?.entries || []) {
      const pass = /.*\.each(\d+)\./.exec(e.key || ''); // the innermost loop's pass
      if (a.passes > 1 && pass) items.push(h('li', { class: 'wf-tl-pass', style: '--depth: 0', text: `#${Number(pass[1]) + 1}` }));
      items.push(timelineItem(r, e, 0));
    }
    fill(box, inspRoot(s.type, inspHead(s.type, s.label || STEP_INFO[s.type]?.name || s.type, null, close),
      h('p', { class: 'field-hint wfc-insp-sub', text: stepSummary(s) }),
      items.length ? h('ol', { class: 'wf-tl wfc-insp-tl' }, items) : h('p', { class: 'field-hint', text: 'It didn\'t run.' })));
    return true;
  }

  let loadingRun = false;
  async function loadRun() {
    if (loadingRun) return;
    loadingRun = true;
    const id = runState.id;
    let rec;
    try { rec = await api.getRun(id); } catch { rec = null; }
    loadingRun = false;
    if (runState.id !== id) return;
    runState.rec = rec || null;
    if (current().name === 'run') keepFocus(renderRun);
  }

  function runActions(r) {
    const busy = runState.busy;
    const act = (label, kind, fn, cls = 'btn slim-btn') => h('button', { type: 'button', class: cls, disabled: !!busy, 'data-fk': `act-${kind}`, onclick: () => fn(r) }, busy === kind ? `${label}…` : label);
    const btns = [];
    if (r.status === 'running' || r.status === 'waiting') btns.push(act('Stop', 'stop', stopRun));
    if (['error', 'interrupted', 'stopped'].includes(r.status)) btns.push(act('Retry from the failed step', 'resume', resumeRun));
    if (r.status === 'error') btns.push(act(busy === 'repair' ? 'Claude is looking' : 'Fix with Claude', 'repair', repairRun, 'btn primary slim-btn'));
    return btns.length ? h('div', { class: 'row wrap wf-run-actions' }, btns) : null;
  }

  async function runCall(kind, fn, okText) {
    runState.busy = kind;
    keepFocus(renderRun);
    let res;
    try { res = await fn(); } catch { res = { ok: false, error: 'That didn\'t work. Try again.' }; }
    runState.busy = '';
    SB.toast(res?.ok ? okText : res?.error || 'That didn\'t work.');
    if (current().name === 'run') { keepFocus(renderRun); refreshRun(); }
    return res;
  }

  const stopRun = r => runCall('stop', () => api.stopRun(r.id), 'Stopping it');
  const resumeRun = r => runCall('resume', () => api.resumeRun(r.id), 'Picking up from the failed step');

  async function repairRun(r) {
    runState.busy = 'repair';
    keepFocus(renderRun);
    let res;
    try { res = await api.repairWorkflow(r.id); } catch { res = { ok: false, error: 'Couldn\'t reach Claude. Try again.' }; }
    runState.busy = '';
    if (!res?.ok || !res.workflow) {
      SB.toast(res?.error || 'Claude couldn\'t fix it.');
      if (current().name === 'run') keepFocus(renderRun);
      return;
    }
    // The id is kept, so saving overwrites the workflow that failed.
    openEditor(res.workflow, { title: `Fix “${res.workflow.name || r.workflowName}”`, note: res.note || 'Claude changed the workflow. Check it over, then press Save.' });
  }

  function factsList(title, obj) {
    return h('div', { class: 'wf-facts' }, h('h3', { class: 'wf-h3', text: title }),
      h('dl', {}, Object.entries(obj).flatMap(([k, v]) => [h('dt', { class: 'wf-mono', text: k }), h('dd', { text: typeof v === 'string' ? v : pretty(v) })])));
  }

  // Keys are paths of step ids: look, pick.then.fix, files.each3.move. Indent by depth, and head each
  // loop pass with its number.
  function timeline(r) {
    const order = (r.order || Object.keys(r.steps || {})).filter(k => r.steps?.[k]);
    if (!order.length) return h('p', { class: 'wf-empty small', text: 'No steps have started yet.' });
    const items = [];
    const seenPass = new Set();
    for (const key of order) {
      const parts = key.split('.');
      for (let i = 1; i < parts.length; i += 2) {
        const m = /^each(\d+)$/.exec(parts[i]);
        const pass = parts.slice(0, i + 1).join('.');
        if (m && !seenPass.has(pass)) {
          seenPass.add(pass);
          items.push(h('li', { class: 'wf-tl-pass', style: `--depth: ${(i + 1) / 2}`, text: `#${Number(m[1]) + 1}` }));
        }
      }
      items.push(timelineItem(r, r.steps[key], (parts.length - 1) / 2));
    }
    return h('ol', { class: 'wf-tl' }, items);
  }

  function timelineItem(r, e, depth) {
    const meta = [];
    if (e.startedAt && e.endedAt) meta.push(SB.duration(e.endedAt - e.startedAt));
    if (e.attempts > 1) meta.push(`${e.attempts} tries`);
    if (e.type === 'if' && e.output?.branch) meta.push(e.output.branch === 'then' ? 'went to Then' : 'went to Otherwise');
    if (e.type === 'each' && e.output && Number.isFinite(e.output.count)) meta.push(e.output.total > e.output.count ? `${e.output.count} of ${e.output.total}` : plural(e.output.count, 'item'));
    if (e.status === 'waiting' && e.waitUntil) meta.push(`until ${SB.untilTime(e.waitUntil)}`);
    const waitingAsk = e.status === 'waiting' && (e.question || (r.waiting?.key === e.key && r.waiting.question));
    return h('li', { class: `wf-tl-item s-${e.status}`, style: `--depth: ${depth}` },
      h('span', { class: 'wf-tl-glyph', 'aria-hidden': 'true', text: STATUS_GLYPH[e.status] || '·' }),
      h('div', { class: 'wf-tl-main' },
        h('div', { class: 'wf-tl-title' },
          h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon(e.type)),
          h('span', { class: 'wf-tl-name', text: e.label || e.id || STEP_INFO[e.type]?.name || e.key }),
          h('span', { class: 'sr-only', text: `: ${STATUS_WORD[e.status] || e.status}` }),
          meta.length ? h('span', { class: 'wf-tl-meta', text: meta.join(' · ') }) : null),
        e.error ? h('pre', { class: 'wf-run-error small', text: e.error }) : null,
        waitingAsk ? askBox(r, e) : null,
        e.tabId ? h('button', { type: 'button', class: 'btn ghost slim-btn wf-open-tab', onclick: () => openTab(e.tabId) }, 'Open conversation') : null,
        e.output != null && e.type !== 'if' ? stepOutput(e) : null));
  }

  function askBox(r, e) {
    const question = e.question || r.waiting?.question || '';
    const choices = e.choices?.length ? e.choices : r.waiting?.choices?.length ? r.waiting.choices : ['Continue', 'Stop'];
    return h('div', { class: 'wf-waiting', role: 'group', 'aria-label': 'Waiting for you' },
      h('p', { class: 'wf-waiting-q', text: question }),
      h('div', { class: 'row wrap' }, choices.map(c => h('button', {
        type: 'button', class: 'btn slim-btn',
        onclick: async ev => { ev.currentTarget.disabled = true; await answer(r.id, e.key, c); refreshRun(); },
      }, c))));
  }

  function openTab(tabId) {
    if (state.tabs.has(tabId)) { SB.activate(tabId); return; }
    SB.setView('chat');
    SB.toast('That conversation is closed. Find it in History.');
  }

  function stepOutput(e) {
    const o = e.output;
    let body;
    if (e.type === 'claude' && typeof o === 'object') {
      const rest = { ...o };
      delete rest.reply;
      delete rest.tabId;
      body = [o.reply ? SB.renderMarkdownInto(h('div', { class: 'wf-md' }), String(o.reply)) : null,
        Object.keys(rest).length ? h('pre', { class: 'wf-pre', text: pretty(rest) }) : null];
    } else if (e.type === 'run' && typeof o === 'object') {
      body = [h('pre', { class: 'wf-pre', text: String(o.output ?? '') || '(nothing printed)' }), h('p', { class: 'field-hint', text: `Exit code ${o.code}` })];
    } else if (e.type === 'http' && typeof o === 'object') {
      body = [h('p', { class: 'field-hint', text: `Status ${o.status}` }), h('pre', { class: 'wf-pre', text: o.json != null ? pretty(o.json) : String(o.body ?? '') })];
    } else if (e.type === 'file' && typeof o === 'object' && 'text' in o) {
      body = h('pre', { class: 'wf-pre', text: String(o.text ?? '') });
    } else {
      body = h('pre', { class: 'wf-pre', text: pretty(o) });
    }
    return outputDetails(e.key, 'Output', body);
  }

  function outputDetails(key, label, body) {
    const det = h('details', { class: 'wf-out', open: openOutputs.has(key) }, h('summary', { text: label }), body);
    det.addEventListener('toggle', () => { if (det.open) openOutputs.add(key); else openOutputs.delete(key); });
    return det;
  }

  function pretty(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  // ================================================================ live updates

  function applyView(v) {
    if (!v || typeof v !== 'object') return;
    state.workflows = v;
    if (state.view === 'workflows' && current().name === 'list') fillList();
  }

  const refreshList = throttle(() => { if (state.view === 'workflows' && current().name === 'list') fillList(); }, 600);
  const refreshRuns = throttle(() => { if (current().name === 'runs') loadRuns(); }, 800);
  const refreshRun = throttle(() => { if (current().name === 'run') loadRun(); }, 500);

  function onRun(summary) {
    if (!summary?.id) return;
    ed.chat?.onRun(summary); // Claude's test run, wherever you are
    const w = workflows().find(x => x.id === summary.workflowId);
    if (w && (!w.lastRun || w.lastRun.id === summary.id || (summary.startedAt || 0) >= (w.lastRun.startedAt || 0))) w.lastRun = summary;
    if (state.view !== 'workflows') return;
    const s = current();
    if (s.name === 'list') refreshList();
    if (s.name === 'runs' && s.id === summary.workflowId) refreshRuns();
    if (s.name === 'run' && s.runId === summary.id) refreshRun();
  }

  // Next-run times drift into the past while the panel is open.
  setInterval(() => { if (state.view === 'workflows' && current().name === 'list') api.listWorkflows().then(applyView).catch(() => {}); }, 60000);

  // ================================================================ wiring

  SB.applyWorkflows = applyView;
  SB.onWorkflowRun = onRun;
  SB.workflows = {
    create: () => { SB.setView('workflows'); leaveEditorIfNeeded(() => openEditor(blankWorkflow())); },
    describe: () => {
      SB.setView('workflows');
      leaveEditorIfNeeded(() => {
        if (nav.length > 1) home();
        focusDescribe = true;
        requestAnimationFrame(takeDescribeFocus);
      });
    },
  };

  // A notification about a run (it needs an answer, it failed) opens that run.
  function openRun(runId) {
    if (typeof runId !== 'string') return;
    nav = [{ name: 'list' }, { name: 'run', runId }];
    if (state.view !== 'workflows') SB.setView('workflows'); else show();
  }

  SB.views.workflows = { render, openRun };
})();
