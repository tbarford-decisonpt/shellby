// Climbing the edges of the screen, wired up: he walks to the side of the
// screen, turns, climbs it, maybe crosses the top upside down, and comes back
// down by climbing, leaping or letting go. A hard throw into a wall or the
// ceiling sticks, and so does putting him down right beside one. The judgement
// and the geometry are in climb.js (pure, tested); this drives the motion
// engine (motion.js) and tells the critter window which way up he is.
//
// He stays on the desktop layer the whole time, like on the floor: your apps
// still cover him, so he never climbs over anything you're looking at.
const climb = require('./climb');

// Every edge of his screen is a wall, as it already is to a throw (motion.js
// bounces off them): a neighbouring monitor's bezel is still the side of this one.
const ALL_EDGES = Object.freeze({ left: true, right: true, ceiling: true });

/**
 * deps: {
 *   motion(), screen, config, capture, geo() -> { width, height, foot, half, body },
 *   getPos(), place(x, y), temperament(), speak(occasion, opts), stat(event, payload),
 *   toRenderer(kind, info), surface(name), bit(name, ms), dragging(), crew(),
 *   perchingAway(), walkHome(),
 *   wanders() -> whether he goes off on his own (motion.js wanders; config wander without it)
 * }
 */
function createClimbing(d) {
  let route = null;     // climb.startRoute state while he's on a wall or the ceiling
  let pending = null;   // { side }: walking along the floor to the foot of a wall
  let lastEnd = Date.now(); // so he doesn't head straight for a wall at startup

  const setting = () => climb.settingOf(d.config.get('climb'));
  const wanders = () => (d.wanders ? d.wanders() : d.config.get('wander') !== false);
  const allowed = () => !d.capture && setting() !== 'off' && wanders() && d.crew() === 0;
  const display = () => {
    const p = d.getPos(), g = d.geo();
    return d.screen.getDisplayNearestPoint({ x: Math.round(p.x + g.width / 2), y: Math.round(p.y + g.height / 2) });
  };
  const area = () => display().workArea;
  const edges = () => ALL_EDGES;

  function onFloor() {
    return climb.onFloorAt(d.getPos(), area(), d.geo());
  }

  // ---------------------------------------------------------------- going up

  /** Head for a wall now (side: 'left' | 'right', or the nearer one). */
  function tryClimb({ side = null } = {}) {
    const motion = d.motion();
    if (!allowed() || route || pending || motion.busy || d.dragging() || d.perchingAway() || !onFloor()) return false;
    const wa = area(), g = d.geo(), e = edges();
    const fromX = d.getPos().x + g.width / 2;
    const wall = side ? (e[side] ? { side, x: climb.cornerX(side, wa, g) } : null) : climb.chooseWall({ edges: e, wa, g, fromX });
    if (!wall) return false;
    pending = { side: wall.side };
    const to = climb.windowAt('floor', wall.x, wa, g);
    d.speak('climb');
    if (!motion.walkTo(to.x, climb.APPROACH_SPEED, { kind: 'climb-approach' })) atTheWall();
    return true;
  }

  /** The idle tick's roll of the dice. */
  function maybeClimb() {
    if (!allowed() || route || pending) return false;
    const want = climb.wantsToClimb({ setting: setting(), temperament: d.temperament(), sinceLast: Date.now() - lastEnd });
    return want && tryClimb();
  }

  function atTheWall() {
    const side = pending?.side;
    pending = null;
    if (!side || !allowed()) return;
    const wa = area(), g = d.geo();
    const along = climb.rangeOf(side, wa, g).hi;
    begin('floor', along, climb.routeFrom({ side, along, edges: edges(), wa, g }));
    d.stat('climbed', { side });
  }

  // ---------------------------------------------------------------- on the wall

  function begin(surface, along, legs) {
    route = climb.startRoute(surface, along, legs);
    if (surface !== 'floor') d.surface(surface);
    d.motion().ride(frame);
  }

  // One frame of climbing, run by motion.ride().
  function frame(dt, now) {
    if (!route) return null;
    const r = climb.climbStep(route, now, Math.min(60, dt));
    route = r.state;
    for (const e of r.events) {
      if (e.type === 'surface') d.surface(e.surface);
      else if (e.type === 'walk') d.toRenderer('walking', { dir: e.dir, speed: 40 });
      else if (e.type === 'still') d.toRenderer('still', {});
      else if (e.type === 'bit') d.bit(e.bit, Math.round(e.ms));
    }
    if (r.end) return finish(r.end);
    const g = d.geo();
    return { place: climb.windowAt(route.surface, route.along, area(), g), calm: !route.moving && !!route.pauseUntil };
  }

  // The route's done: down the way it says. A leap or a drop is a flight, which
  // perching.js already knows how to land and walk home from.
  function finish(how) {
    const was = route;
    route = null;
    lastEnd = Date.now();
    const g = d.geo();
    if (how === 'down') {
      d.motion().halt();
      d.surface('floor');
      d.walkHome();
      return null;
    }
    const at = climb.reorient(d.getPos(), was.surface, 'floor', g);
    d.place(at.x, at.y);
    d.surface('floor');
    if (how === 'leap') {
      d.speak('leap');
      d.stat('wall-leap');
      return { launch: { ...climb.leapFrom(was.surface), style: 'tumble', why: 'leap' } };
    }
    d.speak('letgo');
    return { launch: { vx: 0, vy: 40, style: 'fall', why: 'letgo' } };
  }

  /** Come down now (asked to, or helpers need the room): he lets go. */
  function leave() {
    if (pending) {
      // Still on his way over: he just stops where he is, on the floor.
      pending = null;
      d.motion().halt();
      return true;
    }
    if (!route) return false;
    route = { ...route, legs: [{ kind: 'end', how: 'drop' }], i: 0, pauseUntil: 0 };
    return true;
  }

  // ---------------------------------------------------------------- grabbing hold

  /** The edges a throw can stick to right now, for motion.js. */
  function grips() {
    if (!allowed() || d.perchingAway()) return null;
    return edges();
  }

  /** Stuck to a wall or the ceiling by a throw, or put down right beside a wall. */
  function grab(surface, { how }) {
    const wa = area(), g = d.geo(), e = edges();
    const along = climb.grabAlong(surface, d.getPos(), g);
    const range = climb.rangeOf(surface, wa, g);
    const at = Math.min(Math.max(along, range.lo), range.hi);
    const legs = surface === 'ceiling'
      ? climb.routeOnCeiling({ along: at, wa, g })
      : climb.routeFrom({ side: surface, along: at, edges: e, wa, g, grabbed: true });
    begin(surface, at, legs); // the first frame puts his window on the wall
    d.speak(how === 'thrown' ? 'stuck' : 'climb', { force: how === 'thrown' });
    d.stat(how === 'thrown' ? 'stuck-to-wall' : 'climbed', { side: surface });
    return true;
  }

  /** Put down without a throw: onto a wall if he's right beside one. */
  function dropped() {
    if (!allowed()) return false;
    const side = climb.wallNear(d.getPos(), area(), d.geo(), edges());
    return side ? grab(side, { how: 'dropped' }) : false;
  }

  // ---------------------------------------------------------------- what main tells us

  /** A move finished. True when it was ours to deal with. */
  function onSettled(kind, info = {}) {
    // Called off on the way (pending gone): an ordinary walk that main settles.
    if (kind === 'climb-approach') { if (!pending) return false; atTheWall(); return true; }
    // Helpers turned up mid-flight: his window's wider now, so an ordinary landing.
    if (kind === 'flight' && info.wall && allowed()) {
      if (info.why === 'thrown') d.stat('thrown');
      return grab(info.wall, { how: 'thrown' });
    }
    return false;
  }

  /** Picked up (or put back by a reset): off the wall and upright, and you have him. */
  function grabbed() {
    const was = route || pending;
    route = null;
    pending = null;
    if (was) { lastEnd = Date.now(); d.surface('floor'); }
  }

  /**
   * Someone else stopped the motion mid-climb (a setting, say). Upright on
   * the spot would leave him hanging in mid-air, so he lets go and falls.
   */
  function onInterrupted() {
    const was = route;
    grabbed();
    if (!was || was.surface === 'floor') return;
    const at = climb.reorient(d.getPos(), was.surface, 'floor', d.geo());
    d.place(at.x, at.y);
    // After whoever stopped him has finished, so this flight isn't cut short too.
    setImmediate(() => { if (!d.dragging() && !d.motion().busy) d.motion().launch({ vx: 0, vy: 40 }, { style: 'fall', why: 'letgo' }); });
  }

  function menuItems() {
    if (route) return [{ label: 'Come down', click: leave }];
    if (!allowed() || d.perchingAway() || !onFloor()) return [];
    const e = edges();
    return [{ label: 'Climb the wall', enabled: e.left || e.right, click: () => tryClimb() }];
  }

  const isAway = () => !!route;
  const busy = () => !!route || !!pending;
  const view = () => ({
    surface: route?.surface || 'floor', along: route ? Math.round(route.along) : null,
    leg: route ? route.legs[route.i]?.kind || null : null, pending: pending?.side || null,
    edges: edges(), workArea: area(), allowed: allowed(),
  });

  return { tryClimb, maybeClimb, leave, grips, dropped, onSettled, onInterrupted, grabbed, menuItems, isAway, busy, view };
}

module.exports = { createClimbing };
