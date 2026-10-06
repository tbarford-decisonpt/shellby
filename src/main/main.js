const { app, BrowserWindow, ipcMain: electronIpcMain, screen, shell, dialog, globalShortcut, clipboard, session: electronSession, powerMonitor, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { randomUUID } = crypto;

const { Config } = require('./config');
const { History } = require('./history');
const { checkStatus, findClaude, setPlanOnly, run: runCli } = require('./claude-cli');
const { loadSkins } = require('./skins');
const { sendToBottom } = require('./desktop-layer');
const { clampToDisplays, panelPosition } = require('./placement');
const claudeSetup = require('./claude-setup');
const { Wardrobe } = require('./wardrobe/service');
const confirm = require('./confirm');
const { attachContextMenu } = require('./context-menu');
const { REGISTRY_URL, PROTOCOL, findDeepLink } = require('./registry');
const native = require('./native-windows');
const { kindOfApp } = require('./surroundings');
const { withDevice } = require('./xp');
const focus = require('./focus');
const rooms = require('./rooms');
const { createLean } = require('./lean');
const { createSkillRemover } = require('./skillremove');
const { createModsService } = require('./mods-service');
const editor = require('./editor');
const voice = require('./voice');
const statusLine = require('./statusline');
const streaks = require('./streaks');
const { repoOf, lastCommitAt } = require('./gitinfo');
const stickers = require('./stickers');
const weekly = require('./weekly');
const workmode = require('./workmode');
const { Log } = require('./log');
const crashReport = require('./crash-report');
const attach = require('./attachments');
const parity = require('./parity');
const teamIpcModule = require('./team-ipc');
const { guardIpc, windowPolicy } = require('./ipc-guard');
const { guardAllWebContents } = require('./web-guard');
const { createUsage } = require('./usage-service');
const { createHeldQueue } = require('./held-service');
const { createRoutines } = require('./routines-service');
const { createAway } = require('./away-service');
const { createStickers } = require('./sticker-service');
const { createCopies } = require('./copy-service');
const { registerHistoryIpc, clearQuestion } = require('./ipc/history');
const { registerWardrobeIpc } = require('./ipc/wardrobe');
const { registerTankIpc } = require('./ipc/tank');
const { wireWindows } = require('./wiring/windows');
const { wireCritter } = require('./wiring/critter');
const { wireSessions } = require('./wiring/sessions');
const { wireProgress } = require('./wiring/progress');
const { wireTimetrack } = require('./wiring/timetrack');
const { wireCrabApi } = require('./wiring/crab-api');
const { wireChannels } = require('./wiring/channels');
const { wirePhoneTasks } = require('./wiring/phone-tasks');
const { wireSurroundings } = require('./wiring/surroundings');
const { wireToolbox } = require('./wiring/toolbox');
const { wireGithub } = require('./wiring/github');
const { wireFocus } = require('./wiring/focus');
const { wireSnippets } = require('./wiring/snippets');
const { wireProjects } = require('./wiring/projects');
const { wirePacks } = require('./wiring/packs');
const { wireTray } = require('./wiring/tray');
const { wireClashes } = require('./wiring/clashes');
const { wireUsagePlan } = require('./wiring/usageplan');
const { wireTries } = require('./wiring/tries');
const { wireChecks } = require('./wiring/checks');
const { wireShots } = require('./wiring/shots');
const { wireCorrections } = require('./wiring/corrections');
const { wireHandoff } = require('./wiring/handoff');
const { wireCrew } = require('./wiring/crew');
const { wireStartFrom } = require('./wiring/startfrom');
const { wireClaudeUpdates } = require('./wiring/claude-updates');
const { registerCritterIpc } = require('./ipc/critter');
const { registerLifeIpc } = require('./ipc/life');
const { registerPanelIpc } = require('./ipc/panel');
const { registerTabsIpc } = require('./ipc/tabs');
const { registerHandoffIpc } = require('./ipc/handoff');
const { registerRepoIpc } = require('./ipc/repo');
const { registerSettingsIpc } = require('./ipc/settings');
const { registerToolboxIpc } = require('./ipc/toolbox');
const { registerRoutinesIpc } = require('./ipc/routines');
const { registerGithubIpc } = require('./ipc/github');
const { registerProgressIpc } = require('./ipc/progress');
const { registerSurroundingsIpc } = require('./ipc/surroundings');
const { registerTriesIpc } = require('./ipc/tries');
const { registerCorrectionsIpc } = require('./ipc/corrections');
const { registerStartFromIpc } = require('./ipc/startfrom');
const { registerCrewIpc } = require('./ipc/crew');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
// The crab's window gets a bridge of its own, much smaller (ipc-guard.js).
const CRITTER_PRELOAD = path.join(__dirname, '..', 'preload', 'critter-preload.js');
const TOY_PRELOAD = path.join(__dirname, '..', 'preload', 'toy-preload.js');
const FLOOR_PRELOAD = path.join(__dirname, '..', 'preload', 'floor-preload.js');
const NOTE_PRELOAD = path.join(__dirname, '..', 'preload', 'note-preload.js');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const CAPTURE = process.argv.includes('--capture-screenshots');

const BASE_PX = 4;                 // screen pixels per sprite pixel at scale 1
const PANEL_DEFAULT = { width: 460, height: 700 };
const MAX_CREW_SHOWN = 5;          // helper crabs drawn on the desktop
const SLEEP_AFTER_MS = 3 * 60 * 1000;
// A task running this long earns a "bear with me" (dev/e2e may shorten it).
const LONG_TASK_MS = Number(!process.env.SHELLBY_LONG_TASK_MS ? 0 : process.env.SHELLBY_LONG_TASK_MS) || 3 * 60 * 1000;
const CREW_WORTH_MENTIONING = 3;         // helpers out before he remarks on the crowd
// A tab left this long gives its claude process (and MCP servers) back; its next message resumes it.
const TAB_IDLE_STOP_MS = 30 * 60 * 1000;
const TAB_IDLE_CHECK_MS = 60 * 1000;
const IDLE_BIT_CHANCE = 0.25;            // ...of each idle tick becoming a little habit
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

// ---------------------------------------------------------------- the log
// Shellby runs all day with no console attached, so until now a crash left
// nothing behind: he simply vanished off the desktop. The log lives in the
// profile folder (so dev and test runs keep their own) and is scrubbed of the
// home directory and anything token-shaped, because its last lines are what
// "Report a problem" offers to paste into an issue. See log.js.
const log = new Log(path.join(app.getPath('userData'), 'logs'), { home: os.homedir() });
// An event type a Claude Code update added is noted here, once (session.js).
require('./session').setLogger(log);
// ("starting" is written below, once this is known to be the Shellby that stays.)

// Keeping him alive through a stray throw is the right trade for a desk pet:
// vanishing mid-task tells the user nothing and loses the conversation. It is
// written down, and he says so once, rather than being swallowed.
let snags = 0;
function snag(what, detail) {
  log.error(what, detail);
  if (++snags > 3) return; // a loop must not become a storm of toasts, or of reports
  // A dead window's native crash reaches Sentry as a dump of its own; these don't.
  if (sentry && detail instanceof Error) sentry.captureException(detail, { tags: { snag: what } });
  else if (sentry && what === 'unhandled rejection') sentry.captureMessage(`${what}: ${detail}`, 'error');
  // No config yet means this is a crash during startup, before there's anywhere
  // to show it (and notify() would throw from inside the handler).
  if (!config) return;
  const ask = sentry && crashConsent() === 'ask';
  notify('Shellby hit a snag', ask ? 'He carried on, but something went wrong. Send a report so it gets fixed?' : 'He carried on, but something went wrong. Right-click him → Report a problem.',
    ask ? () => askToSend('snag') : reportProblem, { tone: 'problem', action: ask ? 'Send report' : 'Report it' });
}
process.on('uncaughtException', err => snag('uncaught exception', err));
process.on('unhandledRejection', reason => snag('unhandled rejection', reason instanceof Error ? reason : String(reason)));
// Ctrl+C on a dev run, or a polite kill: go through the normal quit so tasks,
// dev servers and helper processes are stopped instead of left running.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
// Every page, however it was made: no pop-ups, navigation, redirects or webviews (web-guard.js).
guardAllWebContents(app);
// A window or a helper process dying: the panel going blank used to be the only
// sign, and nothing at all when it was the critter.
app.on('render-process-gone', (_e, _wc, details) => snag('a window died', `${details.reason} (exit code ${details.exitCode})`));
app.on('child-process-gone', (_e, details) => log.error('a child process died', `${details.type}: ${details.reason}`));
// Dev/e2e only: drive the app with the fake CLI from test/fixtures (no Claude account, no usage).
const FAKE_CLI = !app.isPackaged && process.env.SHELLBY_FAKE_CLAUDE ? path.resolve(process.env.SHELLBY_FAKE_CLAUDE) : null; // screenshot runs can pretend it's Halloween

// Dev/test runs get their own identity so Windows never ties their toasts or
// jump lists to the installed Shellby.
app.setAppUserModelId(app.isPackaged ? 'com.xsalmon.shellby' : 'com.xsalmon.shellby.dev');
const PRIMARY = CAPTURE || app.requestSingleInstanceLock();
if (!PRIMARY) app.exit(0);
// A second launch bowing out doesn't write it: this line is where the crash
// report's "the run before" begins (crash-report.js previousLogTail).
else log.info(`Shellby ${app.getVersion()} starting`, `${process.platform} ${os.release()}, electron ${process.versions.electron}`);

// ---------------------------------------------------------------- crash reports
// Sentry, held back by the user's answer (crash-report.js). Started before the
// app is ready so a native crash is caught from the first moment, and only by
// the Shellby holding the lock: a second launch bowing out isn't a crash.
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const lastRun = PRIMARY && !CAPTURE ? crashReport.startRun(LOG_DIR, { version: app.getVersion() }) : { unclean: false };
// Before settings load (or if reading them throws) the gate holds everything.
const crashGate = crashReport.makeGate(() => config && { consent: config.get('crashReports'), decisions: config.get('crashReportDecisions') });
const sentry = PRIMARY ? startSentry() : null;
const crashConsent = () => crashReport.normalizeConsent(config?.get('crashReports'));

function startSentry() {
  const dsn = crashReport.dsnFor({ env: process.env, isPackaged: app.isPackaged, capture: CAPTURE });
  if (!dsn) return null;
  try {
    const S = require('@sentry/electron/main');
    const scrub = s => log.scrub(s);
    S.init({
      dsn,
      release: `shellby@${app.getVersion()}`,
      environment: app.isPackaged ? 'production' : 'development',
      sendDefaultPii: false,
      integrations: crashReport.keepIntegrations,
      transportOptions: { shouldSend: crashGate.shouldSend, shouldStore: crashGate.shouldStore },
      beforeSend: event => crashReport.scrubEvent(event, scrub),
      beforeBreadcrumb: crumb => crashReport.scrubEvent(crumb, scrub),
    });
    return S;
  } catch (e) {
    log.warn('crash reports unavailable', e);
    return null;
  }
}

// shellby:// links ("Add to Shellby" on the community gallery). Dev runs only
// register when asked, so they don't hijack the links from an installed Shellby.
if (!CAPTURE) {
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  else if (process.env.SHELLBY_REGISTER_PROTOCOL === '1') app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(ROOT)]);
}
// The community registry. Only dev builds may point elsewhere (for testing).
// Isolated dev/test runs (SHELLBY_USER_DATA) never touch the real status file
// or the real Claude Code settings.
const ISOLATED = !app.isPackaged && !!process.env.SHELLBY_USER_DATA;
const statusFile = () => (ISOLATED ? path.join(app.getPath('userData'), 'shellby-status.txt') : statusLine.STATUS_FILE);
const claudeSettings = () => (ISOLATED ? path.join(app.getPath('userData'), 'claude-settings.json') : statusLine.settingsPath());
const registryUrl = () => (!app.isPackaged && process.env.SHELLBY_REGISTRY_URL) || REGISTRY_URL;
// A CLI the user pointed at by hand, when the usual places didn't have it.
const claudePath = () => config?.get('claudePath') || null;

