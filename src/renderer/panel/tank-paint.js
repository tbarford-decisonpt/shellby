/* Shellby panel — painting his tank (src/main/tank.js says where things stand).
   Everything is drawn in art pixels: the caller scales the context by a whole
   number. Used by the Tank tab and by the porthole on the Health view.

   resolve() turns a layout (what's stored, or the editor's draft) into the
   pieces to paint, in order, using the tray for their art, the same way
   tank.js view() does in main, so a piece moves under your cursor without a
   round trip. */
'use strict';
(function () {
  const B = SB.beachPaint; // sprite cache, colour mixing, time of day

  // The water at each hour: top and bottom of the tank, and how dark the room is.
  const WATER = {
    day: { top: '#3fa3b3', low: '#145463', shade: 0, rays: 0.1 },
    dawn: { top: '#5e6f8c', low: '#1d3b52', shade: 0.12, rays: 0.05 },
    dusk: { top: '#7a5a73', low: '#1f3446', shade: 0.15, rays: 0.04 },
    night: { top: '#163b4f', low: '#06141c', shade: 0.32, rays: 0 },
  };
  const BUBBLE = '#cdeafe';
  const LIT = new Set(['bubbler']); // these keep their colour after dark

  /** The hour the tank shows: the clock's, or the one you picked. */
  const timeOf = light => (light === 'day' || light === 'night' ? light : B.timeOfDay());

  // ------------------------------------------------------------ laying out

  const depthOf = p => (p.category === 'sticker' ? 6 : p.layer === 'back' ? 0 : p.layer === 'float' ? 5 : 1 + p.row); // stickers: on the front glass

  function baseline(world, layer, row) {
    if (layer === 'float') return world.floatY[row] ?? world.floatY[0];
    if (layer === 'back') return world.backY;
    return world.rows[row] ?? world.crabY;
  }

  /**
   * Pieces to paint from a layout ({ size, style, placed }), with the art from
   * the tray. `sizes` and `world` come from main's view; when the layout's size
   * differs from the view's (you're trying a bigger tank) the world is rebuilt.
   */
  function resolve(layout, v) {
    const art = new Map(v.tray.map(t => [t.ref, t]));
    const size = v.sizes.find(s => s.id === layout.size) || v.size;
    const world = worldFor(size, v.world);
    const pieces = [];
    for (const p of layout.placed) {
      const a = art.get(p.ref);
      if (!a || a.locked || a.category === 'substrate' || a.category === 'backdrop') continue;
      const row = a.layer === 'back' ? 0 : p.row;
      pieces.push({ ...a, uid: p.uid, row, x: Math.max(0, Math.min(p.x, size.w - a.w)), y: baseline(world, a.layer, row), z: p.z, flip: p.flip });
    }
    pieces.sort((a, b) => depthOf(a) - depthOf(b) || a.z - b.z || a.x - b.x || a.uid - b.uid);
    const pick = role => {
      const chosen = layout.style[role] && art.get(layout.style[role]);
      return chosen && !chosen.locked && chosen.category === role ? chosen : v.style[role];
    };
    return { size, world, pieces, style: { substrate: pick('substrate'), backdrop: pick('backdrop'), light: layout.style.light } };
  }

  // tank.js geometry(), for a size other than the one main laid out.
  function worldFor(size, like) {
    if (size.h === like.h && size.w === like.w) return like;
    const shift = size.h - like.h;
    return {
      ...like, w: size.w, h: size.h, sandTop: like.sandTop + shift,
      rows: like.rows.map(y => y + shift), backY: like.backY + shift, crabY: like.crabY + shift,
    };
  }

  // ------------------------------------------------------------ painting

  function tile(ctx, img, x0, y0, x1, y1) {
    for (let y = y0; y < y1; y += img.height) {
      for (let x = x0; x < x1; x += img.width) {
        const w = Math.min(img.width, x1 - x), h = Math.min(img.height, y1 - y);
        ctx.drawImage(img, 0, 0, w, h, x, y, w, h);
      }
    }
  }

  function water(ctx, scene, W, t, still) {
    const { world, style } = scene;
    const top = 0, bottom = world.sandTop + 2;
    if (style.backdrop) tile(ctx, B.sprite(style.backdrop.pixels, style.backdrop.palette), 0, top, world.w, bottom);
    else { ctx.fillStyle = W.low; ctx.fillRect(0, top, world.w, bottom); }
    // The water over the back glass: lighter near the top, where the light comes in.
    const g = ctx.createLinearGradient(0, 0, 0, bottom);
    g.addColorStop(0, W.top);
    g.addColorStop(1, W.low);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = g;
    ctx.fillRect(0, top, world.w, bottom);
    ctx.globalAlpha = 1;
    // Light coming down through it, drifting.
    if (W.rays) {
      ctx.fillStyle = '#ffffff';
      const drift = still ? 0 : Math.round(t * 1.5) % 40;
      for (let x = -40 + drift; x < world.w + 20; x += 40) {
        ctx.globalAlpha = W.rays;
        for (let y = 0; y < bottom; y++) ctx.fillRect(x + Math.floor(y / 3), y, 6, 1);
      }
      ctx.globalAlpha = 1;
    }
    // The surface, lapping.
    ctx.fillStyle = B.mix(W.top, '#ffffff', 0.35);
    for (let x = 0; x < world.w; x++) {
      const dy = still ? 0 : Math.round(Math.sin(x / 6 + t * 1.2) * 0.6);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x, 2 + dy, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function floor(ctx, scene) {
    const { world, style } = scene;
    const top = world.sandTop;
    if (style.substrate) tile(ctx, B.sprite(style.substrate.pixels, style.substrate.palette), 0, top, world.w, world.h);
    else { ctx.fillStyle = '#a8946c'; ctx.fillRect(0, top, world.w, world.h - top); }
    // Its back edge catches the light; the front is in the glass's shadow.
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.18;
    ctx.fillRect(0, top, world.w, 1);
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.12;
    ctx.fillRect(0, world.h - 1, world.w, 1);
    ctx.globalAlpha = 1;
  }

  const frameOf = (p, t, still) => {
    if (still || !p.frames.length || !p.fps) return p.pixels;
    const i = Math.floor(t * p.fps + p.uid * 0.37) % (p.frames.length + 1);
    return i === 0 ? p.pixels : p.frames[i - 1];
  };

  function piece(ctx, p, t, still, alpha = 1) {
    const img = B.sprite(frameOf(p, t, still), p.palette);
    const top = p.y - p.h + 1;
    if (p.layer !== 'float') { // a soft shadow where it meets the floor
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.2 * alpha;
      ctx.fillRect(p.x + 1, p.y + 1, Math.max(1, p.w - 1), 1);
    }
    ctx.globalAlpha = alpha;
    if (p.flip) {
      ctx.save();
      ctx.translate(p.x + p.w, top);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(img, p.x, top);
    }
    ctx.globalAlpha = 1;
  }

  // A column of bubbles over every bubbler on the floor.
  function bubbles(ctx, scene, t, still) {
    ctx.fillStyle = BUBBLE;
    for (const p of scene.pieces) {
      if (p.category !== 'bubbler' || p.layer === 'float') continue;
      const cx = p.x + Math.floor(p.w / 2), from = p.y - p.h;
      const span = Math.max(8, from - 3);
      for (let i = 0; i < 6; i++) {
        const rise = still ? i * (span / 6) : (t * 9 + i * (span / 6) + p.uid * 5) % span;
        const y = Math.round(from - rise);
        const x = cx + (still ? 0 : Math.round(Math.sin(t * 2 + i * 1.7) * 1));
        ctx.globalAlpha = 0.35 + 0.4 * (1 - rise / span);
        if (i % 3 === 0) { ctx.fillRect(x - 1, y, 1, 1); ctx.fillRect(x + 1, y, 1, 1); ctx.fillRect(x, y - 1, 1, 1); ctx.fillRect(x, y + 1, 1, 1); }
        else ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // lift (art px up) and crop (rows of him from the top, 0 for none of him)
  // come from his life in the tank (tank-life.js): sitting on things, peeking out.
  function crabOn(ctx, scene, crab) {
    const y = scene.world.crabY - crab.h + 1 - (crab.hop || 0) - (crab.lift || 0);
    const alpha = crab.alpha ?? 1;
    const rows = crab.crop == null ? crab.h : Math.max(0, Math.min(crab.h, crab.crop));
    if (!rows) return;
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 0.22 * alpha;
    if (!crab.lift && rows === crab.h) ctx.fillRect(Math.round(crab.x) + 3, scene.world.crabY + 1, crab.w - 6, 1);
    ctx.globalAlpha = alpha;
    const sh = rows * ((crab.img.height || crab.h) / crab.h);
    if (crab.flip) {
      ctx.save();
      ctx.translate(Math.round(crab.x) + crab.w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(crab.img, 0, 0, crab.img.width || crab.w, sh, 0, 0, crab.w, rows);
      ctx.restore();
    } else {
      ctx.drawImage(crab.img, 0, 0, crab.img.width || crab.w, sh, Math.round(crab.x), y, crab.w, rows);
    }
    ctx.globalAlpha = 1;
  }

  // The front glass: faint streaks and a highlight down one side.
  function glass(ctx, world) {
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.035;
    for (let x = 5; x < world.w; x += 8) ctx.fillRect(x, 0, 1, world.h);
    ctx.globalAlpha = 0.08;
    ctx.fillRect(2, 4, 1, world.h - 8);
    ctx.globalAlpha = 1;
  }

  /**
   * Paint a resolved scene into ctx (already scaled to art pixels).
   * opts: { t (seconds), still, crab: { img, w, h, x, flip, hop, alpha } | null,
   *         ghost: a piece being dragged in, drawn see-through,
   *         dim: uid -> alpha (the piece you're dragging, faded where it was),
   *         gauges: live decor from tank-gauges.js, or null }
   */
  function paint(ctx, scene, { t = 0, still = false, crab = null, ghost = null, dim = null, gauges = null } = {}) {
    const W = WATER[timeOf(scene.style.light)] || WATER.night;
    const G = gauges && SB.tankGauges;
    ctx.imageSmoothingEnabled = false;
    water(ctx, scene, W, t, still);
    floor(ctx, scene);
    if (G) G.under(ctx, scene, gauges, t, still);
    const behind = scene.pieces.filter(p => depthOf(p) <= 2);
    const front = scene.pieces.filter(p => depthOf(p) > 2);
    const alphaOf = p => (dim && dim.has(p.uid) ? dim.get(p.uid) : 1);
    const sway = G ? G.swaySpeed(gauges) : 1; // plants sway faster when he's hot
    const tOf = p => (p.category === 'plant' ? t * sway : t);
    for (const p of behind) piece(ctx, p, tOf(p), still, alphaOf(p));
    if (crab && !crab.front) crabOn(ctx, scene, crab);
    for (const p of front.filter(p => p.layer !== 'float')) piece(ctx, p, tOf(p), still, alphaOf(p));
    if (crab && crab.front) crabOn(ctx, scene, crab); // up on something in the front row
    bubbles(ctx, scene, G ? t * G.bubbleSpeed(gauges) : t, still);
    // After dark the room dims, but lamps and bubblers keep their glow.
    if (W.shade) {
      ctx.fillStyle = '#020a10';
      ctx.globalAlpha = W.shade;
      ctx.fillRect(0, 0, scene.world.w, scene.world.h);
      ctx.globalAlpha = 1;
    }
    for (const p of front.filter(p => p.layer === 'float')) {
      if (W.shade && LIT.has(p.category)) { // a soft glow around it
        ctx.fillStyle = B.mix(p.palette[Object.keys(p.palette)[0]], '#ffffff', 0.3);
        ctx.globalAlpha = 0.12;
        ctx.fillRect(p.x - 2, p.y - p.h - 1, p.w + 4, p.h + 4);
        ctx.globalAlpha = 1;
      }
      piece(ctx, p, tOf(p), still, alphaOf(p));
    }
    if (ghost) piece(ctx, ghost, t, true, 0.6);
    if (G) G.over(ctx, scene, gauges, t, still);
    glass(ctx, scene.world);
  }

  /** One piece on its own, for the tray: a small canvas, `k` device px a pixel. */
  function thumb(item, box) {
    const src = B.sprite(item.pixels, item.palette);
    const k = Math.max(1, Math.floor(box / Math.max(src.width, src.height)));
    const c = document.createElement('canvas');
    c.width = src.width * k;
    c.height = src.height * k;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * A still picture of a scene ({ world, style, pieces }), one canvas px per art
   * pixel: for the crab card and a friend's tank, which scale it up themselves.
   * crab: as paint() takes it, or null.
   */
  function still(scene, crab = null) {
    const c = document.createElement('canvas');
    c.width = scene.world.w;
    c.height = scene.world.h;
    paint(c.getContext('2d'), scene, { still: true, crab });
    return c;
  }

  /**
   * Where a card's view of a tank starts, and where he stands in it: beside
   * its biggest piece (on the right, or the left when there's no room), with
   * the two of them in the middle of a `cropW`-wide window. Art pixels.
   */
  function framing(v, cropW, crabW) {
    const { world } = v;
    const clampTo = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    const anchor = v.pieces.filter(p => p.layer !== 'float').sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!anchor) {
      const x0 = clampTo(Math.round(v.focusX - cropW / 2), 0, Math.max(0, world.w - cropW));
      return { x0, crabX: clampTo(Math.round(x0 + (cropW - crabW) / 2), 0, Math.max(0, world.w - crabW)) };
    }
    const right = anchor.x + anchor.w + 2 + crabW <= world.w;
    const crabX = right ? anchor.x + anchor.w + 2 : Math.max(0, anchor.x - crabW - 2);
    const lo = Math.min(anchor.x, crabX), hi = Math.max(anchor.x + anchor.w, crabX + crabW);
    const x0 = clampTo(Math.round((lo + hi - cropW) / 2), 0, Math.max(0, world.w - cropW));
    return { x0, crabX: clampTo(crabX, x0, Math.max(x0, Math.min(world.w, x0 + cropW) - crabW)) };
  }

  SB.tankPaint = { WATER, timeOf, resolve, paint, thumb, baseline, still, framing };
})();
