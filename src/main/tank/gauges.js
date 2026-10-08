// Gauges in disguise: a few things in his tank quietly show what Shellby
// already knows about your PC (docs/plans/tank-decor.md §10).
//
//   thermometer  a suction-cup thermometer on the front glass: the hottest
//                GPU (or the CPU) and red past your Health line
//   bubbler      air stones bubble faster with CPU load
//   lighthouse   lit while a dev server is running, blinking when one crashed
//   moods        Health's moods reach the water: hot warms it, dizzy swirls
//                it, stuffed piles boxes in a corner. They clear with the mood.
//
// Each one can be turned off (config `tankLive`, per PC). None of it is ever
// synced or put on a card. Main pushes a new reading only when what the tank
// would show changes (the values here are coarse on purpose), so the panel
// never asks on a timer. Pure: see test/tank-gauges.test.js.

const KEYS = Object.freeze(['thermometer', 'bubbler', 'lighthouse', 'moods']);
const MOODS = Object.freeze(['hot', 'scorching', 'dizzy', 'stuffed']);
const LOAD_STEPS = Object.freeze([25, 50, 75]);   // CPU % where the bubbles speed up a notch
const TEMP_MIN = 0;
const TEMP_MAX = 150;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Which gauges are on (all of them unless you turned one off). Never throws. */
function normalizeLive(raw) {
  const r = isObj(raw) ? raw : {};
  return Object.fromEntries(KEYS.map(k => [k, !(Object.hasOwn(r, k) && r[k] === false)]));
}

/** The hottest reading he'd show, and the line it goes red past: the GPU first, else the CPU. */
function tempOf(snap) {
  const s = isObj(snap?.sample) ? snap.sample : {};
  const t = isObj(snap?.thresholds) ? snap.thresholds : {};
  const gpus = (Array.isArray(s.gpus) ? s.gpus : []).map(g => num(g?.temp)).filter(v => v !== null);
  const gpu = gpus.length ? Math.max(...gpus) : null;
  const value = gpu ?? num(s.cpu?.temp);
  if (value === null || value < TEMP_MIN || value > TEMP_MAX) return null;
  const warn = num(gpu !== null ? t.gpuWarn : t.cpuWarn);
  const round = Math.round(value);
  return { value: round, warn: warn === null ? null : Math.round(warn), hot: warn !== null && round >= warn, of: gpu !== null ? 'gpu' : 'cpu' };
}

/** 0 (calm) to 3 (busy): CPU load in coarse steps, so a jittery reading doesn't send a new one every poll. */
function loadStep(snap) {
  const load = num(snap?.sample?.cpu?.load);
  if (load === null) return null;
  return LOAD_STEPS.filter(s => load >= s).length;
}

/** The mood the water takes (only the ones it has a look for). */
function moodOf(mood) {
  const m = isObj(mood) ? mood.mood : typeof mood === 'string' ? mood : null;
  return MOODS.includes(m) ? m : null;
}

/** Dev servers, from DevServers#summary(): lit while any is up, blinking while one crashed. */
function lighthouseOf(servers) {
  if (!isObj(servers)) return null;
  const up = Number.isInteger(servers.up) && servers.up > 0;
  const down = Number.isInteger(servers.down) && servers.down > 0;
  return { lit: up || down, blink: down };
}

/**
 * What the tank shows now. Anything turned off, or not known, is null.
 *   health: the Health monitor's latest snapshot ({ sample, thresholds }), or null
 *   mood:   Health's mood ({ mood } or null; null too when Health moods are off)
 *   servers: DevServers#summary(), or null
 *   live:   normalizeLive()
 */
function gauges({ health = null, mood = null, servers = null, live = null } = {}) {
  const on = normalizeLive(live);
  return {
    thermometer: on.thermometer ? tempOf(health) : null,
    bubbler: on.bubbler ? loadStep(health) : null,
    lighthouse: on.lighthouse ? lighthouseOf(servers) : null,
    mood: on.moods ? moodOf(mood) : null,
    live: on,
  };
}

/** Whether two readings would look the same in the tank. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = { KEYS, MOODS, LOAD_STEPS, normalizeLive, tempOf, loadStep, moodOf, lighthouseOf, gauges, same };
