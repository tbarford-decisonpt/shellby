// Perching, wired up: Shellby picks a window, eyes it up, hops onto its title
// bar and rides it until it closes, you shake him off, or he gets bored and
// hops home. The judgement calls are in perch.js (pure, tested); the Win32
// reads are native-windows.js; this file is the glue between them, the motion
// engine (motion.js) and the critter window.
//
// Z-order is the trick. On the desktop he's an owned window of the desktop
// host (desktop-layer.js). Perched, he's an owned window of the app's window,
// so he sits just above it and goes behind anything that covers it. In the air
// he's nobody's, on top of the ordinary windows, so a hop or a fall is seen
// crossing your apps rather than happening behind them.
const perch = require('./perch');
const native = require('./native-windows');

const READ_IDLE_MS = 90;        // a still window is read ~11×/s; a moving one every frame
const LEAN_EVERY_MS = 70;       // how often his lean is sent to the renderer while riding
const RIDE_PRAISE_MS = 1600;    // clinging this long at a fair speed: he's enjoying it
const RIDE_PRAISE_SPEED = 220;
const EYE_MS = 650;             // looking up at the window before he goes for it
const HOP_HOME_MAX = 900;       // hops straight home from up to this far away; further, hops down and walks
const WALK_HOME_SPEED = 95;
const DIZZY_MS = 2600;
const REFUSED_MS = 10 * 60 * 1000; // a window Windows wouldn't let him own (elevated) is left alone this long
const PERCH_BITS_MS = 6000;

/**
 * deps: {
 *   critter(), motion(), screen, config, geo(), getPos(), place(x, y), box(),
 *   homePos() -> { x, y }, pin(), temperament(), speak(occasion, opts), stat(event, payload),
 *   toRenderer(kind, info), perchView(view), bit(name, ms), refresh(), dragging(), crew(), capture,
 *   veiled() -> hidden behind a game or the lock screen (main.js veil)
 *   onTop() -> true while he's kept above your apps (desktop-layer.js)
 * }
 */
