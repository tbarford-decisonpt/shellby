// Mischief: the cheeky crab, strictly opt-in. Desktop Goose made its name
// tugging the cursor and dragging notes onto the screen; Shellby is a polite
// crab, so his version is small, rare unless you ask for more, and never in
// the way: he pinches your cursor for half a second, gives the window he's
// sitting on a shove, leaves sandy footprints, and drags in a note for you.
// This is the pure part: whether he may, which prank, and the numbers for
// each one. pranks.js carries them out.
const LEVELS = Object.freeze(['off', 'cheeky', 'gremlin']);
const PRANKS = Object.freeze(['pinch', 'nudge', 'tracks', 'notes']);

const MINUTE = 60 * 1000;
// Time between pranks, picked fresh each time from [lo, hi].
const GAP = Object.freeze({ cheeky: [20 * MINUTE, 40 * MINUTE], gremlin: [4 * MINUTE, 9 * MINUTE] });
const FIRST = Object.freeze([90 * 1000, 4 * MINUTE]); // just switched on: soon, so you see what you turned on
const DAILY = Object.freeze({ cheeky: 6, gremlin: 30 });

const PINCH = Object.freeze({
  near: 150,     // the cursor within this many DIPs of his claw...
  lingerMs: 1200, // ...for this long, and he's tempted
  windupMs: 550,  // the look before the snap
  holdMs: 520,    // how long he hangs on
  tug: 44,        // how far he pulls it toward himself
  breakPx: 70,    // you yank it this far from where he's holding it: he lets go
});
const NUDGE = Object.freeze({ min: 24, max: 56, ms: 420, idleSec: 2 });
const NOTE = Object.freeze({ max: 3, walkSpeed: 70, haulSpeed: 42, offscreenMs: 1300 });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const levelOf = v => (LEVELS.includes(v) ? v : 'off');

/** Which pranks are switched on; anything not set is on. */
function prankSet(p) {
  const src = p && typeof p === 'object' ? p : {};
  return Object.fromEntries(PRANKS.map(k => [k, src[k] !== false]));
}

const dayOf = now => {
  const t = new Date(now);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/** The prank log: { day, count, next } with today's count. */
function logOf(log, now) {
  const src = log && typeof log === 'object' ? log : {};
  const day = dayOf(now);
  return {
    day,
    count: src.day === day && Number.isInteger(src.count) && src.count >= 0 ? src.count : 0,
    next: Number.isFinite(src.next) && src.next > 0 ? src.next : 0,
  };
}

/** Switched on (or Shellby started with it on): arm the first prank. */
function arm(log, now, rand = Math.random) {
  const l = logOf(log, now);
  if (l.next > now) return l;
  return { ...l, next: Math.round(now + FIRST[0] + rand() * (FIRST[1] - FIRST[0])) };
}

/** A prank happened: count it and pick when the next may. */
function played(log, level, now, rand = Math.random) {
  const l = logOf(log, now);
  const [lo, hi] = GAP[levelOf(level)] || GAP.cheeky;
  return { ...l, count: l.count + 1, next: Math.round(now + lo + rand() * (hi - lo)) };
}

/** Is it time, and is there any of today's allowance left? */
function due(log, level, now) {
  const lv = levelOf(level);
  if (lv === 'off') return false;
  const l = logOf(log, now);
  return l.next > 0 && now >= l.next && l.count < DAILY[lv];
}

/**
 * Why he must behave right now, or null when he needn't. Every one of these
 * is a moment a prank would be unwelcome rather than funny.
 */
function blocked(ctx) {
  if (levelOf(ctx.level) === 'off') return 'off';
  if (ctx.capture) return 'capture';
  if (ctx.guarding) return 'focus';
  if (ctx.onCall) return 'call';
  if (ctx.fullscreen) return 'fullscreen';
  if (ctx.locked) return 'locked';
  if (ctx.working) return 'working';
  if (ctx.asleep) return 'asleep';
  if (ctx.playing) return 'playing';
  if (ctx.dragging) return 'dragging';
  if (ctx.buttonsDown) return 'buttons';
  if (ctx.pausedUntil && ctx.pausedUntil > (ctx.now ?? Date.now())) return 'paused';
  return null;
}

/**
 * Which prank fits the moment, or null. ctx: { enabled (prankSet), cursorNear,
 * perched, onFloor, notesOut }. The cursor hanging about is the moment for a
 * pinch, so that's the likeliest when it's on offer.
 */
function choosePrank(ctx, rand = Math.random) {
  const on = ctx.enabled || prankSet(null);
  const options = [
    on.pinch && ctx.cursorNear && ['pinch', 4],
    on.nudge && ctx.perched && ['nudge', 3],
    on.notes && ctx.onFloor && (ctx.notesOut || 0) < NOTE.max && ['note', 2],
  ].filter(Boolean);
  const total = options.reduce((s, [, w]) => s + w, 0);
  if (!total) return null;
  let r = rand() * total;
  for (const [kind, w] of options) {
    r -= w;
    if (r < 0) return kind;
  }
  return options[options.length - 1][0];
}

/** Is the cursor within reach of his claw? Both in DIPs. */
const cursorNear = (cursor, claw) => !!cursor && !!claw && Math.hypot(cursor.x - claw.x, cursor.y - claw.y) <= PINCH.near;

/**
 * Where he holds the cursor u (0..1) of the way through a pinch: pulled from
 * where he caught it toward his claw, no further than PINCH.tug, eased out.
 */
function tugPoint(start, claw, u) {
  const dx = claw.x - start.x, dy = claw.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x: Math.round(start.x), y: Math.round(start.y) };
  const k = Math.min(1, PINCH.tug / dist) * (1 - (1 - clamp(u, 0, 1)) ** 3);
  return { x: Math.round(start.x + dx * k), y: Math.round(start.y + dy * k) };
}

