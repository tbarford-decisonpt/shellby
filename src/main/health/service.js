// Health glue between the monitor and the rest of the app: settings,
// notifications (with cooldowns), the alert log, trophies and IPC. main.js
// passes in what it owns so this file never reaches into globals.
const { HealthMonitor } = require('./monitor');
const { createSensors } = require('./sensors');
const { createFakeSensors, createFakeProcesses, createFakeStartup, createFakeSpace } = require('./fake');
const { DEFAULT_THRESHOLDS, normalizeThresholds, askPrompt, rank, formatGb } = require('./rules');
const space = require('./space');
const hogs = require('./hogs');
const startup = require('./startup');
const { FootprintTracker } = require('./footprint');

const HEALTH_DEFAULTS = Object.freeze({
  enabled: true,   // watch at all
  moods: true,     // Shellby reacts on the desktop
  notify: true,    // Windows notifications for warnings
  lhmPort: 8085,
  space: true,     // look at what Docker, WSL and the package caches are holding
  ...DEFAULT_THRESHOLDS,
});
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;   // per check, for warnings
const CRITICAL_COOLDOWN_MS = 10 * 60 * 1000; // per check, for repeat "very high" alerts
const LOG_MAX = 40;
const HOGS_FRESH_MS = 4000;   // one perf-counter read serves a burst of refreshes
const ZERO_TIMING = { temp: { raiseMs: 0, clearMs: 0, margin: 3 }, ram: { raiseMs: 0, clearMs: 0, margin: 3 }, disk: { raiseMs: 0, clearMs: 0, margin: 2 } };

/** Validate a settings patch from the renderer on top of the current settings. */
function normalizeHealthSettings(current, patch = {}) {
  const base = { ...HEALTH_DEFAULTS, ...(current && typeof current === 'object' ? current : {}) };
  const next = { ...base };
  for (const k of ['enabled', 'moods', 'notify', 'space']) if (k in patch) next[k] = !!patch[k];
  if ('lhmPort' in patch) {
    const p = Number(patch.lhmPort);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) next.lhmPort = p;
  }
  const t = normalizeThresholds({ ...base, ...pick(patch, Object.keys(DEFAULT_THRESHOLDS)) });
  return { enabled: next.enabled, moods: next.moods, notify: next.notify, lhmPort: next.lhmPort, space: next.space, ...t };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

class HealthService {
  /**
   * deps: { config, send, getPanel, notify, showHealth, stat, startTask, onMood, fakeScenario?, instant? }
   *   startTask(prompt, title) -> { ok, tabId?, error? }
   *   onMood(mood|null): the critter shows it (only called while moods are on)
   *   confirm(spec) -> index of the button chosen in the isolated confirm window
   *   selfPids() -> every PID of Shellby's own, which End task never touches
   *   ownedPids() -> Set of PIDs Shellby's tasks started and still have running
   *   appMetrics() -> app.getAppMetrics(), for his own footprint (none: no footprint line)
   */
  constructor(deps) {
    this.deps = deps;
    const fake = deps.fakeScenario;
    this.sensors = fake ? createFakeSensors(fake) : createSensors();
    this.sensors.setLhmPort?.(this.settings.lhmPort);
    this.monitor = new HealthMonitor({
      sensors: this.sensors,
      getThresholds: () => this.settings,
      unwatched: () => !this.panelOpen(),
      timing: deps.instant || fake ? ZERO_TIMING : undefined,
    });
    this.lastNotified = new Map();
    // What's hogging it, and what starts with Windows. Both are read on demand
    // from the Health view, never from the poll loop.
    this.processes = deps.processReader || (fake ? createFakeProcesses() : hogs.createProcessReader());
    this.startup = deps.startupReader || (fake ? createFakeStartup() : startup.createStartupReader());
    this.hogRead = null;
    this.shownHogs = new Map();   // pid -> process: the only ones endTask() will touch
    this.shownGroups = new Map(); // lowercased name -> group: the only ones endGroup() will touch
    this.ending = false;
    this.shownStartup = new Map(); // id -> startup entry: the only ones setStartup() will touch
    this.switching = false;
    // Docker, WSL and the package caches. Measured rarely and well off the poll
    // loop: walking a cache is not something to do every five seconds.
    this.space = deps.spaceProbe || (fake ? createFakeSpace(fake) : space.createSpaceProbe());
    this.spaceSnapshot = null;
    // His own CPU and memory, read on the monitor's beat: getAppMetrics() is a
    // cheap call in main, with no process list to walk.
    this.footprint = deps.appMetrics ? new FootprintTracker({ metrics: deps.appMetrics, panelOpen: () => this.panelOpen() }) : null;
    this.monitor.on('sample', snap => this.toPanel('health', { ...snap, settings: this.settings, space: this.spaceSnapshot, self: this.self() }));
    this.monitor.on('mood', mood => deps.onMood(this.settings.moods ? mood : null));
    this.monitor.on('change', change => this.onChange(change));
    // readings() is the monitor's own list; this adds the one that doesn't come
    // from a sensor. Measuring is async and cached, so the poll never waits.
    const baseReadings = this.monitor.readings.bind(this.monitor);
    this.monitor.readings = sample => {
      if (this.settings.space) this.refreshSpace();
      return [...baseReadings(sample), ...space.readings(this.spaceSnapshot)];
    };
  }

