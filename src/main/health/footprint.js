// Shellby's own footprint: his CPU and memory right now, across every process
// he runs (main, the two renderers, the GPU process, the utility processes).
// Health lists what's hogging your PC, so it owns up to his share too.
//
// Read from app.getAppMetrics(). Its cpu.percentCPUUsage is an average since
// *anybody's* last call (selfPids() in the health wiring calls it as well), so
// this reads cumulativeCPUUsage, each process's CPU seconds since it started,
// and takes the difference between two readings itself. Pure but for the
// tracker, which only holds the last reading and is handed its clock.
const os = require('os');

const KB = 1024;
const MB = 1024 * 1024;
const MIN_INTERVAL_MS = 2000;    // a view() right after a sample keeps the sample's figure
const HISTORY_MAX = 120;         // ten minutes of the monitor's 5 s samples
// Above either, the hint points at what makes him lighter. CPU is a share of the
// whole PC, like the hogs list and Task Manager: his panel open and focused is
// ~75% of one core (docs/DEVELOPMENT.md), which is 5% of a 16-thread desktop but
// 19% of a 4-core laptop, and the laptop is who this is for.
const HEAVY = Object.freeze({ cpu: 5, mem: 1024 * MB });

/**
 * app.getAppMetrics() -> Map(key -> { pid, type, created, cpuSeconds, percent, bytes }).
 * Keyed by pid and creation time, because Windows reuses a dead process's pid.
 * cpuSeconds is null on an Electron without cumulativeCPUUsage; percent is
 * then the fallback (an average over its own, shared interval).
 */
function readMetrics(metrics) {
  const out = new Map();
  for (const m of Array.isArray(metrics) ? metrics : []) {
    const pid = Number(m?.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const created = Number(m.creationTime) || 0;
    const cum = Number(m.cpu?.cumulativeCPUUsage);
    const pct = Number(m.cpu?.percentCPUUsage);
    const kb = Number(m.memory?.workingSetSize);
    out.set(`${pid}:${created}`, {
      pid, type: String(m.type || 'Unknown'), created,
      cpuSeconds: Number.isFinite(cum) && cum >= 0 ? cum : null,
      percent: Number.isFinite(pct) && pct >= 0 ? pct : 0,
      bytes: Number.isFinite(kb) && kb > 0 ? kb * KB : 0,
    });
  }
  return out;
}

/**
 * What his processes cost between two readings:
 *   { cpuCore, cpu, mem, procs }
 * cpuCore is a share of ONE core (100 = one core flat out), cpu the same as a
 * share of the whole machine, mem the working sets added up (bytes, what
 * scripts/idle-cost.js reports). A process that started inside the window
 * counts all its CPU time; one gone by the end counts for nothing.
 */
function footprintBetween(prev, next, { prevAt, at, cores = os.cpus().length } = {}) {
  const seconds = Math.max(0.001, (at - prevAt) / 1000);
  let cpuCore = 0;
  let mem = 0;
  for (const [key, p] of next) {
    mem += p.bytes;
    const before = prev?.get(key);
    if (p.cpuSeconds == null || (before && before.cpuSeconds == null)) { cpuCore += p.percent; continue; }
    const since = before ? before.cpuSeconds : p.created >= prevAt ? 0 : null;
    if (since == null) continue; // not seen before, and older than the window: no baseline
    cpuCore += Math.max(0, p.cpuSeconds - since) / seconds * 100;
  }
  const n = Math.max(1, Number(cores) || 1);
  return { cpuCore: round(cpuCore), cpu: round(cpuCore / n), mem, procs: next.size };
}

const round = v => Math.round(v * 10) / 10;

/** 0.4 -> "0.4%", 12.3 -> "12%": like the hogs list. */
function pct(v) {
  if (!Number.isFinite(v)) return '?%';
  return `${v > 0 && v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}%`;
}

/** Bytes -> "450 MB" or "1.2 GB". */
function size(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return bytes >= 1000 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;
}

const isHeavy = (fp, limits = HEAVY) => !!fp && (fp.cpu >= limits.cpu || fp.mem >= limits.mem);

/**
 * The Health line and its hint, in his words:
 *   { line, detail, heavy, hint, jump }
 * jump names the Settings section the hint points at (null: it points nowhere).
 * `whenClosed` is his CPU as a share of the machine while the panel was closed
 * (null until he's been measured that way), so the hint can say what closing
 * it really does on this PC instead of quoting a number from somebody else's.
 */
function describe(fp, { whenClosed = null, limits = HEAVY } = {}) {
  if (!fp) return null;
  const line = `Shellby himself: ${pct(fp.cpu)} CPU, ${size(fp.mem)}`;
  const detail = `Added up across his ${fp.procs} process${fp.procs === 1 ? '' : 'es'}. CPU is a share of the whole PC, like Task Manager shows: ${pct(fp.cpuCore)} of one core.`;
  const heavy = isHeavy(fp, limits);
  let hint = null;
  let jump = null;
  if (heavy && fp.cpu >= limits.cpu) {
    const closed = Number.isFinite(whenClosed) && whenClosed < fp.cpu
      ? `with it closed he settles to about ${pct(whenClosed)} on this PC`
      : 'close it and he settles to almost nothing';
    hint = `Most of that is this panel's animation: ${closed}. Fewer pals and less wandering make him lighter still.`;
    jump = 'Moving around';
  } else if (heavy) {
    hint = "He's holding more memory than usual. Restarting Shellby hands it back.";
  }
  return { line, detail, heavy, hint, jump };
}

/**
 * Keeps the last reading and works out the next. sample() -> the footprint
 * since the previous call (null on the first), plus what he costs with the
 * panel closed, averaged over the last ten minutes of closed samples.
 *   deps: { metrics: () => app.getAppMetrics(), panelOpen: () => bool, now?, cores? }
 */
class FootprintTracker {
  constructor({ metrics, panelOpen = () => false, now = Date.now, cores = os.cpus().length }) {
    Object.assign(this, { metrics, panelOpen, now, cores });
    this.last = null;      // { at, reading, open }
    this.current = null;   // the latest footprint
    this.history = [];     // [{ open, cpu }] per interval
  }

  sample() {
    const at = this.now();
    if (this.last && at - this.last.at < MIN_INTERVAL_MS) return this.view();
    let raw;
    try { raw = this.metrics(); } catch { return this.view(); }
    const reading = readMetrics(raw);
    const open = !!this.panelOpen();
    if (this.last) {
      this.current = footprintBetween(this.last.reading, reading, { prevAt: this.last.at, at, cores: this.cores });
      // Only an interval with the panel closed at both ends counts as "closed".
      this.history.push({ open: open || this.last.open, cpu: this.current.cpu });
      if (this.history.length > HISTORY_MAX) this.history.shift();
    }
    this.last = { at, reading, open };
    return this.view();
  }

  whenClosed() {
    const closed = this.history.filter(h => !h.open);
    return closed.length ? round(closed.reduce((n, h) => n + h.cpu, 0) / closed.length) : null;
  }

  /** { ...footprint, line, detail, heavy, hint } for the panel, or null before two readings. */
  view() {
    if (!this.current) return null;
    return { ...this.current, ...describe(this.current, { whenClosed: this.whenClosed() }) };
  }
}

module.exports = { readMetrics, footprintBetween, describe, isHeavy, pct, size, FootprintTracker, HEAVY };
