// Dialogue packs: voices and scenes in wardrobe packs (src/main/wardrobe/dialogue.js),
// how he talks in a voice (voice.js), which scenes he does (scenes.js), and the
// Wardrobe keeping track of the voice he's wearing (wardrobe/service.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dlg = require('../src/main/wardrobe/dialogue');
const { validatePack } = require('../src/main/wardrobe/catalog');
const { KNOWN_ACHIEVEMENTS } = require('../src/main/wardrobe/achievements');
const { KNOWN_SEASONS } = require('../src/main/wardrobe/seasons');
const voice = require('../src/main/voice');
const sc = require('../src/main/scenes');
const { LEVELS } = require('../src/main/bond');
const { Config } = require('../src/main/config');
const { Wardrobe } = require('../src/main/wardrobe/service');
const { checkSchema } = require('../scripts/validate-packs');

const BUILTIN = path.join(__dirname, '..', 'src', 'wardrobe');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'addon.schema.json'), 'utf8'));
const known = { knownAchievements: KNOWN_ACHIEVEMENTS, knownSeasons: KNOWN_SEASONS };

const header = { format: 1, id: 'pirate-talk', name: 'Pirate Talk', author: 'someone', version: '1.0.0' };
const pirate = {
  id: 'pirate', name: 'Pirate',
  lines: { working: ['arr, on it', 'aye aye'], success: ['booty!'] },
  flavor: { cocky: { success: ["captain's orders"] } },
};
const lookout = {
  id: 'lookout', name: 'Keeps a lookout', voice: 'pirate',
  beats: [{ bit: 'gaze', ms: 2000, say: 'land ho?' }, { bit: 'squint', ms: 1200, say: { any: '…nope', sleepy: 'zz' } }],
};
const packOf = extra => ({ ...header, ...extra });

// ---------------------------------------------------------------- voices

test('a voice keeps its good lines and says why it dropped the rest', () => {
  const { content, warnings, error } = dlg.voiceContent({
    lines: {
      working: ['arr', 'arr', 'x'.repeat(25), 'bell\u0007', ''],
      singing: ['la la'],
      success: ['booty!'],
    },
    lang: 'english please',
  });
  assert.equal(error, undefined);
  assert.deepEqual(content.lines.working, ['arr']); // the duplicate goes quietly
  assert.deepEqual(Object.keys(content.lines), ['working', 'success']);
  assert.equal(content.fallback, 'shellby');
  assert.equal(content.lang, '');
  assert.ok(warnings.some(w => w.includes('longer than 24')));
  assert.ok(warnings.some(w => w.includes('control character')));
  assert.ok(warnings.some(w => w.includes('lines "singing": unknown occasion')));
  assert.ok(warnings.some(w => w.startsWith('ignored lang')));
});

test('a voice with nothing to say, or a fallback it made up, is skipped', () => {
  assert.match(dlg.voiceContent({ lines: { working: ['x'.repeat(30)] } }).error, /at least one occasion/);
  assert.match(dlg.voiceContent({ lines: 'arr' }).error, /at least one occasion/);
  assert.match(dlg.voiceContent({ lines: { working: ['arr'] }, fallback: 'english' }).error, /fallback/);
});

test('lines are measured the way people count, and bidi overrides are refused', () => {
  assert.equal(dlg.lineProblem('🦀'.repeat(24)), null); // 48 UTF-16 units, 24 crabs
  assert.match(dlg.lineProblem('🦀'.repeat(25)), /longer than 24/);
  assert.equal(dlg.lineProblem('👨‍👩‍👧 hi'), null); // zero-width joiners are fine
  assert.match(dlg.lineProblem('abc‮def'), /control character/);
  assert.equal(sc.lineFor('🦀'.repeat(20), 'chipper'), '🦀'.repeat(20));
});

test('a junk pack gets a bounded, readable list of warnings', () => {
  const lines = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`x${i}`.repeat(200), ['hm']]));
  const { warnings } = validatePack(packOf({ voices: [{ ...pirate, lines: { ...lines, idle: ['hm'] } }] }), known);
  assert.equal(warnings.length, 51);
  assert.match(warnings[50], /and \d+ more/);
  assert.ok(warnings.every(w => w.length < 200), 'long keys are cut short');
});

