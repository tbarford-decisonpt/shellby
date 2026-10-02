#!/usr/bin/env node
// The `shellby` command: hand work to the crab from any terminal, or ask him
// how things are. For a thing named after a shell, not being usable from one
// was a bit of an oversight.
//
//   shellby do "tidy my Downloads folder"   hand a task to Shellby
//   shellby say "all green"                 put a line in his speech bubble
//   shellby status                          how the crab and this PC are doing
//
// Self-contained plain Node (builtins only): Shellby copies this file next to
// its shim in %LOCALAPPDATA%\Shellby\bin, so it never has to be read out of the
// packaged app. It talks to the running Shellby over 127.0.0.1 and nothing else.
//
// Starting a task spends the user's Claude subscription and runs code on their
// PC, so unlike the MCP server's cosmetic actions this needs the token Shellby
// writes into its own settings folder, and by default Shellby still asks before
// it runs anything.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.SHELLBY_PORT) || 47913;
const TIMEOUT_MS = 8000;
const MAX_PROMPT = 4000;
const MODES = ['ask', 'smart', 'acceptEdits', 'plan'];   // deliberately not autonomous

const EXIT = { ok: 0, error: 1, usage: 2, notRunning: 3, denied: 4 };

const USAGE = `shellby - the desktop crab, from your terminal

  shellby do <task...>        hand a task to Shellby, in this folder
  shellby say <text...>       put a short line in his speech bubble
  shellby status              how the crab and this PC are doing
  shellby help                this
  shellby version

Options for "do":
  -C, --dir <path>     run the task somewhere else (default: this folder)
  -m, --mode <mode>    ${MODES.join(' | ')}  (default: whatever Shellby is set to)
  -q, --quiet          print nothing unless it fails

Shellby has to be running. He will ask you before starting the task unless you
have turned that off in Settings.`;

// ------------------------------------------------------------------ plumbing

const out = s => process.stdout.write(`${s}\n`);
const err = s => process.stderr.write(`${s}\n`);

const markerPath = () => path.join(os.tmpdir(), `shellby-hooks-${PORT}`);

/**
 * The token Shellby writes into its settings folder. Anything running as this
 * user can read it, which is the point: it keeps out web pages and other
 * accounts, not the user's own programs.
 */
function readToken() {
  if (process.env.SHELLBY_TOKEN) return process.env.SHELLBY_TOKEN.trim();
  const dirs = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Shellby'),
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'Shellby'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Shellby'),
    path.join(os.homedir(), '.config', 'Shellby'),
  ].filter(Boolean);
  for (const d of dirs) {
    try {
      const t = fs.readFileSync(path.join(d, 'cli-token'), 'utf8').trim();
      if (t) return t;
    } catch { /* try the next one */ }
  }
  return null;
}

/** POST one request to the running Shellby. Resolves; never rejects. */
function post(route, payload, { token } = {}) {
  return new Promise(resolve => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'X-Shellby': '1',
    };
    if (token) headers['X-Shellby-Token'] = token;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: route, method: 'POST', headers, timeout: TIMEOUT_MS }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size < 256 * 1024) chunks.push(c); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* no body */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'Shellby did not answer in time.' }); });
    req.on('error', e => resolve({ status: 0, error: e.code === 'ECONNREFUSED' ? 'nothing is listening' : e.message }));
    req.end(body);
  });
}

function notRunning() {
  err('Shellby is not running. Start him and try again.');
  return EXIT.notRunning;
}

// ------------------------------------------------------------------ arguments

