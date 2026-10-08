// Shellby's chirps. Square waves straight out of WebAudio: no audio files to
// ship, nothing to decode, and it suits a pixel crab better than a sample would.
// Off unless you turn sounds on (Settings -> Look); main only sends an event
// when it's on, and never while he's guarding your focus. Plays through the
// shared engine in sound.js, so the volume setting applies.
(function (root) {
  // occasion -> notes, in semitones from A4, each ~55ms. Short and dry.
  // An occasion with no tune of its own uses NEUTRAL, so a new line in
  // voice.js is audible without having to be given a melody first.
  const NEUTRAL = [0];
  const TUNES = {
    success: [4, 11],
    passed: [4, 11, 16],
    deploy: [0, 7, 12, 16],
    push: [7, 12],
    error: [-2, -9],
    learned: [7, 11, 14],
    unlocked: [0, 4, 7, 12],
    petted: [12, 14],
    working: [2],
    tests: [5, 5],
    morning: [0, 4],
    latenight: [-5, -7],
    back: [4, 7, 4],
    idle: [-3],
    oops: [7, 3, -2],
  };
  const NOTE_MS = 55;
  const GAIN = 0.045;        // quiet enough to live behind your music (at the normal volume)
  const MAX_PER_SECOND = 4;  // a hard stop on anything that could buzz

  let recent = [];

  function play(occasion) {
    const now = Date.now();
    recent = recent.filter(t => now - t < 1000);
    if (recent.length >= MAX_PER_SECOND) return;
    const sound = root.ShellbySound;
    // Someone who turned motion off wants a calm desktop; take the hint. A
    // locked screen has nobody to hear it (main doesn't know; sound.js does).
    if (!sound || sound.reduced() || sound.calm) return;
    const ac = sound.audio();
    if (!ac) return;
    recent.push(now);
    const tune = TUNES[occasion] || NEUTRAL;
    tune.forEach((semitone, i) => sound.tone(ac, {
      at: ac.currentTime + (i * NOTE_MS) / 1000,
      freq: 440 * Math.pow(2, semitone / 12),
      ms: NOTE_MS,
      gain: GAIN,
      attack: 0.008,
    }));
  }

  root.ShellbyChirp = { play, TUNES };
})(typeof window !== 'undefined' ? window : globalThis);
