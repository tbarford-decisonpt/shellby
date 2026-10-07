const { app, ipcMain: electronIpcMain, screen, session: electronSession, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { randomUUID } = crypto;

const { Config } = require('./config');
const { History } = require('./history');
const { checkStatus, setPlanOnly } = require('./claude-cli');
const { loadSkins } = require('./skins');
const { clampToDisplays } = require('./placement');
const { REGISTRY_URL, PROTOCOL, findDeepLink } = require('./registry');
const { withDevice } = require('./xp');
const rooms = require('./rooms');
const statusLine = require('./statusline');
const { Log } = require('./log');
const crashReport = require('./crash-report');
const attach = require('./attachments');
const { guardAllWebContents } = require('./web-guard');
const { wirePanel } = require('./wiring/panel');
const { wireServices } = require('./wiring/services');
const { wireCrewSlots } = require('./wiring/crew-slots');
const { wireStreaks } = require('./wiring/streaks');
const { wireSettings } = require('./wiring/settings');
const { wireWardrobe } = require('./wiring/wardrobe');
const { wireQuit } = require('./wiring/quit');
const { wireWindows } = require('./wiring/windows');
const { wireCritter } = require('./wiring/critter');
const { wireSessions } = require('./wiring/sessions');
const { wireProgress } = require('./wiring/progress');
const { wireBugdex } = require('./wiring/bugdex');
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
const { wireJournal } = require('./wiring/journal');
const { wireCrew } = require('./wiring/crew');
const { wireSurprises } = require('./wiring/surprises');
const { wireStartFrom } = require('./wiring/startfrom');
const { wireBacklog } = require('./wiring/backlog');
const { wireClaudeUpdates } = require('./wiring/claude-updates');
const { registerIpc } = require('./ipc');

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
// What main shares with the modules in ipc/ and wiring/. Functions declared
// here are hoisted, so they go as they are; everything else is a getter, read when it's used: most of it is set at
// boot or changes as he runs, and some is only declared further down. A setter
// is there only where a module changes it. wiring/ reaches the services whole
// (d.usageService.limitWait()); the flat names are what ipc/ reads.
const shared = {
  every, isFolder, isStr, rememberPrompt, send,
  get recapLog() { return shared.awayService.recapLog; }, set recapLog(v) { shared.awayService.recapLog = v; },
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
  get adoptPhoneTab() { return adoptPhoneTab; },
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
  get backlogView() { return backlogView; },
  get backlogEdit() { return backlogEdit; },
  get backlogAddIssue() { return backlogAddIssue; },
  get backlogDo() { return backlogDo; },
  get backlogOpenDoing() { return backlogOpenDoing; },
  get backlogOpenTodo() { return backlogOpenTodo; },
  get backlogOpenIssue() { return backlogOpenIssue; },
  get backlogHide() { return backlogHide; },
  get backlogTabInfo() { return backlogTabInfo; },
  get backlogOpenPr() { return backlogOpenPr; },
  get backlogTick() { return backlogTick; },
  get backlogCommit() { return backlogCommit; },
  get backlogHand() { return backlogHand; },
  get backlogHome() { return backlogHome; },
  get backlogMerged() { return backlogMerged; },
  get backlogTabClosed() { return backlogTabClosed; },
  get backlogRepoTasks() { return backlogRepoTasks; },
  get backlogForTerminal() { return backlogForTerminal; },
  get beachSeen() { return beachSeen; },
  get beachView() { return beachView; },
  get booted() { return booted; },
  get broadcastSkin() { return broadcastSkin; },
  get broadcastWardrobe() { return broadcastWardrobe; },
  get bugdex() { return bugdex; },
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
  get confirmAndUpdateShellbyPlugin() { return confirmAndUpdateShellbyPlugin; },
  get confirmAndPublishPack() { return confirmAndPublishPack; },
  get confirmAndUninstallPlugin() { return confirmAndUninstallPlugin; },
  get confirmChannelPlace() { return confirmChannelPlace; },
  get confirmGitHubFeature() { return confirmGitHubFeature; },
  get correctionFromTurns() { return correctionFromTurns; },
  get crashConsent() { return crashConsent; },
  get crewExtra() { return crewExtra; },
  get crewRoster() { return crewRoster; },
  get crewShown() { return crewShown; }, set crewShown(v) { crewShown = v; },
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
  get journal() { return journal; },
  get githubEndpoints() { return githubEndpoints; },
  get guestShown() { return guestShown; }, set guestShown(v) { guestShown = v; },
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
  get lean() { return lean; }, set lean(v) { lean = v; },
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
  get confirmAndInstallPackText() { return confirmAndInstallPackText; },
  get installFromRegistry() { return installFromRegistry; },
  get captureClock() { return captureClock; },
  get LOG_DIR() { return LOG_DIR; },
  get PRIMARY() { return PRIMARY; },
  get repeating() { return repeating; },
  get onHotkey() { return onHotkey; },
  get onPermission() { return onPermission; },
  get onResult() { return onResult; },
  get onToolSpoken() { return onToolSpoken; },
  get openGitHubUrl() { return openGitHubUrl; },
  get openIssuePr() { return openIssuePr; },
  get openTab() { return openTab; },
  get outfit() { return outfit; },
  get paintLights() { return paintLights; },
  get panel() { return panel; }, set panel(v) { panel = v; },
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
  get pluginViewListed() { return pluginViewListed; },
  get prBadge() { return prBadge; }, set prBadge(v) { prBadge = v; },
  get refreshPhoneTasks() { return refreshPhoneTasks; },
  get pranks() { return pranks; }, set pranks(v) { pranks = v; },
  get profileCard() { return profileCard; }, set profileCard(v) { profileCard = v; },
  get projectInsights() { return projectInsights; },
  get projects() { return projects; }, set projects(v) { projects = v; },
  get ptt() { return ptt; }, set ptt(v) { ptt = v; },
  get px() { return px; },
  get randomUUID() { return randomUUID; },
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
  get questDone() { return questDone; },
  get questsPanelView() { return questsPanelView; },
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
  get setQuests() { return setQuests; },
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
  get skins() { return skins; }, set skins(v) { skins = v; },
  get sleepTimer() { return sleepTimer; }, set sleepTimer(v) { sleepTimer = v; },
  get snippetList() { return snippetList; },
  get snippetsView() { return snippetsView; },
  get soundMix() { return soundMix; },
  get surprises() { return surprises; },
  get speak() { return speak; },
  get startFocus() { return startFocus; },
  get startFromDraft() { return startFromDraft; },
  get startFromSend() { return startFromSend; },
  get startTask() { return startTask; },
  get startTaskInCopy() { return startTaskInCopy; },
  get dropUnsentCopy() { return dropUnsentCopy; },
  get setPhoneTasks() { return setPhoneTasks; },
  get startView() { return startView; }, set startView(v) { startView = v; },
  get stat() { return stat; },
  get statusFile() { return statusFile; },
  get stickerStats() { return stickerStats; },
  get stickersView() { return stickersView; },
  get stopFocus() { return stopFocus; },
  get syncLayer() { return syncLayer; },
  get taskFromClipboard() { return taskFromClipboard; },
  get teamIpc() { return teamIpc; }, set teamIpc(v) { teamIpc = v; },
  get parityIpc() { return parityIpc; }, set parityIpc(v) { parityIpc = v; },
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
  get workAreas() { return workAreas; },
  get visitor() { return visitor; }, set visitor(v) { visitor = v; },
  get wake() { return wake; },
  get wardrobe() { return wardrobe; }, set wardrobe(v) { wardrobe = v; },
  get weatherSvc() { return weatherSvc; }, set weatherSvc(v) { weatherSvc = v; },
  get weatherView() { return weatherView; },
  get webPreferences() { return webPreferences; },
  get weekView() { return weekView; },
  get welcomeTrophies() { return welcomeTrophies; }, set welcomeTrophies(v) { welcomeTrophies = v; },
  get workflows() { return workflows; }, set workflows(v) { workflows = v; },
  get worktreeHome() { return worktreeHome; },
  get xpView() { return xpView; },
};

// Adds an area's exports to shared, where the others reach them. Two areas
// giving the same name would quietly replace one another, so that stops boot.
function share(parts) {
  for (const k of Object.keys(parts)) if (k in shared) throw new Error(`shared.${k} is given twice`);
  return Object.assign(shared, parts);
}

// The panel's window first: its functions were main's own, there from the start.
const { createPanel, reachedForShellby, showPanel } = share(wirePanel(shared));
// Room for helper crabs in his window, and saving his spot.
const { setCrewSlots } = share(wireCrewSlots(shared));
// Streaks and nudges.
const { checkNudges } = share(wireStreaks(shared));
// Settings' side effects: the hotkey, opening at login, your skins folder.
const { applyHotkey, applyLoginItem, userSkinsDir } = share(wireSettings(shared));
// The Wardrobe, made at boot.
const { createWardrobe } = share(wireWardrobe(shared));
// Before any other area, as they were: the rest reach these from the start.
const {
  checkLimit, routineService, scheduleHeld, startScheduler,
  watchAway, watchGuards, watchLeaving, watchOutlook,
} = share(wireServices(shared));
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
  knownFolder, noteAwayRun, noteFix, noteRed, noteTestRun, noteWeek, noteWorkTime, questDone, questsPanelView,
  roomTaskDone, roomsPanelView, runCheckup, setQuests, setRooms, showFlaky, weekView, xpView,
} = wireProgress(shared);
const bugdex = wireBugdex(shared); // the bugs Claude has fixed for you, in jars
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
  askOnce, confirmAndChangeHook, confirmAndInstallPlugin, confirmAndInstallShellbyPlugin, confirmAndUpdateShellbyPlugin,
  confirmAndUninstallPlugin, createShop, createToolbox, draftHook, forgetPausedHook, pauseHook, pluginView, pluginViewListed,
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
  dropUnsentCopy, serversOnQuit, showServer, startTaskInCopy,
} = wireProjects(shared);
const { confirmAndInstallPackText, installFromRegistry, onDeepLink, setFolder } = wirePacks(shared);
const { looseEndDraft, looseEnds, showBuildFix, startFromDraft, startFromSend } = wireStartFrom(shared);
const {
  backlogView, backlogEdit, backlogAddIssue, backlogDo, backlogOpenDoing, backlogOpenTodo, backlogOpenIssue, backlogHide, backlogTabInfo, backlogOpenPr, backlogTick, backlogCommit, backlogHand, backlogHome, backlogMerged, backlogTabClosed, backlogRepoTasks, backlogForTerminal,
} = wireBacklog(shared); // Next up on each project's page (docs/plans/next-up.md)
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
const journal = wireJournal(shared); // handoff notes per project, read from Claude Code's own files
const crewRoster = wireCrew(shared); // one lasting helper crab per agent type
const surprises = wireSurprises(shared); // crit hits and clean landings, now and then

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Where a tab's copy of its repo goes (copy-service.js), and Claude Code's own settings.
const worktreeHome = () => path.join(app.getPath('userData'), 'worktrees');
const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ================================================================ IPC

// Remembered for Up and Ctrl+R in the box (parity.js).
function rememberPrompt(text) { parityIpc?.rememberPrompt(text); }

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
  createWardrobe();
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
  registerIpc(electronIpcMain, shared);
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
  journal.resumePending(); // notes that were still settling when Shellby last quit
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
// Quitting stops everything he started, in order (wiring/quit.js).
wireQuit(shared);
