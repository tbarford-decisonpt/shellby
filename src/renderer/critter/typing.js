// Typing along, and the weather on him. src/main/typing.js decides when you're
// typing; this draws it: a little keyboard by his claw, a tap for each key you
// let go, faster when you're fast, and starry eyes during a real burst. The
// weather half is a flinch at thunder while a storm is on (src/main/weather.js);
// the shiver and the sweat are plain CSS (typing.css). Drawing only.
'use strict';
(function () {
  const api = window.shellby.critter;
  const C = window.ShellbyCritter;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const KEYS = 8;             // keys on his little keyboard
  const TAP_MS = 90;          // a claw stays down this long
  const THUNDER_MS = [20000, 55000]; // between claps, while it storms
  const FLINCH_MS = 900;
  const LEVELS = new Set(['none', 'typing', 'fast']);

  const crab = document.getElementById('crab');
  const board = document.createElement('div');
  board.id = 'keys';
  board.setAttribute('aria-hidden', 'true');
  const keys = Array.from({ length: KEYS }, () => document.createElement('i'));
  board.append(...keys);
  crab.append(board);

  // On the ground just in front of his claw, in sprite pixels like #sand.
  function place() {
    const px = C.px();
    const [cx] = C.claw();
    board.style.setProperty('--kx', `${(cx - 2) * px}px`);
    board.style.setProperty('--ky', `${Math.max(0, C.rows() - 3) * px}px`);
  }

  // A habit (a dig, a stretch) has his claw busy: no tapping through it.
  const clawBusy = () => [...C.flags].some(f => f.startsWith('bit-'));

  let level = 'none';
  let impressed = false;
  let tapTimer = null;
  let flip = false;

  function show(nextLevel, nextImpressed) {
    if (nextLevel === level && nextImpressed === impressed) return;
    if (level === 'none' && nextLevel !== 'none') place();
    level = nextLevel;
    impressed = nextImpressed;
    for (const f of ['typing', 'typing-fast', 'impressed']) C.flags.delete(f);
    if (level !== 'none') C.flags.add('typing');
    if (level === 'fast') C.flags.add('typing-fast');
    if (impressed) C.flags.add('impressed');
    C.paint();
  }

  // One key let go: his claw comes down, his legs take turns, and a key lights up.
  function tap() {
    if (reduced() || clawBusy()) return;
    flip = !flip;
    crab.classList.add('tap');
    crab.classList.toggle('tap-b', flip);
    const k = keys[Math.floor(Math.random() * KEYS)];
    k.classList.add('down');
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      crab.classList.remove('tap');
      for (const key of keys) key.classList.remove('down');
    }, TAP_MS);
  }

  api.onTyping(msg => {
    const next = clawBusy() || !LEVELS.has(msg?.level) ? 'none' : msg.level;
    show(next, next !== 'none' && !!msg?.impressed);
    if (msg?.tap && level !== 'none') tap();
  });

  // ---------------------------------------------------------------- thunder
  let thunderTimer = null;
  function storm(on) {
    if (!on) { clearTimeout(thunderTimer); thunderTimer = null; return; }
    if (thunderTimer) return;
    const next = () => {
      thunderTimer = setTimeout(() => {
        if (!reduced() && !document.hidden) {
          C.flags.add('thunder');
          C.paint();
          setTimeout(() => { C.flags.delete('thunder'); C.paint(); }, FLINCH_MS);
        }
        next();
      }, THUNDER_MS[0] + Math.random() * (THUNDER_MS[1] - THUNDER_MS[0]));
    };
    next();
  }
  api.onSkin(msg => storm(msg?.outfit?.weather?.mood === 'storm'));
})();
