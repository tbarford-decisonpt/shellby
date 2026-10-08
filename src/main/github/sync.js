// Sync between PCs through one private gist ("shellby-sync.json"): trophies,
// collected seasonal items, stats, XP, streak days, shell stickers, the outfit
// and the skin. Merging only ever adds progress (unions and maxima), so a sync
// can't lose anything on either side. XP is counted per PC and the PCs are
// added together (xp.js mergeXpCounts), so XP earned on two PCs adds up. The
// outfit, skin and sticker layouts follow whichever PC changed them last. The
// Bugdex's catches are counted per PC like XP (bugdex.js merge). His tank's
// layout follows whichever PC changed it last (tank-share.js). Your friends list
// follows the latest add or remove on any PC (friends.js mergeSync), and each of
// your settings whichever PC changed it last, snippets and pins item by item
// (sync-prefs.js). The gist is yours but is still treated as untrusted input.
const { normalizeStats } = require('../wardrobe/achievements');
const { normalizeXp, mergeXpCounts, cleanByDevice } = require('../xp');
const stickers = require('../stickers');
const bugdex = require('../bugdex');
const tankShare = require('../tank-share');
const tankLayouts = require('../tank-layouts');
const friends = require('../friends');
const events = require('../events');
const prefs = require('../sync-prefs');
const { findGist } = require('./gists');

const FILE = 'shellby-sync.json';
const FORMAT = 1;
const MAX_BYTES = 512 * 1024;
const SLOTS = ['hat', 'face', 'neck', 'held', 'shell', 'effect'];
const KEY_RE = /^[a-z0-9][a-z0-9/-]{0,80}$/;

const strings = (list, re, max) => [...new Set((Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && re.test(x)))].slice(0, max);
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Pull the syncable parts out of Shellby's settings. get: config.get. data:
 * your own settings, without Work mode laid over them (config.data).
 */
function snapshot(get, data = {}) {
  const w = get('wardrobe') || {};
  const stamps = get('syncStamps') || {};
  const xp = normalizeXp(get('xp'));
  const streaks = get('streaks') || {};
  return clean({
    format: FORMAT,
    wardrobe: { unlocked: w.unlocked, collected: w.collected, outfit: w.outfit, outfitAt: stamps.outfitAt },
    stats: get('stats'),
    xp: { total: xp.total, byDevice: xp.byDevice, legacyPending: xp.legacyPending, log: xp.log, lastDay: xp.lastDay },
    days: streaks.days,
    stickers: get('stickers'),
    skin: get('skin'), skinAt: stamps.skinAt,
    // Catches made before this PC had its id count as this PC's.
    bugdex: bugdex.syncable(bugdex.withDevice(get('bugdex'), xp.device)),
    tank: get('tank'),
    tankLayouts: get('tankLayouts'),
    friends: friends.syncable(get('friends')),
    // Tide events: goals and medals follow you between PCs (events.js merge).
    events: events.normalize(get('events')),
    prefs: prefs.snapshot(data, stamps.prefs),
  });
}

