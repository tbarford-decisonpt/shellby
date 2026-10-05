const { app, BrowserWindow, ipcMain: electronIpcMain, screen, shell, dialog, globalShortcut, clipboard, session: electronSession, powerMonitor, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { randomUUID } = crypto;

const { Config } = require('./config');
const { History } = require('./history');
const { MAX_TABS } = require('./sessions');
const { checkStatus, findClaude, setPlanOnly, run: runCli } = require('./claude-cli');
const { loadSkins } = require('./skins');
const { sendToBottom } = require('./desktop-layer');
const { clampToDisplays, panelPosition } = require('./placement');
const claudeSetup = require('./claude-setup');
const { missedOnStartup, nextRun, describeSchedule, Scheduler } = require('./routines');
const routineDraft = require('./routine-draft');
const { Wardrobe } = require('./wardrobe/service');
const confirm = require('./confirm');
const { attachContextMenu } = require('./context-menu');
const { REGISTRY_URL, PROTOCOL, findDeepLink } = require('./registry');
const crabtools = require('./crabtools');
const mcpServers = require('./mcpservers');
const changes = require('./changes');
const worktrees = require('./worktrees');
const native = require('./native-windows');
const { kindOfApp } = require('./surroundings');
const { withDevice } = require('./xp');
const shells = require('./shells');
const focus = require('./focus');
const rooms = require('./rooms');
const limits = require('./limits');
const spend = require('./spend');
const { createLean } = require('./lean');
const { createSkillRemover } = require('./skillremove');
const recap = require('./recap');
const leaving = require('./leaving');
const secretscan = require('./secretscan');
const forecast = require('./forecast');
const guard = require('./guard');
const held = require('./held');
const voice = require('./voice');
const statusLine = require('./statusline');
const streaks = require('./streaks');
const { repoOf, lastCommitAt, projectOf, trackedFiles, stickerFile } = require('./gitinfo');
const stickers = require('./stickers');
const weekly = require('./weekly');
const stickerArt = require('./sticker-art');
const { shellMask, stickerSlots, STICKER } = require('./sticker-slots');
const { Log } = require('./log');
const crashReport = require('./crash-report');
const attach = require('./attachments');
const parity = require('./parity');
const teamIpcModule = require('./team-ipc');
const { guardIpc, windowPolicy } = require('./ipc-guard');
const branch = require('./branch');
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
const { wireSurroundings } = require('./wiring/surroundings');
const { wireToolbox } = require('./wiring/toolbox');
const { wireGithub } = require('./wiring/github');
const { wireFocus } = require('./wiring/focus');
const { wireSnippets } = require('./wiring/snippets');
const { wireProjects } = require('./wiring/projects');
const { wirePacks } = require('./wiring/packs');
const { wireTray } = require('./wiring/tray');
const { registerCritterIpc } = require('./ipc/critter');
const { registerLifeIpc } = require('./ipc/life');
const { registerPanelIpc } = require('./ipc/panel');
const { registerTabsIpc } = require('./ipc/tabs');
const { registerRepoIpc } = require('./ipc/repo');
const { registerSettingsIpc } = require('./ipc/settings');
const { registerToolboxIpc } = require('./ipc/toolbox');
const { registerRoutinesIpc } = require('./ipc/routines');
const { registerGithubIpc } = require('./ipc/github');
const { registerProgressIpc } = require('./ipc/progress');
const { registerSurroundingsIpc } = require('./ipc/surroundings');

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

let config, history, skins, manager, toolbox, scheduler, wardrobe, health, external, shop, github, ci, issues, updates, friends, profileCard, prBadge;
let workflows = null;              // the Automate page's engine (workflows/service.js)
let depWatch = null;               // the weekly look at your projects' packages (depwatch.js)
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
const routineTabs = new Map();     // tabId -> routine id (for lastStatus bookkeeping)
const queueTabs = new Map();       // tabId -> held task id, for tasks queued for the reset (held.js)
const queueWaits = new Map();      // tabId -> resolve(how its turn ended), while the queue waits on it
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

// What main shares with the modules in ipc/ and wiring/. Functions declared
// here are hoisted, so they go as they are; everything else is a getter, read
// when it's used: most of it is set at boot or changes as he runs, and some is
// only declared further down. A setter is there only where a module changes it.
const shared = {
  applyHotkey, applyLoginItem, armCopy, armGuard, changeRef, chatRoutine, checkAway, checkGuards,
  checkNudges, draftRoutine, drawSticker, gameInFront, greet, holdForReset, leaveCheck,
  moveIntoCopy, noteRecap, onSpend, onUsage, outlookView, panelSettings, placeStickers,
  proposeRoutine, queueTask, recordWork, refreshOutlook, rememberPrompt, reopenForHeld,
  repairRoutine, retireWorktree, routineTestView, routines, routinesView, runRoutine,
  saveCritterPos, saveHeld, saveRoutines, saveStreaks, send, sendOutlook, setCrewSlots,
  setPanelRoomy, shellStickers, shipped, shippedMerge, showPanel, streaksView, syncKeepAwake,
  testRoutine, togglePanel, updateRoutine, usageBreakdown,
  get BASE_PX() { return BASE_PX; },
  get CAPTURE() { return CAPTURE; },
  get CARD_MAX_BYTES() { return CARD_MAX_BYTES; },
  get CREW_WORTH_MENTIONING() { return CREW_WORTH_MENTIONING; },
  get CRITTER_PRELOAD() { return CRITTER_PRELOAD; },
  get FAKE_CLI() { return FAKE_CLI; },
  get FLOOR_PRELOAD() { return FLOOR_PRELOAD; },
  get FORECAST_TEST() { return FORECAST_TEST; },
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
  get RECAP_TEST() { return RECAP_TEST; },
  get RENDERER() { return RENDERER; },
  get ROOT() { return ROOT; },
  get SLEEP_AFTER_MS() { return SLEEP_AFTER_MS; },
  get SNAPSHOT_WAIT_MS() { return SNAPSHOT_WAIT_MS; },
  get TAB_IDLE_CHECK_MS() { return TAB_IDLE_CHECK_MS; },
  get TAB_IDLE_STOP_MS() { return TAB_IDLE_STOP_MS; },
  get TOY_PRELOAD() { return TOY_PRELOAD; },
  get TRICKS_KIND() { return TRICKS_KIND; },
  get activeSkin() { return activeSkin; },
  get advanceFocus() { return advanceFocus; },
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
  get channelPlace() { return channelPlace; },
  get channelSecret() { return channelSecret; }, set channelSecret(v) { channelSecret = v; },
  get channelSettings() { return channelSettings; },
  get channelsView() { return channelsView; },
  get checkedUp() { return checkedUp; },
  get checkupsView() { return checkupsView; },
  get chirp() { return chirp; },
  get ci() { return ci; }, set ci(v) { ci = v; },
  get ciView() { return ciView; },
  get claudeConfigDir() { return claudeConfigDir; },
  get claudePath() { return claudePath; },
  get claudeSettings() { return claudeSettings; },
  get claudeStatus() { return claudeStatus; }, set claudeStatus(v) { claudeStatus = v; },
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
  get crashConsent() { return crashConsent; },
  get crewExtra() { return crewExtra; },
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
  get github() { return github; }, set github(v) { github = v; },
  get guestShown() { return guestShown; },
  get health() { return health; }, set health(v) { health = v; },
  get healthMood() { return healthMood; }, set healthMood(v) { healthMood = v; },
  get heldList() { return heldList; },
  get heldNotices() { return heldNotices; }, set heldNotices(v) { heldNotices = v; },
  get helperWidth() { return helperWidth; },
  get history() { return history; },
  get homesView() { return homesView; },
  get importSnippets() { return importSnippets; },
  get installCli() { return installCli; },
  get isFolder() { return isFolder; },
  get isStr() { return isStr; },
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
  get leaveVerdict() { return leaveVerdict; },
  get levelUpAt() { return levelUpAt; }, set levelUpAt(v) { levelUpAt = v; },
  get life() { return life; }, set life(v) { life = v; },
  get limitWait() { return limitWait; },
  get linkBusy() { return linkBusy; }, set linkBusy(v) { linkBusy = v; },
  get log() { return log; },
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
  get noteFix() { return noteFix; },
  get noteRed() { return noteRed; },
  get noteSnippetUse() { return noteSnippetUse; },
  get noteTestRun() { return noteTestRun; },
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
  get pinnedTools() { return pinnedTools; },
  get placeCritter() { return placeCritter; },
  get playtime() { return playtime; }, set playtime(v) { playtime = v; },
  get pluginView() { return pluginView; },
  get prBadge() { return prBadge; }, set prBadge(v) { prBadge = v; },
  get pranks() { return pranks; }, set pranks(v) { pranks = v; },
  get profileCard() { return profileCard; }, set profileCard(v) { profileCard = v; },
  get projectInsights() { return projectInsights; },
  get projects() { return projects; }, set projects(v) { projects = v; },
  get ptt() { return ptt; }, set ptt(v) { ptt = v; },
  get px() { return px; },
  get queueTabs() { return queueTabs; },
  get queueWaits() { return queueWaits; },
  get randomUUID() { return randomUUID; },
  get reachedForShellby() { return reachedForShellby; },
  get recapLog() { return recapLog; }, set recapLog(v) { recapLog = v; },
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
  get routineTabs() { return routineTabs; },
  get routineTests() { return routineTests; },
  get runCheckup() { return runCheckup; },
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
  get shellIdOf() { return shellIdOf; },
  get shellSpots() { return shellSpots; },
  get shop() { return shop; }, set shop(v) { shop = v; },
  get shopAsking() { return shopAsking; }, set shopAsking(v) { shopAsking = v; },
  get shopBlocked() { return shopBlocked; },
  get shotsDir() { return shotsDir; },
  get showFlaky() { return showFlaky; },
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
  get startTask() { return startTask; },
  get startTaskInCopy() { return startTaskInCopy; },
  get startView() { return startView; }, set startView(v) { startView = v; },
  get stat() { return stat; },
  get statusFile() { return statusFile; },
  get stickerState() { return stickerState; },
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
  get turnEnds() { return turnEnds; },
  get turnStarts() { return turnStarts; },
  get typing() { return typing; }, set typing(v) { typing = v; },
  get typingSettings() { return typingSettings; },
  get updateView() { return updateView; },
  get updates() { return updates; }, set updates(v) { updates = v; },
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
  get wornShellObj() { return wornShellObj; },
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
  knownFolder, noteFix, noteRed, noteTestRun, noteWeek, noteWorkTime, roomTaskDone, roomsPanelView,
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
  answerPermission, askOnPhone, channelPlace, channelSettings, channelsView, confirmChannelPlace,
  createObs, createRemote, loadChannelSecret, obsSettings, obsState, obsView, saveChannelSecret,
  tellChannel,
} = wireChannels(shared);
const {
  confirmAndInstallOpenRgb, createDictation, createLifeAndPlay, createMedia, createRgb,
  createTypingAlong, createWeather, ensureOpenRgb, mediaSettings, mediaView, musicHeadphones,
  onHotkey, paintLights, restoreLights, rgbSettings, rgbView, showListening, typingSettings,
  weatherView,
} = wireSurroundings(shared);
const {
  askOnce, confirmAndChangeHook, confirmAndInstallPlugin, confirmAndInstallShellbyPlugin,
  confirmAndUninstallPlugin, createShop, createToolbox, forgetPausedHook, pauseHook, pluginView,
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
const {
  askToSend, buildMenu, createTray, drainCrashQueue, reportProblem, reportUncleanExit,
  setupUpdates, updateView,
} = wireTray(shared);

// ---------------------------------------------------------------- while you were away (recap.js)
// What finished, failed and used the window is noted as it happens; whether
// you're at the keyboard comes from Windows' idle time, read once a minute and
// on lock, unlock, sleep and wake.
const AWAY_POLL_MS = 60 * 1000;
// Dev/e2e only: the idle readings come from dev:away instead of Windows.
const RECAP_TEST = !app.isPackaged && process.env.SHELLBY_RECAP_TEST === '1';
let recapLog = [];
let away = { since: null };

function noteRecap(event) {
  if (event) recapLog = recap.record(recapLog, event, Date.now());
}

function checkAway({ locked = false, idleMs = null } = {}) {
  if (CAPTURE || !config) return;
  if (idleMs === null) {
    if (RECAP_TEST) return;
    try {
      idleMs = powerMonitor.getSystemIdleTime() * 1000;
      // Asked each time rather than tracked from events: a nudge of the mouse
      // on the lock screen, or a wake nobody is there for, still reads as locked.
      locked = locked || powerMonitor.getSystemIdleState(60) === 'locked';
    } catch { return; }
  }
  const r = recap.watch(away, { now: Date.now(), idleMs, locked });
  away = r.state;
  if (r.back) {
    greet(r.back.until - r.back.since);
    welcomeBack(r.back);
  }
}

// He runs to the front of his window and waves you back in, both claws once
// you've been gone a good while. Never a sulk, however long it was.
function greet(awayMs) {
  if (CAPTURE || !critter || critter.isDestroyed()) return;
  send(critter, 'critter:greet', { awayMs: Math.max(0, Number(awayMs) || 0) });
}

function watchAway() {
  if (CAPTURE) return;
  for (const gone of ['lock-screen', 'suspend']) powerMonitor.on(gone, () => checkAway({ locked: true }));
  for (const here of ['unlock-screen', 'resume']) powerMonitor.on(here, () => checkAway());
  setInterval(checkAway, AWAY_POLL_MS);
}

// Prompts open right now, in Shellby's tabs and in Claude Code elsewhere.
function waitingOnYou() {
  const kindOf = items => (items.some(i => i.toolName === 'AskUserQuestion') ? 'question' : items.some(i => i.toolName === 'ExitPlanMode') ? 'plan' : 'approval');
  const own = [...(manager?.tabs.values() || [])]
    .filter(t => t.session.pending.size)
    .map(t => ({ tabId: t.id, title: t.title, what: kindOf([...t.session.pending.values()]) }));
  const elsewhere = (external?.summary.sessions || [])
    .filter(s => s.state === 'asking')
    .map(s => ({ tabId: null, title: s.where || s.project, what: 'approval', external: true }));
  return [...own, ...elsewhere];
}

function welcomeBack({ since, until }) {
  if (config.get('recap') === false || !panel || panel.isDestroyed()) return;
  const digest = recap.build(recapLog, { since, until, waiting: waitingOnYou(), limit: limitWait() });
  if (!digest) return;
  send(panel, 'recap', digest);
  speak('back', { force: true });
  if (panel.isVisible() && panel.isFocused()) return;
  notify(`While you were away (${recap.awayFor(digest.awayMs)})`, recap.headline(digest), () => showPanel({ focusInput: false }));
}

// ---------------------------------------------------------------- is it safe to leave? (leaving.js)
// Unpushed, uncommitted and stashed work in the projects you've been in lately,
// plus anything still running. Asked from the menu ("Is it safe to leave?" and
// "Lock the PC", which checks first), and kept fresh in the background so that
// a shutdown or sign-out can be held up with the reason beside Shellby's name:
// Windows can't tell an app the screen is about to lock, but it does ask before
// ending the session.
const LEAVE_RECENT_MS = 14 * 24 * 60 * 60 * 1000; // projects worked in this recently are checked
const LEAVE_REFRESH_MS = 10 * 60 * 1000;
const LEAVE_AFTER_WORK_MS = 30 * 1000;            // a finished turn usually committed or changed something
let leaveProjects = [];   // the last git check, for the shutdown guard (which can't wait for git)
let leaveChecking = null; // the check in flight, shared by everyone who asks meanwhile
let leaveSoon = null;

function leaveFolders() {
  const now = Date.now();
  const recent = Object.entries(streaks.normalize(config.get('streaks')).projects)
    .filter(([, p]) => now - p.lastSeen < LEAVE_RECENT_MS)
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .map(([key]) => key);
  const tabs = [...(manager?.tabs.values() || [])].map(t => t.session?.cwd);
  return [...tabs, ...(config.get('recentFolders') || []), ...recent].filter(Boolean);
}

// What's in flight right now, in Shellby and in Claude Code elsewhere. Live, so cheap.
function runningNow() {
  const tabs = [...(manager?.tabs.values() || [])];
  const ext = external?.summary || { sessions: [], background: [] };
  return {
    working: [
      ...tabs.filter(t => t.session.busy && !t.session.pending.size).map(t => t.title),
      ...(ext.sessions || []).filter(s => s.state === 'working').map(s => s.where || s.project),
    ],
    waiting: waitingOnYou().map(w => w.title),
    background: (ext.background || []).map(b => ({ program: b.program, project: b.project })),
    servers: devServers?.runningList() || [],
  };
}

// fresh: don't settle for a check that started before you asked (a push you
// made a moment ago must count), so wait for that one and run another.
async function checkLeaving({ fresh = false } = {}) {
  if (CAPTURE || !config) return [];
  if (fresh && leaveChecking) await leaveChecking;
  leaveChecking ||= leaving.check(leaveFolders(), undefined, { scan: secretscan.atRisk })
    .then(projects => { leaveProjects = projects; return projects; })
    .catch(e => { log.warn('safe-to-leave check failed', e.message); return leaveProjects; })
    .finally(() => { leaveChecking = null; });
  return leaveChecking;
}

// The cached answer, with what's running read fresh.
const leaveVerdict = () => leaving.verdict(leaveProjects, runningNow());

function checkLeavingSoon() {
  clearTimeout(leaveSoon);
  leaveSoon = setTimeout(checkLeaving, LEAVE_AFTER_WORK_MS);
}

// lock: asked from "Lock the PC". Safe locks straight away; anything at risk is
// listed first, with the choice to lock anyway or have Claude tidy it up.
async function leaveCheck({ lock = false } = {}) {
  const v = leaving.verdict(await checkLeaving({ fresh: true }), runningNow());
  if (v.safe && lock) { native.lockScreen(); return; }
  const fixable = leaveProjects.find(p => p.ok && leaving.verdict([p]).lines.length);
  const canFix = !v.safe && !!fixable && !config.get('crabOnly');
  const buttons = v.safe
    ? [{ label: 'Lock the PC' }, { label: 'Close' }]
    : [{ label: 'Lock anyway', style: 'danger' }, ...(canFix ? [{ label: `Tidy up ${fixable.name}` }] : []), { label: 'Stay' }];
  const cancelId = buttons.length - 1;
  const response = await confirm.ask(panel, {
    ...dialogLook(), icon: v.safe ? '🐚' : '🧳',
    title: v.safe ? 'Safe to leave' : 'Not quite safe to leave',
    message: v.headline,
    detail: v.lines.slice(0, 12).join('\n') + (v.lines.length > 12 ? `\n…and ${v.lines.length - 12} more` : ''),
    note: v.safe ? '' : 'Locking never loses any of this, but a shutdown or a dead battery can.',
    buttons, defaultId: v.safe ? 0 : cancelId, cancelId,
  });
  if (response === 0) native.lockScreen();
  else if (canFix && response === 1) {
    showPanel();
    // Never "commit and push everything" past a secret: Claude is told what Shellby found, and to stop there.
    const found = fixable.secrets?.findings.map(secretscan.describe) || [];
    const secrets = found.length
      ? ` Shellby found what look like secrets in work that hasn't gone out yet: ${found.join('; ')}. Don't commit or push those: tell me about them first.`
      : '';
    send(panel, 'tab:new-in', { cwd: fixable.root, draft: `I'm about to leave my PC. In ${fixable.name}: commit any uncommitted work with clear messages, push every branch that has commits the remote doesn't, and tell me what's in any stashes. Never commit or push a .env file, a key file or anything that looks like a password or API key.${secrets} Ask me before anything destructive.` });
  }
}

// Windows asks every window before a shutdown, restart or sign-out. While work
// is at risk Shellby says no, with the reason, and Windows shows it beside his
// name with "Shut down anyway". Only for work this PC alone has, or Claude
// mid-turn (leaving.verdict's hold); never for a critical shutdown or an
// installer asking apps to close (close-app). With no reason to show (koffi
// missing), he never holds it up: a nameless "an app is preventing shutdown"
// would just look broken.
function guardSessionEnd(win) {
  const release = () => { try { if (!win.isDestroyed()) native.unblockShutdown(native.hwndOf(win)); } catch { /* best effort */ } };
  win.on('query-session-end', e => {
    try {
      const reasons = e.reasons || [];
      const v = leaveVerdict();
      if (config.get('leaveGuard') === false || reasons.includes('critical') || reasons.includes('close-app') || !v.hold) { release(); return; }
      if (native.blockShutdown(native.hwndOf(win), `Shellby: ${v.headline}`)) e.preventDefault();
      // What it said may be up to ten minutes old: look again, so the next try is right.
      checkLeaving();
    } catch (err) { log.warn('shutdown guard failed', err.message); }
  });
  win.on('session-end', release);
}

function watchLeaving() {
  if (CAPTURE) return;
  guardSessionEnd(critter);
  setTimeout(checkLeaving, 90 * 1000);
  setInterval(checkLeaving, LEAVE_REFRESH_MS);
  // Leaving the desk is when the answer matters next: have it ready.
  for (const gone of ['lock-screen', 'suspend']) powerMonitor.on(gone, () => checkLeaving());
}

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

// ================================================================ a copy of the repo per tab (worktrees.js)

const worktreeHome = () => path.join(app.getPath('userData'), 'worktrees');

// A conversation in a git project starts in your checkout, and moves into a
// copy of its own (worktrees.js) the first time it goes to change something:
// a question makes no branch, and by then Claude knows enough to name one.
//
// armCopy, before each turn: while the tab has no copy, a hook on the tools
// that change files sees each call first. The first real change is held back,
// Claude is asked for a branch name, and when that turn ends moveIntoCopy makes
// the copy, carries the conversation across and lets Claude carry on there.
async function armCopy(tab) {
  // A branch (branch.js) already has its copy, but Claude remembers the
  // original's paths: the same hook keeps its changes out of them. Only while
  // that copy is the one it works in: once it's gone, so is the fence.
  if (tab.fence && tab.worktree && !CAPTURE && path.resolve(tab.fence.home || '').toLowerCase() === path.resolve(tab.worktree.path).toLowerCase()) {
    tab.session.beforeWork = input => {
      const why = branch.fenceDenies(tab.fence, input.tool_name, input.tool_input);
      return why ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } } : {};
    };
    return;
  }
  if (!config.get('worktrees') || CAPTURE || tab.noCopy || tab.routineId || tab.workflowRunId || tab.worktree) {
    tab.session.beforeWork = null;
    return;
  }
  if (tab.session.beforeWork) return;
  const root = await changes.rootOf(tab.session.cwd);
  const home = path.resolve(worktreeHome()).toLowerCase() + path.sep;
  // Not a repo, already one of our copies, or a conversation that has already
  // changed files here: it stays where it is.
  if (!root || (path.resolve(root) + path.sep).toLowerCase().startsWith(home)) return;
  if (tab.saved && history.load(tab.id).some(i => i.kind === 'changes')) return;
  tab.session.beforeWork = input => {
    if (tab.worktree || tab.noCopy || !config.get('worktrees')) return {};
    if (!worktrees.startsWork(input.tool_name, input.tool_input)) return {};
    tab.copyWanted = true;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NAME_THE_BRANCH } };
  };
}

