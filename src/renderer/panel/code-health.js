/* Shellby panel — how each project's code is doing, under the Projects list:
   dependency health (checkup.js) and flaky tests (flaky.js). Dependency watch,
   the third section there, is depwatch.js. */
'use strict';
(function () {
  const { h, api, state, $, plural } = SB;
  const ECO_NAME = { npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', pip: 'Python', cargo: 'Rust', go: 'Go', ruby: 'Ruby', php: 'PHP', dotnet: '.NET', osv: 'OSV' };

  // ------------------------------------------------------------ dependency health

  // What each project's last audit and outdated check found (checkup.js).
  function depsLine(c) {
    const bits = [];
    if (c.audit?.status === 'clean') bits.push(h('span', { class: `dep-pill ${c.fresh ? 'ok' : ''}`, text: c.fresh ? '🧼 Fresh' : 'No known vulnerabilities' }));
    else if (c.audit?.status === 'issues') bits.push(h('span', { class: 'dep-pill err', text: c.audit.count ? plural(c.audit.count, 'vulnerability', 'vulnerabilities') : 'Vulnerable' }));
    if (c.outdated?.status === 'issues') bits.push(h('span', { class: 'dep-pill warn', text: c.outdated.count ? `${c.outdated.count} outdated` : 'Outdated' }));
    else if (c.outdated?.status === 'clean') bits.push(h('span', { class: 'dep-pill ok', text: 'Up to date' }));
    if (!bits.length) bits.push(h('span', { class: 'dep-pill', text: "Couldn't read the result" }));
    return bits;
  }

  function renderDeps() {
    const list = state.checkups || [];
    $('depsHealth').hidden = !list.length;
    if (!list.length) return;
    const fresh = list.filter(c => c.fresh).length;
    $('depsSummary').textContent = `${fresh} of ${plural(list.length, 'project')} fresh`;
    $('depsList').replaceChildren(...list.map(c => {
      const at = Math.max(c.audit?.at || 0, c.outdated?.at || 0);
      return h('li', { class: 'dep' },
        h('div', { class: 'dep-main' },
          h('div', { class: 'dep-name' }, h('span', { text: c.name }), c.ecosystem ? h('small', { text: ECO_NAME[c.ecosystem] || c.ecosystem }) : null),
          h('div', { class: 'dep-pills' }, ...depsLine(c), h('time', { title: new Date(at).toLocaleString(), text: `checked ${SB.relTime(at)}` }))),
        h('button', { class: 'btn ghost slim-btn', type: 'button', title: `Check ${c.name}'s dependencies again`, onclick: async () => {
          const res = await api.runCheckup(c.key);
          if (!res.ok) SB.toast(res.error);
          else { SB.setView('chat'); SB.toast('Press Enter to run the checkup'); }
        } }, 'Check again'));
    }));
  }

  SB.applyCheckups = list => { state.checkups = Array.isArray(list) ? list : []; if (state.view === 'projects') renderDeps(); };
  api.getCheckups().then(SB.applyCheckups);
  api.onCheckups(SB.applyCheckups);

  // ------------------------------------------------------------ flaky tests

  // Tests that failed and then passed on the same code (flaky.js).
  const RUNNER_NAME = { node: 'node --test', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', pytest: 'pytest', go: 'Go', cargo: 'Rust', playwright: 'Playwright', rspec: 'RSpec', dotnet: '.NET', phpunit: 'PHPUnit' };

  function flakyPills(f) {
    const bits = [];
    if (f.status === 'fixed') bits.push(h('span', { class: 'dep-pill ok', text: 'Fixed for good' }));
    else bits.push(h('span', { class: `dep-pill ${f.week >= 2 ? 'err' : 'warn'}`, text: f.week ? `flaked ${f.week === 1 ? 'once' : `${f.week} times`} this week` : `flaked ${plural(f.total, 'time')}` }));
    if (f.status === 'fixing') bits.push(h('span', { class: 'dep-pill', text: `Fixing: ${Math.min(f.clean.runs, f.clean.of)} of ${f.clean.of} clean runs` }));
    if (f.status === 'quarantined') bits.push(h('span', { class: 'dep-pill', text: 'Quarantined' }));
    if (f.issue) bits.push(h('a', { class: 'dep-pill', href: '#', 'data-href': f.issue.url, title: 'Open the issue on GitHub', text: `Issue #${f.issue.number}` }));
    return bits;
  }

  function flakyButton(f, action, label, title, primary = false) {
    return h('button', { class: `btn ${primary ? '' : 'ghost '}slim-btn`, type: 'button', title, onclick: async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const res = await api.flakyAct({ key: f.key, id: f.id, action });
      btn.disabled = false;
      if (res?.canceled) return;
      if (!res?.ok) SB.toast(res?.error || "That didn't work.");
      else if (action === 'dismiss') SB.toast(`Shellby will leave ${f.label} be`);
      else if (action === 'issue') SB.toast(`${res.existing ? 'Already filed' : 'Filed'} as issue #${res.number}`);
    } }, label);
  }

  function flakyButtons(f) {
    if (f.status === 'watching') {
      return [
        flakyButton(f, 'fix', 'Fix it', 'Claude finds the cause and fixes it, in a copy of the repository', true),
        flakyButton(f, 'quarantine', 'Quarantine', 'Claude skips just this test, with a note, in a copy of the repository'),
        f.issuable && !f.issue && flakyButton(f, 'issue', 'File an issue', 'A GitHub issue with what Shellby saw, labelled shellby so the Issue helper can offer to fix it. Asks first'),
        flakyButton(f, 'dismiss', 'Not flaky', "Hide it unless it keeps doing this (say, it was a server that wasn't up)"),
      ];
    }
    if (f.status === 'quarantined' && f.retry) return [flakyButton(f, 'unquarantine', 'Try it again', 'Claude un-skips it and runs it 20 times, in a copy of the repository', true)];
    return [];
  }

  function renderFlaky() {
    const list = state.flaky?.list || [];
    const on = state.flaky?.on !== false;
    $('flakyTests').hidden = !list.length;
    if (!list.length) return;
    const now = list.filter(f => f.week && f.status !== 'fixed').length;
    $('flakySummary').textContent = on ? (now ? `${plural(now, 'test')} flaky this week` : 'Nothing flaky this week') : 'Spotting is off in Settings';
    $('flakyList').replaceChildren(...list.map(f => h('li', { class: `dep flaky ${f.status}` },
      h('div', { class: 'dep-main' },
        h('div', { class: 'dep-name' },
          h('span', { text: f.label, title: f.suite ? 'A run failed without naming a test' : f.id }),
          h('small', { text: [f.project, RUNNER_NAME[f.framework]].filter(Boolean).join(' · ') })),
        h('div', { class: 'dep-pills' }, ...flakyPills(f), h('time', { title: new Date(f.lastAt).toLocaleString(), text: `last ${SB.relTime(f.lastAt)}` }))),
      h('div', { class: 'flaky-actions' }, ...flakyButtons(f)))));
  }

  SB.applyFlaky = v => { state.flaky = v && typeof v === 'object' ? { on: v.on !== false, list: Array.isArray(v.list) ? v.list : [] } : { on: true, list: [] }; if (state.view === 'projects') renderFlaky(); };
  SB.refreshFlaky = () => api.getFlaky().then(SB.applyFlaky);
  SB.refreshFlaky();
  // Main pushes the list alone; whether spotting is on comes from settings.
  api.onFlaky(list => SB.applyFlaky({ on: state.settings?.flakyTests !== false, list }));
  $('flakyForget').addEventListener('click', () => api.forgetFlaky()); // main asks first


  // ------------------------------------------------------------ the page

  // The crab, a notification or the tray: straight to one section, on the list
  // rather than whichever project page was open.
  const FOCUS = {
    flaky: { section: 'flakyTests', title: 'flakyTitle', ready: () => SB.refreshFlaky() },
    depwatch: { section: 'depWatch', title: 'depWatchTitle', ready: () => Promise.resolve() },
  };
  api.onCodeHealthFocus(async which => {
    const f = FOCUS[which];
    if (!f) return;
    if (SB.pj.openKey()) SB.pj.closeProject();
    await f.ready();
    const sec = $(f.section);
    if (sec.hidden) return;
    sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    $(f.title).setAttribute('tabindex', '-1');
    $(f.title).focus({ preventScroll: true });
  });

  const renderProjects = SB.views.projects.render;
  SB.views.projects.render = () => { renderProjects(); renderDeps(); renderFlaky(); };
})();
