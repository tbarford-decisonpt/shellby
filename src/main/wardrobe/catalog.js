// Wardrobe packs: JSON files that add accessories (hats, glasses, held items…),
// ambient effects (falling snow, orbiting bats…), skins, dialogue: voices
// (a new way of talking) and scenes (see dialogue.js), and decor for his tank. The built-in pack
// ships in src/wardrobe; community packs live in %APPDATA%/Shellby/wardrobe.
//
// Packs are data only. Everything is validated strictly before it reaches the
// renderer, and validation never throws: a bad item is skipped with a warning,
// a bad pack header rejects the pack. See docs/ADDONS.md for the format.
const fs = require('fs');
const path = require('path');
const { validate: validateSkin } = require('../skins');
const { voiceContent, sceneContent } = require('./dialogue');

const FORMAT = 1;
const MAX_FILE_BYTES = 512 * 1024;
const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const HEX = /^#[0-9a-f]{6}$/i;

const SLOTS = ['hat', 'face', 'neck', 'held', 'shell'];
const ANCHORS = ['head', 'face', 'neck', 'claw', 'shellTop'];
const FOLLOWS = ['stalks', 'body', 'claw', 'shell', 'eyes', 'legs'];
const MOTIONS = ['fall', 'rise', 'float', 'orbit', 'twinkle', 'burst'];
const RARITIES = ['common', 'rare', 'epic', 'legendary'];

const SLOT_ANCHOR = { hat: 'head', face: 'face', neck: 'neck', held: 'claw', shell: 'shellTop' };
const SLOT_FOLLOWS = { hat: 'stalks', face: 'stalks', neck: 'body', held: 'claw', shell: 'shell' };

// Where each anchor sits on the classic 22×13 crab (x = column, y = row, 0-based).
// Skins with a different shape can override any of these via "anchors".
const DEFAULT_ANCHORS = Object.freeze({
  head: Object.freeze([15, -1]),    // just above the gap between the eyes
  face: Object.freeze([15, 0]),     // between the eyes, on the eye row
  neck: Object.freeze([15, 4]),     // where the stalks meet the body
  claw: Object.freeze([21, 6]),     // tip of the claw pinch
  shellTop: Object.freeze([7, 0]),  // top of the shell
});

// Decor for his tank (src/main/tank.js). Pieces stand on the floor, against the
// back glass, or float in the water; substrates and backdrops are tiles the
// tank repeats. Spots are where he can do something with a piece.
const DECOR_CATEGORIES = ['structure', 'plant', 'rock', 'treasure', 'bubbler', 'substrate', 'backdrop'];
const DECOR_LAYERS = ['floor', 'back', 'float'];
const STYLE_CATEGORIES = ['substrate', 'backdrop'];
const SPOT_KINDS = ['hide', 'sit', 'climb', 'sleep', 'nibble', 'open', 'peek'];

const LIMITS = Object.freeze({
  accessories: 200, effects: 50, skins: 50, voices: 20, scenes: 60, decor: 100,
  itemGrid: 16, spriteGrid: 8, paletteMax: 16, spritesMax: 6,
  decorGrid: 32, framesMax: 3, spotsMax: 4,
});

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && (min === 0 || v.trim().length > 0);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const q = v => JSON.stringify(v);

// ---- item field validators: each returns an error string or null

function checkPalette(p) {
  if (!isObj(p)) return 'palette must be an object';
  const keys = Object.keys(p);
  if (keys.length < 1 || keys.length > LIMITS.paletteMax) return `palette needs 1–${LIMITS.paletteMax} entries`;
  for (const k of keys) {
    if (k.length !== 1 || k === '.') return `bad palette key ${q(k)}`;
    if (typeof p[k] !== 'string' || !HEX.test(p[k])) return `bad palette colour for ${q(k)}`;
  }
  return null;
}

function copyPalette(p) {
  const out = Object.create(null); // no prototype: keys can never reach Object.prototype
  for (const k of Object.keys(p)) out[k] = p[k];
  return out;
}

function checkPixels(rows, max) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > max) return `pixels must be 1–${max} rows`;
  if (rows.some(r => typeof r !== 'string')) return 'pixels rows must be strings';
  if (rows.some(r => r.length > max)) return `pixels rows must be at most ${max} characters`;
  return null;
}

