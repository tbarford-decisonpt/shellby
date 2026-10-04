// The Wardrobe: what's unlocked, what Shellby is wearing, and when to celebrate.
// Pure logic over config + the catalog (no Electron), so it's unit-tested.
const { EventEmitter } = require('events');
const { loadCatalog, installPack, removePack } = require('./catalog');
const { SEASONS, KNOWN_SEASONS, activeSeasons, featuredSeason, isActive, nextStart } = require('./seasons');
const { ACHIEVEMENTS, KNOWN_ACHIEVEMENTS, normalizeStats, recordStat, evaluate, progress } = require('./achievements');
const { encodeOutfit, decodeOutfit, resolveEntries } = require('./codes');

const SLOTS = ['hat', 'face', 'neck', 'held', 'shell', 'effect'];
const EMPTY_OUTFIT = Object.freeze({ hat: null, face: null, neck: null, held: null, shell: null, effect: null });
const RANDOM_SKIP = 0.35; // chance a slot stays empty when randomizing

const DEFAULTS = {
  outfit: { ...EMPTY_OUTFIT },
  voice: null,           // key of the pack voice he talks in (null: his own)
  unlocked: [],          // achievement ids
  collected: [],         // seasonal item keys collected while their season was on
  newItems: [],          // item keys the user hasn't looked at yet
  seasonOverrides: {},   // seasonId -> window key; user changed the look during that window
  seasonalAuto: true,
  crewOutfits: true,
  unlockAll: false,
};

// Start date of the season window containing `date` (for per-year overrides and banners).
function windowStart(season, date) {
  const y = date.getFullYear();
  const [sm, sd] = season.start;
  const start = new Date(y, sm - 1, sd);
  return start > date ? new Date(y - 1, sm - 1, sd) : start;
}
function windowEnd(season, date) {
  const s = windowStart(season, date);
  const [em, ed] = season.end;
  let end = new Date(s.getFullYear(), em - 1, ed, 23, 59, 59);
  if (end < s) end = new Date(s.getFullYear() + 1, em - 1, ed, 23, 59, 59);
  return end;
}
const windowKey = (season, date) => `${season.id}@${windowStart(season, date).getFullYear()}`;

class Wardrobe extends EventEmitter {
  constructor({ config, builtinDir, userDir, now = () => new Date() }) {
    super();
    Object.assign(this, { config, builtinDir, userDir, now });
    this.catalog = { accessories: new Map(), effects: new Map(), skins: [], voices: new Map(), scenes: new Map(), packs: [], errors: [] };
  }

  // ------------------------------------------------------------ persistence
  get data() {
    const raw = this.config.get('wardrobe') || {};
    const d = { ...DEFAULTS, ...raw };
    d.outfit = { ...EMPTY_OUTFIT, ...(raw.outfit || {}) };
    for (const k of ['unlocked', 'collected', 'newItems']) d[k] = Array.isArray(raw[k]) ? raw[k].filter(x => typeof x === 'string') : [];
    d.seasonOverrides = raw.seasonOverrides && typeof raw.seasonOverrides === 'object' ? { ...raw.seasonOverrides } : {};
    d.voice = typeof raw.voice === 'string' ? raw.voice : null;
    return d;
  }
  save(patch) { this.config.set({ wardrobe: { ...this.data, ...patch } }); }
  get stats() { return normalizeStats(this.config.get('stats')); }

  // ------------------------------------------------------------ catalog
  load() {
    this.catalog = loadCatalog({ builtinDir: this.builtinDir, userDir: this.userDir, knownAchievements: KNOWN_ACHIEVEMENTS, knownSeasons: KNOWN_SEASONS });
    this.collectSeasonals();
    return this.catalog;
  }

  item(key) { return this.catalog.accessories.get(key) || this.catalog.effects.get(key) || this.catalog.voices.get(key) || this.catalog.skins.find(s => s.key === key) || null; }

