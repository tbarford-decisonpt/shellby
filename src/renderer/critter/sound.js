// Shellby's sound engine: one AudioContext, one master volume, and the little
// noises his body makes (scuttling feet, a hop, a bump off the screen's edge, a
// thump on landing, a ta-da). All synthesized here, so there are no audio files
// to ship. What may play comes from main as part of his state (src/main/sounds.js):
// main is the one that knows about your focus, your calls and the settings.
// chirp.js (his voice) and ambient.js (the background) play through this.
(function (root) {
  const BASE_VOLUME = 60;          // the volume the chirp was tuned at; the bus is 1.0 there
  const STEP_GAIN = 0.05;
  const TICK_MS_PER_SPEED = 5000;  // footstep gap = this / walking speed (DIP/s)
  const STEP_MIN_MS = 50;
  const STEP_MAX_MS = 160;
  const QUIET_SUSPEND_MS = 5000;   // past the longest cue (a fanfare, ~1.2 s) and the sea's fade-out
  // The least time between two of the same cue, so a flurry of bounces is a
  // patter rather than a buzz.
  const MIN_GAP_MS = {
    bounce: 70, land: 250, hop: 150, tada: 1500, fanfare: 2500, sparkle: 800, slap: 400, crit: 2500, landing: 2500,
    // Bug battles (src/main/bugdex/battle.js), asked for by the panel's battle screen.
    battle: 1500, boss: 2500, hit: 120, super: 300, smash: 600, miss: 200, heal: 300, resist: 300,
    faint: 800, lower: 400, caught: 1500, badge: 2500, fled: 800, cry: 600,
  };

  let ctx = null;
  let bus = null;
  let mix = { voice: false, fx: false, ambient: 'off', volume: BASE_VOLUME };
  let calm = false;
  let suspendTimer = null;
  let suspending = null; // the suspend() under way, until it settles
  let stepTimer = null;
  let stepN = 0;
  const lastAt = {};

  const reduced = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const busGain = () => mix.volume / BASE_VOLUME;

  // Made the first time something actually plays: a crab with every sound off
  // never opens an audio device.
  function audio() {
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) {
      ctx = new Ctor();
      bus = ctx.createGain();
      bus.gain.value = busGain();
      bus.connect(ctx.destination);
    }
    // A window that was never clicked (he's focusable: false) can start
    // suspended, and a quiet spell suspends it (below); resuming is a no-op once
    // it's running. A suspended context's clock is stopped too, so whatever is
    // scheduled now plays from its start once the device is back: nothing clipped.
    clearTimeout(suspendTimer);
    if (!calm) wake();
    restLater();
    return ctx;
  }

  // suspend() takes a moment, and the state still reads 'running' until it's done:
  // a sound arriving then would be scheduled on a clock about to stop. So a
  // sound in that moment resumes once the suspend has gone through.
  function rest() {
    suspending = ctx.suspend().catch(() => {}).finally(() => { suspending = null; });
  }
  function wake() {
    if (suspending) suspending.then(() => { if (!calm) ctx.resume().catch(() => {}); });
    else if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // A running AudioContext keeps the audio device and its thread busy mixing
  // silence (about 1% of a core between this window and the audio service), so
  // a few quiet seconds after the last sound it's suspended. The sea, or his
  // feet still scuttling, keep it going.
  function restLater() {
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      if (!ctx || ctx.state !== 'running' || stepTimer || (root.ShellbyAmbient?.kind || 'off') !== 'off') return;
      rest();
    }, QUIET_SUSPEND_MS);
  }

  const out = () => (audio() ? bus : null);

  // ---- building blocks
  function tone(ac, { at, freq, to = freq, ms, type = 'square', gain, attack = 0.006, dest = bus }) {
    const end = at + ms / 1000;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, end);
    // A quick in and out, or the wave clicks.
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g).connect(dest);
    osc.start(at);
    osc.stop(end + 0.02);
  }

  let noiseBuf = null;
  function noise(ac, { at, ms, freq, q = 1, type = 'bandpass', gain, dest = bus }) {
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const end = at + ms / 1000;
    const src = ac.createBufferSource();
    const f = ac.createBiquadFilter();
    const g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(f).connect(g).connect(dest);
    src.start(at, Math.random() * 0.4);
    src.stop(end + 0.02);
  }

  const hz = semitone => 440 * Math.pow(2, semitone / 12);

  // A note with a little brass to it: two detuned saws through a soft filter.
  function horn(ac, at, semitone, ms, gain) {
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2200;
    f.connect(bus);
    tone(ac, { at, freq: hz(semitone), ms, type: 'sawtooth', gain, dest: f });
    tone(ac, { at, freq: hz(semitone) * 1.006, ms, type: 'sawtooth', gain: gain * 0.7, dest: f });
  }

  // ---- the cues. Each takes the AudioContext, its start time and a strength
  // from 0 to 1 (how hard he hit, say).
  const CUES = {
    // One claw-tip on the desk. Alternate feet sound a touch different.
    step(ac, at, n) {
      noise(ac, { at, ms: 14, freq: n % 2 ? 3400 : 2600, q: 6, gain: STEP_GAIN });
    },
    hop(ac, at) {
      tone(ac, { at, freq: 320, to: 760, ms: 110, type: 'sine', gain: 0.07 });
    },
    // A bump: a high bonk off the side, a lower boing off the floor.
    bounce(ac, at, strength, hit) {
      const base = hit === 'wall' ? 520 : hit === 'ceiling' ? 640 : 260;
      const g = 0.03 + 0.05 * strength;
      tone(ac, { at, freq: base * 1.4, to: base, ms: 90, type: 'triangle', gain: g });
      noise(ac, { at, ms: 25, freq: 900, q: 2, gain: g * 0.8 });
    },
    land(ac, at, strength) {
      tone(ac, { at, freq: 150, to: 55, ms: 140, type: 'sine', gain: 0.06 + 0.06 * strength });
      noise(ac, { at, ms: 70, freq: 400, type: 'lowpass', gain: 0.05 });
    },
    // "ta-da!": a short pickup, then the chord.
    tada(ac, at) {
      horn(ac, at, 3, 90, 0.025);              // C5
      [3, 7, 10].forEach(s => horn(ac, at + 0.13, s + 12, 520, 0.018)); // C6 E6 G6
    },
    // Level up: up the arpeggio, then the chord.
    fanfare(ac, at) {
      [3, 7, 10, 15].forEach((s, i) => horn(ac, at + i * 0.09, s, 110, 0.022));
      [15, 19, 22].forEach(s => horn(ac, at + 0.4, s, 700, 0.016));
    },
    // A critical hit (src/main/surprises.js): a quick run up the scale, then
    // the chord with a glint on top. Short, because the surprise is the point.
    crit(ac, at) {
      [0, 4, 7, 12, 16].forEach((s, i) => tone(ac, { at: at + i * 0.045, freq: hz(s + 15), ms: 70, gain: 0.018 }));
      [15, 19, 22, 27].forEach(s => horn(ac, at + 0.25, s, 620, 0.014));
      [34, 39].forEach((s, i) => tone(ac, { at: at + 0.3 + i * 0.09, freq: hz(s), ms: 220, type: 'triangle', gain: 0.02 }));
    },
    // A clean landing: swooping in, a soft touchdown, then the chord.
    landing(ac, at) {
      tone(ac, { at, freq: hz(22), to: hz(10), ms: 280, type: 'triangle', gain: 0.025 });
      noise(ac, { at: at + 0.28, ms: 70, freq: 450, type: 'lowpass', gain: 0.05 });
      [10, 15, 19].forEach(s => horn(ac, at + 0.34, s, 520, 0.015));
    },
    sparkle(ac, at) {
      [24, 28, 31, 36].forEach((s, i) => tone(ac, { at: at + i * 0.05, freq: hz(s), ms: 140, type: 'triangle', gain: 0.03 }));
    },
    // A sticker smacked onto his shell.
    slap(ac, at) {
      noise(ac, { at, ms: 40, freq: 1800, q: 1.5, gain: 0.09 });
      tone(ac, { at: at + 0.01, freq: hz(19), ms: 60, gain: 0.02 });
    },

    // ---- bug battles: chiptune, like the handhelds they're a nod to.
    // A wild bug: a tumble down the scale and a jab back up.
    battle(ac, at) {
      [24, 22, 20, 18, 16, 14, 12, 10].forEach((s, i) => tone(ac, { at: at + i * 0.035, freq: hz(s), ms: 45, gain: 0.016 }));
      [3, 10, 15].forEach((s, i) => tone(ac, { at: at + 0.32 + i * 0.07, freq: hz(s), ms: 120, gain: 0.02 }));
    },
    // A boss or the league: a low rumble under a minor chord.
    boss(ac, at) {
      noise(ac, { at, ms: 600, freq: 120, type: 'lowpass', gain: 0.08 });
      [-21, -14, -9].forEach(s => horn(ac, at + 0.05, s, 900, 0.02));
      [3, 6, 10].forEach((s, i) => tone(ac, { at: at + 0.5 + i * 0.12, freq: hz(s), ms: 160, gain: 0.018 }));
    },
    hit(ac, at) {
      noise(ac, { at, ms: 70, freq: 2400, q: 0.8, gain: 0.07 });
      tone(ac, { at, freq: 220, to: 90, ms: 90, gain: 0.03 });
    },
    super(ac, at) {
      [0, 0.09].forEach(dt => noise(ac, { at: at + dt, ms: 80, freq: 3000, q: 0.7, gain: 0.08 }));
      tone(ac, { at, freq: 330, to: 70, ms: 200, gain: 0.035 });
    },
    smash(ac, at) {
      noise(ac, { at, ms: 160, freq: 1600, q: 0.5, gain: 0.1 });
      tone(ac, { at, freq: 440, to: 55, ms: 260, type: 'sawtooth', gain: 0.03 });
      [27, 31, 34].forEach((s, i) => tone(ac, { at: at + 0.2 + i * 0.05, freq: hz(s), ms: 120, type: 'triangle', gain: 0.02 }));
    },
    miss(ac, at) {
      tone(ac, { at, freq: 500, to: 1400, ms: 160, type: 'triangle', gain: 0.02 });
    },
    heal(ac, at) {
      [12, 16, 19, 24].forEach((s, i) => tone(ac, { at: at + i * 0.06, freq: hz(s), ms: 180, type: 'sine', gain: 0.025 }));
    },
    resist(ac, at) {
      tone(ac, { at, freq: 140, to: 110, ms: 160, gain: 0.03 });
      noise(ac, { at, ms: 50, freq: 600, q: 2, gain: 0.05 });
    },
    // Fainting: the long slide down.
    faint(ac, at) {
      tone(ac, { at, freq: 700, to: 60, ms: 650, gain: 0.025 });
    },
    // The specimen jar lowered on its line: a reel ticking out.
    lower(ac, at) {
      for (let i = 0; i < 6; i++) noise(ac, { at: at + i * 0.08, ms: 14, freq: 3600, q: 6, gain: 0.04 });
      tone(ac, { at, freq: 900, to: 520, ms: 480, type: 'sine', gain: 0.012 });
    },
    // The cork goes on: a click, then the little tune.
    caught(ac, at) {
      noise(ac, { at, ms: 30, freq: 3200, q: 3, gain: 0.08 });
      [15, 19, 22].forEach((s, i) => tone(ac, { at: at + 0.15 + i * 0.1, freq: hz(s), ms: 110, gain: 0.02 }));
      [15, 19, 22, 27].forEach(s => horn(ac, at + 0.48, s, 600, 0.013));
    },
    // A badge, or the Hall of Fame.
    badge(ac, at) {
      [3, 7, 10, 15, 19].forEach((s, i) => horn(ac, at + i * 0.08, s, 120, 0.02));
      [15, 19, 22, 27].forEach(s => horn(ac, at + 0.45, s, 900, 0.014));
      [34, 39, 43].forEach((s, i) => tone(ac, { at: at + 0.6 + i * 0.08, freq: hz(s), ms: 260, type: 'triangle', gain: 0.018 }));
    },
    // It got away: scurrying off.
    fled(ac, at) {
      for (let i = 0; i < 5; i++) noise(ac, { at: at + i * 0.06, ms: 18, freq: 3000 - i * 300, q: 5, gain: 0.05 });
    },
    // Every species has its own call, worked out from its dex number: the
    // same bug always sounds the same. Its type picks the wave, its rarity how
    // deep it goes.
    cry(ac, at, _strength, _hit, data) {
      const no = Number.isInteger(data?.no) ? data.no : 1;
      let seed = (no * 2654435761) >>> 0;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const WAVE = { runtime: 'square', io: 'triangle', net: 'sine', vcs: 'sawtooth', ci: 'square', build: 'sawtooth', types: 'triangle', py: 'sine', sys: 'sawtooth', test: 'square', sec: 'triangle', ghost: 'sine' };
      const DEPTH = { common: 12, uncommon: 7, rare: 2, legendary: -5, special: 0 };
      const type = WAVE[data?.type] || 'square';
      const base = (DEPTH[data?.rarity] ?? 10) + Math.floor(rnd() * 6);
      const notes = 3 + Math.floor(rnd() * 3);
      let t = at;
      for (let i = 0; i < notes; i++) {
        const s = base + Math.floor(rnd() * 9) - 3;
        const ms = 60 + Math.floor(rnd() * 70);
        const slide = rnd() < 0.5 ? hz(s + (rnd() < 0.5 ? 4 : -4)) : hz(s);
        tone(ac, { at: t, freq: hz(s), to: slide, ms, type, gain: type === 'sine' ? 0.035 : 0.018 });
        t += ms / 1000 * 0.8;
      }
      if (data?.type === 'ghost') tone(ac, { at, freq: hz(base + 12), to: hz(base + 5), ms: (t - at) * 1000 + 200, type: 'sine', gain: 0.012 });
    },
  };

  /**
   * Play a cue if effects are on. strength 0..1; hit: what a bounce bumped.
   * Returns whether it played.
   */
  function cue(name, { strength = 0.5, hit = null, data = null } = {}) {
    const play = CUES[name];
    if (!play || calm) return false;
    if (!mix.fx || reduced()) return false;
    const now = Date.now();
    if (now - (lastAt[name] || 0) < (MIN_GAP_MS[name] || 0)) return false;
    const ac = audio();
    if (!ac) return false;
    lastAt[name] = now;
    play(ac, ac.currentTime, Math.max(0, Math.min(1, strength)), hit, data);
    return true;
  }

  // ---- scuttling: little clicks for as long as he walks, quicker the faster he goes.
  function scuttle(speed) {
    clearTimeout(stepTimer);
    stepTimer = null;
    if (!speed || !mix.fx || calm || reduced()) return;
    const gap = Math.max(STEP_MIN_MS, Math.min(STEP_MAX_MS, TICK_MS_PER_SPEED / speed));
    const tick = () => {
      const ac = audio();
      if (ac && Math.random() > 0.08) CUES.step(ac, ac.currentTime, stepN++); // the odd missed step sounds less like a metronome
      stepTimer = setTimeout(tick, gap * (0.85 + Math.random() * 0.3));
    };
    tick();
  }

  /** The mix from main ({ voice, fx, ambient, volume }), with every state push. */
  function setMix(next) {
    if (!next || typeof next !== 'object') return;
    mix = {
      voice: !!next.voice,
      fx: !!next.fx,
      ambient: typeof next.ambient === 'string' ? next.ambient : 'off',
      volume: Number.isFinite(next.volume) ? Math.max(0, Math.min(100, next.volume)) : BASE_VOLUME,
    };
    if (!mix.fx) scuttle(0);
    if (bus) bus.gain.setTargetAtTime(busGain(), ctx.currentTime, 0.05);
    root.ShellbyAmbient?.set(calm ? 'off' : mix.ambient);
    if (ctx && !calm) restLater(); // the sea just switched off: rest once it has faded
  }

  /** The screen is locked (not merely covered): nothing to hear. Let the audio device rest. */
  function setCalm(on) {
    calm = !!on;
    if (calm) scuttle(0);
    root.ShellbyAmbient?.set(calm ? 'off' : mix.ambient);
    if (!ctx) return;
    clearTimeout(suspendTimer);
    if (calm) suspendTimer = setTimeout(rest, 1500); // after the fade-out
    else if (mix.ambient !== 'off') wake(); // the next sound resumes it otherwise
  }

  root.ShellbySound = {
    audio, out, cue, scuttle, setMix, setCalm, tone, noise, reduced,
    get mix() { return mix; },
    get opened() { return !!ctx; },
    get calm() { return calm; },
    CUES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
