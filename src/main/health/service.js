// Health glue between the monitor and the rest of the app: settings,
// notifications (with cooldowns), the alert log, trophies and IPC. main.js
// passes in what it owns so this file never reaches into globals.
const { HealthMonitor } = require('./monitor');
const { createSensors } = require('./sensors');
const { createFakeSensors } = require('./fake');
const { DEFAULT_THRESHOLDS, normalizeThresholds, askPrompt, rank } = require('./rules');

const HEALTH_DEFAULTS = Object.freeze({
  enabled: true,   // watch at all
  moods: true,     // Shellby reacts on the desktop
  notify: true,    // Windows notifications for warnings
  lhmPort: 8085,
  ...DEFAULT_THRESHOLDS,
});
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;   // per check, for warnings
const CRITICAL_COOLDOWN_MS = 10 * 60 * 1000; // per check, for repeat "very high" alerts
const LOG_MAX = 40;
const ZERO_TIMING = { temp: { raiseMs: 0, clearMs: 0, margin: 3 }, ram: { raiseMs: 0, clearMs: 0, margin: 3 }, disk: { raiseMs: 0, clearMs: 0, margin: 2 } };

/** Validate a settings patch from the renderer on top of the current settings. */
function normalizeHealthSettings(current, patch = {}) {
  const base = { ...HEALTH_DEFAULTS, ...(current && typeof current === 'object' ? current : {}) };
  const next = { ...base };
  for (const k of ['enabled', 'moods', 'notify']) if (k in patch) next[k] = !!patch[k];
  if ('lhmPort' in patch) {
    const p = Number(patch.lhmPort);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) next.lhmPort = p;
  }
  const t = normalizeThresholds({ ...base, ...pick(patch, Object.keys(DEFAULT_THRESHOLDS)) });
  return { enabled: next.enabled, moods: next.moods, notify: next.notify, lhmPort: next.lhmPort, ...t };
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
   */
  constructor(deps) {
    this.deps = deps;
    const fake = deps.fakeScenario;
    this.sensors = fake ? createFakeSensors(fake) : createSensors();
    this.sensors.setLhmPort?.(this.settings.lhmPort);
    this.monitor = new HealthMonitor({
      sensors: this.sensors,
      getThresholds: () => this.settings,
      timing: deps.instant || fake ? ZERO_TIMING : undefined,
    });
    this.lastNotified = new Map();
    this.monitor.on('sample', snap => this.toPanel('health', { ...snap, settings: this.settings }));
    this.monitor.on('mood', mood => deps.onMood(this.settings.moods ? mood : null));
    this.monitor.on('change', change => this.onChange(change));
  }

  get settings() { return normalizeHealthSettings(this.deps.config.get('health')); }
  get mood() { return this.settings.moods ? this.monitor.mood : null; }
  get log() { const l = this.deps.config.get('healthLog'); return Array.isArray(l) ? l : []; }

  start() { if (this.settings.enabled) this.monitor.start(); }
  stop() { this.monitor.stop(); }

  toPanel(channel, payload) {
    const panel = this.deps.getPanel();
    if (panel && !panel.isDestroyed() && panel.isVisible()) this.deps.send(panel, channel, payload);
  }

  view() {
    return { ...this.monitor.snapshot(), settings: this.settings, log: this.log, fake: !!this.sensors.fake };
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

  async recheck() { await this.monitor.recheck(); return this.view(); }

  /** Start a read-only Claude Code task that investigates one check. */
  ask(checkId) {
    const check = Object.prototype.hasOwnProperty.call(this.monitor.checks, checkId) ? this.monitor.checks[checkId] : null;
    if (!check?.reading) return { ok: false, error: "That reading isn't available right now." };
    const prompt = askPrompt(check.reading, this.settings);
    if (!prompt) return { ok: false, error: "Shellby doesn't know how to look into that one." };
    this.deps.stat('health-asked');
    return this.deps.startTask(prompt, `Health: ${check.reading.label}`);
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
