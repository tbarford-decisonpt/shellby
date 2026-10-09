// The toolbox: everything Claude Code can reach for — skills, subagents, slash
// commands and MCP servers — gathered from ~/.claude, the project's .claude and
// any plugins, so the UI can list and pin them. ToolboxWatcher keeps it fresh and
// announces when a new skill/agent/command shows up on disk ("learned a new trick").
// Read-only: nothing here ever writes to the user's Claude config (removing one of
// your own skills, agents or commands is skillremove.js, and asks first).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { scanMods } = require('./mods');

const MAX_FILE = 256 * 1024;   // bigger than this isn't a real skill/agent/command file
const MAX_ITEMS = 1000;        // per list
const MAX_DEPTH = 8;           // recursion limit for agents/commands (guards symlink loops)
const MAX_DESC = 240;
const KINDS = ['skills', 'agents', 'commands'];
const PRIORITY = { plugin: 0, user: 1, project: 2 };
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---- frontmatter

// Minimal YAML frontmatter reader: top-level `key: value` scalars only.
function parseFrontmatter(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return out;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return out;
  const body = lines.slice(1, end);

  const indented = l => /^\s+\S/.test(l);
  let i = 0;
  while (i < body.length) {
    const m = /^([\w.-]+)\s*:(?:\s+(.*))?$/.exec(body[i]);
    i++;
    if (!m) continue; // comments, list items, nested lines, junk
    const key = m[1];
    const raw = (m[2] || '').trim();
    // Everything indented (or blank) below this key belongs to it.
    const block = [];
    while (i < body.length && (indented(body[i]) || body[i].trim() === '')) block.push(body[i++]);
    while (block.length && block[block.length - 1].trim() === '') block.pop();

    let value;
    const bs = /^([>|])[+-]?\d?[+-]?\s*(#.*)?$/.exec(raw);
    if (bs) value = blockScalar(block, bs[1]);
    else if (!raw) {
      if (block.length) continue; // nested map / list: not ours
      value = '';
    } else if (raw[0] === '"') value = doubleQuoted(raw, block);
    else if (raw[0] === "'") value = singleQuoted(raw, block);
    else if (raw[0] === '[' || raw[0] === '{') continue; // flow collections: ignore
    else {
      // Plain scalar, possibly continued on indented lines (folded with spaces).
      value = [raw, ...block.map(l => l.trim())].filter(Boolean).join(' ').replace(/\s+#.*$/, '');
    }
    if (!BAD_KEYS.has(key)) out[key] = value;
  }
  return out;
}

function blockScalar(block, style) {
  const nonBlank = block.filter(l => l.trim());
  const indent = nonBlank.length ? Math.min(...nonBlank.map(l => l.match(/^\s*/)[0].length)) : 0;
  const rows = block.map(l => l.slice(indent));
  if (style === '|') return rows.join('\n').replace(/\s+$/, '');
  // Folded: lines join with spaces; a blank line becomes a newline.
  let s = '';
  for (const r of rows) {
    if (!r.trim()) s += '\n';
    else s += (s && !s.endsWith('\n') ? ' ' : '') + r.trim();
  }
  return s.trim();
}

function doubleQuoted(raw, block) {
  const src = [raw, ...block.map(l => l.trim())].join(' ');
  let s = '';
  for (let i = 1; i < src.length; i++) {
    const c = src[i];
    if (c === '"') break;
    if (c === '\\' && i + 1 < src.length) {
      const n = src[++i];
      s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else s += c;
  }
  return s;
}

function singleQuoted(raw, block) {
  const src = [raw, ...block.map(l => l.trim())].join(' ');
  let s = '';
  for (let i = 1; i < src.length; i++) {
    if (src[i] === "'") {
      if (src[i + 1] === "'") { s += "'"; i++; } else break;
    } else s += src[i];
  }
  return s;
}

// ---- scanning

function cleanDesc(d) {
  const s = typeof d === 'string' ? d.replace(/\s+/g, ' ').trim() : '';
  return s.length > MAX_DESC ? s.slice(0, MAX_DESC - 1) + '…' : s;
}

// The frontmatter, and how much text follows it: that body is what Claude reads
// when the skill, command or agent is called. cache ({ prev, next } Maps keyed by
// path) skips re-reading a file whose size and time haven't changed: with a few
// dozen plugins that's hundreds of files, and the scan runs on the main process.
function readMeta(file, cache = null) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const hit = cache?.prev.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      cache.next.set(file, hit);
      return hit.meta;
    }
    const text = fs.readFileSync(file, 'utf8');
    const fm = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
    const meta = { ...parseFrontmatter(text), bodyChars: text.length - (fm ? fm[0].length : 0) };
    cache?.next.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// All *.md under dir, as { file, parts: ['sub', 'name'] }.
function walkMd(dir, parts = [], depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_ITEMS * 2) return out;
  for (const e of readdir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && isDir(full))) walkMd(full, [...parts, e.name], depth + 1, out);
    else if (/\.md$/i.test(e.name)) out.push({ file: full, parts: [...parts, e.name.replace(/\.md$/i, '')] });
  }
  return out;
}

