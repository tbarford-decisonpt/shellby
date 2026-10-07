const { app, ipcMain: electronIpcMain, screen, session: electronSession, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');

const { checkStatus } = require('./claude-cli');
const { loadSkins } = require('./skins');
const { clampToDisplays } = require('./placement');
const { REGISTRY_URL, PROTOCOL, findDeepLink } = require('./registry');
const { withDevice } = require('./xp');
const statusLine = require('./statusline');
const { Log } = require('./log');
const crashReport = require('./crash-report');
const { guardAllWebContents } = require('./web-guard');
const { registerIpc } = require('./ipc');
const { wireCrash } = require('./wiring/crash');
const { wireProfile } = require('./wiring/profile');
const { wirePanel } = require('./wiring/panel');
const { wireCrewSlots } = require('./wiring/crew-slots');
const { wireStreaks } = require('./wiring/streaks');
const { wireSettings } = require('./wiring/settings');
const { wireWardrobe } = require('./wiring/wardrobe');
const { wireServices } = require('./wiring/services');
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
const { wireStartFrom } = require('./wiring/startfrom');
const { wireBacklog } = require('./wiring/backlog');
const { wireClaudeUpdates } = require('./wiring/claude-updates');
const { wireTray } = require('./wiring/tray');
const { wireClashes } = require('./wiring/clashes');
const { wireUsagePlan } = require('./wiring/usageplan');
const { wireChecks } = require('./wiring/checks');
const { wireTries } = require('./wiring/tries');
const { wireShots } = require('./wiring/shots');
const { wireCorrections } = require('./wiring/corrections');
const { wireHandoff } = require('./wiring/handoff');
const { wireJournal } = require('./wiring/journal');
const { wireCrew } = require('./wiring/crew');
const { wireSurprises } = require('./wiring/surprises');
const { wireQuit } = require('./wiring/quit');

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
const HOUR_MS = 60 * 60 * 1000;

// Dev/test isolation: a separate profile (settings, history, single-instance lock)
// so test runs never touch the user's real Shellby or need it closed.
if (!app.isPackaged && process.env.SHELLBY_USER_DATA) app.setPath('userData', process.env.SHELLBY_USER_DATA);
// Screenshot runs always use a throwaway profile.
if (process.argv.includes('--capture-screenshots') && !process.env.SHELLBY_USER_DATA) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-capture-')));
}

// ---------------------------------------------------------------- the log
// Shellby runs all day with no console attached, so until now a crash left
// nothing behind: he simply vanished off the desktop. The log lives in the
// profile folder (so dev and test runs keep their own) and is scrubbed of the
// home directory and anything token-shaped, because its last lines are what
// "Report a problem" offers to paste into an issue. See log.js.
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const log = new Log(LOG_DIR, { home: os.homedir() });
// An event type a Claude Code update added is noted here, once (session.js).
require('./session').setLogger(log);
// ("starting" is written below, once this is known to be the Shellby that stays.)

// Dev/e2e only: drive the app with the fake CLI from test/fixtures (no Claude account, no usage).
const FAKE_CLI = !app.isPackaged && process.env.SHELLBY_FAKE_CLAUDE ? path.resolve(process.env.SHELLBY_FAKE_CLAUDE) : null;
require('./test-desktop').keepPainting(app); // test runs only: keep covered windows painting, so screenshots and rendering work on a busy desktop
// Isolated dev/test runs (SHELLBY_USER_DATA) never touch the real status file
// or the real Claude Code settings.
const ISOLATED = !app.isPackaged && !!process.env.SHELLBY_USER_DATA;

// Shellby's own repeating checks, all cleared on quit so none fires into a
// half-torn-down app.
const repeating = [];
const every = (fn, ms) => { const t = setInterval(fn, ms); repeating.push(t); return t; };

