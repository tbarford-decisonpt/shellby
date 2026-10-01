const {
  app, BrowserWindow, ipcMain, screen, Menu, Tray, shell, dialog,
  globalShortcut, Notification, nativeImage, clipboard, session: electronSession,
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
const { Wardrobe } = require('./wardrobe/service');
const confirm = require('./confirm');
const { validatePack } = require('./wardrobe/catalog');
const { KNOWN_ACHIEVEMENTS } = require('./wardrobe/achievements');
const { KNOWN_SEASONS } = require('./wardrobe/seasons');
const { REGISTRY_URL, PROTOCOL, parseDeepLink, findDeepLink, fetchRegistryPack, fetchRegistryCatalog } = require('./registry');
const { itemHash } = require('./wardrobe/codes');
const { HealthService } = require('./health/service');
const { ExternalSessions, DEFAULT_PORT: HOOK_PORT } = require('./external');
const { FAKE_SCENARIOS } = require('./health/fake');

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
const CARD_MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Dev/test isolation: a separate profile (settings, history, single-instance lock)
// so test runs never touch the user's real Shellby or need it closed.
if (!app.isPackaged && process.env.SHELLBY_USER_DATA) app.setPath('userData', process.env.SHELLBY_USER_DATA);
// Screenshot runs always use a throwaway profile.
if (process.argv.includes('--capture-screenshots') && !process.env.SHELLBY_USER_DATA) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-capture-')));
}
const captureClock = { now: null };
// Dev/e2e only: drive the app with the fake CLI from test/fixtures (no Claude account, no usage).
const FAKE_CLI = !app.isPackaged && process.env.SHELLBY_FAKE_CLAUDE ? path.resolve(process.env.SHELLBY_FAKE_CLAUDE) : null; // screenshot runs can pretend it's Halloween

// Dev/test runs get their own identity so Windows never ties their toasts or
// jump lists to the installed Shellby.
app.setAppUserModelId(app.isPackaged ? 'com.xsalmon.shellby' : 'com.xsalmon.shellby.dev');
if (!CAPTURE && !app.requestSingleInstanceLock()) app.exit(0);

// shellby:// links ("Add to Shellby" on the community gallery). Dev runs only
// register when asked, so they don't hijack the links from an installed Shellby.
if (!CAPTURE) {
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  else if (process.env.SHELLBY_REGISTER_PROTOCOL === '1') app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(ROOT)]);
}
// The community registry. Only dev builds may point elsewhere (for testing).
const registryUrl = () => (!app.isPackaged && process.env.SHELLBY_REGISTRY_URL) || REGISTRY_URL;

let config, history, skins, manager, toolbox, scheduler, wardrobe, health, external;
let critter, panel, tray;
let claudeStatus = null;
let crewShown = 0;                 // helper slots currently allotted in the critter window
let shrinkTimer = null;
let flash = null;                  // { state, until } — brief success/error/learned reaction
let healthMood = null;             // { mood, level, text } from the health monitor, or null
let lastActivity = Date.now();
let sleepTimer = null;
let welcomeTrophies = [];       // achievements credited from history on first run
let booted = false;                // deep links wait for this
let pendingLink = null;
let startView = null;              // view the panel should open on at boot (e.g. a deep link wants the Wardrobe)            // a shellby:// link that arrived before boot finished
let linkBusy = false;              // one registry install at a time
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

// Built-in/user skins plus wardrobe pack skins (which can be locked).
function allSkins() {
  const packSkins = wardrobe ? wardrobe.catalog.skins.map(s => ({ ...s, id: s.key, locked: wardrobe.lockInfo(s) })) : [];
  return [...skins, ...packSkins];
}

function activeSkin() {
  const list = allSkins();
  const chosen = list.find(s => s.id === config.get('skin'));
  return (chosen && !chosen.locked ? chosen : null) || list.find(s => s.id === 'classic') || list[0];
}

function outfit() {
  return wardrobe ? wardrobe.render() : { accessories: [], effect: null, confetti: null, crewAccessories: [] };
}

