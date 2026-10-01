// Health rules: turn raw readings into ok / warn / critical checks, Shellby's
// mood, alert text and "ask Shellby" prompts. Everything here is pure (no I/O,
// no clock), so it is unit-tested directly; monitor.js owns timing and side effects.

const LEVELS = ['ok', 'warn', 'critical'];
const rank = level => Math.max(0, LEVELS.indexOf(level));

const DEFAULT_THRESHOLDS = Object.freeze({
  gpuWarn: 80,    // °C
  cpuWarn: 85,    // °C (Ryzen/Intel desktop chips run 80-90 under load; Tjmax is ~95-100)
  ramWarn: 90,    // % used
  diskWarnGb: 50, // GB free (small drives warn at 10% instead, whichever is lower)
});

// Settings the user can change, with the range each may take.
const THRESHOLD_LIMITS = Object.freeze({
  gpuWarn: [60, 100],
  cpuWarn: [60, 105],
  ramWarn: [70, 98],
  diskWarnGb: [1, 1000],
});

const TEMP_CRITICAL_ABOVE_WARN = 8;  // °C
const RAM_CRITICAL_ABOVE_WARN = 6;   // percentage points (capped at 99)

// How long a reading must hold before Shellby reacts, and before he calms down.
// Temperatures spike for a second all the time; nobody wants a crab that panics at that.
const TIMING = Object.freeze({
  temp: { raiseMs: 20000, clearMs: 30000, margin: 3 },   // margin in °C
  ram: { raiseMs: 45000, clearMs: 30000, margin: 3 },    // margin in % points
  disk: { raiseMs: 0, clearMs: 0, margin: 2 },           // margin in GB
});

const GB = 1024 ** 3;

/** Clamp a thresholds object to the allowed ranges, falling back to defaults. */
function normalizeThresholds(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, [lo, hi]] of Object.entries(THRESHOLD_LIMITS)) {
    const v = Number(src[key]);
    out[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : DEFAULT_THRESHOLDS[key];
  }
  return out;
}

/**
 * The warn / critical lines for one reading. Disks are "lower is worse" (free GB);
 * everything else is "higher is worse".
 */
function limitsFor(reading, t) {
  switch (reading.kind) {
    case 'gpu-temp':
    case 'cpu-temp': {
      const warn = reading.kind === 'gpu-temp' ? t.gpuWarn : t.cpuWarn;
      return { warn, critical: warn + TEMP_CRITICAL_ABOVE_WARN, margin: TIMING.temp.margin, higherIsWorse: true };
    }
    case 'ram':
      return { warn: t.ramWarn, critical: Math.min(99, t.ramWarn + RAM_CRITICAL_ABOVE_WARN), margin: TIMING.ram.margin, higherIsWorse: true };
    case 'disk': {
      const sizeGb = (reading.total || 0) / GB;
      // Big drives warn at the GB floor; small drives at 10% (so a 128 GB SSD isn't always "full").
      const warn = Math.min(t.diskWarnGb, sizeGb * 0.10);
      const critical = Math.min(t.diskWarnGb / 4, sizeGb * 0.04);
      return { warn, critical, margin: TIMING.disk.margin, higherIsWorse: false };
    }
    default:
      return null;
  }
}

const timingFor = (kind, timing = TIMING) => (kind === 'ram' ? timing.ram : kind === 'disk' ? timing.disk : timing.temp);

/**
 * The level a reading points at right now, with hysteresis: once warned, the
 * value has to come back past the line by `margin` before the level drops.
 */
function targetLevel(reading, current, t) {
  const lim = limitsFor(reading, t);
  if (!lim || !Number.isFinite(reading.value)) return 'ok';
  const v = reading.value;
  const crosses = line => (lim.higherIsWorse ? v >= line : v <= line);
  const clearOf = line => (lim.higherIsWorse ? v < line - lim.margin : v > line + lim.margin);
  let level = crosses(lim.critical) ? 'critical' : crosses(lim.warn) ? 'warn' : 'ok';
  if (current === 'critical' && level !== 'critical' && !clearOf(lim.critical)) level = 'critical';
  if (current !== 'ok' && level === 'ok' && !clearOf(lim.warn)) level = 'warn';
  return level;
}

/**
 * Advance every check by one sample.
 *   prev:     { [id]: { level, pending, since } } from the last call ({} at start)
 *   readings: [{ id, kind, label, value, unit, total? }]
 * Returns { checks, changes } where changes = [{ id, from, to, reading }]. A
 * level only moves after the new target has held for the kind's raise/clear time.
 * Checks without a reading this time are dropped (the sensor went away).
 * `timing` defaults to TIMING (screenshot and e2e runs pass zero waits).
 */
function step(prev, readings, thresholds, now, timing = TIMING) {
  const t = normalizeThresholds(thresholds);
  const checks = {};
  const changes = [];
  for (const reading of readings) {
    if (!reading || typeof reading.id !== 'string' || !Number.isFinite(reading.value)) continue;
    const old = prev?.[reading.id] || { level: 'ok', pending: null, since: null };
    const target = targetLevel(reading, old.level, t);
    let { level, pending, since } = old;
    if (target === level) {
      pending = null; since = null;
    } else {
      if (pending !== target) { pending = target; since = now; }
      const t2 = timingFor(reading.kind, timing);
      const wait = rank(target) > rank(level) ? t2.raiseMs : t2.clearMs;
      if (now - since >= wait) {
        changes.push({ id: reading.id, from: level, to: target, reading });
        level = target; pending = null; since = null;
      }
    }
    checks[reading.id] = { level, pending, since, reading };
  }
  return { checks, changes };
}