test('voice lines can never reach Object.prototype', () => {
  const { content } = dlg.voiceContent({ lines: JSON.parse('{"__proto__": ["boo"], "idle": ["hm"]}') });
  assert.equal(Object.getPrototypeOf(content.lines), null);
  assert.deepEqual(Object.keys(content.lines), ['idle']);
  assert.equal({}.boo, undefined);
});

// ---------------------------------------------------------------- scenes

test('a scene can only use what Shellby already knows how to draw', () => {
  const ok = dlg.sceneContent(lookout, { voiceIds: ['pirate'] });
  assert.equal(ok.error, undefined);
  assert.equal(ok.content.voice, 'pirate');
  const bad = (beat, why) => assert.match(dlg.sceneContent({ beats: [{ bit: 'gaze', ms: 1000, ...beat }] }).error, why);
  bad({ bit: 'moonwalk' }, /unknown bit/);
  bad({ prop: 'cannon' }, /unknown prop/);
  bad({ hold: 'cutlass' }, /unknown hold/);
  bad({ wear: 'eyepatch' }, /unknown wear/);
  bad({ ms: 100 }, /ms must be/);
  bad({ ms: 1500.5 }, /ms must be/);
  bad({ say: 'x'.repeat(25) }, /longer than 24/);
  bad({ say: { pirate: 'arr' } }, /unknown key "pirate"/);
  bad({ say: [] }, /1–6 entries/);
});

