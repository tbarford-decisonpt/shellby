/* Shellby panel — Toolbox > Mods: Claude Code plugins whose hooks are code, which
   run inside every Claude Code conversation (main's mods.js and mods-service.js).
   Each one can be checked (what it hooks and what it can reach, in words), turned
   on or off, tested, opened in VS Code and removed; New mod starts a conversation
   that builds one. Turning one on and running its tests ask in Shellby's own
   confirm window: the panel only names the mod. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;   // as mods.js NEW_NAME_RE
  const MAX_IDEA = 2000;
  const NEW_FOR_MS = 3 * 24 * 3600 * 1000;

  // The last check and test run of each, for the files as they were then (stamp):
  // once the mod changes, what they said no longer holds, so it isn't shown.
  const reports = new Map(); // id -> { stamp, report } | { stamp, error }
  const tests = new Map();   // id -> { stamp, result }
  const fresh = (map, m) => { const got = map.get(m.id); return got && got.stamp === m.stamp ? got : null; };
  const busy = new Map();    // id -> what it's doing ('check', 'switch', 'test', 'remove')
  const openRows = new Set();
  let form = null;           // { name, idea, error, sending } while New mod is open

  const mods = () => state.toolbox?.mods || [];
  const find = id => mods().find(m => m.id === id) || null;
  const rerender = () => { if (state.view === 'toolbox') SB.views.toolbox.render(); };
  const isNew = m => (state.learned || []).some(l => l.kind === 'mod' && l.id === m.id && Date.now() - l.at < NEW_FOR_MS);
  const SOURCE = { user: 'yours', plugin: 'marketplace', session: 'this conversation' };
  const WHERE = {
    user: 'Yours: a folder in ~/.claude/skills, so Claude Code loads it everywhere, the terminal and your editor too.',
    session: 'A conversation loaded it with --plugin-dir, just for itself.',
  };

  // sel: the button to put the keyboard back on once the row is drawn again.
  async function act(id, what, fn, sel = null) {
    if (busy.has(id)) return null;
    busy.set(id, what);
    rerender();
    let r;
    try { r = await fn(); } catch { r = { ok: false, error: "Shellby couldn't do that." }; }
    busy.delete(id);
    if (r?.toolbox) state.toolbox = r.toolbox;
    if (r?.cancelled && r.busy) SB.toast('Finish the open Shellby dialog first.');
    else if (r && !r.ok && !r.cancelled) {
      if (r.needsTerminal && r.command) SB.toast(r.error, { ms: 9000, action: 'Copy command', onAction: () => { api.copyText(r.command); SB.toast('Copied'); } });
      else SB.toast(r.error || "Couldn't do that.", { ms: 8000 });
    }
    rerender();
    if (sel) focusRow(id, sel);
    return r;
  }

  // A failed check is said in the row, so it doesn't toast as well.
  const check = (m, sel = null) => act(m.id, 'check', async () => {
    const r = await api.checkMod(m.id);
    reports.set(m.id, r?.ok ? { stamp: r.stamp, report: r.report } : { stamp: m.stamp, error: r?.error || "Couldn't check it." });
    return r?.cancelled ? r : { ...r, ok: true };
  }, sel);

  const toggle = m => act(m.id, 'switch', async () => {
    const r = await api.setModEnabled(m.id, !m.enabled);
    if (r?.report) reports.set(m.id, { stamp: m.stamp, report: r.report });
    if (r?.ok && !r.already) SB.toast(m.enabled ? `Turned ${m.name} off. New conversations won't load it.` : `Turned ${m.name} on. New conversations load it.`, { ms: 6000 });
    return r;
  }, '.mod-switch');

  const runTests = m => act(m.id, 'test', async () => {
    const r = await api.testMod(m.id);
    if (r?.ok) tests.set(m.id, { stamp: m.stamp, result: r.result });
    return r;
  }, '.mod-test');

  const remove = m => act(m.id, 'remove', async () => {
    const r = await api.removeMod(m.id);
    if (r?.ok) {
      openRows.delete(m.id);
      SB.toast(m.source === 'user' ? `Moved ${m.name} to the Recycle Bin. Restore it from there if you change your mind.` : `Removed ${m.name}`, { ms: 8000 });
    }
    return r;
  });

  async function openInEditor(m) {
    const r = await api.openMod(m.id);
    if (!r?.ok) SB.toast(r?.error || "Couldn't open it.", { ms: 8000 });
  }

  // ------------------------------------------------------------ New mod

  async function startBuilding() {
    if (!form || form.sending) return;
    const name = (form.name || '').trim();
    const idea = (form.idea || '').trim();
    form.error = !NAME.test(name) ? 'Use lowercase letters, digits and dashes, like tidy-commits.'
      : mods().some(m => m.name === name) ? `There's already a mod called ${name}.`
        : !idea ? 'Say what it should do, in a sentence.' : '';
    if (form.error) { remount(); return; }
    form.sending = true;
    remount();
    let r;
    try { r = await api.draftMod(name, idea); } catch { r = { ok: false, error: "Shellby couldn't do that." }; }
    if (!form) return;
    form.sending = false;
    if (!r?.ok) { form.error = r?.error || "Couldn't start that."; remount(); return; }
    form = null;
    remount();
    SB.setView('chat');
    SB.newTabIn({ cwd: r.cwd, draft: r.prompt });
    SB.toast('Read it over, then send it. Shellby tells you when the mod shows up.', { ms: 7000 });
  }

  function newModForm(f) {
    const nameIn = h('input', { class: 'field slim mono', type: 'text', id: 'modName', spellcheck: 'false', maxlength: '64', placeholder: 'tidy-commits', 'aria-label': 'Name' });
    nameIn.value = f.name || '';
    nameIn.addEventListener('input', () => { f.name = nameIn.value; });
    const ideaIn = h('textarea', { class: 'field', id: 'modIdea', rows: '3', maxlength: String(MAX_IDEA), placeholder: 'shows a toast with how long each turn took, and stops Claude from running rm -rf', 'aria-label': 'What it should do' });
    ideaIn.value = f.idea || '';
    ideaIn.addEventListener('input', () => { f.idea = ideaIn.value; });
    const el = h('form', {
      class: 'mcp-form mod-form', 'aria-label': 'New mod',
      onsubmit: e => { e.preventDefault(); startBuilding(); },
      onkeydown: e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startBuilding(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); form = null; remount(); }
      },
    },
      h('label', { class: 'field-label', for: 'modName' }, 'Name', nameIn),
      h('label', { class: 'field-label', for: 'modIdea' }, 'What should it do?', ideaIn),
      h('p', { class: `setup-status${f.error ? ' err' : ''}`, role: 'status',
        text: f.error || 'Claude builds it in ~/.claude/skills, with a test, in a new conversation. You read the request before it goes.' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary slim-btn', type: 'submit', disabled: !!f.sending }, f.sending ? '…' : 'Start building'),
        h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { form = null; remount(); } }, 'Cancel')));
    queueMicrotask(() => (f.error ? (NAME.test((f.name || '').trim()) ? ideaIn : nameIn) : nameIn).focus());
    return el;
  }

  function paneBar() {
    return h('div', { class: 'mcp-bar' },
      h('span', { class: 'muted small', text: "Code that runs inside every Claude Code conversation: Shellby's, your terminal's and your editor's. Shellby asks before one is turned on." }),
      h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => { form = form ? null : { name: '', idea: '' }; remount(); } }, form ? 'Close' : 'New mod'));
  }

  function remount() {
    $('setupPane').dataset.mounted = '';
    rerender();
  }

  // ------------------------------------------------------------ a row

  const RISK_MARK = { high: '⚠', medium: '•', low: '•' };

  function reportBlock(m) {
    const got = fresh(reports, m);
    if (!got) return null;
    if (got.error) return h('p', { class: 'setup-status err', text: got.error });
    const r = got.report;
    return h('div', { class: 'mod-report' },
      r.errors.length ? h('div', { class: 'mod-problems err' },
        h('b', { text: "Claude Code won't load it:" }),
        h('ul', {}, r.errors.slice(0, 8).map(e => h('li', { text: e })))) : null,
      h('b', { text: 'What it can do' }),
      h('ul', { class: 'mod-powers' },
        (r.powers.length ? r.powers : [{ text: 'Nothing beyond reacting inside Claude Code', risk: 'low' }])
          .map(p => h('li', { class: `risk-${p.risk}` }, h('span', { 'aria-hidden': 'true', text: `${RISK_MARK[p.risk]} ` }), p.text)),
        r.other.length ? h('li', { class: 'muted', text: `Also uses ${r.other.join(', ')}` }) : null,
        r.callsKnown ? null : h('li', { class: 'muted', text: "Claude Code couldn't say what it reaches for." })),
      h('p', { class: 'muted small', text: "Read from its code, which can't show everything code can do." }),
      r.hooks.length ? h('p', { class: 'muted small' }, 'Hooks: ', h('code', { text: r.hooks.join(', ') })) : null,
      r.warnings.length ? h('details', { class: 'mod-warnings' },
        h('summary', { text: `${r.warnings.length} note${r.warnings.length === 1 ? '' : 's'} from Claude Code` }),
        h('ul', {}, r.warnings.slice(0, 12).map(w => h('li', { text: w })))) : null);
  }

  function testBlock(m) {
    const got = fresh(tests, m);
    if (!got?.result) return null;
    const t = got.result;
    const verdict = t.noTests ? 'Claude Code found no tests to run.'
      : t.ok ? `✅ Tests passed${t.passed != null ? ` (${t.passed})` : ''}`
        : `❌ Tests failed${t.failed != null ? ` (${t.failed} failing)` : ''}`;
    return h('details', { class: 'mod-tests', open: !t.ok },
      h('summary', { class: t.ok ? '' : 'err', text: verdict }),
      t.tail.length ? h('pre', { class: 'mono small', text: t.tail.join('\n') }) : null);
  }

  const actBtn = (icon, label, attrs) => h('button', { class: 'btn ghost slim-btn tool-act', type: 'button', ...attrs },
    icon ? SB.icon(icon, { width: 1.4 }) : null, label);

  function detail(m, id) {
    const doing = busy.get(m.id);
    const meta = [m.version && `v${m.version}`, m.author && `by ${m.author}`, `${m.modules.length} module${m.modules.length === 1 ? '' : 's'}`,
      m.tests ? `${m.tests} test file${m.tests === 1 ? '' : 's'}` : 'no tests'].filter(Boolean).join(' · ');
    const where = m.source === 'plugin' ? `From the ${m.marketplace} marketplace. Remove it here, or in Get more.` : WHERE[m.source];
    return h('div', { class: 'tool-detail', id },
      m.problem ? h('p', { class: 'setup-status err', text: `${m.problem} Until then Shellby won't switch it.` }) : null,
      m.setBy && m.setBy !== 'user' ? h('p', { class: 'setup-status', text: `This project's settings turn it ${m.enabled ? 'on' : 'off'} here, which wins over your own switch.` }) : null,
      h('p', { class: 'tool-where', text: where }),
      h('p', { class: 'muted small', text: meta }),
      reportBlock(m),
      testBlock(m),
      h('p', { class: 'muted small', text: "In Shellby its log lines, toasts, status lines and slash commands show up. Panes and bands above the prompt only draw in a terminal." }),
      h('code', { class: 'tool-path', text: SB.shortPath(m.path, 64), title: m.path }),
      h('div', { class: 'tool-detail-actions' },
        actBtn(null, doing === 'check' ? 'Checking…' : fresh(reports, m) ? 'Check again' : 'What can it do?', { class: 'btn ghost slim-btn tool-act mod-check', disabled: !!doing, onclick: () => check(m, '.mod-check') }),
        m.tests ? actBtn(null, doing === 'test' ? 'Testing…' : 'Run its tests', { class: 'btn ghost slim-btn tool-act mod-test', disabled: !!doing, onclick: () => runTests(m) }) : null,
        actBtn(SB.ICONS.edit, 'Open in VS Code', { 'aria-label': `Open ${m.name} in VS Code`, onclick: () => openInEditor(m) }),
        actBtn(SB.ICONS.folder, 'Show folder', { onclick: () => api.revealMod(m.id) }),
        m.source !== 'session' ? actBtn(SB.ICONS.trash, doing === 'remove' ? 'Removing…' : 'Remove', {
          class: 'btn ghost slim-btn tool-act danger-hover', 'aria-label': `Remove ${m.name}`, disabled: !!doing,
          title: m.source === 'user' ? 'Shellby asks first, and it goes to the Recycle Bin' : 'Shellby asks first',
          onclick: () => remove(m),
        }) : null));
  }

  function row(m) {
    const open = openRows.has(m.id);
    const id = `mod-detail-${m.id.replace(/[^\w-]/g, '_')}`;
    const doing = busy.get(m.id);
    const li = h('li', { class: `tool-row tool-item${isNew(m) ? ' is-new' : ''}${m.enabled ? '' : ' is-off'}${open ? ' is-open' : ''}`, dataset: { key: `mod:${m.id}` } });
    const toggleRow = h('button', {
      class: 'tool-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': open ? id : null,
      onclick: () => {
        if (!openRows.delete(m.id)) openRows.add(m.id);
        // A first look at it: say what it can do without another click.
        if (openRows.has(m.id) && !fresh(reports, m)) check(m, '.tool-toggle'); else rerender();
        focusRow(m.id, '.tool-toggle');
      },
    },
    h('span', { class: 'tool-name' },
      h('span', { class: `mod-dot${m.enabled ? ' on' : ''}`, role: 'img', 'aria-label': m.enabled ? 'on' : 'off', title: m.enabled ? 'On' : 'Off' }),
      h('code', { text: m.name }),
      isNew(m) ? h('span', { class: 'new-pill', text: 'new' }) : null,
      h('span', { class: 'src-pill', text: m.source === 'plugin' ? m.marketplace : SOURCE[m.source] || '' })),
    m.description ? h('span', { class: 'tool-desc', text: m.description }) : null,
    m.problem ? h('span', { class: 'tool-stats unused', text: "Needs a look: Shellby won't switch it" }) : null);
    const sw = m.source === 'session' ? null : h('button', {
      class: `btn slim-btn mod-switch${m.enabled ? ' ghost' : ''}`, type: 'button', disabled: doing === 'switch',
      'aria-label': `${m.enabled ? 'Turn off' : 'Turn on'} ${m.name}`,
      title: m.enabled ? 'New conversations stop loading it' : 'Shellby shows you what it can do and asks first',
      onclick: () => toggle(m),
    }, doing === 'switch' ? '…' : m.enabled ? 'Turn off' : 'Turn on');
    li.append(h('div', { class: 'tool-head' }, toggleRow, h('div', { class: 'tool-actions' }, sw)));
    if (open) li.append(detail(m, id));
    return li;
  }

  function focusRow(id, sel) {
    requestAnimationFrame(() => {
      const li = [...$('toolList').querySelectorAll('.tool-item')].find(r => r.dataset.key === `mod:${id}`);
      li?.querySelector(sel)?.focus({ preventScroll: true });
    });
  }

  // ------------------------------------------------------------ the tab

  function emptyState(q) {
    if (q) return h('li', { class: 'history-empty', text: 'No matches.' });
    return h('li', { class: 'history-empty' },
      h('p', { text: 'No mods yet. A mod is a little program inside Claude Code: it can react to what Claude does, block a risky command, add a slash command or a tool. Press New mod and say what you want.' }));
  }

  function render(q) {
    const pane = $('setupPane');
    const key = `mod:${form ? `open:${form.sending ? 'sending' : ''}:${form.error || ''}` : 'closed'}`;
    pane.hidden = false;
    if (pane.dataset.mounted !== key) {
      pane.replaceChildren(paneBar(), ...(form ? [newModForm(form)] : []));
      pane.dataset.mounted = key;
    }
    const items = mods().filter(m => !q || m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
      .sort((a, b) => (isNew(b) - isNew(a)) || (b.enabled - a.enabled) || a.name.localeCompare(b.name));
    const refocus = keepFocus($('toolList'));
    $('toolList').replaceChildren(...(items.length ? items.map(row) : [emptyState(q)]));
    refocus();
  }

  // A redraw (a rescan landing after a switch) replaces every row: put the
  // keyboard back on the same button of the same row.
  function keepFocus(list) {
    const a = document.activeElement;
    const li = a && list.contains(a) ? a.closest('.tool-item[data-key]') : null;
    if (!li) return () => {};
    const nth = [...li.querySelectorAll('button')].indexOf(a);
    return () => {
      const again = [...list.querySelectorAll('.tool-item[data-key]')].find(r => r.dataset.key === li.dataset.key);
      again?.querySelectorAll('button')[nth]?.focus({ preventScroll: true });
    };
  }

  /** Straight to one mod, open (a "new mod" toast's action). */
  function show(id) {
    if (find(id)) openRows.add(id);
    SB.showToolbox('mod');
    const m = find(id);
    if (m && !fresh(reports, m)) check(m, '.tool-toggle');
    focusRow(id, '.tool-toggle');
  }

  // ------------------------------------------------------------ the status lines under the box

  SB.renderModStatus = (tab) => {
    const el = $('modStatus');
    const lines = tab ? [...tab.modStatus] : [];
    el.hidden = !lines.length;
    el.replaceChildren(...lines.map(([plugin, text]) => h('span', { class: 'mod-status-line' },
      h('span', { 'aria-hidden': 'true', text: '🧩 ' }), h('b', { text: plugin }), h('span', { class: 'mod-tag', text: 'mod' }), text)));
  };

  SB.toolboxMods = { render, show, count: () => mods().length };
})();
