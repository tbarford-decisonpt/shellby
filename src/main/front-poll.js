'use strict';
// One read of the window in front, shared by the cover poll and the game poll
// (wiring/windows.js), and a slower beat while nothing changes.
//
// Both polls used to ask for the foreground window and describe it every two
// seconds, and describe() opens the process twice to name its exe. The window
// in front is usually the same one for minutes, so the name is kept per window
// and only the cheap part (where it is, whether it's minimized) is read again.

const FAST_MS = 2000;     // just after something changed: a game coming up, a window moving
const SLOW_MS = 5000;     // the same window, in the same place, for a while
const STILL_AFTER = 15;   // polls without a change before the beat slows (30 s)

/**
 * createFrontReader({ foreground, describe, quick }) -> read() -> info | null
 * describe(h) is the full read (exe, path, class...); quick(h) the cheap one
 * ({ gone, frame, visible, minimized, cloaked, ... }).
 */
function createFrontReader({ foreground, describe, quick }) {
  let last = null; // { h, info }
  return function read() {
    const h = foreground();
    if (!h) { last = null; return null; }
    if (last && last.h === h && last.info) {
      const q = quick(h);
      if (q && !q.gone) return (last.info = { ...last.info, ...q });
    }
    const info = describe(h);
    last = { h, info };
    return info;
  };
}

// What the poll compares to tell "nothing changed": the window, its frame and state, and whether you're away.
function signature(info, away) {
  if (!info) return `none|${away}`;
  const f = info.frame || {};
  return [info.hwnd, f.left, f.top, f.right, f.bottom, info.visible, info.minimized, info.cloaked, away].join('|');
}

/** createBeat() -> next(sig) -> ms until the next poll. */
function createBeat({ fast = FAST_MS, slow = SLOW_MS, stillAfter = STILL_AFTER } = {}) {
  let seen = null;
  let still = 0;
  return function next(sig) {
    if (sig === seen) still++;
    else { seen = sig; still = 0; }
    return still >= stillAfter ? slow : fast;
  };
}

module.exports = { createFrontReader, createBeat, signature, FAST_MS, SLOW_MS, STILL_AFTER };