test('a scene has to be short and its conditions have to make sense', () => {
  const beats = Array.from({ length: 3 }, () => ({ bit: 'gaze', ms: 5000 }));
  assert.match(dlg.sceneContent({ beats }).error, /at most 12000/);
  assert.match(dlg.sceneContent({ beats: [] }).error, /beats must be/);
  const when = w => dlg.sceneContent({ when: w, beats: [{ bit: 'gaze', ms: 1000 }] }, { seasons: KNOWN_SEASONS });
  assert.match(when({ raining: true }).error, /unknown condition/);
  assert.match(when({ music: 'yes' }).error, /must be true/);
  assert.match(when({ night: true, day: true }).error, /never both/);
  assert.match(when({ bond: LEVELS.length }).error, /when.bond/);
  assert.match(when({ season: 'monsoon' }).error, /unknown season/);
  assert.deepEqual(when({ season: 'winter', bond: 2 }).content.when, { season: 'winter', bond: 2 });
  assert.match(dlg.sceneContent({ ...lookout }, { voiceIds: [] }).error, /isn't a voice in this pack/);
  assert.match(dlg.sceneContent({ who: ['grumpy'], beats: lookout.beats }).error, /who must list/);
});

// ---------------------------------------------------------------- in a pack

test('voices and scenes load from a pack, keyed so they can never clash', () => {
  const { pack, errors, warnings } = validatePack(packOf({
    voices: [pirate, { id: 'mute', name: 'Mute', lines: {} }],
    scenes: [lookout, { id: 'wave', name: 'Waves', beats: [{ bit: 'wave', ms: 1500, say: 'ahoy' }] }],
  }), known);
  assert.deepEqual(errors, []);
  assert.deepEqual(pack.voices.map(v => v.key), ['pirate-talk/pirate']);
  assert.deepEqual(pack.scenes.map(s => [s.key, s.voice]), [['pirate-talk/lookout', 'pirate-talk/pirate'], ['pirate-talk/wave', null]]);
  assert.ok(warnings.some(w => w.startsWith('skipped voice mute')));
});

test("a voice's own warnings name the voice", () => {
  const { pack, warnings } = validatePack(packOf({ voices: [{ ...pirate, lines: { ...pirate.lines, idle: ['x'.repeat(40)] } }] }), known);
  assert.equal(pack.voices.length, 1);
  assert.ok(warnings.some(w => w.startsWith('voice pirate: ignored a line in lines.idle')), warnings.join('\n'));
});

test('voices can be seasonal or earned like any other item', () => {
  const { pack, warnings } = validatePack(packOf({
    voices: [{ ...pirate, rarity: 'epic', unlock: { season: 'halloween' } }, { ...pirate, id: 'nope', unlock: { achievement: 'pirate-king' } }],
  }), known);
  assert.deepEqual(pack.voices.map(v => [v.id, v.rarity, v.unlock]), [['pirate', 'epic', { season: 'halloween' }]]);
  assert.ok(warnings.some(w => w.includes('unknown achievement')));
});

// ---------------------------------------------------------------- talking in a voice

const SEED = 'seed-for-tests';
const T = voice.temperamentOf(SEED);
const state = { seed: SEED };
const sayIn = (occasion, worn, opts = {}) => voice.say(state, occasion, 1e12, { force: true, rand: () => 0, voice: worn, ...opts });
const worn = (extra = {}) => ({ lines: { working: ['arr, on it'], milestone: ['what a voyage'] }, flavor: {}, fallback: 'shellby', ...extra });

test('in a voice he says its lines where it has them, and his own elsewhere', () => {
  assert.equal(sayIn('working', worn()).text, 'arr, on it');
  assert.ok(voice.LINES.success.includes(sayIn('success', worn()).text) || voice.FLAVOR[T].success.includes(sayIn('success', worn()).text));
});

test('a quiet voice keeps occasions it has no lines for to itself', () => {
  assert.equal(sayIn('working', worn({ fallback: 'quiet' })).text, 'arr, on it');
  assert.equal(sayIn('success', worn({ fallback: 'quiet' })), null);
  assert.equal(sayIn('memory', worn({ fallback: 'quiet' }), { text: 'remember that?' }), null);
});

test('a line made elsewhere keeps its content, unless the voice is another language', () => {
  // A character voice: the milestone still says how many days.
  assert.equal(sayIn('milestone', worn(), { text: '100 days!' }).text, '100 days!');
  assert.equal(sayIn('memory', worn(), { text: 'remember that?' }).text, 'remember that?');
  // A quiet voice: its own line where it has one, else nothing.
  assert.equal(sayIn('milestone', worn({ fallback: 'quiet' }), { text: '100 days!' }).text, 'what a voyage');
});

test("a voice's temperament lines join its own", () => {
  const v = worn({ lines: { idle: ['calm seas'] }, flavor: { [T]: { idle: ['hammock time'] } } });
  assert.deepEqual(voice.poolFor('idle', T, v), ['calm seas', 'hammock time']);
  // A temperament line alone is enough to cover the occasion.
  assert.deepEqual(voice.poolFor('push', T, worn({ flavor: { [T]: { push: ['set sail!'] } } })), ['set sail!']);
});

test('without a voice nothing changes', () => {
  assert.deepEqual(voice.poolFor('idle', T, null), voice.poolFor('idle', T));
  assert.equal(sayIn('working', null).text, voice.poolFor('working', T)[0]);
});

// ---------------------------------------------------------------- scenes in a voice

const packScene = (id, v) => ({ id, voice: v, who: [], when: {}, beats: [{ bit: 'wave', ms: 1000, say: 'hola' }] });

test('pack scenes join his own, and voice scenes only while that voice is on', () => {
  const pack = [packScene('p/anyone', null), packScene('p/pirate-only', 'p/pirate')];
  const ids = w => sc.inVoice(pack, w).list.map(s => s.id);
  assert.ok(ids(null).includes('p/anyone'));
  assert.ok(!ids(null).includes('p/pirate-only'));
  assert.ok(ids({ key: 'p/pirate', fallback: 'shellby' }).includes('p/pirate-only'));
  assert.equal(ids(null).length, sc.SCENES.length + 1);
});

test("in a quiet voice, scenes that weren't written for it play without words", () => {
  const pack = [packScene('p/hola', 'p/es')];
  const { silent } = sc.inVoice(pack, { key: 'p/es', fallback: 'quiet' });
  assert.equal(silent(sc.SCENES[0]), true);
  assert.equal(silent(pack[0]), false);
  assert.equal(sc.inVoice(pack, { key: 'p/pirate', fallback: 'shellby' }).silent(sc.SCENES[0]), false);
  const beats = sc.resolve(sc.SCENES.find(s => s.id === 'sneeze'), 'chipper', () => 0, { silent: true });
  assert.ok(beats.length && beats.every(b => b.say === null && b.bit));
});

test('pickScene chooses from the list it is given', () => {
  const only = [packScene('p/only', null)];
  assert.equal(sc.pickScene({}, [], () => 0.5, only).id, 'p/only');
  assert.equal(sc.pickScene({}, ['p/only'], () => 0.5, only), null);
});

test('however many pack scenes there are, his own still come up at least half the time', () => {
  const flood = Array.from({ length: 300 }, (_, i) => packScene(`p/s${i}`, null));
  const list = [...sc.SCENES, ...flood];
  let own = 0;
  const N = 400;
  for (let i = 0; i < N; i++) if (sc.SCENES.includes(sc.pickScene({}, [], () => (i + 0.5) / N, list))) own++;
  assert.ok(own / N >= 0.45, `his own scenes came up ${own}/${N}`);
});

// ---------------------------------------------------------------- the Wardrobe

function make() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-dlg-'));
  const w = new Wardrobe({ config: new Config(dir), builtinDir: BUILTIN, userDir: path.join(dir, 'packs'), now: () => new Date(2026, 5, 10, 12) });
  w.load();
  return { w, dir };
}

