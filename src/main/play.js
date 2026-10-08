// Games with him. Hide and seek: he burrows into the sand and pops up somewhere
// behind your windows (he lives on the wallpaper, so that's a real hiding
// place), peeks out now and then as a hint, and gives up if you take too long.
// Fetch: throw a pebble across the screen and he scuttles after it.
//
// The rules are pure (callers pass `now` and `rand`); src/main/playtime.js runs
// the games with real windows. See test/play.test.js.

const SECOND = 1000;

const HIDE = Object.freeze({
  countMs: 3000,                          // "close your eyes!" before he burrows
  hints: Object.freeze([40 * SECOND, 80 * SECOND, 115 * SECOND]),
  giveUpMs: 150 * SECOND,                 // ...then he comes out on his own: he wins
  peekMs: 1600,                           // how long a hint keeps him above your windows
  margin: 24,                             // stay this far inside a window's edges
  minAway: 260,                           // and at least this far from where he started
});

const FETCH = Object.freeze({
  runSpeed: 190,                          // DIP/s: a crab after a pebble is a fast crab
  homeSpeed: 110,                         // ...and a proud, slower one coming back
  boredMs: 90 * SECOND,                   // nobody's thrown it for a while: game over
  size: 44,                               // the pebble's window, DIP
});

const area = r => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Where to hide. Prefers a spot fully behind one of your windows (so he's
 * really hidden), bigger windows likelier; with nothing open he picks the far
 * corner of the screen instead. Positions are the critter window's top-left.
 *   windows: [{ rect: { left, top, right, bottom } }] visible app windows
 *   work:    { x, y, width, height } the screen's work area
 *   size:    { width, height } of his window
 *   home:    { x, y } where he is now
 * Returns { x, y, covered }.
 */
function chooseHideSpot({ windows = [], work, size, home }, rand = Math.random) {
  const m = HIDE.margin;
  const inWork = r => ({
    left: Math.max(r.left, work.x), top: Math.max(r.top, work.y),
    right: Math.min(r.right, work.x + work.width), bottom: Math.min(r.bottom, work.y + work.height),
  });
  const roomy = windows
    .map(w => inWork(w.rect || {}))
    .filter(r => r.right - r.left >= size.width + 2 * m && r.bottom - r.top >= size.height + 2 * m);
  // Spots inside each window, far enough from where he started.
  const spots = [];
  for (const r of roomy) {
    for (let i = 0; i < 6; i++) {
      const x = Math.round(r.left + m + rand() * (r.right - r.left - size.width - 2 * m));
      const y = Math.round(r.top + m + rand() * (r.bottom - r.top - size.height - 2 * m));
      if (!home || Math.hypot(x - home.x, y - home.y) >= HIDE.minAway) spots.push({ x, y, weight: area(r) });
    }
  }
  if (spots.length) {
    const sum = spots.reduce((n, s) => n + s.weight, 0);
    let r = rand() * sum;
    for (const s of spots) { r -= s.weight; if (r < 0) return { x: s.x, y: s.y, covered: true }; }
    const s = spots[spots.length - 1];
    return { x: s.x, y: s.y, covered: true };
  }
  // Nothing to hide behind: the corner furthest from him.
  const corners = [
    { x: work.x, y: work.y }, { x: work.x + work.width - size.width, y: work.y },
    { x: work.x, y: work.y + work.height - size.height }, { x: work.x + work.width - size.width, y: work.y + work.height - size.height },
  ];
  const from = home || { x: work.x + work.width / 2, y: work.y + work.height / 2 };
  corners.sort((a, b) => Math.hypot(b.x - from.x, b.y - from.y) - Math.hypot(a.x - from.x, a.y - from.y));
  return { ...corners[0], covered: false };
}

/**
 * What happens next in a game of hide and seek, given how long he's been hidden:
 * { hint: index } for a peek, 'giveup' when he's had enough, or null.
 *   game: { hiddenAt, hints: number of hints given }
 */
function hideStep(game, now) {
  if (!game?.hiddenAt) return null;
  const t = now - game.hiddenAt;
  if (t >= HIDE.giveUpMs) return 'giveup';
  const given = game.hints || 0;
  if (given < HIDE.hints.length && t >= HIDE.hints[given]) return { hint: given };
  return null;
}

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const n = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    hide: { games: n(r.hide?.games), found: n(r.hide?.found), won: n(r.hide?.won), best: n(r.hide?.best) },
    fetch: { throws: n(r.fetch?.throws), fetched: n(r.fetch?.fetched), longest: n(r.fetch?.longest) },
  };
}

/**
 * A game of hide and seek ended. `foundMs` is how long you took, or null when
 * he gave up waiting. Returns { state, best } — best is true for a new record.
 */
function hideResult(stateIn, foundMs) {
  const s = normalize(stateIn);
  const games = s.hide.games + 1;
  if (foundMs == null) return { state: { ...s, hide: { ...s.hide, games, won: s.hide.won + 1 } }, best: false };
  const ms = Math.max(0, Math.round(foundMs));
  const best = !s.hide.best || ms < s.hide.best;
  return { state: { ...s, hide: { ...s.hide, games, found: s.hide.found + 1, best: best ? ms : s.hide.best } }, best };
}

/** He brought the pebble back. `distance` is how far it went, DIP. */
function fetchResult(stateIn, distance) {
  const s = normalize(stateIn);
  const d = Math.max(0, Math.round(Number(distance) || 0));
  return { state: { ...s, fetch: { throws: s.fetch.throws + 1, fetched: s.fetch.fetched + 1, longest: Math.max(s.fetch.longest, d) } }, longest: d > s.fetch.longest };
}

/** Where his window should stand to pick up something lying at `toyX` (both left edges). */
function pickupX(toyX, { critterWidth, toySize, box }) {
  // His claw is near the right of his own slot: stand so the pebble lands just in front of him.
  const x = toyX - critterWidth + toySize + 10;
  return clamp(Math.round(x), box.minX, box.maxX);
}

module.exports = { HIDE, FETCH, chooseHideSpot, hideStep, normalize, hideResult, fetchResult, pickupX };