// ================================================================ shared
// What main shares with the modules in ipc/ and wiring/: the state they all
// read and change, set at boot or as he runs, and each area's exports, which
// share() adds as the area is wired below. wiring/ reaches the services whole
// (d.usageService.limitWait()); the flat names are what ipc/ reads.
const shared = {
  ROOT, RENDERER, PRELOAD, CRITTER_PRELOAD, TOY_PRELOAD, FLOOR_PRELOAD, NOTE_PRELOAD, ICON, CAPTURE,
  BASE_PX, MAX_CREW_SHOWN, SLEEP_AFTER_MS, LONG_TASK_MS, CREW_WORTH_MENTIONING, TAB_IDLE_STOP_MS,
  TAB_IDLE_CHECK_MS, IDLE_BIT_CHANCE, TRICKS_KIND, CARD_MAX_BYTES, PNG_SIGNATURE, FAKE_CLI, ISOLATED,
  LOG_DIR, log, every, repeating, randomUUID,
  PRIMARY: false, lastRun: null, sentry: null, // crash reports, started below
  captureClock: { now: null }, // screenshot runs can pretend it's Halloween
  isStr: s => typeof s === 'string' && s.length > 0 && s.length < 10000,
  isFolder: d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }, // missing or unreadable: not a folder
  send(win, channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  },
  statusFile: () => (ISOLATED ? path.join(app.getPath('userData'), 'shellby-status.txt') : statusLine.STATUS_FILE),
  claudeSettings: () => (ISOLATED ? path.join(app.getPath('userData'), 'claude-settings.json') : statusLine.settingsPath()),
  // The community registry. Only dev builds may point elsewhere (for testing).
  registryUrl: () => (!app.isPackaged && process.env.SHELLBY_REGISTRY_URL) || REGISTRY_URL,
  // A CLI the user pointed at by hand, when the usual places didn't have it.
  claudePath: () => shared.config?.get('claudePath') || null,
  // Where a tab's copy of its repo goes (copy-service.js), and Claude Code's own settings.
  worktreeHome: () => path.join(app.getPath('userData'), 'worktrees'),
  claudeConfigDir: () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  // Remembered for Up and Ctrl+R in the box (parity.js).
  rememberPrompt: text => { shared.parityIpc?.rememberPrompt(text); },
  get recapLog() { return shared.awayService.recapLog; }, set recapLog(v) { shared.awayService.recapLog = v; },

  // ---- made at boot
  config: null, history: null, skins: null, wardrobe: null, manager: null, toolbox: null, shop: null,
  health: null, external: null, github: null, ci: null, issues: null, updates: null, friends: null,
  profileCard: null, prBadge: null, critter: null, panel: null, tray: null, timeTracker: null,
  workflows: null,                 // the Automate page's engine (workflows/service.js)
  depWatch: null,                  // the weekly look at your projects' packages (depwatch.js)
  claudeUpdates: null,             // the daily look at Claude Code's own version (claude-update.js)
  projects: null,                  // the Projects page (projects/service.js)
  devServers: null,                // the dev servers in them (devservers/service.js)
  parityIpc: null,
  teamIpc: null,                   // Toolbox → Team: the repo's .shellby/team.json (team-ipc.js)
  lean: null,                      // Lean Shell: the prompt cache, setup weight and idle tools (lean.js)
  obsServer: null, rgbClient: null, media: null, remote: null, channelSecret: null,
  dictation: null, ptt: null,      // push-to-talk: hold the hotkey and say the task (see dictation.js)
  motion: null,                    // throws and strolls (see motion.js)
  perching: null,                  // up on your windows (see perching.js)
  climbing: null,                  // up the edges of the screen and across the top (see climbing.js)
  pranks: null,                    // mischief, if you asked for it (see pranks.js)
  floor: null,                     // the strip of floor with his pals and footprints (see floor.js)
  life: null,                      // his life between tasks: scenes, gifts, the bond, your day (see life.js)
  playtime: null,                  // hide and seek, fetch (see playtime.js)
  typing: null,                    // tapping along while you type (see typing.js)
  weatherSvc: null,                // the weather outside, for what he wears (see weather-service.js)

  // ---- as he runs
  claudeStatus: null,
  lastInit: null,                  // the newest init report from a conversation: its MCP list is refreshed from mcp_status
  nowPlaying: null,                // { title, artist, app, playing } from the Windows media session
  crewShown: 0,                    // helper slots currently allotted in the critter window
  guestShown: false,               // room allotted for a friend's visiting crab
  visitor: null,                   // { login, look, until }: a friend's crab dropped by (see friends.js)
  flash: null,                     // { state, until }: brief success/error/learned reaction
  said: null,                      // { text, occasion, until }: the line in his bubble (see voice.js)
  longTaskTimer: null,             // a task still running after LONG_TASK_MS gets a "still going…"
  fileTouches: new Map(),          // file path -> times written this run, for his "this file again?"
  healthMood: null,                // { mood, level, text } from the health monitor, or null
  levelUpAt: 1,                    // level shown in the critter's level-up bubble
  lastXp: null,                    // { amount, at } for the status line's "+25 XP"
  lastStatus: { state: 'idle', busy: 0, crew: 0, background: 0 },
  lastActivity: Date.now(),
  dragging: false,                 // the user is dragging him around
  sleepTimer: null,
  welcomeTrophies: [],             // achievements credited from history on first run
  booted: false,                   // deep links wait for this
  pendingLink: null,               // a shellby:// link that arrived before boot finished
  startView: null,                 // view the panel should open on at boot (e.g. a deep link wants the Wardrobe)
  linkBusy: false,                 // one registry install at a time
  autonomousOkThisRun: false,      // switching into Autonomous was confirmed since Shellby started (settings:set)
  calmReason: null,                // the panel: 'blur' | 'locked' | null
  heldNotices: [],
  lastRgbColor: '',
  shopAsking: false,
  focusTimer: null,
  focusTick: null,
};

