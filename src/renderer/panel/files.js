/* Shellby panel — files: paths that open in your editor, diffs of an edit
   Claude is asking to make (worked out from the tool call, before anything
   runs, unlike a turn's git diff in feed-changes.js), and zooming the panel. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const D = window.ShellbyDiff;

  const MAX_DIFF_ROWS = 400;

  // ------------------------------------------------------------ opening files

  SB.openFile = async (target, { line = null, reveal = false, tabId = state.activeTab } = {}) => {
    const r = await api.openFile(tabId, target, { line: line || undefined, reveal });
    if (!r?.ok) SB.toast(r?.error || "Couldn't open that.");
  };

  // A path relative to the conversation's folder when it's inside it, else ~-shortened.
  SB.relPath = (file, cwd) => {
    const f = String(file || '');
    const base = String(cwd || '').replace(/[\\/]+$/, '');
    if (base && f.toLowerCase().startsWith(base.toLowerCase()) && /[\\/]/.test(f[base.length] || '')) return f.slice(base.length + 1);
    return SB.tildify(f);
  };

  SB.fileLink = (file, { line = null, text = null, cls = '' } = {}) => h('a', {
    class: `file-link${cls ? ` ${cls}` : ''}`, href: '#', dataset: { path: file, line: line || '' },
    title: `Open ${file}${line ? ` at line ${line}` : ''} · Ctrl+click opens your editor · Shift+click shows it in its folder`,
  }, text ?? SB.basename(file));

  // One listener for every link, wherever it is: inside a tool row's <summary>
  // preventDefault also stops the row from opening.
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a.file-link');
    if (!a) return;
    e.preventDefault();
    const feed = a.closest('.feed');
    const tabId = feed?.dataset.tab || state.activeTab;
    const line = Number(a.dataset.line) || null;
    // Ctrl: your editor, as a click used to be. Shift: its folder. A popped-out window has only its
    // chat, and a link outside a conversation (Workflows' runs, say) has no folder to show it in.
    if (e.ctrlKey || e.shiftKey || SB.solo || !SB.viewer || !feed) return SB.openFile(a.dataset.path, { line, reveal: e.shiftKey, tabId });
    SB.viewer.openLink(tabId, a.dataset.path, line);
  });

  // `src/main/x.js:42` in a reply becomes a link. Only things that are plainly
  // paths: a folder separator, or an extension code uses. config.get stays text.
  const EXTS = new Set(('js mjs cjs jsx ts tsx json md mdx css scss less html htm vue svelte py rb go rs java kt kts swift c h cc cpp hpp cs fs ' +
    'php sh bash zsh ps1 psm1 bat cmd yml yaml toml ini cfg conf env xml svg txt csv tsv sql lock gradle tf lua dart ex exs erl zig ' +
    'r jl scala clj png jpg jpeg gif webp ico pdf ipynb dockerfile gitignore').split(' '));
  const PATHISH = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.([A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?::\d+)?)?$/;

  SB.linkifyPaths = el => {
    for (const code of el.querySelectorAll('code')) {
      if (code.closest('pre, a')) continue;
      const t = code.textContent.trim();
      const m = t.match(PATHISH);
      if (!m || (!/[\\/]/.test(t) && !EXTS.has(m[1].toLowerCase()))) continue;
      const a = SB.fileLink(t, { line: m[2] ? Number(m[2]) : null, text: '' });
      code.replaceWith(a);
      a.append(code);
    }
    // And in plain prose, outside backticks, but only when it can't be anything
    // else: a folder in it and an extension code uses (`see src/main/x.js:42`).
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement.closest('pre, code, a, button') || !/[\\/]/.test(n.nodeValue) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const parts = [];
      let last = 0;
      for (const m of text.matchAll(PROSE_PATH)) {
        const t = m[2].replace(/[.,;:)]+$/, '');
        const pm = t.match(PATHISH);
        if (!pm || !/[\\/]/.test(t) || !EXTS.has(pm[1].toLowerCase())) continue;
        const at = m.index + m[1].length;
        parts.push(text.slice(last, at), SB.fileLink(t, { line: pm[2] ? Number(pm[2]) : null, text: t }));
        last = at + t.length;
      }
      if (!parts.length) continue;
      node.replaceWith(...parts, text.slice(last));
    }
    return el;
  };
  // A path-shaped word in prose: what's before it (start or a space or bracket), then the word.
  const PROSE_PATH = /(^|[\s(["'])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])?[\w@.+-]+(?:[\\/][\w@.+-]+)+(?::\d+(?::\d+)?)?)/g;

  // ------------------------------------------------------------ an edit's diff

  SB.diffStats = edits => {
    const { added, removed } = D.stats(edits);
    return h('span', { class: 'dstat', 'aria-label': `${added} lines added, ${removed} removed` },
      added ? h('b', { class: 'add', text: `+${added}` }) : null,
      removed ? h('b', { class: 'del', text: `−${removed}` }) : null);
  };

  // Red and green rows. Numbers only when we know where the edit sits (`line`);
  // colours when the file's name says what language it's in (code.js).
  SB.diffView = (edits, { line = null, file = null } = {}) => {
    const box = h('div', { class: `ediff${line ? '' : ' no-nums'}`, role: 'group', 'aria-label': 'Changes' });
    let shown = 0;
    let left = 0;
    edits.forEach((e, i) => {
      const rows = D.rows(e, { line: i === 0 ? line : null });
      const paint = file ? SB.diffPainter?.(file) : null; // each edit is its own run of the file
      if (i && shown < MAX_DIFF_ROWS) box.append(h('div', { class: 'er fold', text: '⋯' }));
      for (const r of rows) {
        if (shown >= MAX_DIFF_ROWS) { left++; continue; }
        shown++;
        if (r.t === '…') { box.append(h('div', { class: 'er fold', text: `⋯ ${r.n} unchanged line${r.n === 1 ? '' : 's'}` })); continue; }
        box.append(h('div', { class: `er ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx'}` },
          h('span', { class: 'en', 'aria-hidden': 'true', text: r.a ?? '' }),
          h('span', { class: 'en', 'aria-hidden': 'true', text: r.b ?? '' }),
          h('span', { class: 'eg', text: r.t === ' ' ? ' ' : r.t === '-' ? '−' : '+' }),
          paint && r.s ? SB.paintTokens(h('span', { class: 'et' }), paint(r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx', r.s)) : h('span', { class: 'et', text: r.s || ' ' })));
      }
    });
    if (left) box.append(h('div', { class: 'er fold', text: `… ${left} more line${left === 1 ? '' : 's'}` }));
    return box;
  };

  // ------------------------------------------------------------ editors

  SB.loadEditors = async () => { state.editors = await api.getEditors(); return state.editors; };

  // ------------------------------------------------------------ zoom

  SB.zoom = async step => {
    const z = await api.zoom(step);
    SB.toast(`Zoom ${Math.round(z * 100)}%${z === 1 ? '' : ' · Ctrl+0 resets'}`, { ms: 1400 });
  };
  let wheelAt = 0;
  window.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (performance.now() - wheelAt < 180) return;
    wheelAt = performance.now();
    SB.zoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
})();
