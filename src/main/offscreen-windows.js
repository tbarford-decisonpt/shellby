// An e2e run's windows, kept off every screen (test-desktop.js point 3). Every
// BrowserWindow really sits FAR_X pixels to the left of where Shellby thinks it is,
// so it never covers your apps and your mouse never reaches it, while it still
// paints and answers Page.captureScreenshot (occlusion is off in test runs). The
// app and the checks keep seeing on-screen bounds: the bounds methods add the
// offset going in and take it off coming out.
//
// Showing never activates, and focus is kept here instead of by Windows: focus()
// and show() mark a window focused (with its 'focus' and the last one's 'blur'),
// so isFocused() reads as it would, without ever taking the foreground from you;
// moveTop() does nothing, since Electron's activates the window.
// maximize() becomes a resize to the work area, flagged so isMaximized() and the
// 'maximize'/'unmaximize' events still read as a real one.
//
// Three things Windows does to a window on no monitor, each worked around here:
//  - It takes the nearest monitor's size and scale, which far to the left is the
//    leftmost one, and the page's `screen` reports that. So Shellby is told that
//    monitor is the only one (onlyHome): main and the page agree. CI has one.
//  - Chromium gives a frameless window with a thick frame the standard borders
//    when it meets no monitor, so the page came out 16 x 8 px bigger than asked.
//    Windows are made with thickFrame: false (nothing resizes them by hand here),
//    which needs the constructor, so require('electron') hands out a subclass.
//  - A window made on one monitor and moved to another changes scale on the way
//    and lands somewhere else, so each is made off screen, on the home monitor.
const Module = require('module');

const FAR_X = -15000; // DIP; past any monitor layout, inside Windows' 32k limit once scaled
const isFar = x => x <= FAR_X / 2;

/** On-screen bounds -> where the window really goes. Already-real ones pass. */
const toReal = r => (isFar(r.x) ? { ...r } : { ...r, x: r.x + FAR_X });
/** Where it really is -> the on-screen bounds Shellby works in. */
const toSeen = r => (isFar(r.x) ? { ...r, x: r.x - FAR_X } : { ...r });

/** The display a window far to the left of every screen is given: the leftmost. */
const homeDisplay = displays => displays.reduce((a, b) => (b.bounds.x < a.bounds.x ? b : a));

/** Make the screen module see only the home display. -> that display. */
function onlyHome(screen) {
  const home = homeDisplay(screen.getAllDisplays());
  screen.getAllDisplays = () => [home];
  screen.getPrimaryDisplay = () => home;
  screen.getDisplayNearestPoint = () => home;
  screen.getDisplayMatching = () => home;
  return home;
}

/** Constructor options -> the same window, made off screen, with no thick frame, never activated. */
function offScreenOptions(opts = {}, workArea) {
  const width = opts.width ?? 800, height = opts.height ?? 600;
  const seen = Number.isFinite(opts.x) && Number.isFinite(opts.y)
    ? { x: opts.x, y: opts.y }
    : { x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + (workArea.height - height) / 2) };
  const real = toReal({ ...seen, width, height });
  // focusable: false is WS_EX_NOACTIVATE: not Alt+Tab, a taskbar click or Windows
  // picking the next window when you close yours can hand it the foreground.
  return { ...opts, x: real.x, y: real.y, thickFrame: false, center: false, focusable: false, skipTaskbar: true };
}

/** require('electron') -> the same module, with BrowserWindow swapped for `Sub`. */
function handOut(electron, Sub) {
  const swapped = new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? Sub : t[k]) });
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? swapped : load.call(this, request, ...rest);
  };
}