const NAME_THE_BRANCH = 'Not yet: before anything changes, Shellby moves this conversation into its own copy of the repository, on a new branch. '
  + 'Run no more tools this turn. Reply with one line, "Branch: <name>", where <name> is 2 to 5 lowercase words joined by hyphens that say what this work is '
  + '(for example "Branch: fix-login-redirect"). You will carry on from where you were, in the copy.';

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

async function moveIntoCopy(tab) {
  tab.copyWanted = false;
  const session = tab.session;
  const from = session.cwd;
  // Busy throughout, so a message typed meanwhile waits for the move.
  session.setBusy(true);
  const carryOn = text => {
    session.setBusy(false);
    if (!manager.tabs.has(tab.id)) return;
    try { session.send(text, manager.prepareTurn(tab)); } catch (err) { log.info(`worktree: ${err.message}`); }
  };
  const stayHere = why => {
    tab.noCopy = true;
    manager.note(tab.id, { kind: 'error', text: `Working in your checkout: ${why}` });
    carryOn('Shellby could not make a copy, so this conversation stays in this folder. Carry on with what you were about to do, here.');
  };

  const made = await worktrees.create(from, { home: worktreeHome(), title: worktrees.suggestedName(tab.lastReply) || tab.title });
  if (!manager.tabs.has(tab.id)) { // closed while the copy was being made
    if (made?.ok) worktrees.remove(made.worktree, { force: true });
    return;
  }
  if (!made?.ok) return stayHere(made?.error || 'this folder is not in a git repository.');
  const w = made.worktree;
  await session.stop();
  if (!worktrees.carryTranscript({ configDir: claudeConfigDir(), sessionId: session.sessionId, from, to: w.cwd })) {
    await worktrees.remove(w, { force: true });
    return stayHere("Claude Code's record of this conversation couldn't be carried into the copy.");
  }
  tab.worktree = w;
  session.cwd = w.cwd;
  session.beforeWork = null;
  history.update(tab.id, { cwd: w.cwd, worktree: w });
  log.info(`worktree: ${w.branch} for ${path.basename(w.root)}`);
  manager.note(tab.id, { kind: 'moved', branch: w.branch, base: w.base });
  manager.changed();
  carryOn(`Shellby has moved this conversation into its own copy of the repository, at ${w.path}, on branch ${w.branch}, started from ${w.base} at its last commit. `
    + `Work there from now on: the project that was at ${w.root} is at ${w.path} in this copy, so use paths under it. `
    + "It has every committed file; anything uncommitted or ignored in the original (node_modules, build output) isn't in it. "
    + 'Carry on with what you were about to do.');
}