// Returns [normalizedUnlock, error]. Missing → {default:true}.
function checkUnlock(u, known) {
  if (u === undefined) return [{ default: true }, null];
  if (!isObj(u)) return [null, 'unlock must be an object'];
  const keys = Object.keys(u);
  if (keys.length !== 1) return [null, 'unlock must have exactly one of default, achievement, season'];
  if (hasOwn(u, 'default')) return u.default === true ? [{ default: true }, null] : [null, 'unlock.default must be true'];
  if (hasOwn(u, 'achievement')) {
    if (typeof u.achievement !== 'string' || !known.achievements.has(u.achievement)) return [null, `unknown achievement ${q(u.achievement)}`];
    return [{ achievement: u.achievement }, null];
  }
  if (hasOwn(u, 'season')) {
    if (typeof u.season !== 'string' || !known.seasons.has(u.season)) return [null, `unknown season ${q(u.season)}`];
    return [{ season: u.season }, null];
  }
  return [null, `unknown unlock type ${q(keys[0])}`];
}

// Fields shared by accessories and effects. Returns [fields, error].
function commonFields(raw) {
  if (!isStr(raw.name, 1, 40)) return [null, 'name must be 1–40 characters'];
  if (raw.description !== undefined && !isStr(raw.description, 0, 160)) return [null, 'description must be at most 160 characters'];
  if (raw.rarity !== undefined && !RARITIES.includes(raw.rarity)) return [null, `bad rarity ${q(raw.rarity)}`];
  return [{ name: raw.name, description: raw.description || '', rarity: raw.rarity || 'common' }, null];
}

function validateAccessory(raw, known) {
  const [base, err] = commonFields(raw);
  if (err) return { error: err };
  if (!SLOTS.includes(raw.slot)) return { error: `bad slot ${q(raw.slot)}` };
  if (raw.anchor !== undefined && !ANCHORS.includes(raw.anchor)) return { error: `bad anchor ${q(raw.anchor)}` };
  if (raw.follows !== undefined && !FOLLOWS.includes(raw.follows)) return { error: `bad follows ${q(raw.follows)}` };
  const pv = raw.pivot;
  if (!Array.isArray(pv) || pv.length !== 2 || !pv.every(n => isInt(n, -16, 32))) return { error: 'pivot must be [x, y] integers in -16..32' };
  const e = checkPalette(raw.palette) || checkPixels(raw.pixels, LIMITS.itemGrid);
  if (e) return { error: e };
  const [unlock, ue] = checkUnlock(raw.unlock, known);
  if (ue) return { error: ue };
  return {
    item: {
      ...base,
      slot: raw.slot,
      anchor: raw.anchor || SLOT_ANCHOR[raw.slot],
      follows: raw.follows || SLOT_FOLLOWS[raw.slot],
      pivot: [pv[0], pv[1]],
      palette: copyPalette(raw.palette),
      pixels: [...raw.pixels],
      unlock,
    },
  };
}

function validateEffect(raw, known) {
  const [base, err] = commonFields(raw);
  if (err) return { error: err };
  if (!MOTIONS.includes(raw.motion)) return { error: `bad motion ${q(raw.motion)}` };
  if (raw.count !== undefined && !isInt(raw.count, 1, 24)) return { error: 'count must be an integer 1–24' };
  if (raw.speed !== undefined && !(typeof raw.speed === 'number' && raw.speed >= 0.25 && raw.speed <= 3)) return { error: 'speed must be 0.25–3' };
  if (raw.ink !== undefined && typeof raw.ink !== 'boolean') return { error: 'ink must be true or false' };
  if (!Array.isArray(raw.sprites) || raw.sprites.length < 1 || raw.sprites.length > LIMITS.spritesMax) return { error: `sprites must be 1–${LIMITS.spritesMax} entries` };
  const sprites = [];
  for (const [i, s] of raw.sprites.entries()) {
    if (!isObj(s)) return { error: `sprite ${i} must be an object` };
    const e = checkPalette(s.palette) || checkPixels(s.pixels, LIMITS.spriteGrid) || checkFrames(s.frames, s.pixels, LIMITS.spriteGrid);
    if (e) return { error: `sprite ${i}: ${e}` };
    sprites.push({ palette: copyPalette(s.palette), pixels: [...s.pixels], ...(s.frames ? { frames: s.frames.map(f => [...f]) } : {}) });
  }
  const animated = sprites.some(s => s.frames);
  if (raw.fps !== undefined && (!animated || !isInt(raw.fps, 1, 12))) return { error: 'fps must be an integer 1–12, with frames' };
  const [unlock, ue] = checkUnlock(raw.unlock, known);
  if (ue) return { error: ue };
  return {
    item: {
      ...base, motion: raw.motion, count: raw.count ?? 10, speed: raw.speed ?? 1, ink: raw.ink === true,
      fps: animated ? raw.fps ?? 4 : 0, sprites, unlock,
    },
  };
}