/** Patch the bounds, maximize and focus methods. -> the window that has the focus, for tests. */
function patchWindows(BrowserWindow, getScreen) {
  const P = BrowserWindow.prototype;
  const raw = { getBounds: P.getBounds, setBounds: P.setBounds, getContentBounds: P.getContentBounds, setContentBounds: P.setContentBounds, hide: P.hide };
  const maxed = new WeakMap(); // window -> the bounds to come back to
  const want = new WeakMap(); // window -> the on-screen bounds Shellby last asked for
  const takesFocus = new WeakMap(); // window -> focusable, as Shellby asked (Windows is told false)
  let focused = null;

  const alive = w => !!w && !w.isDestroyed();
  const give = win => {
    if (focused === win) return;
    const was = focused;
    focused = win;
    if (alive(was)) was.emit('blur');
    if (win) win.emit('focus');
  };

  P.getBounds = function () { return toSeen(raw.getBounds.call(this)); };
  P.setBounds = function (b, animate) {
    const next = { ...this.getBounds(), ...b };
    want.set(this, next);
    return raw.setBounds.call(this, toReal(next), animate);
  };
  P.getContentBounds = function () { return toSeen(raw.getContentBounds.call(this)); };
  P.setContentBounds = function (b, animate) {
    raw.setContentBounds.call(this, toReal({ ...this.getContentBounds(), ...b }), animate);
    want.set(this, this.getBounds());
  };
  P.getPosition = function () { const b = this.getBounds(); return [b.x, b.y]; };
  P.setPosition = function (x, y, animate) { this.setBounds({ x, y }, animate); };
  P.getNormalBounds = function () { return maxed.get(this) || this.getBounds(); };
  P.center = function () {
    const b = this.getBounds();
    const wa = getScreen().getDisplayMatching(b).workArea;
    this.setBounds({ x: Math.round(wa.x + (wa.width - b.width) / 2), y: Math.round(wa.y + (wa.height - b.height) / 2) });
  };

  P.isMaximized = function () { return maxed.has(this); };
  P.maximize = function () {
    if (maxed.has(this)) return;
    const normal = this.getBounds();
    maxed.set(this, normal); // before the resize, whose handlers ask isMaximized()
    this.setBounds(getScreen().getDisplayMatching(normal).workArea);
    if (!this.isVisible()) this.show();
    this.emit('maximize');
  };
  P.unmaximize = function () {
    const normal = maxed.get(this);
    if (!normal) return;
    maxed.delete(this);
    this.setBounds(normal);
    this.emit('unmaximize');
  };

  P.isFocusable = function () { return takesFocus.get(this) ?? true; };
  P.setFocusable = function (on) { takesFocus.set(this, !!on); };
  P.show = function () { this.showInactive(); if (this.isFocusable()) give(this); };
  P.focus = function () { if (this.isVisible() && this.isFocusable()) give(this); };
  // Electron's moveTop is a SetWindowPos without SWP_NOACTIVATE: it took the foreground.
  // Off every screen, nothing is above or below anything you can see.
  P.moveTop = function () {};
  P.blur = function () { if (focused === this) give(null); };
  P.hide = function () { raw.hide.call(this); if (focused === this) give(null); };
  P.isFocused = function () { return focused === this && alive(this) && this.isVisible(); };
  BrowserWindow.getFocusedWindow = () => (alive(focused) && focused.isVisible() ? focused : null);

  /** A new window: remember where it was asked to be, and keep it off screen. */
  const adopt = (win, focusable = true) => {
    takesFocus.set(win, focusable !== false);
    want.set(win, win.getBounds());
    // Showing a new transparent window can still move it on screen (the crab):
    // back off at once, before a frame of it is drawn.
    const back = () => { if (!win.isDestroyed() && !isFar(raw.getBounds.call(win).x)) raw.setBounds.call(win, toReal(want.get(win))); };
    win.on('move', back);
    win.on('show', back);
    win.once('closed', () => { if (focused === win) focused = null; });
  };
  return { adopt, focused: () => focused };
}

/**
 * Before any window exists, and before any module takes BrowserWindow from
 * require('electron'). electron: the real module (its screen isn't touched before
 * ready). -> { BrowserWindow: the subclass handed out, focused() } for tests.
 */
function keepOffScreen(electron) {
  const { app } = electron;
  const Orig = electron.BrowserWindow;
  const getScreen = () => electron.screen;
  let home = null;
  app.whenReady().then(() => { home = onlyHome(getScreen()); }); // ahead of main.js's own whenReady
  const windows = patchWindows(Orig, getScreen);
  class OffScreenWindow extends Orig {
    constructor(opts) {
      super(offScreenOptions(opts, (home || onlyHome(getScreen())).workArea));
      windows.adopt(this, opts?.focusable);
    }
  }
  handOut(electron, OffScreenWindow);
  return { BrowserWindow: OffScreenWindow, focused: windows.focused };
}

module.exports = { keepOffScreen, patchWindows, offScreenOptions, handOut, onlyHome, homeDisplay, toReal, toSeen, FAR_X };
