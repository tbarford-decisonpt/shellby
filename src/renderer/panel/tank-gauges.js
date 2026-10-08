/* Shellby panel — his tank's live decor (src/main/tank/gauges.js decides what
   it shows). Main pushes a new reading only when it changes; this keeps the
   latest and paints it into the tank: the thermometer on the front glass, the
   lighthouse's lamp, bubblers that hurry with CPU load, and Health's moods in
   the water. Nothing here runs on a timer: the Tank tab's own frames (and the
   Health porthole's one still frame) call in. Loaded after tank-paint.js. */
'use strict';
(function () {
  const { api, state } = SB;

  const BUBBLE_SPEED = [1, 1.5, 2.2, 3];      // per tank-gauges.js LOAD_STEPS step
  const MOOD_TINT = { hot: ['#ff8a3d', 0.16], scorching: ['#ff4a2a', 0.24], dizzy: ['#b48cff', 0.08], stuffed: null };
  const BOX = { k: '#5b3d1e', b: '#a87a45', l: '#c99b62' };
  const LAMP = '#ffe27a';
  const TEMP_LO = 20, TEMP_HI = 100;          // °C at the bottom and the top of the thermometer
  const LIGHTHOUSE = 'lighthouse';

  let g = null; // the latest reading from main

  // ------------------------------------------------------------ painting

  /** The water's mood, over the back glass and under everything in it. */
  function under(ctx, scene, gg, t, still) {
    const tint = gg?.mood && MOOD_TINT[gg.mood];
    if (!tint) return;
    const { world } = scene;
    ctx.fillStyle = tint[0];
    ctx.globalAlpha = tint[1];
    ctx.fillRect(0, 0, world.w, world.sandTop + 2);
    if (gg.mood === 'dizzy') { // a slow swirl in the middle of the water
      const cx = world.w / 2, cy = world.sandTop / 2, turn = still ? 0 : t * 1.4;
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 18; i++) {
        const a = turn + i * 0.7, r = 3 + i * 0.9;
        ctx.globalAlpha = 0.25 - i * 0.01;
        ctx.fillRect(Math.round(cx + Math.cos(a) * r * 1.6), Math.round(cy + Math.sin(a) * r * 0.6), 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // A pile of cardboard boxes in the front corner, from his desktop "stuffed" mood.
  function boxes(ctx, world) {
    const x0 = world.w - 22, y0 = world.h - 2;
    const one = (x, y, w, h) => {
      ctx.fillStyle = BOX.k; ctx.fillRect(x, y - h, w, h);
      ctx.fillStyle = BOX.b; ctx.fillRect(x + 1, y - h + 1, w - 2, h - 2);
      ctx.fillStyle = BOX.l; ctx.fillRect(x + 1, y - h + 1, w - 2, 1);
      ctx.fillStyle = BOX.k; ctx.fillRect(x + Math.floor(w / 2), y - h + 1, 1, 2);
    };
    one(x0, y0, 9, 7);
    one(x0 + 10, y0, 10, 8);
    one(x0 + 4, y0 - 7, 9, 6);
  }

  function lamp(ctx, scene, gg, t, still) {
    const l = gg?.lighthouse;
    if (!l?.lit || (l.blink && !still && Math.floor(t * 2) % 2)) return;
    for (const p of scene.pieces) {
      if (p.ref !== LIGHTHOUSE) continue;
      const cx = p.x + Math.floor(p.w / 2), top = p.y - p.h + 1;
      ctx.fillStyle = l.blink ? '#ff6b5a' : LAMP;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(cx - 3, top - 1, 7, 5);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(cx - 1, top + 1, 3, 2);
      ctx.globalAlpha = 0.12; // the beam, out over the water
      ctx.fillRect(cx + 3, top + 1, Math.min(24, scene.world.w - cx - 3), 2);
      ctx.globalAlpha = 1;
    }
  }

  // The suction-cup thermometer, on the inside of the front glass at the right.
  function thermometer(ctx, world, th) {
    if (!th) return;
    const x = world.w - 6, top = 6, bottom = world.sandTop - 3;
    const span = bottom - top;
    const frac = Math.max(0, Math.min(1, (th.value - TEMP_LO) / (TEMP_HI - TEMP_LO)));
    const fill = Math.round(span * frac);
    ctx.fillStyle = '#e8f6ff';
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x - 1, top - 1, 3, span + 2);   // the tube
    ctx.fillRect(x - 2, top - 3, 5, 2);          // the suction cup
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = th.hot ? '#ff3b30' : '#ffd23f';
    ctx.fillRect(x, bottom - fill, 1, fill);
    ctx.fillRect(x - 1, bottom, 3, 2);           // the bulb
    if (th.warn) { // your Health line, a notch on the tube
      const at = bottom - Math.round(span * Math.max(0, Math.min(1, (th.warn - TEMP_LO) / (TEMP_HI - TEMP_LO))));
      ctx.fillStyle = '#ff6b5a';
      ctx.globalAlpha = 0.8;
      ctx.fillRect(x + 2, at, 2, 1);
    }
    ctx.globalAlpha = 1;
  }

  /** Over everything but the glass's own streaks. */
  function over(ctx, scene, gg, t, still) {
    if (!gg) return;
    if (gg.mood === 'stuffed') boxes(ctx, scene.world);
    lamp(ctx, scene, gg, t, still);
    thermometer(ctx, scene.world, gg.thermometer);
  }

  /** How much faster the bubbles rise. */
  const bubbleSpeed = gg => BUBBLE_SPEED[gg?.bubbler ?? 0] || 1;

  // ------------------------------------------------------------ words, for the tank's description

  function words(gg = g) {
    if (!gg) return '';
    const parts = [];
    if (gg.thermometer) parts.push(`The thermometer reads ${gg.thermometer.value}°${gg.thermometer.hot ? ', past your Health line' : ''}.`);
    if (gg.lighthouse?.lit) parts.push(gg.lighthouse.blink ? 'The lighthouse is blinking: a dev server crashed.' : 'The lighthouse is lit: a dev server is running.');
    if (gg.mood === 'hot' || gg.mood === 'scorching') parts.push('The water is warm.');
    if (gg.mood === 'dizzy') parts.push('The water is swirling.');
    if (gg.mood === 'stuffed') parts.push('Boxes are piled in a corner.');
    return parts.join(' ');
  }

  // ------------------------------------------------------------ data in

  // The switches under the tank, and a line saying what they show right now.
  function renderSwitches() {
    document.querySelectorAll('[data-live]').forEach(el => { el.checked = g?.live?.[el.dataset.live] !== false; });
    const now = document.getElementById('tkLiveNow');
    if (now) now.textContent = words() || 'Nothing to show right now: all calm.';
  }

  function take(next) {
    if (!next || typeof next !== 'object') return;
    const moodChanged = next.mood !== g?.mood;
    g = next;
    if (state.view === 'tank') renderSwitches();
    document.dispatchEvent(new CustomEvent('sb:tank-gauges', { detail: { moodChanged } }));
  }

  document.addEventListener('change', async e => {
    const el = e.target.closest?.('[data-live]');
    if (!el) return;
    const on = el.checked;
    const r = await api.setTankLive({ key: el.dataset.live, on }).catch(() => null);
    if (!r?.ok) { el.checked = !on; SB.toast('Couldn’t change that. Try again in a moment.'); return; }
    take(r.gauges);
    renderSwitches();
  });

  api.onTankGauges?.(take);
  // Asked once when the tank or Health comes into view (pushes stop while the panel is hidden).
  const ask = () => api.getTankGauges?.().then(next => { take(next); renderSwitches(); }).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (state.view === 'tank' || state.view === 'health')) ask(); });
  ask();

  SB.tankGauges = {
    current: () => g, under, over, bubbleSpeed, words, refresh: ask,
  };
})();
