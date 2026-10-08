// Claude Code sessions running outside Shellby (terminal, VS Code, ...). The
// Shellby plugin's hooks POST each hook event here (claude-plugin/hooks/hooks.json);
// we keep a tiny picture of every live session so the crab can work, ask and
// celebrate along with them.
//
// Only the event name, tool name, folder and session id are kept (the folder and
// id so "Bring it into Shellby" can open the conversation where it lives). Tool
// inputs (commands, file contents) arrive in the payload and are dropped unread.
// The one exception is a backgrounded command, where the program it runs ('node',
// 'npm') is kept so Shellby can say what was left running -- never its arguments.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { classifyCommand } = require('./xp');
const { shipOf } = require('./stickers');
const { checkupOf, readCheckup, commandDir } = require('./checkup');
const { clientOf, describeClient } = require('./clients');
const bugRead = require('./bugdex/detect');
const { cmdKey } = require('./flaky/ids');

const DEFAULT_PORT = 47913;
const MAX_BODY = 2 * 1024 * 1024;       // Write/Edit payloads include file contents
const WORKING_STALE_MS = 15 * 60 * 1000; // no events for this long: assume it went quiet
const FORGET_MS = 2 * 60 * 60 * 1000;    // ...and forget it after this
const HELPER_TOOLS = new Set(['Task', 'Agent']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const STOP_TOOLS = new Set(['KillShell', 'TaskStop']); // the model stopped one itself
const MAX_BG = 8;                        // more than anyone leaves running on purpose
const BG_FORGET_MS = 30 * 60 * 1000;     // long enough to notice, short enough not to haunt
const MAX_SESSIONS = 64;                 // nobody runs more; a flood of fake ids evicts the oldest
const MAX_CONNECTIONS = 16;
const MAX_ENDED = 16;                    // sessions just closed, still bringable into Shellby
const MAX_CWD = 400;
const LOCAL_DIR = /^[A-Za-z]:[\\/][^\u0000-\u001f\u007f]*$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// While listening, Shellby leaves a marker the plugin's hook checks first, so
// hooks cost nothing when Shellby is closed (see claude-plugin/hooks/notify.sh).
const markerPath = port => path.join(os.tmpdir(), `shellby-hooks-${port}`);

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const projectOf = cwd => clip(path.basename(String(cwd || '').replace(/[\\/]+$/, '')) || 'Claude Code', 60);

// Just the program a backgrounded command runs ('node', 'npm'), never its
// arguments: enough to say what is still going, nothing carrying a path, a flag
// or a secret. A leading `cd somewhere &&` is stepped over to reach the real one.
function programOf(command) {
  for (const part of String(command ?? '').split(/&&|\|\||;/)) {
    const first = part.trim().split(/\s+/)[0] || '';
    const base = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|sh|ps1)$/i, '');
    if (!base || base === 'cd' || base === 'set' || base === 'export') continue;
    return /^[A-Za-z0-9._-]{1,24}$/.test(base) ? base : 'a command';
  }
  return 'a command';
}

/**
 * Apply one hook event to the sessions map (pure: returns a new map and the
 * notable things that happened). evt is Claude Code's hook JSON.
 *   effects: [{ type: 'turn-done', project, tools } | { type: 'asking', project, message }
 *             | { type: 'command-ok', kind, project } | { type: 'checkup', check, dir, result }]
 */
