// The time tracker's moving parts: every 15 seconds it looks at the window in
// front, how long since you touched the keyboard, and where Claude is working,
// and gives the moment to a project (timetrack.js decides which). Once a
// minute it checks the git reflogs of the projects it knows, so a commit,
// checkout or pull counts as a sign of where you are. It keeps the day's
// seconds in memory and writes them to settings every couple of minutes and on
// quit, plus the Time page's view, edits and exports (CSV, PDF, clipboard).
//
// Nothing here leaves the PC. A window's title is matched and dropped; only
// project, day and seconds are kept. main.js passes in what it owns.
const fs = require('fs');
const path = require('path');
const tt = require('./timetrack');
const { timesheetHtml, exportName } = require('./timesheet');
const gitinfo = require('./gitinfo');

const TICK_MS = 15 * 1000;
const GIT_EVERY_MS = 60 * 1000;
const SAVE_EVERY_MS = 2 * 60 * 1000;
const GIT_FRESH_MS = 3 * 60 * 1000;   // a reflog that moved this recently is "now"
const COMMITS_TTL_MS = 60 * 1000;
const MAX_WATCHED = 30;
const MAX_LOOKUPS = 40;               // projects asked for their commits in one view
const RESOLVE_CACHE = 200;
const RETRY_MS = 60 * 1000;          // a folder git couldn't place (busy, timed out) is asked again after this

const caseKey = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const folderName = key => key.split(/[\\/]/).filter(Boolean).pop() || key;

