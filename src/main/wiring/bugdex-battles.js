'use strict';

// Bug battles: Claude's work on what's loose, as a fight (bugdex/battle.js).
// Made by wireBugdex (wiring/bugdex.js), which shares its state with it.

const bugdex = require('../bugdex');
const lifecycle = require('../bugdex/lifecycle');
const battle = require('../bugdex/battle');
const { HABITATS, TYPES, speciesById, bossOf, leagueOf } = require('../bugdex/species');

// Bug battles (bugdex/battle.js), in memory only.
const BATTLE_PUSH_MS = 150;            // moves come in flurries: one push for a flurry
const BATTLE_KEEP_MS = 3 * 60 * 1000;  // a finished battle stays this long, for the panel to play out
const MAX_BATTLES = 40;
// Cues the battle screen may ask the crab to play (critter/sound.js).
const BATTLE_CUES = new Set(['battle', 'boss', 'hit', 'super', 'smash', 'miss', 'heal', 'resist', 'faint', 'lower', 'caught', 'badge', 'fled', 'cry']);

/**
 *   d: what main shares; on, state: wireBugdex's; names: its project id -> name map (shared, by reference).
 */
function makeBattles({ d, on, state, names }) {
  const battles = new Map();         // encounter id -> its battle (bugdex/battle.js)
  // ---- bug battles: Claude's work on what's loose, as a fight (bugdex/battle.js)

  const battleMeta = new Map();      // encounter id -> { tabId, project, source }: kept past the catch
  let battleTimer = null;

  /** Its battle, started if there isn't one yet (after a restart they start afresh). */
  function battleOf(e, now = Date.now(), failed = null) {
    const id = lifecycle.encId(e);
    battleMeta.set(id, { tabId: e.tabId || battleMeta.get(id)?.tabId || null, project: e.name || names.get(e.project) || '', source: e.source });
    if (battles.has(id)) return battles.get(id);
    const sp = speciesById(e.species);
    if (!sp) return null;
    const b = battle.start({ species: sp.id, rarity: sp.rarity, type: sp.type }, {
      id, boss: !!bossOf(sp.id), league: leagueOf(sp.id), stage: bugdex.stageOf(bugdex.caughtOf(state().species[sp.id])), failed, now,
    });
    battles.set(id, b);
    while (battles.size > MAX_BATTLES) { const old = battles.keys().next().value; battles.delete(old); battleMeta.delete(old); }
    pushBattles();
    return b;
  }

  /** Change one encounter's battle; the panel hears about it a moment later. */
  function fight(e, fn) {
    const b = battleOf(e);
    if (!b) return;
    const next = fn(b);
    if (next === b) return;
    battles.set(b.id, next);
    pushBattles();
  }

  const fightAll = (list, fn) => { for (const e of list) fight(e, fn); };

  function pushBattles() {
    if (battleTimer || !d.panel) return;
    battleTimer = setTimeout(() => { battleTimer = null; d.send(d.panel, 'bugdex:battles', d.config.get('bugBattles') === false ? [] : battleList()); }, BATTLE_PUSH_MS);
    battleTimer.unref?.();
  }

  /**
   * Every battle the panel may draw: each open encounter's (started if need
   * be), and ones that just ended, for long enough to play the ending out.
   * One whose encounter closed without a catch got away.
   */
  function battleList() {
    const now = Date.now();
    const open = on() ? state().open : [];
    const ids = new Set(open.map(lifecycle.encId));
    for (const e of open) battleOf(e, now);
    for (const [id, b] of [...battles]) {
      const done = !b.over && !ids.has(id) ? battle.finish(b, { at: now, outcome: 'fled' }) : b;
      if (done !== b) battles.set(id, done);
      if (done.over && now - (done.moves.at(-1)?.at || 0) > BATTLE_KEEP_MS) { battles.delete(id); battleMeta.delete(id); }
    }
    const tabs = new Set(d.manager ? [...d.manager.tabs.keys()] : []);
    return [...battles.values()].map(b => {
      const sp = speciesById(b.species);
      const meta = battleMeta.get(b.id) || {};
      const h = HABITATS.find(x => x.id === sp.habitat);
      const boss = bossOf(sp.id);
      return {
        ...battle.view(b, sp.name),
        no: sp.no, name: sp.name, blurb: sp.blurb, habitat: sp.habitat || 'none', habitatName: h?.name || '', habitatIcon: h?.icon || '',
        typeLabel: TYPES[sp.type]?.label || '', typeColor: TYPES[sp.type]?.color || '#888888',
        pixels: (sp.portrait || sp).pixels, palette: (sp.portrait || sp).palette,
        chip: { pixels: sp.pixels, palette: sp.palette }, // the desk sprite, for the chip under the tabs
        badge: boss ? { name: boss.badge.name, pixels: boss.badge.pixels, palette: boss.badge.palette } : null,
        tabId: meta.tabId && tabs.has(meta.tabId) ? meta.tabId : null, project: meta.project || '', source: meta.source || 'bash',
      };
    }).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** The battle screen asks the crab to play a sound (he has the speaker, and your sound settings). */
  function cue(name, opts = {}) {
    if (!BATTLE_CUES.has(name) || !d.critter) return;
    const sp = name === 'cry' ? speciesById(opts.species) : null;
    if (name === 'cry' && !sp) return;
    d.send(d.critter, 'critter:sound', sp ? { cue: 'cry', no: sp.no, type: sp.type, rarity: sp.rarity } : { cue: name });
  }

  /** The battle's ending: the fix's finishing blow, the jar, and the crew who helped get it on their record. */
  function endBattle(e, r, now, move) {
    const sp = speciesById(e.species);
    const was = battles.get(lifecycle.encId(e));
    // A squatter that was a zombie all along: the battle was with what it looked like.
    const reveal = was && was.species !== sp.id ? sp.name : null;
    fight(e, b => battle.finish(b, {
      at: now, outcome: 'caught', move,
      jar: { isNew: r.isNew, forms: r.forms, evolved: r.evolved, badge: r.badge, league: r.league, fame: r.fame, reveal, counted: r.counted },
    }));
    const party = battles.get(lifecycle.encId(e))?.party || [];
    if (r.counted && party.length) d.crewRoster?.beat?.(party.map(p => p.type), sp.type);
  }

  return { battles, battleOf, fight, fightAll, battleList, cue, endBattle };
}

module.exports = { makeBattles };
