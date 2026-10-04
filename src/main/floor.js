// The floor beside him: one transparent strip along the bottom of his screen,
// on the desktop layer like he is, where his colony lives and his footprints
// go. Pals (Settings → Shellby → Colony) are little crabs of his own who hang
// out with him between tasks: they wander, dig, nap when he naps, gather under
// him when he climbs, and cheer when a task goes well. Footprints are mischief
// (see mischief.js): sandy tracks wherever he walks, fading as the tide comes in.
//
// One window rather than one per pal: a transparent window costs a renderer
// and a GPU surface each, and pals never leave the floor. The strip lets the
// mouse through everywhere but over a pal (the renderer says when).
const mischief = require('./mischief');
const { ON_FLOOR } = require('./climb');

const COLONY_MAX = 5;
const PAL_SCALE = 0.55;   // of Shellby's size; helpers are 0.5
const FEED_MS = 120;      // how often his whereabouts are read for the pals and the tracks
const NAMES = Object.freeze(['Pinch', 'Kelp', 'Barnacle', 'Bubbles', 'Sandy']);
const HUES = Object.freeze([145, 250, 60, 300, 200]); // matches the helpers' (critter.js HUES)

const colonySize = v => (Number.isInteger(v) && v >= 0 ? Math.min(v, COLONY_MAX) : 0);

/** The pals, by place in the colony: stable names and colours. */
const roster = n => Array.from({ length: colonySize(n) }, (_, i) => ({ id: `pal-${i}`, name: NAMES[i], hue: HUES[i] }));

/** Footprints are on: mischief is, and you haven't switched tracks off. */
const tracksOn = config => mischief.levelOf(config.get('mischief')) !== 'off' && mischief.prankSet(config.get('mischiefPranks')).tracks;

/**
 * deps: {
 *   config, screen, capture, makeWindow() -> BrowserWindow, pin(win), lower(win),
 *   critterBounds(), geo() -> { width, height, foot, half }, px(),
 *   skin() -> the critter:skin payload, status() -> his state, away() -> 'perch' | 'climb' | null,
 *   calm(), hidden() -> off the screen with him (behind a game), veil(win, hide)
 * }
 */
function createFloor(d) {
  let win = null;
  let feed = null;
  let sent = '';
  let shown = '';
  let ready = false; // shown once; before that, ready-to-show decides

  const wanted = () => !d.capture && (colonySize(d.config.get('colony')) > 0 || tracksOn(d.config));
  const height = () => Math.round(d.px() * 13 * PAL_SCALE) + 64;

  function displayOf() {
    const b = d.critterBounds(), g = d.geo();
    // His own spot, not the crew-widened window's left edge: the right-hand slot is him.
    return d.screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width - g.width / 2), y: Math.round(b.y + b.height / 2) });
  }

  function place() {
    if (!win || win.isDestroyed()) return;
    const wa = displayOf().workArea;
    const want = { x: wa.x, y: wa.y + wa.height - height(), width: wa.width, height: height() };
    const key = JSON.stringify(want);
    if (key === shown) return;
    shown = key;
    win.setBounds(want);
  }

  function create() {
    win = d.makeWindow();
    shown = '';
    sent = '';
    ready = false;
    place();
    win.setIgnoreMouseEvents(true, { forward: true });
    const w = win;
    w.once('ready-to-show', () => {
      if (w.isDestroyed()) return;
      ready = true;
      if (!d.hidden()) w.showInactive();
      d.pin(w);
      lower();
    });
    w.webContents.on('did-finish-load', setup); // and again after a reload, which forgets it all
    w.on('closed', () => { if (win === w) { win = null; stopFeed(); } });
  }

  // What the strip needs to draw: his look and the colony. Again after a reload.
  function setup() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('floor:skin', { ...d.skin(), scale: PAL_SCALE });
    win.webContents.send('floor:colony', { pals: roster(d.config.get('colony')), tracks: tracksOn(d.config) });
    win.webContents.send('floor:calm', { calm: !!d.calm() });
    sent = '';
    startFeed();
  }

  // Where he is along the strip, and what he's up to, for the pals to react to
  // and the tracks to follow. Sent only when something changed.
  function whereabouts() {
    if (!win || win.isDestroyed()) return;
    place();
    const b = d.critterBounds(), g = d.geo();
    const strip = win.getBounds();
    const cx = b.x + b.width - g.width / 2;
    const feet = b.y + b.height - g.foot;
    const away = d.away();
    const lift = Math.round(strip.y + strip.height - g.foot - feet); // his feet above the floor's (his spot is a little up)
    const onFloor = !away && lift >= -4 && lift <= ON_FLOOR && cx >= strip.x && cx <= strip.x + strip.width;
    const msg = { x: Math.round(cx - strip.x), floor: onFloor, lift: onFloor ? lift : 0, away: away || null, state: d.status(), half: g.half };
    const key = JSON.stringify(msg);
    if (key === sent) return;
    sent = key;
    win.webContents.send('floor:shellby', msg);
  }

  function startFeed() {
    stopFeed();
    feed = setInterval(whereabouts, FEED_MS);
  }
  function stopFeed() {
    clearInterval(feed);
    feed = null;
  }

  /** Make the strip match the settings: open it, close it, or tell it what changed. */
  function sync() {
    if (!wanted()) {
      if (win && !win.isDestroyed()) win.close();
      win = null;
      stopFeed();
      return;
    }
    if (!win || win.isDestroyed()) return create();
    setup();
  }

  /** Something happened the pals should react to: 'success', 'error', 'landed', 'petted'. */
  function event(kind) {
    if (win && !win.isDestroyed()) win.webContents.send('floor:event', { kind });
  }

  // He's a new size or a new skin: redraw them to match.
  function reskin() {
    if (!win || win.isDestroyed()) return;
    shown = '';
    place();
    win.webContents.send('floor:skin', { ...d.skin(), scale: PAL_SCALE });
  }

  function hover(over) {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!over, { forward: true });
  }

  function calm(on, hide = false) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('floor:calm', { calm: !!on });
    if (ready) d.veil(win, hide);
  }

  // Under him, always: the strip goes to the bottom after he does.
  function lower() {
    if (win && !win.isDestroyed()) d.lower(win);
  }

  // Onto whichever layer he's on now (on top of your apps, or the desktop), under him.
  function repin() {
    if (!win || win.isDestroyed()) return;
    d.pin(win);
    lower();
  }

  const isFloor = wc => !!win && !win.isDestroyed() && wc === win.webContents;
  const view = () => ({ open: !!win && !win.isDestroyed(), pals: roster(d.config.get('colony')).map(p => p.name), tracks: tracksOn(d.config), bounds: win && !win.isDestroyed() ? win.getBounds() : null });

  function dispose() {
    stopFeed();
    if (win && !win.isDestroyed()) win.close();
    win = null;
  }

  return { sync, event, reskin, hover, calm, lower, repin, isFloor, view, dispose, reload: setup };
}

module.exports = { createFloor, roster, colonySize, tracksOn, COLONY_MAX, PAL_SCALE, NAMES };
