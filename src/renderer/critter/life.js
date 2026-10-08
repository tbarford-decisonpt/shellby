// His life between tasks, drawn (src/main/life.js and playtime.js decide what
// and when): his eyes on your cursor, the props of a scene (a sandcastle, a fly,
// bubbles...), what he holds up or puts on for a moment, and what a visiting
// crab says back. Everything here is drawing; the body animations are one
// class per beat in critter.css (body.bit-*), set by critter.js.
'use strict';
(function () {
  const api = window.shellby.critter;
  const C = window.ShellbyCritter;
  const Sprite = window.ShellbySprite;
  const root = document.documentElement.style;
  const host = document.getElementById('prop');
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- his eyes
  api.onLook(msg => {
    const x = msg?.x === 1 || msg?.x === -1 ? msg.x : 0;
    const y = msg?.y === 1 || msg?.y === -1 ? msg.y : 0;
    root.setProperty('--lookx', String(x));
    root.setProperty('--looky', String(y));
    document.body.classList.toggle('cursor-near', !!msg?.near);
  });

  // ---------------------------------------------------------------- props
  // Pixel art for the props that are drawn rather than made of CSS.
  const ART = {
    castle: { palette: { s: '#e9d8a6', S: '#c9b38a', f: '#e63946', k: '#8a6a4a' }, pixels: ['....f....', '....k....', '.s.sSs.s.', '.sSsssSs.', '.sssssss.', 'sSsSSSsSs', 'sssSSSsss'] },
    heart: { palette: { s: '#c9b38a' }, pixels: ['.ss.ss.', 's..s..s', 's.....s', '.s...s.', '..s.s..', '...s...'] },
    fly: { palette: { k: '#2b2d42', w: '#cfe8ff' }, pixels: ['w.w', '.k.'] },
  };
  // What his claw holds for a scene (a find comes with its own pixels).
  const HOLD = {
    coffee: { palette: { w: '#fff4e4', b: '#6f4e37', s: '#cfd8dc' }, pixels: ['.s.s..', 'wwwww.', 'wbbbww', 'wbbbww', 'wwwww.'] },
    pebble: { palette: { a: '#8d99ae', b: '#b8c2d1' }, pixels: ['.bb.', 'abba', '.aa.'] },
    mic: { palette: { K: '#2b2d42', s: '#cfd8dc', k: '#4a4e69' }, pixels: ['.KKK.', 'KsKsK', '.KKK.', '..k..', '..k..'] },
    // A plankton drifting down to him (the one he eats comes with its own pixels, src/main/needs.js SNACKS).
    plankton: { palette: { a: '#7fd6c2', b: '#c8f3e8', k: '#2a9d8f' }, pixels: ['.ab.', 'aaak', '.ak.'] },
  };
  // What he puts on his face for a scene.
  const WEAR = {
    shades: { slot: 'face', pivot: [4, 1], palette: { K: '#1b1d2a', w: '#7fd6c2' }, pixels: ['KKKKKKKKK', 'KwKKKKwKK', '.KK...KK.'] },
  };

  let propTimer = null;
  function clearProp() {
    clearTimeout(propTimer);
    host.className = '';
    host.replaceChildren();
  }

  function el(tag, cls, style = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(style)) e.style.setProperty(k, v);
    return e;
  }

  // Each prop: what goes in the host. Positions are in critter.css (#prop.prop-*).
  const DRAW = {
    'castle': () => [Sprite.grid(ART.castle.pixels, ART.castle.palette, { px: Math.max(2, Math.round(C.px() * 0.8)) })],
    // The castle he just built, crumbling: drawn again and knocked down.
    'castle-fall': () => [Sprite.grid(ART.castle.pixels, ART.castle.palette, { px: Math.max(2, Math.round(C.px() * 0.8)) })],
    'heart': () => [Sprite.grid(ART.heart.pixels, ART.heart.palette, { px: Math.max(2, Math.round(C.px() * 0.7)) })],
    'fly': () => {
      const f = el('i', 'fly');
      f.append(Sprite.grid(ART.fly.pixels, ART.fly.palette, { px: Math.max(2, Math.round(C.px() * 0.6)) }));
      return [f];
    },
    'bubbles': () => Array.from({ length: 6 }, (_, i) => el('i', 'bub', { '--d': `${i * 380}ms`, '--x': `${(i % 3) * 7 - 4}px`, '--s': `${6 + (i * 5) % 7}px` })),
    'shooting-star': () => [el('i', 'star')],
    'juggle': () => [0, 1, 2].map(i => {
      const p = el('i', 'peb', { '--d': `${i * -240}ms` });
      p.append(Sprite.grid(HOLD.pebble.pixels, HOLD.pebble.palette, { px: Math.max(1, Math.round(C.px() * 0.5)) }));
      return p;
    }),
    'achoo': () => Array.from({ length: 8 }, (_, i) => el('i', 'grit', { '--dx': `${14 + (i * 13) % 26}px`, '--dy': `${-10 + (i * 7) % 18}px`, '--d': `${i * 18}ms` })),
    'zz': () => ['z', 'z', 'Z'].map((t, i) => { const z = el('i', 'z', { '--d': `${i * 450}ms` }); z.textContent = t; return z; }),
    'notes': () => ['♪', '♫', '♪'].map((t, i) => { const n = el('i', 'note', { '--d': `${i * 520}ms`, '--x': `${i * 9 - 9}px` }); n.textContent = t; return n; }),
    'sweat': () => [0, 1].map(i => el('i', 'drop', { '--d': `${i * 400}ms`, '--x': `${i * 10}px` })),
    'sparkle': () => ['✦', '✧', '✦', '✧'].map((t, i) => { const s = el('i', 'spark', { '--d': `${i * 260}ms`, '--x': `${(i % 2 ? 1 : -1) * (6 + i * 5)}px`, '--y': `${-4 - (i * 7) % 14}px` }); s.textContent = t; return s; }),
    // Looking after him (src/main/care.js): a snack drifting down to his claw,
    // crumbs while he munches, suds for a rinse, and a heart or two after.
    'plankton-drop': () => {
      const p = el('i', 'snack');
      p.append(Sprite.grid(HOLD.plankton.pixels, HOLD.plankton.palette, { px: Math.max(2, Math.round(C.px() * 0.6)) }));
      return [p];
    },
    'crumbs': () => Array.from({ length: 6 }, (_, i) => el('i', 'crumb', { '--d': `${i * 280}ms`, '--dx': `${(i % 2 ? 1 : -1) * (4 + (i * 5) % 9)}px` })),
    'suds': () => Array.from({ length: 9 }, (_, i) => el('i', 'sud', { '--d': `${i * 230}ms`, '--x': `${(i % 3) * 9 - 12}px`, '--s': `${5 + (i * 3) % 6}px` })),
    'hearts': () => ['♥', '♥'].map((t, i) => { const e = el('i', 'love', { '--d': `${i * 320}ms`, '--x': `${i * 10 - 5}px` }); e.textContent = t; return e; }),
    // A bug scooped into a jar (src/main/bugdex.js): a splash as it drops in,
    // a puff of sparkles as the cork goes on, and the jar in his claw (critter:hold)
    // wobbling once, twice or three times by rarity (--wobbles, life.css). A
    // ghost leaves a wisp behind.
    'jar': msg => {
      const wobbles = [1, 2, 3].includes(msg.wobbles) ? msg.wobbles : 1;
      root.setProperty('--wobbles', String(wobbles));
      const splash = Array.from({ length: 6 }, (_, i) => el('i', 'splash', { '--d': `${i * 30}ms`, '--dx': `${(i - 2.5) * 5}px`, '--dy': `${-8 - (i * 7) % 11}px` }));
      const sparks = ['✦', '✧', '✦'].map((t, i) => { const s = el('i', 'spark', { '--d': `${i * 180}ms`, '--x': `${(i - 1) * 9}px`, '--y': `${-2 - (i % 2) * 6}px` }); s.textContent = t; return s; });
      return [...splash, ...sparks, ...(msg.ghost ? [el('i', 'wisp')] : [])];
    },
  };

  api.onProp(msg => {
    const prop = msg?.prop;
    if (!prop || !DRAW[prop]) return clearProp();
    if (reduced() && prop !== 'castle' && prop !== 'heart') return clearProp(); // a still picture, no moving parts
    clearProp();
    host.className = `prop-${prop}`;
    host.append(...DRAW[prop](msg)); // the whole message: some props are drawn to order (a jar's wobbles)
    const ms = Number.isFinite(msg.ms) ? Math.min(Math.max(msg.ms, 400), 8000) : 2000;
    propTimer = setTimeout(clearProp, ms + 200);
  });

  // ---------------------------------------------------------------- held and worn
  api.onHold(msg => {
    if (!msg) return C.wear('held', null);
    const art = msg.item ? HOLD[msg.item] : (Array.isArray(msg.pixels) && msg.palette ? msg : null);
    if (!art) return C.wear('held', null);
    const w = Math.max(...art.pixels.map(r => r.length)), h = art.pixels.length;
    // Held up by its bottom middle, like a sticker before it goes on.
    C.wear('held', { slot: 'held', anchor: 'claw', follows: 'claw', pivot: [Math.floor(w / 2), h], pixels: art.pixels, palette: art.palette });
  });

  api.onWear(msg => {
    const item = msg?.item && WEAR[msg.item];
    if (!item) { C.wear('face', null); return; }
    C.wear('face', { ...item, anchor: 'face' });
  });

  // ---------------------------------------------------------------- a visitor talking back
  let vTimer = null;
  api.onVisitorSay(msg => {
    const v = C.visitor();
    const b = v?.querySelector('.vbubble');
    if (!b || typeof msg?.text !== 'string') return;
    clearTimeout(vTimer);
    b.textContent = msg.text.slice(0, 40);
    b.classList.add('on');
    const ms = Number.isFinite(msg.ms) ? Math.min(Math.max(msg.ms, 1000), 8000) : 3000;
    vTimer = setTimeout(() => b.classList.remove('on'), ms);
  });
})();
