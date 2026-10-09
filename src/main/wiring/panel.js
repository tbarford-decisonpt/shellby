// The panel's window: made once and hidden rather than closed, opened beside
// the crab, kept behind a game unless you reached for it, and grown to "make
// room" for a workflow map and put back after.
// Kept out of main.js, which only wires it up.
const { BrowserWindow, app, ipcMain, screen } = require('electron');
const path = require('path');
const { attachContextMenu } = require('../context-menu');
const { sendToBottom } = require('../desktop-layer');
const native = require('../native-windows');
const { panelPosition } = require('../placement');
const { kindOfApp } = require('../surroundings');

const PANEL_DEFAULT = { width: 460, height: 700 };
// "Make room" on a workflow map: the panel grows toward the middle of its screen,
// and goes back to its size after. Only you resizing it is ever remembered.
const ROOMY = { width: 1180, height: 780, gap: 8, settleMs: 800 };
// Long enough to pick an item from the crab's menu or the tray's.
const REACHED_MS = 15000;
// An auto-hiding taskbar's height, kept clear of the composer.
const AUTOHIDE_TASKBAR_PX = 48;

const clampInto = (r, wa) => ({
  ...r,
  x: Math.round(Math.min(Math.max(r.x, wa.x + ROOMY.gap), wa.x + wa.width - r.width - ROOMY.gap)),
  y: Math.round(Math.min(Math.max(r.y, wa.y + ROOMY.gap), wa.y + wa.height - r.height - ROOMY.gap)),
});

/**
 * Where the panel at bounds b grows to on work area wa: toward the middle of
 * the screen, so it keeps the corner nearest the screen's edge. want: the size
 * it's after (Make room's, or what the panes need). Pure.
 * -> { set, right, low } | null when it's already as big as it would get
 */
function grownBounds(b, wa, want = ROOMY) {
  const width = Math.min(want.width, wa.width - ROOMY.gap * 2);
  const height = Math.max(b.height, Math.min(want.height, wa.height - ROOMY.gap * 2));
  if (width <= b.width && height <= b.height) return null;
  const right = b.x + b.width / 2 > wa.x + wa.width / 2;
  const low = b.y + b.height / 2 > wa.y + wa.height / 2;
  return { set: clampInto({ x: right ? b.x + b.width - width : b.x, y: low ? b.y + b.height - height : b.y, width, height }, wa), right, low };
}

/**
 * Its old size again, for a grown panel that has since been moved to bounds c
 * (on work area wa): the corner it grew from stays where it is now. Pure.
 */
function shrunkBounds({ from, right, low }, c, wa) {
  return clampInto({ x: right ? c.x + c.width - from.width : c.x, y: low ? c.y + c.height - from.height : c.y, width: from.width, height: from.height }, wa);
}