// Done with the copy: the tab closes (its process has to be gone before
// Windows lets the folder go), and its History entry points home again.
async function retireWorktree(tabId, w, { force }) {
  remote?.settleTab(tabId);
  await manager.closeAndWait(tabId);
  routineTabs.delete(tabId);
  queueTabs.delete(tabId);
  queueWaits.get(tabId)?.({ ok: false, interrupted: true, closed: true });
  queueWaits.delete(tabId);
  turnStarts.delete(tabId);
  const removed = await worktrees.remove(w, { force });
  // The conversation was Claude's in the copy's folder, and can't be resumed
  // from another one: History keeps the transcript and starts afresh there.
  // The copy's diffs were snapshots in the repository's shared object store,
  // so they still read from your checkout once the folder is gone.
  const copies = (history.get(tabId)?.copies || []).filter(c => c.path !== w.path);
  // A branch's fence and note were about its copy (branch.js): with the copy
  // gone it works in your checkout like any conversation, so they go too.
  history.update(tabId, { cwd: w.originalCwd, worktree: null, claudeSessionId: null, fence: null, preamble: null, copies: [...copies, { path: w.path, root: w.root }] });
  return removed;
}

// What the renderer hands back about a diff block, and nothing else. It has to
// be a change main reported in that tab's transcript (and, for one file's diff,
// one of its files): the renderer can't point git at any repo or tree it likes.
// A change made in a copy that has since been tidied away reads from the repo
// the copy came from (retired: there's no copy left to undo it in).
function changeRef(r) {
  const tabId = isStr(r?.tabId) ? r.tabId : null;
  if (!tabId) return null;
  const reported = history.load(tabId).find(i => i.kind === 'changes' && i.root === r.root && i.before === r.before && i.after === r.after);
  if (!reported) return null;
  if (r.file != null && !reported.files?.some(f => f.path === r.file)) return null;
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const copy = !fs.existsSync(reported.root) && (history.get(tabId)?.copies || []).find(c => isStr(c?.path) && isStr(c?.root) && same(c.path, reported.root));
  return {
    tabId, root: copy ? copy.root : reported.root, before: reported.before, after: reported.after,
    ...(copy ? { retired: true } : {}), ...(r.file != null ? { file: r.file } : {}),
  };
}

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

// ================================================================ shell stickers (stickers.js)
//
// The first time a project ships, Shellby gets a sticker for it and slaps it
// on his shell; shipping it again makes the sticker better. The drawing is
// generated from the project (sticker-art.js), so only the counts and where
// each one sits are stored.

const SLAP_MS = 3200;                // the critter's slap, from holding it up to the squash
const FACTS_MS = 24 * 60 * 60 * 1000; // a project's language and own sticker, looked up at most daily
const drawings = new Map();          // look -> drawing (sticker-art.js)
const projectFacts = new Map();      // repo root -> { lang, custom, at }

const shellIdOf = shell => (shell ? shell.id : stickers.HOME);
const wornShellObj = () => shells.wornShell(config?.get('home'), currentLevel());
const stickerState = () => stickers.normalize(config.get('stickers'));

function drawSticker(p) {
  const key = JSON.stringify([p.id, p.name, p.lang, p.custom]);
  let d = drawings.get(key);
  if (!d) {
    d = stickerArt.draw(p);
    drawings.set(key, d);
    if (drawings.size > 400) drawings.delete(drawings.keys().next().value);
  }
  return d;
}

// Where stickers can go on a shell, for whichever skin he's wearing.
const shellSpots = (skin, shell) => {
  const mask = shellMask(skin, shell);
  return { mask, slots: stickerSlots(mask) };
};
const covers = (mask, x, y) => {
  for (let dy = 0; dy < STICKER; dy++) for (let dx = 0; dx < STICKER; dx++) if (!mask[y + dy]?.[x + dx]) return false;
  return true;
};

/** The stickers on a shell, placed in sprite pixels and stacked, for sprite.js. */
function shellStickers(skin, shell, state = stickerState()) {
  const layout = state.layouts[shellIdOf(shell)] || [];
  const now = Date.now();
  return placeStickers(skin, shell, layout.map(e => {
    const p = state.projects[e.id];
    const tier = stickers.tierFor(p.ships).id;
    const weather = stickers.weathering(p, now);
    return { id: p.id, tier, weather, slot: e.slot, z: e.z, flip: e.flip, nudge: e.nudge, ...stickerArt.onShell(drawSticker(p), { tier, weather, flip: e.flip }) };
  }));
}

