// Dev servers: the ones Shellby started, what each is doing, and what happens
// when one falls over (a sign on the crab, a toast, and a card that asks before
// anything goes to Claude). See docs/plans/projects.md.
//
// runner.js does the processes and the log files, output.js reads them; this
// decides. Everything with a side effect comes in through deps, so the tests
// drive it with a fake runner and a fake clock.
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID, createHash } = require('crypto');
const out = require('./output');
const scripts = require('./scripts');

const MAX_RUNNING = 8;
const TICK_MS = 750;
const ALIVE_EVERY_MS = 3000;
const MARKER_RECHECK_MS = 300;        // cmd writes its marker, then exits a moment later
const TRIM_EVERY_MS = 60 * 1000;
const LOOP_WINDOW_MS = 5 * 60 * 1000;
const LOOP_CRASHES = 3;
const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 150;
// A server still running this long after it started is up, whether or not it
// said where: plenty never print an address Shellby can read.
const UP_GRACE_MS = 25 * 1000;
const LIVE = new Set(['starting', 'up']);
const ON_QUIT = ['keep', 'stop'];

const caseKey = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, n) : '');
const int = v => (Number.isInteger(v) ? v : null);
const num = v => (Number.isFinite(v) ? v : 0);
const localDir = p => typeof p === 'string' && path.isAbsolute(p) && !/^[\\/]{2}/.test(p) && p.length <= 400;
const LOCAL_URL = /^https?:\/\/localhost:\d{1,5}\/\S*$/;
const hashOf = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 32);

/** config.devServers -> settings with defaults, and the servers it remembers (checked against `dir`). */
function normalize(raw, dir = null) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const last = {};
  for (const [k, v] of Object.entries(r.last && typeof r.last === 'object' ? r.last : {})) {
    if (typeof v === 'string' && scripts.SCRIPT_RE.test(v)) last[k.slice(0, 400)] = v;
  }
  const resume = (Array.isArray(r.resume) ? r.resume : [])
    .filter(x => x && localDir(x.root) && scripts.SCRIPT_RE.test(String(x.script)))
    .map(x => ({ root: x.root, script: x.script, project: str(x.project, 80) || path.basename(x.root) }))
    .slice(0, MAX_RUNNING);
  return {
    onQuit: ON_QUIT.includes(r.onQuit) ? r.onQuit : 'keep',
    quitNoteSeen: r.quitNoteSeen === true,
    crab: bool(r.crab, true),
    sign: bool(r.sign, true),
    toast: bool(r.toast, true),
    last,
    resume,
    servers: (Array.isArray(r.servers) ? r.servers : []).map(s => normalizeServer(s, dir)).filter(Boolean).slice(0, MAX_RUNNING * 2),
  };
}

// A remembered server, checked: it came from settings.json, which anything
// could have edited. Its log must be the one Shellby would have made for it,
// and a running one must come with the start time that identifies its process.
function normalizeServer(s, dir) {
  if (!s || typeof s !== 'object' || !/^srv-[a-z0-9]{8}$/.test(s.id) || !localDir(s.root)) return null;
  if (!scripts.MANAGERS.includes(s.manager)) return null;
  const kind = s.kind === 'install' ? 'install' : 'server';
  if (kind === 'server' && !scripts.SCRIPT_RE.test(String(s.script))) return null;
  const log = dir ? path.join(dir, `${s.id}.log`) : null;
  let status = ['starting', 'up', 'crashed', 'failed'].includes(s.status) ? s.status : 'crashed';
  const pidStartedAt = num(s.pidStartedAt) || null;
  // Running, but with nothing to tell its process from another: it's not ours to touch.
  if (LIVE.has(status) && (!int(s.pid) || !pidStartedAt)) status = 'crashed';
  return {
    id: s.id, kind, root: s.root, project: str(s.project, 80) || path.basename(s.root), script: kind === 'install' ? null : s.script,
    manager: s.manager, framework: str(s.framework, 30) || null, pid: int(s.pid), pidStartedAt,
    log: log && s.log === log ? log : null, status, port: int(s.port), url: typeof s.url === 'string' && LOCAL_URL.test(s.url) ? s.url : null,
    startedAt: num(s.startedAt), upAt: num(s.upAt), endedAt: num(s.endedAt), exitCode: int(s.exitCode), restarts: int(s.restarts) || 0,
    seen: s.seen === true, missed: s.missed === true, neverUp: s.neverUp === true, fixTabId: str(s.fixTabId, 80) || null, fixedAt: num(s.fixedAt),
  };
}

