// Which workflows an event starts, and the timers and watchers that produce
// events of their own (schedules, folders). The matching is pure; the two
// small classes at the bottom are the only things here that touch timers or
// the file system, and both take them injected for tests.
const fs = require('fs');
const path = require('path');
const { previousAt, nextAt } = require('./schedule');

const MAX_CHAIN = 3;              // workflow -> workflow trigger hops
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 60;            // starts per workflow per hour before it's paused
const FOLDER_QUIET_MS = 3000;     // a burst of file events settles into one start
const MAX_FOLDER_FILES = 200;

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * An event -> [{ workflow, trigger }] it starts. Only enabled workflows, and
 * only the first matching trigger of each (two triggers matching one event
 * start it once).
 *   ci:       data { event, repo, ... }
 *   issue:    data { event, reasons: ['assigned'|'labelled'], repo, ... }
 *   shipped:  data { kind, project, ... }
 *   task:     data { outcome, ... }
 *   health, startup: any data
 *   workflow: data { name, status, chain }
 */
function matchEvent(workflows, type, data = {}) {
  const out = [];
  for (const wf of workflows) {
    if (!wf.enabled) continue;
    const trigger = (wf.when || []).find(t => t.type === type && matches(t, data, wf));
    if (trigger) out.push({ workflow: wf, trigger });
  }
  return out;
}

function matches(t, data, wf) {
  switch (t.type) {
    case 'ci': return (t.on === 'any' || t.on === data.event) && (!t.repo || same(t.repo, data.repo));
    // An issue can be both assigned to you and labelled: either reason counts.
    case 'issue': return (t.on === 'any' || (Array.isArray(data.reasons) && data.reasons.includes(t.on))) && (!t.repo || same(t.repo, data.repo));
    case 'shipped': return (t.kind === 'any' || t.kind === data.kind) && (!t.project || same(t.project, data.project));
    case 'task': return t.outcome === 'any' || t.outcome === data.outcome;
    case 'workflow':
      return same(t.name, data.name) && !same(wf.name, data.name)
        && (t.status === 'any' || t.status === data.status)
        && (data.chain || 0) < MAX_CHAIN;
    case 'health':
    case 'startup':
      return true;
    default:
      return false;
  }
}

/** The workflow whose webhook trigger holds this token, if any. Constant-time per compare. */
function byWebhook(workflows, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,64}$/.test(token)) return null;
  const crypto = require('crypto');
  const want = Buffer.from(token);
  for (const wf of workflows) {
    if (!wf.enabled) continue;
    const t = (wf.when || []).find(x => x.type === 'webhook');
    if (!t) continue;
    const have = Buffer.from(t.token);
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) return { workflow: wf, trigger: t };
  }
  return null;
}

/** "*.pdf, report-??.csv" -> a test for a file name (case-insensitive). Empty matches everything. */
function patternTest(pattern) {
  const parts = String(pattern || '').split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return () => true;
  return name => { const n = String(name).toLowerCase(); return parts.some(p => wildcard(p, n)); };
}