// A picture's extra frames: 1–framesMax more, each the same size as `pixels`.
function checkFrames(frames, pixels, max) {
  if (frames === undefined) return null;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > LIMITS.framesMax) return `frames must be 1–${LIMITS.framesMax} pictures`;
  const w = Math.max(...pixels.map(r => r.length));
  for (const [i, f] of frames.entries()) {
    const fe = checkPixels(f, max);
    if (fe) return `frame ${i}: ${fe}`;
    if (f.length !== pixels.length || Math.max(...f.map(r => r.length)) > w) return `frame ${i} must be the same size as pixels`;
  }
  return null;
}

function validatePackSkin(raw, known) {
  const { skin, errors } = validateSkin(raw, undefined);
  if (!skin) return { error: errors.join('; ') };
  if (raw.anchors !== undefined && !isObj(raw.anchors)) return { error: 'anchors must be an object' };
  const anchors = {};
  for (const name of ANCHORS) anchors[name] = [...DEFAULT_ANCHORS[name]];
  for (const k of Object.keys(raw.anchors || {})) {
    const v = raw.anchors[k];
    if (!ANCHORS.includes(k)) return { error: `unknown anchor ${q(k)}` };
    if (!Array.isArray(v) || v.length !== 2 || !v.every(n => isInt(n, -16, 48))) return { error: `anchor ${k} must be [x, y] integers in -16..48` };
    anchors[k] = [v[0], v[1]];
  }
  const [unlock, ue] = checkUnlock(raw.unlock, known);
  if (ue) return { error: ue };
  return { item: { ...skin, unlock, anchors } };
}

function validateVoice(raw, known) {
  const [base, err] = commonFields(raw);
  if (err) return { error: err };
  const { content, warnings, error } = voiceContent(raw);
  if (error) return { error };
  const [unlock, ue] = checkUnlock(raw.unlock, known);
  if (ue) return { error: ue };
  return { item: { ...base, ...content, unlock }, warnings };
}

// A piece of tank decor. Frames are extra pictures of the same size, played in
// a loop at `fps` (a bubbler's bubbles, a swaying plant).
function validateDecor(raw, known) {
  const [base, err] = commonFields(raw);
  if (err) return { error: err };
  if (!DECOR_CATEGORIES.includes(raw.category)) return { error: `bad category ${q(raw.category)}` };
  const style = STYLE_CATEGORIES.includes(raw.category);
  if (raw.layer !== undefined && (style || !DECOR_LAYERS.includes(raw.layer))) return { error: style ? 'substrates and backdrops have no layer' : `bad layer ${q(raw.layer)}` };
  const e = checkPalette(raw.palette) || checkPixels(raw.pixels, LIMITS.decorGrid);
  if (e) return { error: e };
  const w = Math.max(...raw.pixels.map(r => r.length));
  if (w < 1) return { error: 'pixels must not be empty' };
  const frames = [];
  if (raw.frames !== undefined) {
    if (style || !Array.isArray(raw.frames) || raw.frames.length < 1 || raw.frames.length > LIMITS.framesMax) return { error: style ? 'substrates and backdrops have no frames' : `frames must be 1–${LIMITS.framesMax} pictures` };
    for (const [i, f] of raw.frames.entries()) {
      const fe = checkPixels(f, LIMITS.decorGrid);
      if (fe) return { error: `frame ${i}: ${fe}` };
      if (f.length !== raw.pixels.length || Math.max(...f.map(r => r.length)) > w) return { error: `frame ${i} must be the same size as pixels` };
      frames.push([...f]);
    }
  }
  if (raw.fps !== undefined && (!frames.length || !isInt(raw.fps, 1, 8))) return { error: 'fps must be an integer 1–8, with frames' };
  const spots = [];
  if (raw.spots !== undefined) {
    if (style || !Array.isArray(raw.spots) || raw.spots.length > LIMITS.spotsMax) return { error: style ? 'substrates and backdrops have no spots' : `spots must be at most ${LIMITS.spotsMax}` };
    for (const [i, s] of raw.spots.entries()) {
      if (!isObj(s) || !SPOT_KINDS.includes(s.kind)) return { error: `spot ${i}: bad kind ${q(s?.kind)}` };
      const at = s.at;
      if (!Array.isArray(at) || at.length !== 2 || !isInt(at[0], 0, w - 1) || !isInt(at[1], -LIMITS.decorGrid, raw.pixels.length - 1)) return { error: `spot ${i}: at must be [x, y] inside the piece` };
      spots.push({ kind: s.kind, at: [at[0], at[1]] });
    }
  }
  const [unlock, ue] = checkUnlock(raw.unlock, known);
  if (ue) return { error: ue };
  return {
    item: {
      ...base,
      category: raw.category,
      layer: style ? null : raw.layer || 'floor',
      palette: copyPalette(raw.palette),
      pixels: [...raw.pixels],
      frames, fps: frames.length ? raw.fps ?? 2 : 0, spots,
      unlock,
    },
  };
}