test('the Wardrobe wears a voice, hands it to the runtime, and lets it go when the pack goes', () => {
  const { w, dir } = make();
  const file = path.join(dir, 'pirate-talk.json');
  fs.writeFileSync(file, JSON.stringify(packOf({ voices: [pirate], scenes: [lookout] })));
  assert.equal(w.install(file).ok, true);

  assert.equal(w.dialogue().voice, null);
  assert.equal(w.setVoice('pirate-talk/nope').ok, false);
  assert.equal(w.setVoice('pirate-talk/pirate').ok, true);
  const g = w.dialogue();
  assert.equal(g.voice.key, 'pirate-talk/pirate');
  assert.deepEqual(g.voice.lines.working, ['arr, on it', 'aye aye']);
  assert.ok(g.scenes.some(s => s.id === 'pirate-talk/lookout' && s.voice === 'pirate-talk/pirate'));

  const v = w.view();
  assert.equal(v.voice, 'pirate-talk/pirate');
  const tile = v.voices.find(x => x.key === 'pirate-talk/pirate');
  assert.deepEqual(tile.sample, ['arr, on it', 'booty!']);
  assert.equal(tile.lines, undefined, 'the panel gets a sample, not the whole voice');
  assert.deepEqual(v.packs.find(p => p.id === 'pirate-talk').counts, { accessories: 0, effects: 0, skins: 0, voices: 1, scenes: 1, decor: 0 });

  w.remove('pirate-talk');
  assert.equal(w.dialogue().voice, null);
  assert.equal(w.view().voice, null);
  assert.equal(w.setVoice(null).ok, true);
});

test("a voice can't take a key an accessory already has", () => {
  const { w, dir } = make();
  const file = path.join(dir, 'pirate-talk.json');
  const hat = { id: 'pirate', name: 'Pirate Hat', slot: 'hat', pivot: [0, 0], palette: { k: '#000000' }, pixels: ['k'] };
  fs.writeFileSync(file, JSON.stringify(packOf({ accessories: [hat], voices: [pirate] })));
  w.install(file);
  assert.equal(w.catalog.voices.has('pirate-talk/pirate'), false);
  assert.equal(w.item('pirate-talk/pirate').slot, 'hat');
});

test("a locked voice can't be worn, and stops talking if it locks again", () => {
  const { w, dir } = make();
  const file = path.join(dir, 'pirate-talk.json');
  fs.writeFileSync(file, JSON.stringify(packOf({ voices: [{ ...pirate, unlock: { achievement: 'centurion' } }] })));
  w.install(file);
  assert.match(w.setVoice('pirate-talk/pirate').error, /locked/);
  w.setOptions({ unlockAll: true });
  assert.equal(w.setVoice('pirate-talk/pirate').ok, true);
  w.setOptions({ unlockAll: false });
  assert.equal(w.dialogue().voice, null);
});

