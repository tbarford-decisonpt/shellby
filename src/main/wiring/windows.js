// His windows: the crab's and the panel's, where they sit on which screen,
// keeping them cheap while nobody can see them (idle cost), and staying on top
// of your apps.
// Kept out of main.js, which only wires it up.
const { app, BrowserWindow, powerMonitor, screen } = require('electron');
const path = require('path');
const { createClimbing } = require('../climbing');
const { DESKTOP_CLASSES, covers: coversBox, panelCalm: panelCalmFor, keepOnDesktop, pin: pinToDesktop, sendToBottom, setOnTop, tuckUnder, veil } = require('../desktop-layer');
const { createFloor } = require('../floor');
const focus = require('../focus');
const { CritterMotion } = require('../motion');
const native = require('../native-windows');
const { watchesDesktop } = require('../test-desktop');
const { createPerching } = require('../perching');
const { clampToDisplays } = require('../placement');
const { createPranks } = require('../pranks');
const voice = require('../voice');

/** d: what main shares (main.js `shared`). */
function wireWindows(d) {
  // ---- windows

  const px = () => Math.round(d.BASE_PX * (d.config.get('critterScale') || 1));
  const helperWidth = () => Math.round(px() * 22 * 0.5) + 10;
  const CREW_PAD = 60; // room for helper name tags at the far left
  const VISITOR_SCALE = 0.7;
  const visitorWidth = () => Math.round(px() * 22 * VISITOR_SCALE) + 16;
  const crewExtra = (slots = d.crewShown, guest = d.guestShown) => (slots || guest ? slots * helperWidth() + (guest ? visitorWidth() : 0) + CREW_PAD : 0);

  function critterBaseSize() {
    const p = px();
    return { width: 22 * p + 72, height: 13 * p + 84 };
  }

  function workAreas() { return screen.getAllDisplays().map(d => d.workArea); }

  // The critter window's size in DIPs: Shellby plus room for helper crabs.
  function critterSize() {
    const b = critterBaseSize();
    return { width: b.width + crewExtra(), height: b.height };
  }

  // Windows keeps a window's *physical* size when it crosses onto a monitor with
  // another scale (125% -> 150% shrinks it by a sixth), which clipped Shellby or
  // cut him loose from his effects. So every move sets the size too, and any size
  // Windows imposes afterwards (WM_DPICHANGED) is put back.
  function placeCritter(x, y) {
    d.critter.setBounds({ x: Math.round(x), y: Math.round(y), ...critterSize() });
    keepCritterSize();
  }
  let sizeFixes = [];
  function keepCritterSize() {
    if (!d.critter || d.critter.isDestroyed()) return;
    const want = critterSize();
    const b = d.critter.getBounds();
    if (b.width === want.width && b.height === want.height) return;
    const now = Date.now();
    sizeFixes = sizeFixes.filter(t => now - t < 1000);
    if (sizeFixes.length >= 4) return; // never fight Windows in a loop
    sizeFixes.push(now);
    d.critter.setBounds({ x: b.x, y: b.y, ...want });
  }

  function resetCritterPos() {
    d.pranks?.grabbed();
    d.climbing?.grabbed(); // put straight back, not dropped from wherever he was
    d.motion?.stop();
    const p = defaultCritterPos(critterBaseSize());
    placeCritter(p.x - crewExtra(), p.y);
    d.config.set({ critterPos: p });
    settleCritter();
  }

  // Back down on the desktop layer, unless he's up on a window (or in the air on
  // his way to one), where he stays put. See perching.js.
  function settleCritter() {
    if (d.perching) d.perching.home();
    else sendToBottom(d.critter);
    d.floor?.lower();
  }

  function defaultCritterPos(size) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - size.width - 48, y: wa.y + wa.height - size.height - 24 };
  }

  function secureWindow(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
  }

  const webPreferences = { preload: d.PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false };

  // Throws land on the floor of the screen he's on; strolls stay on it too.
  function motionBox() {
    const b = d.critter.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x + b.width - critterBaseSize().width / 2, y: b.y + b.height / 2 }).workArea;
    return { minX: wa.x, maxX: wa.x + wa.width - b.width, minY: wa.y, floorY: wa.y + wa.height - b.height };
  }

  // His window and body, for perching and climbing. Feet sit 18 DIP above the
  // window's bottom edge (#crab in critter.css); half is half his width, body his height.
  function critterGeo() {
    const s = critterSize();
    return { width: s.width, height: s.height, foot: 18, half: 11 * px(), body: 13 * px(), headroom: s.height - 18 };
  }

  // What perching needs from here: his size and spot, the motion engine, and his
  // voice, stats and renderer.
  function createPerchingFor() {
    d.perching = createPerching({
      critter: () => d.critter,
      veiled: () => crabCalmNow().hide,
      motion: () => d.motion,
      screen,
      config: d.config,
      capture: d.CAPTURE,
      geo: critterGeo,
      getPos: () => { const [x, y] = d.critter.getPosition(); return { x, y }; },
      place: (x, y) => placeCritter(x, y),
      box: motionBox,
      homePos: () => {
        const p = d.config.get('critterPos') || defaultCritterPos(critterBaseSize());
        return { x: p.x - crewExtra(), y: p.y };
      },
      pin: () => (d.CAPTURE ? sendToBottom(d.critter) : pinToDesktop(d.critter)),
      onTop: () => onTopNow(),
      temperament: () => voice.temperamentOf(voice.normalize(d.config.get('voice')).seed),
      speak: (occasion, opts) => d.speak(occasion, opts),
      stat: d.stat,
      toRenderer: (kind, info = {}) => d.send(d.critter, 'critter:motion', { kind, ...info }),
      perchView: view => d.send(d.critter, 'critter:perch', view),
      bit: (bit, ms) => d.send(d.critter, 'critter:bit', { bit, ms }),
      refresh: () => d.refreshCritter(),
      dragging: () => d.dragging,
      crew: () => d.crewShown + (d.guestShown ? 1 : 0), // helpers or a visitor beside him: he stays down
    });
    d.climbing = createClimbing({
      motion: () => d.motion,
      screen,
      config: d.config,
      capture: d.CAPTURE,
      geo: critterGeo,
      getPos: () => { const [x, y] = d.critter.getPosition(); return { x, y }; },
      place: (x, y) => placeCritter(x, y),
      temperament: () => voice.temperamentOf(voice.normalize(d.config.get('voice')).seed),
      speak: (occasion, opts) => d.speak(occasion, opts),
      stat: d.stat,
      toRenderer: (kind, info = {}) => d.send(d.critter, 'critter:motion', { kind, ...info }),
      surface: name => d.send(d.critter, 'critter:surface', { surface: name }),
      bit: (bit, ms) => d.send(d.critter, 'critter:bit', { bit, ms }),
      dragging: () => d.dragging,
      crew: () => d.crewShown + (d.guestShown ? 1 : 0), // the window's wider with them: no room to turn
      perchingAway: () => !!d.perching?.isAway(),
      walkHome: () => d.perching.walkHome(),
    });
  }

  // The floor strip and mischief: what they need from here. Created after life
  // and play, whose state they read.
  function createMischief() {
    d.floor = createFloor({
      config: d.config, screen, capture: d.CAPTURE,
      makeWindow: () => {
        const w = new BrowserWindow({
          width: 400, height: 80, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
          alwaysOnTop: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
          title: 'Shellby’s floor', icon: d.ICON, webPreferences: { ...webPreferences, preload: d.FLOOR_PRELOAD },
        });
        secureWindow(w);
        w.loadFile(path.join(d.RENDERER, 'floor', 'floor.html'));
        return w;
      },
      pin: w => pinToDesktop(w),
      lower: w => tuckUnder(w, d.critter),
      critterBounds: () => d.critter.getBounds(),
      geo: critterGeo,
      px,
      skin: () => ({ skin: d.activeSkin(), px: px(), outfit: d.outfit() }),
      status: () => d.lastStatus.state,
      away: () => (d.climbing?.isAway() ? 'climb' : d.perching?.isAway() ? 'perch' : null),
      calm: () => crabCalmNow().calm,
      hidden: () => crabCalmNow().hide,
      veil: (w, hide) => veil(w, hide, { lower: x => tuckUnder(x, d.critter) }),
    });
    d.pranks = createPranks({
      config: d.config, screen, native, capture: d.CAPTURE,
      motion: () => d.motion,
      getPos: () => { const [x, y] = d.critter.getPosition(); return { x, y }; },
      place: (x, y) => placeCritter(x, y),
      geo: critterGeo,
      // His claw: in front of him, about halfway up (sprite.js DEFAULT_ANCHORS.claw).
      clawPoint: () => {
        if (!d.critter || d.critter.isDestroyed()) return null;
        const g = critterGeo(), [x, y] = d.critter.getPosition();
        return { x: x + g.width / 2 + 9 * px(), y: y + g.height - g.foot - 6 * px() };
      },
      status: () => d.lastStatus.state,
      guarding: () => focus.guarding(d.config.get('focus'), Date.now()),
      onCall: () => !!d.life?.onCall(),
      locked: () => d.calmReason === 'locked',
      // ...or tapping along while you type (typing.js): no pinching mid-sentence.
      playing: () => !!d.playtime?.busy() || !!d.life?.busy() || !!d.typing?.active(),
      dragging: () => d.dragging,
      crew: () => d.crewShown + (d.guestShown ? 1 : 0),
      perching: d.perching,
      climbingBusy: () => !!d.climbing?.busy(),
      walkHome: () => d.perching.walkHome(),
      speak: (occasion, opts) => d.speak(occasion, opts),
      bit: (bit, ms, dir) => d.send(d.critter, 'critter:bit', { bit, ms, ...(dir ? { dir } : {}) }),
      toRenderer: (kind, info = {}) => d.send(d.critter, 'critter:motion', { kind, ...info }),
      stat: d.stat,
      makeNote: () => {
        const w = new BrowserWindow({
          width: 210, height: 150, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
          alwaysOnTop: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
          title: 'A note from Shellby', icon: d.ICON, webPreferences: { ...webPreferences, preload: d.NOTE_PRELOAD },
        });
        secureWindow(w);
        w.loadFile(path.join(d.RENDERER, 'note', 'note.html'));
        return w;
      },
      pinWindow: w => pinToDesktop(w),
      systemIdleSeconds: () => { try { return powerMonitor.getSystemIdleTime(); } catch { return null; } },
    });
    d.floor.sync();
    d.pranks.sync();
  }

  function createMotion() {
    d.motion = new CritterMotion({
      getPos: () => { const [x, y] = d.critter.getPosition(); return { x, y }; },
      place: (x, y) => placeCritter(x, y),
      box: motionBox,
      ledges: () => d.perching?.flightLedges() || [],
      grips: () => d.climbing?.grips() || null,
      onState: (kind, info = {}) => d.send(d.critter, 'critter:motion', { kind, ...info }),
      onSettled: (kind, info) => {
        if (d.playtime?.onSettled(kind)) return; // a walk to fetch the pebble, or back with it
        if (d.pranks?.onSettled(kind)) return;   // off the edge of the screen to fetch a note
        if (d.climbing?.onSettled(kind, info)) return; // at the foot of a wall, or thrown onto one
        if (d.perching?.onSettled(kind, info)) return;
        if (kind === 'flight') { d.saveCritterPos(); d.stat('thrown'); d.floor?.event('landed'); }
        settleCritter();
      },
      onInterrupted: kind => {
        d.perching?.onInterrupted(kind);
        d.climbing?.onInterrupted(kind);
        d.pranks?.onInterrupted();
      },
      // A bump against the screen's edge is only news to the speaker.
      onBounce: b => { if (d.soundMix().fx) d.send(d.critter, 'critter:motion', { kind: 'bounce', ...b }); },
    });
    createPerchingFor();
    // Now and then an idle, awake Shellby takes a few steps near his spot, hops
    // up onto one of your windows, finds something to do with his claws, or says
    // something to nobody. Up on a window, his life has its own rhythm.
    setInterval(() => {
      // Tapping along while you type: no wandering off or digging mid-sentence.
      if (d.CAPTURE || d.dragging || d.playtime?.busy() || d.life?.busy() || d.typing?.active()) return;
      const idle = d.lastStatus.state === 'idle';
      const guarding = focus.guarding(d.config.get('focus'), Date.now());
      if (d.perching.isUp()) return void d.perching.idleTick({ idle, guarding, quiet: !voice.hasHabits(d.config.get('chatter')) });
      // Up a wall, or off the edge of the screen fetching a note: busy.
      if (d.climbing?.busy() || d.pranks?.busy()) return;
      if (d.motion.busy || d.crewShown || d.guestShown || !idle || guarding) return;
      // A stroll moves his window; the little habits don't, so 'wander' only
      // governs the strolling (and the climbing), as it always has.
      if (d.config.get('wander') !== false && !d.life?.onCall()) {
        if (d.perching.maybeGoUp()) return;
        if (d.climbing.maybeClimb()) return;
        const home = d.config.get('critterPos');
        // A bit mopey (needs.js), he doesn't feel much like strolling.
        if (home && Math.random() < (d.life?.mopey() ? 0.14 : 0.35)) return void d.motion.stroll(home.x - crewExtra());
      }
      if (!voice.hasHabits(d.config.get('chatter')) || Math.random() > d.IDLE_BIT_CHANCE) return;
      // A scene, a habit, maybe a find or a memory (life.js).
      if (d.life?.idleBit()) return;
      const bit = voice.pickBit(voice.normalize(d.config.get('voice')).seed);
      d.send(d.critter, 'critter:bit', { bit });
      d.speak(voice.CLUMSY_BITS.includes(bit) ? 'oops' : 'idle');
    }, 15000);
  }

  function createCritter() {
    const size = critterBaseSize();
    const saved = d.config.get('critterPos');
    const pos = clampToDisplays({ ...(saved || defaultCritterPos(size)), ...size }, workAreas());
    d.critter = new BrowserWindow({
      ...size, x: pos.x, y: pos.y,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
      alwaysOnTop: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
      title: 'Shellby', icon: d.ICON, webPreferences: { ...webPreferences, preload: d.CRITTER_PRELOAD },
    });
    secureWindow(d.critter);
    setOnTop(onTopNow);
    d.critter.loadFile(path.join(d.RENDERER, 'critter', 'critter.html'));
    d.critter.once('ready-to-show', () => {
      keepCritterSize(); // created on a scaled monitor, Windows may have rounded it
      critterReady = true;
      if (!crabCalmNow().hide) d.critter.showInactive(); // started behind a game: the next calm shows him
      if (!d.CAPTURE) keepOnDesktop(d.critter, { isAway: () => !!d.perching?.isAway() });
      layerOnTop = onTopNow();
    });
    // On top of your apps his window lets the mouse through; a reload forgets that.
    d.critter.webContents.on('did-finish-load', () => d.perching?.layerChanged());
    d.critter.on('blur', () => { sendToBottom(d.critter); d.floor?.lower(); }); // a no-op while he's up on a window; the floor strip stays under him
    d.critter.on('resize', () => setImmediate(keepCritterSize));
  }

  // ---- idle cost
  // An open panel costs about three quarters of a core, nearly all of it CSS
  // animation on pixel sprites (scripts/idle-cost.js measures it). Most of that is
  // spent while nobody is looking: the panel left open behind an editor, or the
  // screen locked. So the decorative animations — the drifting caustics and the
  // breathing crab, never the spinners or progress — are paused when the panel
  // isn't focused, and everything in both windows stops while the screen is locked
  // or the machine is suspended.
  //
  // He also stops while he can't be seen. He lives under every app, so a game or a
  // maximized window hides him completely, but Chromium never learns that (a
  // transparent window owned by the desktop is never reported occluded) and kept
  // compositing his loops at 60 fps: a third of a 3080 Ti behind a game. A cheap
  // poll asks whether a game is up or the window in front covers him; while it
  // does he gets the locked-screen calm. With a game up the panel drops its
  // decorative loops, and stops the rest only when the game's window lies over
  // it (panelCalm in desktop-layer.js): on another screen it's still watched.
  // Under a game's window, or with the screen locked, calm isn't enough: he and
  // his floor are hidden outright (desktop-layer.js veil). Only when the game
  // covers him: on another monitor he's still in plain sight. And not behind an
  // ordinary window: the poll is two seconds, and a crab missing from the desktop
  // that long after you minimize something would be noticed.
  const COVER_POLL_MS = 2000;
  let hidden = { crab: false, game: false, underGame: false, panelUnderGame: false };
  let calmSent = '';
  let critterReady = false;
  function crabCalmNow() {
    const locked = d.calmReason === 'locked';
    // Covered, he stops animating but can still be heard; locked, he goes quiet too.
    return { calm: locked || hidden.crab, locked, hide: !d.CAPTURE && (locked || hidden.underGame) };
  }
  function sendCalm() {
    const panelCalm = panelCalmFor({ reason: d.calmReason, game: hidden.game, underGame: hidden.panelUnderGame });
    const crabCalm = crabCalmNow();
    const key = JSON.stringify([panelCalm, crabCalm]);
    if (key === calmSent) return;
    calmSent = key;
    d.send(d.panel, 'panel:calm', panelCalm);
    d.send(d.critter, 'critter:calm', crabCalm);
    if (critterReady) veil(d.critter, crabCalm.hide, { lower: sendToBottom }); // until then, ready-to-show decides
    d.floor?.calm(crabCalm.calm, crabCalm.hide); // the floor beside him is covered when he is
  }
  function setCalm(reason) {
    d.calmReason = reason;
    sendCalm();
  }
  function crabCovered(info) {
    // Up on a window, or kept on top of your apps, he's drawn above what's in front.
    if (!info || onTopNow() || d.perching?.isAway() || info.pid === process.pid || DESKTOP_CLASSES.has(info.cls)) return false;
    return coversBox(frontFrame(info), d.critter.getBounds());
  }
  // The window in front's frame in DIPs, or null when it can't hide anything.
  function frontFrame(info) {
    if (!info || !info.visible || info.minimized || info.cloaked || !info.frame) return null;
    const f = info.frame;
    return screen.screenToDipRect(null, { x: f.left, y: f.top, width: f.right - f.left, height: f.bottom - f.top });
  }
  function panelCovered(info) {
    const p = d.panel;
    if (!info || info.pid === process.pid || !p || p.isDestroyed() || !p.isVisible() || p.isMinimized()) return false;
    return coversBox(frontFrame(info), p.getBounds());
  }
  function checkCovered() {
    if (!d.critter || d.critter.isDestroyed() || !native.available()) return;
    const info = native.describe(native.foreground());
    const game = d.gameInFront(info);
    hidden = { ...hidden, game }; // first: whether he's on top (crabCovered) depends on it
    const covered = crabCovered(info);
    hidden = {
      ...hidden, crab: (game && !d.perching?.isAway()) || covered, underGame: game && covered,
      panelUnderGame: game && panelCovered(info),
    };
    syncLayer(); // a game came up, or went
    sendCalm();
  }

  // ---- on top of your apps
  // "Keep him on top of my apps" (Settings) lifts him and his floor out of the
  // desktop layer (desktop-layer.js). He still steps back down behind a game, so
  // he's never drawn over one, and while he's hiding: he needs your windows for that.
  function onTopNow() {
    return !d.CAPTURE && d.config.get('onTop') === true && !hidden.game && !d.playtime?.hiding();
  }
  let layerOnTop = null; // what applyLayer last put him on
  function applyLayer() {
    if (!d.critter || d.critter.isDestroyed()) return;
    layerOnTop = onTopNow();
    // In the air he lands on the right layer; up on a window, perching restacks him.
    if (!d.perching?.isAway()) pinToDesktop(d.critter);
    d.floor?.repin();
    d.perching?.layerChanged();
  }
  function syncLayer() {
    if (onTopNow() !== layerOnTop) applyLayer();
  }
  function watchIdleCost() {
    d.panel.on('blur', () => setCalm(d.calmReason === 'locked' ? 'locked' : 'blur'));
    d.panel.on('focus', () => setCalm(d.calmReason === 'locked' ? 'locked' : null));
    for (const asleep of ['lock-screen', 'suspend']) powerMonitor.on(asleep, () => setCalm('locked'));
    powerMonitor.on('unlock-screen', () => setCalm(d.panel?.isFocused() ? null : 'blur'));
    // A wake usually lands on the lock screen: stay hidden until it's unlocked.
    powerMonitor.on('resume', () => {
      let locked = false;
      try { locked = powerMonitor.getSystemIdleState(60) === 'locked'; } catch { /* unknown: treat as awake */ }
      setCalm(locked ? 'locked' : d.panel?.isFocused() ? null : 'blur');
    });
    // The renderers start animated; a reload would forget a calm sent before it.
    for (const w of [d.panel, d.critter]) w?.webContents.on('did-finish-load', () => { calmSent = ''; sendCalm(); });
    if (!d.CAPTURE && watchesDesktop(process.env, app.isPackaged)) setInterval(checkCovered, COVER_POLL_MS).unref?.();
  }

  return {
    applyLayer, createCritter, createMischief, createMotion, crewExtra, critterBaseSize,
    critterGeo, helperWidth, motionBox, placeCritter, px, resetCritterPos, secureWindow,
    settleCritter, syncLayer, watchIdleCost, webPreferences, workAreas,
  };
}

module.exports = { wireWindows };
