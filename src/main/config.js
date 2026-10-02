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
  skin: 'classic',
  critterPos: null,
  critterScale: 1,
  openAtLogin: false,
  notifications: true,
  model: '', // '' -> Claude Code's default
  onboarded: false,
  crabOnly: false,
  wander: true,      // idle strolls near his spot (see motion.js)
  chatter: 'normal', // how much he says and gets up to: quiet | normal | chatty (see voice.js)
  sounds: false,     // a little chirp when he speaks; off until you ask for it
  voice: null,       // his seed, temperament and what he's said lately (see voice.js)
  xp: null,          // XP and levels (see xp.js); null -> level 1
  home: null,        // { worn, seen }: the shell he lives in (see shells.js); null -> his own
  focus: null,       // the focus session in progress (see focus.js)
  limitWait: null,   // { window, resetsAt }: napping until the usage limit resets (see limits.js)
  streaks: null,      // work days, projects and nudge settings (see streaks.js)
  statusLinePrevious: null, // the Claude Code statusLine Shellby replaced (restored on remove)
  externalSessions: true, // react to Claude Code sessions outside Shellby (via the plugin's hooks)
  github: null,       // GitHub features, name and avatar (see github/service.js); the token is NOT here
  syncGistId: null,   // the private gist progress syncs through
  syncStamps: null,   // { outfitAt, skinAt }: when they last changed, so sync keeps the newest
  autonomousAcknowledged: false,
  lastUsage: null,
  openTabs: [],       // history ids of conversations open as tabs
  pinnedTools: [],    // [{ kind, name }] shown as quick chips
  learnedTricks: [],  // recently discovered skills/agents/commands
  routines: [],       // see routines.js
  health: null,       // health monitor settings (see health/service.js); null -> defaults
  healthLog: [],      // recent health alerts, newest first
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