function broadcastSkin() {
  const skin = activeSkin();
  const o = outfit();
  send(critter, 'critter:skin', { skin, px: px(), helperWidth: helperWidth(), outfit: o });
  send(panel, 'skin', { skin, outfit: o });
}

function dialogLook() {
  const o = outfit();
  return { skin: activeSkin(), accessories: o.accessories };
}

function broadcastWardrobe() {
  broadcastSkin();
  if (wardrobe) send(panel, 'wardrobe', wardrobe.view());
}

function flashState(state, ms = 7000) {
  flash = { state, until: Date.now() + ms };
  refreshCritter();
  setTimeout(refreshCritter, ms + 50);
}

// Rolls every tab up into one mood: asking > working > flash > idle/sleeping.
function refreshCritter() {
  if (!manager || !critter) return;
  const own = manager.aggregate;
  const ext = external?.summary || { state: 'idle', busy: 0, crew: [] };
  // Shellby's own tabs plus Claude Code sessions elsewhere: asking > working > idle.
  const agg = {
    state: own.state === 'asking' || ext.state === 'asking' ? 'asking' : own.state === 'working' || ext.state === 'working' ? 'working' : own.state,
    busy: own.busy + ext.busy,
    crew: [...own.crew, ...ext.crew],
  };
  let state = agg.state;
  if (state !== 'idle') lastActivity = Date.now();
  else if (flash && flash.until > Date.now()) state = flash.state;
  else if (Date.now() - lastActivity > SLEEP_AFTER_MS && healthMood?.level !== 'critical') state = 'sleeping';

  send(critter, 'critter:state', {
    state,
    busy: agg.busy,
    crew: agg.crew.slice(0, MAX_CREW_SHOWN),
    moreCrew: Math.max(0, agg.crew.length - MAX_CREW_SHOWN),
    health: healthMood,
  });
  setCrewSlots(Math.min(agg.crew.length, MAX_CREW_SHOWN));

  clearTimeout(sleepTimer);
  if (state === 'idle') sleepTimer = setTimeout(refreshCritter, SLEEP_AFTER_MS - (Date.now() - lastActivity) + 100);
  const tip = agg.busy ? `Shellby: ${agg.busy} task${agg.busy > 1 ? 's' : ''} running` : 'Shellby';
  tray?.setToolTip(healthMood ? `${tip} · ${HEALTH_TIP[healthMood.mood]} (${healthMood.text})` : tip);
}

const HEALTH_TIP = { hot: 'running hot', scorching: 'overheating', dizzy: 'memory nearly full', stuffed: 'drive nearly full' };

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
    argsPrefix: FAKE_CLI ? [FAKE_CLI] : [],
    history,
    getExe: () => (FAKE_CLI ? process.env.SHELLBY_NODE || 'node' : claudeStatus?.exe || findClaude()),
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
    if (item.kind === 'task' && item.phase === 'started') stat('helper-spawned');
  });
  manager.on('tabs', summary => {
    send(panel, 'tabs', summary);
    const saved = summary.filter(t => t.saved && !t.routineId).map(t => t.id);
    if (!CAPTURE) config.set({ openTabs: saved });
  });
  manager.on('aggregate', agg => {
    refreshCritter();
    const s = wardrobe?.stats;
    if (s && agg.crew.length > s.maxCrew) stat('crew-size', { n: agg.crew.length });
    if (s && agg.busy > s.maxParallel) stat('parallel', { n: agg.busy });
  });
}

// Feed the achievement system; unlocks celebrate via the wardrobe 'unlocked' event.
function stat(event, payload) {
  if (!wardrobe || CAPTURE) return;
  try { wardrobe.record(event, payload); } catch (e) { console.warn('[shellby] stat failed:', e.message); }
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
  if (item.ok && !item.interrupted) {
    const fx = outfit().effect;
    if (fx?.motion === 'burst') send(critter, 'critter:burst', fx);
    stat('task-completed');
  }
  if (item.interrupted || (panel.isVisible() && panel.isFocused())) return;
  const secs = Math.round((item.durationMs || 0) / 1000);
  notify(item.ok ? `${routineId ? 'Routine' : 'Shellby'} finished: ${tab.title}` : `Shellby hit a problem: ${tab.title}`,
    item.ok ? `Done in ${secs}s. Click to see what happened.` : (item.error || 'Click for details.'),
    () => showPanel({ tabId }));
}

