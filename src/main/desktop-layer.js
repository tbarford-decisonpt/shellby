// Keeps the critter on the desktop layer: above the wallpaper and icons, below
// every app, and still visible after Win+D ("Show desktop").
//
// Technique: make the critter an *owned* window of the shell's desktop host
// (the Progman/WorkerW window that contains SHELLDLL_DefView). Owned windows
// share their owner's z-band, so the critter lives with the desktop. We use an
// owner (not SetParent) so the window keeps normal input and screen coordinates.
// Perching (see perching.js) borrows the same trick with an app's window as the
// owner, so while he's away the watchdog leaves his owner alone.
const native = require('./native-windows');

const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

let away = () => false; // set by keepOnDesktop: true while he's perched on a window

function sendToBottom(win) {
  const a = native.load();
  if (!a || win.isDestroyed() || away()) return;
  try { a.SetWindowPos(native.hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE); } catch { /* best effort */ }
}

function pin(win) {
  if (!native.available() || win.isDestroyed()) return false;
  try {
    const host = native.desktopHost();
    if (host) native.ownBy(native.hwndOf(win), host);
    sendToBottom(win);
    return !!host;
  } catch (e) {
    console.error('[shellby] desktop pin failed:', e);
    return false;
  }
}

function isPinned(win) {
  if (!native.available() || win.isDestroyed()) return true;
  const host = native.desktopHost();
  return !!host && native.ownerOf(native.hwndOf(win)) === host;
}

// Pins now, re-pins when Explorer restarts (it broadcasts "TaskbarCreated"),
// and runs a slow watchdog for anything else that breaks ownership. `isAway`
// says he's perched on some app's window right now and must be left there.
function keepOnDesktop(win, { watchdogMs = 15000, isAway = () => false } = {}) {
  const a = native.load();
  away = isAway;
  if (!a) {
    console.warn('[shellby] desktop layer unavailable (koffi not loaded); the critter will float as a normal window');
    return () => {};
  }
  console.log(`[shellby] desktop pin: ${pin(win) ? 'ok' : 'failed'}`);
  try {
    const msg = a.RegisterWindowMessageW('TaskbarCreated');
    win.hookWindowMessage(msg, () => setTimeout(() => { if (!away()) pin(win); }, 1500));
  } catch { /* hookWindowMessage unavailable */ }
  const timer = setInterval(() => { if (!win.isDestroyed() && !away() && !isPinned(win)) pin(win); }, watchdogMs);
  win.on('closed', () => clearInterval(timer));
  return () => clearInterval(timer);
}

// Does the window in front hide him completely? He lives below every app, so a
// window whose frame contains his whole box does. Both rects in DIPs ({x, y,
// width, height}). The desktop's own host window is screen-sized but sits under
// him, so it never counts (the caller leaves it out by class).
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW']);
function covers(frame, box) {
  if (!frame || !box) return false;
  return frame.x <= box.x && frame.y <= box.y
    && frame.x + frame.width >= box.x + box.width
    && frame.y + frame.height >= box.y + box.height;
}

// Take a transparent window off the screen while nobody can see it, and put it
// back under every app when they can. Calm (animation: none) isn't enough
// behind a game: every repaint he still makes — a state change, a bubble, the
// crew — is a frame presented to a GPU the game is saturating, and each one
// waits in the game's queue. Measured behind Dune: 23% of the 3D engine and a
// quarter of a core with not one animation running. A hidden window presents
// nothing at all. Owned windows keep their owner while hidden, so he comes back
// on the desktop layer.
function veil(win, hide, { lower = () => {} } = {}) {
  if (!win || win.isDestroyed()) return;
  if (hide) {
    if (win.isVisible()) win.hide();
  } else if (!win.isVisible()) {
    win.showInactive();
    lower(win);
  }
}

module.exports = { keepOnDesktop, pin, sendToBottom, isPinned, covers, veil, DESKTOP_CLASSES };
