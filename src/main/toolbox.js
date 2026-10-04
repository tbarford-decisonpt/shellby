// The toolbox: everything Claude Code can reach for — skills, subagents, slash
// commands and MCP servers — gathered from ~/.claude, the project's .claude and
// any plugins, so the UI can list and pin them. ToolboxWatcher keeps it fresh and
// announces when a new skill/agent/command shows up on disk ("learned a new trick").
// Read-only: nothing here ever writes to the user's Claude config (removing one of
// your own skills, agents or commands is skillremove.js, and asks first).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

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
// when the skill, command or agent is called.
function readMeta(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const text = fs.readFileSync(file, 'utf8');
    const fm = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
    return { ...parseFrontmatter(text), bodyChars: text.length - (fm ? fm[0].length : 0) };
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
function scanRoot(root, source, prefix) {
  const found = { skills: [], agents: [], commands: [] };
  const named = n => (prefix ? `${prefix}:${n}` : n);
  for (const e of readdir(path.join(root, 'skills'))) {
    const dir = path.join(root, 'skills', e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(dir)))) continue;
    const file = path.join(dir, 'SKILL.md');
    const meta = readMeta(file);
    if (meta) found.skills.push(tool('skill', e.name, meta, source, file));
  }
  for (const { file, parts } of walkMd(path.join(root, 'agents'))) {
    const meta = readMeta(file);
    if (meta) found.agents.push(tool('agent', parts[parts.length - 1], meta, source, file));
  }
  for (const { file, parts } of walkMd(path.join(root, 'commands'))) {
    const meta = readMeta(file);
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

function scanToolbox({ home, cwd, plugins = [] } = {}) {
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
    const found = scanRoot(r.dir, r.source, r.prefix);
    for (const k of KINDS) {
      for (const t of found[k]) {
        const prev = maps[k].get(t.name);
        if (!prev || r.rank > prev.rank) maps[k].set(t.name, { rank: r.rank, t });
      }
    }
  }
  const list = k => [...maps[k].values()].map(v => v.t).sort(byName).slice(0, MAX_ITEMS);
  return { skills: list('skills'), agents: list('agents'), commands: list('commands'), mcp: [], scannedAt: Date.now() };
}

// ---- CLI init merge

const strings = a => (Array.isArray(a) ? a.filter(s => typeof s === 'string' && s) : []);
const cliTool = (kind, name) => ({ kind, name, description: '', source: 'cli', path: null });

function mergeInit(toolbox, init) {
  const tb = toolbox || {};
  const copy = k => (Array.isArray(tb[k]) ? tb[k].map(t => ({ ...t })) : []);
  const out = { skills: copy('skills'), agents: copy('agents'), commands: copy('commands'), mcp: [], scannedAt: tb.scannedAt || Date.now() };
  if (!init || typeof init !== 'object') {
    out.mcp = copy('mcp');
    return out;
  }
  const have = { skill: new Set(out.skills.map(t => t.name)), agent: new Set(out.agents.map(t => t.name)), command: new Set(out.commands.map(t => t.name)) };
  const add = (list, kind, name) => {
    if (have[kind].has(name)) return;
    have[kind].add(name);
    list.push(cliTool(kind, name));
  };
  for (const n of strings(init.skills)) add(out.skills, 'skill', n);
  for (const n of strings(init.agents)) add(out.agents, 'agent', n);
  for (const n of strings(init.slash_commands)) {
    if (!have.skill.has(n)) add(out.commands, 'command', n);
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

const ALL = tb => [...(tb.skills || []), ...(tb.agents || []), ...(tb.commands || []), ...(tb.mcp || [])];
const key = t => `${t.kind}:${t.name}`;
const signature = tb => ALL(tb).map(t => `${key(t)}:${t.description}:${t.path}:${t.status || ''}`).join('\n');

class ToolboxWatcher extends EventEmitter {
  constructor({ home, getCwd, getPlugins, debounceMs = 800, pollMs = 60000, fsImpl = fs } = {}) {
    super();
    this.home = home;
    this.getCwd = typeof getCwd === 'function' ? getCwd : () => null;
    this.getPlugins = typeof getPlugins === 'function' ? getPlugins : () => [];
    this.debounceMs = debounceMs;
    this.pollMs = pollMs;
    this.fs = fsImpl;
    this.watchers = [];
    this.watchKey = '';
    this.debounce = null;
    this.poll = null;
    this.scan = null;       // last raw scanToolbox result
    this.init = null;       // last CLI init event
    this.merged = null;     // scan + init
    this.sig = null;
    this.seen = new Set();  // every item key ever scanned: a trick is only "learned" once
    this.pluginKey = '';
    this.started = false;
  }

  get current() {
    return this.merged || mergeInit({ skills: [], agents: [], commands: [], mcp: [], scannedAt: 0 }, this.init);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.refresh(true);
    if (this.pollMs > 0) {
      this.poll = setInterval(() => this.rescan(), this.pollMs);
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

  rescan() {
    clearTimeout(this.debounce);
    this.debounce = null;
    this.refresh(false);
    return this.current;
  }

  setInit(init) {
    this.init = init && typeof init === 'object' ? init : null;
    // Init may bring a plugin list we haven't scanned yet: pick it up now.
    if (this.scan && this.pluginsKey(this.plugins()) !== this.pluginKey) this.refresh(false);
    this.merged = mergeInit(this.scan || { skills: [], agents: [], commands: [], mcp: [], scannedAt: 0 }, this.init);
    this.sig = signature(this.merged);
    this.emit('changed', this.merged);
  }

  // ---- internals

  plugins() {
    let p = null;
    try { p = this.getPlugins(); } catch {}
    if (Array.isArray(p) && p.length) return p;
    return this.init && Array.isArray(this.init.plugins) ? this.init.plugins : [];
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
    try { scan = scanToolbox({ home: this.home, cwd, plugins }); } catch { return; }
    const prev = this.scan;
    this.scan = scan;
    this.pluginKey = this.pluginsKey(plugins);
    this.merged = mergeInit(scan, this.init);
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
    for (const t of [...scan.skills, ...scan.agents, ...scan.commands]) {
      if (this.seen.has(key(t))) continue;
      this.seen.add(key(t));
      if (!announce || t.source === 'cli') continue;
      if (t.source.startsWith('plugin:') && !knownDirs.some(d => isInside(t.path, d))) continue;
      this.emit('learned', { kind: t.kind, name: t.name, description: t.description, path: t.path, source: t.source });
    }
    const sig = signature(this.merged);
    if (sig !== this.sig) {
      this.sig = sig;
      this.emit('changed', this.merged);
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

module.exports = { scanToolbox, parseFrontmatter, mergeInit, ToolboxWatcher, walkMd, samePath };
