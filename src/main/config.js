// Persistent settings in %APPDATA%/Shellby/settings.json.
const fs = require('fs');
const path = require('path');

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
  effort: '', // '' -> Claude Code's default; low | medium | high | xhigh | max (session.js)
  outputStyle: '', // '' -> the user's own; a style name otherwise (outputstyles.js)
  shellAcknowledged: false, // ! in the box runs PowerShell commands; asked once in the confirm window (parity.js)
  claudePath: null, // set only when the user points at the CLI by hand (see claude-cli.js)
  planOnly: false,  // leave API keys and other providers out of Claude Code's environment (see claude-cli.js)
  onboarded: false,
  rooms: null,       // which screens a new user has opened so far; null until first boot decides (see rooms.js)
  reopenAfterUpdate: false, // "Update and restart" was pressed: the new version opens the panel when it boots
  crabOnly: false,
  wander: true,      // idle strolls near his spot (see motion.js)
  perch: 'sometimes', // how often he climbs onto your windows: off | sometimes | often (see perch.js)
  perchIgnore: [],   // apps he stays off, by exe name ("Not on Spotify" in his menu)
  perchStats: null,  // { byExe }: where he's perched, for his favourite (kept on this PC only)
  climb: 'sometimes', // how often he climbs the edges of the screen: off | sometimes | often (see climb.js)
  mischief: 'off',   // the cheeky crab, strictly opt-in: off | cheeky | gremlin (see mischief.js)
  mischiefPranks: null, // { pinch, nudge, tracks, notes }: which pranks; anything unset is on
  mischiefLog: null, // { day, count, next }: today's pranks and when the next may be
  mischiefPause: 0,  // "Behave for an hour" from his menu: no mischief until then
  colony: 0,         // pals who hang out with him on the floor, 0 to 5 (see floor.js)
  chatter: 'normal', // how much he says and gets up to: quiet | normal | chatty (see voice.js)
  sounds: false,     // a little chirp when he speaks; off until you ask for it
  voice: null,       // his seed, temperament and what he's said lately (see voice.js)
  finds: null,       // the shelf: everything he's dug up for you (see gifts.js)
  bond: null,        // how close you are, the days together, the moments he remembers (see bond.js)
  play: null,        // hide and seek and fetch scores (see play.js)
  scenesSeen: null,  // which of his little scenes he's done (see scenes.js)
  xp: null,          // XP and levels (see xp.js); null -> level 1
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
  streaks: null,      // work days, projects and nudge settings (see streaks.js)
  stickers: null,     // a sticker per project shipped, and where they sit on each shell (see stickers.js)
  beach: null,        // the beach: what you've seen on it and the high-water mark (see beach.js); this PC only
  checkups: null,     // each project's last dependency audit and outdated check (see checkup.js); this PC only
  weekly: null,       // what happened each day, for the week-in-review card (see weekly.js); this PC only
  flakyTests: true,   // spot tests that fail and then pass on the same code (see flaky.js)
  flaky: null,        // which tests flaked, by project: names and hashes, never output (see flaky.js); this PC only
  timeTracking: null, // seconds on each project per day, clients and rates (see timetrack.js); this PC only, never synced
  statusLinePrevious: null, // the Claude Code statusLine Shellby replaced (restored on remove)
  pausedHooks: [],    // hooks taken out of a Claude Code settings file by Pause, kept to put back (main.js pauseHook)
  externalSessions: true, // react to Claude Code sessions outside Shellby (via the plugin's hooks)
  github: null,       // GitHub features, name and avatar (see github/service.js); the token is NOT here
  issueWatch: null,   // which GitHub issues he has already offered to take on (see github/issues.js)
  syncGistId: null,   // the private gist progress syncs through
  syncStamps: null,   // { outfitAt, skinAt }: when they last changed, so sync keeps the newest
  autonomousAcknowledged: false,
  lastUsage: null,
  spendLedger: [],    // who used the 5-hour and weekly limits (see spend.js)
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
  routines: [],       // see routines.js
  depWatch: null,     // { enabled, lastScanAt, results }: the weekly package check (see depwatch.js); off until you turn it on
  health: null,       // health monitor settings (see health/service.js); null -> defaults
  healthLog: [],      // recent health alerts, newest first
  channels: null,     // where to send "he needs you" when you're away (see channels.js)
  obs: null,          // { enabled, port }: the browser source for a stream (see obs.js)
  rgb: null,          // { enabled, port }: his mood on the desk lighting (see rgb.js)
  rgbSaved: null,     // [{ id, name, saved }]: each device's own mode before Shellby painted it, put back on switching off
  nowPlaying: null,   // { enabled, headphones, remarks }: listening along (see media.js)
  cli: null,          // { installed }: the `shellby` command (see clipath.js)
  worktrees: false,   // each new tab in a git repo works in its own copy (see worktrees.js)
  channelSecret: null, // the channel's token, encrypted by Windows (never in the clear)
  channelsConfirmed: null, // the destination you said yes to in the confirm window; nothing goes anywhere else (main.js channelPlace)
  crashReports: 'ask',        // ask | always | never: whether crash reports go to Sentry (crash-report.js)
  crashReportDecisions: [],   // [{ until, send }]: each Send / Don't send answer and what it covered
};

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { ...DEFAULTS, ...readJson(this.file) };
    if (!MODES.includes(this.data.mode)) this.data.mode = DEFAULTS.mode;
  }

  get(key) { return this.data[key]; }

  set(patch) {
    const prev = this.data;
    this.data = { ...this.data, ...patch };
    // Write via temp file so a crash mid-write can't corrupt settings.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
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

module.exports = { Config, MODES, CLI_MODE, DEFAULTS, readJson };
