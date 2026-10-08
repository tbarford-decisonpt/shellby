// The beach (Shellby's screen → Beach): a scene that only grows. Every project
// you've shipped is a sandcastle, built bigger as its sticker goes up a tier
// (stickers.js); your streak is the tide, and the best one you've had leaves a
// high-water line of seaweed that never goes back out (streaks.js); his finds
// wash up along it (gifts.js); projects you're working on but haven't shipped
// are plots with a bucket and spade waiting for a castle. Past them all, once
// Claude has fixed a bug or two, a rock pool where the Bugdex's catches swim
// (bugdex.js).
//
// Everything here is laid out in "art pixels" (one unit is one pixel of the
// scene), so the renderer only paints (src/renderer/panel/beach-paint.js).
// Castles come out as colour roles, not colours, so the same castle can stand
// at dawn or under the moon:
//   s sand   S shaded sand   d doorway   w window (lit when the project is live)
//   p flagpole   f its flag   g a gold flag (one-point-oh)
//   k wood   i iron   b bucket   B bucket rim
//
// Pure: no I/O, no clock (callers pass `now`). See test/beach.test.js.

const stickers = require('./stickers');
const streaks = require('./streaks');
const gifts = require('./gifts');
const bugdex = require('./bugdex');
const moon = require('./moon');

const HEIGHT = 100;            // the scene, top of the sky to the front of the sand
const SEA_TOP = 36;            // the horizon
const SHORE = 50;              // where the sea meets the sand at low tide
const ROWS = Object.freeze([77, 95]); // castle baselines: further up the beach, nearer you
const MIN_WIDTH = 120;         // a beach is never narrower than this, even empty (the panel shows more)
const START = 14;              // sand before the first castle
const CRAB_ROOM = 34;          // the spot beside the newest castle where he sits
const TAIL = 26;               // sand after the last thing on it
const MAX_PLOTS = 8;
// The tide pool: its water grows a pixel wider with each kind of bug caught,
// from 4 to 12, with a rim of rock round it. Swimmers are 3×3 specks.
const POOL_MIN = 4, POOL_MAX = 12, POOL_RIM = 1, POOL_GAP = 4;
const POOL_Y = 87;             // its baseline, between the castle rows
const MAX_SWIMMERS = 8, SPECK = 3;

// The tide comes further up the sand the longer the streak, quickly at first,
// then more slowly: a week is most of the way, a month nearly all of it.
const TIDE_MIN = 3, TIDE_MAX = 13, TIDE_EASE = 12;
const tideDepth = days => Math.round(TIDE_MIN + (TIDE_MAX - TIDE_MIN) * (1 - Math.exp(-Math.max(0, days) / TIDE_EASE)));

// One shape per sticker tier. [x, width, height] blocks on a grid this wide;
// towers stand on (and in front of) the keep. Heights vary a little per castle.
const SHAPES = Object.freeze({
  paper: { name: 'Sandcastle', keep: [2, 7, 5], towers: [[4, 3, 9]], door: 1 },
  vinyl: { name: 'Tower house', keep: [2, 11, 6], towers: [[1, 3, 10], [11, 3, 10]], door: 3 },
  holo: { name: 'Keep', keep: [3, 15, 8], towers: [[1, 4, 12], [16, 4, 12], [8, 5, 16]], door: 3, keepWindows: true },
  foil: { name: 'Citadel', wall: [1, 25, 6], keep: [6, 15, 11], towers: [[0, 4, 13], [23, 4, 13], [6, 3, 16], [18, 3, 16], [11, 5, 21]], door: 3, keepWindows: true },
});
const SHAPE_ORDER = ['paper', 'vinyl', 'holo', 'foil'];
const FLAGS = Object.freeze(['#ff7a5c', '#7fd6c2', '#ffc15e', '#ff8fab', '#9fc4ff', '#b9a6ff', '#8fe388']);

// A plot: the first course of a wall going up, with the bucket and spade left in it.
const PLOT_ART = Object.freeze(['..........kk', '...........k', '.BBB.......k', '.bbb.s.s.s.i', '.bbb.ssssSsi', 'SSSSSSSSSSSS']);
const STAKE_ART = Object.freeze(['.ff.', '.fff', '.p..', '.p..', 'SSS.']);