  get settings() { return normalizeHealthSettings(this.deps.config.get('health')); }
  get mood() { return this.settings.moods ? this.monitor.mood : null; }
  get log() { const l = this.deps.config.get('healthLog'); return Array.isArray(l) ? l : []; }

  /** Kick off a measurement if the cached one has gone stale. Never awaited. */
  refreshSpace() {
    this.space.read().then(snap => { this.spaceSnapshot = snap; }).catch(() => {});
  }

  start() {
    if (!this.settings.enabled) return;
    this.monitor.start();
    if (this.settings.space) this.refreshSpace();
  }
  stop() { this.monitor.stop(); }

  panelOpen() {
    const panel = this.deps.getPanel();
    return !!panel && !panel.isDestroyed() && panel.isVisible();
  }

  /** Shellby's own footprint (footprint.js), or null before it has two readings. */
  self() { return this.footprint ? this.footprint.sample() : null; }

  toPanel(channel, payload) {
    const panel = this.deps.getPanel();
    if (panel && !panel.isDestroyed() && panel.isVisible()) this.deps.send(panel, channel, payload);
  }

  view() {
    this.monitor.watched(); // the Health view is open: back to the five-second beat now
    return {
      ...this.monitor.snapshot(),
      settings: this.settings, log: this.log, fake: !!this.sensors.fake,
      space: this.spaceSnapshot, self: this.self(),
    };
  }

  async setSettings(patch) {
    const prev = this.settings;
    const next = normalizeHealthSettings(prev, patch);
    this.deps.config.set({ health: next });
    if (next.lhmPort !== prev.lhmPort) { this.sensors.setLhmPort?.(next.lhmPort); await this.monitor.recheck(); }
    if (next.enabled && !this.monitor.running) this.monitor.start();
    if (!next.enabled && this.monitor.running) this.monitor.stop();
    if (next.moods !== prev.moods) this.deps.onMood(next.moods ? this.monitor.mood : null);
    return this.view();
  }

  async recheck() {
    if (this.settings.space) { try { this.spaceSnapshot = await this.space.read({ force: true }); } catch { /* leave the old one */ } }
    await this.monitor.recheck();
    return this.view();
  }

  /** Start a read-only Claude Code task that investigates one check. */
  ask(checkId) {
    const check = Object.prototype.hasOwnProperty.call(this.monitor.checks, checkId) ? this.monitor.checks[checkId] : null;
    if (!check?.reading) return { ok: false, error: "That reading isn't available right now." };
    // The reclaim check's prompt needs the whole snapshot, not just the number.
    const prompt = check.reading.kind === 'reclaim'
      ? space.spacePrompt(this.spaceSnapshot)
      : askPrompt(check.reading, this.settings);
    if (!prompt) return { ok: false, error: "Shellby doesn't know how to look into that one." };
    this.deps.stat('health-asked');
    return this.deps.startTask(prompt, `Health: ${check.reading.label}`);
  }

