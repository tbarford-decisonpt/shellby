// Shellby's chirps. Square waves straight out of WebAudio: no audio files to
// ship, nothing to decode, and it suits a pixel crab better than a sample would.
// Off unless you turn sounds on (Settings -> Look); main only sends an event
// when it's on, and never while he's guarding your focus.
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
  };
  const NOTE_MS = 55;
  const GAIN = 0.045;        // quiet enough to live behind your music
  const MAX_PER_SECOND = 4;  // a hard stop on anything that could buzz

  let ctx = null;
  let recent = [];

  function audio() {
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    // A window that was never clicked (he's focusable: false) can start
    // suspended; resuming is a no-op once it's running.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function play(occasion) {
    const now = Date.now();
    recent = recent.filter(t => now - t < 1000);
    if (recent.length >= MAX_PER_SECOND) return;
    // Someone who turned motion off wants a calm desktop; take the hint.
    if (root.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const tune = TUNES[occasion] || NEUTRAL;
    const ac = audio();
    if (!ac) return;
    recent.push(now);
    tune.forEach((semitone, i) => {
      const at = ac.currentTime + (i * NOTE_MS) / 1000;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.value = 440 * Math.pow(2, semitone / 12);
      // A quick in and out, or a square wave clicks.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(GAIN, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_MS / 1000);
      osc.connect(gain).connect(ac.destination);
      osc.start(at);
      osc.stop(at + NOTE_MS / 1000 + 0.02);
    });
  }

  root.ShellbyChirp = { play, TUNES };
})(typeof window !== 'undefined' ? window : globalThis);
