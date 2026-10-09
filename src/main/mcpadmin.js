// Adding and removing MCP servers, the way `claude mcp add` / `claude mcp
// remove` (and /mcp in the terminal) do. main.js runs the CLI with the
// arguments built here, only after the confirm window says yes, since an MCP
// server is a program Claude Code will start by itself in every session.
//
// Validation and argument building are pure; findServer reads Claude Code's
// config files. See test/mcpadmin.test.js.
const fs = require('fs');
const path = require('path');

const SCOPES = ['local', 'project', 'user'];
const TRANSPORTS = ['stdio', 'http', 'sse'];
const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAX_TARGET = 1000;
const MAX_PAIRS = 20;
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * Split a command line into words: spaces separate, double or single quotes
 * group, and a backslash is just a character (Windows paths keep theirs).
 */
function splitArgs(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(line || '')) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
    } else {
      cur += ch; started = true;
    }
  }
  if (quote) return null; // an unclosed quote
  if (started || cur) out.push(cur);
  return out;
}

// "KEY=value" lines (env) or "Name: value" lines (headers), blanks skipped.
function pairs(text, sep) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > MAX_PAIRS) return { error: `At most ${MAX_PAIRS} of those.` };
  const out = [];
  for (const l of lines) {
    const at = l.indexOf(sep);
    const key = at > 0 ? l.slice(0, at).trim() : '';
    const value = at > 0 ? l.slice(at + 1).trim() : '';
    if (!key || CONTROL.test(l)) return { error: sep === '=' ? `Write each variable as NAME=value ("${l.slice(0, 40)}" isn't).` : `Write each header as Name: value ("${l.slice(0, 40)}" isn't).` };
    if (sep === '=' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: `${key} isn't a variable name.` };
    if (sep === ':' && !HEADER.test(key)) return { error: `${key} isn't a header name.` };
    out.push(sep === '=' ? `${key}=${value}` : `${key}: ${value}`);
  }
  return { list: out };
}

// npx, pnpm and the rest are .cmd scripts on Windows, which Claude Code can't
// start as a server by themselves: its docs say to run them through `cmd /c`.
// (One typed as `cmd /c npx …` already is, and is left alone.)
const CMD_SHIM = /^(?:npx|npm|pnpm|pnpx|yarn|bunx)(?:\.cmd)?$/i;

/** A stdio server's words -> the ones that start it on this platform. Pure. */
function withCmdWrapper(words, platform = process.platform) {
  if (platform !== 'win32' || !words.length) return words;
  return CMD_SHIM.test(path.win32.basename(words[0])) ? ['cmd', '/c', ...words] : words;
}

/**
 * input: { name, transport, target, scope, env, headers }
 * -> { args, summary } for `claude <args>`, or { error }.
 * target is the command line (stdio) or the URL (http, sse).
 *
 * -e and --header each take several values, so "--" ends the options before
 * the name: everything after it is the name, then the command or URL (checked
 * against the real CLI). On Windows, npx and friends get `cmd /c` in front
 * (withCmdWrapper), and summary.target says so: the confirm window shows what runs.
 */
