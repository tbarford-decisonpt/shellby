// Persistent settings in %APPDATA%/Shellby/settings.json.
const fs = require('fs');
const path = require('path');
const workmode = require('./workmode');

const MODES = ['ask', 'smart', 'acceptEdits', 'plan', 'autonomous'];

// UI mode -> Claude Code --permission-mode value
const CLI_MODE = {
  ask: 'default',
  smart: 'auto',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  autonomous: 'bypassPermissions',
};

const DEFAULTS = {
  mode: 'ask',
  cwd: null, // null -> home dir
  recentFolders: [],
  hotkey: 'Control+Alt+Space',
  pushToTalk: false, // hold the hotkey to dictate a task with Windows speech recognition (see dictation.js)
  skin: 'classic',
  critterPos: null,
  critterScale: 1,
  openAtLogin: false,
  notifications: true,
  recap: true,        // a digest of what happened when you come back after an hour away (see recap.js)
  leaveGuard: true,   // hold up a shutdown or sign-out while work is unpushed, uncommitted or mid-turn (see leaving.js)
  model: '', // '' -> Claude Code's default
  effort: '', // new conversations' effort: '' -> Claude Code's default; low | medium | high | xhigh | max (session.js)
  effortPick: true, // with effort on Auto, size each new conversation from its first message instead (effort-pick.js)
  outputStyle: '', // '' -> the user's own; a style name otherwise (outputstyles.js)
  shellAcknowledged: false, // ! in the box runs PowerShell commands; asked once in the confirm window (parity.js)
  claudePath: null, // set only when the user points at the CLI by hand (see claude-cli.js)
  planOnly: false,  // leave API keys and other providers out of Claude Code's environment (see claude-cli.js)
  onboarded: false,
  rooms: null,       // which screens a new user has opened so far; null until first boot decides (see rooms.js)
  quests: null,      // which quests are done, and whether the chat's quest card is hidden (see quests.js)
  reopenAfterUpdate: false, // "Update and restart" was pressed: the new version opens the panel when it boots
  crabOnly: false,
  workMode: false,   // the tools up front and a quiet crab, laid over your own settings (see workmode.js)
  workOverrides: {}, // what you changed while in Work mode; it wins over Work mode's own (workmode.js write)
  wander: true,      // idle strolls near his spot (see motion.js)
  wanderChosen: false, // you set wander yourself: with Windows' animation effects off, only that strolls (motion.js wanders)
  onTop: false,      // drawn over your apps instead of on the desktop under them (see desktop-layer.js)
  perch: 'sometimes', // how often he climbs onto your windows: off | sometimes | often (see perch.js)
  perchIgnore: [],   // apps he stays off, by exe name ("Not on Spotify" in his menu)
  perchStats: null,  // { byExe }: where he's perched, for his favourite (kept on this PC only)
  climb: 'sometimes', // how often he climbs the edges of the screen: off | sometimes | often (see climb.js)
  mischief: 'off',   // the cheeky crab, strictly opt-in: off | cheeky | gremlin (see mischief.js)
  mischiefPranks: null, // { pinch, nudge, tracks, notes }: which pranks; anything unset is on
  mischiefLog: null, // { day, count, next }: today's pranks and when the next may be
  mischiefPause: 0,  // "Behave for an hour" from his menu: no mischief until then
  colony: 0,         // pals who hang out with him on the floor, 0 to 5 (see floor.js)
  chatter: 'normal', // how much he says and gets up to: quiet | work | normal | chatty (see voice.js)
  sounds: false,     // a little chirp when he speaks; off until you ask for it
  editor: 'auto',    // where file links open: auto | vscode | cursor | windsurf | insiders | system (see filelinks.js)
  panelZoom: 1,      // Ctrl+= / Ctrl+- in the panel
  soundFx: false,    // his feet, bumps, landings and a ta-da for big moments (see sounds.js)
  ambient: 'off',    // the background: off | surf | tidepool (src/renderer/critter/ambient.js)
  soundVolume: 60,   // 25 | 60 | 100: soft, normal, loud
  selfAware: true,   // Claude is told it's in Shellby and gets the crab's tools (see selfaware.js)
  suggestions: true, // ...and may offer Shellby features as one-tap cards
  mutedSuggestions: [], // features the user said not to offer again
  voice: null,       // his seed, temperament and what he's said lately (see voice.js)
  finds: null,       // the shelf: everything he's dug up for you (see gifts.js)
  bugdex: null,      // the bugs Claude has fixed for you, in jars (see bugdex.js)
  bond: null,        // how close you are, the days together, the moments he remembers (see bond.js)
  play: null,        // hide and seek and fetch scores (see play.js)
  needs: null,       // his tummy, shine, pep and cheer, and the snack pantry (see needs.js); this PC only
  needsOn: true,     // "Snacks and naps": off keeps him content all the time
  scenesSeen: null,  // which of his little scenes he's done (see scenes.js)
  xp: null,          // XP and levels (see xp.js); null -> level 1
  crew: null,        // { members }: one lasting helper crab per agent type, with its record (see crew-roster.js)
  home: null,        // { worn, seen }: the shell he lives in (see shells.js); null -> his own
  focus: null,       // the focus session in progress (see focus.js)
  limitWait: null,   // { window, resetsAt }: napping until the usage limit resets (see limits.js)
  forecast: true,    // warn when you're on pace to fill the 5-hour window before it resets (see forecast.js)
  forecastWarned: null, // the reset time of the window last warned about, so each window warns once
  held: [],          // messages, routines and queued tasks waiting for the usage window to reset (see held.js)
  queueKeepAwake: true, // keep the PC from sleeping while a task waits for the reset or runs (main.js syncKeepAwake)
  spendGuard: true,  // stop unattended runs before they eat the share of the 5-hour window you keep (see guard.js)
  spendReserve: 25,  // % of the 5-hour window routines, workflows and away-from-the-PC Autonomous tabs leave you
  spendMaxMinutes: 60, // the longest one routine run may take
  holdBigTasks: false, // hold a message for the reset when it usually takes more than the window has left (usage-ledger.js)
  streaks: null,      // work days, projects and nudge settings (see streaks.js)
  stickers: null,     // a sticker per project shipped, and where they sit on each shell (see stickers.js)
  beach: null,        // the beach: what you've seen on it and the high-water mark (see beach.js); this PC only
  tankLayouts: null,  // his tank's saved layouts (tank-layouts.js): synced, never on a card
  tankLive: null,
  tankTidy: null,     // whether he tidies his finds, and what he moved last (tank-tidy.js): per PC, never synced     // which of his tank's live decor is on (tank-gauges.js): per PC, never synced
  tank: null,         // his tank: its size, floor and back glass, and where each piece stands (see tank.js)
  tankLife: null,     // his life in it: what he uses most, sets shown, the biggest tank (see tank-life.js); this PC only
  checkups: null,     // each project's last dependency audit and outdated check (see checkup.js); this PC only
  weekly: null,       // what happened each day, for the week-in-review card (see weekly.js); this PC only
  flakyTests: true,   // spot tests that fail and then pass on the same code (see flaky.js)
  surprises: true,    // now and then a fanfare for a real outcome: a critical hit, a clean landing (see surprises.js)
  crits: null,        // the surprises' luck: when the last one was, misses since, how many (see surprises.js); this PC only
  catchBugs: true,    // the Bugdex: catch each kind of bug Claude fixes (see bugdex.js)
  bugBattles: true,   // ...and show Claude's work on each one as a battle (see bugdex/battle.js)
  bugFollower: true,  // ...and his favourite catch follows him round the desk
  shareBugdex: false, // ...and put which kinds you've caught (and your badges) on your calling card, for friends
  checkEachTurn: false, // run the project's tests after a turn that changed files, and before bringing a copy home (see checks.js)
  checkTimeoutMin: 5, // the longest one check may run, in minutes (checks.TIMEOUTS_MIN)
  checksTrusted: {},  // { project root (lower-case): true | false }: asked once before running a project's own tests (checks.js)
  turnShots: true,   // before/after pictures of a Shellby dev server either side of a turn (see shots.js)
  flaky: null,        // which tests flaked, by project: names and hashes, never output (see flaky.js); this PC only
  timeTracking: null, // seconds on each project per day, clients and rates (see timetrack.js); this PC only, never synced
  timeSync: null,     // { provider, account, links, sent }: sending days to Toggl, Clockify or Harvest (see timesync.js); off until you connect one
  timeSyncToken: null, // ...and its token, encrypted by Windows (never in the clear)
  statusLinePrevious: null, // the Claude Code statusLine Shellby replaced (restored on remove)
  pausedHooks: [],    // hooks taken out of a Claude Code settings file by Pause, kept to put back (main.js pauseHook)
  externalSessions: true, // react to Claude Code sessions outside Shellby (via the plugin's hooks)
  github: null,       // GitHub features, name and avatar (see github/service.js); the token is NOT here
  issueWatch: null,   // which GitHub issues he has already offered to take on (see github/issues.js)
  backlogDoing: {},   // Next up items with a conversation on them, by project (see wiring/backlog.js); this PC only
  backlogHidden: {},  // Next up items you hid, by project; this PC only
  backlogTrackers: {}, // { project key: { server, kind: 'linear' | 'jira', scope } }: Linear or Jira issues on Next up, read through that MCP server (see backlog/trackers.js)
  sentry: null,       // { url, token (encrypted by Windows), links, snoozed }: errors from Sentry on Next up (wiring/sentry.js); this PC only, never synced
  ciSeen: null,       // { 'owner/repo#12': ms }: when you last opened each of your PRs, for "new comments" (see github/ci.js); this PC only
  gitlab: null,       // { ci, hosts }: watch GitLab merge requests through glab, and self-managed hosts to ask (see wiring/gitlab.js); glab keeps the sign-in
  gitlabSeen: null,   // { 'group/project!12': ms }: ciSeen for merge requests (see gitlab/watcher.js); this PC only
  syncGistId: null,   // the private gist progress syncs through
  syncStamps: null,   // { outfitAt, skinAt }: when they last changed, so sync keeps the newest
  autonomousAcknowledged: false,
  lastUsage: null,
  journalPending: [], // conversations whose handoff note was still settling at quit (see wiring/journal.js)
  spendLedger: [],    // who used the 5-hour and weekly limits (see spend.js)
  turnCosts: [],      // what each turn cost, by project and kind of ask, never the prompt (see usage-ledger.js); this PC only
  // Lean Shell (efficiency.js, lean.js): cache reads per day, each project's
  // setup weight, what Claude Code used lately, plugins' always-on estimates,
  // what was tidied away (XP once each), and when things were first seen.
  cacheDays: {},
  setupWeights: {},
  leanUsed: null,
  pluginCosts: {},
  leanTidied: [],
  mcpSeen: {},          // when Shellby first saw each MCP server (one that's new isn't idle)
  pluginEnabledAt: {},  // when a plugin was turned back on from the Lean tab
  openTabs: [],       // history ids of conversations open as tabs
  pinnedTools: [],    // [{ kind, name }] shown as quick chips
  snippets: null,     // [{ name, text, hint?, newTab? }]: saved prompts, /name in the panel and @name in a terminal (see snippets.js); null -> the starters
  snippetUse: {},     // { name: { n, at } }: how often each snippet has run, and when last
  snippetFormat: 0,   // snippets.FORMAT once the saved list has been migrated to it
  learnedTricks: [],  // recently discovered skills/agents/commands
  corrections: null,  // { events, offers }: corrections noted and rules offered from them (see corrections.js); this PC only
  routines: [],       // see routines.js
  depWatch: null,     // { enabled, lastScanAt, results }: the weekly package check (see depwatch.js); off until you turn it on
  plainCards: true, // permission cards and the Working bar say what a step does, in plain words (plain-words.js)
  claudeTricks: true, // say what a new Claude Code can do, from its changelog (see claude-tricks.js)
  claudeTricksState: null, // { lastSeen, pending }: the version he last saw, and a card not yet dismissed
  claudeUpdates: null, // { mode, latest, lastCheckAt, … }: keeping Claude Code itself current (see claude-update.js); null -> tell me
  notes: null,        // { general, projects }: ideas to plan, build or ask about (see notes.js)
  health: null,       // health monitor settings (see health/service.js); null -> defaults
  healthLog: [],      // recent health alerts, newest first
  channels: null,     // where to send "he needs you" when you're away (see channels.js)
  obs: null,          // { enabled, port }: the browser source for a stream (see obs.js)
  streamDeck: null,   // { enabled }: Allow, Deny, Stop, Bring it home and Ready to review on a Stream Deck (see deck.js)
  streamDeckToken: null, // the Stream Deck plugin's way in, encrypted by Windows (wiring/deck.js)
  streamDeckAdded: false, // the plugin has been handed to Stream Deck's installer at least once
  rgb: null,          // { enabled, port }: his mood on the desk lighting (see rgb.js)
  rgbSaved: null,     // [{ id, name, saved }]: each device's own mode before Shellby painted it, put back on switching off
  discord: null,      // { enabled, task }: his level and what he's up to on your Discord profile (see discord.js); off until you turn it on
  nowPlaying: null,   // { enabled, headphones, remarks }: listening along (see media.js)
  typing: null,       // { enabled, remarks }: tapping along while you type (see typing.js); off until you turn it on
  typingBest: 0,      // your fastest burst, in words a minute (typing.js)
  weather: null,      // { enabled, place, remarks }: dressing for the weather outside (see weather-service.js); off until you pick a town
  weatherNow: null,   // the last reading from Open-Meteo (weather.js parseForecast)
  cli: null,          // { installed }: the `shellby` command (see clipath.js)
  worktrees: false,   // each new tab in a git repo works in its own copy (see worktrees.js)
  clashWarnings: true, // say when two copies (or a copy and your checkout) change the same file (wiring/clashes.js)
  channelSecret: null, // the channel's token, encrypted by Windows (never in the clear)
  channelsConfirmed: null, // the destination you said yes to in the confirm window; nothing goes anywhere else (main.js channelPlace)
  crashReports: 'ask',        // ask | always | never: whether crash reports go to Sentry (crash-report.js)
  crashReportDecisions: [],   // [{ until, send }]: each Send / Don't send answer and what it covered
};

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
    const { data, recoveredFrom, unreadable } = loadSettings(this.file);
    // Where a damaged settings.json was moved to (main.js logs it), or null.
    this.recoveredFrom = recoveredFrom;
    // Why settings.json couldn't be read at all (still locked after retries), or
    // null. Then this session runs on defaults and never saves: writing would
    // replace the real settings, which are fine, just out of reach.
    this.unreadable = unreadable;
    this.data = { ...DEFAULTS, ...data };
    if (!MODES.includes(this.data.mode)) this.data.mode = DEFAULTS.mode;
  }

  // What applies right now: Work mode's settings lay over your own (workmode.js).
  // `data` keeps your own, untouched.
  get(key) { return workmode.valueOf(this.data, key); }

  set(patch) {
    // Every save writes the defaults too, so a saved wander: true can't say
    // whether you chose it; this does (set from Settings, or another PC's sync).
    if (patch && 'wander' in patch && !('wanderChosen' in patch)) patch = { ...patch, wanderChosen: true };
    const prev = this.data;
    this.data = { ...this.data, ...patch };
    if (!this.unreadable) writeSettings(this.file, JSON.stringify(this.data, null, 2));
    this.onSet?.(patch, prev);
    return this.data;
  }

  addRecentFolder(dir) {
    const list = [dir, ...this.data.recentFolders.filter(d => d.toLowerCase() !== dir.toLowerCase())];
    this.set({ recentFolders: list.slice(0, 6) });
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Antivirus and search indexers briefly hold files open on Windows, which makes
// a read or rename fail with EPERM/EBUSY/EACCES. A few short waits (100 ms in
// all: this blocks the main process) usually see it through.
const BUSY_WAITS_MS = [10, 20, 30, 40];
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function retryBusy(fn) {
  for (const wait of BUSY_WAITS_MS) {
    try { return fn(); } catch (err) {
      if (!BUSY.has(err.code)) throw err;
      pause(wait);
    }
  }
  return fn();
}

// settings.json -> { data, recoveredFrom, unreadable }. A missing file is a
// fresh profile. One that can't be read as an object is moved aside rather than
// treated as empty: the next save would otherwise replace routines, snippets and
// XP with the defaults, with nothing left to rescue. One that can't be read or
// moved at all is left exactly where it is (unreadable: why).
function loadSettings(file) {
  let text;
  try { text = retryBusy(() => fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, recoveredFrom: null, unreadable: null };
    return { data: {}, recoveredFrom: null, unreadable: err.message };
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return { data, recoveredFrom: null, unreadable: null };
  } catch { /* damaged: set aside below */ }
  const aside = file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
  try { retryBusy(() => fs.renameSync(file, aside)); } catch (err) {
    return { data: {}, recoveredFrom: null, unreadable: `damaged, and couldn't be set aside: ${err.message}` };
  }
  return { data: {}, recoveredFrom: aside, unreadable: null };
}

// Via a temp file, so a crash mid-write can't leave half a settings.json. A
// rename that stays blocked falls back to writing in place: better than losing
// the change.
function writeSettings(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  try { retryBusy(() => fs.renameSync(tmp, file)); return; } catch (err) {
    if (!BUSY.has(err.code)) throw err;
  }
  fs.writeFileSync(file, text);
  fs.rmSync(tmp, { force: true });
}

module.exports = { Config, MODES, CLI_MODE, DEFAULTS, readJson };
