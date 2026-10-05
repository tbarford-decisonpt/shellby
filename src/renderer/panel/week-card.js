/* Shellby panel — the weekly crab card: tasks, streak, top project, new
   trophies and what shipped over the last seven days, as a line on the
   Trophies & XP page and as a shareable 1200x630 PNG in the crab card's look
   (card.js's kit). Main (weekly.js) keeps a small per-day ledger of what
   happened and hands the card over every Friday afternoon. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const K = SB.cardKit;
  const { W, H, C } = K;
  const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const fmt = n => Number(n || 0).toLocaleString();
  const plural = (n, one, many) => SB.plural(n, one, many, fmt);
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

  // "45m", "3.5h", "31h": Claude's working time, as short as it reads well.
  function hoursText(ms) {
    const h = ms / 3600000;
    if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
    return h < 10 ? `${(Math.round(h * 10) / 10).toLocaleString()}h` : `${fmt(Math.round(h))}h`;
  }
  // "≈ 3.9 workdays" once it's past a day's work (8 hours).
  const workdays = ms => (ms >= 8 * 3600000 ? `≈ ${(Math.round(ms / 3600000 / 8 * 10) / 10).toLocaleString()} workdays` : '');
  const weekday = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short' });
  // Anything worth a "What your plan bought you" panel: time counted, or a fix.
  const hasPlan = w => !!(w.plan && (w.plan.ms > 0 || w.plan.fixes > 0));

  // The little extras worth a mention: deploys, releases, clean audits, focus.
  // (Merged pull requests are in the week's work lines, weekly.js workLines.)
  function extras(c) {
    return [
      c.deploys ? `🚀 ${plural(c.deploys, 'deploy')}` : null,
      c.releases ? `🏷️ ${plural(c.releases, 'release')}` : null,
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

  // "shellby, rack-builder ✨, +2 more": names fitted to one line, new stickers marked.
  function shippedLine(ctx, shipped, maxW, font) {
    const names = shipped.map(p => (p.isNew ? `${p.name} ✨` : p.name));
    for (let n = names.length; n > 0; n--) {
      const line = names.slice(0, n).join(', ') + (n < names.length ? `, +${names.length - n} more` : '');
      ctx.font = font;
      if (ctx.measureText(line).width <= maxW || n === 1) return K.fitText(ctx, line, maxW, font);
    }
    return '';
  }

  // As many whole items as fit on the line, in order; the first is cut only when it alone won't fit.
  function fitWhole(ctx, items, maxW, font) {
    ctx.font = font;
    let line = '';
    for (const item of items) {
      const next = line ? `${line}   ${item}` : item;
      if (ctx.measureText(next).width > maxW) break;
      line = next;
    }
    return line || K.fitText(ctx, items[0], maxW, font);
  }

  // "🦉 Night Owl   🔟 Ten Tasks" when the names fit, else just the icons and a count.
  function trophyLine(ctx, trophies, maxW, font) {
    const named = trophies.map(t => `${t.icon} ${t.name}`).join('   ');
    ctx.font = font;
    if (ctx.measureText(named).width <= maxW) return [named, ''];
    return [K.fitText(ctx, trophies.map(t => t.icon).join(' '), maxW - 110, font), ` · ${plural(trophies.length, 'trophy', 'trophies')}`];
  }

  // The right-hand column: three label-and-line rows. An empty row says so dimly.
  function drawHighlights(ctx, w, shipped, x, top, maxW) {
    const tp = w.topProject;
    const valueFont = '700 19px "Atkinson Hyperlegible"';
    const rows = [
      ['TOP PROJECT', tp ? tp.name : '', tp?.tasks ? ` · ${plural(tp.tasks, 'task')}` : '', 'Nothing yet'],
      ['NEW TROPHIES', ...trophyLine(ctx, w.trophies, maxW, valueFont), 'None this week'],
      ['SHIPPED', shippedLine(ctx, shipped, maxW, valueFont), '', 'The week isn\'t over yet.'],
    ];
    rows.forEach(([label, value, note, empty], i) => {
      const y = top + i * 48;
      ctx.fillStyle = C.sandFaint;
      ctx.font = '600 13px "Martian Mono"';
      ctx.fillText(label, x, y);
      if (!value) {
        ctx.fillStyle = C.sandDim;
        ctx.fillText(K.fitText(ctx, empty, maxW, '18px "Atkinson Hyperlegible"'), x, y + 25);
        return;
      }
      ctx.fillStyle = C.sand;
      ctx.font = '600 13px "Martian Mono"';
      const noteW = note ? ctx.measureText(note).width : 0;
      const text = K.fitText(ctx, value, maxW - noteW, valueFont);
      ctx.fillText(text, x, y + 25);
      if (note) {
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = C.sandDim;
        ctx.font = '600 13px "Martian Mono"';
        ctx.fillText(note, x + tw, y + 24);
      }
    });
  }

  // "What your plan bought you": a receipt with Claude's hours as the big
  // number, tasks finished and fixes that held beside it, and the weekly
  // limit's meter along the bottom, so the value sits next to what it cost.
  function drawPlan(ctx, w, x, y, pw, ph) {
    const p = w.plan;
    const glow = ctx.createLinearGradient(x, y, x + pw, y + ph);
    glow.addColorStop(0, 'rgba(255,193,94,.13)');
    glow.addColorStop(1, 'rgba(17,35,42,.92)');
    K.roundRect(ctx, x, y, pw, ph, 18);
    ctx.fillStyle = 'rgba(17,35,42,.92)';
    ctx.fill();
    ctx.fillStyle = glow;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,193,94,.38)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const pad = 24, inner = pw - pad * 2;
    ctx.fillStyle = C.amber;
    ctx.font = '600 13px "Martian Mono"';
    ctx.fillText('WHAT YOUR PLAN BOUGHT YOU', x + pad, y + 30);

    // The hero: hours of Claude at work.
    const leftW = Math.round(inner * 0.5);
    ctx.fillStyle = C.sand;
    ctx.fillText(K.fitText(ctx, p.ms ? hoursText(p.ms) : '—', leftW, '500 58px "Martian Mono"'), x + pad, y + 92);
    ctx.fillStyle = C.sandDim;
    const days = workdays(p.ms);
    ctx.fillText(K.fitText(ctx, `of Claude at work${days ? ` · ${days}` : ''}`, leftW, '17px "Atkinson Hyperlegible"'), x + pad, y + 118);

    // Beside it: tasks finished, and fixes that held (or, with no fixes, what shipped).
    const rx = x + pad + leftW + 18;
    ctx.fillStyle = 'rgba(243,230,204,.10)';
    ctx.fillRect(rx - 18, y + 48, 1, 74);
    const rows = [
      [fmt(p.tasks), p.tasks === 1 ? 'task finished' : 'tasks finished', C.coral],
      p.fixes
        ? [`${fmt(p.held)}/${fmt(p.fixes)}`, p.fixes === 1 ? 'fix that held' : 'fixes that held', '#7bd389']
        : [fmt(w.counts.projects), w.counts.projects === 1 ? 'project shipped' : 'projects shipped', C.glass],
    ];
    rows.forEach(([num, label, col], i) => {
      const ry = y + 74 + i * 42;
      ctx.fillStyle = col;
      ctx.fillRect(rx, ry - 22, 4, 26);
      ctx.fillStyle = C.sand;
      ctx.font = '500 30px "Martian Mono"';
      const nw = Math.min(ctx.measureText(num).width, 140);
      ctx.fillText(K.fitText(ctx, num, 140, ctx.font), rx + 14, ry);
      ctx.fillStyle = C.sandDim;
      ctx.fillText(K.fitText(ctx, label, x + pw - pad - (rx + 26 + nw), '17px "Atkinson Hyperlegible"'), rx + 26 + nw, ry - 2);
    });

    // The meter: how much of the weekly limit that took.
    const my = y + ph - 22;
    if (!p.weekly) {
      ctx.fillStyle = C.sandFaint;
      ctx.fillText(K.fitText(ctx, 'Counted from every turn Claude finished, in Shellby and your terminal.', inner, '15px "Atkinson Hyperlegible"'), x + pad, my + 4);
      return;
    }
    const five = p.fiveHour ? ` · 5-hour ${p.fiveHour.pct}%` : '';
    const note = `${p.weekly.pct}% of weekly limit · resets ${weekday(p.weekly.resetsAt)}${five}`;
    ctx.font = '600 15px "Atkinson Hyperlegible"';
    const noteW = Math.min(ctx.measureText(note).width, inner * 0.76);
    const barW = inner - noteW - 16;
    K.roundRect(ctx, x + pad, my - 8, barW, 10, 5);
    ctx.fillStyle = 'rgba(127,214,194,.14)';
    ctx.fill();
    const fill = Math.max(10, Math.round(barW * p.weekly.pct / 100));
    const bar = ctx.createLinearGradient(x + pad, 0, x + pad + barW, 0);
    bar.addColorStop(0, C.glass);
    bar.addColorStop(1, p.weekly.pct >= 90 ? C.coral : C.amber);
    K.roundRect(ctx, x + pad, my - 8, fill, 10, 5);
    ctx.fillStyle = bar;
    ctx.fill();
    ctx.fillStyle = C.sandDim;
    ctx.fillText(K.fitText(ctx, note, noteW, ctx.font), x + pad + barW + 16, my + 2);
  }

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
    const plan = hasPlan(w);
    // With the plan panel in the tiles' place, the streak moves up here.
    const streak = plan && w.streak.current ? ` · 🔥 ${w.streak.current}-day streak` : '';
    // The level goes first when it all won't fit.
    const sub = `+${fmt(w.xp)} XP${vs ? ` (${vs})` : ''}${streak} · ${w.activeDays} of 7 days`;
    ctx.font = '20px "Atkinson Hyperlegible"';
    const subLine = ctx.measureText(sub + lv).width <= colW ? sub + lv : sub;
    ctx.fillText(K.fitText(ctx, subLine, colW, ctx.font), x0, 188);

    const c = w.counts;
    if (plan) drawPlan(ctx, w, x0, 208, colW, 172);
    else drawStatTiles(ctx, w, x0, colW);

    // ---- the seven days, and the week's top project, trophies and ships
    const top = plan ? 404 : 376;
    ctx.fillStyle = C.sandFaint;
    ctx.font = '600 13px "Martian Mono"';
    ctx.fillText('XP PER DAY', x0, top);
    drawHighlights(ctx, w, shipped, x0 + 300, top, colW - 300);

    const chart = { x: x0, y: top + 22, w: 264, h: plan ? 76 : 88 }; // room above the tallest bar for its pip
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

    // The week's work (routines while you were away, pull requests, builds
    // fixed, branches home), then the extras, on one line above the footer:
    // whole items only, best first, as many as fit.
    const more = [...(w.work || []).map(l => `${l.icon} ${l.text}`), ...extras(c)];
    if (more.length) {
      ctx.fillStyle = C.sandDim;
      ctx.fillText(fitWhole(ctx, more, colW, '17px "Atkinson Hyperlegible"'), x0, H - 84);
    }

    await K.drawFooter(ctx);
    return { canvas, data: w };
  }

  // Before the plan panel had anything to say: three tiles, tasks done, the
  // streak (or days active without one), and what shipped (or turned green, or
  // the trophies when neither happened).
  function drawStatTiles(ctx, w, x0, colW) {
    const c = w.counts;
    const third = c.projects || (!c.green && !c.trophies)
      ? [fmt(c.projects), c.projects === 1 ? 'project shipped' : 'projects shipped', C.glass]
      : c.green
        ? [fmt(c.green), c.green === 1 ? 'test suite went green' : 'tests went green', '#7bd389']
        : [fmt(c.trophies), c.trophies === 1 ? 'trophy earned' : 'trophies earned', C.glass];
    K.drawTiles(ctx, [
      [fmt(c.tasks), c.tasks === 1 ? 'task done' : 'tasks done', C.coral],
      w.streak.current
        ? [`🔥${fmt(w.streak.current)}`, 'day streak', C.amber]
        : [`${w.activeDays}/7`, 'days active', C.amber],
      third,
    ], x0, colW, 214, 118);
  }

  const postText = w => {
    const bits = [
      w.counts.projects ? `shipped ${plural(w.counts.projects, 'project')}` : null,
      w.counts.green ? `turned ${plural(w.counts.green, 'test suite')} green` : null,
      !w.counts.projects && w.counts.tasks ? `finished ${plural(w.counts.tasks, 'task')}` : null,
      w.counts.trophies ? `earned ${plural(w.counts.trophies, 'trophy', 'trophies')} 🏆` : null,
      w.streak.current >= 2 ? `kept a ${w.streak.current}-day streak 🔥` : null,
    ].filter(Boolean);
    const said = bits.length ? `${bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : bits[0]}` : `earned ${fmt(w.xp)} XP`;
    return `${planText(w)}My week with Shellby 🦀 ${said}. A pixel hermit crab that runs Claude Code on my desktop.`;
  };

  // "My Claude plan bought me 31 hours of work this week: 42 tasks finished, 5 of 6 fixes held. "
  function planText(w) {
    const p = w.plan;
    if (!hasPlan(w) || p.ms < 3600000) return '';
    const bits = [
      p.tasks ? `${plural(p.tasks, 'task')} finished` : null,
      p.fixes ? `${fmt(p.held)} of ${plural(p.fixes, 'fix', 'fixes')} held` : null,
    ].filter(Boolean);
    return `My Claude plan bought me ${hoursText(p.ms).replace(/h$/, '')} hours of work this week${bits.length ? `: ${bits.join(', ')}` : ''}. `;
  }

  // The Trophies page's one-liner: "🕒 31h of Claude at work · 42 tasks finished · 5/6 fixes held · 62% of weekly limit".
  function planLine(w) {
    if (!hasPlan(w)) return '';
    const p = w.plan;
    return [
      p.ms ? `🕒 ${hoursText(p.ms)} of Claude at work` : null,
      p.tasks ? `${plural(p.tasks, 'task')} finished` : null,
      p.fixes ? `${fmt(p.held)}/${fmt(p.fixes)} ${p.fixes === 1 ? 'fix' : 'fixes'} held` : null,
      p.weekly ? `${p.weekly.pct}% of your weekly limit` : null,
    ].filter(Boolean).join(' · ');
  }

  const share = () => K.present({
    kind: 'week', draw: render, buttons: '[data-share-week]', post: postText,
    title: 'Your week', alt: 'Your week with Shellby: what your plan bought you (hours of Claude work, tasks finished, fixes that held, the weekly limit used), your streak, your top project, new trophies, what you shipped, the week\'s work (routines that ran while you were away, pull requests, builds fixed, branches brought home) and XP for the last seven days',
  });

  // ------------------------------------------------------------ the Trophies & XP page

  async function renderLine() {
    const box = $('xpWeek');
    if (!box) return;
    const w = await api.getWeek().catch(() => null);
    if (!w) { box.hidden = true; return; }
    box.hidden = false;
    $('xpWeekRange').textContent = `· ${range(w)}`;
    const plan = $('xpWeekPlan');
    if (plan) { plan.textContent = planLine(w); plan.hidden = !plan.textContent; }
    const planned = !!plan?.textContent;
    const c = w.counts;
    const bits = [
      c.projects ? plural(c.projects, 'project') + ' shipped' : null,
      c.green ? `${plural(c.green, 'test suite')} turned green` : null,
      c.tasks && !planned ? plural(c.tasks, 'task') + ' done' : null, // the plan's box says it already
      w.streak.current ? `🔥 ${w.streak.current}-day streak` : null,
      w.topProject?.tasks ? `most work in ${w.topProject.name}` : null,
      ...(w.work || []).map(l => `${l.icon} ${l.text}`),
      ...w.trophies.map(t => `${t.icon} ${t.name}`),
      ...extras({ ...c, newStickers: 0 }), // the chips below already say which are new
    ].filter(Boolean);
    $('xpWeekLine').textContent = bits.length ? bits.join(' · ') : 'Nothing yet this week. Ship something and it shows up here.';
    $('xpWeekShipped').replaceChildren(...withArt(w).slice(0, 8).map(p => h('li', { class: p.isNew ? 'new' : '', title: p.isNew ? `${p.name}: new sticker this week` : p.name, text: p.name })));
  }

  document.querySelectorAll('[data-share-week]').forEach(b => b.addEventListener('click', share));
  api.onWeekReady(w => SB.toast(`📅 ${w.headline} this week. Your weekly crab card is ready.`, { action: 'Share', onAction: share, ms: 8000 }));

  const renderTrophies = SB.views.trophies.render;
  SB.views.trophies.render = () => { renderTrophies(); renderLine(); };

  SB.weekCard = { render, share };
})();
