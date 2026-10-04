// Mischief, carried out (the rules are in mischief.js). Strictly opt-in:
// with Settings → Shellby → Mischief on Off, as it starts, nothing here runs.
//
//   pinch  your cursor lingers by him: he eyes it, snaps it up and tugs it a
//          few pixels toward himself for half a second. Pull and he lets go.
//   nudge  up on a window, he braces and gives it a shove (it stays on screen).
//   note   he walks off the edge of the screen and hauls a little note back
//          in for you, or digs one up if there's no edge to go off.
//   tracks sandy footprints where he walks (drawn by floor.js).
//
// Every step checks again that it's still fine: a click, a call, focus time,
// a fullscreen app or a task starting, and he behaves.
const mischief = require('./mischief');
const climb = require('./climb');

const TICK_MS = 250;
const VK_ESCAPE = 0x1B;
const FRAME_MS = 16;
const NOTE_SIZE = Object.freeze({ width: 210, height: 150 });

/**
 * deps: {
 *   config, screen, native, capture, motion(), getPos(), place(x, y), geo(),
 *   clawPoint() -> { x, y } (DIPs), status() -> 'idle' | 'working' | ...,
 *   guarding(), onCall(), locked(), playing(), dragging(), crew(),
 *   perching: { isUp, view, fullscreen }, climbingBusy(), walkHome(),
 *   speak(occasion, opts), bit(name, ms, dir), toRenderer(kind, info), stat(event),
 *   makeNote() -> BrowserWindow, pinWindow(win), systemIdleSeconds()
 * }
 */
