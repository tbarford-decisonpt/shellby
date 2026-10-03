// Shellby on the move: thrown crabs fly, bounce and land on the taskbar (or
// catch a window's title bar on the way down), an idle crab sometimes takes a
// short sideways stroll near his spot, and he hops up onto windows and rides
// them (see perch.js). Positions are the critter window's top-left in DIPs,
// speeds in DIP/s, time in ms.
// The physics is pure; CritterMotion drives a window through injected
// callbacks, so tests run it without Electron (test/motion.test.js).

const GRAVITY = 2600;          // DIP/s²
const FLOOR_BOUNCE = 0.42;     // vertical speed kept on hitting the floor
const WALL_BOUNCE = 0.5;       // horizontal speed kept on hitting a screen edge
const FLOOR_FRICTION = 0.7;    // horizontal speed kept per floor bounce
const MIN_THROW = 900;         // release speed that counts as a throw
const MAX_SPEED = 3600;
const SAMPLE_MS = 90;          // release velocity is measured over the last ~90 ms of the drag
const MAX_FLIGHT_MS = 4000;
const FRAME_MS = 16;
const CALM_MS = 100;           // a ride with nothing moving (see ride())

const STROLL_SPEED = 38;       // a crab's amble
const STROLL_RANGE = 140;      // never strays further than this from his spot
const STROLL_MIN = 30;
const STROLL_MAX = 110;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Speed at release from drag samples [{ x, y, t }] (oldest first). { vx, vy } in DIP/s. */
function releaseVelocity(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  const first = samples.find(s => last.t - s.t <= SAMPLE_MS) || samples[0];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0.005) return { vx: 0, vy: 0 };
  const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  const k = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
  return { vx: vx * k, vy: vy * k };
}

const isThrow = v => Math.hypot(v.vx, v.vy) >= MIN_THROW;

/**
 * One physics step. body: { x, y, vx, vy }; box: { minX, maxX, minY, floorY,
 * ledges? }. A ledge ({ id, x1, x2, y }, in window coordinates) is a title bar:
 * falling onto one from above, he grabs it and lands there.
 * Returns { body, landed, bounced, ledge } (a new body; the old one is untouched).
 */
function stepFlight(body, dtMs, box) {
  const dt = dtMs / 1000;
  let { x, y, vx, vy } = body;
  const fromY = y;
  vy += GRAVITY * dt;
  x += vx * dt;
  y += vy * dt;
  let bounced = false;
  if (x < box.minX) { x = box.minX; vx = Math.abs(vx) * WALL_BOUNCE; bounced = true; }
  if (x > box.maxX) { x = box.maxX; vx = -Math.abs(vx) * WALL_BOUNCE; bounced = true; }
  if (y < box.minY) { y = box.minY; vy = Math.abs(vy) * WALL_BOUNCE; }
  if (vy > 0) {
    const ledge = (box.ledges || []).find(l => fromY <= l.y && y >= l.y && x >= l.x1 && x <= l.x2 && l.y < box.floorY);
    if (ledge) return { body: { x, y: ledge.y, vx: 0, vy: 0 }, landed: true, bounced: false, ledge: ledge.id };
  }
  let landed = false;
  if (y >= box.floorY) {
    y = box.floorY;
    if (vy > 160) { vy = -vy * FLOOR_BOUNCE; vx *= FLOOR_FRICTION; bounced = true; } else { vy = 0; vx *= 0.85; }
    landed = vy === 0 && Math.abs(vx) < 30;
  }
  return { body: { x, y, vx, vy }, landed, bounced, ledge: null };
}

/**
 * Where an idle stroll goes: a short step left or right, kept within
 * STROLL_RANGE of his own spot and on screen. null when there's no room.
 */
