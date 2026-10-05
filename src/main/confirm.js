// Themed confirmation windows that keep the security of native dialogs.
//
// Each question opens its own small window with its own preload. The panel
// renderer can't reach it (separate process, no shared bridge), and answers are
// accepted only from that exact window's webContents, once. So even a
// compromised panel can't approve an install or turn on Autonomous by itself.
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const WIDTH = 440;
const open = new Map(); // webContents.id -> { win, finish }
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  ipcMain.on('dialog:respond', (e, index) => {
    const entry = open.get(e.sender.id);
    if (entry && Number.isInteger(index)) entry.finish(index);
  });
  ipcMain.on('dialog:resize', (e, height) => {
    const entry = open.get(e.sender.id);
    if (!entry || !Number.isFinite(height)) return;
    const h = Math.max(160, Math.min(760, Math.round(height)));
    const b = entry.win.getBounds();
    entry.win.setBounds({ x: b.x, y: Math.round(b.y + (b.height - h) / 2), width: WIDTH, height: h });
    if (!entry.win.isVisible()) { entry.win.show(); entry.win.focus(); }
  });
}

// spec: { title, message, detail, note, icon, danger, items, skin, accessories, shell,
//         buttons: [{ label, style }], defaultId, cancelId }
// Resolves with the index of the chosen button (cancelId if the window closes).
//
// One question at a time, and only a few waiting: a stack of them is how
// someone gets clicked through ("yes, yes, yes"), so anything past that is
// answered Cancel without being shown.
const MAX_WAITING = 3;
let queue = Promise.resolve();
let waiting = 0;

/**
 * @typedef {object} ConfirmSpec
 * @property {string} title
 * @property {string} [message]
 * @property {string} [detail]
 * @property {string} [note]
 * @property {string} [icon]
 * @property {boolean} [danger]
 * @property {{ label: string, style?: string }[]} buttons
 * @property {number} [defaultId]
 * @property {number} [cancelId]  defaults to the last button
 */

/**
 * @param {import('electron').BrowserWindow | null} parent  centred on it (and modal to it) when it's showing
 * @param {ConfirmSpec} spec
 * @returns {Promise<number>} the chosen button's index; cancelId if closed, refused or past MAX_WAITING
 */
function ask(parent, spec) {
  const cancelId = spec.cancelId ?? spec.buttons.length - 1;
  if (waiting >= MAX_WAITING) return Promise.resolve(cancelId);
  waiting++;
  const turn = queue.then(() => show(parent, spec));
  queue = turn.catch(() => {}).finally(() => { waiting--; });
  return turn;
}

function show(parent, spec) {
  wire();
  return new Promise(resolve => {
    const hasParent = parent && !parent.isDestroyed() && parent.isVisible();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const anchor = hasParent ? parent.getBounds() : area;
    const win = new BrowserWindow({
      width: WIDTH, height: 320,
      x: Math.round(anchor.x + (anchor.width - WIDTH) / 2), y: Math.round(anchor.y + (anchor.height - 320) / 2),
      parent: hasParent ? parent : undefined, modal: hasParent,
      show: false, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false,
      skipTaskbar: hasParent, alwaysOnTop: !hasParent, title: spec.title, hasShadow: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'dialog-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    const id = win.webContents.id;
    const cancelId = spec.cancelId ?? spec.buttons.length - 1;
    let done = false;
    const finish = index => {
      if (done) return;
      done = true;
      open.delete(id);
      resolve(index >= 0 && index < spec.buttons.length ? index : cancelId);
      if (!win.isDestroyed()) win.close();
    };
    open.set(id, { win, finish });
    win.on('closed', () => finish(cancelId));
    win.webContents.once('did-finish-load', () => win.webContents.send('dialog:show', { ...spec, cancelId }));
    // Safety net: show even if the renderer never reports its size.
    setTimeout(() => { if (!done && !win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); } }, 1500);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'dialog', 'dialog.html'));
  });
}

module.exports = { ask };