let config, history, skins, manager, toolbox, wardrobe, health, external, shop, github, ci, issues, updates, friends, profileCard, prBadge;
let workflows = null;              // the Automate page's engine (workflows/service.js)
let depWatch = null;               // the weekly look at your projects' packages (depwatch.js)
let claudeUpdates = null;          // the daily look at Claude Code's own version (claude-update.js)
let projects = null;               // the Projects page (projects/service.js)
let devServers = null;             // the dev servers in them (devservers/service.js)
let parityIpc = null;
let teamIpc = null;                // Toolbox → Team: the repo's .shellby/team.json (team-ipc.js)
let lean = null; // Lean Shell: the prompt cache, setup weight and idle tools (lean.js)
let lastInit = null; // the newest init report from a conversation: its MCP list is refreshed from mcp_status
let obsServer, rgbClient, media, channelSecret, remote;
let nowPlaying = null;        // { title, artist, app, playing } from the Windows media session
let dictation = null, ptt = null; // push-to-talk: hold the hotkey and say the task (see dictation.js)
let critter, panel, tray;
let claudeStatus = null;
let crewShown = 0;                 // helper slots currently allotted in the critter window
let shrinkTimer = null;
// Shellby's own repeating checks, all cleared on quit so none fires into a
// half-torn-down app.
const repeating = [];
const every = (fn, ms) => { const t = setInterval(fn, ms); repeating.push(t); return t; };
let guestShown = false;            // room allotted for a friend's visiting crab
let visitor = null;                // { login, look, until }: a friend's crab dropped by (see friends.js)
let flash = null;                  // { state, until } — brief success/error/learned reaction
let motion = null;                 // throws and strolls (see motion.js)
let perching = null;               // up on your windows (see perching.js)
let climbing = null;               // up the edges of the screen and across the top (see climbing.js)
let pranks = null;                 // mischief, if you asked for it (see pranks.js)
let floor = null;                  // the strip of floor with his pals and footprints (see floor.js)
let life = null;                   // his life between tasks: scenes, gifts, the bond, your day (see life.js)
let playtime = null;               // hide and seek, fetch (see playtime.js)
let typing = null;                 // tapping along while you type (see typing.js)
let weatherSvc = null;             // the weather outside, for what he wears (see weather-service.js)
let said = null;                   // { text, occasion, until } — the line in his bubble (see voice.js)
let longTaskTimer = null;          // a task still running after LONG_TASK_MS gets a "still going…"
const fileTouches = new Map();     // file path -> times written this run, for his "this file again?"
let healthMood = null;
let levelUpAt = 1;
let lastXp = null;                 // { amount, at } for the status line's "+25 XP"
let lastStatus = { state: 'idle', busy: 0, crew: 0, background: 0 };                 // level shown in the critter's level-up bubble             // { mood, level, text } from the health monitor, or null
let lastActivity = Date.now();
let dragging = false;              // the user is dragging him around
let sleepTimer = null;
let welcomeTrophies = [];       // achievements credited from history on first run
let booted = false;                // deep links wait for this
let pendingLink = null;
let startView = null;              // view the panel should open on at boot (e.g. a deep link wants the Wardrobe)            // a shellby:// link that arrived before boot finished
let linkBusy = false;              // one registry install at a time
let autonomousOkThisRun = false;   // switching into Autonomous was confirmed since Shellby started (settings:set)

// ================================================================ wiring
// Each area of the app lives in wiring/ (and its IPC in ipc/); main keeps the
// state they share and boots them.
let calmReason = null; // the panel: 'blur' | 'locked' | null
let timeTracker = null;
let heldNotices = [];
let lastRgbColor = '';
let shopAsking = false;
let focusTimer = null;
let focusTick = null;

const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000;
const isFolder = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }; // missing or unreadable: not a folder
// Dev/e2e only: 5-hour readings from dev:usage, backdated so a pace builds up
// without an hour's wait, and held work going a second after the reset.
const FORECAST_TEST = !app.isPackaged && process.env.SHELLBY_FORECAST_TEST === '1';
// Held work goes a minute after the reset, so the server has rolled over too.
const HELD_GRACE_MS = FORECAST_TEST ? 1000 : 60 * 1000;
// Dev/e2e only: the idle readings come from dev:away instead of Windows.
const RECAP_TEST = !app.isPackaged && process.env.SHELLBY_RECAP_TEST === '1';

// ================================================================ services
// The areas with state of their own, each given exactly what it uses. Most of
// that only exists once Shellby has booted (or is a wiring/ export declared
// below), so it goes as a getter, read when it's used.