// listChars: the name and full description, which Claude Code lists for Claude in
// every conversation. bodyChars: the rest of the file, read only when it's called.
function tool(kind, name, meta, source, file) {
  const n = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : name;
  const desc = typeof meta.description === 'string' ? meta.description.trim() : '';
  return { kind, name: n, description: cleanDesc(desc), source, path: file, listChars: n.length + desc.length, bodyChars: meta.bodyChars || 0 };
}

// Items from one root (<home>/.claude, <cwd>/.claude or a plugin dir).
function scanRoot(root, source, prefix, cache) {
  const found = { skills: [], agents: [], commands: [] };
  const named = n => (prefix ? `${prefix}:${n}` : n);
  for (const e of readdir(path.join(root, 'skills'))) {
    const dir = path.join(root, 'skills', e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(dir)))) continue;
    const file = path.join(dir, 'SKILL.md');
    const meta = readMeta(file, cache);
    if (meta) found.skills.push(tool('skill', e.name, meta, source, file));
  }
  for (const { file, parts } of walkMd(path.join(root, 'agents'))) {
    const meta = readMeta(file, cache);
    if (meta) found.agents.push(tool('agent', parts[parts.length - 1], meta, source, file));
  }
  for (const { file, parts } of walkMd(path.join(root, 'commands'))) {
    const meta = readMeta(file, cache);
    if (meta) found.commands.push(tool('command', parts.join(':'), meta, source, file));
  }
  for (const k of KINDS) for (const t of found[k]) t.name = named(t.name);
  return found;
}

