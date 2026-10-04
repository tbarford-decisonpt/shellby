/* Shellby panel — the workflow map. A workflow drawn as nodes joined by wires,
   n8n-style, laid out from its steps: no positions are stored, so a drafted or
   imported workflow reads top to bottom like every other. If splits into lanes
   side by side; Repeat wraps its steps in a loop.

   workflows.js owns the workflow, what each node says and what the inspector
   holds; this file draws, pans, zooms, selects and drags. Untrusted text only
   reaches the page through SB.h / textContent. */
'use strict';
(function () {
  const { h } = SB;
  const G = window.ShellbyWfGraph;
  const NS = 'http://www.w3.org/2000/svg';
  const ZOOM_MIN = 0.35;
  const ZOOM_MAX = 1.6;
  const ZOOM_STEP = 1.2;
  const DRAG_START = 5;   // px a press travels before it's a drag, not a click
  const DROP_REACH = 70;  // px from a + that still counts as dropping on it
  const EDGE_PAN = 36;    // px from the map's edge where a drag scrolls it
  const EDGE_SPEED = 14;  // px the map moves per pointer move while you're there
  const MARGIN = 28;      // px kept clear around the workflow when it's placed
  const CURVE = 44;       // px a wire takes to bend into a node beside it
  const LOOP_OUT = 16;    // px a Repeat's way back sits outside its frame
  const GRID = 22;        // px between the dots behind the map, at 100%

  // Where you were on each map (id -> { x, y, z, placed, insp }), across rebuilds.
  const views = new Map();
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* o = {
       id, label, readOnly, steps, maxDepth, sel,
       icon(name)                    -> svg
       triggers: [() => info]        the row along the top (info below)
       step(step, place)             -> info for a step node
       end                           -> info for the last node, or null for a plain "Done"
       started                       the run reached its first step (lights the wires)
       register(at, cell)            -> an element for this node's problems, or null
       select(sel, was)              you picked a node (or null: `was` had been open)
       closed(was)                   the inspector closed on something that isn't a node
       inspect(box, sel, close)      fill the inspector; false if there's nothing to show
       add(list, index, btn, depth)  a + was pressed
       addLabel(list, index)  addFk(list, index)
       addTrigger(btn)               or null: no "+ Trigger"
       move(step, list, index)       a node was dropped on a +
       remove(sel)                   Delete on a node
       tools: [elements]             extra toolbar buttons
     }
     info = { sel, kind, type, icon, title, sub, at, status, badge, note, ran, removable, branches, loopLabel } */
  function mount(o) {
    const saved = views.get(o.id);
    // auto: you haven't zoomed or panned, so it re-fits when the panel changes size.
    const v = saved ? { ...saved } : { x: 0, y: 0, z: 1, placed: false, auto: true, insp: 0 };
    const records = [];   // every node: { sel, btn, cell, refresh, step, place }
    const links = [];     // [from, to, kind, via]
    const gaps = [];      // every +: { el, list, index }
    let selected = o.sel || null;
    let justDragged = false;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'wfc-wires');
    svg.setAttribute('aria-hidden', 'true');
    const flow = h('div', { class: 'wfc-flow' });
    const board = h('div', { class: 'wfc-board' }, svg, flow);
    const stage = h('div', { class: 'wfc-stage', tabindex: '0', role: 'group', 'aria-label': o.label }, board);
    const zoomLabel = h('button', { type: 'button', class: 'wfc-zoom', title: 'Back to 100%', 'aria-label': 'Zoom to 100%', onclick: () => zoomAt(null, 1 / v.z) });
    const tools = h('div', { class: 'wfc-tools', role: 'toolbar', 'aria-label': 'Map' },
      toolBtn('minus', 'Zoom out', () => zoomAt(null, 1 / ZOOM_STEP)),
      zoomLabel,
      toolBtn('plus', 'Zoom in', () => zoomAt(null, ZOOM_STEP)),
      toolBtn('fit', 'Fit the whole workflow', fit),
      o.tools?.length ? h('span', { class: 'wfc-tools-sep', 'aria-hidden': 'true' }) : null,
      o.tools || []);
    const inspId = `wfcInsp${Math.random().toString(36).slice(2, 8)}`;
    const inspBody = h('div', { class: 'wfc-insp-body' });
    const insp = h('aside', { class: 'wfc-insp', id: inspId, 'aria-label': 'Selected node', hidden: true }, inspBody);
    const el = h('div', { class: `wfc${o.readOnly ? ' read-only' : ''}` },
      h('div', { class: 'wfc-main' }, stage, tools), insp);

    function toolBtn(name, label, onclick) {
      return h('button', { type: 'button', class: 'icon-btn wfc-tool', title: label, 'aria-label': label, onclick }, o.icon(name));
    }

    const link = (from, to, kind = '', via = null) => links.push([from, to, kind, via]);

    // ------------------------------------------------------------ building

    function nodeCell(info, extra = {}) {
      const title = h('span', { class: 'wfc-title' });
      const sub = h('span', { class: 'wfc-sub' });
      const badge = h('span', { class: 'wfc-badge', 'aria-hidden': 'true' });
      const note = h('span', { class: 'sr-only' });
      const btn = h('button', {
        type: 'button', class: 'wfc-node', 'aria-expanded': 'false', 'aria-controls': inspId,
        // detail 0: Enter or Space, so the fields get focus too.
        onclick: e => { if (!justDragged) choose(rec.sel, { focus: e.detail === 0 }); },
      },
      h('span', { class: 'wfc-icon', 'aria-hidden': 'true' }, o.icon(info.icon || info.type)),
      h('span', { class: 'wfc-text' }, title, sub), badge, note);
      const cell = h('div', { class: `wfc-cell k-${info.kind}`, 'data-type': info.type || '' }, btn);
      const rec = { sel: info.sel, btn, cell, ...extra };
      rec.refresh = next => {
        const i = next || info;
        title.textContent = i.title || '';
        sub.textContent = i.sub || '';
        sub.hidden = !i.sub;
        badge.textContent = i.badge || '';
        badge.hidden = !i.badge;
        note.textContent = i.note ? `. ${i.note}` : '';
        btn.dataset.fk = `node-${i.sel}`;
        // Marks other code owns (problems, selection, a drag) outlive a repaint.
        const kept = ['has-err', 'selected', 'drag-src'].filter(c => cell.classList.contains(c));
        cell.className = `wfc-cell k-${i.kind}${i.status ? ` s-${i.status}` : ''}${i.ran ? ' ran' : ''}${i.dashed ? ' dashed' : ''}`;
        cell.classList.add(...kept);
        rec.removable = !!i.removable;
        rec.sel = i.sel;
      };
      rec.refresh();
      if (info.at && o.register) {
        const err = o.register(info.at, cell);
        if (err) cell.append(err);
      }
      if (!o.readOnly && extra.step) btn.addEventListener('pointerdown', e => armDrag(e, rec));
      records.push(rec);
      return cell;
    }

    function addBtn(list, index, depth) {
      const b = h('button', {
        type: 'button', class: 'wfc-add', title: o.addLabel(list, index), 'aria-label': o.addLabel(list, index),
        'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': o.addFk(list, index),
        onclick: e => o.add(list, index, e.currentTarget, depth),
      }, o.icon('plus'));
      gaps.push({ el: b, list, index });
      return b;
    }

    // One list of steps, top to bottom: { el, inlet, outlet } for wiring it in.
    function column(steps, at, depth, chain, base) {
      const col = h('div', { class: 'wfc-col' });
      let first = null;
      let prev = null;
      const push = (part, inlet = part, outlet = part) => {
        if (prev) link(prev, inlet); else first = inlet;
        prev = outlet;
        col.append(part);
      };
      if (!o.readOnly) push(addBtn(steps, 0, depth));
      steps.forEach((s, i) => {
        const place = { list: steps, index: i, at: `${at}[${i}]`, depth, chain: [...chain, { list: steps, index: i }], key: `${base}${s.id}` };
        const b = block(s, place);
        push(b.el, b.inlet, b.outlet);
        if (!o.readOnly) push(addBtn(steps, i + 1, depth));
      });
      if (!first) push(h('div', { class: 'wfc-nothing', text: 'Nothing here' }));
      return { el: col, inlet: first, outlet: prev };
    }

    function block(s, place) {
      const info = { ...o.step(s, place), kind: 'step' };
      const cell = nodeCell(info, { step: s, place });
      if (s.type === 'if') {
        const join = h('div', { class: `wfc-dot${info.ran ? ' ran' : ''}` });
        const lanes = h('div', { class: 'wfc-lanes' });
        for (const [k, name] of [['then', 'Then'], ['else', 'Otherwise']]) {
          const taken = !!info.branches?.includes(k);
          const label = h('div', { class: `wfc-lane-label b-${k}${taken ? ' ran' : ''}`, text: name });
          const inner = column(s[k] || [], `${place.at}.${k}`, place.depth + 1, place.chain, G.childBase(s, place.key, k));
          link(cell, label);
          link(label, inner.inlet);
          link(inner.outlet, join);
          lanes.append(h('div', { class: `wfc-lane${o.readOnly && info.ran && !taken ? ' dim' : ''}` }, label, inner.el));
        }
        return { el: h('div', { class: 'wfc-block' }, cell, lanes, join), inlet: cell, outlet: join };
      }
      if (s.type === 'each') {
        const label = h('div', { class: `wfc-lane-label b-each${info.ran ? ' ran' : ''}`, text: info.loopLabel || 'Each item' });
        const inner = column(s.steps || [], `${place.at}.steps`, place.depth + 1, place.chain, G.childBase(s, place.key, 'steps'));
        const frame = h('div', { class: 'wfc-loop' }, label, inner.el);
        const out = h('div', { class: `wfc-dot${info.ran ? ' ran' : ''}` });
        link(cell, label);
        link(label, inner.inlet);
        link(inner.outlet, out);
        link(frame, cell, 'loop', frame);
        return { el: h('div', { class: 'wfc-block' }, cell, frame, out), inlet: cell, outlet: out };
      }
      return { el: cell, inlet: cell, outlet: cell };
    }

    const top = h('div', { class: 'wfc-row' });
    const start = h('div', { class: `wfc-dot wfc-start${o.started ? ' ran' : ''}` });
    for (const get of o.triggers) {
      const cell = nodeCell(get(), { get });
      top.append(cell);
      link(cell, start);
    }
    if (o.addTrigger) {
      top.append(h('button', {
        type: 'button', class: 'wfc-ghost', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': 'add-trigger',
        onclick: e => o.addTrigger(e.currentTarget),
      }, o.icon('plus'), 'Trigger'));
    }
    const main = column(o.steps, 'steps', 1, [], '');
    const end = o.end ? nodeCell({ kind: 'end', icon: 'flag', ...o.end }) : h('div', { class: 'wfc-end', text: 'Done' });
    link(start, main.inlet);
    link(main.outlet, end);
    flow.append(top, start, main.el, end);

    // ------------------------------------------------------------ wires

    const box = (r, br) => ({ x: (r.left - br.left) / v.z, y: (r.top - br.top) / v.z, w: r.width / v.z, h: r.height / v.z });

    function wirePath(A, B, kind, F) {
      if (kind === 'loop') {
        // Round the outside of the frame, from its foot back up into the Repeat's side.
        const xr = F.x + F.w + LOOP_OUT;
        const y1 = F.y + F.h - 18;
        const y2 = B.y + B.h / 2;
        const r = 10;
        return `M ${F.x + F.w} ${y1} H ${xr - r} Q ${xr} ${y1} ${xr} ${y1 - r} V ${y2 + r} Q ${xr} ${y2} ${xr - r} ${y2} H ${B.x + B.w}`;
      }
      const x1 = A.x + A.w / 2;
      const y1 = A.y + A.h;
      const x2 = B.x + B.w / 2;
      const y2 = B.y;
      if (Math.abs(x1 - x2) < 0.5) return `M ${x1} ${y1} V ${y2}`;
      // Straight down, then bend into place just above where it lands.
      const c = Math.min(Math.max(y2 - y1, 1), CURVE);
      return `M ${x1} ${y1} V ${y2 - c} C ${x1} ${y2 - c / 2} ${x2} ${y2 - c / 2} ${x2} ${y2}`;
    }

    function draw() {
      if (!board.isConnected) return;
      const br = board.getBoundingClientRect();
      const W = flow.offsetWidth;
      const H = flow.offsetHeight;
      svg.setAttribute('width', W + LOOP_OUT * 2);
      svg.setAttribute('height', H);
      const marker = document.createElementNS(NS, 'marker');
      for (const [k, val] of Object.entries({ id: 'wfcArrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' })) marker.setAttribute(k, val);
      const tip = document.createElementNS(NS, 'path');
      tip.setAttribute('d', 'M 1 1 L 7 4 L 1 7');
      tip.setAttribute('class', 'wfc-tip');
      marker.append(tip);
      const defs = document.createElementNS(NS, 'defs');
      defs.append(marker);
      const paths = links.map(([a, b, kind, via]) => {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', wirePath(box(a.getBoundingClientRect(), br), box(b.getBoundingClientRect(), br), kind, via && box(via.getBoundingClientRect(), br)));
        const lit = a.classList.contains('ran') && b.classList.contains('ran');
        p.setAttribute('class', `wfc-wire${kind ? ` ${kind}` : ''}${lit ? ' lit' : ''}`);
        if (b.classList.contains('wfc-cell')) p.setAttribute('marker-end', 'url(#wfcArrow)');
        return p;
      });
      svg.replaceChildren(defs, ...paths);
    }

    // ------------------------------------------------------------ pan and zoom

    function apply() {
      board.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
      stage.style.backgroundSize = `${GRID * v.z}px ${GRID * v.z}px`;
      stage.style.backgroundPosition = `${v.x}px ${v.y}px`;
      zoomLabel.textContent = `${Math.round(v.z * 100)}%`;
      views.set(o.id, { ...v });
    }

    // The top of the workflow, centred, small enough to fit across.
    function place() {
      const sw = stage.clientWidth;
      if (!sw) return false;
      const fw = flow.offsetWidth;
      v.z = clamp(Math.min(1, (sw - MARGIN * 2) / fw), ZOOM_MIN, 1);
      v.x = (sw - fw * v.z) / 2;
      v.y = MARGIN;
      v.placed = true;
      v.auto = true;
      apply();
      return true;
    }

    function fit() {
      const sw = stage.clientWidth;
      const sh = visibleHeight();
      const fw = flow.offsetWidth;
      const fh = flow.offsetHeight;
      v.z = clamp(Math.min((sw - MARGIN * 2) / fw, (sh - MARGIN * 2) / fh, 1), ZOOM_MIN, ZOOM_MAX);
      v.x = (sw - fw * v.z) / 2;
      v.y = Math.max(MARGIN, (sh - fh * v.z) / 2);
      v.auto = false;
      apply();
    }

    // Zoom around a point on screen (the middle of the map when there isn't one).
    function zoomAt(point, factor) {
      const r = stage.getBoundingClientRect();
      const px = point ? point.x - r.left : r.width / 2;
      const py = point ? point.y - r.top : visibleHeight() / 2;
      const z = clamp(v.z * factor, ZOOM_MIN, ZOOM_MAX);
      v.x = px - ((px - v.x) * z) / v.z;
      v.y = py - ((py - v.y) * z) / v.z;
      v.z = z;
      v.auto = false;
      apply();
    }

    // Narrow, the inspector is a sheet over the bottom of the map.
    const sheet = () => !insp.hidden && getComputedStyle(insp).position === 'absolute';
    const visibleHeight = () => (sheet() ? insp.getBoundingClientRect().top - stage.getBoundingClientRect().top : stage.clientHeight);

    function ensureVisible(target) {
      if (!target?.isConnected) return;
      const s = stage.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const bottom = s.top + visibleHeight();
      const pad = 24;
      let dx = 0;
      let dy = 0;
      if (r.left < s.left + pad) dx = s.left + pad - r.left;
      else if (r.right > s.right - pad) dx = Math.max(s.right - pad - r.right, s.left + pad - r.left);
      if (r.top < s.top + pad) dy = s.top + pad - r.top;
      else if (r.bottom > bottom - pad) dy = Math.max(bottom - pad - r.bottom, s.top + pad - r.top);
      if (!dx && !dy) return;
      v.x += dx;
      v.y += dy;
      v.auto = false;
      apply();
    }

    stage.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey) zoomAt({ x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.0015));
      else { v.x -= e.deltaX; v.y -= e.deltaY; v.auto = false; apply(); }
    }, { passive: false });

    // Drag the background (or anything, with the middle button) to look around.
    stage.addEventListener('pointerdown', e => {
      const onNode = e.target.closest('button');
      if (!(e.button === 1 || (e.button === 0 && !onNode))) return;
      e.preventDefault();
      if (!onNode) stage.focus({ preventScroll: true });
      const sx = e.clientX - v.x;
      const sy = e.clientY - v.y;
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('panning');
      const move = ev => { v.x = ev.clientX - sx; v.y = ev.clientY - sy; v.auto = false; apply(); };
      const up = () => {
        stage.classList.remove('panning');
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        stage.removeEventListener('pointercancel', up);
      };
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    });

    // Tabbing to a node scrolls the stage itself; turn that into a pan instead.
    stage.addEventListener('scroll', () => {
      if (!stage.scrollTop && !stage.scrollLeft) return;
      v.x -= stage.scrollLeft;
      v.y -= stage.scrollTop;
      stage.scrollTop = 0;
      stage.scrollLeft = 0;
      apply();
    });
    stage.addEventListener('focusin', e => { if (e.target !== stage) ensureVisible(e.target.closest('.wfc-cell') || e.target); });

    const PAN_KEYS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    stage.addEventListener('keydown', e => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const rec = records.find(r => r.btn === e.target);
      if ((e.key === 'Delete' || e.key === 'Backspace') && rec?.removable && !o.readOnly) {
        e.preventDefault();
        o.remove(rec.sel);
        return;
      }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(null, ZOOM_STEP); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(null, 1 / ZOOM_STEP); return; }
      if (e.key === '0') { e.preventDefault(); fit(); return; }
      const pan = e.target === stage && PAN_KEYS[e.key];
      if (pan) { e.preventDefault(); v.x += pan[0] * 60; v.y += pan[1] * 60; v.auto = false; apply(); }
    });

    // Esc closes the inspector before it leaves the editor.
    el.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.defaultPrevented || insp.hidden) return;
      if (document.querySelector('.card-sheet:not([hidden])')) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    });

    // ------------------------------------------------------------ selecting

    function paintSelected() {
      for (const r of records) {
        const on = r.sel === selected;
        r.cell.classList.toggle('selected', on);
        r.btn.setAttribute('aria-expanded', String(on && !insp.hidden));
      }
    }

    function choose(sel, { focus = false } = {}) {
      if (selected !== sel) v.insp = 0;
      v.auto = false; // the inspector opening beside it mustn't re-zoom the map under you
      selected = sel;
      o.select?.(sel);
      showInspector();
      const rec = records.find(r => r.sel === sel);
      if (rec) requestAnimationFrame(() => ensureVisible(rec.cell));
      if (focus && !insp.hidden) focusInspector();
    }

    // Its first field, else its first button (past its own header), else Close.
    function focusInspector() {
      const head = inspBody.querySelector('.wfc-insp-head');
      const all = [...inspBody.querySelectorAll('input, textarea, select, button, summary')].filter(x => !x.disabled && x.offsetParent !== null);
      const target = all.find(x => /^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName)) || all.find(x => !head?.contains(x)) || all[0];
      target?.focus();
    }

    function showInspector() {
      inspBody.replaceChildren();
      const ok = !!selected && o.inspect(inspBody, selected, close) !== false;
      insp.hidden = !ok;
      el.classList.toggle('inspecting', ok);
      paintSelected();
    }
    inspBody.addEventListener('scroll', () => { v.insp = inspBody.scrollTop; views.set(o.id, { ...v }); });

    function close() {
      const was = selected;
      const rec = records.find(r => r.sel === was);
      selected = null;
      v.insp = 0;
      o.select?.(null, was);
      showInspector();
      // A node goes back to its node; anything else (Settings) is for the owner to refocus.
      if (rec) rec.btn.focus({ preventScroll: true }); else o.closed?.(was);
    }

    // ------------------------------------------------------------ dragging a step onto a +

    function armDrag(e, rec) {
      if (e.button !== 0) return;
      const btn = e.currentTarget;
      const sx = e.clientX;
      const sy = e.clientY;
      let drag = null;
      btn.setPointerCapture(e.pointerId);
      const move = ev => {
        if (!drag) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START) return;
          drag = beginDrag(rec);
        }
        dragMove(drag, ev);
      };
      // Lost capture without a pointerup: the node was redrawn away mid-drag. Never leave a drag behind.
      const end = ev => {
        btn.removeEventListener('pointermove', move);
        btn.removeEventListener('pointerup', end);
        btn.removeEventListener('pointercancel', end);
        btn.removeEventListener('lostpointercapture', end);
        if (!drag) return;
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 0);
        finishDrag(drag, ev.type === 'pointerup');
      };
      btn.addEventListener('pointermove', move);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointercancel', end);
      btn.addEventListener('lostpointercapture', end);
    }

    function beginDrag(rec) {
      const { list, index } = rec.place;
      // A + right beside the step would leave it where it is.
      const targets = gaps.filter(g => !(g.list === list && (g.index === index || g.index === index + 1)) && G.canDrop(o.steps, rec.step, g.list, o.maxDepth));
      for (const g of targets) g.el.classList.add('drop-ok');
      el.classList.add('dragging');
      rec.cell.classList.add('drag-src');
      const ghost = h('div', { class: 'wfc-ghost-node', 'aria-hidden': 'true' }, rec.btn.querySelector('.wfc-icon').cloneNode(true), h('span', { text: rec.btn.querySelector('.wfc-title').textContent }));
      document.body.append(ghost);
      const drag = { rec, targets, ghost, hot: null, done: false };
      drag.onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishDrag(drag, false); } };
      document.addEventListener('keydown', drag.onKey, true);
      return drag;
    }

    function dragMove(drag, ev) {
      if (drag.done) return;
      if (!drag.rec.btn.isConnected) { finishDrag(drag, false); return; }
      drag.ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
      const s = stage.getBoundingClientRect();
      const ex = ev.clientX < s.left + EDGE_PAN ? 1 : ev.clientX > s.right - EDGE_PAN ? -1 : 0;
      const ey = ev.clientY < s.top + EDGE_PAN ? 1 : ev.clientY > s.top + visibleHeight() - EDGE_PAN ? -1 : 0;
      if (ex || ey) { v.x += ex * EDGE_SPEED; v.y += ey * EDGE_SPEED; apply(); }
      let best = null;
      let bestD = DROP_REACH;
      for (const g of drag.targets) {
        const r = g.el.getBoundingClientRect();
        const d = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2));
        if (d < bestD) { best = g; bestD = d; }
      }
      if (best === drag.hot) return;
      drag.hot?.el.classList.remove('drop-hot');
      drag.hot = best;
      best?.el.classList.add('drop-hot');
    }

    function finishDrag(drag, commit) {
      if (drag.done) return;
      drag.done = true;
      document.removeEventListener('keydown', drag.onKey, true);
      drag.ghost.remove();
      el.classList.remove('dragging');
      drag.rec.cell.classList.remove('drag-src');
      for (const g of gaps) g.el.classList.remove('drop-ok', 'drop-hot');
      if (commit && drag.hot) o.move(drag.rec.step, drag.hot.list, drag.hot.index);
    }

    // ------------------------------------------------------------ keeping up

    let lastW = 0;
    const ro = new ResizeObserver(() => {
      if (!el.isConnected) { ro.disconnect(); return; }
      const w = stage.clientWidth;
      if (!v.placed || (v.auto && w !== lastW)) place();
      else if (lastW && w !== lastW) { v.x += (w - lastW) / 2; apply(); } // keep the middle in the middle
      lastW = w;
      draw();
    });
    ro.observe(stage);
    ro.observe(flow);
    apply();
    showInspector();
    requestAnimationFrame(() => { inspBody.scrollTop = v.insp || 0; });

    return {
      el,
      // Node text changed (a field was typed in): repaint the nodes and their wires.
      update() {
        for (const r of records) {
          if (r.step) r.refresh({ ...o.step(r.step, r.place), kind: 'step' });
          else if (r.get) r.refresh(r.get());
        }
        paintSelected();
        requestAnimationFrame(draw);
      },
      select: (sel, opts) => choose(sel, opts),
      focus(sel) { const rec = records.find(r => r.sel === sel); rec?.btn.focus({ preventScroll: true }); return !!rec; },
      reveal(sel) { const rec = records.find(r => r.sel === sel); if (rec) ensureVisible(rec.cell); },
    };
  }

  SB.wfCanvas = { mount, forget: id => views.delete(id) };
})();
