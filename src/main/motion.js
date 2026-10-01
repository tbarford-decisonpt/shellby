// Shellby on the move: thrown crabs fly, bounce and land on the taskbar, and an
// idle crab sometimes takes a short sideways stroll near his spot. Positions
// are the critter window's top-left in DIPs, speeds in DIP/s, time in ms.
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
 * One physics step. body: { x, y, vx, vy }; box: { minX, maxX, minY, floorY }.
 * Returns { body, landed, bounced } (a new body; the old one is untouched).
 */
function stepFlight(body, dtMs, box) {
  const dt = dtMs / 1000;
  let { x, y, vx, vy } = body;
  vy += GRAVITY * dt;
  x += vx * dt;
  y += vy * dt;
  let bounced = false;
  if (x < box.minX) { x = box.minX; vx = Math.abs(vx) * WALL_BOUNCE; bounced = true; }
  if (x > box.maxX) { x = box.maxX; vx = -Math.abs(vx) * WALL_BOUNCE; bounced = true; }
  if (y < box.minY) { y = box.minY; vy = Math.abs(vy) * WALL_BOUNCE; }
  let landed = false;
  if (y >= box.floorY) {
    y = box.floorY;
    if (vy > 160) { vy = -vy * FLOOR_BOUNCE; vx *= FLOOR_FRICTION; bounced = true; } else { vy = 0; vx *= 0.85; }
    landed = vy === 0 && Math.abs(vx) < 30;
  }
  return { body: { x, y, vx, vy }, landed, bounced };
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

/** Move x toward target at STROLL_SPEED. { x, done }. */
function stepStroll(x, target, dtMs) {
  const step = STROLL_SPEED * dtMs / 1000;
  if (Math.abs(target - x) <= step) return { x: target, done: true };
  return { x: x + Math.sign(target - x) * step, done: false };
}

/**
 * Drives the critter window. Callbacks:
 *   getPos() -> { x, y }, place(x, y), box() -> { minX, maxX, minY, floorY },
 *   onState('flying' | 'landed' | 'walking' | null, info?), onSettled(kind)
 * Timers are injectable for tests.
 */
class CritterMotion {
  constructor({ getPos, place, box, onState = () => {}, onSettled = () => {}, setTimer = setInterval, clearTimer = clearInterval, now = () => Date.now() }) {
    Object.assign(this, { getPos, place, box, onState, onSettled, setTimer, clearTimer, now });
    this.timer = null;
    this.kind = null; // 'flight' | 'stroll'
  }

  get busy() { return !!this.kind; }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const was = this.kind;
    this.kind = null;
    if (was) this.onState(null);
    return was;
  }

  /** Let go of a drag. Returns true when it was a throw (now flying). */
  release(samples) {
    const v = releaseVelocity(samples);
    if (!isThrow(v)) return false;
    this.stop();
    const p = this.getPos();
    let body = { x: p.x, y: p.y, ...v };
    let last = this.now();
    const started = last;
    this.kind = 'flight';
    this.onState('flying', { vx: v.vx });
    this.timer = this.setTimer(() => {
      const t = this.now();
      const r = stepFlight(body, Math.min(40, t - last), this.box());
      last = t;
      body = r.body;
      this.place(Math.round(body.x), Math.round(body.y));
      if (r.landed || t - started > MAX_FLIGHT_MS) {
        this.stop();
        this.onState('landed');
        this.onSettled('flight');
      }
    }, FRAME_MS);
    return true;
  }

  /** Take a short stroll from where he is, staying near homeX. */
  stroll(homeX, rand) {
    if (this.kind) return false;
    const p = this.getPos();
    const target = planStroll(p.x, homeX, this.box(), rand);
    if (target == null) return false;
    let x = p.x;
    let last = this.now();
    this.kind = 'stroll';
    this.onState('walking', { dir: Math.sign(target - x) });
    this.timer = this.setTimer(() => {
      const t = this.now();
      const r = stepStroll(x, target, Math.min(60, t - last));
      last = t;
      x = r.x;
      this.place(Math.round(x), p.y);
      if (r.done) { this.stop(); this.onSettled('stroll'); }
    }, 50);
    return true;
  }
}

module.exports = { releaseVelocity, isThrow, stepFlight, planStroll, stepStroll, CritterMotion, MIN_THROW, STROLL_RANGE };
