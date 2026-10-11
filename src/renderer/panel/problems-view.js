/* Shellby panel — Problems (Ctrl+Shift+M), as an editor's Problems list: the
   errors and warnings this conversation's last checks printed, file by file.
   A row opens the file at that line in your editor; Fix it (or Fix all) asks
   Claude, in this conversation, with a message main writes from what it
   noted (src/main/problems.js), the tools' words fenced off as output. Look
   for problems runs the project's lint and typecheck (else its tests) through
   the same runner as Run checks, which asks once per project first. */
'use strict';
(function () {
  const { h, api, $, plural } = SB;
  const sheet = $('problemsSheet');
  const list = $('problemsList');
  const sub = $('problemsSub');
  const runBtn = $('problemsRun');
  const fixAllBtn = $('problemsFixAll');

  let tab = null;
  let data = null;  // problems:get's answer
  let back = null;

  SB.openProblems = async (t = SB.activeTab()) => {
    if (!t) return;
    tab = t;
    back = document.activeElement;
    SB.closeMenus?.();
    sheet.hidden = false;
    await load();
    (list.querySelector('.pb-row') || runBtn).focus();
  };

  function close() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    if (back?.isConnected) back.focus({ preventScroll: true });
    back = null;
  }

  async function load() {
    data = await api.problems(tab.id);
    render();
  }

  const byFile = (problems) => {
    const groups = new Map();
    problems.forEach((p, i) => {
      if (!groups.has(p.file)) groups.set(p.file, []);
      groups.get(p.file).push({ ...p, i });
    });
    return [...groups];
  };

  function render() {
    const problems = data?.problems || [];
    const errors = problems.filter(p => p.severity === 'error').length;
    const warnings = problems.length - errors;
    fixAllBtn.hidden = !problems.length;
    fixAllBtn.textContent = problems.length === 1 ? 'Fix it' : `Fix all ${problems.length}`;
    if (data?.never) {
      sub.textContent = 'No checks have run in this conversation yet. Look for problems runs its lint and typecheck, or its tests.';
    } else {
      const from = (data?.commands || []).map(c => c.cmd).join(', ');
      const what = problems.length ? [errors ? plural(errors, 'error') : '', warnings ? plural(warnings, 'warning') : ''].filter(Boolean).join(', ') : 'No problems';
      sub.textContent = `${what} from ${from || 'its checks'}, ${SB.relTime(data?.at)}.`;
    }
    list.replaceChildren(...byFile(problems).map(([file, items]) => h('section', { class: 'pb-file' },
      h('h3', { class: 'pb-file-head', title: file },
        h('span', { class: 'pb-name', text: file.split('/').pop() }),
        h('span', { class: 'pb-dir', text: file.slice(0, -file.split('/').pop().length) }),
        h('span', { class: 'pb-count', text: String(items.length) })),
      h('ul', {}, ...items.map(p => row(p))))));
    if (!problems.length && data && !data.never) {
      list.append(h('p', { class: 'pb-empty small muted', text: data.status === 'pass'
        ? 'Its last checks passed.'
        : "Its last checks didn't pass, but nothing they printed names a file and line. The checks block in the conversation has what they said." }));
    }
  }

  function row(p) {
    const open = h('button', { class: 'pb-row', type: 'button', title: `Open ${p.file} at line ${p.line}` },
      h('span', { class: `pb-sev ${p.severity}`, text: p.severity === 'error' ? '✕' : '!', 'aria-label': p.severity }),
      h('span', { class: 'pb-msg', text: p.message }),
      p.code ? h('span', { class: 'pb-code', text: p.code }) : null,
      h('span', { class: 'pb-at', text: `${p.line}:${p.col}` }));
    open.addEventListener('click', () => SB.openFile(p.file, { line: p.line, tabId: tab.id }));
    const fix = h('button', { class: 'pb-fix', type: 'button', title: 'Ask Claude to fix just this one', 'aria-label': `Fix: ${p.message}` }, 'Fix it');
    fix.addEventListener('click', () => sendFix([p.i]));
    return h('li', {}, open, fix);
  }

  async function sendFix(picked = null) {
    if (!tab || !data) return;
    if (tab.busy) SB.toast('He’s working: it goes once he’s done.', { ms: 2400 });
    const r = await api.fixProblems({ tabId: tab.id, at: data.at, picked });
    if (!r?.text) { SB.toast(r?.error || "Couldn't write that up."); return load(); }
    const t = tab;
    close();
    SB.activate(t.id);
    SB.inChat(() => SB.sendDirect(t, r.text));
  }

  runBtn.addEventListener('click', async () => {
    if (!tab) return;
    runBtn.disabled = true;
    const was = runBtn.textContent;
    runBtn.textContent = 'Looking…';
    sub.textContent = 'Running its checks…';
    try {
      const r = await api.findProblems(tab.id);
      if (!r?.ok && !r?.declined) SB.toast(r?.error || "Couldn't run its checks.");
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = was;
    }
    if (!sheet.hidden) await load();
  });
  fixAllBtn.addEventListener('click', () => sendFix(null));
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  sheet.addEventListener('mousedown', (e) => { if (e.target === sheet) close(); });
  $('problemsClose').addEventListener('click', close);
})();
