/* Shellby panel — Projects: your repositories (on this PC and on GitHub), what
   Shellby knows about each (project-facts.js), and the dev servers in them
   (src/main/projects/, src/main/devservers/). Main works everything out; this
   draws it and sends back what you click. This file holds the list and a
   project's page; a clone's dev servers are projects-servers.js, adding,
   scanning and cloning projects-add.js, and the decisions projects-logic.js.

   Nothing goes to Claude from here without the approval sheet on a crashed
   server's card: it shows the exact prompt, and only its Send button sends.
   The other task buttons (Bump, Fix it, Ask why) start the same tasks their
   own pages do. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const F = SB.pjFacts;

  const L = window.ShellbyProjectsLogic;

  let data = null;           // projects:list
  let servers = null;         // servers:get, kept live by servers:changed
  let scope = 'all';          // all | local | running | github
  let sort = 'recent';        // recent | attention | name
  let openKey = null;         // the project whose page is open
  let detail = null;          // projects:detail for it

  // ------------------------------------------------------------------ words

  const { plural } = SB;
  const { isLive } = L;

  // ------------------------------------------------------------------ loading

  // Git is read after the list (main's readGitSoon), so a reload often brings
  // nothing new: then nothing is redrawn, and an open menu, a <details> or the
  // row you're on stay as they are. Nor is the list redrawn under its open menu.
  let loadSeq = 0;
  let shownList = '';
  async function load({ refresh = false } = {}) {
    const seq = ++loadSeq;
    const [list, srv] = await Promise.all([api.listProjects({ refresh }), api.getServers()]);
    if (seq !== loadSeq || !list) return;
    SB.pjInbox?.load({ refresh }); // after the list, so main knows every clone it covers
    const same = JSON.stringify(list) === shownList && JSON.stringify(srv) === JSON.stringify(servers);
    data = list;
    servers = srv || servers;
    renderQuit();
    if (!same && $('pjMenu').hidden) { shownList = JSON.stringify(list); renderList(); }
    if (openKey) await openProject(openKey, { quiet: true });
  }

  // Redraws go through SB.keepFocus, which puts focus back on the same button;
  // these reopen the <details> that were open. Elements opt in with data-keep.
  const openDetails = new Set();
  function keptDetails(keep, summary, ...body) {
    const d = h('details', { class: 'pj-more', dataset: { keep } }, h('summary', { text: summary }), ...body);
    d.open = openDetails.has(keep);
    d.addEventListener('toggle', () => { if (d.open) openDetails.add(keep); else openDetails.delete(keep); });
    return d;
  }

  const serversIn = root => (servers?.servers || []).filter(s => s.root.toLowerCase() === root.toLowerCase());

  // Shared with projects-servers.js and projects-add.js, which add their parts
  // to it as they load.
  const P = SB.pj = {
    data: () => data, servers: () => servers, openKey: () => openKey,
    serversIn, keptDetails, load, showScreen, renderAll,
    reloadServers: async () => { servers = await api.getServers(); renderAll(); },
  };

  // ------------------------------------------------------------------ the list

  function renderList() {
    if (!data) return;
    const q = $('pjSearch').value.trim().toLowerCase();
    const running = p => p.local.some(c => serversIn(c.root).some(isLive));
    const ordered = L.visible(data.projects, { q, scope, sort, running });
    SB.keepFocus($('pjProjects'), () => $('pjProjects').replaceChildren(...ordered.map(projectRow)));
    announceCount(ordered.length);
    renderSummary();
    const empty = $('pjEmpty');
    const none = !data.projects.length;
    empty.hidden = ordered.length > 0;
    $('pjEmptyActions').hidden = !none;
    $('pjAddRow').hidden = none;
    $('pjEmptyText').textContent = L.emptyText({ none, scope, sort, q });
    renderGitHubNote();
  }

  // The list redraws on every keystroke in the search box, so it isn't a live
  // region; a screen reader hears how many are showing once you pause.
  let countSaid = '';
  let countTimer = null;
  function announceCount(n) {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const text = plural(n, 'project');
      if (text === countSaid || SB.state.view !== 'projects') return;
      countSaid = text;
      SB.announce(text);
    }, 500);
  }

  // "12 projects · 2 need you · 1 server up": the page's answer at a glance.
  function renderSummary() {
    const n = data.projects.filter(p => !p.github?.archived).length;
    const need = F.needsYou(data.projects);
    const up = (servers?.servers || []).filter(isLive).length;
    const down = (servers?.servers || []).filter(s => s.status === 'crashed').length;
    $('pjSummary').replaceChildren(...[
      h('span', { text: plural(n, 'project') }),
      need && h('button', { type: 'button', class: 'pj-sum-need', text: `${need} need${need === 1 ? 's' : ''} you`, onclick: () => setSort('attention') }),
      down && h('span', { class: 'pj-sum-down', text: `${plural(down, 'server')} down` }),
      up && h('span', { text: `${plural(up, 'server')} up` }),
    ].filter(Boolean).flatMap((el, i) => (i ? [h('span', { class: 'pj-sep', 'aria-hidden': 'true', text: '·' }), el] : [el])));
    $('pjSummary').hidden = !data.projects.length;
  }

  function projectRow(p) {
    const mine = p.local.flatMap(c => serversIn(c.root));
    const live = mine.filter(isLive);
    const down = mine.filter(s => s.status === 'crashed');
    const where = p.local[0] ? SB.shortPath(p.local[0].root, 40) : 'Not on this PC';
    const chips = F.chipRow(p);
    const when = p.insights?.lastWorkedAt;
    return h('li', { class: 'pj-item', oncontextmenu: e => { e.preventDefault(); openRowMenu(p, e.currentTarget.querySelector('.pj-row')); } },
      h('button', { type: 'button', class: 'pj-row', dataset: { keep: `row:${p.key}` }, onclick: () => openProject(p.key), title: p.local[0]?.root || p.github?.repo || '' },
        F.tile(p),
        h('span', { class: 'pj-row-main' },
          h('span', { class: 'pj-row-name' },
            h('b', { text: p.name }),
            p.github?.private && h('span', { class: 'pj-tag', text: 'private' }),
            p.github?.fork && h('span', { class: 'pj-tag', text: 'fork' }),
            p.github?.archived && h('span', { class: 'pj-tag', text: 'archived' }),
            p.local.length > 1 && h('span', { class: 'pj-tag', text: `${p.local.length} clones` })),
          chips || h('span', { class: `pj-row-where${p.local.length ? '' : ' off'}`, text: p.github && p.local.length ? `${where} · ${p.github.repo}` : where })),
        h('span', { class: 'pj-row-end' },
          down.length ? h('span', { class: 'pj-pill down', text: down.length > 1 ? `${down.length} down` : 'down' })
            : live.length ? h('span', { class: 'pj-pill up', text: live.length === 1 && live[0].port ? `:${live[0].port}` : `${live.length} up` }) : null,
          when && h('span', { class: 'pj-row-when', text: SB.relTime(when) }))),
      quickActions(p));
  }

  // ------------------------------------------------------------------ quick actions: on the row, and on right-click

  // The main clone's dev server: Open it if it's up, else Start the one you ran last (or the likeliest).
  function devAction(p) {
    const c = p.local[0];
    const choice = L.devChoice(c, serversIn);
    if (!choice) return null;
    const up = choice.open;
    if (up) return { label: `Open :${up.port || ''}`.replace(/ :$/, ''), icon: 'play', run: () => api.openServer(up.id) };
    const script = choice.start;
    return { label: `Start ${script.name}`, icon: 'play', run: async () => {
      const r = await api.startServer({ root: c.root, script: script.name });
      if (!r?.ok) return SB.toast(r?.error || "Couldn't start it.");
      SB.toast(`Starting ${c.manager} run ${script.name} in ${p.name}…`);
      await P.reloadServers();
    } };
  }

  function rowActions(p) {
    const c = p.local[0];
    const dev = devAction(p);
    return [
      c && { label: 'New conversation here', icon: 'chat', run: () => newHere(c.root) },
      dev,
      c && { label: 'Open folder', icon: 'folder', run: () => api.openProjectFolder(c.root) },
      p.github && { label: 'Open on GitHub', icon: 'github', run: () => api.openProjectOnGitHub(p.github.repo) },
      !c && p.github && { label: 'Clone…', icon: 'download', run: async () => { await openProject(p.key); P.openClone(p.github.repo); } },
    ].filter(Boolean);
  }

  const QUICK_ICONS = {
    chat: 'M2.5 4.2c0-.8.6-1.4 1.4-1.4h8.2c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H7l-3 2.4v-2.4h-.1c-.8 0-1.4-.6-1.4-1.4z',
    play: SB.ICONS.play,
    folder: SB.ICONS.folder,
    github: 'M6 12.5c-2.6.8-2.6-1.3-3.6-1.6M9.6 13.6v-2c0-.6.1-1-.3-1.4 1.7-.2 3.4-.8 3.4-3.6 0-.8-.3-1.5-.8-2 .1-.6.1-1.3-.1-1.9 0 0-.6-.2-2 .7a7 7 0 0 0-3.6 0c-1.4-.9-2-.7-2-.7-.2.6-.2 1.3-.1 1.9-.5.5-.8 1.2-.8 2 0 2.8 1.7 3.4 3.4 3.6-.3.3-.4.8-.3 1.4v2',
    download: 'M8 2.5v8m-3-3 3 3 3-3M3 13h10',
    more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  };
  const qIcon = name => SB.icon(QUICK_ICONS[name], { width: name === 'more' ? 2.6 : 1.4 });

  // The first two actions as icon buttons beside the row, the rest behind "More".
  function quickActions(p) {
    const acts = rowActions(p);
    if (!acts.length) return null;
    const shown = acts.slice(0, 2);
    const more = h('button', { type: 'button', class: 'pj-q', dataset: { keep: `more:${p.key}` }, title: 'More', 'aria-label': `More for ${p.name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: e => openRowMenu(p, e.currentTarget) }, qIcon('more'));
    return h('span', { class: 'pj-quick' },
      shown.map(a => h('button', { type: 'button', class: 'pj-q', dataset: { keep: `q:${p.key}:${a.icon}` }, title: a.label, 'aria-label': `${a.label}: ${p.name}`, onclick: () => a.run() }, qIcon(a.icon))),
      acts.length > shown.length || p.local.length ? more : null);
  }

  function openRowMenu(p, anchor) {
    SB.openMenu($('pjMenu'), anchor, () => [
      ...rowActions(p).map(a => menuItem(a.label, a.run)),
      menuItem('Project page', () => openProject(p.key)),
    ]);
  }
  const { menuItem } = SB;

  function newHere(cwd, draft) {
    SB.setView('chat');
    SB.newTabIn({ cwd, draft });
  }

  function renderGitHubNote() {
    const g = data.github;
    const el = $('pjGitHubNote');
    if (!g.signedIn) {
      el.replaceChildren('Sign in to GitHub in Settings to see your repositories here too.');
    } else if (!g.enabled) {
      el.replaceChildren(h('button', { type: 'button', class: 'link-btn', text: 'Show my GitHub repositories here', onclick: () => turnOnGitHub() }),
        ' (public ones need no extra permission).');
    } else {
      el.replaceChildren(g.error ? `Couldn't reach GitHub: ${g.error}` : g.privateRepos ? 'Showing your GitHub repositories, private ones included.'
        : 'Showing your public GitHub repositories. Private ones appear if Claude tasks may push (GitHub settings).');
    }
  }

  async function turnOnGitHub() {
    const r = await api.githubSetFeature('projects', true);
    if (r?.ok === false && !r.canceled) SB.toast(r.error || "Couldn't turn that on.");
    load({ refresh: true });
  }

  // ------------------------------------------------------------------ "when Shellby quits"

  function renderQuit() {
    if (!servers) return;
    const { onQuit, crab, sign, toast } = servers.settings;
    // On the page only while something runs: that's when it matters. One line, not a box.
    $('pjQuit').hidden = !servers.running;
    $('pjQuitCount').textContent = `${servers.running} running`;
    $('pjStopAll').textContent = servers.running > 1 ? 'Stop all' : 'Stop it';
    $('pjOnQuit').value = onQuit;
    for (const r of document.querySelectorAll('input[name="setOnQuit"]')) r.checked = r.value === onQuit;
    $('srvCrabToggle').checked = crab;
    $('srvSignToggle').checked = sign;
    $('srvToastToggle').checked = toast;
    const down = servers.servers.filter(s => s.status === 'crashed' && !s.seen).length;
    $('projectsBadge').hidden = !down;
  }

  async function setServerSettings(patch) {
    const v = await api.setServerSettings(patch);
    if (v) { servers = v; renderQuit(); }
  }
  for (const r of document.querySelectorAll('input[name="setOnQuit"]')) r.addEventListener('change', () => r.checked && setServerSettings({ onQuit: r.value, quitNoteSeen: true }));
  $('pjOnQuit').addEventListener('change', e => setServerSettings({ onQuit: e.target.value, quitNoteSeen: true }));
  $('srvCrabToggle').addEventListener('change', e => setServerSettings({ crab: e.target.checked }));
  $('srvSignToggle').addEventListener('change', e => setServerSettings({ sign: e.target.checked }));
  $('srvToastToggle').addEventListener('change', e => setServerSettings({ toast: e.target.checked }));
  $('pjStopAll').addEventListener('click', async () => { servers = await api.stopAllServers() || servers; renderQuit(); renderAll(); });

  // ------------------------------------------------------------------ one project

  async function openProject(key, { quiet = false } = {}) {
    const p = await api.projectDetail(key);
    if (!p) { if (!quiet) SB.toast("That project isn't on the list any more."); return closeProject(); }
    // A quiet reload that changed nothing leaves the page (and where you were on it) alone.
    const same = quiet && key === openKey && JSON.stringify(p) === JSON.stringify(detail);
    openKey = key;
    detail = p;
    if (same) return;
    showScreen('detail');
    renderDetail();
  }

  // Back to the list, read again: the page may have just read fresher git than the rows have.
  function closeProject() {
    openKey = null;
    detail = null;
    showScreen('list');
    renderList();
    load();
  }

  function showScreen(which) {
    $('pjListScreen').hidden = which !== 'list';
    $('pjDetailScreen').hidden = which !== 'detail';
    $('pjScanSheet').hidden = which !== 'scan';
    $('pjCloneSheet').hidden = which !== 'clone';
    $('pjRefresh').hidden = which === 'scan' || which === 'clone';
  }

  // A project's page, top to bottom: who it is and the button you came for,
  // how it's going, what needs you, where you left off (and the standup to
  // paste, project-report.js), then the clones
  // (git and dev servers), which is where the work actually happens.
  function renderDetail() {
    const p = detail;
    if (!p) return;
    const main = p.local[0];
    const i = p.insights || {};
    const sticker = i.sticker;
    const head = h('div', { class: 'pj-detail-head' },
      h('button', { type: 'button', class: 'btn ghost slim-btn', text: '← Projects', onclick: closeProject }),
      h('div', { class: 'pj-hero' },
        F.tile(p, 'lg'),
        h('div', { class: 'pj-hero-text' },
          h('h3', { class: 'pj-detail-name', text: p.name }),
          h('span', { class: 'pj-hero-tags' },
            p.github && h('button', { type: 'button', class: 'link-btn pj-repo', text: p.github.repo, onclick: () => api.openProjectOnGitHub(p.github.repo) }),
            p.github?.private && h('span', { class: 'pj-tag', text: 'private' }),
            p.github?.fork && h('span', { class: 'pj-tag', text: 'fork' }),
            p.github?.archived && h('span', { class: 'pj-tag', text: 'archived' })),
          sticker && h('span', { class: 'pj-hero-sticker', title: sticker.marks.map(m => m.name).join(', ') },
            `${sticker.tierName} sticker · ${plural(sticker.ships, 'ship')}`,
            sticker.marks.length ? ` · ${sticker.marks.map(m => m.icon).join(' ')}` : ''))),
      p.github?.description && h('p', { class: 'muted small pj-desc', text: p.github.description }),
      h('div', { class: 'row wrap pj-hero-acts' },
        main && h('button', { type: 'button', class: 'btn primary', text: 'New conversation here', onclick: () => newHere(main.root) }),
        main && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open folder', onclick: () => api.openProjectFolder(main.root) }),
        !main && p.github && h('button', { type: 'button', class: 'btn primary', text: 'Clone…', onclick: () => P.openClone(p.github.repo) }),
        p.github && main && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open on GitHub', onclick: () => api.openProjectOnGitHub(p.github.repo) })));
    const reload = () => openProject(p.key, { quiet: true });
    const cards = [
      // What to work on comes first: it's why you opened the page (backlog.js).
      (main || p.github) && SB.backlog.card({ root: main?.root || null, repo: p.github?.repo || null, name: p.name }, { onClone: repo => P.openClone(repo) }),
      main && F.pulse(p, { onChange: reload }),
      main && F.journal(p, { newHere, onChange: reload, keptDetails }),
      F.health(p),
      main && SB.releasesCard(main.root, p.name),
      main && SB.projectTools.card({ root: main.root, name: p.name }),
      main && F.conversations(p, { newHere }),
      main && SB.pjReport.card(p),
    ];
    const clones = p.local.length
      ? [h('p', { class: 'row-label pj-clones-label', text: p.local.length > 1 ? `${p.local.length} clones on this PC` : 'On this PC' }), ...p.local.map(c => cloneSection(c, p))]
      : [h('section', { class: 'pj-clone' }, h('p', { class: 'muted', text: 'Not on this PC. Clone it to run it, and to see its git, tests and dependencies here.' }))];
    const foot = h('div', { class: 'row wrap pj-detail-foot' },
      h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Remove from Projects', onclick: () => removeProject(p) }));
    SB.keepFocus($('pjDetailScreen'), () => $('pjDetailScreen').replaceChildren(head, ...cards.filter(Boolean), ...clones, foot));
  }

  function cloneSection(c, p) {
    const git = c.git;
    const { text: facts, atRisk } = L.cloneFacts(c); // atRisk is a boolean: h() would draw a bare 0
    return h('section', { class: 'pj-clone', dataset: { root: c.root } },
      h('div', { class: 'pj-clone-head' },
        h('code', { class: 'pj-path', text: SB.shortPath(c.root, 46), title: c.root }),
        p.local.length > 1 && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open folder', onclick: () => api.openProjectFolder(c.root) }),
        p.local.length > 1 && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'New conversation here', onclick: () => newHere(c.root) })),
      facts && h('p', { class: 'muted small pj-facts', text: facts }),
      atRisk && h('div', { class: 'pj-tidy' },
        h('span', { class: 'small', text: git.unpushed ? 'This work is only on this PC.' : 'Changes not committed yet.' }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Tidy up…', onclick: () => newHere(c.root, L.tidyPrompt(p.name)) })),
      copiesList(c.root, git),
      P.serversSection(c));
  }

  // Shellby's copies of the repo (worktrees.js): work that's easy to forget about.
  function copiesList(root, git) {
    const list = git?.copyList || [];
    if (!list.length) return null;
    const d = keptDetails(`copies:${root}`, L.copiesSummary(list),
      h('ul', { class: 'pj-copy-list' }, list.map(w => h('li', {},
        h('code', { text: w.branch || 'detached', title: w.path }),
        w.changed ? h('span', { class: 'pj-chip warn', text: `${w.changed} changed` }) : h('span', { class: 'muted small', text: 'clean' })))));
    d.classList.add('pj-copies');
    return d;
  }

  // ------------------------------------------------------------------ removing

  async function removeProject(p) {
    const r = await api.removeProject(p.key);
    if (!r?.ok) return SB.toast("Couldn't remove it.");
    SB.toast(`${p.name} is off the list. Its folder is untouched.`);
    closeProject();
    load();
  }

  // ------------------------------------------------------------------ live updates

  function renderAll() {
    renderQuit();
    if (state.view !== 'projects') return;
    if (openKey && detail && !$('pjDetailScreen').hidden) renderDetail();
    else if (!$('pjListScreen').hidden) renderList();
  }

  api.onServersChanged(v => {
    servers = v;
    // A running server's log grows: drop the copy so an open card reads it again.
    for (const s of v.servers) if (isLive(s)) P.forgetLog(s.id);
    // Don't redraw under someone typing a note for Claude.
    if (document.activeElement?.classList.contains('pj-note')) { renderQuit(); return; }
    renderAll();
  });
  api.onProjectsChanged(() => { if (state.view === 'projects') load(); });
  api.onProjectInstalled(({ project }) => { SB.toast(`Dependencies installed in ${project}.`); load(); });

  // The crab's sign, a toast or the tray: straight to that server's card.
  api.onProjectsShow(async ({ serverId } = {}) => {
    if (!data) await load();
    servers = await api.getServers();
    const s = servers?.servers.find(x => x.id === serverId);
    if (!s) return;
    const p = data.projects.find(x => x.local.some(c => c.root.toLowerCase() === s.root.toLowerCase()));
    if (!p) return;
    P.openCard(s.id);
    await openProject(p.key);
    const card = document.getElementById(`srv-card-${s.id}`);
    card?.scrollIntoView({ block: 'center' });
    card?.querySelector('button')?.focus();
  });

  // ------------------------------------------------------------------ controls

  $('pjSearch').addEventListener('input', renderList);
  function setSort(to) {
    sort = to;
    for (const x of $('pjSort').querySelectorAll('[role="tab"]')) x.setAttribute('aria-selected', String(x.dataset.sort === to));
    renderList();
  }
  for (const b of $('pjSort').querySelectorAll('[role="tab"]')) b.addEventListener('click', () => setSort(b.dataset.sort));
  $('pjScope').addEventListener('change', e => { scope = e.target.value; renderList(); });
  $('pjEmptyScan').addEventListener('click', () => $('pjScan').click());
  $('pjEmptyAdd').addEventListener('click', () => $('pjAdd').click());
  $('pjRefresh').addEventListener('click', () => load({ refresh: true }));

  // Settings' "Dev servers" group needs the settings even if Projects was never opened.
  api.getServers().then(v => { if (v) { servers = v; renderQuit(); } });

  SB.views.projects = {
    render: () => {
      if ($('pjScanSheet').hidden && $('pjCloneSheet').hidden) showScreen(openKey ? 'detail' : 'list');
      load();
    },
  };
})();