// Stickers by spot number onto this skin's shell, in sprite pixels: the same
// spot means the same place on any crab (a visiting friend's too).
function placeStickers(skin, shell, list) {
  if (!list.length || !skin) return [];
  const { mask, slots } = shellSpots(skin, shell);
  if (!slots.length) return [];
  return list.map(e => {
    let [x, y] = slots[e.slot % slots.length];
    // Shifted a pixel so the one underneath peeks out, unless that would hang off the shell.
    if (covers(mask, x + e.nudge[0], y + e.nudge[1])) { x += e.nudge[0]; y += e.nudge[1]; }
    return { ...e, x, y };
  });
}

// What the repo itself says about its sticker: its main language, and its own
// drawing if it ships one (.shellby/sticker.json, validated in stickers.js).
async function factsOf(root) {
  const f = projectFacts.get(root);
  if (f && Date.now() - f.at < FACTS_MS) return f;
  const [files, custom] = await Promise.all([trackedFiles(root), stickerFile(root)]);
  const next = { lang: stickerArt.languageOf(files), custom: stickers.cleanCustom(custom), at: Date.now() };
  projectFacts.set(root, next);
  if (projectFacts.size > 100) projectFacts.delete(projectFacts.keys().next().value);
  return next;
}

/** Something in `dir` shipped: 'ship' | 'deploy' | 'release' | 'merge'. */
async function shipped(dir, kind, meta = {}) {
  if (CAPTURE || !config || typeof dir !== 'string' || !dir) return;
  try {
    const project = await projectOf(dir);
    if (!project) return;
    const facts = await factsOf(project.root);
    recordShipped({ ...project, lang: facts.lang, custom: facts.custom }, kind, meta);
  } catch (e) {
    log.error('sticker', e);
  }
}

// A pull request merged on GitHub (ci.js). It's the project's sticker whether
// or not it's cloned here; if it is (Shellby has seen you work in it), the
// sticker learns its language and folder from that copy.
async function shippedMerge(pr) {
  if (CAPTURE || !config) return;
  try {
    const remote = stickers.normalizeRemote(`${githubEndpoints().web}/${pr.repo}`);
    if (!remote) return;
    const id = stickers.projectId(remote);
    const known = stickerState().projects[id];
    let root = known?.root && fs.existsSync(known.root) ? known.root : null;
    for (const key of root ? [] : Object.keys(streaks.normalize(config.get('streaks')).projects).slice(0, 50)) {
      if ((await projectOf(key))?.id === id) { root = key; break; }
    }
    if (root) return shipped(root, 'merge', { fixed: !!pr.fixed });
    recordShipped({ id, name: remote.split('/').pop(), remote }, 'merge', { fixed: !!pr.fixed });
  } catch (e) {
    log.error('sticker (merge)', e);
  }
}

function recordShipped(project, kind, meta) {
  const shell = wornShellObj();
  // Known by its folder until it got a remote: it keeps its sticker under the new id.
  let state = config.get('stickers');
  if (project.remote && project.root) state = stickers.rekey(state, stickers.projectId(null, project.root), project.id);
  const before = stickers.normalize(state).projects[project.id] || null;
  const r = stickers.recordShip(state, project, kind, Date.now(), meta,
    { shell: shellIdOf(shell), slots: shellSpots(activeSkin(), shell).slots.length });
  workflows?.event('shipped', { kind: kind === 'ship' ? 'push' : kind, project: project.name || '', version: meta?.version || null });
  if (!r.project) return;
  config.set({ stickers: r.state });
  noteWeek(kind, r.project);
  if (r.minted) noteWeek('minted', r.project);
  if (r.minted) slapSticker(r.project);
  else stickerNews(r, before);
  send(panel, 'stickers', stickersView());
  // A trophy this earns waits for the slap to land, so the two don't talk over each other.
  setTimeout(() => stickerStats(config.get('stickers')), r.minted ? SLAP_MS + 900 : 0);
}

// A brand-new sticker: he holds it up, turns his shell to you and slaps it on.
function slapSticker(p) {
  const d = drawSticker(p);
  const placed = shellStickers(activeSkin(), wornShellObj()).find(s => s.id === p.id);
  flashState('stickered', SLAP_MS + 600);
  sayText(`shipped ${p.name}!`, 'sticker', SLAP_MS + 1200);
  send(critter, 'critter:sticker', { id: p.id, small: d.small, at: placed ? { x: placed.x, y: placed.y } : null });
  broadcastSkin(); // already includes it; the critter keeps it off until the slap lands
  const view = stickersView().projects.find(x => x.id === p.id);
  if (view) send(panel, 'stickers:new', view);
  if (!(panel?.isVisible() && panel.isFocused())) {
    notify(`New sticker: ${p.name}`, placed ? 'You shipped it, so Shellby slapped its sticker on his shell.' : 'You shipped it. Its sticker is in the Sticker Book.',
      () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'stickers'); }, { tone: 'celebrate' });
  }
}

// One he already had got better: a tier, a mark, or pressed back down after peeling.
function stickerNews(r, before) {
  const p = r.project;
  const pressed = before && stickers.weathering(before, Date.now()) !== 'fresh';
  if (!r.tierUp && !r.newMarks.length && !pressed) return;
  broadcastSkin();
  setTimeout(() => send(critter, 'critter:sticker-glint', { id: p.id }), 120);
  const marks = stickers.MARKS.filter(m => r.newMarks.includes(m.id));
  const line = r.tierUp ? `${p.name} went ${r.tierUp.name.toLowerCase()}!` : pressed ? `${p.name}, good as new` : `${marks[0].icon} ${p.name}`;
  sayText(line, 'sticker', 6000);
  send(panel, 'stickers:news', { id: p.id, name: p.name, tier: r.tierUp && { id: r.tierUp.id, name: r.tierUp.name }, marks: marks.map(m => ({ id: m.id, name: m.name, icon: m.icon })), pressed });
}

// ================================================================ usage limits

// When your plan's limit is reached Shellby naps until it resets, then wakes
// up and taps you (see limits.js).
let limitTimer = null;
const limitWait = () => (limits.status(config?.get('limitWait'), Date.now()) === 'waiting' ? limits.normalize(config.get('limitWait')) : null);
const clockTime = t => new Date(t).toLocaleString([], { weekday: new Date(t).toDateString() === new Date().toDateString() ? undefined : 'short', hour: 'numeric', minute: '2-digit' });

function onUsage(u) {
  const hit = limits.limitFrom(u, Date.now());
  const saved = limits.normalize(config.get('limitWait'));
  if (hit) {
    if (saved?.resetsAt === hit.resetsAt) return;
    config.set({ limitWait: hit });
    scheduleLimit();
    refreshCritter();
    const name = limits.windowName(hit.window);
    send(panel, 'limit', { phase: 'hit', ...hit, name, at: clockTime(hit.resetsAt) });
    notify(`Your ${name} Claude limit is reached`, `Shellby will nap and tap you when it resets, ${clockTime(hit.resetsAt)}.`, () => showPanel({ focusInput: false }));
  } else if (saved && limits.cleared(u)) {
    config.set({ limitWait: null }); // lifted early (e.g. extra usage)
    scheduleLimit();
    refreshCritter();
  }
}

// ---- who used it (spend.js): the meters' breakdown by tab, routine and project

let spendLedger = null;
let spendSaveTimer = null;

function spendSource(tab) {
  const dir = tab.worktree?.originalCwd || tab.session?.cwd || '';
  const full = dir ? path.resolve(dir) : null;
  const pk = full?.toLowerCase() || null;
  const project = !full ? null : pk === path.resolve(os.homedir()).toLowerCase() ? 'Home folder' : path.basename(full);
  if (tab.routineId) {
    // A routine renamed or deleted mid-run still counts as that routine.
    const routine = routines().find(r => r.id === tab.routineId);
    return { key: `r:${tab.routineId}`, kind: 'routine', label: routine?.name || tab.title.replace(/^⟳\s*/, ''), project, pk };
  }
  if (tab.workflowRunId) {
    // Counted per workflow, not per run, so an hourly one is one line on the meter.
    const name = tab.title.replace(/^⚡\s*/, '');
    return { key: `w:${name.toLowerCase()}`, kind: 'workflow', label: name, project, pk };
  }
  return { key: `t:${tab.id}`, kind: 'tab', label: tab.title, project, pk };
}

function onSpend(s, tab) {
  spendLedger ??= spend.normalize(config.get('spendLedger'));
  spendLedger = spend.record(spendLedger, spendSource(tab), s.weight, Date.now());
  // Calls come in bursts; one write when they settle is plenty.
  if (!spendSaveTimer) spendSaveTimer = setTimeout(saveSpend, 5000);
}

function saveSpend() {
  clearTimeout(spendSaveTimer);
  spendSaveTimer = null;
  if (spendLedger) config.set({ spendLedger });
}

// Settings as the panel sees them: the ledger stays in main (usageBreakdown).
function panelSettings() {
  const { spendLedger: _ledger, cacheDays: _c, setupWeights: _s, leanUsed: _u, pluginCosts: _p, mcpSeen: _m, pluginEnabledAt: _e, ...rest } = config.data;
  return { ...rest, crashReportsAvailable: !!sentry }; // no DSN in this build: the Settings row stays hidden
}

function usageBreakdown() {
  spendLedger ??= spend.normalize(config.get('spendLedger'));
  const u = config.get('lastUsage') || {};
  const now = Date.now();
  return Object.keys(spend.WINDOW_MS).map(window => {
    const resetsAt = u[window]?.resetsAt;
    const since = spend.windowStart(window, resetsAt, now);
    // A reading from before the last reset says nothing about this window.
    const current = Number.isFinite(resetsAt) && resetsAt > now;
    return {
      window, name: limits.windowName(window), pct: current ? u[window].pct ?? null : null,
      tasks: spend.breakdown(spendLedger, since, 'task'),
      projects: spend.breakdown(spendLedger, since, 'project'),
    };
  });
}

function scheduleLimit() {
  clearTimeout(limitTimer);
  const w = limitWait();
  if (w) limitTimer = setTimeout(checkLimit, Math.min(w.resetsAt - Date.now() + 1500, 2 ** 31 - 1));
}

