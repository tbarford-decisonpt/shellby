// Shellby on your Discord profile, through Rich Presence.
//
// "Lv 12 Abyssal Admin · working with Claude Code" under your name, the way a
// game shows what you're playing. Discord's desktop app listens on a local
// named pipe (\\?\pipe\discord-ipc-0, then -1 and up if that one is taken) and
// speaks a small framed-JSON protocol: no sign-in, no token, no server of ours.
// The application ID below is public, like the GitHub one in github/auth.js;
// it's what Discord shows as the name and picture beside the activity.
//
// The frame codec and activityFor are pure and tested. The client is tested
// against a fake Discord on a real pipe, so the handshake, framing, PINGs,
// rate limiting and reconnecting are all exercised (test/discord.test.js).
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

// Shellby's application on discord.com/developers. Its Rich Presence art needs
// an asset named `shellby`. SHELLBY_DISCORD_CLIENT_ID points a dev run at
// another application.
const CLIENT_ID = '';
const clientId = (env = process.env) => (/^\d{17,20}$/.test(env.SHELLBY_DISCORD_CLIENT_ID || '') ? env.SHELLBY_DISCORD_CLIENT_ID : CLIENT_ID);

const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });
const HEADER_SIZE = 8;
const MAX_FRAME = 64 * 1024;          // READY is ~1 KB; anything bigger isn't Discord
const PIPES = 10;                      // discord-ipc-0 to -9, one per Discord install running
const CONNECT_TIMEOUT_MS = 2000;
const READY_TIMEOUT_MS = 5000;
// Discord takes at most 5 SET_ACTIVITY in 20 seconds and drops the rest, and
// the crab refreshes many times a second: one every 15 s, the latest winning.
const MIN_GAP_MS = 15 * 1000;
const RETRY_MS = 60 * 1000;           // Discord closed: look again in a minute

const HOMEPAGE = 'https://github.com/x-salmon/shellby';

// ------------------------------------------------------------------ the wire

/** One frame: op and length (int32 LE), then the JSON. */
function encodeFrame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(HEADER_SIZE);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * Whole frames off the front of buf: { frames, rest }, or { bad } when what's
 * on the pipe isn't Discord (a length out of range, or JSON that won't parse).
 */
function decodeFrames(buf) {
  const frames = [];
  let at = 0;
  while (buf.length - at >= HEADER_SIZE) {
    const op = buf.readInt32LE(at);
    const size = buf.readInt32LE(at + 4);
    if (size < 0 || size > MAX_FRAME) return { bad: true };
    if (buf.length - at - HEADER_SIZE < size) break;
    let data;
    try { data = JSON.parse(buf.subarray(at + HEADER_SIZE, at + HEADER_SIZE + size).toString('utf8')); } catch { return { bad: true }; }
    frames.push({ op, data });
    at += HEADER_SIZE + size;
  }
  return { frames, rest: buf.subarray(at) };
}

/** Where Discord might be listening, first choice first. */
function pipePaths(platform = process.platform, env = process.env) {
  const at = platform === 'win32' ? i => `\\\\?\\pipe\\discord-ipc-${i}`
    : i => path.join(env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp', `discord-ipc-${i}`);
  return Array.from({ length: PIPES }, (_, i) => at(i));
}

// ------------------------------------------------------------------ what it says

// Discord wants every line 2 to 128 characters.
function clip(text, max = 128) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 2) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const MOODS = { hot: 'running hot', scorching: 'overheating', dizzy: 'memory nearly full', stuffed: 'drive nearly full' };

/** Which line he's on, for when it began (a change restarts Discord's clock). */
function phaseOf(state) {
  return state === 'working' || state === 'asking' || state === 'sleeping' ? state : 'idle';
}

/**
 * The activity for where he is now. Pure.
 *   s.level, s.title  his level and title (xp.js)
 *   s.state, s.busy   the crab's state and how many tasks are running
 *   s.task            the running task's title, only when you share it
 *   s.health          { mood } from the health monitor, or null
 *   s.since           when this phase began (ms)
 *   s.cardUrl         his calling card, when visiting crabs is on (friends.js)
 */
function activityFor(s) {
  const phase = phaseOf(s.state);
  const busy = Math.max(0, Math.floor(Number(s.busy) || 0));
  let line;
  if (phase === 'working') {
    const task = busy <= 1 ? clip(s.task, 100) : null;
    line = task || (busy > 1 ? `${busy} tasks with Claude Code` : 'working with Claude Code');
  } else if (phase === 'asking') line = 'waiting for your OK';
  else if (phase === 'sleeping') line = 'napping';
  else line = MOODS[s.health?.mood] || 'pottering about the desk';
  const level = Number.isInteger(s.level) && s.level > 0 ? s.level : null;
  const activity = {
    details: clip(level ? `Lv ${level} ${s.title || 'crab'}` : 'a hermit crab'),
    state: clip(line),
    assets: { large_image: 'shellby', large_text: 'Shellby, the crab who runs Claude Code' },
    buttons: [],
    instance: false,
  };
  if (Number.isFinite(s.since) && s.since > 0) activity.timestamps = { start: Math.floor(s.since) };
  if (typeof s.cardUrl === 'string' && /^https:\/\/gist\.github\.com\/[\w-]+$/.test(s.cardUrl)) activity.buttons.push({ label: 'Visit my crab', url: s.cardUrl });
  activity.buttons.push({ label: 'Get Shellby', url: HOMEPAGE });
  return activity;
}

