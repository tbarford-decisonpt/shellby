// The floor beside him (src/main/floor.js): his pals, and the footprints he
// leaves when he's feeling cheeky. What the pals do is decided in
// colony-brain.js; this draws it and moves them along a few times a second.
'use strict';
(function () {
  const bridge = window.floor;
  const brain = window.ShellbyColony;
  const colonyHost = document.getElementById('colony');
  const tracksHost = document.getElementById('tracks');
  const TICK_MS = 80;            // pals move at a pixel-art pace, not the screen's
  const STEP = 13;               // a footprint every this many DIPs he walks
  const PRINT_MS = 24000;        // how long a print lasts before the tide takes it
  const MAX_PRINTS = 180;
  const FOOT = 18;               // his feet sit this far above the floor's bottom edge
  window.ShellbyFrameCap.cap(document); // a transparent window: every frame costs the GPU

  let skin = null, px = 4, scale = 0.55, accessories = [];
  let roster = [];
  let pals = [];
  let tracks = false;
  let shellby = null;            // { x, floor, away, state, half }
  let calm = false;
  const els = new Map();         // pal id -> element
  let last = performance.now();

  // Pals stand a body-width and a bit apart, at whatever size he is.
  const world = () => ({ width: window.innerWidth, shellby, gap: Math.round(22 * px * scale) + 8 });

  function sprite(hue) {
    const svg = window.ShellbySprite.build(skin, { px: Math.max(1, px * scale), accessories });
    svg.style.filter = `hue-rotate(${hue}deg) saturate(1.1)`;
    return svg;
  }

  // The colony changed size (or this is the first look): keep the pals who are
  // still in it where they are, bring the new ones in, wave the others off.
  function reconcile() {
    if (!skin || !shellby) return; // they gather round him, so wait to hear where he is
    const keep = new Map(pals.map(p => [p.id, p]));
    const fresh = roster.filter(r => !keep.has(r.id));
    const born = fresh.length ? brain.spawn(fresh, world()) : [];
    pals = roster.map(r => keep.get(r.id) || born.find(b => b.id === r.id));
    for (const [id, el] of els) {
      if (roster.some(r => r.id === id)) continue;
      el.classList.add('leaving');
      els.delete(id);
      setTimeout(() => el.remove(), 900);
    }
    for (const p of pals) if (!els.has(p.id)) els.set(p.id, palEl(p));
    paint();
  }

  function palEl(p) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pal fresh';
    el.dataset.id = p.id;
    el.setAttribute('aria-label', `${p.name}, one of Shellby's pals`);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = p.name;
    const say = document.createElement('span');
    say.className = 'say';
    say.setAttribute('aria-hidden', 'true');
    const zz = document.createElement('span');
    zz.className = 'zz';
    zz.setAttribute('aria-hidden', 'true');
    zz.textContent = 'z';
    el.append(tag, say, zz, sprite(p.hue));
    el.addEventListener('click', () => {
      pals = brain.poke(pals, p.id, performance.now());
      bridge.poke();
      paint();
    });
    setTimeout(() => el.classList.remove('fresh'), 1200);
    colonyHost.append(el);
    return el;
  }

  const SAY = { chat: ['…', '♪', '!?', 'ha'], cheer: ['★', 'yay'], poked: ['!', 'hey', 'eep'], oof: ['oof'], look: ['↑', 'wow'] };
  function paint() {
    for (const p of pals) {
      const el = els.get(p.id);
      if (!el) continue;
      el.style.setProperty('--x', `${Math.round(p.x)}px`);
      el.style.setProperty('--dir', p.dir < 0 ? '-1' : '1');
      const mode = `mode-${p.mode}`;
      if (el.dataset.mode !== mode) {
        el.classList.remove(el.dataset.mode);
        el.classList.add(mode);
        el.dataset.mode = mode;
        const lines = SAY[p.mode];
        el.querySelector('.say').textContent = lines ? lines[Math.floor(Math.random() * lines.length)] : '';
      }
    }
  }

  setInterval(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (calm || !pals.length) return;
    pals = brain.tick(pals, world(), now, dt);
    paint();
  }, TICK_MS);

  // ---- footprints: one every STEP he walks, a little behind him, alternating feet
  let lastPrint = null;
  let foot = 1;
  function print(x, dir, lift = 0) {
    const el = document.createElement('i');
    el.className = 'print';
    foot = -foot;
    el.style.left = `${Math.round(x - dir * 16)}px`;
    el.style.bottom = `${FOOT - 4 + lift + foot * 2}px`;
    el.style.setProperty('--dir', dir < 0 ? '-1' : '1');
    tracksHost.append(el);
    while (tracksHost.childElementCount > MAX_PRINTS) tracksHost.firstElementChild.remove();
    setTimeout(() => el.remove(), PRINT_MS);
  }
  function follow(s) {
    if (!tracks || !s?.floor) { lastPrint = null; return; }
    if (lastPrint === null) { lastPrint = s.x; return; }
    const dx = s.x - lastPrint;
    if (Math.abs(dx) < STEP) return;
    // A jump (a throw, a hop home) isn't a walk: start again from here.
    if (Math.abs(dx) > STEP * 6) { lastPrint = s.x; return; }
    const dir = Math.sign(dx);
    const steps = Math.floor(Math.abs(dx) / STEP);
    for (let k = 1; k <= steps; k++) print(lastPrint + dir * STEP * k, dir, s.lift);
    lastPrint += dir * STEP * steps;
  }

  // ---- the pointer: the strip lets clicks through except over a pal
  let over = false;
  document.addEventListener('mousemove', e => {
    const now = !!e.target.closest?.('.pal');
    if (now !== over) { over = now; bridge.hit(now); }
  });
  document.addEventListener('mouseleave', () => { if (over) { over = false; bridge.hit(false); } });

  bridge.onSkin(msg => {
    if (!msg?.skin) return;
    skin = msg.skin;
    px = Number(msg.px) || px;
    scale = Number(msg.scale) || scale;
    accessories = msg.outfit?.crewAccessories || [];
    for (const [id, el] of els) {
      const p = pals.find(q => q.id === id);
      if (p) el.querySelector('svg')?.replaceWith(sprite(p.hue));
    }
    reconcile();
  });
  bridge.onColony(msg => {
    roster = Array.isArray(msg?.pals) ? msg.pals.filter(p => typeof p?.id === 'string' && typeof p.name === 'string') : [];
    tracks = !!msg?.tracks;
    if (!tracks) tracksHost.replaceChildren();
    reconcile();
  });
  bridge.onShellby(s => {
    shellby = s && Number.isFinite(s.x) ? { x: s.x, floor: !!s.floor, lift: Number(s.lift) || 0, away: s.away || null, state: s.state || 'idle', half: Number(s.half) || 40 } : null;
    if (shellby && pals.length !== roster.length) reconcile();
    follow(shellby);
  });
  bridge.onEvent(msg => {
    if (typeof msg?.kind !== 'string') return;
    pals = brain.react(pals, msg.kind, world(), performance.now());
    paint();
  });
  bridge.onCalm(msg => {
    calm = !!msg?.calm;
    document.body.classList.toggle('calm-deep', calm);
  });
})();
