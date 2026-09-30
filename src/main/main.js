const {
  app, BrowserWindow, ipcMain, screen, Menu, Tray, shell, dialog,
  globalShortcut, Notification, nativeImage, session: electronSession,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Config, MODES } = require('./config');
const { History } = require('./history');
const { ClaudeSession } = require('./session');
const { checkStatus, findClaude } = require('./claude-cli');
const { loadSkins } = require('./skins');
const { keepOnDesktop, sendToBottom } = require('./desktop-layer');
const { clampToDisplays, panelPosition } = require('./placement');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const CAPTURE = process.argv.includes('--capture-screenshots');

const BASE_PX = 4;           // screen pixels per sprite pixel at scale 1
const PANEL_DEFAULT = { width: 440, height: 660 };

app.setAppUserModelId('com.sandoxus.shellby');
if (!CAPTURE && !app.requestSingleInstanceLock()) app.exit(0);

let config, history, skins;
let critter, panel, tray;
let current = null;          // { session: ClaudeSession, historyId }
let claudeStatus = null;
let sleepTimer = null;
let critterState = 'idle';

// ---------------------------------------------------------------- windows

function critterSize() {
  const px = Math.round(BASE_PX * (config.get('critterScale') || 1));
  return { width: 22 * px + 72, height: 13 * px + 84 };
}

function workAreas() { return screen.getAllDisplays().map(d => d.workArea); }

function defaultCritterPos(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - size.width - 48, y: wa.y + wa.height - size.height - 24 };
}