/** Tolerate anything (remote data especially). */
function clean(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = r.wardrobe && typeof r.wardrobe === 'object' ? r.wardrobe : {};
  const outfit = {};
  for (const s of SLOTS) outfit[s] = typeof w.outfit?.[s] === 'string' && KEY_RE.test(w.outfit[s]) ? w.outfit[s] : null;
  const xp = normalizeXp({ total: r.xp?.total, byDevice: r.xp?.byDevice, log: r.xp?.log, lastDay: r.xp?.lastDay });
  return {
    format: FORMAT,
    wardrobe: {
      unlocked: strings(w.unlocked, /^[a-z0-9-]{1,40}$/, 200),
      collected: strings(w.collected, KEY_RE, 500),
      outfit,
      outfitAt: num(w.outfitAt),
    },
    stats: normalizeStats(r.stats),
    // An older Shellby writes only a total: it still counts, as a floor (see cleanByDevice).
    // Another PC's 'local' (XP from before it had its id) never comes across.
    xp: { total: xp.total, byDevice: cleanByDevice(r.xp?.byDevice, 0, { keepLocal: false }), legacyPending: r.xp?.legacyPending === true, log: xp.log, lastDay: xp.lastDay },
    days: strings(r.days, /^\d{4}-\d{2}-\d{2}$/, 400).sort(),
    // No folders, options or badges: those belong to each PC (stickers.js syncable).
    stickers: stickers.syncable(r.stickers),
    skin: typeof r.skin === 'string' && /^[a-z0-9][a-z0-9/-]{0,80}$/.test(r.skin) ? r.skin : null,
    skinAt: num(r.skinAt),
    // Species counts and habitats only: no projects, bugs or open encounters.
    bugdex: bugdex.normalizeSync(r.bugdex),
    // The layout only: whether it's on your calling card stays on each PC.
    tank: tankShare.syncable(r.tank),
    // The saved layouts; what a season put up on this PC stays here.
    tankLayouts: tankLayouts.syncable(r.tankLayouts),
    // Who's on the list and who you removed: no cards, visits or waves.
    friends: friends.syncable(r.friends),
    events: events.normalize(r.events),
    // Personal settings only, each with when it last changed.
    prefs: prefs.clean(r.prefs),
  };
}

