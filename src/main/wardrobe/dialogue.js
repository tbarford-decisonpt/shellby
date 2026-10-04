// Dialogue in wardrobe packs: voices (a whole new way of talking: a pirate, a
// grump, another language) and scenes (little stories told in beats, like the
// ones in src/main/scenes.js).
//
// Still data only. A line is short plain text, shown with textContent. A scene
// can only name animations, props and things to hold that Shellby already
// draws. Neither can run anything, load anything or reach outside his bubble.
// catalog.js handles each item's name, rarity and unlock; this file checks
// what it says and does. Never throws. See docs/ADDONS.md.
const { OCCASIONS: VOICE_OCCASIONS, TEMPERAMENTS, MAX_LINE } = require('../voice');
const { SCENE_BITS, PROPS, HOLDS, WEARS } = require('../scenes');
const { LEVELS } = require('../bond');

const OCCASIONS = Object.freeze(Object.keys(VOICE_OCCASIONS));
// What a voice does on occasions it has no lines for: fall back to Shellby's
// own lines, or say nothing (right for another language).
const FALLBACKS = Object.freeze(['shellby', 'quiet']);
// Scene conditions that are simply on (scenes.js `fits`). bond and season take a value.
const WHEN_FLAGS = Object.freeze(['night', 'day', 'weekend', 'friday', 'monday', 'music', 'cursor', 'find']);
const WHEN_KEYS = Object.freeze([...WHEN_FLAGS, 'bond', 'season']);
const SAY_KEYS = Object.freeze(['any', ...TEMPERAMENTS]);
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
// Control characters and bidi overrides have no business in a speech bubble.
// (Zero-width joiners stay: emoji sequences and some scripts need them.)
const CONTROL_RE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

const LIMITS = Object.freeze({
  linesPerOccasion: 20, sayChoices: 6, beats: 8,
  beatMinMs: 500, beatMaxMs: 5000, sceneMaxMs: 12000, // test/scenes.test.js holds the built-ins to the same
});

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// Quote a value in a warning, cut short: a junk pack shouldn't fill the log.
const q = v => JSON.stringify(typeof v === 'string' && v.length > 32 ? `${v.slice(0, 32)}…` : v);
// Characters as people count them (an emoji is one), like the schema's maxLength.
const lengthOf = s => [...s].length;

/** Why a line can't go in his bubble, or null if it can. */
function lineProblem(v) {
  if (typeof v !== 'string' || !v.trim()) return 'must be text';
  if (lengthOf(v) > MAX_LINE) return `${q(v)} is longer than ${MAX_LINE} characters`;
  if (CONTROL_RE.test(v)) return `${q(v)} has a control character`;
  return null;
}

// A list of lines, keeping the good ones. Duplicates are dropped quietly.
function lineList(list, where, warnings) {
  if (!Array.isArray(list)) { warnings.push(`ignored ${where}: must be a list of lines`); return []; }
  if (list.length > LIMITS.linesPerOccasion) warnings.push(`only the first ${LIMITS.linesPerOccasion} lines of ${where} were loaded`);
  const out = [];
  for (const line of list.slice(0, LIMITS.linesPerOccasion)) {
    const bad = lineProblem(line);
    if (bad) warnings.push(`ignored a line in ${where}: ${bad}`);
    else if (!out.includes(line)) out.push(line);
  }
  return out;
}

// { occasion: [lines] } with unknown occasions and empty lists left out.
function occasionLines(obj, where, warnings) {
  const out = Object.create(null); // no prototype: keys can never reach Object.prototype
  if (!isObj(obj)) { warnings.push(`ignored ${where}: must be an object`); return out; }
  for (const k of Object.keys(obj)) {
    if (!OCCASIONS.includes(k)) { warnings.push(`ignored ${where} ${q(k)}: unknown occasion`); continue; }
    const lines = lineList(obj[k], `${where}.${k}`, warnings);
    if (lines.length) out[k] = lines;
  }
  return out;
}

/**
 * What a voice says. Returns { content: { lines, flavor, fallback, lang }, warnings } or { error }.
 * A bad line or occasion is dropped with a warning. A voice with nothing left to say is an error.
 */
function voiceContent(raw) {
  const warnings = [];
  if (raw.fallback !== undefined && !FALLBACKS.includes(raw.fallback)) return { error: `fallback must be ${FALLBACKS.join(' or ')}` };
  const lines = occasionLines(raw.lines, 'lines', warnings);
  if (!Object.keys(lines).length) return { error: 'lines needs at least one occasion with a line' };
  const flavor = Object.create(null);
  if (raw.flavor !== undefined) {
    if (!isObj(raw.flavor)) warnings.push('ignored flavor: must be an object');
    else {
      for (const t of Object.keys(raw.flavor)) {
        if (!TEMPERAMENTS.includes(t)) { warnings.push(`ignored flavor ${q(t)}: unknown temperament`); continue; }
        const extra = occasionLines(raw.flavor[t], `flavor.${t}`, warnings);
        if (Object.keys(extra).length) flavor[t] = extra;
      }
    }
  }
  let lang = '';
  if (raw.lang !== undefined) {
    if (typeof raw.lang === 'string' && LANG_RE.test(raw.lang)) lang = raw.lang;
    else warnings.push(`ignored lang ${q(raw.lang)}: use a language tag like "es" or "pt-BR"`);
  }
  return { content: { lines, flavor, fallback: raw.fallback || 'shellby', lang }, warnings };
}

