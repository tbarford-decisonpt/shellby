/* Shellby panel — the file viewer: a conversation's folder (or a project's
   worktree) as a tree and a list of what changed since its branch began, any
   file in colour, and each change as a diff with both sides' line numbers.
   Read-only: main hands over a handle and keeps every read inside it (main's
   viewer.js). Opened from a pane's Files button, file links, the branch chip
   and the Project page. Its header's menu switches to another worktree of the
   repo, or to a branch nothing has checked out, read from git alone. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const V = window.ShellbyViewer;
  const S = window.ShellbySyntax;
  const MAX_COLOUR_LINES = 4000;   // past this, plain text
  const REFRESH_MS = 2000;         // at most one look again in this long
  const WRAP_KEY = 'shellby.viewer.wrap'; // '0' once you turn Wrap off; lines wrap until then
  const wrapOn = () => SB.pref(WRAP_KEY) !== '0';
  const ICON = 'M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z';
  const lastFile = new Map(); // a place (V.placeKey) -> the file last open there, while Shellby runs
  let cur = null;             // what's open: the handle, the lists and the file on screen
  let shownAt = 0, timer = null;

  // A call on the handle. One dropped (eight others opened since, a closed tab, a reload) is opened
  // again, once, with its changes list rebuilt, since main serves diffs only for files on that list.
  async function call(fn) {
    const me = cur;
    let r = await fn(me.id).catch(() => null);
    if (r?.expired) {
      const again = await reopen(me);
      if (!again?.ok) {
        if (again?.gone) { me.gone = true; me.branchGone = me.kind === 'branch'; }
        return { ok: false, gone: !!again?.gone, error: again?.error || "Couldn't open that folder." };
      }
      me.id = again.id;
      if (me.git) await api.viewerChanges(me.id, { uncommittedOnly: me.only }).catch(() => null);
      r = await fn(me.id).catch(() => null);
    }
    if (r?.gone) me.gone = true; // the folder was deleted while open: draw() says so
    return r || { ok: false, error: "Couldn't read that." };
  }

  // A place picked from the header's menu has no open request of its own (main hands out keys, not
  // paths): open the first place again, and make the same pick from its menu. Gone only when the list
  // came back without it or main says so; a git hiccup (a timeout) is an error that Retry can answer.
  async function reopen(me) {
    const first = await api.viewerOpen(me.req).catch(() => null);
    if (!first?.ok || !me.place) return first;
    const GONE = { ok: false, gone: true, error: 'That worktree or branch is gone.' };
    const list = await api.viewerPlaces(first.id).catch(() => null);
    const p = list?.ok ? V.findPlace(list.places, me.place) : null;
    const r = p ? await api.viewerSwitch(first.id, p.key).catch(() => null) : null;
    api.viewerClose(first.id);
    if (r?.ok) return r;
    if (list?.ok && (!p || r?.gone)) return GONE;
    return { ok: false, error: r?.error || list?.error || "Couldn't read changes." };
  }

  const ancestors = rel => rel.split('/').slice(0, -1).map((_s, i, parts) => parts.slice(0, i + 1).join('/'));

  // opts.handle: one main has opened already (a pick from the header's menu), and opts.place which
  // pick, so call() can make it again. A pick keeps the file you were on when the new place has it
  // too (on its changes list or in its tree), else opens the one last open there when it still has
  // that, else shows the placeholder (V.keepFile).
  async function start(req, { file = null, line = null, side = null, handle = null, place = null } = {}) {
    const r = handle || await api.viewerOpen(req).catch(() => null);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't open that folder.");
    if (cur && cur.id !== r.id) api.viewerClose(cur.id);
    // Back (and Esc) return to where it was opened from: the chat, or the Project page.
    // Opened again from inside the viewer (a file link in it, a pick from its menu), it keeps the first.
    const from = state.view === 'viewer' ? cur?.from || null : state.view;
    const remembered = lastFile.get(V.placeKey(r)) || null;
    const me = cur = {
      ...r, req, from, place, tabId: place ? null : req.tabId || null, side, only: false, files: [], more: 0, against: null, note: null,
      gone: false, branchGone: false, dirty: false, entries: [], open: new Set(), filter: '',
      file: file || remembered, line, whole: !!line,
    };
    $('viewerFilter').value = '';
    $('viewerMain').replaceChildren();
    SB.setView('viewer');
    draw();
    await Promise.all([loadChanges(), loadTree()]);
    if (cur !== me) return;
    if (me.gone) return draw();
    if (place) me.file = V.keepFile(file, remembered, rel => me.files.some(f => f.path === rel) || me.entries.includes(rel));
    if (!me.side) me.side = me.files.length || me.note ? 'changes' : 'files'; // a failed look says so, on Changes
    if (me.file) for (const a of ancestors(me.file)) me.open.add(a);
    draw();
    if (me.file) showFile(me.file, { line });
    else $('viewerMain').replaceChildren(h('div', { class: 'vw-empty' },
      h('p', { class: 'muted', text: me.files.length ? 'Pick a file to see what changed.' : 'Pick a file to read it.' }),
      me.files.length ? h('p', { class: 'small muted vw-totals', text: V.totalsText(me.files, me.more) }) : null));
  }

  async function loadChanges() {
    const me = cur;
    me.looking = (me.looking || 0) + 1; // looks in flight, for the e2e (current().looking)
    let r;
    try { r = await call(id => api.viewerChanges(id, { uncommittedOnly: me.only })); } finally { me.looking--; }
    if (cur !== me) return;
    shownAt = Date.now();
    me.note = null;
    if (r.branchGone) { me.gone = true; me.branchGone = true; me.files = []; return; }
    if (r.gone) { me.gone = true; me.files = []; return; }
    if (r.noGit) { me.git = false; me.files = []; return; }
    if (!r.ok) { me.files = []; me.note = { text: r.tooManyNew ? 'Too many new files to compare.' : "Couldn't read changes.", retry: !r.tooManyNew }; return; }
    me.files = r.files; me.more = r.more || 0; me.against = r.against;
  }

  async function loadTree() {
    const me = cur;
    const r = await call(id => api.viewerTree(id));
    if (cur === me) me.entries = r.ok ? r.entries : [];
  }

  // The conversation's state in the header: the one it was opened from, or (a pick from the menu, the
  // Project page) one whose folder this is or holds it. A branch is nobody's folder.
  function drawLive() {
    const tab = !cur || cur.kind === 'branch' ? null : cur.tabId ? state.tabs.get(cur.tabId) : V.tabAt(state.tabs.values(), cur.root, state.home);
    const live = V.liveState(tab || null);
    $('viewerLive').hidden = !live;
    if (live) { $('viewerLive').textContent = live.word; $('viewerLive').className = `vw-live ${live.cls}`; }
  }

  function draw() {
    if (!cur) return;
    const where = $('viewerWhere');
    where.replaceChildren(V.whereText(cur), ...(cur.git ? [h('span', { class: 'vw-where-caret', 'aria-hidden': 'true', text: ' ▾' })] : []));
    where.title = cur.root;
    where.disabled = !cur.git; // a folder that isn't a repo has nothing to switch to: plain text, as before
    drawLive();
    if (cur.gone) {
      $('viewerSide').hidden = true;
      $('viewerEditor').hidden = true;
      $('viewerFoot').hidden = true;
      $('viewerMain').replaceChildren(h('div', { class: 'vw-gone' },
        h('p', { text: cur.branchGone ? 'This branch is gone.' : 'This folder is gone.' }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Back', onclick: () => SB.goBack() })));
      return;
    }
    $('viewerSide').hidden = false;
    if (cur.kind === 'branch') $('viewerEditor').hidden = true; // read from git: no file on disk to open
    if (!cur.git) cur.side = 'files';
    $('viewerTabChanges').hidden = !cur.git;
    $('viewerTabChanges').setAttribute('aria-selected', String(cur.side === 'changes'));
    $('viewerTabFiles').setAttribute('aria-selected', String(cur.side === 'files'));
    $('viewerCount').textContent = cur.files.length ? String(cur.files.length + cur.more) : '';
    $('viewerOnlyRow').hidden = cur.side !== 'changes' || !cur.base || cur.kind === 'branch'; // a branch is all commits
    $('viewerOnly').checked = cur.only;
    $('viewerFilter').hidden = cur.side !== 'files';
    const said = cur.side !== 'changes' ? ''
      : cur.note ? cur.note.text
        : cur.more ? `Showing the first ${cur.files.length} of ${cur.files.length + cur.more}.`
          : cur.files.length ? '' : 'Nothing has changed here.';
    $('viewerNote').hidden = !said;
    $('viewerNote').replaceChildren(said, ...(cur.side === 'changes' && cur.note?.retry
      ? [' ', h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Retry', onclick: () => refresh() })] : []));
    $('viewerList').replaceChildren(...(cur.side === 'changes' ? changeRows() : treeRows()));
    const sums = cur.git ? V.totalsText(cur.files, cur.more) : '';
    $('viewerFoot').hidden = !sums || cur.side !== 'changes'; // the totals belong to the Changes list
    $('viewerFoot').textContent = sums;
    for (const el of document.querySelectorAll('#viewerMain .vw-totals')) el.textContent = sums;
  }

  const counts = f => (f.binary ? h('span', { class: 'vw-n muted', text: 'binary' })
    : h('span', { class: 'vw-n' }, f.added ? h('span', { class: 'add', text: `+${f.added}` }) : null, f.removed ? h('span', { class: 'del', text: ` −${f.removed}` }) : null));

  function changeRows() {
    return cur.files.map(f => h('li', {},
      h('button', { type: 'button', class: `vw-row${f.path === cur.file ? ' on' : ''}`, dataset: { path: f.path }, title: `${V.statusWord(f.status)}: ${f.path}`, onclick: () => showFile(f.path) },
        h('span', { class: `vw-st st-${V.statusClass(f.status)}`, text: f.status }),
        h('span', { class: 'vw-path', text: f.path }),
        counts(f))));
  }

  function treeRows() {
    const tree = V.buildTree(cur.entries, cur.files);
    return V.visibleRows(tree, cur.open, cur.filter).map(({ node, depth }) => {
      const opened = node.dir && (cur.open.has(node.path) || !!cur.filter);
      return h('li', {},
        h('button', {
          type: 'button', class: `vw-row vw-d${Math.min(depth, 12)}${node.dir ? ' dir' : ''}${node.path === cur.file ? ' on' : ''}`,
          dataset: { path: node.path }, 'aria-expanded': node.dir ? String(opened) : null,
          onclick: () => (node.dir ? toggle(node.path) : showFile(node.path)),
        },
          h('span', { class: 'vw-caret', 'aria-hidden': 'true', text: node.dir ? (opened ? '▾' : '▸') : '' }),
          h('span', { class: 'vw-path', text: node.name }),
          node.status ? h('span', { class: `vw-st st-${V.statusClass(node.status)}`, text: node.dir ? '•' : node.status, title: node.dir ? 'Something in here changed' : V.statusWord(node.status) }) : null));
    });
  }

  function toggle(dir) {
    if (cur.open.has(dir)) cur.open.delete(dir); else cur.open.add(dir);
    $('viewerList').replaceChildren(...treeRows());
  }

  const note = (text, editor = false) => h('div', { class: 'vw-note-box' },
    h('p', { class: 'muted', text }),
    editor && cur?.kind !== 'branch' ? h('button', { type: 'button', class: 'btn slim-btn', text: 'Open in editor', onclick: openInEditor }) : null);

  function openInEditor() {
    if (!cur?.file) return;
    SB.openFile(`${cur.root}\\${cur.file.replace(/\//g, '\\')}`, { line: cur.line, tabId: cur.tabId || state.activeTab });
  }

  // A line to go to (a link's :42) opens the whole file there, changed or not; Diff is a click away.
  async function showFile(rel, { line = null, keep = false } = {}) {
    const me = cur;
    if (me.file !== rel || line) me.whole = !!line;
    me.file = rel; me.line = line;
    lastFile.set(V.placeKey(me), rel);
    for (const b of document.querySelectorAll('#viewerList .vw-row')) b.classList.toggle('on', b.dataset.path === rel);
    const f = me.files.find(x => x.path === rel) || null;
    const main = $('viewerMain');
    const was = main.querySelector('.vw-scroll');
    const top = was?.scrollTop || 0, left = was?.scrollLeft || 0;
    const body = !f || me.whole ? await wholeFile(rel, line) : await diffOf(f);
    if (cur !== me || me.file !== rel) return;
    if (me.gone) return draw(); // the read found the folder gone: that screen stays
    const scroll = h('div', { class: 'vw-scroll' }, body);
    main.replaceChildren(fileHead(rel, f, body), scroll);
    $('viewerEditor').hidden = me.kind === 'branch';
    if (keep) { scroll.scrollTop = top; scroll.scrollLeft = left; }
    else scroll.querySelector('.hit')?.scrollIntoView({ block: 'center' });
  }

  // The title bar across the top of the right panel; the code scrolls under it. Wrap only
  // where the code is rows (a note has none, and the plain view past the cap can't wrap).
  function fileHead(rel, f, body) {
    const rows = body.matches('.vw-code.diff') || !!body.querySelector('.vw-code.diff');
    const big = body.matches('.vw-big');
    return h('div', { class: 'vw-file-head' },
      h('code', { class: 'vw-file', text: rel, title: rel }),
      f ? h('span', { class: `vw-st st-${V.statusClass(f.status)}`, text: f.status, title: V.statusWord(f.status) }) : null,
      f ? counts(f) : null,
      h('span', { class: 'vw-tools' },
        f ? h('button', {
          type: 'button', class: 'btn ghost slim-btn', text: cur.whole ? 'Diff' : 'Whole file',
          disabled: f.status === 'D' && !cur.whole, onclick: () => { cur.whole = !cur.whole; cur.line = null; showFile(rel); },
        }) : null,
        rows || big ? h('button', {
          type: 'button', class: 'btn ghost slim-btn vw-wrap', text: 'Wrap',
          'aria-pressed': String(rows && wrapOn()),
          // Not disabled, so a keyboard or screen reader reaches it and hears why it does nothing.
          'aria-disabled': big ? 'true' : null,
          'aria-label': big ? "Wrap, unavailable: long files show as plain text, which can't wrap" : null,
          title: big ? "Long files show as plain text, which can't wrap." : 'Wrap long lines',
          onclick: e => { if (!big) setWrap(e.currentTarget, !wrapOn()); },
        }) : null));
  }

  function setWrap(btn, on) {
    SB.pref.set(WRAP_KEY, on ? '1' : '0');
    btn.setAttribute('aria-pressed', String(on));
    for (const c of document.querySelectorAll('#viewerMain .vw-code.diff')) c.classList.toggle('nowrap', !on);
  }

  async function diffOf(f) {
    if (f.binary) return note('A binary file: nothing to show line by line.', true);
    const r = await call(id => api.viewerDiff(id, f.path));
    if (!r.ok) return note(r.error || "Couldn't read the diff.", true);
    const rows = V.numberDiff(r.patch);
    if (!rows.length) return note('No line changes (a mode or line-ending change).');
    const paint = rows.length > MAX_COLOUR_LINES ? null : SB.diffPainter?.(f.path); // plain past the cap, as wholeFile
    const pre = h('pre', { class: `vw-code diff${wrapOn() ? '' : ' nowrap'}` }, rows.map(row => {
      const code = h('span', { class: 'code' });
      const toks = paint && row.cls !== 'meta' ? paint(row.cls, row.text) : null;
      if (toks) SB.paintTokens(code, toks); else code.textContent = row.text;
      return h('span', { class: `dl ${row.cls}` },
        h('span', { class: 'vw-ln', text: row.oldNo ?? '' }),
        h('span', { class: 'vw-ln', text: row.newNo ?? '' }),
        h('span', { class: 'vw-sign', text: row.cls === 'add' ? '+' : row.cls === 'del' ? '−' : '' }),
        code);
    }));
    return r.truncated ? h('div', {}, pre, note('This diff is too big to show in full.', true)) : pre;
  }

  async function wholeFile(rel, line) {
    const r = await call(id => api.viewerRead(id, rel));
    if (r.missing) return note('This file is gone.');
    if (r.tooBig) return note('This file is too big to show here.', true);
    if (r.binary) return note('A binary file: nothing to show as text.', true);
    if (!r.ok) return note(r.error || "Couldn't read that.", true);
    const lines = V.splitLines(r.text);
    if (lines.length > MAX_COLOUR_LINES) {
      // Plain past the cap: two blocks of text instead of a row per line.
      const text = h('pre', { class: 'vw-plain', text: lines.join('\n') });
      if (line) {
        requestAnimationFrame(() => {
          const lh = parseFloat(getComputedStyle(text).lineHeight) || 18;
          const scroller = $('viewerMain').querySelector('.vw-scroll');
          if (scroller) scroller.scrollTop = Math.max(0, (line - 5) * lh);
        });
      }
      return h('div', { class: 'vw-code vw-big' }, h('pre', { class: 'vw-gutter', text: lines.map((_l, i) => i + 1).join('\n') }), text);
    }
    const tk = S.lineTokenizer(S.langFromPath(rel));
    return h('pre', { class: `vw-code diff${wrapOn() ? '' : ' nowrap'}` }, lines.map((l, i) => h('span', { class: `dl ctx${line === i + 1 ? ' hit' : ''}` },
      h('span', { class: 'vw-ln', text: i + 1 }),
      SB.paintTokens(h('span', { class: 'code' }), tk.line(l)))));
  }

  const sig = rel => { const f = cur?.files.find(x => x.path === rel); return f ? `${f.status}${f.added}/${f.removed}` : '-'; };

  async function refresh({ tree = true } = {}) {
    if (!cur) return;
    const me = cur;
    const before = sig(me.file);
    await Promise.all([loadChanges(), tree ? loadTree() : null]);
    if (cur !== me) return;
    draw();
    if (me.gone) return;
    if (me.file && (tree || sig(me.file) !== before)) showFile(me.file, { keep: true }); // no line: Diff or Whole stays as chosen
  }

  // The header's menu: every worktree of the repo, and each branch with commits main lacks. It opens
  // at once and fills in when main has looked (a git status in each worktree can take a moment).
  async function openPlaces() {
    const me = cur;
    const menu = $('viewerMenu');
    const anchor = $('viewerWhere');
    if (!me?.git || !menu.hidden) return SB.closeMenus({ refocus: true });
    SB.openMenu(menu, anchor, () => [h('div', { class: 'menu-label', text: 'Looking…' })]);
    const r = await call(id => api.viewerPlaces(id));
    if (cur !== me || menu.hidden) return;
    SB.closeMenus();
    SB.openMenu(menu, anchor, () => placeRows(r));
  }

  function placeRows(r, onPick = pick) {
    if (!r?.ok) return [h('div', { class: 'menu-label', text: 'Worktrees' }), h('p', { class: 'small muted vw-menu-note', text: "Couldn't list worktrees." })];
    const row = p => SB.menuItem(p.label, V.placeSub(p, SB.relTime), () => onPick(p), { glyph: p.current ? '✓' : '' });
    const trees = r.places.filter(p => p.kind === 'worktree');
    const branches = r.places.filter(p => p.kind === 'branch');
    return [
      h('div', { class: 'menu-label', text: 'Worktrees' }), ...trees.map(row),
      ...(branches.length ? [h('div', { class: 'menu-sep' }), h('div', { class: 'menu-label', text: 'Branches' }), ...branches.map(row)] : []),
    ];
  }

  // A pick: main checks it again and opens it. Straight to main rather than through call(), whose
  // "gone" means this screen's folder: here it means the pick went stale since the menu opened.
  async function pick(p) {
    const me = cur;
    if (!me) return;
    const r = await api.viewerSwitch(me.id, p.key).catch(() => null);
    if (cur !== me) return;
    if (!r?.ok) return SB.toast(r?.gone || r?.expired ? 'That worktree or branch is gone.' : r?.error || "Couldn't open that.");
    start(me.req, { handle: r, place: { kind: p.kind, label: p.label, branch: p.branch }, file: me.file });
  }

  // Main's nudge: something in the folder may have changed. One look, at most every 2 s, only on
  // Changes and only while showing; otherwise the viewer remembers, and looks when it's shown again.
  const showing = () => state.view === 'viewer' && cur?.side === 'changes';
  api.onViewerStale(({ ids } = {}) => {
    if (!cur || !ids?.includes(cur.id)) return;
    if (!showing()) { cur.dirty = true; return; }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (showing()) refresh({ tree: false }); else if (cur) cur.dirty = true;
    }, Math.max(0, REFRESH_MS - (Date.now() - shownAt)));
  });
  // Shown again (Back to chat, then the Files button, or SB.setView): catch up on what it missed.
  SB.views.viewer = {
    parent: () => cur?.from || null, // SB.goBack (nav.js)
    render() {
      if (!cur?.dirty) return;
      cur.dirty = false;
      refresh({ tree: false });
    },
  };

  $('filesBtn').addEventListener('click', () => SB.viewer.openTab(state.activeTab));
  $('viewerBack').addEventListener('click', () => SB.goBack());
  $('viewerRefresh').addEventListener('click', () => refresh());
  $('viewerWhere').addEventListener('click', openPlaces);
  $('viewerEditor').addEventListener('click', openInEditor);
  $('viewerTabChanges').addEventListener('click', async () => { if (!cur) return; cur.side = 'changes'; cur.dirty = false; draw(); await loadChanges(); draw(); });
  $('viewerTabFiles').addEventListener('click', () => { if (!cur) return; cur.side = 'files'; draw(); });
  $('viewerOnly').addEventListener('change', async e => { if (!cur) return; cur.only = e.target.checked; await loadChanges(); draw(); });
  $('viewerFilter').addEventListener('input', e => { if (!cur) return; cur.filter = e.target.value; $('viewerList').replaceChildren(...treeRows()); });
  // ↑/↓ move through the list; the rows are buttons, so Enter opens one.
  $('viewerList').addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...$('viewerList').querySelectorAll('.vw-row')];
    const at = rows.indexOf(document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); }
  });

  SB.viewer = {
    ICON,
    canOpen: tab => !!tab?.cwd && !SB.remotePlace(tab.cwd) && !V.tooWide(tab.cwd, state.home),
    openTab: (tabId, opts) => (tabId ? start({ tabId }, opts) : null),
    openWorktree: (projectRoot, worktreePath, opts) => start({ projectRoot, worktreePath }, opts),
    // A file link: in the viewer when it's inside the conversation's repo, else your editor as before.
    async openLink(tabId, target, line) {
      const r = await api.viewerLocate(tabId, target).catch(() => null);
      if (r?.inside) return start({ tabId }, { file: r.rel, line: r.line || line });
      return SB.openFile(target, { line, tabId });
    },
    // The Files buttons (Task 6) and the header's live state follow the tabs.
    syncButtons() {
      const canOpen = SB.viewer.canOpen;
      $('filesBtn').hidden = SB.panes.count(state.grid) > 1 || !canOpen(state.tabs.get(state.activeTab));
      for (const b of document.querySelectorAll('.pane-head .pane-files')) {
        const pane = state.grid.flat().find(p => p.id === b.closest('.pane-head')?.dataset.pane);
        b.hidden = !canOpen(state.tabs.get(pane?.active));
      }
      if (cur && state.view === 'viewer') drawLive();
    },
    current: () => (cur ? { id: cur.id, root: cur.root, file: cur.file, side: cur.side, files: cur.files, kind: cur.kind, branch: cur.branch, gone: cur.gone, looking: cur.looking || 0 } : null),
    // All files (files-dock.js) uses the header menu's rows for its own branch row, and opens a
    // place it picked there, or a file in one: main issued the handle, or opens it again (reopen).
    placeRows,
    reopen: me => reopen(me),
    openPicked: (req, handle, place, opts = {}) => start(req, { ...opts, handle, place }),
    async openPlace(req, place, opts = {}) {
      const r = await reopen({ req, place });
      if (!r?.ok) return SB.toast(r?.error || "Couldn't open that.");
      return start(req, { ...opts, handle: r, place });
    },
  };
})();