// Adds an area's exports to shared, where the others reach them. Two areas
// giving the same name would quietly replace one another, so that stops boot.
function share(parts) {
  for (const k of Object.keys(parts)) if (Object.hasOwn(shared, k)) throw new Error(`shared.${k} is given twice`);
  return Object.assign(shared, parts);
}

// ---------------------------------------------------------------- snags
// Hung on the process before anything else can throw (wiring/crash.js).
const { snag, startCrashReports } = share(wireCrash(shared));
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

// Dev/test runs get their own identity so Windows never ties their toasts or
// jump lists to the installed Shellby.
app.setAppUserModelId(app.isPackaged ? 'com.xsalmon.shellby' : 'com.xsalmon.shellby.dev');
const PRIMARY = shared.PRIMARY = CAPTURE || app.requestSingleInstanceLock();
if (!PRIMARY) app.exit(0);
// A second launch bowing out doesn't write it: this line is where the crash
// report's "the run before" begins (crash-report.js previousLogTail).
else log.info(`Shellby ${app.getVersion()} starting`, `${process.platform} ${os.release()}, electron ${process.versions.electron}`);
// Sentry, held back by the user's answer, from the first moment (wiring/crash.js).
// Not share(): lastRun and sentry are already on shared, as null until now.
Object.assign(shared, startCrashReports(PRIMARY));

// shellby:// links ("Add to Shellby" on the community gallery). Dev runs only
// register when asked, so they don't hijack the links from an installed Shellby.
if (!CAPTURE) {
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  else if (process.env.SHELLBY_REGISTER_PROTOCOL === '1') app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(ROOT)]);
}

// ================================================================ wiring
// Each area of the app lives in wiring/ (and its IPC in ipc/). Wiring one only
// defines its functions: nothing runs until boot calls them, so the order here
// matters only where an area reads another's export as it is wired (the
// services take main's own helpers). main keeps just what boot calls.

// What were main's own functions, there from the start.
const { openProfile } = share(wireProfile(shared));
const { createPanel, reachedForShellby, showPanel } = share(wirePanel(shared));
const { setCrewSlots } = share(wireCrewSlots(shared));
const { checkNudges } = share(wireStreaks(shared));
const { applyHotkey, applyLoginItem, userSkinsDir } = share(wireSettings(shared));
const { createWardrobe } = share(wireWardrobe(shared));
// Before any other area, as they were: the rest reach these from the start.
const { checkLimit, routineService, scheduleHeld, startScheduler, watchAway, watchGuards, watchLeaving, watchOutlook } = share(wireServices(shared));
const { createCritter, createMischief, createMotion, placeCritter, watchIdleCost, workAreas } = share(wireWindows(shared));
const { broadcastSkin, broadcastWardrobe, refreshCritter, wakeVoice } = share(wireCritter(shared));
const { createManager } = share(wireSessions(shared));
const { awardXp, checkWrapUp } = share(wireProgress(shared));
share({ bugdex: wireBugdex(shared) }); // the bugs Claude has fixed for you, in jars
const { createExternal, createHealth, createTimeTracker, stat } = share(wireTimetrack(shared));
const { createCrabApi } = share(wireCrabApi(shared));
const { channelPlace, channelSettings, confirmChannelPlace, createObs, createRemote, loadChannelSecret } = share(wireChannels(shared));
const { createPhoneTasks } = share(wirePhoneTasks(shared));
const {
  createDictation, createLifeAndPlay, createMedia, createRgb, createTypingAlong, createWeather, ensureOpenRgb, rgbSettings,
} = share(wireSurroundings(shared));
const { createShop, createToolbox } = share(wireToolbox(shared));
const { createCi, createFriends, createGitHub, createIssues, sendVisitor } = share(wireGithub(shared));
const { advanceFocus } = share(wireFocus(shared));
share(wireSnippets(shared));
const { createDepWatch, createProjects, createWorkflows } = share(wireProjects(shared));
const { onDeepLink } = share(wirePacks(shared));
share(wireStartFrom(shared));
share(wireBacklog(shared)); // Next up on each project's page (docs/plans/next-up.md)
const { createClaudeUpdates } = share(wireClaudeUpdates(shared));
const { createTray, drainCrashQueue, reportUncleanExit, setupUpdates } = share(wireTray(shared));
const { watchClashes } = share(wireClashes(shared));
share({ usagePlan: wireUsagePlan(shared) });
share(wireChecks(shared));
share({ tries: wireTries(shared) }); // Try it N ways: only ever from tries:start, after asking
share(wireShots(shared));
const { createCorrections } = share(wireCorrections(shared));
share({ handoff: wireHandoff(shared) });
const { journal } = share({ journal: wireJournal(shared) }); // handoff notes per project, read from Claude Code's own files
share({ crewRoster: wireCrew(shared) }); // one lasting helper crab per agent type
share({ surprises: wireSurprises(shared) }); // crit hits and clean landings, now and then

