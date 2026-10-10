// Your routines and workflows, following you between PCs (github/sync.js).
// Each one goes on its own: it follows whichever PC added, edited or deleted
// it last (syncStamps.plans), with a marker for a delete, like the snippets in
// sync-prefs.js.
//
// What belongs to one PC stays on it: whether it's on, when it last ran and
// how that went, and a workflow's approval (workflows/approvals.js signs it
// with a key only this PC has). One that arrives from another PC comes in
// switched off, so a routine you run on one PC doesn't start running twice,
// and a risky workflow still has to be approved here before it acts unasked.
//
// The gist is untrusted input: every item is checked again by the same rules
// as one you save, and nothing in Autonomous mode comes across (switching to
// it has to be confirmed on each PC, as with the mode in sync-prefs.js).
// Pure. See test/sync-plans.test.js.
const { validateRoutine } = require('./routines');
const { validateWorkflow } = require('./workflows/schema');

const MAX_ITEMS = 100;
const MAX_GONE = 200;
const ID_RE = /^[\w-]{1,64}$/;

// key -> what of one item travels (null when it won't do), and what stays on this PC.
const KINDS = Object.freeze({
  routines: {
    share(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const { routine } = validateRoutine({ ...raw, enabled: false, lastRunAt: null, lastStatus: null });
      if (!routine) return null;
      const { enabled: _e, lastRunAt: _r, lastStatus: _s, ...rest } = routine;
      return rest;
    },
    local: r => ({ enabled: r.enabled === true, lastRunAt: r.lastRunAt ?? null, lastStatus: r.lastStatus ?? null }),
    fresh: () => ({ enabled: false, lastRunAt: null, lastStatus: null }),
  },
  workflows: {
    share(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const now = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : 1;
      const r = validateWorkflow({ ...raw, enabled: false }, { allowAutonomous: false, now });
      if (!r.ok) return null;
      const { enabled: _e, needsApproval: _n, ...rest } = r.workflow;
      return rest;
    },
    local: w => ({ enabled: w.enabled === true }),
    fresh: () => ({ enabled: false }),
  },
});
const KEYS = Object.freeze(Object.keys(KINDS));

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const sorted = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

/** The items of a list that travel, by id, in their order. */
function shared(k, list) {
  const out = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = KINDS[k].share(raw);
    if (item && !out.has(item.id) && out.size < MAX_ITEMS) out.set(item.id, item);
  }
  return out;
}

/**
 * One list, cleaned: { v: [items], items: { id: at }, gone: { id: at } }.
 * An item never stamped (made before this sync, or by an older Shellby)
 * counts as changed at 1, so any real change beats it.
 */
function cleanList(k, raw) {
  const r = isObj(raw) ? raw : {};
  const byId = shared(k, r.v);
  const stamps = isObj(r.items) ? r.items : {};
  const items = {};
  for (const id of byId.keys()) items[id] = num(stamps[id]) || 1;
  const gone = Object.entries(isObj(r.gone) ? r.gone : {})
    .filter(([id, t]) => ID_RE.test(id) && !byId.has(id) && num(t))
    .sort((x, y) => y[1] - x[1]).slice(0, MAX_GONE);
  return { v: [...byId.values()], items: sorted(items), gone: sorted(Object.fromEntries(gone)) };
}

/** Tolerate anything (remote data especially). */
function clean(raw) {
  const r = isObj(raw) ? raw : {};
  return Object.fromEntries(KEYS.map(k => [k, cleanList(k, r[k])]));
}

/** This PC's routines and workflows (config.data) and their stamps (syncStamps.plans). */
function snapshot(data, stampsIn) {
  const stamps = isObj(stampsIn) ? stampsIn : {};
  return clean(Object.fromEntries(KEYS.map(k => [k, { ...(isObj(stamps[k]) ? stamps[k] : {}), v: data?.[k] }])));
}

