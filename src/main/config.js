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
  externalSessions: true, // react to Claude Code sessions outside Shellby (via the plugin's hooks)      // "just the crab": no Claude Code (Health, Wardrobe, trophies)
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
    this.data = { ...this.data, ...patch };
    // Write via temp file so a crash mid-write can't corrupt settings.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
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
