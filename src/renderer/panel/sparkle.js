/* Shellby panel — the sparkly reveal. When a find he digs up or a bug Claude
   fixes comes up sparkly (gifts.js, bugdex.js), the panel stops for it: a card
   flips over to the sparkly one, big, with the odds and how many came before
   it, and a button to share it as a picture (moment-card.js). Main sends
   'sparkle:reveal'; nothing here is ever put in as HTML. */
'use strict';
(function () {
  const { h, api, plural } = SB;
  const queue = [];
  let showing = null;
  let returnFocus = null;

  const day = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function oddsLine(r) {
    const before = r.kind === 'bug' ? plural(r.after, 'bug', 'bugs') : plural(r.after, 'find');
    return `1 in ${r.odds.toLocaleString()} · after ${before} · ${day(r.at)}`;
  }

  function share(r) {
    const what = r.kind === 'bug' ? 'bug' : 'find';
    SB.momentCard.share('shiny', {
      eyebrow: `✨ A sparkly ${what}`, title: r.name, sub: oddsLine(r), art: { pixels: r.pixels, palette: r.palette },
      accent: '#fff1a8', glints: true, badge: `1 in ${r.odds}`,
      stats: [['odds', `1/${r.odds}`], [r.kind === 'bug' ? 'bugs before it' : 'finds before it', r.after.toLocaleString()], ['his level', `Lv ${r.level}`]],
    }, {
      title: `A sparkly ${r.name}`,
      alt: `A sparkly ${r.name}, 1 in ${r.odds}, drawn big on a starry card`,
      post: `✨ My Shellby just ${r.kind === 'bug' ? 'jarred' : 'dug up'} a SPARKLY ${r.name}. 1 in ${r.odds}, after ${r.after.toLocaleString()} ${r.kind === 'bug' ? 'bugs' : 'finds'}. A pixel hermit crab that runs Claude Code on my desktop.`,
    });
  }

  function close() {
    if (!showing) return;
    showing.remove();
    showing = null;
    if (queue.length) { setTimeout(() => show(queue.shift()), 300); return; }
    returnFocus?.focus?.({ preventScroll: true });
    returnFocus = null;
  }

  function open(r) {
    close();
    if (r.kind === 'bug') SB.focusBug?.(r.id);
    else SB.setView('finds');
  }

  function show(r) {
    returnFocus = returnFocus || document.activeElement;
    const art = SB.Sprite.grid(r.pixels, r.palette, { px: Math.max(6, Math.floor(160 / Math.max(r.pixels.length, ...r.pixels.map(x => x.length)))) });
    const shareBtn = h('button', { type: 'button', class: 'btn primary', dataset: { shareMoment: '1' }, onclick: () => share(r) }, '📸 Share this');
    const el = h('div', { class: `sp-reveal${reduced() ? ' still' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'spTitle', 'aria-describedby': 'spOdds' },
      h('div', { class: 'sp-card' },
        h('div', { class: 'sp-flip' },
          h('div', { class: 'sp-back', 'aria-hidden': 'true' }, h('span', { text: '?' })),
          h('div', { class: 'sp-front' },
            h('div', { class: 'sp-art' }, art, h('i', { class: 'sp-glint g1', 'aria-hidden': 'true' }), h('i', { class: 'sp-glint g2', 'aria-hidden': 'true' }), h('i', { class: 'sp-glint g3', 'aria-hidden': 'true' })),
            h('p', { class: 'sp-eyebrow', text: r.first === false ? '✨ Sparkly again' : '✨ Sparkly!' }),
            h('h3', { id: 'spTitle', text: r.name }),
            h('p', { class: 'sp-odds', id: 'spOdds', text: oddsLine(r) }),
            h('p', { class: 'sp-blurb', text: r.kind === 'bug' ? 'Claude fixed it, so it’s in a jar. In colours nobody else’s has.' : 'The same find, in colours that only come up once in a long while.' }),
            h('div', { class: 'sp-actions' },
              shareBtn,
              h('button', { type: 'button', class: 'btn ghost', onclick: () => open(r) }, r.kind === 'bug' ? 'See it in the Bugdex' : 'See it on the shelf'),
              h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Nice!'))))));
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.body.append(el);
    showing = el;
    // The flip lands, then the keyboard goes to Share.
    setTimeout(() => shareBtn.focus({ preventScroll: true }), reduced() ? 0 : 900);
  }

  api.onSparkle(r => {
    if (!r?.name || !Array.isArray(r.pixels) || !r.palette) return;
    const clean = { ...r, odds: Math.max(1, Math.round(Number(r.odds) || 128)), after: Math.max(0, Math.round(Number(r.after) || 0)), level: Math.max(1, Math.round(Number(r.level) || 1)), at: Number(r.at) || Date.now() };
    if (showing) queue.push(clean); else show(clean);
  });

  SB.sparkle = { show, close };
})();
