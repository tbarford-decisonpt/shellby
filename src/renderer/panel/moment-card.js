/* Shellby panel — moment cards: one 1200x630 PNG for a single moment worth
   showing someone (a sparkly find, a tide event's medal, the friends' board, a
   hatched egg), in the crab card's look (card.js's kit). Each caller says what
   the moment was; this draws the big pixel art, the words and the footer. */
'use strict';
(function () {
  const K = SB.cardKit;
  const { W, H, C } = K;
  const HEX = /^#[0-9a-f]{6}$/i;

  /** Pixel art (gifts.js format) on the canvas, each pixel `px` square. */
  function drawPixels(ctx, pixels, palette, x, y, px) {
    pixels.forEach((row, j) => [...row].forEach((ch, i) => {
      const c = palette?.[ch];
      if (ch === '.' || !HEX.test(c || '')) return;
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x + i * px), Math.round(y + j * px), Math.ceil(px), Math.ceil(px));
    }));
  }

  /** The biggest whole-pixel scale that fits the art in a box. */
  const scaleFor = (pixels, box) => Math.max(4, Math.floor(box / Math.max(pixels.length, ...pixels.map(r => r.length))));

  // A starfield of little four-point glints, placed the same way every time.
  function drawGlints(ctx, accent, n = 34) {
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < n; i++) {
      const x = rnd() * W, y = rnd() * (H - 80), s = 2 + Math.floor(rnd() * 3);
      if (x > 500 && x < W - 30 && y > 90 && y < 500) continue; // never over the words
      ctx.fillStyle = i % 3 ? 'rgba(255,255,255,.55)' : accent;
      ctx.fillRect(x, y - s, s / 2 + 1, s * 2 + 1);
      ctx.fillRect(x - s, y, s * 2 + 1, s / 2 + 1);
    }
  }

  /**
   * Draw a moment.
   *   m: { eyebrow, title, sub, art: { pixels, palette }, accent, stats: [[label, value]], glints, badge }
   */
  async function draw(m) {
    await K.loadFonts();
    const { canvas, ctx } = K.newCanvas();
    K.drawWater(ctx);
    const accent = HEX.test(m.accent || '') ? m.accent : C.amber;
    if (m.glints) drawGlints(ctx, accent);

    // The art, big, on a soft halo at the left.
    const box = 380, ax = 70, ay = 70;
    const halo = ctx.createRadialGradient(ax + box / 2, ay + box / 2, 10, ax + box / 2, ay + box / 2, box * 0.62);
    halo.addColorStop(0, `${accent}55`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(ax - 60, ay - 60, box + 120, box + 120);
    if (m.art?.pixels?.length) {
      const px = scaleFor(m.art.pixels, box * 0.78);
      const w = Math.max(...m.art.pixels.map(r => r.length)) * px, h = m.art.pixels.length * px;
      drawPixels(ctx, m.art.pixels, m.art.palette, ax + (box - w) / 2, ay + (box - h) / 2, px);
    }

    // The words, at the right.
    const tx = 520, maxW = W - tx - 60;
    ctx.fillStyle = accent;
    ctx.font = '600 22px "Martian Mono"';
    ctx.fillText(K.fitText(ctx, (m.eyebrow || '').toUpperCase(), maxW, '600 22px "Martian Mono"'), tx, 130);
    ctx.fillStyle = C.sand;
    ctx.fillText(K.fitText(ctx, m.title || '', maxW, '64px "Pixelify Sans"'), tx, 210);
    if (m.sub) {
      ctx.fillStyle = C.sandDim;
      ctx.fillText(K.fitText(ctx, m.sub, maxW, '24px "Atkinson Hyperlegible"'), tx, 258);
    }
    if (m.badge) {
      ctx.font = '700 20px "Atkinson Hyperlegible"';
      const bw = ctx.measureText(m.badge).width + 32;
      K.roundRect(ctx, tx, 286, bw, 40, 20);
      ctx.fillStyle = `${accent}33`;
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.fillText(m.badge, tx + 16, 313);
    }
    // Up to four stats in a row of tiles.
    const stats = (m.stats || []).slice(0, 4);
    if (stats.length) K.drawTiles(ctx, stats.map(([label, value]) => [String(value), label, accent]), tx, W - tx - 60, 360, 128);
    await K.drawFooter(ctx);
    return { canvas, data: m };
  }

  /**
   * Draw it, save it and show the share sheet.
   *   kind: 'shiny' | 'medal' | 'board' | 'egg' (main names the file after it)
   */
  function share(kind, m, { title, alt, post }) {
    return K.present({ kind, draw: () => draw(m), title, alt, post: () => post, buttons: '[data-share-moment]' });
  }

  SB.momentCard = { draw, share, drawPixels };
})();
