// The MCP servers a workflow step or a routine can use, and how to hand them to
// Claude Code: which ones exist, the permission rules that let Claude use a
// server's tools without asking, and the definitions to load when a step wants
// only its own servers (--strict-mcp-config).
//
// Read from the same files Claude Code keeps them in (mcpadmin.js does the
// adding and removing): local and user scope in ~/.claude.json, project scope
// in the folder's .mcp.json. Plugin servers come from the Toolbox's live list;
// they can be allowed, but not loaded on their own or called directly, since
// their definition lives inside the plugin.
//
// A project's .mcp.json comes with the repository, so anyone who can push to it
// can change the command it runs. Claude Code only starts one after you've
// approved it, and Shellby keeps to the same rule: a project server you haven't
// approved in Claude Code is never loaded or started from here.
const fs = require('fs');
const path = require('path');

const NAME = /^[A-Za-z0-9][\w.:@/-]{0,99}$/;
const MAX_SERVERS = 10;
const TRANSPORTS = ['stdio', 'http', 'sse'];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.hasOwn(o, k);

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch { return null; }
}

/** A server's name as it appears in its tools' names: mcp__<this>__tool. */
const toolPrefix = name => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

/** The --allowedTools rules that let Claude use every tool of these servers unasked. */
const allowRules = names => [...new Set((names || []).map(n => `mcp__${toolPrefix(n)}__*`))];

/**
 * A list of server names from untrusted input -> { list } or { error }.
 * Order kept, duplicates dropped.
 */
function checkNames(v) {
  if (v === undefined || v === null) return { list: [] };
  if (!Array.isArray(v)) return { error: 'MCP servers must be a list of names' };
  const list = [];
  for (const n of v) {
    const name = typeof n === 'string' ? n.trim() : '';
    if (!NAME.test(name)) return { error: `“${String(n).slice(0, 40)}” isn't an MCP server name` };
    if (!list.includes(name)) list.push(name);
  }
  if (list.length > MAX_SERVERS) return { error: `Pick at most ${MAX_SERVERS} MCP servers` };
  return { list };
}

const transportOf = def => (TRANSPORTS.includes(def?.type) ? def.type : def?.url ? 'http' : 'stdio');

function projectEntry(global, cwd) {
  if (!cwd || !isObj(global?.projects)) return null;
  const want = path.resolve(cwd).toLowerCase();
  const key = Object.keys(global.projects).find(k => path.resolve(k).toLowerCase() === want);
  return key ? global.projects[key] : null;
}

/**
 * Has the user approved this .mcp.json server, by name, in Claude Code? Only
 * places the repository can't write count: ~/.claude.json's entry for the
 * folder, and ~/.claude/settings.json. A refusal anywhere wins.
 *
 * "Allow every project server" (enableAllProjectMcpServers) isn't enough here:
 * Shellby starts the server itself, with no Claude Code session around it, so
 * any repository you open would get to choose a program for it to run.
 */
function projectApproved(name, { global, settings, cwd }) {
  const entry = projectEntry(global, cwd) || {};
  const sources = [entry, settings || {}];
  const listed = (o, k) => Array.isArray(o?.[k]) && o[k].includes(name);
  if (sources.some(o => listed(o, 'disabledMcpjsonServers'))) return false;
  return sources.some(o => listed(o, 'enabledMcpjsonServers'));
}

// A network share is never read: opening one makes Windows sign in to that machine.
const isShare = p => /^[\\/]{2}/.test(String(p || ''));

function readAll({ home, cwd: raw }) {
  const cwd = isShare(raw) ? null : raw;
  const global = home ? readJson(path.join(home, '.claude.json')) : null;
  const settings = home ? readJson(path.join(home, '.claude', 'settings.json')) : null;
  const shared = cwd ? readJson(path.join(cwd, '.mcp.json'))?.mcpServers : null;
  return { global, settings, shared: isObj(shared) ? shared : null, local: projectEntry(global, cwd)?.mcpServers };
}

/**
 * The server named `name`, as Claude Code would find it for `cwd` (local,
 * then project, then user). -> { ok, scope, def } or { ok: false, error }.
 */
function resolveServer(name, { home, cwd } = {}) {
  const all = readAll({ home, cwd });
  if (has(all.local, name) && isObj(all.local[name])) return { ok: true, scope: 'local', def: all.local[name] };
  if (has(all.shared, name) && isObj(all.shared[name])) {
    if (!projectApproved(name, { ...all, cwd })) {
      return { ok: false, error: `“${name}” comes from this project's .mcp.json and hasn't been approved by name in Claude Code. Open the project in Claude Code and allow it (Shellby doesn't count “allow every project server”), or add it to your own servers.` };
    }
    return { ok: true, scope: 'project', def: all.shared[name] };
  }
  if (has(all.global?.mcpServers, name) && isObj(all.global.mcpServers[name])) return { ok: true, scope: 'user', def: all.global.mcpServers[name] };
  if (name.includes(':') || name.startsWith('plugin_')) {
    return { ok: false, error: `“${name}” comes with a plugin, so Shellby can't start it on its own. A Claude step can still use it with “Only these servers” off.` };
  }
  return { ok: false, error: `There's no MCP server called “${name}” for ${cwd || 'this folder'}. Add it in Toolbox → MCP first.` };
}

/**
 * For --mcp-config: every named server's definition, or the first one that
 * can't be loaded on its own. -> { ok, config: { mcpServers } } or { ok: false, error }.
 */
function configFor(names, opts) {
  const mcpServers = {};
  for (const n of names || []) {
    const r = resolveServer(n, opts);
    if (!r.ok) return r;
    mcpServers[n] = r.def;
  }
  return { ok: true, config: { mcpServers } };
}

/**
 * Every server a step could pick for `cwd`: the ones in Claude Code's files,
 * then the Toolbox's live list (plugin servers, claude.ai connectors).
 * live: [{ name, source }]. -> [{ name, scope, transport, direct }]
 * direct: Shellby can load it alone and call its tools itself.
 */
function listServers({ home, cwd, live = [] } = {}) {
  const all = readAll({ home, cwd });
  const out = new Map();
  const add = (name, scope, def, direct) => {
    if (!NAME.test(name) || out.has(name)) return;
    out.set(name, { name, scope, transport: def ? transportOf(def) : null, direct });
  };
  for (const [n, def] of Object.entries(all.local || {})) add(n, 'local', def, isObj(def));
  for (const [n, def] of Object.entries(all.shared || {})) add(n, 'project', def, isObj(def) && projectApproved(n, { ...all, cwd }));
  for (const [n, def] of Object.entries(all.global?.mcpServers || {})) add(n, 'user', def, isObj(def));
  for (const s of Array.isArray(live) ? live : []) {
    if (typeof s?.name === 'string' && s.name !== 'shellby') add(s.name, 'plugin', null, false);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * ${VAR} and ${VAR:-default} in a definition, filled in the way Claude Code
 * does for .mcp.json. An unset variable with no default becomes ''.
 */
function expandEnv(v, env = process.env) {
  if (typeof v === 'string') {
    return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d ?? ''));
  }
  if (Array.isArray(v)) return v.map(x => expandEnv(x, env));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x, env)]));
  return v;
}

module.exports = { NAME, MAX_SERVERS, toolPrefix, allowRules, checkNames, resolveServer, configFor, listServers, expandEnv, transportOf, projectApproved };
