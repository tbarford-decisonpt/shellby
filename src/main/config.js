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
  model: '', // '' -> Claude Code's default
  effort: '', // '' -> Claude Code's default; low | medium | high | xhigh | max (session.js)
  outputStyle: '', // '' -> the user's own; a style name otherwise (outputstyles.js)
  shellAcknowledged: false, // ! in the box runs PowerShell commands; asked once in the confirm window (parity.js)
  claudePath: null, // set only when the user points at the CLI by hand (see claude-cli.js)
  planOnly: false,  // leave API keys and other providers out of Claude Code's environment (see claude-cli.js)
  onboarded: false,
  crabOnly: false,
  wander: true,      // idle strolls near his spot (see motion.js)
  perch: 'sometimes', // how often he climbs onto your windows: off | sometimes | often (see perch.js)
  perchIgnore: [],   // apps he stays off, by exe name ("Not on Spotify" in his menu)
  perchStats: null,  // { byExe }: where he's perched, for his favourite (kept on this PC only)
  chatter: 'normal', // how much he says and gets up to: quiet | normal | chatty (see voice.js)
  sounds: false,     // a little chirp when he speaks; off until you ask for it
  voice: null,       // his seed, temperament and what he's said lately (see voice.js)
  xp: null,          // XP and levels (see xp.js); null -> level 1
  home: null,        // { worn, seen }: the shell he lives in (see shells.js); null -> his own
  focus: null,       // the focus session in progress (see focus.js)
  limitWait: null,   // { window, resetsAt }: napping until the usage limit resets (see limits.js)
  streaks: null,      // work days, projects and nudge settings (see streaks.js)
  stickers: null,     // a sticker per project shipped, and where they sit on each shell (see stickers.js)
  checkups: null,     // each project's last dependency audit and outdated check (see checkup.js); this PC only
  weekly: null,       // what happened each day, for the week-in-review card (see weekly.js); this PC only
  statusLinePrevious: null, // the Claude Code statusLine Shellby replaced (restored on remove)
  externalSessions: true, // react to Claude Code sessions outside Shellby (via the plugin's hooks)
  github: null,       // GitHub features, name and avatar (see github/service.js); the token is NOT here
  syncGistId: null,   // the private gist progress syncs through
  syncStamps: null,   // { outfitAt, skinAt }: when they last changed, so sync keeps the newest
  autonomousAcknowledged: false,
  lastUsage: null,
  spendLedger: [],    // who used the 5-hour and weekly limits (see spend.js)
  openTabs: [],       // history ids of conversations open as tabs
  pinnedTools: [],    // [{ kind, name }] shown as quick chips
  learnedTricks: [],  // recently discovered skills/agents/commands
  routines: [],       // see routines.js
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
