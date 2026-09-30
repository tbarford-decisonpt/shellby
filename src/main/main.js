const {
  app, BrowserWindow, ipcMain, screen, Menu, Tray, shell, dialog,
  globalShortcut, Notification, nativeImage, session: electronSession,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');

const { Config, MODES } = require('./config');
const { History } = require('./history');
const { SessionManager } = require('./sessions');
const { checkStatus, findClaude } = require('./claude-cli');
const { loadSkins } = require('./skins');
const { keepOnDesktop, sendToBottom } = require('./desktop-layer');
const { clampToDisplays, panelPosition } = require('./placement');
const { ToolboxWatcher } = require('./toolbox');
const { validateRoutine, missedOnStartup, nextRun, describeSchedule, Scheduler } = require('./routines');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const CAPTURE = process.argv.includes('--capture-screenshots');

const BASE_PX = 4;                 // screen pixels per sprite pixel at scale 1
const PANEL_DEFAULT = { width: 460, height: 700 };
const MAX_CREW_SHOWN = 5;          // helper crabs drawn on the desktop
const SLEEP_AFTER_MS = 3 * 60 * 1000;
const TRICKS_KIND = new Set(['skill', 'agent', 'command']);

app.setAppUserModelId('com.xsalmon.shellby');
if (!CAPTURE && !app.requestSingleInstanceLock()) app.exit(0);

let config, history, skins, manager, toolbox, scheduler;
let critter, panel, tray;
let claudeStatus = null;
let crewShown = 0;                 // helper slots currently allotted in the critter window
let shrinkTimer = null;
let flash = null;                  // { state, until } — brief success/error/learned reaction
let lastActivity = Date.now();
let sleepTimer = null;
const routineTabs = new Map();     // tabId -> routine id (for lastStatus bookkeeping)

// ================================================================ windows

const px = () => Math.round(BASE_PX * (config.get('critterScale') || 1));
const helperWidth = () => Math.round(px() * 22 * 0.5) + 10;
const CREW_PAD = 60; // room for helper name tags at the far left
const crewExtra = (slots = crewShown) => (slots ? slots * helperWidth() + CREW_PAD : 0);

function critterBaseSize() {
  const p = px();
  return { width: 22 * p + 72, height: 13 * p + 84 };
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

const webPreferences = { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false };

function createCritter() {
  const size = critterBaseSize();
  const saved = config.get('critterPos');
  const pos = clampToDisplays({ ...(saved || defaultCritterPos(size)), ...size }, workAreas());
  critter = new BrowserWindow({
    ...size, x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    alwaysOnTop: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    title: 'Shellby', icon: ICON, webPreferences,
  });
  secureWindow(critter);
  critter.loadFile(path.join(RENDERER, 'critter', 'critter.html'));
  critter.once('ready-to-show', () => {
    critter.showInactive();
    if (!CAPTURE) keepOnDesktop(critter);
  });
  critter.on('blur', () => sendToBottom(critter));
}

// The critter window grows to the left to make room for helper crabs, keeping
// Shellby himself anchored in place.
function setCrewSlots(n) {
  n = Math.min(n, MAX_CREW_SHOWN);
  if (n === crewShown) return;
  const apply = slots => {
    const b = critter.getBounds();
    const base = critterBaseSize();
    const width = base.width + crewExtra(slots);
    critter.setBounds({ x: b.x + b.width - width, y: b.y, width, height: base.height });
    crewShown = slots;
  };
  clearTimeout(shrinkTimer);
  if (n > crewShown) apply(n);
  else shrinkTimer = setTimeout(() => apply(n), 1100); // let helpers walk home first
}

function saveCritterPos() {
  const b = critter.getBounds();
  const c = clampToDisplays(b, workAreas());
  if (c.x !== b.x || c.y !== b.y) critter.setPosition(c.x, c.y);
  // Persist Shellby's own spot, not the crew-widened window's left edge.
  config.set({ critterPos: { x: c.x + crewExtra(), y: c.y } });
}

function createPanel() {
  const size = config.get('panelSize') || PANEL_DEFAULT;
  panel = new BrowserWindow({
    ...size, minWidth: 400, minHeight: 520,
    show: false, frame: false, backgroundColor: '#0c1719', title: 'Shellby', icon: ICON, webPreferences,
  });
  secureWindow(panel);
  panel.loadFile(path.join(RENDERER, 'panel', 'panel.html'));
  panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });
  panel.on('resized', () => { const [width, height] = panel.getSize(); config.set({ panelSize: { width, height } }); });
}