const PERSISTED = ['id', 'kind', 'root', 'project', 'script', 'manager', 'framework', 'pid', 'pidStartedAt', 'log', 'status', 'port', 'url',
  'startedAt', 'upAt', 'endedAt', 'exitCode', 'restarts', 'seen', 'missed', 'neverUp', 'fixTabId', 'fixedAt'];
const pick = s => Object.fromEntries(PERSISTED.map(k => [k, s[k] ?? null]));

class DevServers extends EventEmitter {
  /**
   * deps: {
   *   config, dir (where logs go), now?()
   *   runner: { start, stop, isAlive, LogTail, trimLog, cleanLogs }   (runner.js)
   *   info(pid) -> { alive, createdAt } | null                        (native-windows.processInfo)
   *   readScripts(root) -> { manager, scripts, installed } | null     (scripts.read)
   *   notify({ title, body, action, onClick, tone })                  a toast (its button and body are one click)
   *   startTask(prompt, title, { cwd }) -> { ok, tabId, error }      a Claude tab (main.js startTask)
   *   panelFocused() -> bool                                          the panel is in front: no toast
   *   openCard(id)                                                    show the server's card
   *   startOpts?: extra options for runner.start (tests)
   * }
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.settings = normalize(deps.config.get('devServers'), deps.dir);
    this.servers = new Map(this.settings.servers.map(s => [s.id, s]));
    this.runtime = new Map(); // id -> { tail, buf, lastAlive, marker }
    this.crashes = new Map(); // root|script -> [ms]
    this.loopToasted = new Map(); // root|script -> ms
    this.busy = new Map(); // id -> the stop or restart in progress: one at a time per server
    this.timer = null;
    this.lastTrim = 0;
  }

  // ------------------------------------------------------------------ views

  view() {
    const { onQuit, quitNoteSeen, crab, sign, toast } = this.settings;
    return {
      settings: { onQuit, quitNoteSeen, crab, sign, toast },
      servers: [...this.servers.values()].map(s => this.publicView(s)),
      running: this.liveCount(),
      max: MAX_RUNNING,
    };
  }

  publicView(s) {
    // The pid and the log's path stay in main: the panel names a server by id.
    const { pid: _pid, pidStartedAt: _started, stopping: _stopping, thisSession: _mine, log, ...rest } = s;
    return { ...rest, command: this.commandOf(s), canFix: s.status === 'crashed' || s.status === 'failed', hasLog: !!log };
  }

  /** For the crab: { up, upPort, down } with the settings applied. */
  summary() {
    const all = [...this.servers.values()].filter(s => s.kind === 'server');
    const live = all.filter(s => LIVE.has(s.status));
    const down = all.filter(s => s.status === 'crashed' && !s.seen);
    const up = live.filter(s => s.status === 'up');
    return {
      up: this.settings.crab ? live.length : 0,
      upPort: this.settings.crab && live.length === 1 ? up[0]?.port ?? null : null,
      down: this.settings.sign ? down.length : 0,
      downId: down[0]?.id || null,
      firstId: (down[0] || live[0])?.id || null,
    };
  }

  liveCount() { return [...this.servers.values()].filter(s => LIVE.has(s.status)).length; }

