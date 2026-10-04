// Shellby on the edges of your screen, the way Shimeji do it: he walks to the
// side, turns and climbs it, sometimes crosses the top upside down, and comes
// back by climbing down, leaping off or simply letting go. Thrown hard into a
// wall or the ceiling, he sticks to it. This is the pure part: which edges are
// walls, where his window goes for a spot on one, and the route he takes.
// climbing.js drives it; the renderer turns him (critter.css .surface-*).
//
// A spot on a surface is its contact: where his feet touch it, in DIPs, given
// as one number along the surface ("along": y on a wall, x on the floor or the
// ceiling). Turning him is a rotation of his body about the window's centre, so
// on each surface his feet sit at a fixed point in his window (footIn), and the
// window goes wherever puts that point on the contact.
const { stepStroll, GRIP_CLEAR } = require('./motion');

const SURFACES = Object.freeze(['floor', 'left', 'right', 'ceiling']);
const SETTINGS = Object.freeze(['off', 'sometimes', 'often']);
const CHANCE = Object.freeze({ off: 0, sometimes: 0.07, often: 0.2 });
const COOLDOWN = Object.freeze({ off: Infinity, sometimes: 4 * 60 * 1000, often: 90 * 1000 });
const KEEN = Object.freeze({ cocky: 1.3, chipper: 1.2, fussy: 0.7, sleepy: 0.6 });

const REACH = 700;          // he'll walk this far along the floor to a wall
const APPROACH_SPEED = 90;
const CLIMB_SPEED = 46;     // up a wall
const DESCEND_SPEED = 70;   // down one
const CEILING_SPEED = 34;   // upside down is slow going
const ON_FLOOR = 32;        // this close to the floor counts as on it (his default spot is 24 up)
const DROP_GRAB = 36;      // put down this close to a wall, he grabs it
const EDGE_SLACK = 3;
const LEAP = Object.freeze({ vx: 520, vy: -380 });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const settingOf = v => (SETTINGS.includes(v) ? v : 'sometimes');
const isWall = s => s === 'left' || s === 'right';

/** Is his window at pos standing on the floor of work area wa (near enough)? */
const onFloorAt = (pos, wa, g) => Math.abs(pos.y - (wa.y + wa.height - g.height)) <= ON_FLOOR;

/** The idle tick's roll of the dice, like perch.wantsToPerch. */
function wantsToClimb({ setting, temperament, sinceLast }, rand = Math.random) {
  const s = settingOf(setting);
  if (s === 'off' || sinceLast < COOLDOWN[s]) return false;
  return rand() < CHANCE[s] * (KEEN[temperament] || 1);
}

/**
 * Which edges of a display he can climb: { left, right, ceiling }. An edge
 * another screen carries on from is a doorway, not a wall. A taskbar along a
 * side is a wall of its own, whatever is beyond it.
 * disp, all: Electron displays ({ id, bounds, workArea }).
 */
function edgesOf(disp, all = []) {
  const b = disp.bounds, wa = disp.workArea;
  const others = all.filter(o => o && o.id !== disp.id).map(o => o.bounds);
  const near = (a, c) => Math.abs(a - c) <= EDGE_SLACK;
  const overlapsY = o => o.y < b.y + b.height && o.y + o.height > b.y;
  const overlapsX = o => o.x < b.x + b.width && o.x + o.width > b.x;
  return {
    left: wa.x > b.x + EDGE_SLACK || !others.some(o => overlapsY(o) && near(o.x + o.width, b.x)),
    right: wa.x + wa.width < b.x + b.width - EDGE_SLACK || !others.some(o => overlapsY(o) && near(o.x, b.x + b.width)),
    ceiling: wa.y > b.y + EDGE_SLACK || !others.some(o => overlapsX(o) && near(o.y + o.height, b.y)),
  };
}

/**
 * Where his feet are in his own window on each surface. g: { width, height,
 * foot } (foot: how far above the window's bottom edge his feet sit upright).
 * A rotation about the centre: 90° clockwise puts them on the left wall,
 * 90° anticlockwise on the right one, 180° on the ceiling.
 */
function footIn(surface, g) {
  const cx = g.width / 2, cy = g.height / 2, down = g.height / 2 - g.foot;
  if (surface === 'left') return { x: cx - down, y: cy };
  if (surface === 'right') return { x: cx + down, y: cy };
  if (surface === 'ceiling') return { x: cx, y: cy - down };
  return { x: cx, y: cy + down };
}

/**
 * The middle of his body in his own window on each surface (g.body: his
 * height). Turning him round in mid-air moves his window by the difference, so
 * he turns where he is rather than jumping across the screen (reorient).
 */
