// That you pressed a key, never which one: the beat he taps along to (typing.js).
//
// Windows' Raw Input sends a WM_INPUT for every key event, even while another
// app is in front (RIDEV_INPUTSINK), to a window we name. No hook goes into any
// other process, so nothing is injected anywhere. Windows copies each whole
// event into our buffer; we look only at its type and the bit that says
// "released" (so a held key's autorepeat counts once) and wipe the buffer
// straight after: the key itself is never looked at or kept.
//
// The window is a message-only one of our own, with a koffi window procedure.
// Electron's hookWindowMessage would be simpler, but it runs its callback after
// the message is handled, when the raw input data has often been freed already.
// A window of our own also hears nothing but its keyboard events.
//
// Best effort, like native-windows.js: no koffi, not Windows, or a call that
// fails all come back as null ("can't hear the keyboard"), never an exception.
let koffi = null;
try { koffi = require('koffi'); } catch { /* native-windows.js already said so */ }

const WM_INPUT = 0x00FF;
const RID_INPUT = 0x10000003;
const RIM_TYPEKEYBOARD = 1;
const RI_KEY_BREAK = 0x1;
const RIDEV_INPUTSINK = 0x100;
const RIDEV_REMOVE = 0x1;
const HWND_MESSAGE = -3;
const USAGE_PAGE_GENERIC = 1, USAGE_KEYBOARD = 6;
const CLASS_NAME = 'ShellbyKeystrokes';

let api = null;
function load() {
  if (api || !koffi || process.platform !== 'win32') return api;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    koffi.struct('SHELLBY_RAWINPUTDEVICE', { usUsagePage: 'uint16_t', usUsage: 'uint16_t', dwFlags: 'uint32_t', hwndTarget: 'intptr_t' });
    const WndProc = koffi.proto('intptr_t __stdcall ShellbyKeysProc(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)');
    koffi.struct('SHELLBY_WNDCLASSEXW', {
      cbSize: 'uint32_t', style: 'uint32_t', lpfnWndProc: 'ShellbyKeysProc *', cbClsExtra: 'int', cbWndExtra: 'int', hInstance: 'intptr_t',
      hIcon: 'intptr_t', hCursor: 'intptr_t', hbrBackground: 'intptr_t', lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'intptr_t',
    });
    api = {
      WndProc,
      // The header is three DWORD/handle fields and a WPARAM: 24 bytes on 64-bit, 16 on 32-bit.
      headerSize: koffi.sizeof('intptr_t') === 8 ? 24 : 16,
      RegisterRawInputDevices: user32.func('bool __stdcall RegisterRawInputDevices(SHELLBY_RAWINPUTDEVICE *d, uint32_t n, uint32_t size)'),
      GetRawInputData: user32.func('uint32_t __stdcall GetRawInputData(intptr_t h, uint32_t cmd, _Out_ void *data, _Inout_ uint32_t *size, uint32_t header)'),
      RegisterClassExW: user32.func('uint16_t __stdcall RegisterClassExW(SHELLBY_WNDCLASSEXW *wc)'),
      CreateWindowExW: user32.func('intptr_t __stdcall CreateWindowExW(uint32_t ex, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t inst, intptr_t param)'),
      DestroyWindow: user32.func('bool __stdcall DestroyWindow(intptr_t hwnd)'),
      DefWindowProcW: user32.func('intptr_t __stdcall DefWindowProcW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)'),
      GetModuleHandleW: kernel32.func('intptr_t __stdcall GetModuleHandleW(str16 name)'),
    };
  } catch (e) {
    console.warn('[shellby] keystrokes unavailable:', e.message);
    api = null;
    koffi = null;
  }
  return api;
}

// The class and its procedure live as long as the app: a class can't be
// registered twice, and Windows may still call the procedure while a window closes.
let proc = null;
let classReady = false;
let listener = null;
const scratch = Buffer.alloc(64); // a keyboard event is 40 bytes on 64-bit

function onMessage(a, hwnd, msg, w, l) {
  if (msg === WM_INPUT && listener) {
    let released = false;
    try {
      const n = a.GetRawInputData(l, RID_INPUT, scratch, [scratch.length], a.headerSize);
      released = n !== 0xFFFFFFFF && n > 0 && scratch.readUInt32LE(0) === RIM_TYPEKEYBOARD
        && (scratch.readUInt16LE(a.headerSize + 2) & RI_KEY_BREAK) !== 0;
    } catch { /* one lost beat */ } finally {
      scratch.fill(0); // whatever Windows copied in (the key too) goes, whatever happened
    }
    if (released) try { listener(); } catch { /* his problem, not the keyboard's */ }
  }
  return a.DefWindowProcW(hwnd, msg, w, l);
}

function ensureClass(a, inst) {
  if (classReady) return true;
  proc = koffi.register((hwnd, msg, w, l) => onMessage(a, hwnd, msg, w, l), koffi.pointer(a.WndProc));
  classReady = a.RegisterClassExW({
    cbSize: koffi.sizeof('SHELLBY_WNDCLASSEXW'), style: 0, lpfnWndProc: proc, cbClsExtra: 0, cbWndExtra: 0, hInstance: inst,
    hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: CLASS_NAME, hIconSm: 0,
  }) !== 0;
  return classReady;
}

/**
 * Call `onKey()` (no arguments: nothing about the key) each time a key is let
 * go, anywhere on the PC. Returns stop(), or null if the keyboard can't be heard.
 * One listener at a time; a second watch replaces the first.
 */
function watch(onKey) {
  const a = load();
  if (!a) return null;
  try {
    const inst = a.GetModuleHandleW(null);
    if (!ensureClass(a, inst)) return null;
    const hwnd = a.CreateWindowExW(0, CLASS_NAME, null, 0, 0, 0, 0, 0, HWND_MESSAGE, 0, inst, 0);
    if (!hwnd) return null;
    const size = koffi.sizeof('SHELLBY_RAWINPUTDEVICE');
    if (!a.RegisterRawInputDevices({ usUsagePage: USAGE_PAGE_GENERIC, usUsage: USAGE_KEYBOARD, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd }, 1, size)) {
      a.DestroyWindow(hwnd);
      return null;
    }
    listener = onKey;
    let stopped = false;
    return function stop() {
      if (stopped) return;
      stopped = true;
      const current = listener === onKey;
      if (current) listener = null;
      // A newer watch() owns the registration now (the process has only one): leave it be.
      if (current) try { a.RegisterRawInputDevices({ usUsagePage: USAGE_PAGE_GENERIC, usUsage: USAGE_KEYBOARD, dwFlags: RIDEV_REMOVE, hwndTarget: 0 }, 1, size); } catch { /* gone with the window */ }
      try { a.DestroyWindow(hwnd); } catch { /* already gone */ }
    };
  } catch (e) {
    console.warn('[shellby] keystrokes unavailable:', e.message);
    return null;
  }
}

module.exports = { watch };