  // ------------------------------------------------------------ unlocking
  isUnlocked(item, d = this.data) {
    if (!item) return false;
    const u = item.unlock;
    if (d.unlockAll || !u || u.default) return true;
    if (u.achievement) return d.unlocked.includes(u.achievement);
    if (u.season) return d.collected.includes(item.key) || isActive(u.season, this.now());
    return false;
  }

  // Why an item is locked, for tooltips: null when unlocked.
  lockInfo(item, d = this.data, stats = this.stats) {
    if (this.isUnlocked(item, d)) return null;
    const u = item.unlock;
    if (u.achievement) {
      const a = progress(stats, new Set(d.unlocked)).find(p => p.id === u.achievement);
      return { reason: 'achievement', achievement: u.achievement, text: a ? `${a.name}: ${a.description}` : 'Earn an achievement', current: a?.current ?? 0, goal: a?.goal ?? 1 };
    }
    const season = SEASONS.find(s => s.id === u.season);
    const back = nextStart(u.season, this.now());
    return { reason: 'season', season: u.season, text: `${season ? `${season.emoji} ${season.name}` : 'Seasonal'} collectible`, back: back ? back.getTime() : null };
  }

  // Seasonal items are yours to keep once their season has come around.
  collectSeasonals() {
    const d = this.data;
    const fresh = [];
    for (const item of [...this.catalog.accessories.values(), ...this.catalog.effects.values(), ...this.catalog.voices.values(), ...this.catalog.skins]) {
      const s = item.unlock?.season;
      if (s && isActive(s, this.now()) && !d.collected.includes(item.key)) fresh.push(item.key);
    }
    if (!fresh.length) return [];
    this.save({ collected: [...d.collected, ...fresh], newItems: [...new Set([...d.newItems, ...fresh])] });
    this.emit('collected', fresh.map(k => this.item(k)).filter(Boolean));
    return fresh;
  }

  // ------------------------------------------------------------ outfits
  validSlotValue(slot, key, d) {
    if (key == null) return true;
    const item = slot === 'effect' ? this.catalog.effects.get(key) : this.catalog.accessories.get(key);
    return !!item && (slot === 'effect' || item.slot === slot) && this.isUnlocked(item, d);
  }

  clean(outfit, d = this.data) {
    const out = { ...EMPTY_OUTFIT };
    for (const slot of SLOTS) if (this.validSlotValue(slot, outfit?.[slot] ?? null, d)) out[slot] = outfit?.[slot] ?? null;
    return out;
  }

  // The season's look wins while auto-seasonal is on and you haven't changed
  // your look during this season's window.
  seasonalActive(d = this.data) {
    const season = featuredSeason(this.now());
    if (!season || !d.seasonalAuto) return null;
    return d.seasonOverrides[season.id] === windowKey(season, this.now()) ? null : season;
  }

  effectiveOutfit(d = this.data) {
    const season = this.seasonalActive(d);
    return this.clean(season ? { ...EMPTY_OUTFIT, ...season.outfit } : d.outfit, d);
  }

  setOutfit(patch) {
    const d = this.data;
    const next = { ...this.effectiveOutfit(d) };
    for (const [slot, key] of Object.entries(patch || {})) {
      if (!SLOTS.includes(slot)) continue;
      if (!this.validSlotValue(slot, key, d)) return { ok: false, error: key ? 'That item is still locked.' : 'Unknown slot.' };
      next[slot] = key ?? null;
    }
    const season = featuredSeason(this.now());
    const seasonOverrides = { ...d.seasonOverrides };
    if (season && d.seasonalAuto) seasonOverrides[season.id] = windowKey(season, this.now());
    const touched = Object.values(patch || {}).filter(Boolean);
    this.save({ outfit: next, seasonOverrides, newItems: d.newItems.filter(k => !touched.includes(k)) });
    this.emit('changed');
    return { ok: true };
  }

  // ------------------------------------------------------------ outfit codes

  /** The code for what Shellby is wearing now. skin: the active skin id/key. */
  outfitCode(skin) { return encodeOutfit(this.effectiveOutfit(), skin); }

