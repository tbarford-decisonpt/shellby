/* Shellby panel — bug battles. While a bug is on the loose, Claude's work on
   it plays out as a tussle on the seabed: the bug and Shellby face to face on
   the sand, the text box typing out each move, the HP bar draining as failing
   tests clear, and the jar lowered on its line when the fix is proven (src/main/bugdex/
   battle.js decides all of it; this only draws). A chip under the tabs shows
   the fight in the conversation where it's happening; the Bugdex's "on the
   loose" rows open it too. Nothing here is ever put in as HTML. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const HEX = /^#[0-9a-f]{6}$/i;
  const MINUTE = 60000;
  const RECENT_MS = 60 * 1000;   // opening a battle replays a move this fresh
  const CHAR_MS = 18;            // the text box's typing speed
  const LINE_HOLD_MS = 650;
  const MAX_LOG = 40;
  const MOVE_COLOR = {
    scout: '#8ecae6', patch: '#ffd166', tests: '#90be6d', typecheck: '#9d8cff', lint: '#f9c74f', build: '#ff9f1c',
    install: '#cdb4db', git: '#f3722c', run: '#4cc9f0', remedy: '#b8ffd9', assist: '#ff8fab',
  };
  const RANK = { boss: 'BOSS', elite: 'DEEP FOUR', champion: 'CHAMPION' };
  // The specimen jar lowered for it: glass, a cork, a glint (the Bugdex's own jar is per bug; this one is empty).
  const JAR = { palette: { j: '#bfe9ff', c: '#b07a4a', h: '#ffffff', g: '#7fb8d6' }, pixels: ['..cccc..', '..cccc..', '.j....j.', 'jh.....j', 'jh.....j', 'j......j', 'j......j', 'jg....gj', '.jjjjjj.'] };
  const LENS = { palette: { r: '#d9c8a0', g: '#bfe9ff', w: '#ffffff', k: '#5c4a32' }, pixels: ['.rrr...', 'rgwgr..', 'rggggr.', 'rggggr.', '.rrrr..', '....kk.', '.....kk'] };

  let battles = [];
  let scene = null;   // the open battle screen: { id, el, parts, shown, queue, playing, last }
  let chipFor = null; // the battle the chip is showing
  let chipSeq = 0;

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = ms => new Promise(r => setTimeout(r, reduced() ? Math.min(ms, 120) : ms));
  const cue = (name, opts) => { if (scene && !document.hidden) api.bugdexCue(name, opts); };
  const sprite = (b, px) => SB.Sprite.grid(b.pixels, b.palette, { px });
  const fitPx = (pixels, box) => Math.max(2, Math.floor(box / Math.max(pixels.length, ...pixels.map(r => r.length))));
  const live = b => b && !b.over;
  const hpShare = (b, hp = b.hp) => (b.max ? Math.max(0, Math.min(1, hp / b.max)) : 0);
  const hpTone = share => (share > 0.5 ? 'high' : share > 0.2 ? 'mid' : 'low');

  // ------------------------------------------------------------ data in
  function apply(list) {
    battles = Array.isArray(list) ? list.filter(b => b && typeof b.id === 'string' && Array.isArray(b.moves)) : [];
    renderChip();
    SB.renderLooseBattles?.();
    if (scene) feed();
  }
  SB.bugBattles = () => battles;
  SB.battleOf = id => battles.find(b => b.id === id) || null;

  // ------------------------------------------------------------ the chip under the tabs
  // The fight in this conversation: a tiny bug, its HP, and "!" when it's new.
  function chip() {
    let el = $('battleChip');
    if (el) return el;
    el = h('button', { type: 'button', class: 'bb-chip', id: 'battleChip', hidden: true, onclick: () => chipFor && openBattle(chipFor) });
    $('subbar').insertBefore(el, $('ctxChip'));
    return el;
  }

  function renderChip() {
    const el = chip();
    const mine = battles.filter(b => b.tabId && b.tabId === state.activeTab && (live(b) || Date.now() - (b.moves.at(-1)?.at || 0) < 20000));
    const b = mine[0];
    if (!b || state.settings?.bugBattles === false) { el.hidden = true; chipFor = null; return; }
    const isNew = chipFor !== b.id;
    const hit = !isNew && b.seq > chipSeq;
    chipFor = b.id;
    chipSeq = b.seq;
    const share = hpShare(b);
    el.hidden = false;
    el.className = `bb-chip rank-${b.league || (b.boss ? 'boss' : 'plain')}${b.over ? ` over-${b.over}` : ''}`;
    el.setAttribute('aria-label', b.over === 'caught' ? `${b.name} caught. Watch the battle.` : `${b.name} on the loose, ${Math.round(share * 100)}% HP. Watch the battle.`);
    el.title = 'Watch the bug battle';
    el.replaceChildren(...[
      h('span', { class: 'bb-chip-art', 'aria-hidden': 'true' }, sprite(b.chip || b, fitPx((b.chip || b).pixels, 16))),
      b.over === 'caught' ? h('span', { class: 'bb-chip-name', text: '✓' }) : null,
      h('span', { class: `bb-chip-hp ${hpTone(share)}`, 'aria-hidden': 'true' }, h('i', { style: `width:${Math.round(share * 100)}%` })),
      isNew && live(b) ? h('span', { class: 'bb-chip-alert', 'aria-hidden': 'true', text: '!' }) : null,
    ].filter(Boolean));
    if (hit && !reduced()) el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }], { duration: 240 });
  }
  SB.renderBattleChip = renderChip;

  // ------------------------------------------------------------ the screen
  function openBattle(id) {
    const b = SB.battleOf(id);
    if (!b) return;
    if (scene) close({ quiet: true });
    const back = document.activeElement;
    const parts = build(b);
    document.body.append(parts.overlay);
    // Not ready until the intro has played: moves that come in meanwhile wait for it.
    scene = { id, b, parts, shown: 0, queue: [], playing: false, ready: false, back, hp: b.max, log: [] };
    parts.close.focus({ preventScroll: true });
    intro(b);
  }
  SB.openBattle = openBattle;

  function close({ quiet = false } = {}) {
    if (!scene) return;
    const { parts, back } = scene;
    scene = null;
    if (quiet || reduced()) parts.overlay.remove();
    else parts.overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).finished.then(() => parts.overlay.remove(), () => parts.overlay.remove());
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  function build(b) {
    const name = h('b', { class: 'bb-name', text: b.name.toUpperCase() });
    const hpFill = h('i', { class: `bb-hp-fill ${hpTone(1)}` });
    const hpBar = h('span', { class: 'bb-hp', role: 'meter', 'aria-label': `${b.name}'s HP`, 'aria-valuemin': '0', 'aria-valuemax': String(b.max), 'aria-valuenow': String(b.max) },
      h('span', { class: 'bb-hp-label', text: 'HP' }), h('span', { class: 'bb-hp-track' }, hpFill));
    const rank = b.league || (b.boss ? 'boss' : null);
    const foeHud = h('div', { class: 'bb-hud foe' },
      rank ? h('span', { class: `bb-rank ${rank}`, text: RANK[rank] }) : null,
      h('div', { class: 'bb-hud-row' }, name, h('span', { class: 'bb-lv', text: `Lv${b.level}` })),
      h('div', { class: 'bb-hud-row' },
        h('span', { class: 'bb-type', style: HEX.test(b.typeColor) ? `--type:${b.typeColor}` : null, text: b.typeLabel || '' }),
        h('span', { class: 'bb-no', text: `#${String(b.no).padStart(3, '0')}` })),
      hpBar);
    const party = h('div', { class: 'bb-party', 'aria-label': 'Claude’s crew in this battle' });
    const meHud = h('div', { class: 'bb-hud me' },
      h('div', { class: 'bb-hud-row' }, h('b', { class: 'bb-name', text: 'SHELLBY' }), h('span', { class: 'bb-lv', text: state.xp ? `Lv${state.xp.level}` : '' })),
      h('div', { class: 'bb-hud-row' }, party, h('span', { class: 'bb-trainer', text: 'w/ CLAUDE' })));
    const foeArt = h('div', { class: 'bb-foe-art' }, sprite(b, fitPx(b.pixels, 64)));
    const foe = h('div', { class: 'bb-foe' }, h('span', { class: 'bb-shadow' }), foeArt);
    const crab = SB.sprite(state.skin, {});
    crab.classList.add('bb-crab');
    const me = h('div', { class: 'bb-me' }, h('span', { class: 'bb-shadow' }), h('div', { class: 'bb-me-art' }, crab));
    const decor = h('div', { class: 'bb-decor', 'aria-hidden': 'true' }, Array.from({ length: 7 }, (_, i) => h('i', { style: `--i:${i}` })));
    const bubbles = h('div', { class: 'bb-bubbles', 'aria-hidden': 'true' }, Array.from({ length: 9 }, (_, i) => h('i', { style: `--i:${i};--x:${(i * 37) % 100}%;--s:${3 + (i * 5) % 5}px` })));
    const fx = h('div', { class: 'bb-fx', 'aria-hidden': 'true' });
    const text = h('p', { class: 'bb-text-line' });
    const caret = h('span', { class: 'bb-caret', 'aria-hidden': 'true', text: '▼' });
    const textBox = h('div', { class: 'bb-text' }, text, caret);
    const blinds = h('div', { class: 'bb-blinds', 'aria-hidden': 'true' }, Array.from({ length: 8 }, (_, i) => h('i', { style: `--i:${i}` })));
    const screen = h('div', { class: `bb-screen hab-${b.habitat}${rank ? ` rank-${rank}` : ''}` },
      h('div', { class: 'bb-water', 'aria-hidden': 'true' }), h('div', { class: 'bb-caustics', 'aria-hidden': 'true' }), decor, bubbles,
      h('div', { class: 'bb-pad foe-pad', 'aria-hidden': 'true' }), h('div', { class: 'bb-pad me-pad', 'aria-hidden': 'true' }),
      foe, me, foeHud, meHud, fx, textBox, blinds, h('div', { class: 'bb-scan', 'aria-hidden': 'true' }));
    const log = h('ol', { class: 'bb-log', 'aria-live': 'polite', 'aria-label': 'Battle log' });
    const where = [b.habitatIcon && b.habitatName ? `${b.habitatIcon} ${b.habitatName}` : null, b.project ? `in ${b.project}` : null].filter(Boolean).join(' · ');
    const closeBtn = h('button', { type: 'button', class: 'icon-btn bb-close', 'aria-label': 'Close the battle', onclick: () => close() }, '×');
    const skip = h('button', { type: 'button', class: 'btn ghost slim-btn bb-skip', onclick: () => skipAhead() }, 'Skip ▸▸');
    const tabBtn = b.tabId ? h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => { close(); SB.activate?.(b.tabId); } }, 'Open the conversation') : null;
    const frame = h('div', { class: 'bb-frame' },
      h('header', { class: 'bb-head' }, h('span', { class: 'bb-title', id: 'bbTitle', text: 'BUG BATTLE' }), h('span', { class: 'bb-where', text: where }), closeBtn),
      screen,
      h('footer', { class: 'bb-foot' }, skip, tabBtn),
      h('details', { class: 'bb-log-box' }, h('summary', { text: 'Battle log' }), log));
    const overlay = h('div', { class: 'bb-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bbTitle' }, frame);
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab') trap(e, frame);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    return { overlay, screen, foe, foeArt, me, crab, foeHud, meHud, hpFill, hpBar, party, fx, text, caret, textBox, blinds, log, close: closeBtn, skip };
  }

  function trap(e, root) {
    const f = [...root.querySelectorAll('button, summary, [tabindex="0"]')].filter(x => !x.disabled && x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }

  // ------------------------------------------------------------ playing it out
  async function intro(b) {
    const s = scene;
    const { parts } = s;
    renderParty(b);
    const rank = b.league || (b.boss ? 'boss' : null);
    cue(rank ? 'boss' : 'battle');
    if (!reduced()) {
      parts.screen.classList.add('entering');
      // The tide comes in over the screen, and goes out on the fight.
      const wave = i => Math.abs(i - 3.5) * 45;
      await Promise.all([...parts.blinds.children].map((bar, i) => bar.animate(
        [{ transform: 'translateY(101%)' }, { transform: 'translateY(0)', offset: 0.45 }, { transform: 'translateY(0)', offset: 0.55 }, { transform: 'translateY(-101%)' }],
        { duration: 1000, delay: wave(i), easing: 'cubic-bezier(.4,0,.6,1)', fill: 'both' }).finished));
      parts.screen.classList.remove('entering');
      parts.foe.animate([{ transform: 'translateX(140%)', filter: 'brightness(0)' }, { transform: 'translateX(0)', filter: 'brightness(0)', offset: 0.7 }, { transform: 'translateX(0)', filter: 'brightness(1)' }], { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)' });
      parts.me.animate([{ transform: 'translateX(-140%)' }, { transform: 'translateX(0)' }], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
      parts.foeHud.animate([{ transform: 'translateY(-160%)' }, { transform: 'translateY(0)' }], { duration: 500, delay: 500, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
      parts.meHud.animate([{ transform: 'translateY(-160%)' }, { transform: 'translateY(0)' }], { duration: 500, delay: 600, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
      await wait(700);
      if (rank) await warning(rank);
    }
    cue('cry', { species: b.species });
    if (!reduced()) parts.foeArt.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12, .9)' }, { transform: 'scale(.95, 1.08)' }, { transform: 'scale(1)' }], { duration: 420 });
    await say(b.moves[0]?.line || `A wild ${b.name} appeared!`);
    if (scene !== s) return;
    // Opening one already under way: catch up quietly, and replay what just happened.
    const now = SB.battleOf(s.id) || b; // it may have moved on during the intro
    s.b = now;
    const tail = now.moves.slice(1);
    const replay = tail.filter((m, i) => (now.over ? i >= tail.length - 2 : Date.now() - m.at < RECENT_MS && i === tail.length - 1));
    const before = replay.length ? now.moves[now.moves.indexOf(replay[0]) - 1] : now.moves.at(-1);
    for (const m of tail) if (!replay.includes(m)) note(m.line);
    if (tail.length > replay.length) {
      setHp(before?.hp ?? now.hp, { instant: true });
      const mins = Math.round((Date.now() - now.startedAt) / MINUTE);
      if (mins >= 1 && !now.over) await say(`The battle has gone on for ${mins} min.`, { log: false });
    }
    s.shown = (replay[0]?.seq ?? now.seq + 1) - 1;
    s.ready = true;
    feed();
  }

  async function warning(rank) {
    const { parts } = scene;
    const stripe = h('div', { class: `bb-warning ${rank}` }, h('span', { text: rank === 'champion' ? '★ CHAMPION ★' : rank === 'elite' ? 'THE DEEP FOUR' : '!! HABITAT BOSS !!' }));
    parts.fx.append(stripe);
    shake(6, 500);
    await stripe.animate([{ transform: 'scaleY(0)', opacity: 0 }, { transform: 'scaleY(1)', opacity: 1, offset: 0.15 }, { transform: 'scaleY(1)', opacity: 1, offset: 0.85 }, { transform: 'scaleY(0)', opacity: 0 }], { duration: 1400 }).finished.catch(() => {});
    stripe.remove();
  }

  /** New moves from main go on the queue; the queue plays one at a time. */
  function feed() {
    if (!scene?.ready) return;
    const b = SB.battleOf(scene.id);
    if (!b) return;
    scene.b = b;
    for (const m of b.moves) if (m.seq > scene.shown) { scene.queue.push(m); scene.shown = m.seq; }
    renderParty(b);
    if (!scene.playing) run();
  }

  async function run() {
    const s = scene;
    s.playing = true;
    while (scene === s && s.queue.length) {
      const m = s.queue.shift();
      try { await play(m, s.b); } catch { /* a closed screen mid-move */ }
    }
    if (scene === s) s.playing = false;
  }

  // Jump to now: no more animation for what's queued.
  function skipAhead() {
    if (!scene) return;
    const left = scene.queue.splice(0);
    for (const m of left) note(m.line);
    const last = left.at(-1);
    if (last) { setHp(last.hp, { instant: true }); scene.parts.text.textContent = last.line; }
    if (last?.fx === 'caught') showCaught(scene.b, last, { instant: true });
  }

  async function play(m, b) {
    const p = scene.parts;
    switch (m.fx) {
      case 'appear': return;
      case 'ko': {
        await say(m.line, { before: () => faint() });
        return;
      }
      case 'caught': return catchIt(b, m);
      case 'fled': {
        cue('fled');
        if (!reduced()) {
          dust(p.foe);
          await p.foe.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6%)', offset: 0.2 }, { transform: 'translateX(160%)' }], { duration: 700, easing: 'ease-in', fill: 'forwards' }).finished;
        }
        await say(m.line);
        return;
      }
      default: break;
    }
    // Announce it first ("Claude used Test Run!"), then the attack, then how it landed.
    const cut = m.line.indexOf('!') + 1;
    const head = cut > 0 && cut < m.line.length ? m.line.slice(0, cut) : m.line;
    await say(head, { log: false, hold: 200 });
    const by = m.move === 'assist' ? await helperIn(m.by) : null;
    const attacker = by || p.me;
    // The attack itself
    if (m.move === 'scout') await scout();
    else if (m.move === 'patch' && m.fx !== 'resist') await slash(attacker);
    else if (m.fx !== 'resist') await beam(attacker, MOVE_COLOR[m.move] || '#ffffff', m.fx === 'crit' ? 18 : m.fx === 'super' ? 14 : 9);
    // ...and how it landed
    if (m.fx === 'resist') await resist();
    else if (m.fx === 'miss') await dodge(m.move === 'scout');
    else if (m.fx === 'heal') await heal();
    else await impact(m);
    setHp(m.hp);
    if (by) helperOut(by);
    await say(m.line, { from: head.length });
  }

  /** Type a line into the box; `from`: carry on from that many characters already shown. */
  async function say(line, { before = null, log = true, from = 0, hold = LINE_HOLD_MS } = {}) {
    const s = scene;
    if (!s) return;
    if (before) await before();
    if (log) note(line);
    const p = s.parts;
    p.caret.hidden = true;
    if (reduced()) p.text.textContent = line;
    else {
      p.text.textContent = line.slice(0, from);
      for (let i = from + 1; i <= line.length && scene === s; i++) {
        p.text.textContent = line.slice(0, i);
        if (line[i - 1] !== ' ') await new Promise(r => setTimeout(r, CHAR_MS));
      }
    }
    p.caret.hidden = false;
    await wait(hold);
  }

  function note(line) {
    if (!scene || !line) return;
    const log = scene.parts.log;
    log.append(h('li', { text: line }));
    while (log.children.length > MAX_LOG) log.firstChild.remove();
  }

  // ------------------------------------------------------------ HP
  function setHp(hp, { instant = false } = {}) {
    if (!scene) return;
    const b = scene.b;
    const share = hpShare(b, hp);
    const p = scene.parts;
    const from = p.hpFill.style.width || '100%';
    const to = `${(share * 100).toFixed(1)}%`;
    p.hpFill.className = `bb-hp-fill ${hpTone(share)}`;
    p.hpBar.setAttribute('aria-valuenow', String(Math.max(0, Math.round(hp))));
    p.hpFill.style.width = to;
    if (!instant && !reduced() && from !== to) {
      const ms = Math.min(1200, 300 + Math.abs(parseFloat(from) - parseFloat(to)) * 18);
      p.hpFill.animate([{ width: from }, { width: to }], { duration: ms, easing: 'steps(24, end)' });
    }
    p.foe.classList.toggle('low', share > 0 && share <= 0.2);
    scene.hp = hp;
  }

  // ------------------------------------------------------------ effects
  // Where something is, in the screen's own coordinates.
  function centre(el) {
    const s = scene.parts.screen.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2, w: r.width, h: r.height };
  }

  function bit(cls, x, y, style = '') {
    const el = h('i', { class: `bb-bit ${cls}`, style: `left:${x}px;top:${y}px;${style}` });
    scene.parts.fx.append(el);
    return el;
  }

  const gone = a => a.finished.then(() => a.effect.target.remove(), () => a.effect.target?.remove());

  function shake(px, ms) {
    if (reduced() || !scene) return;
    const k = Array.from({ length: 8 }, (_, i) => ({ transform: `translate(${(i % 2 ? -1 : 1) * px * (1 - i / 8)}px, ${(i % 3 - 1) * px * 0.4}px)` }));
    scene.parts.screen.animate([...k, { transform: 'translate(0,0)' }], { duration: ms });
  }

  function flash(color = '#ffffff', ms = 220) {
    if (reduced() || !scene) return;
    const f = h('i', { class: 'bb-flash', style: `background:${color}` });
    scene.parts.fx.append(f);
    gone(f.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: ms }));
  }

  function floater(text, cls, at) {
    if (!scene) return;
    const el = bit(`bb-float ${cls}`, at.x, at.y - at.h * 0.4);
    el.textContent = text;
    if (reduced()) { setTimeout(() => el.remove(), 700); return; }
    gone(el.animate([{ transform: 'translate(-50%, 0) scale(.6)', opacity: 0 }, { transform: 'translate(-50%, -14px) scale(1.15)', opacity: 1, offset: 0.25 }, { transform: 'translate(-50%, -26px) scale(1)', opacity: 0 }], { duration: 900, easing: 'ease-out' }));
  }

  function burst(at, color, n = 10, spread = 40) {
    if (reduced() || !scene) return;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const d = spread * (0.6 + Math.random() * 0.6);
      const el = bit('bb-spark', at.x, at.y, `background:${color}`);
      gone(el.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(.3)`, opacity: 0 }], { duration: 500 + Math.random() * 300, easing: 'cubic-bezier(.2,.8,.2,1)' }));
    }
  }

  async function blink(el, times = 3) {
    if (reduced()) return;
    await el.animate(Array.from({ length: times * 2 + 1 }, (_, i) => ({ opacity: i % 2 ? 0.1 : 1 })), { duration: times * 140, easing: 'steps(1, end)' }).finished.catch(() => {});
  }

  async function lunge(el, dir = 1) {
    if (reduced()) return;
    await el.animate([{ transform: 'translate(0,0)' }, { transform: `translate(${-6 * dir}px, 2px)`, offset: 0.3 }, { transform: `translate(${22 * dir}px, -10px)`, offset: 0.6 }, { transform: 'translate(0,0)' }], { duration: 420, easing: 'cubic-bezier(.3,.7,.3,1)' }).finished.catch(() => {});
  }

  async function slash(attacker) {
    const p = scene.parts;
    const claw = attacker === p.me ? p.crab.querySelector('.part-claw') : null;
    if (claw && !reduced()) claw.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-18deg)' }, { transform: 'rotate(8deg)' }, { transform: 'rotate(0)' }], { duration: 420, transformOrigin: 'center' });
    const go = lunge(attacker);
    await wait(220);
    const at = centre(p.foeArt);
    if (!reduced()) {
      for (let i = 0; i < 3; i++) {
        const el = bit('bb-slash', at.x + (i - 1) * 10, at.y + (i - 1) * 6);
        gone(el.animate([{ transform: 'translate(-50%,-50%) rotate(-35deg) scaleX(0)', opacity: 1 }, { transform: 'translate(-50%,-50%) rotate(-35deg) scaleX(1)', opacity: 1, offset: 0.5 }, { transform: 'translate(-50%,-50%) rotate(-35deg) scaleX(1)', opacity: 0 }], { duration: 300, delay: i * 70 }));
      }
    }
    await go;
  }

  async function scout() {
    const p = scene.parts;
    const at = centre(p.foeArt);
    if (reduced()) return;
    const lens = bit('bb-lens', at.x, at.y);
    lens.append(SB.Sprite.grid(LENS.pixels, LENS.palette, { px: 3 }));
    await lens.animate([
      { transform: 'translate(-90%, -40%) rotate(-10deg)', opacity: 0 },
      { transform: 'translate(-90%, -40%) rotate(-10deg)', opacity: 1, offset: 0.15 },
      { transform: 'translate(-10%, -70%) rotate(8deg)', offset: 0.45 },
      { transform: 'translate(-60%, -10%) rotate(-4deg)', offset: 0.75 },
      { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 0 },
    ], { duration: 900, easing: 'ease-in-out' }).finished.catch(() => {});
    lens.remove();
    const q = bit('bb-float scout', at.x, at.y - at.h * 0.6);
    q.textContent = '?';
    gone(q.animate([{ transform: 'translate(-50%,0) scale(.4)', opacity: 0 }, { transform: 'translate(-50%,-8px) scale(1.2)', opacity: 1, offset: 0.4 }, { transform: 'translate(-50%,-12px) scale(1)', opacity: 0 }], { duration: 700 }));
  }

  async function beam(attacker, color, n) {
    const p = scene.parts;
    const go = lunge(attacker === p.me ? p.me.querySelector('.bb-me-art') : attacker, 0.5);
    if (reduced()) { await go; return; }
    const from = centre(attacker === p.me ? p.crab : attacker);
    const to = centre(p.foeArt);
    const runs = [];
    for (let i = 0; i < n; i++) {
      const el = bit('bb-shot', from.x, from.y - 6, `background:${color};box-shadow:0 0 6px ${color}`);
      const wob = (i % 2 ? 1 : -1) * (6 + (i * 7) % 12);
      runs.push(gone(el.animate([
        { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
        { transform: `translate(calc(-50% + ${(to.x - from.x) * 0.5}px), calc(-50% + ${(to.y - from.y) * 0.5 + wob}px)) scale(1)`, opacity: 1, offset: 0.5 },
        { transform: `translate(calc(-50% + ${to.x - from.x}px), calc(-50% + ${to.y - from.y + 6}px)) scale(.8)`, opacity: 0.9 },
      ], { duration: 420, delay: i * 30, easing: 'cubic-bezier(.4,.1,.6,1)' })));
    }
    await Promise.all([go, ...runs]);
  }

  async function impact(m) {
    const p = scene.parts;
    const at = centre(p.foeArt);
    const big = m.fx === 'crit' || m.fx === 'super';
    cue(m.fx === 'crit' ? 'smash' : m.fx === 'super' ? 'super' : 'hit');
    if (m.fx === 'crit') { flash('#ffffff', 320); shake(9, 520); burst(at, '#ffd23f', 18, 60); }
    else if (m.fx === 'super') { flash('#fff4d6', 200); shake(5, 380); burst(at, '#ffd166', 12, 46); }
    else burst(at, '#ffffff', 7, 28);
    if (m.dmg > 0) floater(`-${m.dmg}`, big ? 'dmg big' : 'dmg', at);
    await blink(p.foeArt, big ? 4 : 2);
  }

  async function dodge(scouting) {
    const p = scene.parts;
    cue('miss');
    if (scouting) return;
    const at = centre(p.foeArt);
    floater('MISS', 'miss', at);
    if (reduced()) return;
    await p.foeArt.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(18px) translateY(-4px)', offset: 0.35 }, { transform: 'translateX(18px)', offset: 0.6 }, { transform: 'translateX(0)' }], { duration: 480, easing: 'ease-out' }).finished.catch(() => {});
  }

  async function heal() {
    const p = scene.parts;
    cue('heal');
    const at = centre(p.foeArt);
    floater('+HP', 'heal', at);
    if (reduced()) return;
    for (let i = 0; i < 10; i++) {
      const el = bit('bb-spark heal', at.x + (i - 5) * 6, at.y + at.h * 0.3);
      gone(el.animate([{ transform: 'translate(-50%,0)', opacity: 0 }, { transform: 'translate(-50%,-10px)', opacity: 1, offset: 0.3 }, { transform: 'translate(-50%,-36px)', opacity: 0 }], { duration: 800, delay: i * 50 }));
    }
    await p.foeArt.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.6) drop-shadow(0 0 6px #80ed99)' }, { filter: 'brightness(1)' }], { duration: 700 }).finished.catch(() => {});
  }

  async function resist() {
    const p = scene.parts;
    cue('resist');
    const at = centre(p.foeArt);
    floater('RESIST', 'resist', at);
    if (reduced()) return;
    const shield = bit('bb-shield', at.x, at.y, `width:${at.w * 1.5}px;height:${at.h * 1.5}px`);
    await gone(shield.animate([{ transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 }, { transform: 'translate(-50%,-50%) scale(1.05)', opacity: 1, offset: 0.3 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%,-50%) scale(1.2)', opacity: 0 }], { duration: 800 }));
  }

  async function faint() {
    const p = scene.parts;
    setHp(0);
    cue('faint');
    if (reduced()) { p.foeArt.style.transform = 'rotate(180deg)'; return; }
    await blink(p.foeArt, 3);
    // Belly-up, the way a knocked-out fish floats.
    p.foeArt.style.animation = 'none';
    await p.foeArt.animate([{ transform: 'rotate(0)', filter: 'saturate(1)' }, { transform: 'rotate(180deg)', filter: 'saturate(.4)' }], { duration: 520, easing: 'cubic-bezier(.3,1.4,.5,1)', fill: 'forwards' }).finished.catch(() => {});
  }

  // Pixel confetti for a badge or the Hall of Fame.
  function confetti(n) {
    if (reduced() || !scene) return;
    const w = scene.parts.screen.clientWidth;
    const colours = ['#ffd23f', '#ff7a5c', '#7fd6c2', '#9d8cff', '#ffffff', '#80ed99'];
    for (let i = 0; i < n; i++) {
      const el = bit('bb-confetti', Math.random() * w, -8, `background:${colours[i % colours.length]}`);
      const drift = (Math.random() - 0.5) * 80;
      gone(el.animate([{ transform: 'translate(0,0) rotate(0)' }, { transform: `translate(${drift}px, ${260 + Math.random() * 80}px) rotate(${360 + Math.random() * 360}deg)` }], { duration: 1600 + Math.random() * 1200, delay: Math.random() * 500, easing: 'cubic-bezier(.3,.1,.7,1)' }));
    }
  }

  function dust(el) {
    if (reduced()) return;
    const at = centre(el);
    for (let i = 0; i < 6; i++) {
      const d = bit('bb-dust', at.x - i * 8, at.y + at.h * 0.35);
      gone(d.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 0.9 }, { transform: `translate(calc(-50% - ${10 + i * 4}px), calc(-50% - 8px)) scale(1.3)`, opacity: 0 }], { duration: 600, delay: i * 50 }));
    }
  }

  // A crew member hops in from the edge to help, then hops back out.
  async function helperIn(by) {
    const p = scene.parts;
    if (!by) return null;
    const svg = SB.sprite(state.skin, {});
    svg.style.filter = `hue-rotate(${Number(by.hue) || 0}deg) saturate(1.1)`;
    const el = h('div', { class: 'bb-helper' }, svg, h('span', { class: 'bb-helper-tag', text: `${by.name} · Lv${by.level || 1}` }));
    p.screen.insertBefore(el, p.foeHud);
    if (!reduced()) await el.animate([{ transform: 'translate(-160%, 30%)' }, { transform: 'translate(-30%, -40%)', offset: 0.5 }, { transform: 'translate(0, 0)' }], { duration: 520, easing: 'cubic-bezier(.3,.7,.3,1)' }).finished.catch(() => {});
    return el;
  }

  function helperOut(el) {
    if (reduced()) { el.remove(); return; }
    gone(el.animate([{ transform: 'translate(0,0)', opacity: 1 }, { transform: 'translate(-20%, -50%)', opacity: 1, offset: 0.4 }, { transform: 'translate(-180%, 20%)', opacity: 0 }], { duration: 600, delay: 400, easing: 'ease-in', fill: 'forwards' }));
  }

  function renderParty(b) {
    if (!scene) return;
    const slots = Array.from({ length: 6 }, (_, i) => b.party[i] || null);
    scene.parts.party.replaceChildren(...slots.map(m => {
      if (!m) return h('span', { class: 'bb-slot empty', 'aria-hidden': 'true' });
      const svg = SB.sprite(state.skin, {});
      svg.style.filter = `hue-rotate(${Number(m.hue) || 0}deg) saturate(1.1)`;
      return h('span', { class: 'bb-slot', title: `${m.name} (${m.type}), level ${m.level || 1}` }, svg);
    }));
  }

  // ------------------------------------------------------------ the catch
  // Out cold, it's collected the Shellby way: a specimen jar lowered on a line,
  // it drifts up into it, the cork goes on, and the jar comes to rest on the rock.
  async function catchIt(b, m) {
    const p = scene.parts;
    const jar = h('div', { class: 'bb-jar' }, SB.Sprite.grid(JAR.pixels, JAR.palette, { px: 4 }));
    // Where it stood (its own box: the art itself is floating belly-up).
    const stood = centre(p.foe);
    const rest = { x: stood.x, y: stood.y + stood.h * 0.32 };
    const hang = { x: stood.x, y: stood.y - stood.h * 0.25 };
    if (reduced()) {
      jar.style.cssText = `left:${rest.x}px;top:${rest.y}px`;
      p.foeArt.style.opacity = '0';
      p.fx.append(jar);
      await say(m.line);
      return showCaught(b, m);
    }
    // Down it comes on its line.
    cue('lower');
    const line = bit('bb-line', hang.x, 0, 'height:0');
    p.fx.append(jar);
    jar.style.cssText = `left:${hang.x}px;top:-30px`;
    await Promise.all([
      line.animate([{ height: '0px' }, { height: `${hang.y - 14}px` }], { duration: 700, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' }).finished,
      jar.animate([{ top: '-30px' }, { top: `${hang.y}px` }], { duration: 700, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' }).finished,
    ]).catch(() => {});
    // Up it drifts, small enough to fit.
    await p.foeArt.animate([
      { transform: 'rotate(180deg) translateY(0) scale(1)', opacity: 1 },
      { transform: `rotate(180deg) translateY(${stood.h * 0.45}px) scale(.25)`, opacity: 0 },
    ], { duration: 650, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
    p.foeArt.style.opacity = '0';
    cue('caught');
    jar.classList.add('sealed');
    const at = centre(jar);
    burst(at, '#bfe9ff', 10, 34);
    // ...and the line sets it down on the rock, then reels in.
    await Promise.all([
      jar.animate([{ top: `${hang.y}px` }, { top: `${rest.y}px` }], { duration: 520, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' }).finished,
      line.animate([{ height: `${hang.y - 14}px` }, { height: `${rest.y - 14}px` }], { duration: 520, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' }).finished,
    ]).catch(() => {});
    gone(line.animate([{ height: `${rest.y - 14}px` }, { height: '0px' }], { duration: 500, delay: 150, easing: 'ease-in', fill: 'forwards' }));
    for (let i = 0; i < 3; i++) {
      const star = bit('bb-star', rest.x + (i - 1) * 16, rest.y - 18);
      star.textContent = '✦';
      gone(star.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 0 }, { transform: 'translate(-50%,-120%) scale(1.2)', opacity: 1, offset: 0.4 }, { transform: 'translate(-50%,-180%) scale(.8)', opacity: 0 }], { duration: 1000, delay: i * 120 }));
    }
    await say(m.line);
    await showCaught(b, m);
  }

  // The Bugdex page entry, a badge or the Hall of Fame: a card over the screen.
  async function showCaught(b, m, { instant = false } = {}) {
    if (!scene) return;
    const p = scene.parts;
    p.fx.querySelector('.bb-reg')?.remove();
    const jar = m.jar || {};
    const forms = (jar.forms || []).map(f => ({ 'first-try': '🎯 First try', swift: '⚡ Swift', golden: '✦ Golden', nocturnal: '☾ Nocturnal', spectral: '👻 Spectral', shiny: '✨ Shiny' }[f])).filter(Boolean);
    const card = h('div', { class: `bb-reg${jar.badge ? ' badge' : ''}${jar.fame ? ' fame' : ''}` },
      h('p', { class: 'bb-reg-eyebrow', text: jar.fame ? 'HALL OF FAME' : jar.badge ? 'BADGE EARNED' : jar.isNew ? 'NEW BUGDEX ENTRY' : 'IN THE JAR' }),
      jar.badge && b.badge
        ? h('div', { class: 'bb-reg-badge' }, SB.Sprite.grid(b.badge.pixels, b.badge.palette, { px: 7 }))
        : h('div', { class: 'bb-reg-art' }, sprite(b, fitPx(b.pixels, 56))),
      h('p', { class: 'bb-reg-name', text: jar.badge && b.badge ? `The ${b.badge.name}` : `#${String(b.no).padStart(3, '0')} ${b.name}` }),
      h('p', { class: 'bb-reg-sub', text: jar.fame ? 'Every badge, the Deep Four and the champion.' : jar.badge ? `You beat the boss of ${b.habitatName}.` : b.blurb || '' }),
      forms.length ? h('p', { class: 'bb-reg-forms', text: forms.join('  ') }) : null,
      h('div', { class: 'bb-reg-actions' },
        h('button', { type: 'button', class: 'btn primary slim-btn', onclick: () => { close(); SB.focusBug?.(b.species); } }, 'See it in the Bugdex'),
        h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => close() }, 'Done')));
    p.fx.append(card);
    if (jar.badge || jar.fame) cue('badge');
    if (!instant && !reduced()) {
      card.animate([{ transform: 'translate(-50%, 30%) scale(.8)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1.2)', fill: 'backwards' });
      const art = card.querySelector('.bb-reg-badge svg');
      if (art) art.animate([{ transform: 'rotateY(0)' }, { transform: 'rotateY(720deg)' }], { duration: 1400, easing: 'cubic-bezier(.2,.8,.2,1)' });
      if (jar.fame || jar.badge) confetti(jar.fame ? 60 : 30);
    }
    card.querySelector('.btn.primary')?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ wiring
  api.onBugBattles(apply);
  api.getBugBattles().then(apply).catch(() => {});
  // The chip follows the conversation you're in; time moves the "!" and finished fights along.
  setInterval(() => { if (battles.length) renderChip(); }, 5000);
})();