  /** For "Is it safe to leave?": [{ project, port }]. */
  runningList() {
    return [...this.servers.values()].filter(s => s.kind === 'server' && LIVE.has(s.status)).map(s => ({ project: s.project, port: s.port }));
  }

  /** The servers in one clone, for the project page. */
  forRoot(root) {
    const k = caseKey(root);
    return [...this.servers.values()].filter(s => caseKey(s.root) === k).map(s => this.publicView(s));
  }

  lastScript(root) { return this.settings.last[caseKey(root)] || null; }

  commandOf(s) { return scripts.commandFor(s.manager, s.script, { install: s.kind === 'install' }); }

  // ------------------------------------------------------------------ settings

  setSettings(patch = {}) {
    const next = { ...this.settings };
    if (ON_QUIT.includes(patch.onQuit)) next.onQuit = patch.onQuit;
    for (const k of ['quitNoteSeen', 'crab', 'sign', 'toast']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    this.settings = next;
    this.save();
    return this.view();
  }

  save() {
    const { servers: _old, ...rest } = this.settings;
    this.deps.config.set({ devServers: { ...rest, servers: [...this.servers.values()].map(pick) } });
  }

  changed() {
    this.save();
    this.emit('change', this.view());
  }

  // One stop or restart at a time per server: a double click, or a toast's
  // Restart on top of the card's, would otherwise start two and lose one.
  exclusive(id, fn) {
    const prev = this.busy.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tracked = run.finally(() => { if (this.busy.get(id) === tracked) this.busy.delete(id); });
    this.busy.set(id, tracked);
    return run;
  }

  // ------------------------------------------------------------------ start / stop

  /**
   * Start `script` (or an install) in a project folder.
   * -> { ok: true, server } | { ok: false, error }
   */
  start({ root, script = null, project = null, kind = 'server' }) {
    if (!localDir(root)) return { ok: false, error: 'Unknown project folder.' };
    const found = this.deps.readScripts(root);
    if (!found) return { ok: false, error: "That folder doesn't have a package.json with scripts any more." };
    if (kind === 'server' && !found.scripts.some(s => s.name === script)) return { ok: false, error: `There's no "${script}" script in package.json.` };
    const same = [...this.servers.values()].find(s => caseKey(s.root) === caseKey(root) && s.kind === kind && s.script === (kind === 'install' ? null : script));
    if (same && (LIVE.has(same.status) || this.busy.has(same.id))) return { ok: true, server: this.publicView(same), already: true };
    if (this.liveCount() >= MAX_RUNNING) return { ok: false, error: `${MAX_RUNNING} are running already. Stop one first.` };
    const s = same || {
      id: `srv-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      kind, root, project: str(project, 80) || path.basename(root), script: kind === 'install' ? null : script, restarts: 0,
    };
    // A fresh run: whatever Claude was asked about the last one is done with.
    s.fixTabId = null;
    s.fixedAt = 0;
    s.manager = found.manager;
    s.framework = kind === 'install' ? null : found.scripts.find(x => x.name === script)?.framework || null;
    const r = this.launch(s);
    if (!r.ok) return r;
    if (kind === 'server') this.settings = { ...this.settings, last: { ...this.settings.last, [caseKey(root)]: script } };
    this.changed();
    return { ok: true, server: this.publicView(s) };
  }

  // Runs a server record's command (fresh log, fresh state). -> { ok } | { ok: false, error }
  launch(s) {
    const command = this.commandOf(s);
    if (!command) return { ok: false, error: "That script can't be run." };
    const log = path.join(this.deps.dir, `${s.id}.log`);
    const r = this.deps.runner.start({ root: s.root, command, logFile: log, ...(this.deps.startOpts || {}) });
    if (!r.ok) return { ok: false, error: r.error };
    const now = this.now();
    Object.assign(s, {
      pid: r.pid, pidStartedAt: this.deps.info(r.pid)?.createdAt || now, thisSession: true, log, status: 'starting', port: null, url: null,
      startedAt: now, upAt: 0, endedAt: 0, exitCode: null, seen: false, missed: false, neverUp: false, stopping: false,
    });
    this.servers.set(s.id, s);
    this.runtime.set(s.id, { tail: new this.deps.runner.LogTail(log), buf: new out.LineBuffer(), lastAlive: now, marker: undefined });
    // A child Shellby started this session says when it's done straight away.
    r.child?.once?.('exit', () => setTimeout(() => this.poll(s.id, { checkAlive: true }), 200));
    this.ensureTicking();
    return { ok: true };
  }

  /** Stop one, and forget it once it's really gone. -> { ok } | { ok: false, error } */
  stop(id) {
    return this.exclusive(id, async () => {
      const s = this.servers.get(id);
      if (!s) return { ok: false, error: 'That server has already gone.' };
      if (LIVE.has(s.status) && this.alive(s)) {
        s.stopping = true;
        await this.deps.runner.stop(s.pid);
        if (await this.waitGone(s)) {
          s.stopping = false;
          this.changed();
          return { ok: false, error: "It didn't stop. Try again, or end it from Task Manager." };
        }
      }
      if (this.servers.get(id) === s) this.forget(id);
      this.changed();
      return { ok: true };
    });
  }

  // Waits for a stopped server's process to go. -> true if it's still there
  // after STOP_WAIT_MS. Counted in real waits, not this.now(): that clock is
  // for timestamps, and a frozen one must never turn this into a hang.
  async waitGone(s) {
    for (let waited = 0; this.alive(s); waited += STOP_POLL_MS) {
      if (waited >= STOP_WAIT_MS) return true;
      await new Promise(r => setTimeout(r, STOP_POLL_MS));
    }
    return false;
  }

  /** Stop it if it's running, and start the same thing again. */
  restart(id) {
    return this.exclusive(id, async () => {
      const s = this.servers.get(id);
      if (!s) return { ok: false, error: 'That server has already gone.' };
      if (LIVE.has(s.status) && this.alive(s)) {
        s.stopping = true;
        await this.deps.runner.stop(s.pid);
        if (await this.waitGone(s)) {
          s.stopping = false;
          this.changed();
          return { ok: false, error: "It didn't stop, so it wasn't started again." };
        }
      }
      // Stopped or dismissed while we waited: leave it that way.
      if (this.servers.get(id) !== s) return { ok: false, error: 'That server has already gone.' };
      if (!LIVE.has(s.status) && this.liveCount() >= MAX_RUNNING) return { ok: false, error: `${MAX_RUNNING} are running already. Stop one first.` };
      this.runtime.delete(id);
      s.restarts = (s.restarts || 0) + 1;
      s.fixTabId = null;
      s.fixedAt = 0;
      const r = this.launch(s);
      if (!r.ok) { Object.assign(s, { status: 'crashed', seen: true, stopping: false }); this.changed(); return r; }
      this.changed();
      return { ok: true, server: this.publicView(s) };
    });
  }

  /** A crashed (or failed) one off the list. */
  dismiss(id) {
    const s = this.servers.get(id);
    if (!s || LIVE.has(s.status) || this.busy.has(id)) return { ok: false };
    this.forget(id);
    this.changed();
    return { ok: true };
  }

  /** You've looked at its card: the sign comes down. */
  markSeen(id) {
    const s = this.servers.get(id);
    if (!s || s.seen || s.status !== 'crashed') return;
    s.seen = true;
    this.changed();
  }

  /**
   * Stop every running server. detached: for quitting, where Shellby may be
   * gone before taskkill finishes: it's fired off on its own, and the servers
   * are forgotten (and saved) at once rather than after it returns.
   */
  async stopAll({ detached = false } = {}) {
    const live = [...this.servers.values()].filter(s => LIVE.has(s.status));
    if (detached) {
      for (const s of live) {
        s.stopping = true;
        if (this.alive(s)) this.deps.runner.stop(s.pid, { detached: true });
        this.forget(s.id);
      }
      this.changed();
      return;
    }
    await Promise.all(live.map(s => this.stop(s.id)));
  }

  /**
   * An update is about to install. Servers are stopped now and started again
   * when the new version starts (resumeAfterUpdate), so each comes back under
   * the version that runs it. (Up to 0.65 a server's supervisor was a
   * Shellby.exe, which the installer would end, leaving the server unwatched.)
   */
  stopForUpdate() {
    const live = [...this.servers.values()].filter(s => s.kind === 'server' && LIVE.has(s.status));
    this.settings = { ...this.settings, resume: live.map(s => ({ root: s.root, script: s.script, project: s.project })) };
    return this.stopAll({ detached: true });
  }

  resumeAfterUpdate() {
    const resume = this.settings.resume || [];
    if (!resume.length) return;
    this.settings = { ...this.settings, resume: [] };
    for (const r of resume) this.start({ root: r.root, script: r.script, project: r.project });
    this.changed();
  }

  forget(id) {
    this.servers.delete(id);
    this.runtime.delete(id);
    if (!this.liveCount()) this.stopTicking();
  }

  alive(s) {
    return this.deps.runner.isAlive(s.pid, s.pidStartedAt, this.deps.info, { trustBare: !!s.thisSession }) === true;
  }

  // ------------------------------------------------------------------ watching

  ensureTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stopTicking() { clearInterval(this.timer); this.timer = null; }

  tick() {
    const now = this.now();
    for (const s of [...this.servers.values()]) {
      if (!LIVE.has(s.status)) continue;
      const rt = this.runtime.get(s.id);
      this.poll(s.id, { checkAlive: !rt || rt.marker !== undefined || now - rt.lastAlive >= ALIVE_EVERY_MS });
    }
    if (now - this.lastTrim >= TRIM_EVERY_MS) {
      this.lastTrim = now;
      for (const s of this.servers.values()) if (LIVE.has(s.status) && s.log) this.deps.runner.trimLog(s.log);
    }
    if (!this.liveCount()) this.stopTicking();
  }

  /**
   * Read what one server said since last time, and see if it's still there.
   * An exit marker only counts once the cmd running it is really gone: a server can
   * print "[shellby-exit 0]" itself, and believing it would leave the real one
   * running with nobody watching.
   */
  poll(id, { checkAlive = false } = {}) {
    const s = this.servers.get(id);
    if (!s || !LIVE.has(s.status) || s.stopping) return;
    let rt = this.runtime.get(id);
    if (!rt) { rt = { tail: new this.deps.runner.LogTail(s.log), buf: new out.LineBuffer(), lastAlive: this.now(), marker: undefined }; this.runtime.set(id, rt); }
    let changed = false;
    let sawMarker = false;
    for (const line of rt.buf.push(rt.tail.read())) {
      const code = out.exitOf(line);
      if (code !== undefined) { rt.marker = code; sawMarker = true; continue; }
      if (s.kind === 'server' && !s.url) {
        const u = out.detectUrl(line);
        if (u) { Object.assign(s, { status: 'up', port: u.port, url: u.url, upAt: s.upAt || this.now() }); changed = true; }
      }
    }
    if (checkAlive || sawMarker) {
      rt.lastAlive = this.now();
      if (!this.alive(s)) {
        // Gone: one last read for the marker it may have left on its way out.
        for (const line of [...rt.buf.push(rt.tail.read()), ...rt.buf.flush()]) {
          const code = out.exitOf(line);
          if (code !== undefined) rt.marker = code;
        }
        return this.ended(s, rt.marker ?? null);
      }
      // A marker with that cmd still there: it may be on its way out, or
      // the server printed it. Look again shortly; only its absence decides.
      if (sawMarker) setTimeout(() => this.poll(id, { checkAlive: true }), MARKER_RECHECK_MS).unref?.();
      else if (s.status === 'starting' && s.kind === 'server' && this.livedPastGrace(s)) {
        Object.assign(s, { status: 'up', upAt: this.now() });
        changed = true;
      }
    }
    if (changed) { this.changed(); this.emit('up', this.publicView(s)); }
  }

  // Running long enough to count as up, with or without an address.
  livedPastGrace(s) { return !!s.startedAt && this.now() - s.startedAt >= UP_GRACE_MS; }

  ended(s, code, { quietly = false, unknown = false } = {}) {
    if (s.stopping) return;
    const neverUp = !s.upAt && !this.livedPastGrace(s);
    Object.assign(s, { endedAt: this.now(), exitCode: code });
    if (s.kind === 'install') {
      if (code === 0) {
        this.forget(s.id);
        this.changed();
        this.emit('installed', { root: s.root, project: s.project });
        return;
      }
      s.status = 'failed';
      this.changed();
      return;
    }
    s.status = 'crashed';
    s.neverUp = neverUp;
    s.missed = quietly;
    // Ended while Shellby was closed with no word on how (no marker): it may
    // have been stopped on purpose, so no sign for it, just the card.
    if (unknown) s.seen = true;
    this.changed();
    this.emit('crashed', this.publicView(s));
    if (!quietly) this.toastCrash(s, neverUp);
  }

  toastCrash(s, neverUp) {
    // Counted whether or not a toast shows, so a loop is still seen as one.
    const key = `${caseKey(s.root)}|${s.script}`;
    const now = this.now();
    const recent = [...(this.crashes.get(key) || []).filter(t => now - t < LOOP_WINDOW_MS), now];
    this.crashes.set(key, recent);
    if (!this.settings.toast || this.deps.panelFocused?.()) return;
    const looping = recent.length > LOOP_CRASHES;
    if (looping) {
      // One "keeps crashing" for a loop, not one toast per lap.
      if (now - (this.loopToasted.get(key) || 0) < LOOP_WINDOW_MS) return;
      this.loopToasted.set(key, now);
    }
    const what = s.framework || `${s.manager} run ${s.script}`;
    const code = Number.isInteger(s.exitCode) ? ` with code ${s.exitCode}` : '';
    this.deps.notify({
      title: looping ? `${s.project} dev server keeps crashing` : neverUp ? `${s.project} dev server didn't start` : `${s.project} dev server crashed`,
      body: looping ? `${what} has stopped ${recent.length} times in 5 minutes.` : `${what} exited${code}.`,
      tone: 'problem',
      action: 'See the error',
      onClick: () => this.deps.openCard(s.id),
    });
  }

