// What his pals get up to (src/main/floor.js). Pure, so test/colony.test.js
// runs it in node; floor.js in this folder draws whatever it decides.
//
// A pal is { id, name, hue, x, dir, mode, target, then, until }. With a
// target it's walking there (or scurrying, when there's work on); without one
// it's doing `mode` until `until`, then decides what's next. Everything is
// relative to Shellby: they wander near him, visit him for a chat, nap when he
// naps, bustle about while he works, and gather underneath when he's up a wall
// or on a window, looking up at him.
(function (root) {
  const WALK = 40;        // DIP/s
  const SCURRY = 105;
  const ROAM = 320;       // how far from him they wander
  const MIN_GAP = 30;     // pals keep at least this far apart (world.gap: their width, when known)
  const CLEAR = 22;       // ...and this far outside his body
  const EDGE = 16;        // and off the very ends of the strip
  const DUR = {
    idle: [1800, 5200], dig: [2400, 2400], wave: [1500, 1500], chat: [2600, 3400],
    cheer: [1700, 1700], look: [2400, 4200], sleep: [6000, 9000], oof: [1300, 1300], poked: [1100, 1100],
  };
  const STILL = new Set(Object.keys(DUR));

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const durOf = (mode, rand) => { const [lo, hi] = DUR[mode] || DUR.idle; return lo + rand() * (hi - lo); };

  /** The colony's first positions: a loose line either side of him. */
  function spawn(roster, world, rand = Math.random) {
    const s = world.shellby;
    const mid = s ? s.x : world.width / 2;
    const half = s ? s.half : 40;
    return roster.map((r, i) => {
      const side = i % 2 ? 1 : -1;
      const x = clamp(mid + side * (half + CLEAR + 24 + Math.floor(i / 2) * (Math.max(MIN_GAP, world.gap || 0) + 26)), EDGE, world.width - EDGE);
      return { ...r, x, dir: -side, mode: 'idle', target: null, then: null, until: 0 + rand() * 1500 };
    });
  }

  /**
   * Keep a spot clear of his body and of the other pals, and on the strip: the
   * spot asked for if it's free, else the nearest free one (just past either end
   * of him or of a pal). If there's none at all, his body still wins: a pal may
   * end up close to a friend, never in him.
   */
  function clear(x, pal, pals, world) {
    const lo = EDGE, hi = world.width - EDGE;
    const gap = Math.max(MIN_GAP, world.gap || 0); // a pal's own width and a bit, at whatever size they are
    const s = world.shellby;
    const keep = s && s.floor ? s.half + CLEAR : 0;
    const others = pals.filter(o => o.id !== pal.id).map(o => o.target ?? o.x);
    const inHim = t => keep > 0 && Math.abs(t - s.x) < keep;
    const free = t => t >= lo && t <= hi && !inHim(t) && others.every(ox => Math.abs(t - ox) >= gap);
    const want = clamp(x, lo, hi);
    if (free(want)) return want;
    const spots = [lo, hi, ...(keep ? [s.x - keep, s.x + keep] : []), ...others.flatMap(ox => [ox - gap, ox + gap])].filter(free);
    if (spots.length) return spots.reduce((best, t) => (Math.abs(t - want) < Math.abs(best - want) ? t : best));
    if (!inHim(want)) return want;
    const side = want < s.x ? -1 : 1;
    const out = s.x + side * keep;
    return clamp(out >= lo && out <= hi ? out : s.x - side * keep, lo, hi); // no room that side: the other
  }

  const go = (pal, x, then, now, fast = false) => ({ ...pal, target: x, then, speed: fast ? SCURRY : WALK, mode: fast ? 'scurry' : 'walk', dir: Math.sign(x - pal.x) || pal.dir, until: now });
  const doing = (pal, mode, now, rand) => ({ ...pal, target: null, then: null, mode, until: now + durOf(mode, rand) });

  /** A pal with nothing to do picks something. */
  function decide(pal, pals, world, now, rand) {
    const s = world.shellby;
    const near = (spread, min = 0) => {
      const mid = s ? s.x : world.width / 2;
      const side = rand() < 0.5 ? -1 : 1;
      return clear(mid + side * ((s ? s.half : 0) + CLEAR + min + rand() * spread), pal, pals, world);
    };
    if (!s) return rand() < 0.4 ? go(pal, clear(pal.x + (rand() - 0.5) * 200, pal, pals, world), 'idle', now) : doing(pal, 'idle', now, rand);
    if (s.state === 'sleeping') {
      // Curl up near him.
      if (Math.abs(pal.x - s.x) > s.half + CLEAR + 140) return go(pal, near(110), 'sleep', now);
      return doing(pal, 'sleep', now, rand);
    }
    if (s.away) {
      // He's up a wall or on a window: gather underneath and look up.
      if (Math.abs(pal.x - s.x) > s.half + CLEAR + 110) return go(pal, near(90), 'look', now);
      return doing(pal, rand() < 0.5 ? 'look' : 'wave', now, rand);
    }
    if (s.state === 'working' || s.state === 'asking') {
      // Bustling about, fetching and carrying for the job.
      return rand() < 0.7 ? go(pal, near(170), rand() < 0.5 ? 'dig' : 'idle', now, true) : doing(pal, 'dig', now, rand);
    }
    const r = rand();
    if (r < 0.36) return go(pal, clear(s.x + (rand() - 0.5) * 2 * ROAM, pal, pals, world), 'idle', now);
    if (r < 0.5) return doing(pal, 'dig', now, rand);
    if (r < 0.6) return doing(pal, 'wave', now, rand);
    if (r < 0.76) return go(pal, near(10), 'chat', now); // over for a chat with him
    return doing(pal, 'idle', now, rand);
  }

  function move(pal, dt) {
    const step = (pal.speed || WALK) * dt / 1000;
    const d = pal.target - pal.x;
    if (Math.abs(d) <= step) return { ...pal, x: pal.target, target: null, arrived: true };
    return { ...pal, x: pal.x + Math.sign(d) * step, dir: Math.sign(d) };
  }

  /** One tick for the whole colony: world = { width, shellby: { x, floor, away, state, half } | null }. */
  function tick(pals, world, now, dt, rand = Math.random) {
    let out = pals;
    for (let i = 0; i < out.length; i++) {
      let p = out[i];
      if (p.target != null) {
        p = move(p, Math.min(dt, 200));
        if (p.arrived) {
          const { arrived: _arrived, ...rest } = p;
          p = doing(rest, rest.then || 'idle', now, rand);
          // Face him for a chat or a look up; otherwise whichever way they came.
          if (world.shellby && (p.mode === 'chat' || p.mode === 'look' || p.mode === 'sleep')) p = { ...p, dir: Math.sign(world.shellby.x - p.x) || p.dir };
        }
      } else if (now >= p.until || !STILL.has(p.mode)) {
        p = decide(p, out, world, now, rand);
      }
      if (p !== out[i]) out = [...out.slice(0, i), p, ...out.slice(i + 1)];
    }
    return out;
  }

  /** Something happened that they all react to. */
  function react(pals, kind, world, now, rand = Math.random) {
    if (kind === 'success') return pals.map(p => doing(p, 'cheer', now + rand() * 250, rand));
    if (kind === 'error') return pals.map(p => doing(p, 'oof', now, rand));
    if (kind === 'landed' && world.shellby) {
      // He came down with a thump: they scatter, then wander back in their own time.
      return pals.map(p => {
        const away = Math.sign(p.x - world.shellby.x) || 1;
        return go(p, clear(p.x + away * (60 + rand() * 80), p, pals, world), 'idle', now, true);
      });
    }
    return pals;
  }

  /** You clicked one. */
  function poke(pals, id, now, rand = Math.random) {
    return pals.map(p => (p.id === id ? doing(p, 'poked', now, rand) : p));
  }

  root.ShellbyColony = { spawn, tick, react, poke, WALK, SCURRY, GAP: MIN_GAP, CLEAR };
  if (typeof module !== 'undefined') module.exports = root.ShellbyColony;
})(typeof window !== 'undefined' ? window : globalThis);