const usageService = createUsage({
  log, send, showPanel, every, powerMonitor,
  get config() { return config; },
  get panel() { return panel; },
  get manager() { return manager; },
  get workflows() { return workflows; },
  get recapLog() { return awayService.recapLog; },
  get history() { return history; },
  get usagePlan() { return usagePlan; },
  get notify() { return notify; },
  get refreshCritter() { return refreshCritter; },
  get flashState() { return flashState; },
  get tellChannel() { return tellChannel; },
  get sayText() { return sayText; },
  markActive: () => { lastActivity = Date.now(); },
  routines: () => routineService.routines(),
  heldViews: () => heldService.heldViews(),
});
const heldService = createHeldQueue({
  log, send, showPanel, isFolder, isStr, randomUUID, confirm, powerSaveBlocker, CAPTURE, graceMs: HELD_GRACE_MS,
  get config() { return config; },
  get panel() { return panel; },
  get manager() { return manager; },
  get history() { return history; },
  get claudeStatus() { return claudeStatus; },
  get notify() { return notify; },
  get tellChannel() { return tellChannel; },
  get wake() { return wake; },
  get openTab() { return openTab; },
  get sendToTab() { return sendToTab; },
  get currentCwd() { return currentCwd; },
  get dialogLook() { return dialogLook; },
  get adoptPhoneTab() { return adoptPhoneTab; },
  worktreeHome: () => worktreeHome(),
  limitWait: usageService.limitWait, resetTarget: usageService.resetTarget,
  clockTime: usageService.clockTime, sendOutlook: usageService.sendOutlook,
  routines: () => routineService.routines(),
  routinesView: () => routineService.routinesView(),
  runRoutine: (r, opts) => routineService.runRoutine(r, opts),
  makeRoomForRoutine: () => routineService.makeRoomForRoutine(),
});
const routineService = createRoutines({
  log, send, showPanel, isFolder, randomUUID, confirm,
  get config() { return config; },
  get panel() { return panel; },
  get manager() { return manager; },
  get history() { return history; },
  get usagePlan() { return usagePlan; },
  get claudeStatus() { return claudeStatus; },
  get remote() { return remote; },
  get notify() { return notify; },
  get sayText() { return sayText; },
  get wake() { return wake; },
  get openTab() { return openTab; },
  get currentCwd() { return currentCwd; },
  get stat() { return stat; },
  get dialogLook() { return dialogLook; },
  get runClaudeOnce() { return runClaudeOnce; },
  get knownProjects() { return knownProjects; },
  limitWait: usageService.limitWait, guardSettings: usageService.guardSettings, clockTime: usageService.clockTime,
  heldList: heldService.heldList, holdForReset: heldService.holdForReset, scheduleHeld: heldService.scheduleHeld,
  syncKeepAwake: heldService.syncKeepAwake, queueTabs: heldService.queueTabs,
});
const awayService = createAway({
  log, send, showPanel, every, powerMonitor, native, confirm, CAPTURE, RECAP_TEST,
  get config() { return config; },
  get critter() { return critter; },
  get panel() { return panel; },
  get manager() { return manager; },
  get external() { return external; },
  get devServers() { return devServers; },
  get speak() { return speak; },
  get notify() { return notify; },
  get dialogLook() { return dialogLook; },
  limitWait: usageService.limitWait,
});
const stickerService = createStickers({
  log, send, showPanel, CAPTURE,
  get config() { return config; },
  get critter() { return critter; },
  get panel() { return panel; },
  get workflows() { return workflows; },
  get notify() { return notify; },
  get flashState() { return flashState; },
  get sayText() { return sayText; },
  get broadcastSkin() { return broadcastSkin; },
  get currentLevel() { return currentLevel; },
  get activeSkin() { return activeSkin; },
  get githubEndpoints() { return githubEndpoints; },
  get noteWeek() { return noteWeek; },
  get stickersView() { return stickersView; },
  get stickerStats() { return stickerStats; },
});
const copyService = createCopies({
  log, isStr, CAPTURE, worktreeHome: () => worktreeHome(), claudeConfigDir: () => claudeConfigDir(),
  routineTabs: routineService.routineTabs, queueTabs: heldService.queueTabs, queueWaits: heldService.queueWaits,
  get config() { return config; },
  get manager() { return manager; },
  get history() { return history; },
  get remote() { return remote; },
  get turnStarts() { return turnStarts; },
});

const {
  checkLimit, onUsage, outlookView, projectKeyOf, refreshOutlook, saveSpend, sendOutlook,
  spendSource, tabCost, usageBreakdown, watchGuards, watchOutlook, windowShare,
} = usageService;
const { heldList, holdForReset, queueTabs, queueTask, queueWaits, reopenForHeld, saveHeld, scheduleHeld, syncKeepAwake } = heldService;
const {
  chatRoutine, draftRoutine, repairRoutine, routineTabs, routineTestView, routineTests, routines,
  routinesView, runRoutine, saveRoutines, startScheduler, testRoutine,
} = routineService;
const { checkAway, checkLeavingSoon, isAway, noteRecap, watchAway, watchLeaving } = awayService;
const { shellIdOf, shellStickers, shipped, stickerState } = stickerService;
const { changeRef, retireWorktree } = copyService;