function applyHookEvent(sessions, evt, now, client = null) {
  const next = new Map(sessions);
  const effects = [];
  const name = typeof evt?.hook_event_name === 'string' ? evt.hook_event_name : '';
  const id = typeof evt?.session_id === 'string' && ID_RE.test(evt.session_id) ? evt.session_id : null;
  if (!id || !name) return { sessions: next, effects };
  const prev = next.get(id);
  const s = prev ? { ...prev } : { id, project: projectOf(evt.cwd), state: 'idle', tool: null, helpers: 0, tools: 0, bg: [], startedAt: now };
  if (evt.cwd) s.project = projectOf(evt.cwd);
  // Where Claude Code keeps the conversation is decided by the folder it started
  // in, so that one is kept: from SessionStart, or else the first one heard.
  // Only a folder on a local drive: this port takes events from anything on the
  // PC, and a \\host\share would have Shellby reach out to another machine.
  if (LOCAL_DIR.test(evt.cwd || '') && evt.cwd.length <= MAX_CWD && (name === 'SessionStart' || !s.cwd)) s.cwd = evt.cwd;
  // The hook sends this on every event; keep the last one that named an app, so
  // a session doesn't lose its label to one event that arrived without it.
  if (client?.label) s.client = client;
  s.lastAt = now;

  switch (name) {
    case 'SessionStart':
      s.state = 'idle';
      break;
    case 'UserPromptSubmit':
      s.state = 'working'; s.tool = null; s.tools = 0; s.turnAt = now;
      break;
    case 'PreToolUse': {
      s.state = 'working';
      s.tool = clip(evt.tool_name, 40) || null;
      s.tools += 1;
      if (HELPER_TOOLS.has(evt.tool_name)) s.helpers = Math.min(s.helpers + 1, 12);
      // A backgrounded command outlives the turn that started it, so it is
      // remembered past Stop -- that is the whole point of tracking it.
      if (SHELL_TOOLS.has(evt.tool_name) && evt.tool_input?.run_in_background === true) {
        s.bg = [...(s.bg || []), { program: programOf(evt.tool_input?.command), at: now }].slice(-MAX_BG);
      } else if (STOP_TOOLS.has(evt.tool_name)) {
        s.bg = (s.bg || []).slice(1); // which one it stopped we can't tell: assume the oldest
      }
      break;
    }
    case 'PostToolUse': {
      if (s.state === 'asking') s.state = 'working'; // the permission was granted
      // PostToolUse only fires for commands that succeeded (a failing one gets
      // PreToolUse only), so a test command here means the tests passed. Only
      // the meaning leaves this function, never the command itself.
      if (evt.tool_name === 'Bash' || evt.tool_name === 'PowerShell') {
        const kind = classifyCommand(evt.tool_input?.command);
        // A push, deploy or release also ships the project, which earns its
        // sticker (stickers.js): that needs the folder, and what it shipped.
        const ship = shipOf(kind, evt.tool_input?.command);
        if (kind) {
          effects.push(ship
            ? { type: 'command-ok', kind, project: s.project, cwd: typeof evt.cwd === 'string' ? evt.cwd.slice(0, 400) : null, ship: { kind: ship.kind, version: ship.meta.version ?? null } }
            : { type: 'command-ok', kind, project: s.project });
        }
        // A dependency checkup: what it found and where, never the output itself.
        const check = checkupOf(evt.tool_input?.command);
        if (check && typeof evt.cwd === 'string') {
          const out = evt.tool_response && typeof evt.tool_response === 'object'
            ? [evt.tool_response.stdout, evt.tool_response.stderr].filter(x => typeof x === 'string').join('\n') : '';
          effects.push({
            type: 'checkup', check,
            dir: commandDir(evt.tool_input.command, evt.cwd.slice(0, 400)),
            result: readCheckup(check, { text: out, isError: false, command: evt.tool_input.command }),
          });
        }
      }
      break;
    }
    case 'PostToolUseFailure': {
      if (s.state === 'asking') s.state = 'working'; // it was allowed, and then failed
      // Failing tests mark the project red, so the pass that fixes them counts
      // as "green again" outside Shellby too. Only the meaning leaves here.
      const cmd = evt.tool_name === 'Bash' || evt.tool_name === 'PowerShell' ? evt.tool_input?.command : null;
      if (cmd && classifyCommand(cmd) === 'tests' && s.project) effects.push({ type: 'command-fail', kind: 'tests', project: s.project });
      break;
    }
    case 'SubagentStop':
      s.helpers = Math.max(0, s.helpers - 1);
      break;
    case 'Notification': {
      const message = clip(evt.message, 160);
      if (/permission|approve|allow/i.test(message)) {
        s.state = 'asking';
        effects.push({ type: 'asking', project: s.project, message });
      } else if (/waiting for (your )?input|idle/i.test(message)) {
        s.state = 'idle';
      }
      break;
    }
    case 'Stop': {
      const worked = s.state === 'working' || s.state === 'asking';
      // ms: how long Claude worked on the turn (0 when the prompt wasn't seen, say Shellby started mid-turn).
      const ms = Number.isFinite(s.turnAt) ? Math.max(0, now - s.turnAt) : 0;
      if (worked) effects.push({ type: 'turn-done', project: s.project, tools: s.tools, ms, cwd: typeof evt.cwd === 'string' ? evt.cwd.slice(0, 400) : null, sessionId: id, folder: s.cwd || null });
      // s.bg deliberately survives: whatever it backgrounded is still out there.
      s.state = 'idle'; s.tool = null; s.helpers = 0; s.tools = 0; s.turnAt = null;
      break;
    }
    case 'SessionEnd':
      next.delete(id);
      // Its handoff note is written now (wiring/journal.js), from Claude Code's
      // own file for it: transcript_path is never read, it could name any file.
      if (s.cwd) effects.push({ type: 'session-end', sessionId: id, cwd: s.cwd });
      return { sessions: next, effects };
    default:
      return { sessions: sessions, effects }; // unknown event: no change
  }
  next.set(id, s);
  // Bounded: past MAX_SESSIONS, forget whichever session was heard from longest ago.
  while (next.size > MAX_SESSIONS) {
    let oldest = null;
    for (const [k, v] of next) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
    next.delete(oldest[0]);
  }
  return { sessions: next, effects };
}