  /** Everything a code can point at: [{ key, slot }]. builtinSkins: [{ id, name }]. */
  codeTargets(builtinSkins = []) {
    return [
      ...[...this.catalog.accessories.values()].map(a => ({ key: a.key, slot: a.slot, item: a })),
      ...[...this.catalog.effects.values()].map(e => ({ key: e.key, slot: 'effect', item: e })),
      ...this.catalog.skins.map(s => ({ key: s.key, slot: 'skin', item: s })),
      ...builtinSkins.map(s => ({ key: s.id, slot: 'skin', item: { key: s.id, name: s.name, builtinSkin: true } })),
    ];
  }

  /**
   * What a code would put on: { ok, found: [{ slot, key, name, locked, item }], missing: [{ slot, hash }] }
   * (locked: null, or { text } saying how to earn it).
   */
  previewCode(text, builtinSkins = []) {
    const d = decodeOutfit(text);
    if (!d.ok) return d;
    const targets = this.codeTargets(builtinSkins);
    const { found, missing } = resolveEntries(d.entries, targets);
    return {
      ok: true,
      missing,
      found: found.map(f => {
        const it = targets.find(t => t.key === f.key && t.slot === f.slot).item;
        return { slot: f.slot, key: f.key, name: it.name, locked: it.builtinSkin ? null : this.lockInfo(it), item: it.builtinSkin ? null : publicItem(it) };
      }),
    };
  }

  /**
   * Wear a code: the whole look replaces the current one (slots the code leaves
   * empty come off). Locked items are skipped. Returns { ok, worn, skipped, skin }.
   */
  wearCode(text, builtinSkins = []) {
    const p = this.previewCode(text, builtinSkins);
    if (!p.ok) return p;
    const patch = { hat: null, face: null, neck: null, held: null, shell: null, effect: null };
    const worn = [], skipped = [];
    let skin = null;
    for (const f of p.found) {
      if (f.locked) { skipped.push(f); continue; }
      if (f.slot === 'skin') skin = f.key; else patch[f.slot] = f.key;
      worn.push(f);
    }
    const r = this.setOutfit(patch);
    if (!r.ok) return r;
    return { ok: true, worn, skipped, missing: p.missing, skin };
  }

  wearSeason() {
    const season = featuredSeason(this.now());
    if (!season) return { ok: false, error: 'No season right now.' };
    const d = this.data;
    const seasonOverrides = { ...d.seasonOverrides };
    delete seasonOverrides[season.id];
    this.save({ seasonOverrides, seasonalAuto: true });
    this.emit('changed');
    return { ok: true };
  }

  randomize(rng = Math.random) {
    const d = this.data;
    const pick = list => (list.length && rng() > RANDOM_SKIP ? list[Math.floor(rng() * list.length)].key : null);
    const patch = {};
    for (const slot of SLOTS) {
      const pool = slot === 'effect'
        ? [...this.catalog.effects.values()].filter(e => e.motion !== 'burst' && this.isUnlocked(e, d))
        : [...this.catalog.accessories.values()].filter(a => a.slot === slot && this.isUnlocked(a, d));
      patch[slot] = pick(pool);
    }
    return this.setOutfit(patch);
  }

  setOptions(opts = {}) {
    const patch = {};
    for (const k of ['seasonalAuto', 'crewOutfits', 'unlockAll']) if (typeof opts[k] === 'boolean') patch[k] = opts[k];
    this.save(patch);
    this.emit('changed');
  }

  markSeen(keys = []) {
    const d = this.data;
    this.save({ newItems: d.newItems.filter(k => !keys.includes(k)) });
  }

  // ------------------------------------------------------------ voices and scenes

  /** The pack voice he's talking in, or null for his own (also when it was removed or is locked). */
  activeVoice(d = this.data) {
    const v = d.voice ? this.catalog.voices.get(d.voice) : null;
    return v && this.isUnlocked(v, d) ? v : null;
  }