const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function samePath(a, b) {
  const norm = p => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function isInside(file, dir) {
  if (typeof file !== 'string' || !file) return false;
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// metaCache: a Map the caller keeps between scans (ToolboxWatcher does). It's
// refilled with just the files this scan saw, so deleted ones don't pile up.
// pluginCache: a Map of plugin dir -> what was found there. A plugin's cached
// version is written once when it's installed, so a poll can reuse it; the
// caller clears it for a real rescan.
function scanToolbox({ home, cwd, plugins = [], metaCache = null, pluginCache = null } = {}) {
  const cache = metaCache instanceof Map ? { prev: metaCache, next: new Map() } : null;
  const plugCache = pluginCache instanceof Map ? pluginCache : null;
  const roots = [];
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (p && typeof p.name === 'string' && p.name && typeof p.path === 'string' && p.path) {
      roots.push({ dir: p.path, source: `plugin:${p.name}`, prefix: p.name, rank: PRIORITY.plugin });
    }
  }
  if (home) roots.push({ dir: path.join(home, '.claude'), source: 'user', prefix: '', rank: PRIORITY.user });
  if (cwd && !(home && samePath(cwd, home))) {
    roots.push({ dir: path.join(cwd, '.claude'), source: 'project', prefix: '', rank: PRIORITY.project });
  }

  const maps = { skills: new Map(), agents: new Map(), commands: new Map() };
  for (const r of roots) {
    const plugin = r.rank === PRIORITY.plugin && plugCache;
    const rootKey = `${r.prefix}=${r.dir}`;
    let found = plugin ? plugCache.get(rootKey) : null;
    if (found && cache) {
      // Not stat'ed this time: carry their entries over, so a rescan that
      // clears pluginCache still finds them unchanged.
      for (const k of KINDS) for (const t of found[k]) { const hit = cache.prev.get(t.path); if (hit) cache.next.set(t.path, hit); }
    } else if (!found) {
      found = scanRoot(r.dir, r.source, r.prefix, cache);
      // An empty dir may be an install still being written: look again next time.
      if (plugin && KINDS.some(k => found[k].length)) plugCache.set(rootKey, found);
    }
    for (const k of KINDS) {
      for (const t of found[k]) {
        const prev = maps[k].get(t.name);
        // The loser is remembered, so the Toolbox can say one copy hides another.
        if (!prev) maps[k].set(t.name, { rank: r.rank, t, hides: [] });
        else if (r.rank > prev.rank) maps[k].set(t.name, { rank: r.rank, t, hides: [...prev.hides, { source: prev.t.source, path: prev.t.path }] });
        else prev.hides.push({ source: t.source, path: t.path });
      }
    }
  }
  if (cache) {
    metaCache.clear();
    for (const [k, v] of cache.next) metaCache.set(k, v);
  }
  if (plugCache) {
    const live = new Set(roots.filter(r => r.rank === PRIORITY.plugin).map(r => `${r.prefix}=${r.dir}`));
    for (const k of [...plugCache.keys()]) if (!live.has(k)) plugCache.delete(k);
  }
  // A copy, never the cached item itself: a plugin's found list is reused between scans.
  const list = k => [...maps[k].values()].map(v => (v.hides.length ? { ...v.t, hides: v.hides } : v.t)).sort(byName).slice(0, MAX_ITEMS);
  return { skills: list('skills'), agents: list('agents'), commands: list('commands'), mcp: [], scannedAt: Date.now() };
}

// ---- CLI init merge

// Claude Code's own slash commands aren't files, so the CLI only names them.
// Unknown ones (newer than this list) just go without.
const BUILTIN_COMMANDS = {
  'add-dir': 'Add another folder Claude can work in.',
  agents: 'Manage helper agents.',
  bashes: 'List and manage background shell commands.',
  bug: 'Report a bug to Anthropic.',
  clear: 'Start the conversation over, without its history.',
  compact: 'Summarize the conversation so far to free up context.',
  config: 'Open Claude Code settings.',
  context: 'Show what is using the context window.',
  cost: 'Show what this conversation has cost.',
  doctor: 'Check the Claude Code install for problems.',
  export: 'Save the conversation to a file or the clipboard.',
  help: 'List the commands.',
  hooks: 'Manage hooks.',
  init: 'Write a CLAUDE.md that describes this project.',
  mcp: 'Manage MCP servers.',
  memory: 'Edit CLAUDE.md memory files.',
  model: 'Pick the model.',
  'output-style': 'Pick how Claude writes its replies.',
  permissions: 'Manage allow, ask and deny rules.',
  plugin: 'Manage plugins and marketplaces.',
  'pr-comments': "Get a pull request's review comments.",
  'release-notes': 'Show what changed in recent versions.',
  resume: 'Pick up an earlier conversation.',
  review: 'Review a pull request.',
  rewind: 'Go back to an earlier point in the conversation.',
  'security-review': 'Look over the changes on this branch for security problems.',
  status: 'Show the version, model, account and connections.',
  statusline: 'Set up the status line.',
  todos: 'Show the current to-do list.',
  usage: 'Show plan usage limits.',
};

const strings = a => (Array.isArray(a) ? a.filter(s => typeof s === 'string' && s) : []);
const cliTool = (kind, name, description = '') => ({
  kind, name, description: description || (kind === 'command' && Object.hasOwn(BUILTIN_COMMANDS, name) ? BUILTIN_COMMANDS[name] : ''), source: 'cli', path: null,
});

// init: a conversation's init event, plus `commands` ([{ name, description }]):
// its latest commands_changed list, which is where commands a mod registers
// once the session has started show up.
function mergeInit(toolbox, init) {
  const tb = toolbox || {};
  const copy = k => (Array.isArray(tb[k]) ? tb[k].map(t => ({ ...t })) : []);
  const out = { skills: copy('skills'), agents: copy('agents'), commands: copy('commands'), mcp: [], mods: copy('mods'), scannedAt: tb.scannedAt || Date.now() };
  if (!init || typeof init !== 'object') {
    out.mcp = copy('mcp');
    return out;
  }
  const have = { skill: new Set(out.skills.map(t => t.name)), agent: new Set(out.agents.map(t => t.name)), command: new Set(out.commands.map(t => t.name)) };
  const add = (list, kind, name, description) => {
    if (have[kind].has(name)) return;
    have[kind].add(name);
    list.push(cliTool(kind, name, description));
  };
  for (const n of strings(init.skills)) add(out.skills, 'skill', n);
  for (const n of strings(init.agents)) add(out.agents, 'agent', n);
  const said = new Map();
  for (const c of Array.isArray(init.commands) ? init.commands : []) {
    if (c && typeof c.name === 'string' && c.name && !said.has(c.name)) said.set(c.name, typeof c.description === 'string' ? cleanDesc(c.description) : '');
  }
  for (const n of [...strings(init.slash_commands), ...said.keys()]) {
    if (!have.skill.has(n)) add(out.commands, 'command', n, said.get(n));
  }
  const seen = new Set();
  for (const s of Array.isArray(init.mcp_servers) ? init.mcp_servers : []) {
    if (!s || typeof s.name !== 'string' || !s.name || seen.has(s.name)) continue;
    seen.add(s.name);
    out.mcp.push({ kind: 'mcp', name: s.name, description: '', source: typeof s.source === 'string' && s.source ? s.source : 'cli', path: null, status: typeof s.status === 'string' ? s.status : 'unknown' });
  }
  for (const k of ['skills', 'agents', 'commands', 'mcp']) out[k] = out[k].sort(byName).slice(0, MAX_ITEMS);
  return out;
}

// ---- watcher

const ALL = tb => [...(tb.skills || []), ...(tb.agents || []), ...(tb.commands || []), ...(tb.mcp || []), ...(tb.mods || [])];
// A mod is known by its plugin id: two marketplaces can each have one called "tidy".
const key = t => (t.kind === 'mod' ? `mod:${t.id}` : `${t.kind}:${t.name}`);
const signature = tb => ALL(tb).map(t => `${key(t)}:${t.description}:${t.path}:${t.status || ''}${t.kind === 'mod' ? `:${t.enabled}:${t.version}:${t.tests}` : ''}`).join('\n');

const MAX_SEEN = 5000;
const MAX_LAUNCH_NEWS = 3;
const MODS_MARK = 'mod:*';      // in seen once mods have been looked for: later ones are news
const PLUGIN_EVERY_POLLS = 10;   // with the minute's poll: plugin dirs re-read every ten minutes

// null: no file (or a broken one), so this is as good as a first launch.
function loadSeen(file) {
  if (!file) return null;
  try {
    const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(keys) ? keys.filter(k => typeof k === 'string').slice(-MAX_SEEN) : null;
  } catch { return null; }
}

class ToolboxWatcher extends EventEmitter {
  /**
   * seenFile: where the keys of everything seen are kept between launches, so a
   * skill written while Shellby was closed is still news when it starts.
   */
  /**
   * getInstalled: () => marketplace plugins as the Skill Shop last listed them
   * ({ id, marketplace, dir, enabled, scope }), for the mods among them.
   * getSettings: () => [user, project, local] Claude Code settings objects, for
   * which of your own mods are turned off.
   */
  constructor({ home, getCwd, getPlugins, getInstalled, getSettings, debounceMs = 800, pollMs = 60000, fsImpl = fs, seenFile = null, log = null } = {}) {
    super();
    this.home = home;
    this.getCwd = typeof getCwd === 'function' ? getCwd : () => null;
    this.getPlugins = typeof getPlugins === 'function' ? getPlugins : () => [];
    this.getInstalled = typeof getInstalled === 'function' ? getInstalled : () => [];
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => [];
    this.commands = null;   // the last commands_changed list, which is where mods' commands show up
    this.debounceMs = debounceMs;
    this.pollMs = pollMs;
    this.fs = fsImpl;
    this.log = log;
    this.watchers = [];
    this.watchKey = '';
    this.debounce = null;
    this.poll = null;
    this.scan = null;       // last raw scanToolbox result
    this.init = null;       // last CLI init event
    this.merged = null;     // scan + init
    this.sig = null;
    this.seenFile = seenFile;
    const saved = loadSeen(seenFile);
    this.seen = new Set(saved || []);  // every item key ever scanned: a trick is only "learned" once
    this.restored = saved !== null;    // a first launch has nothing to compare with, so it announces nothing
    this.metaCache = new Map();
    this.pluginCache = new Map();
    this.pluginKey = '';
    this.started = false;
  }

  get current() {
    return this.merged || mergeInit({ skills: [], agents: [], commands: [], mcp: [], mods: [], scannedAt: 0 }, this.initWithCommands());
  }

  initWithCommands() {
    return this.commands ? { ...(this.init || {}), commands: this.commands } : this.init;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.refresh(true);
    if (this.pollMs > 0) {
      // Plugin dirs are read again every so often: a local plugin can be edited in place.
      let polls = 0;
      this.poll = setInterval(() => this.rescan({ plugins: ++polls % PLUGIN_EVERY_POLLS === 0 }), this.pollMs);
      this.poll.unref?.();
    }
  }

  stop() {
    this.started = false;
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    this.debounce = this.poll = null;
    this.closeWatchers();
  }

  // Asked for (the Rescan button, an install): read plugin dirs again too,
  // unless it's for a change to your own files ({ plugins: false }).
  rescan({ plugins = true } = {}) {
    clearTimeout(this.debounce);
    this.debounce = null;
    if (plugins) this.pluginCache.clear();
    this.refresh(false);
    return this.current;
  }

  setInit(init) {
    this.init = init && typeof init === 'object' ? init : null;
    this.commands = null; // a new conversation's list starts from its own init
    // Init may bring a plugin list we haven't scanned yet: pick it up now.
    if (this.scan && this.pluginsKey(this.plugins()) !== this.pluginKey) this.refresh(false);
    this.remerge(true);
  }

  // A conversation's commands_changed: every command it has now, mods' included.
  setCommands(commands) {
    if (!Array.isArray(commands)) return;
    this.commands = commands;
    this.remerge(false);
  }

  remerge(always) {
    this.merged = mergeInit(this.scan || { skills: [], agents: [], commands: [], mcp: [], mods: [], scannedAt: 0 }, this.initWithCommands());
    const sig = signature(this.merged);
    if (!always && sig === this.sig) return;
    this.sig = sig;
    this.emit('changed', this.merged);
  }

  // ---- internals

  plugins() {
    let p = null;
    try { p = this.getPlugins(); } catch {}
    if (Array.isArray(p) && p.length) return p;
    return this.init && Array.isArray(this.init.plugins) ? this.init.plugins : [];
  }

  scanMods() {
    const get = fn => { try { const v = fn(); return Array.isArray(v) ? v : []; } catch { return []; } };
    try {
      return scanMods({ home: this.home, installed: get(this.getInstalled), loaded: this.init && Array.isArray(this.init.plugins) ? this.init.plugins : [], settings: get(this.getSettings) });
    } catch (err) {
      this.log?.warn?.(`toolbox: couldn't look for mods: ${err.message}`);
      return [];
    }
  }

  pluginsKey(plugins) {
    return plugins.filter(p => p && p.name && p.path).map(p => `${p.name}=${p.path}`).sort().join('|');
  }

  refresh(initial) {
    let cwd = null;
    try { cwd = this.getCwd(); } catch {}
    const plugins = this.plugins();
    const prevPlugins = this.pluginKey;
    let scan;
    try { scan = scanToolbox({ home: this.home, cwd, plugins, metaCache: this.metaCache, pluginCache: this.pluginCache }); } catch { return; }
    scan.mods = this.scanMods();
    const prev = this.scan;
    this.scan = scan;
    this.pluginKey = this.pluginsKey(plugins);
    this.merged = mergeInit(scan, this.initWithCommands());
    this.syncWatchers(cwd);

    // Diff against everything seen, not just the last scan: items can flicker
    // (a plugin reported at two cached versions, a skill deleted and put back).
    const announce = !initial && prev;
    // A plugin dir we've never scanned before isn't a "new trick" item by item.
    // That includes a known plugin at another cached version: sessions can
    // report 0.2.2 and 0.2.6 side by side, and what 0.2.6 adds is an update,
    // not something Claude wrote itself. (seen is lost on restart, so keying on
    // the plugin name alone re-announced those on every launch.)
    const knownDirs = prevPlugins.split('|').filter(Boolean).map(s => s.slice(s.indexOf('=') + 1));
    // At launch, only your own (~/.claude) count: the folder Shellby starts in
    // may be a project it has never looked at, and plugins are updates.
    // A handful at most, so a folder copied in wholesale isn't a notification storm.
    const atLaunch = initial && this.restored;
    let grew = false;
    let launchNews = 0;
    for (const t of [...scan.skills, ...scan.agents, ...scan.commands]) {
      if (this.seen.has(key(t))) continue;
      this.seen.add(key(t));
      grew = true;
      if (atLaunch ? t.source !== 'user' || ++launchNews > MAX_LAUNCH_NEWS : !announce || t.source === 'cli') continue;
      if (t.source.startsWith('plugin:') && !knownDirs.some(d => isInside(t.path, d))) continue;
      this.emit('learned', { kind: t.kind, name: t.name, description: t.description, path: t.path, source: t.source });
    }
    // A mod of your own that wasn't here before: Claude Code loads it in every
    // session without asking, so it's news even at launch (a handful of its
    // own). One from a marketplace came with an install you confirmed, or is an
    // update. The first look ever (a first launch, or the first since Shellby
    // knew about mods) only takes note: those were already there.
    const modsKnown = this.seen.has(MODS_MARK);
    let modNews = 0;
    for (const m of scan.mods) {
      if (this.seen.has(key(m))) continue;
      this.seen.add(key(m));
      grew = true;
      if (m.source !== 'user' || !modsKnown || (atLaunch && ++modNews > MAX_LAUNCH_NEWS)) continue;
      this.emit('learned', { kind: 'mod', id: m.id, name: m.name, description: m.description, path: m.path, source: m.source, enabled: m.enabled });
    }
    if (!modsKnown) { this.seen.add(MODS_MARK); grew = true; }
    // A first launch saves even an empty list, so the next one has something to compare with.
    if (grew || (initial && !this.restored)) this.saveSeen();
    const sig = signature(this.merged);
    if (sig !== this.sig) {
      this.sig = sig;
      this.emit('changed', this.merged);
    }
  }

  saveSeen() {
    if (!this.seenFile) return;
    const keys = [...this.seen].slice(-MAX_SEEN);
    const tmp = `${this.seenFile}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.seenFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(keys));
      fs.renameSync(tmp, this.seenFile);
    } catch (err) {
      this.log?.warn?.(`toolbox: couldn't save what it has seen: ${err.message}`);
    }
  }

  watchDirs(cwd) {
    const roots = [];
    if (this.home) roots.push(path.join(this.home, '.claude'));
    if (cwd && !(this.home && samePath(cwd, this.home))) roots.push(path.join(cwd, '.claude'));
    const dirs = [];
    for (const r of roots) {
      for (const k of KINDS) {
        const d = path.join(r, k);
        try { if (this.fs.statSync(d).isDirectory()) dirs.push(d); } catch {}
      }
    }
    return dirs;
  }

  // (Re)attach fs watchers when the set of existing dirs changes (new cwd, new dir).
  syncWatchers(cwd) {
    if (!this.started) return;
    const dirs = this.watchDirs(cwd);
    const k = dirs.join('|');
    if (k === this.watchKey && this.watchers.length === dirs.length) return;
    this.closeWatchers();
    this.watchKey = k;
    for (const d of dirs) {
      try {
        const w = this.fs.watch(d, { recursive: true }, () => this.schedule());
        w.on?.('error', () => {
          try { w.close(); } catch {}
          this.watchers = this.watchers.filter(x => x !== w);
        });
        w.unref?.();
        this.watchers.push(w);
      } catch { /* unsupported or vanished: the poll still covers it */ }
    }
  }

  closeWatchers() {
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers = [];
    this.watchKey = '';
  }

  schedule() {
    if (!this.started) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; if (this.started) this.refresh(false); }, this.debounceMs);
    this.debounce.unref?.();
  }
}

module.exports = { scanToolbox, parseFrontmatter, mergeInit, ToolboxWatcher, walkMd, samePath, BUILTIN_COMMANDS };
