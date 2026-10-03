/* Shellby panel — Dependency watch: the weekly look at outdated and vulnerable
   packages, at the foot of the Routines page (src/main/depwatch.js). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  let view = null;
  let shown = null;              // what the list was last built from: the Routines page re-renders every minute
  let started = new Set();       // projects with a bump task going, until the next check
  let startedFor = null;         // ...which check that was
  const INTRO = [...$('depWatchSum').childNodes].map(n => n.cloneNode(true));

  const SEVERITY_CLASS = { critical: 'err', high: 'err', moderate: 'warn', low: '' };

  function lastChecked(v) {
    if (v.scanning) return 'Checking your projects…';
    if (v.error) return v.error;
    if (!v.lastScanAt) return 'Not checked yet.';
    const flagged = v.results.filter(r => r.attention).length;
    const what = !v.results.length ? 'No npm projects found.'
      : flagged ? `${flagged} of ${v.results.length} could use updates.` : `All ${v.results.length} up to date.`;
    return `Checked ${SB.relTime(v.lastScanAt)}. ${what} Next check ${SB.untilTime(v.nextScanAt)}.`;
  }

  async function bump(r, btn) {
    btn.disabled = true;
    let ok = false;
    try {
      const res = await api.bumpDeps(r.key);
      if (res?.needsClaude) return SB.claudeUpsell('deps');
      if (!res?.ok) return SB.toast(res?.error || "Couldn't start that.");
      ok = true;
      // One task per project per check: a second click would make a second branch.
      started = new Set([...started, r.key]);
      btn.textContent = 'Started';
      SB.toast(`Shellby is bumping ${r.name} in a copy of its own`);
    } finally {
      if (!ok) btn.disabled = false;
    }
  }

  async function makeRoutine(r) {
    const draft = await api.depRoutine(r.key);
    if (!draft) return SB.toast('Check again first: that project is no longer in the list.');
    SB.views.routines.openEditor({ ...draft, isTemplate: true });
    SB.toast('Check it over, then press Save.');
  }

  function row(r) {
    const pill = r.worst ? h('span', { class: `r-pill ${SEVERITY_CLASS[r.worst]}`, text: r.worst }) : null;
    return h('li', { class: `dw-project${r.attention ? ' attention' : ''}${r.ok ? '' : ' failed'}` },
      h('div', { class: 'dw-main' },
        h('div', { class: 'dw-name' }, h('span', { text: r.name, title: r.key }), pill),
        h('div', { class: 'dw-what', text: r.summary })),
      r.attention && h('div', { class: 'dw-actions' },
        h('button', { class: 'btn slim-btn primary', type: 'button', title: 'In a copy of the project: bump the packages, run the tests and open a pull request',
          'aria-label': `Bump, test and open a pull request for ${r.name}`, disabled: started.has(r.key), onclick: e => bump(r, e.currentTarget) },
        started.has(r.key) ? 'Started' : 'Bump & open a PR'),
        h('button', { class: 'btn slim-btn ghost', type: 'button', title: 'A weekly routine that does the same on its own',
          'aria-label': `Make a weekly routine for ${r.name}`, onclick: () => makeRoutine(r) }, 'Make it a routine')));
  }

  function render(v = view) {
    if (!v) return;
    view = v;
    if (state.view !== 'routines') return;
    $('depWatchToggle').checked = v.enabled;
    $('depWatchCheck').hidden = !v.enabled;
    $('depWatchCheck').disabled = v.scanning;
    $('depWatchCheck').textContent = v.scanning ? 'Checking…' : 'Check now';
    $('depWatch').setAttribute('aria-busy', v.scanning ? 'true' : 'false');
    if (v.lastScanAt !== startedFor) { started = new Set(); startedFor = v.lastScanAt; }
    // Off: the intro (in the HTML) says what turning it on does. Only rewritten
    // when it changes: it's a live region, and a rewrite is read out again.
    const sum = v.enabled ? lastChecked(v) : null;
    if (sum === null) {
      if ($('depWatchSum').textContent !== INTRO.map(n => n.textContent).join('')) $('depWatchSum').replaceChildren(...INTRO.map(n => n.cloneNode(true)));
    } else if ($('depWatchSum').textContent !== sum) $('depWatchSum').textContent = sum;
    // Rebuilt only when something in it changed, so focus stays on its buttons.
    const key = JSON.stringify([v.enabled, v.results, [...started]]);
    if (key === shown) return;
    shown = key;
    const rows = v.enabled ? [...v.results].sort((a, b) => b.attention - a.attention) : [];
    $('depWatchList').replaceChildren(...rows.map(row));
  }

  $('depWatchToggle').addEventListener('change', async e => render(await api.setDepWatch(e.target.checked)));
  $('depWatchCheck').addEventListener('click', async () => render(await api.scanDeps()));
  api.onDepWatch(render);

  const renderRoutines = SB.views.routines.render;
  SB.views.routines.render = () => { renderRoutines(); api.getDepWatch().then(render); };
})();