function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function createCritter() {
  const size = critterSize();
  const saved = config.get('critterPos');
  const pos = clampToDisplays({ ...(saved || defaultCritterPos(size)), ...size }, workAreas());
  critter = new BrowserWindow({
    ...size, x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    alwaysOnTop: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    title: 'Shellby',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  secureWindow(critter);
  critter.loadFile(path.join(RENDERER, 'critter', 'critter.html'));
  critter.once('ready-to-show', () => {
    critter.showInactive();
    if (!CAPTURE) keepOnDesktop(critter);
  });
  critter.on('blur', () => sendToBottom(critter));
}

function createPanel() {
  const size = config.get('panelSize') || PANEL_DEFAULT;
  panel = new BrowserWindow({
    ...size, minWidth: 380, minHeight: 480,
    show: false, frame: false, backgroundColor: '#0c1719', title: 'Shellby', icon: ICON,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  secureWindow(panel);
  panel.loadFile(path.join(RENDERER, 'panel', 'panel.html'));
  panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });
  panel.on('resized', () => { const [width, height] = panel.getSize(); config.set({ panelSize: { width, height } }); });
}

function showPanel({ focusInput = true } = {}) {
  if (!panel.isVisible()) {
    const [x, y] = critter.getPosition();
    const [w, h] = critter.getSize();
    const [pw, ph] = panel.getSize();
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    const p = panelPosition({ x, y, width: w, height: h }, { width: pw, height: ph }, wa);
    panel.setPosition(p.x, p.y);
  }
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.moveTop();
  panel.focus();
  if (focusInput) send(panel, 'panel:focus-input');
}

function togglePanel() {
  if (panel.isVisible() && panel.isFocused()) panel.hide();
  else showPanel();
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- critter state

function setCritterState(state) {
  critterState = state;
  send(critter, 'critter:state', state);
  clearTimeout(sleepTimer);
  if (state === 'success' || state === 'error') {
    sleepTimer = setTimeout(() => setCritterState('idle'), 7000);
  } else if (state === 'idle') {
    sleepTimer = setTimeout(() => { if (critterState === 'idle') setCritterState('sleeping'); }, 3 * 60 * 1000);
  }
}

function activeSkin() {
  return skins.find(s => s.id === config.get('skin')) || skins.find(s => s.id === 'classic') || skins[0];
}

function broadcastSkin() {
  const skin = activeSkin();
  send(critter, 'critter:skin', { skin, px: Math.round(BASE_PX * (config.get('critterScale') || 1)) });
  send(panel, 'skin', skin);
}

// ---------------------------------------------------------------- sessions

function currentCwd() {
  const cwd = config.get('cwd');
  return cwd && fs.existsSync(cwd) ? cwd : os.homedir();
}

function endSession() {
  if (!current) return;
  current.session.removeAllListeners();
  current.session.close();
  current = null;
}

function startSession({ historyEntry = null } = {}) {
  endSession();
  const exe = claudeStatus?.exe || findClaude();
  if (!exe) throw new Error('Claude Code is not installed.');
  const session = new ClaudeSession({
    exe, cwd: historyEntry?.cwd || currentCwd(), mode: config.get('mode'), model: config.get('model') || null,
    resumeId: historyEntry?.claudeSessionId || null,
  });
  current = { session, historyId: historyEntry?.id || null };
  const mine = current;

  session.on('item', item => {
    if (current !== mine) return;
    if (item.kind === 'usage') {
      config.set({ lastUsage: { ...item, at: Date.now() } });
    }
    if (item.kind === 'init' && mine.historyId) history.update(mine.historyId, { claudeSessionId: item.sessionId });
    if (mine.historyId) history.append(mine.historyId, item);
    if (item.kind === 'permission') onPermission(item);
    if (item.kind === 'result') onResult(item);
    if (item.kind === 'decision' && critterState === 'asking') setCritterState('working');
    send(panel, 'session:item', item);
  });
  session.on('busy', busy => {
    if (current !== mine) return;
    send(panel, 'session:busy', busy);
    if (busy) setCritterState('working');
  });
  return current;
}

function onPermission(item) {
  setCritterState('asking');
  if (!panel.isVisible() || !panel.isFocused()) {
    notify('Shellby needs your OK', `${item.label}: ${item.detail}`.slice(0, 140), () => showPanel({ focusInput: false }));
  }
}

function onResult(item) {
  setCritterState(item.ok || item.interrupted ? 'success' : 'error');
  if (item.interrupted) return setCritterState('idle');
  if (!panel.isVisible() || !panel.isFocused()) {
    notify(item.ok ? 'Shellby finished' : 'Shellby hit a problem',
      item.ok ? `Done in ${Math.round((item.durationMs || 0) / 1000)}s. Click to see what happened.` : (item.error || 'Click for details.'),
      () => showPanel());
  }
}

function notify(title, body, onClick) {
  if (!config.get('notifications') || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ---------------------------------------------------------------- settings side effects

function applyHotkey(accel, previous) {
  if (previous) { try { globalShortcut.unregister(previous); } catch { /* ignore */ } }
  if (!accel) return true;
  try { return globalShortcut.register(accel, togglePanel); } catch { return false; }
}

function applyLoginItem(open) {
  if (!app.isPackaged) return; // dev runs would register electron.exe itself
  app.setLoginItemSettings({ openAtLogin: !!open });
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  // critter
  let dragOrigin = null;
  ipcMain.on('critter:drag-start', () => { dragOrigin = critter.getPosition(); });
  ipcMain.on('critter:drag-move', (_e, { dx, dy }) => {
    if (dragOrigin) critter.setPosition(dragOrigin[0] + Math.round(dx), dragOrigin[1] + Math.round(dy));
  });
  ipcMain.on('critter:drag-end', () => {
    dragOrigin = null;
    const b = critter.getBounds();
    const c = clampToDisplays(b, workAreas());
    if (c.x !== b.x || c.y !== b.y) critter.setPosition(c.x, c.y);
    config.set({ critterPos: { x: c.x, y: c.y } });
    sendToBottom(critter);
  });
  ipcMain.on('critter:click', () => { if (critterState === 'sleeping') setCritterState('idle'); togglePanel(); sendToBottom(critter); });
  ipcMain.on('critter:menu', () => buildMenu().popup({ window: critter }));
  ipcMain.on('critter:drop', (_e, paths) => {
    const files = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && p).slice(0, 20);
    if (!files.length) return;
    showPanel();
    send(panel, 'panel:attach', files);
  });

  // panel lifecycle
  ipcMain.on('panel:hide', () => panel.hide());
  ipcMain.on('panel:minimize', () => panel.minimize());

  ipcMain.handle('app:bootstrap', async () => {
    claudeStatus = CAPTURE ? require('./capture').FAKE_STATUS : await checkStatus();
    const demoHome = 'C:\\Users\\you';
    return {
      version: app.getVersion(),
      settings: CAPTURE ? { ...config.data, onboarded: true, mode: 'ask', recentFolders: [], lastUsage: null } : config.data,
      status: claudeStatus,
      skins,
      skin: activeSkin(),
      sessions: CAPTURE ? [] : history.list(),
      cwd: CAPTURE ? `${demoHome}\\Downloads` : currentCwd(),
      home: CAPTURE ? demoHome : os.homedir(),
      packaged: app.isPackaged,
      busy: !!current?.session.busy,
    };
  });
  ipcMain.handle('claude:status', async () => (claudeStatus = await checkStatus()));
  ipcMain.handle('claude:login', () => {
    const exe = claudeStatus?.exe || findClaude();
    if (!exe) return false;
    // Opens its own console window; the CLI walks the user through the browser sign-in.
    const { spawn } = require('child_process');
    spawn(exe, ['auth', 'login'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  });

  // tasks
  ipcMain.handle('task:send', (_e, { text, attachments }) => {
    text = String(text || '').trim();
    const files = (attachments || []).filter(f => typeof f === 'string');
    if (!text && !files.length) return { ok: false, error: 'Type a task first.' };
    if (!claudeStatus?.installed || !claudeStatus?.loggedIn) return { ok: false, error: 'Finish setup first: Claude Code needs to be installed and signed in.' };
    let prompt = text || 'Take a look at the attached files.';
    if (files.length) prompt += `\n\nAttached files (dropped onto Shellby):\n${files.map(f => `- ${f}`).join('\n')}`;
    try {
      if (!current) {
        startSession();
      }
      if (!current.historyId) {
        const entry = history.create({ title: text || path.basename(files[0]), cwd: current.session.cwd, mode: config.get('mode') });
        current.historyId = entry.id;
        send(panel, 'sessions', history.list());
      }
      const userItem = { kind: 'user', text, attachments: files };
      history.append(current.historyId, userItem);
      current.session.send(prompt);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('task:stop', () => current?.session.interrupt());
  ipcMain.handle('task:permission', (_e, { requestId, decision, message }) => {
    if (!['allow', 'always', 'deny'].includes(decision)) return false;
    return current?.session.respond(requestId, decision, message) || false;
  });

  // sessions
  ipcMain.handle('session:new', () => { if (current?.session.busy) return false; endSession(); setCritterState('idle'); return true; });
  ipcMain.handle('session:list', () => history.list());
  ipcMain.handle('session:open', (_e, id) => {
    const entry = history.get(id);
    if (!entry || current?.session.busy) return null;
    startSession({ historyEntry: entry });
    return { entry, items: history.load(id) };
  });
  ipcMain.handle('session:delete', (_e, id) => {
    if (current?.historyId === id) endSession();
    history.remove(id);
    return history.list();
  });

  // settings
  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = {};
    for (const k of ['mode', 'hotkey', 'skin', 'critterScale', 'openAtLogin', 'notifications', 'model', 'onboarded', 'autonomousAcknowledged']) {
      if (k in (patch || {})) allowed[k] = patch[k];
    }
    if ('mode' in allowed && !MODES.includes(allowed.mode)) delete allowed.mode;
    if (allowed.mode === 'autonomous' && !config.get('autonomousAcknowledged') && !allowed.autonomousAcknowledged) delete allowed.mode;
    if ('critterScale' in allowed) allowed.critterScale = [0.75, 1, 1.5, 2].includes(allowed.critterScale) ? allowed.critterScale : 1;
    const prevHotkey = config.get('hotkey');
    let hotkeyError = null;
    if ('hotkey' in allowed && allowed.hotkey !== prevHotkey) {
      if (!applyHotkey(allowed.hotkey, prevHotkey)) {
        hotkeyError = `Couldn't register ${allowed.hotkey}; another app may be using it.`;
        applyHotkey(prevHotkey);
        delete allowed.hotkey;
      }
    }
    config.set(allowed);
    if ('mode' in allowed) current?.session.setMode(allowed.mode);
    if ('openAtLogin' in allowed) applyLoginItem(allowed.openAtLogin);
    if ('skin' in allowed) broadcastSkin();
    if ('critterScale' in allowed) {
      const size = critterSize();
      const b = critter.getBounds();
      // Grow/shrink around the critter's feet so it doesn't jump.
      critter.setBounds({ x: b.x + b.width - size.width, y: b.y + b.height - size.height, ...size });
      broadcastSkin();
    }
    return { settings: config.data, hotkeyError };
  });
  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(panel, { title: 'Where should Shellby work?', defaultPath: currentCwd(), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return setFolder(r.filePaths[0]);
  });
  ipcMain.handle('folder:set', (_e, dir) => (typeof dir === 'string' && fs.existsSync(dir) ? setFolder(dir) : null));
  ipcMain.handle('skins:reload', () => { skins = loadSkins(userSkinsDir()); broadcastSkin(); return skins; });
  ipcMain.on('skins:open-folder', () => shell.openPath(userSkinsDir()));
  ipcMain.on('open-external', (_e, url) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* ignore bad urls */ }
  });
  ipcMain.on('open-data-folder', () => shell.openPath(app.getPath('userData')));
}

function setFolder(dir) {
  if (current?.session.busy) return { error: 'Wait for the current task to finish first.' };
  config.set({ cwd: dir });
  config.addRecentFolder(dir);
  endSession();
  return { cwd: dir, settings: config.data };
}

function userSkinsDir() {
  const dir = path.join(app.getPath('userData'), 'skins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- tray + menu

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Shellby', click: () => showPanel() },
    { label: 'New conversation', click: () => { if (!current?.session.busy) { endSession(); send(panel, 'session:reset'); } showPanel(); } },
    { type: 'separator' },
    { label: 'Settings…', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'settings'); } },
    { label: 'Reset position', click: () => { const p = defaultCritterPos(critterSize()); critter.setPosition(p.x, p.y); config.set({ critterPos: p }); } },
    { label: 'Data folder (history, skins)', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit Shellby', click: quit },
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : img);
  tray.setToolTip('Shellby');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => showPanel());
}

function quit() {
  app.isQuitting = true;
  endSession();
  app.quit();
}

// ---------------------------------------------------------------- updates

function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = null;
    autoUpdater.autoInstallOnAppQuit = true;
    // Offline, no releases yet, rate-limited: none of it matters to the user.
    autoUpdater.on('error', err => console.warn('[shellby] update check failed:', err.message.split('\n')[0]));
    autoUpdater.on('update-downloaded', info => {
      send(panel, 'update-ready', info.version);
      notify('Shellby update ready', `Version ${info.version} installs when you quit Shellby.`);
    });
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[shellby] updater unavailable:', e.message);
  }
}

// ---------------------------------------------------------------- boot

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  config = new Config(userData);
  history = new History(path.join(userData, 'sessions'));
  skins = loadSkins(userSkinsDir());

  // Renderers never need camera, mic, geolocation etc.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  registerIpc();
  createCritter();
  createPanel();
  critter.webContents.on('did-finish-load', () => { broadcastSkin(); setCritterState('idle'); });

  if (CAPTURE) return require('./capture').run({ app, critter, panel, showPanel, send, ROOT });

  createTray();
  if (!applyHotkey(config.get('hotkey'))) console.warn('[shellby] hotkey unavailable:', config.get('hotkey'));
  applyLoginItem(config.get('openAtLogin'));
  setupUpdates();

  const reclamp = () => {
    const c = clampToDisplays(critter.getBounds(), workAreas());
    critter.setPosition(c.x, c.y);
  };
  screen.on('display-removed', reclamp);
  screen.on('display-metrics-changed', reclamp);

  if (!config.get('onboarded')) showPanel({ focusInput: false });
});

app.on('second-instance', () => showPanel());
app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { app.isQuitting = true; endSession(); });