function showPanel({ focusInput = true, tabId = null } = {}) {
  if (!panel.isVisible()) {
    const b = critter.getBounds();
    const self = { x: b.x + crewExtra(), y: b.y, width: b.width - crewExtra(), height: b.height };
    const [pw, ph] = panel.getSize();
    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const wa = { ...display.workArea };
    // An auto-hiding taskbar leaves workArea == bounds; keep the composer clear of where it pops up.
    if (wa.height === display.bounds.height) wa.height -= 48;
    const p = panelPosition(self, { width: pw, height: ph }, wa);
    panel.setPosition(p.x, p.y);
  }
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.moveTop();
  panel.focus();
  if (tabId) send(panel, 'tab:focus', tabId);
  if (focusInput) send(panel, 'panel:focus-input');
}

function togglePanel() {
  if (panel.isVisible() && panel.isFocused()) panel.hide();
  else showPanel();
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ================================================================ critter state

function activeSkin() {
  return skins.find(s => s.id === config.get('skin')) || skins.find(s => s.id === 'classic') || skins[0];
}

function broadcastSkin() {
  send(critter, 'critter:skin', { skin: activeSkin(), px: px(), helperWidth: helperWidth() });
  send(panel, 'skin', activeSkin());
}

function flashState(state, ms = 7000) {
  flash = { state, until: Date.now() + ms };
  refreshCritter();
  setTimeout(refreshCritter, ms + 50);
}

// Rolls every tab up into one mood: asking > working > flash > idle/sleeping.
function refreshCritter() {
  if (!manager || !critter) return;
  const agg = manager.aggregate;
  let state = agg.state;
  if (state !== 'idle') lastActivity = Date.now();
  else if (flash && flash.until > Date.now()) state = flash.state;
  else if (Date.now() - lastActivity > SLEEP_AFTER_MS) state = 'sleeping';

  send(critter, 'critter:state', {
    state,
    busy: agg.busy,
    crew: agg.crew.slice(0, MAX_CREW_SHOWN),
    moreCrew: Math.max(0, agg.crew.length - MAX_CREW_SHOWN),
  });
  setCrewSlots(agg.crew.length);

  clearTimeout(sleepTimer);
  if (state === 'idle') sleepTimer = setTimeout(refreshCritter, SLEEP_AFTER_MS - (Date.now() - lastActivity) + 100);
  tray?.setToolTip(agg.busy ? `Shellby: ${agg.busy} task${agg.busy > 1 ? 's' : ''} running` : 'Shellby');
}

function wake() {
  lastActivity = Date.now();
  refreshCritter();
}

// ================================================================ sessions

function currentCwd() {
  const cwd = config.get('cwd');
  return cwd && fs.existsSync(cwd) ? cwd : os.homedir();
}

function createManager() {
  manager = new SessionManager({
    history,
    getExe: () => claudeStatus?.exe || findClaude(),
    getMode: () => config.get('mode'),
    getModel: () => config.get('model'),
  });

  manager.on('item', (tabId, item, tab) => {
    if (item.kind === 'usage') {
      config.set({ lastUsage: { ...item, at: Date.now() } });
      send(panel, 'usage', item);
      return;
    }
    if (item.kind === 'init') {
      toolbox?.setInit(item.toolbox);
      return; // toolbox lists are large; the panel doesn't need them per tab
    }
    send(panel, 'tab:item', { tabId, item });
    if (item.kind === 'permission') onPermission(tabId, item, tab);
    if (item.kind === 'result') onResult(tabId, item, tab);
  });
  manager.on('tabs', summary => {
    send(panel, 'tabs', summary);
    const saved = summary.filter(t => t.saved && !t.routineId).map(t => t.id);
    if (!CAPTURE) config.set({ openTabs: saved });
  });
  manager.on('aggregate', refreshCritter);
}

function onPermission(tabId, item, tab) {
  wake();
  if (panel.isVisible() && panel.isFocused()) return;
  const who = item.agent ? `${item.agent.description || item.agent.type} (helper)` : tab.title;
  notify('Shellby needs your OK', `${who}: ${item.label} ${item.detail}`.slice(0, 160), () => showPanel({ focusInput: false, tabId }));
}

function onResult(tabId, item, tab) {
  const routineId = routineTabs.get(tabId);
  if (routineId) {
    updateRoutine(routineId, { lastStatus: item.interrupted ? 'stopped' : item.ok ? 'ok' : 'error' });
  }
  if (!item.interrupted) flashState(item.ok ? 'success' : 'error');
  if (item.interrupted || (panel.isVisible() && panel.isFocused())) return;
  const secs = Math.round((item.durationMs || 0) / 1000);
  notify(item.ok ? `${routineId ? 'Routine' : 'Shellby'} finished: ${tab.title}` : `Shellby hit a problem: ${tab.title}`,
    item.ok ? `Done in ${secs}s. Click to see what happened.` : (item.error || 'Click for details.'),
    () => showPanel({ tabId }));
}

function notify(title, body, onClick) {
  if (!config.get('notifications') || !Notification.isSupported()) return;
  const n = new Notification({ title: title.slice(0, 80), body, icon: ICON });
  if (onClick) n.on('click', onClick);
  n.show();
}

function openTab({ tabId = randomUUID(), cwd = currentCwd(), historyEntry = null, mode = null, routineId = null, title = null } = {}) {
  return manager.open({ tabId, cwd, historyEntry, mode, routineId, title });
}

function composePrompt(text, files) {
  let prompt = text || 'Take a look at the attached files.';
  if (files.length) prompt += `\n\nAttached files (dropped onto Shellby):\n${files.map(f => `- ${f}`).join('\n')}`;
  return prompt;
}

// ================================================================ toolbox

function createToolbox() {
  toolbox = new ToolboxWatcher({
    home: os.homedir(),
    getCwd: currentCwd,
    getPlugins: () => [],
  });
  toolbox.on('changed', tb => send(panel, 'toolbox', tb));
  toolbox.on('learned', trick => {
    if (!TRICKS_KIND.has(trick.kind)) return;
    const learned = [{ ...trick, at: Date.now() }, ...(config.get('learnedTricks') || [])].slice(0, 30);
    config.set({ learnedTricks: learned });
    send(panel, 'toolbox:learned', trick);
    flashState('learned', 5000);
    const noun = { skill: 'skill', agent: 'helper agent', command: 'command' }[trick.kind];
    if (!(panel.isVisible() && panel.isFocused())) {
      notify(`Shellby learned a new ${noun}`, `${trick.name}${trick.description ? `: ${trick.description}` : ''}`.slice(0, 160),
        () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'toolbox'); });
    }
  });
  toolbox.start();
}

