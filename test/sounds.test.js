const { test } = require('node:test');
const assert = require('node:assert/strict');
const sounds = require('../src/main/sounds');

test('everything is off for a fresh install', () => {
  assert.deepEqual(sounds.mix({}), { voice: false, fx: false, ambient: 'off', volume: 60 });
});

test('the mix follows the settings you switched on', () => {
  const m = sounds.mix({ sounds: true, soundFx: true, ambient: 'tidepool', soundVolume: 100 });
  assert.deepEqual(m, { voice: true, fx: true, ambient: 'tidepool', volume: 100 });
});

test('guarding your focus or a call silences everything, background included', () => {
  const m = sounds.mix({ sounds: true, soundFx: true, ambient: 'surf', soundVolume: 25 }, { quiet: true });
  assert.deepEqual(m, { voice: false, fx: false, ambient: 'off', volume: 25 });
});

test('unknown ambients and volumes fall back to safe defaults', () => {
  const m = sounds.mix({ ambient: 'jackhammer', soundVolume: 9000 });
  assert.equal(m.ambient, 'off');
  assert.equal(m.volume, sounds.DEFAULT_VOLUME);
  assert.equal(sounds.volumeOf('60'), sounds.DEFAULT_VOLUME, 'only the listed numbers count');
});

test('a big moment cheers instead of chirping when effects are on', () => {
  const both = { voice: true, fx: true };
  assert.deepEqual(sounds.forOccasion('deploy', both), { cue: 'tada', chirp: false });
  assert.deepEqual(sounds.forOccasion('levelup', both), { cue: 'fanfare', chirp: false });
  assert.deepEqual(sounds.forOccasion('working', both), { cue: null, chirp: true });
});

test('with effects off, big moments chirp like anything else', () => {
  assert.deepEqual(sounds.forOccasion('deploy', { voice: true, fx: false }), { cue: null, chirp: true });
  assert.deepEqual(sounds.forOccasion('deploy', { voice: false, fx: false }), { cue: null, chirp: false });
});

test('effects alone cheer the big moments and stay quiet for the rest', () => {
  const fxOnly = { voice: false, fx: true };
  assert.deepEqual(sounds.forOccasion('unlocked', fxOnly), { cue: 'tada', chirp: false });
  assert.deepEqual(sounds.forOccasion('idle', fxOnly), { cue: null, chirp: false });
});

test('anyOn ignores the background', () => {
  assert.equal(sounds.anyOn({ voice: false, fx: false, ambient: 'surf' }), false);
  assert.equal(sounds.anyOn({ voice: false, fx: true }), true);
  assert.equal(sounds.anyOn(null), false);
});