// ---------------------------------------------------------------- the built-in Voices pack

test('the built-in voices load and cover what they promise', () => {
  const { w } = make();
  const keys = [...w.catalog.voices.keys()];
  assert.deepEqual(keys, ['pirate', 'grumpy', 'espanol', 'robot', 'surfer', 'royal', 'cowboy', 'francais']);
  for (const [id, lang] of [['espanol', 'es'], ['francais', 'fr']]) {
    const v = w.catalog.voices.get(id);
    assert.equal(v.fallback, 'quiet');
    assert.equal(v.lang, lang);
    // A language voice that falls quiet should still have something for every occasion.
    assert.deepEqual(Object.keys(v.lines).sort(), [...dlg.OCCASIONS].sort(), id);
  }
});

test("built-in pack scenes don't share an id with his own", () => {
  const { w } = make();
  const own = new Set(sc.SCENES.map(s => s.id));
  for (const s of w.catalog.scenes.values()) {
    assert.ok(!own.has(s.key), `${s.key} clashes with a built-in scene`);
    assert.ok(s.voice == null || w.catalog.voices.has(s.voice), `${s.key} names a missing voice`);
  }
});

// ---------------------------------------------------------------- the schema

test('the schema mirrors the dialogue validator', () => {
  const d = SCHEMA.$defs;
  assert.deepEqual(d.occasionLines.propertyNames.enum, [...dlg.OCCASIONS]);
  assert.deepEqual(d.temperament.enum, [...voice.TEMPERAMENTS]);
  assert.deepEqual(d.voice.properties.fallback.enum, [...dlg.FALLBACKS]);
  assert.equal(d.voice.properties.lang.pattern, dlg.LANG_RE.source);
  assert.equal(d.line.maxLength, voice.MAX_LINE);
  assert.equal(d.lines.maxItems, dlg.LIMITS.linesPerOccasion);
  assert.deepEqual(d.beat.properties.bit.enum, [...sc.SCENE_BITS]);
  assert.deepEqual(d.beat.properties.prop.enum, [...sc.PROPS]);
  assert.deepEqual(d.beat.properties.hold.enum, [...sc.HOLDS]);
  assert.deepEqual(d.beat.properties.wear.enum, [...sc.WEARS]);
  assert.equal(d.beat.properties.ms.minimum, dlg.LIMITS.beatMinMs);
  assert.equal(d.beat.properties.ms.maximum, dlg.LIMITS.beatMaxMs);
  assert.deepEqual(Object.keys(d.when.properties), [...dlg.WHEN_KEYS]);
  assert.equal(d.when.properties.bond.maximum, LEVELS.length - 1);
  assert.deepEqual(d.when.properties.season.enum, [...KNOWN_SEASONS]);
  assert.deepEqual(Object.keys(d.say.oneOf[1].properties), [...dlg.SAY_KEYS]);
  assert.equal(d.scene.properties.beats.maxItems, dlg.LIMITS.beats);
});

test('the schema rejects what the gallery should turn away', () => {
  const problems = json => checkSchema(json, SCHEMA, SCHEMA);
  assert.deepEqual(problems(packOf({ voices: [pirate], scenes: [lookout] })), []);
  assert.ok(problems(packOf({ voices: [{ ...pirate, script: 'alert(1)' }] })).some(p => p.includes('unknown field "script"')));
  assert.ok(problems(packOf({ voices: [{ ...pirate, lines: { working: ['x'.repeat(25)] } }] })).length);
  assert.ok(problems(packOf({ voices: [{ ...pirate, lines: { singing: ['la'] } }] })).length);
  assert.ok(problems(packOf({ scenes: [{ ...lookout, beats: [{ bit: 'gaze', ms: 1000, html: '<b>' }] }] })).some(p => p.includes('unknown field "html"')));
  assert.ok(problems(packOf({ scenes: [{ ...lookout, beats: [{ bit: 'gaze', ms: 1000, say: { pirate: 'arr' } }] }] })).length);
});