  /** Talk in a pack voice (its key), or his own (null). */
  setVoice(key) {
    const d = this.data;
    if (key != null) {
      const v = this.catalog.voices.get(key);
      if (!v) return { ok: false, error: "That voice isn't installed." };
      if (!this.isUnlocked(v, d)) return { ok: false, error: 'That voice is still locked.' };
    }
    this.save({ voice: key ?? null, newItems: d.newItems.filter(k => k !== key) });
    this.emit('changed');
    return { ok: true };
  }

  /**
   * What he says and does, for main.js and life.js: the voice he's wearing
   * (null for his own) and every pack scene, keyed so they can't clash with his.
   */
  dialogue(d = this.data) {
    const v = this.activeVoice(d);
    return {
      voice: v ? { key: v.key, name: v.name, lines: v.lines, flavor: v.flavor, fallback: v.fallback } : null,
      scenes: [...this.catalog.scenes.values()].map(s => ({ id: s.key, name: s.name, voice: s.voice, who: s.who, when: s.when, beats: s.beats })),
    };
  }

  // ------------------------------------------------------------ stats + achievements
  record(event, payload = {}) {
    const before = this.stats;
    const stats = recordStat(before, event, payload, this.now());
    if (JSON.stringify(stats) === JSON.stringify(before)) return [];
    this.config.set({ stats });
    const d = this.data;
    const newly = evaluate(stats, new Set(d.unlocked));
    if (!newly.length) return [];
    const rewards = newly.flatMap(id => ACHIEVEMENTS.find(a => a.id === id)?.rewards || []);
    this.save({ unlocked: [...d.unlocked, ...newly], newItems: [...new Set([...d.newItems, ...rewards])] });
    const events = newly.map(id => {
      const a = ACHIEVEMENTS.find(x => x.id === id);
      return { achievement: { id: a.id, name: a.name, icon: a.icon, description: a.description }, rewards: a.rewards.map(k => this.item(k)).filter(Boolean).map(publicItem) };
    });
    for (const e of events) this.emit('unlocked', e);
    return events;
  }

  // First run of the Wardrobe: credit what the user already did with Shellby
  // (from conversation history) so long-time users don't start from zero.
  // Unlocks quietly and returns the achievements earned. No-op once stats exist.
  backfill({ tasksCompleted = 0, activeDays = [] } = {}) {
    if (this.config.get('stats')) return [];
    const stats = normalizeStats({ tasksCompleted, activeDays });
    this.config.set({ stats });
    const d = this.data;
    const newly = evaluate(stats, new Set(d.unlocked));
    if (!newly.length) return [];
    const rewards = newly.flatMap(id => ACHIEVEMENTS.find(a => a.id === id)?.rewards || []);
    this.save({ unlocked: [...d.unlocked, ...newly], newItems: [...new Set([...d.newItems, ...rewards])] });
    return newly.map(id => ACHIEVEMENTS.find(a => a.id === id)).map(a => ({ id: a.id, name: a.name, icon: a.icon, rewards: a.rewards.map(k => this.item(k)?.name).filter(Boolean) }));
  }

  // ------------------------------------------------------------ packs
  install(filePath) {
    const reservedIds = new Set(this.catalog.packs.filter(p => p.source === 'builtin').map(p => p.id));
    const r = installPack(filePath, this.userDir, { knownAchievements: KNOWN_ACHIEVEMENTS, knownSeasons: KNOWN_SEASONS, reservedIds });
    if (r.ok) { this.load(); this.emit('changed'); }
    return r;
  }

  remove(packId) {
    const pack = this.catalog.packs.find(p => p.id === packId && p.source === 'user');
    if (!pack) return false;
    const ok = removePack(packId, this.userDir);
    if (ok) { this.load(); this.emit('changed'); }
    return ok;
  }

