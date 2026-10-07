// What other apps' windows are doing, for perching (see perch.js, perching.js),
// and the one koffi loader the desktop layer shares (see desktop-layer.js).
//
// Everything here is best effort: no koffi, not Windows, or a call that throws
// all come back as "nothing there" (0, null, false), never as an exception.
// Rects are in *physical* pixels, as Win32 reports them; callers convert to DIPs.
let koffi = null;
try { koffi = require('koffi'); } catch (e) { console.warn('[shellby] koffi failed to load:', e.message); }

let api = null;
function load() {
  if (api || !koffi || process.platform !== 'win32') return api;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const shell32 = koffi.load('shell32.dll');
    const advapi32 = koffi.load('advapi32.dll');
    koffi.struct('SHELLBY_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
    const EnumProc = koffi.proto('bool __stdcall ShellbyEnumProc(intptr_t hwnd, intptr_t lParam)');
    api = {
      EnumProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(ShellbyEnumProc *cb, intptr_t lParam)'),
      FindWindowW: user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 title)'),
      FindWindowExW: user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 title)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
      SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int idx, intptr_t val)'),
      GetWindowLongW: user32.func('int32_t __stdcall GetWindowLongW(intptr_t hwnd, int idx)'),
      GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)'),
      RegisterWindowMessageW: user32.func('uint32_t __stdcall RegisterWindowMessageW(str16 name)'),
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      GetAsyncKeyState: user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
      SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hwnd)'),
      IsHungAppWindow: user32.func('bool __stdcall IsHungAppWindow(intptr_t hwnd)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
      PostMessageW: user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ SHELLBY_RECT *r)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int max)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int max)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
      DwmFrame: dwmapi.func('DwmGetWindowAttribute', 'long', ['intptr_t', 'uint32_t', koffi.out(koffi.pointer('SHELLBY_RECT')), 'uint32_t']),
      DwmCloaked: dwmapi.func('DwmGetWindowAttribute', 'long', ['intptr_t', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'uint32_t']),
      OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
      GetExitCodeProcess: kernel32.func('bool __stdcall GetExitCodeProcess(intptr_t h, _Out_ uint32_t *code)'),
      GetProcessTimes: kernel32.func('bool __stdcall GetProcessTimes(intptr_t h, _Out_ uint64_t *created, _Out_ uint64_t *exited, _Out_ uint64_t *kernel, _Out_ uint64_t *user)'),
      SHQueryUserNotificationState: shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int32_t *state)'),
      SetProcessDpiAwarenessContext: user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)'),
      LockWorkStation: user32.func('bool __stdcall LockWorkStation()'),
      ShutdownBlockReasonCreate: user32.func('bool __stdcall ShutdownBlockReasonCreate(intptr_t hwnd, str16 reason)'),
      ShutdownBlockReasonDestroy: user32.func('bool __stdcall ShutdownBlockReasonDestroy(intptr_t hwnd)'),
      RegOpenKeyExW: advapi32.func('long __stdcall RegOpenKeyExW(intptr_t key, str16 sub, uint32_t opts, uint32_t sam, _Out_ intptr_t *out)'),
      RegEnumKeyExW: advapi32.func('long __stdcall RegEnumKeyExW(intptr_t key, uint32_t i, _Out_ uint16_t *name, _Inout_ uint32_t *len, intptr_t r, intptr_t c, intptr_t cl, intptr_t ft)'),
      RegQueryValueExW: advapi32.func('long __stdcall RegQueryValueExW(intptr_t key, str16 name, intptr_t r, _Out_ uint32_t *type, _Out_ uint8_t *data, _Inout_ uint32_t *size)'),
      RegCloseKey: advapi32.func('long __stdcall RegCloseKey(intptr_t key)'),
    };
  } catch (e) {
    console.warn('[shellby] window tracking unavailable:', e.message);
    api = null;
    koffi = null; // don't keep retrying a load that fails
  }
  return api;
}

const GWL_STYLE = -16, GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8;
const GW_OWNER = 4, GW_HWNDPREV = 3;
const HWND_TOP = 0;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
const WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_CHILD = 0x40000000;
const WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TRANSPARENT = 0x20;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SW_MINIMIZE = 6, SW_RESTORE = 9, WM_CLOSE = 0x10;
// SHQueryUserNotificationState values perching cares about.
const QUNS = Object.freeze({ BUSY: 2, D3D_FULL_SCREEN: 3, PRESENTATION: 4 });

const available = () => !!load();

/** The native handle of an Electron BrowserWindow. */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigInt64LE(0)) : buf.readInt32LE(0);
}

