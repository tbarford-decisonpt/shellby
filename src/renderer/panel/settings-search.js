/* Shellby panel — searching Settings. Typing in the box above the tabs shows
   every tab at once, cut down to the sections and rows that match (which ones:
   settings-search-logic.js). A fold that matches opens, and closes again when
   the search is cleared. Esc, or emptying the box, puts the tabs back as they
   were. Ctrl+F on Settings comes here instead of the conversation's find bar. */
'use strict';
(function () {
  const { state, $ } = SB;
  const L = window.ShellbySettingsSearch;
  const view = $('settingsView');
  const box = $('settingsSearch');
  const line = $('settingsSearchLine');
  const tabs = [...$('settingsTabs').querySelectorAll('[role="tab"]')];
  const panels = [...view.querySelectorAll('.settings-panel')];
  let opened = new Set(); // folds the search opened, to close again
  let searching = false;

  for (const p of panels) p.dataset.tabName = tabs.find(b => b.dataset.tab === p.dataset.tab)?.textContent.trim() || '';

  // A section's rows: each child but its heading, with a help line (p.muted)
  // kept with the row above it, so a match on either shows both.
  function unitsOf(group) {
    const units = [];
    for (const el of group.children) {
      if (el.tagName === 'H3' || el.tagName === 'SUMMARY') continue;
      if (units.length && el.matches('p.muted')) units.at(-1).push(el);
      else units.push([el]);
    }
    return units;
  }

  const headOf = g => `${g.dataset.nav || ''} ${g.querySelector('h3')?.textContent || ''}`;
  // A row Settings is hiding anyway (a feature that's off) can't be what you're after.
  const textOf = els => els.filter(el => !el.hidden).map(el => `${el.textContent} ${el.title || ''} ${el.getAttribute('aria-label') || ''}`).join(' ');

  function clearMarks() {
    for (const el of view.querySelectorAll('.search-out')) el.classList.remove('search-out');
    for (const d of opened) d.open = false;
    opened = new Set();
  }

  function run() {
    const words = L.terms(box.value);
    clearMarks();
    if (!words.length) {
      if (searching) {
        searching = false;
        view.classList.remove('searching');
        SB.showSettingsTab(SB.settingsTab());
      }
      line.textContent = '';
      line.hidden = true;
      return;
    }
    searching = true;
    view.classList.add('searching');
    for (const p of panels) p.hidden = false;
    let found = 0;
    for (const p of panels) {
      let inPanel = 0;
      for (const g of p.querySelectorAll('.setting-group')) {
        const units = unitsOf(g);
        const r = L.plan({ head: headOf(g), units: units.map(textOf) }, words);
        if (!r.show) { g.classList.add('search-out'); continue; }
        units.forEach((u, i) => { if (!r.units[i]) u.forEach(el => el.classList.add('search-out')); });
        if (g.tagName === 'DETAILS' && !g.open) { g.open = true; opened.add(g); }
        if (!g.hidden) { found++; inPanel++; }
      }
      if (!inPanel) p.classList.add('search-out');
    }
    line.textContent = L.summary(found, box.value);
    line.hidden = false;
  }

  function clear() {
    if (!box.value) return false;
    box.value = '';
    run();
    return true;
  }

  box.addEventListener('input', run);
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape' && clear()) { e.preventDefault(); e.stopPropagation(); }
    // Enter goes to the first thing that matched.
    if (e.key === 'Enter' && searching) {
      const first = [...view.querySelectorAll('.setting-group')].find(g => !g.hidden && !g.classList.contains('search-out') && !g.closest('.search-out'));
      const control = first && [...first.querySelectorAll('input, select, button, textarea')].find(el => !el.closest('.search-out, [hidden]') && !el.disabled);
      if (control) { e.preventDefault(); control.focus(); control.scrollIntoView({ block: 'center' }); }
    }
  });

  // Picking a tab, or being sent to a setting (the palette, the tray), ends the search.
  for (const b of tabs) b.addEventListener('click', clear, true);
  for (const name of ['jumpToSetting', 'showSetting']) {
    const was = SB[name];
    SB[name] = (...args) => { clear(); return was(...args); };
  }

  // Ctrl+F on Settings searches Settings.
  document.addEventListener('keydown', e => {
    if (state.view !== 'settings' || !SB.shortcuts.matches(e, 'find')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    box.focus();
    box.select();
  }, true);
})();
