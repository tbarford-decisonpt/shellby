// Shellby's chirps, synthesized in WebAudio: no audio files to ship, nothing to
// decode. Each note is a soft "bwip": a sine that slides into its pitch, a quiet
// triangle an octave up for a bit of body, all through a gentle lowpass, so he
// sounds like a small creature rather than a game console's beep.
// Off unless you turn sounds on (Settings -> Look); main only sends an event
// when it's on, and never while he's guarding your focus. Plays through the
// shared engine in sound.js, so the volume setting applies.
(function (root) {
  // occasion -> notes, in semitones from A5. Short and dry.
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
  const BASE_HZ = 880;        // A5: he's small
  const NOTE_STEP_MS = 62;    // from one note's start to the next
  const NOTE_MS = 90;         // each note rings a little past the next one's start, so a tune flows
  const SLIDE = 3;            // semitones each note slides in from (below, or above in a falling tune)
  const GAIN = 0.07;          // the sine; quiet enough to live behind your music (at the normal volume)
  const OVERTONE_GAIN = 0.018;
  const SOFTEN_HZ = 2800;     // the lowpass that takes the edge off
  const WOBBLE_CENTS = 18;    // each chirp lands a touch sharp or flat, so no two are identical
  const MAX_PER_SECOND = 4;   // a hard stop on anything that could buzz

  let recent = [];

  const hz = semitone => BASE_HZ * Math.pow(2, semitone / 12);

  function play(occasion) {
    const now = Date.now();
    recent = recent.filter(t => now - t < 1000);
    if (recent.length >= MAX_PER_SECOND) return;
    const sound = root.ShellbySound;
    // A locked screen has nobody to hear it (main doesn't know; sound.js does).
    // Animations off isn't a reason to hush: that's motion, not sound.
    if (!sound || sound.calm) return;
    const ac = sound.audio();
    const out = ac && sound.out();
    if (!out) return;
    recent.push(now);

    const tune = TUNES[occasion] || NEUTRAL;
    const falling = tune[tune.length - 1] < tune[0];
    const wobble = ((Math.random() * 2 - 1) * WOBBLE_CENTS) / 100;
    const soft = ac.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = SOFTEN_HZ;
    soft.connect(out);

    tune.forEach((semitone, i) => {
      const at = ac.currentTime + (i * NOTE_STEP_MS) / 1000;
      const s = semitone + wobble;
      const from = s + (falling ? SLIDE : -SLIDE);
      sound.tone(ac, { at, freq: hz(from), to: hz(s), ms: NOTE_MS, type: 'sine', gain: GAIN, attack: 0.006, dest: soft });
      sound.tone(ac, { at, freq: hz(from + 12), to: hz(s + 12), ms: NOTE_MS * 0.6, type: 'triangle', gain: OVERTONE_GAIN, attack: 0.004, dest: soft });
    });
  }

  root.ShellbyChirp = { play, TUNES };
})(typeof window !== 'undefined' ? window : globalThis);