// Tools that write code: Claude working on whatever bug is on the loose there.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOL_USE_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * What the Bugdex takes from one hook event (bugdex/detect.js read()): a
 * command starting, a command's reading (a bug it showed, or what its pass
 * means) or a write. Pure. The command and its output are read here and
 * dropped: only hashes, a species and yes/no answers leave.
 *   -> [{ type: 'bug-start', toolUseId, key, cwd } | { type: 'bug-read', toolUseId, reading, cwd } | { type: 'bug-wrote', cwd }]
 */
function bugsOf(evt) {
  const name = evt?.hook_event_name;
  const cwd = typeof evt?.cwd === 'string' && LOCAL_DIR.test(evt.cwd) && evt.cwd.length <= MAX_CWD ? evt.cwd : null;
  if (!cwd || typeof evt.session_id !== 'string' || !ID_RE.test(evt.session_id)) return [];
  if (WRITE_TOOLS.has(evt.tool_name) && name === 'PostToolUse') return [{ type: 'bug-wrote', cwd }];
  if (!SHELL_TOOLS.has(evt.tool_name)) return [];
  const command = typeof evt.tool_input?.command === 'string' ? evt.tool_input.command : '';
  const toolUseId = typeof evt.tool_use_id === 'string' && TOOL_USE_RE.test(evt.tool_use_id) ? evt.tool_use_id : null;
  const background = evt.tool_input?.run_in_background === true;
  if (!command || background) return [];
  if (name === 'PreToolUse') return toolUseId ? [{ type: 'bug-start', toolUseId, key: cmdKey(command), cwd }] : [];
  let reading = null;
  if (name === 'PostToolUse') {
    const res = evt.tool_response;
    const output = res && typeof res === 'object' ? [res.stdout, res.stderr].filter(x => typeof x === 'string').join('\n') : (typeof res === 'string' ? res : '');
    reading = bugRead.read({ cmd: command, output, isError: false });
  } else if (name === 'PostToolUseFailure' && evt.is_interrupt !== true) {
    reading = bugRead.read({ cmd: command, output: typeof evt.error === 'string' ? evt.error : '', isError: true });
  }
  return reading ? [{ type: 'bug-read', toolUseId, reading, cwd }] : [];
}

/** Quiet down sessions that stopped sending events (Claude killed, laptop slept). */
function expire(sessions, now) {
  const next = new Map();
  for (const [id, s] of sessions) {
    if (now - s.lastAt > FORGET_MS) continue;
    const quiet = now - s.lastAt > WORKING_STALE_MS && s.state !== 'idle';
    const base = quiet ? { ...s, state: 'idle', tool: null, helpers: 0 } : s;
    const bg = (base.bg || []).filter(b => now - b.at < BG_FORGET_MS);
    next.set(id, bg.length === (base.bg || []).length ? base : { ...base, bg });
  }
  return next;
}

/** One session as the panel sees it. */
function viewOf(s) {
  return {
    id: s.id, cwd: s.cwd || null,
    project: s.project, state: s.state, tool: s.tool, helpers: s.helpers, lastAt: s.lastAt,
    client: s.client?.label || null, clientKind: s.client?.kind || null,
    where: describeClient(s.project, s.client),
  };
}

