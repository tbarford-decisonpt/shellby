// A classic script that shares critter.js's top-level scope (critter.html
// loads it right after critter.js). How he looks on the move, perched, up a
// wall, and his idle habits (bits).
/* global api:writable, clampN:writable, flags:writable, paintBody:writable, root:writable, setDir:writable */

// ---- on the move: thrown, landing, strolling, and up on your windows. Main
// moves the window (src/main/motion.js, perching.js); this is how he looks
// while it does: one body class per beat, all of it in critter.css.
const MOTION_FLAGS = [
  'flying', 'fly-left', 'fly-fall', 'fly-fling', 'fly-pop', 'landed', 'walking', 'walk-left',
  'eyeing', 'crouch', 'hopping', 'hop-flip', 'cling', 'scramble', 'coyote', 'wheee', 'windy', 'hauling',
];
const FLY_STYLES = new Set(['fall', 'fling', 'pop']); // 'tumble' is the plain throw
const DIZZY_MS = 2600;
const WHEEE_MS = 1800;
const BOUNCE_HARD = 2500;  // DIP/s: a bump this fast or faster is as loud as a bump gets
const AMBLE = 38;          // DIP/s: his walking pace when a walk doesn't say (motion.js STROLL_SPEED)
let landedTimer = null;
let dizzyTimer = null;
let wheeeTimer = null;
const dustHost = document.getElementById('dust');


// Riding a window that's moving: lean back against it, and the faster it goes
// the harder the wind streams past.
function setLean(vx) {
  const v = clampN(vx, -4000, 4000);
  const wind = clampN(Math.abs(v) / 1400, 0, 1);
  root.setProperty('--lean', `${clampN(-v / 90, -16, 16).toFixed(1)}deg`);
  root.setProperty('--wind', wind.toFixed(2));
  root.setProperty('--wdir', v < 0 ? '-1' : '1');
  if (wind > 0.15) flags.add('windy'); else flags.delete('windy');
}

// A puff of dust where his feet touch down.
function puff(n = 7) {
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i');
    const side = i % 2 ? 1 : -1;
    const spread = 6 + (i * 37 % 19);
    el.style.setProperty('--dx', `${side * spread * 1.6}px`);
    el.style.setProperty('--dy', `${-4 - (i * 23 % 11)}px`);
    el.style.animationDelay = `${i * 12}ms`;
    dustHost.append(el);
    setTimeout(() => el.remove(), 800);
  }
}

function dizzy(ms = DIZZY_MS) {
  clearTimeout(dizzyTimer);
  flags.add('dizzy');
  paintBody();
  dizzyTimer = setTimeout(() => { flags.delete('dizzy'); paintBody(); }, clampN(ms, 600, 6000));
}

// A move takes over his body, so whatever little habit he was in the middle of stops.
// While he burrows, claws full of sand go flying out behind him.
const GRAIN_EVERY_MS = 140;
let grainTimer = null;
function kickSand() {
  const dir = getComputedStyle(document.documentElement).getPropertyValue('--dir').trim() === '-1' ? -1 : 1;
  for (let i = 0; i < 2; i++) {
    const el = document.createElement('i');
    el.className = 'grain';
    el.style.setProperty('--dx', `${-dir * (14 + Math.random() * 18)}px`);
    el.style.setProperty('--dy', `${-(10 + Math.random() * 14)}px`);
    el.style.animationDelay = `${i * 40}ms`;
    dustHost.append(el);
    setTimeout(() => el.remove(), 700);
  }
}
function digSand(on) {
  clearInterval(grainTimer);
  grainTimer = null;
  if (on && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) grainTimer = setInterval(kickSand, GRAIN_EVERY_MS);
}

function endBit() {
  digSand(false);
  clearTimeout(bitTimer);
  if (bit) flags.delete(`bit-${bit}`);
  bit = null;
}