// What main shares with the modules in ipc/ and wiring/. Functions declared
// here are hoisted, and the services above already exist, so they go as they
// are; everything else is a getter, read when it's used: most of it is set at
// boot or changes as he runs, and some is only declared further down. A setter
// is there only where a module changes it. wiring/ reaches the services whole
// (d.usageService.limitWait()); the flat names are what ipc/ reads.
const shared = {
  applyHotkey, applyLoginItem, changeRef, chatRoutine, checkAway, checkNudges, draftRoutine,
  gameInFront, heldList, holdForReset, isFolder, isStr, noteRecap, onUsage, outlookView,
  panelSettings, queueTabs, queueTask, queueWaits, recordWork, refreshOutlook, rememberPrompt,
  reopenForHeld, repairRoutine, retireWorktree, routineTabs, routineTestView, routineTests,
  routines, routinesView, runRoutine, saveCritterPos, saveHeld, saveRoutines, saveStreaks, send,
  sendOutlook, setCrewSlots, setPanelRoomy, shellIdOf, shellStickers, shipped, showPanel,
  stickerState, streaksView, syncKeepAwake, testRoutine, togglePanel, usageBreakdown,
  FORECAST_TEST, RECAP_TEST, awayService, copyService, routineService, stickerService, usageService,
  get recapLog() { return awayService.recapLog; }, set recapLog(v) { awayService.recapLog = v; },
  isAway, tabCost, windowShare,
  projectKeyOf, spendSource,
  get BASE_PX() { return BASE_PX; },
  get CAPTURE() { return CAPTURE; },
  get CARD_MAX_BYTES() { return CARD_MAX_BYTES; },
  get CREW_WORTH_MENTIONING() { return CREW_WORTH_MENTIONING; },
  get CRITTER_PRELOAD() { return CRITTER_PRELOAD; },
  get FAKE_CLI() { return FAKE_CLI; },
  get FLOOR_PRELOAD() { return FLOOR_PRELOAD; },
  get HEALTH_TIP() { return HEALTH_TIP; },
  get ICON() { return ICON; },
  get IDLE_BIT_CHANCE() { return IDLE_BIT_CHANCE; },
  get ISOLATED() { return ISOLATED; },
  get LONG_TASK_MS() { return LONG_TASK_MS; },
  get MAX_CREW_SHOWN() { return MAX_CREW_SHOWN; },
  get NOTE_PRELOAD() { return NOTE_PRELOAD; },
  get NUDGE_TEST() { return NUDGE_TEST; },
  get PANEL_MAX_TEXT() { return PANEL_MAX_TEXT; },
  get PNG_SIGNATURE() { return PNG_SIGNATURE; },
  get PRELOAD() { return PRELOAD; },
  get RENDERER() { return RENDERER; },
  get ROOT() { return ROOT; },
  get SLEEP_AFTER_MS() { return SLEEP_AFTER_MS; },
  get SNAPSHOT_WAIT_MS() { return SNAPSHOT_WAIT_MS; },
  get TAB_IDLE_CHECK_MS() { return TAB_IDLE_CHECK_MS; },
  get TAB_IDLE_STOP_MS() { return TAB_IDLE_STOP_MS; },
  get TOY_PRELOAD() { return TOY_PRELOAD; },
  get TRICKS_KIND() { return TRICKS_KIND; },
  get activeSkin() { return activeSkin; },
  get addLesson() { return addLesson; },
  get advanceFocus() { return advanceFocus; },
  get afterTurnChecks() { return afterTurnChecks; },
  get allSkins() { return allSkins; },
  get allSnippets() { return allSnippets; },
  get answerPermission() { return answerPermission; },
  get applyLayer() { return applyLayer; },
  get askOnPhone() { return askOnPhone; },
  get askOnce() { return askOnce; },
  get autonomousOkThisRun() { return autonomousOkThisRun; }, set autonomousOkThisRun(v) { autonomousOkThisRun = v; },
  get awardXp() { return awardXp; },
  get badgePr() { return badgePr; },
  get beachSeen() { return beachSeen; },
  get beachView() { return beachView; },
  get booted() { return booted; },
  get broadcastSkin() { return broadcastSkin; },
  get broadcastWardrobe() { return broadcastWardrobe; },
  get buildMenu() { return buildMenu; },
  get calmReason() { return calmReason; }, set calmReason(v) { calmReason = v; },
  get channelConfirmed() { return channelConfirmed; },
  get channelPlace() { return channelPlace; },
  get channelSecret() { return channelSecret; }, set channelSecret(v) { channelSecret = v; },
  get channelSettings() { return channelSettings; },
  get channelsView() { return channelsView; },
  get cancelAllChecks() { return cancelAllChecks; },
  get cancelChecks() { return cancelChecks; },
  get checkTry() { return checkTry; },
  get checkedUp() { return checkedUp; },
  get checksOn() { return checksOn; },
  get checkupsView() { return checkupsView; },
  get chirp() { return chirp; },
  get clashTabsChanged() { return clashTabsChanged; },
  get clashTurnEnded() { return clashTurnEnded; },
  get clashesView() { return clashesView; },
  get changeLearned() { return changeLearned; },
  get ci() { return ci; }, set ci(v) { ci = v; },
  get ciView() { return ciView; },
  get claudeConfigDir() { return claudeConfigDir; },
  get claudePath() { return claudePath; },
  get claudeSettings() { return claudeSettings; },
  get claudeStatus() { return claudeStatus; }, set claudeStatus(v) { claudeStatus = v; },
  get claudeUpdateView() { return claudeUpdateView; },
  get claudeUpdates() { return claudeUpdates; }, set claudeUpdates(v) { claudeUpdates = v; },
  get cliBinDir() { return cliBinDir; },
  get cliView() { return cliView; },
  get climbing() { return climbing; }, set climbing(v) { climbing = v; },
  get clipboardHasImage() { return clipboardHasImage; },
  get composePrompt() { return composePrompt; },
  get config() { return config; },
  get confirmAndAddMarketplace() { return confirmAndAddMarketplace; },
  get confirmAndChangeHook() { return confirmAndChangeHook; },
  get confirmAndInstallOpenRgb() { return confirmAndInstallOpenRgb; },
  get confirmAndInstallPlugin() { return confirmAndInstallPlugin; },
  get confirmAndInstallShellbyPlugin() { return confirmAndInstallShellbyPlugin; },
  get confirmAndPublishPack() { return confirmAndPublishPack; },
  get confirmAndUninstallPlugin() { return confirmAndUninstallPlugin; },
  get confirmChannelPlace() { return confirmChannelPlace; },
  get confirmGitHubFeature() { return confirmGitHubFeature; },
  get correctionFromTurns() { return correctionFromTurns; },
  get crashConsent() { return crashConsent; },
  get crewExtra() { return crewExtra; },
  get crewRoster() { return crewRoster; },
  get crewShown() { return crewShown; },
  get critter() { return critter; }, set critter(v) { critter = v; },
  get critterBaseSize() { return critterBaseSize; },
  get critterGeo() { return critterGeo; },
  get currentCwd() { return currentCwd; },
  get currentLevel() { return currentLevel; },
  get depWatch() { return depWatch; }, set depWatch(v) { depWatch = v; },
  get devServers() { return devServers; }, set devServers(v) { devServers = v; },
  get dialogLook() { return dialogLook; },
  get dictation() { return dictation; }, set dictation(v) { dictation = v; },
  get dismissLesson() { return dismissLesson; },
  get draftHook() { return draftHook; },
  get draftLesson() { return draftLesson; },
  get dragging() { return dragging; }, set dragging(v) { dragging = v; },
  get drainCrashQueue() { return drainCrashQueue; },
  get editStickers() { return editStickers; },
  get endTurn() { return endTurn; },
  get ensureOpenRgb() { return ensureOpenRgb; },
  get expandSnippet() { return expandSnippet; },
  get exportSnippets() { return exportSnippets; },
  get external() { return external; }, set external(v) { external = v; },
  get externalView() { return externalView; },
  get fileTouches() { return fileTouches; },
  get flakyAct() { return flakyAct; },
  get flakyOn() { return flakyOn; },
  get flakyTree() { return flakyTree; },
  get flakyView() { return flakyView; },
  get flash() { return flash; }, set flash(v) { flash = v; },
  get flashState() { return flashState; },
  get floor() { return floor; }, set floor(v) { floor = v; },
  get focusState() { return focusState; },
  get focusTick() { return focusTick; }, set focusTick(v) { focusTick = v; },
  get focusTimer() { return focusTimer; }, set focusTimer(v) { focusTimer = v; },
  get focusView() { return focusView; },
  get forgetPausedHook() { return forgetPausedHook; },
  get friends() { return friends; }, set friends(v) { friends = v; },
  get friendsView() { return friendsView; },
  get gateHome() { return gateHome; },
  get github() { return github; }, set github(v) { github = v; },
  get handoff() { return handoff; },
  get githubEndpoints() { return githubEndpoints; },
  get guestShown() { return guestShown; },
  get health() { return health; }, set health(v) { health = v; },
  get healthMood() { return healthMood; }, set healthMood(v) { healthMood = v; },
  get heldNotices() { return heldNotices; }, set heldNotices(v) { heldNotices = v; },
  get helperWidth() { return helperWidth; },
  get history() { return history; },
  get homesView() { return homesView; },
  get importSnippets() { return importSnippets; },
  get installCli() { return installCli; },
  get issues() { return issues; }, set issues(v) { issues = v; },
  get knownFolder() { return knownFolder; },
  get knownProjects() { return knownProjects; },
  get lastActivity() { return lastActivity; }, set lastActivity(v) { lastActivity = v; },
  get lastInit() { return lastInit; }, set lastInit(v) { lastInit = v; },
  get lastRgbColor() { return lastRgbColor; }, set lastRgbColor(v) { lastRgbColor = v; },
  get lastRun() { return lastRun; },
  get lastStatus() { return lastStatus; }, set lastStatus(v) { lastStatus = v; },
  get lastXp() { return lastXp; }, set lastXp(v) { lastXp = v; },
  get lean() { return lean; },
  get learnedView() { return learnedView; },
  get levelUpAt() { return levelUpAt; }, set levelUpAt(v) { levelUpAt = v; },
  get lessonPreview() { return lessonPreview; },
  get lessonState() { return lessonState; },
  get life() { return life; }, set life(v) { life = v; },
  get linkBusy() { return linkBusy; }, set linkBusy(v) { linkBusy = v; },
  get log() { return log; },
  get looseEndDraft() { return looseEndDraft; },
  get looseEnds() { return looseEnds; },
  get longTaskTimer() { return longTaskTimer; }, set longTaskTimer(v) { longTaskTimer = v; },
  get makeIssueCopy() { return makeIssueCopy; },
  get manager() { return manager; }, set manager(v) { manager = v; },
  get media() { return media; }, set media(v) { media = v; },
  get mediaSettings() { return mediaSettings; },
  get mediaView() { return mediaView; },
  get mergeSnippets() { return mergeSnippets; },
  get motion() { return motion; }, set motion(v) { motion = v; },
  get motionBox() { return motionBox; },
  get musicHeadphones() { return musicHeadphones; },
  get noteAwayRun() { return noteAwayRun; },
  get noteFix() { return noteFix; },
  get noteCorrection() { return noteCorrection; },
  get noteRed() { return noteRed; },
  get noteSnippetUse() { return noteSnippetUse; },
  get noteTestRun() { return noteTestRun; },
  get noteWeek() { return noteWeek; },
  get noteWorkTime() { return noteWorkTime; },
  get notify() { return notify; },
  get nowPlaying() { return nowPlaying; }, set nowPlaying(v) { nowPlaying = v; },
  get obsServer() { return obsServer; }, set obsServer(v) { obsServer = v; },
  get obsSettings() { return obsSettings; },
  get obsState() { return obsState; },
  get obsView() { return obsView; },
  get onPermission() { return onPermission; },
  get onResult() { return onResult; },
  get onToolSpoken() { return onToolSpoken; },
  get openGitHubUrl() { return openGitHubUrl; },
  get openIssuePr() { return openIssuePr; },
  get openTab() { return openTab; },
  get outfit() { return outfit; },
  get paintLights() { return paintLights; },
  get panel() { return panel; },
  get pauseHook() { return pauseHook; },
  get pendingCommands() { return pendingCommands; },
  get pendingLink() { return pendingLink; }, set pendingLink(v) { pendingLink = v; },
  get perching() { return perching; }, set perching(v) { perching = v; },
  get phoneTasksView() { return phoneTasksView; },
  get pickPhoneTasksFolder() { return pickPhoneTasksFolder; },
  get pinnedTools() { return pinnedTools; },
  get placeCritter() { return placeCritter; },
  get playtime() { return playtime; }, set playtime(v) { playtime = v; },
  get pluginView() { return pluginView; },
  get prBadge() { return prBadge; }, set prBadge(v) { prBadge = v; },
  get refreshPhoneTasks() { return refreshPhoneTasks; },
  get pranks() { return pranks; }, set pranks(v) { pranks = v; },
  get profileCard() { return profileCard; }, set profileCard(v) { profileCard = v; },
  get projectInsights() { return projectInsights; },
  get projects() { return projects; }, set projects(v) { projects = v; },
  get ptt() { return ptt; }, set ptt(v) { ptt = v; },
  get px() { return px; },
  get randomUUID() { return randomUUID; },
  get reachedForShellby() { return reachedForShellby; },
  get refreshClashes() { return refreshClashes; },
  get refreshCritter() { return refreshCritter; },
  get refreshStatusLine() { return refreshStatusLine; },
  get registerWorkflowIpc() { return registerWorkflowIpc; },
  get registryUrl() { return registryUrl; },
  get remote() { return remote; }, set remote(v) { remote = v; },
  get removeCli() { return removeCli; },
  get resetCritterPos() { return resetCritterPos; },
  get restoreLights() { return restoreLights; },
  get resumeHook() { return resumeHook; },
  get rgbClient() { return rgbClient; }, set rgbClient(v) { rgbClient = v; },
  get rgbSettings() { return rgbSettings; },
  get rgbView() { return rgbView; },
  get roomTaskDone() { return roomTaskDone; },
  get roomsPanelView() { return roomsPanelView; },
  get runCheckup() { return runCheckup; },
  get runChecksFor() { return runChecksFor; },
  get runClaudeOnce() { return runClaudeOnce; },
  get said() { return said; }, set said(v) { said = v; },
  get saveChannelSecret() { return saveChannelSecret; },
  get sayText() { return sayText; },
  get seasonsWhere() { return seasonsWhere; },
  get secureWindow() { return secureWindow; },
  get sendToTab() { return sendToTab; },
  get sentry() { return sentry; },
  get serversOnQuit() { return serversOnQuit; },
  get setFolder() { return setFolder; },
  get setRooms() { return setRooms; },
  get setSnippets() { return setSnippets; },
  get settleCritter() { return settleCritter; },
  get setupCwd() { return setupCwd; },
  get setupView() { return setupView; },
  get setupWhere() { return setupWhere; },
  get shop() { return shop; }, set shop(v) { shop = v; },
  get shopAsking() { return shopAsking; }, set shopAsking(v) { shopAsking = v; },
  get shopBlocked() { return shopBlocked; },
  get shotImage() { return shotImage; },
  get shotsAfterTurn() { return shotsAfterTurn; },
  get shotsBeforeTurn() { return shotsBeforeTurn; },
  get shotsDir() { return shotsDir; },
  get showFlaky() { return showFlaky; },
  get showBuildFix() { return showBuildFix; },
  get showHealth() { return showHealth; },
  get showListening() { return showListening; },
  get showServer() { return showServer; },
  get skins() { return skins; },
  get sleepTimer() { return sleepTimer; }, set sleepTimer(v) { sleepTimer = v; },
  get snippetList() { return snippetList; },
  get snippetsView() { return snippetsView; },
  get soundMix() { return soundMix; },
  get speak() { return speak; },
  get startFocus() { return startFocus; },
  get startFromDraft() { return startFromDraft; },
  get startFromSend() { return startFromSend; },
  get startTask() { return startTask; },
  get startTaskInCopy() { return startTaskInCopy; },
  get setPhoneTasks() { return setPhoneTasks; },
  get startView() { return startView; }, set startView(v) { startView = v; },
  get stat() { return stat; },
  get statusFile() { return statusFile; },
  get stickerStats() { return stickerStats; },
  get stickersView() { return stickersView; },
  get stopFocus() { return stopFocus; },
  get syncLayer() { return syncLayer; },
  get taskFromClipboard() { return taskFromClipboard; },
  get teamIpc() { return teamIpc; },
  get tellChannel() { return tellChannel; },
  get testHook() { return testHook; },
  get timeTracker() { return timeTracker; }, set timeTracker(v) { timeTracker = v; },
  get toolbox() { return toolbox; }, set toolbox(v) { toolbox = v; },
  get tray() { return tray; }, set tray(v) { tray = v; },
  get tries() { return tries; },
  get turnEnds() { return turnEnds; },
  get turnStarts() { return turnStarts; },
  get typing() { return typing; }, set typing(v) { typing = v; },
  get typingSettings() { return typingSettings; },
  get updateView() { return updateView; },
  get updates() { return updates; }, set updates(v) { updates = v; },
  get usagePlan() { return usagePlan; },
  get visitor() { return visitor; }, set visitor(v) { visitor = v; },
  get wake() { return wake; },
  get wardrobe() { return wardrobe; },
  get weatherSvc() { return weatherSvc; }, set weatherSvc(v) { weatherSvc = v; },
  get weatherView() { return weatherView; },
  get webPreferences() { return webPreferences; },
  get weekView() { return weekView; },
  get welcomeTrophies() { return welcomeTrophies; },
  get workflows() { return workflows; }, set workflows(v) { workflows = v; },
  get worktreeHome() { return worktreeHome; },
  get xpView() { return xpView; },
};

