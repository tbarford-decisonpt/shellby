// Sync between PCs through one private gist ("shellby-sync.json"): trophies,
// collected seasonal items, stats, XP, streak days, shell stickers, the outfit
// and the skin. Merging only ever adds progress (unions and maxima), so a sync
// can't lose anything on either side; the outfit, skin and sticker layouts
// follow whichever PC changed them last. The gist is yours but is still
// treated as untrusted input.
const { normalizeStats } = require('../wardrobe/achievements');
const { normalizeXp } = require('../xp');
const stickers = require('../stickers');

const FILE = 'shellby-sync.json';
const FORMAT = 1;
const MAX_BYTES = 512 * 1024;
const SLOTS = ['hat', 'face', 'neck', 'held', 'shell', 'effect'];
const KEY_RE = /^[a-z0-9][a-z0-9/-]{0,80}$/;

const strings = (list, re, max) => [...new Set((Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && re.test(x)))].slice(0, max);
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);

/** Pull the syncable parts out of Shellby's settings (config.get). */
function snapshot(get) {
  const w = get('wardrobe') || {};
  const stamps = get('syncStamps') || {};
  const xp = normalizeXp(get('xp'));
  const streaks = get('streaks') || {};
  return clean({
    format: FORMAT,
    wardrobe: { unlocked: w.unlocked, collected: w.collected, outfit: w.outfit, outfitAt: stamps.outfitAt },
    stats: get('stats'),
    xp: { total: xp.total, log: xp.log, lastDay: xp.lastDay },
    days: streaks.days,
    stickers: get('stickers'),
    skin: get('skin'), skinAt: stamps.skinAt,
  });
}

/** Tolerate anything (remote data especially). */
function clean(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = r.wardrobe && typeof r.wardrobe === 'object' ? r.wardrobe : {};
  const outfit = {};
  for (const s of SLOTS) outfit[s] = typeof w.outfit?.[s] === 'string' && KEY_RE.test(w.outfit[s]) ? w.outfit[s] : null;
  const xp = normalizeXp({ total: r.xp?.total, log: r.xp?.log, lastDay: r.xp?.lastDay });
  return {
    format: FORMAT,
    wardrobe: {
      unlocked: strings(w.unlocked, /^[a-z0-9-]{1,40}$/, 200),
      collected: strings(w.collected, KEY_RE, 500),
      outfit,
      outfitAt: num(w.outfitAt),
    },
    stats: normalizeStats(r.stats),
    xp: { total: xp.total, log: xp.log, lastDay: xp.lastDay },
    days: strings(r.days, /^\d{4}-\d{2}-\d{2}$/, 400).sort(),
    // No folders, options or badges: those belong to each PC (stickers.js syncable).
    stickers: stickers.syncable(r.stickers),
    skin: typeof r.skin === 'string' && /^[a-z0-9][a-z0-9/-]{0,80}$/.test(r.skin) ? r.skin : null,
    skinAt: num(r.skinAt),
  };
}

/** Combine two snapshots: unions and maxima; the outfit/skin follow the newer change. */
function merge(aIn, bIn) {
  const a = clean(aIn), b = clean(bIn);
  const union = (x, y) => [...new Set([...x, ...y])];
  const stats = {};
  for (const k of Object.keys(a.stats)) stats[k] = k === 'activeDays' ? union(a.stats.activeDays, b.stats.activeDays) : Math.max(a.stats[k], b.stats[k] || 0);
  const seen = new Set();
  const log = [...a.xp.log, ...b.xp.log].sort((x, y) => y.at - x.at).filter(e => { const k = `${e.at}|${e.kind}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
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
    xp: { total: Math.max(a.xp.total, b.xp.total), log, lastDay: [a.xp.lastDay, b.xp.lastDay].filter(Boolean).sort().pop() || null },
    days: union(a.days, b.days).sort().slice(-400),
    stickers: stickers.merge(a.stickers, b.stickers),
    skin: newerSkin.skin, skinAt: newerSkin.skinAt,
  });
}

const same = (x, y) => JSON.stringify(clean(x)) === JSON.stringify(clean(y));

/** Write a merged snapshot back into Shellby's settings (patch for config.set). */
function patchFor(merged, get) {
  const w = get('wardrobe') || {};
  const xp = get('xp') || {};
  const streaks = get('streaks') || {};
  const patch = {
    wardrobe: { ...w, unlocked: merged.wardrobe.unlocked, collected: merged.wardrobe.collected, outfit: merged.wardrobe.outfit },
    stats: merged.stats,
    xp: { ...xp, total: merged.xp.total, log: merged.xp.log, lastDay: merged.xp.lastDay },
    streaks: { ...streaks, days: merged.days },
    // Merged into this PC's own, so its folders, options and badges stay.
    stickers: stickers.merge(get('stickers'), merged.stickers),
    syncStamps: { outfitAt: merged.wardrobe.outfitAt, skinAt: merged.skinAt },
  };
  if (merged.skin) patch.skin = merged.skin;
  return patch;
}

// ------------------------------------------------------------------ the gist

/** Find one of your own gists by the file it holds (the sync gist by default); returns its id or null. */
async function findGist(gh, knownId, file = FILE) {
  if (knownId) {
    try { await gh.get(`/gists/${encodeURIComponent(knownId)}`); return knownId; } catch (e) { if (e.status !== 404) throw e; }
  }
  for (let page = 1; page <= 5; page++) {
    const list = await gh.get(`/gists?per_page=100&page=${page}`);
    const hit = (list || []).find(g => g.files && g.files[file]);
    if (hit) return hit.id;
    if (!list || list.length < 100) break;
  }
  return null;
}

async function readGist(gh, id) {
  const g = await gh.get(`/gists/${encodeURIComponent(id)}`);
  const f = g?.files?.[FILE];
  if (!f || f.size > MAX_BYTES) return null;
  try { return clean(JSON.parse(f.content || '{}')); } catch { return null; }
}

const content = snap => JSON.stringify({ ...clean(snap), note: 'Shellby sync: trophies, XP, outfit, streak days and shell stickers. Safe to delete; Shellby makes a new one.' }, null, 1);

/**
 * One sync: merge local with the gist, apply what changed locally, push what
 * changed remotely. Returns { gistId, pulled, pushed }.
 *   get/set: config accessors
 */
async function syncNow(gh, { get, set }) {
  const local = snapshot(get);
  const id = await findGist(gh, get('syncGistId'));
  if (!id) {
    const created = await gh.post('/gists', { public: false, description: 'Shellby sync', files: { [FILE]: { content: content(local) } } });
    set({ syncGistId: created.id });
    return { gistId: created.id, pulled: false, pushed: true };
  }
  if (id !== get('syncGistId')) set({ syncGistId: id });
  const remote = await readGist(gh, id) || clean({});
  const merged = merge(local, remote);
  const pulled = !same(merged, local);
  if (pulled) set(patchFor(merged, get));
  const pushed = !same(merged, remote);
  if (pushed) await gh.patch(`/gists/${encodeURIComponent(id)}`, { files: { [FILE]: { content: content(merged) } } });
  return { gistId: id, pulled, pushed };
}

module.exports = { snapshot, clean, merge, patchFor, syncNow, findGist, FILE };