function safe(fn, fallback) {
  const a = load();
  if (!a) return fallback;
  try { return fn(a); } catch { return fallback; }
}

const str16 = (fn, h) => {
  const b = new Uint16Array(260);
  const n = fn(h, b, 260);
  return String.fromCharCode(...b.slice(0, Math.max(0, n)));
};
const rectOf = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/** Visible top-level windows, topmost first (the z-order). */
function topLevelWindows() {
  return safe(a => {
    const out = [];
    const cb = koffi.register(h => { if (a.IsWindowVisible(h)) out.push(h); return true; }, koffi.pointer(a.EnumProc));
    try { a.EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
    return out;
  }, []);
}

const exeCache = new Map(); // pid -> { name, full }; pids are reused, so it's capped and short-lived
function imageOf(pid) {
  if (!pid) return { name: '', full: '' };
  const hit = exeCache.get(pid);
  if (hit && Date.now() - hit.at < 60000) return hit;
  const full = safe(a => {
    const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return '';
    try {
      const buf = new Uint16Array(1024);
      const size = [1024];
      if (!a.QueryFullProcessImageNameW(h, 0, buf, size)) return '';
      return String.fromCharCode(...buf.slice(0, size[0]));
    } finally { a.CloseHandle(h); }
  }, '');
  const entry = { name: full.split('\\').pop().toLowerCase(), full, at: Date.now() };
  if (exeCache.size > 200) exeCache.clear();
  exeCache.set(pid, entry);
  return entry;
}
// The lower-case file name ("chrome.exe").
const exeOf = pid => imageOf(pid).name;

const STILL_ACTIVE = 259;
const FILETIME_UNIX_MS = 11644473600000; // 1601-01-01 to 1970-01-01

/**
 * Is a process still running, and when did it start? -> { alive, createdAt (ms) }
 * or null when Windows can't say (no koffi). A pid that isn't there, or isn't
 * ours to look at, is { alive: false }. The start time tells a reused pid apart
 * from the process that had it (devservers/runner.js).
 */
function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, createdAt: null };
  return safe(a => {
    const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return { alive: false, createdAt: null };
    try {
      const code = [0];
      const alive = a.GetExitCodeProcess(h, code) ? code[0] === STILL_ACTIVE : false;
      const created = [0], exited = [0], kernel = [0], user = [0];
      let createdAt = null;
      if (a.GetProcessTimes(h, created, exited, kernel, user)) {
        const ticks = typeof created[0] === 'bigint' ? created[0] : BigInt(Math.round(Number(created[0]) || 0));
        if (ticks > 0n) createdAt = Number(ticks / 10000n) - FILETIME_UNIX_MS;
      }
      return { alive, createdAt };
    } finally { a.CloseHandle(h); }
  }, null);
}

