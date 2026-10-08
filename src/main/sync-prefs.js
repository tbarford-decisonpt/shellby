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
// Nor is a PC in Autonomous switched out of it by a sync (heldBack): its mode
// syncs again from the next time you change it there.
//
// Snippets and pins go item by item (LISTS): each one follows the PC that
// added, edited or deleted it last, with a marker for a delete (like friends.js
// mergeSync), so one added on another PC isn't lost to a change made here. A
// list from an older Shellby has no per-item stamps: whatever isn't on it
// counts as deleted when the list last changed (`floor`), as it always did.
// Pure. See test/sync-prefs.test.js.
const { TIMEOUTS_MIN } = require('./checks');
const { SETTINGS: CLIMB_SETTINGS } = require('./climb');
const { DEFAULTS, MODES } = require('./config');
const filelinks = require('./filelinks');
const { COLONY_MAX } = require('./floor');
const guard = require('./guard');
const mischief = require('./mischief');
const { isModel } = require('./models');
const outputStyles = require('./outputstyles');
const { SETTINGS: PERCH_SETTINGS } = require('./perch');
const { FEATURES: SUGGESTABLE } = require('./selfaware');
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
  effortPick: bool,
  outputStyle: v => (typeof v === 'string' ? outputStyles.clean(v) : undefined),
  hotkey: v => (typeof v === 'string' && /^[A-Za-z0-9+]{0,60}$/.test(v) ? v : undefined),
  critterScale: oneOf([0.75, 1, 1.5, 2]),
  notifications: bool, recap: bool, claudeTricks: bool, plainCards: bool, leaveGuard: bool, crabOnly: bool, workMode: bool, wander: bool, onTop: bool,
  sounds: bool, soundFx: bool, needsOn: bool, forecast: bool, spendGuard: bool, holdBigTasks: bool, flakyTests: bool,
  selfAware: bool, suggestions: bool, queueKeepAwake: bool, externalSessions: bool,
  // An editor this PC doesn't have falls back to the one it does (filelinks.js pickEditor).
  editor: oneOf(filelinks.CHOICES),
  mutedSuggestions: v => (Array.isArray(v) ? [...new Set(v.filter(f => typeof f === 'string' && SUGGESTABLE[f]))] : undefined),
  surprises: bool, tideEvents: bool, signCommits: bool, catchBugs: bool, bugBattles: bool, bugFollower: bool, checkEachTurn: bool, turnShots: bool, worktrees: bool, clashWarnings: bool, planOnly: bool,
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

// The settings that merge item by item: how to tell one item from another.
// null snippets are the starters, so they count as those items, stamped 0.
const LISTS = Object.freeze({
  snippets: { id: s => s.name, items: v => snippets.normalize(v) },
  pinnedTools: { id: p => `${p.kind}:${p.name}`, items: v => PREFS.pinnedTools(v) || [] },
});
const MAX_GONE = 200;

// What a sync names when it brings one in ("Synced from your other PC: ...").
const LABELS = Object.freeze({
  mode: 'mode', model: 'model', effort: 'effort', effortPick: 'effort picking', outputStyle: 'output style', hotkey: 'hotkey', critterScale: 'his size',
  notifications: 'notifications', recap: 'recaps', claudeTricks: 'new tricks', plainCards: 'plain words', leaveGuard: 'shutdown guard', crabOnly: 'just the crab', workMode: 'Work mode',
  wander: 'wandering', onTop: 'always on top', sounds: 'his voice', soundFx: 'sound effects', needsOn: 'snacks and naps',
  forecast: 'forecast', spendGuard: 'limit guard', holdBigTasks: 'holding big tasks', flakyTests: 'flaky tests', surprises: 'surprises', tideEvents: 'tide events', signCommits: 'signed commits',
  catchBugs: 'bug catching', bugBattles: 'bug battles', bugFollower: 'his favourite catch', checkEachTurn: 'checks after each turn',
  turnShots: 'turn screenshots', worktrees: 'copies', clashWarnings: 'clash warnings', planOnly: 'plan only', perch: 'perching',
  climb: 'climbing', mischief: 'mischief', mischiefPranks: 'pranks', colony: 'pals', chatter: 'chatter', ambient: 'ambient sound',
  soundVolume: 'volume', spendReserve: 'limit reserve', spendMaxMinutes: 'limit wait', checkTimeoutMin: 'check time limit',
  workOverrides: 'Work mode', snippets: 'snippets', pinnedTools: 'pins',
  selfAware: 'Claude knowing Shellby', suggestions: 'feature suggestions', mutedSuggestions: 'muted suggestions',
  queueKeepAwake: 'staying awake for queued work', externalSessions: 'outside sessions', editor: 'editor',
});

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const sorted = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

