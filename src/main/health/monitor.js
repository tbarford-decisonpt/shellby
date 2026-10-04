// The health monitor: polls sensors, keeps a short history for the Health
// view's sparklines, advances the rules, and emits:
//   'sample'  (snapshot)            every poll
//   'mood'    ({ mood, level, ... } | null) when Shellby's health mood changes
//   'change'  ({ id, from, to, reading, text }) when a check changes level
const { EventEmitter } = require('events');
const { step, moodFor, describe, normalizeThresholds, rank } = require('./rules');

const POLL_MS = 5000;
const DISK_EVERY_MS = 60000;
const LHM_RETRY_MS = 60000;      // when LHM isn't answering, don't hammer the port
const MISS_GRACE = 3;            // failed reads tolerated before a sensor counts as gone
const HISTORY_MS = 60 * 60 * 1000;
const HISTORY_MAX = Math.ceil(HISTORY_MS / POLL_MS);
const GB = 1024 ** 3;

class HealthMonitor extends EventEmitter {
  /**
   * sensors: see sensors.createSensors (or a fake with the same shape)
   * getThresholds: () => thresholds object
   * now: () => ms (injectable for tests)
   */
  constructor({ sensors, getThresholds, now = () => Date.now(), pollMs = POLL_MS, timing }) {
    super();
    this.sensors = sensors;
    this.getThresholds = getThresholds;
    this.now = now;
    this.pollMs = pollMs;
    this.timing = timing;           // undefined -> rules.TIMING
    this.timer = null;
    this.running = false;
    this.inflight = null;         // the poll in progress, shared by concurrent callers
    this.epoch = 0;               // bumped by stop(); a poll from an older epoch is discarded
    this.misses = { nvidia: 0, lhm: 0 };
    this.lastNvidia = null;
    this.checks = {};
    this.mood = null;
    this.history = [];            // compact points, see historyPoint()
    this.latest = null;
    this.disks = null;
    this.disksAt = -Infinity;     // never read yet
    this.lhm = { state: 'unknown', nextTryAt: 0 };  // 'ok' | 'off' | 'auth' | 'unknown'
    this.app = null;              // which sensor app answered: 'lhm' | 'hwinfo' | null
    this.sources = { nvidia: !!sensors.hasNvidia, lhm: 'unknown', app: null };
  }