function notify(title, body, onClick) {
  // Dev, test and screenshot runs never post OS notifications: their toasts
  // outlive the process, and clicking a stale one relaunches bare electron.exe
  // (Electron's default page). SHELLBY_ALLOW_NOTIFY=1 opts a dev run back in.
  if (CAPTURE || (!app.isPackaged && process.env.SHELLBY_ALLOW_NOTIFY !== '1')) return;
  if (!config.get('notifications') || !Notification.isSupported()) return;
  const n = new Notification({ title: title.slice(0, 80), body, icon: ICON });
  if (onClick) n.on('click', onClick);
  n.show();
}

function openTab({ tabId = randomUUID(), cwd = currentCwd(), historyEntry = null, mode = null, routineId = null, title = null } = {}) {
  return manager.open({ tabId, cwd, historyEntry, mode, routineId, title });
}

// A task started by Shellby himself (e.g. "look into why the GPU is hot"): opens
// in its own tab in the foreground, in the current permission mode.
function startTask(prompt, title) {
  if (config.get('crabOnly') || !claudeStatus?.installed || !claudeStatus?.loggedIn) return { ok: false, needsClaude: true, error: 'That needs Claude Code: set it up first.' };
  try {
    const tabId = randomUUID();
    openTab({ tabId, title });
    manager.send(tabId, prompt, { kind: 'user', text: prompt, title });
    wake();
    send(panel, 'tab:opened', { tabId, entry: history.get(tabId), items: history.load(tabId), background: false });
    return { ok: true, tabId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function showHealth() {
  showPanel({ focusInput: false });
  send(panel, 'panel:view', 'health');
}

function createHealth() {
  // Dev runs can fake a scenario (SHELLBY_FAKE_HEALTH=hot|scorching|dizzy|stuffed|calm|nocpu);
  // screenshot runs always do. Packaged builds only ever read real sensors.
  const envFake = !app.isPackaged && FAKE_SCENARIOS.includes(process.env.SHELLBY_FAKE_HEALTH) ? process.env.SHELLBY_FAKE_HEALTH : null;
  health = new HealthService({
    config, send, notify, stat, startTask, showHealth,
    getPanel: () => panel,
    fakeScenario: CAPTURE ? 'calm' : envFake,
    onMood: mood => { healthMood = mood; refreshCritter(); },
  });
}

// Claude Code sessions outside Shellby, reported by the Shellby plugin's hooks.
function createExternal() {
  const port = (!app.isPackaged && Number(process.env.SHELLBY_HOOK_PORT)) || HOOK_PORT;
  external = new ExternalSessions({ port });
  external.on('changed', summary => { refreshCritter(); send(panel, 'external', { ...summary, status: external.status, port: external.port, enabled: !!config.get('externalSessions') }); });
  external.on('status', () => send(panel, 'external', externalView()));
  external.on('turn-done', () => {
    flashState('success');
    const fx = outfit().effect;
    if (fx?.motion === 'burst') send(critter, 'critter:burst', fx);
    stat('task-completed');
  });
  external.on('asking', () => wake());
  if (config.get('externalSessions')) external.start();
}

function externalView() {
  return { ...(external ? external.summary : { sessions: [], status: 'off' }), enabled: !!config.get('externalSessions') };
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
    stat('trick-learned');
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
    stat('routine-run');
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
    stat('files-dropped');
    showPanel();
    send(panel, 'panel:attach', files);
  });

  // ---- panel lifecycle
  ipcMain.on('panel:hide', () => panel.hide());
  ipcMain.on('panel:minimize', () => panel.minimize());

  ipcMain.handle('app:bootstrap', async () => {
    claudeStatus = CAPTURE || FAKE_CLI ? require('./capture').FAKE_STATUS : await checkStatus();
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
      skin: activeSkin(),
      skins: allSkins(),
      outfit: outfit(),
      wardrobe: wardrobe.view(),
      welcomeTrophies: welcomeTrophies.splice(0),
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
      registryUrl: registryUrl(),
      startView: (() => { const v = startView; startView = null; return v; })(),
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
    const pending = manager.tabs.get(tabId)?.session.pending.get(requestId);
    if (pending) {
      stat('permission-answered');
      if (decision !== 'deny' && pending.runsCreated?.length) stat('created-script-approved');
      if (decision !== 'deny' && pending.toolName === 'ExitPlanMode') stat('plan-approved');
    }
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
    for (const k of ['mode', 'hotkey', 'skin', 'critterScale', 'openAtLogin', 'notifications', 'model', 'onboarded', 'autonomousAcknowledged', 'showCrew', 'crabOnly']) {
      if (k in patch) allowed[k] = patch[k];
    }
    // Turning on Autonomous for the first time needs a confirmation that renderer
    // code can't click through (isolated confirm window; see confirm.js).
    if (allowed.autonomousAcknowledged === true && !config.get('autonomousAcknowledged')) {
      const response = await confirm.ask(panel, {
        ...dialogLook(), icon: '⚠️', danger: true,
        title: 'Enable Autonomous mode?',
        message: 'Let Shellby act without asking?',
        detail: 'Shellby and his helper agents will be able to edit, run or delete anything your Windows account can, including scripts they write for themselves, with no permission prompts.',
        note: 'You can switch back to Ask first any time from the mode menu.',
        buttons: [{ label: 'Enable Autonomous', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) { delete allowed.autonomousAcknowledged; if (allowed.mode === 'autonomous') delete allowed.mode; }
    }
    if ('mode' in allowed && !MODES.includes(allowed.mode)) delete allowed.mode;
    if ('skin' in allowed) {
      const sk = allSkins().find(x => x.id === allowed.skin);
      if (!sk || sk.locked) delete allowed.skin;
    }
    if (allowed.mode === 'autonomous' && !config.get('autonomousAcknowledged') && allowed.autonomousAcknowledged !== true) delete allowed.mode;
    if (allowed.autonomousAcknowledged === false) delete allowed.autonomousAcknowledged; // can't be un-acknowledged silently either
    if ('critterScale' in allowed) allowed.critterScale = [0.75, 1, 1.5, 2].includes(allowed.critterScale) ? allowed.critterScale : 1;
    if ('model' in allowed && !['', 'opus', 'sonnet', 'haiku'].includes(allowed.model)) delete allowed.model;
    for (const k of ['openAtLogin', 'notifications', 'onboarded', 'autonomousAcknowledged', 'crabOnly']) if (k in allowed) allowed[k] = !!allowed[k];
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
  ipcMain.handle('skins:reload', () => { skins = loadSkins(userSkinsDir()); wardrobe?.load(); broadcastWardrobe(); return allSkins(); });

  // ---- wardrobe
  ipcMain.handle('wardrobe:view', () => wardrobe.view());
  ipcMain.handle('wardrobe:set-outfit', (_e, patch) => ({ ...wardrobe.setOutfit(patch && typeof patch === 'object' ? patch : {}), view: wardrobe.view() }));
  ipcMain.handle('wardrobe:wear-season', () => ({ ...wardrobe.wearSeason(), view: wardrobe.view() }));
  ipcMain.handle('wardrobe:randomize', () => ({ ...wardrobe.randomize(), view: wardrobe.view() }));
  ipcMain.handle('wardrobe:options', (_e, opts) => { wardrobe.setOptions(opts || {}); return wardrobe.view(); });
  ipcMain.on('wardrobe:seen', (_e, keys) => { if (Array.isArray(keys)) wardrobe.markSeen(keys.filter(isStr)); });
  ipcMain.handle('wardrobe:install', async (_e, filePath) => {
    let file = isStr(filePath) ? filePath : null;
    if (!file) {
      const r = await dialog.showOpenDialog(panel, { title: 'Install a Shellby wardrobe pack', filters: [{ name: 'Shellby pack', extensions: ['json'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      file = r.filePaths[0];
    }
    // Only .json files under the size cap, and never echo parse errors: V8's
    // messages quote file contents, which would let a renderer peek at any file.
    if (!/\.json$/i.test(file)) return { ok: false, errors: ['Packs are .json files.'] };
    try { if (fs.statSync(file).size > 512 * 1024) return { ok: false, errors: ['That pack is too big (max 512 KB).'] }; } catch { return { ok: false, errors: ['File not found.'] }; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, errors: ['File not found.'] }; }
    const r = await confirmAndInstallPackText(text);
    return { ...r, view: wardrobe.view() };
  });
  ipcMain.handle('wardrobe:remove-pack', (_e, packId) => { if (isStr(packId)) wardrobe.remove(packId); return wardrobe.view(); });

  // ---- outfit codes (SHB-XXXX-XXXX): a whole look as a pasteable string
  const builtinSkins = () => skins.map(s => ({ id: s.id, name: s.name }));
  ipcMain.handle('wardrobe:code', () => ({ code: wardrobe.outfitCode(activeSkin()?.id) }));
  ipcMain.handle('wardrobe:code-preview', async (_e, text) => {
    if (!isStr(text) || text.length > 120) return { ok: false, error: "That doesn't look like an outfit code." };
    const p = wardrobe.previewCode(text, builtinSkins());
    if (!p.ok || !p.missing.length) return { ...p, packs: [] };
    // Items from community packs you don't have: find them in the gallery's catalog.
    const cat = await fetchRegistryCatalog({ baseUrl: registryUrl() });
    const packs = new Map();
    const unknown = [];
    for (const m of p.missing) {
      const hit = cat.ok && cat.items.find(it => it.slot === m.slot && itemHash(it.key) === m.hash);
      if (!hit) { unknown.push(m); continue; }
      const entry = packs.get(hit.packId) || { id: hit.packId, name: hit.packName, items: [] };
      entry.items.push({ slot: m.slot, name: hit.name });
      packs.set(hit.packId, entry);
    }
    return { ...p, packs: [...packs.values()], unknown, catalogError: cat.ok ? null : cat.errors[0] };
  });
  ipcMain.handle('wardrobe:code-wear', (_e, text) => {
    if (!isStr(text) || text.length > 120) return { ok: false, error: "That doesn't look like an outfit code." };
    const r = wardrobe.wearCode(text, builtinSkins());
    if (!r.ok) return r;
    if (r.skin && r.skin !== config.get('skin')) {
      const sk = allSkins().find(x => x.id === r.skin);
      if (sk && !sk.locked) { config.set({ skin: r.skin }); broadcastSkin(); }
    }
    return { ...r, view: wardrobe.view() };
  });
  // "Get the pack" from an outfit code: the same confirmed install as a gallery link.
  ipcMain.handle('wardrobe:install-registry', (_e, packId) => (isStr(packId) && /^[a-z0-9][a-z0-9-]{1,39}$/.test(packId) ? installFromRegistry(packId) : { ok: false }));
  ipcMain.on('wardrobe:open-folder', () => { fs.mkdirSync(wardrobe.userDir, { recursive: true }); shell.openPath(wardrobe.userDir); });
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

  // ---- Claude Code sessions elsewhere
  ipcMain.on('clipboard:text', (_e, text) => { if (isStr(text) && text.length <= 2000) clipboard.writeText(text); });
  ipcMain.handle('external:get', () => externalView());
  ipcMain.handle('external:set', (_e, enabled) => {
    config.set({ externalSessions: !!enabled });
    if (enabled) external.start(); else external.stop();
    return externalView();
  });

  // ---- health
  ipcMain.handle('health:get', () => health.view());
  ipcMain.handle('health:set', (_e, patch) => health.setSettings(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('health:recheck', () => health.recheck());
  ipcMain.handle('health:ask', (_e, checkId) => (isStr(checkId) ? health.ask(checkId) : { ok: false, error: 'Unknown reading.' }));
  ipcMain.handle('health:clear-log', () => { config.set({ healthLog: [] }); return health.view(); });
  ipcMain.on('health:viewed', () => stat('health-viewed'));

  // ---- shareable crab card: the renderer draws it; main checks it's a PNG,
  // picks the path itself, saves it and puts it on the clipboard.
  let lastCard = null;
  // Isolated dev/test runs keep cards in their throwaway profile and never touch the clipboard.
  const isolated = !app.isPackaged && !!process.env.SHELLBY_USER_DATA;
  const cardImage = bytes => {
    const buf = Buffer.from(bytes instanceof Uint8Array ? bytes : []);
    const isPng = buf.length > 8 && buf.length <= CARD_MAX_BYTES && buf.subarray(0, 8).equals(PNG_SIGNATURE);
    const img = isPng ? nativeImage.createFromBuffer(buf) : null;
    return img && !img.isEmpty() ? { buf, img } : null;
  };
  ipcMain.handle('card:save', (_e, bytes) => {
    const card = cardImage(bytes);
    if (!card) return { ok: false, error: "That card didn't come out right." };
    try {
      const dir = path.join(isolated ? app.getPath('userData') : app.getPath('pictures'), 'Shellby');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      lastCard = path.join(dir, `shellby-card-${stamp}.png`);
      fs.writeFileSync(lastCard, card.buf);
      if (!isolated) clipboard.writeImage(card.img);
      stat('card-shared');
      return { ok: true, name: path.join('Pictures', 'Shellby', path.basename(lastCard)) };
    } catch {
      return { ok: false, error: "Couldn't save the card to Pictures." };
    }
  });
  ipcMain.handle('card:copy', (_e, bytes) => {
    const card = cardImage(bytes);
    if (card && !isolated) clipboard.writeImage(card.img);
    return { ok: !!card };
  });
  ipcMain.on('card:reveal', () => { if (lastCard && fs.existsSync(lastCard)) shell.showItemInFolder(lastCard); });

  // ---- misc
  ipcMain.on('open-external', (_e, url) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* ignore bad urls */ }
  });
  ipcMain.on('open-data-folder', () => shell.openPath(app.getPath('userData')));
}

// ================================================================ pack installs

// Preview a pack's text, ask in a native dialog (which renderer code can't click
// through), then install exactly the previewed bytes. Shared by "Install pack…",
// drag and drop, and the community gallery. Never echoes JSON parse errors.
// opts: { sourceLabel?: shown in the dialog, expectId?: the pack id we asked for }
async function confirmAndInstallPackText(text, { sourceLabel = null, expectId = null } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 512 * 1024) return { ok: false, errors: ['That pack is too big (max 512 KB).'] };
  let preview;
  try {
    preview = validatePack(JSON.parse(text.replace(/^﻿/, '')), { source: 'user', knownAchievements: KNOWN_ACHIEVEMENTS, knownSeasons: KNOWN_SEASONS });
  } catch {
    return { ok: false, errors: ["That file isn't valid JSON, so it isn't a Shellby pack."] };
  }
  if (!preview.pack) return { ok: false, errors: preview.errors };
  const p = preview.pack;
  if (expectId && p.id !== expectId) return { ok: false, errors: [`The downloaded pack's id (${p.id}) doesn't match the link (${expectId}), so it was not installed.`] };
  const SLOT_LABEL = { hat: 'Hat', face: 'Face', neck: 'Neck', held: 'Held', shell: 'Shell' };
  const response = await confirm.ask(panel, {
    ...dialogLook(), icon: '📦',
    title: 'Install wardrobe pack?',
    message: `"${p.name}" ${p.version} by ${p.author}${sourceLabel ? `, ${sourceLabel}` : ''}`,
    detail: p.description || '',
    items: [
      ...p.accessories.map(a => ({ kind: a.slot, label: SLOT_LABEL[a.slot] || a.slot, name: a.name, pixels: a.pixels, palette: { ...a.palette } })),
      ...p.effects.map(e => ({ kind: 'effect', label: 'Effect', name: e.name, sprites: e.sprites.map(sp => ({ pixels: sp.pixels, palette: { ...sp.palette } })) })),
      ...p.skins.map(k => ({ kind: 'skin', label: 'Colors', name: k.name, pixels: k.pixels, palette: { ...k.palette }, parts: { ...k.parts } })),
    ],
    note: "Packs are pixel art and settings only. They can't run code.",
    buttons: [{ label: 'Install', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return { ok: false, canceled: true };
  // Install from a private temp copy of the previewed text, so what was shown is
  // exactly what gets installed (installPack re-validates and picks the final name).
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-pack-'));
    const tmp = path.join(dir, 'pack.json');
    fs.writeFileSync(tmp, text);
    const r = wardrobe.install(tmp);
    return { ok: r.ok, errors: r.errors || [], warnings: r.warnings || [], pack: r.pack ? { id: r.pack.id, name: r.pack.name } : null };
  } catch {
    return { ok: false, errors: ["Couldn't save the pack. Try again."] };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// A shellby:// link from the community gallery. Queued until boot has finished.
// The link only ever supplies a pack id; everything else comes from the registry.
function onDeepLink(link) {
  if (CAPTURE || !link) return;
  if (!booted) { pendingLink = link; return; }
  const parsed = parseDeepLink(link);
  if (!parsed) {
    showPanel({ focusInput: false });
    reportPackResult({ ok: false, error: "That Shellby link isn't one this version understands." });
    return;
  }
  // The panel must be loaded to switch views and hear the result.
  const go = () => installFromRegistry(parsed.packId);
  if (panel.webContents.isLoading()) panel.webContents.once('did-finish-load', go);
  else go();
}

async function installFromRegistry(packId) {
  startView = 'wardrobe'; // survives a panel that is still booting (its init would otherwise reset to chat)
  showPanel({ focusInput: false });
  send(panel, 'panel:view', 'wardrobe');
  if (linkBusy) return reportPackResult({ ok: false, error: 'Shellby is already installing a pack. Try again when it finishes.' });
  linkBusy = true;
  try {
    const got = await fetchRegistryPack(packId, { baseUrl: registryUrl() });
    if (!got.ok) return reportPackResult({ ok: false, error: got.errors[0] || 'Download failed.' });
    const have = wardrobe.catalog.packs.find(p => p.id === packId && p.source === 'user');
    if (have && got.entry.version && have.version === got.entry.version) {
      return reportPackResult({ ok: true, already: true, name: have.name, version: have.version });
    }
    const r = await confirmAndInstallPackText(got.text, { sourceLabel: 'from the Shellby community registry', expectId: packId });
    if (r.canceled) return reportPackResult({ ok: false, canceled: true });
    if (!r.ok) return reportPackResult({ ok: false, error: r.errors[0] || 'Install failed.' });
    return reportPackResult({ ok: true, name: r.pack.name, warnings: r.warnings.length });
  } catch (e) {
    console.warn('[shellby] registry install failed:', e.message);
    return reportPackResult({ ok: false, error: 'Something went wrong installing that pack.' });
  } finally {
    linkBusy = false;
  }
}

// Tell the panel (it toasts); if nobody is looking, a failure also gets a native box.
function reportPackResult(result) {
  send(panel, 'wardrobe:installed', result);
  if (!result.ok && !result.canceled && !(panel?.isVisible() && panel.isFocused())) {
    confirm.ask(panel, { ...dialogLook(), icon: '😕', title: "Couldn't install that pack", message: result.error || 'Something went wrong.', buttons: [{ label: 'OK', style: 'primary' }], defaultId: 0, cancelId: 0 }).catch(() => {});
  }
  return result;
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
  const claude = !config.get('crabOnly'); // just-the-crab mode has no tasks, toolbox or routines
  return Menu.buildFromTemplate([
    { label: 'Open Shellby', click: () => showPanel() },
    claude && { label: 'New conversation', click: () => { showPanel(); send(panel, 'tab:new-request'); } },
    { label: 'Wardrobe', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'wardrobe'); } },
    claude && { label: 'Toolbox', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'toolbox'); } },
    claude && { label: 'Routines', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'routines'); } },
    { label: healthMood ? `Health: ${HEALTH_TIP[healthMood.mood]} (${healthMood.text})` : 'Health', click: showHealth },
    { type: 'separator' },
    ...(agg?.busy ? [{ label: `${agg.busy} task${agg.busy > 1 ? 's' : ''} running`, enabled: false }, { type: 'separator' }] : []),
    { label: 'Settings…', click: () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'settings'); } },
    { label: 'Reset position', click: () => { const p = defaultCritterPos(critterBaseSize()); critter.setPosition(p.x - crewExtra(), p.y); config.set({ critterPos: p }); } },
    { label: 'Data folder (history, skins)', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit Shellby', click: quit },
  ].filter(Boolean));
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
  wardrobe = new Wardrobe({
    config, builtinDir: path.join(__dirname, '..', 'wardrobe'), userDir: path.join(userData, 'wardrobe'),
    now: () => captureClock.now || new Date(),
  });
  wardrobe.load();
  wardrobe.on('changed', broadcastWardrobe);
  wardrobe.on('unlocked', e => {
    flashState('unlocked', 6000);
    send(critter, 'critter:burst', outfit().confetti);
    send(panel, 'wardrobe:unlocked', e);
    send(panel, 'wardrobe', wardrobe.view());
    if (!(panel?.isVisible() && panel.isFocused())) {
      notify(`${e.achievement.icon} Achievement: ${e.achievement.name}`, `Unlocked ${e.rewards.map(r => r.name).join(' + ')}. Open the Wardrobe to try it on!`,
        () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'wardrobe'); });
    }
  });
  wardrobe.on('collected', items => {
    send(panel, 'wardrobe:collected', items.map(i => ({ key: i.key, name: i.name })));
    broadcastWardrobe();
  });
  // Credit past usage from history on the Wardrobe's first run (must precede any stat()).
  if (!CAPTURE) {
    const day = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const entries = history.list();
    welcomeTrophies = wardrobe.backfill({
      tasksCompleted: entries.reduce((n, e) => n + history.load(e.id).filter(i => i.kind === 'result' && i.ok).length, 0),
      activeDays: [...new Set(entries.flatMap(e => [e.createdAt, e.updatedAt]).filter(Boolean).map(day))],
    });
  }
  stat('active');
  setInterval(() => { wardrobe.collectSeasonals(); broadcastWardrobe(); }, 60 * 60 * 1000);
  skins = loadSkins(userSkinsDir());

  // Renderers never need camera, mic, geolocation etc.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  // The README reel shows Shellby big: he's the star.
  if (CAPTURE && process.argv.includes('--reel')) config.set({ critterScale: 2 });
  createManager();
  createHealth();
  registerIpc();
  createCritter();
  createPanel();
  critter.webContents.on('did-finish-load', () => { broadcastSkin(); refreshCritter(); });

  if (CAPTURE) return require(process.argv.includes('--reel') ? './reel' : './capture').run({ app, critter, panel, showPanel, send, ROOT, setCrewSlots, wardrobe, captureClock, broadcastWardrobe, health });

  createToolbox();
  createTray();
  health.start();
  createExternal();
  if (!applyHotkey(config.get('hotkey'))) console.warn('[shellby] hotkey unavailable:', config.get('hotkey'));
  applyLoginItem(config.get('openAtLogin'));
  setupUpdates();
  checkStatus().then(s => { claudeStatus = FAKE_CLI ? require('./capture').FAKE_STATUS : s; startScheduler(); });

  const reclamp = () => {
    const c = clampToDisplays(critter.getBounds(), workAreas());
    critter.setPosition(c.x, c.y);
  };
  screen.on('display-removed', reclamp);
  screen.on('display-metrics-changed', reclamp);

  if (!config.get('onboarded')) showPanel({ focusInput: false });

  // A gallery link that launched us (or arrived while booting) runs now.
  booted = true;
  const link = pendingLink || findDeepLink(process.argv);
  pendingLink = null;
  if (link) onDeepLink(link);
});

app.on('second-instance', (_e, argv) => {
  const link = findDeepLink(argv);
  if (link) onDeepLink(link);
  else if (booted) showPanel();
});
app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => { globalShortcut.unregisterAll(); scheduler?.stop(); toolbox?.stop(); health?.stop(); external?.stop(); });
app.on('before-quit', () => { app.isQuitting = true; manager?.closeAll(); });
