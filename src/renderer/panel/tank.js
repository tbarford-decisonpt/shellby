/* Shellby panel — the Tank tab of Shellby's screen: a home you decorate.
   Watching, he wanders the middle row among what you've put in. Decorating,
   you work on a draft: drag pieces in from the tray (or press Enter on one),
   move them with the mouse or the arrow keys, and press Done; main checks the
   draft (tank.js sanitize) before it's kept. The scene is one canvas
   (tank-paint.js); the buttons over it are what you can point at and tab to. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const P = SB.tankPaint;
  const FPS = 10;            // the pixel world moves in steps, like the crab
  const WALK = 7;            // art px a second
  const HURRY = 3;           // ...and how much faster he gets out of your way when you decorate
  const DECORATING_ALPHA = 0.45;
  const MAX_HISTORY = 100;
  const DRAG_START = 4;      // css px before a press becomes a drag
  const THUMB = 44;          // device px, the tray's pictures
  const TALL = 10;           // pieces this tall go to the back row by default

  const stage = $('tkStage'), canvas = $('tkCanvas'), hits = $('tkHits');
  const ctx = canvas.getContext('2d');

  let v = null;              // the tank, from main
  let draft = null;          // the layout being decorated (null while watching)
  let history = [], future = [];
  let selected = null;       // uid of the piece picked in the editor
  let shelf = null;          // the tray's open category
  let K = 3, u = 3;          // device px and css px per art pixel
  let crab = null, crabKey = null;
  const walker = { x: 30, dir: 1, target: null, rest: 0, step: 0, hopUntil: 0 };
  let timer = 0, lastTick = 0, dirty = true;
  let drag = null;           // { kind: 'piece' | 'new', ... }
  let seq = 0;
  const seen = new Set();    // decor refs already reported as seen this session

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clone = o => JSON.parse(JSON.stringify(o));
  const plural = (n, one, many) => SB.plural(n, one, many, x => x.toLocaleString());
  const listOf = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
  const editing = () => !!draft;
  const layout = () => draft || v.layout;
  const scene = () => P.resolve(layout(), v);
  const trayItem = ref => v.tray.find(t => t.ref === ref);
  const capacityOf = id => (v.sizes.find(s => s.id === id) || v.size).cap;
  const pieceOf = uid => layout().placed.find(p => p.uid === uid);

  // ------------------------------------------------------------ sizing

  function size() {
    if (!v) return;
    const { world } = scene();
    const dpr = window.devicePixelRatio || 1;
    const cssW = stage.clientWidth || 420;
    K = Math.max(1, Math.floor((cssW * dpr) / world.w));
    u = K / dpr;
    canvas.width = world.w * K;
    canvas.height = world.h * K;
    canvas.style.width = `${world.w * u}px`;
    canvas.style.height = `${world.h * u}px`;
    hits.style.width = canvas.style.width;
    hits.style.height = canvas.style.height;
    walker.x = Math.min(walker.x, Math.max(0, world.w - (crab?.w || 22)));
    dirty = true;
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
      if (key !== crabKey) return; // a newer outfit is on its way
      crab = { img, w: Math.ceil(w), h: Math.ceil(hh) };
    } catch {
      if (key !== crabKey) return;
      crab = null; // the tank still stands without him
      crabKey = null; // ...and he's tried again next time
    }
    dirty = true;
    keepingFocus(renderHits);
    kick();
  }

  // He wanders: picks somewhere, walks there, has a look, picks again. Now and
  // then the somewhere is a piece, so he seems to visit things. Decorating,
  // he steps over to the side and watches.
  function walk(dt, now) {
    if (!crab || !v) return;
    const { world, pieces } = scene();
    const maxX = Math.max(0, world.w - crab.w - 1);
    if (editing()) walker.target = sideX();
    if (walker.target === null) {
      if (now < walker.rest) return;
      const floorPieces = pieces.filter(p => p.layer !== 'float');
      const visit = floorPieces.length && Math.random() < 0.55 ? floorPieces[Math.floor(Math.random() * floorPieces.length)] : null;
      const x = visit ? visit.x + visit.w / 2 - crab.w / 2 : Math.random() * maxX;
      walker.target = Math.round(Math.min(maxX, Math.max(1, x)));
    }
    const d = walker.target - walker.x;
    if (Math.abs(d) < 0.5) {
      walker.x = walker.target;
      walker.target = null;
      walker.rest = now + 1500 + Math.random() * 3500;
      return;
    }
    walker.dir = Math.sign(d);
    walker.x += walker.dir * Math.min(Math.abs(d), WALK * (editing() ? HURRY : 1) * dt);
    walker.step += dt;
    dirty = true;
  }

  function crabArt(now, still) {
    if (!crab) return null;
    const moving = walker.target !== null && !still;
    const hop = now < walker.hopUntil ? 2 : moving && Math.floor(walker.step * 4) % 2 ? 1 : 0;
    // Decorating, he's see-through, so nothing hides behind him while you place it.
    return { ...crab, x: still ? stillX() : walker.x, flip: walker.dir < 0 && !still, hop, alpha: editing() ? DECORATING_ALPHA : 1 };
  }
  // With the motion turned down he sits by the biggest thing in the tank, or
  // off to the side while you decorate, out of your way.
  const sideX = () => Math.max(0, scene().world.w - (crab?.w || 22) - 1);
  const stillX = () => (editing() ? sideX() : Math.max(0, Math.min((v?.focusX ?? 40) - (crab?.w || 22) / 2 + 12, sideX())));

  function pet() {
    api.critter.pet();
    if (reduced()) return; // he's petted all the same, just without the hop
    walker.hopUntil = performance.now() + 350;
    kick();
  }

  // ------------------------------------------------------------ the loop

  // Ten frames a second while you're looking (plants sway, bubbles rise, he
  // walks); one still frame when the motion is turned down; nothing at all
  // when the tab is hidden or you're somewhere else.
  const kick = () => { if (!timer) timer = setTimeout(tick, 0); };

  function tick() {
    timer = 0;
    if (state.view !== 'tank' || !v || document.hidden) return;
    const now = performance.now();
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;
    const still = reduced();
    if (!still) walk(dt, now);
    if (dirty || !still || drag) draw(now, still);
    dirty = false;
    if (!still || drag || now < walker.hopUntil) timer = setTimeout(tick, 1000 / FPS);
    else lastTick = 0;
  }

  function draw(now, still) {
    const sc = scene();
    ctx.setTransform(K, 0, 0, K, 0, 0);
    ctx.clearRect(0, 0, sc.world.w, sc.world.h);
    let ghost = null;
    if (drag?.kind === 'new' && drag.over) {
      const it = trayItem(drag.ref);
      ghost = { ...it, uid: 0, x: drag.x, row: drag.row, y: P.baseline(sc.world, it.layer, drag.row), flip: false };
    }
    P.paint(ctx, sc, { t: still ? 0 : now / 1000, still, crab: crabArt(now, still), ghost });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const crabBtn = hits.querySelector('.tk-hit-crab');
    if (crabBtn && crab) {
      const a = crabArt(now, still);
      crabBtn.style.left = `${a.x * u}px`;
      crabBtn.style.top = `${(sc.world.crabY - crab.h + 1) * u}px`;
    }
  }

  // ------------------------------------------------------------ what you can point at

  const rowName = p => (p.layer === 'float' ? ['high in the water', 'in the water', 'low in the water'][p.row] : p.layer === 'back' ? 'against the back glass' : `${v.rows[p.row]} row`);

  function renderHits() {
    if (!v) return;
    const sc = scene();
    const edit = editing();
    const buttons = sc.pieces.map(p => h('button', {
      type: 'button',
      class: `tk-hit${selected === p.uid ? ' on' : ''}${edit ? ' edit' : ''}`,
      style: `left:${(p.x - 1) * u}px;top:${(p.y - p.h) * u}px;width:${(p.w + 2) * u}px;height:${(p.h + 2) * u}px`,
      'aria-label': `${p.name}, ${rowName(p)}${p.flip ? ', flipped' : ''}`,
      'aria-describedby': edit ? 'tkKeys' : null,
      'aria-pressed': edit ? String(selected === p.uid) : null,
      dataset: { uid: String(p.uid), name: p.name, keep: `hit:${p.uid}` },
    }));
    if (crab) buttons.push(h('button', { type: 'button', class: 'tk-hit tk-hit-crab', 'aria-label': 'Pet Shellby', dataset: { name: 'Shellby', keep: 'crab' }, style: `width:${crab.w * u}px;height:${crab.h * u}px` }));
    hits.replaceChildren(...buttons, h('span', { class: 'tk-tag', id: 'tkTag', 'aria-hidden': 'true', hidden: true }));
  }

  function tag(btn) {
    const el = $('tkTag');
    if (!el) return;
    if (!btn || drag) { el.hidden = true; return; }
    el.textContent = btn.dataset.name;
    el.hidden = false;
    el.style.left = `${parseFloat(btn.style.left) + parseFloat(btn.style.width) / 2}px`;
    el.style.top = `${parseFloat(btn.style.top)}px`;
  }
  const hitFor = uid => hits.querySelector(`.tk-hit[data-uid="${uid}"]`);
  // A piece being dragged: its button follows it, without being rebuilt.
  function moveHit(uid) {
    const p = scene().pieces.find(x => x.uid === uid), b = hitFor(uid);
    if (!p || !b) return;
    b.style.left = `${(p.x - 1) * u}px`;
    b.style.top = `${(p.y - p.h) * u}px`;
  }

  hits.addEventListener('pointerover', e => tag(e.target.closest('.tk-hit')));
  hits.addEventListener('pointerout', e => { if (!e.relatedTarget?.closest?.('.tk-hit')) tag(document.activeElement?.closest?.('.tk-hit')); });
  hits.addEventListener('focusin', e => tag(e.target.closest('.tk-hit')));
  hits.addEventListener('focusout', () => tag(null));
  hits.addEventListener('click', e => {
    const btn = e.target.closest('.tk-hit');
    if (!btn || stage.dataset.dragged) return;
    if (btn.classList.contains('tk-hit-crab')) return pet();
    if (editing()) select(Number(btn.dataset.uid));
  });

  // ------------------------------------------------------------ editing

  // One step to undo, unless it changed nothing (an arrow key against the glass).
  function commit(change, { announce = null, keepFocus = true } = {}) {
    const before = clone(draft);
    change(draft);
    if (JSON.stringify(before) === JSON.stringify(draft)) return;
    history.push(before);
    if (history.length > MAX_HISTORY) history.shift();
    future = [];
    afterChange(keepFocus);
    if (announce) say(announce);
  }

  // Rebuilding the buttons mustn't throw away where the keyboard was.
  // The pieces, the crab, the tray's items and its shelves carry data-keep for it.
  const keepingFocus = render => SB.keepFocus($('tankView'), render, { preventScroll: true });

  function afterChange(keepFocus = true) {
    const focused = keepFocus && document.activeElement?.closest?.('.tk-hit')?.dataset.uid;
    if (selected && !pieceOf(selected)) selected = null;
    if (scene().size.w !== canvas.width / K) size();
    renderHits();
    renderTools();
    renderTray();
    renderTitle();
    if (focused && hitFor(focused)) hitFor(focused).focus({ preventScroll: true });
    dirty = true;
    kick();
  }

  function startEditing() {
    if (editing()) return;
    draft = clone(v.layout);
    history = [];
    future = [];
    selected = null;
    stage.classList.add('editing');
    renderAll();
    $('tkTray').querySelector('.tk-item:not([disabled])')?.focus();
    say('Decorating. Pick something from the tray, then press Done.');
  }

  function stopEditing() {
    draft = null;
    selected = null;
    drag = null;
    stage.classList.remove('editing');
    renderAll();
  }

  let saving = 0;
  async function done() {
    const n = ++saving;
    let r;
    try {
      r = await api.saveTank(draft);
    } catch {
      // Keep the draft: nothing is lost, and Done can be pressed again.
      $('tkNote').textContent = 'Couldn’t save his tank just now. Your changes are still here; try Done again.';
      $('tkNote').hidden = false;
      return say($('tkNote').textContent);
    }
    if (n !== saving) return; // Done was pressed again: that answer wins
    if (!r?.ok) {
      $('tkNote').textContent = r?.error || 'Couldn’t save his tank just now.';
      $('tkNote').hidden = false;
      return say($('tkNote').textContent);
    }
    if (r?.view) v = r.view;
    stopEditing();
    const dropped = r?.dropped || [];
    $('tkNote').textContent = dropped.length ? `${plural(dropped.length, 'piece')} couldn’t go in: ${listOf([...new Set(dropped.map(d => reason(d.reason)))])}.` : '';
    $('tkNote').hidden = !dropped.length;
    say(dropped.length ? $('tkNote').textContent : 'Saved. He’s having a look round.');
    document.dispatchEvent(new CustomEvent('sb:tank', { detail: v }));
    $('tkDecorate').focus();
  }
  const reason = r => ({ full: 'the tank was full', locked: 'it’s locked', 'not-enough': 'he hasn’t found enough of it', unknown: 'it isn’t installed' }[r] || 'it doesn’t go there');

  function cancel() {
    stopEditing();
    say('Put back as it was.');
    $('tkDecorate').focus();
  }

  function undo() {
    if (!history.length) return;
    future.push(clone(draft));
    draft = history.pop();
    afterChange(false);
    say('Undone.');
  }
  function redo() {
    if (!future.length) return;
    history.push(clone(draft));
    draft = future.pop();
    afterChange(false);
    say('Redone.');
  }

  function select(uid) {
    selected = uid;
    renderHits();
    renderTools();
    hitFor(uid)?.focus({ preventScroll: true });
  }

  // Somewhere for a new piece: in its row, where it overlaps the least,
  // starting from the middle.
  function freeSpot(item, row) {
    const { world, pieces } = scene();
    const same = pieces.filter(p => p.layer === item.layer && (item.layer === 'back' || p.row === row));
    const span = Math.max(0, world.w - item.w);
    let best = Math.round(span / 2), bestHit = Infinity;
    for (let i = 0; i <= span; i += 2) {
      const x = Math.round(span / 2 + (i % 4 === 0 ? i / 2 : -i / 2));
      if (x < 0 || x > span) continue;
      const hit = same.reduce((n, p) => n + Math.max(0, Math.min(x + item.w, p.x + p.w) - Math.max(x, p.x)), 0);
      if (hit < bestHit) { best = x; bestHit = hit; if (!hit) break; }
    }
    return best;
  }
  const defaultRow = item => (item.layer === 'float' ? 1 : item.layer === 'back' || item.h >= TALL ? 0 : 2);

  function canAdd(item) {
    if (!item || item.locked) return 'locked';
    if (draft.placed.length >= capacityOf(draft.size)) return 'full';
    const used = draft.placed.filter(p => p.ref === item.ref).length;
    if (item.max !== null && used >= item.max) return 'not-enough';
    return null;
  }

  function add(ref, at = null) {
    const item = trayItem(ref);
    const why = canAdd(item);
    if (why === 'full') return say(`His tank is full: ${plural(capacityOf(draft.size), 'piece')}. Put something away, or try a bigger tank.`);
    if (why) return say(`${item?.name || 'That'} can’t go in: ${reason(why)}.`);
    const row = at ? at.row : defaultRow(item);
    const uid = draft.placed.reduce((m, p) => Math.max(m, p.uid), 0) + 1;
    const x = at ? at.x : freeSpot(item, row);
    commit(d => { d.placed.push({ uid, ref, x, row, z: topZ(d, row) + 1, flip: false }); }, { keepFocus: false, announce: `${item.name} in, ${rowName({ ...item, row })}.` });
    select(uid);
  }
  const topZ = (d, row) => d.placed.filter(p => p.row === row).reduce((m, p) => Math.max(m, p.z), 0);

  function nudge(uid, fn, words) {
    const p = pieceOf(uid);
    if (!p) return;
    const item = trayItem(p.ref);
    commit(d => {
      const q = d.placed.find(x => x.uid === uid);
      fn(q, item, scene().world);
      q.x = Math.max(0, Math.min(q.x, scene().size.w - (item?.w || 1)));
    }, { announce: words });
  }
  const moveBy = (uid, dx) => nudge(uid, q => { q.x += dx; }, null);
  const rowBy = (uid, dr) => nudge(uid, (q, item) => {
    if (item?.layer === 'back') return;
    q.row = Math.max(0, Math.min(2, q.row + dr));
  }, null);
  const flip = uid => nudge(uid, q => { q.flip = !q.flip; }, 'Flipped.');
  // Back or forward among the pieces in its row: the row is renumbered 0, 1, 2…
  // in paint order, with this one moved to the very back or the very front.
  function restack(uid, dz) {
    const p = pieceOf(uid);
    if (!p) return;
    commit(d => {
      const row = d.placed.filter(x => x.row === p.row).sort((a, b) => a.z - b.z || a.x - b.x || a.uid - b.uid);
      const me = row.find(x => x.uid === uid);
      const others = row.filter(x => x !== me);
      (dz > 0 ? [...others, me] : [me, ...others]).forEach((x, i) => { x.z = i; });
    }, { announce: dz > 0 ? 'Brought forward.' : 'Sent back.' });
  }
  function putAway(uid) {
    const p = pieceOf(uid);
    if (!p) return;
    const name = trayItem(p.ref)?.name || 'It';
    commit(d => { d.placed = d.placed.filter(x => x.uid !== uid); }, { keepFocus: false, announce: `${name} put away.` });
    selected = null;
    renderTools();
    (hits.querySelector('.tk-hit:not(.tk-hit-crab)') || $('tkDone')).focus({ preventScroll: true });
  }

  hits.addEventListener('keydown', e => {
    const btn = e.target.closest('.tk-hit');
    if (!btn || btn.classList.contains('tk-hit-crab')) return;
    const uid = Number(btn.dataset.uid);
    if (!editing()) {
      // Watching: arrow keys walk along what's in the tank.
      const all = [...hits.querySelectorAll('.tk-hit')];
      const i = all.indexOf(btn);
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, to))].focus({ preventScroll: true });
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave the app's shortcuts alone
    const step = e.shiftKey ? 8 : 1;
    const act = {
      ArrowLeft: () => moveBy(uid, -step), ArrowRight: () => moveBy(uid, step),
      ArrowUp: () => rowBy(uid, -1), ArrowDown: () => rowBy(uid, 1),
      f: () => flip(uid), F: () => flip(uid),
      '[': () => restack(uid, -1), ']': () => restack(uid, 1),
      Delete: () => putAway(uid), Backspace: () => putAway(uid),
      Enter: () => select(uid), ' ': () => select(uid),
      Escape: () => { selected = null; renderHits(); renderTools(); },
    }[e.key];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    if (selected !== uid && e.key.startsWith('Arrow')) selected = uid;
    act();
  });

  document.addEventListener('keydown', e => {
    if (state.view !== 'tank' || !editing() || !(e.ctrlKey || e.metaKey) || e.target.closest?.('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ------------------------------------------------------------ dragging

  function artAt(e) {
    const r = canvas.getBoundingClientRect();
    return { ax: (e.clientX - r.left) / u, ay: (e.clientY - r.top) / u, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
  }
  // The row nearest the piece's foot, with the pointer at its middle.
  function rowAt(item, ay) {
    const { world } = scene();
    if (item.layer === 'back') return 0;
    const lines = item.layer === 'float' ? world.floatY : world.rows;
    const foot = ay + item.h / 2;
    let best = 0;
    lines.forEach((y, i) => { if (Math.abs(y - foot) < Math.abs(lines[best] - foot)) best = i; });
    return best;
  }

  hits.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.tk-hit');
    if (!editing() || !btn || btn.classList.contains('tk-hit-crab') || e.button !== 0) return;
    const p = pieceOf(Number(btn.dataset.uid));
    if (!p) return;
    const { ax } = artAt(e);
    drag = { kind: 'piece', uid: p.uid, startX: e.clientX, startY: e.clientY, grab: ax - p.x, moved: false, id: e.pointerId, before: clone(draft) };
  });

  $('tkTray').addEventListener('pointerdown', e => {
    const btn = e.target.closest('.tk-item[data-ref]');
    if (!editing() || !btn || btn.disabled || e.button !== 0 || btn.dataset.style) return;
    drag = { kind: 'new', ref: btn.dataset.ref, startX: e.clientX, startY: e.clientY, moved: false, id: e.pointerId, over: false, x: 0, row: 0 };
  });

  document.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!(e.buttons & 1)) return endDrag(e, false);
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_START) return;
    if (!drag.moved) { drag.moved = true; stage.classList.add('dragging'); tag(null); }
    const { ax, ay, inside } = artAt(e);
    const sc = scene();
    if (drag.kind === 'piece') {
      const q = draft.placed.find(p => p.uid === drag.uid);
      const item = trayItem(q.ref);
      q.x = Math.round(Math.max(0, Math.min(sc.size.w - item.w, ax - drag.grab)));
      q.row = rowAt(item, ay);
      moveHit(q.uid);
    } else {
      const item = trayItem(drag.ref);
      drag.over = inside;
      drag.x = Math.round(Math.max(0, Math.min(sc.size.w - item.w, ax - item.w / 2)));
      drag.row = rowAt(item, ay);
    }
    dirty = true;
    kick();
  });

  function endDrag(e, dropped = true) {
    const d = drag;
    drag = null;
    stage.classList.remove('dragging');
    if (!d) return;
    if (!d.moved) {
      // A press without a drag: a tray item goes in at the first good spot.
      if (d.kind === 'new' && dropped) add(d.ref);
      return;
    }
    stage.dataset.dragged = '1';
    setTimeout(() => { delete stage.dataset.dragged; }, 0);
    if (d.kind === 'piece') {
      // The move is one step to undo, from where it started.
      history.push(d.before);
      if (history.length > MAX_HISTORY) history.shift();
      future = [];
      selected = d.uid;
      afterChange(false);
      hitFor(d.uid)?.focus({ preventScroll: true });
    } else if (dropped && d.over) {
      add(d.ref, { x: d.x, row: d.row });
    } else {
      dirty = true;
      kick();
    }
  }
  document.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.id) endDrag(e, true); });
  document.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) endDrag(e, false); });

  // ------------------------------------------------------------ words and controls around it

  function say(text) { $('tkLive').textContent = ''; requestAnimationFrame(() => { $('tkLive').textContent = text; }); }

  function renderTitle() {
    const lay = layout();
    const sz = v.sizes.find(s => s.id === lay.size) || v.size;
    const n = lay.placed.length;
    $('tkSub').textContent = `${sz.name} · ${n} of ${plural(sz.cap, 'piece')}`;
    $('tkEmpty').hidden = n > 0 || editing();
    const names = scene().pieces.map(p => p.name);
    canvas.setAttribute('aria-label', names.length
      ? `His tank, the ${sz.name.toLowerCase()}: ${listOf(names.length > 6 ? [...names.slice(0, 5), plural(names.length - 5, 'more thing')] : names)}.`
      : `His tank, the ${sz.name.toLowerCase()}. Nothing in it yet.`);
    const missing = v.missing.length;
    $('tkMissing').hidden = !missing || editing();
    $('tkMissing').textContent = missing ? `${plural(missing, 'piece')} in his tank can’t be shown on this PC (its pack was removed, or it’s locked again). ${missing === 1 ? 'It keeps' : 'They keep'} ${missing === 1 ? 'its' : 'their'} place.` : '';
  }

  // Where more decor comes from, counted from the tray itself.
  function renderKey() {
    $('tkKeySec').hidden = editing();
    if (editing()) return;
    const decor = v.tray.filter(t => t.kind === 'decor');
    const have = decor.filter(t => !t.locked);
    const earned = decor.filter(t => t.unlock?.achievement);
    const nextUp = earned.find(t => t.locked && t.locked.reason === 'achievement');
    const seasonal = decor.filter(t => t.unlock?.season);
    const finds = v.tray.filter(t => t.kind === 'find');
    const jars = v.tray.filter(t => t.kind === 'jar');
    const bar = (n, of) => h('span', { class: 'tk-bar', 'aria-hidden': 'true', style: `--fill: ${of ? n / of : 0}` });
    $('tkKeyMeta').replaceChildren(`${have.length} of ${plural(decor.length, 'piece')} are his`, bar(have.length, decor.length));
    // One source per row: what it is, how many, and a line on how they arrive.
    const row = (name, count, text, meter) => h('li', { class: 'tk-src' },
      h('div', { class: 'tk-src-h' }, h('span', { class: 'tk-src-name', text: name }), h('span', { class: 'tk-src-n', text: count })),
      meter, h('p', {}, text));
    const one = seasonal.length === 1;
    const trophies = earned.filter(t => !t.locked).length;
    const nextText = nextUp && nextUp.locked.text.replace(/^[^:]*: /, '').replace(/^./, c => c.toUpperCase());
    $('tkKey').replaceChildren(
      row('From the start', String(decor.filter(t => t.unlock?.default).length), 'A castle, plants, rocks, a floor and a back wall.'),
      row('Trophies', `${trophies} of ${earned.length}`,
        nextUp ? [h('b', { text: `Next: the ${nextUp.name.toLowerCase()}. ` }), `${nextText}.`] : 'Every trophy piece is his.',
        bar(trophies, earned.length)),
      row('Seasons', `${seasonal.filter(t => !t.locked).length} of ${seasonal.length}`,
        `${one ? 'Turns' : 'Turn'} up in ${one ? 'its' : 'their'} season, then ${one ? 'stays' : 'stay'} for good.`),
      row('His finds', String(finds.length),
        finds.length ? 'Everything he digs up can go in, as many as he’s found.' : 'Whatever he digs up for you can go in. Nothing yet: give him time.'),
      ...(jars.length ? [row('Specimen jars', String(jars.length), 'Every kind of bug Claude has fixed, in a jar from the Bugdex.')] : []));
  }

  function renderTools() {
    const edit = editing();
    $('tkDecorate').hidden = edit;
    for (const id of ['tkUndo', 'tkRedo', 'tkCancel', 'tkDone']) $(id).hidden = !edit;
    $('tkUndo').disabled = !history.length;
    $('tkRedo').disabled = !future.length;
    const p = edit && selected && pieceOf(selected);
    const item = p && trayItem(p.ref);
    $('tkPicked').hidden = !item;
    if (item) $('tkPickedName').textContent = item.name;
    $('tkKeysHint').hidden = !edit;
  }

  function shelves() {
    const present = new Set(v.tray.map(t => t.category));
    return v.categories.filter(c => present.has(c.id));
  }

  function renderTray() {
    const box = $('tkTray');
    box.hidden = !editing();
    if (!editing()) return;
    const list = shelves();
    if (!list.some(c => c.id === shelf)) shelf = list[0]?.id || null;
    $('tkShelves').replaceChildren(...list.map(c => {
      const fresh = v.tray.some(t => t.category === c.id && t.isNew && !t.locked && t.kind === 'decor' && !seen.has(t.ref));
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(c.id === shelf), tabindex: c.id === shelf ? '0' : '-1', dataset: { shelf: c.id, keep: `shelf:${c.id}` } },
        c.name, fresh ? h('i', { class: 'dot-badge', 'aria-hidden': 'true' }) : null);
    }));
    const lay = draft;
    const style = shelf === 'substrate' || shelf === 'backdrop';
    const room = capacityOf(lay.size) - lay.placed.length;
    const items = v.tray.filter(t => t.category === shelf);
    $('tkItems').replaceChildren(...items.map(t => {
      const used = lay.placed.filter(p => p.ref === t.ref).length;
      const chosen = style && (lay.style[shelf] || (v.style[shelf]?.ref)) === t.ref;
      const left = t.max !== null ? t.max - used : null;
      const off = !!t.locked || (!style && (room <= 0 || left === 0));
      const meta = t.locked ? t.locked.text
        : style ? (chosen ? 'In the tank' : '')
          : left !== null ? (left ? `${left} left` : 'All in the tank') : used ? `${used} in the tank` : '';
      return h('button', {
        type: 'button', class: `tk-item${t.locked ? ' locked' : ''}${chosen ? ' chosen' : ''}`,
        disabled: off, 'aria-pressed': style ? String(chosen) : null,
        title: t.locked ? `Locked: ${t.locked.text}` : t.description,
        dataset: style ? { ref: t.ref, style: shelf, keep: `item:${t.ref}` } : { ref: t.ref, keep: `item:${t.ref}` },
      },
      h('span', { class: 'tk-thumb', 'aria-hidden': 'true' }, P.thumb(t, THUMB)),
      h('span', { class: 'tk-item-name', text: t.name }),
      meta ? h('span', { class: 'tk-item-meta', text: meta }) : null,
      t.isNew && !t.locked && t.kind === 'decor' && !seen.has(t.ref) ? h('i', { class: 'dot-badge', 'aria-label': 'new' }) : null);
    }));
    $('tkItems').setAttribute('aria-label', list.find(c => c.id === shelf)?.name || 'Tray');
    // Seen once it's on screen.
    const fresh = items.filter(t => t.isNew && !t.locked && t.kind === 'decor' && !seen.has(t.ref)).map(t => t.ref);
    if (fresh.length) { fresh.forEach(r => seen.add(r)); api.tankSeen(fresh); }
    renderSettings();
  }

  function renderSettings() {
    const lay = draft;
    $('tkSizes').replaceChildren(...v.sizes.map(s => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(s.id === lay.size), disabled: !s.unlocked,
      title: s.unlocked ? `${s.w} × ${s.h}, room for ${s.cap}` : `Grows into it at level ${s.level}${s.shipped ? ` with ${s.shipped} projects shipped` : ''}`,
      dataset: { size: s.id },
    }, s.name, s.unlocked ? null : h('span', { class: 'tk-lock', text: ` · L${s.level}` }))));
    $('tkLight').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.light === lay.style.light)));
  }

  $('tkShelves').addEventListener('click', e => {
    const b = e.target.closest('[data-shelf]');
    if (!b) return;
    shelf = b.dataset.shelf;
    renderTray();
    $('tkShelves').querySelector(`[data-shelf="${shelf}"]`)?.focus();
  });
  $('tkItems').addEventListener('click', e => {
    const b = e.target.closest('.tk-item');
    if (!b || b.disabled || !b.dataset.style) return; // pieces go in on pointerup or Enter, see below
    const role = b.dataset.style, ref = b.dataset.ref;
    commit(d => { d.style[role] = ref; }, { keepFocus: false, announce: `${trayItem(ref).name} it is.` });
    [...$('tkItems').querySelectorAll('.tk-item')].find(x => x.dataset.ref === ref)?.focus();
  });
  // The keyboard's way in: Enter or Space on a piece in the tray.
  $('tkItems').addEventListener('keydown', e => {
    const b = e.target.closest('.tk-item');
    if (!b || b.dataset.style || !(e.key === 'Enter' || e.key === ' ')) return;
    e.preventDefault();
    if (!b.disabled) add(b.dataset.ref);
  });
  $('tkSizes').addEventListener('click', e => {
    const b = e.target.closest('[data-size]');
    if (!b || b.disabled || b.dataset.size === draft.size) return;
    const next = v.sizes.find(s => s.id === b.dataset.size);
    const over = draft.placed.length - next.cap;
    commit(d => {
      d.size = next.id;
      if (over > 0) d.placed = d.placed.slice(0, next.cap); // the newest go back in the tray
    }, { keepFocus: false, announce: over > 0 ? `The ${next.name.toLowerCase()} holds ${next.cap}: ${plural(over, 'piece')} went back in the tray.` : `Trying the ${next.name.toLowerCase()}.` });
    size();
    $('tkSizes').querySelector(`[data-size="${next.id}"]`)?.focus();
  });
  $('tkLight').addEventListener('click', e => {
    const b = e.target.closest('[data-light]');
    if (!b || b.dataset.light === draft.style.light) return;
    commit(d => { d.style.light = b.dataset.light; }, { keepFocus: false });
    renderSettings();
  });

  $('tkDecorate').addEventListener('click', startEditing);
  $('tkDone').addEventListener('click', done);
  $('tkCancel').addEventListener('click', cancel);
  $('tkUndo').addEventListener('click', undo);
  $('tkRedo').addEventListener('click', redo);
  $('tkFlip').addEventListener('click', () => selected && flip(selected));
  $('tkBack').addEventListener('click', () => selected && restack(selected, -1));
  $('tkForward').addEventListener('click', () => selected && restack(selected, 1));
  $('tkAway').addEventListener('click', () => selected && putAway(selected));

  // ------------------------------------------------------------ data in

  function badge() {
    document.querySelectorAll('.tk-badge').forEach(el => { el.hidden = !v?.news.length; });
  }

  // ------------------------------------------------------------ on your calling card (tank-share.js)

  function renderShare() {
    const f = state.github?.features || {};
    const cards = !!(f.friends?.on || f.profileCard?.on);
    $('tkShare').checked = !!v.shareCard;
    $('tkShareHelp').textContent = !v.shareCard
      ? 'Your calling card and profile card show his outfit and his shell, not his tank. The crab card you share yourself (📸 Share) always shows it.'
      : !cards
        ? 'Visiting crabs and the profile card are both off (Settings → GitHub), so there’s no card for it to go on yet.'
        : 'They show its size, floor, back glass and up to 24 pieces: built-in decor and his finds. Specimen jars and decor from packs stay home.';
  }

  $('tkShare').addEventListener('change', async e => {
    const on = e.target.checked;
    e.target.disabled = true;
    const r = await api.shareTank(on).catch(() => null);
    e.target.disabled = false;
    if (r?.view) apply(r.view);
    if (!r?.ok) { e.target.checked = !on; SB.toast('Couldn’t change that. Try again in a moment.'); return; }
    SB.toast(on ? 'His tank goes on your cards when they next update.' : 'His tank comes off your cards when they next update, in a minute or so.');
  });

  function renderAll() {
    if (!v) return;
    size();
    renderTitle();
    renderTools();
    renderHits();
    renderTray();
    renderKey();
    renderShare();
    dirty = true;
    kick();
  }

  // The newest answer wins: an older fetch arriving late is dropped.
  async function fetchTank() {
    const n = ++seq;
    const next = await api.getTank();
    return n === seq ? next : null;
  }

  function apply(next) {
    if (!next) return;
    v = next;
    badge();
    if (draft && draft.size !== v.layout.size && !v.sizes.find(s => s.id === draft.size)?.unlocked) draft.size = v.layout.size;
    if (state.view === 'tank') keepingFocus(renderAll);
    document.dispatchEvent(new CustomEvent('sb:tank', { detail: v })); // the Health porthole and the profile card
  }

  async function open() {
    apply(await fetchTank());
    await loadCrab();
    if (v && !editing() && !walker.target) walker.x = stillX();
  }

  // New decor unlocking, a find, or a different outfit changes what's shown.
  let refetch = 0;
  const later = () => { clearTimeout(refetch); refetch = setTimeout(() => fetchTank().then(apply), state.view === 'tank' ? 500 : 4000); };
  api.onWardrobe?.(later);
  api.onUnlocked?.(later);
  api.onLife?.(later);
  api.onSkin?.(() => { crabKey = null; if (state.view === 'tank') loadCrab(); });
  new ResizeObserver(() => { if (state.view === 'tank' && v) { size(); keepingFocus(renderHits); kick(); } }).observe(stage);
  document.addEventListener('visibilitychange', kick);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => { dirty = true; kick(); });

  SB.views.tank = { render: () => { open(); } };
  SB.tankView = () => v;
  api.getTank().then(next => { if (next) { v = next; badge(); document.dispatchEvent(new CustomEvent('sb:tank', { detail: v })); } });
})();
