// Little scenes: a few beats strung together instead of a single habit. He
// squints at your cursor, creeps up on it, pounces, misses, and says he meant
// to. He builds a sandcastle and watches it crumble. He gets the hiccups.
//
// A scene is a list of beats; each beat is one animation (a `bit`, drawn by a
// body class in critter.css), maybe a prop beside him, maybe something in his
// claw or on his face, and maybe a line. Lines can differ by temperament.
// Pure: picking and resolving take `rand`; src/main/life.js plays them.
// See test/scenes.test.js.

const MAX_LINE = 24; // voice.js MAX_LINE

// Props the renderer knows how to draw (src/renderer/critter/life.js).
const PROPS = Object.freeze(['castle', 'castle-fall', 'bubbles', 'fly', 'shooting-star', 'juggle', 'heart', 'achoo', 'zz', 'notes', 'sweat']);
// Things he can hold or wear for a scene. 'find' is his favourite find (gifts.js).
const HOLDS = Object.freeze(['find', 'coffee', 'pebble', 'mic']);
const WEARS = Object.freeze(['shades']);
// Animations the scenes use, beyond his everyday habits (voice.js BITS).
const SCENE_BITS = Object.freeze([
  'dig', 'polish', 'peek', 'stretch', 'flop', 'squint', 'creep', 'pounce', 'nose', 'sneeze', 'sniff', 'hic', 'hold',
  'blow', 'nod', 'jolt', 'curl', 'admire', 'rock', 'bow', 'swat', 'jab', 'gaze', 'juggle', 'bonk', 'present', 'lean',
  'sip', 'boogie', 'hide', 'boo', 'shiver', 'wave', 'count',
]);

const T = ['chipper', 'fussy', 'cocky', 'sleepy'];

/*
 * who:   temperaments it suits (they're three times likelier to get it); all can.
 * when:  conditions, all of which must hold:
 *   night / day / weekend / friday / monday, music (something's playing),
 *   bond (at least this level, bond.js), find (has a favourite find),
 *   cursor (the pointer is near him), season ('halloween' ...)
 * beats: { bit, ms, say?, prop?, hold?, wear? } — `say` is a line, a list to
 *   pick from, or { any, <temperament>: ... }.
 */