function pinnedTools() {
  return (config.get('pinnedTools') || []).filter(p => p && TRICKS_KIND.has(p.kind) && typeof p.name === 'string');
}

// ================================================================ routines

function routines() { return Array.isArray(config.get('routines')) ? config.get('routines') : []; }

function routinesView() {
  const now = Date.now();
  return routines().map(r => ({
    ...r, next: nextRun(r, now), scheduleText: describeSchedule(r.schedule),
    running: [...routineTabs.entries()].some(([tabId, id]) => id === r.id && manager.isBusy(tabId)),
  }));
}

function saveRoutines(list) {
  config.set({ routines: list });
  send(panel, 'routines', routinesView());
}

function updateRoutine(id, patch) {
  saveRoutines(routines().map(r => (r.id === id ? { ...r, ...patch } : r)));
}

function runRoutine(r, { reason = 'scheduled' } = {}) {
  const busyTab = [...routineTabs.entries()].find(([tabId, id]) => id === r.id && manager.isBusy(tabId));
  if (busyTab) return { ok: false, error: `"${r.name}" is still running from last time.` };
  if (!claudeStatus?.loggedIn) return { ok: false, error: 'Claude Code is not signed in.' };
  try {
    const tabId = randomUUID();
    const cwd = r.cwd && fs.existsSync(r.cwd) ? r.cwd : currentCwd();
    openTab({ tabId, cwd, mode: r.mode, routineId: r.id, title: `⟳ ${r.name}` });
    routineTabs.set(tabId, r.id);
    const userItem = { kind: 'user', text: r.prompt, title: `⟳ ${r.name}`, routine: { id: r.id, name: r.name, reason } };
    manager.send(tabId, r.prompt, userItem);
    updateRoutine(r.id, { lastRunAt: Date.now(), lastStatus: null });
    send(panel, 'tab:opened', { tabId, entry: history.get(tabId), items: history.load(tabId), background: true });
    return { ok: true, tabId };
  } catch (err) {
    notify(`Routine "${r.name}" couldn't start`, err.message);
    return { ok: false, error: err.message };
  }
}

