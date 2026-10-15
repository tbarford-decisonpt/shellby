// Newest wins, at a pace. Main sends the whole list of conversations again every
// time any one of them moves (a token counted, a tool started, a cache warmed), and
// with a lot of busy tabs that is hundreds of messages a second. Each one used to be
// handled in full: the tab strip rebuilt and measured, the composer's chips redrawn.
// A panel that handles a message slower than they arrive falls further behind
// until they stop, and a minimized one (whose tasks Chromium delays) falls behind
// fastest, so the page freezes for as long as the backlog takes to drain.
//
// latest(run, { minMs }) -> { offer(value), flush(), cancel() }
// offer() runs `run` with the value at once when it has been quiet for minMs, else
// holds it and runs the newest one held when minMs is up. A value offered over a held
// one replaces it: nothing is handled twice and nothing piles up.
(function (root) {
  const DEFAULT_MIN_MS = 80;

  function latest(run, opts = {}) {
    const minMs = opts.minMs ?? DEFAULT_MIN_MS;
    const now = opts.now || (() => performance.now());
    const later = opts.setTimeout || setTimeout;
    const stop = opts.clearTimeout || clearTimeout;
    let lastRun = -Infinity;
    let timer = null;
    let waiting = false;
    let held;

    function fire() {
      timer = null;
      if (!waiting) return;
      const value = held;
      waiting = false;
      held = undefined;
      lastRun = now();
      run(value);
    }

    function offer(value) {
      held = value;
      waiting = true;
      if (timer !== null) return; // the run already on its way takes this one
      const wait = lastRun + minMs - now();
      if (wait <= 0) fire();
      else timer = later(fire, wait);
    }

    function flush() {
      if (timer !== null) stop(timer);
      fire();
    }

    function cancel() {
      if (timer !== null) stop(timer);
      timer = null;
      waiting = false;
      held = undefined;
    }

    return { offer, flush, cancel };
  }

  root.ShellbyLatest = { latest, DEFAULT_MIN_MS };
  if (typeof module !== 'undefined') module.exports = root.ShellbyLatest;
})(typeof window !== 'undefined' ? window : globalThis);