  // ------------------------------------------------------------ views
  // What the sprite renderer needs for the current outfit.
  render() {
    const d = this.data;
    const o = this.effectiveOutfit(d);
    const accessories = ['shell', 'neck', 'hat', 'face', 'held'].map(s => o[s] && this.catalog.accessories.get(o[s])).filter(Boolean).map(publicItem);
    return {
      accessories,
      effect: o.effect ? publicItem(this.catalog.effects.get(o.effect)) : null,
      confetti: publicItem(this.catalog.effects.get('confetti')),
      crewAccessories: d.crewOutfits ? accessories.filter(a => a.slot === 'hat') : [],
    };
  }

  // Everything the Wardrobe screen shows.
  view() {
    const d = this.data;
    const stats = this.stats;
    const now = this.now();
    const decorate = item => ({ ...publicItem(item), locked: this.lockInfo(item, d, stats), isNew: d.newItems.includes(item.key) });
    const featured = featuredSeason(now);
    return {
      outfit: this.effectiveOutfit(d),
      options: { seasonalAuto: d.seasonalAuto, crewOutfits: d.crewOutfits, unlockAll: d.unlockAll },
      season: featured ? { id: featured.id, name: featured.name, emoji: featured.emoji, endsAt: windowEnd(featured, now).getTime(), wearing: !!this.seasonalActive(d), outfit: featured.outfit } : null,
      activeSeasons: activeSeasons(now).map(s => s.id),
      accessories: [...this.catalog.accessories.values()].map(decorate),
      effects: [...this.catalog.effects.values()].map(decorate),
      voices: [...this.catalog.voices.values()].map(decorate),
      voice: this.activeVoice(d)?.key || null,
      skins: this.catalog.skins.map(decorate),
      achievements: progress(stats, new Set(d.unlocked)).map(p => ({ ...p, rewards: p.rewards.map(k => this.item(k)).filter(Boolean).map(publicItem) })),
      packs: this.catalog.packs.map(p => ({ id: p.id, name: p.name, author: p.author, version: p.version, description: p.description, source: p.source, counts: p.counts, warnings: (p.warnings || []).length })),
      errors: this.catalog.errors,
      totals: {
        unlocked: [...this.catalog.accessories.values(), ...this.catalog.effects.values()].filter(i => this.isUnlocked(i, d)).length,
        all: this.catalog.accessories.size + this.catalog.effects.size,
      },
      // Bragging rights for the shareable crab card (counts only, nothing personal).
      stats: {
        tasksCompleted: stats.tasksCompleted,
        helpersSpawned: stats.helpersSpawned,
        tricksLearned: stats.tricksLearned,
        activeDays: stats.activeDays.length,
      },
    };
  }
}

// Plain, serialisable copy of a catalog item for IPC.
function publicItem(item) {
  if (!item) return null;
  const { key, id, packId, name, description, slot, anchor, follows, pivot, palette, pixels, rarity, unlock, source, motion, count, speed, sprites } = item;
  const out = { key, id, packId, name, description, rarity, unlock, source };
  if (pixels) Object.assign(out, { slot, anchor, follows, pivot, palette: { ...palette }, pixels: [...pixels] });
  if (sprites) Object.assign(out, { motion, count, speed, sprites: sprites.map(s => ({ palette: { ...s.palette }, pixels: [...s.pixels] })) });
  if (item.lines) Object.assign(out, { lang: item.lang, fallback: item.fallback, sample: voiceSample(item), occasions: Object.keys(item.lines).length });
  return out;
}

// A taste of a voice for its Wardrobe tile: a few of its everyday lines.
const SAMPLE_FROM = ['working', 'success', 'idle', 'error', 'petted'];
function voiceSample(v, n = 3) {
  const order = [...SAMPLE_FROM.filter(o => v.lines[o]), ...Object.keys(v.lines).filter(o => !SAMPLE_FROM.includes(o))];
  return order.map(o => v.lines[o][0]).slice(0, n);
}

module.exports = { Wardrobe, SLOTS, EMPTY_OUTFIT, windowStart, windowEnd, windowKey, publicItem };
