/* Shellby panel — files: links that open in your editor, diffs of Claude's
   edits, the branch chip under the tab strip, and zooming the panel. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
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
    title: `Open ${file}${line ? ` at line ${line}` : ''} · Shift+click shows it in its folder`,
  }, text ?? SB.basename(file));

  // One listener for every link, wherever it is: inside a tool row's <summary>
  // preventDefault also stops the row from opening.
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a.file-link');
    if (!a) return;
    e.preventDefault();
    const tab = a.closest('.feed')?.dataset.tab;
    SB.openFile(a.dataset.path, { line: Number(a.dataset.line) || null, reveal: e.shiftKey, tabId: tab || state.activeTab });
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
    return el;
  };

  // ------------------------------------------------------------ diffs

  SB.diffStats = edits => {
    const { added, removed } = D.stats(edits);
    return h('span', { class: 'dstat', 'aria-label': `${added} lines added, ${removed} removed` },
      added ? h('b', { class: 'add', text: `+${added}` }) : null,
      removed ? h('b', { class: 'del', text: `−${removed}` }) : null);
  };

  // Red and green rows. Numbers only when we know where the edit sits (`line`).
  SB.diffView = (edits, { line = null } = {}) => {
    const box = h('div', { class: `diff${line ? '' : ' no-nums'}`, role: 'group', 'aria-label': 'Changes' });
    let shown = 0;
    let left = 0;
    edits.forEach((e, i) => {
      const rows = D.rows(e, { line: i === 0 ? line : null });
      if (i && shown < MAX_DIFF_ROWS) box.append(h('div', { class: 'dl fold', text: '⋯' }));
      for (const r of rows) {
        if (shown >= MAX_DIFF_ROWS) { left++; continue; }
        shown++;
        if (r.t === '…') { box.append(h('div', { class: 'dl fold', text: `⋯ ${r.n} unchanged line${r.n === 1 ? '' : 's'}` })); continue; }
        box.append(h('div', { class: `dl ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx'}` },
          h('span', { class: 'dn', 'aria-hidden': 'true', text: r.a ?? '' }),
          h('span', { class: 'dn', 'aria-hidden': 'true', text: r.b ?? '' }),
          h('span', { class: 'dg', text: r.t === ' ' ? ' ' : r.t === '-' ? '−' : '+' }),
          h('span', { class: 'dt', text: r.s || ' ' })));
      }
    });
    if (left) box.append(h('div', { class: 'dl fold', text: `… ${left} more line${left === 1 ? '' : 's'}` }));
    return box;
  };

  // ------------------------------------------------------------ branch chip

  const chip = $('gitChip');
  let gitSeq = 0;
  let gitTimer = null;

  const absIn = (root, rel) => `${root}\\${rel.replace(/\//g, '\\')}`;

  SB.refreshGit = async () => {
    const seq = ++gitSeq;
    const g = await api.gitStatus(state.activeTab);
    if (seq !== gitSeq) return;
    state.git = g;
    chip.hidden = !g;
    if (!g) return;
    const n = g.files.length + g.more;
    $('gitBranch').textContent = g.detached ? 'detached' : g.branch || '?';
    $('gitChanges').textContent = n ? `${n} changed` : '';
    $('gitChanges').hidden = !n;
    const sync = [g.ahead && `${g.ahead} ahead`, g.behind && `${g.behind} behind`].filter(Boolean).join(', ');
    chip.title = `${g.name} on ${g.detached ? 'a detached HEAD' : g.branch}${sync ? ` · ${sync} of ${g.upstream}` : ''} · ${n ? `${n} changed file${n === 1 ? '' : 's'}` : 'nothing changed'}`;
  };
  // Bursts of edits refresh once, a moment after the last.
  SB.refreshGitSoon = () => { clearTimeout(gitTimer); gitTimer = setTimeout(SB.refreshGit, 700); };
  window.addEventListener('focus', SB.refreshGitSoon);

  const CODE_WORDS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted', '?': 'new' };
  const codeOf = c => (c === '??' ? '?' : (c[1] !== ' ' ? c[1] : c[0]));

  SB.openGitMenu = () => SB.openMenu($('gitMenu'), chip, () => {
    const g = state.git;
    if (!g) return [];
    const sync = [g.ahead && `↑${g.ahead}`, g.behind && `↓${g.behind}`].filter(Boolean).join(' ');
    return [
      h('div', { class: 'menu-label', text: `${g.name} · ${g.detached ? 'detached HEAD' : g.branch}${sync ? ` · ${sync}` : ''}` }),
      g.files.length ? null : h('div', { class: 'menu-item muted', text: 'No changes. Everything is committed.' }),
      ...g.files.slice(0, 40).map(f => {
        const c = codeOf(f.code);
        return h('button', { class: 'menu-item git-file', title: `${CODE_WORDS[c] || f.code.trim()}: ${f.path}`, onclick: () => { SB.closeMenus(); SB.openFile(absIn(g.root, f.path)); } },
          h('span', { class: `git-code c-${c === '?' ? 'new' : c}`, text: c === '?' ? 'U' : c }),
          h('span', { class: 'git-path', text: f.path }));
      }),
      g.files.length + g.more > 40 ? h('div', { class: 'menu-label', text: `…and ${g.files.length + g.more - 40} more` }) : null,
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); SB.openFile(g.root); } },
        h('span', { class: 'mi-check', text: '↗' }), h('span', { class: 'mi-title', text: `Open ${g.name} in ${state.editors?.using || 'its folder'}` })),
    ];
  });
  chip.addEventListener('click', SB.openGitMenu);

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
