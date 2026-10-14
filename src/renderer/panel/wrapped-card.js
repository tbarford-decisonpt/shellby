/* Shellby panel — the Wrapped card (docs/WRAPPED.md): one 1200x630 PNG of a
   year, in the crab card's look (card.js's kit). His tank and him as he's
   dressed now on the left; the year, six tiles of its biggest numbers, the
   year's nemesis bug and the molt badge on the right. Saved and copied the way
   every card is (card:save, which also counts Show-Off). */
'use strict';
(function () {
  const K = SB.cardKit;
  const { W, H, C } = K;
  const HEX = /^#[0-9a-f]{6}$/i;
  const GOLD = '#f2c14e';
  const TILE_COLOURS = [C.amber, C.glass, C.coral, '#9a6ad0', '#6fbf4a', '#4a8fe0'];

  function drawArt(ctx, art, x, y, box) {
    if (!art?.pixels?.length) return;
    const w = Math.max(...art.pixels.map(r => r.length)), ht = art.pixels.length;
    const px = Math.max(2, Math.floor(box / Math.max(w, ht)));
    const ox = x + (box - w * px) / 2, oy = y + (box - ht * px) / 2;
    art.pixels.forEach((row, j) => [...row].forEach((ch, i) => {
      const col = art.palette?.[ch];
      if (ch === '.' || !HEX.test(col || '')) return;
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(ox + i * px), Math.round(oy + j * px), px, px);
    }));
  }

  // The card-foil perk (level 77): a gold edge with a sheen across it.
  function drawFoil(ctx) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#b8862b');
    g.addColorStop(0.45, '#fff3b0');
    g.addColorStop(0.55, GOLD);
    g.addColorStop(1, '#b8862b');
    ctx.strokeStyle = g;
    ctx.lineWidth = 10;
    K.roundRect(ctx, 5, 5, W - 10, H - 10, 22);
    ctx.stroke();
  }

  /** Draw a year (the 'wrapped' game view for one year). */
  async function draw(v) {
    await K.loadFonts();
    const { canvas, ctx } = K.newCanvas();
    K.drawWater(ctx);
    await K.drawTank(ctx, []);

    const tx = 560, right = W - 56, card = v.card || {};
    ctx.fillStyle = C.amber;
    ctx.fillText(K.fitText(ctx, 'SHELLBY WRAPPED', 340, '600 22px "Martian Mono"'), tx, 96);
    ctx.fillStyle = C.sand;
    ctx.fillText(K.fitText(ctx, String(v.year), 300, '92px "Pixelify Sans"'), tx, 178);
    ctx.fillStyle = C.sandDim;
    const sub = v.partial && v.since ? `Since ${new Date(`${v.since}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, with Shellby` : 'A year with Shellby';
    ctx.fillText(K.fitText(ctx, sub, 360, '24px "Atkinson Hyperlegible"'), tx, 218);

    // The nemesis, top right, and the molt badge under it.
    if (card.nemesis?.art) {
      const box = 104, bx = right - box, by = 56;
      K.roundRect(ctx, bx - 8, by - 8, box + 16, box + 16, 18);
      ctx.fillStyle = 'rgba(17,35,42,.9)';
      ctx.fill();
      drawArt(ctx, card.nemesis.art, bx, by, box);
      ctx.fillStyle = C.sandDim;
      ctx.textAlign = 'right';
      ctx.fillText(K.fitText(ctx, `Nemesis: ${card.nemesis.name}`, 260, '600 14px "Martian Mono"'), right + 8, by + box + 32);
      ctx.textAlign = 'left';
    }
    if (card.molts) {
      const text = `Molted ×${card.molts}`;
      ctx.font = '700 18px "Atkinson Hyperlegible"';
      const bw = ctx.measureText(text).width + 28;
      K.roundRect(ctx, tx, 236, bw, 34, 17);
      ctx.fillStyle = 'rgba(185,140,255,.22)';
      ctx.fill();
      ctx.fillStyle = '#d9c2ff';
      ctx.fillText(text, tx + 14, 259);
    }

    // Six tiles, two rows of three.
    const tiles = (card.tiles || []).slice(0, 6).map(([label, value], i) => [value, label, TILE_COLOURS[i % TILE_COLOURS.length]]);
    const gap = 14, tw = (right - tx - gap * 2) / 3; // drawTiles' gap, three to a row
    const row = (list, y) => list.length && K.drawTiles(ctx, list, tx, list.length * tw + (list.length - 1) * gap, y, 112);
    row(tiles.slice(0, 3), 292);
    row(tiles.slice(3), 418);

    if (card.foil) drawFoil(ctx);
    await K.drawFooter(ctx);
    return { canvas, data: v };
  }

  const postText = v => {
    const tile = (card, label) => card?.tiles?.find(t => t[0] === label)?.[1];
    const xp = tile(v.card, 'XP'), days = tile(v.card, 'days together');
    return `My ${v.year} with Shellby 🦀 ${xp ? `${xp} XP` : ''}${days ? `, ${days} days together` : ''}. A pixel hermit crab that runs Claude Code on my desktop. #ShellbyWrapped`;
  };

  /** Draw it, save it and show the share sheet. */
  function share(v) {
    return K.present({
      kind: 'wrapped', draw: () => draw(v), post: postText, buttons: '[data-wrapped-card]',
      title: `Shellby Wrapped ${v.year}`,
      alt: `Your Shellby Wrapped ${v.year} card: your crab in his tank, with the year's biggest numbers`,
    });
  }

  SB.wrappedCard = { draw, share };
})();
