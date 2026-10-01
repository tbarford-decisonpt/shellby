/* Shellby panel — the shareable crab card: a 1200x630 PNG of Shellby as he's
   dressed right now, with trophies and task count. Drawn on a canvas from the
   same pixel data as everything else; main saves it and copies it to the clipboard. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const W = 1200, H = 630;
  const C = {
    abyss: '#061316', reef: '#11232a', line: '#214049', sand: '#f3e6cc', sandDim: '#b3a892',
    sandFaint: '#7d7566', glass: '#7fd6c2', coral: '#ff7a5c', amber: '#ffc15e',
  };
  const REPO = 'https://github.com/x-salmon/shellby';

  // The title is the most impressive trophy earned (first match wins).
  const TITLE_ORDER = ['centurion', 'fleet', 'inventor', 'quarter-century', 'loyal', 'keep-your-cool', 'all-hands',
    'spring-cleaning', 'multitasker', 'night-owl', 'early-bird', 'tinkerer', 'planner', 'ten-tasks', 'crew-boss',
    'toolmaker', 'clockwork', 'careful', 'check-up', 'special-delivery', 'first-task'];

  function cardData() {
    const v = state.wardrobe || {};
    const done = (v.achievements || []).filter(a => a.done);
    const byId = new Map(done.map(a => [a.id, a]));
    const top = TITLE_ORDER.map(id => byId.get(id)).find(Boolean) || done[0] || null;
    const o = v.outfit || {};
    const named = [...(state.outfit?.accessories || []).map(a => a.name), state.outfit?.effect?.name].filter(Boolean);
    return {
      title: top ? top.name : 'Fresh out of the shell',
      titleIcon: top ? top.icon : '🐚',
      wearing: named,
      tasks: v.stats?.tasksCompleted ?? 0,
      helpers: v.stats?.helpersSpawned ?? 0,
      days: v.stats?.activeDays ?? 0,
      trophies: done.length,
      trophiesAll: (v.achievements || []).length,
      badges: done.map(a => a.icon),
      season: v.season?.wearing ? v.season : null,
      code: SB.outfitCode?.() || null,
      hasOutfit: !!(o && Object.values(o).some(Boolean)),
    };
  }

  // ------------------------------------------------------------ drawing helpers

  function svgImage(svg, width, height) {
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth, font) {
    ctx.font = font;
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  // ------------------------------------------------------------ the card

  async function render() {
    await Promise.all(['64px "Pixelify Sans"', '600 15px "Martian Mono"', '20px "Atkinson Hyperlegible"', '700 20px "Atkinson Hyperlegible"']
      .map(f => document.fonts.load(f).catch(() => null)));
    // Fresh numbers: the panel's wardrobe view only refreshes when something unlocks.
    SB.applyWardrobe(await api.wardrobeView());
    if (!SB.outfitCode?.()) await new Promise(r => setTimeout(r, 50));
    const d = cardData();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Water: deep gradient with two soft lights, like the panel.
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0f3039');
    bg.addColorStop(1, C.abyss);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (const [x, y, r, col] of [[180, 120, 420, 'rgba(127,214,194,.10)'], [1100, 640, 460, 'rgba(255,122,92,.08)']]) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // Shellby's tank on the left.
    const tank = { x: 48, y: 48, w: 470, h: 470 };
    ctx.save();
    roundRect(ctx, tank.x, tank.y, tank.w, tank.h, 26);
    ctx.fillStyle = 'rgba(6,19,22,.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(127,214,194,.18)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.clip();
    ctx.fillStyle = 'rgba(127,214,194,.035)';
    for (let x = tank.x + 24; x < tank.x + tank.w; x += 24) ctx.fillRect(x, tank.y, 1, tank.h);
    // sand
    const sandY = tank.y + tank.h - 70;
    ctx.fillStyle = '#7a6a4b';
    ctx.fillRect(tank.x, sandY, tank.w, 70);
    ctx.fillStyle = '#a8946c';
    ctx.fillRect(tank.x, sandY, tank.w, 10);
    ctx.fillStyle = 'rgba(201,180,138,.55)';
    for (let i = 0; i < 90; i++) ctx.fillRect(tank.x + ((i * 53) % tank.w), sandY + 16 + ((i * 29) % 48), 4, 4);

    // The crab, as dressed now (fit frames hats and held items too).
    const svg = SB.sprite(state.skin, { fit: true });
    const [, , vw, vh] = (svg.getAttribute('viewBox') || '0 0 22 13').split(' ').map(Number);
    const P = Math.floor(Math.min(360 / vw, 300 / vh));
    const crab = await svgImage(svg, vw * P, vh * P);
    const cx = tank.x + (tank.w - vw * P) / 2;
    const cy = sandY + 14 - vh * P;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.ellipse(tank.x + tank.w / 2, sandY + 18, vw * P * 0.42, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(crab, Math.round(cx), Math.round(cy));

    // His equipped effect, scattered around him (snow, sparkles, bats...).
    const fx = state.outfit?.effect;
    if (fx?.sprites?.length) {
      const spots = [[0.12, 0.14], [0.82, 0.1], [0.9, 0.42], [0.07, 0.5], [0.3, 0.06], [0.62, 0.22], [0.2, 0.32], [0.74, 0.58]];
      for (let i = 0; i < spots.length; i++) {
        const s = fx.sprites[i % fx.sprites.length];
        const sw = Math.max(...s.pixels.map(r => r.length)), sh = s.pixels.length;
        const k = Math.max(5, Math.round(30 / Math.max(sw, sh)));
        const img = await svgImage(SB.Sprite.grid(s.pixels, s.palette), sw * k, sh * k);
        ctx.drawImage(img, Math.round(tank.x + spots[i][0] * tank.w), Math.round(tank.y + spots[i][1] * (sandY - tank.y)));
      }
    }
    ctx.restore();

    // ---- right column
    const x0 = 568, right = W - 56, colW = right - x0;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.coral;
    ctx.font = '600 15px "Martian Mono"';
    ctx.fillText(d.season ? `MY SHELLBY · ${d.season.emoji} ${d.season.name.toUpperCase()}` : 'MY SHELLBY', x0, 92);

    ctx.fillStyle = C.sand;
    // Shrink a long title before resorting to an ellipsis.
    let size = 54;
    ctx.font = `600 ${size}px "Pixelify Sans"`;
    while (size > 36 && ctx.measureText(`${d.titleIcon} ${d.title}`).width > colW) ctx.font = `600 ${--size}px "Pixelify Sans"`;
    ctx.fillText(fitText(ctx, `${d.titleIcon} ${d.title}`, colW, ctx.font), x0, 150);

    ctx.fillStyle = C.sandDim;
    const wearing = d.wearing.length ? `Wearing ${d.wearing.join(', ')}` : 'Wearing nothing but a shell';
    ctx.fillText(fitText(ctx, wearing, colW, '20px "Atkinson Hyperlegible"'), x0, 188);

    // Three stat tiles.
    const tiles = [
      [d.tasks.toLocaleString(), d.tasks === 1 ? 'task done' : 'tasks done', C.coral],
      [`${d.trophies}/${d.trophiesAll}`, 'trophies', C.amber],
      [d.helpers.toLocaleString(), d.helpers === 1 ? 'helper crab sent' : 'helper crabs sent', C.glass],
    ];
    const gap = 14, tw = (colW - gap * 2) / 3, ty = 226, th = 128;
    tiles.forEach(([num, label, col], i) => {
      const x = x0 + i * (tw + gap);
      roundRect(ctx, x, ty, tw, th, 16);
      ctx.fillStyle = 'rgba(17,35,42,.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(127,214,194,.12)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(x, ty + 18, 4, th - 36);
      ctx.fillStyle = C.sand;
      ctx.fillText(fitText(ctx, num, tw - 36, '500 46px "Martian Mono"'), x + 22, ty + 70);
      ctx.fillStyle = C.sandDim;
      ctx.fillText(fitText(ctx, label, tw - 36, '17px "Atkinson Hyperlegible"'), x + 22, ty + 102);
    });

    // Trophy badges.
    const by = 392;
    ctx.fillStyle = C.sandFaint;
    ctx.font = '600 13px "Martian Mono"';
    ctx.fillText(d.badges.length ? 'TROPHY SHELF' : 'TROPHY SHELF · EMPTY FOR NOW', x0, by);
    const badge = 52;
    const perRow = Math.floor((colW + 10) / (badge + 10));
    d.badges.slice(0, perRow).forEach((icon, i) => {
      const bx = x0 + (i % perRow) * (badge + 10), byy = by + 16 + Math.floor(i / perRow) * (badge + 10);
      roundRect(ctx, bx, byy, badge, badge, 12);
      ctx.fillStyle = 'rgba(255,193,94,.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,193,94,.28)';
      ctx.stroke();
      ctx.fillStyle = '#fff'; // colour emoji take their alpha from fillStyle
      ctx.font = '28px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(icon, bx + badge / 2, byy + 36);
      ctx.textAlign = 'left';
    });
    if (d.badges.length > perRow) {
      ctx.fillStyle = C.sandDim;
      ctx.font = '600 15px "Martian Mono"';
      ctx.textAlign = 'right';
      ctx.fillText(`+${d.badges.length - perRow} more`, right, by);
      ctx.textAlign = 'left';
    }

    // The outfit code: anyone with Shellby can paste it to wear this look.
    if (d.code) {
      const cy = by + 16 + badge + 46;
      ctx.fillStyle = C.sandFaint;
      ctx.font = '600 13px "Martian Mono"';
      ctx.fillText('WEAR MY LOOK', x0, cy);
      ctx.fillStyle = C.glass;
      ctx.font = '500 26px "Martian Mono"';
      ctx.fillText(d.code, x0, cy + 34);
    }

    // Footer.
    ctx.fillStyle = 'rgba(6,19,22,.85)';
    ctx.fillRect(0, H - 64, W, 64);
    ctx.fillStyle = 'rgba(127,214,194,.18)';
    ctx.fillRect(0, H - 64, W, 1);
    const mini = await svgImage(SB.sprite(state.skin, { plain: true }), 22 * 2, 13 * 2);
    ctx.drawImage(mini, 48, H - 45);
    ctx.fillStyle = C.sand;
    ctx.font = '600 24px "Pixelify Sans"';
    ctx.fillText('Shellby', 104, H - 23);
    ctx.fillStyle = C.sandDim;
    ctx.font = '17px "Atkinson Hyperlegible"';
    ctx.fillText('the pixel hermit crab that runs Claude Code on your desktop', 210, H - 25);
    ctx.fillStyle = C.glass;
    ctx.font = '600 15px "Martian Mono"';
    ctx.textAlign = 'right';
    ctx.fillText('github.com/x-salmon/shellby', right, H - 25);
    ctx.textAlign = 'left';

    return { canvas, data: d };
  }

  // ------------------------------------------------------------ share flow

  const sheet = $('cardSheet');
  let last = null;

  const postText = d => `Meet my Shellby 🦀 ${d.tasks} task${d.tasks === 1 ? '' : 's'} done and ${d.trophies}/${d.trophiesAll} trophies. A pixel hermit crab that runs Claude Code on my desktop.${d.code ? ` Wear my look: ${d.code}` : ''}`;

  async function share() {
    const btns = document.querySelectorAll('[data-share-card]');
    btns.forEach(b => { b.disabled = true; });
    try {
      const { canvas, data } = await render();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const r = await api.saveCard(bytes);
      if (!r?.ok) return SB.toast(r?.error || "Couldn't save the card.");
      // data: URL, not blob: (the panel's CSP only allows 'self' and data: images).
      last = { url: canvas.toDataURL('image/png'), data, bytes };
      $('cardImg').src = last.url;
      $('cardPath').textContent = r.name;
      sheet.hidden = false;
      $('cardCopy').focus();
    } catch (e) {
      console.warn('[shellby] card failed', e);
      SB.toast("Couldn't draw the card.");
    } finally {
      btns.forEach(b => { b.disabled = false; });
    }
  }

  function close() {
    sheet.hidden = true;
  }

  document.querySelectorAll('[data-share-card]').forEach(b => b.addEventListener('click', share));
  $('cardClose').addEventListener('click', close);
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  sheet.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  $('cardCopy').addEventListener('click', async () => {
    if (!last) return;
    const r = await api.copyCard(last.bytes);
    SB.toast(r?.ok ? 'Copied. Paste it anywhere.' : "Couldn't copy the card.");
  });
  $('cardReveal').addEventListener('click', () => api.revealCard());
  $('cardX').addEventListener('click', () => {
    if (last) api.openExternal(`https://x.com/intent/post?text=${encodeURIComponent(postText(last.data))}&url=${encodeURIComponent(REPO)}`);
  });
  $('cardBsky').addEventListener('click', () => {
    if (last) api.openExternal(`https://bsky.app/intent/compose?text=${encodeURIComponent(`${postText(last.data)} ${REPO}`)}`);
  });

  SB.crabCard = { render, share };
})();
