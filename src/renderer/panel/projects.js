/* Shellby panel — Projects: your repositories (on this PC and on GitHub), what
   Shellby knows about each (project-facts.js), and the dev servers in them
   (src/main/projects/, src/main/devservers/). Main works everything out; this
   draws it and sends back what you click.

   Nothing goes to Claude from here without the approval sheet on a crashed
   server's card: it shows the exact prompt, and only its Send button sends.
   The other task buttons (Bump, Fix it, Ask why) start the same tasks their
   own pages do. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const F = SB.pjFacts;

  let data = null;            // projects:list
  let servers = null;         // servers:get, kept live by servers:changed
  let scope = 'all';          // all | local | running | github
  let sort = 'recent';        // recent | attention | name
  let openKey = null;         // the project whose page is open
  let detail = null;          // projects:detail for it
  const openCards = new Set(); // server ids whose log is open
  const logs = new Map();     // id -> { lines, errors }
  const notes = new Map();    // id -> what you typed for Claude
  const drafts = new Map();   // id -> the prompt as main built it
  let scan = null;            // { candidates, picked: Set }
  let cloneRepo = null;
  let cloning = false;

  // ------------------------------------------------------------------ words

  const { plural } = SB;
  const ago = t => (t ? SB.relTime(t) : '');
  const STATUS = {
    starting: s => (s.kind === 'install' ? 'Installing…' : 'Starting…'),
    up: s => (s.port ? `Up on :${s.port}` : 'Up'),
    // Ended while Shellby was closed with no exit code: it may well have been stopped on purpose.
    crashed: s => (s.missed && !Number.isInteger(s.exitCode) ? `Stopped while Shellby was closed · ${ago(s.endedAt)}`
      : `${s.neverUp ? "Didn't start" : 'Crashed'} ${ago(s.endedAt)}${Number.isInteger(s.exitCode) ? ` · exit code ${s.exitCode}` : ''}${s.missed ? ' · while Shellby was closed' : ''}`),
    failed: s => `Install failed ${ago(s.endedAt)}${Number.isInteger(s.exitCode) ? ` · exit code ${s.exitCode}` : ''}`,
  };
  const statusText = s => STATUS[s.status]?.(s) || s.status;
  const isLive = s => s.status === 'starting' || s.status === 'up';
  const modeTitle = () => SB.MODES.find(m => m.id === state.settings.mode)?.title || 'your current mode';

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

  // ------------------------------------------------------------------ the list

  const SORTS = {
    recent: () => 0, // main's order: worked on lately, running, on this PC, last push
    attention: (a, b) => (b.insights?.attention || 0) - (a.insights?.attention || 0),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  };

  function renderList() {
    if (!data) return;
    const q = $('pjSearch').value.trim().toLowerCase();
    const running = p => p.local.some(c => serversIn(c.root).some(isLive));
    const inScope = p => (scope === 'local' ? p.local.length > 0 : scope === 'github' ? !p.local.length : scope === 'running' ? running(p) : true);
    const shown = data.projects.filter(p => {
      if (q && !`${p.name} ${p.github?.repo || ''}`.toLowerCase().includes(q)) return false;
      if (!inScope(p)) return false;
      if (sort === 'attention' && !q) return (p.insights?.attention || 0) > 0 || running(p);
      return scope !== 'all' || !p.github?.archived || q;
    });
    const ordered = shown.map((p, i) => [p, i]).sort(([a, i], [b, j]) => SORTS[sort](a, b) || i - j).map(([p]) => p);
    SB.keepFocus($('pjProjects'), () => $('pjProjects').replaceChildren(...ordered.map(projectRow)));
    announceCount(ordered.length);
    renderSummary();
    const empty = $('pjEmpty');
    const none = !data.projects.length;
    empty.hidden = shown.length > 0;
    $('pjEmptyActions').hidden = !none;
    $('pjAddRow').hidden = none;
    $('pjEmptyText').textContent = none
      ? "No projects yet. Shellby lists the repos he's seen you work in. Scan the folder you keep them in and tick the ones you want, or add one."
      : scope === 'running' ? 'Nothing running right now.'
        : sort === 'attention' && !q ? 'Nothing needs you. Every project is pushed, passing and up to date as far as Shellby knows. 🐚'
          : 'Nothing matches.';
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
    if (!c) return null;
    const up = serversIn(c.root).find(s => s.status === 'up' && s.url && s.kind === 'server');
    if (up) return { label: `Open :${up.port || ''}`.replace(/ :$/, ''), icon: 'play', run: () => api.openServer(up.id) };
    if (serversIn(c.root).some(isLive)) return null;
    const script = c.scripts.find(s => s.name === c.lastScript) || c.scripts.find(s => s.likely);
    if (!script || c.installed === false) return null;
    return { label: `Start ${script.name}`, icon: 'play', run: async () => {
      const r = await api.startServer({ root: c.root, script: script.name });
      if (!r?.ok) return SB.toast(r?.error || "Couldn't start it.");
      SB.toast(`Starting ${c.manager} run ${script.name} in ${p.name}…`);
      servers = await api.getServers();
      renderAll();
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
      !c && p.github && { label: 'Clone…', icon: 'download', run: async () => { await openProject(p.key); openClone(p.github.repo); } },
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
  // how it's going, what needs you, where you left off, then the clones
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
        !main && p.github && h('button', { type: 'button', class: 'btn primary', text: 'Clone…', onclick: () => openClone(p.github.repo) }),
        p.github && main && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open on GitHub', onclick: () => api.openProjectOnGitHub(p.github.repo) })));
    const reload = () => openProject(p.key, { quiet: true });
    const cards = [
      main && F.pulse(p, { onChange: reload }),
      F.todo(p),
      F.health(p),
      main && F.conversations(p, { newHere }),
      main && SB.startFrom.looseEndsCard(main.root, p.name),
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
    const facts = [
      c.branch && `on ${c.branch}`,
      git && (git.dirty ? plural(git.dirty, 'uncommitted change') : 'nothing uncommitted'),
      git?.unpushed && `${git.unpushed} unpushed`,
      git?.stashes && plural(git.stashes, 'stash', 'stashes'),
    ].filter(Boolean).join(' · ');
    const atRisk = !!(git && (git.dirty || git.unpushed)); // a boolean: h() would draw a bare 0
    return h('section', { class: 'pj-clone', dataset: { root: c.root } },
      h('div', { class: 'pj-clone-head' },
        h('code', { class: 'pj-path', text: SB.shortPath(c.root, 46), title: c.root }),
        p.local.length > 1 && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open folder', onclick: () => api.openProjectFolder(c.root) }),
        p.local.length > 1 && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'New conversation here', onclick: () => newHere(c.root) })),
      facts && h('p', { class: 'muted small pj-facts', text: facts }),
      atRisk && h('div', { class: 'pj-tidy' },
        h('span', { class: 'small', text: git.unpushed ? 'This work is only on this PC.' : 'Changes not committed yet.' }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Tidy up…', onclick: () => newHere(c.root, tidyPrompt(p.name)) })),
      copiesList(c.root, git),
      serversSection(c));
  }

  // The same ask as "Is it safe to leave?" → Tidy up, put in the box for you to read and send.
  const tidyPrompt = name => `In ${name}: commit any uncommitted work with clear messages, push every branch that has commits the remote doesn't, and tell me what's in any stashes. Never commit or push a .env file, a key file or anything that looks like a password or API key. Ask me before anything destructive.`;

  // Shellby's copies of the repo (worktrees.js): work that's easy to forget about.
  function copiesList(root, git) {
    const list = git?.copyList || [];
    if (!list.length) return null;
    const changed = list.filter(w => w.changed).length;
    const d = keptDetails(`copies:${root}`, `${plural(list.length, 'copy', 'copies')} Shellby made${changed ? ` · ${changed} with changes` : ''}`,
      h('ul', { class: 'pj-copy-list' }, list.map(w => h('li', {},
        h('code', { text: w.branch || 'detached', title: w.path }),
        w.changed ? h('span', { class: 'pj-chip warn', text: `${w.changed} changed` }) : h('span', { class: 'muted small', text: 'clean' })))));
    d.classList.add('pj-copies');
    return d;
  }

  // ------------------------------------------------------------------ servers in a clone

  function serversSection(c) {
    const running = serversIn(c.root);
    const install = running.find(s => s.kind === 'install');
    const box = h('div', { class: 'pj-servers' }, h('p', { class: 'row-label', text: 'Servers' }));
    if (!c.scripts.length) {
      box.append(h('p', { class: 'muted small', text: c.manager === null ? 'No package.json here, so nothing to run yet.' : 'No scripts in package.json.' }));
      return box;
    }
    if (install) box.append(serverCard(install, c));
    else if (c.installed === false) {
      box.append(h('div', { class: 'pj-install' },
        h('span', { class: 'small', text: `Install dependencies first (${c.manager} install).` }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Install', onclick: () => doInstall(c) })));
    }
    const likely = c.scripts.filter(s => s.likely);
    const rest = c.scripts.filter(s => !s.likely);
    const rowsFor = list => list.map(sc => {
      const s = running.find(x => x.kind === 'server' && x.script === sc.name);
      return s ? serverCard(s, c) : scriptRow(sc, c);
    });
    box.append(h('ul', { class: 'pj-scripts' }, rowsFor(likely.length ? likely : rest.slice(0, 3))));
    const more = likely.length ? rest : rest.slice(3);
    if (more.length) box.append(keptDetails(`scripts:${c.root}`, `More scripts (${more.length})`, h('ul', { class: 'pj-scripts' }, rowsFor(more))));
    return box;
  }

  function scriptRow(sc, c) {
    return h('li', { class: 'pj-script' },
      h('span', { class: 'pj-dot off', 'aria-hidden': 'true' }),
      h('span', { class: 'pj-script-name' }, h('code', { text: `${c.manager} run ${sc.name}` }), sc.framework && h('span', { class: 'pj-tag', text: sc.framework })),
      h('button', { type: 'button', class: `btn slim-btn${sc.name === c.lastScript ? ' primary' : ''}`, text: 'Start', onclick: e => startScript(e.target, c, sc.name) }));
  }

  async function startScript(btn, c, script) {
    btn.disabled = true;
    const r = await api.startServer({ root: c.root, script });
    btn.disabled = false;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start it.");
    servers = await api.getServers();
    renderAll();
  }

  async function doInstall(c) {
    const r = await api.installProject(c.root);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start the install.");
    servers = await api.getServers();
    renderAll();
  }

  function serverCard(s, c) {
    const crashed = s.status === 'crashed' || s.status === 'failed';
    const fixed = crashed && s.fixedAt > 0; // a boolean: h() would draw a bare 0
    const open = openCards.has(s.id) || crashed;
    const name = s.kind === 'install' ? `${c.manager} install` : `${s.manager} run ${s.script}`;
    const act = (text, fn, cls = 'btn ghost slim-btn') => h('button', { type: 'button', class: cls, text, onclick: fn });
    const buttons = [
      fixed && act('Restart', () => serverAction('restartServer', s.id), 'btn primary slim-btn'),
      s.status === 'up' && s.url && act('Open', () => api.openServer(s.id), 'btn slim-btn'),
      isLive(s) && s.kind === 'server' && act('Restart', () => serverAction('restartServer', s.id)),
      isLive(s) && act('Stop', () => serverAction('stopServer', s.id)),
      crashed && !fixed && s.kind === 'server' && act('Restart', () => serverAction('restartServer', s.id)),
      crashed && act('Dismiss', () => serverAction('dismissServer', s.id)),
      act(open ? 'Hide log' : 'Log', () => toggleLog(s.id)),
    ].filter(Boolean);
    const card = h('li', { class: `pj-card ${s.status}`, id: `srv-card-${s.id}` },
      h('div', { class: 'pj-card-head' },
        h('span', { class: `pj-dot ${s.status}`, 'aria-hidden': 'true' }),
        h('span', { class: 'pj-script-name' }, h('code', { text: name }), s.framework && h('span', { class: 'pj-tag', text: s.framework })),
        h('span', { class: 'pj-status', role: 'status', text: statusText(s) })),
      fixed && h('p', { class: 'pj-fixed', text: "Claude's done. Restart the server?" }),
      h('div', { class: 'row wrap pj-card-actions' }, buttons),
      open && logBox(s),
      crashed && !fixed && s.canFix && approvalSheet(s));
    if (crashed && !s.seen) api.serverSeen(s.id);
    return card;
  }

  async function serverAction(method, id) {
    const r = await api[method](id);
    if (r && r.ok === false && r.error) SB.toast(r.error);
    if (method !== 'stopServer') openCards.delete(id);
    logs.delete(id);
    drafts.delete(id);
    servers = await api.getServers();
    renderAll();
  }

  function toggleLog(id) {
    if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
    renderAll();
  }

  // The log, redacted by main. Error lines are marked so the cause stands out.
  function logBox(s) {
    const box = h('div', { class: 'pj-log-wrap' });
    const draw = l => {
      const errors = new Set(l.errors);
      const pre = h('pre', { class: 'pj-log', tabindex: '0', 'aria-label': `Output of ${s.script || 'the install'}` },
        l.lines.length ? l.lines.map((line, i) => h('span', { class: errors.has(i) ? 'err' : null, text: `${line}\n` })) : h('span', { class: 'muted', text: 'Nothing printed yet.' }));
      box.replaceChildren(pre, h('button', { type: 'button', class: 'link-btn small', text: 'Open the log file', onclick: () => api.openServerLog(s.id) }));
      pre.scrollTop = pre.scrollHeight;
    };
    if (logs.has(s.id) && !isLive(s)) draw(logs.get(s.id));
    else api.serverLog(s.id).then(l => { if (l) { logs.set(s.id, l); draw(l); } });
    return box;
  }

  // ------------------------------------------------------------------ the approval sheet

  function approvalSheet(s) {
    const prompt = h('pre', { class: 'pj-prompt', tabindex: '0', 'aria-label': 'What will be sent to Claude' });
    const note = h('textarea', { class: 'field pj-note', rows: '2', maxlength: '500', placeholder: 'Anything to add? (optional)', 'aria-label': 'A note for Claude' });
    note.value = notes.get(s.id) || '';
    let t = null;
    let seq = 0;
    // Send is only ever for the draft on screen: off while it's being fetched,
    // and it carries that draft's hash so main sends exactly this text or nothing.
    let shown = null; // { hash, note }
    const refresh = async () => {
      const mine = ++seq;
      send.disabled = true;
      const d = await api.serverFixDraft({ id: s.id, note: note.value });
      if (mine !== seq) return;
      if (!d) { prompt.textContent = 'This server is running again.'; return; }
      drafts.set(s.id, d.prompt);
      prompt.textContent = d.prompt;
      shown = { hash: d.hash, note: note.value };
      send.disabled = false;
    };
    note.addEventListener('input', () => { notes.set(s.id, note.value); send.disabled = true; clearTimeout(t); t = setTimeout(refresh, 250); });
    // Enter in the note is a new line, never "send".
    const send = h('button', { type: 'button', class: 'btn primary slim-btn', text: 'Send to Claude', disabled: true, onclick: () => shown && sendFix(s, shown, send, refresh) });
    if (drafts.has(s.id)) prompt.textContent = drafts.get(s.id); else prompt.textContent = 'Getting the error…';
    refresh();
    return h('section', { class: 'pj-approve', 'aria-label': 'Ask Claude to fix it' },
      h('p', { class: 'pj-approve-title', text: 'Ask Claude to fix it?' }),
      h('p', { class: 'muted small', text: 'This is exactly what will be sent: the last lines it printed (secrets blanked out) and what to do with them.' }),
      prompt,
      note,
      h('p', { class: 'muted small pj-where' },
        `Claude will work in ${SB.shortPath(s.root, 40)}, in ${modeTitle()} mode. `,
        h('button', { type: 'button', class: 'link-btn', text: 'Change the mode', onclick: () => { SB.setView('settings'); } })),
      h('div', { class: 'row wrap' },
        send,
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Not now', onclick: () => { openCards.delete(s.id); renderAll(); } })));
  }

  async function sendFix(s, shown, btn, refresh) {
    btn.disabled = true;
    const r = await api.sendServerFix({ id: s.id, note: shown.note, hash: shown.hash });
    if (!r?.ok) {
      SB.toast(r?.error || "Couldn't open a conversation.");
      // Changed since you read it: show the new text and let you look again.
      if (r?.stale) refresh(); else btn.disabled = false;
      return;
    }
    notes.delete(s.id);
    drafts.delete(s.id);
    // The tab opened itself (boot.js onTabOpened); go and watch it work.
    SB.setView('chat');
    if (state.tabs.has(r.tabId)) SB.activate(r.tabId);
  }

  // ------------------------------------------------------------------ removing

  async function removeProject(p) {
    const r = await api.removeProject(p.key);
    if (!r?.ok) return SB.toast("Couldn't remove it.");
    SB.toast(`${p.name} is off the list. Its folder is untouched.`);
    closeProject();
    load();
  }

  // ------------------------------------------------------------------ adding: one repo, or a scan

  $('pjAdd').addEventListener('click', async () => {
    const r = await api.addProject();
    if (r?.cancelled) return;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't add that folder.");
    SB.toast(`Added ${r.name}`);
    load({ refresh: true });
  });

  $('pjScan').addEventListener('click', async () => {
    showScreen('scan');
    $('pjScanLede').textContent = 'Choose a folder to look through…';
    $('pjScanList').replaceChildren();
    $('pjScanAdd').disabled = true;
    scan = null;
    const r = await api.scanForProjects();
    if (!r?.ok) { if (!r?.cancelled) SB.toast(r?.error || "Couldn't look through that folder."); return showScreen('list'); }
    scan = { ...r, picked: new Set() };
    renderScan();
  });

  function renderScan() {
    const { candidates, parent, truncated, picked } = scan;
    $('pjScanLede').textContent = candidates.length
      ? `Found ${plural(candidates.length, 'repository')} in ${SB.shortPath(parent, 40)}${truncated ? ' (stopped looking after the first 200)' : ''}. Tick the ones to add; nothing is added until you do.`.replace('repositorys', 'repositories')
      : `No git repositories in ${SB.shortPath(parent, 40)}, two folders deep.`;
    $('pjScanList').replaceChildren(...candidates.map(c => {
      const box = h('input', { type: 'checkbox', disabled: c.listed });
      box.checked = c.listed || picked.has(c.root);
      box.addEventListener('change', () => { if (box.checked) picked.add(c.root); else picked.delete(c.root); updateScanButtons(); });
      return h('li', {}, h('label', { class: 'pj-check' }, box,
        h('span', {}, h('b', { text: c.name }), c.remote && h('span', { class: 'muted small', text: ` ${c.remote}` }), c.listed && h('span', { class: 'pj-tag', text: 'already listed' }),
          h('span', { class: 'pj-check-path', text: SB.shortPath(c.root, 50) }))));
    }));
    updateScanButtons();
  }

  function updateScanButtons() {
    const n = scan?.picked.size || 0;
    $('pjScanAdd').disabled = !n;
    $('pjScanAdd').textContent = n ? `Add ${n} selected` : 'Add selected';
  }

  $('pjScanAll').addEventListener('click', () => {
    if (!scan) return;
    for (const c of scan.candidates) if (!c.listed) scan.picked.add(c.root);
    renderScan();
  });
  $('pjScanAdd').addEventListener('click', async () => {
    const r = await api.addProjects([...scan.picked]);
    SB.toast(r?.added ? `Added ${plural(r.added, 'repository')}`.replace('repositorys', 'repositories') : 'Nothing added.');
    scan = null;
    showScreen('list');
    load({ refresh: true });
  });
  $('pjScanCancel').addEventListener('click', () => { api.cancelProjectScan(); scan = null; showScreen('list'); });

  // ------------------------------------------------------------------ cloning

  function openClone(repo) {
    cloneRepo = repo;
    showScreen('clone');
    $('pjCloneTitle').textContent = `Clone ${repo}`;
    $('pjCloneWhere').textContent = 'No folder chosen';
    $('pjCloneDest').textContent = '';
    $('pjCloneError').hidden = true;
    $('pjCloneStatus').textContent = '';
    $('pjCloneProgress').hidden = true;
    $('pjCloneGo').disabled = true;
    const again = $('pjCloneAgain');
    again.hidden = !data?.lastCloneParent;
    if (data?.lastCloneParent) again.textContent = `Use ${SB.shortPath(data.lastCloneParent, 30)} again`;
  }

  async function chose(r) {
    if (!r?.ok) return;
    $('pjCloneWhere').textContent = SB.tildify(r.parent);
    const t = await api.cloneTarget(cloneRepo);
    const err = $('pjCloneError');
    err.hidden = !t?.error;
    err.textContent = t?.error || '';
    $('pjCloneDest').textContent = t?.dest ? `It will be cloned to ${t.dest}` : '';
    $('pjCloneGo').disabled = !t?.dest;
  }
  $('pjCloneChoose').addEventListener('click', async () => chose(await api.chooseCloneFolder()));
  $('pjCloneAgain').addEventListener('click', async () => chose(await api.cloneFolderAgain()));

  $('pjCloneGo').addEventListener('click', async () => {
    cloning = true;
    $('pjCloneGo').disabled = true;
    $('pjCloneChoose').disabled = true;
    $('pjCloneAgain').disabled = true;
    $('pjCloneProgress').hidden = false;
    $('pjCloneBar').style.width = '0%';
    $('pjCloneStatus').textContent = 'Cloning…';
    const r = await api.cloneProject(cloneRepo);
    cloning = false;
    $('pjCloneChoose').disabled = false;
    $('pjCloneAgain').disabled = false;
    $('pjCloneProgress').hidden = true;
    if (!r?.ok) {
      $('pjCloneStatus').textContent = '';
      if (r?.cancelled) return showScreen('detail');
      $('pjCloneError').hidden = false;
      $('pjCloneError').textContent = r?.error || 'The clone failed.';
      $('pjCloneGo').disabled = false;
      return;
    }
    SB.toast(`Cloned to ${r.root}`);
    await load({ refresh: true });
    showScreen('detail');
  });
  $('pjCloneCancel').addEventListener('click', () => {
    if (cloning) { api.cancelClone(); return; }
    showScreen(openKey ? 'detail' : 'list');
  });
  api.onCloneProgress(p => {
    if (!cloning || p.repo !== cloneRepo) return;
    $('pjCloneBar').style.width = `${p.percent}%`;
    $('pjCloneStatus').textContent = `${p.phase}: ${p.percent}%`;
  });

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
    for (const s of v.servers) if (isLive(s)) logs.delete(s.id);
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
    openCards.add(s.id);
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