const {
  applyLayer, createCritter, createMischief, createMotion, crewExtra, critterBaseSize, critterGeo,
  helperWidth, motionBox, placeCritter, px, resetCritterPos, secureWindow, settleCritter,
  syncLayer, watchIdleCost, webPreferences, workAreas,
} = wireWindows(shared);
const {
  HEALTH_TIP, activeSkin, allSkins, broadcastSkin, broadcastWardrobe, chirp, currentLevel,
  dialogLook, flashState, homesView, onToolSpoken, outfit, refreshCritter, refreshStatusLine,
  seasonsWhere, soundMix, speak, wake, wakeVoice,
} = wireCritter(shared);
const {
  SNAPSHOT_WAIT_MS, createManager, currentCwd, endTurn, turnEnds, turnStarts,
} = wireSessions(shared);
const {
  awardXp, checkWrapUp, checkedUp, checkupsView, flakyAct, flakyOn, flakyTree, flakyView,
  knownFolder, noteAwayRun, noteFix, noteRed, noteTestRun, noteWeek, noteWorkTime, roomTaskDone, roomsPanelView,
  runCheckup, setRooms, showFlaky, weekView, xpView,
} = wireProgress(shared);
const {
  beachSeen, beachView, clipboardHasImage, composePrompt, createExternal, createHealth,
  createTimeTracker, editStickers, externalView, knownProjects, notify, onPermission, onResult,
  openTab, pendingCommands, projectInsights, sendToTab, shotsDir, showHealth, startTask, stat,
  stickerStats, stickersView, taskFromClipboard,
} = wireTimetrack(shared);
const { cliBinDir, cliView, createCrabApi, installCli, removeCli, sayText } = wireCrabApi(shared);
const {
  answerPermission, askOnPhone, channelConfirmed, channelPlace, channelSettings, channelsView, confirmChannelPlace,
  createObs, createRemote, loadChannelSecret, obsSettings, obsState, obsView, saveChannelSecret,
  tellChannel,
} = wireChannels(shared);
const {
  adoptPhoneTab, createPhoneTasks, phoneTasksView, pickPhoneTasksFolder, refreshPhoneTasks, setPhoneTasks,
} = wirePhoneTasks(shared);
const {
  confirmAndInstallOpenRgb, createDictation, createLifeAndPlay, createMedia, createRgb,
  createTypingAlong, createWeather, ensureOpenRgb, mediaSettings, mediaView, musicHeadphones,
  onHotkey, paintLights, restoreLights, rgbSettings, rgbView, showListening, typingSettings,
  weatherView,
} = wireSurroundings(shared);
const {
  askOnce, confirmAndChangeHook, confirmAndInstallPlugin, confirmAndInstallShellbyPlugin,
  confirmAndUninstallPlugin, createShop, createToolbox, draftHook, forgetPausedHook, pauseHook, pluginView,
  resumeHook, setupCwd, setupView, setupWhere, shopBlocked, testHook,
} = wireToolbox(shared);
const {
  badgePr, ciView, confirmAndAddMarketplace, confirmAndPublishPack, confirmGitHubFeature, createCi,
  createFriends, createGitHub, createIssues, friendsView, githubEndpoints, makeIssueCopy,
  openGitHubUrl, openIssuePr, pinnedTools, sendVisitor,
} = wireGithub(shared);
const { advanceFocus, focusState, focusView, startFocus, stopFocus } = wireFocus(shared);
const {
  PANEL_MAX_TEXT, allSnippets, expandSnippet, exportSnippets, importSnippets, mergeSnippets,
  noteSnippetUse, setSnippets, snippetList, snippetsView,
} = wireSnippets(shared);
const {
  createDepWatch, createProjects, createWorkflows, registerWorkflowIpc, runClaudeOnce,
  serversOnQuit, showServer, startTaskInCopy,
} = wireProjects(shared);
const { confirmAndInstallPackText, installFromRegistry, onDeepLink, setFolder } = wirePacks(shared);
const { looseEndDraft, looseEnds, showBuildFix, startFromDraft, startFromSend } = wireStartFrom(shared);
const { claudeUpdateView, createClaudeUpdates } = wireClaudeUpdates(shared);
const {
  askToSend, buildMenu, createTray, drainCrashQueue, reportProblem, reportUncleanExit,
  setupUpdates, updateView,
} = wireTray(shared);
const { clashTabsChanged, clashTurnEnded, clashesView, refreshClashes, watchClashes } = wireClashes(shared);
const usagePlan = wireUsagePlan(shared);
const { afterTurnChecks, cancelAllChecks, cancelChecks, checkTry, checksOn, gateHome, runChecksFor } = wireChecks(shared);
const tries = wireTries(shared); // Try it N ways: only ever from tries:start, after asking
const { shotImage, shotsAfterTurn, shotsBeforeTurn } = wireShots(shared);
const {
  addLesson, changeLearned, correctionFromTurns, createCorrections, dismissLesson, draftLesson,
  learnedView, lessonPreview, lessonState, noteCorrection,
} = wireCorrections(shared);
const handoff = wireHandoff(shared);
const crewRoster = wireCrew(shared); // one lasting helper crab per agent type