  /**
   * The busiest processes by 'cpu', 'gpu' or 'mem' (by default whichever
   * explains the current mood), one by one and added up by app:
   *   { ok, metric, total, procs: [{ pid, name, cpu, gpu, mem, owned, locked }],
   *     groups: [{ name, count, cpu, gpu, mem, owned, locked }] }
   * owned says Shellby's own tasks started it. Group PIDs stay here.
   */
  async hogs(metric) {
    const m = hogs.METRICS.includes(metric) ? metric : hogs.metricFor(this.monitor.mood?.id) || 'cpu';
    const all = await this.readProcesses();
    if (!all) return { ok: false, metric: m, procs: [], groups: [], error: "Shellby couldn't read the process list." };
    const owned = this.ownedPids();
    const top = hogs.topBy(all, m);
    const groups = hogs.groupByName(all, m, hogs.TOP_N, owned);
    this.shownHogs = new Map(top.map(p => [p.pid, p]));
    this.shownGroups = new Map(groups.map(g => [g.name.toLowerCase(), g]));
    return {
      ok: true, metric: m, total: all.length,
      procs: top.map(p => ({ ...p, owned: owned.has(p.pid), locked: this.lockedReason(p) })),
      groups: groups.map(({ pids, ...g }) => ({ ...g, locked: g.count > 1 ? this.groupLock(g) : this.lockedReason(all.find(p => p.pid === pids[0])) })),
    };
  }

  /** The process list, or null. One perf-counter read serves a burst of callers. */
  readProcesses() {
    if (!this.hogRead || Date.now() - this.hogRead.at > HOGS_FRESH_MS) {
      this.hogRead = { at: Date.now(), promise: this.processes.read().catch(() => null) };
    }
    return this.hogRead.promise;
  }

  ownedPids() {
    try { return this.deps.ownedPids?.() || new Set(); } catch { return new Set(); }
  }

  /** Start the "what's running and what don't I need" task. */
  async askProcesses() {
    const all = await this.readProcesses();
    if (!all) return { ok: false, error: "Shellby couldn't read the process list." };
    this.deps.stat('health-asked');
    // Always in Ask mode: any program can pick its own process name, so
    // whatever Claude wants to run or end still needs your OK.
    return this.deps.startTask(hogs.processesPrompt(all, this.ownedPids()), "Health: what's running", { mode: 'ask' });
  }

  // A group is ended by name, so a protected name locks the lot; Shellby's own
  // PIDs inside an otherwise endable group are just skipped by endGroup().
  groupLock(group) {
    return hogs.protectedReason({ pid: -1, name: group.name }, []);
  }

  lockedReason(proc) {
    const self = [process.pid, process.ppid, ...(this.deps.selfPids?.() || [])];
    return hogs.protectedReason(proc, self);
  }

