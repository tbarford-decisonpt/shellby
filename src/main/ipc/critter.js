// The crab's own window: dragging, throwing, poking and petting him, and the
// dev/e2e-only handlers that drive him (rooms.js decides which screens are open,
// quests.js which tricks he has shown you).
// Kept out of main.js, which only wires it up.
const { app, screen } = require('electron');
const focus = require('../focus');
const native = require('../native-windows');
const quests = require('../quests');
const rooms = require('../rooms');
const voice = require('../voice');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerCritterIpc(ipcMain, d) {
  // ---- critter
  // The grab offset is fixed at drag start; moves follow the real cursor (the
  // renderer's screenX lags and rescales while its own window moves under it).
  // Recent cursor samples tell a drop from a throw (see motion.js).
  /** @type {{ dx: number, dy: number } | null} where in the crab you took hold of him */
  let grab = null;
  let samples = [];
  ipcMain.on('critter:drag-start', () => {
    d.life?.cancel();
    // Mid-game: found if he was hiding, and either way he stays where you put him.
    d.playtime?.grabbed();
    d.pranks?.grabbed(); // first: whatever he was up to stops, and a note on its way in stays put
    d.climbing?.grabbed(); // ...and off any wall, upright in your hand rather than falling from it
    d.motion?.stop();
    d.perching?.grabbed(); // in your hand he's above every window, so you can see where he'll go
    const c = screen.getCursorScreenPoint();
    const [x, y] = d.critter.getPosition();
    grab = { dx: c.x - x, dy: c.y - y };
    samples = [{ x: c.x, y: c.y, t: Date.now() }];
    d.dragging = true;
    d.wake();
  });
  ipcMain.on('critter:drag-move', () => {
    if (!grab) return;
    const c = screen.getCursorScreenPoint();
    d.placeCritter(c.x - grab.dx, c.y - grab.dy);
    samples = [...samples.slice(-11), { x: c.x, y: c.y, t: Date.now() }];
  });
  ipcMain.on('critter:drag-end', () => {
    grab = null;
    d.dragging = false;
    const c = screen.getCursorScreenPoint();
    if (d.motion?.release([...samples, { x: c.x, y: c.y, t: Date.now() }])) return; // he lands, then saves
    if (d.perching?.dropped()) return; // put down on a title bar: he perches there, and home stays home
    if (d.climbing?.dropped()) return; // put down right by the side of the screen: he grabs hold of it
    d.saveCritterPos();
    d.settleCritter();
  });
  // Perched, his window lets the mouse through except over the crab himself.
  ipcMain.on('critter:hit', (_e, over) => d.perching?.hover(!!over));
  // The floor strip lets the mouse through except over a pal (floor.js).
  ipcMain.on('floor:hit', (_e, over) => d.floor?.hover(!!over));
  let lastPoke = 0;
  ipcMain.on('floor:poke', () => {
    if (Date.now() - lastPoke < 500) return; // a click is a hello, not a counter to run up
    lastPoke = Date.now();
    d.stat('pal-poked');
  });
  // A note he dragged in, crumpled up and thrown away (pranks.js).
  ipcMain.on('note:close', e => d.pranks?.closeNote(e.sender));
  // Rubbing the mouse back and forth over him (see critter.js).
  let lastPet = 0;
  ipcMain.on('critter:pet', () => {
    if (Date.now() - lastPet < 1500) return;
    lastPet = Date.now();
    d.stat('petted');
    d.life?.onPet();
    if (['idle', 'sleeping'].includes(d.lastStatus.state)) { d.lastActivity = Date.now(); d.flashState('petted', 2600); }
  });
  ipcMain.on('critter:reset-position', () => d.resetCritterPos());
  // ---- rooms: which screens are open yet (rooms.js)
  ipcMain.handle('rooms:get', () => d.roomsPanelView());
  ipcMain.handle('rooms:open', (_e, id) => d.setRooms(rooms.openRoom(d.config.get('rooms'), String(id || ''))));
  ipcMain.handle('rooms:all', () => d.setRooms(rooms.openAll(d.config.get('rooms'))));
  // ---- quests: the features worth finding, and the chat's card for the next one (quests.js)
  ipcMain.handle('quests:get', () => d.questsPanelView());
  ipcMain.handle('quests:hide', (_e, hidden) => d.setQuests(quests.setHidden(d.config.get('quests'), hidden === true)));

  // Dev/e2e only: throw him, send him for a stroll, finish a focus session now,
  // make him say something or do one of his idle habits.
  if (!app.isPackaged && process.env.SHELLBY_MOTION_TEST === '1') {
    ipcMain.handle('dev:say', (_e, occasion) => d.speak(String(occasion || ''), { force: true }));
    ipcMain.handle('dev:bit', (_e, bit) => {
      const chosen = voice.BITS.includes(bit) ? bit : voice.pickBit(voice.normalize(d.config.get('voice')).seed);
      d.send(d.critter, 'critter:bit', { bit: chosen });
      return chosen;
    });
    ipcMain.handle('dev:temperament', () => voice.temperamentOf(voice.normalize(d.config.get('voice')).seed));
    // His life between tasks (life.js): a scene by id, a dig, a moment of your day, a new day.
    ipcMain.handle('dev:scene', (_e, id) => d.life?.playScene(String(id || '')) || null);
    ipcMain.handle('dev:life', (_e, { what, ...args } = {}) => {
      if (!d.life) return null;
      if (what === 'dig') return d.life.dig({ manual: true })?.id || null;
      if (what === 'event') return d.life.event(args.event), true;
      if (what === 'day') return d.life.newDayForTest(), true;
      if (what === 'call') return d.life.callForTest(args.on), true;
      if (what === 'needs') return d.life.needsForTest(args); // { meters, pantry }
      if (what === 'nap') return d.life.napForTest(Math.min(Math.max(Number(args.ms) || 4000, 500), 60000));
      return d.life.view();
    });
    ipcMain.handle('dev:quest', (_e, id) => (d.questDone(String(id || '')), d.questsPanelView()));
    ipcMain.handle('dev:throw', (_e, { vx = 0, vy = 0 } = {}) => {
      const t = Date.now();
      return d.motion.release([{ x: 0, y: 0, t: t - 50 }, { x: vx * 0.05, y: vy * 0.05, t }]);
    });
    ipcMain.handle('dev:stroll', () => d.motion.stroll((d.config.get('critterPos')?.x ?? d.critter.getPosition()[0]) - d.crewExtra()));
    ipcMain.handle('dev:focus-end', () => {
      const s = focus.normalize(d.config.get('focus'));
      if (s) { d.config.set({ focus: { ...s, endsAt: Date.now() - 1 } }); d.advanceFocus(); }
      return d.focusView();
    });
    ipcMain.handle('dev:critter-pos', () => d.critter.getBounds());
    // Perching: go up on a given window now (no dice roll, no look-up), see where he is, or hop down.
    ipcMain.handle('dev:perch', (_e, { hwnd = null, leave = false } = {}) => {
      if (leave) return d.perching.leave('asked');
      return d.perching.tryGoUp({ hwnd: Number.isInteger(hwnd) ? hwnd : null, eye: false, any: !hwnd });
    });
    ipcMain.handle('dev:perch-state', (_e, { debug = false } = {}) => ({ ...d.perching.view(), self: native.hwndOf(d.critter), bounds: d.critter.getBounds(), motion: d.motion.kind, ...(debug ? { debug: d.perching.debug() } : {}) }));
    // The edges of the screen, mischief and the floor: start a climb (or come down), force a prank, look at it all.
    ipcMain.handle('dev:climb', (_e, { side = null, leave = false } = {}) => (leave ? d.climbing.leave() : d.climbing.tryClimb({ side: ['left', 'right'].includes(side) ? side : null })));
    ipcMain.handle('dev:prank', (_e, { kind, ignore = [] } = {}) => d.pranks.force(kind, { ignore: Array.isArray(ignore) ? ignore.filter(x => typeof x === 'string') : [] }));
    ipcMain.handle('dev:edges', () => ({ climb: d.climbing.view(), mischief: d.pranks.view(), floor: d.floor.view(), bounds: d.critter.getBounds(), motion: d.motion.kind, geo: d.critterGeo() }));
  }
}

module.exports = { registerCritterIpc };
