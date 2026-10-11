/* Shellby panel — the file viewer: a conversation's folder (or a project's
   worktree) as a tree and a list of what changed since its branch began, any
   file in colour, and each change as a diff with both sides' line numbers.
   Read-only: main hands over a handle and keeps every read inside it (main's
   viewer.js). Opened from a pane's Files button, file links, the branch chip
   and the Project page. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const V = window.ShellbyViewer;
  const S = window.ShellbySyntax;
  const MAX_COLOUR_LINES = 4000;   // past this, plain text
  const REFRESH_MS = 2000;         // at most one look again in this long
  const ICON = 'M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z';
  const lastFile = new Map(); // root -> the file last open there, while Shellby runs
  let cur = null;             // what's open: the handle, the lists and the file on screen
  let shownAt = 0, timer = null;

  // A call on the handle. One dropped (eight others opened since, a closed tab, a reload) is opened
  // again, once, with its changes list rebuilt, since main serves diffs only for files on that list.
  async function call(fn) {
    const me = cur;
    let r = await fn(me.id).catch(() => null);
    if (r?.expired) {
      const again = await api.viewerOpen(me.req).catch(() => null);
      if (!again?.ok) {
        if (again?.gone) me.gone = true;
        return { ok: false, gone: !!again?.gone, error: again?.error || "Couldn't open that folder." };
      }
      me.id = again.id;
      if (me.git) await api.viewerChanges(me.id, { uncommittedOnly: me.only }).catch(() => null);
      r = await fn(me.id).catch(() => null);
    }
    if (r?.gone) me.gone = true; // the folder was deleted while open: draw() says so
    return r || { ok: false, error: "Couldn't read that." };
  }

  const ancestors = rel => rel.split('/').slice(0, -1).map((_s, i, parts) => parts.slice(0, i + 1).join('/'));

  async function start(req, { file = null, line = null, side = null } = {}) {
    const r = await api.viewerOpen(req).catch(() => null);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't open that folder.");
    if (cur && cur.id !== r.id) api.viewerClose(cur.id);
    const me = cur = {
      ...r, req, tabId: req.tabId || null, side, only: false, files: [], more: 0, against: null, note: null, gone: false, dirty: false,
      entries: [], open: new Set(), filter: '', file: file || lastFile.get(r.root) || null, line, whole: !!line,
    };
    $('viewerFilter').value = '';
    $('viewerMain').replaceChildren();
    SB.setView('viewer');
    draw();
    await Promise.all([loadChanges(), loadTree()]);
    if (cur !== me) return;
    if (me.gone) return draw();
    if (!me.side) me.side = me.files.length || me.note ? 'changes' : 'files'; // a failed look says so, on Changes
    if (me.file) for (const a of ancestors(me.file)) me.open.add(a);
    draw();
    if (me.file) showFile(me.file, { line });
    else $('viewerMain').replaceChildren(h('p', { class: 'muted vw-empty', text: me.files.length ? 'Pick a file to see what changed.' : 'Pick a file to read it.' }));
  }

  async function loadChanges() {
    const me = cur;
    const r = await call(id => api.viewerChanges(id, { uncommittedOnly: me.only }));
    if (cur !== me) return;
    shownAt = Date.now();
    me.note = null;
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

  function drawLive() {
    const live = cur?.tabId ? V.liveState(state.tabs.get(cur.tabId)) : null;
    $('viewerLive').hidden = !live;
    if (live) { $('viewerLive').textContent = live.word; $('viewerLive').className = `vw-live ${live.cls}`; }
  }

  function draw() {
    if (!cur) return;
    $('viewerWhere').textContent = [cur.name, cur.branch && (cur.base ? `${cur.branch} (from ${cur.base})` : cur.branch)].filter(Boolean).join(' · ');
    $('viewerWhere').title = cur.root;
    drawLive();
    if (cur.gone) {
      $('viewerSide').hidden = true;
      $('viewerEditor').hidden = true;
      $('viewerMain').replaceChildren(h('div', { class: 'vw-gone' },
        h('p', { text: 'This folder is gone.' }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Back', onclick: () => SB.goBack() })));
      return;
    }
    $('viewerSide').hidden = false;
    if (!cur.git) cur.side = 'files';
    $('viewerTabChanges').hidden = !cur.git;
    $('viewerTabChanges').setAttribute('aria-selected', String(cur.side === 'changes'));
    $('viewerTabFiles').setAttribute('aria-selected', String(cur.side === 'files'));
    $('viewerCount').textContent = cur.files.length ? String(cur.files.length + cur.more) : '';
    $('viewerOnlyRow').hidden = cur.side !== 'changes' || !cur.base;
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
    editor ? h('button', { type: 'button', class: 'btn slim-btn', text: 'Open in editor', onclick: openInEditor }) : null);

  function openInEditor() {
    if (!cur?.file) return;
    SB.openFile(`${cur.root}\\${cur.file.replace(/\//g, '\\')}`, { line: cur.line, tabId: cur.tabId || state.activeTab });
  }

  // A line to go to (a link's :42) opens the whole file there, changed or not; Diff is a click away.
  async function showFile(rel, { line = null, keep = false } = {}) {
    const me = cur;
    if (me.file !== rel || line) me.whole = !!line;
    me.file = rel; me.line = line;
    lastFile.set(me.root, rel);
    for (const b of document.querySelectorAll('#viewerList .vw-row')) b.classList.toggle('on', b.dataset.path === rel);
    const f = me.files.find(x => x.path === rel) || null;
    const main = $('viewerMain');
    const top = main.scrollTop;
    const body = !f || me.whole ? await wholeFile(rel, line) : await diffOf(f);
    if (cur !== me || me.file !== rel) return;
    if (me.gone) return draw(); // the read found the folder gone: that screen stays
    main.replaceChildren(fileHead(rel, f), body);
    $('viewerEditor').hidden = false;
    if (keep) main.scrollTop = top;
    else main.querySelector('.hit')?.scrollIntoView({ block: 'center' });
  }

  function fileHead(rel, f) {
    return h('div', { class: 'vw-file-head' },
      h('code', { class: 'vw-file', text: rel, title: rel }),
      f ? h('span', { class: `vw-st st-${V.statusClass(f.status)}`, text: f.status, title: V.statusWord(f.status) }) : null,
      f ? counts(f) : null,
      f ? h('button', {
        type: 'button', class: 'btn ghost slim-btn', text: cur.whole ? 'Diff' : 'Whole file',
        disabled: f.status === 'D' && !cur.whole, onclick: () => { cur.whole = !cur.whole; cur.line = null; showFile(rel); },
      }) : null);
  }

  async function diffOf(f) {
    if (f.binary) return note('A binary file: nothing to show line by line.', true);
    const r = await call(id => api.viewerDiff(id, f.path));
    if (!r.ok) return note(r.error || "Couldn't read the diff.", true);
    const rows = V.numberDiff(r.patch);
    if (!rows.length) return note('No line changes (a mode or line-ending change).');
    const paint = SB.diffPainter?.(f.path);
    const pre = h('pre', { class: 'vw-code diff' }, rows.map(row => {
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
      if (line) requestAnimationFrame(() => { const lh = parseFloat(getComputedStyle(text).lineHeight) || 18; $('viewerMain').scrollTop = Math.max(0, (line - 5) * lh); });
      return h('div', { class: 'vw-code vw-big' }, h('pre', { class: 'vw-gutter', text: lines.map((_l, i) => i + 1).join('\n') }), text);
    }
    const tk = S.lineTokenizer(S.langFromPath(rel));
    return h('pre', { class: 'vw-code diff' }, lines.map((l, i) => h('span', { class: `dl ctx${line === i + 1 ? ' hit' : ''}` },
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
    render() {
      if (!cur?.dirty) return;
      cur.dirty = false;
      refresh({ tree: false });
    },
  };

  $('viewerBack').addEventListener('click', () => SB.goBack());
  $('viewerRefresh').addEventListener('click', () => refresh());
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
    canOpen: tab => !!tab?.cwd && !SB.remotePlace(tab.cwd),
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
      if (cur && state.view === 'viewer') drawLive();
    },
    current: () => (cur ? { id: cur.id, root: cur.root, file: cur.file, side: cur.side, files: cur.files } : null),
  };
})();
