/* Shellby panel — three more of his tank's live decor (src/main/tank/gauges.js
   decides what they show): the tide gauge on the left of the front glass (how
   much of the 5-hour usage window is left), the Sunken Chest glinting for a
   minute when a PR of yours merges, and a message in a bottle bobbing at the
   surface while a recap or a weekly card waits unread. tank-gauges.js calls
   in from its own painting and words; nothing here runs on a timer. Loaded
   after tank-gauges.js. */
'use strict';
(function () {
  const TIDE = { x: 5, top: 6, water: '#5ec8f2', low: '#ff9f43', lowAt: 20 }; // left of the glass's highlight
  const CHEST = 'sunken-chest';
  const GLINT = [[4, 1], [1, 2], [7, 3], [6, 1]]; // where on the chest the glint lands, in turn
  const BOTTLE = { glass: '#6fcf97', dark: '#3f8f63', paper: '#fff6d8', cork: '#a87a45' };

  // A narrow tube on the glass, filled to how much of the window is left.
  function tide(ctx, world, tg) {
    if (!tg) return;
    const bottom = world.sandTop - 3, span = bottom - TIDE.top;
    const fill = Math.round(span * Math.max(0, Math.min(100, tg.left)) / 100);
    ctx.fillStyle = '#e8f6ff';
    ctx.globalAlpha = 0.35;
    ctx.fillRect(TIDE.x - 1, TIDE.top - 1, 3, span + 2);
    for (let q = 1; q < 4; q++) ctx.fillRect(TIDE.x + 2, TIDE.top + Math.round(span * q / 4), 1, 1); // quarter marks
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = tg.left <= TIDE.lowAt ? TIDE.low : TIDE.water;
    ctx.fillRect(TIDE.x, bottom - fill, 1, fill);
    if (fill) { ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.7; ctx.fillRect(TIDE.x, bottom - fill, 1, 1); } // the waterline
    ctx.globalAlpha = 1;
  }

  // A four-point sparkle hopping round each chest.
  function glint(ctx, scene, t, still) {
    const [dx, dy] = GLINT[still ? 0 : Math.floor(t * 3) % GLINT.length];
    ctx.fillStyle = '#ffffff';
    for (const p of scene.pieces) {
      if (p.ref !== CHEST) continue;
      const x = p.x + (p.flip ? p.w - 1 - dx : dx), y = p.y - p.h + 1 + dy;
      ctx.globalAlpha = 0.95;
      ctx.fillRect(x, y, 1, 1);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x - 1, y, 1, 1); ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1); ctx.fillRect(x, y + 1, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  // A bottle on its side, bobbing at the surface a third of the way in.
  function bottle(ctx, world, t, still) {
    const x = Math.round(world.w / 3), y = 2 + (still ? 0 : Math.round(Math.sin(t * 1.6)));
    ctx.fillStyle = BOTTLE.dark;
    ctx.fillRect(x + 1, y, 4, 1);
    ctx.fillRect(x + 1, y + 2, 4, 1);
    ctx.fillStyle = BOTTLE.glass;
    ctx.fillRect(x, y + 1, 1, 1);
    ctx.fillRect(x + 4, y + 1, 2, 1);
    ctx.fillStyle = BOTTLE.paper;
    ctx.fillRect(x + 1, y + 1, 3, 1);
    ctx.fillStyle = BOTTLE.cork;
    ctx.fillRect(x + 6, y + 1, 1, 1);
  }

  function over(ctx, scene, gg, t, still) {
    tide(ctx, scene.world, gg.tide);
    if (gg.chest) glint(ctx, scene, t, still);
    if (gg.bottle) bottle(ctx, scene.world, t, still);
  }

  function words(gg) {
    const parts = [];
    if (gg.tide) parts.push(`The tide gauge shows ${gg.tide.left}% of your 5-hour window left.`);
    if (gg.chest) parts.push('The chest is glinting: a pull request of yours just merged.');
    if (gg.bottle) parts.push(gg.bottle === 'week' ? 'A message in a bottle: your weekly card is ready.' : 'A message in a bottle: there’s a recap of while you were away.');
    return parts.join(' ');
  }

  SB.tankGaugesMore = { over, words };
})();
