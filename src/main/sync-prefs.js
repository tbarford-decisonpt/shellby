// Your settings, following you between PCs (github/sync.js). Only personal
// choices travel: how he behaves, how Claude runs, your snippets and pins.
// What belongs to one PC stays on it: where he sits, the folder Claude works
// in, the CLI path, ports, start at login, push-to-talk (needs that PC's
// speech recognition), crash-report consent, and anything with a secret in it.
//
// Each setting follows whichever PC changed it last (syncStamps.prefs). One
// that was never stamped counts as changed at 1 if it isn't the default, so a
// PC you've set up beats a fresh install, and any real change beats both.
//
// Autonomous never comes across: switching to it has to be confirmed on each
// PC (ipc/settings.js), so the mode syncs only while it's one of the others.
// Pure. See test/sync-prefs.test.js.
const { TIMEOUTS_MIN } = require('./checks');
const { SETTINGS: CLIMB_SETTINGS } = require('./climb');
const { DEFAULTS, MODES } = require('./config');
const { COLONY_MAX } = require('./floor');
const guard = require('./guard');
const mischief = require('./mischief');
const { isModel } = require('./models');
const outputStyles = require('./outputstyles');
const { SETTINGS: PERCH_SETTINGS } = require('./perch');
const { EFFORTS } = require('./session');
const snippets = require('./snippets');
const sounds = require('./sounds');
const voice = require('./voice');
const workmode = require('./workmode');

const MAX_PINS = 12;
const bool = v => (typeof v === 'boolean' ? v : undefined);
const oneOf = list => v => (list.includes(v) ? v : undefined);

// key -> (remote value) -> the value to keep, or undefined when it won't do.
const PREFS = {
  mode: v => (MODES.includes(v) && v !== 'autonomous' ? v : undefined),
  model: v => (isModel(v) ? v : undefined),
  effort: v => (v === '' || EFFORTS.includes(v) ? v : undefined),
  outputStyle: v => (typeof v === 'string' ? outputStyles.clean(v) : undefined),
  hotkey: v => (typeof v === 'string' && /^[A-Za-z0-9+]{0,60}$/.test(v) ? v : undefined),
  critterScale: oneOf([0.75, 1, 1.5, 2]),
  notifications: bool, recap: bool, leaveGuard: bool, crabOnly: bool, workMode: bool, wander: bool, onTop: bool,
  sounds: bool, soundFx: bool, needsOn: bool, forecast: bool, spendGuard: bool, holdBigTasks: bool, flakyTests: bool,
  surprises: bool, tideEvents: bool, catchBugs: bool, bugBattles: bool, bugFollower: bool, checkEachTurn: bool, turnShots: bool, worktrees: bool, clashWarnings: bool, planOnly: bool,
  perch: oneOf(PERCH_SETTINGS),
  climb: oneOf(CLIMB_SETTINGS),
  mischief: oneOf(mischief.LEVELS),
  mischiefPranks: v => (v && typeof v === 'object' && !Array.isArray(v) ? mischief.prankSet(v) : undefined),
  colony: v => (Number.isInteger(v) ? Math.max(0, Math.min(COLONY_MAX, v)) : undefined),
  chatter: oneOf(voice.CHATTER),
  ambient: oneOf(sounds.AMBIENTS),
  soundVolume: oneOf(sounds.VOLUMES),
  spendReserve: oneOf(guard.RESERVES),
  spendMaxMinutes: oneOf(guard.MAX_MINUTES),
  checkTimeoutMin: oneOf(TIMEOUTS_MIN),
  // Work mode's keys only, each held to its own rule.
  workOverrides: v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = {};
    for (const k of workmode.KEYS) { const x = k in v ? PREFS[k](v[k]) : undefined; if (x !== undefined) out[k] = x; }
    return out;
  },
  // null is "the starters" (snippets.js normalize).
  snippets: v => (v === null ? null : Array.isArray(v) ? snippets.normalize(v) : undefined),
  // Checked again against what this PC has whenever they're shown (wiring/github.js pinnedTools).
  pinnedTools: v => (Array.isArray(v)
    ? v.filter(p => p && /^[a-z]{1,20}$/.test(p.kind) && typeof p.name === 'string' && p.name.length && p.name.length <= 200)
      .map(p => ({ kind: p.kind, name: p.name })).slice(-MAX_PINS)
    : undefined),
};
const KEYS = Object.freeze(Object.keys(PREFS));

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/** Tolerate anything (remote data especially): { key: { v, at } } for the ones that will do. */
function clean(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of KEYS) {
    if (!r[k] || typeof r[k] !== 'object' || !('v' in r[k])) continue;
    const v = PREFS[k](r[k].v);
    if (v !== undefined) out[k] = { v, at: num(r[k].at) };
  }
  return out;
}

/**
 * This PC's own settings (config.data: your own, not Work mode's overlay) and
 * when each last changed (syncStamps.prefs).
 */
function snapshot(data, stampsIn) {
  const stamps = stampsIn && typeof stampsIn === 'object' ? stampsIn : {};
  const raw = {};
  for (const k of KEYS) {
    if (!(k in data)) continue;
    raw[k] = { v: data[k], at: num(stamps[k]) || (same(data[k], DEFAULTS[k]) ? 0 : 1) };
  }
  return clean(raw);
}

/** Each setting from whichever side changed it last; a tie keeps `a` (this PC). */
function merge(aIn, bIn) {
  const a = clean(aIn), b = clean(bIn);
  const out = {};
  for (const k of KEYS) {
    const x = a[k], y = b[k];
    if (x || y) out[k] = !x || (y && y.at > x.at) ? y : x;
  }
  return out;
}

/**
 * What to write into this PC's settings: the values another PC changed more
 * recently, and every stamp, so the next sync agrees. { values, stamps }.
 */
function apply(local, merged) {
  const l = clean(local), m = clean(merged);
  const values = {};
  const stamps = {};
  for (const k of KEYS) {
    if (!m[k]) continue;
    stamps[k] = m[k].at;
    if (m[k].at > (l[k]?.at ?? -1) && !same(l[k]?.v, m[k].v)) values[k] = m[k].v;
  }
  return { values, stamps };
}

/** The synced settings this patch really changed (config.onSet), to stamp. */
function changedKeys(patch, prev) {
  return KEYS.filter(k => k in patch && !same(patch[k], prev[k]));
}

module.exports = { KEYS, PREFS, clean, snapshot, merge, apply, changedKeys };
