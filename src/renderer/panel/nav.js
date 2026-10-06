/* Shellby panel — navigation: the bottom bar and Settings gear, Back/Esc going
   up one level, Ctrl+1…6, the Ctrl+K "jump anywhere" palette, and the Settings
   tabs. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------ bar + gear

  SB.goBack = () => SB.setView(SB.PARENT_VIEW[state.view] || SB.homeView());

  const navButtons = [...document.querySelectorAll('[data-view-btn]')];
  // In bar order, which Work mode changes (workmode.js), so Ctrl+1… follow it.
  const dockButtons = () => [...document.querySelectorAll('.dock [data-view-btn]')];
  SB.retitleDock = () => dockButtons().forEach((b, i) => {
    b.title = `${b.textContent.trim()} (Ctrl+${i + 1})`;
    b.setAttribute('aria-keyshortcuts', `Control+${i + 1}`);
  });
  SB.retitleDock();

  for (const b of navButtons) {
    b.addEventListener('click', () => {
      const target = b.dataset.viewBtn;
      if (state.view !== target) return SB.setView(target);
      // Already here: back to the composer, or back to the top, rather than nothing.
      if (target === 'chat') return $('input').focus();
      document.querySelector(`.view-${target}`)?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    });
  }

  document.addEventListener('keydown', e => {
    if (state.view === 'onboarding' || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    // A dialog (share card, upsell, outfit code) owns the keyboard until it closes.
    if (document.querySelector('.card-sheet:not([hidden])')) return;
    if (e.key.toLowerCase() === 'k') { e.preventDefault(); return sheet.hidden ? openPalette() : closePalette(); }
    const n = Number(e.key);
    const b = dockButtons()[n - 1] || null;
    if (!b || getComputedStyle(b).display === 'none') return;
    e.preventDefault();
    closePalette();
    b.click();
  });

  // ------------------------------------------------------------ Settings tabs

  // Four tabs instead of one long page: the crab, Claude, the outside world, the
  // app itself. Settings reopens on the last tab you looked at; the first time,
  // Claude users start on Claude and just-the-crab users on Shellby.
  const settingsView = $('settingsView');
  const tabs = [...$('settingsTabs').querySelectorAll('[role="tab"]')];
  const allGroups = () => [...settingsView.querySelectorAll('.setting-group[data-nav]')];
  const tabOf = group => group.closest('.settings-panel')?.dataset.tab;
  let currentTab = null;

  function showTab(tab, { focus = false } = {}) {
    const changed = tab !== currentTab;
    currentTab = tab;
    for (const b of tabs) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of settingsView.querySelectorAll('.settings-panel')) p.hidden = p.dataset.tab !== tab;
    if (changed) settingsView.scrollTop = 0;
  }

  SB.showSettingsTab = tab => showTab(tab);
  // /model, /output-style: the setting itself, in view and focused.
  SB.showSetting = id => {
    const el = $(id);
    const group = el?.closest('.setting-group');
    if (!el || !group) return;
    SB.setView('settings');
    showTab(tabOf(group));
    if (group.tagName === 'DETAILS') group.open = true;
    requestAnimationFrame(() => { group.scrollIntoView({ block: 'center' }); el.focus(); });
  };

  // The extras fold to one line each. The line says On or Off, read from the
  // body each section already shows only while its feature is on.
  for (const fold of settingsView.querySelectorAll('.setting-fold[data-fold-on]')) {
    const body = $(fold.dataset.foldOn);
    const label = fold.querySelector('.fold-state');
    if (!body || !label) continue;
    const sync = () => {
      label.textContent = body.hidden ? 'Off' : 'On';
      label.classList.toggle('on', !body.hidden);
    };
    new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }
  for (const b of tabs) b.addEventListener('click', () => showTab(b.dataset.tab));
  // Arrow keys walk the tabs, the usual way for a tab list.
  $('settingsTabs').addEventListener('keydown', e => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    showTab(tabs[(next + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });

  // main.js points here by section name (the tray's update item, the "update
  // ready" notification), and the palette by section.
  SB.jumpToSettingByName = name => {
    const group = allGroups().find(g => g.dataset.nav === name);
    if (group) SB.jumpToSetting(group);
  };

  SB.jumpToSetting = group => {
    if (state.view !== 'settings') SB.setView('settings');
    showTab(tabOf(group));
    if (group.tagName === 'DETAILS') group.open = true;
    requestAnimationFrame(() => {
      group.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      // A brief glow says which section you were sent to.
      group.classList.remove('arrived');
      void group.offsetWidth;
      group.classList.add('arrived');
    });
  };
  settingsView.addEventListener('animationend', e => e.target.classList.remove('arrived'));

  const renderSettings = SB.views.settings.render;
  SB.views.settings.render = () => {
    renderSettings();
    if (!currentTab) showTab(SB.isCrabOnly() ? 'shellby' : 'claude');
  };

  // ------------------------------------------------------------ Ctrl+K palette

  const K = SB.shortcuts;
  const sheet = $('paletteSheet');
  const input = $('paletteInput');
  const list = $('paletteList');
  let results = [];
  let selected = 0;
  let returnFocus = null;

  const claude = () => !SB.isCrabOnly();

  // What you ran from here lately, newest first, so it comes back to the top.
  const RECENT_KEY = 'shellby.palette.recent';
  let recent = (() => { try { return K.noteRecent(JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]')); } catch { return []; } })();
  function remember(entry) {
    recent = K.noteRecent(recent, K.idOf(entry));
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* lasts this session */ }
  }

  // ---- this conversation: the actions its chips, menus and cards offer

  function actionEntries() {
    const tab = claude() && SB.activeTab();
    if (!tab) return [];
    const act = (id, icon, title, sub, run, shortcut = null, keys = '') => ({
      id: `act:${id}`, group: 'This conversation', icon, title, sub, shortcut, keys, run: () => SB.inChat(run),
    });
    const idle = tab.saved && !tab.busy;
    const w = tab.worktree;
    return [
      tab.busy && act('stop', '■', 'Stop', 'He stops where he is. Queued messages come back to the box', () => SB.stopTask(), 'stop', 'interrupt cancel halt'),
      idle && act('undo', '↶', 'Undo the last turn', 'Rewind to just before your last message: the conversation, the code, or both', () => SB.openRewind(tab, tab.lastTurnId), null, 'rewind revert back'),
      idle && act('rewind', '⟲', 'Rewind to an earlier message', 'Pick one; the conversation, the code, or both go back to then', () => SB.openRewind(tab), 'rewind', 'undo revert back'),
      idle && act('tryAgain', '⑂', 'Try it another way', 'Your last message again in a new tab, changed or as it was. This one stays as it is', () => SB.tryAgain(tab), 'tryAgain', 'branch fork retry redo again'),
      idle && tab.lastTurnId && act('branch', '⑂', 'Branch from the last reply', 'A new tab that carries on from here, with its own copy of the files', () => SB.openBranch(tab, tab.lastTurnId, 'after'), null, 'fork'),
      SB.hasChanges(tab) && act('changes', '±', 'Show the last turn’s changes', 'Every file it touched, each diff a key away, and Undo', () => SB.showChanges(tab), 'showChanges', 'diff files changed undo review'),
      w && act('home', '↩', 'Bring it home', `Commit what’s left and merge into ${w.base}. The conversation carries on`, () => SB.bringHome(tab), 'bringHome', 'merge worktree copy branch'),
      w && act('homePush', '⇡', 'Bring it home and push', `Merge into ${w.base}, then push it to its remote`, () => SB.bringHome(tab, { push: true }), null, 'merge worktree copy branch push'),
      idle && act('compact', '⇣', 'Compact', 'Claude sums up the conversation so far and carries on in the room it frees', () => SB.compactTab(tab), null, 'context full crowded summarise summarize'),
      idle && act('fresh', '↻', 'Start fresh with a summary', 'Claude writes a handoff note, then a new conversation picks it up in this tab', () => SB.startFresh(tab), null, 'context handoff new summary compact'),
      (tab.saved || !tab.isEmpty) && act('close', '×', 'Close this conversation', tab.saved ? 'It stays in History' : 'Nothing’s been sent yet', () => SB.closeTabSafely(tab.id), 'closeTab', 'tab'),
    ].filter(Boolean);
  }

  // ---- this conversation's project: its folder and its dev server (projects.js)

  const PROJECTS_STALE_MS = 30000;
  let projects = null;  // { at, list, servers }
  async function loadProjects() {
    if (!claude()) return;
    const fresh = projects && Date.now() - projects.at < PROJECTS_STALE_MS;
    try {
      const [list, servers] = await Promise.all([fresh ? projects.list : api.listProjects(), api.getServers()]);
      projects = { at: fresh ? projects.at : Date.now(), list, servers };
    } catch { return; } // no project actions this time; the rest of the palette is unaffected
    if (!sheet.hidden) update({ keep: true });
  }

  function projectEntries() {
    const tab = claude() && SB.activeTab();
    const where = tab ? tab.worktree?.originalCwd || tab.cwd || state.cwd : null;
    const found = where && K.cloneFor(projects?.list?.projects, where);
    if (!found) return [];
    const { project: p, clone: c } = found;
    const mine = (projects.servers?.servers || []).filter(s => s.root.toLowerCase() === c.root.toLowerCase() && (s.status === 'starting' || s.status === 'up'));
    const entry = (id, icon, title, sub, run, keys = '') => ({ id: `pj:${id}`, group: 'Project', icon, title, sub, keys: `project ${p.name} ${keys}`, run });
    const script = c.scripts?.find(s => s.name === c.lastScript) || c.scripts?.find(s => s.likely);
    const servers = mine.flatMap(s => [
      s.status === 'up' && s.url && entry(`open:${s.script}`, '▶', `Open ${s.script} in the browser`, `${p.name} · ${s.port ? `:${s.port}` : s.url}`, () => api.openServer(s.id), 'dev server localhost port'),
      entry(`stop:${s.script}`, '■', `Stop ${s.manager} run ${s.script}`, `${p.name} · ${s.status === 'up' ? 'running' : 'starting'}`, async () => {
        const r = await api.stopServer(s.id);
        SB.toast(r?.ok === false ? r.error || "Couldn't stop it." : `Stopped ${s.script} in ${p.name}.`);
      }, 'dev server kill'),
    ]);
    return [
      ...servers.filter(Boolean),
      !mine.some(s => s.kind === 'server') && script && c.installed !== false && entry('start', '▶', 'Start the dev server', `${c.manager} run ${script.name} in ${p.name}`, async () => {
        const r = await api.startServer({ root: c.root, script: script.name });
        SB.toast(r?.ok ? `Starting ${c.manager} run ${script.name} in ${p.name}…` : r?.error || "Couldn't start it.");
      }, `dev server run ${script.name} npm vite next localhost`),
      entry('folder', '📂', 'Open the project folder', SB.shortPath(c.root, 40), () => api.openProjectFolder(c.root), 'explorer files directory'),
    ].filter(Boolean);
  }

  // ---- Claude: model and effort (permission modes are their own group)

  function claudeEntries() {
    if (!claude()) return [];
    const effort = state.settings.effort || '';
    return [
      { id: 'claude:model', group: 'Claude', icon: '◆', title: 'Change the model', sub: 'For new conversations (/model)', keys: 'model opus sonnet haiku', run: () => SB.showSetting('modelSelect') },
      ...(SB.EFFORTS || []).map(x => ({
        id: `claude:effort:${x.id}`, group: 'Claude', icon: effort === x.id ? '●' : '○', title: `Effort: ${x.title}`, sub: x.sub,
        keys: 'effort thinking think how hard', run: () => SB.chooseEffort(x.id),
      })),
    ];
  }

  function routineEntries() {
    if (!claude()) return [];
    return (state.routines || []).filter(r => !r.running).map(r => ({
      id: `routine:${r.id}`, group: 'Routines', icon: '⏰', title: `Run “${r.name}” now`, sub: r.scheduleText || '', keys: 'routine run now schedule',
      run: async () => {
        const res = await api.runRoutine(r.id);
        SB.toast(res?.ok ? `Started "${r.name}"` : res?.error || "Couldn't start it.");
        if (res?.ok) SB.setView('chat');
      },
    }));
  }

  // Your saved prompts, put in the box (not sent) to add to.
  function snippetEntries() {
    if (!claude()) return [];
    return (state.snippets || []).map(s => ({
      id: `snippet:${s.name}`, group: 'Snippets', icon: '/', title: `/${s.name}`, sub: `Put it in the box${s.summary ? ` · ${s.summary}` : ''}`,
      keys: 'snippet insert prompt saved', run: () => SB.prefill(`/${s.name} `),
    }));
  }

  function screenEntries() {
    const go = view => () => SB.setView(view);
    return [
      { icon: '🎩', title: 'Shellby: outfits', sub: 'Dress him up', keys: 'crab wardrobe hats skins colors effects packs', run: go('wardrobe') },
      { icon: '🏆', title: 'Shellby: trophies & XP', sub: 'Level, XP and trophies', keys: 'level achievements', run: go('trophies') },
      { icon: '🐚', title: 'Shellby: finds', sub: 'Everything he’s dug up for you', keys: 'gifts shelf treasure dig collection sets', run: go('finds') },
      claude() && { icon: '🫙', title: 'Shellby: Bugdex', sub: 'Every kind of bug Claude has fixed for you', keys: 'bugdex bugs errors caught collection dex', run: go('bugdex') },
      { icon: '💞', title: 'Shellby: us', sub: 'How close you are, your story, games, your birthday', keys: 'bond friendship memories journal birthday temperament scenes', run: go('us') },
      { icon: '🪸', title: 'Shellby: tank', sub: 'Decorate his tank with castles, plants and his finds', keys: 'tank aquarium home decorate decor castle plants treasure chest room furniture', run: go('tank') },
      { icon: '🏖️', title: 'Shellby: beach', sub: 'A sandcastle for every project you’ve shipped', keys: 'beach sandcastle castles shipped projects tide streak snapshot share', run: go('beach') },
      { icon: '🙈', title: 'Play hide and seek', sub: 'He hides behind your windows', keys: 'game play hide seek', run: () => SB.play('hide') },
      { icon: '🎾', title: 'Play fetch', sub: 'Throw him a pebble', keys: 'game play fetch ball throw', run: () => SB.play('fetch') },
      claude() && (SB.isWorkMode?.()
        ? { icon: '🦀', title: 'Leave Work mode', sub: 'Everything back as it was', keys: 'work mode off crab pet lively', run: () => SB.setWorkMode(false) }
        : { icon: '🛠️', title: 'Work mode', sub: 'The tools up front, and a quiet crab', keys: 'work mode quiet calm developer tools focus', run: () => SB.setWorkMode(true) }),
      claude() && { icon: '💬', title: 'Chat', sub: 'Give Shellby a task', keys: 'home task conversation', run: go('chat') },
      claude() && { icon: '➕', title: 'New conversation', sub: 'A fresh tab, in the usual folder', keys: 'tab chat', shortcut: 'newTab', run: () => { SB.setView('chat'); SB.newTab(); } },
      claude() && { icon: '🧰', title: 'Toolbox', sub: 'Skills, agents, commands, MCP servers, mods, hooks and memory', keys: 'tools mcp mods plugins hooks memory claude.md', run: go('toolbox') },
      claude() && { icon: '🛒', title: 'Skill Shop', sub: 'Install skills from plugin marketplaces', keys: 'get more plugins install marketplace', run: () => SB.openShop() },
      claude() && { icon: '⚡', title: 'Workflows', sub: 'Triggers that start a list of steps', keys: 'automate automation flow trigger steps webhook', run: go('workflows') },
      claude() && { icon: '⚡', title: 'New workflow', sub: 'Build one step by step', keys: 'automate add create flow trigger', run: () => SB.workflows.create() },
      claude() && { icon: '⚡', title: 'Describe a workflow', sub: 'Say what should happen and Claude drafts it', keys: 'automate draft write claude flow', run: () => SB.workflows.describe() },
      claude() && { icon: '⏰', title: 'Routines', sub: 'Tasks that run on a schedule', keys: 'automate schedule recurring cron', run: go('routines') },
      claude() && { icon: '⏰', title: 'New routine', sub: 'Schedule a recurring task', keys: 'schedule add', run: () => { SB.setView('routines'); $('newRoutineBtn').click(); } },
      { icon: '📈', title: 'Health', sub: 'Temperatures, memory and drives', keys: 'gpu cpu ram disk temperature vitals', run: go('health') },
      claude() && { icon: '🗂️', title: 'History', sub: 'Past conversations', keys: 'sessions old', run: go('history') },
      { icon: '⏱️', title: 'Time', sub: 'Hours on each project, your streak, focus sessions and timesheets', keys: 'time tracking hours timesheet invoice billing clients rate freelance streak nudge quiet focus pomodoro', run: go('time') },
      claude() && { icon: '📁', title: 'Projects', sub: 'Your repos and their dev servers', keys: 'projects repos repositories github clone dev server vite next npm run localhost port', run: go('projects') },
      { icon: '⚙️', title: 'Settings', sub: 'Everything else', keys: 'preferences options', run: go('settings') },
      { icon: '⌨️', title: 'Keyboard shortcuts', sub: 'Every key, in one list', keys: 'keys keyboard hotkeys cheat sheet help', shortcut: 'shortcuts', run: () => SB.openShortcuts() },
      SB.hasLockedRooms?.() && { icon: '🚪', title: 'Show every screen', sub: 'Put all of them on the bar now', keys: 'rooms unlock more dock bar all screens', run: () => SB.openAllRooms() },
    ].filter(Boolean).map(e => ({ ...e, group: 'Screens' }));
  }

  // Every section, whichever tab it's on: the palette is how you find one without
  // knowing where it lives.
  function settingEntries() {
    return allGroups().filter(g => !g.hidden).map(g => {
      const heading = g.querySelector('h3')?.textContent || '';
      const tab = tabs.find(b => b.dataset.tab === tabOf(g))?.textContent.trim() || '';
      return {
        group: 'Settings', icon: '⚙️', title: `Settings › ${g.dataset.nav}`,
        sub: [tab, heading.toLowerCase() === g.dataset.nav.toLowerCase() ? '' : heading].filter(Boolean).join(' · '),
        keys: g.textContent.slice(0, 400), run: () => SB.jumpToSetting(g),
      };
    });
  }

  function modeEntries() {
    if (!claude()) return [];
    return SB.MODES.map(m => ({
      group: 'Permission mode', icon: state.settings.mode === m.id ? '●' : '○', title: `Mode: ${m.title}`, sub: m.sub,
      keys: 'permission mode shift+tab', run: () => SB.chooseMode(m.id),
    }));
  }

  function toolEntries() {
    const tb = state.toolbox;
    if (!claude() || !tb) return [];
    const seen = new Set();
    return [...tb.skills.map(t => ({ ...t, kind: 'skill' })), ...tb.commands.map(t => ({ ...t, kind: 'command' }))]
      .filter(t => !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))
      .map(t => ({
        group: t.kind === 'skill' ? 'Skills' : 'Commands', icon: '/', title: `/${t.name}`, sub: t.description || '', keys: t.kind,
        run: () => {
          SB.setView('chat');
          const box = $('input');
          box.value = `/${t.name} `;
          box.dispatchEvent(new Event('input'));
          box.focus();
        },
      }));
  }

  function conversationEntries() {
    if (!claude()) return [];
    return (state.sessions || []).map(s => ({
      group: 'Conversations', icon: '💬', title: s.title, sub: `${SB.relTime(s.updatedAt)} · ${SB.shortPath(s.cwd, 30)}${s.done ? ' · done' : ''}`, keys: s.cwd || '',
      run: async () => { SB.setView('chat'); await SB.openHistory(s.id); },
    }));
  }

  // The open conversation: carrying it on in a terminal, and reordering the tab
  // strip without a pointer (the drag gesture's keyboard twin, and the only way
  // there is for anyone who can't drag).
  function tabEntries() {
    const tab = state.tabs.get(state.activeTab);
    if (!claude() || !tab) return [];
    // To a terminal and back (handoff.js), once there's a conversation to carry on.
    const handoff = !tab.saved ? [] : [tab.inTerminal
      ? { group: 'Conversations', icon: '↩', title: 'Pick this conversation up here', sub: `${tab.title} · back from the terminal`, keys: 'terminal handoff resume back return', run: () => { SB.setView('chat'); SB.pickUpHere(tab.id); } }
      : { group: 'Conversations', icon: '›_', title: 'Continue this conversation in a terminal', sub: `${tab.title} · Windows Terminal, claude --resume`, keys: 'terminal handoff resume cli console powershell wt', run: () => SB.continueInTerminal(tab.id) }];
    if (state.tabs.size < 2) return handoff;
    const here = tab.title;
    return [...handoff, ...[[-1, 'left', 'PageUp'], [1, 'right', 'PageDown']].map(([step, where, key]) => ({
      group: 'Conversations', icon: step < 0 ? '⬅️' : '➡️',
      title: `Move this conversation ${where}`, sub: `${here} · Ctrl+Shift+${key}`,
      keys: 'tab strip reorder order move drag position',
      run: () => { SB.setView('chat'); SB.nudgeTab(state.activeTab, step); },
    }))];
  }

  // Ranking lives in shortcuts.js (tested there): the best match first, then
  // what you ran lately, then the group's place here.
  const GROUP_RANK = {
    'This conversation': 0, Screens: 1, Focus: 2, Project: 3, Claude: 4, Settings: 5, 'Permission mode': 6,
    Routines: 7, Snippets: 8, Conversations: 9, Skills: 10, Commands: 11,
  };
  const focusEntries = () => (SB.focusCommands?.() || []).map(e => ({ ...e, group: 'Focus' }));

  // With nothing typed: this conversation's actions on the chat screen, what you
  // ran lately, then every screen and setting to browse.
  function search(raw) {
    const actions = actionEntries();
    const screens = screenEntries();
    const settings = settingEntries();
    const all = [...actions, ...screens, ...focusEntries(), ...projectEntries(), ...claudeEntries(), ...settings, ...modeEntries(),
      ...routineEntries(), ...snippetEntries(), ...tabEntries(), ...conversationEntries(), ...toolEntries()];
    return K.rank(all, raw, {
      recent, groupRank: GROUP_RANK,
      pinned: state.view === 'chat' ? actions : [],
      browse: [...screens, ...settings],
    });
  }

  function renderPalette() {
    const grouped = !input.value.trim();
    const rows = [];
    let lastGroup = null;
    results.forEach((r, i) => {
      if (grouped && r.group !== lastGroup) { rows.push(h('li', { class: 'pal-group', role: 'presentation', text: r.group })); lastGroup = r.group; }
      rows.push(h('li', {
        class: 'pal-item', role: 'option', id: `pal-${i}`, 'aria-selected': String(i === selected),
        onmousemove: () => { if (selected !== i) { selected = i; paintSelection(); } },
        onmousedown: e => { e.preventDefault(); runAt(i); },
      },
      h('span', { class: 'pal-icon', 'aria-hidden': 'true', text: r.icon }),
      h('span', { class: 'pal-text' }, h('span', { class: 'pal-title', text: r.title }), r.sub ? h('span', { class: 'pal-sub', text: r.sub }) : null),
      // Its shortcut if it has one (the next time, no palette needed); else, in a search, where it lives.
      r.shortcut ? h('kbd', { class: 'pal-kbd', text: K.primary(r.shortcut), title: K.label(r.shortcut) })
        : grouped ? null : h('span', { class: 'pal-key', text: r.group })));
    });
    if (!results.length) rows.push(h('li', { class: 'pal-empty', role: 'presentation', text: `Nothing matches "${input.value.trim()}".` }));
    list.replaceChildren(...rows);
    paintSelection();
  }

  function paintSelection() {
    for (const li of list.querySelectorAll('.pal-item')) li.setAttribute('aria-selected', String(li.id === `pal-${selected}`));
    const active = $(`pal-${selected}`);
    if (active) { input.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }

  // keep: the same entry stays chosen (the project actions arriving late shouldn't move you).
  function update({ keep = false } = {}) {
    const was = keep ? results[selected] && K.idOf(results[selected]) : null;
    results = search(input.value);
    const at = was ? results.findIndex(r => K.idOf(r) === was) : -1;
    selected = at >= 0 ? at : 0;
    renderPalette();
  }

  function runAt(i) {
    const r = results[i];
    if (!r) return;
    closePalette({ restoreFocus: false });
    remember(r);
    r.run();
    requestAnimationFrame(landFocus);
  }

  // Chat gets its composer back; other screens get focus on their heading, so
  // the keyboard isn't left stranded on the page. Anything that took focus
  // itself (a menu, a diff, a dialog) keeps it.
  function landFocus() {
    if (document.activeElement && document.activeElement !== document.body) return;
    if (state.view === 'chat') return $('input').focus({ preventScroll: true });
    const heading = document.querySelector(`.view-${state.view} h2`);
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }

  function openPalette() {
    if (state.view === 'onboarding') return;
    SB.closeMenus();
    returnFocus = document.activeElement;
    sheet.hidden = false;
    input.value = '';
    update();
    input.focus();
    loadProjects();
  }

  function closePalette({ restoreFocus = true } = {}) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  SB.openPalette = openPalette;

  input.addEventListener('input', update);
  input.addEventListener('keydown', e => {
    // Keep these away from the chat shortcuts in tabs.js (Esc there would hide the panel).
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closePalette(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      return paintSelection();
    }
    if (e.key === 'Enter') { e.preventDefault(); return runAt(selected); }
    if (e.key === 'Tab') e.preventDefault(); // the input is the only stop in the dialog
    if (!(e.ctrlKey && /^[k1-6/]$/i.test(e.key))) e.stopPropagation();
  });
  sheet.addEventListener('mousedown', e => { if (e.target === sheet) closePalette(); });
  $('paletteBtn').addEventListener('click', openPalette);

  // ------------------------------------------------------------ Ctrl+/ every shortcut

  // Drawn from the same table the palette and the handlers read (shortcuts.js).
  // A dialog like the share card: a11y.js keeps Tab inside it and hands focus
  // back to whatever had it when it closes.
  const keysSheet = $('shortcutsSheet');
  const keysList = $('shortcutsList');

  function renderShortcuts() {
    keysList.replaceChildren(...K.grouped().map(({ group, items }) => h('section', { class: 'keys-group' },
      h('h3', { text: group }),
      h('dl', {}, ...items.flatMap(s => [
        h('dt', {}, ...s.keys.flatMap((k, i) => [i ? h('span', { class: 'keys-or', text: s.keys.length > 2 ? ' ' : ' or ' }) : null, h('kbd', { text: k })]).filter(Boolean)),
        h('dd', { text: s.what }),
      ])))));
  }

  let keysBack = null; // what had the keyboard before, unless that was the palette
  SB.openShortcuts = () => {
    if (state.view === 'onboarding') return;
    const from = sheet.hidden ? document.activeElement : returnFocus;
    keysBack = from && from !== document.body && !from.closest('.palette-sheet, .card-sheet') ? from : null;
    closePalette({ restoreFocus: false });
    SB.closeMenus();
    renderShortcuts();
    keysSheet.hidden = false;
    keysList.scrollTop = 0;
    keysList.focus(); // the list scrolls with the arrow keys
  };
  function closeShortcuts() {
    if (keysSheet.hidden) return;
    keysSheet.hidden = true;
    if (keysBack?.isConnected && keysBack.getClientRects().length) keysBack.focus({ preventScroll: true });
    else { document.activeElement?.blur(); landFocus(); }
    keysBack = null;
  }
  $('shortcutsClose').addEventListener('click', closeShortcuts);
  keysSheet.addEventListener('mousedown', e => { if (e.target === keysSheet) closeShortcuts(); });
  keysSheet.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeShortcuts(); }
  });

  // Ctrl+/ anywhere toggles it; ? does too while you're not typing.
  const typing = el => !!el?.closest?.('textarea, input, select, [contenteditable="true"]');
  document.addEventListener('keydown', e => {
    if (state.view === 'onboarding' || !K.matches(e, 'shortcuts')) return;
    if (e.key === '?' && typing(e.target)) return;
    const open = !keysSheet.hidden;
    // Another dialog (share card, upsell) keeps the keyboard until it closes.
    if (!open && document.querySelector('.card-sheet:not([hidden])')) return;
    e.preventDefault();
    if (open) closeShortcuts(); else SB.openShortcuts();
  });
})();
