// Claude Code sessions running outside Shellby (terminal, VS Code, ...). The
// Shellby plugin's hooks POST each hook event here (claude-plugin/hooks/hooks.json);
// we keep a tiny picture of every live session so the crab can work, ask and
// celebrate along with them.
//
// Only the event name, tool name, folder name and session id are kept. Tool
// inputs (commands, file contents) arrive in the payload and are dropped unread.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { classifyCommand } = require('./xp');

const DEFAULT_PORT = 47913;
const MAX_BODY = 2 * 1024 * 1024;       // Write/Edit payloads include file contents
const WORKING_STALE_MS = 15 * 60 * 1000; // no events for this long: assume it went quiet
const FORGET_MS = 2 * 60 * 60 * 1000;    // ...and forget it after this
const HELPER_TOOLS = new Set(['Task', 'Agent']);
const MAX_SESSIONS = 64;                 // nobody runs more; a flood of fake ids evicts the oldest
const MAX_CONNECTIONS = 16;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// While listening, Shellby leaves a marker the plugin's hook checks first, so
// hooks cost nothing when Shellby is closed (see claude-plugin/hooks/notify.sh).
const markerPath = port => path.join(os.tmpdir(), `shellby-hooks-${port}`);

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const projectOf = cwd => clip(path.basename(String(cwd || '').replace(/[\\/]+$/, '')) || 'Claude Code', 60);

/**
 * Apply one hook event to the sessions map (pure: returns a new map and the
 * notable things that happened). evt is Claude Code's hook JSON.
 *   effects: [{ type: 'turn-done', project, tools } | { type: 'asking', project, message }]
 */
function applyHookEvent(sessions, evt, now) {
  const next = new Map(sessions);
  const effects = [];
  const name = typeof evt?.hook_event_name === 'string' ? evt.hook_event_name : '';
  const id = typeof evt?.session_id === 'string' && ID_RE.test(evt.session_id) ? evt.session_id : null;
  if (!id || !name) return { sessions: next, effects };
  const prev = next.get(id);
  const s = prev ? { ...prev } : { id, project: projectOf(evt.cwd), state: 'idle', tool: null, helpers: 0, tools: 0, startedAt: now };
  if (evt.cwd) s.project = projectOf(evt.cwd);
  s.lastAt = now;

  switch (name) {
    case 'SessionStart':
      s.state = 'idle';
      break;
    case 'UserPromptSubmit':
      s.state = 'working'; s.tool = null; s.tools = 0;
      break;
    case 'PreToolUse': {
      s.state = 'working';
      s.tool = clip(evt.tool_name, 40) || null;
      s.tools += 1;
      if (HELPER_TOOLS.has(evt.tool_name)) s.helpers = Math.min(s.helpers + 1, 12);
      break;
    }
    case 'PostToolUse': {
      if (s.state === 'asking') s.state = 'working'; // the permission was granted
      // PostToolUse only fires for commands that succeeded (a failing one gets
      // PreToolUse only), so a test command here means the tests passed. Only
      // the meaning leaves this function, never the command itself.
      if (evt.tool_name === 'Bash' || evt.tool_name === 'PowerShell') {
        const kind = classifyCommand(evt.tool_input?.command);
        if (kind) effects.push({ type: 'command-ok', kind, project: s.project });
      }
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
      if (worked) effects.push({ type: 'turn-done', project: s.project, tools: s.tools });
      s.state = 'idle'; s.tool = null; s.helpers = 0; s.tools = 0;
      break;
    }
    case 'SessionEnd':
      next.delete(id);
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

/** Quiet down sessions that stopped sending events (Claude killed, laptop slept). */
function expire(sessions, now) {
  const next = new Map();
  for (const [id, s] of sessions) {
    if (now - s.lastAt > FORGET_MS) continue;
    next.set(id, now - s.lastAt > WORKING_STALE_MS && s.state !== 'idle' ? { ...s, state: 'idle', tool: null, helpers: 0 } : s);
  }
  return next;
}

/** Roll the sessions up for the critter: state, busy count and helper crabs. */
function summarize(sessions) {
  const list = [...sessions.values()];
  const busy = list.filter(s => s.state === 'working' || s.state === 'asking');
  const state = list.some(s => s.state === 'asking') ? 'asking' : busy.length ? 'working' : 'idle';
  const crew = busy.flatMap(s => Array.from({ length: s.helpers }, (_, i) => ({ id: `ext-${s.id}-${i}`, tabId: null, label: s.project, type: 'Claude Code' })));
  return {
    state, busy: busy.length, crew,
    sessions: list.sort((a, b) => b.lastAt - a.lastAt).map(s => ({ project: s.project, state: s.state, tool: s.tool, helpers: s.helpers, lastAt: s.lastAt })),
  };
}

/**
 * Is this request one of our hooks? Requires POST /v1/hook, our header, JSON,
 * and no Origin: browsers always send Origin on cross-site POSTs (and can't add
 * custom headers without a CORS preflight we never answer), so a web page
 * can't feed the crab fake events.
 */
function acceptable(req) {
  return req.method === 'POST'
    && req.url === '/v1/hook'
    && req.headers['x-shellby'] === '1'
    && /^application\/json\b/i.test(req.headers['content-type'] || '')
    && !req.headers.origin;
}

class ExternalSessions extends EventEmitter {
  constructor({ port = DEFAULT_PORT, now = () => Date.now() } = {}) {
    super();
    this.port = port;
    this.now = now;
    this.sessions = new Map();
    this.server = null;
    this.status = 'off'; // 'off' | 'listening' | 'busy' | 'error'
    this.timer = null;
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
      this.marker(false);
      this.emit('status', this.status);
    });
    server.listen(this.port, '127.0.0.1', () => {
      this.port = server.address().port;
      this.status = 'listening';
      this.marker(true);
      clearInterval(this.timer);
      this.timer = setInterval(() => this.update(expire(this.sessions, this.now())), 60 * 1000);
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
    this.update(new Map());
    this.emit('status', this.status);
  }

  marker(on) {
    try {
      if (on) fs.writeFileSync(markerPath(this.port), String(process.pid));
      else fs.rmSync(markerPath(this.port), { force: true });
    } catch { /* best effort: without it hooks just skip */ }
  }

  handle(req, res) {
    if (!acceptable(req)) { res.writeHead(req.url === '/v1/hook' ? 403 : 404).end(); req.resume(); return; }
    // Shellby's own Claude Code processes carry SHELLBY_OWNED=1 into the hook's
    // environment; their tabs already drive the crab.
    if (req.headers['x-shellby-owned'] === '1') { res.writeHead(204).end(); req.resume(); return; }
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      res.writeHead(204).end(); // empty body: nothing for Claude Code to read as hook output
      let evt;
      try { evt = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
      this.ingest(evt);
    });
  }

  ingest(evt) {
    const { sessions, effects } = applyHookEvent(this.sessions, evt, this.now());
    this.update(sessions);
    for (const e of effects) this.emit(e.type, e);
  }

  update(sessions) {
    const before = JSON.stringify(summarize(this.sessions));
    this.sessions = sessions;
    const after = summarize(this.sessions);
    if (JSON.stringify(after) !== before) this.emit('changed', after);
  }

  get summary() { return { ...summarize(this.sessions), status: this.status, port: this.port }; }
}

module.exports = { ExternalSessions, applyHookEvent, expire, summarize, acceptable, markerPath, DEFAULT_PORT };