// Runs at the reset time, after the PC wakes up, and at startup.
function checkLimit() {
  const raw = config.get('limitWait');
  const st = limits.status(raw, Date.now());
  if (st === 'waiting') return scheduleLimit();
  config.set({ limitWait: null });
  refreshCritter();
  sendOutlook();
  if (st !== 'reset') return;
  const name = limits.windowName(limits.normalize(raw).window);
  lastActivity = Date.now();
  flashState('refreshed', 6500);
  tellChannel({ kind: 'limit' });
  send(panel, 'limit', { phase: 'reset', name });
  notify(`Your ${name} Claude limit just reset`, "Shellby's awake and ready. Anything you queued can go now.", () => showPanel());
}

// ---- the forecast (forecast.js), and what's held for after the reset (held.js)

// Dev/e2e only: 5-hour readings from dev:usage, backdated so a pace builds up
// without an hour's wait, and held work going a second after the reset.
const FORECAST_TEST = !app.isPackaged && process.env.SHELLBY_FORECAST_TEST === '1';
// Held work goes a minute after the reset, so the server has rolled over too.
const HELD_GRACE_MS = FORECAST_TEST ? 1000 : 60 * 1000;
const HELD_STAGGER_MS = 5000;          // one after another, not all at once
const HELD_BUSY_RETRY_MS = 60 * 1000;  // its conversation is still working: try again shortly
const HELD_SETTLE_MS = 45 * 1000;      // how long to wait for word on the window between held messages
const QUEUE_WATCH_MS = 20 * 1000;      // how often a running queued task is checked on, in case its end goes unheard
const OUTLOOK_TICK_MS = 60 * 1000;     // a forecast goes stale with no new readings
let heldTimer = null;
let releasing = false;
let lastOutlook = '';
let keepAwakeId = null;

const heldList = () => held.normalize(config.get('held'), Date.now());
const sameReset = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 10 * 60 * 1000;

function saveHeld(list) {
  config.set({ held: list });
  scheduleHeld();
  syncKeepAwake();
  sendOutlook();
  send(panel, 'routines', routinesView()); // routines show their own "after the reset"
}

// Queued tasks are mostly for overnight, and a PC that falls asleep at 1am
// runs nothing at 3. While one waits or runs, Windows is asked not to sleep
// when idle (the screen still turns off). A lid shut or Sleep chosen still
// wins: the queue then goes when the PC wakes (powerMonitor 'resume').
function syncKeepAwake() {
  if (!config || CAPTURE) return;
  const want = config.get('queueKeepAwake') !== false && (queueWaits.size > 0 || heldList().some(h => h.kind === 'task'));
  if (want && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
    log.info('Keeping the PC awake for the reset queue');
  } else if (!want && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
    log.info('Reset queue empty: the PC may sleep again');
  }
}

// When "after the reset" is: the limit you're held at, else the 5-hour window's
// next reset as last reported. null until Claude Code has said.
function resetTarget(now = Date.now()) {
  const w = limitWait();
  if (w) return w.resetsAt;
  const r = config.get('lastUsage')?.fiveHour?.resetsAt;
  return Number.isFinite(r) && r > now ? r : null;
}

// Everything the panel shows about where the window's heading and what's waiting on it.
function outlookView() {
  const now = Date.now();
  const o = forecast.outlook(recapLog, now);
  const w = limitWait();
  const resetAt = resetTarget(now);
  const warn = !!o?.warn && config.get('forecast') !== false && !w;
  return {
    pace: o ? { pct: o.pct, perHour: o.perHour, hitAt: o.hitAt, hitText: clockTime(o.hitAt), resetsAt: o.resetsAt, warn } : null,
    warning: warn ? { text: forecast.message(o, now, clockTime), resetsAt: o.resetsAt } : null,
    limit: w ? { window: w.window, name: limits.windowName(w.window), resetsAt: w.resetsAt, at: clockTime(w.resetsAt) } : null,
    resetAt, resetText: resetAt ? clockTime(resetAt) : null,
    held: heldList().map(heldView),
    keepAwake: config.get('queueKeepAwake') !== false,
  };
}

function heldView(h) {
  const base = { id: h.id, kind: h.kind, at: h.at, atText: clockTime(h.at) };
  if (h.kind === 'message') return { ...base, tabId: h.tabId, text: h.text, attachments: h.attachments };
  if (h.kind === 'routine') return { ...base, routineId: h.routineId, name: h.name };
  return {
    ...base, name: h.name, prompt: h.prompt, cwd: h.cwd, folder: h.cwd ? path.basename(h.cwd) : null, mode: h.mode,
    tabId: h.tabId, running: !!h.tabId && queueWaits.has(h.tabId),
    // Started before and still here: it ran dry partway (or Shellby restarted), and carries on.
    resuming: !!h.tabId && !queueWaits.has(h.tabId),
  };
}

function sendOutlook() {
  if (!config) return;
  const view = outlookView();
  lastOutlook = JSON.stringify(view);
  send(panel, 'outlook', view);
}

// A new reading: show the forecast, and the first time a window's pace says
// it'll run out before the reset, say so (once per window).
function refreshOutlook() {
  sendOutlook();
  if (config.get('forecast') === false || limitWait()) return;
  const now = Date.now();
  const o = forecast.outlook(recapLog, now);
  if (!o?.warn || sameReset(config.get('forecastWarned'), o.resetsAt)) return;
  config.set({ forecastWarned: o.resetsAt });
  log.info('Usage forecast', `${o.pct}% at ${o.perHour}%/h: full ~${new Date(o.hitAt).toISOString()}, resets ${new Date(o.resetsAt).toISOString()}`);
  sayText(`At this pace we run dry around ${clockTime(o.hitAt)}.`, 'forecast');
  if (panel?.isVisible() && panel.isFocused()) return; // the panel's banner says it
  notify('Heading for your 5-hour limit', `${forecast.message(o, now, clockTime)} You can hold work for after the reset.`, () => showPanel());
}

// The forecast lapses when readings stop, and the reset passes: keep the panel current.
function watchOutlook() {
  setInterval(() => {
    if (!config || !panel || panel.isDestroyed()) return;
    const view = outlookView();
    const json = JSON.stringify(view);
    if (json !== lastOutlook) { lastOutlook = json; send(panel, 'outlook', view); }
  }, OUTLOOK_TICK_MS).unref?.();
}

/** Hold a message or a routine run for after the reset. raw: { kind, ... } from held.js. */
function holdForReset(raw) {
  const at = resetTarget();
  // A window seen before and since run out: you're on a fresh one already.
  if (!at && raw.kind === 'task' && config.get('lastUsage')?.fiveHour) return { ok: false, idle: true, error: "There's no 5-hour window running to wait for, so it would just start now. Run it as a normal task instead." };
  if (!at) return { ok: false, error: "Shellby doesn't know when your window resets yet. He finds out with your next message." };
  const res = held.hold(heldList(), { ...raw, at: at + HELD_GRACE_MS }, Date.now());
  if (res.error) return { ok: false, error: res.error };
  const added = res.list.length > heldList().length;
  if (added) saveHeld(res.list);
  return { ok: true, id: res.item.id, at: res.item.at, atText: clockTime(res.item.at), added };
}

/**
 * "Run it when my limit resets": a task from the Routines page's queue.
 * input: { prompt, cwd?, mode? }. Autonomous is only allowed once you've
 * acknowledged it, and asked about each time: it runs while you sleep.
 */
