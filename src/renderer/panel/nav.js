/* Shellby panel — navigation: the bottom bar and Settings gear, Back/Esc going
   up one level, Ctrl+1…6, the Ctrl+K "jump anywhere" palette, and the Settings
   section links. */
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

  // ------------------------------------------------------------ Settings section links

  const settingsView = $('settingsView');
  const jump = $('settingsJump');
  const visibleGroups = () => [...settingsView.querySelectorAll('.setting-group[data-nav]')]
    .filter(g => !g.hidden && getComputedStyle(g).display !== 'none');

  // While a jump's smooth scroll runs, keep the clicked link lit instead of
  // walking the highlight through every section on the way.
  let jumpingTo = null;
  settingsView.addEventListener('scrollend', () => { jumpingTo = null; markCurrent(); });

  SB.jumpToSetting = group => {
    if (state.view !== 'settings') SB.setView('settings');
    requestAnimationFrame(() => {
      const before = settingsView.scrollTop;
      jumpingTo = group;
      group.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      markCurrent(group);
      // Already in place: no scroll happens, so no scrollend either.
      requestAnimationFrame(() => { if (settingsView.scrollTop === before) jumpingTo = null; });
    });
  };

  function renderJump() {
    jump.replaceChildren(...visibleGroups().map(g => h('button', {
      type: 'button', class: 'jump-chip', dataset: { nav: g.dataset.nav }, onclick: () => SB.jumpToSetting(g),
    }, g.dataset.nav)));
    markCurrent();
    markEdges();
  }

  // The current section is the last one whose top has scrolled up under the links.
  function markCurrent(forced) {
    const groups = visibleGroups();
    if (!groups.length) return;
    let current = forced;
    if (!current) {
      const line = settingsView.getBoundingClientRect().top + jump.offsetHeight + 24;
      current = groups[0];
      for (const g of groups) if (g.getBoundingClientRect().top <= line) current = g;
      // At the very bottom the last short sections can never reach the line.
      if (settingsView.scrollTop + settingsView.clientHeight >= settingsView.scrollHeight - 2) current = groups.at(-1);
    }
    for (const chip of jump.children) {
      const on = chip.dataset.nav === current.dataset.nav;
      if (on) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
      if (on) {
        const { offsetLeft: left, offsetWidth: width } = chip;
        if (left < jump.scrollLeft || left + width > jump.scrollLeft + jump.clientWidth) jump.scrollLeft = left - 16;
      }
    }
  }

  const markEdges = () => {
    jump.classList.toggle('more-left', jump.scrollLeft > 2);
    jump.classList.toggle('more-right', jump.scrollLeft + jump.clientWidth < jump.scrollWidth - 2);
  };
  jump.addEventListener('scroll', markEdges, { passive: true });
  new ResizeObserver(markEdges).observe(jump);

  let scrollTick = 0;
  settingsView.addEventListener('scroll', () => {
    if (scrollTick) return;
    scrollTick = requestAnimationFrame(() => { scrollTick = 0; markCurrent(jumpingTo); });
  }, { passive: true });

  const renderSettings = SB.views.settings.render;
  SB.views.settings.render = () => { renderSettings(); renderJump(); };

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
      claude() && { icon: '💬', title: 'Chat', sub: 'Give Shellby a task', keys: 'home task conversation', run: go('chat') },
      claude() && { icon: '➕', title: 'New conversation', sub: 'Ctrl+T', keys: 'tab chat', run: () => { SB.setView('chat'); SB.newTab(); } },
      claude() && { icon: '🧰', title: 'Toolbox', sub: 'Skills, agents, commands and MCP servers', keys: 'tools mcp', run: go('toolbox') },
      claude() && { icon: '🛒', title: 'Skill Shop', sub: 'Install skills from plugin marketplaces', keys: 'get more plugins install marketplace', run: () => SB.openShop() },
      claude() && { icon: '⏰', title: 'Routines', sub: 'Tasks that run on a schedule', keys: 'schedule recurring cron', run: go('routines') },
      claude() && { icon: '⏰', title: 'New routine', sub: 'Schedule a recurring task', keys: 'schedule add', run: () => { SB.setView('routines'); $('newRoutineBtn').click(); } },
      { icon: '📈', title: 'Health', sub: 'Temperatures, memory and drives', keys: 'gpu cpu ram disk temperature vitals', run: go('health') },
      claude() && { icon: '🗂️', title: 'History', sub: 'Past conversations', keys: 'sessions old', run: go('history') },
      { icon: '⚙️', title: 'Settings', sub: 'Everything else', keys: 'preferences options', run: go('settings') },
    ].filter(Boolean).map(e => ({ ...e, group: 'Screens' }));
  }

  function settingEntries() {
    return visibleGroups().map(g => {
      const heading = g.querySelector('h3')?.textContent || '';
      return {
        group: 'Settings', icon: '⚙️', title: `Settings › ${g.dataset.nav}`,
        sub: heading.toLowerCase() === g.dataset.nav.toLowerCase() ? '' : heading,
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
      group: 'Conversations', icon: '💬', title: s.title, sub: `${SB.relTime(s.updatedAt)} · ${SB.shortPath(s.cwd, 30)}`, keys: s.cwd || '',
      run: async () => { SB.setView('chat'); await SB.openHistory(s.id); },
    }));
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

  const GROUP_RANK = { Screens: 0, Settings: 1, 'Permission mode': 2, Conversations: 3, Skills: 4, Commands: 5 };

  function search(raw) {
    const q = raw.trim().toLowerCase();
    if (!q) return [...screenEntries(), ...settingEntries()];
    const words = q.split(/\s+/);
    return [...screenEntries(), ...settingEntries(), ...modeEntries(), ...conversationEntries(), ...toolEntries()]
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