/** Roll the sessions up for the critter: state, busy count and helper crabs. */
function summarize(sessions) {
  const list = [...sessions.values()];
  const busy = list.filter(s => s.state === 'working' || s.state === 'asking');
  const state = list.some(s => s.state === 'asking') ? 'asking' : busy.length ? 'working' : 'idle';
  const crew = busy.flatMap(s => Array.from({ length: s.helpers }, (_, i) => ({ id: `ext-${s.id}-${i}`, tabId: null, label: s.project, type: s.client?.label || 'Claude Code' })));
  // Backgrounded commands nobody has accounted for, newest first. These are the
  // reason the crab doesn't just go idle when a turn ends.
  const background = list
    .flatMap(s => (s.bg || []).map(b => ({ project: s.project, program: b.program, at: b.at })))
    .sort((a, b) => b.at - a.at);
  return {
    state, busy: busy.length, crew, background,
    sessions: list.sort((a, b) => b.lastAt - a.lastAt).map(viewOf),
  };
}

// What this port answers. /v1/hook is the plugin's hooks; /v1/crab is the MCP
// server driving the critter; /v1/cli is the `shellby` command; /v1/flow is a
// workflow's web hook (its token is in the body, workflows/triggers.js).
const ROUTES = ['/v1/hook', '/v1/crab', '/v1/cli', '/v1/flow'];

/**
 * Is this one of ours? Requires POST to a known route, our header, JSON, and no
 * Origin: browsers always send Origin on cross-site POSTs (and can't add custom
 * headers without a CORS preflight we never answer), so a web page can't feed
 * the crab fake events or start a task.
 */
function acceptable(req) {
  return req.method === 'POST'
    // Exact, so a query string is not a way to reach a route by another name.
    && ROUTES.includes(req.url)
    && req.headers['x-shellby'] === '1'
    && /^application\/json\b/i.test(req.headers['content-type'] || '')
    && !req.headers.origin
    // Every client here dials 127.0.0.1. A page that rebinds its own name to
    // this PC still sends that name as Host, so this holds even if the Origin
    // rule ever didn't.
    && /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '');
}

// A refused request isn't read: enough of it is drained to answer cleanly,
// and anything bigger just loses its connection.
const REFUSED_DRAIN = 64 * 1024;
function refuse(req, res, status) {
  res.writeHead(status).end();
  let seen = 0;
  req.on('data', c => { seen += c.length; if (seen > REFUSED_DRAIN) req.destroy(); });
  req.resume();
}

class ExternalSessions extends EventEmitter {
  constructor({ port = DEFAULT_PORT, now = () => Date.now() } = {}) {
    super();
    this.port = port;
    this.owner = `${process.pid}-${Math.random().toString(36).slice(2)}`; // whose marker it is
    this.now = now;
    this.sessions = new Map();
    this.ended = new Map();  // id -> view: closed lately, so "Bring it into Shellby" still works once you've typed /exit
    this.server = null;
    this.status = 'off'; // 'off' | 'listening' | 'busy' | 'error'
    this.timer = null;
    // Set by main.js. Until they are, those routes answer 404, which is exactly
    // what a newer plugin talking to an older Shellby should see.
    this.onCrab = null;
    this.onCli = null;
    this.onFlow = null;
  }

  /** "I checked, they're done": drops every remembered background command. */
  clearBackground() {
    let hit = false;
    const next = new Map();
    for (const [id, se] of this.sessions) {
      if (se.bg?.length) { hit = true; next.set(id, { ...se, bg: [] }); } else next.set(id, se);
    }
    if (!hit) return false;
    this.sessions = next;
    this.emit('changed', this.summary);
    return true;
  }

