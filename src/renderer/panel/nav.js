/* Shellby panel — navigation: the bottom bar and Settings gear, Back/Esc going
   up one level, Ctrl+1…8, the Ctrl+K "jump anywhere" palette, and the Settings
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
    if (SB.solo || state.view === 'onboarding' || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
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

  // Five tabs instead of one long page, each named for what it changes: the crab,
  // what he does around your PC, Claude, the outside world, the app itself.
  // Settings reopens on the last tab you looked at; the first time, Claude users
  // start on Claude and just-the-crab users on Shellby.
  const settingsView = $('settingsView');
  const tabBar = $('settingsTabs');
  const tabs = [...tabBar.querySelectorAll('[role="tab"]')];
  const allGroups = () => [...settingsView.querySelectorAll('.setting-group[data-nav]')];
  const tabOf = group => group.closest('.settings-panel')?.dataset.tab;
  const tabIndex = tab => tabs.findIndex(b => b.dataset.tab === tab);
  let currentTab = null;

  // The highlight under the chosen tab slides to the next one. The tabs are as
  // wide as their names, so it's measured, not worked out from the count.
  function placeInk() {
    const b = tabs[tabIndex(currentTab)];
    if (!b || !b.offsetWidth) return;
    tabBar.style.setProperty('--ink-x', `${b.offsetLeft}px`);
    tabBar.style.setProperty('--ink-w', `${b.offsetWidth}px`);
    // ::before only transitions once has-ink is on, so the first placement lands
    // in place instead of sliding in from the left edge.
    if (!tabBar.classList.contains('has-ink')) {
      void tabBar.offsetWidth;
      tabBar.classList.add('has-ink');
    }
  }
  new ResizeObserver(placeInk).observe(tabBar);
  document.fonts.ready.then(placeInk);

  function showTab(tab, { focus = false } = {}) {
    const changed = tab !== currentTab;
    // The new tab's page comes in from the side its tab is on.
    if (changed && currentTab) settingsView.dataset.dir = tabIndex(tab) > tabIndex(currentTab) ? 'next' : 'prev';
    currentTab = tab;
    for (const b of tabs) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of settingsView.querySelectorAll('.settings-panel')) p.hidden = p.dataset.tab !== tab;
    if (changed) settingsView.scrollTop = 0;
    placeInk();
  }

  SB.showSettingsTab = tab => showTab(tab);
  SB.settingsTab = () => currentTab;
  // /model, /output-style: the setting itself, in view and focused.
  SB.showSetting = id => {
    const el = $(id);
    const group = el?.closest('.setting-group');
    if (!el || !group) return;
    SB.setView('settings');
    showTab(tabOf(group));
    if (group.tagName === 'DETAILS') group.open = true;
    placeInk(); // opening it can bring in a scrollbar and shift the tabs
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
  // A setting that talks about one on another tab links straight to it.
  settingsView.addEventListener('click', e => {
    const link = e.target.closest('[data-jump-setting]');
    if (link) SB.showSetting(link.dataset.jumpSetting);
  });
  // Arrow keys walk the tabs, the usual way for a tab list.
  tabBar.addEventListener('keydown', e => {
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
    placeInk(); // opening it can bring in a scrollbar and shift the tabs
    requestAnimationFrame(() => {
      group.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      // A brief glow says which section you were sent to.
      group.classList.remove('arrived');
      void group.offsetWidth;
      group.classList.add('arrived');
    });
  };
  settingsView.addEventListener('animationend', e => {
    e.target.classList.remove('arrived');
    // The slide is for a tab change only: coming back to Settings just fades in.
    if (e.target.classList.contains('settings-panel')) delete settingsView.dataset.dir;
  });

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
      idle && act('clear', '⌫', 'Clear', 'A new conversation in this tab, with nothing carried over (/clear)', () => SB.clearConversation(tab), null, 'clear reset new context forget wipe'),
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
    const effort = SB.activeTab()?.effort ?? (state.settings.effort || '');
    const pick = !state.settings.effort && state.settings.effortPick !== false;
    return [
      { id: 'claude:model', group: 'Claude', icon: '◆', title: 'Change the model', sub: 'For new conversations (/model)', keys: 'model opus sonnet haiku', run: () => SB.showSetting('modelSelect') },
      ...(SB.EFFORTS || []).map(x => ({
        id: `claude:effort:${x.id}`, group: 'Claude', icon: effort === x.id ? '●' : '○', title: `Effort: ${x.title}`, sub: x.sub,
        keys: 'effort thinking think how hard', run: () => SB.chooseEffort(x.id),
      })),
      { id: 'claude:effort-pick', group: 'Claude', icon: pick ? '✓' : '○', title: 'Effort: pick to fit each new conversation', sub: pick ? 'On: from its first message' : 'Off',
        keys: 'effort thinking auto pick fit context', run: () => SB.chooseNewEffort(!pick) },
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
      claude() && { icon: '🦀', title: 'Shellby: crew', sub: 'Your helper agents, each a crab with a level and a record', keys: 'crew helpers subagents agents party roster level hats code-reviewer explore', run: go('crew') },
      claude() && { icon: '🏛️', title: 'Shellby: council', sub: 'Advisor crabs argue a decision out, and he rules on it', keys: 'council advisors debate decide decision opinions verdict vote board panel second opinion', run: go('council') },
      { icon: '🐚', title: 'Shellby: finds', sub: 'Everything he’s dug up for you', keys: 'gifts shelf treasure dig collection sets', run: go('finds') },
      claude() && { icon: '🫙', title: 'Shellby: Bugdex', sub: 'Every kind of bug Claude has fixed for you', keys: 'bugdex bugs errors caught collection dex', run: go('bugdex') },
      { icon: '💞', title: 'Shellby: us', sub: 'How close you are, your story, games, your birthday', keys: 'bond friendship memories journal birthday temperament scenes', run: go('us') },
      { icon: '🪸', title: 'Shellby: tank', sub: 'Decorate his tank with castles, plants and his finds', keys: 'tank aquarium home decorate decor castle plants treasure chest room furniture', run: go('tank') },
      { icon: '🏖️', title: 'Shellby: beach', sub: 'A sandcastle for every project you’ve shipped', keys: 'beach sandcastle castles shipped projects tide streak snapshot share', run: go('beach') },
      { icon: '🙈', title: 'Play hide and seek', sub: 'He hides behind your windows', keys: 'game play hide seek', run: () => SB.play('hide') },
      { icon: '🎾', title: 'Play fetch', sub: 'Throw him a pebble', keys: 'game play fetch ball throw', run: () => SB.play('fetch') },
      claude() && SB.isWorkMode?.() && { icon: '🦀', title: 'Leave Work mode', sub: 'Everything back as it was', keys: 'work mode off crab pet lively switch', run: () => SB.switchMode('claude') },
      ...SB.APP_MODES.filter(m => m.id !== SB.modeNow() && !(m.id === 'claude' && SB.isWorkMode())).map(m => ({
        icon: m.icon, title: `Mode: ${m.title}`, sub: m.sub, keys: `mode switch change ${m.id} work quiet calm developer tools focus crab pet lively claude`, run: () => SB.switchMode(m.id),
      })),
      claude() && { icon: '💬', title: 'Chat', sub: 'Give Shellby a task', keys: 'home task conversation', run: go('chat') },
      claude() && { icon: '➕', title: 'New conversation', sub: 'A fresh tab, in the usual folder', keys: 'tab chat', shortcut: 'newTab', run: () => { SB.setView('chat'); SB.newTab(); } },
      claude() && { icon: '🧰', title: 'Toolbox', sub: 'Skills, agents, commands, MCP servers, mods, hooks and memory', keys: 'tools mcp mods plugins hooks memory claude.md', run: go('toolbox') },
      claude() && { icon: '🛒', title: 'Skill Shop', sub: 'Install skills from plugin marketplaces', keys: 'get more plugins install marketplace', run: () => SB.openShop() },
      claude() && { icon: '⚡', title: 'Workflows', sub: 'Triggers that start a list of steps', keys: 'automate automation flow trigger steps webhook', run: go('workflows') },
      claude() && { icon: '⚡', title: 'New workflow', sub: 'Build one step by step', keys: 'automate add create flow trigger', run: () => SB.workflows.create() },
      claude() && { icon: '⚡', title: 'Describe a workflow', sub: 'Say what should happen and Claude drafts it', keys: 'automate draft write claude flow', run: () => SB.workflows.describe() },
      claude() && { icon: '⏰', title: 'Routines', sub: 'Tasks that run on a schedule', keys: 'automate schedule recurring cron', run: go('routines') },
      claude() && { icon: '⏰', title: 'New routine', sub: 'Schedule a recurring task', keys: 'schedule add', run: () => { SB.setView('routines'); $('newRoutineBtn').click(); } },
      claude() && { icon: '📝', title: 'Notes', sub: 'Ideas to plan, build or ask Claude about', keys: 'todo ideas list project', run: go('notes') },
      claude() && { icon: '📝', title: 'New note', sub: 'Jot down something to do', keys: 'todo idea add', run: () => { SB.setView('notes'); $('noteInput').focus(); } },
      { icon: '📈', title: 'Health', sub: 'Temperatures, memory and drives', keys: 'gpu cpu ram disk temperature vitals', run: go('health') },
      claude() && { icon: '🗂️', title: 'History', sub: 'Past conversations', keys: 'sessions old', run: go('history') },
      { icon: '⏱️', title: 'Time', sub: 'Hours on each project, your streak, focus sessions and timesheets', keys: 'time tracking hours timesheet invoice billing clients rate freelance streak nudge quiet focus pomodoro', run: go('time') },
      claude() && { icon: '📁', title: 'Projects', sub: 'Your repos and their dev servers', keys: 'projects repos repositories github clone dev server vite next npm run localhost port', run: go('projects') },
      { icon: '⚙️', title: 'Settings', sub: 'Everything else', keys: 'preferences options', run: go('settings') },
      { icon: '⌨️', title: 'Keyboard shortcuts', sub: 'Every key, in one list', keys: 'keys keyboard hotkeys cheat sheet help', shortcut: 'shortcuts', run: () => SB.openShortcuts() },
      claude() && { icon: '🗺️', title: 'Quests', sub: 'Find his best tricks, one at a time', keys: 'quests quest tutorial learn tips tricks hidden features guide diff comment branch copy home reset queue', run: () => SB.showQuests() },
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

  // Claude Code's cloud sessions (wiring/handoff.js openCloud): each opens in a
  // terminal, where Claude Code shows its own lists and asks what it needs to.
  function cloudEntries() {
    if (!claude()) return [];
    const tabId = state.activeTab;
    const open = async (kind, value = null) => {
      const r = await api.openCloud({ kind, value, tabId }).catch(() => null);
      if (!r?.ok) return SB.toast(r?.error || "Couldn't open a terminal.", { ms: 6000 });
      SB.toast(r.text, { ms: 6000 });
    };
    // What's in the box is what a new cloud session starts on.
    const typed = () => $('input').value.trim();
    return [
      { group: 'Cloud', icon: '☁️', title: 'Pick up a cloud session here', sub: 'claude --teleport, in a terminal: from claude.ai/code or the app', keys: 'teleport cloud web remote session resume', run: () => open('teleport') },
      { group: 'Cloud', icon: '☁️', title: 'Start a cloud session on what\'s in the box', sub: 'claude --cloud, in a terminal: it keeps going with this PC off', keys: 'cloud web remote session start background',
        run: () => { if (!typed()) return SB.toast('Type what the cloud session should do in the box first.', { ms: 5000 }); return open('cloud', typed()); } },
      { group: 'Cloud', icon: '⑂', title: 'Pick up the conversation behind a pull request', sub: 'claude --from-pr, in a terminal. Paste its address in the box first to skip the list', keys: 'pull request pr github from-pr resume review',
        run: () => open('pr', /^https:\/\/github\.com\/\S+\/pull\/\d+$/.test(typed()) ? typed() : null) },
    ];
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

  // Splitting, popping out and moving between panes: the keyboard's way to do
  // what dragging a tab into the chat, or out of the window, does (tab-panes.js).
  function paneEntries() {
    const tab = state.tabs.get(state.activeTab);
    if (!claude() || !tab) return [];
    const shown = SB.panes.ids(state.grid);
    const keys = 'pane split side by side grid quad window layout';
    const chat = run => () => { SB.setView('chat'); run(); };
    return [
      { icon: '◫', title: 'Split: another conversation alongside', sub: 'Side by side, then a 2×2 grid', keys, shortcut: 'splitPane', run: chat(SB.splitPane) },
      { icon: '↗', title: 'Open this conversation in its own window', sub: tab.title, keys: `${keys} pop out tear off`, run: () => SB.popOut(tab.id) },
      shown.length > 1 && { icon: '×', title: 'Close this pane', sub: `${tab.title} keeps its tab`, keys, run: chat(() => SB.closePane(tab.id)) },
      ...shown.filter(id => id !== tab.id && state.tabs.has(id)).map(id => ({
        icon: '◧', title: `Go to the pane with ${state.tabs.get(id).title}`, sub: 'Focus it, so the box talks to it', keys: `${keys} focus`,
        run: chat(() => SB.activate(id)),
      })),
      { icon: '⛶', title: 'Maximize or restore the panel', sub: 'Room for a 2×2 grid', keys: `${keys} fullscreen full screen bigger`, run: () => api.maximize() },
    ].filter(Boolean).map(e => ({ ...e, group: 'Conversations' }));
  }

  // Ranking lives in shortcuts.js (tested there): the best match first, then
  // what you ran lately, then the group's place here.
  const GROUP_RANK = {
    'This conversation': 0, Screens: 1, Focus: 2, Project: 3, Claude: 4, Editor: 5, Settings: 6, 'Permission mode': 7,
    Routines: 8, Snippets: 9, Conversations: 10, Skills: 11, Commands: 12,
  };
  const focusEntries = () => (SB.focusCommands?.() || []).map(e => ({ ...e, group: 'Focus' }));

  // Find, zoom and the working folder in your editor.
  function editorEntries() {
    const ed = state.editors?.using;
    const here = SB.activeTab()?.cwd || state.cwd;
    return [
      claude() && { id: 'ed:find', icon: '🔎', title: 'Find in this conversation', sub: '', shortcut: 'find', keys: 'search text match', run: () => SB.inChat(() => SB.find.open()) },
      { id: 'ed:zoomIn', icon: '➕', title: 'Zoom in', sub: 'Bigger text in the panel', shortcut: 'zoomIn', keys: 'font size larger scale', run: () => SB.zoom(1) },
      { id: 'ed:zoomOut', icon: '➖', title: 'Zoom out', sub: 'Smaller text in the panel', shortcut: 'zoomOut', keys: 'font size smaller scale', run: () => SB.zoom(-1) },
      { id: 'ed:zoomReset', icon: '🔍', title: 'Reset zoom', sub: 'Text back to its usual size', shortcut: 'zoomReset', keys: 'font size actual normal 100', run: () => SB.zoom(0) },
      claude() && here && { id: 'ed:folder', icon: '↗', title: ed ? `Open working folder in ${ed}` : 'Open working folder', sub: SB.shortPath(here, 40), keys: 'editor vscode code cursor windsurf project explorer', run: () => SB.openFile(here) },
    ].filter(Boolean).map(e => ({ ...e, group: 'Editor' }));
  }

  // With nothing typed: this conversation's actions on the chat screen, what you
  // ran lately, then every screen and setting to browse.
  function search(raw) {
    const actions = actionEntries();
    const screens = screenEntries();
    const settings = settingEntries();
    const all = [...actions, ...screens, ...focusEntries(), ...projectEntries(), ...claudeEntries(), ...editorEntries(), ...settings, ...modeEntries(),
      ...routineEntries(), ...snippetEntries(), ...tabEntries(), ...cloudEntries(), ...paneEntries(), ...conversationEntries(), ...toolEntries()];
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
    if (state.view === 'onboarding' || SB.solo) return;
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
    if (!(e.ctrlKey && /^[k1-8/]$/i.test(e.key))) e.stopPropagation();
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

  // The keys a VS Code hand reaches for: Ctrl+Shift+P for the palette (Ctrl+K's
  // own handler is at the top), and Ctrl+= / Ctrl+- / Ctrl+0 for the text size.
  document.addEventListener('keydown', e => {
    if (state.view === 'onboarding' || document.querySelector('.card-sheet:not([hidden])')) return;
    if (K.matches(e, 'palette') && e.shiftKey) { e.preventDefault(); return sheet.hidden ? openPalette() : closePalette(); }
    const zoom = K.matches(e, 'zoomIn') ? 1 : K.matches(e, 'zoomOut') ? -1 : K.matches(e, 'zoomReset') ? 0 : null;
    if (zoom !== null) { e.preventDefault(); SB.zoom(zoom); }
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