// A list setting's per-item stamps: { items: { id: at }, gone: { id: at }, floor }.
// Without them (an older Shellby, or a PC that hasn't synced since) every item
// counts as changed when the list did, and anything missing as deleted then.
function cleanList(k, v, at, raw) {
  const list = LISTS[k].items(v);
  const ids = new Set(list.map(LISTS[k].id));
  const legacy = !isObj(raw?.items);
  const items = {};
  for (const id of ids) items[id] = legacy ? at : num(raw.items[id]) || at;
  const gone = Object.entries(isObj(raw?.gone) ? raw.gone : {})
    .filter(([id, t]) => id.length <= 240 && !ids.has(id) && num(t))
    .sort((x, y) => y[1] - x[1]).slice(0, MAX_GONE);
  return { v, at, items: sorted(items), gone: sorted(Object.fromEntries(gone)), floor: legacy ? at : num(raw.floor) };
}

/** Tolerate anything (remote data especially): { key: { v, at } } for the ones that will do. */
function clean(raw) {
  const r = isObj(raw) ? raw : {};
  const out = {};
  for (const k of KEYS) {
    if (!r[k] || typeof r[k] !== 'object' || !('v' in r[k])) continue;
    const v = PREFS[k](r[k].v);
    if (v === undefined) continue;
    out[k] = LISTS[k] ? cleanList(k, v, num(r[k].at), r[k]) : { v, at: num(r[k].at) };
  }
  return out;
}

const atOf = (k, v, stamps) => num(stamps[k]) || (same(v, DEFAULTS[k]) ? 0 : 1);

/**
 * This PC's own settings (config.data: your own, not Work mode's overlay) and
 * when each last changed (syncStamps.prefs, with the lists' items in .lists).
 */
function snapshot(data, stampsIn) {
  const stamps = isObj(stampsIn) ? stampsIn : {};
  const raw = {};
  for (const k of KEYS) {
    if (!(k in data)) continue;
    raw[k] = { ...(LISTS[k] && isObj(stamps.lists?.[k]) ? stamps.lists[k] : {}), v: data[k], at: atOf(k, data[k], stamps) };
  }
  return clean(raw);
}

// Both PCs' lists: each item from whichever added, edited or deleted it last.
// A tie keeps the item, and between two edits, `x`'s (this PC). The order is
// the one from the list that changed last (a tie goes by its text, so two PCs
// always pick the same one).
function mergeList(k, x, y) {
  const { id } = LISTS[k];
  const latest = new Map();
  const consider = (key, e) => { const was = latest.get(key); if (!was || e.at > was.at || (e.at === was.at && e.item && !was.item)) latest.set(key, e); };
  for (const side of [x, y]) for (const item of LISTS[k].items(side.v)) consider(id(item), { at: side.items[id(item)], item });
  for (const side of [x, y]) for (const [key, at] of Object.entries(side.gone)) consider(key, { at, item: null });
  // An older list: what isn't on it was deleted when it last changed.
  for (const side of [x, y]) for (const key of [...latest.keys()]) if (!(key in side.items) && !(key in side.gone)) consider(key, { at: side.floor, item: null });
  const first = y.at > x.at || (y.at === x.at && JSON.stringify(y.v) < JSON.stringify(x.v)) ? [y, x] : [x, y];
  const order = [...new Set(first.flatMap(side => LISTS[k].items(side.v).map(id)))];
  const kept = order.filter(key => latest.get(key).item);
  const allNull = x.v === null && y.v === null;
  const v = allNull ? null : PREFS[k](kept.map(key => latest.get(key).item));
  return cleanList(k, v, Math.max(x.at, y.at), {
    items: Object.fromEntries(kept.map(key => [key, latest.get(key).at])),
    gone: Object.fromEntries([...latest].filter(([, e]) => !e.item).map(([key, e]) => [key, e.at])),
    floor: Math.max(x.floor, y.floor),
  });
}

