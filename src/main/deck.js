// Shellby on a Stream Deck: hardware keys for the things he waits on you for.
//
// Five keys, each showing what's waiting behind it:
//
//   Allow / Deny     the oldest permission prompt, in any conversation
//   Stop             the turn that's running (the one on screen, or the only one)
//   Bring it home    the conversation on screen, when it has a copy of its own
//   Ready to review  how many conversations have finished work for you to look at
//
// It's the desk version of answering from your phone (replies.js), so it follows
// the phone's rules: only Allow and Deny, never "Always allow", and a prompt the
// card goes out of its way to flag (a question, a plan, a file Claude wrote, a
// command too long to read at a glance) is never answered blind. Its keys say
// "Look" instead, and pressing one opens the panel at it.
//
// Stream Deck plugins are small Node programs that Stream Deck starts and talks
// to over its own websocket. Ours (src/streamdeck/) reads the keys from here:
// a server on 127.0.0.1 with a server-sent event stream of key states and one
// POST for a press. Every request carries a token Shellby put in the plugin when
// it packed it, and anything that looks like a browser (an Origin header, a Host
// that isn't us) is turned away, so a web page can't press Allow on your PC.
//
// The key logic (keys, resolvePress) is pure; DeckServer is the socket.
const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const { deskOnlyReason } = require('./replies');
const { toReview } = require('../renderer/panel/tab-sort');

const DEFAULT_PORT = 47915;            // next door to the overlay
const ACTIONS = ['allow', 'deny', 'stop', 'home', 'review'];
const MAX_CLIENTS = 4;                 // one plugin; a second while Stream Deck restarts it
const MAX_BODY = 1024;
const KEEPALIVE_MS = 20000;
const API = '/deck/v1';

// ------------------------------------------------------------------ the keys

/** Short enough for a 72px key: the plugin draws it, it can't wrap it. */
function short(text, max = 10) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// What a press has to still be pointing at: a prompt that's been answered at
// the desk while your finger was on the way must not pass its Allow to the next.
const promptRef = p => `${p.tabId}\n${p.requestId}`;

/**
 * Every key's state, from what Shellby knows right now.
 *   prompts: waiting permission prompts, oldest first:
 *            [{ tabId, requestId, toolName, label, detail, input, runsCreated, selfConfig }]
 *   tabs:    the tab summary (sessions.js `summary`)
 *   shown:   the conversation the panel last showed, or null
 * Each key: { mode: 'idle' | 'ready' | 'look', count, line, ref }.
 * line is the word under the glyph; ref is what a press has to match.
 */
function keys({ prompts = [], tabs = [], shown = null } = {}) {
  const titleOf = id => tabs.find(t => t.id === id)?.title || 'Untitled';
  const out = {};

  // ---- Allow and Deny: the oldest prompt
  const head = prompts[0];
  for (const action of ['allow', 'deny']) {
    if (!head) { out[action] = { mode: 'idle', count: 0, line: '', ref: '' }; continue; }
    const look = !!deskOnlyReason(head);
    out[action] = {
      mode: look ? 'look' : 'ready',
      count: prompts.length,
      // Which conversation, when there's only the one key to say it on.
      line: look ? 'Look' : short(head.toolName || titleOf(head.tabId)),
      ref: promptRef(head),
    };
  }

  // ---- Stop: the conversation on screen if it's working, else the only one working
  const working = tabs.filter(t => t.busy);
  const target = working.find(t => t.id === shown) || (working.length === 1 ? working[0] : null);
  if (!working.length) out.stop = { mode: 'idle', count: 0, line: '', ref: '' };
  else if (target) out.stop = { mode: 'ready', count: working.length, line: short(target.title), ref: target.id };
  // Several and none on screen: stopping a guess would be worse than a look.
  else out.stop = { mode: 'look', count: working.length, line: 'Look', ref: '' };

  // ---- Bring it home: the conversation on screen, if it has a copy
  const here = tabs.find(t => t.id === shown && t.worktree);
  if (!here) out.home = { mode: 'idle', count: 0, line: '', ref: '' };
  else if (here.busy || here.pending) out.home = { mode: 'idle', count: 0, line: 'Working', ref: '' };
  else out.home = { mode: 'ready', count: 0, line: short(here.worktree.branch?.split('/').pop() || here.title), ref: here.id };

  // ---- Ready to review: the review inbox's count
  const queue = tabs.filter(toReview).sort((a, b) => (a.ready.at || 0) - (b.ready.at || 0));
  out.review = queue.length
    ? { mode: 'ready', count: queue.length, line: short(titleOf(queue[0].id)), ref: '' }
    : { mode: 'idle', count: 0, line: '', ref: '' };

  return out;
}

/**
 * What a press does, given the keys as they are now (keys()).
 *   { do: 'answer', decision, tabId, requestId }   Allow or Deny the prompt
 *   { do: 'stop', tabId }                          interrupt that turn
 *   { do: 'home', tabId }                          bring that copy home
 *   { do: 'review' }                               open the review inbox
 *   { do: 'show', tabId? }                         open the panel there and let them look
 *   { error }                                      nothing to do, or it changed
 * ref: what the key showed when it was pressed.
 */
