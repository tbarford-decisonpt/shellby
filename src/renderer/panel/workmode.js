/* Shellby panel — Work mode: the tools up front and a quiet crab. The bar
   leads with Chat, Projects, History, Toolbox, Automate and Health; Shellby's
   own screens move to the end of it and stay in Ctrl+K. What it changes about
   him is decided in main (src/main/workmode.js), which sends the bar's order
   with the settings, so this only lays the panel out to match. */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const dock = $('dock');
  const usual = [...dock.children]; // the bar's own order, for leaving Work mode

  SB.isWorkMode = () => !!state.settings.workMode && !state.settings.crabOnly;
  SB.modeNow = () => (state.settings.crabOnly ? 'crab' : SB.isWorkMode() ? 'work' : 'claude');

  function layDock() {
    const order = SB.isWorkMode() ? state.settings.dockOrder || [] : [];
    const rank = el => { const i = order.indexOf(el.dataset?.viewBtn); return i < 0 ? order.length + usual.indexOf(el) : i; };
    const want = order.length ? [...usual].sort((a, b) => rank(a) - rank(b)) : usual;
    if (want.some((el, i) => dock.children[i] !== el)) dock.append(...want);
    SB.retitleDock?.();
  }

  SB.applyWorkMode = () => {
    document.body.classList.toggle('work-mode', SB.isWorkMode());
    layDock();
    $('workModeToggle').checked = SB.isWorkMode();
    const now = SB.modeNow();
    document.querySelectorAll('#modeSeg [data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === now)));
  };

  // Rides along with just the crab's: everything that changes the mode calls it.
  const applyCrabOnly = SB.applyCrabOnly;
  SB.applyCrabOnly = () => {
    applyCrabOnly();
    SB.applyWorkMode();
  };

  SB.setWorkMode = async on => {
    const r = await api.setSettings({ workMode: !!on });
    state.settings = r.settings;
    SB.applyCrabOnly();
    if (state.view === 'settings') SB.views.settings.render();
    SB.toast(on
      ? "Work mode's on. Your tools come first, and he only speaks up about the work. His screens are at the end of the bar."
      : 'Work mode is off. Everything is as you left it.', { ms: 5000 });
  };

  // First run: the Work mode path goes through the same Claude Code setup (settings.js).
  SB.chooseWorkMode = async () => {
    const r = await api.setSettings({ onboarded: true, firstTour: true, crabOnly: false, workMode: true });
    state.settings = r.settings;
    SB.onboardPath = null;
    SB.applyCrabOnly();
    SB.refreshEmptyStates();
    SB.setView('chat');
    SB.toast("Work mode it is. He's on your desktop, keeping quiet unless something needs you.", { ms: 6000 });
  };

  // The three modes, and the one switch between them: his right-click menu and
  // the tray (panel:mode), Ctrl+K and Settings all come through here.
  SB.APP_MODES = [
    { id: 'claude', icon: '💬', title: 'Claude Code', sub: 'Your tasks, and a lively crab' },
    { id: 'work', icon: '🛠️', title: 'Work mode', sub: 'The tools up front, and a quiet crab' },
    { id: 'crab', icon: '🦀', title: 'Just the crab', sub: 'Health, the Wardrobe and trophies, no Claude' },
  ];
  const needsSetup = () => {
    const s = state.status || {};
    return SB.isCrabOnly() && !state.settings.claudeElsewhere && !(s.installed && s.loggedIn);
  };

  SB.switchMode = async id => {
    if (!SB.APP_MODES.some(m => m.id === id) || id === SB.modeNow()) return;
    // Out of just the crab with no Claude Code yet: its setup first, which lands in the mode asked for.
    if (id !== 'crab' && needsSetup()) {
      SB.startClaudeSetup();
      if (id === 'work') { SB.onboardPath = 'work'; SB.setView('onboarding'); }
      return;
    }
    if (id === 'work') return SB.setWorkMode(true);
    const r = await api.setSettings(id === 'crab' ? { crabOnly: true } : { crabOnly: false, workMode: false });
    state.settings = r.settings;
    SB.applyCrabOnly();
    SB.refreshEmptyStates?.();
    if (id === 'crab' && state.view === 'chat') SB.setView(SB.homeView());
    if (state.view === 'settings') SB.views.settings.render();
    SB.toast(id === 'crab'
      ? 'Just the crab. Your conversations stay saved; switch back from his menu any time.'
      : 'Claude Code, with a lively crab. Everything is as you left it.', { ms: 5000 });
  };
  api.onMode(id => SB.switchMode(id));
  document.querySelectorAll('#modeSeg [data-mode]').forEach(b => b.addEventListener('click', () => SB.switchMode(b.dataset.mode)));

  $('workModeToggle').addEventListener('change', e => SB.setWorkMode(e.target.checked));
})();
