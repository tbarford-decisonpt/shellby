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

  // cap(doc, { fps, filter, setInterval, clearInterval, now }) -> { stop() }
  function cap(doc, opts = {}) {
    const fps = opts.fps || DEFAULT_FPS;
    const filter = opts.filter || (() => true);
    const every = opts.setInterval || setInterval;
    const cancel = opts.clearInterval || clearInterval;
    const now = opts.now || (() => performance.now());
    const held = new WeakSet();
    let last = now();

    function tick() {
      const t = now();
      const dt = t - last;
      last = t;
      for (const a of doc.getAnimations()) {
        if (a.playState === 'running' && filter(a)) {
          // Just started, by CSS or a script: from here on it's ours.
          a.pause();
          held.add(a);
        } else if (a.playState === 'paused' && held.has(a)) {
          step(a, dt);
        }
      }
    }

    function step(a, dt) {
      const rate = a.playbackRate || 1;
      const next = (a.currentTime || 0) + dt * rate;
      const end = a.effect?.getComputedTiming?.().endTime;
      if (rate < 0 ? next <= 0 : Number.isFinite(end) && next >= end) { // played backwards, it ends at 0
        held.delete(a);
        a.finish();
      } else {
        a.currentTime = next;
      }
    }

    const timer = every(tick, Math.round(1000 / fps));
    return { stop: () => cancel(timer), tick };
  }

  root.ShellbyFrameCap = { cap, loops, DEFAULT_FPS };
  if (typeof module !== 'undefined') module.exports = root.ShellbyFrameCap;
})(typeof window !== 'undefined' ? window : globalThis);