// * and ? matching in linear time (no regex, so no backtracking on a hostile file name).
function wildcard(p, s) {
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < s.length) {
    if (i < p.length && (p[i] === '?' || p[i] === s[j])) { i++; j++; } else if (i < p.length && p[i] === '*') { star = i++; mark = j; } else if (star >= 0) { i = star + 1; j = ++mark; } else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

/** The soonest scheduled start of a workflow after `from`, or null. */
function nextStart(wf, from) {
  if (!wf.enabled) return null;
  const times = (wf.when || []).filter(t => t.type === 'schedule').map(t => nextAt(t.schedule, wf.createdAt, from)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

/** Starts per workflow in the last hour; past the limit, the caller pauses it. */
class RateLimit {
  constructor({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.starts = new Map();
  }

  /** Records a start; false when this one goes over the limit. */
  allow(id, now) {
    const recent = (this.starts.get(id) || []).filter(t => now - t < this.windowMs);
    recent.push(now);
    this.starts.set(id, recent);
    return recent.length <= this.limit;
  }

  forget(id) { this.starts.delete(id); }
}

/**
 * Ticks every `tickMs` and calls onDue(workflow, trigger, slot) for each
 * schedule slot that fell in the last tick. After a sleep or hibernate only
 * the latest slot counts, once (like routines' Scheduler).
 */
class ScheduleTicker {
  constructor({ getWorkflows, onDue, tickMs = 30000, now = () => Date.now(), timers = { setInterval, clearInterval } }) {
    Object.assign(this, { getWorkflows, onDue, tickMs, now, timers });
    this.last = null;
    this.fired = new Map(); // `${wf.id}:${index}` -> slot
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.last = this.now();
    this.timer = this.timers.setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = this.now();
    const since = this.last;
    this.last = now;
    if (since === null) return;
    for (const wf of this.getWorkflows()) {
      if (!wf.enabled) continue;
      (wf.when || []).forEach((t, i) => {
        if (t.type !== 'schedule') return;
        const slot = previousAt(t.schedule, wf.createdAt, now);
        if (slot === null || slot <= since) return;
        const key = `${wf.id}:${i}`;
        if (this.fired.get(key) >= slot) return;
        this.fired.set(key, slot);
        try { this.onDue(wf, t, slot); } catch { /* one bad start must not stop the rest */ }
      });
    }
  }
}

/**
 * Watches the folders named by folder triggers and calls onFiles(workflow,
 * trigger, files[]) once a burst of changes has gone quiet. sync(workflows)
 * starts and stops watchers to match.
 */
class FolderWatch {
  constructor({ onFiles, onError = () => {}, quietMs = FOLDER_QUIET_MS, watch = fs.watch, stat = p => fs.statSync(p) }) {
    Object.assign(this, { onFiles, onError, quietMs, watchFn: watch, stat });
    this.watchers = new Map(); // key -> { watcher, timer, files: Map, wf, trigger }
  }

  sync(workflows) {
    const wanted = new Map();
    for (const wf of workflows) {
      if (!wf.enabled) continue;
      (wf.when || []).forEach((t, i) => { if (t.type === 'folder') wanted.set(`${wf.id}:${i}:${t.path}:${t.pattern}:${t.events}`, { wf, trigger: t }); });
    }
    for (const [key, w] of this.watchers) {
      if (!wanted.has(key)) { this.close(w); this.watchers.delete(key); }
    }
    for (const [key, { wf, trigger }] of wanted) {
      const have = this.watchers.get(key);
      if (have) { have.wf = wf; continue; }
      this.open(key, wf, trigger);
    }
  }

  open(key, wf, trigger) {
    const entry = { watcher: null, timer: null, files: new Map(), wf, trigger, test: patternTest(trigger.pattern) };
    try {
      // Top level only: a workflow that sorts files into subfolders would
      // otherwise see its own moves as new files and start itself again.
      entry.watcher = this.watchFn(trigger.path, { recursive: false, persistent: false }, (kind, name) => this.saw(entry, kind, name));
      entry.watcher.on?.('error', e => { this.onError(wf, trigger, e); this.close(entry); });
      this.watchers.set(key, entry);
    } catch (e) {
      this.onError(wf, trigger, e);
    }
  }

  saw(entry, kind, name) {
    if (!name) return;
    const rel = String(name);
    const base = path.basename(rel);
    if (!entry.test(base) || base.startsWith('~$') || /\.(tmp|crdownload|part|partial)$/i.test(base)) return;
    const full = path.join(entry.trigger.path, rel);
    let isFile;
    try { isFile = this.stat(full).isFile(); } catch { return; } // gone again: a temp file, or a delete
    if (!isFile) return;
    // 'rename' is how a new file arrives; 'change' is a write to one already there.
    const event = kind === 'rename' ? 'added' : 'changed';
    if (entry.trigger.events !== 'any' && entry.trigger.events !== event) return;
    if (entry.files.size < MAX_FOLDER_FILES) entry.files.set(full, event);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const files = [...entry.files.keys()];
      entry.files.clear();
      if (files.length) this.onFiles(entry.wf, entry.trigger, files);
    }, this.quietMs);
    entry.timer.unref?.();
  }

  close(entry) {
    clearTimeout(entry.timer);
    try { entry.watcher?.close(); } catch { /* already gone */ }
  }

  closeAll() {
    for (const w of this.watchers.values()) this.close(w);
    this.watchers.clear();
  }
}

module.exports = { matchEvent, byWebhook, patternTest, nextStart, RateLimit, ScheduleTicker, FolderWatch, MAX_CHAIN, RATE_LIMIT };