// Scenes are checked after voices, so one can name a voice from its own pack.
function validateScene(raw, known, pack) {
  const [base, err] = commonFields(raw);
  if (err) return { error: err };
  const { content, error } = sceneContent(raw, { seasons: known.seasons, voiceIds: pack.voices.map(v => v.id) });
  if (error) return { error };
  return { item: { name: base.name, description: base.description, ...content } };
}

// Voices come before scenes: see validateScene.
const KINDS = [
  ['accessories', 'accessory', validateAccessory],
  ['effects', 'effect', validateEffect],
  ['skins', 'skin', validatePackSkin],
  ['voices', 'voice', validateVoice],
  ['scenes', 'scene', validateScene],
  ['decor', 'decor', validateDecor],
];

/**
 * Validate and normalize one pack. Never throws.
 * @returns {{ pack: object|null, errors: string[], warnings: string[] }}
 */
function validatePack(json, { source = 'user', knownAchievements = new Set(), knownSeasons = new Set() } = {}) {
  const errors = [];
  const warnings = [];
  const known = { achievements: knownAchievements, seasons: knownSeasons };
  if (!isObj(json)) return { pack: null, errors: ['pack is not an object'], warnings };

  if (json.format !== FORMAT) errors.push(`unsupported format ${q(json.format)} (expected ${FORMAT})`);
  if (typeof json.id !== 'string' || !PACK_ID_RE.test(json.id)) errors.push(`bad pack id ${q(json.id)}`);
  if (!isStr(json.name, 1, 60)) errors.push('name must be 1–60 characters');
  if (!isStr(json.author, 1, 60)) errors.push('author must be 1–60 characters');
  if (typeof json.version !== 'string' || !VERSION_RE.test(json.version)) errors.push(`bad version ${q(json.version)} (use 1.2.3)`);
  if (errors.length) return { pack: null, errors, warnings };

  // Optional metadata: a bad value is dropped with a warning, the pack survives.
  let description = '';
  if (json.description !== undefined) {
    if (isStr(json.description, 0, 240)) description = json.description;
    else warnings.push('ignored description: must be at most 240 characters');
  }
  let homepage = '';
  if (json.homepage !== undefined) {
    if (isHttpsUrl(json.homepage)) homepage = json.homepage;
    else warnings.push('ignored homepage: must be an https:// URL of at most 200 characters');
  }

  const pack = {
    id: json.id, name: json.name, author: json.author, version: json.version,
    description, homepage, source,
    accessories: [], effects: [], skins: [], voices: [], scenes: [], decor: [],
  };
  const keyOf = id => (source === 'builtin' ? id : `${pack.id}/${id}`);

  for (const [field, label, check] of KINDS) {
    let list = json[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { warnings.push(`ignored ${field}: must be an array`); continue; }
    if (list.length > LIMITS[field]) {
      warnings.push(`only the first ${LIMITS[field]} ${field} were loaded`);
      list = list.slice(0, LIMITS[field]);
    }
    const seen = new Set();
    list.forEach((raw, i) => {
      const id = isObj(raw) ? raw.id : undefined;
      const name = typeof id === 'string' ? id : `#${i}`;
      if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) { warnings.push(`skipped ${label} ${name}: bad id`); return; }
      const { item, error, warnings: itemWarnings = [] } = check(raw, known, pack);
      if (error) { warnings.push(`skipped ${label} ${id}: ${error}`); return; }
      if (seen.has(id)) { warnings.push(`skipped ${label} ${id}: duplicate id (kept the first)`); return; }
      seen.add(id);
      warnings.push(...itemWarnings.map(w => `${label} ${id}: ${w}`));
      const key = keyOf(id);
      const extra = label === 'skin' ? { id: key } : { id };
      if (label === 'scene') extra.voice = item.voice ? keyOf(item.voice) : null;
      pack[field].push({ ...item, ...extra, key, packId: pack.id, source });
    });
  }
  return { pack, errors: [], warnings: capWarnings(warnings) };
}

