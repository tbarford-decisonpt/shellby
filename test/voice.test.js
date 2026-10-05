const { test } = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../src/main/voice');
const fs = require('fs');
const path = require('path');

const T0 = new Date(2026, 9, 1, 12, 0, 0).getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// A deterministic rand: always the first available choice.
const first = () => 0;
// ...and one that walks the pool, so repeated calls differ.
const cycler = () => { let i = 0; return () => ((i++ % 7) / 7); };

const seeded = seed => ({ ...voice.normalize(null), seed });

test('every line fits the bubble (two short lines at most)', () => {
  const pools = [...Object.values(voice.LINES), ...Object.values(voice.FLAVOR).flatMap(f => Object.values(f))];
  for (const pool of pools) {
    for (const line of pool) {
      assert.ok(line.length <= voice.MAX_LINE, `"${line}" is ${line.length} chars, over ${voice.MAX_LINE}`);
      assert.equal(line, line.trim(), `"${line}" has stray whitespace`);
    }
  }
});

test('every occasion has a pool of at least three, and every pool an occasion', () => {
  for (const key of Object.keys(voice.OCCASIONS)) {
    assert.ok(voice.LINES[key]?.length >= 3, `${key} needs at least three lines`);
  }
  for (const key of Object.keys(voice.LINES)) {
    assert.ok(voice.OCCASIONS[key], `${key} has lines but no occasion rule`);
  }
  // Flavor may only extend occasions that exist.
  for (const [temperament, flavor] of Object.entries(voice.FLAVOR)) {
    assert.ok(voice.TEMPERAMENTS.includes(temperament));
    for (const key of Object.keys(flavor)) assert.ok(voice.OCCASIONS[key], `${temperament} flavors unknown ${key}`);
  }
});

test("'quiet' never says anything at all", () => {
  for (const occasion of Object.keys(voice.OCCASIONS)) {
    assert.equal(voice.say(null, occasion, T0, { chatter: 'quiet', rand: first }), null);
    assert.equal(voice.say(null, occasion, T0, { chatter: 'quiet', rand: first, force: true }), null);
  }
});

test("'work' only speaks up about the work, and has no idle habits", () => {
  for (const occasion of Object.keys(voice.OCCASIONS)) {
    const r = voice.say(null, occasion, T0, { chatter: 'work', rand: first, force: true });
    assert.equal(!!r, voice.WORK_OCCASIONS.has(occasion), occasion);
  }
  assert.equal(voice.say(null, 'memory', T0, { chatter: 'work', text: 'hi', force: true }), null);
  assert.equal(voice.hasHabits('work'), false);
  assert.equal(voice.hasHabits('quiet'), false);
  assert.equal(voice.hasHabits('normal'), true);
  assert.equal(voice.hasHabits('chatty'), true);
  assert.equal(voice.hasHabits(undefined), true, 'unset is normal');
});

test('a line comes back with a ttl, and the state remembers it', () => {
  const r = voice.say(null, 'success', T0, { rand: first });
  assert.equal(r.occasion, 'success');
  assert.ok(voice.poolFor('success', 'chipper').includes(r.text));
  assert.equal(r.until, T0 + voice.OCCASIONS.success.ttl);
  assert.equal(r.state.lastSpokeAt, T0);
  assert.equal(r.state.said.success, T0);
});

test('the global gap stops him chattering, and force gets through it', () => {
  const r1 = voice.say(null, 'success', T0, { rand: first });
  // 'error' has no cooldown of its own, but the global gap still applies.
  assert.equal(voice.say(r1.state, 'error', T0 + 5 * SECOND, { rand: first }), null);
  assert.ok(voice.say(r1.state, 'error', T0 + 45 * SECOND, { rand: first }));
  assert.ok(voice.say(r1.state, 'error', T0 + 5 * SECOND, { rand: first, force: true }));
});

test("'chatty' shortens the gap and the cooldowns; 'normal' holds them", () => {
  const r = voice.say(null, 'working', T0, { rand: first });
  const soon = T0 + 2 * MINUTE;
  assert.equal(voice.say(r.state, 'working', soon, { chatter: 'normal', rand: first }), null);
  assert.ok(voice.say(r.state, 'working', soon, { chatter: 'chatty', rand: first }));
});

test("occasions marked chatty-only stay quiet at 'normal'", () => {
  assert.equal(voice.say(null, 'searching', T0, { chatter: 'normal', rand: first }), null);
  assert.ok(voice.say(null, 'searching', T0, { chatter: 'chatty', rand: first }));
});