api.onMotion(msg => {
  const { kind, vx = 0 } = msg || {};
  // Beats that layer on top of whatever he's doing rather than replacing it.
  if (kind === 'lean') { setLean(vx); paintBody(); return; }
  if (kind === 'bounce') { window.ShellbySound.cue('bounce', { hit: msg.hit, strength: msg.speed / BOUNCE_HARD }); return; }
  if (kind === 'dizzy') { dizzy(msg.ms); return; }
  if (kind === 'wheee') {
    clearTimeout(wheeeTimer);
    flags.add('wheee');
    wheeeTimer = setTimeout(() => { flags.delete('wheee'); paintBody(); }, WHEEE_MS);
    paintBody();
    return;
  }
  for (const f of MOTION_FLAGS) flags.delete(f);
  clearTimeout(landedTimer);
  // Hauling a prank along is walking too, just backwards. His feet go quiet the moment he stops.
  window.ShellbySound.scuttle(kind === 'walking' || kind === 'hauling' ? msg.speed || AMBLE : 0);
  if (kind !== 'perched' && kind !== null) endBit();
  if (kind !== 'cling') setLean(0);
  if (kind === 'flying') {
    flags.add('flying');
    if (vx < 0) flags.add('fly-left');
    if (FLY_STYLES.has(msg.style)) flags.add(`fly-${msg.style}`);
    setDir(vx);
  }
  if (kind === 'walking') { flags.add('walking'); if (msg.dir < 0) flags.add('walk-left'); setDir(msg.dir); }
  // Mischief: walking backwards, hauling a note in by its corner (src/main/pranks.js).
  if (kind === 'hauling') { flags.add('walking'); flags.add('hauling'); setDir(msg.dir); }
  // 'still' (a pause on a wall) is just the absence of all the above.
  if (kind === 'eyeing') { flags.add('eyeing'); setDir(msg.dx); }
  if (kind === 'crouch') { flags.add('crouch'); setDir(vx); }
  if (kind === 'hopping') {
    flags.add('hopping');
    if (msg.flip) flags.add('hop-flip');
    root.setProperty('--hop-ms', `${clampN(msg.ms, 200, 2000)}ms`);
    setDir(vx);
    window.ShellbySound.cue('hop');
  }
  if (kind === 'landed') {
    flags.add('landed');
    puff();
    landedTimer = setTimeout(() => { flags.delete('landed'); paintBody(); }, 700);
    if (msg.dizzy) dizzy();
    window.ShellbySound.cue('land', { strength: msg.dizzy ? 1 : 0.4 });
  }
  if (kind === 'cling') flags.add('cling');
  if (kind === 'scramble') flags.add('scramble');
  if (kind === 'coyote') flags.add('coyote');
  paintBody();
});

// ---- up on a window. Perched, everything but the crab himself lets the mouse
// through to the title bar under him, so main needs to know when the pointer
// is over him (the moves are forwarded even while the window ignores clicks).
// Kept on top of your apps, his window lets the mouse through on the floor too.
let perched = false;
let through = false;
let overMe = false;
const setOver = over => { if (over !== overMe) { overMe = over; api.hit(over); } };
api.onPerch(msg => {
  perched = !!msg?.up;
  through = msg?.through ?? perched;
  if (perched) flags.add('on-perch'); else flags.delete('on-perch');
  if (!through) overMe = false;
  paintBody();
});
document.addEventListener('mousemove', e => {
  if (through) setOver(!!e.target.closest?.('#crab, #bgBadge, #srvPill, .helper'));
});

// ---- up a wall or hanging from the top of the screen (src/main/climbing.js).
// His body (#pose) turns about the middle of the window; main has put the
// window where that brings his feet to the edge.
const SURFACES = ['left', 'right', 'ceiling'];
api.onSurface(msg => {
  const surface = SURFACES.includes(msg?.surface) ? msg.surface : 'floor';
  for (const s of SURFACES) flags.delete(`surface-${s}`);
  if (surface !== 'floor') flags.add(`surface-${surface}`);
  paintBody();
});
document.addEventListener('mouseleave', () => { if (through) setOver(false); });

// ---- idle habits: he digs, polishes his shell, peeks about, flops over, and
// up on a window, sits on the edge or peers down over it. Which habit it is
// comes from main (src/main/voice.js, perching.js); the animation is one class
// per habit in critter.css, so an unknown one simply does nothing.
const BIT_MS = 2600;
let bitTimer = null;
let bit = null;
api.onBit(msg => {
  if (typeof msg?.bit !== 'string' || !/^[a-z]{2,12}$/.test(msg.bit)) return;
  endBit();
  if (msg.bit === 'none') return void paintBody(); // a scene was cut short
  if (msg.dir === 1 || msg.dir === -1) setDir(msg.dir); // a pounce goes toward your cursor
  bit = msg.bit;
  flags.add(`bit-${bit}`);
  paintBody();
  if (bit === 'dig') digSand(true);
  const ms = Number.isFinite(msg.ms) ? clampN(msg.ms, 400, 10000) : BIT_MS; // a scene's beats can be short
  bitTimer = setTimeout(() => { digSand(false); flags.delete(`bit-${bit}`); bit = null; paintBody(); }, ms);
});
