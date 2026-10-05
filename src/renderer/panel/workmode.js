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
    const r = await api.setSettings({ onboarded: true, crabOnly: false, workMode: true });
    state.settings = r.settings;
    SB.onboardPath = null;
    SB.applyCrabOnly();
    SB.setView('chat');
    SB.toast("Work mode it is. He's on your desktop, keeping quiet unless something needs you.", { ms: 6000 });
  };

  $('workModeToggle').addEventListener('change', e => SB.setWorkMode(e.target.checked));
})();