/**
 * Shellby's health mood from the current checks (worst first):
 *   scorching > hot > dizzy > stuffed > null (all good)
 * Returns { mood, level, id, text } or null. `text` is a tiny label for the speech bubble.
 */
function moodFor(checks) {
  const list = Object.values(checks || {}).filter(c => c.level !== 'ok');
  const worst = kinds => list
    .filter(c => kinds.includes(c.reading.kind))
    .sort((a, b) => rank(b.level) - rank(a.level) || severity(b.reading) - severity(a.reading))[0];
  const temp = worst(['gpu-temp', 'cpu-temp']);
  if (temp) return { mood: temp.level === 'critical' ? 'scorching' : 'hot', level: temp.level, id: temp.reading.id, text: `${Math.round(temp.reading.value)}°` };
  const ram = worst(['ram']);
  if (ram) return { mood: 'dizzy', level: ram.level, id: ram.reading.id, text: `${Math.round(ram.reading.value)}%` };
  const disk = worst(['disk']);
  if (disk) return { mood: 'stuffed', level: disk.level, id: disk.reading.id, text: `${disk.reading.drive || ''} ${formatGb(disk.reading.value)}`.trim() };
  return null;
}

// Tie-break between checks at the same level: hotter / fuller wins.
function severity(r) { return r.kind === 'disk' ? -r.value : r.value; }

function formatGb(gb) {
  if (!Number.isFinite(gb)) return '?';
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

/** Notification / log wording for a level change. */
function describe(change, thresholds) {
  const t = normalizeThresholds(thresholds);
  const r = change.reading;
  const lim = limitsFor(r, t);
  const up = rank(change.to) > rank(change.from);
  if (r.kind === 'gpu-temp' || r.kind === 'cpu-temp') {
    const v = `${Math.round(r.value)}°C`;
    if (!up) return { title: `${r.label} cooled down`, body: `Back to ${v}. Shellby can stop sweating.` };
    return change.to === 'critical'
      ? { title: `${r.label} is very hot: ${v}`, body: `That's ${Math.round(r.value - lim.warn)}°C past your ${lim.warn}°C warning. Check airflow, or ask Shellby what's using it.` }
      : { title: `${r.label} is running hot: ${v}`, body: `Above your ${lim.warn}°C warning for a while now. Shellby is sweating.` };
  }
  if (r.kind === 'ram') {
    const v = `${Math.round(r.value)}%`;
    if (!up) return { title: 'Memory is back to normal', body: `${v} of RAM in use.` };
    return { title: `Memory is ${change.to === 'critical' ? 'almost full' : 'running low'}: ${v} used`, body: `${formatGb(r.used / GB)} of ${formatGb(r.total / GB)} in use. Things may start to slow down.` };
  }
  if (r.kind === 'disk') {
    const free = formatGb(r.value);
    if (!up) return { title: `${r.label} has room again`, body: `${free} free. Nice cleanup!` };
    return { title: `${r.label} is ${change.to === 'critical' ? 'nearly full' : 'getting full'}: ${free} free`, body: `Out of ${formatGb(r.total / GB)}. Shellby can find what's taking up the space.` };
  }
  return { title: `${r.label}: ${change.to}`, body: '' };
}

/**
 * A ready-to-send Claude Code task that investigates a check. Read-only by
 * design: it asks Claude to report and suggest, never to delete or kill.
 */
function askPrompt(reading, thresholds) {
  const t = normalizeThresholds(thresholds);
  const lim = limitsFor(reading, t);
  switch (reading.kind) {
    case 'gpu-temp':
    case 'cpu-temp': {
      const part = reading.kind === 'gpu-temp' ? 'GPU' : 'CPU';
      const usage = reading.kind === 'gpu-temp'
        ? 'which processes are using the GPU most right now (nvidia-smi or Task Manager-style GPU engine counters)'
        : 'which processes are using the most CPU right now';
      return [
        `My ${reading.label}${reading.model ? ` (${reading.model})` : ''} is at ${Math.round(reading.value)}°C. Shellby warns me at ${lim.warn}°C.`,
        '',
        `1. Find out ${usage}.`,
        `2. Tell me whether this temperature is actually a problem for this ${part}, using its rated limits.`,
        '3. Suggest the most likely fixes (background apps, fan curve, dust, airflow, frame-rate caps), most likely first.',
        '',
        "Don't kill processes or change any settings. Just report back.",
      ].join('\n');
    }
    case 'ram':
      return [
        `My PC is using ${Math.round(reading.value)}% of its ${formatGb(reading.total / GB)} of RAM.`,
        '',
        '1. List the 15 processes using the most memory right now, grouped by app, with their sizes.',
        '2. Point out anything that looks like a memory leak or something I probably forgot was open.',
        '3. Suggest what I could close.',
        '',
        "Don't close anything yourself.",
      ].join('\n');
    case 'disk':
      return [
        `Drive ${reading.drive} only has ${formatGb(reading.value)} free out of ${formatGb(reading.total / GB)}.`,
        '',
        `1. Find the largest folders on ${reading.drive} (a couple of levels deep) and the biggest individual files.`,
        '2. Look for safe things to clean up: temp files, caches, old installers in Downloads, the Recycle Bin, Windows Update leftovers, duplicate game or app installs.',
        '3. Give me a table of cleanup candidates with sizes and how safe each one is.',
        '',
        "Don't delete or move anything. Just report back.",
      ].join('\n');
    default:
      return null;
  }
}

module.exports = {
  LEVELS, rank, DEFAULT_THRESHOLDS, THRESHOLD_LIMITS, TIMING,
  normalizeThresholds, limitsFor, targetLevel, step, moodFor, describe, askPrompt, formatGb,
};