async function queueTask(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'Say what Shellby should do.' };
  if (prompt.length > 50000) return { ok: false, error: 'That task is too long to queue (50,000 characters at most).' };
  const cwd = isStr(input.cwd) ? input.cwd : currentCwd();
  if (!isFolder(cwd)) return { ok: false, error: "That folder doesn't exist any more." };
  const mode = held.TASK_MODES.includes(input.mode) ? input.mode : null;
  if (mode === 'autonomous') {
    if (!config.get('autonomousAcknowledged')) return { ok: false, error: 'Turn on Autonomous in Settings first.' };
    const response = await confirm.ask(panel, {
      ...dialogLook(), icon: '🌙', danger: true,
      title: 'Queue an Autonomous task?',
      message: "It runs after your usage resets, likely while you're away, and won't ask before it acts.",
      detail: `Folder: ${cwd}\n\n${prompt}`,
      note: 'You can cancel it from the queue on the Routines page until it starts.',
      buttons: [{ label: 'Queue it', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return { ok: false, cancelled: true };
  }
  const res = holdForReset({ kind: 'task', prompt, cwd, mode });
  if (res.ok) log.info('Task queued for the reset', `${held.taskName(prompt)} at ${res.atText}`);
  return res;
}

function scheduleHeld() {
  clearTimeout(heldTimer);
  const at = held.next(heldList());
  if (at === null) return;
  heldTimer = setTimeout(() => releaseHeld().catch(err => log.warn('Held release failed', err.message)), Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
}

// After a held message goes, wait to hear how the window looks (a usage
// reading, or the limit) before the next: if the reset wasn't the one that
// mattered (the weekly window is full too), the rest mustn't all go and fail.
async function heardSince(t) {
  for (let waited = 0; waited < HELD_SETTLE_MS; waited += 500) {
    if (!config || limitWait() || (config.get('lastUsage')?.at || 0) > t) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

// Due: send what's held, one at a time. Still limited (a reset later than
// expected, or the weekly window): wait for that reset instead.
async function releaseHeld() {
  if (releasing || !config) return;
  const ready = held.due(heldList(), Date.now());
  if (!ready.length) return scheduleHeld();
  const w = limitWait();
  if (w) return saveHeld(held.defer(heldList(), ready.map(h => h.id), w.resetsAt + HELD_GRACE_MS));
  releasing = true;
  const went = [];
  try {
    for (const [i, h] of ready.entries()) {
      if (i) {
        if (went.length && went[went.length - 1].kind === 'message') await heardSince(went[went.length - 1].sentAt);
        await new Promise(r => setTimeout(r, HELD_STAGGER_MS));
      }
      if (!config) return; // quitting
      if (!heldList().some(x => x.id === h.id)) continue; // cancelled in the meantime
      if (limitWait()) break; // limited again: the next pass moves the rest to that reset
      let outcome;
      try {
        // A task is waited on until it finishes, so heavy ones go one at a
        // time and whatever the window can't fit waits for the next reset.
        outcome = h.kind === 'routine' ? releaseRoutine(h) : h.kind === 'task' ? await releaseTask(h) : releaseMessage(h);
      } catch (err) {
        // Dropped rather than left due: a failure that repeats would retry forever.
        log.warn('Held item failed', err.message);
        outcome = 'failed';
      }
      if (!config) return; // quit while a task ran: it carries on next time
      const list = heldList();
      // 'resume': a task that ran dry partway stays queued, and carries on in its conversation.
      if (outcome !== 'resume') config.set({ held: outcome === 'retry' ? held.defer(list, [h.id], Date.now() + HELD_BUSY_RETRY_MS) : held.without(list, h.id) });
      sendOutlook(); // its chip goes now, not when the whole batch is done
      if (outcome === 'sent') went.push({ ...h, sentAt: Date.now() });
    }
  } finally {
    releasing = false;
    if (config) saveHeld(heldList());
  }
  if (!went.length) return;
  const what = held.summary(went);
  log.info('Held work released', what);
  if (!went.some(h => h.kind === 'task')) return notify('Your usage window reset', `Shellby sent ${what}.`, () => showPanel());
  const left = heldList().filter(h => h.kind === 'task').length;
  notify(left ? 'Shellby got through part of your queue' : 'Your reset queue is done',
    `Shellby got through ${what}.${left ? ` ${left} more wait${left === 1 ? 's' : ''} for the next reset.` : ''}`, () => showPanel());
}

// The first message of a task that was started before and is still queued:
// the window ran dry partway, or Shellby closed while it worked.
const QUEUE_CARRY_ON = 'This task was cut off partway through (the usage limit ran out, or Shellby was closed), and your usage window has reset since. Carry on from where you stopped and finish it. If it was already finished, say so briefly and recap what you did.';

/**
 * One queued task: started (or carried on in its conversation), then waited
 * on until it ends, and the result sent to your phone. -> 'sent' | 'failed'
 * | 'retry' (its conversation is busy with you) | 'resume' (ran dry partway:
 * stays queued for the next reset).
 */
async function releaseTask(h) {
  const left = () => heldList().filter(x => x.kind === 'task' && x.id !== h.id).length;
  const project = h.cwd ? path.basename(h.cwd) : '';
  const tell = (status, extra = {}) => tellChannel({ kind: 'queue', status, title: h.name, project, left: left(), ...extra });
  const fail = why => {
    log.warn('Queued task failed', `${h.name}: ${why}`);
    notify(`Queued task didn't run: ${h.name}`, why, () => showPanel({ focusInput: false }), { tone: 'problem' });
    tell('error', { body: why });
    return 'failed';
  };
  if (config.get('crabOnly') || !claudeStatus?.installed || !claudeStatus?.loggedIn) return fail('Claude Code isn\'t set up and signed in, so it couldn\'t start. Queue it again once it is.');
  if (held.spent(h)) return fail(`It was cut off ${held.MAX_TRIES} times, so Shellby stopped retrying. Its conversation is in History.`);

  const open = h.tabId ? manager.tabs.get(h.tabId) : null;
  if (open && manager.isBusy(h.tabId)) return 'retry'; // you're working in it right now
  const carryOn = !!h.tabId && !!(open || history.get(h.tabId));
  const tabId = carryOn ? h.tabId : randomUUID();
  const title = `🌙 ${h.name}`;
  const prompt = carryOn ? QUEUE_CARRY_ON : h.prompt;
  let turnId;
  try {
    if (!open) {
      makeRoomForRoutine();
      openTab(carryOn ? { tabId, historyEntry: history.get(tabId) }
        : { tabId, cwd: h.cwd && isFolder(h.cwd) ? h.cwd : currentCwd(), mode: h.mode, title });
    }
    turnId = manager.send(tabId, prompt, { kind: 'user', text: prompt, title, queued: { id: h.id, name: h.name } });
    queueTabs.set(tabId, h.id);
    // Saved as soon as it starts: if Shellby closes mid-task, the next pass carries on here.
    config.set({ held: held.started(heldList(), h.id, tabId) });
  } catch (err) {
    return fail(err.message);
  }
  const ended = waitForQueued(tabId);
  syncKeepAwake();
  sendOutlook();
  wake();
  if (open) send(panel, 'tab:sent', { tabId, item: { kind: 'user', text: prompt, attachments: [], turnId } });
  else send(panel, 'tab:opened', { tabId, entry: history.get(tabId), items: history.load(tabId), background: true, busy: true });
  log.info('Queued task started', `${h.name}${carryOn ? ' (carrying on)' : ''}`);

  const end = await ended;
  syncKeepAwake();
  if (!config) return 'resume';
  // The limit arrives as a usage reading, separately from the result: an
  // error might be the window running dry before that reading is in.
  if (!end.ok && !end.interrupted && !limitWait()) await heardSince(Date.now());
  if (!config) return 'resume';
  // Limited now: it most likely ran dry partway. It stays queued and carries
  // on after this reset; if it had in fact finished, the next turn says so.
  const w = limitWait();
  if (w && !end.interrupted) {
    tell('paused', { resumeAt: w.resetsAt + HELD_GRACE_MS, seconds: end.seconds });
    return 'resume';
  }
  const status = end.ok ? 'ok' : end.interrupted ? 'stopped' : 'error';
  tell(status, { body: end.ok ? end.reply : end.closed ? 'Its tab was closed.' : end.error, seconds: end.seconds });
  return end.ok ? 'sent' : 'failed';
}

// How a queued task's turn ended: onResult answers, closing its tab answers,
// and if neither is heard (its process died quietly), finding it idle twice does.
function waitForQueued(tabId) {
  return new Promise(resolve => {
    let idle = 0;
    const watch = setInterval(() => {
      const gone = !manager?.tabs.has(tabId);
      idle = !gone && !manager.isBusy(tabId) ? idle + 1 : 0;
      if (gone || idle >= 2) finish({ ok: false, interrupted: gone, closed: gone, error: gone ? null : 'It stopped without saying how it went.' });
    }, QUEUE_WATCH_MS);
    watch.unref?.();
    function finish(end) {
      clearInterval(watch);
      if (queueWaits.get(tabId) === finish) queueWaits.delete(tabId);
      resolve(end);
    }
    queueWaits.set(tabId, finish);
  });
}

function releaseRoutine(h) {
  const r = routines().find(x => x.id === h.routineId);
  if (!r) return 'dropped'; // deleted while it waited
  // Held only because it came due at the limit, then paused: it stays paused.
  if (h.auto && !r.enabled) return 'dropped';
  const res = runRoutine(r, { reason: 'after-reset' });
  if (res.ok) return 'sent';
  if (res.skipped) notify(`Routine "${r.name}" didn't run`, res.error);
  return 'failed';
}

// Back to its conversation, reopened from History if it was closed. If it
// can't go, it lands back in that conversation's box rather than vanishing.
function releaseMessage(h) {
  const open = manager.tabs.get(h.tabId);
  if (open?.session.busy) return 'retry';
  if (!open) {
    try {
      reopenForHeld(h);
    } catch (err) {
      notify("A held message couldn't be sent", `${err.message} It was: ${h.text.slice(0, 140)}`);
      return 'failed';
    }
  }
  const r = sendToTab(h.tabId, h.text, h.attachments);
  if (!open) {
    send(panel, 'tab:opened', {
      tabId: h.tabId, entry: history.get(h.tabId), items: history.load(h.tabId), background: true, busy: r.ok,
      ...(r.ok ? {} : { draft: h.text, attachments: h.attachments }),
    });
  } else if (r.ok) send(panel, 'tab:sent', { tabId: h.tabId, item: r.item });
  else send(panel, 'held:returned', { tabId: h.tabId, text: h.text, attachments: h.attachments, error: r.error });
  if (!r.ok) notify("A held message couldn't be sent", `${r.error} It's back in its conversation's box.`, () => showPanel());
  return r.ok ? 'sent' : 'failed';
}

// The conversation a held message belongs to, open again under its own id:
// from History, or (never sent anything yet) as a fresh tab in its folder.
function reopenForHeld(h) {
  const entry = history.get(h.tabId);
  makeRoomForRoutine();
  return openTab(entry
    ? { tabId: h.tabId, historyEntry: entry }
    : { tabId: h.tabId, cwd: h.cwd && isFolder(h.cwd) ? h.cwd : currentCwd(), title: h.title });
}

// A scheduled routine that comes due while you're at your limit would only
// fail, and one past the spending guard's ceiling would eat the share you kept
// for yourself: either way it waits for the reset, and says so the first time.
function runOrHoldRoutine(r, reason) {
  const w = limitWait();
  const usage = config.get('lastUsage');
  const saving = !w && guard.holdBeforeStart(guardSettings(), usage, Date.now());
  if (!w && !saving) return runRoutine(r, { reason });
  const res = holdForReset({ kind: 'routine', routineId: r.id, name: r.name, auto: true });
  if (!res.ok) return { ok: false, skipped: true, error: res.error };
  if (res.added) {
    log.info('Routine held for the reset', `${r.name}${saving ? ' (spending guard)' : ''}`);
    const why = w ? `You're at your ${limits.windowName(w.window)} limit.`
      : `Your 5-hour window is at ${usage.fiveHour.pct}%, and you asked to keep ${guardSettings().reserve}% for yourself.`;
    notify(`Routine "${r.name}" will run after the reset`, `${why} It runs at ${res.atText}.`, () => showPanel({ focusInput: false }));
  }
  return { ok: true, held: true };
}

// ---- the spending guard (guard.js): unattended runs stop before they eat
// the share of the 5-hour window you keep for yourself, and a routine that
// runs far too long stops too.
const GUARD_TICK_MS = 30 * 1000;
const guardSettings = () => guard.settingsOf(k => config.get(k));

// Each turn as it starts: what kind of unattended run it is, by who sent it
// (sessions.js turnFrom). What you type yourself, even in a routine's or a
// workflow's tab, is yours. A run you started by hand (Run now, a manual
// workflow run) is never stopped on the ceiling: only a routine's time cap
// still applies to it.
// A task queued for the reset counts as yours: you queued it to spend that
// window, overnight, in whatever mode you picked, so the ceiling and the
// "you've walked away" rule don't stop it (the limit itself still does).
function armGuard(tab) {
  const { routine, workflow, queued } = tab.turnFrom || {};
  const kind = routine ? 'routine' : workflow ? 'workflow' : null;
  const byHand = queued ? true : routine ? routine.reason === 'manual' : !!workflow && workflows?.originOf(workflow.runId) === 'manual';
  tab.guardRun = { kind, startedAt: Date.now(), exempt: byHand, stopped: null };
}

function idleForGuard() {
  try {
    return powerMonitor.getSystemIdleState(60) === 'locked' ? Infinity : powerMonitor.getSystemIdleTime() * 1000;
  } catch { return 0; }
}

// On each usage reading and every half minute: stop any run the guard says
// should stop. Autonomous is read off the tab now, not when the turn started,
// so switching into it mid-turn counts.
function checkGuards() {
  if (!manager || !config) return;
  const settings = guardSettings();
  if (!settings.on) return;
  const now = Date.now();
  const usage = config.get('lastUsage');
  let idleMs = null;
  for (const [tabId, tab] of manager.tabs) {
    const run = tab.guardRun;
    if (!run || run.stopped || !manager.isBusy(tabId)) continue;
    const kind = run.kind || (tab.session.mode === 'autonomous' ? 'autonomous' : null);
    if (!kind) continue;
    if (kind === 'autonomous' && idleMs === null) idleMs = idleForGuard();
    const v = guard.verdict({ ...run, kind }, settings, { usage, now, idleMs: idleMs ?? 0 });
    if (!v) continue;
    run.stopped = v;
    log.info('Spending guard stopped a run', `${tab.title}: ${v.reason}${v.pct ? ` at ${v.pct}%` : ''}`);
    manager.interrupt(tabId);
    const m = guard.message(v, tab.title, settings, clockTime);
    notify(m.title, m.body, () => showPanel({ tabId }), { tone: 'problem' });
  }
}

function watchGuards() {
  setInterval(checkGuards, GUARD_TICK_MS).unref?.();
}

// ================================================================ routines

function routines() { return Array.isArray(config.get('routines')) ? config.get('routines') : []; }

function routinesView() {
  const now = Date.now();
  return routines().map(r => ({
    ...r, next: nextRun(r, now), scheduleText: describeSchedule(r.schedule),
    running: [...routineTabs.entries()].some(([tabId, id]) => id === r.id && manager.isBusy(tabId)),
    held: heldFor(r.id),
  }));
}

// A run of this routine waiting for the usage reset: { id, at, atText } or null.
function heldFor(routineId) {
  const h = heldList().find(x => x.kind === 'routine' && x.routineId === routineId);
  return h ? { id: h.id, at: h.at, atText: clockTime(h.at) } : null;
}

function saveRoutines(list) {
  config.set({ routines: list });
  send(panel, 'routines', routinesView());
}

function updateRoutine(id, patch) {
  saveRoutines(routines().map(r => (r.id === id ? { ...r, ...patch } : r)));
}

// An hourly routine opens a tab every run; left alone they'd fill every slot
// overnight and the next run (and any tab of yours) couldn't open. At the cap,
// the oldest finished routine tab closes. History keeps its transcript.
function makeRoomForRoutine() {
  if (manager.tabs.size < MAX_TABS) return;
  // A queue tab still on the list (it ran dry, and carries on later) is kept.
  const pending = new Set(heldList().map(h => h.tabId).filter(Boolean));
  const done = [...routineTabs.keys(), ...queueTabs.keys()].find(id => manager.tabs.has(id) && !manager.isBusy(id) && !pending.has(id));
  if (!done) return;
  manager.close(done);
  routineTabs.delete(done);
  queueTabs.delete(done);
  remote?.settleTab(done);
}

// A routine's MCP servers -> what its conversation starts with: rules that let
// Claude use them unasked, and with "only these", just their definitions.
// Throws (runRoutine reports it) when one can't be loaded on its own.
function routineTools(r, cwd) {
  if (!r.mcp?.length) return {};
  let mcpConfig = null;
  if (r.mcpOnly) {
    const res = mcpServers.configFor(r.mcp, { home: os.homedir(), cwd });
    if (!res.ok) throw new Error(res.error);
    mcpConfig = res.config;
  }
  return { allowedTools: mcpServers.allowRules(r.mcp), mcpConfig };
}

function runRoutine(r, { reason = 'scheduled' } = {}) {
  const busyTab = [...routineTabs.entries()].find(([tabId, id]) => id === r.id && manager.isBusy(tabId));
  if (busyTab) return { ok: false, skipped: true, error: `"${r.name}" is still running from last time.` };
  if (!claudeStatus?.loggedIn) return { ok: false, skipped: true, error: 'Claude Code is not signed in.' };
  try {
    makeRoomForRoutine();
    const tabId = randomUUID();
    const cwd = r.cwd && fs.existsSync(r.cwd) ? r.cwd : currentCwd();
    openTab({ tabId, cwd, mode: r.mode, routineId: r.id, title: `⟳ ${r.name}`, ...routineTools(r, cwd) });
    routineTabs.set(tabId, r.id);
    const userItem = { kind: 'user', text: r.prompt, title: `⟳ ${r.name}`, routine: { id: r.id, name: r.name, reason } };
    manager.send(tabId, r.prompt, userItem);
    updateRoutine(r.id, { lastRunAt: Date.now(), lastStatus: null });
    stat('routine-run');
    send(panel, 'tab:opened', { tabId, entry: history.get(tabId), items: history.load(tabId), background: true });
    return { ok: true, tabId };
  } catch (err) {
    notify(`Routine "${r.name}" couldn't start`, err.message, null, { tone: 'problem' });
    return { ok: false, error: err.message };
  }
}

const MAX_ROUTINES = 50;
const isFolder = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// One routine question at a time, so a chatty session can't stack dialogs, and
// a quiet spell after a no, so anything on the port can't keep asking.
const ROUTINE_COOLDOWN_MS = 30 * 1000;
let routineAsking = false;
let routineDeclinedAt = 0;

/**
 * An `add_routine` from Claude (MCP). A routine spends the user's subscription
 * on a schedule, and anything on this PC can reach the port it came in on, so
 * it is only saved once the user says yes in the isolated confirm window. A
 * routine with the same name is changed in place, keeping its history and
 * whether it's paused.
 */
async function proposeRoutine(routine) {
  if (routineAsking) return { ok: false, error: 'Shellby is already asking the user about a routine. Wait for that answer first.', status: 409 };
  if (Date.now() - routineDeclinedAt < ROUTINE_COOLDOWN_MS) return { ok: false, error: 'The user just turned down a routine. Talk it over with them before proposing another.', status: 429 };
  if (routine.cwd && !isFolder(routine.cwd)) return { ok: false, error: `That folder doesn't exist: ${routine.cwd}`, status: 400 };
  const replacing = routines().find(r => sameName(r.name, routine.name)) || null;
  if (!replacing && routines().length >= MAX_ROUTINES) return { ok: false, error: `The user already has ${MAX_ROUTINES} routines, which is the limit.`, status: 400 };

  routineAsking = true;
  let response;
  try {
    wake();
    response = await confirm.ask(panel, {
      ...dialogLook(), icon: '⟳',
      ...crabtools.routineQuestion(routine, { replacing, defaultFolder: currentCwd() }),
      buttons: [{ label: replacing ? 'Change it' : 'Add routine', style: 'primary' }, { label: 'No thanks' }], defaultId: 0, cancelId: 1,
    });
  } finally { routineAsking = false; }
  if (response !== 0) {
    routineDeclinedAt = Date.now();
    return { text: crabtools.routineReply(routine, { added: false, replaced: !!replacing }) };
  }

  // The list may have changed while the dialog was up. The yes was to adding,
  // or to changing one particular routine: anything else needs asking again.
  const current = routines().find(r => sameName(r.name, routine.name));
  if ((current?.id || null) !== (replacing?.id || null)) {
    return { ok: false, error: "The user's routines changed while they were deciding, so nothing was saved. Check list_routines and try again.", status: 409 };
  }
  const saved = current
    ? { ...routine, id: current.id, createdAt: current.createdAt, lastRunAt: current.lastRunAt, lastStatus: current.lastStatus, enabled: current.enabled }
    : routine;
  if (!current && routines().length >= MAX_ROUTINES) return { ok: false, error: `The user already has ${MAX_ROUTINES} routines, which is the limit.`, status: 400 };
  saveRoutines(current ? routines().map(r => (r.id === current.id ? saved : r)) : [...routines(), saved]);
  sayText(current ? `Updated the "${saved.name}" routine.` : `New routine: ${saved.name}.`, 'mcp');
  return { text: crabtools.routineReply(saved, { added: true, replaced: !!current, next: nextRun(saved, Date.now()) }) };
}

/**
 * "Describe it" on the Routines page: Claude fills in the editor from a
 * sentence. Only a draft comes back; the user saves it from the editor, so no
 * confirm window is needed. One at a time, since each is a (small) Claude call.
 */
let routineDrafting = false;
async function draftRoutine(text) {
  if (config.get('crabOnly')) return { ok: false, error: 'Routines are off in just-the-crab mode.' };
  const checked = routineDraft.checkDescription(text);
  if (!checked.ok) return checked;
  if (routineDrafting) return { ok: false, error: 'Already drafting one. Give it a moment.' };
  routineDrafting = true;
  try {
    const res = await runClaudeOnce(routineDraft.draftArgs(checked.text, { home: os.homedir(), defaultFolder: currentCwd(), places: routinePlaces() }),
      routineDraft.DRAFT_TIMEOUT_MS);
    if (res.timedOut) return { ok: false, error: 'Claude took too long. Try again.' };
    if (!res.stdout.trim()) {
      log.warn('Routine draft failed', res.stderr.trim().split('\n').slice(-3).join(' ') || res.err?.message);
      return { ok: false, error: 'Claude Code didn\'t answer. Check it\'s signed in, in Settings.' };
    }
    return routineDraft.parseDraft(res.stdout, { folderOk: isFolder });
  } finally { routineDrafting = false; }
}

// Build it with Claude's test runs: tab id -> routine id. Kept apart from
// routineTabs, which forgets a tab once it closes, so a test is still read
// after you've closed its tab. Only the last few are remembered.
const routineTests = new Map();
const MAX_ROUTINE_TESTS = 20;

/**
 * Build it with Claude, one turn of the routine editor's chat. `runId` is the
 * test run that just finished: its transcript is read here, and only if it was
 * a test of this same saved routine. Nothing is saved or run here.
 */
async function chatRoutine({ routine, messages, runId } = {}) {
  if (config.get('crabOnly')) return { ok: false, error: 'Routines are off in just-the-crab mode.' };
  if (routineDrafting) return { ok: false, error: 'Claude is already working on one. Give it a moment.' };
  const saved = routine && typeof routine.id === 'string' ? routines().find(r => r.id === routine.id) : null;
  const run = runId && saved && routineTests.get(runId) === saved.id ? routineDraft.runBrief(history.load(runId)).text : '';
  routineDrafting = true;
  try {
    const res = await routineDraft.chat({ routine, messages, run }, routineClaudeDeps());
    if (res.stderr) log.warn('Routine chat failed', String(res.stderr).trim().split('\n').slice(-3).join(' '));
    const { stderr: _stderr, ...out } = res;
    return out;
  } finally { routineDrafting = false; }
}

const routineClaudeDeps = () => ({
  runClaude: runClaudeOnce, folderOk: isFolder, allowAutonomous: !!config.get('autonomousAcknowledged'),
  context: { home: os.homedir(), defaultFolder: currentCwd(), today: new Date().toDateString(), places: routinePlaces() },
});

// Where you work, so "my shellby repo" finds a real folder: recent conversations' folders first, then known projects.
function routinePlaces() {
  const home = path.resolve(os.homedir()).toLowerCase();
  const seen = new Set();
  const out = [];
  const add = (dir, name) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key) || key === home || !isFolder(dir)) return;
    seen.add(key);
    out.push({ name: name || path.basename(dir), path: dir });
  };
  for (const e of history.list().slice(0, 200)) if (e.cwd) add(e.cwd);
  for (const p of knownProjects()) add(p.key, p.name);
  return out.slice(0, 20);
}

/**
 * Fix with Claude, on a routine whose last run failed: Claude reads that run
 * (the newest History entry of this routine, a test run included) and the
 * corrected routine opens in the editor. Nothing is saved here.
 */
async function repairRoutine(id) {
  if (config.get('crabOnly')) return { ok: false, error: 'Routines are off in just-the-crab mode.' };
  const r = routines().find(x => x.id === id);
  if (!r) return { ok: false, error: 'That routine is gone.' };
  const runs = history.list().filter(e => e.routineId === id);
  const latest = runs.reduce((a, b) => (!a || (b.createdAt || 0) > (a.createdAt || 0) ? b : a), null);
  const items = latest ? history.load(latest.id) : [];
  if (!items.length) return { ok: false, error: 'Shellby no longer has that run\'s conversation, so there\'s nothing to go on. Run it again, then try.' };
  if (routineDrafting) return { ok: false, error: 'Claude is already working on one. Give it a moment.' };
  routineDrafting = true;
  try {
    const res = await routineDraft.repair({ routine: r, brief: routineDraft.runBrief(items).text }, routineClaudeDeps());
    if (res.stderr) log.warn('Routine fix failed', String(res.stderr).trim().split('\n').slice(-3).join(' '));
    const { stderr: _stderr, ...out } = res;
    return out;
  } finally { routineDrafting = false; }
}

// How a test run is going, in the shape the editor's chat follows (wf-chat.js).
function routineTestView(tabId) {
  const tab = manager.tabs.get(tabId);
  if (tab && manager.isBusy(tabId)) return { id: tabId, status: 'running', waiting: tab.session?.pending?.size ? { permission: true } : null };
  const { status, error } = routineDraft.runBrief(history.load(tabId));
  // No result: its tab was closed, or Claude Code quit partway (that tab is still open, and idle).
  if (status === 'unfinished') return tab ? { id: tabId, status: 'error', error: 'Claude Code stopped before it finished.' } : { id: tabId, status: 'interrupted' };
  return { id: tabId, status, error };
}

function testRoutine(id) {
  const r = routines().find(x => x.id === id);
  if (!r) return { ok: false, error: 'Save it first.' };
  const res = runRoutine(r, { reason: 'test' });
  if (!res.ok) return res;
  routineTests.set(res.tabId, r.id);
  while (routineTests.size > MAX_ROUTINE_TESTS) routineTests.delete(routineTests.keys().next().value);
  return { ok: true, runId: res.tabId };
}

function startScheduler() {
  scheduler = new Scheduler({ getRoutines: routines });
  scheduler.on('due', r => {
    // A start that fails outright (runRoutine catch) already said so; a skip
    // (signed out, last run still going) would otherwise vanish without a word.
    const res = runOrHoldRoutine(r, 'scheduled');
    if (!res.ok && res.skipped) {
      log.info('Routine skipped', `${r.name}: ${res.error}`);
      notify(`Routine "${r.name}" didn't run`, res.error, null, { tone: 'problem' });
    }
  });
  scheduler.start();
  // Catch up on slots missed while the PC was off, staggered so they don't stampede.
  const missed = routines().filter(r => missedOnStartup(r, Date.now()));
  missed.forEach((r, i) => setTimeout(() => runOrHoldRoutine(r, 'catch-up'), 8000 + i * 5000));
  // Anything held for a reset that came while Shellby was closed goes now.
  scheduleHeld();
  syncKeepAwake();
}

// ================================================================ settings side effects

function applyHotkey(accel, previous) {
  if (previous) { try { globalShortcut.unregister(previous); } catch { /* ignore */ } }
  if (!accel) return true;
  try { return globalShortcut.register(accel, onHotkey); } catch { return false; }
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
  parityIpc = parity.register({
    ipcMain, manager, history, config, confirm, dialog, clipboard, app,
    panel: () => panel, dialogLook, changeRef, setupWhere, setupView, currentCwd,
    toolbox: () => toolbox, lastInit: () => lastInit, stat,
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
    setupView, saveHook: req => confirmAndChangeHook(req, false), saveRule: req => parityIpc.changeRule(req),
    log: { warn: msg => log.warn('team pack', msg) },
  });
  // ---- history (ipc/history.js)
  registerHistoryIpc(ipcMain, {
    history, manager, openTab, log,
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
  registerRepoIpc(ipcMain, d);
  registerSettingsIpc(ipcMain, d);
  registerToolboxIpc(ipcMain, d);
  registerRoutinesIpc(ipcMain, d);
  registerGithubIpc(ipcMain, d);
  registerProgressIpc(ipcMain, d);
  registerSurroundingsIpc(ipcMain, d);
}

// ================================================================ boot

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  config = new Config(userData);
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
        () => { showPanel({ focusInput: false }); send(panel, 'panel:view', 'wardrobe'); }, { tone: 'celebrate' });
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
  // This PC's own XP count, so sync can add PCs together (xp.js).
  if (!CAPTURE && !config.get('xp')?.device) config.set({ xp: withDevice(config.get('xp'), randomUUID()) });
  awardXp('day');
  setInterval(() => { wardrobe.collectSeasonals(); broadcastWardrobe(); }, 60 * 60 * 1000);
  skins = loadSkins(userSkinsDir());

  // Renderers never need camera, mic, geolocation etc.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // ...nor do they get to find out they might (the check behind permissions.query).
  electronSession.defaultSession.setPermissionCheckHandler(() => false);

  // The README reel shows Shellby big: he's the star.
  if (CAPTURE && process.argv.includes('--reel')) config.set({ critterScale: 2 });
  createGitHub();
  createManager();
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
  // On, but not to anywhere you said yes to (a question still open when Shellby
  // quit, or a token Windows can no longer read back): ask now rather than
  // stay silently "on" and send nothing.
  confirmChannelPlace().catch(e => log.warn('channel confirm failed', e.message));
  createObs();
  createRgb();
  if (rgbSettings().enabled) ensureOpenRgb().catch(() => {}); // lighting on: start OpenRGB if it isn't running
  createWeather();
  createMedia();
  createLifeAndPlay();
  createTypingAlong();
  createMischief();
  createDictation();
  if (config.get('focus')) advanceFocus(); // picks up (or finishes) a session from before a restart
  if (config.get('limitWait')) checkLimit(); // a limit that reset while Shellby was closed
  // Timers don't run while the PC sleeps: catch up on wake.
  powerMonitor.on('resume', () => { if (config.get('limitWait')) checkLimit(); if (config.get('focus')) advanceFocus(); if (scheduler) scheduleHeld(); });
  watchOutlook();
  watchGuards();
  setTimeout(checkNudges, 60 * 1000);
  try { if (statusLine.upgradeStatusLine(claudeSettings())) console.log('[shellby] updated the Claude Code status line command'); } catch { /* leave it */ }
  setInterval(checkNudges, 60 * 60 * 1000);
  setTimeout(checkWrapUp, 2 * 60 * 1000);
  setInterval(checkWrapUp, 30 * 60 * 1000);
  if (!applyHotkey(config.get('hotkey'))) console.warn('[shellby] hotkey unavailable:', config.get('hotkey'));
  applyLoginItem(config.get('openAtLogin'));
  setupUpdates();
  checkStatus({ configured: claudePath() }).then(s => { claudeStatus = FAKE_CLI ? require('./capture').FAKE_STATUS : s; startScheduler(); });

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
  scheduler?.stop();
  if (config) saveSpend();
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
  clearTimeout(limitTimer);
  remote?.stop();
  dictation?.stop();
  if (PRIMARY && !CAPTURE) crashReport.endRun(LOG_DIR); // quit on purpose: nothing to report next time
});
// close() gives a process 3 s to finish on its own, which Shellby quitting never
// waits for: one mid-task would carry on editing with no window to show it.
// Workflows freeze first: a run cut off by quitting is resumable, not failed.
app.on('before-quit', () => {
  app.isQuitting = true;
  workflows?.shutdown();
  manager?.closeAll({ kill: true });
  // Quits that didn't come through quit() (Windows shutting down, say):
  // "Stop them" still holds. taskkill runs on its own, so Shellby exiting
  // can't cut it off halfway down the tree, and the servers are saved as gone.
  if (devServers?.view().settings.onQuit === 'stop') devServers.stopAll({ detached: true }).catch(() => {});
  devServers?.shutdown();
});
