/* Shellby panel — All files, the File manager's second tab (trail.js keeps the drawer, its tabs,
   width and grip): the whole project of the conversation you're in, as the file viewer's tree,
   beside the chat. Each file carries its git mark and +/− against HEAD, and each folder the
   totals of what's under it (main's viewer:status); the branch row opens the viewer's worktree
   and branch menu. Files light up as Claude reads them (purple), writes them (orange) and
   commits them (green), and the folders they're in open while they're lit. Which rows light and
   for how long is shared/files-logic.js's (pure); the file you pick to send along is
   files-select.js's. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const V = window.ShellbyViewer;
  const F = window.ShellbyFiles;
  const REFRESH_MS = 2000;   // a status read at most this often, as the viewer looks
  const PAINT_MS = 200;      // rows redrawn at most this often while items pour in
  const FOLLOW_KEY = 'shellby.files.follow';
  const WORDS = { R: 'Renamed', U: 'Conflicted: both sides changed it' };
  const word = s => WORDS[s] || V.statusWord(s);
  const stClass = s => (s === 'U' ? 'conflict' : V.statusClass(s));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fullPath = (root, rel) => `${root}\\${rel.replace(/\//g, '\\')}`; // as the viewer's openInEditor builds it

  const dock = $('filesDock');
  // A conversation's own window has no All files: main sends viewer:stale to the panel only, so a
  // tree there would never look again. Its tab hides, and Ctrl+Shift+F shows the Trail.
  if (SB.solo) { $('drawerTabFiles').hidden = true; return; }
  const branchEl = h('div', { class: 'ft-branch' });
  const filterEl = h('input', { class: 'field ft-filter', type: 'search', placeholder: 'Search files', 'aria-label': 'Search files', spellcheck: 'false' });
  const pinsEl = h('div', { class: 'ft-pins', 'aria-hidden': 'true' });
  const rowsEl = h('div', { class: 'ft-rows' });
  const treeEl = h('div', { class: 'ft-tree', role: 'tree', tabindex: '0', 'aria-label': 'All files' }, pinsEl, rowsEl);
  // The branch row's parts are built once and updated in place: a status read every couple of seconds
  // must not replace the button the menu is anchored to, or the one holding the keyboard.
  const nogitEl = h('span', { class: 'ft-nogit', text: 'Not a git repo' });
  const nameEl = h('span', { class: 'ft-branch-name' });
  const abEl = h('span', { class: 'ft-ab' });
  const whereBtn = h('button', { type: 'button', class: 'ft-where', 'aria-haspopup': 'menu', onclick: () => openPlaces() }, nameEl, abEl,
    h('span', { class: 'vw-where-caret', 'aria-hidden': 'true', text: '▾' }));
  const errText = document.createTextNode('');
  const retryBtn = h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Retry', onclick: () => load() });
  const errEl = h('span', { class: 'ft-err' }, errText, ' ', retryBtn);
  const sumsEl = h('span', { class: 'ft-sums' });
  const pickedEl = h('span', { class: 'ft-picked' });
  const unpickBtn = h('button', { type: 'button', class: 'icon-btn ft-unpick', title: 'Stop sending this file along', 'aria-label': 'Clear the picked file', text: '×' });
  const followBox = h('input', { type: 'checkbox' });
  const footEl = h('footer', { class: 'ft-foot' }, pickedEl, unpickBtn,
    h('label', { class: 'ft-follow', title: 'Keep what Claude is working on in view' }, followBox, 'Follow'));
  dock.replaceChildren(branchEl, filterEl, treeEl, footEl);

  let shown = false;         // the drawer is open on this tab
  let me = null;             // what's shown (fresh() below), or { tabId, cwd, note } while there's no tree
  let follow = SB.pref(FOLLOW_KEY) !== '0';
  let followed = null;       // the newest lit row already scrolled to
  let lastRead = 0, timer = 0, darkTimer = 0, frame = 0, lastPaint = 0;
  let missed = false;        // a nudge came while another screen was up: read when the chat is back
  const live = () => shown && state.view === 'chat'; // up, and on screen
  const flash = F.create();  // what's lit, and the folders a flash opened (files-logic.js)
  const opens = new Map();   // a conversation's id -> the folders open in its tree, while Shellby runs
  followBox.checked = follow;

  function fresh(tabId, cwd, req, r, place = null, home = null) {
    if (!opens.has(tabId)) opens.set(tabId, new Set());
    return {
      tabId, cwd, req, place, home: home || r.root, id: r.id, root: r.root, git: r.git, branch: r.branch,
      upstream: null, ahead: 0, behind: 0, entries: [], files: [], byKey: new Map(), marks: new Map(), sums: new Map(),
      tree: null, paths: new Map(), untracked: '', open: opens.get(tabId), filter: '', activeKey: null, rows: [],
      error: null, gone: false, read: false, note: null, reopening: null,
    };
  }

  // ------------------------------------------------------------ the handle

  // A call on the dock's handle. One main dropped (eight others opened since) is opened again, once,
  // by every call that finds it gone at the same time.
  async function call(at, fn) {
    let r = await fn(at.id).catch(() => null);
    if (r?.expired) {
      at.reopening ||= (at.place ? SB.viewer.reopen({ req: at.req, place: at.place }) : api.viewerOpen(at.req))
        .catch(() => null).finally(() => { at.reopening = null; });
      const again = await at.reopening;
      if (me !== at) return { ok: false };
      if (!again?.ok) return again?.gone ? { ok: false, gone: true } : { ok: false, error: again?.error || "Couldn't open that folder." };
      if (at.id !== again.id) { at.id = again.id; at.read = false; } // a new handle: its first read compares with nothing
      r = await fn(at.id).catch(() => null);
    }
    return r || { ok: false, error: "Couldn't read that." };
  }

  // The conversation in the focused pane gets the tree; a new one, or one moved into its own copy,
  // gets a handle of its own (opened with its id, so main closes it with the conversation).
  // quiet: a catch-up (the tab shown again) lights nothing; activating the conversation already shown
  // reads as any nudge would, so a commit's flash isn't swallowed.
  async function ensure(quiet = true) {
    const tab = state.tabs.get(state.activeTab) || null;
    const cwd = tab?.cwd || null;
    // A folder found gone is opened afresh (it may be back), not read again through its old handle.
    if (me && tab && me.tabId === tab.id && me.cwd === cwd && (me.root || me.note) && !me.gone) return me.root ? load({ tree: true, quiet }) : draw();
    if (me?.id) api.viewerClose(me.id);
    Object.assign(flash, F.create());
    clearTimeout(darkTimer);
    if (!tab || !cwd) { me = { tabId: tab?.id || null, cwd, note: tab ? 'This conversation has no folder yet.' : 'No conversation open.' }; return draw(); }
    const at = me = { tabId: tab.id, cwd, note: 'Opening…' };
    draw();
    const req = { tabId: tab.id };
    const r = await api.viewerOpen(req).catch(() => null);
    if (me !== at) { if (r?.ok) api.viewerClose(r.id); return; }
    if (!r?.ok) { at.note = r?.error || "Couldn't open that folder."; return draw(); }
    me = fresh(tab.id, cwd, req, r);
    await load({ tree: true, quiet: true });
  }

  // The marks (and, when asked or a new untracked folder turned up, the tree) read again. quiet: a
  // first look or a catch-up, which lights nothing.
  async function load({ tree = false, quiet = false } = {}) {
    const at = me;
    if (!at?.id) return;
    lastRead = Date.now();
    const [st, tr] = await Promise.all([
      call(at, id => api.viewerStatus(id)),
      tree || !at.entries.length ? call(at, id => api.viewerTree(id)) : null,
    ]);
    if (me !== at) return;
    if (st.gone || tr?.gone) {
      if (at.place) return goHome(at); // a worktree picked from the menu, deleted: the conversation's own folder again
      at.gone = true;
      return draw();
    }
    at.gone = false; // made again since
    if (tr?.ok) { at.entries = tr.entries; at.tree = null; }
    // A folder git lists whole ('?? new/'): its files are in the index only once it's read again, and
    // afresh (main caches its list a while, and more files in it later won't change that line).
    if (takeStatus(at, st, quiet) && !tree) {
      const again = await call(at, id => api.viewerTree(id, { fresh: true }));
      if (me !== at) return;
      if (again.ok) { at.entries = again.entries; at.tree = null; }
    }
    draw();
    if (flash.lit.size) lit(); // a file lit before git knew it is in the tree now: reveal it
  }

  // -> whether the untracked files changed (the tree then needs reading again)
  function takeStatus(at, r, quiet) {
    if (r?.noGit) {
      Object.assign(at, { git: false, files: [], byKey: new Map(), marks: new Map(), sums: new Map(), error: null, tree: null });
      return false;
    }
    if (!r?.ok) { at.error = r?.error || "Couldn't read git status."; return false; } // the last marks stay
    const before = at.files;
    Object.assign(at, { error: null, git: true, files: r.files, branch: r.branch, upstream: r.upstream, ahead: r.ahead, behind: r.behind, tree: null });
    at.byKey = new Map(r.files.map(f => [F.keyOf(f.path), f]));
    at.marks = new Map(r.files.map(f => [F.keyOf(f.path), f.status]));
    at.sums = F.totals(r.files);
    // With what's inside a folder git lists whole: more files in it leave its line as it was.
    const untracked = r.files.filter(f => f.status === '?').map(f => f.path).join('\0') + '\0' + (r.untrackedIn || '');
    const grew = at.read && untracked !== at.untracked;
    at.untracked = untracked;
    const ran = flash.ranShell;
    flash.ranShell = false;
    if (at.read && !quiet && shown) {
      const now = Date.now();
      // A shell command since the last read: whatever it changed lights as a write would.
      const a = ran && F.light(flash, F.changedBetween(before, r.files), 'write', now);
      const b = F.light(flash, [...(r.committed || []), ...(r.staged || [])], 'commit', now);
      if (a || b) lit();
    }
    at.read = true;
    return grew;
  }

  // Main's nudge: something in the folder may have changed. One read at most every REFRESH_MS,
  // and none while hidden: showing the tab reads again anyway.
  // With another screen up (the viewer, Settings), it notes the nudge and reads when the chat is back.
  api.onViewerStale(({ ids } = {}) => {
    if (!shown || timer || !me?.id || !ids?.includes(me.id)) return;
    if (state.view !== 'chat') { missed = true; return; }
    timer = setTimeout(() => { timer = 0; if (live()) load(); else missed = true; }, Math.max(0, REFRESH_MS - (Date.now() - lastRead)));
  });

  // ------------------------------------------------------------ drawing

  function treeOf(at) {
    if (!at.tree) {
      // Folders git lists whole ('new/') go in as folders, so one shows at once, marked '?' (markOf);
      // as files, buildTree would make one named ''.
      const whole = f => f.path.endsWith('/');
      at.tree = V.buildTree([...at.entries, ...at.files.filter(whole).map(f => f.path)], at.files.filter(f => !whole(f)));
      at.paths = new Map();
      (function walk(n) { for (const c of n.children) { at.paths.set(F.keyOf(c.path), c.path); if (c.dir) walk(c); } })(at.tree);
    }
    return at.tree;
  }

  function draw() {
    if (!shown) return;
    const at = me;
    const note = !at ? 'No conversation open.' : at.gone ? 'This folder is gone.' : at.note;
    filterEl.hidden = footEl.hidden = !!note;
    if (note) {
      branchEl.replaceChildren();
      pinsEl.replaceChildren();
      rowsEl.replaceChildren(h('p', { class: 'ft-note', text: note }));
      return;
    }
    drawBranch();
    drawRows();
    drawFoot();
  }

  // The branch, ahead and behind its upstream, and the repo's totals; a button that opens the menu.
  function drawBranch() {
    const at = me;
    if (!at.git) return setBranch([nogitEl]);
    const ab = at.upstream ? [at.ahead ? `↑${at.ahead}` : '', at.behind ? `↓${at.behind}` : ''].filter(Boolean).join(' ') : '';
    nameEl.textContent = at.branch || 'detached';
    abEl.textContent = ab;
    abEl.hidden = !ab;
    abEl.title = ab ? `Ahead of ${at.upstream} by ${at.ahead}, behind by ${at.behind}` : '';
    whereBtn.title = `${at.root}\nWorktrees and branches`;
    if (at.error) errText.nodeValue = at.error; else sumsEl.textContent = F.totalsText(at.sums.get('')) || 'clean';
    setBranch([whereBtn, at.error ? errEl : sumsEl]);
  }

  // Only when the parts differ: putting the same nodes back would drop the keyboard from a focused one.
  function setBranch(parts) {
    const now = branchEl.children;
    if (now.length === parts.length && parts.every((p, i) => now[i] === p)) return;
    branchEl.replaceChildren(...parts);
  }

  // The conversation's pick, as a path in its own folder's tree (never shown on a picked worktree).
  function pickedRel(at) {
    return (!at.place && SB.treePick?.(state.tabs.get(at.tabId))?.rel) || '';
  }

  function drawRows() {
    const at = me;
    const list = V.visibleRows(treeOf(at), at.open, at.filter);
    at.rows = list.slice(0, F.ROW_CAP);
    const picked = F.keyOf(pickedRel(at)) || null;
    if (!list.length) rowsEl.replaceChildren(h('p', { class: 'ft-note', text: at.filter ? 'Nothing matches.' : 'No files here.' }));
    else rowsEl.replaceChildren(...at.rows.map((r, i) => rowEl(at, r, i, picked)),
      ...(list.length > at.rows.length ? [h('div', { class: 'ft-more', text: `… ${list.length - at.rows.length} more, collapse folders or search.` })] : []));
    markActive();
    followNewest();
    pinRows();
  }

  function rowEl(at, { node, depth }, i, picked) {
    const key = F.keyOf(node.path);
    const mark = F.markOf(at.marks, node.path);
    const glow = flash.lit.get(key);
    const opened = node.dir && (at.open.has(node.path) || !!at.filter);
    const f = node.dir ? null : at.byKey.get(key);
    const cls = ['ft-row', node.dir ? 'ft-dir' : 'ft-file'];
    if (glow) cls.push('lit', `t-${glow.tone}`);
    if (node.dir && flash.revealed.has(key) && !flash.touched.has(key)) cls.push('revealed');
    if (mark === 'D') cls.push('deleted');
    if (key === picked) cls.push('picked');
    const sums = node.dir ? F.totalsText(at.sums.get(key)) : '';
    return h('div', {
      class: cls.join(' '), role: 'treeitem', id: `ft-${i}`, 'aria-level': String(depth + 1),
      'aria-expanded': node.dir ? String(opened) : null, 'aria-selected': 'false',
      dataset: { i: String(i), key }, style: `--d:${Math.min(depth, 16)}`, title: mark ? `${node.path}\n${word(mark)}` : node.path,
    },
    h('span', { class: 'ft-chev', 'aria-hidden': 'true', text: node.dir ? (opened ? '▾' : '▸') : '' }),
    h('span', { class: 'ft-name', text: node.name }),
    sums ? h('span', { class: 'ft-sum', text: sums }) : null,
    f && f.status !== '?' && (f.added || f.removed) ? h('span', { class: 'ft-n' }, h('span', { class: 'add', text: `+${f.added}` }), h('span', { class: 'del', text: ` −${f.removed}` })) : null,
    mark ? h('span', { class: `ft-st st-${stClass(mark)}`, text: mark }) : null);
  }

  function drawFoot() {
    const at = me;
    const rel = pickedRel(at);
    pickedEl.textContent = rel;
    pickedEl.title = rel ? `Goes with your next message: ${rel}` : '';
    unpickBtn.hidden = !rel;
  }

  function markActive() {
    const at = me;
    const i = at.rows.findIndex(r => F.keyOf(r.node.path) === at.activeKey);
    for (const el of rowsEl.querySelectorAll('.ft-row')) el.setAttribute('aria-selected', String(Number(el.dataset.i) === i));
    treeEl.setAttribute('aria-activedescendant', i >= 0 ? `ft-${i}` : '');
    return i;
  }

  // Follow on: the newest lit row comes into view (not with reduced motion: nothing moves on its own).
  function followNewest() {
    if (!follow || reduced() || !flash.newest) return;
    const k = F.keyOf(flash.newest);
    if (followed === k) return;
    const i = me.rows.findIndex(r => F.keyOf(r.node.path) === k);
    if (i < 0) return;
    followed = k;
    rowsEl.querySelector(`#ft-${i}`)?.scrollIntoView({ block: 'nearest' });
  }

  // Follow on: lit rows scrolled above the top stay pinned there, over a ⋮, a third of the view at most.
  function pinRows() {
    pinsEl.replaceChildren();
    if (!follow || !flash.lit.size || !me?.rows?.length) return;
    const rowH = rowsEl.querySelector('.ft-row')?.offsetHeight || 24;
    const first = Math.floor(Math.max(0, treeEl.scrollTop - rowsEl.offsetTop) / rowH);
    const litIdx = me.rows.map((r, i) => (flash.lit.has(F.keyOf(r.node.path)) ? i : -1)).filter(i => i >= 0);
    const pinned = F.pins(litIdx, first, Math.floor(treeEl.clientHeight / 3 / rowH));
    if (!pinned.length) return;
    pinsEl.replaceChildren(...pinned.map(i => {
      const c = rowsEl.querySelector(`#ft-${i}`).cloneNode(true);
      c.removeAttribute('id');
      c.setAttribute('role', 'presentation');
      return c;
    }), h('div', { class: 'ft-pin-more', text: '⋮' }));
  }

  // Rows redrawn at most every PAINT_MS while a turn pours items in.
  function schedule() {
    if (frame) return;
    frame = setTimeout(() => requestAnimationFrame(() => {
      frame = 0;
      lastPaint = performance.now();
      if (shown && me?.root) drawRows();
    }), Math.max(0, lastPaint + PAINT_MS - performance.now()));
  }

  // ------------------------------------------------------------ flashes

  // Every item of every conversation (feed.js, beside the trail): only the one shown, only live
  // ones, and only while this tab is up. Hidden, nothing lights; showing it reads again. But a
  // tool's result and the turn's end still count, or what lit before would stay lit for good.
  SB.filesTake = (tab, item, replay) => {
    if (replay || !me?.root || tab.id !== me.tabId || me.place) return;
    if (!live()) {
      if ((item?.kind === 'tool_result' || item?.kind === 'result') && F.take(flash, item, { root: me.root, now: Date.now() })) darkLater();
      return;
    }
    if ((tab.cwd || null) !== me.cwd) { ensure(); return; } // moved into its own copy: the tree follows
    if (F.take(flash, item, { root: me.root, cwd: tab.cwd, now: Date.now() })) lit();
  };

  // Something lit: open its folders, keep the newest in view, and go dark when the burst is over.
  function lit() {
    const at = me;
    if (!at?.root) return;
    treeOf(at);
    for (const { rel } of flash.lit.values()) {
      if (!at.paths.has(F.keyOf(rel))) continue; // not in the tree yet: once git lists it (load)
      for (const k of F.reveal(flash, rel, x => at.open.has(at.paths.get(x) ?? x))) at.open.add(at.paths.get(k) ?? k);
    }
    followed = null;
    schedule();
    darkLater();
  }

  // Dark when the burst is over; while a tool runs, it has no end yet.
  function darkLater() {
    clearTimeout(darkTimer);
    if (flash.lit.size && Number.isFinite(flash.until)) darkTimer = setTimeout(dark, Math.max(0, flash.until - Date.now()) + 20);
  }

  function dark() {
    const close = F.expire(flash, Date.now());
    if (!close) return darkLater();
    for (const k of close) me?.open?.delete(me.paths.get(k) ?? k);
    schedule();
  }

  // ------------------------------------------------------------ doing things

  const isOpen = node => me.open.has(node.path) || !!me.filter;

  function toggle(node) {
    if (me.open.has(node.path)) me.open.delete(node.path); else me.open.add(node.path);
    F.touch(flash, node.path);
    me.activeKey = F.keyOf(node.path);
    drawRows();
  }

  // A click picks a file to go with your next message (files-select.js). Not in a worktree picked
  // from the menu: the pick belongs to the conversation's own folder.
  function pick(node) {
    const tab = state.tabs.get(me.tabId);
    if (tab && !me.place) SB.setTreePick?.(tab, { rel: node.path });
  }

  // In the full viewer: at its diff when it has changes, else the whole file. Ctrl: your editor.
  function openFile(rel, { ctrl = false } = {}) {
    const at = me;
    if (ctrl || SB.solo || !SB.viewer) return SB.openFile(fullPath(at.root, rel), { tabId: at.tabId });
    if (at.place) return SB.viewer.openPlace(at.req, at.place, { file: rel });
    SB.viewer.openTab(at.tabId, { file: rel });
  }

  function copyPath(rel, full) {
    api.copyText(full ? fullPath(me.root, rel) : rel);
    SB.toast(full ? 'Copied its full path.' : 'Copied its path.', { ms: 2000 });
  }

  // The branch row's menu: the viewer's own (its rows, main's keys), with picks of its own.
  async function openPlaces() {
    const at = me;
    const menu = $('filesMenu');
    if (!at?.git || !whereBtn.isConnected) return;
    if (!menu.hidden) return SB.closeMenus({ refocus: true });
    SB.openMenu(menu, whereBtn, () => [h('div', { class: 'menu-label', text: 'Looking…' })]);
    const r = await call(at, id => api.viewerPlaces(id));
    if (me !== at || menu.hidden) return;
    SB.closeMenus();
    if (!whereBtn.isConnected) return;
    SB.openMenu(menu, whereBtn, () => SB.viewer.placeRows(r, pickPlace));
  }

  // A worktree: the tree switches to it (its own folder again: back home). A branch has no folder,
  // so no marks: it opens in the full viewer, which keeps the handle main just opened.
  // The worktree picked from the menu is gone (deleted, or its branch row's pick went stale): back to
  // the conversation's own folder, which keeps the branch row and its menu, rather than a dead end.
  async function goHome(at) {
    if (at.id) api.viewerClose(at.id);
    at.id = null;
    const r = await api.viewerOpen(at.req).catch(() => null);
    if (me !== at) { if (r?.ok) api.viewerClose(r.id); return; }
    Object.assign(flash, F.create());
    if (!r?.ok) { me = { tabId: at.tabId, cwd: at.cwd, note: r?.error || "Couldn't open that folder." }; return draw(); }
    SB.toast(`${at.place.label || 'That worktree'} is gone. Showing this conversation's folder again.`);
    me = fresh(at.tabId, at.cwd, at.req, r, null, at.home);
    await load({ tree: true, quiet: true });
  }

  async function pickPlace(p) {
    const at = me;
    const r = await api.viewerSwitch(at.id, p.key).catch(() => null);
    if (me !== at) { if (r?.ok) api.viewerClose(r.id); return; }
    if (!r?.ok) return SB.toast(r?.gone || r?.expired ? 'That worktree or branch is gone.' : r?.error || "Couldn't open that.");
    const place = { kind: p.kind, label: p.label, branch: p.branch };
    if (r.kind === 'branch') return SB.viewer.openPicked(at.req, r, place);
    api.viewerClose(at.id);
    const home = r.root.toLowerCase() === at.home.toLowerCase();
    Object.assign(flash, F.create());
    me = fresh(at.tabId, at.cwd, at.req, r, home ? null : place, at.home);
    await load({ tree: true, quiet: true });
  }

  // @path in the box (files-select.js): its row comes into view and takes the keyboard, unpicked.
  SB.filesReveal = (p) => {
    const at = me;
    const tab = at?.root && state.tabs.get(at.tabId);
    if (!shown || !tab) return;
    const rel = F.relOf(p, at.root, tab.cwd) || F.relOf(p, at.root, at.root);
    const path = rel && treeOf(at) && at.paths.get(F.keyOf(rel));
    if (!path) return;
    for (const a of F.ancestors(path)) at.open.add(a);
    at.activeKey = F.keyOf(path);
    drawRows();
    const i = markActive();
    if (i >= 0) rowsEl.querySelector(`#ft-${i}`)?.scrollIntoView({ block: 'nearest' });
  };

  // ------------------------------------------------------------ input

  const rowOf = el => { const row = el.closest('.ft-row'); return row && me?.rows ? me.rows[Number(row.dataset.i)] || null : null; };

  rowsEl.addEventListener('click', (e) => {
    const r = rowOf(e.target);
    if (!r) return;
    me.activeKey = F.keyOf(r.node.path);
    if (r.node.dir) return toggle(r.node);
    markActive();
    pick(r.node);
  });
  rowsEl.addEventListener('dblclick', (e) => { const r = rowOf(e.target); if (r && !r.node.dir) openFile(r.node.path, { ctrl: e.ctrlKey }); });
  rowsEl.addEventListener('contextmenu', (e) => { const r = rowOf(e.target); if (!r) return; e.preventDefault(); copyPath(r.node.path, e.shiftKey); });
  // The tree keeps the keyboard; the rows aren't stops of their own (as the trail's map).
  rowsEl.addEventListener('mousedown', (e) => { e.preventDefault(); treeEl.focus({ preventScroll: true }); });
  pinsEl.addEventListener('click', (e) => {
    const key = e.target.closest('.ft-row')?.dataset.key;
    const i = me?.rows?.findIndex(r => F.keyOf(r.node.path) === key) ?? -1;
    if (i >= 0) rowsEl.querySelector(`#ft-${i}`)?.scrollIntoView({ block: 'center' });
  });
  let scrollFrame = 0;
  treeEl.addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; pinRows(); }); });

  treeEl.addEventListener('keydown', (e) => {
    const at = me;
    if (!at?.rows?.length) return;
    let i = Math.max(0, at.rows.findIndex(r => F.keyOf(r.node.path) === at.activeKey));
    const r = at.rows[i];
    const go = to => {
      i = Math.max(0, Math.min(at.rows.length - 1, to));
      at.activeKey = F.keyOf(at.rows[i].node.path);
      markActive();
      rowsEl.querySelector(`#ft-${i}`)?.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return go(i + 1);
      case 'ArrowUp': e.preventDefault(); return go(i - 1);
      case 'Home': e.preventDefault(); return go(0);
      case 'End': e.preventDefault(); return go(at.rows.length - 1);
      case 'ArrowRight': e.preventDefault(); return r.node.dir && !isOpen(r.node) ? toggle(r.node) : go(i + 1);
      case 'ArrowLeft': e.preventDefault(); return r.node.dir && isOpen(r.node) ? toggle(r.node) : go(i - 1);
      case 'Enter': e.preventDefault(); return r.node.dir ? toggle(r.node) : openFile(r.node.path, { ctrl: e.ctrlKey });
    }
  });
  treeEl.addEventListener('focus', () => { if (me?.rows?.length && !me.activeKey) { me.activeKey = F.keyOf(me.rows[0].node.path); markActive(); } });

  filterEl.addEventListener('input', () => { if (!me?.root) return; me.filter = filterEl.value; drawRows(); });
  unpickBtn.addEventListener('click', () => SB.setTreePick?.(state.tabs.get(me?.tabId), null));
  followBox.addEventListener('change', () => {
    follow = followBox.checked;
    try { window.localStorage.setItem(FOLLOW_KEY, follow ? '1' : '0'); } catch { /* lasts this session */ }
    pinRows();
  });

  // ------------------------------------------------------------ the drawer

  SB.drawerTab('files', {
    show({ focus = false } = {}) {
      shown = true;
      dock.hidden = false;
      ensure();
      if (focus) treeEl.focus();
    },
    hide() {
      shown = false;
      dock.hidden = true;
      if (!$('filesMenu').hidden) SB.closeMenus();
    },
  });
  // The conversation in the focused pane changed (tabs.js activate): the tree, and the chip, follow it.
  SB.filesFollow = () => { if (shown) ensure(false); SB.renderPickChip?.(); };
  SB.filesRedraw = () => { if (shown && me?.root) { drawRows(); drawFoot(); } };
  // Back to the chat (SB.setView calls its render): a nudge missed meanwhile is read now. The chat's
  // render belongs to pane-room.js, which loads before this file; it still runs first.
  const chatView = SB.views.chat;
  SB.views.chat = {
    ...chatView,
    render() {
      chatView?.render?.();
      if (missed && shown && me?.root) { missed = false; load({ quiet: true }); }
    },
  };

  // For the e2e (scripts/e2e-files.js): what's shown and what's lit.
  SB.filesDock = {
    current: () => (me?.root ? {
      id: me.id, root: me.root, place: me.place, branch: me.branch, error: me.error, files: me.files,
      open: [...me.open], lit: [...flash.lit.values()].map(l => [l.rel, l.tone]), shown,
    } : null),
  };
})();