function resolvePress(action, ref, now) {
  if (!ACTIONS.includes(action)) return { error: 'unknown' };
  const key = now?.[action];
  if (!key || key.mode === 'idle') return { error: 'nothing' };
  if (action === 'review') return { do: 'review' };
  if (key.mode === 'look') {
    const tabId = key.ref ? key.ref.split('\n')[0] : null;
    return tabId ? { do: 'show', tabId } : { do: 'show' };
  }
  // It moved on between the key being drawn and the press: say so, do nothing.
  if (typeof ref !== 'string' || ref !== key.ref) return { error: 'changed' };
  if (action === 'allow' || action === 'deny') {
    const [tabId, requestId] = key.ref.split('\n');
    return { do: 'answer', decision: action, tabId, requestId };
  }
  return { do: action, tabId: key.ref };
}

// ------------------------------------------------------------------ the socket

const newToken = (bytes = crypto.randomBytes(32)) => Buffer.from(bytes).toString('base64url');

function sameSecret(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(token || ''));
  return !!token && a.length === b.length && crypto.timingSafeEqual(a, b);
}

class DeckServer extends EventEmitter {
  /**
   * token:   what every request must carry (Authorization: Bearer …)
   * getKeys: () => keys(), the first thing a plugin is sent
   * onPress: (action, ref) => Promise<{ ok, error? }>
   */
  constructor({ token, getKeys, onPress, port = DEFAULT_PORT }) {
    super();
    Object.assign(this, { token, getKeys, onPress, port });
    this.server = null;
    this.clients = new Set();
    this.status = 'off';          // 'off' | 'listening' | 'busy' | 'error'
    this.keepalive = null;
  }

  get connected() { return this.clients.size; }

  view() {
    return { status: this.status, port: this.port, connected: this.connected };
  }

  start() {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.on('error', err => {
      clearInterval(this.keepalive);
      this.keepalive = null;
      this.server = null;
      this.status = err.code === 'EADDRINUSE' ? 'busy' : 'error';
      this.emit('status', this.view());
    });
    server.listen(this.port, '127.0.0.1', () => {
      this.port = server.address().port;
      this.status = 'listening';
      this.keepalive = setInterval(() => this.write(': ping\n\n'), KEEPALIVE_MS);
      this.emit('status', this.view());
    });
    this.server = server;
  }

  stop() {
    clearInterval(this.keepalive);
    this.keepalive = null;
    for (const res of this.clients) { try { res.end(); } catch { /* gone */ } }
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.status = 'off';
    this.emit('status', this.view());
  }

  /** The keys changed: every plugin hears at once. */
  broadcast(state) {
    this.write(`data: ${JSON.stringify({ keys: state })}\n\n`);
  }

  write(chunk) {
    for (const res of [...this.clients]) {
      try { res.write(chunk); } catch { this.drop(res); }
    }
  }

  drop(res) {
    if (!this.clients.delete(res)) return;
    try { res.end(); } catch { /* already gone */ }
    this.emit('status', this.view());
  }

  /** Who may ask at all: the plugin, never a web page. */
  refuse(req) {
    // A browser always says where a cross-site request comes from; the plugin
    // never does. And a Host that isn't 127.0.0.1 is DNS rebinding.
    if (req.headers.origin != null) return 403;
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return 403;
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''));
    if (!m || !sameSecret(m[1], this.token)) return 401;
    return 0;
  }

  handle(req, res) {
    const url = String(req.url || '').split('?')[0];
    const no = this.refuse(req);
    if (no) { res.writeHead(no, { 'Content-Type': 'text/plain' }).end(no === 401 ? 'Pair again from Shellby.' : 'No.'); return; }
    if (url === `${API}/keys` && req.method === 'GET') { this.subscribe(req, res); return; }
    if (url === `${API}/press` && req.method === 'POST') { this.press(req, res); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not here.');
  }

  subscribe(req, res) {
    if (this.clients.size >= MAX_CLIENTS) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    this.clients.add(res);
    req.on('close', () => this.drop(res));
    res.on('error', () => this.drop(res));
    let first = null;
    try { first = this.getKeys?.(); } catch { /* the next change will say */ }
    res.write(`retry: 2000\n\ndata: ${JSON.stringify({ keys: first })}\n\n`);
    this.emit('status', this.view());
  }

  press(req, res) {
    const reply = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) { reply(415, { ok: false, error: 'json' }); return; }
    let body = '';
    let over = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (over) return;
      body += chunk;
      if (body.length > MAX_BODY) { over = true; reply(413, { ok: false, error: 'too big' }); req.destroy(); }
    });
    req.on('end', async () => {
      if (over) return;
      let msg;
      try { msg = JSON.parse(body); } catch { reply(400, { ok: false, error: 'json' }); return; }
      if (!msg || typeof msg.action !== 'string' || !ACTIONS.includes(msg.action)) { reply(400, { ok: false, error: 'unknown' }); return; }
      let r;
      try { r = await this.onPress(msg.action, typeof msg.ref === 'string' ? msg.ref.slice(0, 200) : ''); } catch { r = { ok: false, error: 'failed' }; }
      reply(200, r && typeof r === 'object' ? r : { ok: !!r });
    });
  }
}

module.exports = { DeckServer, keys, resolvePress, newToken, short, ACTIONS, DEFAULT_PORT, API, MAX_CLIENTS };
