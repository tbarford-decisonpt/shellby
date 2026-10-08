/* Shellby panel — the mode and folder chips under the box. The folder chip's
   repository items live in tab-git.js (loaded after this). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  // Theirs, reached when they're called (the file loads after this one).
  const repoItems = tab => SB.repoItems(tab);

  // ------------------------------------------------------------ mode chip

  SB.applyMode = (mode) => {
    document.body.dataset.mode = mode;
    const m = SB.MODES.find(x => x.id === mode) || SB.MODES[0];
    $('modeLabel').textContent = m.chip;
    $('modeHint').textContent = SB.MODE_HINTS[mode] || '';
    $('modeHint').classList.toggle('danger', mode === 'autonomous');
  };

  SB.chooseMode = async (mode, { quiet = false } = {}) => {
    if (mode === 'autonomous' && !state.settings.autonomousAcknowledged) {
      // A popped-out window has no Settings to confirm it in.
      if (SB.solo) return SB.toast('Turn Autonomous on from Settings in the main panel first.');
      SB.setView('settings');
      SB.showSettingsTab('claude');
      $('autonomousConfirm').hidden = false;
      $('autonomousConfirm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const r = await api.setSettings({ mode });
    state.settings = r.settings;
    SB.applyMode(state.settings.mode);
    if (state.view === 'settings') SB.views.settings.render();
    if (!quiet) SB.toast(`Mode: ${SB.MODES.find(x => x.id === state.settings.mode).title} (all open conversations)`);
  };

  // Shift+Tab in the composer steps through the modes, like Claude Code. Autonomous
  // stays out of the loop: holding a key down should never land on "never asks".
  // The chip flips before the save so quick presses build on each other.
  const CYCLE = SB.MODES.map(m => m.id).filter(id => id !== 'autonomous');
  SB.cycleMode = () => {
    const next = CYCLE[(CYCLE.indexOf(document.body.dataset.mode) + 1) % CYCLE.length];
    SB.applyMode(next);
    return SB.chooseMode(next);
  };

  $('modeChip').addEventListener('click', () => SB.openMenu($('modeMenu'), $('modeChip'), () => SB.MODES.map(m =>
    h('button', { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(state.settings.mode === m.id), onclick: () => { SB.closeMenus(); SB.chooseMode(m.id); } },
      h('span', { class: 'mi-check', text: state.settings.mode === m.id ? '●' : '' }),
      h('span', {}, h('div', { class: 'mi-title', text: m.title }), h('div', { class: 'mi-sub', text: m.sub }))))));

  // ------------------------------------------------------------ folder chip

  // A tab in its own copy (worktrees.js) still shows the project you know,
  // with the branch beside it, rather than a path inside Shellby's folder.
  function applyFolderLabel(cwd, tab = null) {
    const w = tab?.worktree;
    const shown = w?.originalCwd || cwd;
    $('folderLabel').textContent = SB.shortPath(shown);
    $('folderChip').title = w ? `Working folder: ${shown}\nThis conversation works in its own copy: ${cwd}` : `Working folder: ${cwd}`;
    $('branchChip').hidden = !w;
    if (w) {
      $('branchLabel').textContent = w.branch.replace(/^shellby\//, '');
      $('branchChip').title = `Its own copy, on branch ${w.branch} (from ${w.base})`;
    }
  }
  SB.applyFolderLabel = applyFolderLabel;

  SB.folderChanged = async (r) => {
    if (!r) return;
    if (r.error) return SB.toast(r.error);
    state.settings = r.settings;
    state.cwd = r.cwd;
    $('settingsFolder').textContent = SB.remotePlace(r.cwd) || r.cwd;
    // A blank tab moves to the new folder; a conversation in progress keeps its own.
    const tab = SB.activeTab();
    if (SB.isBlankTab(tab) && !SB.solo) {
      await api.closeTab(tab.id);
      tab.destroy();
      state.tabs.delete(tab.id);
      state.activeTab = null;
      await SB.newTab();
      SB.toast(`Now working in ${SB.remotePlace(r.cwd) || SB.basename(r.cwd)}`);
    } else {
      applyFolderLabel(tab?.cwd || r.cwd);
      SB.toast(`New conversations will start in ${SB.remotePlace(r.cwd) || SB.basename(r.cwd)}`, SB.solo ? {} : { action: 'Open one', onAction: () => SB.newTab() });
    }
  };

  $('folderChip').addEventListener('click', () => SB.openMenu($('folderMenu'), $('folderChip'), () => {
    const tab = SB.activeTab();
    const here = tab?.cwd || state.cwd;
    const recents = (state.settings.recentFolders || []).filter(d => d.toLowerCase() !== (here || '').toLowerCase());
    return [
      h('div', { class: 'menu-label', text: tab && !tab.isEmpty ? 'This conversation works in' : 'Working in' }),
      h('div', { class: 'menu-item path', text: here }),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: async () => { SB.closeMenus(); SB.folderChanged(await api.pickFolder()); } }, h('span', { class: 'mi-check', text: '+' }), h('span', { class: 'mi-title', text: 'Choose folder…' })),
      recents.length ? h('div', { class: 'menu-label', text: 'Recent' }) : null,
      ...recents.map(d => h('button', { class: 'menu-item path', title: d, onclick: async () => { SB.closeMenus(); SB.folderChanged(await api.setFolder(d)); } }, SB.tildify(d))),
      ...repoItems(tab),
    ];
  }));
})();