// Enough to fix a pack by, without a junk one filling the Wardrobe.
const MAX_WARNINGS = 50;
const capWarnings = w => (w.length > MAX_WARNINGS ? [...w.slice(0, MAX_WARNINGS), `…and ${w.length - MAX_WARNINGS} more`] : w);

function isHttpsUrl(v) {
  if (typeof v !== 'string' || v.length > 200 || !/^https:\/\/\S+$/.test(v)) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

// Read + parse a pack file with a size cap. Returns { json } or { error }.
function readPackFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: 'not a file' };
    if (st.size > MAX_FILE_BYTES) return { error: `file is larger than ${MAX_FILE_BYTES / 1024} KB` };
    return { json: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'file not found' : `invalid JSON: ${e.message}` };
  }
}

function listJson(dir) {
  if (!dir) return [];
  try { return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort(); } catch { return []; }
}

/**
 * Load the built-in pack(s) then every user pack. Missing dirs are fine.
 */
function loadCatalog({ builtinDir, userDir, knownAchievements = new Set(), knownSeasons = new Set() } = {}) {
  const accessories = new Map();
  const effects = new Map();
  const voices = new Map();
  const scenes = new Map();
  const decor = new Map();
  const skinKeys = new Set();
  const skins = [];
  const packs = [];
  const errors = [];
  const builtinIds = new Set();
  const userIds = new Map(); // id -> file that claimed it

  for (const [dir, source] of [[builtinDir, 'builtin'], [userDir, 'user']]) {
    for (const f of listJson(dir)) {
      const file = path.join(dir, f);
      const { json, error } = readPackFile(file);
      if (error) { errors.push(`${f}: ${error}`); continue; }
      const { pack, errors: errs, warnings } = validatePack(json, { source, knownAchievements, knownSeasons });
      if (!pack) { errors.push(`${f}: ${errs.join('; ')}`); continue; }
      if (builtinIds.has(pack.id)) { errors.push(`${f}: id reserved (${pack.id})`); continue; }
      if (source === 'user' && userIds.has(pack.id)) {
        errors.push(`${f}: duplicate pack id ${pack.id} (kept ${userIds.get(pack.id)})`);
        continue;
      }
      (source === 'builtin' ? builtinIds.add(pack.id) : userIds.set(pack.id, f));

      const packWarnings = [...warnings];
      const add = (map, item, label) => {
        if (map.has(item.key)) packWarnings.push(`skipped ${label} ${item.id}: key ${item.key} already taken`);
        else map.set(item.key, item);
      };
      for (const a of pack.accessories) add(accessories, a, 'accessory');
      for (const x of pack.effects) add(effects, x, 'effect');
      for (const s of pack.skins) {
        if (skinKeys.has(s.key)) packWarnings.push(`skipped skin ${s.id}: key ${s.key} already taken`);
        else { skinKeys.add(s.key); skins.push(s); }
      }
      // A voice shares unlocks and "new" badges with the other items, so its key has to be theirs too.
      for (const v of pack.voices) {
        if (accessories.has(v.key) || effects.has(v.key) || skinKeys.has(v.key)) packWarnings.push(`skipped voice ${v.id}: key ${v.key} already taken`);
        else add(voices, v, 'voice');
      }
      for (const sc of pack.scenes) add(scenes, sc, 'scene');
      // Decor shares unlocks and "new" badges with the wardrobe's items too.
      for (const x of pack.decor) {
        if (accessories.has(x.key) || effects.has(x.key) || voices.has(x.key) || skinKeys.has(x.key)) packWarnings.push(`skipped decor ${x.id}: key ${x.key} already taken`);
        else add(decor, x, 'decor');
      }
      packs.push({
        id: pack.id, name: pack.name, author: pack.author, version: pack.version,
        description: pack.description, homepage: pack.homepage, source, file,
        counts: { accessories: pack.accessories.length, effects: pack.effects.length, skins: pack.skins.length, voices: pack.voices.length, scenes: pack.scenes.length, decor: pack.decor.length },
        warnings: packWarnings,
      });
    }
  }
  return { accessories, effects, skins, voices, scenes, decor, packs, errors };
}