// ================================================================ boot

app.whenReady().then(() => {
  openProfile(); // settings and history, before anything reads them
  const { config } = shared;
  createWardrobe(); // credits past usage on its first run, so before any stat()
  stat('active');
  // This PC's own XP count, so sync can add PCs together (xp.js).
  if (!CAPTURE && !config.get('xp')?.device) config.set({ xp: withDevice(config.get('xp'), randomUUID()) });
  awardXp('day');
  every(() => { shared.wardrobe.collectSeasonals(); broadcastWardrobe(); }, HOUR_MS);
  shared.skins = loadSkins(userSkinsDir());

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
  const { critter, panel } = shared;
  critter.webContents.on('did-finish-load', () => { broadcastSkin(); refreshCritter(); sendVisitor(); shared.life?.resendLook(); shared.typing?.resend(); });

  if (CAPTURE) {
    return require(process.argv.includes('--reel') ? './reel' : './capture').run({
      app, critter, panel, showPanel, send: shared.send, ROOT, setCrewSlots, wardrobe: shared.wardrobe, captureClock: shared.captureClock,
      broadcastWardrobe, health: shared.health, config, broadcastSkin,
      makeTimeTracker: () => { createTimeTracker({ start: false }); return shared.timeTracker; },
    });
  }

  createToolbox();
  createShop();
  createTray();
  // Windows signing out or shutting down ends him without will-quit: that's no crash.
  for (const w of [critter, panel]) w?.on('session-end', () => crashReport.endRun(LOG_DIR));
  reportUncleanExit();
  // Answers given before a restart still apply: walk the queue once so what was
  // turned down leaves the disk, and what was okayed goes.
  setTimeout(drainCrashQueue, 10 * 1000);
  shared.health.start();
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
  shared.channelSecret = loadChannelSecret();
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
  try { if (statusLine.upgradeStatusLine(shared.claudeSettings())) console.log('[shellby] updated the Claude Code status line command'); } catch (err) { log.warn('status line command could not be updated; left as it was', err?.message); }
  every(checkNudges, HOUR_MS);
  setTimeout(checkWrapUp, 2 * 60 * 1000);
  every(checkWrapUp, 30 * 60 * 1000);
  if (!applyHotkey(config.get('hotkey'))) console.warn('[shellby] hotkey unavailable:', config.get('hotkey'));
  applyLoginItem(config.get('openAtLogin'));
  setupUpdates();
  createClaudeUpdates();
  // Routines start either way: a failed CLI check must not silently leave them off.
  checkStatus({ configured: shared.claudePath() })
    .then(s => { shared.claudeStatus = FAKE_CLI ? require('./capture').FAKE_STATUS : s; })
    .catch(err => log.warn('Claude CLI status check failed at boot', err?.message || String(err)))
    .finally(startScheduler);

  const reclamp = () => {
    const c = clampToDisplays(shared.critter.getBounds(), workAreas());
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
  shared.booted = true;
  const link = shared.pendingLink || findDeepLink(process.argv);
  shared.pendingLink = null;
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
  if (shared.booted) { reachedForShellby(); showPanel(); }
});
// Quitting stops everything he started, in order (wiring/quit.js).
wireQuit(shared);