  start() {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    // Hooks send one small request and hang up; anything slow or crowded is not a hook.
    server.requestTimeout = 5000;
    server.headersTimeout = 3000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = MAX_CONNECTIONS;
    server.on('error', err => {
      clearInterval(this.timer); // a failed listen must not leave its timer behind
      this.timer = null;
      this.status = err.code === 'EADDRINUSE' ? 'busy' : 'error';
      this.server = null;
      // (no marker(false): the port belongs to someone else, and so does its marker)
      this.emit('status', this.status);
    });
    server.listen(this.port, '127.0.0.1', () => {
      this.port = server.address().port;
      this.status = 'listening';
      this.marker(true);
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        this.update(expire(this.sessions, this.now()));
        for (const [k, v] of this.ended) if (this.now() - v.endedAt > FORGET_MS) this.ended.delete(k);
        this.marker(true); // self-healing: put it back if anything removed it
      }, 60 * 1000);
      this.emit('status', this.status);
    });
    this.server = server;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.server?.close();
    this.server = null;
    this.marker(false);
    this.status = 'off';
    this.ended.clear();
    this.update(new Map());
    this.emit('status', this.status);
  }

  // The marker says "Shellby is listening on this port". Only the Shellby that
  // wrote it may remove it: a second copy that fails to bind the same port (a
  // dev run, a restart racing the old instance) must not switch hooks off for
  // the one that's actually listening.
  marker(on) {
    const file = markerPath(this.port);
    try {
      if (on) fs.writeFileSync(file, this.owner);
      else if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === this.owner) fs.rmSync(file, { force: true });
    } catch { /* best effort: without it hooks just skip */ }
  }

  handle(req, res) {
    const route = req.url;
    if (!acceptable(req)) { refuse(req, res, ROUTES.includes(route) ? 403 : 404); return; }
    // Shellby's own Claude Code processes carry SHELLBY_OWNED=1 into the hook's
    // environment; their tabs already drive the crab. (Only hooks: a task
    // Shellby started may still legitimately drive the crab over MCP.)
    if (route === '/v1/hook' && req.headers['x-shellby-owned'] === '1') { res.writeHead(204).end(); req.resume(); return; }
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (route === '/v1/hook') {
        res.writeHead(204).end(); // empty body: nothing for Claude Code to read as hook output
        let evt;
        try { evt = JSON.parse(body); } catch { return; }
        this.ingest(evt, req.headers);
        return;
      }
      this.answer(route, body, req.headers, res);
    });
  }

  /**
   * /v1/crab, /v1/cli and /v1/flow. All reply with JSON, because unlike a hook there is
   * someone waiting to hear what happened. main.js supplies the handlers; with
   * none set the route is simply not there, which is what an older Shellby
   * looks like to a newer plugin.
   */
  answer(route, body, headers, res) {
    const reply = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }).end(text);
    };
    const handler = route === '/v1/crab' ? this.onCrab : route === '/v1/flow' ? this.onFlow : this.onCli;
    if (!handler) { reply(404, { error: 'Not enabled.' }); return; }
    let payload;
    try { payload = JSON.parse(body); } catch { reply(400, { error: 'That was not JSON.' }); return; }
    Promise.resolve()
      .then(() => handler(payload, { token: typeof headers['x-shellby-token'] === 'string' ? headers['x-shellby-token'] : '' }))
      .then(result => reply(result?.status || (result?.ok === false ? 400 : 200), result?.ok === false ? { error: result.error } : { text: result?.text || 'Done.' }))
      .catch(() => reply(500, { error: 'Shellby could not do that.' }));
  }

  /**
   * One session by id, for handoff.js: live while it's open, or one that ended
   * lately (closing it is exactly what "Bring it into Shellby" asks you to do).
   */
  known(id) {
    const s = this.sessions.get(id);
    if (s) return { ...viewOf(s), live: true };
    const gone = this.ended.get(id);
    return gone ? { ...gone, live: false } : null;
  }

  ingest(evt, headers = {}) {
    if (evt?.hook_event_name === 'SessionEnd' && this.sessions.has(evt.session_id)) {
      this.ended.set(evt.session_id, { ...viewOf(this.sessions.get(evt.session_id)), state: 'idle', endedAt: this.now() });
      while (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.keys().next().value);
    }
    // Which app the session is running in, worked out by the hook (see
    // claude-plugin/hooks/notify.sh) and named in clients.js.
    const client = clientOf({ host: headers['x-shellby-host'], entry: headers['x-shellby-entry'] });
    const { sessions, effects } = applyHookEvent(this.sessions, evt, this.now(), client);
    this.update(sessions);
    for (const e of effects) this.emit(e.type, e);
    // The Bugdex's own reading of it (wiring/bugdex.js): never on the effects, which the crab reacts to.
    for (const e of bugsOf(evt)) this.emit(e.type, e);
  }

  update(sessions) {
    const before = JSON.stringify(summarize(this.sessions));
    this.sessions = sessions;
    const after = summarize(this.sessions);
    if (JSON.stringify(after) !== before) this.emit('changed', after);
  }

  get summary() { return { ...summarize(this.sessions), status: this.status, port: this.port }; }
}

module.exports = { ExternalSessions, applyHookEvent, bugsOf, expire, summarize, acceptable, markerPath, programOf, DEFAULT_PORT, ROUTES };