// ------------------------------------------------------------------ the client

/**
 * One connection to Discord, kept up while it's on. set() whenever there's
 * something new to show; it goes out at most every MIN_GAP_MS, and only if it
 * changed. Statuses: 'off', 'connecting', 'looking' (Discord isn't running),
 * 'on' (showing), 'refused' (Discord turned the application down).
 * Emits 'change' when the status or account changes.
 */
class DiscordPresence extends EventEmitter {
  constructor({ id = clientId(), pipes = pipePaths(), pid = process.pid, now = Date.now, minGapMs = MIN_GAP_MS, retryMs = RETRY_MS, log = () => {} } = {}) {
    super();
    this.id = id;
    this.pipes = pipes;
    this.pid = pid;
    this.now = now;
    this.minGapMs = minGapMs;
    this.retryMs = retryMs;
    this.log = log;
    this.status = 'off';
    this.user = null;
    this.lastError = null;
    this.socket = null;
    this.wanted = null;      // the activity to show, or null for nothing
    this.sentKey = 'null';   // what Discord has from us, as JSON: nothing, on a fresh connection
    this.sentAt = 0;
    this.nonce = 0;
    this.timers = { retry: null, flush: null, ready: null };
  }

  get configured() { return !!this.id; }

  view() { return { status: this.status, user: this.user, error: this.lastError, configured: this.configured }; }

  start() {
    if (this.status !== 'off') return;
    if (!this.configured) { this.setStatus('refused', 'No Discord application in this build.'); return; }
    this.connect();
  }

  /** Hang up. Discord clears the activity itself when the pipe closes. */
  stop() {
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); this.timers[k] = null; }
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.sentKey = 'null';
    this.user = null;
    this.lastError = null;
    this.setStatus('off');
  }

  /** What to show next (an activity from activityFor), or null to show nothing. */
  set(activity) {
    this.wanted = activity || null;
    this.flush();
  }

  setStatus(status, error = this.lastError) {
    if (status === this.status && error === this.lastError) return;
    this.status = status;
    this.lastError = error;
    this.emit('change', this.view());
  }

  connect(index = 0) {
    if (this.status === 'off' && index === 0) this.setStatus('connecting', null);
    if (index >= this.pipes.length) {
      this.setStatus('looking', null);
      this.retryLater();
      return;
    }
    const socket = net.createConnection(this.pipes[index]);
    this.socket = socket;
    let buf = Buffer.alloc(0);
    let opened = false;
    const giveUp = setTimeout(() => socket.destroy(new Error('timed out')), CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      opened = true;
      clearTimeout(giveUp);
      socket.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: this.id }));
      this.timers.ready = setTimeout(() => socket.destroy(new Error('no answer from Discord')), READY_TIMEOUT_MS);
    });
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const got = decodeFrames(buf);
      if (got.bad) { socket.destroy(new Error('not Discord')); return; }
      buf = got.rest;
      for (const f of got.frames) this.onFrame(socket, f);
    });
    socket.on('error', () => {}); // 'close' follows and decides
    socket.on('close', () => {
      clearTimeout(giveUp);
      clearTimeout(this.timers.ready);
      if (this.socket !== socket) return; // stop(), or a newer connection
      this.socket = null;
      this.sentKey = 'null';
      if (!opened) { this.connect(index + 1); return; } // nobody on this pipe: the next one
      this.user = null;
      if (this.status !== 'refused') this.setStatus('looking', null);
      this.retryLater();
    });
  }

  retryLater() {
    clearTimeout(this.timers.retry);
    this.timers.retry = setTimeout(() => { this.timers.retry = null; if (this.status !== 'off') this.connect(); }, this.retryMs);
    this.timers.retry.unref?.();
  }

  onFrame(socket, { op, data }) {
    if (op === OP.PING) { socket.write(encodeFrame(OP.PONG, data)); return; }
    if (op === OP.CLOSE) {
      // Turned down: most often an application ID Discord doesn't know.
      this.log(`discord: closed (${data?.code}): ${data?.message}`);
      this.setStatus('refused', clip(data?.message) || 'Discord said no.');
      socket.destroy();
      return;
    }
    if (op !== OP.FRAME) return;
    if (data?.evt === 'READY') {
      clearTimeout(this.timers.ready);
      const u = data.data?.user;
      this.user = u ? clip(u.global_name || u.username, 40) : null;
      this.sentKey = 'null';
      this.setStatus('on', null);
      this.flush();
    } else if (data?.evt === 'ERROR') {
      this.log(`discord: ${data.cmd || ''} ${data.data?.code}: ${data.data?.message}`);
    }
  }

  flush() {
    if (this.status !== 'on' || !this.socket) return;
    const key = JSON.stringify(this.wanted);
    if (key === this.sentKey) return;
    const wait = this.sentAt + this.minGapMs - this.now();
    if (wait > 0) {
      if (!this.timers.flush) this.timers.flush = setTimeout(() => { this.timers.flush = null; this.flush(); }, wait);
      return;
    }
    const args = this.wanted ? { pid: this.pid, activity: this.wanted } : { pid: this.pid };
    this.socket.write(encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce: String(++this.nonce) }));
    this.sentKey = key;
    this.sentAt = this.now();
  }
}

module.exports = {
  CLIENT_ID, HEADER_SIZE, HOMEPAGE, MAX_FRAME, MIN_GAP_MS, OP,
  DiscordPresence, activityFor, clientId, clip, decodeFrames, encodeFrame, phaseOf, pipePaths,
};
