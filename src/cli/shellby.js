#!/usr/bin/env node
// The `shellby` command: hand work to the crab from any terminal, or ask him
// how things are. For a thing named after a shell, not being usable from one
// was a bit of an oversight.
//
//   shellby do "tidy my Downloads folder"   hand a task to Shellby
//   shellby say "all green"                 put a line in his speech bubble
//   shellby status                          how the crab and this PC are doing
//   shellby flow run "Red build fixer" branch=main   start a workflow
//   shellby time last-week                  hours on each project, for an invoice
//   shellby do @review                      run a saved prompt snippet
//   shellby take                            open this folder's Claude Code session in Shellby
//   shellby next                            what to work on in this project (Next up)
//   shellby task add "release notes"         a task on this project's list (.shellby/tasks.md)
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
// Workflow inputs, as Shellby checks them (crabtools.parseWorkflowCall). Repeated
// here because this file can't load the app's modules; Shellby checks again.
const INPUT_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_INPUTS = 10;
const MAX_INPUT_VALUE = 2000;
const MAX_FLOW_NAME = 60;
// A task's title, as Shellby keeps it (backlog/tasks.js MAX_TITLE).
const MAX_TASK = 200;

const TIME_RANGES = ['today', 'week', 'last-week', 'month', 'last-month'];
// A saved snippet, as Shellby names them (snippets.js NAME). Lowercase only, so
// `shellby do @Makefile ...` and `@src/app.js` stay file mentions for Claude.
const SNIPPET = /^@([a-z0-9][a-z0-9-]{0,31})$/;
// A Claude Code session id, as Shellby checks it (handoff.js isSessionId).
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXIT = { ok: 0, error: 1, usage: 2, notRunning: 3, denied: 4 };

const USAGE = `shellby - the desktop crab, from your terminal

  shellby do <task...>        hand a task to Shellby, in this folder
  shellby do @<snippet> [more...]
                              run one of your saved prompt snippets, like @review
  shellby snippets            your snippets
  shellby take [session-id]   carry the Claude Code session in this folder on in
                              Shellby (or /shellby:handoff from inside it)
  shellby say <text...>       put a short line in his speech bubble
  shellby status              how the crab and this PC are doing
  shellby flow list           your workflows, and which ones Claude Code may run
  shellby flow run <name...> [key=value ...]
                              start a workflow that has the "Claude Code" trigger
  shellby next                what to work on in this project, ranked: your tasks,
                              its GitHub issues and the TODOs in its code
  shellby task add <text...>  add a task to this project's .shellby/tasks.md
  shellby task done <n>       tick off item n of shellby next (one of your tasks)
  shellby time [range] [--git] hours on each project: ${TIME_RANGES.join(' | ')}
                              (default: week). --git fills untracked days from your commits
  shellby help                this
  shellby version

Options for "do":
  -C, --dir <path>     run the task somewhere else (default: this folder)
  -m, --mode <mode>    ${MODES.join(' | ')}  (default: whatever Shellby is set to)
  -q, --quiet          print nothing unless it fails

A snippet's prompt gets whatever follows its name: in place of $ARGUMENTS if
it has one ("shellby do @tests src/app.js"), word by word for $1, $2 and on
(the last one takes the rest), otherwise on the end.

For "flow run", the name is every word before the first key=value (or quote
it), and each key=value fills in one of the workflow's inputs:
  shellby flow run Red build fixer branch=main

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
  if (first === 'snippets') return args.length ? { error: 'shellby snippets takes nothing after it.' } : { cmd: 'snippets' };

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
    const snippet = SNIPPET.exec(words[0] || '');
    if (snippet) words.shift();
    const prompt = words.join(' ').trim();
    if (!prompt && !snippet) return { error: 'What should he do? (shellby do "tidy my Downloads", or a snippet: shellby do @review)' };
    if (prompt.length > MAX_PROMPT) return { error: `That task is longer than ${MAX_PROMPT} characters.` };
    return snippet ? { ...opts, prompt, snippet: snippet[1] } : { ...opts, prompt };
  }

  if (first === 'flow') return parseFlowArgs(args);

  if (first === 'take') {
    if (args.length > 1) return { error: 'shellby take takes at most a session id.' };
    if (args.length && !SESSION_ID.test(args[0])) return { error: `"${String(args[0]).slice(0, 40)}" isn't a Claude Code session id.` };
    return args.length ? { cmd: 'take', id: args[0] } : { cmd: 'take' };
  }

  if (first === 'next') return args.length ? { error: 'shellby next takes nothing after it.' } : { cmd: 'next' };

  if (first === 'task') {
    const sub = args.shift();
    if (sub === 'add') {
      const title = args.join(' ').replace(/\s+/g, ' ').trim();
      if (!title) return { error: 'Add what? (shellby task add "release notes for 0.71")' };
      if (title.length > MAX_TASK) return { error: `Keep a task under ${MAX_TASK} characters.` };
      return { cmd: 'task-add', title };
    }
    if (sub === 'done') {
      const n = Number(args[0]);
      if (args.length !== 1 || !Number.isInteger(n) || n < 1 || n > 999) return { error: 'Which one? (shellby task done 2, numbered as shellby next lists them)' };
      return { cmd: 'task-done', n };
    }
    return { error: 'Usage: shellby task add <text...> | shellby task done <n>' };
  }

  if (first === 'time') {
    const opts = { cmd: 'time', range: 'week', estimates: false };
    for (const a of args) {
      if (a === '--git') opts.estimates = true;
      else if (TIME_RANGES.includes(a)) opts.range = a;
      else return { error: `shellby time takes one of ${TIME_RANGES.join(', ')} (and --git), not "${String(a).slice(0, 30)}".` };
    }
    return opts;
  }

  return { error: `Unknown command: ${String(first).slice(0, 30)}. Try "shellby help".` };
}