/** d: what main shares (main.js `shared`). */
function wirePanel(d) {
  // ---- the window

  function createPanel() {
    const size = d.config.get('panelSize') || PANEL_DEFAULT;
    const panel = d.panel = new BrowserWindow({
      ...size, minWidth: 400, minHeight: 520,
      show: false, frame: false, backgroundColor: '#0c1719', title: 'Shellby', icon: d.ICON, webPreferences: d.webPreferences,
    });
    d.secureWindow(panel);
    attachContextMenu(panel, ipcMain); // checks the sender itself: only the panel picks from its menu
    panel.loadFile(path.join(d.RENDERER, 'panel', 'panel.html'));
    panel.webContents.on('did-finish-load', () => panel.webContents.setZoomFactor(d.config.get('panelZoom') || 1)); // Ctrl+= / Ctrl+- (ipc/files.js)
    panel.on('focus', reachedForShellby); // clicked into it yourself
    panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });
    // The loops are stepped by a 12 fps timer (shared/framecap.js), and Chromium
    // slows a background window's timers to a crawl: behind another window the
    // spinners froze, which reads as a hung task. Unthrottled only while it's on
    // screen, since this also keeps `document.hidden` false, and the tank, beach
    // and polls rely on that to stop once the panel is put away.
    const throttle = on => { if (!panel.isDestroyed()) panel.webContents.backgroundThrottling = on; };
    panel.on('show', () => throttle(false));
    panel.on('restore', () => throttle(false));
    panel.on('hide', () => throttle(true));
    panel.on('minimize', () => throttle(true));
    panel.on('resized', () => {
      if (Date.now() - roomyAt < ROOMY.settleMs) return; // it was us, not you
      if (panel.isMaximized()) return; // the size to come back to is the one before
      // Resizing it yourself while it's made room keeps your size: there's nothing to put back,
      // and the panel stops asking for room.
      if (roomyFrom) { roomyFrom = null; d.send(panel, 'panel:roomy-lost'); }
      const [width, height] = panel.getSize();
      d.config.set({ panelSize: { width, height } });
    });
  }

  // ---- making room

  let roomyFrom = null; // { from: its bounds before, set: the bounds it grew to, right, low }
  let roomyAt = 0;

  function setPanelRoomy(on) {
    const { panel } = d;
    if (!panel || panel.isDestroyed()) return { ok: false, roomy: false };
    if (!on) {
      if (roomyFrom) {
        const { from, set } = roomyFrom;
        const c = panel.getBounds();
        // Where it was, unless it's been moved (or put back beside the crab) since: then its
        // size, keeping the corner it grew from where it is now.
        const back = c.x === set.x && c.y === set.y ? from : shrunkBounds(roomyFrom, c, screen.getDisplayMatching(c).workArea);
        roomyAt = Date.now();
        panel.setBounds(back);
      }
      roomyFrom = null;
      return { ok: true, roomy: false };
    }
    if (roomyFrom) return { ok: true, roomy: true };
    const b = panel.getBounds();
    const grown = grownBounds(b, screen.getDisplayMatching(b).workArea);
    if (!grown) return { ok: true, roomy: false };
    roomyFrom = { from: b, ...grown };
    roomyAt = Date.now();
    panel.setBounds(grown.set);
    return { ok: true, roomy: true };
  }

  // Room for more panes (tab-panes.js): the panel grows toward the middle of
  // its screen until they fit, and stays that size. Never smaller, never while
  // maximized, and not remembered as your size. want: the window's size in DIP
  // (the renderer has already scaled by its zoom). It's the panes' size now, so
  // Make room has nothing to put back: the map hears it's lost its room, as
  // when you resize it yourself.
  function fitPanel(want) {
    const { panel } = d;
    if (!panel || panel.isDestroyed() || panel.isMaximized()) return { ok: false, grew: false };
    const b = panel.getBounds();
    const w = { width: Math.max(b.width, Math.ceil(want.width)), height: Math.max(b.height, Math.ceil(want.height)) };
    const grown = grownBounds(b, screen.getDisplayMatching(b).workArea, w);
    if (!grown) return { ok: true, grew: false };
    if (roomyFrom) { roomyFrom = null; d.send(panel, 'panel:roomy-lost'); }
    roomyAt = Date.now(); // ours, not yours: the resized handler won't save it as panelSize
    panel.setBounds(grown.set);
    return { ok: true, grew: true };
  }

  // ---- showing it

  // A dev run opens its panel behind whatever you're doing (a game, say) instead of
  // snatching focus, until you reach for Shellby yourself: the crab, the hotkey, the
  // tray, or clicking the panel. SHELLBY_FOREGROUND=1 brings back the packaged behavior.
  let openBehind = !app.isPackaged && process.env.SHELLBY_FOREGROUND !== '1';
  let reachedAt = 0;
  const reachedForShellby = () => { openBehind = false; reachedAt = Date.now(); };

  // Every build, packaged too: with a game in front, the panel only comes forward
  // when you just reached for it (the hotkey, mostly). Anything else (a task from
  // the terminal, a finished routine) opens behind the game.
  function gameInFront(info = native.describe(native.foreground())) {
    const q = native.notificationState();
    if (q === native.QUNS.D3D_FULL_SCREEN || q === native.QUNS.PRESENTATION) return true;
    if (!info || info.pid === process.pid) return false;
    return kindOfApp({ exe: info.exe, path: info.path }) === 'game';
  }

  function showPanel({ focusInput = true, tabId = null } = {}) {
    // A conversation in its own window is shown there instead (wiring/popouts.js).
    if (tabId && d.isPoppedOut(tabId)) return d.showPopout(tabId);
    const { panel } = d;
    if (openBehind || (Date.now() - reachedAt > REACHED_MS && gameInFront())) {
      if (!panel.isVisible()) { if (!panel.isMaximized()) placePanel(); panel.showInactive(); sendToBottom(panel); }
      if (tabId) d.send(panel, 'tab:focus', tabId);
      return;
    }
    if (!panel.isVisible() && !panel.isMaximized()) placePanel();
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.moveTop();
    panel.focus();
    if (tabId) d.send(panel, 'tab:focus', tabId);
    if (focusInput) d.send(panel, 'panel:focus-input');
  }

  // Beside the crab, on his screen.
  function placePanel() {
    const { panel } = d;
    const b = d.critter.getBounds();
    const self = { x: b.x + d.crewExtra(), y: b.y, width: b.width - d.crewExtra(), height: b.height };
    const [pw, ph] = panel.getSize();
    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const wa = { ...display.workArea };
    // An auto-hiding taskbar leaves workArea == bounds; keep the composer clear of where it pops up.
    if (wa.height === display.bounds.height) wa.height -= AUTOHIDE_TASKBAR_PX;
    const p = panelPosition(self, { width: pw, height: ph }, wa);
    panel.setPosition(p.x, p.y);
  }

  function togglePanel() {
    reachedForShellby(); // the crab and the hotkey both land here
    if (d.panel.isVisible() && d.panel.isFocused()) d.panel.hide();
    else showPanel();
  }

  return { createPanel, fitPanel, gameInFront, reachedForShellby, setPanelRoomy, showPanel, togglePanel };
}

module.exports = { wirePanel, grownBounds, shrunkBounds, ROOMY };