// Resolve `${userDir}/${id}.json`, refusing anything that would land outside userDir.
function packPath(userDir, packId) {
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) return null;
  const root = path.resolve(userDir);
  const dest = path.resolve(root, `${packId}.json`);
  const rel = path.relative(root, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  return dest;
}

/**
 * Validate a pack file and copy it into userDir as <id>.json.
 * opts: { knownAchievements, knownSeasons, reservedIds? } — reservedIds (e.g. the
 * built-in pack ids) are refused so an install can't be shadowed on next load.
 */
function installPack(srcPath, userDir, opts = {}) {
  const { json, error } = readPackFile(srcPath);
  if (error) return { ok: false, errors: [error], warnings: [] };
  const { pack, errors, warnings } = validatePack(json, { ...opts, source: 'user' });
  if (!pack) return { ok: false, errors, warnings };
  if (opts.reservedIds && opts.reservedIds.has(pack.id)) return { ok: false, errors: [`id reserved (${pack.id})`], warnings };
  const dest = packPath(userDir, pack.id);
  if (!dest) return { ok: false, errors: ['refusing to write outside the wardrobe folder'], warnings };
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
    fs.renameSync(tmp, dest);
  } catch (e) {
    return { ok: false, errors: [`could not save pack: ${e.message}`], warnings };
  }
  return { ok: true, pack, errors: [], warnings, dest };
}

// A removed pack waits a week in a folder beside the wardrobe's
// (userData/wardrobe-trash), so Undo can bring it back. Not inside the
// wardrobe folder, which you can open and which is read as packs.
const TRASH_DAYS = 7;
const trashDir = userDir => `${path.resolve(userDir)}-trash`;

/** Throw out what's been in the trash longer than TRASH_DAYS. Never throws. */
function emptyTrash(userDir, now = Date.now()) {
  const dir = trashDir(userDir);
  for (const f of listJson(dir)) {
    const file = path.join(dir, f);
    try { if (now - fs.statSync(file).mtimeMs > TRASH_DAYS * 864e5) fs.unlinkSync(file); } catch { /* next time */ }
  }
}

/**
 * Take `${userDir}/${packId}.json` out of the wardrobe, into the trash for a
 * week (one copy a pack id: the newest). Returns true if a file was moved.
 */
function removePack(packId, userDir, now = Date.now()) {
  const file = packPath(userDir, packId);
  if (!file) return false;
  emptyTrash(userDir, now);
  const dest = packPath(trashDir(userDir), packId);
  try {
    if (!fs.existsSync(file)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    fs.utimesSync(dest, new Date(now), new Date(now)); // its week starts now, not when it was installed
    return true;
  } catch { return false; }
}

/**
 * Bring a removed pack back from the trash. Refused (false) if it's gone, or
 * a pack with its id has been installed since, which stays.
 */
function restorePack(packId, userDir) {
  const file = packPath(userDir, packId);
  const from = file && packPath(trashDir(userDir), packId);
  if (!from) return false;
  try {
    if (fs.existsSync(file) || !fs.existsSync(from)) return false;
    fs.renameSync(from, file);
    return true;
  } catch { return false; }
}

module.exports = {
  validatePack, loadCatalog, installPack, removePack, restorePack, emptyTrash, TRASH_DAYS,
  FORMAT, MAX_FILE_BYTES, PACK_ID_RE, ITEM_ID_RE, VERSION_RE,
  SLOTS, ANCHORS, FOLLOWS, MOTIONS, RARITIES, SLOT_ANCHOR, SLOT_FOLLOWS, DEFAULT_ANCHORS, LIMITS,
  DECOR_CATEGORIES, DECOR_LAYERS, STYLE_CATEGORIES, SPOT_KINDS,
};
