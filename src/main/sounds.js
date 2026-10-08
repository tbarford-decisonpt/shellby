// What Shellby is allowed to sound like right now. Every noise he makes is
// synthesized in the critter window (src/renderer/critter/sound.js, chirp.js,
// ambient.js); this decides which of them may play, so the rules live in one
// place: three things you switch on yourself (Settings -> Look), one volume,
// and silence while he guards your focus or you're on a call.
// Pure: no I/O. See test/sounds.test.js.

const AMBIENTS = Object.freeze(['off', 'surf', 'tidepool']);
const VOLUMES = Object.freeze([25, 60, 100]); // soft, normal, loud
const DEFAULT_VOLUME = 60;                    // the chirp's loudness before there was a volume

// Moments big enough for a cheer of their own rather than a blip. Anything
// else that speaks just chirps.
const CHEERS = Object.freeze({
  deploy: 'tada',
  passed: 'tada',
  fixed: 'tada',
  merged: 'tada',
  milestone: 'tada',
  unlocked: 'tada',
  levelup: 'fanfare',
  crit: 'crit',         // surprises.js: rarer than any of these, so a sound of its own
  landing: 'landing',
  learned: 'sparkle',
  newTricks: 'sparkle',
});

const SILENT = Object.freeze({ voice: false, fx: false, ambient: 'off', volume: DEFAULT_VOLUME });

const volumeOf = v => (VOLUMES.includes(v) ? v : DEFAULT_VOLUME);

/**
 * The sounds on right now. settings: { sounds, soundFx, ambient, soundVolume }
 * (config); quiet: he's guarding your focus or you're on a call.
 * Returns { voice, fx, ambient, volume }.
 */
function mix(settings = {}, { quiet = false } = {}) {
  const volume = volumeOf(settings.soundVolume);
  if (quiet) return { ...SILENT, volume };
  return {
    voice: !!settings.sounds,
    fx: !!settings.soundFx,
    ambient: AMBIENTS.includes(settings.ambient) ? settings.ambient : 'off',
    volume,
  };
}

/**
 * What to play when he speaks (or has a moment with nothing to say):
 * { cue, chirp }. A cheer stands in for the chirp rather than playing over it.
 */
function forOccasion(occasion, m) {
  const cue = m?.fx ? CHEERS[occasion] || null : null;
  return { cue, chirp: !cue && !!m?.voice };
}

/** Is anything that plays on a moment (not the background) on? */
const anyOn = m => !!(m && (m.voice || m.fx));

module.exports = { mix, forOccasion, anyOn, volumeOf, AMBIENTS, VOLUMES, DEFAULT_VOLUME, CHEERS };