  // ------------------------------------------------------------------ picking servers back up

  /**
   * After Shellby starts: each server it remembers is either still running
   * (picked back up, log and all) or ended while Shellby was closed (shown on
   * its card, without a toast for something that happened hours ago). Whether
   * it's running is asked of Windows first; a marker in the log alone never
   * decides it.
   */
  reattach() {
    for (const s of [...this.servers.values()]) {
      if (!LIVE.has(s.status)) continue;
      if (!s.log) { this.ended(s, null, { quietly: true, unknown: true }); continue; }
      const tail = this.deps.runner.LogTail.fromEnd(s.log);
      const rt = { tail, buf: new out.LineBuffer(), lastAlive: this.now(), marker: undefined };
      this.runtime.set(s.id, rt);
      const lines = rt.buf.push(tail.read());
      if (this.alive(s)) {
        if (!s.url) for (const l of lines) { const u = out.detectUrl(l); if (u) Object.assign(s, { status: 'up', port: u.port, url: u.url, upAt: s.upAt || this.now() }); }
        continue;
      }
      const marker = [...lines, ...rt.buf.flush()].map(out.exitOf).filter(c => c !== undefined).pop();
      this.ended(s, marker ?? null, { quietly: true, unknown: marker === undefined });
    }
    // Logs of servers long gone.
    this.deps.runner.cleanLogs(this.deps.dir, new Set([...this.servers.values()].map(s => s.log).filter(Boolean)), { now: this.now() });
    if (this.liveCount()) this.ensureTicking();
    this.changed();
    this.resumeAfterUpdate();
  }