function centerIn(surface, g) {
  const cx = g.width / 2, cy = g.height / 2;
  const down = g.height / 2 - g.foot - g.body / 2;
  if (surface === 'left') return { x: cx - down, y: cy };
  if (surface === 'right') return { x: cx + down, y: cy };
  if (surface === 'ceiling') return { x: cx, y: cy - down };
  return { x: cx, y: cy + down };
}

/** His window, turned from one surface's pose to another's without his body moving. */
function reorient(pos, from, to, g) {
  const a = centerIn(from, g), b = centerIn(to, g);
  return { x: Math.round(pos.x + a.x - b.x), y: Math.round(pos.y + a.y - b.y) };
}

/** Where along a surface he is when his body (in `pose`) is at pos: for grabbing hold of it. */
function grabAlong(surface, pos, g, pose = 'floor') {
  const c = centerIn(pose, g);
  return isWall(surface) ? pos.y + c.y : pos.x + c.x;
}

/** The contact point for `along` on a surface of work area wa. */
function contactOf(surface, along, wa, g) {
  if (surface === 'left') return { x: wa.x, y: along };
  if (surface === 'right') return { x: wa.x + wa.width, y: along };
  if (surface === 'ceiling') return { x: along, y: wa.y };
  return { x: along, y: wa.y + wa.height - g.foot }; // the floor, where he's always stood
}

/** His window's top-left for a spot on a surface. */
function windowAt(surface, along, wa, g) {
  const c = contactOf(surface, along, wa, g);
  const f = footIn(surface, g);
  return { x: Math.round(c.x - f.x), y: Math.round(c.y - f.y) };
}

/** Where along a surface his window at pos puts him. */
function alongOf(surface, pos, g) {
  const f = footIn(surface, g);
  return isWall(surface) ? pos.y + f.y : pos.x + f.x;
}

/** How far along a surface he can go, keeping his whole body on it. g.half: half his width. */
function rangeOf(surface, wa, g) {
  const lo = isWall(surface) ? wa.y : wa.x;
  const len = isWall(surface) ? wa.height : wa.width;
  return { lo: lo + g.half, hi: lo + len - g.half };
}

/**
 * Which way his sprite faces to move `delta` along a surface. His body is
 * turned, so "forward" on the left wall is down the screen, on the right wall
 * up it, and on the ceiling leftward.
 */
function localDir(surface, delta) {
  const s = Math.sign(delta) || 1;
  if (surface === 'left') return s;
  if (surface === 'right' || surface === 'ceiling') return -s;
  return s;
}

/** Floor x at the foot of a wall, and that wall's lowest and highest spots. */
function cornerX(side, wa, g) {
  const r = rangeOf('floor', wa, g);
  return side === 'left' ? r.lo : r.hi;
}

/**
 * Which wall to go for from floor x `fromX`, or null: the nearer climbable
 * one within REACH (now and then the other, if it's in reach too).
 */
function chooseWall({ edges, wa, g, fromX }, rand = Math.random) {
  const options = ['left', 'right']
    .filter(side => edges[side])
    .map(side => ({ side, x: cornerX(side, wa, g), dist: Math.abs(cornerX(side, wa, g) - fromX) }))
    .filter(o => o.dist <= REACH)
    .sort((a, b) => a.dist - b.dist);
  if (!options.length) return null;
  return options.length > 1 && rand() < 0.2 ? options[1] : options[0];
}

const pause = (ms, bit) => ({ kind: 'pause', ms, bit });
const move = (surface, from, to, speed) => ({ kind: 'move', surface, from, to, speed });

/**
 * Everything he does from a spot on a wall until he's done with it: climb to
 * a height, look around, then come down one of four ways. `along` is where he
 * is now; `grabbed` means he got there by being thrown (a moment to recover).
 * Returns a list of legs for climbStep.
 */
function routeFrom({ side, along, edges, wa, g, grabbed = false }, rand = Math.random) {
  const wall = rangeOf(side, wa, g);
  const legs = grabbed ? [pause(900, 'grip')] : [];
  const bottom = wall.hi;
  const span = wall.hi - wall.lo;
  const roll = rand();
  const toCeiling = edges.ceiling && roll < 0.4;
  const top = toCeiling ? wall.lo : clamp(bottom - span * (0.3 + rand() * 0.45), wall.lo, wall.hi);
  if (Math.abs(top - along) > 4) legs.push(move(side, along, top, top < along ? CLIMB_SPEED : DESCEND_SPEED));
  legs.push(pause(1500 + rand() * 2200, 'peer'));
  if (toCeiling) {
    const roof = rangeOf('ceiling', wa, g);
    const from = side === 'left' ? roof.lo : roof.hi;
    const dist = 180 + rand() * 340;
    const to = clamp(from + (side === 'left' ? dist : -dist), roof.lo, roof.hi);
    legs.push(move('ceiling', from, to, CEILING_SPEED), pause(1400 + rand() * 1600, 'dangle'), { kind: 'end', how: 'drop' });
    return legs;
  }
  if (roll < 0.62) {
    legs.push({ kind: 'end', how: 'leap' });
    return legs;
  }
  const floorX = cornerX(side, wa, g);
  legs.push(move(side, top, bottom, DESCEND_SPEED), move('floor', floorX, floorX, APPROACH_SPEED), { kind: 'end', how: 'down' });
  return legs;
}