// The critter window grows to the left to make room for helper crabs, keeping
// Shellby himself anchored in place.
function setCrewSlots(n, guest = !!visitor) {
  n = Math.min(n, MAX_CREW_SHOWN);
  // A shrink still pending from a moment ago would cut off whoever just arrived.
  clearTimeout(shrinkTimer);
  if (n === crewShown && guest === guestShown) return;
  // Helpers and a visiting crab line up on the floor beside him, so he comes
  // down off any window first. The refresh after he lands brings them out.
  if ((n > crewShown || (guest && !guestShown)) && perching?.isAway()) { perching.leave('crew'); return; }
  // ...and lets go of a wall or the ceiling: his window can't widen while he's turned.
  if ((n > crewShown || (guest && !guestShown)) && climbing?.isAway()) { climbing.leave(); return; }
  const apply = (slots, g) => {
    const b = critter.getBounds();
    const base = critterBaseSize();
    const width = base.width + crewExtra(slots, g);
    crewShown = slots;
    guestShown = g;
    critter.setBounds({ x: b.x + b.width - width, y: b.y, width, height: base.height });
  };
  motion?.stop(); // a throw or stroll would put back the old left edge
  if (n > crewShown || (guest && !guestShown)) apply(Math.max(n, crewShown), guest || guestShown);
  // Grown for the newcomer; anyone leaving still gets the shrink below.
  if (n === crewShown && guest === guestShown) return;
  shrinkTimer = setTimeout(() => apply(n, guest), 1100); // let helpers walk home first
}

function saveCritterPos() {
  const b = critter.getBounds();
  const c = clampToDisplays(b, workAreas());
  if (c.x !== b.x || c.y !== b.y) placeCritter(c.x, c.y);
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
  attachContextMenu(panel, electronIpcMain); // checks the sender itself: only the panel picks from its menu
  panel.loadFile(path.join(RENDERER, 'panel', 'panel.html'));
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
    // Resizing it yourself while it's made room keeps your size: there's nothing to put back,
    // and the panel stops asking for room.
    if (roomyFrom) { roomyFrom = null; send(panel, 'panel:roomy-lost'); }
    const [width, height] = panel.getSize();
    config.set({ panelSize: { width, height } });
  });
}

// "Make room" on a workflow map: the panel grows toward the middle of its screen,
// and goes back to its size after. Only you resizing it is ever remembered.
const ROOMY = { width: 1180, height: 780, gap: 8, settleMs: 800 };
let roomyFrom = null; // { from: its bounds before, set: the bounds it grew to, right, low }
let roomyAt = 0;

const clampInto = (r, wa) => ({
  ...r,
  x: Math.round(Math.min(Math.max(r.x, wa.x + ROOMY.gap), wa.x + wa.width - r.width - ROOMY.gap)),
  y: Math.round(Math.min(Math.max(r.y, wa.y + ROOMY.gap), wa.y + wa.height - r.height - ROOMY.gap)),
});

function setPanelRoomy(on) {
  if (!panel || panel.isDestroyed()) return { ok: false, roomy: false };
  if (!on) {
    if (roomyFrom) {
      const { from, set, right, low } = roomyFrom;
      const c = panel.getBounds();
      // Where it was, unless it's been moved (or put back beside the crab) since: then its
      // size, keeping the corner it grew from where it is now.
      const back = c.x === set.x && c.y === set.y ? from
        : clampInto({ x: right ? c.x + c.width - from.width : c.x, y: low ? c.y + c.height - from.height : c.y, width: from.width, height: from.height }, screen.getDisplayMatching(c).workArea);
      roomyAt = Date.now();
      panel.setBounds(back);
    }
    roomyFrom = null;
    return { ok: true, roomy: false };
  }
  if (roomyFrom) return { ok: true, roomy: true };
  const b = panel.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.min(ROOMY.width, wa.width - ROOMY.gap * 2);
  const height = Math.max(b.height, Math.min(ROOMY.height, wa.height - ROOMY.gap * 2));
  if (width <= b.width && height <= b.height) return { ok: true, roomy: false };
  const right = b.x + b.width / 2 > wa.x + wa.width / 2;
  const low = b.y + b.height / 2 > wa.y + wa.height / 2;
  const set = clampInto({ x: right ? b.x + b.width - width : b.x, y: low ? b.y + b.height - height : b.y, width, height }, wa);
  roomyFrom = { from: b, set, right, low };
  roomyAt = Date.now();
  panel.setBounds(set);
  return { ok: true, roomy: true };
}

// A dev run opens its panel behind whatever you're doing (a game, say) instead of
// snatching focus, until you reach for Shellby yourself: the crab, the hotkey, the
// tray, or clicking the panel. SHELLBY_FOREGROUND=1 brings back the packaged behavior.
let openBehind = !app.isPackaged && process.env.SHELLBY_FOREGROUND !== '1';
let reachedAt = 0;
const reachedForShellby = () => { openBehind = false; reachedAt = Date.now(); };
// Long enough to pick an item from the crab's menu or the tray's.
const REACHED_MS = 15000;

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
  if (openBehind || (Date.now() - reachedAt > REACHED_MS && gameInFront())) {
    if (!panel.isVisible()) { placePanel(); panel.showInactive(); sendToBottom(panel); }
    if (tabId) send(panel, 'tab:focus', tabId);
    return;
  }
  if (!panel.isVisible()) placePanel();
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.moveTop();
  panel.focus();
  if (tabId) send(panel, 'tab:focus', tabId);
  if (focusInput) send(panel, 'panel:focus-input');
}