  // ------------------------------------------------------------------ the log, and Claude

  /** -> { lines, errors: [index] } (redacted), or null. */
  log(id) {
    const s = this.servers.get(id);
    if (!s) return null;
    const lines = out.redactLines(this.lines(s));
    return { lines, errors: [...out.errorLines(lines)] };
  }

  // The lines in memory, or (for one that ended before this run of Shellby) the end of its log.
  lines(s) {
    const rt = this.runtime.get(s.id);
    if (rt?.buf.all().length) return rt.buf.all().filter(l => out.exitOf(l) === undefined);
    if (!s.log) return [];
    try {
      const buf = new out.LineBuffer();
      buf.push(this.deps.runner.LogTail.fromEnd(s.log).read());
      buf.flush();
      return buf.all().filter(l => out.exitOf(l) === undefined);
    } catch { return []; }
  }

  /**
   * What "Send to Claude" would send, exactly. -> { prompt, hash, lines, root, project } or null.
   * Redacted over the whole log first, so a private key printed over several
   * lines is blanked even when only its end is in the tail.
   */
  fixDraft(id, note = '') {
    const s = this.servers.get(id);
    if (!s || !['crashed', 'failed'].includes(s.status)) return null;
    const lines = out.tail(out.redactLines(this.lines(s)));
    const prompt = out.fixPrompt({ ...s, command: this.commandOf(s) }, lines, note);
    return { prompt, hash: hashOf(prompt), lines, root: s.root, project: s.project, note: String(note || '').slice(0, out.MAX_NOTE) };
  }