function createPranks(d) {
  let tick = null;
  let nearSince = 0;
  let running = null;  // { kind, timers: [], frame }
  let haul = null;     // { side, note, inX, phase, timer }: a note on its way in
  let homeTimer = null; // the walk home after a note, or after one was called off
  const notes = new Set();
  let recentNotes = [];
  let devIgnore = new Set(); // dev/e2e only: rails a test has said to look past (a call, a fullscreen app)

  const level = () => mischief.levelOf(d.config.get('mischief'));
  const enabled = () => mischief.prankSet(d.config.get('mischiefPranks'));
  const log = () => d.config.get('mischiefLog');

  // ---------------------------------------------------------------- may he?

  const reason = () => {
    const r = rails();
    return r && !devIgnore.has(r) ? r : null;
  };
  const rails = () => mischief.blocked({
    level: level(), capture: d.capture, guarding: d.guarding(), onCall: d.onCall(),
    fullscreen: d.perching.fullscreen(), locked: d.locked(),
    working: d.status() === 'working' || d.status() === 'asking', asleep: d.status() === 'sleeping',
    playing: d.playing(), dragging: d.dragging(), buttonsDown: d.native.mouseDown(),
    pausedUntil: d.config.get('mischiefPause') || 0, now: Date.now(),
  });

  // Free to start something: not mid-move (sitting on a window is fine), not
  // climbing, no helpers beside him.
  function free() {
    const m = d.motion();
    const sitting = d.perching.isUp() && d.perching.view().mode === 'sit';
    return !running && !haul && d.crew() === 0 && !d.climbingBusy() && (!m.busy || sitting);
  }

  function onFloor() {
    if (d.perching.isUp() || d.motion().busy) return false;
    const g = d.geo(), p = d.getPos();
    const wa = d.screen.getDisplayNearestPoint({ x: p.x + g.width / 2, y: p.y + g.height / 2 }).workArea;
    return climb.onFloorAt(p, wa, g);
  }

  // ---------------------------------------------------------------- the loop

  function check() {
    const now = Date.now();
    if (reason()) { nearSince = 0; return; }
    const near = mischief.cursorNear(d.screen.getCursorScreenPoint(), d.clawPoint());
    nearSince = near ? nearSince || now : 0;
    if (!free() || !mischief.due(log(), level(), now)) return;
    const kind = mischief.choosePrank({
      enabled: enabled(),
      cursorNear: !!nearSince && now - nearSince >= mischief.PINCH.lingerMs,
      perched: d.perching.isUp() && d.perching.view().mode === 'sit',
      onFloor: onFloor(),
      notesOut: notes.size,
    });
    if (kind) start(kind);
  }

  function start(kind) {
    const go = { pinch, nudge, note: fetchNote }[kind];
    if (!go || !go()) return false;
    d.config.set({ mischiefLog: mischief.played(log(), level(), Date.now()) });
    return true;
  }

  const later = (ms, fn) => { const t = setTimeout(fn, ms); running?.timers.push(t); return t; };
  function end() {
    if (!running) return;
    running.timers.forEach(clearTimeout);
    clearInterval(running.frame);
    running = null;
  }

  // ---------------------------------------------------------------- pinch

  function pinch() {
    if (!d.native.available()) return false; // no hold on the cursor to be had: no pretending
    const claw = d.clawPoint();
    const c0 = d.screen.getCursorScreenPoint();
    if (!claw || !mischief.cursorNear(c0, claw)) return false;
    const dir = c0.x < claw.x ? -1 : 1;
    running = { kind: 'pinch', timers: [], frame: null };
    d.bit('squint', mischief.PINCH.windupMs, dir);
    later(mischief.PINCH.windupMs, () => {
      const start = d.screen.getCursorScreenPoint();
      if (reason() || !mischief.cursorNear(start, d.clawPoint())) { end(); return; } // you moved on, or it stopped being ok
      d.bit('pinch', mischief.PINCH.holdMs + 300, dir);
      const began = Date.now();
      let held = start;
      running.frame = setInterval(() => {
        const at = d.screen.getCursorScreenPoint();
        // A click, Esc, a pull, or anything that means behave: he lets go at once.
        if (reason() || d.native.keyDown(VK_ESCAPE) || mischief.yanked(held, at)) return letGo(true);
        const u = (Date.now() - began) / mischief.PINCH.holdMs;
        if (u >= 1) return letGo(false);
        held = mischief.tugPoint(start, d.clawPoint() || start, u);
        const phys = d.screen.dipToScreenPoint(held);
        d.native.setCursor(phys.x, phys.y);
      }, FRAME_MS);
    });
    const letGo = yanked => {
      end();
      d.speak(yanked ? 'yanked' : 'pinched', { force: true });
      d.stat('pinched', { yanked });
    };
    return true;
  }

  // ---------------------------------------------------------------- nudge

  function nudge() {
    const v = d.perching.view();
    if (!v.up || !v.hwnd || !v.frame) return false;
    if ((d.systemIdleSeconds() ?? 0) < mischief.NUDGE.idleSec) return false; // you're using it: not now
    const disp = d.screen.getDisplayMatching(v.frame);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const dx = mischief.nudgeFor(v.frame, disp.workArea, dir);
    if (!dx) return false;
    const info = d.native.describe(v.hwnd);
    if (!info?.rect || info.maximized || info.minimized) return false; // a maximized or snapped-full window stays put
    const rect = info.rect;
    running = { kind: 'nudge', timers: [], frame: null };
    d.bit('shove', 1200, Math.sign(dx));
    later(380, () => {
      if (reason()) { end(); return; }
      const began = Date.now();
      let last = rect.left; // where he last put it: anywhere else, and you've taken hold of it
      running.frame = setInterval(() => {
        const now = d.native.describe(v.hwnd)?.rect;
        const still = now && now.left === last && now.top === rect.top && d.perching.isUp() && d.perching.view().hwnd === v.hwnd;
        if (!still || reason()) { end(); return; } // grabbed, moved, snapped, closed, or he's off it: hands off
        const u = (Date.now() - began) / mischief.NUDGE.ms;
        const off = Math.round(dx * mischief.shoveAt(Math.min(1, u)) * disp.scaleFactor);
        last = rect.left + off;
        d.native.move(v.hwnd, last, rect.top);
        if (u >= 1) {
          end();
          d.speak('shoved', { force: true });
          d.stat('nudged');
        }
      }, FRAME_MS);
    });
    return true;
  }

  // ---------------------------------------------------------------- a note

  function makeNote(at, look, { rise = false } = {}) {
    const w = d.makeNote();
    w.setBounds({ x: Math.round(at.x), y: Math.round(at.y), ...NOTE_SIZE });
    notes.add(w);
    w.on('closed', () => notes.delete(w));
    const show = () => {
      if (w.isDestroyed()) return;
      w.webContents.send('note:look', look);
      if (rise) w.webContents.send('note:settle', { rise: true }); // dug up: it comes up out of the sand
      w.showInactive();
      d.pinWindow(w);
    };
    if (w.webContents.isLoading()) w.once('ready-to-show', show); else show();
    return w;
  }

  function noteLook() {
    const n = mischief.pickNote(Date.now(), Math.random, recentNotes);
    recentNotes = [...recentNotes, n.text].slice(-8);
    return n;
  }

  // Where the note sits relative to him while he hauls it: behind him, by the
  // edge it came from, at his claw's height.
  function noteBeside(side) {
    const p = d.getPos(), g = d.geo();
    const cx = p.x + g.width / 2;
    const y = p.y + g.height - g.foot - NOTE_SIZE.height + 6;
    return side === 'left' ? { x: cx - g.half - 6 - NOTE_SIZE.width, y } : { x: cx + g.half + 6, y };
  }

  function fetchNote() {
    if (!onFloor()) return false;
    const g = d.geo(), p = d.getPos();
    const disp = d.screen.getDisplayNearestPoint({ x: p.x + g.width / 2, y: p.y + g.height / 2 });
    const wa = disp.workArea;
    const e = climb.edgesOf(disp, d.screen.getAllDisplays());
    const cx = p.x + g.width / 2;
    const sides = ['left', 'right'].filter(s => e[s]).sort((a, b) => Math.abs(climb.cornerX(a, wa, g) - cx) - Math.abs(climb.cornerX(b, wa, g) - cx));
    const side = sides[0];
    if (!side) return digNote();
    const outX = side === 'left' ? wa.x - g.width : wa.x + wa.width;
    const inward = 170 + Math.random() * 180 + NOTE_SIZE.width;
    const inX = Math.round(side === 'left' ? wa.x + inward - g.width / 2 : wa.x + wa.width - inward - g.width / 2);
    haul = { side, note: null, inX, phase: 'out', wa };
    d.speak('noteOff');
    if (!d.motion().walkTo(outX, mischief.NOTE.walkSpeed, { kind: 'note-out' })) { haul = null; return false; }
    return true;
  }

  function haulIn() {
    if (!haul) return;
    const timer = setTimeout(() => {
      if (!haul || haul.phase !== 'waiting') return;
      if (reason()) return void abandon();
      const note = makeNote(noteBeside(haul.side), noteLook());
      haul = { ...haul, note, phase: 'in' };
      const p = d.getPos();
      const dir = Math.sign(haul.inX - p.x);
      let x = p.x;
      d.toRenderer('hauling', { dir: -dir }); // facing the note, walking backwards
      d.motion().ride(dt => {
        if (!haul || haul.phase !== 'in') { d.motion().halt(); return null; } // called off: stop where he is
        const step = mischief.NOTE.haulSpeed * Math.min(60, dt) / 1000;
        const done = Math.abs(haul.inX - x) <= step;
        x = done ? haul.inX : x + dir * step;
        if (!haul.note.isDestroyed()) {
          const at = noteBeside(haul.side);
          haul.note.setPosition(Math.round(at.x), Math.round(at.y));
        }
        if (done) { delivered(); return null; }
        return { place: { x: Math.round(x), y: p.y } };
      });
    }, mischief.NOTE.offscreenMs);
    haul = { ...haul, phase: 'waiting', timer };
  }

  function delivered() {
    const note = haul?.note;
    haul = null;
    d.motion().halt();
    d.toRenderer('still', {});
    if (note && !note.isDestroyed()) note.webContents.send('note:settle');
    d.bit('wave', 1400);
    d.speak('note', { force: true });
    d.stat('note-delivered');
    goHome(1500);
  }

  // Back to his spot, unless something else has him by then (you, a climb, another move).
  function goHome(ms) {
    clearTimeout(homeTimer);
    homeTimer = setTimeout(() => {
      homeTimer = null;
      if (!d.dragging() && !d.motion().busy && !d.climbingBusy() && !haul) d.walkHome();
    }, ms);
  }

  // No edge to go off (a middle screen): he digs one up instead.
  function digNote() {
    running = { kind: 'dig', timers: [], frame: null };
    d.bit('dig', 2600);
    later(2300, () => {
      end();
      if (reason()) return;
      const at = noteBeside(Math.random() < 0.5 ? 'left' : 'right');
      makeNote(at, noteLook(), { rise: true });
      d.speak('note', { force: true });
      d.stat('note-delivered');
    });
    return true;
  }

  // Interrupted on the way (dragged off, a task started): a note still off the
  // screen goes with him; one already on it stays where it got to.
  function abandon({ dragged = false } = {}) {
    if (!haul) return;
    const { note, wa, timer, phase } = haul;
    haul = null;
    clearTimeout(timer);
    // Still walking out or hauling in: stop him where he is (halt, not stop, so
    // nobody else is told they were interrupted by something they started).
    if ((phase === 'out' || phase === 'in') && d.motion().busy) d.motion().halt();
    if (note && !note.isDestroyed()) {
      const [nx] = note.getPosition();
      if (nx + NOTE_SIZE.width < wa.x + 20 || nx > wa.x + wa.width - 20) note.close();
      else note.webContents.send('note:settle');
    }
    // Left off the edge of the screen by whatever cut in: he comes back.
    if (dragged) clearTimeout(homeTimer); else goHome(400);
  }

  // ---------------------------------------------------------------- what main tells us

  function onSettled(kind) {
    if (kind === 'note-out') { if (!haul) return false; haulIn(); return true; } // called off on the way: main settles him
    return false;
  }

  function onInterrupted({ dragged = false } = {}) {
    end();
    if (dragged) clearTimeout(homeTimer);
    abandon({ dragged });
  }

  /** Picked up mid-prank: whatever he was up to stops, and you have him. */
  const grabbed = () => onInterrupted({ dragged: true });

  /** Start or stop the loop to match the setting. Called at boot and when it changes. */
  function sync() {
    const on = level() !== 'off' && !d.capture;
    if (on && !tick) {
      d.config.set({ mischiefLog: mischief.arm(log(), Date.now()) });
      tick = setInterval(check, TICK_MS);
    } else if (!on && tick) {
      clearInterval(tick);
      tick = null;
      onInterrupted();
      nearSince = 0;
    }
  }

  /** "Do something cheeky": now, if he can. False when he has nothing that fits. */
  function now() {
    if (level() === 'off' || reason() || !free()) return false;
    const kind = mischief.choosePrank({
      enabled: enabled(),
      cursorNear: mischief.cursorNear(d.screen.getCursorScreenPoint(), d.clawPoint()),
      perched: d.perching.isUp() && d.perching.view().mode === 'sit',
      onFloor: onFloor(),
      notesOut: notes.size,
    });
    return kind ? start(kind) : false;
  }

  /** Dev/e2e only: this prank now, if he may (no dice, no schedule), looking past the rails named in `ignore`. */
  function force(kind, { ignore = [] } = {}) {
    devIgnore = new Set(ignore);
    if (level() === 'off' || reason() || !free()) return false;
    return start(kind);
  }

  function behave(ms) {
    d.config.set({ mischiefPause: Date.now() + ms });
    onInterrupted();
    d.speak('behave', { force: true });
  }

  function menuItems() {
    if (level() === 'off') return [];
    const paused = (d.config.get('mischiefPause') || 0) > Date.now();
    return [
      { label: 'Do something cheeky', enabled: !paused, click: () => { if (!now()) d.speak('noPrank', { force: true }); } },
      paused
        ? { label: 'Mischief back on', click: () => d.config.set({ mischiefPause: 0 }) }
        : { label: 'Behave for an hour', click: () => behave(60 * 60 * 1000) },
      notes.size ? { label: `Tidy away notes (${notes.size})`, click: clearNotes } : null,
    ].filter(Boolean);
  }

  function clearNotes() { for (const w of [...notes]) if (!w.isDestroyed()) w.close(); }

  const busy = () => !!running || !!haul;
  const isNote = wc => [...notes].some(w => !w.isDestroyed() && w.webContents === wc);
  const view = () => ({ level: level(), pranks: enabled(), notes: notes.size, running: running?.kind || (haul ? 'note' : null), blocked: reason(), free: free(), log: mischief.logOf(log(), Date.now()) });

  function dispose() {
    if (tick) clearInterval(tick);
    tick = null;
    onInterrupted({ dragged: true }); // quitting: nowhere to walk home to
    clearNotes();
  }

  const closeNote = wc => { for (const w of notes) if (!w.isDestroyed() && w.webContents === wc) w.close(); };

  return { sync, onSettled, onInterrupted, grabbed, menuItems, busy, isNote, closeNote, now, force, view, dispose };
}

module.exports = { createPranks, NOTE_SIZE };
