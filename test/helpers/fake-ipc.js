// A stand-in for Electron and its ipcMain, so a src/main/ipc/*.js module can be
// registered and its channels called from plain node --test.
//
//   const electron = installFakeElectron();          // before requiring the module under test
//   const { registerXIpc } = require('../src/main/ipc/x');
//   const ipc = createFakeIpc();
//   registerXIpc(ipc.ipcMain, deps);
//   await ipc.invoke('x:get', arg);                  // as the panel, through ipc-guard.js
//
// Handlers are registered through the real guardIpc/windowPolicy, so a call
// "from the panel" passes the same check it does in the app, and invokeAs()
// can show that the crab's window or a stranger is turned away.
const Module = require('module');
const { EventEmitter } = require('events');
const { guardIpc, windowPolicy } = require('../../src/main/ipc-guard');

/** Every call to a fake function, in order: [{ name, args }]. */
function recorder() {
  const calls = [];
  const fn = (name, impl = () => undefined) => (...args) => { calls.push({ name, args }); return impl(...args); };
  return { calls, fn, of: name => calls.filter(c => c.name === name).map(c => c.args) };
}

// A BrowserWindow that never draws: enough for confirm.js to open, answer and close one.
let nextWindowId = 100;
class FakeBrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.visible = false;
    this.destroyed = false;
    this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width, height: opts.height };
    const wc = new EventEmitter();
    wc.id = nextWindowId++;
    wc.sent = [];
    wc.send = (channel, payload) => wc.sent.push({ channel, payload });
    wc.setWindowOpenHandler = fn => { wc.openHandler = fn; };
    this.webContents = wc;
    FakeBrowserWindow.all.push(this);
  }
  loadFile(file) { this.loaded = file; queueMicrotask(() => this.webContents.emit('did-finish-load')); }
  getBounds() { return { ...this.bounds }; }
  setBounds(b) { this.bounds = { ...b }; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  isMaximized() { return !!this.maximized; }
  show() { this.visible = true; }
  focus() {}
  close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
}
FakeBrowserWindow.all = [];

/**
 * Puts a fake `electron` in require's cache, so modules that require it get
 * this instead of the path to the Electron binary. Returns the fake, whose
 * `calls` record what was asked of shell, clipboard and dialog.
 */
function installFakeElectron({ userData = 'C:\\fake\\userData', pictures = 'C:\\fake\\Pictures' } = {}) {
  const rec = recorder();
  const rawIpc = new EventEmitter(); // confirm.js listens on Electron's own ipcMain
  const electron = {
    calls: rec.calls,
    callsOf: rec.of,
    app: { isPackaged: false, getPath: name => (name === 'pictures' ? pictures : userData), commandLine: { appendSwitch: () => {} } },
    shell: {
      openExternal: rec.fn('shell.openExternal', async () => {}),
      openPath: rec.fn('shell.openPath', async () => ''),
      showItemInFolder: rec.fn('shell.showItemInFolder'),
    },
    clipboard: {
      writeText: rec.fn('clipboard.writeText', async () => {}),
      write: rec.fn('clipboard.write', async () => {}),
    },
    ClipboardItem: class ClipboardItem { constructor(items) { this.items = items; this.types = Object.keys(items); } },
    nativeImage: { createFromBuffer: buf => ({ isEmpty: () => buf.length === 0 }) },
    dialog: { showOpenDialog: rec.fn('dialog.showOpenDialog', async () => ({ canceled: true, filePaths: [] })) },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: rawIpc,
  };
  const key = require.resolve('electron');
  const mod = new Module(key);
  mod.filename = key;
  mod.loaded = true;
  mod.exports = electron;
  require.cache[key] = mod;
  return electron;
}

/**
 * An ipcMain behind the real ipc-guard.js. invoke/send call as the panel;
 * invokeAs/sendAs take any sender (senders.critter, senders.stranger).
 */
function createFakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  const raw = { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => listeners.set(c, fn) };
  const senders = { panel: { id: 1 }, critter: { id: 2 }, stranger: { id: 3 } };
  const refused = [];
  const ipcMain = guardIpc(raw, windowPolicy(() => ({ panel: senders.panel, critter: senders.critter })), {
    onRefused: channel => refused.push(channel),
  });
  const lookup = (map, channel) => {
    const fn = map.get(channel);
    if (!fn) throw new Error(`nothing registered on ${channel}`);
    return fn;
  };
  const invokeAs = (sender, channel, ...args) => {
    const fn = lookup(handlers, channel);
    return Promise.resolve().then(() => fn({ sender }, ...args));
  };
  const sendAs = (sender, channel, ...args) => lookup(listeners, channel)({ sender }, ...args);
  return {
    ipcMain, senders, refused,
    channels: () => [...handlers.keys(), ...listeners.keys()],
    invoke: (channel, ...args) => invokeAs(senders.panel, channel, ...args),
    invokeAs,
    send: (channel, ...args) => sendAs(senders.panel, channel, ...args),
    sendAs,
  };
}

/** A settings store like config.js's: get(key), set(patch), and what was set. */
function fakeConfig(initial = {}) {
  let values = { ...initial };
  const sets = [];
  return {
    sets,
    get: k => values[k],
    set: patch => { sets.push(patch); values = { ...values, ...patch }; },
    all: () => ({ ...values }),
  };
}

const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000;

module.exports = { installFakeElectron, createFakeIpc, fakeConfig, recorder, isStr, FakeBrowserWindow };