function planStroll(x, homeX, box, rand = Math.random) {
  const lo = Math.max(box.minX, homeX - STROLL_RANGE);
  const hi = Math.min(box.maxX, homeX + STROLL_RANGE);
  if (hi - lo < STROLL_MIN) return null;
  const dist = STROLL_MIN + rand() * (STROLL_MAX - STROLL_MIN);
  // Drift back toward his spot more often than away from it.
  const towardHome = Math.sign(homeX - x) || (rand() < 0.5 ? -1 : 1);
  const dir = rand() < 0.65 ? towardHome : -towardHome;
  let target = clamp(x + dir * dist, lo, hi);
  if (Math.abs(target - x) < STROLL_MIN) target = clamp(x - dir * dist, lo, hi);
  return Math.abs(target - x) < STROLL_MIN ? null : Math.round(target);
}

/** Move x toward target at speed (a stroll by default). { x, done }. */
function stepStroll(x, target, dtMs, speed = STROLL_SPEED) {
  const step = speed * dtMs / 1000;
  if (Math.abs(target - x) <= step) return { x: target, done: true };
  return { x: x + Math.sign(target - x) * step, done: false };
}

/**
 * Drives the critter window. Callbacks:
 *   getPos() -> { x, y }, place(x, y), box() -> { minX, maxX, minY, floorY },
 *   ledges() -> [{ id, x1, x2, y }] (read once per flight; see perch.js),
 *   onState(kind | null, info?), onSettled(kind, info?),
 *   onInterrupted(kind): someone else called stop() mid-move.
 * Kinds: 'flight', 'stroll' (also walkTo), 'hop', 'ride'. Timers are injectable for tests.
 */
class CritterMotion {
  constructor({ getPos, place, box, ledges = () => [], onState = () => {}, onSettled = () => {}, onInterrupted = () => {}, setTimer = setInterval, clearTimer = clearInterval, now = () => Date.now() }) {
    Object.assign(this, { getPos, place, box, ledges, onState, onSettled, onInterrupted, setTimer, clearTimer, now });
    this.timer = null;
    this.kind = null;
  }

  get busy() { return !!this.kind; }

