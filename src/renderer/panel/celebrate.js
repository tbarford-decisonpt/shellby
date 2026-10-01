/* Shellby panel — the trophy unlock card. A queue of celebrations, shown one at
   a time above the composer: medallion, trophy name and description, pixel
   previews of the rewards, and "Wear it" / "Share" actions. */
'use strict';
(function () {
  const { h, api } = SB;
  const SHOW_MS = 9000;
  const queue = [];
  let current = null;

  const host = h('div', { class: 'celebrate-host', 'aria-live': 'polite' });
  document.body.append(host);

  function thumb(item) {
    const art = item.pixels ? { pixels: item.pixels, palette: item.palette } : item.sprites?.[0];
    if (!art) return h('span', { class: 'cel-thumb empty', text: '✦' });
    const w = Math.max(...art.pixels.map(r => r.length)), hgt = art.pixels.length;
    const k = Math.max(2, Math.floor(26 / Math.max(w, hgt)));
    const svg = SB.Sprite.grid(art.pixels, art.palette, { px: k });
    return h('span', { class: 'cel-thumb' }, svg);
  }

  const SLOT_LABEL = { hat: 'Hat', face: 'Face', neck: 'Neck', held: 'Held', shell: 'Shell' };

  function card(c) {
    const wearable = (c.rewards || []).filter(r => r.slot || r.motion);
    const el = h('section', { class: 'celebrate', role: 'status' },
      h('div', { class: 'cel-medal', 'aria-hidden': 'true' }, h('span', { text: c.icon || '🏆' })),
      h('div', { class: 'cel-body' },
        h('p', { class: 'cel-eyebrow', text: c.eyebrow || 'Trophy unlocked' }),
        h('h3', { class: 'cel-title', text: c.title }),
        c.text ? h('p', { class: 'cel-text', text: c.text }) : null,
        c.rewards?.length ? h('ul', { class: 'cel-rewards' }, c.rewards.map(r => h('li', {},
          thumb(r),
          h('span', { class: 'cel-rname' }, h('b', { text: r.name }), h('small', { text: r.slot ? SLOT_LABEL[r.slot] || r.slot : r.motion ? 'Effect' : 'Colors' }))))) : null,
        h('div', { class: 'cel-actions' },
          wearable.length ? h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => wear(wearable) }, wearable.length > 1 ? 'Wear them' : 'Wear it') : null,
          h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { dismiss(); SB.crabCard?.share(); } }, '📸 Share'))),
      h('button', { class: 'cel-close icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: dismiss },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })),
      h('div', { class: 'cel-timer', 'aria-hidden': 'true' }));
    return el;
  }

  async function wear(items) {
    const patch = {};
    for (const r of items) patch[r.slot || 'effect'] = r.key;
    dismiss();
    const r = await api.setOutfit(patch);
    SB.applyWardrobe(r.view);
    SB.setView('wardrobe');
  }

  function show() {
    if (current || !queue.length) return;
    const c = queue.shift();
    const el = card(c);
    el.style.setProperty('--show-ms', `${SHOW_MS}ms`);
    host.replaceChildren(el);
    document.body.classList.add('celebrating');
    current = { el, timer: null, left: SHOW_MS, started: Date.now() };
    const run = () => { current.started = Date.now(); current.timer = setTimeout(dismiss, current.left); el.classList.remove('paused'); };
    const pause = () => { clearTimeout(current.timer); current.left -= Date.now() - current.started; el.classList.add('paused'); };
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', run);
    el.addEventListener('focusin', pause);
    run();
  }

  function dismiss() {
    if (!current) return;
    const { el, timer } = current;
    clearTimeout(timer);
    current = null;
    el.classList.add('leaving');
    setTimeout(() => { el.remove(); if (!queue.length) document.body.classList.remove('celebrating'); show(); }, 220);
  }

  /** c: { icon, title, text, rewards: [public items], eyebrow? } */
  SB.celebrate = c => { queue.push(c); show(); };
  // Drop any showing or queued cards at once (used by the scripted screenshots).
  SB.clearCelebrations = () => {
    queue.length = 0;
    if (current) { clearTimeout(current.timer); current.el.remove(); current = null; }
    document.body.classList.remove('celebrating');
  };
})();
