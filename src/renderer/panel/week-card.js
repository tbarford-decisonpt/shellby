/* Shellby panel — the week in review: "what we shipped" over the last seven
   days, as a line on the Trophies & XP page and as a shareable 1200x630 PNG in
   the crab card's look (card.js's kit). The numbers come from main
   (weekly.js), which keeps a small per-day ledger of what happened. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const K = SB.cardKit;
  const { W, H, C } = K;
  const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const fmt = n => Number(n || 0).toLocaleString();
  const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
  const dateOf = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
  const shortDate = key => dateOf(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const range = w => `${shortDate(w.fromDay)} – ${shortDate(w.toDay)}`;

  // "↑ 32% on last week" (or "3.4× last week" for a big jump); nothing without a last week.
  function versus(now, before) {
    if (!before) return '';
    const pct = Math.round(((now - before) / before) * 100);
    if (Math.abs(pct) < 5) return 'same as last week';
    if (pct >= 100) return `${(now / before).toFixed(1)}× last week`;
    return `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% on last week`;
  }

  // The little extras worth a mention: deploys, releases, merges, clean audits, focus.
  function extras(c) {
    return [
      c.deploys ? `🚀 ${plural(c.deploys, 'deploy')}` : null,
      c.releases ? `🏷️ ${plural(c.releases, 'release')}` : null,
      c.merges ? `🔀 ${plural(c.merges, 'merged PR', 'merged PRs')}` : null,
      c.checkups ? `🧼 ${plural(c.checkups, 'clean audit')}` : null,
      c.flaky ? `🎲 ${plural(c.flaky, 'flaky test')} caught` : null,
      c.flakeFixes ? `🩹 ${plural(c.flakeFixes, 'flaky test')} fixed` : null,
      c.newStickers ? `✨ ${plural(c.newStickers, 'new sticker')}` : null,
      c.focus ? `⛑️ ${plural(c.focus, 'focus session')}` : null,
    ].filter(Boolean);
  }

  // Shipped projects with their sticker art, from the Sticker Book's view.
  function withArt(w) {
    const byId = new Map((state.stickers?.projects || []).map(p => [p.id, p]));
    return w.shipped.map(p => ({ ...p, art: byId.get(p.id)?.art || null, hidden: !!byId.get(p.id)?.hidden }));
  }

  // ------------------------------------------------------------ the card

  async function render() {
    await K.loadFonts();
    SB.applyStickers?.(await api.getStickers());
    const w = await api.getWeek();
    // A project kept off the calling card stays off this one too.
    const shipped = withArt(w).filter(p => !p.hidden);
    const { canvas, ctx } = K.newCanvas();
    K.drawWater(ctx);
    await K.drawTank(ctx, shipped.filter(p => p.art));

    const x0 = 568, right = W - 56, colW = right - x0;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.coral;
    ctx.font = '600 15px "Martian Mono"';
    const login = state.github?.signedIn ? `@${state.github.login.toUpperCase()}'S WEEK` : 'MY WEEK WITH SHELLBY';
    ctx.fillText(K.fitText(ctx, `${login} · ${range(w).toUpperCase()}`, colW, ctx.font), x0, 92);

    // The headline, shrunk before it's cut.
    const title = `${w.counts.projects ? '🚢' : w.counts.green ? '🟢' : '🦀'} ${w.headline}`;
    ctx.fillStyle = C.sand;
    let size = 54;
    ctx.font = `600 ${size}px "Pixelify Sans"`;
    while (size > 34 && ctx.measureText(title).width > colW) ctx.font = `600 ${--size}px "Pixelify Sans"`;
    ctx.fillText(K.fitText(ctx, title, colW, ctx.font), x0, 150);

    ctx.fillStyle = C.sandDim;
    const lv = w.level ? ` · level ${w.level.level}` : '';
    const vs = versus(w.xp, w.xpPrev);
    ctx.fillText(K.fitText(ctx, `+${fmt(w.xp)} XP${vs ? ` (${vs})` : ''} · ${w.activeDays} of 7 days${lv}`, colW, '20px "Atkinson Hyperlegible"'), x0, 188);

    // Three tiles: what shipped, what turned green, and the streak.
    const c = w.counts;
    K.drawTiles(ctx, [
      [fmt(c.projects), c.projects === 1 ? 'project shipped' : 'projects shipped', C.glass],
      [fmt(c.green), c.green === 1 ? 'test suite went green' : 'tests went green', '#7bd389'],
      w.streak.current
        ? [`🔥${fmt(w.streak.current)}`, 'day streak', C.coral]
        : [fmt(c.tasks), c.tasks === 1 ? 'task done' : 'tasks done', C.coral],
    ], x0, colW, 214, 118);

    // ---- the seven days, and what shipped
    const top = 376;
    ctx.fillStyle = C.sandFaint;
    ctx.font = '600 13px "Martian Mono"';
    ctx.fillText('XP PER DAY', x0, top);
    const shipX = x0 + 300;
    ctx.fillText(shipped.length ? 'SHIPPED' : 'SHIPPED · NOTHING YET', shipX, top);

    const chart = { x: x0, y: top + 22, w: 264, h: 88 }; // room above the tallest bar for its pip
    const best = Math.max(1, ...w.days.map(d => d.xp));
    const slot = chart.w / w.days.length, bw = Math.floor(slot * 0.62);
    w.days.forEach((d, i) => {
      const bh = d.xp ? Math.max(6, Math.round((d.xp / best) * chart.h)) : 3;
      const bx = Math.round(chart.x + i * slot + (slot - bw) / 2);
      const isToday = i === w.days.length - 1;
      ctx.fillStyle = d.xp ? (isToday ? C.amber : C.glass) : 'rgba(127,214,194,.18)';
      ctx.fillRect(bx, chart.y + chart.h - bh, bw, bh);
      // A shipping day gets a coral pip on top.
      if (d.shipped) { ctx.fillStyle = C.coral; ctx.fillRect(bx + bw / 2 - 4, chart.y + chart.h - bh - 12, 8, 8); }
      ctx.fillStyle = isToday ? C.sand : C.sandFaint;
      ctx.font = '600 12px "Martian Mono"';
      ctx.textAlign = 'center';
      ctx.fillText(DAY_LETTER[dateOf(d.day).getDay()], bx + bw / 2, chart.y + chart.h + 20);
      ctx.textAlign = 'left';
    });

    // Up to four names, busiest first; a new sticker says so.
    const maxRows = 4;
    shipped.slice(0, maxRows).forEach((p, i) => {
      const y = top + 34 + i * 28;
      ctx.fillStyle = p.isNew ? C.amber : C.glass;
      ctx.fillRect(shipX, y - 11, 8, 8);
      ctx.fillStyle = C.sand;
      const tag = p.isNew ? '  NEW' : '';
      const name = K.fitText(ctx, p.name, colW - 300 - 24 - (tag ? 50 : 0), '700 20px "Atkinson Hyperlegible"');
      ctx.fillText(name, shipX + 18, y);
      if (tag) {
        const nw = ctx.measureText(name).width;
        ctx.fillStyle = C.amber;
        ctx.font = '600 12px "Martian Mono"';
        ctx.fillText(tag, shipX + 18 + nw, y - 1);
      }
    });
    if (shipped.length > maxRows) {
      ctx.fillStyle = C.sandDim;
      ctx.font = '600 14px "Martian Mono"';
      ctx.fillText(`+${shipped.length - maxRows} more`, shipX + 18, top + 34 + maxRows * 28);
    }
    if (!shipped.length) {
      ctx.fillStyle = C.sandDim;
      ctx.fillText(K.fitText(ctx, 'The week isn\'t over yet.', colW - 300, '18px "Atkinson Hyperlegible"'), shipX, top + 34);
    }

    // Everything else, on one line above the footer.
    const more = extras(c);
    if (more.length) {
      ctx.fillStyle = C.sandDim;
      ctx.fillText(K.fitText(ctx, more.join('   '), colW, '17px "Atkinson Hyperlegible"'), x0, H - 84);
    }

    await K.drawFooter(ctx);
    return { canvas, data: w };
  }

  const postText = w => {
    const bits = [
      w.counts.projects ? `shipped ${plural(w.counts.projects, 'project')}` : null,
      w.counts.green ? `turned ${plural(w.counts.green, 'test suite')} green` : null,
      w.streak.current >= 2 ? `kept a ${w.streak.current}-day streak 🔥` : null,
    ].filter(Boolean);
    const said = bits.length ? `${bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : bits[0]}` : `earned ${fmt(w.xp)} XP`;
    return `My week with Shellby 🦀 ${said}. A pixel hermit crab that runs Claude Code on my desktop.`;
  };

  const share = () => K.present({
    kind: 'week', draw: render, buttons: '[data-share-week]', post: postText,
    title: 'Your week', alt: 'Your week with Shellby: what you shipped, tests turned green, your streak and XP for the last seven days',
  });

  // ------------------------------------------------------------ the Trophies & XP page

  async function renderLine() {
    const box = $('xpWeek');
    if (!box) return;
    const w = await api.getWeek().catch(() => null);
    if (!w) { box.hidden = true; return; }
    box.hidden = false;
    $('xpWeekRange').textContent = `· ${range(w)}`;
    const c = w.counts;
    const bits = [
      c.projects ? plural(c.projects, 'project') + ' shipped' : null,
      c.green ? `${plural(c.green, 'test suite')} turned green` : null,
      c.tasks ? plural(c.tasks, 'task') + ' done' : null,
      w.streak.current ? `🔥 ${w.streak.current}-day streak` : null,
      ...extras({ ...c, newStickers: 0 }), // the chips below already say which are new
    ].filter(Boolean);
    $('xpWeekLine').textContent = bits.length ? bits.join(' · ') : 'Nothing yet this week. Ship something and it shows up here.';
    $('xpWeekShipped').replaceChildren(...withArt(w).slice(0, 8).map(p => h('li', { class: p.isNew ? 'new' : '', title: p.isNew ? `${p.name}: new sticker this week` : p.name, text: p.name })));
  }

  document.querySelectorAll('[data-share-week]').forEach(b => b.addEventListener('click', share));
  api.onWeekReady(w => SB.toast(`📅 ${w.headline} this week. Your week card is ready.`, { action: 'Share', onAction: share, ms: 6000 }));

  const renderTrophies = SB.views.trophies.render;
  SB.views.trophies.render = () => { renderTrophies(); renderLine(); };

  SB.weekCard = { render, share };
})();