function addArgs(input, { platform = process.platform } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const name = String(i.name || '').trim();
  if (!NAME.test(name)) return { error: 'Give it a short name: letters, numbers, dots, dashes or underscores.' };
  const transport = TRANSPORTS.includes(i.transport) ? i.transport : 'stdio';
  const scope = SCOPES.includes(i.scope) ? i.scope : 'local';
  const target = String(i.target || '').trim();
  if (!target) return { error: transport === 'stdio' ? 'Type the command that starts the server.' : 'Paste the server\'s URL.' };
  if (target.length > MAX_TARGET || CONTROL.test(target)) return { error: 'Keep it on one line, under 1000 characters.' };
  const args = ['mcp', 'add', '--scope', scope, '--transport', transport];
  if (transport === 'stdio') {
    const env = pairs(i.env, '=');
    if (env.error) return env;
    const typed = splitArgs(target);
    if (!typed || !typed.length) return { error: 'That command has a quote that never closes.' };
    const words = withCmdWrapper(typed, platform);
    for (const e of env.list) args.push('-e', e);
    args.push('--', name, ...words);
    const shown = words === typed ? target : `cmd /c ${target}`;
    return { args, summary: { name, transport, scope, target: shown, env: env.list.map(e => e.split('=')[0]) } };
  }
  let url;
  try { url = new URL(target); } catch { return { error: "That isn't a URL." }; }
  if (!/^https?:$/.test(url.protocol)) return { error: 'The URL needs to start with https:// (or http:// for a server on this PC).' };
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return { error: 'Use https:// for a server that isn\'t on this PC.' };
  const headers = pairs(i.headers, ':');
  if (headers.error) return headers;
  for (const h of headers.list) args.push('--header', h);
  args.push('--', name, url.href);
  return { args, summary: { name, transport, scope, target: url.href, headers: headers.list.map(h => h.split(':')[0]) } };
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch { return null; }
}

/**
 * Where a server named `name` was added, read from the files Claude Code keeps
 * them in, never by asking the CLI (which starts a server to check on it):
 * local and user scope in ~/.claude.json, project scope in the folder's
 * .mcp.json. -> { scope, target } | null
 */
function findServer(name, { home, cwd } = {}) {
  const has = (o, k) => !!o && typeof o === 'object' && Object.hasOwn(o, k);
  const describe = s => (s && typeof s === 'object'
    ? String(s.url || [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter(Boolean).join(' ')).slice(0, 300)
    : '');
  const global = home ? readJson(path.join(home, '.claude.json')) : null;
  if (global && cwd && global.projects && typeof global.projects === 'object') {
    const key = Object.keys(global.projects).find(k => path.resolve(k).toLowerCase() === path.resolve(cwd).toLowerCase());
    const local = key ? global.projects[key]?.mcpServers : null;
    if (has(local, name)) return { scope: 'local', target: describe(local[name]) };
  }
  const shared = cwd ? readJson(path.join(cwd, '.mcp.json'))?.mcpServers : null;
  if (has(shared, name)) return { scope: 'project', target: describe(shared[name]) };
  if (has(global?.mcpServers, name)) return { scope: 'user', target: describe(global.mcpServers[name]) };
  return null;
}

/** `claude mcp remove`, for a server that lives in one of the three scopes. */
function removeArgs(name, scope) {
  if (!NAME.test(String(name || ''))) return { error: 'Unknown server.' };
  if (!SCOPES.includes(scope)) return { error: 'Shellby can only remove servers you added (yours, this project\'s or just-you-here). Plugin servers go with their plugin.' };
  return { args: ['mcp', 'remove', '--scope', scope, name] };
}

/**
 * What `claude mcp get <name>` says about a server: the scope it lives in
 * (from the remove hint it prints), its status and where it connects.
 */
function parseGet(text) {
  const t = String(text || '');
  const scope = /claude mcp remove \S+ -s (local|project|user)\b/.exec(t)?.[1] || null;
  const field = k => new RegExp(`^\\s*${k}:\\s*(.+)$`, 'mi').exec(t)?.[1].trim() || null;
  return { scope, status: field('Status'), type: field('Type'), target: field('URL') || field('Command') };
}

/**
 * The sign-in page mcp_authenticate handed back, if it's one to open in the
 * browser: https, or http on this PC (a local server's own page). -> href | null
 */
function signInUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8000 || CONTROL.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href;
  return null;
}

const SCOPE_WORDS = {
  local: 'just you, in this project',
  project: "this project's shared .mcp.json, so everyone who opens it",
  user: 'you, in every project',
};

module.exports = { splitArgs, addArgs, removeArgs, parseGet, findServer, signInUrl, SCOPES, TRANSPORTS, SCOPE_WORDS };