function createPerching(d) {
  let attached = null;   // { hwnd, exe, since, stayUntil, ride, read, lastRead, clingSince, praised }
  let floating = false;  // in the air: on top of the apps, owned by nobody
  let lastEnd = Date.now(); // so he doesn't go straight up at startup
  let pendingUp = null;  // the look-up before a hop
  let flightFrom = null; // the window he just left, for "leap of faith"
  let lean = { at: 0, v: 0 };
  let clickThrough = false;
  let hovering = false;
  let afterLand = null;
  const refused = new Map(); // hwnd -> until

  const self = () => native.hwndOf(d.critter());
  const setting = () => perch.settingOf(d.config.get('perch'));
  const allowed = () => !d.capture && native.available() && setting() !== 'off' && d.config.get('wander') !== false;
  const ignore = () => new Set((d.config.get('perchIgnore') || []).filter(x => typeof x === 'string'));
  const ctx = () => ({ ownPids: new Set([process.pid]), ignore: ignore(), geo: d.geo() });

  // ---------------------------------------------------------------- reading windows

  function toDip(r) {
    if (!r) return null;
    const rect = d.screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
    return { rect, workArea: d.screen.getDisplayMatching(rect).workArea };
  }

  function readWindow(hwnd) {
    const q = native.quick(hwnd);
    if (q.gone || !q.frame) return q;
    const dip = toDip(q.frame);
    return { ...q, frame: dip.rect, workArea: dip.workArea };
  }

  function describeDip(hwnd) {
    const info = native.describe(hwnd);
    if (!info?.frame) return info;
    const dip = toDip(info.frame);
    return { ...info, frame: dip.rect, workArea: dip.workArea };
  }

  /**
   * Something fullscreen wants your attention. An exclusive-mode game or a
   * presentation keeps him off every window; an ordinary fullscreen app only
   * off the screen it fills, if that's his screen.
   */
  function busy() {
    const q = native.notificationState();
    if (q === native.QUNS.D3D_FULL_SCREEN || q === native.QUNS.PRESENTATION) return true;
    if (q !== native.QUNS.BUSY) return false;
    const fg = describeDip(native.foreground());
    if (!fg?.frame) return false;
    const screenOf = rect => d.screen.getDisplayMatching(rect);
    const disp = screenOf(fg.frame);
    const fills = fg.frame.width >= disp.bounds.width - 2 && fg.frame.height >= disp.bounds.height - 2;
    return fills && disp.id === screenOf(d.critter().getBounds()).id;
  }

  /** Every visible window he could see, top-first, judged. */
  function candidates({ except = null } = {}) {
    const me = self();
    const now = Date.now();
    const c = ctx();
    return native.topLevelWindows().filter(h => h !== me).map(h => {
      const info = describeDip(h);
      if (!info?.frame || info.minimized || info.cloaked) return null;
      const ok = h !== except && !(refused.get(h) > now) && perch.perchable(info, c);
      return { hwnd: h, frame: info.frame, workArea: info.workArea, exe: info.exe, ok };
    }).filter(Boolean);
  }

  function segments(opts) {
    const wins = candidates(opts);
    const exeOf = new Map(wins.map(w => [w.hwnd, w.exe]));
    return perch.visibleLedges(wins, d.geo()).map(s => ({ ...s, exe: exeOf.get(s.hwnd) }));
  }

  /** Ledges a flight can catch, in window coordinates (see motion.js stepFlight). */
  function flightLedges() {
    if (!allowed() || busy()) return [];
    return perch.flightLedges(segments({ except: flightFrom }), d.geo());
  }

  // ---------------------------------------------------------------- z-order and input

  function floatUp() {
    floating = true;
    native.float(self());
  }

  /** Back on the desktop layer (letting go of any window he was on). */
  function home() {
    detach();
    floating = false;
    d.pin();
  }

  // Perched, his transparent window overlaps the title bar under him, so it
  // lets the mouse through everywhere except over the crab himself (the
  // renderer says when the pointer is over him). Kept on top of your apps, it
  // overlaps them wherever he is, so it always does.
  const through = () => clickThrough || !!d.onTop?.();
  function applyMouse() {
    const c = d.critter();
    if (!c || c.isDestroyed()) return;
    c.setIgnoreMouseEvents(through() && !hovering, { forward: true });
  }
  function tellRenderer() {
    d.perchView({ up: !!attached, through: through() });
  }
  function setClickThrough(on) {
    clickThrough = on;
    if (!through()) hovering = false;
    applyMouse();
  }
  function hover(over) {
    if (hovering === !!over) return;
    hovering = !!over;
    if (through()) applyMouse();
  }

  /**
   * On top of your apps or back on the desktop (Settings, or a game came up):
   * the mouse follows, and up on a window he's restacked to match. On top he's
   * nobody's; otherwise the window's again, so he goes behind what covers it.
   */
  function layerChanged() {
    if (attached) {
      d.pin();
      if (!d.onTop?.() && native.ownBy(self(), attached.hwnd)) native.raiseAbove(self(), attached.hwnd);
    }
    setClickThrough(clickThrough);
    tellRenderer();
  }

  // ---------------------------------------------------------------- going up

  function sameScreen(seg) {
    const b = d.box();
    const half = d.geo().width / 2;
    return seg.x2 >= b.minX + half && seg.x1 <= b.maxX + half;
  }

  function goUp(seg, { eye = true } = {}) {
    const g = d.geo();
    const from = d.getPos();
    const first = readWindow(seg.hwnd);
    if (perch.classify(first, g) !== 'ok') return false;
    const cx = perch.pickSpot(seg, perch.centerOf(from, g));
    const rel = cx - first.frame.x;
    const target = () => {
      const r = readWindow(seg.hwnd);
      return perch.classify(r, g) === 'ok' ? perch.standAt(r.frame.x + rel, r.frame.y, g) : null;
    };
    const jump = () => {
      pendingUp = null;
      const motion = d.motion();
      const to = target();
      if (!to || motion.busy || d.dragging() || !allowed()) {
        if (!motion.busy) d.toRenderer(null, {}); // changed his mind: stop looking up
        return;
      }
      const at = d.getPos();
      floatUp();
      const going = motion.hop(target, {
        path: perch.hopPoint, ms: perch.hopDuration(at, to), flip: perch.hopFlips(at, to),
        onLand: () => attach(seg.hwnd, { how: 'hop' }),
      });
      if (!going) { home(); d.toRenderer(null, {}); } // the window went in the instant between
    };
    if (!eye) { jump(); return true; }
    d.toRenderer('eyeing', { dx: Math.sign(cx - perch.centerOf(from, g)) });
    pendingUp = setTimeout(jump, EYE_MS);
    return true;
  }

  /** Try for a window now: `hwnd` if given, else the one you're using (or his favourite). */
  function tryGoUp({ hwnd = null, eye = true, any = false } = {}) {
    // Helpers line up on the floor beside him, so not while they're out.
    if (!allowed() || attached || pendingUp || d.motion().busy || d.crew() > 0 || busy()) return false;
    const g = d.geo();
    const fromX = perch.centerOf(d.getPos(), g);
    const segs = segments().filter(sameScreen);
    const nearest = list => list.reduce((best, s) => {
      const dist = Math.abs(Math.min(Math.max(fromX, s.x1), s.x2) - fromX);
      return !best || dist < best.dist ? { s, dist } : best;
    }, null)?.s || null;
    const seg = hwnd ? nearest(segs.filter(s => s.hwnd === hwnd))
      : any ? nearest(segs)
        : perch.chooseLedge(segs, { foreground: native.foreground(), favourite: perch.favouriteOf(d.config.get('perchStats')), fromX });
    return seg ? goUp(seg, { eye }) : false;
  }

  /** The idle tick's roll of the dice. */
  function maybeGoUp() {
    if (!allowed() || attached) return false;
    const want = perch.wantsToPerch({ setting: setting(), temperament: d.temperament(), sinceLast: Date.now() - lastEnd });
    return want && tryGoUp();
  }

  // ---------------------------------------------------------------- up there

  function attach(hwnd, { how }) {
    const g = d.geo();
    const info = describeDip(hwnd);
    // Gone, changed, or perching was switched off while he was in the air.
    if (!allowed() || !info || !perch.perchable(info, ctx())) return fallOff('missed');
    const me = self();
    // Kept on top of your apps he stays there, up on a window too: only on the
    // desktop layer does he take the window as his owner to sit just above it.
    if (!d.onTop?.() && !native.ownBy(me, hwnd)) {
      // Elevated windows, mostly: Windows won't let a normal process own them.
      refused.set(hwnd, Date.now() + REFUSED_MS);
      return fallOff('refused');
    }
    if (!d.onTop?.()) native.raiseAbove(me, hwnd);
    floating = false;
    const ledge = perch.ledgeOf(info.frame, info.workArea, g);
    const cx = Math.min(Math.max(perch.centerOf(d.getPos(), g), ledge.x1), ledge.x2);
    const at = perch.standAt(cx, info.frame.y, g);
    d.place(at.x, at.y);
    const now = Date.now();
    attached = {
      hwnd, exe: info.exe, since: now, stayUntil: now + perch.stayFor(d.temperament()),
      ride: perch.startRide({ hwnd, frame: info.frame, cx, now, at }),
      read: { ...native.quick(hwnd), frame: info.frame, workArea: info.workArea }, lastRead: now,
      clingSince: 0, praised: false,
    };
    setClickThrough(true);
    tellRenderer();
    d.motion().ride(rideFrame);
    d.config.set({ perchStats: perch.recordPerch(d.config.get('perchStats'), info.exe) });
    d.stat('perched', { exe: info.exe });
    const leapt = how === 'fall' && flightFrom && flightFrom !== hwnd;
    if (how === 'thrown') d.stat('caught-on-window');
    if (leapt) d.stat('window-leap');
    d.speak(how === 'thrown' || leapt ? 'caught' : 'perch');
    flightFrom = null;
    d.refresh(); // anything held back while he was in the air (helpers) gets its turn
    return true;
  }

  /** Off the perch (the window is someone else's again). Doesn't move him. */
  function detach() {
    if (!attached) return null;
    const was = attached;
    attached = null;
    lastEnd = Date.now();
    d.stat('ride', { n: Math.round(was.ride.distance), exe: was.exe });
    setClickThrough(false);
    tellRenderer();
    return was;
  }

  function sendLean(v, now) {
    if (now - lean.at < LEAN_EVERY_MS || (Math.abs(v - lean.v) < 30 && !(v === 0 && lean.v !== 0))) return;
    lean = { at: now, v };
    d.toRenderer('lean', { vx: Math.round(v) });
  }

  function onRideEvent(e, now, speed) {
    const [what, why] = e.split(':');
    if (what === 'cling') { attached = { ...attached, clingSince: now }; d.toRenderer('cling', {}); }
    else if (what === 'settle' || what === 'walked') { attached = { ...attached, praised: false }; d.toRenderer('perched', {}); sendLean(0, now + LEAN_EVERY_MS); }
    else if (what === 'scramble') d.toRenderer('scramble', {});
    else if (what === 'coyote') {
      // Windows hides an owned window along with a minimized owner, so let go of
      // it first or the best bit happens out of sight.
      floatUp();
      if ((why === 'minimized' || why === 'hidden') && !d.veiled?.()) d.critter().showInactive();
      d.toRenderer('coyote', { why });
    }
    if (what === 'cling' || what === 'settle') return;
    if (attached?.ride.mode === 'cling' && !attached.praised && now - attached.clingSince > RIDE_PRAISE_MS && speed > RIDE_PRAISE_SPEED) {
      attached = { ...attached, praised: true };
      d.toRenderer('wheee', {});
      d.speak('ride');
    }
  }

  // One frame of riding, run by motion.ride().
  function rideFrame(dt, now) {
    if (!attached) return null;
    const g = d.geo();
    const busy = attached.ride.mode !== 'sit' || !!attached.ride.coyote;
    if (busy || now - attached.lastRead >= READ_IDLE_MS) attached = { ...attached, read: readWindow(attached.hwnd), lastRead: now };
    const r = perch.rideStep(attached.ride, attached.read, now, dt, g);
    attached = { ...attached, ride: r.state };
    const speed = Math.abs(r.lean || 0);
    for (const e of r.events) onRideEvent(e, now, speed);
    if (!r.events.length) onRideEvent('tick', now, speed);
    if (r.release) return { launch: letGo(r.release, r.events) };
    if (attached.ride.mode === 'cling') sendLean(r.lean, now);
    return { place: r.place, calm: !!r.settled && !attached.ride.coyote };
  }

  function letGo(release, events) {
    const was = detach();
    flightFrom = was?.hwnd || null;
    floatUp();
    const why = events.find(e => e.startsWith('letgo:')) ? 'flung' : events.includes('pop') ? 'popped' : 'fell';
    if (why === 'flung') {
      d.stat('shaken', { exe: was?.exe || null });
      if (!release.dizzy) d.speak('shaken');
    }
    if (why === 'popped') d.speak('pop');
    if (why === 'fell') d.speak('dropped');
    return { ...release, why };
  }

  /** Nothing to stand on: fall from where he is. */
  function fallOff(why) {
    detach();
    floatUp();
    d.motion().launch({ vx: 0, vy: 60 }, { style: 'fall', why });
    return false;
  }

  /** Hop down and go home (asked to, got bored, or Shellby needs the room). */
  function leave(reason = 'bored') {
    clearTimeout(pendingUp);
    pendingUp = null;
    if (!attached) return false;
    const from = d.getPos();
    const b = d.box();
    const homeAt = d.homePos();
    const onScreen = homeAt && homeAt.x >= b.minX - 4 && homeAt.x <= b.maxX + 4 && homeAt.y <= b.floorY + 4;
    const near = onScreen && Math.abs(homeAt.x - from.x) <= HOP_HOME_MAX;
    const dir = onScreen ? Math.sign(homeAt.x - from.x) || 1 : 1;
    const to = near ? { x: homeAt.x, y: homeAt.y } : { x: Math.min(Math.max(from.x + dir * 140, b.minX), b.maxX), y: b.floorY };
    detach();
    floatUp();
    clearTimeout(afterLand);
    const going = d.motion().hop(() => to, {
      path: perch.hopPoint, ms: perch.hopDuration(from, to), flip: perch.hopFlips(from, to), crouchMs: 220,
      onLand: () => {
        home();
        d.refresh();
        if (!near) afterLand = setTimeout(walkHome, 500);
      },
    });
    if (!going) { home(); d.refresh(); }
    return reason;
  }

  function walkHome() {
    afterLand = null;
    const motion = d.motion();
    const at = d.getPos();
    const to = d.homePos();
    if (!to || motion.busy || d.dragging() || attached) return;
    // Home is somewhere else on the floor: walk. Anywhere else (another
    // screen, or up on the desktop where you left him): hop.
    if (Math.abs(to.y - at.y) <= 6) {
      if (motion.walkTo(to.x, WALK_HOME_SPEED, { kind: 'walk-home' })) return;
    } else {
      floatUp();
      const going = motion.hop(() => to, { path: perch.hopPoint, ms: perch.hopDuration(at, to), flip: perch.hopFlips(at, to), onLand: () => { home(); d.refresh(); } });
      if (!going) home();
    }
  }

  // ---------------------------------------------------------------- what main tells us

  /** A move finished. True when it was ours to deal with (main leaves it alone). */
  function onSettled(kind, info = {}) {
    if (kind === 'flight') {
      if (info.ledge) {
        // Caught a title bar. If it turns out he can't stay there, attach()
        // sends him on down, so either way the landing is ours, not main's.
        if (info.why === 'thrown') d.stat('thrown');
        const caught = attach(info.ledge, { how: info.why === 'thrown' ? 'thrown' : 'fall' });
        if (caught && info.dizzy) { d.toRenderer('dizzy', { ms: DIZZY_MS }); d.speak('dizzy', { force: true }); }
        return true;
      }
      flightFrom = null;
      home();
      if (info.why === 'thrown') return false; // an ordinary throw: main saves the new spot
      lastEnd = Date.now();
      d.refresh(); // helpers that were waiting for him to come down
      if (info.dizzy) { d.toRenderer('dizzy', { ms: DIZZY_MS }); d.speak('dizzy', { force: true }); }
      clearTimeout(afterLand);
      afterLand = setTimeout(walkHome, info.dizzy ? DIZZY_MS + 200 : 900);
      return true;
    }
    if (kind === 'walk-home') { home(); d.refresh(); return true; }
    return kind === 'hop';
  }

  /**
   * Someone else stopped the motion: a drag, the crew arriving, a reset, a
   * setting. Whatever he was doing (riding, hopping, falling, walking home),
   * he's back on the desktop layer and not on anyone's window; a drag then
   * lifts him straight back up (grabbed).
   */
  function onInterrupted() {
    clearTimeout(pendingUp);
    pendingUp = null;
    clearTimeout(afterLand);
    afterLand = null;
    flightFrom = null;
    home();
  }

  /** Picked up: he's in your hand, above everything, until you let go. */
  function grabbed() {
    clearTimeout(pendingUp);
    pendingUp = null;
    clearTimeout(afterLand); // a walk home queued from his last landing would undo where you put him
    afterLand = null;
    flightFrom = null;
    detach();
    floatUp();
  }

  /** Put down without a throw: onto a title bar if he's over one, else the desktop. */
  function dropped() {
    if (allowed()) {
      const seg = perch.ledgeUnder(d.getPos(), segments(), d.geo());
      if (seg) {
        // Perched, or (a window that won't have him) already falling off it:
        // either way this isn't a new spot for main to save as his home.
        if (attach(seg.hwnd, { how: 'dropped' }) || d.motion().busy) return true;
      }
    }
    home();
    return false;
  }

  /** The idle tick while he's up: habits, walks along the bar, and when to go home. */
  function idleTick({ idle, guarding, quiet = false }) {
    if (!attached) return;
    if (!allowed() || busy()) return void leave('off');
    if (!idle || guarding || attached.ride.mode !== 'sit') return;
    if (Date.now() >= attached.stayUntil) return void leave('bored');
    const roll = Math.random();
    if (roll < 0.3) {
      const next = perch.strollOnLedge(attached.ride, attached.read, d.geo());
      if (next !== attached.ride) {
        attached = { ...attached, ride: next };
        d.toRenderer('walking', { dir: Math.sign(next.walkTo - next.offset) });
      }
    } else if (quiet) {
      // 'quiet' keeps his habits to himself, on the floor and up here alike.
    } else if (roll < 0.55) d.bit('sit', PERCH_BITS_MS);
    else if (roll < 0.75) d.bit('peer', PERCH_BITS_MS / 2);
  }

  /** For the right-click menu. */
  function menuItems() {
    if (attached) {
      const exe = attached.exe;
      return [
        { label: 'Hop down', click: () => leave('asked') },
        exe && { label: `Not on ${perch.appName(exe)}`, click: () => { d.config.set({ perchIgnore: [...ignore(), exe].slice(-50) }); leave('asked'); } },
      ].filter(Boolean);
    }
    return allowed() ? [{ label: 'Climb onto a window', click: () => tryGoUp({ any: true, eye: false }) }] : [];
  }

  const isUp = () => !!attached;
  const isAway = () => !!attached || floating;
  const view = () => ({
    up: !!attached, floating, hwnd: attached?.hwnd || null, exe: attached?.exe || null, mode: attached?.ride.mode || null, clickThrough,
    frame: attached?.read?.frame || null,
    owner: native.ownerOf(self()),
  });

  /** Dev/e2e only: what he can see and why each window is or isn't a perch. */
  const debug = () => ({
    allowed: allowed(), busy: busy(), box: d.box(), geo: d.geo(),
    display: (() => {
      const disp = d.screen.getDisplayMatching(d.critter().getBounds());
      return { dip: disp.bounds, phys: d.screen.dipToScreenRect(null, disp.bounds) };
    })(),
    windows: candidates().map(w => ({ hwnd: w.hwnd, exe: w.exe, ok: w.ok, frame: w.frame })),
    segments: segments().map(s => ({ ...s, sameScreen: sameScreen(s) })),
  });

  function dispose() {
    clearTimeout(pendingUp);
    clearTimeout(afterLand);
  }

  return {
    isUp, isAway, view, maybeGoUp, tryGoUp, leave, idleTick, onSettled, onInterrupted, grabbed, dropped,
    flightLedges, menuItems, hover, layerChanged, home, dispose, debug,
    // Shared with climbing.js (home from the foot of a wall) and pranks.js (a fullscreen app means behave).
    walkHome, fullscreen: busy,
  };
}

module.exports = { createPerching };