function startScheduler() {
  scheduler = new Scheduler({ getRoutines: routines });
  scheduler.on('due', r => runRoutine(r));
  scheduler.start();
  // Catch up on slots missed while the PC was off, staggered so they don't stampede.
  const missed = routines().filter(r => missedOnStartup(r, Date.now()));
  missed.forEach((r, i) => setTimeout(() => runRoutine(r, { reason: 'catch-up' }), 8000 + i * 5000));
}

// ================================================================ settings side effects

function applyHotkey(accel, previous) {
  if (previous) { try { globalShortcut.unregister(previous); } catch { /* ignore */ } }
  if (!accel) return true;
  try { return globalShortcut.register(accel, togglePanel); } catch { return false; }
}

function applyLoginItem(open) {
  if (!app.isPackaged) return; // dev runs would register electron.exe itself
  app.setLoginItemSettings({ openAtLogin: !!open });
}

function userSkinsDir() {
  const dir = path.join(app.getPath('userData'), 'skins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ================================================================ IPC

const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000;

function registerIpc() {
  // ---- critter
  let dragOrigin = null;
  ipcMain.on('critter:drag-start', () => { dragOrigin = critter.getPosition(); });
  ipcMain.on('critter:drag-move', (_e, { dx, dy } = {}) => {
    if (dragOrigin && Number.isFinite(dx) && Number.isFinite(dy)) critter.setPosition(dragOrigin[0] + Math.round(dx), dragOrigin[1] + Math.round(dy));
  });
  ipcMain.on('critter:drag-end', () => { dragOrigin = null; saveCritterPos(); sendToBottom(critter); });
  ipcMain.on('critter:click', () => { wake(); togglePanel(); sendToBottom(critter); });
  ipcMain.on('critter:crew-click', (_e, tabId) => { if (isStr(tabId)) showPanel({ focusInput: false, tabId }); });
  ipcMain.on('critter:menu', () => buildMenu().popup({ window: critter }));
  ipcMain.on('critter:drop', (_e, paths) => {
    const files = (Array.isArray(paths) ? paths : []).filter(isStr).slice(0, 20);
    if (!files.length) return;
    showPanel();
    send(panel, 'panel:attach', files);
  });

  // ---- panel lifecycle
  ipcMain.on('panel:hide', () => panel.hide());
  ipcMain.on('panel:minimize', () => panel.minimize());

  ipcMain.handle('app:bootstrap', async () => {
    claudeStatus = CAPTURE ? require('./capture').FAKE_STATUS : await checkStatus();
    const demoHome = 'C:\\Users\\you';
    // Restore the tabs that were open last time (idle until you send something).
    if (!CAPTURE && !manager.tabs.size) {
      for (const id of config.get('openTabs') || []) {
        const entry = history.get(id);
        if (entry) { try { openTab({ tabId: id, historyEntry: entry }); } catch { /* limit reached */ } }
      }
    }
    return {
      version: app.getVersion(),
      settings: CAPTURE ? { ...config.data, onboarded: true, mode: 'ask', recentFolders: [], lastUsage: null } : config.data,
      status: claudeStatus,
      skins,
      skin: activeSkin(),
      sessions: CAPTURE ? [] : history.list(),
      tabs: manager.summary,
      tabItems: Object.fromEntries(manager.summary.map(t => [t.id, history.load(t.id)])),
      toolbox: CAPTURE ? null : toolbox.current,
      pinned: pinnedTools(),
      learned: CAPTURE ? [] : config.get('learnedTricks') || [],
      routines: CAPTURE ? [] : routinesView(),
      cwd: CAPTURE ? `${demoHome}\\Downloads` : currentCwd(),
      home: CAPTURE ? demoHome : os.homedir(),
      packaged: app.isPackaged,
    };
  });
  ipcMain.handle('claude:status', async () => (claudeStatus = await checkStatus()));
  ipcMain.handle('claude:login', () => {
    const exe = claudeStatus?.exe || findClaude();
    if (!exe) return false;
    // Opens its own console window; the CLI walks the user through the browser sign-in.
    require('child_process').spawn(exe, ['auth', 'login'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  });

  // ---- tabs
  ipcMain.handle('tab:new', () => {
    try { return { ok: true, tabId: openTab().id }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('tab:close', (_e, tabId) => {
    if (!isStr(tabId)) return false;
    manager.interrupt(tabId);
    manager.close(tabId);
    routineTabs.delete(tabId);
    return true;
  });
  ipcMain.on('tab:seen', (_e, tabId) => { if (isStr(tabId)) manager.markRead(tabId); });

  ipcMain.handle('task:send', (_e, { tabId, text, attachments } = {}) => {
    text = String(text || '').trim().slice(0, 50000);
    const files = (Array.isArray(attachments) ? attachments : []).filter(isStr).slice(0, 20);
    if (!text && !files.length) return { ok: false, error: 'Type a task first.' };
    if (!claudeStatus?.installed || !claudeStatus?.loggedIn) return { ok: false, error: 'Finish setup first: Claude Code needs to be installed and signed in.' };
    try {
      if (!isStr(tabId) || !manager.tabs.has(tabId)) tabId = openTab({ tabId: isStr(tabId) ? tabId : undefined }).id;
      manager.send(tabId, composePrompt(text, files), { kind: 'user', text, attachments: files });
      wake();
      return { ok: true, tabId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('task:stop', (_e, tabId) => { if (isStr(tabId)) manager.interrupt(tabId); });
  ipcMain.handle('task:permission', (_e, { tabId, requestId, decision, message } = {}) => {
    if (!isStr(tabId) || !isStr(requestId) || !['allow', 'always', 'deny'].includes(decision)) return false;
    return manager.respond(tabId, requestId, decision, typeof message === 'string' ? message.slice(0, 500) : undefined);
  });

  // ---- history
  ipcMain.handle('session:list', () => history.list());
  ipcMain.handle('session:open', (_e, id) => {
    const entry = isStr(id) && history.get(id);
    if (!entry) return null;
    if (!manager.tabs.has(id)) {
      try { openTab({ tabId: id, historyEntry: entry }); } catch (err) { return { error: err.message }; }
    }
    return { tabId: id, entry, items: history.load(id) };
  });
  ipcMain.handle('session:delete', (_e, id) => {
    if (!isStr(id)) return history.list();
    manager.close(id);
    history.remove(id);
    return history.list();
  });

  // ---- settings
  ipcMain.handle('settings:set', async (_e, patch = {}) => {
    const allowed = {};
    for (const k of ['mode', 'hotkey', 'skin', 'critterScale', 'openAtLogin', 'notifications', 'model', 'onboarded', 'autonomousAcknowledged', 'showCrew']) {
      if (k in patch) allowed[k] = patch[k];
    }
    // Turning on Autonomous for the first time needs a native confirmation that
    // renderer code can't click through, even if a renderer were ever compromised.
    if (allowed.autonomousAcknowledged === true && !config.get('autonomousAcknowledged')) {
      const { response } = await dialog.showMessageBox(panel, {
        type: 'warning', title: 'Enable Autonomous mode?', noLink: true,
        message: 'Let Shellby act without asking?',
        detail: 'In Autonomous mode Shellby and its helper agents can edit, run or delete anything your Windows account can, including scripts they write for themselves, without any permission prompt.',
        buttons: ['Enable Autonomous', 'Cancel'], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) { delete allowed.autonomousAcknowledged; if (allowed.mode === 'autonomous') delete allowed.mode; }
    }
    if ('mode' in allowed && !MODES.includes(allowed.mode)) delete allowed.mode;
    if (allowed.mode === 'autonomous' && !config.get('autonomousAcknowledged') && allowed.autonomousAcknowledged !== true) delete allowed.mode;
    if (allowed.autonomousAcknowledged === false) delete allowed.autonomousAcknowledged; // can't be un-acknowledged silently either
    if ('critterScale' in allowed) allowed.critterScale = [0.75, 1, 1.5, 2].includes(allowed.critterScale) ? allowed.critterScale : 1;
    if ('model' in allowed && !['', 'opus', 'sonnet', 'haiku'].includes(allowed.model)) delete allowed.model;
    for (const k of ['openAtLogin', 'notifications', 'onboarded', 'autonomousAcknowledged']) if (k in allowed) allowed[k] = !!allowed[k];
    const prevHotkey = config.get('hotkey');
    let hotkeyError = null;
    if ('hotkey' in allowed && allowed.hotkey !== prevHotkey) {
      if (typeof allowed.hotkey !== 'string' || !applyHotkey(allowed.hotkey, prevHotkey)) {
        hotkeyError = `Couldn't register ${allowed.hotkey}; another app may be using it.`;
        applyHotkey(prevHotkey);
        delete allowed.hotkey;
      }
    }
    config.set(allowed);
    if ('mode' in allowed) manager.setMode(allowed.mode);
    if ('openAtLogin' in allowed) applyLoginItem(allowed.openAtLogin);
    if ('skin' in allowed) broadcastSkin();
    if ('critterScale' in allowed) {
      const size = critterBaseSize();
      const b = critter.getBounds();
      const width = size.width + crewExtra();
      // Grow/shrink around the critter's feet so it doesn't jump.
      critter.setBounds({ x: b.x + b.width - width, y: b.y + b.height - size.height, width, height: size.height });
      broadcastSkin();
    }
    return { settings: config.data, hotkeyError };
  });
  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(panel, { title: 'Where should Shellby work?', defaultPath: currentCwd(), properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : setFolder(r.filePaths[0]);
  });
  ipcMain.handle('folder:set', (_e, dir) => (isStr(dir) && fs.existsSync(dir) ? setFolder(dir) : null));
  ipcMain.handle('folder:pick-any', async () => {
    const r = await dialog.showOpenDialog(panel, { title: 'Choose a folder', defaultPath: currentCwd(), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  });

  // ---- skins
  ipcMain.handle('skins:reload', () => { skins = loadSkins(userSkinsDir()); broadcastSkin(); return skins; });
  ipcMain.on('skins:open-folder', () => shell.openPath(userSkinsDir()));

  // ---- toolbox
  ipcMain.handle('toolbox:get', () => toolbox.current);
  ipcMain.handle('toolbox:rescan', () => { toolbox.rescan(); return toolbox.current; });
  ipcMain.handle('toolbox:pin', (_e, { kind, name, pinned } = {}) => {
    if (!TRICKS_KIND.has(kind) || !isStr(name)) return pinnedTools();
    const rest = pinnedTools().filter(p => !(p.kind === kind && p.name === name));
    config.set({ pinnedTools: pinned ? [...rest, { kind, name }].slice(-12) : rest });
    return pinnedTools();
  });
  ipcMain.on('toolbox:reveal', (_e, p) => {
    // Only reveal files the toolbox itself reported (never arbitrary paths from the renderer).
    const known = toolbox.current && ['skills', 'agents', 'commands'].some(k => toolbox.current[k].some(t => t.path === p));
    if (known) shell.showItemInFolder(p);
  });

  // ---- routines
  ipcMain.handle('routines:list', () => routinesView());
  ipcMain.handle('routines:save', (_e, input) => {
    const existing = routines().find(r => r.id === input?.id);
    const { routine, errors } = validateRoutine({ ...existing, ...input }, { allowAutonomous: !!config.get('autonomousAcknowledged') });
    if (!routine) return { ok: false, errors };
    const list = existing ? routines().map(r => (r.id === routine.id ? routine : r)) : [...routines(), routine];
    if (list.length > 50) return { ok: false, errors: ['That is a lot of routines. Delete some first (limit 50).'] };
    saveRoutines(list);
    return { ok: true, routine, routines: routinesView() };
  });
  ipcMain.handle('routines:delete', (_e, id) => { saveRoutines(routines().filter(r => r.id !== id)); return routinesView(); });
  ipcMain.handle('routines:run', (_e, id) => {
    const r = routines().find(x => x.id === id);
    return r ? runRoutine(r, { reason: 'manual' }) : { ok: false, error: 'Routine not found.' };
  });

  // ---- misc
  ipcMain.on('open-external', (_e, url) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* ignore bad urls */ }
  });
  ipcMain.on('open-data-folder', () => shell.openPath(app.getPath('userData')));
}

function setFolder(dir) {
  config.set({ cwd: dir });
  config.addRecentFolder(dir);
  toolbox?.rescan();
  return { cwd: dir, settings: config.data };
}

// ================================================================ tray + menu

function buildMenu() {
  const agg = manager?.aggregate;
  return Menu.buildFromTemplate([
    { label: 'Open Shellby', click: () => showPanel() },
    { label: 'New conversation', click: () => { showPanel(); send(panel, 'tab:new-request'); } },
    { label: 'Toolbox', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'toolbox'); } },
    { label: 'Routines', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'routines'); } },
    { type: 'separator' },
    ...(agg?.busy ? [{ label: `${agg.busy} task${agg.busy > 1 ? 's' : ''} running`, enabled: false }, { type: 'separator' }] : []),
    { label: 'Settings…', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'settings'); } },
    { label: 'Reset position', click: () => { const p = defaultCritterPos(critterBaseSize()); critter.setPosition(p.x - crewExtra(), p.y); config.set({ critterPos: p }); } },
    { label: 'Data folder (history, skins)', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit Shellby', click: quit },
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : img);
  tray.setToolTip('Shellby');
  tray.on('click', () => showPanel());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

function quit() {
  app.isQuitting = true;
  manager?.closeAll();
  app.quit();
}

// ================================================================ updates

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

// ================================================================ boot

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  config = new Config(userData);
  history = new History(path.join(userData, 'sessions'));
  skins = loadSkins(userSkinsDir());

  // Renderers never need camera, mic, geolocation etc.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  createManager();
  registerIpc();
  createCritter();
  createPanel();
  critter.webContents.on('did-finish-load', () => { broadcastSkin(); refreshCritter(); });

  if (CAPTURE) return require('./capture').run({ app, critter, panel, showPanel, send, ROOT, setCrewSlots });

  createToolbox();
  createTray();
  if (!applyHotkey(config.get('hotkey'))) console.warn('[shellby] hotkey unavailable:', config.get('hotkey'));
  applyLoginItem(config.get('openAtLogin'));
  setupUpdates();
  checkStatus().then(s => { claudeStatus = s; startScheduler(); });

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
app.on('will-quit', () => { globalShortcut.unregisterAll(); scheduler?.stop(); toolbox?.stop(); });
app.on('before-quit', () => { app.isQuitting = true; manager?.closeAll(); });