/** Combine two snapshots: unions and maxima; the outfit/skin follow the newer change. */
function merge(aIn, bIn) {
  const a = clean(aIn), b = clean(bIn);
  const union = (x, y) => [...new Set([...x, ...y])];
  const stats = {};
  for (const k of Object.keys(a.stats)) stats[k] = k === 'activeDays' ? union(a.stats.activeDays, b.stats.activeDays) : Math.max(a.stats[k], b.stats[k] || 0);
  const seen = new Set();
  const counts = mergeXpCounts(a.xp, b.xp);
  const log = [...a.xp.log, ...b.xp.log].sort((x, y) => y.at - x.at).filter(e => { const k = `${e.at}|${e.kind}|${e.label}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
  const newerOutfit = b.wardrobe.outfitAt > a.wardrobe.outfitAt ? b : a;
  const newerSkin = b.skinAt > a.skinAt ? b : a;
  return clean({
    format: FORMAT,
    wardrobe: {
      unlocked: union(a.wardrobe.unlocked, b.wardrobe.unlocked),
      collected: union(a.wardrobe.collected, b.wardrobe.collected),
      outfit: newerOutfit.wardrobe.outfit,
      outfitAt: newerOutfit.wardrobe.outfitAt,
    },
    stats,
    xp: { total: counts.total, byDevice: counts.byDevice, log, lastDay: [a.xp.lastDay, b.xp.lastDay].filter(Boolean).sort().pop() || null },
    days: union(a.days, b.days).sort().slice(-400),
    stickers: stickers.merge(a.stickers, b.stickers),
    skin: newerSkin.skin, skinAt: newerSkin.skinAt,
    bugdex: bugdex.merge(a.bugdex, b.bugdex),
    tank: tankShare.merge(a.tank, b.tank),
    tankLayouts: tankLayouts.merge(a.tankLayouts, b.tankLayouts),
    friends: friends.mergeSync(a.friends, b.friends),
    events: events.merge(a.events, b.events),
    prefs: prefs.merge(a.prefs, b.prefs),
  });
}

const same = (x, y) => JSON.stringify(clean(x)) === JSON.stringify(clean(y));

/** Write a merged snapshot back into Shellby's settings (patch for config.set). */
function patchFor(merged, get, data = {}) {
  const w = get('wardrobe') || {};
  const xp = get('xp') || {};
  const streaks = get('streaks') || {};
  const patch = {
    wardrobe: { ...w, unlocked: merged.wardrobe.unlocked, collected: merged.wardrobe.collected, outfit: merged.wardrobe.outfit },
    stats: merged.stats,
    xp: { ...xp, total: merged.xp.total, byDevice: merged.xp.byDevice, legacyPending: false, log: merged.xp.log, lastDay: merged.xp.lastDay },
    streaks: { ...streaks, days: merged.days },
    // Merged into this PC's own, so its folders, options and badges stay.
    stickers: stickers.merge(get('stickers'), merged.stickers),
    syncStamps: { outfitAt: merged.wardrobe.outfitAt, skinAt: merged.skinAt, prefs: null },
    // Merged into this PC's own book, so its open bugs and projects stay.
    bugdex: bugdex.applySync(bugdex.withDevice(get('bugdex'), normalizeXp(xp).device), merged.bugdex),
  };
  // A newer tank from another PC; this PC's own choice about the calling card stays.
  if (merged.tank.editedAt > tankShare.syncable(get('tank')).editedAt) patch.tank = tankShare.applySync(get('tank'), merged.tank);
  if (merged.tankLayouts.editedAt > tankLayouts.syncable(get('tankLayouts')).editedAt) patch.tankLayouts = tankLayouts.applySync(get('tankLayouts'), merged.tankLayouts);
  if (merged.skin) patch.skin = merged.skin;
  const ev = events.merge(get('events'), merged.events);
  if (JSON.stringify(ev) !== JSON.stringify(events.normalize(get('events')))) patch.events = ev;
  if (JSON.stringify(friends.syncable(get('friends'))) !== JSON.stringify(merged.friends)) patch.friends = friends.applySync(get('friends'), merged.friends);
  // A PC in Autonomous stays in it (sync-prefs.js heldBack).
  const p = prefs.apply(prefs.snapshot(data, (get('syncStamps') || {}).prefs), merged.prefs, prefs.heldBack(data));
  Object.assign(patch, p.values);
  patch.syncStamps.prefs = p.stamps;
  return patch;
}

// ------------------------------------------------------------------ the gist

async function readGist(gh, id) {
  const g = await gh.get(`/gists/${encodeURIComponent(id)}`);
  const f = g?.files?.[FILE];
  if (!f || f.size > MAX_BYTES) return null;
  try { return clean(JSON.parse(f.content || '{}')); } catch { return null; }
}

// What's in the gist is settled: nobody else's legacy is pending.
const settled = snap => { const c = clean(snap); return { ...c, xp: { ...c.xp, legacyPending: false } }; };
const content = snap => JSON.stringify({ ...settled(snap), note: 'Shellby sync: trophies, XP, outfit, streak days, shell stickers, his tank and its saved layouts, your friends list and settings. Safe to delete; Shellby makes a new one.' }, null, 1);

/**
 * One sync: merge local with the gist, apply what changed locally, push what
 * changed remotely. Returns { gistId, pulled, pushed }.
 *   get/set: config accessors. data(): your own settings (config.data)
 */
async function syncNow(gh, { get, set, data = () => ({}) }) {
  const local = snapshot(get, data());
  const id = await findGist(gh, get('syncGistId'), FILE);
  if (!id) {
    const created = await gh.post('/gists', { public: false, description: 'Shellby sync', files: { [FILE]: { content: content(local) } } });
    // This PC's legacy is now the gist's, so it counts in full from here on.
    set({ syncGistId: created.id, xp: { ...normalizeXp(get('xp')), legacyPending: false } });
    return { gistId: created.id, pulled: false, pushed: true };
  }
  if (id !== get('syncGistId')) set({ syncGistId: id });
  const remote = await readGist(gh, id) || clean({});
  const merged = merge(local, remote);
  const pulled = !same(merged, local);
  if (pulled) set(patchFor(merged, get, data()));
  const pushed = !same(merged, remote);
  if (pushed) await gh.patch(`/gists/${encodeURIComponent(id)}`, { files: { [FILE]: { content: content(merged) } } });
  return { gistId: id, pulled, pushed };
}

module.exports = { snapshot, clean, merge, patchFor, syncNow, findGist, FILE };