  start() {
    if (this.running) return;
    this.running = true;
    // A loop belongs to one start(): one still awaiting a poll when Health is
    // switched off and on again must not carry on beside the new one.
    const epoch = this.epoch;
    const loop = async () => {
      if (!this.running || epoch !== this.epoch) return;
      await this.poll();
      if (this.running && epoch === this.epoch) this.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }

  stop() {
    this.running = false;
    this.epoch++;                 // a poll still awaiting its sensors must not revive anything
    clearTimeout(this.timer);
    this.timer = null;
    this.checks = {};
    this.latest = null;
    this.lastNvidia = null;
    this.misses = { nvidia: 0, lhm: 0 };
    if (this.mood) { this.mood = null; this.emit('mood', null); }
  }

  /** Read everything again now, ignoring LHM's back-off and the disk interval. */
  async recheck() {
    if (this.inflight) await this.inflight;  // otherwise poll() would just hand back the old read
    this.lhm.nextTryAt = 0;
    this.disksAt = -Infinity;
    return this.poll();
  }

  poll() {
    if (!this.inflight) this.inflight = this.pollOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async pollOnce() {
    const epoch = this.epoch;
    try {
      const at = this.now();
      const [nvidiaRead, lhm, disks] = await Promise.all([
        this.sensors.readNvidia(),
        at >= this.lhm.nextTryAt ? this.readSensorApp() : Promise.resolve(undefined),
        at - this.disksAt >= DISK_EVERY_MS ? this.sensors.readDisks(at) : Promise.resolve(undefined),
      ]);
      if (epoch !== this.epoch) return this.latest;
      const nvidia = this.tolerateNvidia(nvidiaRead);
      if (lhm !== undefined) this.applyLhm(lhm, at);
      if (disks !== undefined) { this.disks = disks; this.disksAt = at; }
      const sample = this.compose(at, nvidia, this.lhm.data, this.sensors.readCpuLoad(), this.sensors.readMemory(), this.disks);
      this.sources = {
        nvidia: !!nvidia, lhm: this.lhm.state, app: this.app,
        cpuTemp: sample.cpu.temp != null, gpuTemp: sample.gpus.some(g => g.temp != null),
        storage: sample.storage.length > 0, fans: sample.fans.length > 0, battery: !!sample.battery,
      };
      this.latest = sample;
      this.remember(sample);
      this.evaluate(sample, at);
      this.emit('sample', this.snapshot({ withHistory: false }));
      return sample;
    } catch (e) {
      console.warn('[shellby] health poll failed:', e.message);
      return this.latest;
    }
  }

  /**
   * LibreHardwareMonitor, or HWiNFO if that isn't the one running. Both return
   * the same snapshot shape, so nothing downstream has to care which answered.
   */
  async readSensorApp() {
    const lhm = await this.sensors.readLhm();
    if (lhm && !lhm.error) { this.app = 'lhm'; return lhm; }
    const hw = await this.sensors.readHwinfo?.();
    if (hw && !hw.error) { this.app = 'hwinfo'; return hw; }
    this.app = null;
    return lhm ?? hw ?? null;   // keep an auth error, so the view can explain it
  }

  // A busy GPU can make nvidia-smi time out once in a while. Reuse the last good
  // read for a few polls instead of dropping the check (which would reset its
  // hysteresis and make a hot crab flicker calm and back).
  tolerateNvidia(read) {
    if (read) { this.misses.nvidia = 0; this.lastNvidia = read; return read; }
    if (this.lastNvidia && ++this.misses.nvidia <= MISS_GRACE) return this.lastNvidia;
    this.lastNvidia = null;
    return null;
  }

  applyLhm(lhm, at) {
    if (lhm && !lhm.error) {
      this.misses.lhm = 0;
      Object.assign(this.lhm, { state: 'ok', data: lhm, nextTryAt: 0 });
    } else if (!lhm && this.lhm.state === 'ok' && ++this.misses.lhm <= MISS_GRACE) {
      // Same grace for a slow LHM answer: keep the last reading, retry next poll.
    } else {
      Object.assign(this.lhm, { state: lhm?.error === 'auth' ? 'auth' : 'off', data: null, nextTryAt: at + LHM_RETRY_MS });
    }
  }

  // One normalized sample from whatever sources answered.
  compose(at, nvidia, lhm, cpuLoad, memory, disks) {
    // nvidia-smi is the better NVIDIA source; LHM fills in AMD/Intel GPUs.
    const gpus = [...(nvidia || []), ...((lhm?.gpus || []).filter(g => !(nvidia?.length && g.vendor === 'nvidia')))]
      .map((g, i) => ({ ...g, index: i }));
    return {
      at,
      cpu: { load: cpuLoad, temp: lhm?.cpu?.temp ?? null, name: lhm?.cpu?.name || null, power: lhm?.cpu?.power ?? null },
      gpus,
      ram: memory,
      disks: disks || [],
      storage: lhm?.storage || [],
      fans: lhm?.fans || [],
      battery: lhm?.battery || null,
    };
  }

  remember(s) {
    this.history.push(historyPoint(s));
    const cutoff = s.at - HISTORY_MS;
    while (this.history.length > HISTORY_MAX || (this.history.length && this.history[0].at < cutoff)) this.history.shift();
  }

  readings(s) {
    const out = [];
    const many = s.gpus.length > 1;
    s.gpus.forEach((g, i) => {
      if (g.temp != null) out.push({ id: `gpu-temp:${i}`, kind: 'gpu-temp', label: many ? `GPU ${i + 1}` : 'GPU', model: g.name, value: g.temp, unit: '°C' });
    });
    if (s.cpu.temp != null) out.push({ id: 'cpu-temp', kind: 'cpu-temp', label: 'CPU', model: s.cpu.name, value: s.cpu.temp, unit: '°C' });
    s.storage.forEach((d, i) => {
      if (d.temp != null) out.push({ id: `storage-temp:${i}`, kind: 'storage-temp', label: s.storage.length > 1 ? `Drive ${i + 1}` : 'Drive', model: d.name, value: d.temp, unit: '°C' });
    });
    if (s.ram) out.push({ id: 'ram', kind: 'ram', label: 'Memory', value: s.ram.pct, unit: '%', used: s.ram.used, total: s.ram.total });
    for (const d of s.disks) {
      out.push({ id: `disk:${d.id}`, kind: 'disk', label: `Drive ${d.id}`, drive: d.id, value: d.free / GB, unit: 'GB', total: d.total });
    }
    return out;
  }

  evaluate(sample, at) {
    const thresholds = this.getThresholds();
    const { checks, changes } = step(this.checks, this.readings(sample), thresholds, at, this.timing);
    this.checks = checks;
    for (const c of changes) this.emit('change', { ...c, text: describe(c, thresholds) });
    const mood = moodFor(checks);
    const key = m => (m ? `${m.mood}|${m.level}|${m.id}|${m.text}` : '');
    if (key(mood) !== key(this.mood)) {
      this.mood = mood;
      this.emit('mood', mood);
    }
  }

  /** What the Health view renders. */
  snapshot({ withHistory = true } = {}) {
    // The reading goes too: the view words its verdict from it, so a check the
    // view has no gauge for (a drive's heat, reclaimable space) still reads right.
    const checks = Object.fromEntries(Object.entries(this.checks).map(([id, c]) => [id, { level: c.level, pending: c.pending, reading: c.reading }]));
    const worst = Object.values(this.checks).reduce((w, c) => (rank(c.level) > rank(w) ? c.level : w), 'ok');
    return {
      running: this.running,
      sample: this.latest,
      checks,
      worst,
      mood: this.mood,
      sources: this.sources,
      lhmPort: this.sensors.lhmPort,
      thresholds: normalizeThresholds(this.getThresholds()),
      history: withHistory ? this.history : undefined,
      // Live samples carry no history, just the point this sample added to it.
      point: withHistory ? undefined : this.history[this.history.length - 1],
    };
  }
}

function round(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; }

/**
 * One compact history point. The first GPU keeps its original keys (gpu, gpuT);
 * any others are gpu1/gpuT1 and so on, and drive temperatures are stT0, stT1...
 */
function historyPoint(s) {
  const p = { at: s.at, cpu: round(s.cpu.load), cpuT: round(s.cpu.temp), ram: round(s.ram?.pct) };
  s.gpus.forEach((g, i) => {
    const n = i || '';
    p[`gpu${n}`] = round(g.load);
    p[`gpuT${n}`] = round(g.temp);
  });
  if (!s.gpus.length) { p.gpu = null; p.gpuT = null; }
  (s.storage || []).forEach((d, i) => { p[`stT${i}`] = round(d.temp); });
  return p;
}

module.exports = { HealthMonitor, historyPoint, POLL_MS, HISTORY_MS };
