/* Shellby panel — the Beach tab of Shellby's screen: a scene that only grows.
   A sandcastle for every project you've shipped, the tide for your streak, his
   finds washed up along the high-water line (src/main/beach.js lays it out,
   beach-paint.js draws it). It's wider than the panel once you've shipped a
   few: drag it, use the strip under it, or tab along it. What's new since you
   last looked rises out of the sand while you watch. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const P = SB.beachPaint;
  const ART = 3;            // css px per art pixel, rounded to whole device pixels
  const FPS = 12;           // the pixel world moves in steps, like the crab
  const RISE_MS = 1100;     // one castle coming up out of the sand
  const RISE_GAP = 420;     // ...and the next one starting
  const MAX_RISES = 16;
  const HEART_MS = 900;
  const MAP_MAX = 56;       // css px, the strip that shows the whole beach
  const SNAP_MAX = 6000;    // px, the widest snapshot (it stays well under main's 8 MB card limit)

  const stage = $('bcStage'), canvas = $('bcCanvas'), hits = $('bcHits'), map = $('bcMap');
  const ctx = canvas.getContext('2d');
  const mapArt = document.createElement('canvas');

  let v = null;              // the beach, from main
  let K = 3, u = 3;          // device px and css px per art pixel
  let viewArt = 150;         // art pixels across the stage
  let pan = 0;               // art pixels from the left
  let follow = false;        // the camera is following castles going up
  let crab = null, crabKey = null, petAt = 0;
  const rises = new Map();   // castle id -> when it starts rising
  let pops = [];
  let selected = null;       // { kind, id }
  let raf = 0, idle = 0, dirty = true, mapDirty = true;
  let drag = null;
  let refetch = null;
  let seq = 0;               // only the newest answer from main counts
  let opened = false;        // the camera has been placed once; after that it stays where you left it
  const risen = new Set();   // castles that have already come up this session

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plural = (n, one, many) => SB.plural(n, one, many, x => x.toLocaleString());
  const when = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const monthYear = t => new Date(t).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const listOf = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
  const sizeOf = pixels => ({ w: Math.max(...pixels.map(r => r.length)), h: pixels.length });

  // The scene as painted: never narrower than the stage, with the sun or moon
  // fixed in the sky as you look along (it's a long way off).
  function scene(width = Math.max(v.world.width, Math.ceil(viewArt)), orbAt = pan + viewArt * 0.72) {
    return { ...v, paintWidth: width, orbX: Math.round(orbAt) };
  }
  const maxPan = () => Math.max(0, scene().paintWidth - viewArt);
  const centreOn = (x, w = 0) => clamp(x + w / 2 - viewArt / 2, 0, maxPan());

  // ------------------------------------------------------------ sizing

  function size() {
    const dpr = window.devicePixelRatio || 1;
    K = Math.max(2, Math.round(ART * dpr));
    u = K / dpr;
    const cssW = stage.clientWidth || 420;
    const H = v?.world.height || 100;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = H * K;
    canvas.style.height = `${(H * K) / dpr}px`;
    stage.style.height = `${(H * K) / dpr + 2}px`; // and its 1px border, top and bottom
    viewArt = canvas.width / K;
    pan = clamp(pan, 0, v ? maxPan() : 0);
    dirty = mapDirty = true;
  }

  // ------------------------------------------------------------ him

  async function loadCrab() {
    const key = `${state.skin?.name}|${JSON.stringify(state.outfit || {})}`;
    if (!state.skin || !SB.cardKit || key === crabKey) return;
    crabKey = key;
    const svg = SB.sprite(state.skin, { fit: true });
    const [, , w, hh] = (svg.getAttribute('viewBox') || '0 0 22 13').split(' ').map(Number);
    try {
      const img = await SB.cardKit.svgImage(svg, Math.ceil(w), Math.ceil(hh));
      crab = { img, w: Math.ceil(w), h: Math.ceil(hh) };
    } catch {
      crab = null; // the scene still stands without him
    }
    dirty = mapDirty = true;
    if (v) renderHits();
    kick();
  }

  function crabArt(now, still) {
    if (!crab) return null;
    const petting = now - petAt < 320;
    return { ...crab, hop: petting ? 3 : !still && Math.floor(now / 800) % 4 === 0 ? 1 : 0 };
  }

  function pet() {
    api.critter.pet();
    petAt = performance.now();
    if (!crab || pops.length >= 6) return kick();
    const gold = (state.life?.bond?.level?.index ?? 0) >= 5;
    pops.push({ x: v.crab.x + crab.w / 2 - 3 + Math.round(Math.random() * 10 - 5), y: v.crab.y - crab.h - 4, born: petAt, age: 0, gold });
    kick();
  }

  // ------------------------------------------------------------ the loop

  // Smooth while something's moving (castles rising, a drag, hearts), a few
  // frames a second for the waves and stars otherwise, and nothing at all
  // when the motion is turned down and the scene is still.
  const kick = () => {
    if (idle) { clearTimeout(idle); idle = 0; }
    if (!raf) raf = requestAnimationFrame(frame);
  };

  function frame(now) {
    raf = 0;
    if (state.view !== 'beach' || !v || document.hidden) return;
    const still = reduced();
    const busy = rises.size || pops.length || follow || drag || now - petAt < 400;
    if (dirty || busy || !still) {
      draw(now, still);
      dirty = false;
    }
    if (busy) raf = requestAnimationFrame(frame);
    else if (!still) idle = setTimeout(() => { idle = 0; kick(); }, 1000 / FPS);
  }

  function draw(now, still) {
    const t = still ? 0 : now / 1000;
    const reveal = new Map();
    let rising = null;
    for (const [id, start] of rises) {
      const k = clamp((now - start) / RISE_MS, 0, 1);
      reveal.set(id, k);
      if (now >= start) rising = id;
      if (k >= 1) rises.delete(id);
    }
    // The camera keeps the castle going up in view, then lets go.
    if (follow) {
      const c = v.castles.find(x => x.id === rising);
      if (c) pan += (centreOn(c.x, c.w) - pan) * 0.08;
      if (!rises.size) follow = false;
    }
    pan = clamp(pan, 0, maxPan());
    pops = pops.map(p => ({ ...p, age: (now - p.born) / HEART_MS })).filter(p => p.age < 1);

    const time = P.timeOfDay();
    if (stage.dataset.time !== time) { stage.dataset.time = time; mapDirty = true; }
    const dpr = K / u;
    const shift = Math.round(pan * K);
    ctx.setTransform(K, 0, 0, K, -shift, 0);
    P.paint(ctx, scene(), { time, t, x0: pan - 1, x1: pan + viewArt + 1, crab: crabArt(now, still), reveal, pops, still });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    hits.style.transform = `translateX(${-shift / dpr}px)`;
    drawMap(time);
  }

  // ------------------------------------------------------------ the whole beach, small

  function drawMap(time) {
    const s = scene();
    const show = s.paintWidth > viewArt + 1;
    map.hidden = !show;
    if (!show) return;
    const dpr = K / u;
    const cssW = stage.clientWidth;
    const cssH = Math.max(18, Math.min(MAP_MAX, Math.round((cssW * s.world.height) / s.paintWidth)));
    if (map.width !== Math.round(cssW * dpr) || map.height !== Math.round(cssH * dpr)) {
      map.width = Math.round(cssW * dpr);
      map.height = Math.round(cssH * dpr);
      map.style.height = `${cssH}px`;
    }
    if (mapDirty) {
      mapArt.width = s.paintWidth;
      mapArt.height = s.world.height;
      P.paint(mapArt.getContext('2d'), scene(s.paintWidth, s.paintWidth * 0.72), { time, still: true, crab: crabArt(0, true) });
      mapDirty = false;
    }
    const m = map.getContext('2d');
    m.imageSmoothingEnabled = true;
    m.drawImage(mapArt, 0, 0, map.width, map.height);
    const x = (pan / s.paintWidth) * map.width, w = (viewArt / s.paintWidth) * map.width;
    m.fillStyle = 'rgba(6, 19, 22, .45)';
    m.fillRect(0, 0, x, map.height);
    m.fillRect(x + w, 0, map.width - x - w, map.height);
    m.strokeStyle = 'rgba(243, 230, 204, .85)';
    m.lineWidth = Math.max(1, dpr * 1.5);
    m.strokeRect(x + m.lineWidth / 2, m.lineWidth / 2, w - m.lineWidth, map.height - m.lineWidth);
  }

  // ------------------------------------------------------------ what you can point at

  const poolLabel = () => `Tide pool: ${plural(v.pool.kinds, 'kind')} of bug Claude has fixed`;

  function things() {
    const out = [
      ...v.castles.map(c => ({ kind: 'castle', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, name: c.name, label: `${c.name}, a ${c.kind.toLowerCase()} from ${plural(c.ships, 'ship')}` })),
      ...v.plots.map(p => ({ kind: 'plot', id: p.key, x: p.x, y: p.y, w: p.w, h: p.h, name: p.name, label: `${p.name}, a plot waiting for its castle` })),
      ...v.finds.map(f => ({ kind: 'find', id: f.id, x: f.x, y: f.y, ...sizeOf(f.pixels), name: f.name, label: `${f.name}, washed up` })),
      ...(v.pool ? [{ kind: 'pool', id: 'pool', x: v.pool.x, y: v.pool.y, w: v.pool.w, h: v.pool.h, name: 'Tide pool', label: poolLabel() }] : []),
    ];
    if (crab) out.push({ kind: 'crab', id: 'crab', x: v.crab.x, y: v.crab.y, w: crab.w, h: crab.h, name: 'Shellby', label: 'Pet Shellby' });
    return out.sort((a, b) => a.x - b.x || a.y - b.y);
  }

  function renderHits() {
    hits.style.width = `${scene().paintWidth * u}px`;
    const pad = 1; // a little slack around small things
    hits.replaceChildren(...things().map(it => h('button', {
      type: 'button',
      class: `bc-hit bc-hit-${it.kind}${selected?.kind === it.kind && selected.id === it.id ? ' on' : ''}`,
      style: `left:${(it.x - pad) * u}px;top:${(it.y - it.h - pad) * u}px;width:${(it.w + pad * 2) * u}px;height:${(it.h + pad * 2) * u}px`,
      'aria-label': it.label,
      'aria-pressed': it.kind === 'crab' ? null : String(selected?.kind === it.kind && selected.id === it.id),
      dataset: { name: it.name, kind: it.kind, id: it.id, x: String(it.x), w: String(it.w) },
    })), h('span', { class: 'bc-tag', id: 'bcTag', 'aria-hidden': 'true', hidden: true }));
  }

  function tag(btn) {
    const el = $('bcTag');
    if (!el) return;
    if (!btn) { el.hidden = true; return; }
    el.textContent = btn.dataset.name;
    el.hidden = false;
    el.style.left = `${parseFloat(btn.style.left) + parseFloat(btn.style.width) / 2}px`;
    el.style.top = `${parseFloat(btn.style.top)}px`;
  }

  function lookAt(btn) {
    const x = Number(btn.dataset.x), w = Number(btn.dataset.w);
    if (x >= pan + 4 && x + w <= pan + viewArt - 4) return;
    follow = false;
    pan = centreOn(x, w);
    dirty = true;
    kick();
  }

  hits.addEventListener('click', e => {
    const btn = e.target.closest('.bc-hit');
    if (!btn) return;
    if (btn.dataset.kind === 'crab') return pet();
    const same = selected?.kind === btn.dataset.kind && selected.id === btn.dataset.id;
    selected = same ? null : { kind: btn.dataset.kind, id: btn.dataset.id };
    markSelected();
    renderDetail();
    if (selected) $('bcDetail').scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
  });
  const hitFor = sel => sel && [...hits.querySelectorAll('.bc-hit')].find(b => b.dataset.kind === sel.kind && b.dataset.id === sel.id);
  function markSelected() {
    hits.querySelectorAll('.bc-hit').forEach(b => {
      const on = !!selected && b.dataset.kind === selected.kind && b.dataset.id === selected.id;
      b.classList.toggle('on', on);
      if (b.dataset.kind !== 'crab') b.setAttribute('aria-pressed', String(on));
    });
  }
  hits.addEventListener('pointerover', e => tag(e.target.closest('.bc-hit')));
  hits.addEventListener('pointerout', e => { if (!e.relatedTarget?.closest?.('.bc-hit')) tag(document.activeElement?.closest?.('.bc-hit')); });
  hits.addEventListener('focusin', e => { const b = e.target.closest('.bc-hit'); if (b) { tag(b); lookAt(b); } });
  hits.addEventListener('focusout', () => tag(null));
  // Arrow keys walk along the beach, one thing at a time.
  hits.addEventListener('keydown', e => {
    const all = [...hits.querySelectorAll('.bc-hit')];
    const i = all.indexOf(document.activeElement);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (i < 0 || to === undefined) return;
    e.preventDefault();
    all[clamp(to, 0, all.length - 1)].focus({ preventScroll: true });
  });
  // Focus moving to something off to the side mustn't scroll the stage itself:
  // the camera (lookAt) does the moving, and the buttons stay over what they name.
  stage.addEventListener('scroll', () => { stage.scrollLeft = 0; stage.scrollTop = 0; });

  // ------------------------------------------------------------ looking along it

  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || maxPan() <= 0) return;
    drag = { x: e.clientX, pan, moved: false, id: e.pointerId };
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!(e.buttons & 1)) { endDrag(); return; } // let go outside the window
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 4) {
      drag.moved = true;
      follow = false;
      stage.setPointerCapture(drag.id);
      stage.classList.add('dragging');
      tag(null);
    }
    if (!drag.moved) return;
    pan = clamp(drag.pan - dx / u, 0, maxPan());
    dirty = true;
    kick();
  });
  function endDrag(e) {
    // Only a drag that ends with a release is followed by a click to swallow.
    if (drag?.moved && e?.type === 'pointerup') {
      stage.dataset.dragged = '1';
      setTimeout(() => { delete stage.dataset.dragged; }, 0);
    }
    drag = null;
    stage.classList.remove('dragging');
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // A drag that ends on a castle isn't a click on it.
  stage.addEventListener('click', e => {
    if (!stage.dataset.dragged) return;
    delete stage.dataset.dragged;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  // Sideways scrolling (a trackpad, or Shift and the wheel) looks along; plain scrolling still scrolls the page.
  stage.addEventListener('wheel', e => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (!d || maxPan() <= 0) return;
    const next = clamp(pan + d / u, 0, maxPan());
    if (next === pan) return;
    e.preventDefault();
    follow = false;
    pan = next;
    dirty = true;
    kick();
  }, { passive: false });

  function mapTo(e) {
    const r = map.getBoundingClientRect();
    follow = false;
    pan = clamp(((e.clientX - r.left) / r.width) * scene().paintWidth - viewArt / 2, 0, maxPan());
    dirty = true;
    kick();
  }
  map.addEventListener('pointerdown', e => { map.setPointerCapture(e.pointerId); mapTo(e); });
  map.addEventListener('pointermove', e => { if (map.hasPointerCapture(e.pointerId)) mapTo(e); });

  // ------------------------------------------------------------ words around it

  function renderTitle() {
    const s = v.stats;
    $('bcSub').textContent = s.castles ? `${plural(s.castles, 'castle')} since ${monthYear(s.since)}` : 'Nothing built yet';
    $('bcEmpty').hidden = !!s.castles;
    $('bcHint').hidden = maxPan() <= 0;
    canvas.setAttribute('aria-label', `Your beach: ${listOf([
      plural(s.castles, 'sandcastle'),
      v.tide.current ? `the tide in for ${plural(v.tide.current, 'day')}` : 'the tide out',
      plural(s.finds, 'find'),
      s.plots ? plural(s.plots, 'plot') : null,
      v.pool ? poolLabel().replace(/^T/, 't') : null,
      P.timeOfDay() === 'night' && v.moon ? `a ${v.moon.name.replace(/ moon$/, '')} moon overhead` : null,
    ].filter(Boolean))}.`);
  }

  function glyph(kind) {
    const src = P.glyph(kind, P.timeOfDay());
    const k = 3;
    const c = h('canvas', { class: 'bc-glyph', width: src.width * k, height: src.height * k, 'aria-hidden': 'true' });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function renderKey() {
    const s = v.stats, td = v.tide;
    const row = (kind, title, text) => h('li', { class: `bc-key-item bc-key-${kind}` }, h('span', { class: 'bc-key-art' }, glyph(kind)), h('div', {}, h('b', { text: title }), h('p', { text })));
    $('bcKey').replaceChildren(
      row('castle', s.castles ? `${plural(s.castles, 'castle')} from ${plural(s.ships, 'ship')}` : 'No castles yet',
        'One for every project you ship. It grows as you keep shipping: a tower house at 5 ships, a keep at 15, a citadel at 40.'),
      row('tide', td.current ? `The tide’s been in ${plural(td.current, 'day')}` : 'The tide’s out',
        td.best ? `Every day in a row you finish a task, it comes further up. The seaweed is your best, ${plural(td.best, 'day')}, and it stays put.`
          : 'Every day in a row you finish a task, it comes further up. Your best leaves a line of seaweed that stays put.'),
      row('find', s.finds ? `${plural(s.finds, 'find')} washed up` : 'Nothing washed up yet',
        'Everything he digs up lands along the high-water line.'),
      row('plot', s.plots ? `${plural(s.plots, 'plot')} waiting` : 'No plots right now',
        'Projects you’re working on that haven’t shipped. Ship one and he builds on it.'),
      ...(s.bugs ? [row('pool', `${plural(s.bugs, 'kind')} of bug in the tide pool`,
        'Every kind of bug Claude fixes with him around goes in the Bugdex. The pool grows with each new one.')] : []));
  }

  function bigArt(src, box) {
    const k = Math.max(2, Math.floor(box / Math.max(src.width, src.height)));
    const c = h('canvas', { class: 'bc-detail-art', width: src.width * k, height: src.height * k, 'aria-hidden': 'true' });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function renderDetail() {
    const box = $('bcDetail');
    const T = P.THEMES[P.timeOfDay()];
    const item = selected && (selected.kind === 'castle' ? v.castles.find(c => c.id === selected.id)
      : selected.kind === 'plot' ? v.plots.find(p => p.key === selected.id)
        : selected.kind === 'pool' ? v.pool
          : v.finds.find(f => f.id === selected.id));
    if (!item) { selected = null; box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const close = h('button', { type: 'button', class: 'icon-btn bc-detail-close', 'aria-label': 'Close', onclick: () => {
      const was = hitFor(selected);
      selected = null;
      markSelected();
      renderDetail();
      was?.focus({ preventScroll: true }); // back to what it was about
    } }, '×');
    let art, lines, actions = [];
    if (selected.kind === 'castle') {
      const c = item;
      art = P.sprite(c.pixels, { ...T.castle, w: c.lit && T.lights ? '#ffd27a' : T.castle.d, p: '#6b5640', f: c.flag, g: '#ffd23f' });
      const extra = [c.deploys && plural(c.deploys, 'deploy'), c.releases && `${plural(c.releases, 'release')}${c.version ? ` (last ${c.version})` : ''}`, c.merges && plural(c.merges, 'merged PR')].filter(Boolean);
      lines = [
        h('p', { class: 'bc-detail-kind', text: `A ${c.kind.toLowerCase()}` }),
        h('h3', { text: c.name }),
        h('p', { text: `First shipped ${when(c.firstShipAt)}${c.lastShipAt - c.firstShipAt > 86400000 ? `, last on ${when(c.lastShipAt)}` : ''}.` }),
        h('p', { text: `${plural(c.ships, 'ship')}${extra.length ? `, with ${listOf(extra)}` : ''}.` }),
        h('p', { class: 'bc-detail-next', text: c.next ? `${plural(c.next.left, 'more ship')} and it becomes a ${c.next.kind.toLowerCase()}.` : 'As big as castles get.' }),
        c.marks.length ? h('ul', { class: 'bc-marks', 'aria-label': 'Marks' }, c.marks.map(m => h('li', { text: `${m.icon} ${m.name}` }))) : null,
      ];
      if (SB.openSticker) actions = [h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => SB.openSticker(c.id) }, 'See its sticker')];
    } else if (selected.kind === 'plot') {
      const p = item;
      art = P.sprite(v.art.plot, { ...T.castle, k: '#8a6a4a', i: '#aab4bf', b: '#ff7a5c', B: '#ffb08f' });
      lines = [
        h('p', { class: 'bc-detail-kind', text: 'A plot' }),
        h('h3', { text: p.name }),
        h('p', { text: `You worked on it ${p.lastSeen ? `on ${when(p.lastSeen)}` : 'lately'}, but it hasn’t shipped yet. Push it, deploy it, release it or merge a PR, and he builds its castle here.` }),
      ];
    } else if (selected.kind === 'pool') {
      const pool = item;
      art = P.glyph('pool', P.timeOfDay());
      const names = pool.swimmers.map(s => s.name);
      lines = [
        h('p', { class: 'bc-detail-kind', text: 'A tide pool' }),
        h('h3', { text: `${plural(pool.kinds, 'kind')} of bug Claude has fixed` }),
        h('p', { text: `Every bug Claude fixes with him around goes in the Bugdex, and the newest swim here: ${listOf(names)}.` }),
        h('p', { text: 'The pool grows with every new kind you catch.' }),
      ];
      if (SB.views.bugdex) actions = [h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => SB.setView('bugdex') }, 'Open the Bugdex')];
    } else {
      const f = item;
      art = P.sprite(f.pixels, f.palette);
      lines = [
        h('p', { class: `bc-detail-kind rarity-${f.rarity}`, text: f.rarity === 'special' ? 'Keepsake' : f.rarity[0].toUpperCase() + f.rarity.slice(1) }),
        h('h3', { text: f.name }),
        h('p', { text: f.blurb }),
        h('p', { text: `Washed up ${when(f.first)}${f.count > 1 ? `, and ${plural(f.count - 1, 'more')} since` : ''}.` }),
      ];
      actions = [h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => SB.setView('finds') }, 'See the shelf')];
    }
    box.className = `bc-detail bc-detail-${selected.kind}`;
    box.replaceChildren(
      h('div', { class: 'bc-detail-stage', dataset: { time: P.timeOfDay() } }, bigArt(art, 96)),
      h('div', { class: 'bc-detail-info' }, ...lines, actions.length ? h('div', { class: 'bc-detail-actions' }, actions) : null),
      close);
  }

  // ------------------------------------------------------------ new since you last looked

  // Castles new (or grown) since you last looked come up out of the sand one
  // after another, the camera following along. The first time you open the
  // beach it puts itself by him; after that it stays where you left it.
  function show() {
    if (state.view !== 'beach') return; // left before it arrived: keep it new for next time
    const fresh = v.castles.filter(c => (v.firstVisit || c.isNew || c.grew) && !risen.has(c.id)).slice(-MAX_RISES);
    fresh.forEach(c => risen.add(c.id));
    if (fresh.length && !reduced()) {
      const t0 = performance.now() + 450;
      fresh.forEach((c, i) => rises.set(c.id, t0 + i * RISE_GAP));
      pan = centreOn(fresh[0].x, fresh[0].w);
      follow = true;
    } else if (fresh.length) {
      pan = centreOn(fresh.at(-1).x, fresh.at(-1).w);
    } else if (!opened) {
      // By him, next to the newest castle: the latest thing you shipped is in view.
      pan = centreOn(v.crab.x, crab?.w || 22);
    }
    opened = true;
    if (fresh.length || v.news || v.firstVisit) {
      $('bcLive').textContent = fresh.length && !v.firstVisit ? `${plural(fresh.length, 'castle')} new on your beach since you last looked.` : '';
      // Seen once it's on screen, not before.
      requestAnimationFrame(() => {
        if (state.view !== 'beach') return;
        const n = ++seq;
        api.beachSeen().then(next => { if (next && n === seq) { v = next; badge(); } });
      });
    }
    dirty = mapDirty = true;
    kick();
  }

  // ------------------------------------------------------------ data in

  function badge() {
    document.querySelectorAll('.bc-badge').forEach(el => { el.hidden = !v?.news; });
  }

  function render() {
    size();
    renderTitle();
    renderKey();
    renderHits();
    renderDetail();
    dirty = mapDirty = true;
    kick();
  }

  // The newest answer wins: an older fetch arriving late is dropped.
  async function fetchBeach() {
    const n = ++seq;
    const next = await api.getBeach();
    return n === seq ? next : null;
  }

  function apply(next) {
    if (!next) return;
    v = next;
    badge();
    if (state.view !== 'beach') return;
    render();
    if (v.news) show(); // shipped while you were watching: up it comes
  }

  async function open() {
    const next = await fetchBeach();
    if (!next) return;
    v = next;
    badge();
    render();
    await loadCrab();
    show();
  }

  // Shipping, a find or a new day changes the beach. Fetch it again soon if
  // you're looking at it, or lazily (for the tab's dot) if you aren't.
  const later = () => {
    clearTimeout(refetch);
    refetch = setTimeout(() => fetchBeach().then(apply), state.view === 'beach' ? 800 : 5000);
  };
  api.onStickers(later);
  api.onLife(later);
  api.onStreaks(later);
  api.onSkin?.(() => { crabKey = null; if (state.view === 'beach') loadCrab(); });
  new ResizeObserver(() => { if (state.view === 'beach' && v) { size(); renderHits(); kick(); } }).observe(stage);
  document.addEventListener('visibilitychange', kick);

  $('bcShare').addEventListener('click', () => SB.beachCard.share());

  // ------------------------------------------------------------ the snapshot

  async function snapshot() {
    const K2 = SB.cardKit;
    await K2.loadFonts();
    const fresh = await fetchBeach();
    if (fresh) { v = fresh; if (state.view === 'beach') render(); }
    await loadCrab();
    // At least 1200 px wide, at most SNAP_MAX: a very long beach is shown from
    // its newest end, where he is.
    const full = v.world.width;
    const S = clamp(Math.ceil(1200 / full), 1, 8);
    const width = Math.min(full, Math.floor(SNAP_MAX / S));
    const from = full - width;
    const BAR = 120;
    const c = document.createElement('canvas');
    c.width = width * S;
    c.height = v.world.height * S + BAR;
    const g = c.getContext('2d');
    g.setTransform(S, 0, 0, S, -from * S, 0);
    P.paint(g, scene(full, from + width * 0.72), { time: P.timeOfDay(), t: 0, x0: from, x1: full, still: true, crab: crabArt(0, true) });
    g.setTransform(1, 0, 0, 1, 0, 0);

    const s = v.stats, td = v.tide;
    const y0 = v.world.height * S;
    g.fillStyle = K2.C.abyss;
    g.fillRect(0, y0, c.width, BAR);
    g.fillStyle = 'rgba(127, 214, 194, .18)';
    g.fillRect(0, y0, c.width, 1);
    const whose = state.github?.signedIn ? `@${state.github.login}’s beach` : 'My beach';
    const summary = listOf([
      s.castles ? `${plural(s.castles, 'castle')} from ${plural(s.ships, 'ship')}` : 'no castles yet',
      td.current ? `a ${td.current}-day tide${td.best > td.current ? ` (best ${td.best})` : ''}` : null,
      s.finds ? `${plural(s.finds, 'find')} washed up` : null,
    ].filter(Boolean));
    g.textBaseline = 'alphabetic';
    g.fillStyle = K2.C.sand;
    g.fillText(K2.fitText(g, whose, c.width - 520, '600 40px "Pixelify Sans"'), 48, y0 + 56);
    g.fillStyle = K2.C.sandDim;
    g.fillText(K2.fitText(g, summary[0].toUpperCase() + summary.slice(1), c.width - 440, '20px "Atkinson Hyperlegible"'), 48, y0 + 92);
    g.textAlign = 'right';
    g.fillStyle = K2.C.sand;
    g.font = '600 24px "Pixelify Sans"';
    g.fillText('Shellby', c.width - 48, y0 + 56);
    g.fillStyle = K2.C.glass;
    g.font = '600 15px "Martian Mono"';
    g.fillText('github.com/x-salmon/shellby', c.width - 48, y0 + 92);
    g.textAlign = 'left';
    return { canvas: c, data: { castles: s.castles, tide: td.current, finds: s.finds } };
  }

  const postText = d => `My Shellby beach 🏖️ ${d.castles ? `${plural(d.castles, 'sandcastle')}, one for every project I’ve shipped` : 'Waiting for its first sandcastle'}${d.tide ? `, and the tide’s been in ${plural(d.tide, 'day')}` : ''}. A pixel hermit crab that runs Claude Code on my desktop.`;

  const share = () => SB.cardKit.present({
    kind: 'beach', draw: snapshot, buttons: '#bcShare', post: postText,
    title: 'Your beach', alt: 'A pixel beach: a sandcastle for every project you’ve shipped, the tide line, and the finds washed up along it',
  });

  SB.beachCard = { render: snapshot, share };
  SB.views.beach = { render: () => { open(); } };
  api.getBeach().then(apply);
})();