  /**
   * End a process from the last hogs() list, after asking in the confirm
   * window. The PID is checked again after the answer, in case it closed and
   * Windows handed its number to something else while the question was open.
   */
  async endTask(pid) {
    const proc = Number.isInteger(pid) ? this.shownHogs.get(pid) : null;
    if (!proc) return { ok: false, error: 'That one is no longer in the list. Refresh and try again.' };
    const locked = this.lockedReason(proc);
    if (locked) return { ok: false, error: locked };
    if (this.ending) return { ok: false, error: 'Shellby is already asking about another one.' };
    this.ending = true;
    let answer;
    try {
      answer = await this.deps.confirm({
        icon: '🛑', danger: true,
        title: `End ${proc.name}?`,
        message: `Windows closes ${proc.name} straight away, like End task in Task Manager.`,
        detail: `Process ${proc.pid}: ${proc.cpu}% CPU${proc.gpu != null ? `, ${proc.gpu}% GPU` : ''}, ${formatGb(proc.mem / 1024 ** 3)} of memory.`,
        note: "Anything unsaved in it is lost. If it's an app you have open, closing it yourself is safer.",
        buttons: [{ label: 'End task', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
    } finally {
      this.ending = false;
    }
    if (answer !== 0) return { ok: false, cancelled: true };
    const now = await this.processes.nameOf(pid);
    if (now === undefined) return { ok: false, error: "Shellby couldn't check that process just now. Try again." };
    if (!now) { this.shownHogs.delete(pid); this.hogRead = null; return { ok: true, gone: true }; }
    if (now.toLowerCase() !== proc.name.toLowerCase()) return { ok: false, error: `${proc.name} already closed, so Shellby left process ${pid} alone.` };
    const result = await this.processes.end(pid);
    if (result.ok) { this.shownHogs.delete(pid); this.hogRead = null; }
    return result;
  }

  /**
   * End every process in one app group from the last hogs() list, after one
   * question in the confirm window. Each PID is checked again afterwards, in a
   * single tasklist read, and only ended if it still runs under the same name.
   * -> { ok, ended, gone, failed, error? } or { ok: false, cancelled: true }.
   */
  async endGroup(name) {
    const group = typeof name === 'string' ? this.shownGroups.get(name.toLowerCase()) : null;
    if (!group) return { ok: false, error: 'That one is no longer in the list. Refresh and try again.' };
    const locked = this.groupLock(group);
    if (locked) return { ok: false, error: locked };
    const notSelf = () => {
      const self = new Set([process.pid, process.ppid, ...(this.deps.selfPids?.() || [])]);
      return group.pids.filter(pid => !self.has(pid));
    };
    const pids = notSelf();
    if (!pids.length) return { ok: false, error: "That's Shellby himself." };
    if (this.ending) return { ok: false, error: 'Shellby is already asking about another one.' };
    this.ending = true;
    let answer;
    try {
      answer = await this.deps.confirm({
        icon: '🛑', danger: true,
        title: pids.length === 1 ? `End ${group.name}?` : `End all ${pids.length} ${group.name} processes?`,
        message: `Windows closes ${pids.length === 1 ? group.name : `every ${group.name} process`} straight away, like End task in Task Manager.`,
        detail: `Together: ${group.cpu}% CPU${group.gpu != null ? `, ${group.gpu}% GPU` : ''}, ${formatGb(group.mem / 1024 ** 3)} of memory.${group.owned ? ` ${group.owned} of them were started by Shellby's tasks.` : ''}`,
        note: "Anything unsaved in them is lost. If it's an app you have open, closing it yourself is safer.",
        buttons: [{ label: pids.length === 1 ? 'End task' : 'End all', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
    } finally {
      this.ending = false;
    }
    if (answer !== 0) return { ok: false, cancelled: true };
    const now = await this.processes.names?.();
    if (!now) return { ok: false, error: "Shellby couldn't check those processes just now. Try again." };
    // Shellby's own PIDs again, as of now: one may have been reused while the
    // question was open. The names were read in one go just above, and ending is
    // a plain TerminateProcess each, so the gap a PID could be reused in (and
    // then only by a process of the same name the user agreed to end) is tiny.
    const stillNotSelf = new Set(notSelf());
    let ended = 0, gone = 0, failed = 0, error = null;
    for (const pid of pids.filter(p => stillNotSelf.has(p))) {
      const running = now.get(pid);
      if (!running || running.toLowerCase() !== group.name.toLowerCase()) { gone++; continue; }
      const r = await this.processes.end(pid);
      if (r.ok) ended++; else { failed++; error = error || r.error; }
    }
    this.shownGroups.delete(group.name.toLowerCase());
    this.hogRead = null;
    return { ok: ended + gone > 0 || !failed, ended, gone, failed, error };
  }

  /**
   * What starts with Windows: { ok, items: [{ id, name, command, location, off, locked }] }.
   * locked says why Shellby won't switch one (null when he will). The registry
   * name stays here: the panel only ever sends back an id from this list.
   */
  async startupItems({ force = false } = {}) {
    const items = await this.startup.read({ force }).catch(() => null);
    if (!items) return { ok: false, items: [], error: "Shellby couldn't read the startup list." };
    // Name and location: what the parser keeps unique, and it can't drift onto
    // another entry if the list is re-read and re-sorted before the click.
    this.shownStartup = new Map(items.map(item => [`${item.location}|${item.name}`.toLowerCase(), item]));
    return {
      ok: true,
      items: [...this.shownStartup].map(([id, item]) => {
        const { switch: _sw, ...shown } = item;
        return { ...shown, id, locked: this.startupLock(item) };
      }),
    };
  }

  startupLock(item) {
    // By the exe it runs, not the name: another Shellby build (com.someone.shellby)
    // is just another app here, and Open at login doesn't control it.
    const exe = (this.deps.selfExe || process.execPath).toLowerCase();
    if (item.command.toLowerCase().includes(exe)) return "That's Shellby: use Open at login in Settings.";
    if (item.switch) return null;
    if (/everyone/.test(item.location)) return 'Entries for everyone need an administrator. Switch it in Task Manager → Startup apps.';
    return "Windows has no on/off switch for this one.";
  }

  /**
   * Switch one entry from the last startupItems() list on or off, the way Task
   * Manager does: the entry stays put, so it can always be switched back.
   * -> { ok, name, off, list } with the list read again, or { ok: false, error }.
   */
  async setStartup(id, off) {
    const item = typeof id === 'string' ? this.shownStartup.get(id) : null;
    if (!item) return { ok: false, error: 'That one is no longer in the list. Refresh and try again.' };
    const locked = this.startupLock(item);
    if (locked) return { ok: false, error: locked };
    if (this.switching) return { ok: false, error: 'Shellby is still switching another one.' };
    this.switching = true;
    let r;
    try {
      r = await this.startup.set(item.switch, !!off);
    } catch {
      r = null;
    } finally {
      this.switching = false;
    }
    if (!r?.ok) return { ok: false, error: r?.error || "Windows didn't take the change." };
    return { ok: true, name: item.name, off: !!off, list: await this.startupItems({ force: true }) };
  }

  /** Start the read-only startup audit task. */
  async askStartup() {
    const { ok, items } = await this.startupItems();
    if (!ok) return { ok: false, error: "Shellby couldn't read the startup list." };
    this.deps.stat('health-asked');
    // Always in Ask mode: the prompt carries registry text any installer can
    // write, so whatever Claude wants to run still needs your OK.
    return this.deps.startTask(startup.startupPrompt(items), 'Health: startup apps', { mode: 'ask' });
  }

  onChange(change) {
    const { id, from, to, reading, text } = change;
    const up = rank(to) > rank(from);
    const entry = { at: Date.now(), id, kind: reading.kind, label: reading.label, from, to, value: Math.round(reading.value * 10) / 10, title: text.title };
    this.deps.config.set({ healthLog: [entry, ...this.log].slice(0, LOG_MAX) });
    this.toPanel('health:log', this.log);

    // Trophies for coming back from the edge.
    if (!up && to === 'ok' && (reading.kind === 'gpu-temp' || reading.kind === 'cpu-temp')) this.deps.stat('health-cooled');
    if (!up && to === 'ok' && reading.kind === 'disk') this.deps.stat('health-space-freed');

    if (!up || !this.settings.notify) return;
    // Per check: a warning repeats at most every 30 minutes and "very high" every
    // 10, but a warning that turns very high always gets through.
    const last = this.lastNotified.get(id);
    const quiet = to === 'critical' ? CRITICAL_COOLDOWN_MS : NOTIFY_COOLDOWN_MS;
    const escalated = to === 'critical' && last?.level !== 'critical';
    if (last && !escalated && Date.now() - last.at < quiet) return;
    this.lastNotified.set(id, { at: Date.now(), level: to });
    this.deps.notify(text.title, text.body, () => this.deps.showHealth());
  }
}

module.exports = { HealthService, normalizeHealthSettings, HEALTH_DEFAULTS };
