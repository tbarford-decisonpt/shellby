/* Shellby panel — his life in the tank, moment to moment: he hides in the
   castle and peeks out, sits on the chest, climbs the driftwood, sleeps in his
   cave at night, nibbles the plants, opens the chest and peeks out of the
   ship's porthole. Each piece says where in it he can do what (its `spots`,
   validated in wardrobe/catalog.js); this picks one and says how he looks
   while he does it.

   Pure and cheap: tank.js calls it from the Tank tab's own 10 fps loop, which
   only runs while the tab is on screen, so none of this costs anything
   otherwise. Main keeps what lasts (his favourite, the sets on display):
   src/main/tank-life.js. Loaded by the panel and by test/tank-life-pick.test.js. */
'use strict';
(function () {
  // How long each one takes, in ms: [shortest, longest].
  const DURATION = Object.freeze({
    hide: [5000, 9000], sit: [4000, 8000], climb: [3200, 4200], sleep: [20000, 40000],
    nibble: [2500, 4500], open: [3000, 4000], peek: [3500, 6000], look: [2500, 3000],
  });
  const WANDER = 0.3;          // the chance he just ambles somewhere instead
  const FAVOURITE_WEIGHT = 3;  // his favourite comes up this many times as often
  const PEEK_ROWS = 4;         // how much of him shows while he peeks: his eye stalks
  const NIBBLE_HZ = 3;

  const between = ([a, b], rand) => Math.round(a + (b - a) * rand());

  /**
   * Every spot in the tank, where it is in the tank's art pixels. A flipped
   * piece has its spots flipped too. Floating pieces have none he can reach.
   */
  function spotsOf(pieces) {
    const out = [];
    for (const p of pieces || []) {
      if (p.layer === 'float' || !Array.isArray(p.spots)) continue;
      const top = p.y - p.h + 1;
      for (const s of p.spots) {
        const ax = p.flip ? p.w - 1 - s.at[0] : s.at[0];
        out.push({ kind: s.kind, uid: p.uid, name: p.name, x: p.x + ax, y: top + s.at[1], top, row: p.row });
      }
    }
    return out;
  }

  /**
   * What he does next. `rand` is injected so it's deterministic in tests.
   * opts: { spots, night, favourite (uid), news (uids he hasn't looked at yet),
   *         crabW, maxX, rand }
   * Returns { kind, uid, x (where he stands), spot, ms } or null to wander.
   */
  function pick({ spots = [], night = false, favourite = null, news = [], crabW = 22, maxX = 80, rand = Math.random }) {
    const at = s => Math.round(Math.min(maxX, Math.max(0, s.x - crabW / 2)));
    // Something new first: he goes and has a look.
    for (const uid of news) {
      const s = spots.find(x => x.uid === uid) || null;
      if (s) return { kind: 'look', uid, x: at(s), spot: s, ms: between(DURATION.look, rand) };
    }
    // At night he goes to bed, if there's somewhere to sleep.
    const beds = spots.filter(s => s.kind === 'sleep');
    if (night && beds.length) {
      const s = beds.find(b => b.uid === favourite) || beds[Math.min(beds.length - 1, Math.floor(rand() * beds.length))];
      return { kind: 'sleep', uid: s.uid, x: at(s), spot: s, ms: between(DURATION.sleep, rand) };
    }
    const awake = spots.filter(s => s.kind !== 'sleep');
    if (!awake.length || rand() < WANDER) return null;
    const pool = awake.flatMap(s => (s.uid === favourite ? Array(FAVOURITE_WEIGHT).fill(s) : [s]));
    const s = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    return { kind: s.kind, uid: s.uid, x: at(s), spot: s, ms: between(DURATION[s.kind] || DURATION.look, rand) };
  }

  /**
   * How he looks `t` ms into an activity: { lift (art px up from his row),
   * crop (rows of him that show, from the top; null for all of him),
   * hop, z (sleeping), face (1 right, -1 left, 0 as he was) }.
   * crabY is where his feet are; crabH how tall he is.
   */
  function pose(act, t, { crabY, crabH }) {
    const none = { lift: 0, crop: null, hop: 0, z: false, face: 0 };
    if (!act || !act.spot) return none;
    const f = Math.max(0, Math.min(1, t / act.ms));
    const s = act.spot;
    const onTop = crabY - s.y;                           // feet on the spot (below his row for a front-row piece)
    const front = s.row === 2;                           // ...and then he's drawn in front of that row
    const peekAt = crabY - crabH - s.y + PEEK_ROWS;      // the top of him just over the spot
    switch (act.kind) {
      case 'hide':
        // In he goes; a moment later, his eye stalks at the window.
        return f < 0.35 ? { ...none, crop: 0 } : { ...none, lift: peekAt, crop: PEEK_ROWS };
      case 'peek':
        return { ...none, lift: peekAt, crop: f < 0.15 || f > 0.9 ? PEEK_ROWS - 2 : PEEK_ROWS };
      case 'sit':
        return { ...none, lift: onTop, front };
      case 'climb': {
        // Up one side, down the other.
        const up = f < 0.5 ? f * 2 : (1 - f) * 2;
        return { ...none, lift: Math.round(onTop * up), face: f < 0.5 ? 1 : -1, front };
      }
      case 'sleep':
        // Tucked in, just the top of his shell showing, and z's.
        return { ...none, lift: peekAt, crop: PEEK_ROWS, z: f > 0.1 };
      case 'nibble':
        return { ...none, hop: Math.floor((t / 1000) * NIBBLE_HZ * 2) % 2 };
      case 'open':
        // Lifts the lid (a little hop), finds nothing, turns to look at you.
        return { ...none, hop: f < 0.3 ? 1 : 0, face: f > 0.6 ? -1 : 0 };
      case 'look':
        return { ...none, hop: f < 0.2 ? 2 : 0 };
      default:
        return none;
    }
  }

  /** The words for the live region: what he's up to. */
  function describe(act) {
    if (!act) return 'Shellby is pottering about.';
    const n = String(act.spot?.name || 'something').toLowerCase();
    return {
      hide: `Shellby is hiding in the ${n}.`, peek: `Shellby is peeking out of the ${n}.`,
      sit: `Shellby is sitting on the ${n}.`, climb: `Shellby is climbing the ${n}.`,
      sleep: `Shellby is asleep in the ${n}.`, nibble: `Shellby is nibbling the ${n}.`,
      open: `Shellby is looking inside the ${n}.`, look: `Shellby is having a look at the ${n}.`,
    }[act.kind] || 'Shellby is pottering about.';
  }

  /**
   * Moving day: where each piece is `t` ms after he's moved in. They hop
   * across one after another in a little arc, then he scuttles in last.
   * Returns { dy: uid -> art px up, crabIn (0..1: how far in he is) , done }.
   */
  const MOVE_HOP = 500, MOVE_GAP = 120, MOVE_ARC = 10;
  function moving(pieces, t) {
    const dy = new Map();
    const list = pieces || [];
    list.forEach((p, i) => {
      const f = (t - i * MOVE_GAP) / MOVE_HOP;
      dy.set(p.uid, f < 0 ? null : f >= 1 ? 0 : Math.round(Math.sin(Math.PI * f) * MOVE_ARC));
    });
    const crabStart = list.length * MOVE_GAP + MOVE_HOP;
    const crabIn = Math.max(0, Math.min(1, (t - crabStart) / 900));
    return { dy, crabIn, done: crabIn >= 1 };
  }

  const api = { DURATION, PEEK_ROWS, spotsOf, pick, pose, describe, moving };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else SB.tankLife = api;
})();
