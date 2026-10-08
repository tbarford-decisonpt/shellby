/* Shellby panel — Routines → In Claude's cloud: the routines you made with
   /schedule in Claude Code, which run in Anthropic's cloud whether your PC is
   on or not. Claude Code keeps them; main asks it for the list with a tiny
   one-off call (cloud-routines.js), so it's fetched when you ask, then kept
   for a few minutes. Run now asks in the confirm window; making or changing
   one is Claude Code's own /schedule, in a conversation. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  let view = null;      // { ok, routines, more, at } | { ok: false, error, signedOut }
  let loading = false;
  let asked = false;    // fetched at least once this run: after that, opening the page reads the kept list
  const runs = new Map(); // routine id -> { list, error } while its runs are open

  async function load(fresh = false) {
    if (loading) return;
    loading = true;
    asked = true;
    render();
    try { view = await api.listCloudRoutines(fresh); } catch { view = { ok: false, error: "Couldn't ask Claude Code." }; }
    loading = false;
    render();
  }

  // Making one is Claude Code's own /schedule, in a conversation of its own.
  const newOne = () => { SB.setView('chat'); SB.prefillNew('/schedule '); };

  async function toggleRuns(r) {
    if (runs.has(r.id)) { runs.delete(r.id); return render(); }
    runs.set(r.id, { list: null, error: null });
    render();
    const res = await api.cloudRuns(r.id).catch(() => null);
    if (!runs.has(r.id)) return;
    runs.set(r.id, res?.ok ? { list: res.runs, error: null } : { list: null, error: res?.error || "Couldn't get its runs." });
    render();
  }

  async function runNow(r, btn) {
    btn.disabled = true;
    const res = await api.runCloudRoutine(r.id).catch(() => null);
    btn.disabled = false;
    if (res?.cancelled) return;
    SB.toast(res?.ok ? `"${r.name}" is running in Claude's cloud.` : res?.error || "Couldn't start it.", res?.ok
      ? { ms: 7000, action: 'Watch it', onAction: () => api.openCloudRoutine(r.id) } : { ms: 8000 });
  }

  function whenText(r) {
    if (r.runOnceAt) return `once, ${new Date(r.runOnceAt).toLocaleString()}`;
    return r.schedule || (r.cron ? `cron ${r.cron} (UTC)` : 'no schedule');
  }

  function row(r) {
    const open = runs.get(r.id);
    return h('li', { class: `dep cloud-routine${r.enabled ? '' : ' paused'}` },
      h('div', { class: 'cr-top' },
        h('span', { class: 'cr-icon', 'aria-hidden': 'true', text: '☁' }),
        h('div', { class: 'cr-main' },
          h('div', { class: 'cr-name' }, h('b', { text: r.name }), r.enabled ? null : h('span', { class: 'dep-pill', text: 'paused' })),
          h('div', { class: 'cr-when muted small' },
            whenText(r),
            r.enabled && r.nextRunAt ? [' · ', h('span', { title: new Date(r.nextRunAt).toLocaleString(), text: `next ${SB.untilTime(r.nextRunAt)}` })] : null,
            r.repos.length ? ` · ${r.repos.map(u => u.replace(/^https?:\/\/(www\.)?github\.com\//, '')).join(', ')}` : null,
            r.model ? ` · ${r.model}` : null),
          r.prompt ? h('div', { class: 'ar-desc', text: r.prompt, title: r.prompt }) : null),
        h('div', { class: 'ar-actions' },
          h('button', { class: 'btn ghost slim-btn', type: 'button', 'aria-expanded': String(!!open), onclick: () => toggleRuns(r) }, open ? 'Hide runs' : 'Runs'),
          h('button', { class: 'btn ghost slim-btn', type: 'button', title: 'Open it on claude.ai', onclick: () => api.openCloudRoutine(r.id) }, 'Open'),
          h('button', { class: 'btn slim-btn', type: 'button', title: 'Start a run now. Asks first.', onclick: e => runNow(r, e.currentTarget) }, 'Run now'))),
      open ? h('div', { class: 'cr-runs' },
        open.error ? h('p', { class: 'err small', role: 'alert', text: open.error })
          : !open.list ? h('p', { class: 'muted small', text: 'Asking Claude Code…' })
            : !open.list.length ? h('p', { class: 'muted small', text: 'No runs yet.' })
              : h('ul', { class: 'cr-run-list' }, open.list.map(x => h('li', {},
                h('span', { class: `dep-pill${/fail|error/i.test(x.status || '') ? ' err' : /complet|success|idle/i.test(x.status || '') ? ' ok' : ''}`, text: x.status || 'run' }),
                h('span', { text: x.title || '' }),
                x.at ? h('span', { class: 'muted small', title: new Date(x.at).toLocaleString(), text: SB.relTime(x.at) }) : null)))) : null);
  }

  function render() {
    const list = $('cloudList');
    const actions = $('cloudActions');
    if (!list) return;
    if (state.settings?.crabOnly) { $('cloudRoutines').hidden = true; return; }
    $('cloudRoutines').hidden = false;
    // Opening the page reads the kept list once it's been fetched this run (main keeps it ten minutes).
    if (asked && !view && !loading) load();
    const refresh = h('button', { class: 'btn ghost slim-btn', type: 'button', disabled: loading, onclick: () => load(true) }, loading ? 'Asking Claude Code…' : asked ? 'Refresh' : 'Show my cloud routines');
    const create = h('button', { class: 'btn ghost slim-btn', type: 'button', title: "Starts a conversation with Claude Code's /schedule", onclick: newOne }, 'New cloud routine…');
    const manage = h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => api.openCloudRoutine(null) }, 'All on claude.ai');
    actions.replaceChildren(...[refresh, create, view?.ok ? manage : null].filter(Boolean));
    $('cloudSummary').textContent = view?.ok ? `${view.routines.length}${view.more ? '+' : ''} · as of ${SB.relTime(view.at)}` : '';
    if (!view) {
      list.replaceChildren(h('li', { class: 'muted small cloud-note', text: loading ? 'Asking Claude Code…' : 'Shellby asks Claude Code for them when you want to see them: one tiny call, a fraction of a cent.' }));
      return;
    }
    if (!view.ok) {
      list.replaceChildren(h('li', { class: 'cloud-note', role: 'alert' }, h('span', { text: view.error || "Couldn't get them." }),
        view.signedOut ? h('span', { class: 'muted small', text: ' Sign in to Claude Code with your claude.ai account, then refresh.' }) : null));
      return;
    }
    list.replaceChildren(...(view.routines.length ? view.routines.map(row)
      : [h('li', { class: 'muted small cloud-note', text: "None yet. A cloud routine runs a Claude Code session on a schedule in Anthropic's cloud, with your repo checked out: a nightly dependency check, a morning summary of new issues." })]));
  }

  SB.renderCloudRoutines = render;
})();
