/* Shellby panel — Projects: your repositories (on this PC and on GitHub), what
   Shellby knows about each (project-facts.js), and the dev servers in them
   (src/main/projects/, src/main/devservers/). Main works everything out; this
   draws it and sends back what you click. This file holds the list and moves
   between it and a project's page (project-page.js); a clone's dev servers are
   projects-servers.js, adding, scanning and cloning projects-add.js, and the
   decisions projects-logic.js.

   Nothing goes to Claude from here without the approval sheet on a crashed
   server's card: it shows the exact prompt, and only its Send button sends.
   The other task buttons (Bump, Fix it, Ask why) start the same tasks their
   own pages do. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const F = SB.pjFacts;

  const L = window.ShellbyProjectsLogic;

  // The order, the scope and your pins outlast a restart (this PC only).
  const PREF = { sort: 'shellby.pj.sort', scope: 'shellby.pj.scope', pins: 'shellby.pj.pinned' };
  const readPins = () => {
    try { const v = JSON.parse(SB.pref(PREF.pins, '[]')); return Array.isArray(v) ? v.filter(k => typeof k === 'string') : []; } catch { return []; }
  };

  let data = null;           // projects:list
  let servers = null;         // servers:get, kept live by servers:changed
  let { sort, scope } = L.readView({ sort: SB.pref(PREF.sort), scope: SB.pref(PREF.scope) });
  let pins = readPins();
  let openKey = null;         // the project whose page is open
  let detail = null;          // projects:detail for it
  let loadedAt = 0;           // when the list last came back, for "updated 4m ago"

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
    loadedAt = Date.now();
    renderQuit();
    if (!same && $('pjMenu').hidden) { shownList = JSON.stringify(list); renderList(); } else renderSummary();
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

  // Shared with project-page.js, projects-servers.js and projects-add.js, which
  // add their parts to it as they load.
  const P = SB.pj = {
    data: () => data, servers: () => servers, openKey: () => openKey, detail: () => detail,
    serversIn, keptDetails, load, showScreen, renderAll, openProject, closeProject, newHere, devAction,
    reloadServers: async () => { servers = await api.getServers(); renderAll(); },
  };

  // ------------------------------------------------------------------ the list

  function renderList() {
    if (!data) return;
    const q = $('pjSearch').value.trim().toLowerCase();
    const running = p => p.local.some(c => serversIn(c.root).some(isLive));
    const ordered = L.visible(data.projects, { q, scope, sort, running, pinned: new Set(pins) });
    SB.keepFocus($('pjProjects'), () => $('pjProjects').replaceChildren(...ordered.map(projectRow)));
    announceCount(ordered.length);
    renderSummary();
    const empty = $('pjEmpty');
    const none = !data.projects.length;
    empty.hidden = ordered.length > 0;
    $('pjEmptyActions').hidden = !none;
    $('pjAddRow').hidden = none;
    $('pjEmptyText').textContent = L.emptyText({ none, scope, q });
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

  // "12 projects · 2 need you · 1 server up · updated 4m ago": the page's answer at a glance.
  function renderSummary() {
    if (!data) return;
    const n = data.projects.filter(p => !p.github?.archived).length;
    const need = F.needsYou(data.projects);
    const up = (servers?.servers || []).filter(isLive).length;
    const down = (servers?.servers || []).filter(s => s.status === 'crashed').length;
    // It redraws every half minute: keepFocus leaves you on "2 need you" if you were.
    SB.keepFocus($('pjSummary'), () => $('pjSummary').replaceChildren(...[
      h('span', { text: plural(n, 'project') }),
      need && h('button', { type: 'button', class: 'pj-sum-need', dataset: { keep: 'sum-need' }, text: `${need} need${need === 1 ? 's' : ''} you`, onclick: () => setScope('attention') }),
      down && h('span', { class: 'pj-sum-down', text: `${plural(down, 'server')} down` }),
      up && h('span', { text: `${plural(up, 'server')} up` }),
      loadedAt && h('span', { class: 'pj-sum-when', title: 'When Shellby last read your projects. Refresh reads them again now.', text: `updated ${SB.relTime(loadedAt)}` }),
    ].filter(Boolean).flatMap((el, i) => (i ? [h('span', { class: 'pj-sep', 'aria-hidden': 'true', text: '·' }), el] : [el]))));
    $('pjSummary').hidden = !data.projects.length;
  }
  // "updated 4m ago" keeps up while you look at it.
  const SUMMARY_TICK_MS = 30000;
  setInterval(() => { if (state.view === 'projects' && !$('pjListScreen').hidden) renderSummary(); }, SUMMARY_TICK_MS);

  const PIN_ICON = 'M6 2.5h4l-.5 4 2 2h-7l2-2zM8 8.5v5';

  function projectRow(p) {
    const mine = p.local.flatMap(c => serversIn(c.root));
    const live = mine.filter(isLive);
    const down = mine.filter(s => s.status === 'crashed');
    const where = p.local[0] ? SB.shortPath(p.local[0].root, 40) : 'Not on this PC';
    const chips = F.chipRow(p);
    const when = p.insights?.lastWorkedAt;
    const pinned = pins.includes(p.key);
    return h('li', { class: `pj-item${pinned ? ' pinned' : ''}`, oncontextmenu: e => { e.preventDefault(); openRowMenu(p, e.currentTarget.querySelector('.pj-row')); } },
      h('button', { type: 'button', class: 'pj-row', dataset: { keep: `row:${p.key}`, key: p.key }, onclick: () => openProject(p.key), title: p.local[0]?.root || p.github?.repo || '' },
        F.tile(p),
        h('span', { class: 'pj-row-main' },
          h('span', { class: 'pj-row-name' },
            pinned && h('span', { class: 'pj-pin', title: 'Pinned', 'aria-label': 'Pinned' }, SB.icon(PIN_ICON, { width: 1.4 })),
            h('b', { text: p.name }),
            p.github?.private && h('span', { class: 'pj-tag', text: 'private' }),
            p.github?.fork && h('span', { class: 'pj-tag', text: 'fork' }),
            p.github?.archived && h('span', { class: 'pj-tag', text: 'archived' }),
            p.local.length > 1 && h('span', { class: 'pj-tag', text: `${p.local.length} clones` })),
          h('span', { class: `pj-row-where${p.local.length ? '' : ' off'}`, text: p.github && p.local.length ? `${where} · ${p.github.repo}` : where }),
          chips),
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

  const chatAction = p => p.local[0] && { label: 'New conversation here', icon: 'chat', run: () => newHere(p.local[0].root) };

  function rowActions(p) {
    const c = p.local[0];
    const pinned = pins.includes(p.key);
    return [
      chatAction(p),
      devAction(p),
      c && { label: 'Open folder', icon: 'folder', run: () => api.openProjectFolder(c.root) },
      p.github && { label: 'Open on GitHub', icon: 'github', run: () => api.openProjectOnGitHub(p.github.repo) },
      !c && p.github && { label: 'Clone…', icon: 'download', run: async () => { await openProject(p.key); P.openClone(p.github.repo); } },
      { label: pinned ? 'Unpin' : 'Pin to top', icon: 'pin', run: () => togglePin(p) },
    ].filter(Boolean);
  }

  const QUICK_ICONS = {
    chat: 'M2.5 4.2c0-.8.6-1.4 1.4-1.4h8.2c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H7l-3 2.4v-2.4h-.1c-.8 0-1.4-.6-1.4-1.4z',
    play: SB.ICONS.play,
    more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  };
  const qIcon = name => SB.icon(QUICK_ICONS[name], { width: name === 'more' ? 2.6 : 1.4 });

  // Three fixed slots beside the row, so each icon is always in the same place:
  // a conversation, the dev server, then More. A slot with nothing to do stays empty.
  function quickActions(p) {
    const slot = a => (a
      ? h('button', { type: 'button', class: 'pj-q', dataset: { keep: `q:${p.key}:${a.icon}` }, title: a.label, 'aria-label': `${a.label}: ${p.name}`, onclick: () => a.run() }, qIcon(a.icon))
      : h('span', { class: 'pj-q empty', 'aria-hidden': 'true' }));
    const more = h('button', { type: 'button', class: 'pj-q', dataset: { keep: `more:${p.key}` }, title: 'More', 'aria-label': `More for ${p.name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: e => openRowMenu(p, e.currentTarget) }, qIcon('more'));
    return h('span', { class: 'pj-quick' }, slot(chatAction(p)), slot(devAction(p)), more);
  }

  function openRowMenu(p, anchor) {
    SB.openMenu($('pjMenu'), anchor, () => [
      ...rowActions(p).map(a => menuItem(a.label, a.run)),
      menuItem('Project page', () => openProject(p.key)),
    ]);
  }
  const { menuItem } = SB;

  function togglePin(p) {
    pins = L.togglePin(pins, p.key);
    SB.pref.set(PREF.pins, JSON.stringify(pins));
    SB.announce(pins.includes(p.key) ? `${p.name} pinned to the top.` : `${p.name} unpinned.`);
    renderList();
  }

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

  // ------------------------------------------------------------------ to a project's page and back

  async function openProject(key, { quiet = false } = {}) {
    const p = await api.projectDetail(key);
    if (!p) { if (!quiet) SB.toast("That project isn't on the list any more."); return closeProject(); }
    // A quiet reload that changed nothing leaves the page (and where you were on it) alone.
    const same = quiet && key === openKey && JSON.stringify(p) === JSON.stringify(detail);
    openKey = key;
    detail = p;
    if (same) return;
    showScreen('detail');
    P.renderDetail();
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

  // ------------------------------------------------------------------ live updates

  function renderAll() {
    renderQuit();
    if (state.view !== 'projects') return;
    if (openKey && detail && !$('pjDetailScreen').hidden) P.renderDetail();
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

  function setSort(to) {
    sort = to;
    SB.pref.set(PREF.sort, to);
    for (const x of $('pjSort').querySelectorAll('[role="tab"]')) x.setAttribute('aria-selected', String(x.dataset.sort === to));
    renderList();
  }
  function setScope(to) {
    scope = to;
    SB.pref.set(PREF.scope, to);
    $('pjScope').value = to;
    renderList();
  }
  for (const x of $('pjSort').querySelectorAll('[role="tab"]')) x.setAttribute('aria-selected', String(x.dataset.sort === sort));
  $('pjScope').value = scope;

  $('pjSearch').addEventListener('input', renderList);
  // Enter opens the top row; Esc clears what you typed (and only then goes back).
  $('pjSearch').addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      const top = $('pjProjects').querySelector('.pj-row');
      if (top) { e.preventDefault(); openProject(top.dataset.key); }
    } else if (e.key === 'Escape' && e.target.value) {
      e.preventDefault();
      e.stopPropagation();
      e.target.value = '';
      renderList();
    }
  });
  // Ctrl+F on the list searches the list, as it does on Settings.
  document.addEventListener('keydown', e => {
    if (state.view !== 'projects' || $('pjListScreen').hidden || !SB.shortcuts.matches(e, 'find')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    $('pjSearch').focus();
    $('pjSearch').select();
  }, true);

  for (const b of $('pjSort').querySelectorAll('[role="tab"]')) b.addEventListener('click', () => setSort(b.dataset.sort));
  $('pjScope').addEventListener('change', e => setScope(e.target.value));
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