// Beside the crab, on his screen.
function placePanel() {
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

function togglePanel() {
  reachedForShellby(); // the crab and the hotkey both land here
  if (panel.isVisible() && panel.isFocused()) panel.hide();
  else showPanel();
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Where a tab's copy of its repo goes (copy-service.js), and Claude Code's own settings.
const worktreeHome = () => path.join(app.getPath('userData'), 'worktrees');
const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ================================================================ streaks and nudges

function streaksView() {
  const s = streaks.normalize(config.get('streaks'));
  const now = Date.now();
  return {
    ...streaks.streakOf(s, now), nudges: s.nudges, afterDays: s.afterDays,
    projects: Object.entries(s.projects).sort((a, b) => b[1].lastSeen - a[1].lastSeen).map(([key, p]) => ({
      key, name: p.name, muted: p.muted, lastSeen: p.lastSeen, lastCommitAt: p.lastCommitAt,
      quietDays: p.lastCommitAt ? streaks.daysSince(p.lastCommitAt, now) : null,
    })),
  };
}

function saveStreaks(next) {
  config.set({ streaks: next });
  send(panel, 'streaks', streaksView());
  refreshStatusLine();
}

// A task finished somewhere (dir: its working folder). Keeps the streak, and
// remembers the git repo it ran in with its newest commit time. A merge home
// (task: false) keeps the streak but isn't another task for the week's count.
async function recordWork(dir, { task = true } = {}) {
  if (CAPTURE || !config) return;
  timeTracker?.touch(dir);
  checkLeavingSoon();
  saveStreaks(streaks.recordWorkDay(config.get('streaks'), Date.now()));
  const repo = await repoOf(dir);
  if (!repo) return;
  if (task) config.set({ weekly: weekly.recordWork(config.get('weekly'), Date.now(), repo.name) }); // the week's top project
  let s = streaks.recordProject(config.get('streaks'), repo.key, repo.name, Date.now());
  const at = await lastCommitAt(repo.root);
  if (at) s = streaks.recordCommit(s, repo.key, at);
  saveStreaks(s);
}

// Dev/e2e only: run the nudge check on demand, ignoring quiet hours (nudges only fire 9:00-21:00).
const NUDGE_TEST = !app.isPackaged && process.env.SHELLBY_NUDGE_TEST === '1';

// Hourly: refresh every known project's last commit, then maybe nudge once.
async function checkNudges() {
  if (CAPTURE || !config) return;
  let s = streaks.normalize(config.get('streaks'));
  for (const key of Object.keys(s.projects)) {
    const at = await lastCommitAt(key);
    if (at) s = streaks.recordCommit(s, key, at);
  }
  saveStreaks(s);
  if (config.get('crabOnly') || focus.guarding(config.get('focus'), Date.now())) return;
  const n = streaks.dueNudge(s, Date.now(), NUDGE_TEST ? 12 : undefined);
  if (!n) return;
  saveStreaks(streaks.markNudged(config.get('streaks'), n.key, Date.now()));
  flashState('asking', 4000);
  const open = () => { showPanel(); send(panel, 'tab:new-in', { cwd: n.key, draft: `Where did we leave off in ${n.name}? Summarize what changed recently, what's unfinished, and suggest the next step.` }); };
  if (NUDGE_TEST || (panel?.isVisible() && panel.isFocused())) send(panel, 'nudge', { ...n, text: streaks.nudgeText(n) });
  else notify(streaks.nudgeText(n), 'Click to pick up where you left off.', open);
}

// ================================================================ settings side effects

// Settings as the panel sees them: the spend ledger stays in main (usage-service.js usageBreakdown),
// and Work mode's settings show as they apply, over your own (workmode.js).
function panelSettings() {
  const { spendLedger: _ledger, cacheDays: _c, setupWeights: _s, leanUsed: _u, pluginCosts: _p, mcpSeen: _m, pluginEnabledAt: _e, turnCosts: _t, phoneTasksSecret: _pt, ...rest } = workmode.effective(config.data);
  return { ...rest, dockOrder: workmode.behaviour(config.data).dock, crashReportsAvailable: !!sentry }; // no DSN in this build: the Settings row stays hidden
}

function applyHotkey(accel, previous) {
  if (previous) { try { globalShortcut.unregister(previous); } catch (err) { log.warn('old hotkey could not be released', err?.message); } }
  if (!accel) return true;
  try { return globalShortcut.register(accel, onHotkey); } catch (err) { log.warn('hotkey could not be registered', err?.message); return false; }
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

// Remembered for Up and Ctrl+R in the box (parity.js).
function rememberPrompt(text) { parityIpc?.rememberPrompt(text); }

function registerIpc() {
  // Every handler (here, in ipc/, and parity's and branching's) checks which
  // window is asking: the crab's gets only its own channels, other windows nothing.
  const ipcMain = guardIpc(electronIpcMain, windowPolicy(() => ({
    panel: panel && !panel.isDestroyed() ? panel.webContents : null,
    critter: critter && !critter.isDestroyed() ? critter.webContents : null,
    isToy: wc => !!playtime?.isToy(wc),
    isFloor: wc => !!floor?.isFloor(wc),
    isNote: wc => !!pranks?.isNote(wc),
  })), { onRefused: channel => log.warn('IPC refused', channel) });
  lean = createLean({
    config, shop: () => shop, shopBlocked, askOnce, toolbox: () => toolbox, setupWhere, configDir: claudeConfigDir, awardXp, log,
    memory: () => claudeSetup.scanMemory(setupWhere()),
    projectOf: tab => { const s = spendSource(tab); return s.pk ? { key: s.pk, name: s.project } : null; },
    currentProject: () => path.resolve(currentCwd()).toLowerCase(),
  });
  lean.register(ipcMain);
  createSkillRemover({
    toolbox: () => toolbox, askOnce, log, stat,
    // The folders the Toolbox scans (ToolboxWatcher's home and getCwd).
    where: () => ({ home: os.homedir(), cwd: currentCwd() }),
    trash: p => shell.trashItem(p),
    usage: () => lean.usage(),
    unpin: (kind, name) => config.set({ pinnedTools: (config.get('pinnedTools') || []).filter(p => !(p?.kind === kind && p?.name === name)) }),
  }).register(ipcMain);
  // Toolbox → Mods (mods-service.js): the CLI runs in the shop's empty folder.
  createModsService({
    toolbox: () => toolbox, shop: () => shop, askOnce, home: os.homedir(), log,
    // Just-the-crab mode leaves Claude Code alone, mods' checks and tests included.
    blocked: () => (config.get('crabOnly') ? { ok: false, error: 'Mods need Claude Code. Turn it on in Settings.' } : null),
    runClaude: (args, timeout) => {
      const exe = claudeStatus?.exe || findClaude(process.env, claudePath());
      if (!exe) return Promise.resolve({ ok: false, notInstalled: true, stdout: '', stderr: '' });
      const cwd = path.join(app.getPath('userData'), 'plugin-cli');
      try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* execFile reports it */ }
      return runCli(exe, args, timeout, { cwd });
    },
    uninstallPlugin: id => confirmAndUninstallPlugin(id),
    trash: p => shell.trashItem(p),
    openFolder: dir => editor.openFolder(dir),
    reveal: dir => { shell.openPath(dir); },
  }).register(ipcMain);
  parityIpc = parity.register({
    ipcMain, manager, history, config, confirm, dialog, clipboard, app,
    panel: () => panel, dialogLook, changeRef, setupWhere, setupView, currentCwd,
    toolbox: () => toolbox, lastInit: () => lastInit, stat, correctionFromTurns, noteCorrection,
    noteUndone: n => noteWeek('undone', null, n),
    turnEnding: tabId => turnEnds.get(tabId) || Promise.resolve(),
    dataDir: app.getPath('userData'),
    runClaude: (args, timeout, opts) => {
      const exe = claudeStatus?.exe || findClaude(process.env, claudePath());
      return exe ? runCli(exe, args, timeout, opts) : Promise.resolve({ ok: false, notInstalled: true, stdout: '', stderr: '' });
    },
  });
  teamIpc = teamIpcModule.register({
    ipcMain, config, shell, home: os.homedir(), panel: () => panel, send, currentCwd, stat,
    ownSnippets: snippetList, pushSnippets: () => send(panel, 'snippets', snippetsView()),
    workflows: () => (config.get('crabOnly') ? null : workflows),
    setupView, setupWhere, saveHook: req => confirmAndChangeHook(req, false), saveRule: req => parityIpc.changeRule(req),
    confirm: spec => confirm.ask(panel, { ...dialogLook(), ...spec }),
    runClaude: (args, timeout, opts) => {
      const exe = claudeStatus?.exe || findClaude(process.env, claudePath());
      return exe ? runCli(exe, args, timeout, opts) : Promise.resolve({ ok: false, notInstalled: true, stdout: '', stderr: '' });
    },
    log: { warn: msg => log.warn('team pack', msg) },
  });
  // ---- history (ipc/history.js)
  registerHistoryIpc(ipcMain, {
    history, manager, openTab, log,
    onCleared: () => usagePlan.clear(), // what each turn cost goes with the conversations
    confirmClear: async (count, openCount) => {
      const r = await dialog.showMessageBox(panel, {
        type: 'warning', buttons: ['Clear all history', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        ...clearQuestion(count, openCount),
      });
      return r.response === 0;
    },
  });

  // ---- skins, the wardrobe and outfit codes (ipc/wardrobe.js)
  registerWardrobeIpc(ipcMain, {
    wardrobe: () => wardrobe,
    builtinSkins: () => skins.map(s => ({ id: s.id, name: s.name })),
    allSkins, activeSkin, config, voice, confirmAndInstallPackText, installFromRegistry, registryUrl, broadcastSkin, userSkinsDir,
    reloadSkins: () => { skins = loadSkins(userSkinsDir()); wardrobe?.load(); broadcastWardrobe(); return allSkins(); },
    clearBackground: () => { external?.clearBackground(); return externalView(); },
    pickPackFile: async () => {
      const r = await dialog.showOpenDialog(panel, { title: 'Install a Shellby wardrobe pack', filters: [{ name: 'Shellby pack', extensions: ['json'] }], properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0] || null;
    },
    openPath: p => shell.openPath(p),
  });

  // ---- his tank (tank.js, ipc/tank.js): decor from the wardrobe, his finds, where they stand
  registerTankIpc(ipcMain, {
    config, stat,
    wardrobe: () => wardrobe,
    level: () => currentLevel(),
    shipped: () => stickers.stats(stickerState()).stickers,
  });

  // The rest, one area per module in ipc/.
  const d = shared;
  registerCritterIpc(ipcMain, d);
  registerLifeIpc(ipcMain, d);
  registerPanelIpc(ipcMain, d);
  registerTabsIpc(ipcMain, d);
  registerHandoffIpc(ipcMain, d);
  registerRepoIpc(ipcMain, d);
  registerSettingsIpc(ipcMain, d);
  registerToolboxIpc(ipcMain, d);
  registerRoutinesIpc(ipcMain, d);
  registerGithubIpc(ipcMain, d);
  registerProgressIpc(ipcMain, d);
  registerSurroundingsIpc(ipcMain, d);
  registerTriesIpc(ipcMain, d);
  registerCorrectionsIpc(ipcMain, d);
  registerStartFromIpc(ipcMain, d);
  registerCrewIpc(ipcMain, d);
}

// ================================================================ boot

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  config = new Config(userData);
  if (config.recoveredFrom) log.error('settings.json could not be read; started from defaults', `the old copy is at ${config.recoveredFrom}`);
  if (config.unreadable) log.error('settings.json is locked; running on defaults and not saving this session', config.unreadable);
  // Rooms are decided once: everything for someone who was already here, one
  // door at a time for someone new (rooms.js).
  if (config.get('rooms') == null) config.set({ rooms: rooms.initialRooms(!!config.get('onboarded')) });
  setPlanOnly(config.get('planOnly')); // before anything launches Claude Code
  history = new History(path.join(userData, 'sessions'), { onError: (what, err) => log.error(`history: ${what}`, err) });
  // Transcripts orphaned by an older build (which trimmed the index without
  // deleting them) or by an interrupted delete. Cheap, and it only ever removes
  // files nothing lists; see History.sweep().
  const swept = history.sweep();
  if (swept) log.info(`cleared ${swept} orphaned transcript${swept > 1 ? 's' : ''}`);
  // Recently deleted empties itself: at boot, and daily for a PC that never restarts.
  const purgeBin = () => {
    const n = history.purgeExpired();
    if (n) log.info(`purged ${n} expired deleted conversation${n > 1 ? 's' : ''}`);
  };
  purgeBin();
  setInterval(purgeBin, 24 * 60 * 60 * 1000).unref?.();
  attach.prune(path.join(userData, 'screenshots'));
  wardrobe = new Wardrobe({
    config, builtinDir: path.join(__dirname, '..', 'wardrobe'), userDir: path.join(userData, 'wardrobe'),
    now: () => captureClock.now || new Date(),
    south: () => seasonsWhere().south,
    // "Unlock everything" is held back for a paid tier; dev runs (e2e, screenshots) keep it.
    canUnlockAll: () => !app.isPackaged,
  });
  wardrobe.load();
  wardrobe.on('changed', broadcastWardrobe);
  wardrobe.on('unlocked', e => {
    flashState('unlocked', 6000);
    awardXp('trophy', { label: e.achievement.name });
    if (!CAPTURE) config.set({ weekly: weekly.recordTrophy(config.get('weekly'), Date.now(), e.achievement) });
    send(critter, 'critter:burst', outfit().confetti);
    send(panel, 'wardrobe:unlocked', e);
    send(panel, 'wardrobe', wardrobe.view());
    if (!(panel?.isVisible() && panel.isFocused())) {
      notify(`${e.achievement.icon} Achievement: ${e.achievement.name}`, `Unlocked ${e.rewards.map(r => r.name).join(' + ')}. Open the Wardrobe to try it on!`,
        () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'wardrobe'); }, { tone: 'celebrate', pet: true });
    }
  });
  wardrobe.on('collected', items => {
    send(panel, 'wardrobe:collected', items.map(i => ({ key: i.key, name: i.name })));
    broadcastWardrobe();
  });
  // Credit past usage from history on the Wardrobe's first run (must precede any stat()).
  if (!CAPTURE) {
    const day = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    // A function, so history is only read on the first run (backfill is a no-op after).
    welcomeTrophies = wardrobe.backfill(() => {
      const entries = history.list();
      return {
        tasksCompleted: entries.reduce((n, e) => n + history.load(e.id).filter(i => i.kind === 'result' && i.ok).length, 0),
        activeDays: [...new Set(entries.flatMap(e => [e.createdAt, e.updatedAt]).filter(Boolean).map(day))],
      };
    });
  }
  stat('active');
  // This PC's own XP count, so sync can add PCs together (xp.js).
  if (!CAPTURE && !config.get('xp')?.device) config.set({ xp: withDevice(config.get('xp'), randomUUID()) });
  awardXp('day');
  every(() => { wardrobe.collectSeasonals(); broadcastWardrobe(); }, 60 * 60 * 1000);
  skins = loadSkins(userSkinsDir());

  // Renderers never need camera, mic, geolocation etc.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // ...nor do they get to find out they might (the check behind permissions.query).
  electronSession.defaultSession.setPermissionCheckHandler(() => false);

  // The README reel shows Shellby big: he's the star.
  if (CAPTURE && process.argv.includes('--reel')) config.set({ critterScale: 2 });
  createGitHub();
  createManager();
  watchClashes();
  createCorrections();
  createHealth();
  registerIpc();
  createCritter();
  createMotion();
  createPanel();
  watchIdleCost();
  watchAway();
  watchLeaving();
  critter.webContents.on('did-finish-load', () => { broadcastSkin(); refreshCritter(); sendVisitor(); life?.resendLook(); typing?.resend(); });

  if (CAPTURE) return require(process.argv.includes('--reel') ? './reel' : './capture').run({ app, critter, panel, showPanel, send, ROOT, setCrewSlots, wardrobe, captureClock, broadcastWardrobe, health, config, broadcastSkin,
    makeTimeTracker: () => { createTimeTracker({ start: false }); return timeTracker; } });

  createToolbox();
  createShop();
  createTray();
  // Windows signing out or shutting down ends him without will-quit: that's no crash.
  for (const w of [critter, panel]) w?.on('session-end', () => crashReport.endRun(LOG_DIR));
  reportUncleanExit();
  // Answers given before a restart still apply: walk the queue once so what was
  // turned down leaves the disk, and what was okayed goes.
  setTimeout(drainCrashQueue, 10 * 1000);
  health.start();
  createExternal();
  createTimeTracker();
  createProjects();
  createCrabApi();
  createWorkflows();
  createDepWatch();
  createCi();
  createIssues();
  createFriends();
  channelSecret = loadChannelSecret();
  // Set up before destinations needed confirming (0.46.1): what you already
  // had running counts as said yes to, so an update doesn't silence it.
  if (config.get('channelsConfirmed') == null && channelSettings().enabled) config.set({ channelsConfirmed: channelPlace() });
  createRemote();
  createPhoneTasks(); // listening again, if your phone may start tasks
  // On, but not to anywhere you said yes to (a question still open when Shellby
  // quit, or a token Windows can no longer read back): ask now rather than
  // stay silently "on" and send nothing.
  confirmChannelPlace().catch(e => log.warn('channel confirm failed', e.message));
  createObs();
  createRgb();
  if (rgbSettings().enabled) ensureOpenRgb().catch(err => log.warn('OpenRGB could not be started', err?.message)); // lighting on: start OpenRGB if it isn't running
  createWeather();
  createMedia();
  createLifeAndPlay();
  createTypingAlong();
  createMischief();
  createDictation();
  if (config.get('focus')) advanceFocus(); // picks up (or finishes) a session from before a restart
  if (config.get('limitWait')) checkLimit(); // a limit that reset while Shellby was closed
  // Timers don't run while the PC sleeps: catch up on wake.
  powerMonitor.on('resume', () => { if (config.get('limitWait')) checkLimit(); if (config.get('focus')) advanceFocus(); if (routineService.isScheduling()) scheduleHeld(); });
  watchOutlook();
  watchGuards();
  setTimeout(checkNudges, 60 * 1000);
  try { if (statusLine.upgradeStatusLine(claudeSettings())) console.log('[shellby] updated the Claude Code status line command'); } catch (err) { log.warn('status line command could not be updated; left as it was', err?.message); }
  every(checkNudges, 60 * 60 * 1000);
  setTimeout(checkWrapUp, 2 * 60 * 1000);
  every(checkWrapUp, 30 * 60 * 1000);
  if (!applyHotkey(config.get('hotkey'))) console.warn('[shellby] hotkey unavailable:', config.get('hotkey'));
  applyLoginItem(config.get('openAtLogin'));
  setupUpdates();
  createClaudeUpdates();
  // Routines start either way: a failed CLI check must not silently leave them off.
  checkStatus({ configured: claudePath() })
    .then(s => { claudeStatus = FAKE_CLI ? require('./capture').FAKE_STATUS : s; })
    .catch(err => log.warn('Claude CLI status check failed at boot', err?.message || String(err)))
    .finally(startScheduler);

  const reclamp = () => {
    const c = clampToDisplays(critter.getBounds(), workAreas());
    placeCritter(c.x, c.y);
  };
  screen.on('display-removed', reclamp);
  screen.on('display-metrics-changed', reclamp);

  if (!config.get('onboarded')) showPanel({ focusInput: false });
  // Back from "Update and restart": you pressed a button in the panel, so
  // that's where you land.
  if (config.get('reopenAfterUpdate')) {
    config.set({ reopenAfterUpdate: false });
    showPanel();
  }

  // Says good morning, or notices you've been away for a few days.
  wakeVoice();

  // A gallery link that launched us (or arrived while booting) runs now.
  booted = true;
  const link = pendingLink || findDeepLink(process.argv);
  pendingLink = null;
  if (link) onDeepLink(link);
});

