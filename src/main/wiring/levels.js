// Levels 1 to 99 and what each unlocks (progression/levels.js): installs the real everLevel
// on d (the highest level ever reached, 99 after any molt) and registers the
// 'unlocks' view the panel's level ladder reads (renderer levels-ui.js).
// Kept out of main.js, which only wires it up.
const levels = require('../progression/levels');
const { normalizeXp, levelOf } = require('../progression/xp');

/** d: what main shares (main.js `shared`). */
function wireLevels(d) {
  const xpNow = () => normalizeXp(d.config?.get('xp'));
  d.setEverLevel?.(() => levels.everLevel(xpNow()));

  function unlocksView() {
    const xp = xpNow();
    const ever = levels.everLevel(xp);
    const v = levelOf(xp);
    const seen = levels.normalizeUnlockSeen(d.config?.get('unlockSeen'));
    const perks = levels.perksFor(ever);
    return {
      level: v.level, everLevel: ever, molts: xp.molt.count,
      next: xp.molt.count ? null : levels.nextUnlock(v.level, { xp: xp.total }),
      perks: Object.entries(levels.PERKS).map(([id, p]) => ({ id, ...p, owned: perks.has(id) })),
      ladder: levels.ladder(ever, seen.level),
      seenLevel: seen.level,
    };
  }

  d.gameHub?.register('unlocks', {
    get: () => unlocksView(),
    act(action, payload) {
      if (!d.config) return null;
      // The bounty-reroll perk (wiring/progress.js): one of today's bounties swapped.
      if (action === 'reroll') return d.rerollBounty?.(payload?.id) ?? null;
      // The ladder was looked at: what's new up to here isn't any more.
      if (action !== 'seen') return null;
      const seen = levels.normalizeUnlockSeen(d.config.get('unlockSeen'));
      d.config.set({ unlockSeen: { ...seen, level: levels.everLevel(xpNow()) } });
      return unlocksView();
    },
  });

  return { unlocksView };
}

module.exports = { wireLevels };