const SCENES = Object.freeze([
  {
    id: 'pounce', name: 'Pounces on your cursor', who: ['chipper', 'cocky'], when: { cursor: true },
    beats: [
      { bit: 'squint', ms: 1400, say: '…' },
      { bit: 'creep', ms: 1600 },
      { bit: 'pounce', ms: 650, say: { any: 'GOT IT', sleepy: 'hup' } },
      { bit: 'flop', ms: 1300, say: { any: 'meant to do that', fussy: 'how undignified', sleepy: 'too fast', chipper: 'next time!' } },
    ],
  },
  {
    id: 'sneeze', name: 'Sneezes', beats: [
      { bit: 'nose', ms: 1000, say: 'a-' },
      { bit: 'nose', ms: 1000, say: 'a-a-' },
      { bit: 'sneeze', ms: 750, say: 'ACHOO!', prop: 'achoo' },
      { bit: 'sniff', ms: 1500, say: { any: "'scuse me", fussy: 'sand. everywhere.', cocky: 'bless me', sleepy: 'woke myself up' } },
    ],
  },
  {
    id: 'hiccups', name: 'Gets the hiccups', beats: [
      { bit: 'hic', ms: 900, say: 'hic!' },
      { bit: 'hic', ms: 900, say: 'hic!' },
      { bit: 'hold', ms: 2200, say: 'holding breath…' },
      { bit: 'admire', ms: 1100, say: 'gone!' },
      { bit: 'hic', ms: 900, say: '…hic!' },
    ],
  },
  {
    id: 'bubbles', name: 'Blows bubbles', who: ['chipper', 'sleepy'], beats: [
      { bit: 'blow', ms: 2800, prop: 'bubbles', say: 'blub' },
      { bit: 'gaze', ms: 1800, say: { any: 'pretty', cocky: 'best ones yet', fussy: 'one popped early' } },
    ],
  },
  {
    id: 'nodoff', name: 'Nods off', who: ['sleepy'], beats: [
      { bit: 'nod', ms: 1800, prop: 'zz', say: 'zz…' },
      { bit: 'nod', ms: 1800, prop: 'zz' },
      { bit: 'jolt', ms: 800, say: { any: "wasn't asleep!", sleepy: 'five more minutes', cocky: 'resting my eyes' } },
    ],
  },
  {
    id: 'workout', name: 'Works out', who: ['chipper', 'cocky'], when: { day: true }, beats: [
      { bit: 'curl', ms: 1300, say: 'one…' },
      { bit: 'curl', ms: 1300, say: 'two…' },
      { bit: 'curl', ms: 1500, say: '…three', prop: 'sweat' },
      { bit: 'flop', ms: 1600, say: { any: 'enough for today', cocky: 'feel the burn', chipper: 'so strong!' } },
    ],
  },
  {
    id: 'castle', name: 'Builds a sandcastle', beats: [
      { bit: 'dig', ms: 1800, say: { any: 'building…', fussy: 'precisely…' } },
      { bit: 'admire', ms: 2000, prop: 'castle', say: { any: 'masterpiece', cocky: 'nailed it', chipper: 'my castle!' } },
      { bit: 'squint', ms: 1000, prop: 'castle-fall' },
      { bit: 'flop', ms: 1500, say: { any: '…my castle', fussy: 'the foundations!', sleepy: 'oh well', cocky: 'it was a draft' } },
    ],
  },
  {
    id: 'mirror', name: 'Admires his shell', who: ['cocky', 'fussy'], beats: [
      { bit: 'polish', ms: 1800 },
      { bit: 'admire', ms: 1900, say: { any: 'looking good', fussy: 'one smudge…', sleepy: 'good enough' } },
      { bit: 'polish', ms: 1400, say: { any: 'there.', cocky: 'perfect. as usual.' } },
    ],
  },
  {
    id: 'airguitar', name: 'Plays air guitar', who: ['cocky', 'chipper'], when: { music: true }, beats: [
      { bit: 'rock', ms: 2600, prop: 'notes', say: '♪ shred ♪' },
      { bit: 'rock', ms: 1800, prop: 'notes' },
      { bit: 'bow', ms: 1100, say: { any: 'thank you!', cocky: "I'm here all week", sleepy: 'encore later' } },
    ],
  },
  {
    id: 'fly', name: 'Swats at a fly', beats: [
      { bit: 'squint', ms: 1400, prop: 'fly', say: 'bzz?' },
      { bit: 'swat', ms: 900, prop: 'fly' },
      { bit: 'swat', ms: 900, prop: 'fly', say: { any: 'get lost', chipper: 'come back!', fussy: 'shoo. SHOO.' } },
      { bit: 'squint', ms: 1300, say: '…' },
    ],
  },
  {
    id: 'counting', name: 'Counts grains of sand', who: ['fussy'], beats: [
      { bit: 'count', ms: 1700, say: '4,817…' },
      { bit: 'count', ms: 1700, say: '4,818…' },
      { bit: 'jolt', ms: 900, say: { any: 'lost count', fussy: 'start again.' } },
    ],
  },
  {
    id: 'shadowbox', name: 'Shadow-boxes', who: ['cocky'], beats: [
      { bit: 'jab', ms: 1600, say: 'float like a…' },
      { bit: 'jab', ms: 1300 },
      { bit: 'admire', ms: 1400, say: '…crab' },
    ],
  },
  {
    id: 'stargaze', name: 'Watches the stars', when: { night: true }, beats: [
      { bit: 'gaze', ms: 2600, say: { any: 'so many stars', sleepy: 'pretty… yawn' } },
      { bit: 'gaze', ms: 1600, prop: 'shooting-star', say: 'a wish!' },
      { bit: 'admire', ms: 1500, say: { any: "won't tell you", chipper: 'wished for you!' } },
    ],
  },
  {
    id: 'sunbathe', name: 'Sunbathes', when: { weekend: true, day: true }, beats: [
      { bit: 'stretch', ms: 1300, wear: 'shades' },
      { bit: 'flop', ms: 3200, wear: 'shades', say: { any: 'this is the life', fussy: 'SPF 50, obviously' } },
      { bit: 'flop', ms: 2000, wear: 'shades' },
    ],
  },
  {
    id: 'juggle', name: 'Juggles pebbles', who: ['chipper', 'cocky'], beats: [
      { bit: 'juggle', ms: 2800, prop: 'juggle', say: 'hup hup hup' },
      { bit: 'bonk', ms: 900, say: 'ow' },
      { bit: 'sniff', ms: 1200, say: { any: 'nobody saw that', chipper: 'again!' } },
    ],
  },
  {
    id: 'coffee', name: 'Needs his coffee', when: { monday: true }, beats: [
      { bit: 'sip', ms: 1700, hold: 'coffee', say: 'monday…' },
      { bit: 'sip', ms: 1700, hold: 'coffee' },
      { bit: 'stretch', ms: 1300, hold: 'coffee', say: 'better.' },
    ],
  },
  {
    id: 'friday', name: 'Friday boogie', when: { friday: true }, beats: [
      { bit: 'boogie', ms: 2600, prop: 'notes', say: 'friday!' },
      { bit: 'boogie', ms: 2000, prop: 'notes', say: { any: 'weekend soon', fussy: 'tidy desk first' } },
    ],
  },
  {
    id: 'showfind', name: 'Shows off his favourite find', when: { bond: 2, find: true }, beats: [
      { bit: 'present', ms: 2200, hold: 'find', say: { any: 'my favourite', cocky: 'my treasure', fussy: 'polished it' } },
      { bit: 'polish', ms: 1500, hold: 'find' },
      { bit: 'admire', ms: 1300, hold: 'find', say: '…mine' },
    ],
  },
  {
    id: 'heart', name: 'Draws you a heart', when: { bond: 3 }, beats: [
      { bit: 'dig', ms: 1800 },
      { bit: 'admire', ms: 2600, prop: 'heart', say: { any: 'for you', cocky: "don't make it weird", sleepy: 'for you… zz' } },
    ],
  },
  {
    id: 'snuggle', name: 'Leans on your cursor', when: { bond: 4, cursor: true }, beats: [
      { bit: 'lean', ms: 2800, say: '♥' },
      { bit: 'lean', ms: 2000 },
    ],
  },
  {
    id: 'karaoke', name: 'Sings karaoke', who: ['chipper'], when: { music: true }, beats: [
      { bit: 'rock', ms: 2400, hold: 'mic', prop: 'notes', say: '♪ la la la ♪' },
      { bit: 'bow', ms: 1200, hold: 'mic', say: 'thank you!' },
    ],
  },
  {
    id: 'boo', name: 'Tries to scare you', when: { season: 'halloween' }, beats: [
      { bit: 'hide', ms: 1700, say: '…' },
      { bit: 'boo', ms: 800, say: 'BOO!' },
      { bit: 'admire', ms: 1300, say: { any: 'scared you?', fussy: 'very spooky' } },
    ],
  },
  {
    id: 'shiver', name: 'Shivers', when: { season: 'winter' }, beats: [
      { bit: 'shiver', ms: 2400, say: 'brrr' },
      { bit: 'stretch', ms: 1300, say: { any: 'cosy now', sleepy: 'hibernate?' } },
    ],
  },
  {
    id: 'wave', name: 'Waves at you', when: { cursor: true, bond: 1 }, beats: [
      { bit: 'wave', ms: 1800, say: { any: 'hi!', fussy: 'hello.', sleepy: 'oh, hi', cocky: 'hey you' } },
    ],
  },
].map(s => Object.freeze({ who: [], when: {}, ...s, beats: Object.freeze(s.beats.map(Object.freeze)) })));

