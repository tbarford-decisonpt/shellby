/* Shellby panel — above the box, for the conversation on screen: Claude's own
   to-do list as it works through it (TaskCreate / TaskUpdate, or TodoWrite;
   shared/todos.js keeps it from the feed's items), and the commands and watches
   it left running in the background (main's jobs.js, in each tab's summary),
   each with its output a click away and a Stop. Shellby makes neither list:
   it shows Claude Code's. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const T = window.ShellbyTodos;

  const KEEP_FINISHED_MS = 2 * 60 * 1000; // a finished command stays in the tray this long
  const OUTPUT_EVERY_MS = 2000;           // an open output refreshes this often while it runs
  const OPEN_UP_TO = 6;                   // a list this short starts open

  // ------------------------------------------------------------ to-dos

  const MARK = { completed: '✓', in_progress: '▸', pending: '○' };

  function renderTodos(tab) {
    const box = $('todos');
    const s = tab && SB.activeTab() === tab ? T.summary(tab.todos) : null;
    // Shown while there's a list and either Claude is at it or something's left on it.
    const show = !!s && s.total > 0 && (tab.busy || s.done < s.total);
    box.hidden = !show;
    if (!show) { box.replaceChildren(); return; }
    tab.todosOpen ??= s.total <= OPEN_UP_TO;
    const all = T.allDone(s);
    const bar = h('span', { class: 'todo-bar', 'aria-hidden': 'true' });
    bar.style.setProperty('--done', `${Math.round((100 * s.done) / s.total)}%`);
    const head = h('button', { class: 'todo-head', type: 'button', 'aria-expanded': String(tab.todosOpen),
      title: tab.todosOpen ? 'Fold the list' : 'Show the whole list',
      onclick: () => { tab.todosOpen = !tab.todosOpen; renderTodos(tab); } },
      h('span', { class: 'todo-chev', 'aria-hidden': 'true', text: tab.todosOpen ? '▾' : '▸' }),
      h('b', { text: all ? `All ${s.total} done` : `${s.done} of ${s.total} done` }),
      bar,
      s.current && !all ? h('span', { class: 'todo-now', text: s.current }) : null);
    const list = tab.todosOpen
      ? h('ol', { class: 'todo-list' }, s.items.map(t => h('li', { class: `todo ${t.status}` },
          h('span', { class: 'todo-mark', 'aria-hidden': 'true', text: MARK[t.status] || '○' }),
          h('span', { class: 'todo-text', text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject }),
          h('span', { class: 'sr-only', text: ` (${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing now' : 'to do'})` }))))
      : null;
    box.replaceChildren(...[h('div', { class: 'todo-title muted small', text: "Claude's to-do list" }), head, list].filter(Boolean)); // replaceChildren writes a null out as text
  }

  // ------------------------------------------------------------ background commands

  const outputs = new Map(); // `${tabId}:${jobId}` -> { text, error, timer } while its output is open
  let ticker = null;

  const ago = ms => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60000)}m ago`);
  const statusText = (j, now) => (j.status === 'running' ? SB.clock(now - j.startedAt)
    : j.status === 'done' ? `done · ${ago(now - j.endedAt)}` : j.status === 'failed' ? `failed · ${ago(now - j.endedAt)}` : 'stopped');

  async function fetchOutput(tab, job) {
    const key = `${tab.id}:${job.id}`;
    const o = outputs.get(key);
    if (!o) return;
    const r = await api.jobOutput(tab.id, job.id).catch(() => null);
    if (!outputs.has(key)) return; // closed while it was on its way
    Object.assign(o, r?.ok ? { text: r.text || '(nothing yet)', cut: !!r.cut, error: null } : { error: r?.error || "Couldn't read its output." });
    renderJobs(tab);
  }

  function toggleOutput(tab, job) {
    const key = `${tab.id}:${job.id}`;
    const o = outputs.get(key);
    if (o) { clearInterval(o.timer); outputs.delete(key); renderJobs(tab); return; }
    const next = { text: null, error: null, timer: null };
    outputs.set(key, next);
    if (job.status === 'running') next.timer = setInterval(() => fetchOutput(tab, job), OUTPUT_EVERY_MS);
    fetchOutput(tab, job);
    renderJobs(tab);
  }

  async function stop(tab, job, btn) {
    btn.disabled = true;
    btn.textContent = 'Stopping…';
    const r = await api.stopJob(tab.id, job.id).catch(() => null);
    if (!r?.ok) { SB.toast(r?.error || "Couldn't stop it."); btn.disabled = false; btn.textContent = 'Stop'; }
  }

  function jobRow(tab, j, now) {
    const key = `${tab.id}:${j.id}`;
    const o = outputs.get(key);
    if (o && j.status !== 'running' && o.timer) { clearInterval(o.timer); o.timer = null; fetchOutput(tab, j); } // one last look once it ends
    const stopBtn = j.status === 'running' ? h('button', { class: 'btn ghost slim-btn', type: 'button', title: 'Ask Claude Code to stop it', onclick: e => stop(tab, j, e.currentTarget) }, 'Stop') : null;
    return h('li', { class: `job ${j.status}` },
      h('div', { class: 'job-row' },
        h('span', { class: 'job-icon', 'aria-hidden': 'true', text: j.kind === 'monitor' ? '👁' : j.status === 'running' ? '⚙' : j.status === 'done' ? '✓' : j.status === 'failed' ? '✗' : '■' }),
        h('span', { class: 'job-what', title: j.command || j.description, text: j.description }),
        h('span', { class: 'job-state', dataset: { since: String(j.startedAt) }, text: statusText(j, now) }),
        j.hasOutput ? h('button', { class: 'btn ghost slim-btn', type: 'button', 'aria-expanded': String(!!o), onclick: () => toggleOutput(tab, j) }, o ? 'Hide output' : 'Output') : null,
        stopBtn),
      j.status !== 'running' && j.summary ? h('div', { class: 'job-summary muted small', text: j.summary }) : null,
      o ? (o.error ? h('p', { class: 'job-out err', role: 'alert', text: o.error })
        : h('pre', { class: 'job-out', tabindex: '0', 'aria-label': `Output of ${j.description}` }, o.cut ? h('span', { class: 'muted', text: '… the start is cut off\n' }) : null, o.text ?? 'Reading…')) : null);
  }

  function renderJobs(tab) {
    const box = $('jobs');
    const now = Date.now();
    const list = tab && SB.activeTab() === tab
      ? (tab.jobs || []).filter(j => j.status === 'running' || now - (j.endedAt || 0) < KEEP_FINISHED_MS)
      : [];
    box.hidden = !list.length;
    // Outputs of jobs no longer listed close with them.
    for (const [key, o] of outputs) if (!list.some(j => `${tab?.id}:${j.id}` === key)) { clearInterval(o.timer); outputs.delete(key); }
    if (!list.length) { box.replaceChildren(); stopTicker(); return; }
    const running = list.filter(j => j.status === 'running').length;
    // Keep any output the reader has scrolled, rather than jumping it back to the top on every redraw.
    const scrolls = new Map([...box.querySelectorAll('pre.job-out')].map(p => [p.getAttribute('aria-label'), p.scrollTop]));
    box.replaceChildren(
      h('div', { class: 'job-title muted small' },
        running ? `Running in the background (${running}) · Claude is told when each one finishes` : 'Finished in the background'),
      h('ul', { class: 'job-list' }, list.map(j => jobRow(tab, j, now))));
    for (const p of box.querySelectorAll('pre.job-out')) {
      const at = scrolls.get(p.getAttribute('aria-label'));
      p.scrollTop = at ?? p.scrollHeight; // a fresh one shows its newest lines
    }
    startTicker();
  }

  // One timer while the tray shows: the running clocks tick, and finished ones leave on time.
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      const tab = SB.activeTab();
      if (!tab || $('jobs').hidden) return stopTicker();
      const now = Date.now();
      const stale = (tab.jobs || []).some(j => j.status !== 'running' && now - (j.endedAt || 0) >= KEEP_FINISHED_MS && j.endedAt);
      if (stale) return renderJobs(tab);
      for (const el of $('jobs').querySelectorAll('.job.running .job-state')) el.textContent = SB.clock(now - Number(el.dataset.since));
    }, 1000);
  }
  function stopTicker() { clearInterval(ticker); ticker = null; }

  SB.renderTodos = renderTodos;
  SB.renderJobs = renderJobs;
})();
