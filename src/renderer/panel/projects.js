/* Shellby panel — Projects: your repositories (on this PC and on GitHub) and
   the dev servers in them (src/main/projects/, src/main/devservers/). Main
   works everything out; this draws it and sends back what you click.

   Nothing goes to Claude from here without the approval sheet on a crashed
   server's card: it shows the exact prompt, and only its Send button sends. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  let data = null;            // projects:list
  let servers = null;         // servers:get, kept live by servers:changed
  let filter = 'all';
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

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
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

  let loadSeq = 0;
  async function load({ refresh = false } = {}) {
    const seq = ++loadSeq;
    const [list, srv] = await Promise.all([api.listProjects({ refresh }), api.getServers()]);
    if (seq !== loadSeq || !list) return;
    data = list;
    servers = srv || servers;
    renderQuit();
    renderList();
    if (openKey) await openProject(openKey, { quiet: true });
  }

  const serversIn = root => (servers?.servers || []).filter(s => s.root.toLowerCase() === root.toLowerCase());

  // ------------------------------------------------------------------ the list

  function renderList() {
    if (!data) return;
    const q = $('pjSearch').value.trim().toLowerCase();
    const shown = data.projects.filter(p => {
      if (q && !`${p.name} ${p.github?.repo || ''}`.toLowerCase().includes(q)) return false;
      if (filter === 'local') return p.local.length > 0;
      if (filter === 'github') return !p.local.length;
      if (filter === 'running') return p.local.some(c => serversIn(c.root).some(isLive));
      return !p.github?.archived || q;
    });
    $('pjProjects').replaceChildren(...shown.map(projectRow));
    const empty = $('pjEmpty');
    empty.hidden = shown.length > 0;
    empty.textContent = !data.projects.length
      ? "No projects yet. Shellby lists the ones he's seen you work in. Add a repo, or scan a folder you keep them in."
      : filter === 'running' ? 'Nothing running right now.' : 'Nothing matches.';
    renderGitHubNote();
  }

  function projectRow(p) {
    const live = p.local.flatMap(c => serversIn(c.root)).filter(isLive);
    const down = p.local.flatMap(c => serversIn(c.root)).filter(s => s.status === 'crashed');
    const where = p.local[0] ? SB.shortPath(p.local[0].root, 40) : 'Not on this PC';
    return h('li', {},
      h('button', { type: 'button', class: 'pj-row', onclick: () => openProject(p.key) },
        h('span', { class: 'pj-row-main' },
          h('span', { class: 'pj-row-name' },
            h('b', { text: p.name }),
            p.github?.private && h('span', { class: 'pj-tag', text: 'private' }),
            p.github?.fork && h('span', { class: 'pj-tag', text: 'fork' }),
            p.github?.archived && h('span', { class: 'pj-tag', text: 'archived' }),
            p.local.length > 1 && h('span', { class: 'pj-tag', text: `${p.local.length} clones` })),
          h('span', { class: `pj-row-where${p.local.length ? '' : ' off'}`, text: p.github && p.local.length ? `${where} · ${p.github.repo}` : where })),
        down.length ? h('span', { class: 'pj-pill down', text: down.length > 1 ? `${down.length} down` : 'down' })
          : live.length ? h('span', { class: 'pj-pill up', text: live.length === 1 && live[0].port ? `:${live[0].port}` : `${live.length} up` }) : null));
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
    // On the page only while something runs: that's when it matters.
    $('pjQuit').hidden = !servers.running;
    $('pjStopAll').textContent = servers.running > 1 ? `Stop all ${servers.running} now` : 'Stop it now';
    for (const name of ['pjOnQuit', 'setOnQuit']) {
      for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.checked = r.value === onQuit;
    }
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
  for (const name of ['pjOnQuit', 'setOnQuit']) {
    for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener('change', () => r.checked && setServerSettings({ onQuit: r.value, quitNoteSeen: true }));
  }
  $('srvCrabToggle').addEventListener('change', e => setServerSettings({ crab: e.target.checked }));
  $('srvSignToggle').addEventListener('change', e => setServerSettings({ sign: e.target.checked }));
  $('srvToastToggle').addEventListener('change', e => setServerSettings({ toast: e.target.checked }));
  $('pjStopAll').addEventListener('click', async () => { servers = await api.stopAllServers() || servers; renderQuit(); renderAll(); });

  // ------------------------------------------------------------------ one project

  async function openProject(key, { quiet = false } = {}) {
    const p = await api.projectDetail(key);
    if (!p) { if (!quiet) SB.toast("That project isn't on the list any more."); return closeProject(); }
    openKey = key;
    detail = p;
    showScreen('detail');
    renderDetail();
  }

  function closeProject() {
    openKey = null;
    detail = null;
    showScreen('list');
    renderList();
  }

  function showScreen(which) {
    $('pjListScreen').hidden = which !== 'list';
    $('pjDetailScreen').hidden = which !== 'detail';
    $('pjScanSheet').hidden = which !== 'scan';
    $('pjCloneSheet').hidden = which !== 'clone';
    $('pjRefresh').hidden = which === 'scan' || which === 'clone';
  }

  function renderDetail() {
    const p = detail;
    if (!p) return;
    const head = h('div', { class: 'pj-detail-head' },
      h('button', { type: 'button', class: 'btn ghost slim-btn', text: '← Projects', onclick: closeProject }),
      h('h3', { class: 'pj-detail-name', text: p.name }),
      p.github && h('button', { type: 'button', class: 'link-btn pj-repo', text: p.github.repo, onclick: () => api.openProjectOnGitHub(p.github.repo) }),
      p.github?.description && h('p', { class: 'muted small', text: p.github.description }));
    const clones = p.local.length
      ? p.local.map(cloneSection)
      : [h('section', { class: 'pj-clone' },
        h('p', { class: 'muted', text: 'Not on this PC.' }),
        h('button', { type: 'button', class: 'btn primary slim-btn', text: 'Clone…', onclick: () => openClone(p.github.repo) }))];
    const foot = h('div', { class: 'row wrap pj-detail-foot' },
      h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Remove from Projects', onclick: () => removeProject(p) }));
    $('pjDetailScreen').replaceChildren(head, ...clones, foot);
  }

  function cloneSection(c) {
    const git = c.git;
    const facts = [
      c.branch && `on ${c.branch}`,
      git && (git.dirty ? plural(git.dirty, 'uncommitted change') : 'nothing uncommitted'),
      git?.unpushed && `${git.unpushed} unpushed`,
      git?.copies?.length && plural(git.copies.length, 'Shellby copy').replace('copys', 'copies'),
    ].filter(Boolean).join(' · ');
    return h('section', { class: 'pj-clone', dataset: { root: c.root } },
      h('div', { class: 'pj-clone-head' },
        h('code', { class: 'path', text: SB.shortPath(c.root, 46), title: c.root }),
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open folder', onclick: () => api.openProjectFolder(c.root) }),
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'New conversation here', onclick: () => SB.newTabIn({ cwd: c.root }) })),
      facts && h('p', { class: 'muted small pj-facts', text: facts }),
      serversSection(c));
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
    if (more.length) box.append(h('details', { class: 'pj-more' }, h('summary', { text: `More scripts (${more.length})` }), h('ul', { class: 'pj-scripts' }, rowsFor(more))));
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
  for (const b of $('pjFilter').querySelectorAll('[role="tab"]')) {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      for (const x of $('pjFilter').querySelectorAll('[role="tab"]')) x.setAttribute('aria-selected', String(x === b));
      renderList();
    });
  }
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
