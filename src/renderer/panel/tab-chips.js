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

  // A conversation in your own checkout shows its branch too: the way into the file viewer (viewer.js).
  // What's known shows at once, so the chip never blinks; a lookup older than 15 s is redone
  // quietly, one at a time per folder.
  const branchSeen = new Map(); // cwd -> { at, branch, asking }
  function plainBranch(tab) {
    const seen = branchSeen.get(tab.cwd) || { at: 0, branch: null, asking: null };
    branchSeen.set(tab.cwd, seen);
    if (Date.now() - seen.at > 15000 && !seen.asking) {
      seen.asking = api.viewerBranch(tab.id).catch(() => null).then(r => {
        Object.assign(seen, { at: Date.now(), branch: r?.branch || null, asking: null });
        if (SB.activeTab()?.id === tab.id && !tab.worktree) showBranch(seen.branch);
      });
    }
    return seen.branch;
  }
  function showBranch(branch) {
    $('branchChip').hidden = !branch;
    if (branch) {
      $('branchLabel').textContent = branch;
      $('branchChip').title = `On branch ${branch}`;
    }
  }

  // A tab in its own copy (worktrees.js) still shows the project you know,
  // with the branch beside it, rather than a path inside Shellby's folder.
  function applyFolderLabel(cwd, tab = null) {
    const w = tab?.worktree;
    const shown = w?.originalCwd || cwd;
    $('folderLabel').textContent = SB.shortPath(shown);
    $('folderChip').title = w ? `Working folder: ${shown}\nThis conversation works in its own copy: ${cwd}` : `Working folder: ${cwd}`;
    if (w) {
      $('branchChip').hidden = false;
      $('branchLabel').textContent = w.branch.replace(/^shellby\//, '');
      $('branchChip').title = `Its own copy, on branch ${w.branch} (from ${w.base})`;
    } else if (SB.hasTries(tab)) {
      // In your checkout, it says so once there are other tries at this to compare with or keep.
      $('branchChip').hidden = false;
      $('branchLabel').textContent = 'other tries';
      $('branchChip').title = 'There are other tries at this: compare them, or keep one';
    } else {
      showBranch(tab && !SB.solo ? plainBranch(tab) : null);
    }
    SB.refreshUsage?.(); // a folder on another computer may be another account's plan (tab-meters.js)
  }
  SB.applyFolderLabel = applyFolderLabel;

  // Other tries at the same thing (branching.js): it was branched, or a branch went off from it.
  SB.hasTries = tab => !!tab && (!!tab.branchOf || !!tab.hasTries || [...state.tabs.values()].some(o => o.branchOf?.id === tab.id));

  // Two tabs branched without a copy share one folder (branching.js): each sees the other's changes.
  SB.sharesWith = tab => {
    if (!tab) return null;
    if (tab.branchOf?.shared) return tab.branchOf.title;
    return [...state.tabs.values()].find(o => o.branchOf?.shared && o.branchOf.id === tab.id)?.title || null;
  };

  SB.folderChanged = async (r) => {
    if (!r) return;
    if (r.error) return SB.toast(r.error);
    state.settings = r.settings;
    state.cwd = r.cwd;
    $('settingsFolder').textContent = SB.remotePlace(r.cwd) || r.cwd;
    // A blank tab moves to the new folder; a conversation in progress keeps its own.
    const tab = SB.activeTab();
    if (SB.isBlankTab(tab) && !SB.solo) {
      // The new one opens beside it first: a pane holding only the blank tab
      // would close with it, and the new tab land in the pane next door.
      const fresh = await SB.newTab({ reuse: false });
      if (!fresh) return;
      SB.forgetTab(tab.id); // tab-panes.js: out of its pane, which still has the new one
      await api.closeTab(tab.id);
      SB.renderTabStrip();
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