  /**
   * You pressed Send to Claude on the card. hash: the draft you were shown; if
   * the prompt has changed since (it crashed again, or your note was still
   * catching up), nothing is sent. -> { ok, tabId } | { ok: false, error, stale? }
   */
  sendFix(id, note = '', hash = null) {
    const s = this.servers.get(id);
    const draft = this.fixDraft(id, note);
    if (!s || !draft) return { ok: false, error: 'That server is running again, or gone.' };
    if (hash !== draft.hash) return { ok: false, stale: true, error: 'What would be sent has changed. Check it again, then send.' };
    const r = this.deps.startTask(draft.prompt, `Fix ${s.project} dev server`, { cwd: s.root });
    if (!r?.ok) return r || { ok: false, error: "Couldn't open a conversation." };
    s.fixTabId = r.tabId;
    s.fixedAt = 0;
    s.seen = true;
    this.changed();
    return { ok: true, tabId: r.tabId };
  }

  /** A Claude turn ended. If it was a fix, offer the restart. */
  onTabDone(tabId, ok) {
    const s = [...this.servers.values()].find(x => x.fixTabId && x.fixTabId === tabId);
    if (!s || !ok || LIVE.has(s.status)) return;
    s.fixedAt = this.now();
    this.changed();
    if (this.deps.panelFocused?.()) return;
    // Restarting is safe to do from a toast; sending to Claude never is. The
    // toast's button and its body are the same click (toast.js), so both
    // restart it and show the card, where you can watch it come back up.
    this.deps.notify({
      title: `Claude's done with ${s.project}`,
      body: 'Restart the dev server?',
      action: 'Restart',
      onClick: () => { this.restart(s.id); this.deps.openCard(s.id); },
    });
  }

  shutdown() {
    this.stopTicking();
    this.save();
  }
}

module.exports = { DevServers, normalize, hashOf, MAX_RUNNING, LOOP_CRASHES };
