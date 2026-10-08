// A frame clock for the transparent windows (Shellby, his pebble).
//
// A transparent window on Windows pays a GPU sync for every frame it presents,
// and Chromium presents one every vsync while any animation is running. His
// 2px breathe at 60 fps took a quarter of a 3080 Ti, more with a game fighting
// for the GPU (scripts/idle-cost.js measures it). Pixel art doesn't need 60 fps,
// so this pauses every animation the window starts, CSS or script, and moves
// them along itself a few times a second: the window then only presents when
// the clock ticks.
//
// And only when the picture would change. Most of his idle loops hold still for
// most of their length (a blink is 5% of six seconds; the claw snaps for a tenth
// of nine), so the clock reads each animation's keyframes once and moves it only
// when that tick lands in a stretch that changes, or crosses a step. Ticks in
// between cost a little arithmetic and no frame at all.
//
// Finite animations are finished through the API when their time is up, so
// `animationend`, fill modes and `finished` promises behave as before. An
// animation something else paused (animation-play-state, a script) is left
// alone: it was never this clock's.
//
// `filter` picks which animations the clock takes. The panel is opaque but just
// as costly behind a game, and it is clicked and hovered: it hands over only the
// loops (`loops`), so a hover or a tab sliding in still runs at the screen's rate.
(function (root) {
  const DEFAULT_FPS = 12;

  // Repeats forever: a spinner, a breathe, the drifting light. Never a reply to a click.
  const loops = a => a.effect?.getComputedTiming?.().iterations === Infinity;

  const NOT_VALUES = new Set(['offset', 'computedOffset', 'easing', 'composite']);

  // Where a step easing jumps, as fractions of its segment. steps(n) (jump-end,
  // the default) jumps at 1/n..1, jump-start at 0..(n-1)/n; anything else gets
  // every k/n, which is at worst one move more than it needs. A move that
  // changes nothing still presents a frame, so the default leaves out 0.
  function stepsOf(easing) {
    if (easing === 'step-end') return [1];
    if (easing === 'step-start') return [0];
    const m = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+)\s*)?\)$/.exec(String(easing || ''));
    if (!m) return null;
    const n = Math.min(Number(m[1]), 100);
    if (!(n > 0)) return null;
    const all = Array.from({ length: n + 1 }, (_, k) => k / n);
    const at = m[2] || 'end';
    if (at === 'end' || at === 'jump-end') return all.slice(1);
    if (at === 'start' || at === 'jump-start') return all.slice(0, -1);
    return all;
  }

  /**
   * Which parts of one iteration change the picture, from the keyframes:
   *   { live: [[from, to], ...], jumps: [at, ...] } in iteration progress 0..1
   * or null when it can't tell (an effect easing, a missing end keyframe, an
   * additive one...): then every tick moves it, as before.
   */
  function changesOf(effect) {
    let frames, timing;
    try { frames = effect?.getKeyframes?.(); timing = effect?.getComputedTiming?.(); } catch { return null; }
    if (!Array.isArray(frames) || frames.length < 2 || !timing) return null;
    if ((timing.easing && timing.easing !== 'linear') || timing.iterationStart) return null;
    const at = f => f.computedOffset ?? f.offset;
    if (at(frames[0]) !== 0 || at(frames[frames.length - 1]) !== 1) return null;
    const live = [];
    const jumps = [];
    for (let i = 0; i < frames.length - 1; i++) {
      const f = frames[i], g = frames[i + 1];
      if ([f, g].some(k => k.composite && k.composite !== 'auto' && k.composite !== 'replace')) return null;
      const keys = new Set([...Object.keys(f), ...Object.keys(g)].filter(k => !NOT_VALUES.has(k)));
      if ([...keys].every(k => f[k] === g[k])) continue; // holds still
      const a = at(f), b = at(g);
      if (b <= a) { jumps.push(a); continue; } // two keyframes at one offset
      const steps = stepsOf(f.easing);
      if (steps) for (const s of steps) jumps.push(a + (b - a) * s);
      else live.push([a, b]);
    }
    return { live, jumps };
  }

  // { it, p }: which iteration time t is in, and how far through it (after the
  // direction), or null when it isn't a plain looping timing.
  function progressAt(timing, t) {
    const duration = Number(timing?.duration);
    if (!(duration > 0)) return null;
    const local = t - (timing.delay || 0);
    if (local < 0) return { it: -1, p: 0 };
    const overall = local / duration;
    if (overall >= (timing.iterations ?? 1)) return { it: Infinity, p: 0 };
    const it = Math.floor(overall);
    const odd = it % 2 === 1;
    const flip = timing.direction === 'reverse' || (timing.direction === 'alternate' && odd) || (timing.direction === 'alternate-reverse' && !odd);
    const p = overall - it;
    return { it, p: flip ? 1 - p : p };
  }

  // Would the picture differ between time `from` (what's shown) and `to`?
  function changes(info, timing, from, to) {
    if (!info) return true;
    const x = progressAt(timing, from), y = progressAt(timing, to);
    if (!x || !y || x.it !== y.it) return true; // a loop coming round: one move per lap
    const lo = Math.min(x.p, y.p), hi = Math.max(x.p, y.p);
    if (hi <= lo) return false;
    return info.live.some(([a, b]) => a < hi && b > lo) || info.jumps.some(j => j !== x.p && j >= lo && j <= hi); // a step right where it's drawn is already showing
  }

  // cap(doc, { fps, filter, setInterval, clearInterval, now }) -> { stop() }
  function cap(doc, opts = {}) {
    const fps = opts.fps || DEFAULT_FPS;
    const filter = opts.filter || (() => true);
    const every = opts.setInterval || setInterval;
    const cancel = opts.clearInterval || clearInterval;
    const now = opts.now || (() => performance.now());
    // animation -> { t: where the clock has it, shown: where it was last moved to, info }
    const held = new WeakMap();
    let last = now();

    function tick() {
      const t = now();
      const dt = t - last;
      last = t;
      for (const a of doc.getAnimations()) {
        if (a.playState === 'running' && filter(a)) {
          // Just started, by CSS or a script: from here on it's ours.
          a.pause();
          const at = a.currentTime || 0;
          held.set(a, { t: at, shown: at, info: undefined });
        } else if (a.playState === 'paused' && held.has(a)) {
          step(a, held.get(a), dt);
        }
      }
    }

    function step(a, h, dt) {
      // Moved by someone else since (a script seeking it): carry on from there.
      if ((a.currentTime || 0) !== h.shown) h.t = h.shown = a.currentTime || 0;
      const rate = a.playbackRate || 1;
      const next = h.t + dt * rate;
      const timing = a.effect?.getComputedTiming?.();
      const end = timing?.endTime;
      if (rate < 0 ? next <= 0 : Number.isFinite(end) && next >= end) { // played backwards, it ends at 0
        held.delete(a);
        a.finish();
        return;
      }
      h.t = next;
      if (h.info === undefined) h.info = changesOf(a.effect);
      if (!changes(h.info, timing, h.shown, next)) return; // nothing new to draw
      a.currentTime = next;
      h.shown = next;
    }

    const timer = every(tick, Math.round(1000 / fps));
    return { stop: () => cancel(timer), tick };
  }

  root.ShellbyFrameCap = { cap, loops, changesOf, changes, stepsOf, DEFAULT_FPS };
  if (typeof module !== 'undefined') module.exports = root.ShellbyFrameCap;
})(typeof window !== 'undefined' ? window : globalThis);
