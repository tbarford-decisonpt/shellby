/* Shellby panel — painting the beach (src/main/beach.js lays it out). Everything
   is drawn in art pixels: the caller scales the context by a whole number so
   each one comes out square, live on the Beach tab and in the snapshot. The
   palettes are the Us diorama's (together.css), one per time of day, and
   castles arrive as colour roles so they take the light of the hour. */
'use strict';
(function () {
  const THEMES = {
    night: {
      skyTop: '#050d17', skyLow: '#142c3d', sea: '#0d3440', seaHi: '#1d5763', foam: '#b9dcd6',
      sand: '#3f4b50', sandLo: '#36424a', sandHi: '#4c595e', weed: '#4f8a66', stars: 0.9, lights: true,
      orb: ['#f3e6cc', '#cdbf9f'], orbY: 8, castle: { s: '#8b979a', S: '#626e73', d: '#141b20' }, // moonlit, so they stand off the sand
    },
    dawn: {
      skyTop: '#191a36', skyLow: '#7a4d62', sea: '#1f4a5b', seaHi: '#557f88', foam: '#f7dccb',
      sand: '#a38a6b', sandLo: '#937a5f', sandHi: '#b39a7a', weed: '#5e7446', stars: 0.35, lights: true,
      orb: ['#ff9a6b', '#ffc39e'], orbY: 31, castle: { s: '#c9ae89', S: '#9c8264', d: '#3e3029' },
    },
    day: {
      skyTop: '#0e3550', skyLow: '#3f8ea2', sea: '#136b77', seaHi: '#3bb0aa', foam: '#effaf5',
      sand: '#d8c38e', sandLo: '#c9b27e', sandHi: '#e6d4a2', weed: '#58783f', stars: 0, lights: false,
      orb: ['#ffc15e', '#ffe0a3'], orbY: 7, castle: { s: '#f1e3b8', S: '#c4ab76', d: '#6b5536' },
    },
    dusk: {
      skyTop: '#1b1530', skyLow: '#8c4b52', sea: '#23455a', seaHi: '#6d6a7c', foam: '#ffd9c2',
      sand: '#9e7b61', sandLo: '#8d6c55', sandHi: '#ad8b70', weed: '#5f6e42', stars: 0.2, lights: true,
      orb: ['#ff7a5c', '#ffb08f'], orbY: 31, castle: { s: '#c49e7d', S: '#93725a', d: '#3b2a24' },
    },
  };
  // Colours that don't change with the hour.
  const FIXED = { p: '#6b5640', g: '#ffd23f', k: '#8a6a4a', i: '#aab4bf', b: '#ff7a5c', B: '#ffb08f', lit: '#ffd27a', stakeFlag: '#ff7a5c' };
  const ORB = ['..1111..', '.111111.', '11121111', '11111211', '11211111', '11111111', '.111121.', '..1111..'];
  const CLOUD = ['....1111.....', '..11111111.11', '1111111111111'];
  const HEART = ['.11.11.', '1221111', '1211111', '.11111.', '..111..', '...1...'];

  const timeOfDay = (hour = new Date().getHours()) => (hour >= 21 || hour < 5 ? 'night' : hour < 8 ? 'dawn' : hour < 17 ? 'day' : 'dusk');

  // ------------------------------------------------------------ helpers

  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  function mix(a, b, k) {
    const [x, y] = [hex(a), hex(b)];
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
  }
  // A stable pseudo-random number in [0, 1) for an integer: the same sand every frame.
  const noise = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // Pixel grids become small canvases once, then get stamped. Keyed on the grid
  // itself (so a new beach from main lets the old ones go) and then its colours.
  const cache = new WeakMap();
  function sprite(pixels, palette) {
    let byColours = cache.get(pixels);
    if (!byColours) { byColours = new Map(); cache.set(pixels, byColours); }
    const key = Object.entries(palette).map(([k, col]) => k + col).join('');
    let c = byColours.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = Math.max(1, ...pixels.map(r => r.length));
    c.height = pixels.length;
    const ctx = c.getContext('2d');
    pixels.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const col = palette[row[x]];
        if (!col) continue;
        ctx.fillStyle = col;
        ctx.fillRect(x, y, 1, 1);
      }
    });
    byColours.set(key, c);
    return c;
  }

  // ------------------------------------------------------------ the backdrop

  // How much of the moon's face is lit, 0 at new to 1 at full; fraction runs 0 → 0.5 (full) → 1.
  const litOf = fraction => (1 - Math.cos(2 * Math.PI * fraction)) / 2;

  /**
   * Which pixels of the 8×8 moon are in shadow at this phase, as [x, y] pairs.
   * Waxing, the right side fills first; waning, the right side empties first
   * (as it looks from the northern hemisphere).
   */
  function moonDark(fraction) {
    const out = [];
    const c = Math.cos(2 * Math.PI * fraction);
    for (let y = 0; y < ORB.length; y++) {
      for (let x = 0; x < ORB[y].length; x++) {
        if (ORB[y][x] === '.') continue;
        const u = (x + 0.5 - 4) / 4, w = Math.sqrt(Math.max(0, 1 - ((y + 0.5 - 4) / 4) ** 2));
        const lit = fraction < 0.5 ? u > w * c : u < -w * c;
        if (!lit) out.push([x, y]);
      }
    }
    return out;
  }

  // The unlit part of the moon: dark, but not quite gone (earthshine).
  function moonShadow(ctx, T, ox, fraction) {
    ctx.fillStyle = mix(T.skyTop, T.orb[1], 0.18);
    for (const [x, y] of moonDark(fraction)) ctx.fillRect(ox + x, T.orbY + y, 1, 1);
  }

  function sky(ctx, T, v, x0, x1, t) {
    const { seaTop } = v.world;
    const bands = 9;
    for (let i = 0; i < bands; i++) {
      const y0 = Math.round((seaTop * i) / bands), y1 = Math.round((seaTop * (i + 1)) / bands);
      ctx.fillStyle = mix(T.skyTop, T.skyLow, i / (bands - 1));
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    if (T.stars) {
      ctx.fillStyle = '#f3e6cc';
      for (let x = Math.floor(x0 / 7) * 7; x < x1; x += 7) {
        const n = x / 7;
        if (noise(n) > 0.55) continue;
        const twinkle = Math.floor(t * 1.5 + n * 3) % 9 === 0;
        ctx.globalAlpha = T.stars * (twinkle ? 0.3 : 0.6 + noise(n + 7) * 0.4);
        ctx.fillRect(x + Math.floor(noise(n + 3) * 7), Math.floor(noise(n + 5) * (seaTop - 12)), 1, 1);
      }
      ctx.globalAlpha = 1;
    }
    // A few clouds, drifting slowly along a beach of any length.
    if (!T.lights || T.stars < 0.5) {
      const span = v.paintWidth + 40;
      const cloud = sprite(CLOUD, { 1: mix(T.skyLow, '#ffffff', 0.35) });
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < Math.ceil(span / 90); i++) {
        const cx = ((i * 90 + noise(i) * 60 + t * 1.2) % span) - 20;
        if (cx + 13 < x0 || cx > x1) continue;
        ctx.drawImage(cloud, Math.round(cx), 6 + Math.floor(noise(i + 9) * 14));
      }
      ctx.globalAlpha = 1;
    }
    // The sun or the moon, low at dawn and dusk (the sea goes over its bottom half).
    const ox = v.orbX;
    if (ox + 16 > x0 && ox - 8 < x1) {
      // At night it's the real moon (src/main/moon.js): a thin one barely glows.
      const moonlit = T === THEMES.night && Number.isFinite(v.moon?.fraction) ? v.moon.fraction : null;
      const glow = moonlit === null ? 1 : 0.25 + 0.75 * litOf(moonlit);
      // A halo in two pixel rings, then the disc itself.
      ctx.fillStyle = T.orb[0];
      for (const [r, a] of [[9, 0.07], [7, 0.1]]) {
        ctx.globalAlpha = a * glow;
        for (let dy = -r; dy <= r; dy++) {
          const w = Math.round(Math.sqrt(r * r - dy * dy));
          ctx.fillRect(ox + 4 - w, T.orbY + 4 + dy, w * 2, 1);
        }
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(sprite(ORB, { 1: T.orb[0], 2: T.orb[1] }), ox, T.orbY);
      if (moonlit !== null) moonShadow(ctx, T, ox, moonlit);
    }
    // Far-off headlands along the horizon, every so often.
    ctx.fillStyle = mix(T.skyLow, T.sea, 0.55);
    for (let x = x0; x < x1; x++) {
      const zone = Math.floor(x / 130);
      if (noise(zone + 40) < 0.45) continue;
      const k = (x % 130) / 130;
      const h = Math.round(Math.sin(k * Math.PI) * (2 + noise(zone + 41) * 4) + Math.sin(x / 5) * 0.6);
      if (h > 0) ctx.fillRect(x, seaTop - h, 1, h);
    }
  }

  function sea(ctx, T, v, x0, x1, t) {
    const { seaTop, shore } = v.world;
    const h = shore - seaTop;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = mix(T.seaHi, T.sea, i / 3);
      ctx.fillRect(x0, seaTop + Math.round((h * i) / 4), x1 - x0, Math.ceil(h / 4) + 1);
    }
    ctx.fillStyle = T.foam;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(x0, seaTop, x1 - x0, 1); // the horizon
    // The orb's light on the water: dashes narrowing towards you.
    ctx.fillStyle = T.orb[0];
    for (let r = 0; r < 6; r++) {
      const w = 6 - r, y = seaTop + 2 + r * 2;
      ctx.globalAlpha = 0.45 - r * 0.05;
      ctx.fillRect(v.orbX + 1 + r / 2 + (Math.floor(t * 2 + r) % 2), y, w, 1);
    }
    // Rows of crests rolling along, slower further out.
    ctx.fillStyle = T.foam;
    [[seaTop + 4, 0.25, 3], [seaTop + 8, 0.35, 5], [shore - 3, 0.5, 8]].forEach(([y, a, speed], k) => {
      ctx.globalAlpha = a;
      const shift = Math.floor(t * speed) + k * 11;
      for (let x = x0 - (x0 % 2); x < x1; x++) {
        const m = (x + shift) % 23;
        if (m < 4) ctx.fillRect(x, y, 1, 1);
        if (m > 0 && m < 3) ctx.fillRect(x, y - 1, 1, 1);
      }
    });
    ctx.globalAlpha = 1;
  }

  // Dry sand, then the wet sand as far as the tide reaches (your streak), its
  // lapping edge, and the seaweed it left at its highest (your best).
  function sand(ctx, T, v, x0, x1, t) {
    const { shore, height } = v.world;
    const { wet, mark } = v.tide;
    ctx.fillStyle = T.sand;
    ctx.fillRect(x0, shore, x1 - x0, height - shore);
    for (let x = x0; x < x1; x++) {
      for (let k = 0; k < 3; k++) {
        const n = x * 3 + k;
        if (noise(n) < 0.55) continue;
        ctx.fillStyle = noise(n + 1) < 0.6 ? T.sandLo : T.sandHi;
        ctx.fillRect(x, shore + 2 + Math.floor(noise(n + 2) * (height - shore - 2)), 1, 1);
      }
    }
    // Wet sand: darker, and shiny with the sky in it, so you can see how far the tide is in.
    const wetSand = mix(T.sand, T.sea, 0.5);
    ctx.fillStyle = wetSand;
    ctx.fillRect(x0, shore, x1 - x0, wet);
    ctx.fillStyle = mix(wetSand, T.skyLow, 0.55);
    for (let x = x0 - (x0 % 3); x < x1; x += 3) {
      const r = noise(x + 911);
      if (r < 0.5) continue;
      ctx.fillRect(x, shore + 1 + Math.floor(noise(x + 912) * Math.max(1, wet - 2)), 2 + Math.floor(r * 4), 1);
    }
    ctx.fillStyle = T.orb[0]; // the sun or moon in the wet sand too
    ctx.globalAlpha = 0.3;
    for (let y = shore + 1; y < shore + wet - 1; y += 2) ctx.fillRect(v.orbX + 2 + (y % 4 ? 1 : 0), y, 3, 1);
    ctx.globalAlpha = 1;
    // The wrack line: clumps of weed, bits of shell and driftwood, where the tide reached at its best.
    const line = shore + mark + 1;
    for (let x = x0; x < x1; x++) {
      const r = noise(x + 501);
      if (r < 0.3) continue;
      const shell = r > 0.95, wood = r > 0.91 && !shell && x % 5 === 0;
      ctx.fillStyle = shell ? mix(T.sandHi, '#ffffff', 0.55) : wood ? FIXED.k : T.weed;
      const tall = !shell && !wood && r > 0.72;
      ctx.fillRect(x, line - (tall ? 1 : 0) + (noise(x + 77) < 0.25 ? -1 : 0), wood ? 3 : 1, tall ? 2 : 1);
    }
    // The water's edge, lapping.
    ctx.fillStyle = T.foam;
    for (let x = x0; x < x1; x++) {
      const dy = Math.round(Math.sin(x / 7 + t * 1.4) * 0.8 + Math.sin(x / 3.3 - t * 0.9) * 0.4);
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x, shore + wet - 1 + dy, 1, 1);
      ctx.globalAlpha = 0.3;
      if ((x + Math.floor(t * 3)) % 4) ctx.fillRect(x, shore + wet - 3 + dy, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ what's on the sand

  function castlePalette(T, c) {
    const lit = c.lit && T.lights;
    return { ...T.castle, w: lit ? FIXED.lit : T.castle.d, p: FIXED.p, f: c.flag, g: FIXED.g };
  }

  // A soft dark under anything standing on the sand.
  function shadow(ctx, x, y, w) {
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x + 1, y, w, 1);
    ctx.globalAlpha = 1;
  }

  function drawCastle(ctx, T, c, reveal, t) {
    if (reveal <= 0) return; // not started coming up yet
    const img = sprite(c.pixels, castlePalette(T, c));
    const top = c.y - c.h;
    shadow(ctx, c.x, c.y, c.w);
    if (reveal < 1) {
      // Rising out of the sand, row by row, with sand flying off the top.
      const rows = Math.max(1, Math.ceil(c.h * reveal));
      ctx.drawImage(img, 0, c.h - rows, c.w, rows, c.x, c.y - rows, c.w, rows);
      ctx.fillStyle = T.castle.s;
      for (let i = 0; i < 5; i++) {
        const n = Math.floor(t * 9) + i * 13 + c.x;
        ctx.fillRect(c.x + Math.floor(noise(n) * c.w), c.y - rows - 1 - Math.floor(noise(n + 1) * 4), 1, 1);
      }
      return;
    }
    ctx.drawImage(img, c.x, top);
    // Lit windows glow after dark.
    if (c.lit && T.lights) {
      ctx.fillStyle = FIXED.lit;
      c.pixels.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] !== 'w') continue;
          ctx.globalAlpha = 0.16 + (Math.floor(t * 0.7 + x) % 5 === 0 ? 0.06 : 0);
          ctx.fillRect(c.x + x - 1, top + y - 1, 3, 3);
        }
      });
      ctx.globalAlpha = 1;
    }
    // The flag flutters: one pixel at its tip, on and off.
    if (Math.floor(t * 2 + c.x) % 2) {
      const fy = c.pixels.findIndex(r => /[fg]/.test(r));
      if (fy >= 0) {
        const fx = Math.max(c.pixels[fy].lastIndexOf('f'), c.pixels[fy].lastIndexOf('g'));
        ctx.fillStyle = c.pixels[fy][fx] === 'g' ? FIXED.g : c.flag;
        ctx.fillRect(c.x + fx + 1, top + fy + 1, 1, 1);
      }
    }
  }

  function drawFind(ctx, T, f, t, still) {
    const img = sprite(f.pixels, f.palette);
    ctx.drawImage(img, f.x, f.y - img.height);
    const shine = f.rarity === 'legendary' || f.rarity === 'special' || f.isNew;
    if (shine && !still && Math.floor(t * 1.5 + f.x) % 4 === 0) {
      ctx.fillStyle = f.rarity === 'legendary' ? FIXED.g : '#ffffff';
      ctx.fillRect(f.x + img.width, f.y - img.height - 1, 1, 1);
      ctx.fillRect(f.x + img.width - 1, f.y - img.height - 2, 1, 1);
    }
  }

  // The tide pool: a rim of rock with the corners knocked off, the sea's own
  // water in it, and the Bugdex's catches bobbing about (still when motion's off).
  function drawPool(ctx, T, pool, t, still) {
    const { x, w, h } = pool, top = pool.y - h;
    const rock = mix(T.sandLo, '#5d6670', 0.6);
    shadow(ctx, x, pool.y, w);
    ctx.fillStyle = rock;
    ctx.fillRect(x + 1, top, w - 2, h);
    ctx.fillRect(x, top + 1, w, h - 2);
    ctx.fillStyle = mix(rock, '#ffffff', 0.2); // light on the near-side stones
    for (let i = 1; i < w - 1; i += 3) ctx.fillRect(x + i, top, 1 + (i % 2), 1);
    const water = pool.water;
    for (let i = 0; i < water.h; i++) {
      ctx.fillStyle = mix(T.seaHi, T.sea, water.h > 1 ? i / (water.h - 1) : 0);
      ctx.fillRect(water.x, water.y + i, water.w, 1);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(water.x, water.y, water.w, water.h);
    ctx.clip();
    pool.swimmers.forEach((s, i) => {
      const bob = still ? 0 : Math.round(Math.sin(t * 1.3 + i * 1.7) * 0.6);
      ctx.drawImage(sprite(s.pixels, s.palette), s.x, s.y + bob);
    });
    // A glint drifting across the top of the water.
    ctx.fillStyle = T.foam;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(water.x + (still ? 1 : Math.floor(t * 0.8) % water.w), water.y, 2, 1);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * Paint the beach into ctx (already scaled to art pixels), from x0 to x1.
   * opts: { time, t (seconds), crab: { img, w, h, hop }, reveal: id -> 0..1,
   *         pops: [{ x, y, age }] (hearts, age 0..1), still: no flicker }.
   */
  function paint(ctx, v, { time = timeOfDay(), t = 0, x0 = 0, x1 = v.paintWidth, crab = null, reveal = null, pops = [], still = false } = {}) {
    const T = THEMES[time] || THEMES.night;
    ctx.imageSmoothingEnabled = false;
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.ceil(x1);
    sky(ctx, T, v, x0, x1, t);
    sea(ctx, T, v, x0, x1, t);
    sand(ctx, T, v, x0, x1, t);

    // Back to front, by where each thing stands on the sand.
    const items = [
      ...v.finds.map(f => ({ y: f.y, x: f.x, w: 9, draw: () => drawFind(ctx, T, f, t, still) })),
      ...v.plots.map(p => ({ ...p, draw: () => { shadow(ctx, p.x, p.y, p.w); ctx.drawImage(sprite(v.art.plot, { ...T.castle, k: FIXED.k, i: FIXED.i, b: FIXED.b, B: FIXED.B }), p.x, p.y - p.h); } })),
      ...(v.stake ? [{ ...v.stake, draw: () => ctx.drawImage(sprite(v.art.stake, { f: FIXED.stakeFlag, p: FIXED.p, S: T.castle.S }), v.stake.x, v.stake.y - v.stake.h) }] : []),
      ...v.castles.map(c => ({ ...c, draw: () => drawCastle(ctx, T, c, reveal ? reveal.get(c.id) ?? 1 : 1, t) })),
      ...(v.pool ? [{ x: v.pool.x, y: v.pool.y, w: v.pool.w, draw: () => drawPool(ctx, T, v.pool, t, still) }] : []),
      ...(crab ? [{ x: v.crab.x, y: v.crab.y, w: crab.w, draw: () => {
        shadow(ctx, v.crab.x + 2, v.crab.y, crab.w - 4);
        ctx.drawImage(crab.img, v.crab.x, v.crab.y - crab.h - (crab.hop || 0), crab.w, crab.h);
      } }] : []),
    ].filter(o => o.x + (o.w || 0) >= x0 - 2 && o.x <= x1 + 2).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const o of items) o.draw();

    for (const p of pops) {
      ctx.globalAlpha = Math.max(0, 1 - p.age);
      ctx.drawImage(sprite(HEART, p.gold ? { 1: '#ffd23f', 2: '#fff2b8' } : { 1: '#ff8fab', 2: '#ffd1dc' }), Math.round(p.x), Math.round(p.y - p.age * 16));
    }
    ctx.globalAlpha = 1;
  }

  // Small pictures of each thing for the key under the scene.
  function glyph(kind, time = timeOfDay()) {
    const T = THEMES[time] || THEMES.night;
    if (kind === 'castle') return sprite(['....pff.', '....p...', '.s.sSs.S', '.ssssssS', '.sswsssS', '.sssdssS', 'SSSSSSSS'], { ...T.castle, w: T.lights ? FIXED.lit : T.castle.d, p: FIXED.p, f: '#ff7a5c' });
    if (kind === 'tide') return sprite(['........', '.ff..ff.', 'ffffffff', 'wwwwwwww', '.g.g.gg.'], { f: T.foam, w: mix(T.sand, T.sea, 0.42), g: T.weed });
    if (kind === 'pool') return sprite(['.rrrrrr.', 'rhhhhhhr', 'rwbwwwwr', 'rwwwwbwr', '.rrrrrr.'], { r: mix(T.sandLo, '#5d6670', 0.6), h: T.seaHi, w: T.sea, b: '#ff8fab' });
    if (kind === 'plot') return sprite(['.......kk', '........k', '.BBB....k', '.bbb.s.si', 'SSSSSSSSS'], { ...T.castle, k: FIXED.k, i: FIXED.i, b: FIXED.b, B: FIXED.B });
    return sprite(['.bbb.', 'bcbba', 'bbbba', '.aaa.'], { a: '#8d99ae', b: '#b8c2d1', c: '#dfe5ec' });
  }

  SB.beachPaint = { THEMES, timeOfDay, paint, sprite, glyph, mix };
})();