/** Thrown onto the ceiling: hang on, shuffle along a bit, then let go. */
function routeOnCeiling({ along, wa, g }, rand = Math.random) {
  const roof = rangeOf('ceiling', wa, g);
  const at = clamp(along, roof.lo, roof.hi);
  const dir = at - roof.lo < roof.hi - at ? 1 : -1; // toward the middle
  const to = clamp(at + dir * (120 + rand() * 260), roof.lo, roof.hi);
  return [pause(900, 'grip'), move('ceiling', at, to, CEILING_SPEED), pause(1200 + rand() * 1400, 'dangle'), { kind: 'end', how: 'drop' }];
}

/**
 * One frame along a route. s: { surface, along, legs, i, pauseUntil, moving }.
 * Returns { state, events, end } where events tell the renderer what changed:
 * { type: 'surface', surface }, { type: 'walk', dir }, { type: 'still' },
 * { type: 'bit', bit, ms }; and end is how the route finished, once it has.
 */
function climbStep(s, now, dtMs) {
  const leg = s.legs[s.i];
  if (!leg) return { state: s, events: [], end: 'down' };
  if (leg.kind === 'end') return { state: s, events: [], end: leg.how };
  if (leg.kind === 'pause') {
    if (!s.pauseUntil) {
      const events = [{ type: 'still' }, ...(leg.bit ? [{ type: 'bit', bit: leg.bit, ms: leg.ms }] : [])];
      return { state: { ...s, pauseUntil: now + leg.ms, moving: false }, events, end: null };
    }
    if (now < s.pauseUntil) return { state: s, events: [], end: null };
    return { state: { ...s, pauseUntil: 0, i: s.i + 1 }, events: [], end: null };
  }
  const turned = s.surface !== leg.surface;
  const from = turned ? leg.from : s.along;
  const r = stepStroll(from, leg.to, dtMs, leg.speed);
  const events = turned ? [{ type: 'surface', surface: leg.surface }] : [];
  if ((turned || !s.moving) && Math.abs(leg.to - from) > 1) events.push({ type: 'walk', dir: localDir(leg.surface, leg.to - from) });
  const next = { ...s, surface: leg.surface, along: r.x, moving: !r.done, i: r.done ? s.i + 1 : s.i };
  if (r.done && s.legs[next.i]?.kind !== 'move') events.push({ type: 'still' });
  return { state: next, events, end: null };
}

/** A fresh route state for climbStep. */
const startRoute = (surface, along, legs) => ({ surface, along, legs, i: 0, pauseUntil: 0, moving: false });

/** The push off a wall when he leaps: away from it, and up a little. */
function leapFrom(surface, rand = Math.random) {
  if (surface === 'ceiling') return { vx: (rand() - 0.5) * 200, vy: 40 };
  const away = surface === 'left' ? 1 : -1;
  return { vx: away * LEAP.vx * (0.8 + rand() * 0.4), vy: LEAP.vy * (0.8 + rand() * 0.4) };
}

/**
 * Put down (not thrown) at pos: is there a wall close enough to grab? Only
 * off the floor, and only a climbable side. Returns 'left', 'right' or null.
 */
function wallNear(pos, wa, g, edges) {
  const cx = pos.x + g.width / 2;
  const feetY = pos.y + g.height - g.foot;
  if (feetY > wa.y + wa.height - g.foot - GRIP_CLEAR) return null;
  if (edges.left && cx - g.half - wa.x <= DROP_GRAB) return 'left';
  if (edges.right && wa.x + wa.width - (cx + g.half) <= DROP_GRAB) return 'right';
  return null;
}

module.exports = {
  SURFACES, SETTINGS, REACH, APPROACH_SPEED, ON_FLOOR, onFloorAt,
  settingOf, wantsToClimb, edgesOf, footIn, centerIn, reorient, grabAlong, contactOf, windowAt, alongOf, rangeOf, localDir, cornerX,
  chooseWall, routeFrom, routeOnCeiling, climbStep, startRoute, leapFrom, wallNear, isWall,
};