/** Each setting from whichever side changed it last; a tie keeps `a` (this PC). */
function merge(aIn, bIn) {
  const a = clean(aIn), b = clean(bIn);
  const out = {};
  for (const k of KEYS) {
    const x = a[k], y = b[k];
    if (LISTS[k] && x && y) out[k] = mergeList(k, x, y);
    else if (x || y) out[k] = !x || (y && y.at > x.at) ? y : x;
  }
  return out;
}

/** What a sync mustn't change on this PC: the mode, while it's in Autonomous. */
function heldBack(data) {
  return data?.mode === 'autonomous' ? ['mode'] : [];
}

/**
 * What to write into this PC's settings: the values another PC changed more
 * recently, and every stamp, so the next sync agrees. { values, stamps }.
 * held: keys to leave as they are (heldBack).
 */
function apply(local, merged, held = []) {
  const l = clean(local), m = clean(merged);
  const values = {};
  const stamps = {};
  for (const k of KEYS) {
    if (!m[k]) continue;
    stamps[k] = m[k].at;
    if (held.includes(k)) continue;
    if (LISTS[k]) {
      const { v, items, gone, floor } = m[k];
      stamps.lists = { ...stamps.lists, [k]: { items, gone, floor } };
      // The merge decided item by item already: whatever differs came from the other side.
      if (!l[k] || !same(LISTS[k].items(l[k].v), LISTS[k].items(v))) values[k] = v;
    } else if (m[k].at > (l[k]?.at ?? -1) && !same(l[k]?.v, m[k].v)) values[k] = m[k].v;
  }
  return { values, stamps };
}

/** The synced settings this patch really changed (config.onSet), to stamp. */
function changedKeys(patch, prev) {
  return KEYS.filter(k => k in patch && !same(patch[k], prev[k]));
}

/**
 * New syncStamps.prefs for a change you made (config.onSet), or null when it
 * changed no synced setting: the time for each one, and for a list, each item
 * added or edited, and a marker for each one deleted.
 */
function restamp(patch, prev, stampsIn, now) {
  const changed = changedKeys(patch, prev);
  if (!changed.length) return null;
  const was = isObj(stampsIn) ? stampsIn : {};
  const stamps = { ...was };
  for (const k of changed) {
    stamps[k] = now;
    if (!LISTS[k]) continue;
    const { id } = LISTS[k];
    const before = cleanList(k, prev[k], atOf(k, prev[k], was), isObj(was.lists?.[k]) ? was.lists[k] : {});
    const old = new Map(LISTS[k].items(prev[k]).map(x => [id(x), x]));
    const next = LISTS[k].items(patch[k]);
    const items = Object.fromEntries(next.map(x => [id(x), same(old.get(id(x)), x) ? before.items[id(x)] : now]));
    const gone = { ...before.gone };
    for (const key of old.keys()) if (!(key in items)) gone[key] = now;
    for (const key of Object.keys(items)) delete gone[key];
    stamps.lists = { ...stamps.lists, [k]: { items, gone, floor: before.floor } };
  }
  return stamps;
}

/** "theme, editor": the settings a sync changed, as Settings calls them. */
function describe(keys) {
  return [...new Set(keys.map(k => LABELS[k] || k))].join(', ');
}

module.exports = { KEYS, PREFS, LISTS, LABELS, clean, snapshot, merge, apply, heldBack, changedKeys, restamp, describe };
