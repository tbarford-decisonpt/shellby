/* Shellby panel — navigation: the bottom bar and Settings gear, Back/Esc going
   up one level, Ctrl+1…6, the Ctrl+K "jump anywhere" palette, and the Settings
   tabs. */
'use strict';
(function () {
  const { h, state, $ } = SB;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------ bar + gear

  SB.goBack = () => SB.setView(SB.PARENT_VIEW[state.view] || SB.homeView());

  const navButtons = [...document.querySelectorAll('[data-view-btn]')];
  const dockButtons = [...document.querySelectorAll('.dock [data-view-btn]')];
  dockButtons.forEach((b, i) => { b.title = `${b.textContent.trim()} (Ctrl+${i + 1})`; });

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
    const b = n >= 1 && n <= dockButtons.length ? dockButtons[n - 1] : null;
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

  const sheet = $('paletteSheet');
  const input = $('paletteInput');
  const list = $('paletteList');
  let results = [];
  let selected = 0;
  let returnFocus = null;

  const claude = () => !SB.isCrabOnly();

  function screenEntries() {
    const go = view => () => SB.setView(view);
    return [
      { icon: '🎩', title: 'Shellby: outfits', sub: 'Dress him up', keys: 'crab wardrobe hats skins colors effects packs', run: go('wardrobe') },
      { icon: '🏆', title: 'Shellby: trophies & XP', sub: 'Level, XP, streaks and trophies', keys: 'level achievements streak', run: go('trophies') },
      { icon: '🐚', title: 'Shellby: finds', sub: 'Everything he’s dug up for you', keys: 'gifts shelf treasure dig collection sets', run: go('finds') },
      { icon: '💞', title: 'Shellby: us', sub: 'How close you are, your story, games, your birthday', keys: 'bond friendship memories journal birthday temperament scenes', run: go('us') },
      { icon: '🪸', title: 'Shellby: tank', sub: 'Decorate his tank with castles, plants and his finds', keys: 'tank aquarium home decorate decor castle plants treasure chest room furniture', run: go('tank') },
      { icon: '🏖️', title: 'Shellby: beach', sub: 'A sandcastle for every project you’ve shipped', keys: 'beach sandcastle castles shipped projects tide streak snapshot share', run: go('beach') },
      { icon: '🙈', title: 'Play hide and seek', sub: 'He hides behind your windows', keys: 'game play hide seek', run: () => SB.play('hide') },
      { icon: '🎾', title: 'Play fetch', sub: 'Throw him a pebble', keys: 'game play fetch ball throw', run: () => SB.play('fetch') },
      claude() && { icon: '💬', title: 'Chat', sub: 'Give Shellby a task', keys: 'home task conversation', run: go('chat') },
      claude() && { icon: '➕', title: 'New conversation', sub: 'Ctrl+T', keys: 'tab chat', run: () => { SB.setView('chat'); SB.newTab(); } },
      claude() && { icon: '🧰', title: 'Toolbox', sub: 'Skills, agents, commands, MCP servers, hooks and memory', keys: 'tools mcp hooks memory claude.md', run: go('toolbox') },
      claude() && { icon: '🛒', title: 'Skill Shop', sub: 'Install skills from plugin marketplaces', keys: 'get more plugins install marketplace', run: () => SB.openShop() },
      claude() && { icon: '⚡', title: 'Workflows', sub: 'Triggers that start a list of steps', keys: 'automate automation flow trigger steps webhook', run: go('workflows') },
      claude() && { icon: '⚡', title: 'New workflow', sub: 'Build one step by step', keys: 'automate add create flow trigger', run: () => SB.workflows.create() },
      claude() && { icon: '⚡', title: 'Describe a workflow', sub: 'Say what should happen and Claude drafts it', keys: 'automate draft write claude flow', run: () => SB.workflows.describe() },
      claude() && { icon: '⏰', title: 'Routines', sub: 'Tasks that run on a schedule', keys: 'automate schedule recurring cron', run: go('routines') },
      claude() && { icon: '⏰', title: 'New routine', sub: 'Schedule a recurring task', keys: 'schedule add', run: () => { SB.setView('routines'); $('newRoutineBtn').click(); } },
      { icon: '📈', title: 'Health', sub: 'Temperatures, memory and drives', keys: 'gpu cpu ram disk temperature vitals', run: go('health') },
      claude() && { icon: '🗂️', title: 'History', sub: 'Past conversations', keys: 'sessions old', run: go('history') },
      { icon: '⏱️', title: 'Time', sub: 'Hours on each project, timesheets and invoices', keys: 'time tracking hours timesheet invoice billing clients rate freelance', run: go('time') },
      claude() && { icon: '📁', title: 'Projects', sub: 'Your repos and their dev servers', keys: 'projects repos repositories github clone dev server vite next npm run localhost port', run: go('projects') },
      { icon: '⚙️', title: 'Settings', sub: 'Everything else', keys: 'preferences options', run: go('settings') },
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
      keys: 'permission mode', run: () => SB.chooseMode(m.id),
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

  // Every word has to appear somewhere; titles that start with the query rank first.
  function score(entry, q, words) {
    const title = entry.title.toLowerCase();
    const hay = `${title} ${entry.sub} ${entry.keys} ${entry.group}`.toLowerCase();
    if (!words.every(w => hay.includes(w))) return -1;
    const bare = title.replace(/^(settings › |mode: |\/)/, '');
    if (bare.startsWith(q) || title.startsWith(q)) return 0;
    if (title.includes(q)) return 1;
    if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) return 2;
    return 3;
  }

  const GROUP_RANK = { Screens: 0, Focus: 1, Settings: 2, 'Permission mode': 3, Conversations: 4, Skills: 5, Commands: 6 };
  const focusEntries = () => (SB.focusCommands?.() || []).map(e => ({ ...e, group: 'Focus' }));

  function search(raw) {
    const q = raw.trim().toLowerCase();
    if (!q) return [...screenEntries(), ...settingEntries()];
    const words = q.split(/\s+/);
    return [...screenEntries(), ...focusEntries(), ...settingEntries(), ...modeEntries(), ...tabEntries(), ...conversationEntries(), ...toolEntries()]
      .map(entry => ({ entry, s: score(entry, q, words) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => a.s - b.s || GROUP_RANK[a.entry.group] - GROUP_RANK[b.entry.group])
      .slice(0, 40)
      .map(x => x.entry);
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
      grouped ? null : h('span', { class: 'pal-key', text: r.group })));
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

  function update() { results = search(input.value); selected = 0; renderPalette(); }

  function runAt(i) {
    const r = results[i];
    if (!r) return;
    closePalette({ restoreFocus: false });
    r.run();
    // Chat focuses its composer itself; other screens get focus on their heading,
    // so the keyboard isn't left stranded on the page.
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body || state.view === 'chat') return;
      const heading = document.querySelector(`.view-${state.view} h2`);
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    });
  }

  function openPalette() {
    if (state.view === 'onboarding') return;
    SB.closeMenus();
    returnFocus = document.activeElement;
    sheet.hidden = false;
    input.value = '';
    update();
    input.focus();
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
    if (!(e.ctrlKey && /^[k1-6]$/i.test(e.key))) e.stopPropagation();
  });
  sheet.addEventListener('mousedown', e => { if (e.target === sheet) closePalette(); });
  $('paletteBtn').addEventListener('click', openPalette);
})();
