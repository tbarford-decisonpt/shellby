// The background, for anyone who wants the beach in the room (Settings -> Look
// -> Background). Synthesized like everything else he plays (see sound.js):
//   surf      waves rolling in and out: low noise that swells, brightens at the
//             crest and fizzes as it breaks, never quite the same twice
//   tidepool  calmer water with the plip and trickle of a rock pool
// Main says which one through his state; it's off while he guards your focus,
// you're on a call, or the screen is locked. Unlike his chirps and bumps it
// ignores Windows' "animations off": it's a steady sound you picked by name,
// not a sudden one.
(function (root) {
  const FADE_S = 1.2;
  const FLAVORS = {
    surf:     { level: 0.10, peak: [0.6, 1], waveS: [5.5, 9], bright: [900, 1400], fizz: 0.35, plips: false },
    tidepool: { level: 0.07, peak: [0.35, 0.6], waveS: [7, 11], bright: [500, 750], fizz: 0.12, plips: true },
  };
  const FLOOR = 0.15;         // the sea never goes fully quiet between waves
  const DARK_HZ = 300;
  const PLIP_GAP_S = [0.8, 4];

  let kind = 'off';
  let chain = null;

  const between = ([lo, hi]) => lo + Math.random() * (hi - lo);

  // Brown noise (a random walk, kept from drifting off), looped: the deep
  // rumble of water. Made once.
  let brown = null;
  function brownNoise(ac) {
    if (brown) return brown;
    brown = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate);
    const d = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return brown;
  }

  function build(ac, out, flavor) {
    const src = ac.createBufferSource();
    src.buffer = brownNoise(ac);
    src.loop = true;
    const level = ac.createGain();
    level.gain.setValueAtTime(0, ac.currentTime);
    level.gain.linearRampToValueAtTime(flavor.level, ac.currentTime + FADE_S * 2);
    level.connect(out);
    // The body of the wave...
    const low = ac.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = DARK_HZ;
    const swell = ac.createGain();
    swell.gain.value = FLOOR;
    src.connect(low).connect(swell).connect(level);
    // ...and the foam where it breaks.
    const high = ac.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 2400;
    const foam = ac.createGain();
    foam.gain.value = 0;
    src.connect(high).connect(foam).connect(level);
    src.start();
    return { ac, src, level, low, swell, foam, flavor, waveTimer: null, plipTimer: null };
  }

  // One wave: in (darker to brighter, louder), the break, then the long pull back.
  function wave(c) {
    const { ac, flavor } = c;
    const at = ac.currentTime + 0.05;
    const len = between(flavor.waveS);
    const crest = at + len * 0.4;
    const peak = between(flavor.peak);
    c.swell.gain.cancelScheduledValues(at);
    c.swell.gain.setValueAtTime(c.swell.gain.value, at);
    c.swell.gain.linearRampToValueAtTime(peak, crest);
    c.swell.gain.setTargetAtTime(FLOOR, crest, len * 0.18);
    c.low.frequency.cancelScheduledValues(at);
    c.low.frequency.setValueAtTime(c.low.frequency.value, at);
    c.low.frequency.exponentialRampToValueAtTime(between(flavor.bright), crest);
    c.low.frequency.setTargetAtTime(DARK_HZ, crest, len * 0.2);
    c.foam.gain.cancelScheduledValues(at);
    c.foam.gain.setValueAtTime(0, at);
    c.foam.gain.setValueAtTime(0, crest - 0.3);
    c.foam.gain.linearRampToValueAtTime(flavor.fizz * peak, crest + 0.25);
    c.foam.gain.setTargetAtTime(0, crest + 0.25, 0.6);
    c.waveTimer = setTimeout(() => chain === c && wave(c), len * 1000);
  }

  // A drop into the pool: a sine that slides up fast. Sometimes a few in a row.
  function plip(c) {
    const { ac } = c;
    const n = Math.random() < 0.25 ? 2 + Math.floor(Math.random() * 2) : 1;
    for (let i = 0; i < n; i++) {
      const f = 550 + Math.random() * 450;
      root.ShellbySound.tone(ac, { at: ac.currentTime + i * 0.09, freq: f, to: f * 2.2, ms: 45, type: 'sine', gain: 0.18, dest: c.level });
    }
    c.plipTimer = setTimeout(() => chain === c && plip(c), between(PLIP_GAP_S) * 1000);
  }

  function stop() {
    const c = chain;
    chain = null;
    if (!c) return;
    clearTimeout(c.waveTimer);
    clearTimeout(c.plipTimer);
    const t = c.ac.currentTime;
    c.level.gain.cancelScheduledValues(t);
    c.level.gain.setValueAtTime(c.level.gain.value, t);
    c.level.gain.linearRampToValueAtTime(0, t + FADE_S);
    c.src.stop(t + FADE_S + 0.05);
    setTimeout(() => c.level.disconnect(), (FADE_S + 0.2) * 1000);
  }

  /** 'off' | 'surf' | 'tidepool'. Changing flavor fades one sea into the other. */
  function set(next) {
    const want = FLAVORS[next] ? next : 'off';
    if (want === kind) return;
    stop();
    kind = 'off';
    if (want === 'off') return;
    const sound = root.ShellbySound;
    const ac = sound?.audio();
    const out = sound?.out();
    if (!ac || !out) return; // no audio here: try again on the next state push
    const c = build(ac, out, FLAVORS[want]);
    chain = c;
    kind = want;
    wave(c);
    if (c.flavor.plips) c.plipTimer = setTimeout(() => chain === c && plip(c), between(PLIP_GAP_S) * 1000);
  }

  root.ShellbyAmbient = { set, get kind() { return kind; }, FLAVORS };
})(typeof window !== 'undefined' ? window : globalThis);
