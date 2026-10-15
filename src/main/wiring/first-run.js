// First steps (first-run.js): each step done by the real thing happening
// somewhere in main (a folder chosen, a task sent, the viewer opened, a pet),
// the panel's card kept up to date, and the core loop finished opening the
// game's rooms (wiring/progress.js reachCoreRooms).
// Kept out of main.js, which only wires it up.
const firstRun = require('../first-run');
const levels = require('../progression/levels');
const { normalizeXp } = require('../progression/xp');

/** d: what main shares (main.js `shared`). */
function wireFirstRun(d) {
  const off = () => d.CAPTURE || !d.config;
  const level = () => levels.everLevel(normalizeXp(d.config.get('xp')));
  const onboarded = () => !!d.config.get('onboarded');
  // The welcome screen is the first step: done once you're through it.
  const current = () => {
    const v = firstRun.normalizeFirstRun(d.config.get('firstRun'));
    return onboarded() ? firstRun.markStep(v, 'welcome', Date.now()) : v;
  };

  function firstRunPanelView() {
    return firstRun.firstRunView(off() ? null : d.config.get('firstRun'), off() ? {} : { onboarded: onboarded(), level: level() });
  }

  /** Whether the core loop is done now (First steps finished, or the level reached). */
  function coreLoopNow() {
    return off() || firstRun.coreLoopDone(current(), level());
  }

  // Saved, told to the panel, and the core loop checked.
  function save(next) {
    if (!next || JSON.stringify(next) === JSON.stringify(firstRun.normalizeFirstRun(d.config.get('firstRun')))) return firstRunPanelView();
    d.config.set({ firstRun: next });
    const v = firstRunPanelView();
    d.send(d.panel, 'first-run', v);
    if (coreLoopNow()) d.reachCoreRooms?.();
    return v;
  }

  /** The real thing happened: a step is done (once; later calls do nothing). */
  function firstRunStep(id) {
    if (off()) return;
    save(firstRun.markStep(current(), id, Date.now()));
  }

  const skipFirstStep = id => (off() ? firstRunPanelView() : save(firstRun.skipStep(current(), String(id || ''), Date.now())));
  const hideFirstRun = hidden => (off() ? firstRunPanelView() : save(firstRun.setHidden(current(), hidden === true)));

  return { coreLoopNow, firstRunPanelView, firstRunStep, hideFirstRun, skipFirstStep };
}

module.exports = { wireFirstRun };