/**
 * argv (without node and the script) -> a checked command.
 *   { cmd, prompt?, dir?, mode?, quiet? } | { error } | { usage: true }
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const first = args.shift();
  if (!first || first === 'help' || first === '--help' || first === '-h') return { usage: true };
  if (first === 'version' || first === '--version' || first === '-v') return { cmd: 'version' };
  if (first === 'status') return { cmd: 'status' };

  if (first === 'say') {
    const text = args.join(' ').trim();
    return text ? { cmd: 'say', text } : { error: 'Say what? (shellby say "all green")' };
  }

  if (first === 'do') {
    const opts = { cmd: 'do', quiet: false, dir: null, mode: null };
    const words = [];
    while (args.length) {
      const a = args.shift();
      if (a === '-q' || a === '--quiet') opts.quiet = true;
      else if (a === '-C' || a === '--dir') {
        const d = args.shift();
        if (!d) return { error: `${a} needs a folder.` };
        opts.dir = d;
      } else if (a === '-m' || a === '--mode') {
        const m = args.shift();
        if (!MODES.includes(m)) return { error: `--mode has to be one of: ${MODES.join(', ')}` };
        opts.mode = m;
      } else if (a === '--') words.push(...args.splice(0));
      else if (a.startsWith('-') && a.length > 1) return { error: `Unknown option: ${a}` };
      else words.push(a);
    }
    const prompt = words.join(' ').trim();
    if (!prompt) return { error: 'What should he do? (shellby do "tidy my Downloads")' };
    if (prompt.length > MAX_PROMPT) return { error: `That task is longer than ${MAX_PROMPT} characters.` };
    return { ...opts, prompt };
  }

  return { error: `Unknown command: ${String(first).slice(0, 30)}. Try "shellby help".` };
}

// ------------------------------------------------------------------ commands

async function main(argv) {
  const cmd = parseArgs(argv);
  if (cmd.usage) { out(USAGE); return EXIT.ok; }
  if (cmd.error) { err(cmd.error); return EXIT.usage; }
  if (cmd.cmd === 'version') { out(readVersion()); return EXIT.ok; }

  // The marker file means a fast, clear answer instead of a connection timeout.
  if (!fs.existsSync(markerPath())) return notRunning();

  if (cmd.cmd === 'status') {
    const res = await post('/v1/crab', { action: 'status', args: {} });
    if (!res.status) return notRunning();
    if (res.status >= 300) { err(res.json?.error || `Shellby answered ${res.status}.`); return EXIT.error; }
    out(res.json?.text || 'No answer.');
    return EXIT.ok;
  }

  if (cmd.cmd === 'say') {
    const res = await post('/v1/crab', { action: 'say', args: { text: cmd.text } });
    if (!res.status) return notRunning();
    if (res.status >= 300) { err(res.json?.error || `Shellby answered ${res.status}.`); return EXIT.error; }
    return EXIT.ok;
  }

  // do
  const token = readToken();
  if (!token) {
    err('Shellby has not set up the command line yet.');
    err('Turn on Settings > Claude Code everywhere > the shellby command, then try again.');
    return EXIT.denied;
  }
  const dir = path.resolve(cmd.dir || process.cwd());
  if (!isDirectory(dir)) { err(`Not a folder: ${dir}`); return EXIT.usage; }

  const res = await post('/v1/cli', { action: 'task', args: { prompt: cmd.prompt, cwd: dir, mode: cmd.mode } }, { token });
  if (!res.status) return notRunning();
  if (res.status === 401 || res.status === 403) {
    err('Shellby refused the command line. Turn it off and on again in Settings to get a fresh token.');
    return EXIT.denied;
  }
  if (res.status >= 300) { err(res.json?.error || `Shellby answered ${res.status}.`); return EXIT.error; }
  if (!cmd.quiet) out(res.json?.text || 'Handed to Shellby.');
  return EXIT.ok;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readVersion() {
  // Written next to this file when Shellby installs the command.
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'cli-version.json'), 'utf8'));
    return `shellby ${v.version}`;
  } catch { return 'shellby (version unknown)'; }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => { err(`shellby: ${e?.message || e}`); process.exit(EXIT.error); });
}

module.exports = { parseArgs, main, USAGE, MODES, MAX_PROMPT, EXIT };