/** You pulled away harder than he can hold. */
const yanked = (held, actual) => Math.hypot(actual.x - held.x, actual.y - held.y) > PINCH.breakPx;

/**
 * How far to shove the window he's on (DIPs, signed): `dir` if there's room,
 * else the other way, keeping it wholly inside its work area. 0 if it can't go.
 */
function nudgeFor(frame, wa, dir, rand = Math.random) {
  const want = NUDGE.min + rand() * (NUDGE.max - NUDGE.min);
  const room = d => (d > 0 ? wa.x + wa.width - (frame.x + frame.width) : frame.x - wa.x);
  for (const d of [dir || 1, -(dir || 1)]) {
    const r = Math.min(want, room(d));
    if (r >= NUDGE.min / 2) return Math.round(d * r);
  }
  return 0;
}

/** The shove over time: fast, with a little overshoot and settle. */
function shoveAt(u) {
  const t = clamp(u, 0, 1);
  const c = 1.6;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

// The notes he drags in. Short, in his voice, never about what's on your screen.
const NOTE_LINES = Object.freeze({
  any: [
    'i was here', 'snip snip', 'you looked lonely', 'drink some water', 'stretch your claws',
    'have you saved?', 'nice cursor. mine now', 'commit early, commit often', 'gone fishing. back soon',
    'i ate a semicolon', 'remember to blink', 'this is a crab note', 'roses are red. so am i',
    'the tide says hi', 'you are doing great', 'found this in the sand',
  ],
  late: ['go to bed', 'the moon is out', 'sleep is a feature', 'tomorrow-you says thanks'],
  morning: ['morning! coffee?', 'new day, new bugs', 'up and at it'],
  friday: ['it is friday', 'weekend is near', 'ship it, then sleep'],
});

/** A note for the moment: { text }. `recent` lines are skipped while there are others. */
function pickNote(now, rand = Math.random, recent = []) {
  const t = new Date(now);
  const h = t.getHours();
  const pool = [...NOTE_LINES.any];
  if (h >= 23 || h < 5) pool.push(...NOTE_LINES.late, ...NOTE_LINES.late);
  else if (h >= 5 && h < 10) pool.push(...NOTE_LINES.morning);
  if (t.getDay() === 5) pool.push(...NOTE_LINES.friday);
  const fresh = pool.filter(x => !recent.includes(x));
  const from = fresh.length ? fresh : pool;
  return { text: from[Math.floor(rand() * from.length) % from.length] };
}

module.exports = {
  LEVELS, PRANKS, PINCH, NUDGE, NOTE, DAILY, GAP,
  levelOf, prankSet, logOf, arm, played, due, blocked, choosePrank, cursorNear, tugPoint, yanked,
  nudgeFor, shoveAt, pickNote, NOTE_LINES,
};