/** Does a scene's `when` hold in this moment? */
function fits(scene, ctx = {}) {
  const w = scene.when;
  const hour = Number.isFinite(ctx.hour) ? ctx.hour : 12;
  const night = hour >= 21 || hour < 5;
  if (w.night && !night) return false;
  if (w.day && night) return false;
  if (w.weekend && !(ctx.weekday === 0 || ctx.weekday === 6)) return false;
  if (w.friday && ctx.dayOccasion !== 'friday') return false;
  if (w.monday && ctx.dayOccasion !== 'monday') return false;
  if (w.music && !ctx.music) return false;
  if (w.cursor && !ctx.cursorNear) return false;
  if (w.find && !ctx.hasFind) return false;
  if (w.bond && !((ctx.bond || 0) >= w.bond)) return false;
  if (w.season && !(ctx.seasons || []).includes(w.season)) return false;
  return true;
}

/**
 * Which scene next, or null. Ones that suit his temperament come up more; the
 * last few he did are left out so he doesn't loop.
 *   ctx: { temperament, hour, weekday, dayOccasion, music, cursorNear, hasFind, bond, seasons }
 */
function pickScene(ctx = {}, recent = [], rand = Math.random) {
  const pool = SCENES.filter(s => fits(s, ctx) && !recent.includes(s.id));
  if (!pool.length) return null;
  // Scenes that only happen at a particular moment are the special ones: give them a lift.
  const weight = s => (s.who.includes(ctx.temperament) ? 3 : 1) * (Object.keys(s.when).length ? 1.6 : 1);
  const sum = pool.reduce((n, s) => n + weight(s), 0);
  let r = rand() * sum;
  for (const s of pool) { r -= weight(s); if (r < 0) return s; }
  return pool[pool.length - 1];
}

/** A line for this temperament from a beat's `say`. */
function lineFor(say, temperament, rand = Math.random) {
  if (say == null) return null;
  let v = say;
  if (typeof v === 'object' && !Array.isArray(v)) v = v[temperament] ?? v.any;
  if (Array.isArray(v)) v = v[Math.min(v.length - 1, Math.floor(rand() * v.length))];
  return typeof v === 'string' && v.length <= MAX_LINE ? v : null;
}

/** The scene's beats with every line settled for this crab: [{ bit, ms, say, prop, hold, wear }]. */
function resolve(scene, temperament, rand = Math.random) {
  if (!scene) return [];
  return scene.beats.map(b => ({
    bit: b.bit, ms: b.ms, say: lineFor(b.say, temperament, rand), prop: b.prop || null, hold: b.hold || null, wear: b.wear || null,
  }));
}

/** How long it runs, start to finish. */
const lengthOf = beats => beats.reduce((n, b) => n + b.ms, 0);

module.exports = { SCENES, PROPS, HOLDS, WEARS, SCENE_BITS, TEMPERAMENTS: T, fits, pickScene, lineFor, resolve, lengthOf };