const FLOW_USAGE = 'Usage: shellby flow list | shellby flow run <name...> [key=value ...]';

/** `flow list` / `flow run <name...> [key=value ...]` -> { cmd: 'flow-list' } | { cmd: 'flow-run', name, inputs } | { error } */
function parseFlowArgs(args) {
  const sub = args.shift();
  if (sub === 'list' || sub === 'ls') return args.length ? { error: FLOW_USAGE } : { cmd: 'flow-list' };
  if (sub !== 'run') return { error: sub ? `Unknown flow command: ${String(sub).slice(0, 30)}. ${FLOW_USAGE}` : FLOW_USAGE };

  const words = [];
  const inputs = {};
  let count = 0;
  for (const a of args) {
    const eq = a.indexOf('=');
    // Everything before the first key=value is the name.
    if (eq === -1 && !count) { words.push(a); continue; }
    if (eq === -1) return { error: `Expected key=value after the name, got "${a.slice(0, 40)}". ${FLOW_USAGE}` };
    const key = a.slice(0, eq);
    if (!INPUT_KEY.test(key)) return { error: `"${key.slice(0, 40)}" can't be an input name: use lowercase letters, digits and _.` };
    if (Object.prototype.hasOwnProperty.call(inputs, key)) return { error: `${key} is given twice.` };
    const value = a.slice(eq + 1);
    if (value.length > MAX_INPUT_VALUE) return { error: `${key} is longer than ${MAX_INPUT_VALUE} characters.` };
    if (++count > MAX_INPUTS) return { error: `At most ${MAX_INPUTS} inputs.` };
    inputs[key] = value;
  }
  const name = words.join(' ').replace(/\s+/g, ' ').trim();
  if (!name) return { error: `Which workflow? ${FLOW_USAGE}` };
  if (name.length > MAX_FLOW_NAME) return { error: `Workflow names are at most ${MAX_FLOW_NAME} characters.` };
  return { cmd: 'flow-run', name, inputs };
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

  // Everything below starts something, so it needs the token.
  const token = readToken();
  if (!token) {
    err('Shellby has not set up the command line yet.');
    err('Turn on Settings > Claude Code everywhere > the shellby command, then try again.');
    return EXIT.denied;
  }

  if (cmd.cmd === 'time') return cliRequest({ action: 'time', range: cmd.range, estimates: cmd.estimates }, token, { fallback: 'No time to show.' });
  if (cmd.cmd === 'snippets') return cliRequest({ action: 'snippets' }, token, { fallback: 'No snippets yet.' });
  if (cmd.cmd === 'flow-list') return cliRequest({ action: 'flow-list' }, token, { fallback: 'No answer.' });
  if (cmd.cmd === 'take') {
    return cliRequest({ action: 'take', args: { cwd: process.cwd(), ...(cmd.id ? { id: cmd.id } : {}) } }, token, { fallback: 'Opened in Shellby.' });
  }
  if (cmd.cmd === 'next') return cliRequest({ action: 'next', args: { cwd: process.cwd() } }, token, { fallback: 'Nothing waiting.' });
  if (cmd.cmd === 'task-add') return cliRequest({ action: 'task-add', args: { cwd: process.cwd(), title: cmd.title } }, token, { fallback: 'Added.' });
  if (cmd.cmd === 'task-done') return cliRequest({ action: 'task-done', args: { cwd: process.cwd(), n: cmd.n } }, token, { fallback: 'Ticked off.' });
  if (cmd.cmd === 'flow-run') return cliRequest({ action: 'flow-run', name: cmd.name, inputs: cmd.inputs }, token, { fallback: 'Started.' });

  // do
  const dir = path.resolve(cmd.dir || process.cwd());
  if (!isDirectory(dir)) { err(`Not a folder: ${dir}`); return EXIT.usage; }
  const args = { prompt: cmd.prompt, cwd: dir, mode: cmd.mode };
  if (cmd.snippet) args.snippet = cmd.snippet;
  return cliRequest({ action: 'task', args }, token,
    { quiet: cmd.quiet, fallback: 'Handed to Shellby.' });
}

/** POST to /v1/cli with the token, print the answer, and turn it into an exit code. */
async function cliRequest(payload, token, { quiet = false, fallback = 'Done.' } = {}) {
  const res = await post('/v1/cli', payload, { token });
  if (!res.status) return notRunning();
  if (res.status === 401 || res.status === 403) {
    // A 403 that says why (the command is off, that workflow isn't Claude's to
    // run) is passed on; a bare refusal is most likely a stale token.
    err(res.status === 403 && res.json?.error ? res.json.error
      : 'Shellby refused the command line. Turn it off and on again in Settings to get a fresh token.');
    return EXIT.denied;
  }
  if (res.status >= 300) { err(res.json?.error || `Shellby answered ${res.status}.`); return EXIT.error; }
  if (!quiet) out(res.json?.text || fallback);
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

module.exports = { parseArgs, main, USAGE, MODES, TIME_RANGES, MAX_PROMPT, EXIT, INPUT_KEY, MAX_INPUTS, MAX_INPUT_VALUE, MAX_FLOW_NAME, MAX_TASK, SNIPPET, SESSION_ID };