// ------------------------------------------------------------------ seeded art

/** A small deterministic generator, so a castle looks the same every time. */
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drop empty rows above and empty columns either side. */
function trim(rows) {
  const lines = rows.map(r => r.join(''));
  const top = lines.findIndex(l => /[^.]/.test(l));
  const kept = lines.slice(Math.max(0, top));
  const used = i => kept.some(l => l[i] !== '.');
  let left = 0, right = kept[0].length - 1;
  while (left < right && !used(left)) left++;
  while (right > left && !used(right)) right--;
  return kept.map(l => l.slice(left, right + 1));
}

/**
 * A castle for a project: its tier sets the size, its id everything else
 * (tower heights, roofs, the flag's colour), and its marks the trimmings:
 * live → lit windows, release → a flag on every tower, v1 → a gold one on top.
 */
function castleArt(id, tierId, marks = []) {
  const shape = SHAPES[tierId] || SHAPES.paper;
  const rand = seeded(String(id));
  const has = new Set(marks);
  const tallest = Math.max(...shape.towers.map(t => t[2]));
  const W = Math.max(...[shape.keep, shape.wall, ...shape.towers].filter(Boolean).map(([x, w]) => x + w)) + 6;
  const H = tallest + 2 + 5; // room for a taller tower and its flag
  const grid = Array.from({ length: H }, () => Array(W).fill('.'));
  const ground = H - 1;
  const set = (x, y, ch) => { if (y >= 0 && y < H && x >= 0 && x < W) grid[y][x] = ch; };
  const OX = 1; // a column of sand for the mound's lip

  // A block of packed sand, shaded on its right and crenellated on top.
  function block(bx, bw, bh, { crenel = true } = {}) {
    const top = ground - bh;
    for (let y = top; y < ground; y++) {
      for (let x = bx; x < bx + bw; x++) {
        const gap = crenel && y === top && (x - bx) % 2 === 1;
        if (gap) continue;
        set(OX + x, y, x === bx + bw - 1 || rand() < 0.07 ? 'S' : 's');
      }
    }
    return top;
  }

  if (shape.wall) block(...shape.wall);
  const [kx, kw, kh] = shape.keep;
  const keepTop = block(kx, kw, kh);

  const tops = shape.towers.map(([tx, tw, th]) => {
    const h = th + Math.floor(rand() * 3) - 1;
    const cone = tw >= 3 && rand() < 0.4;
    if (!cone) return { tx, tw, top: block(tx, tw, h) };
    // A pointed roof: the body, then rows narrowing to a point.
    const rows = Math.ceil(tw / 2);
    const bodyTop = block(tx, tw, h - rows, { crenel: false });
    for (let j = 0; j < rows; j++) {
      for (let x = tx + j; x < tx + tw - j; x++) set(OX + x, bodyTop - 1 - j, x >= tx + tw / 2 ? 'S' : 's');
    }
    return { tx, tw, top: bodyTop - rows, cone: true, bodyTop };
  });

  // Windows down each tower (every fourth row, clear of the keep), then the keep's own.
  for (const t of tops) {
    const cx = OX + t.tx + Math.floor((t.tw - 1) / 2);
    for (let y = (t.bodyTop ?? t.top) + 2; y < keepTop - 1; y += 4) set(cx, y, 'w');
    if (shape.towers.length === 1) set(cx, (t.bodyTop ?? t.top) + 2, 'w');
  }
  if (shape.keepWindows) for (let x = kx + 2; x < kx + kw - 2; x += 3) set(OX + x, keepTop + 2, 'w');

  // The door, an arch in the middle of the keep.
  const mid = OX + kx + Math.floor(kw / 2);
  if (shape.door === 1) { set(mid, ground - 1, 'd'); set(mid, ground - 2, 'd'); } else {
    for (let y = ground - 3; y < ground; y++) for (let x = mid - 1; x <= mid + 1; x++) if (y > ground - 3 || x === mid) set(x, y, 'd');
  }

  // Flags: the tallest tower always, every tower once it's released.
  const top = tops.reduce((a, b) => (b.top < a.top ? b : a));
  for (const t of tops) {
    if (t !== top && !has.has('release')) continue;
    const px = OX + t.tx + Math.floor((t.tw - 1) / 2);
    const pole = t === top ? 3 : 2;
    for (let i = 1; i <= pole; i++) set(px, t.top - i, 'p');
    const ch = t === top && has.has('v1') ? 'g' : 'f';
    const fy = t.top - pole;
    set(px + 1, fy, ch); set(px + 2, fy, ch); set(px + 1, fy + 1, ch);
    if (t === top) { set(px + 3, fy, ch); set(px + 2, fy + 1, ch); }
  }

  // The mound it all stands on.
  let minX = W, maxX = 0;
  for (let y = 0; y < ground; y++) for (let x = 0; x < W; x++) if (grid[y][x] !== '.') { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  for (let x = Math.max(0, minX - 1); x <= Math.min(W - 1, maxX + 1); x++) set(x, ground, 'S');

  return {
    pixels: trim(grid),
    flag: FLAGS[Math.floor(rand() * FLAGS.length)],
    lit: has.has('live'),
  };
}

// ------------------------------------------------------------------ state

/** What's been seen (so new castles can rise as you watch) and the best tide. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tiers = {};
  for (const [id, t] of Object.entries(r.tiers && typeof r.tiers === 'object' ? r.tiers : {})) {
    if (/^[0-9a-f]{12}$/.test(id) && SHAPE_ORDER.includes(t)) tiers[id] = t;
  }
  return {
    seenAt: Number.isFinite(r.seenAt) && r.seenAt > 0 ? r.seenAt : 0,
    tiers,
    highWater: Number.isInteger(r.highWater) && r.highWater > 0 ? Math.min(r.highWater, 100000) : 0,
  };
}

/** The high-water mark only ever goes up: the longest streak in the days kept, or better. */
function observe(stateIn, longest) {
  const s = normalize(stateIn);
  return longest > s.highWater ? { ...s, highWater: longest } : s;
}

/** You've looked: everything there now stops being new. */
function markSeen(stateIn, castles, now) {
  const s = normalize(stateIn);
  return { ...s, seenAt: now, tiers: Object.fromEntries(castles.map(c => [c.id, c.tier])) };
}

// ------------------------------------------------------------------ layout

/**
 * Lay things along two rows, left to right: each new one starts a little past
 * the last (so the rows overlap like a town) but never on top of its own row.
 */
function placer(x0) {
  const ends = [x0, x0];
  let cursor = x0;
  return (w, row) => {
    const x = Math.max(cursor, ends[row]);
    ends[row] = x + w + 3;
    cursor = x + Math.ceil(w * 0.55) + 2;
    return x;
  };
}

/** Projects worked in lately that haven't shipped: plots waiting for a castle. */
function plotsOf(streakState, projects) {
  const roots = new Set(projects.map(p => (p.root || '').toLowerCase()).filter(Boolean));
  return Object.entries(streakState.projects)
    .filter(([key]) => !roots.has(key.toLowerCase()))
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .slice(0, MAX_PLOTS)
    .map(([key, p]) => ({ key, name: p.name, lastSeen: p.lastSeen }));
}

/**
 * Where the finds wash up: spread along the wrack line in the sand between the
 * castles, a find's width apart so none hides another. When one line fills up
 * they wash up just above it, then just below; only past that do they pile up.
 */
const FIND_GAP = 9; // the widest find is 8 pixels
function placeFinds(owned, width, line, taken) {
  if (!owned.length) return [];
  const blocked = x => taken.some(([a, b]) => x + FIND_GAP - 1 > a && x - 1 < b);
  let free = [];
  for (let x = 4; x < width - 10; x++) if (!blocked(x)) free.push(x);
  if (free.length < FIND_GAP) free = Array.from({ length: Math.max(1, width - 14) }, (_, i) => i + 4);
  const after = x => { const i = free.findIndex(f => f >= x); return i < 0 ? free.length : i; };
  const lanes = [line + 2, line - 1, line + 4].map(y => ({ y, next: 0 }));
  const step = free.length / owned.length;
  return owned.map((f, i) => {
    const rand = seeded(f.id);
    const want = Math.floor(i * step + rand() * Math.max(0, step - FIND_GAP));
    for (const lane of lanes) {
      const k = Math.max(want, lane.next);
      if (k >= free.length) continue;
      lane.next = after(free[k] + FIND_GAP);
      return { ...f, x: free[k], y: lane.y };
    }
    return { ...f, x: free[Math.min(free.length - 1, want)], y: lanes[0].y, piled: true };
  });
}
const overflow = finds => finds.filter(f => f.piled).length;

/**
 * The tide pool, starting at x: the water sized by the kinds caught, and the
 * newest of them swimming in it, each in a spot of its own while there's room
 * (a lane of 3-pixel slots, and a second one below once the first is full),
 * then wherever its id puts it. y is the pool's baseline, like a castle's.
 */
function placePool(bugState, x) {
  const swim = bugdex.poolOf(bugState, MAX_SWIMMERS);
  if (!swim.length) return null;
  const kinds = Math.max(bugdex.summary(bugState).caught, swim.length);
  const water = Math.max(POOL_MIN, Math.min(POOL_MAX, POOL_MIN + kinds - 1));
  const perLane = Math.floor(water / SPECK);
  const lanes = swim.length > perLane ? 2 : 1;
  const deep = lanes * (SPECK + 1);
  const w = water + POOL_RIM * 2, h = deep + POOL_RIM * 2;
  const top = POOL_Y - h;
  const order = seeded(swim.map(s => s.id).join(','));
  const slots = [];
  for (let lane = 0; lane < lanes; lane++) for (let i = 0; i < perLane; i++) slots.push([i * SPECK, lane * (SPECK + 1)]);
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(order() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  const swimmers = swim.map((s, i) => {
    const rand = seeded(s.id);
    const [sx, sy] = slots[i] || [Math.floor(rand() * (water - SPECK + 1)), Math.floor(rand() * (deep - SPECK + 1))];
    return { id: s.id, name: s.name, x: x + POOL_RIM + sx, y: top + POOL_RIM + sy, pixels: s.pixels, palette: s.palette };
  });
  return { x, y: POOL_Y, w, h, water: { x: x + POOL_RIM, y: top + POOL_RIM, w: water, h: deep }, kinds, swimmers };
}

/**
 * The whole beach. stickerState: stickers.normalize(); streakState:
 * streaks.normalize(); findState: gifts.normalize(); bugState: the Bugdex's
 * (anything; bugdex.normalize cleans it); state: this module's.
 */
function view({ stickerState, streakState, findState, bugState = null, state: stateIn, now }) {
  const state = normalize(stateIn);
  const since = state.seenAt;
  const own = Object.values(stickerState.projects).filter(p => !p.from).sort((a, b) => a.firstShipAt - b.firstShipAt || a.id.localeCompare(b.id));
  const place = placer(START);

  const castles = own.map((p, i) => {
    const tier = stickers.tierFor(p.ships).id;
    const art = castleArt(p.id, tier, p.marks);
    const row = i % 2;
    const w = art.pixels[0].length, h = art.pixels.length;
    const x = place(w, row);
    const next = stickers.nextTier(p.ships);
    const seenTier = state.tiers[p.id];
    return {
      id: p.id, name: p.name, x, y: ROWS[row] + (seeded(p.id)() < 0.5 ? 0 : 1), w, h, row,
      tier, kind: SHAPES[tier].name, flag: art.flag, lit: art.lit, pixels: art.pixels,
      ships: p.ships, deploys: p.deploys, releases: p.releases, merges: p.merges, version: p.lastVersion,
      firstShipAt: p.firstShipAt, lastShipAt: p.lastShipAt,
      marks: stickers.MARKS.filter(m => p.marks.includes(m.id)).map(({ id, name, icon }) => ({ id, name, icon })),
      next: next ? { kind: SHAPES[next.id].name, left: next.left } : null,
      isNew: since > 0 && p.firstShipAt > since,
      grew: !!seenTier && SHAPE_ORDER.indexOf(tier) > SHAPE_ORDER.indexOf(seenTier),
    };
  });

  // He sits beside the newest castle; plots are the building site past him.
  const crab = { x: place(CRAB_ROOM - 8, 1) + 4, y: ROWS[1] + 1 };
  const plots = plotsOf(streakState, own).map((p, i) => {
    const row = i % 2 ? 1 : 0;
    return { ...p, x: place(PLOT_ART[0].length + 2, row), y: ROWS[row], w: PLOT_ART[0].length, h: PLOT_ART.length };
  });
  const stake = castles.length ? null : { x: START + 6, y: ROWS[0], w: STAKE_ART[0].length, h: STAKE_ART.length };
  const ends = [...castles, ...plots, crab].map(o => o.x + (o.w || CRAB_ROOM - 8));
  // The tide pool sits past everything else on the sand, so it's never in front of a castle.
  const pool = placePool(bugState, Math.max(0, ...ends) + POOL_GAP);
  let width = Math.max(MIN_WIDTH, Math.max(0, ...ends, pool ? pool.x + pool.w : 0) + TAIL);

  const run = streaks.streakOf(streakState, now);
  const best = Math.max(state.highWater, run.longest);
  const tide = {
    current: run.current, best, today: run.today, worked: streakState.days.length,
    wet: tideDepth(run.current), mark: tideDepth(best),
  };

  const ownedFinds = Object.entries(findState.items)
    .map(([id, it]) => ({ f: gifts.findById(id), it }))
    .filter(x => x.f)
    .sort((a, b) => a.it.first - b.it.first || a.f.id.localeCompare(b.f.id))
    .map(({ f, it }) => ({
      id: f.id, name: f.name, rarity: f.rarity, blurb: f.blurb, pixels: f.pixels, palette: f.palette,
      count: it.n, first: it.first, isNew: since > 0 && it.first > since,
    }));
  // Only what stands tall enough to hide the wrack line takes room on it; if
  // it's still full, the beach grows open sand past the last castle for them.
  const line = SHORE + tide.mark;
  const taken = castles.filter(c => c.y - c.h < line + 5).map(c => [c.x, c.x + c.w]);
  let finds = placeFinds(ownedFinds, width, line, taken);
  for (let more = overflow(finds), tries = 0; more > 0 && tries < 20; more = overflow(finds), tries++) {
    width += Math.ceil(more / 3) * FIND_GAP + FIND_GAP;
    finds = placeFinds(ownedFinds, width, line, taken);
  }

  const bugs = bugdex.normalize(bugState);
  const tonight = moon.phase(now);
  const newBugs = since > 0 ? Object.values(bugs.species).filter(e => bugdex.caughtOf(e) > 0 && e.first > since).length : 0;

  return {
    world: { width, height: HEIGHT, seaTop: SEA_TOP, shore: SHORE, rows: ROWS },
    castles, plots, stake, crab, finds, tide, pool,
    art: { plot: PLOT_ART, stake: STAKE_ART },
    stats: {
      castles: castles.length,
      ships: castles.reduce((n, c) => n + c.ships, 0),
      finds: finds.length,
      plots: plots.length,
      bugs: pool ? pool.kinds : 0,
      since: castles.length ? castles[0].firstShipAt : null,
    },
    news: castles.filter(c => c.isNew || c.grew).length + finds.filter(f => f.isNew).length + newBugs,
    firstVisit: since === 0,
    // The real moon tonight (moon.js): the night sky shows its phase.
    moon: { fraction: Math.round(tonight.fraction * 1000) / 1000, name: tonight.name },
  };
}

module.exports = {
  HEIGHT, SEA_TOP, SHORE, ROWS, MIN_WIDTH, SHAPES, PLOT_ART, STAKE_ART,
  tideDepth, castleArt, normalize, observe, markSeen, view,
};