test("idle mutters reach 'normal' too, just less often than 'chatty'", () => {
  const r = voice.say(null, 'idle', T0, { chatter: 'normal', rand: first });
  assert.ok(r, 'a crab-only user on Normal hears him now and then');
  assert.equal(voice.say(r.state, 'idle', T0 + 15 * MINUTE, { chatter: 'normal', rand: first }), null);
  assert.ok(voice.say(r.state, 'idle', T0 + 15 * MINUTE, { chatter: 'chatty', rand: first }));
  assert.ok(voice.say(r.state, 'idle', T0 + 26 * MINUTE, { chatter: 'normal', rand: first }));
});

test('a line made elsewhere passes the same rules and must fit', () => {
  const r = voice.say(null, 'memory', T0, { text: 'remember Chrome?' });
  assert.equal(r.text, 'remember Chrome?');
  assert.equal(r.state.said.memory, T0);
  assert.equal(voice.say(r.state, 'memory', T0 + HOUR, { text: 'remember Edge?' }), null, 'its cooldown holds');
  assert.equal(voice.say(null, 'memory', T0, { text: 'x'.repeat(voice.MAX_LINE + 1) }), null);
  assert.equal(voice.say(null, 'memory', T0, { text: '   ' }), null);
  assert.equal(voice.say(null, 'memory', T0, { text: 'hi', chatter: 'quiet' }), null);
});

test('every temperament describes itself', () => {
  for (const t of voice.TEMPERAMENTS) {
    const info = voice.TEMPERAMENT_INFO[t];
    assert.ok(info?.name && info.emoji && info.blurb, t);
  }
});

test('he never repeats a line while another one is unused', () => {
  const pool = voice.poolFor('idle', voice.temperamentOf(null));
  const rand = cycler();
  let state = seeded(null);
  const said = [];
  // Walk a full pool's worth of lines, forcing past the cooldowns.
  for (let i = 0; i < pool.length; i++) {
    const r = voice.say(state, 'idle', T0 + i * MINUTE, { chatter: 'chatty', rand, force: true });
    said.push(r.text);
    state = r.state;
  }
  // Within the first half of a pool there can be no duplicate at all.
  const half = said.slice(0, Math.ceil(pool.length / 2));
  assert.equal(new Set(half).size, half.length, `repeated inside ${JSON.stringify(half)}`);
});

test('an unknown occasion and a bad clock say nothing', () => {
  assert.equal(voice.say(null, 'nonsense', T0, { rand: first }), null);
  assert.equal(voice.say(null, 'success', NaN, { rand: first }), null);
  assert.equal(voice.say(null, 'success', undefined, { rand: first }), null);
});

test('temperament is stable for a seed and spreads across seeds', () => {
  assert.equal(voice.temperamentOf('abc'), voice.temperamentOf('abc'));
  assert.ok(voice.TEMPERAMENTS.includes(voice.temperamentOf('abc')));
  assert.equal(voice.temperamentOf(null), voice.TEMPERAMENTS[0]);
  const seen = new Set(Array.from({ length: 200 }, (_, i) => voice.temperamentOf(`seed-${i}`)));
  assert.equal(seen.size, voice.TEMPERAMENTS.length, 'every temperament should be reachable');
});

test('temperament adds its own lines to a pool', () => {
  const base = voice.LINES.success.length;
  assert.equal(voice.poolFor('success', 'cocky').length, base + voice.FLAVOR.cocky.success.length);
  assert.ok(voice.poolFor('success', 'cocky').includes('obviously'));
  // A crab with the cocky seed can say the cocky line; a chipper one cannot.
  const cocky = voice.TEMPERAMENTS.includes('cocky');
  assert.ok(cocky);
  assert.ok(!voice.poolFor('success', 'chipper').includes('obviously'));
});

test('time of day: morning early, late night in the small hours, nothing midday', () => {
  assert.equal(voice.timeOccasion(T0, 7), 'morning');
  assert.equal(voice.timeOccasion(T0, 2), 'latenight');
  assert.equal(voice.timeOccasion(T0, 14), null);
  assert.equal(voice.timeOccasion(T0, 23), null);
  // Defaults to the clock it was given.
  assert.equal(voice.timeOccasion(new Date(2026, 9, 1, 6, 0, 0).getTime()), 'morning');
});

test('absence: he notices three days away, not one', () => {
  assert.equal(voice.absenceOccasion(T0 - 1 * 24 * HOUR, T0), null);
  assert.equal(voice.absenceOccasion(T0 - 4 * 24 * HOUR, T0), 'back');
  assert.equal(voice.absenceOccasion(null, T0), null);
  assert.equal(voice.absenceOccasion(T0, NaN), null);
});

