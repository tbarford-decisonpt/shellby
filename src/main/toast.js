// Shellby's own pop-up notifications, drawn like the rest of the app instead of
// as a plain Windows toast.
//
// Each notice is a small frameless window stacked in the bottom-right corner of
// the screen Shellby lives on. It never takes focus, so it can't steal your
// typing. Like the confirmation windows it has its own preload, and clicks are
// accepted only from that exact window's webContents.
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const WIDTH = 380;
const GAP = -16; // windows overlap their shadow room, leaving 12px between the cards
const MARGIN = 4; // plus the 14px of shadow room inside each window
const MAX_SHOWN = 3;
const shown = []; // newest last: { win, height, display, finish }
let wired = false;

const entryFor = sender => shown.find(t => !t.win.isDestroyed() && t.win.webContents.id === sender.id);

function wire() {
  if (wired) return;
  wired = true;
  ipcMain.on('toast:click', e => entryFor(e.sender)?.finish(true));
  ipcMain.on('toast:dismiss', e => entryFor(e.sender)?.finish(false));
  ipcMain.on('toast:resize', (e, height) => {
    const entry = entryFor(e.sender);
    if (!entry || !Number.isFinite(height)) return;
    entry.height = Math.max(64, Math.min(240, Math.round(height)));
    layout();
    if (!entry.win.isVisible()) entry.win.showInactive();
  });
}

// Newest at the bottom, older ones pushed up above it.
function layout() {
  let bottom = null;
  for (let i = shown.length - 1; i >= 0; i--) {
    const t = shown[i];
    if (t.win.isDestroyed()) continue;
    const wa = t.display.workArea;
    if (bottom === null) bottom = wa.y + wa.height - MARGIN;
    const y = bottom - t.height;
    t.win.setBounds({ x: wa.x + wa.width - WIDTH - MARGIN, y, width: WIDTH, height: t.height });
    bottom = y - GAP;
  }
}

// spec: { title, body, tone: 'info' | 'urgent' | 'danger', sticky, skin, accessories, shell }
// near: a rectangle on the display to show it on (where Shellby is).
// onClick runs if the notice is clicked; closing it with × does nothing.
function show(spec, { near = null, onClick = null } = {}) {
  wire();
  const display = near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: WIDTH, height: 96, show: false, frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false, skipTaskbar: true, focusable: false, hasShadow: false,
    alwaysOnTop: true, title: spec.title,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'toast-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  let done = false;
  const entry = {
    win, height: 96, display,
    finish(clicked) {
      if (done) return;
      done = true;
      const i = shown.indexOf(entry);
      if (i >= 0) shown.splice(i, 1);
      if (!win.isDestroyed()) win.close();
      layout();
      if (clicked && onClick) onClick();
    },
  };
  shown.push(entry);
  while (shown.length > MAX_SHOWN) shown[0].finish(false);
  win.on('closed', () => entry.finish(false));
  win.webContents.once('did-finish-load', () => win.webContents.send('toast:show', spec));
  // Safety net: show even if the renderer never reports its size.
  setTimeout(() => { if (!done && !win.isDestroyed() && !win.isVisible()) { layout(); win.showInactive(); } }, 1500);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'toast', 'toast.html'));
}

function closeAll() {
  for (const t of [...shown]) t.finish(false);
}

module.exports = { show, closeAll };
