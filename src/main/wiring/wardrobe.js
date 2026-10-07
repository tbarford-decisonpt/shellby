// The Wardrobe at boot (wardrobe/service.js): loaded, its unlocks celebrated,
// and on its first run, credited with what history shows you've done already.
// Kept out of main.js, which only wires it up; its channels are ipc/wardrobe.js.
const { app } = require('electron');
const path = require('path');
const { Wardrobe } = require('../wardrobe/service');
const weekly = require('../weekly');

const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** What history shows you've done: { tasksCompleted, activeDays: ['YYYY-MM-DD'] }. */
function pastUsage(history) {
  const entries = history.list();
  return {
    tasksCompleted: entries.reduce((n, e) => n + history.load(e.id).filter(i => i.kind === 'result' && i.ok).length, 0),
    activeDays: [...new Set(entries.flatMap(e => [e.createdAt, e.updatedAt]).filter(Boolean).map(dayOf))],
  };
}

/** d: what main shares (main.js `shared`). */
function wireWardrobe(d) {
  function createWardrobe() {
    const { config } = d;
    const wardrobe = d.wardrobe = new Wardrobe({
      config, builtinDir: path.join(__dirname, '..', '..', 'wardrobe'), userDir: path.join(app.getPath('userData'), 'wardrobe'),
      now: () => d.captureClock.now || new Date(),
      south: () => d.seasonsWhere().south,
      // "Unlock everything" is held back for a paid tier; dev runs (e2e, screenshots) keep it.
      canUnlockAll: () => !app.isPackaged,
    });
    wardrobe.load();
    wardrobe.on('changed', d.broadcastWardrobe);
    wardrobe.on('unlocked', e => {
      d.flashState('unlocked', 6000);
      d.awardXp('trophy', { label: e.achievement.name });
      if (!d.CAPTURE) config.set({ weekly: weekly.recordTrophy(config.get('weekly'), Date.now(), e.achievement) });
      d.send(d.critter, 'critter:burst', d.outfit().confetti);
      d.send(d.panel, 'wardrobe:unlocked', e);
      d.send(d.panel, 'wardrobe', wardrobe.view());
      if (!(d.panel?.isVisible() && d.panel.isFocused())) {
        d.notify(`${e.achievement.icon} Achievement: ${e.achievement.name}`, `Unlocked ${e.rewards.map(r => r.name).join(' + ')}. Open the Wardrobe to try it on!`,
          () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'wardrobe'); }, { tone: 'celebrate', pet: true });
      }
    });
    wardrobe.on('collected', items => {
      d.send(d.panel, 'wardrobe:collected', items.map(i => ({ key: i.key, name: i.name })));
      d.broadcastWardrobe();
    });
    // Credit past usage from history on the Wardrobe's first run (must precede any stat()).
    // A function, so history is only read on the first run (backfill is a no-op after).
    if (!d.CAPTURE) d.welcomeTrophies = wardrobe.backfill(() => pastUsage(d.history));
  }

  return { createWardrobe };
}

module.exports = { wireWardrobe, pastUsage };