function frameOf(a, h) {
  const r = {};
  if (a.DwmFrame(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0 && r.right > r.left) return rectOf(r);
  const w = {};
  return a.GetWindowRect(h, w) ? rectOf(w) : null;
}

/**
 * The cheap read the perch watcher does every frame: is it still there, where
 * is its visible frame, and has it been minimized, maximized, hidden or cloaked.
 */
function quick(h) {
  return safe(a => {
    if (!h || !a.IsWindow(h)) return { gone: true };
    const cloak = [0];
    a.DwmCloaked(h, DWMWA_CLOAKED, cloak, 4);
    return {
      gone: false,
      frame: frameOf(a, h),
      visible: a.IsWindowVisible(h),
      minimized: a.IsIconic(h),
      maximized: a.IsZoomed(h),
      cloaked: cloak[0] !== 0,
      hung: a.IsHungAppWindow(h),
    };
  }, { gone: true });
}

/** Everything perch.js needs to judge a window. null when it isn't one. */
function describe(h) {
  return safe(a => {
    const q = quick(h);
    if (q.gone) return null;
    const pid = [0];
    a.GetWindowThreadProcessId(h, pid);
    const style = a.GetWindowLongW(h, GWL_STYLE) >>> 0;
    const ex = a.GetWindowLongW(h, GWL_EXSTYLE) >>> 0;
    const r = {};
    a.GetWindowRect(h, r);
    return {
      hwnd: h,
      pid: pid[0],
      exe: exeOf(pid[0]),
      // Where it's installed, so a game can be told by its launcher's folder (surroundings.js).
      path: imageOf(pid[0]).full,
      cls: str16(a.GetClassNameW, h),
      rect: rectOf(r),
      ...q,
      captioned: (style & WS_CAPTION) === WS_CAPTION || !!(style & WS_THICKFRAME),
      child: !!(style & WS_CHILD),
      tool: !!(ex & WS_EX_TOOLWINDOW),
      topmost: !!(ex & WS_EX_TOPMOST),
      noActivate: !!(ex & WS_EX_NOACTIVATE),
      clickThrough: !!(ex & WS_EX_TRANSPARENT),
      owned: !!a.GetWindow(h, GW_OWNER),
    };
  }, null);
}

const foreground = () => safe(a => a.GetForegroundWindow(), 0);

/**
 * The window in front, for the time tracker (timetrack.js): its process and
 * exe, and its title. The title is only ever matched against project names in
 * memory; it is never stored or logged. null when there's nothing in front.
 */
function frontWindow() {
  return safe(a => {
    const h = a.GetForegroundWindow();
    if (!h) return null;
    const pid = [0];
    a.GetWindowThreadProcessId(h, pid);
    const b = new Uint16Array(512);
    const n = a.GetWindowTextW(h, b, 512);
    return { hwnd: h, pid: pid[0], exe: exeOf(pid[0]), title: String.fromCharCode(...b.slice(0, Math.max(0, n))) };
  }, null);
}
const isWindow = h => safe(a => !!h && a.IsWindow(h), false);
// Is this key held right now, whichever app has focus? (push-to-talk, see dictation.js)
const keyDown = vk => safe(a => (a.GetAsyncKeyState(vk) & 0x8000) !== 0, false);
// Any mouse button held right now (left, right, middle): mischief never grabs mid-click (pranks.js).
const VK_MOUSE = [0x01, 0x02, 0x04];
const mouseDown = () => VK_MOUSE.some(keyDown);
// Mischief's cursor pinch (pranks.js), in physical pixels. Only ever for half a second.
const setCursor = (x, y) => safe(a => a.SetCursorPos(Math.round(x), Math.round(y)), false);
const isVisible = h => safe(a => a.IsWindowVisible(h), false);
const ownerOf = h => safe(a => a.GetWindow(h, GW_OWNER), 0);

/** What Windows says about interrupting the user right now (QUNS_*), or 0. */
const notificationState = () => safe(a => {
  const s = [0];
  return a.SHQueryUserNotificationState(s) === 0 ? s[0] : 0;
}, 0);

/** The shell window that hosts the desktop icons (Progman, or a WorkerW). */
function desktopHost() {
  return safe(a => {
    const progman = a.FindWindowW('Progman', null);
    if (progman && a.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null)) return progman;
    // Wallpaper slideshows and some Win10/11 builds move DefView into a WorkerW.
    let w = 0;
    while ((w = a.FindWindowExW(0, w, 'WorkerW', null))) {
      if (a.FindWindowExW(w, 0, 'SHELLDLL_DefView', null)) return w;
    }
    return progman || 0;
  }, 0);
}

/**
 * Make `self` an owned window of `owner`. Owned windows share their owner's
 * z-band and always sit just above it, so this is how he stays on top of the
 * window he perches on, and goes behind whatever covers it. True only when
 * Windows actually took it (it refuses for elevated windows, for one).
 */
function ownBy(self, owner) {
  if (!owner) return false; // no window to own him: "owner is 0" would read as success
  return safe(a => {
    a.SetWindowLongPtrW(self, GWLP_HWNDPARENT, owner);
    return a.GetWindow(self, GW_OWNER) === owner;
  }, false);
}

/**
 * Taking an owner doesn't move a window in the z-order; Windows only enforces
 * "owned above owner" the next time the owner is restacked. So put him there
 * now: just behind whatever is directly above the owner.
 */