// A beat's `say`: a line, a list to pick from, or { any, <temperament>: ... }.
function checkSay(say) {
  const one = v => {
    if (Array.isArray(v)) {
      if (v.length < 1 || v.length > LIMITS.sayChoices) return `a list of lines needs 1–${LIMITS.sayChoices} entries`;
      return v.map(lineProblem).find(Boolean) || null;
    }
    return lineProblem(v);
  };
  if (!isObj(say)) return one(say);
  const keys = Object.keys(say);
  if (!keys.length) return 'say needs at least one line';
  const unknown = keys.find(k => !SAY_KEYS.includes(k));
  if (unknown) return `say has unknown key ${q(unknown)} (use any, ${TEMPERAMENTS.join(', ')})`;
  return keys.map(k => one(say[k])).find(Boolean) || null;
}

const copySay = say => (Array.isArray(say) ? [...say] : isObj(say) ? Object.fromEntries(Object.keys(say).map(k => [k, copySay(say[k])])) : say);

function checkBeat(b, i) {
  if (!isObj(b)) return [null, `beat ${i} must be an object`];
  if (!SCENE_BITS.includes(b.bit)) return [null, `beat ${i}: unknown bit ${q(b.bit)}`];
  if (!Number.isInteger(b.ms) || b.ms < LIMITS.beatMinMs || b.ms > LIMITS.beatMaxMs) return [null, `beat ${i}: ms must be a whole number ${LIMITS.beatMinMs}–${LIMITS.beatMaxMs}`];
  if (b.prop !== undefined && !PROPS.includes(b.prop)) return [null, `beat ${i}: unknown prop ${q(b.prop)}`];
  if (b.hold !== undefined && !HOLDS.includes(b.hold)) return [null, `beat ${i}: unknown hold ${q(b.hold)}`];
  if (b.wear !== undefined && !WEARS.includes(b.wear)) return [null, `beat ${i}: unknown wear ${q(b.wear)}`];
  if (b.say !== undefined) {
    const bad = checkSay(b.say);
    if (bad) return [null, `beat ${i}: ${bad}`];
  }
  const beat = { bit: b.bit, ms: b.ms };
  for (const k of ['prop', 'hold', 'wear']) if (b[k] !== undefined) beat[k] = b[k];
  if (b.say !== undefined) beat.say = copySay(b.say);
  return [beat, null];
}

function checkWhen(w, seasons) {
  if (w === undefined) return [{}, null];
  if (!isObj(w)) return [null, 'when must be an object'];
  const out = {};
  for (const k of Object.keys(w)) {
    if (!WHEN_KEYS.includes(k)) return [null, `unknown condition when.${k}`];
    if (WHEN_FLAGS.includes(k)) {
      if (w[k] !== true) return [null, `when.${k} must be true`];
      out[k] = true;
    } else if (k === 'bond') {
      if (!Number.isInteger(w.bond) || w.bond < 1 || w.bond >= LEVELS.length) return [null, `when.bond must be a whole number 1–${LEVELS.length - 1}`];
      out.bond = w.bond;
    } else {
      if (typeof w.season !== 'string' || !seasons.has(w.season)) return [null, `unknown season ${q(w.season)}`];
      out.season = w.season;
    }
  }
  if (out.night && out.day) return [null, 'when.night and when.day can never both hold'];
  return [out, null];
}

/**
 * A scene's beats and when it plays. voiceIds: the voices this pack defines, so
 * a scene can belong to one ("voice": "pirate") and only play while it's worn.
 * Returns { content: { who, when, voice, beats } } or { error }.
 */
function sceneContent(raw, { seasons = new Set(), voiceIds = [] } = {}) {
  let who = [];
  if (raw.who !== undefined) {
    if (!Array.isArray(raw.who) || raw.who.some(t => !TEMPERAMENTS.includes(t))) return { error: `who must list temperaments (${TEMPERAMENTS.join(', ')})` };
    who = [...new Set(raw.who)];
  }
  const [when, we] = checkWhen(raw.when, seasons);
  if (we) return { error: we };
  let voice = null;
  if (raw.voice !== undefined) {
    if (typeof raw.voice !== 'string' || !voiceIds.includes(raw.voice)) return { error: `voice ${q(raw.voice)} isn't a voice in this pack` };
    voice = raw.voice;
  }
  if (!Array.isArray(raw.beats) || raw.beats.length < 1 || raw.beats.length > LIMITS.beats) return { error: `beats must be 1–${LIMITS.beats} entries` };
  const beats = [];
  for (const [i, b] of raw.beats.entries()) {
    const [beat, err] = checkBeat(b, i);
    if (err) return { error: err };
    beats.push(beat);
  }
  const ms = beats.reduce((n, b) => n + b.ms, 0);
  if (ms > LIMITS.sceneMaxMs) return { error: `beats add up to ${ms} ms; a scene can be at most ${LIMITS.sceneMaxMs}` };
  return { content: { who, when, voice, beats } };
}

module.exports = {
  voiceContent, sceneContent, lineProblem,
  OCCASIONS, FALLBACKS, WHEN_FLAGS, WHEN_KEYS, SAY_KEYS, LANG_RE, LIMITS,
};