app.on('second-instance', (_e, argv) => {
  const link = findDeepLink(argv);
  if (link) return onDeepLink(link);
  // A dev run (`electron .` shares this profile) bumping into us isn't you
  // opening Shellby: it mustn't drag the panel over whatever you're doing.
  if (path.basename(argv[0] || '').toLowerCase() !== path.basename(process.execPath).toLowerCase()) {
    log.info('second-instance: a dev run started and exited; panel left alone');
    return;
  }
  if (booted) { reachedForShellby(); showPanel(); }
});
app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => {
  typing?.stop(); // lets go of the keyboard (keystrokes.js)
  statusLine.clearStatus(statusFile()); // Claude Code's status line goes quiet when Shellby does
  globalShortcut.unregisterAll();
  routineService.stop();
  if (config) saveSpend();
  if (config) usagePlan.save();
  lean?.save();
  toolbox?.stop();
  health?.stop();
  timeTracker?.stop(); // writes the last minutes down
  depWatch?.stop();
  external?.stop();
  github?.stop();
  friends?.stop();
  life?.stop();
  playtime?.stop();
  pranks?.dispose();
  floor?.dispose();
  ci?.stop();
  clearTimeout(focusTimer);
  clearInterval(focusTick);
  usageService.stop(); // the reset tap
  repeating.forEach(clearInterval);
  remote?.shutdown();
  dictation?.stop();
  media?.stop(); // its PowerShell loop never reads stdin, so it won't notice we've gone
  if (PRIMARY && !CAPTURE) crashReport.endRun(LOG_DIR); // quit on purpose: nothing to report next time
});
// close() gives a process 3 s to finish on its own, which Shellby quitting never
// waits for: one mid-task would carry on editing with no window to show it.
// Workflows freeze first: a run cut off by quitting is resumable, not failed.
app.on('before-quit', () => {
  app.isQuitting = true;
  remote?.shutdown(); // no task from the phone starts while he's on his way out
  workflows?.shutdown();
  manager?.closeAll({ kill: true });
  cancelAllChecks(); // a test run Shellby started ends with him
  // Quits that didn't come through quit() (Windows shutting down, say):
  // "Stop them" still holds. taskkill runs on its own, so Shellby exiting
  // can't cut it off halfway down the tree, and the servers are saved as gone.
  if (devServers?.view().settings.onQuit === 'stop') devServers.stopAll({ detached: true }).catch(err => log.warn('dev servers could not be stopped at quit', err?.message));
  devServers?.shutdown();
});