function raiseAbove(self, owner) {
  return safe(a => {
    let above = a.GetWindow(owner, GW_HWNDPREV);
    if (above === self) return true;
    // Never slot in behind an always-on-top window (the taskbar, a pinned
    // app): that would make him topmost too. The top of the ordinary windows
    // is as high as he goes.
    if (!above || (a.GetWindowLongW(above, GWL_EXSTYLE) & WS_EX_TOPMOST)) above = HWND_TOP;
    return a.SetWindowPos(self, above, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }, false);
}

const ownByDesktop = self => ownBy(self, desktopHost());

/**
 * In the air: nobody's owned window, on top of the ordinary (not topmost)
 * windows, so a hop or a fall is seen crossing the apps rather than happening
 * behind them. Without activating him. He's put back down when he lands.
 */
function float(self) {
  return safe(a => {
    a.SetWindowLongPtrW(self, GWLP_HWNDPARENT, 0);
    return a.SetWindowPos(self, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  }, false);
}

// Probe and e2e helpers (scripts/perch-probe.js): drive someone else's window.
const focus = h => safe(a => a.SetForegroundWindow(h), false);
const minimize = h => safe(a => a.ShowWindow(h, SW_MINIMIZE), false);
const restore = h => safe(a => a.ShowWindow(h, SW_RESTORE), false);
const close = h => safe(a => a.PostMessageW(h, WM_CLOSE, 0, 0), false);
// Plain node.exe isn't DPI aware, so Windows would scale every rect it sees;
// scripts call this first to see the same physical pixels Electron does.
const dpiAware = () => safe(a => a.SetProcessDpiAwarenessContext(-4 /* PER_MONITOR_AWARE_V2 */), false);
const move = (h, x, y) => safe(a => a.SetWindowPos(h, 0, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | 0x4 /* NOZORDER */), false);
// "Is it safe to leave?" (leaving.js): lock the screen, and the line Windows
// shows beside Shellby while he holds up a shutdown or sign-out.
const lockScreen = () => safe(a => a.LockWorkStation(), false);
const blockShutdown = (h, reason) => safe(a => a.ShutdownBlockReasonCreate(h, String(reason).slice(0, 250)), false);
const unblockShutdown = h => safe(a => a.ShutdownBlockReasonDestroy(h), false);

// ---- the registry, read in place
const HKEY_CURRENT_USER = -2147483647; // (HKEY)(LONG)0x80000001, sign-extended
const KEY_READ = 0x20019, REG_QWORD = 11, MAX_DEPTH = 4, MAX_KEYS = 5000;

/**
 * Every REG_QWORD named in `names` under an HKCU key and its subkeys, written
 * out as `reg query <key> /s` would print them, so the same parser reads both:
 *   HKEY_CURRENT_USER\<path>
 *       <Name>    REG_QWORD    0x<hex>
 * `reg.exe` costs ~300 ms of CPU for the microphone's list; this, a few ms.
 * null when it can't be read (not Windows, no koffi, no such key).
 */
function regQwords(path, names) {
  const sub = String(path).replace(/^HKCU\\|^HKEY_CURRENT_USER\\/i, '');
  return safe(a => {
    const lines = [];
    let keys = 0;
    const open = (parent, rel) => {
      const out = [0];
      if (a.RegOpenKeyExW(parent, rel, 0, KEY_READ, out) !== 0) return false;
      const h = out[0];
      try {
        keys++;
        const found = [];
        for (const name of names) {
          const data = Buffer.alloc(8);
          const type = [0], size = [8];
          if (a.RegQueryValueExW(h, name, 0, type, data, size) === 0 && type[0] === REG_QWORD) found.push(`    ${name}    REG_QWORD    0x${data.readBigUInt64LE(0).toString(16)}`);
        }
        return { h, found };
      } catch (e) {
        a.RegCloseKey(h);
        throw e;
      }
    };
    const visit = (parent, rel, full, depth) => {
      const k = open(parent, rel);
      if (!k) return;
      try {
        if (k.found.length) lines.push(`HKEY_CURRENT_USER\\${full}`, ...k.found);
        if (depth >= MAX_DEPTH) return;
        for (let i = 0; keys < MAX_KEYS; i++) {
          const name = new Uint16Array(512);
          const len = [512];
          if (a.RegEnumKeyExW(k.h, i, name, len, 0, 0, 0, 0) !== 0) break; // ERROR_NO_MORE_ITEMS, or anything else
          const child = String.fromCharCode(...name.slice(0, len[0]));
          visit(k.h, child, `${full}\\${child}`, depth + 1);
        }
      } finally {
        a.RegCloseKey(k.h);
      }
    };
    const out = [0];
    if (a.RegOpenKeyExW(HKEY_CURRENT_USER, sub, 0, KEY_READ, out) !== 0) return null;
    a.RegCloseKey(out[0]);
    visit(HKEY_CURRENT_USER, sub, sub, 0);
    return lines.join('\r\n');
  }, null);
}

module.exports = {
  regQwords,
  load, available, hwndOf, topLevelWindows, describe, quick, foreground, frontWindow, isWindow, keyDown, mouseDown, setCursor, isVisible, ownerOf,
  QUNS, notificationState, desktopHost, ownBy, ownByDesktop, raiseAbove, float, focus, minimize, restore, close, move, dpiAware,
  lockScreen, blockShutdown, unblockShutdown, processInfo,
};
