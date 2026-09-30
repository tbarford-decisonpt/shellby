// Keeps the critter on the desktop layer: above the wallpaper and icons, below
// every app, and still visible after Win+D ("Show desktop").
//
// Technique: make the critter an *owned* window of the shell's desktop host
// (the Progman/WorkerW window that contains SHELLDLL_DefView). Owned windows
// share their owner's z-band, so the critter lives with the desktop. We use an
// owner (not SetParent) so the window keeps normal input and screen coordinates.
let koffi = null;
try { koffi = require('koffi'); } catch (e) { console.warn('[shellby] koffi failed to load:', e.message); }

let api = null;
function load() {
  if (api || !koffi || process.platform !== 'win32') return api;
  const user32 = koffi.load('user32.dll');
  api = {
    FindWindowW: user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 title)'),
    FindWindowExW: user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 title)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
    SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int idx, intptr_t val)'),
    GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)'),
    RegisterWindowMessageW: user32.func('uint32_t __stdcall RegisterWindowMessageW(str16 name)'),
  };
  return api;
}

const GWLP_HWNDPARENT = -8;
const GW_OWNER = 4;
const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigInt64LE(0)) : buf.readInt32LE(0);
}

function findDesktopHost() {
  const a = load();
  if (!a) return 0;
  const progman = a.FindWindowW('Progman', null);
  if (progman && a.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null)) return progman;
  // Wallpaper slideshows and some Win10/11 builds move DefView into a WorkerW.
  let w = 0;
  while ((w = a.FindWindowExW(0, w, 'WorkerW', null))) {
    if (a.FindWindowExW(w, 0, 'SHELLDLL_DefView', null)) return w;
  }
  return progman || 0;
}

function sendToBottom(win) {
  const a = load();
  if (!a || win.isDestroyed()) return;
  try { a.SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE); } catch { /* best effort */ }
}

function pin(win) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  try {
    const host = findDesktopHost();
    if (host) a.SetWindowLongPtrW(hwndOf(win), GWLP_HWNDPARENT, host);
    sendToBottom(win);
    return !!host;
  } catch (e) {
    console.error('[shellby] desktop pin failed:', e);
    return false;
  }
}

function isPinned(win) {
  const a = load();
  if (!a || win.isDestroyed()) return true;
  const host = findDesktopHost();
  return !!host && a.GetWindow(hwndOf(win), GW_OWNER) === host;
}

// Pins now, re-pins when Explorer restarts (it broadcasts "TaskbarCreated"),
// and runs a slow watchdog for anything else that breaks ownership.
function keepOnDesktop(win, { watchdogMs = 15000 } = {}) {
  const a = load();
  if (!a) {
    console.warn('[shellby] desktop layer unavailable (koffi not loaded); the critter will float as a normal window');
    return () => {};
  }
  console.log(`[shellby] desktop pin: ${pin(win) ? 'ok' : 'failed'}`);
  try {
    const msg = a.RegisterWindowMessageW('TaskbarCreated');
    win.hookWindowMessage(msg, () => setTimeout(() => pin(win), 1500));
  } catch { /* hookWindowMessage unavailable */ }
  const timer = setInterval(() => { if (!win.isDestroyed() && !isPinned(win)) pin(win); }, watchdogMs);
  win.on('closed', () => clearInterval(timer));
  return () => clearInterval(timer);
}

module.exports = { keepOnDesktop, pin, sendToBottom, isPinned };
