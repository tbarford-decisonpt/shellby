/* Shellby panel — the trophy unlock card. A queue of celebrations, shown one at
   a time above the composer: medallion, trophy name and description, pixel
   previews of the rewards, and "Wear it" / "Share" actions. Closing a card
   yourself (not letting it time out) counts as having seen its rewards. */
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
    const svg = SB.Sprite.grid(art.pixels, art.palette, { px: k, ink: !item.sprites }); // lined like he holds it; effects stay plain
    return h('span', { class: 'cel-thumb' }, svg);
  }

  const SLOT_LABEL = { hat: 'Hat', face: 'Face', neck: 'Neck', held: 'Held', shell: 'Shell' };
  const KIND_LABEL = { home: 'Home', sticker: 'Sticker', find: 'Find', decor: 'For his tank' };

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
          h('span', { class: 'cel-rname' }, h('b', { text: r.name }), h('small', { text: r.slot ? SLOT_LABEL[r.slot] || r.slot : r.motion ? 'Effect' : KIND_LABEL[r.kind] || 'Colors' }))))) : null,
        h('div', { class: 'cel-actions' },
          wearable.length ? h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => wear(wearable) }, wearable.length > 1 ? 'Wear them' : 'Wear it') : null,
          c.action ? h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => { close(); c.action.run(); } }, c.action.label) : null,
          h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { close(); SB.crabCard?.share(); } }, '📸 Share'),
          h('button', { class: 'btn ghost slim-btn cel-all', type: 'button', onclick: dismissAll }))),
      h('button', { class: 'cel-close icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: close },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })),
      h('div', { class: 'cel-timer', 'aria-hidden': 'true' }));
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    return el;
  }

  // Rewards are wardrobe items (key) or homes (id).
  const seen = cards => SB.acknowledge?.(cards.flatMap(c => (c.rewards || []).map(r => r.key || r.id)));

  // "Dismiss all (3)" while more cards wait behind this one.
  function syncMore() {
    const b = current?.el.querySelector('.cel-all');
    if (!b) return;
    b.hidden = !queue.length;
    b.textContent = `Dismiss all (${queue.length + 1})`;
  }

  async function wear(items) {
    const patch = {};
    for (const r of items) patch[r.slot || 'effect'] = r.key;
    close();
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
    current = { el, c, timer: null, left: SHOW_MS, started: Date.now() };
    syncMore();
    const run = () => { current.started = Date.now(); current.timer = setTimeout(dismiss, current.left); el.classList.remove('paused'); };
    const pause = () => { clearTimeout(current.timer); current.left -= Date.now() - current.started; el.classList.add('paused'); };
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', run);
    el.addEventListener('focusin', pause);
    run();
  }

  // Closed by hand: its rewards have been seen.
  function close() {
    if (current) seen([current.c]);
    dismiss();
  }

  function dismissAll() {
    seen(queue);
    queue.length = 0;
    close();
  }

  function dismiss() {
    if (!current) return;
    const { el, timer } = current;
    clearTimeout(timer);
    current = null;
    el.classList.add('leaving');
    setTimeout(() => { el.remove(); if (!queue.length) document.body.classList.remove('celebrating'); show(); }, 220);
  }

  /** c: { icon, title, text, rewards: [public items], eyebrow?, action?: { label, run } } */
  SB.celebrate = c => { queue.push(c); show(); syncMore(); };
  // Drop any showing or queued cards at once (used by the scripted screenshots).
  SB.clearCelebrations = () => {
    queue.length = 0;
    if (current) { clearTimeout(current.timer); current.el.remove(); current = null; }
    document.body.classList.remove('celebrating');
  };
})();
