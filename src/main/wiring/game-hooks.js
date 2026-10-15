// The hooks the gamification packages meet through (docs/GAMIFICATION-PLAN.md
// section 3.2), so each can be built on its own: listener lists for awards,
// level-ups, stats and scored commands, the reef's notes, the level ever reached,
// and the game-hub every game screen registers with. Kept out of main.js, which
// only wires it up.
const { createGameHub } = require('../game-hub');
const { levelFor, normalizeXp } = require('../progression/xp');

/** d: what main shares (main.js `shared`). */
function wireGameHooks(d) {
  // One listener list: on(fn) adds, emit(...) calls each; one that throws is logged, never the caller's problem.
  function listeners(name) {
    const fns = [];
    const on = fn => {
      if (typeof fn !== 'function') throw new Error(`${name} needs a function`);
      fns.push(fn);
      return () => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); };
    };
    const emit = (...args) => {
      for (const fn of [...fns]) {
        try { fn(...args); } catch (e) { d.log.warn(`${name} listener failed`, e?.message || String(e)); }
      }
    };
    return { on, emit };
  }

  const award = listeners('onAward');              // ({ kind, gained, meta, level }) after awardXp pays
  const levelUp = listeners('onLevelUp');          // ({ from, to }) when the level number goes up
  const stat = listeners('onStat');                // (event, payload) for every achievement stat
  const commandResult = listeners('onCommandResult'); // ({ kind, command, project, ok }) a scored shell command
  const reef = listeners('onReefNote');            // (project, sig, v) a reef signal reading

  // The highest level ever reached. Until molting lands (WP1) that's the level now.
  let everLevelOf = () => levelFor(normalizeXp(d.config?.get('xp')).total).level;

  return {
    gameHub: createGameHub(d),
    onAward: award.on, emitAward: award.emit,
    onLevelUp: levelUp.on, emitLevelUp: levelUp.emit,
    onStat: stat.on, emitStat: stat.emit,
    onCommandResult: commandResult.on, emitCommandResult: commandResult.emit,
    onReefNote: reef.on, reefNote: (project, sig, v) => reef.emit(project, sig, v),
    everLevel: () => everLevelOf(),
    setEverLevel: fn => { if (typeof fn === 'function') everLevelOf = fn; },
  };
}

module.exports = { wireGameHooks };
