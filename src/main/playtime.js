// Playing with him, for real: hide and seek behind your windows, and fetch
// with a pebble you throw across the screen. The rules are in play.js; this
// moves his window (and the pebble's), and main.js wires it in through `d`.
//
// Hide and seek: "close your eyes!", he burrows into the sand and pops up behind
// one of your windows (he lives on the wallpaper, so they really do hide him).
// Click him, or drag him out, to find him. Take too long and he peeks out over
// your windows as a hint; much longer and he comes out on his own and wins.
//
// Fetch: a pebble appears beside him. Drag it and throw it; it flies, bounces
// and lands on the same floor he stands on, and he scuttles after it, picks it
// up, brings it back and drops it at your feet. Ignore it for long enough and
// the game's over.

const { releaseVelocity, CritterMotion } = require('./motion');
const play = require('./play');

const SKIP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow']);
const FOOT = 18; // his feet are this far above his window's bottom edge (critter.css #crab)
const DEFAULT_TOY = Object.freeze({ palette: { a: '#8d99ae', b: '#b8c2d1', c: '#e9ecef' }, pixels: ['.bbb.', 'bccba', 'bbbba', '.aaa.'] });

function createPlaytime(d) {
  let game = null;   // { kind: 'hide', phase, hiddenAt, hints, timers } | { kind: 'fetch', phase, ... }
  let toy = null;    // the pebble's BrowserWindow
  let toyMotion = null;
  let toyDrag = null;
  let boredTimer = null;

  const state = () => play.normalize(d.config.get('play'));
  const save = s => d.config.set({ play: s });
  const busy = () => !!game;
  const timers = [];
  const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const clearTimers = () => { timers.splice(0).forEach(clearTimeout); };

  // ---------------------------------------------------------------- hide and seek
  function hidingPlaces() {
    const own = new Set(d.ownPids());
    const out = [];
    for (const h of d.native.topLevelWindows().slice(0, 60)) {
      const w = d.native.describe(h);
      if (!w || w.minimized || w.cloaked || !w.visible || w.tool || w.child || !w.captioned || own.has(w.pid) || SKIP_CLASSES.has(w.cls)) continue;
      const r = w.frame || w.rect;
      if (r) out.push({ rect: r });
    }
    return out;
  }

  function startHide() {
    if (game) return { ok: false, error: "He's already playing." };
    if (!d.isFree()) return { ok: false, error: "He's busy right now. Try again when he's idle." };
    d.prepare();
    const home = d.getPos();
    game = { kind: 'hide', phase: 'counting', home, hiddenAt: 0, hints: 0 };
    d.say('close your eyes!', play.HIDE.countMs, 'play');
    d.toCrab('critter:bit', { bit: 'peek', ms: play.HIDE.countMs });
    later(play.HIDE.countMs, () => {
      if (game?.kind !== 'hide') return;
      d.toCrab('critter:bit', { bit: 'burrow', ms: 1000 });
      later(900, () => {
        if (game?.kind !== 'hide') return;
        const b = d.bounds();
        const work = d.screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
        const spot = play.chooseHideSpot({ windows: hidingPlaces(), work, size: { width: b.width, height: b.height }, home });
        d.place(spot.x, spot.y);
        d.pin();
        d.toCrab('critter:bit', { bit: 'emerge', ms: 900 });
        game = { ...game, phase: 'hidden', hiddenAt: Date.now(), covered: spot.covered };
        game.tick = setInterval(hideTick, 1000);
      });
    });
    d.changed();
    return { ok: true };
  }

  function hideTick() {
    if (game?.kind !== 'hide' || game.phase !== 'hidden') return;
    const step = play.hideStep(game, Date.now());
    if (step === 'giveup') return endHide(null);
    if (step?.hint != null) {
      game.hints = step.hint + 1;
      peek(['over here!', 'getting warm?', 'psst!'][step.hint] || 'psst!');
    }
  }

  // Up over your windows for a moment, then back behind them.
  function peek(line, ms = play.HIDE.peekMs) {
    d.float();
    d.toCrab('critter:bit', { bit: 'peekaboo', ms });
    d.say(line, ms, 'play');
    d.chirp();
    later(ms, () => { if (game?.kind === 'hide' && game.phase === 'hidden') d.pin(); });
  }

  /** He was clicked. While he's hidden, that's you finding him. */
  function found() {
    if (game?.kind !== 'hide' || game.phase !== 'hidden') return false;
    endHide(Date.now() - game.hiddenAt);
    return true;
  }

  /**
   * You picked him up mid-game. Hidden, that's finding him; any other moment
   * (counting, burrowing, on his way home, fetching) the game stops. Either
   * way he stays wherever you put him down.
   */
  function grabbed() {
    if (!game) return;
    if (game.kind === 'hide' && game.phase === 'hidden') {
      endHide(Date.now() - game.hiddenAt, { dragged: true });
      return;
    }
    stop(null, { stay: true });
  }

  function endHide(foundMs, { dragged = false } = {}) {
    const g = game;
    clearInterval(g.tick);
    game = { ...g, phase: 'over' };
    const r = play.hideResult(state(), foundMs);
    save(r.state);
    if (foundMs != null) {
      d.stat('hide-found');
      d.burst();
      d.say(r.best && r.state.hide.found > 1 ? 'new record!' : 'you found me!', 3000, 'play');
      d.toCrab('critter:bit', { bit: 'jolt', ms: 900 });
    } else {
      d.float();
      d.say('I win!', 3000, 'play');
      d.toCrab('critter:bit', { bit: 'boogie', ms: 2600 });
    }
    d.onPlayed('hide', { foundMs, best: r.best });
    // Dragged out of hiding: he stays where you put him. Otherwise he burrows home.
    if (dragged) { clearTimers(); game = null; d.changed(); return; }
    later(3000, () => goHome(g.home));
  }

  function goHome(home) {
    d.toCrab('critter:bit', { bit: 'burrow', ms: 1000 });
    later(900, () => {
      d.place(home.x, home.y);
      d.pin();
      d.toCrab('critter:bit', { bit: 'emerge', ms: 900 });
      game = null;
      d.changed();
      d.refresh();
    });
  }

  // ---------------------------------------------------------------- fetch
  function toyFloor() {
    const b = d.bounds();
    const work = d.screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
    const size = play.FETCH.size;
    const floorY = Math.min(b.y + b.height - FOOT - size + 6, work.y + work.height - size);
    return { minX: work.x, maxX: work.x + work.width - size, minY: work.y, floorY };
  }

  // Just in front of him, on his floor.
  function besideHim() {
    const b = d.bounds();
    const self = 22 * d.px() + 72;
    const x = b.x + b.width - self / 2 - 11 * d.px() - play.FETCH.size - 6;
    return { x: Math.round(Math.max(toyFloor().minX, x)), y: toyFloor().floorY };
  }

  function makeToy() {
    if (toy && !toy.isDestroyed()) return toy;
    const size = play.FETCH.size;
    toy = d.makeWindow({ width: size, height: size });
    toyMotion = new CritterMotion({
      getPos: () => { const [x, y] = toy.getPosition(); return { x, y }; },
      place: (x, y) => { if (toy && !toy.isDestroyed()) toy.setPosition(Math.round(x), Math.round(y)); },
      box: toyFloor,
      onSettled: kind => { if (kind === 'flight') landed(); },
    });
    // Closing is asynchronous: by the time an old pebble's 'closed' arrives,
    // a new game may already have its own, which this mustn't touch.
    const w = toy;
    w.on('closed', () => { if (toy === w) { toy = null; toyMotion?.halt(); toyMotion = null; } });
    return toy;
  }

  function toyLook() {
    const f = d.favouriteFind();
    return f ? { pixels: f.pixels, palette: f.palette } : DEFAULT_TOY;
  }

  function startFetch() {
    if (game) return { ok: false, error: "He's already playing." };
    if (!d.isFree()) return { ok: false, error: "He's busy right now. Try again when he's idle." };
    d.prepare();
    game = { kind: 'fetch', phase: 'waiting', home: d.getPos(), throws: 0 };
    const w = makeToy();
    const at = besideHim();
    w.setPosition(at.x, at.y);
    w.once('ready-to-show', () => { w.showInactive(); d.pinWindow(w); w.webContents.send('toy:look', toyLook()); });
    if (w.webContents.isLoading()) { /* ready-to-show will fire */ } else { w.showInactive(); d.pinWindow(w); w.webContents.send('toy:look', toyLook()); }
    d.say('throw it!', 3000, 'play');
    d.toCrab('critter:bit', { bit: 'wave', ms: 1800 });
    bored();
    d.changed();
    return { ok: true };
  }

  function bored() {
    clearTimeout(boredTimer);
    // Nothing thrown (or held and never let go, or dropped somewhere it never
    // settled) for a while: game over. A walk to or from the pebble re-arms it.
    boredTimer = setTimeout(() => {
      if (game?.kind !== 'fetch') return;
      if (game.phase === 'running' || game.phase === 'returning') return bored();
      endFetch('that was fun');
    }, play.FETCH.boredMs);
  }

  function toyDragStart() {
    if (game?.kind !== 'fetch' || !toy) return;
    if (game.phase === 'running') d.motion().stop(); // you grabbed it back off him
    toyMotion.halt();
    bored();
    // Like dragging him (main.js): the grab offset is fixed now and moves follow
    // the real cursor, because the renderer's screenX lags while its window moves.
    const [x, y] = toy.getPosition();
    const c = d.screen.getCursorScreenPoint();
    toyDrag = { x, y, dx: c.x - x, dy: c.y - y, samples: [{ x, y, t: Date.now() }] };
    game = { ...game, phase: 'held' };
  }

  function toyDragMove() {
    if (!toyDrag || !toy) return;
    const c = d.screen.getCursorScreenPoint();
    const x = c.x - toyDrag.dx, y = c.y - toyDrag.dy;
    toy.setPosition(Math.round(x), Math.round(y));
    toyDrag.samples = [...toyDrag.samples, { x, y, t: Date.now() }].slice(-12);
  }

  function toyDragEnd() {
    if (!toyDrag || !toy) return;
    const [x, y] = toy.getPosition();
    const v = releaseVelocity([...toyDrag.samples, { x, y, t: Date.now() }]);
    game = { ...game, phase: 'flying', from: toyDrag.x };
    toyDrag = null;
    bored();
    d.toCrab('critter:bit', { bit: 'squint', ms: 900 });
    toyMotion.launch(v, { why: 'thrown' }); // a gentle drop just falls
  }

  function landed() {
    if (game?.kind !== 'fetch' || !toy) return;
    const [tx] = toy.getPosition();
    game = { ...game, phase: 'running', toyX: tx };
    const box = d.motionBox();
    const target = play.pickupX(tx, { critterWidth: d.bounds().width, toySize: play.FETCH.size, box });
    d.say(['mine!', 'got it got it', 'wait for me!'][Math.floor(Math.random() * 3)], 1800, 'play');
    d.motion().stop(); // anything left over: so a refusal below only ever means "already there"
    if (!d.motion().walkTo(target, play.FETCH.runSpeed, { kind: 'fetch-run' })) pickUp();
  }

  function pickUp() {
    if (game?.kind !== 'fetch' || !toy) return;
    toy.hide();
    d.toCrab('critter:hold', toyLook());
    d.toCrab('critter:bit', { bit: 'present', ms: 900 });
    game = { ...game, phase: 'returning' };
    later(700, () => {
      if (game?.kind !== 'fetch') return;
      d.motion().stop();
      if (!d.motion().walkTo(game.home.x, play.FETCH.homeSpeed, { kind: 'fetch-home' })) dropOff();
    });
  }

  function dropOff() {
    if (game?.kind !== 'fetch' || !toy) return;
    const distance = Math.abs((game.toyX ?? 0) - (game.from ?? game.toyX ?? 0));
    const r = play.fetchResult(state(), distance);
    save(r.state);
    d.stat('fetched');
    d.onPlayed('fetch', { distance, longest: r.longest });
    d.toCrab('critter:hold', null);
    const at = besideHim();
    toy.setPosition(at.x, at.y);
    toy.showInactive();
    d.pinWindow(toy);
    d.say(r.longest && r.state.fetch.fetched > 1 ? 'furthest yet!' : ['again?', 'again! again!', 'one more?'][Math.floor(Math.random() * 3)], 2600, 'play');
    d.toCrab('critter:bit', { bit: 'wave', ms: 1600 });
    game = { ...game, phase: 'waiting', throws: game.throws + 1 };
    bored();
  }

  // `stay`: he's being dragged somewhere, so don't put him back home.
  function endFetch(line, { stay = false } = {}) {
    clearTimeout(boredTimer);
    const g = game;
    game = null;
    toyMotion?.halt();
    if (toy && !toy.isDestroyed()) toy.close();
    toy = null;
    d.toCrab('critter:hold', null);
    if (line) d.say(line, 2600, 'play');
    // Mid-run or on his way back: he walks home rather than staying out there.
    if (!stay && g && (g.phase === 'running' || g.phase === 'returning')) {
      d.motion().stop();
      d.motion().walkTo(g.home.x, play.FETCH.homeSpeed, { kind: 'stroll' });
    }
    d.changed();
  }

  /** motion.js finished a walk this module started. True when it was ours. */
  function onSettled(kind) {
    if (kind === 'fetch-run') { pickUp(); return true; }
    if (kind === 'fetch-home') { dropOff(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- stopping
  /** Stop whatever game is on (a task started, the menu, quitting). He goes home. */
  function stop(reason = null, { stay = false } = {}) {
    if (!game) return;
    clearTimers();
    if (game.kind === 'hide') {
      clearInterval(game.tick);
      const home = game.home;
      game = null;
      if (!stay) { d.place(home.x, home.y); d.pin(); }
      if (reason) d.say(reason, 2500, 'play');
    } else {
      endFetch(reason, { stay });
    }
    d.changed();
  }

  function menuItems() {
    if (game?.kind === 'hide') return [{ label: 'Stop hide and seek', click: () => stop('aww, ok') }];
    if (game?.kind === 'fetch') return [{ label: 'Stop playing fetch', click: () => endFetch('that was fun') }];
    return [
      { label: 'Hide and seek', click: startHide },
      { label: 'Fetch', click: startFetch },
    ];
  }

  const view = () => ({ ...state(), playing: game ? game.kind : null });

  return {
    startHide, startFetch, found, grabbed, stop, busy, onSettled, menuItems, view,
    toyDragStart, toyDragMove, toyDragEnd,
    kind: () => game?.kind || null,
    hiding: () => game?.kind === 'hide' && game.phase !== 'over', // he needs your windows to hide behind
    isToy: wc => !!toy && !toy.isDestroyed() && wc === toy.webContents,
  };
}

module.exports = { createPlaytime, DEFAULT_TOY };