// Both PCs' lists: each item from whichever added, edited or deleted it last.
// A tie keeps the item, and between two edits, `x`'s (this PC). This PC's
// order comes first, then what's new from the other.
function mergeList(x, y) {
  const latest = new Map();
  const consider = (id, e) => { const was = latest.get(id); if (!was || e.at > was.at || (e.at === was.at && e.item && !was.item)) latest.set(id, e); };
  for (const side of [x, y]) for (const item of side.v) consider(item.id, { at: side.items[item.id], item });
  for (const side of [x, y]) for (const [id, at] of Object.entries(side.gone)) consider(id, { at, item: null });
  const order = [...new Set([...x.v, ...y.v].map(i => i.id))].filter(id => latest.get(id).item);
  return {
    v: order.map(id => latest.get(id).item).slice(0, MAX_ITEMS),
    items: sorted(Object.fromEntries(order.map(id => [id, latest.get(id).at]))),
    gone: sorted(Object.fromEntries([...latest].filter(([, e]) => !e.item).sort((p, q) => q[1].at - p[1].at).slice(0, MAX_GONE).map(([id, e]) => [id, e.at]))),
  };
}

function merge(aIn, bIn) {
  const a = clean(aIn), b = clean(bIn);
  return Object.fromEntries(KEYS.map(k => [k, mergeList(a[k], b[k])]));
}

/**
 * What to write into this PC's settings: { values, stamps }. values has a
 * list only when it changed. Each item keeps this PC's own state (on or off,
 * its last run); a new one comes in off. Items this PC can't read (a broken
 * workflow, kept for you to fix) stay as they are.
 */
function apply(data, merged) {
  const m = clean(merged);
  const values = {};
  const stamps = {};
  for (const k of KEYS) {
    const { items, gone } = m[k];
    stamps[k] = { items, gone };
    const list = Array.isArray(data?.[k]) ? data[k] : [];
    const mine = new Map(list.map(raw => [KINDS[k].share(raw)?.id, raw]).filter(([id]) => id));
    const kept = list.filter(raw => !KINDS[k].share(raw));
    const keptIds = new Set(kept.map(raw => raw?.id));
    const next = [
      ...m[k].v.filter(item => !keptIds.has(item.id)).map(item => {
        const was = mine.get(item.id);
        return { ...item, ...(was ? KINDS[k].local(was) : KINDS[k].fresh()) };
      }),
      ...kept,
    ];
    // Compared in the same shape, so key order alone never counts as a change.
    const before = [...[...mine.values()].map(raw => ({ ...KINDS[k].share(raw), ...KINDS[k].local(raw) })), ...kept];
    if (!same(next, before)) values[k] = next;
  }
  return { values, stamps };
}

/**
 * New syncStamps.plans for a change you made (config.onSet), or null when it
 * changed nothing that travels: the time for each item added or edited, and a
 * marker for each one deleted.
 */
function restamp(patch, prev, stampsIn, now) {
  const keys = KEYS.filter(k => k in patch);
  if (!keys.length) return null;
  const was = isObj(stampsIn) ? stampsIn : {};
  const out = { ...was };
  let changed = false;
  for (const k of keys) {
    const before = cleanList(k, { ...(isObj(was[k]) ? was[k] : {}), v: prev?.[k] });
    const old = new Map(before.v.map(i => [i.id, i]));
    const next = shared(k, patch[k]);
    const items = {};
    for (const [id, item] of next) items[id] = same(old.get(id), item) ? before.items[id] : now;
    // One still here that no longer travels (switched to Autonomous) isn't deleted.
    const here = new Set((Array.isArray(patch[k]) ? patch[k] : []).map(raw => raw?.id));
    const gone = { ...before.gone };
    for (const id of old.keys()) if (!here.has(id)) gone[id] = now;
    for (const id of next.keys()) delete gone[id];
    if (same(items, before.items) && same(gone, before.gone)) continue;
    out[k] = { items: sorted(items), gone: sorted(gone) };
    changed = true;
  }
  return changed ? out : null;
}

module.exports = { KEYS, clean, snapshot, merge, apply, restamp };