test('idle habits are weighted by temperament but all reachable', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => `seed-${i}`);
  const bits = new Set();
  for (const seed of seeds) for (let i = 0; i < 40; i++) bits.add(voice.pickBit(seed, () => i / 40));
  assert.deepEqual([...bits].sort(), [...voice.BITS].sort());
  // A sleepy crab flops more often than a fussy one.
  const flops = seed => Array.from({ length: 100 }, (_, i) => voice.pickBit(seed, () => i / 100)).filter(b => b === 'flop').length;
  const sleepySeed = seeds.find(s => voice.temperamentOf(s) === 'sleepy');
  const fussySeed = seeds.find(s => voice.temperamentOf(s) === 'fussy');
  assert.ok(flops(sleepySeed) > flops(fussySeed));
});

test('pickBit always returns a real bit, even with a degenerate rand', () => {
  assert.ok(voice.BITS.includes(voice.pickBit('abc', () => 0)));
  assert.ok(voice.BITS.includes(voice.pickBit('abc', () => 0.999999)));
  assert.ok(voice.BITS.includes(voice.pickBit('abc', () => 1)));
});

test('what the work is: the third visit to a file beats its size', () => {
  assert.equal(voice.occasionForTool('Write', { chars: 5000, touches: 1 }), 'bigWrite');
  assert.equal(voice.occasionForTool('Write', { chars: 5000, touches: 3 }), 'sameFile');
  assert.equal(voice.occasionForTool('Write', { chars: 4, touches: 1 }), null);
  // Even a small edit is worth a word the third time it hits the same file.
  assert.equal(voice.occasionForTool('Edit', { chars: 4, touches: 4 }), 'sameFile');
});

test('what the work is: tests, searches and the web', () => {
  assert.equal(voice.occasionForTool('Bash', { command: 'npm test' }), 'tests');
  assert.equal(voice.occasionForTool('Bash', { command: 'npm test -- --dry-run' }), null);
  assert.equal(voice.occasionForTool('Bash', { command: 'git push' }), null); // waits for it to land
  assert.equal(voice.occasionForTool('Bash', { command: 'ls' }), null);
  assert.equal(voice.occasionForTool('Grep', {}), 'searching');
  assert.equal(voice.occasionForTool('WebSearch', {}), 'web');
  assert.equal(voice.occasionForTool('Read', {}), null);
  assert.equal(voice.occasionForTool(null, {}), null);
  assert.equal(voice.occasionForTool('Bash'), null);
});

test('a finished command maps to what he says about it', () => {
  assert.equal(voice.occasionForCommand('tests'), 'passed');
  assert.equal(voice.occasionForCommand('ship'), 'push');
  assert.equal(voice.occasionForCommand('deploy'), 'deploy');
  assert.equal(voice.occasionForCommand(null), null);
  assert.equal(voice.occasionForCommand('nonsense'), null);
});

test('normalize tolerates rubbish from disk', () => {
  assert.deepEqual(voice.normalize(null), { seed: null, lastRunAt: null, lastSpokeAt: 0, said: {}, recent: {} });
  assert.deepEqual(voice.normalize('nope'), { seed: null, lastRunAt: null, lastSpokeAt: 0, said: {}, recent: {} });
  const s = voice.normalize({
    seed: 42, lastRunAt: 'soon', lastSpokeAt: null,
    said: { success: T0, nonsense: T0, error: 'never' },
    recent: { success: [0, 1, 'x', 2.5], nonsense: [0] },
  });
  assert.equal(s.seed, null);
  assert.equal(s.lastRunAt, null);
  assert.equal(s.lastSpokeAt, 0);
  assert.deepEqual(s.said, { success: T0 });
  assert.deepEqual(s.recent, { success: [0, 1] });
});

test('say never mutates the state it was given', () => {
  const before = seeded('abc');
  const snapshot = JSON.parse(JSON.stringify(before));
  voice.say(before, 'success', T0, { rand: first });
  assert.deepEqual(before, snapshot);
});

test("a seed carried in state picks that crab's flavoured lines", () => {
  const cockySeed = Array.from({ length: 60 }, (_, i) => `s${i}`).find(s => voice.temperamentOf(s) === 'cocky');
  const pool = voice.poolFor('success', 'cocky');
  const rand = cycler();
  const texts = new Set();
  let state = seeded(cockySeed);
  for (let i = 0; i < pool.length; i++) {
    const r = voice.say(state, 'success', T0 + i * MINUTE, { chatter: 'chatty', rand, force: true });
    texts.add(r.text);
    state = r.state;
  }
  // Over a full pool he uses the flavoured lines too, not just the base ones.
  assert.ok([...texts].every(t => pool.includes(t)));
  assert.ok([...texts].some(t => voice.FLAVOR.cocky.success.includes(t)));
});

test('every idle habit has an animation, and the clumsy ones are habits', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'critter');
  const css = ['critter.css', 'charm.css'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const bit of voice.BITS) assert.ok(css.includes(`body.bit-${bit} `), `no animation for bit-${bit}`);
  for (const bit of voice.CLUMSY_BITS) assert.ok(voice.BITS.includes(bit), `${bit} is clumsy but never picked`);
});
