// The small things that make him yours rather than a sprite: he leans into a
// rub and, rubbed long enough, rolls over for more; he perks up when your
// cursor comes near; he says hello when you've been away; his eye stalks lag
// a beat behind when he stops; and he frets through your tests and sighs with
// relief when a long job lands. Each is a body class (charm.css) set here;
// critter.js owns the body's classes, so everything goes through its flags.
'use strict';
(function () {
  const api = window.shellby.critter;
  const C = window.ShellbyCritter;
  const crab = document.getElementById('crab');
  const root = document.documentElement.style;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- flags
  const timers = new Map();
  function pulse(flag, ms) {
    clearTimeout(timers.get(flag));
    // Already on (a rub calls this on every move): just push the end back.
    if (!C.flags.has(flag)) { C.flags.add(flag); C.paint(); }
    timers.set(flag, setTimeout(() => { timers.delete(flag); C.flags.delete(flag); C.paint(); }, ms));
  }
  function hold(flag, on) {
    if (C.flags.has(flag) === on) return;
    clearTimeout(timers.get(flag));
    timers.delete(flag);
    if (on) C.flags.add(flag); else C.flags.delete(flag);
    C.paint();
  }

  // Anything that already has his whole body: a move, a habit, a moment of charm.
  const BUSY = new Set(['flying', 'walking', 'hopping', 'crouch', 'eyeing', 'cling', 'scramble', 'coyote', 'dizzy', 'belly', 'greet', 'notice', 'tossing']);
  const busy = () => [...C.flags].some(f => BUSY.has(f) || f.startsWith('bit-') || f.startsWith('together-') || f.startsWith('sticker-'));
  let state = 'idle';
  const free = () => state === 'idle' && !busy();

  // ---------------------------------------------------------------- a rub
  // Rubbing him (no click) and he leans into your hand, eyes shut. critter.js
  // decides when the rub counts as a pet; three of those in a row and he rolls
  // onto his back for more.
  const RUB_TRAVEL_PX = 60;     // how far the pointer moves over him before he leans in
  const RUB_LINGER_MS = 450;    // ...and how long he stays leant after it stops
  const BELLY_PETS = 3;         // pets...
  const BELLY_WINDOW_MS = 15000; // ...within this long
  const BELLY_MS = 2600;
  let travel = 0;
  let lastX = null;
  let pets = [];

  crab.addEventListener('pointermove', e => {
    if (e.buttons) return; // a drag, not a rub
    if (lastX !== null) travel += Math.abs(e.screenX - lastX);
    lastX = e.screenX;
    if (travel < RUB_TRAVEL_PX) return;
    const r = crab.getBoundingClientRect();
    root.setProperty('--rub', e.clientX < r.left + r.width / 2 ? '-1' : '1');
    pulse('rubbed', RUB_LINGER_MS);
  });
  crab.addEventListener('pointerleave', () => { travel = 0; lastX = null; });

  document.addEventListener('shellby:petted', () => {
    const now = performance.now();
    pets = [...pets.filter(t => now - t < BELLY_WINDOW_MS), now];
    if (pets.length < BELLY_PETS || C.flags.has('belly')) return;
    pets = [];
    if (busy() && !C.flags.has('rubbed')) return;
    hold('rubbed', false);
    pulse('belly', BELLY_MS);
    if (!reduced()) setTimeout(() => C.hearts(5), BELLY_MS * 0.35);
  });

  // ---------------------------------------------------------------- you, nearby
  // Your cursor wanders close and, now and then, he notices: a perk and a wave.
  const NOTICE_MS = 1100;
  const NOTICE_EVERY_MS = 60 * 1000;
  const NOTICE_CHANCE = 0.5;
  let near = false;
  let noticedAt = -Infinity;
  api.onLook(msg => {
    const was = near;
    near = !!msg?.near;
    if (!near || was || !free()) return;
    const now = performance.now();
    if (now - noticedAt < NOTICE_EVERY_MS || Math.random() > NOTICE_CHANCE) return;
    noticedAt = now;
    pulse('notice', NOTICE_MS);
  });

  // ---------------------------------------------------------------- hello again
  // Back after a while (an hour or more, see recap.js): a hop toward you and a
  // wave. Gone half a day or more and it's a bigger one, with hearts.
  const GREET_MS = 2200;
  const BIG_GREET_AFTER_MS = 4 * 60 * 60 * 1000;
  const GREET_RETRIES = 4;
  function greet(awayMs, tries = 0) {
    if (busy()) {
      if (tries < GREET_RETRIES) setTimeout(() => greet(awayMs, tries + 1), 1500);
      return;
    }
    const big = awayMs >= BIG_GREET_AFTER_MS;
    if (big) pulse('greet-big', GREET_MS + 400);
    pulse('greet', big ? GREET_MS + 400 : GREET_MS);
    if (big && !reduced()) setTimeout(() => C.hearts(4), 700);
  }
  api.onGreet(msg => greet(Number(msg?.awayMs) || 0));

  // ---------------------------------------------------------------- follow-through
  // He stops; his eye stalks don't, quite. A short, damped wobble after a stroll
  // ends or he lands from a hop or a throw.
  const SETTLE_MS = 750;
  const LAYERED = new Set(['lean', 'dizzy', 'wheee']); // these ride on top of a move
  let moving = null;
  api.onMotion(msg => {
    const kind = msg?.kind ?? null;
    if (LAYERED.has(kind)) return;
    if (kind === 'landed' || (moving === 'walking' && kind !== 'walking')) pulse('settle', SETTLE_MS);
    moving = kind;
  });

  // ---------------------------------------------------------------- your work
  // Tests running, or a job that's dragging on: he chews a claw. When a long one
  // comes good, a wipe of the brow before the celebration.
  const FRET_OCCASIONS = new Set(['tests', 'longTask']);
  const RELIEF_AFTER_MS = 45 * 1000;
  const RELIEF_MS = 1300;
  let workingSince = null;
  api.onState(msg => {
    const was = state;
    state = msg?.state || 'idle';
    if (state === 'working' && was !== 'working') workingSince = Date.now();
    if (state === 'working' && FRET_OCCASIONS.has(msg?.say?.occasion)) hold('fret', true);
    if (state !== 'working') hold('fret', false);
    if (state === 'success' && was === 'working' && workingSince && Date.now() - workingSince >= RELIEF_AFTER_MS) pulse('relief', RELIEF_MS);
    if (state !== 'working') workingSince = null;
  });
})();