  // Ends the current move. halt() is the move ending itself; stop() is someone
  // else cutting in, which whoever started a ride needs to hear about.
  halt() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const was = this.kind;
    this.kind = null;
    if (was) this.onState(null);
    return was;
  }

  stop() {
    const was = this.halt();
    if (was) this.onInterrupted(was);
    return was;
  }

  // Calls fn(dtMs, now) every `every` ms until something halts it.
  run(kind, every, fn) {
    let last = this.now();
    this.kind = kind;
    this.timer = this.setTimer(() => {
      const t = this.now();
      const dt = t - last;
      last = t;
      fn(dt, t);
    }, every);
  }

  /** Let go of a drag. Returns true when it was a throw (now flying). */
  release(samples) {
    const v = releaseVelocity(samples);
    if (!isThrow(v)) return false;
    this.stop();
    this.launch(v, { style: 'tumble', why: 'thrown' });
    return true;
  }

  /**
   * Fly from where he is with velocity { vx, vy }. He lands on the floor or
   * catches a ledge; onSettled('flight', { ledge, style, why, dizzy }) says which.
   */
  launch(v, { style = 'tumble', why = 'thrown', dizzy = false } = {}) {
    this.halt();
    const p = this.getPos();
    let body = { x: p.x, y: p.y, vx: v.vx, vy: v.vy };
    const ledges = this.ledges() || [];
    const started = this.now();
    this.onState('flying', { vx: v.vx, style });
    this.run('flight', FRAME_MS, (dt, t) => {
      const r = stepFlight(body, Math.min(40, dt), { ...this.box(), ledges });
      body = r.body;
      this.place(Math.round(body.x), Math.round(body.y));
      if (r.landed || t - started > MAX_FLIGHT_MS) {
        this.halt();
        this.onState('landed', { ledge: r.ledge, dizzy });
        this.onSettled('flight', { ledge: r.ledge, style, why, dizzy });
      }
    });
  }

  /**
   * A hop onto a target that may be moving: target() -> { x, y } each frame,
   * or null if it vanished (he falls from wherever he's got to). A crouch
   * first, then the arc; path(from, to, t) and ms come from perch.js.
   */
  // hop() and ride() hand over from whatever move came before (a perch to a
  // hop down, a hop to the ride), so they halt it rather than interrupt it.
  hop(target, { path, ms, crouchMs = 260, flip = false, onLand = () => {} }) {
    this.halt();
    const from = this.getPos();
    const first = target();
    if (!first) return false;
    this.onState('crouch', { vx: first.x - from.x });
    const crouched = this.now();
    let began = null;
    let prev = { ...from, t: crouched };
    this.run('hop', FRAME_MS, (_dt, t) => {
      if (began === null) {
        if (t - crouched < crouchMs) return;
        began = t;
        this.onState('hopping', { vx: first.x - from.x, flip, ms });
      }
      const to = target();
      const at = this.getPos();
      if (!to) {
        // The window went while he was in the air: nothing to land on.
        const dt = Math.max(0.016, (t - prev.t) / 1000);
        this.launch({ vx: (at.x - prev.x) / dt, vy: (at.y - prev.y) / dt }, { style: 'fall', why: 'missed' });
        return;
      }
      const u = (t - began) / ms;
      const p = u >= 1 ? to : path(from, to, u);
      prev = { ...at, t };
      this.place(p.x, p.y);
      if (u >= 1) {
        this.halt();
        this.onState('landed', {});
        this.onSettled('hop');
        onLand();
      }
    });
    return true;
  }

  /**
   * Hand the window to step(dtMs, now) every frame. It returns { place } to
   * move him, { launch: { vx, vy, style, why, dizzy } } to send him flying, or nothing.
   */
  ride(step) {
    this.halt();
    let at = this.getPos();
    let calm = false;
    const frame = (dt, t) => {
      const r = step(dt, t) || {};
      // Sitting still is most of a perch: don't move the window to where it already is.
      if (r.place && (r.place.x !== at.x || r.place.y !== at.y)) {
        at = r.place;
        this.place(r.place.x, r.place.y);
      }
      if (r.launch) return this.launch(r.launch, r.launch);
      // ...and don't wake up 60 times a second to watch nothing happen: the
      // step says when he's settled, and the first frame it isn't, it's 60 again.
      if (!!r.calm !== calm && this.kind === 'ride') {
        calm = !!r.calm;
        this.clearTimer(this.timer);
        this.run('ride', calm ? CALM_MS : FRAME_MS, frame);
      }
    };
    this.run('ride', FRAME_MS, frame);
  }

  /** Walk straight to x at `speed` (DIP/s), staying at his current height. */
  walkTo(target, speed = STROLL_SPEED, { kind = 'walk' } = {}) {
    if (this.kind) return false;
    const p = this.getPos();
    if (Math.abs(target - p.x) < 2) return false;
    let x = p.x;
    this.onState('walking', { dir: Math.sign(target - x), speed });
    this.run('stroll', 50, dt => {
      const r = stepStroll(x, target, Math.min(60, dt), speed);
      x = r.x;
      this.place(Math.round(x), p.y);
      if (r.done) { this.halt(); this.onSettled(kind); }
    });
    return true;
  }

  /** Take a short stroll from where he is, staying near homeX. */
  stroll(homeX, rand) {
    if (this.kind) return false;
    const p = this.getPos();
    const target = planStroll(p.x, homeX, this.box(), rand);
    if (target == null) return false;
    return this.walkTo(target, STROLL_SPEED, { kind: 'stroll' });
  }
}

module.exports = { releaseVelocity, isThrow, stepFlight, planStroll, stepStroll, CritterMotion, MIN_THROW, STROLL_RANGE, STROLL_SPEED, GRAVITY };