class TimeTracker {
  /**
   * deps: {
   *   config, toPanel(channel, payload), now?()
   *   front() -> { pid, exe, title } | null      the window in front (native-windows.frontWindow)
   *   idle() -> { idleMs, locked }
   *   selfPid                                    Shellby's own windows belong to this process
   *   known() -> [{ key, name }]                 projects Shellby has seen (streaks, stickers)
   *   claudeAt() -> { dirs: [dir], names: [folder name] }  where Claude is working right now
   *   resolve(dir) -> Promise<{ root, name } | null>        the project a folder belongs to
   *   electron: { dialog, BrowserWindow, clipboard, shell, app }, panel() -> BrowserWindow
   * }
   */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.state = tt.normalize(deps.config.get('timeTracking'));
    this.dirty = false;
    this.lastTick = this.now();
    this.lastSave = this.now();
    this.lastGit = 0;
    this.recent = null;           // { key, at }: the last sure sign of a project
    this.current = { key: null, why: 'none' };
    this.resolved = new Map();    // folder -> { key, name, at } | { key: null, at } (a miss is retried after RETRY_MS)
    this.resolving = new Set();
    this.reflogs = new Map();     // file -> mtime last seen
    this.commitCache = new Map(); // `${key}|${from}|${to}` -> { at, list }
    this.gitRun = null;           // the reflog check in progress, so two never overlap
    this.timer = null;
    this.saved = new Set();       // files exported this run: the only ones "Show file" reveals
  }

  toPanel(channel, payload) { this.deps.toPanel(channel, payload); }

  get settings() {
    const { enabled, idleMinutes, roundMinutes, roundMode, currency } = this.state;
    return { enabled, idleMinutes, roundMinutes, roundMode, currency };
  }

  start() {
    if (this.timer) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.save();
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    this.deps.config.set({ timeTracking: this.state });
    this.dirty = false;
    this.lastSave = this.now();
  }

  // ---------------------------------------------------------------- the tick

  /** Every project worth looking for in a title: known ones and the ones on the books, by folder name and by name. */
  projectList() {
    const out = [];
    const seen = new Set();
    const add = (key, name) => {
      const id = `${key}|${String(name).toLowerCase()}`;
      if (!key || !name || seen.has(id) || this.ignored(key)) return;
      seen.add(id);
      out.push({ key, name });
    };
    for (const p of this.deps.known()) { add(p.key, folderName(p.key)); add(p.key, p.name); }
    for (const key of Object.keys(this.state.projects)) add(key, folderName(key));
    return out;
  }

  ignored(key) { return !!tt.projectOf(this.state, key)?.ignored; }

  // The name a project goes by until you rename it: its known name, else its folder.
  nameOf(key) {
    return tt.projectOf(this.state, key)?.name || this.deps.known().find(p => p.key === key)?.name || folderName(key);
  }

  rank() {
    const r = {};
    for (const [day, m] of Object.entries(this.state.days)) for (const k of Object.keys(m)) r[k] = Math.max(r[k] || 0, Date.parse(day) || 0);
    if (this.recent) r[this.recent.key] = Infinity;
    return r;
  }

  /** A folder -> its project key, from the cache; looks it up for next time when it isn't there yet. */
  keyOf(dir) {
    if (typeof dir !== 'string' || !dir) return null;
    const k = caseKey(dir);
    const hit = this.resolved.get(k);
    if (hit && (hit.key || this.now() - hit.at < RETRY_MS)) return hit.key;
    if (!this.resolving.has(k)) {
      this.resolving.add(k);
      const miss = () => this.resolved.set(k, { key: null, at: this.now() });
      Promise.resolve(this.deps.resolve(dir)).then(p => {
        if (this.resolved.size > RESOLVE_CACHE) this.resolved.clear();
        if (p) this.resolved.set(k, { key: caseKey(p.root), name: p.name, at: this.now() });
        else miss();
      }).catch(miss).finally(() => this.resolving.delete(k));
    }
    return null;
  }

  /** The one project Claude is working in right now, or null (none, or more than one). */
  claudeProject(projects) {
    const at = this.deps.claudeAt() || {};
    const keys = new Set();
    for (const d of at.dirs || []) { const k = this.keyOf(d); if (k && !this.ignored(k)) keys.add(k); }
    for (const n of at.names || []) {
      const hits = [...new Set(projects.filter(p => p.name.toLowerCase() === String(n).toLowerCase()).map(p => p.key))];
      if (hits.length === 1) keys.add(hits[0]);
    }
    return keys.size === 1 ? [...keys][0] : null;
  }

  /** Something happened in a folder (a task finished there, a push): it's where you are. */
  touch(dir) {
    if (!this.state.enabled) return;
    const k = this.keyOf(dir);
    const note = key => { if (key && !this.ignored(key)) this.recent = { key, at: this.now() }; };
    if (k) note(k);
    else setTimeout(() => note(this.keyOf(dir)), 3000);
  }

  tick() {
    const now = this.now();
    const elapsed = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (!this.state.enabled) return;
    let idle = { idleMs: 0, locked: false };
    try { idle = this.deps.idle() || idle; } catch { /* keep going as present */ }
    const w = this.deps.front();
    const win = w ? { exe: w.exe, title: w.title, self: w.pid === this.deps.selfPid } : null;
    const projects = this.projectList();
    const claude = this.claudeProject(projects);
    const recent = this.recent && !this.ignored(this.recent.key) ? this.recent : null;
    let r = tt.attribute({ win, ...idle, now, idleMinutes: this.state.idleMinutes, projects, rank: this.rank(), recent, claude });
    if (r.key && this.ignored(r.key)) r = { key: null, why: 'none' };
    if (r.key && r.why !== 'recent') this.recent = { key: r.key, at: now };
    const was = this.current;
    this.current = r;
    if (r.key && elapsed > 0) {
      // A long gap (sleep, a stall) counts one tick at most: idle time resets on
      // the key that woke the PC, so the gap itself says nothing about work.
      const seconds = elapsed > (2 * TICK_MS) / 1000 ? TICK_MS / 1000 : Math.min(elapsed, tt.MAX_CREDIT_S);
      this.state = tt.credit(tt.ensureProject(this.state, r.key, this.nameOf(r.key)), r.key, seconds, now);
      this.dirty = true;
    }
    if (now - this.lastGit >= GIT_EVERY_MS && !this.gitRun) {
      this.lastGit = now;
      this.gitRun = this.watchGit(projects).catch(() => {}).finally(() => { this.gitRun = null; });
    }
    if (now - this.lastSave >= SAVE_EVERY_MS) this.save();
    if (was.key !== r.key || was.why !== r.why || r.key) this.toPanel('time:now', this.nowView());
  }

  // A commit, checkout or pull in a project moves its reflog: that's where you are.
  async watchGit(projects) {
    const keys = [...new Set(projects.map(p => p.key))].slice(0, MAX_WATCHED);
    const now = this.now();
    let newest = null;
    for (const key of keys) {
      for (const file of await gitinfo.headLogs(key)) {
        let mtime;
        try { mtime = (await fs.promises.stat(file)).mtimeMs; } catch { continue; }
        const before = this.reflogs.get(file);
        this.reflogs.set(file, mtime);
        if (before !== undefined && mtime > before && now - mtime < GIT_FRESH_MS && (!newest || mtime > newest.at)) newest = { key, at: mtime };
      }
    }
    if (newest && (!this.recent || newest.at > this.recent.at)) this.recent = newest;
  }

  /** What's being timed right now, for the Time page's header. */
  nowView() {
    const today = tt.dayKey(this.now());
    const day = this.state.days[today] || {};
    const manual = this.state.manual[today] || {};
    const total = Object.keys({ ...day, ...manual }).filter(k => !this.ignored(k)).reduce((n, k) => n + Math.max(0, (day[k] || 0) + (manual[k] || 0)), 0);
    const key = this.current.key;
    return {
      enabled: this.state.enabled,
      key, name: key ? this.nameOf(key) : null, why: this.current.why,
      seconds: key ? Math.max(0, (day[key] || 0) + (manual[key] || 0)) : 0,
      today: total,
    };
  }

  // ---------------------------------------------------------------- the Time page

  rangeOf(id, from, to) {
    const all = tt.ranges(this.now());
    if (id === 'custom' && tt.daysBetween(from, to).length) return { id: 'custom', label: `${from} to ${to}`, from, to };
    return all.find(r => r.id === id) || all.find(r => r.id === 'week');
  }

  async commitsFor(keys, range) {
    const fromMs = new Date(`${range.from}T00:00:00`).getTime();
    const toD = new Date(`${range.to}T00:00:00`);
    const toMs = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() + 1).getTime();
    const out = {};
    const queue = [...keys].slice(0, MAX_LOOKUPS);
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift();
        const id = `${key}|${range.from}|${range.to}`;
        const hit = this.commitCache.get(id);
        if (hit && this.now() - hit.at < COMMITS_TTL_MS) { out[key] = hit.list; continue; }
        const list = await gitinfo.commitsBetween(key, fromMs, toMs).catch(() => []);
        if (this.commitCache.size > 200) this.commitCache.clear();
        this.commitCache.set(id, { at: this.now(), list });
        out[key] = list;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }

  /** opts: { range, from, to, estimates, only: { key } | { client } } -> a summary for that range. */
  async summary(opts = {}) {
    const range = this.rangeOf(opts.range, opts.from, opts.to);
    const known = this.deps.known().filter(p => !this.ignored(p.key));
    const names = Object.fromEntries(known.map(p => [p.key, p.name]));
    const keys = new Set([...Object.keys(this.state.projects).filter(k => !this.ignored(k)), ...known.map(p => p.key)]);
    const commits = await this.commitsFor(keys, range);
    const only = opts.only?.key ? { key: String(opts.only.key) } : opts.only && typeof opts.only.client === 'string' ? { client: opts.only.client } : null;
    return { range, summary: tt.summarize(this.state, range, { commits, estimates: !!opts.estimates, only, names }) };
  }

  async view(opts = {}) {
    const { range, summary } = await this.summary(opts);
    const s = this.state;
    return {
      settings: this.settings,
      now: this.nowView(),
      range, ranges: tt.ranges(this.now()),
      summary,
      choices: { idle: tt.IDLE_CHOICES, round: tt.ROUND_CHOICES, roundModes: tt.ROUND_MODES },
      projects: Object.entries(s.projects).map(([key, p]) => ({ key, ...p, folder: folderName(key) })).sort((a, b) => a.name.localeCompare(b.name)),
      known: this.deps.known().filter(p => !s.projects[p.key]).map(p => ({ key: p.key, name: p.name })),
      clients: [...new Set(Object.values(s.projects).map(p => p.client).filter(Boolean))].sort(),
      windows: !!this.deps.windowsAvailable?.(),
    };
  }

  update(next) {
    this.state = next;
    this.dirty = true;
    this.save();
    this.toPanel('time:now', this.nowView());
  }

  setSettings(patch) {
    const was = this.state.enabled;
    this.update(tt.setSettings(this.state, patch));
    if (!was && this.state.enabled) { this.lastTick = this.now(); this.recent = null; }
    if (was && !this.state.enabled) this.current = { key: null, why: 'none' };
    return this.settings;
  }

  /** A project's client, rate, billable, name or ignored. A known project not yet on the books is put on first. */
  setProject(key, patch) {
    if (typeof key !== 'string') return { ok: false, error: 'Which project?' };
    const known = this.deps.known().find(p => p.key === key);
    if (!tt.projectOf(this.state, key) && !known) return { ok: false, error: "That project isn't one Shellby knows." };
    this.update(tt.setProject(tt.ensureProject(this.state, key, this.nameOf(key)), key, patch));
    return { ok: true };
  }

  removeProject(key) {
    if (!tt.projectOf(this.state, key)) return { ok: false, error: "That project isn't on the books." };
    this.update(tt.removeProject(this.state, key));
    return { ok: true };
  }

  /** Time added or taken off by hand, with an optional note for the invoice line. */
  addTime({ key, day, minutes, note } = {}) {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return { ok: false, error: 'Pick a project and a day.' };
    if (day > tt.dayKey(this.now())) return { ok: false, error: "That day hasn't happened yet." };
    const m = Number(minutes);
    if (!Number.isFinite(m) || Math.abs(m) > 24 * 60) return { ok: false, error: 'Minutes has to be a number, at most a day.' };
    const known = this.deps.known().find(p => p.key === key);
    if (!tt.projectOf(this.state, key) && !known) return { ok: false, error: "That project isn't one Shellby knows." };
    let s = tt.ensureProject(this.state, key, this.nameOf(key));
    if (m) s = tt.adjust(s, day, key, Math.round(m * 60));
    if (typeof note === 'string') s = tt.setNote(s, day, key, note);
    this.update(s);
    return { ok: true };
  }

  /** A folder you work in that Shellby hasn't seen yet. */
  async addFolder(dir) {
    const p = await this.deps.resolve(dir).catch(() => null);
    const root = p?.root || dir;
    const key = caseKey(root);
    this.update(tt.ensureProject(this.state, key, p?.name || path.basename(root), { added: true }));
    return { ok: true, key };
  }

  // ---------------------------------------------------------------- exports

  async exportData(opts = {}) {
    const { range, summary } = await this.summary(opts);
    const only = opts.only?.key ? { project: this.nameOf(opts.only.key) } : opts.only?.client ? { client: opts.only.client } : {};
    return { range, summary, name: exportName(summary, only) };
  }

  async saveAs(defaultName, ext, label) {
    const { dialog, app } = this.deps.electron;
    const dir = path.join(app.getPath('documents'), 'Shellby Timesheets');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the dialog still opens */ }
    const r = await dialog.showSaveDialog(this.deps.panel(), {
      title: `Save the ${label}`, defaultPath: path.join(dir, `${defaultName}.${ext}`),
      filters: [{ name: label, extensions: [ext] }],
    });
    return r.canceled || !r.filePath ? null : r.filePath;
  }

  async exportCsv(opts) {
    const { summary, name } = await this.exportData(opts);
    if (!summary.projects.some(p => p.seconds)) return { ok: false, error: 'No time in that range to export.' };
    const file = await this.saveAs(name, 'csv', 'spreadsheet (CSV)');
    if (!file) return { ok: false, canceled: true };
    // A BOM so Excel reads the names and notes as UTF-8.
    await fs.promises.writeFile(file, `﻿${tt.toCsv(summary)}`, 'utf8');
    this.saved.add(file);
    return { ok: true, file };
  }

  async exportPdf(opts) {
    const { range, summary, name } = await this.exportData(opts);
    if (!summary.projects.some(p => p.seconds)) return { ok: false, error: 'No time in that range to put on a timesheet.' };
    const file = await this.saveAs(name, 'pdf', 'timesheet (PDF)');
    if (!file) return { ok: false, canceled: true };
    const html = timesheetHtml(summary, { label: range.label, preparedBy: await gitinfo.userName().catch(() => ''), generatedAt: this.now() });
    await fs.promises.writeFile(file, await this.renderPdf(html));
    this.saved.add(file);
    return { ok: true, file };
  }

  // A hidden window with scripts off, that can't navigate or open anything, renders the page once.
  async renderPdf(html) {
    const { BrowserWindow, app } = this.deps.electron;
    const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, spellcheck: false, partition: 'timesheet-pdf' } });
    try {
      for (const ev of ['will-navigate', 'will-redirect', 'will-attach-webview']) win.webContents.on(ev, e => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const letter = /^en-(US|CA)$|^es-MX$/.test(app.getLocale?.() || '');
      return await win.webContents.printToPDF({ printBackground: true, pageSize: letter ? 'Letter' : 'A4' });
    } finally {
      win.destroy();
    }
  }

  wasSaved(file) { return this.saved.has(file); }

  async copyText(opts) {
    const { range, summary } = await this.exportData(opts);
    if (!summary.projects.some(p => p.seconds)) return { ok: false, error: 'No time in that range to copy.' };
    // Electron 44's writeText is a promise: a busy clipboard is a failed copy, not a silent one.
    try { await this.deps.electron.clipboard.writeText(tt.toText(summary, range.label)); } catch {
      return { ok: false, error: "Couldn't copy it: something else is holding the clipboard. Try again." };
    }
    return { ok: true };
  }

  /** `shellby time [range]`: the same summary as text. */
  async cliText(rangeId = 'week', { estimates = false } = {}) {
    if (!this.state.enabled && !Object.keys(this.state.days).length) return 'Time tracking is off. Turn it on in Shellby: History → Time.';
    const { range, summary } = await this.summary({ range: rangeId, estimates });
    if (!summary.projects.some(p => p.seconds)) return `No time tracked ${range.label.toLowerCase()}.`;
    return tt.toText(summary, range.label);
  }
}

module.exports = { TimeTracker, TICK_MS };
