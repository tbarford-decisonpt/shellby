// How he gets from one mood to the next. Each is a body class (beats.css) set
// through critter.js's flags (how he works while Claude does is critter.js's
// own, "how he works"):
//   - a beat between moods: he winds up before he works, perks up at a
//     question, nods when you answer, and lets out a breath when it's over
//   - nodding off in stages (eyes droop, legs tuck, then the rest), and waking
//     the other way round, eyes first
//   - a question you leave waiting gets a claw tap, then a hop for your attention
// Every loop runs on the work beat (166 ms, a hair under two ticks of
// shared/framecap.js; see beats.css), so all of it together draws at most six
// frames a second.
'use strict';
(function () {
  const api = window.shellby.critter;
  const C = window.ShellbyCritter;

  // ---------------------------------------------------------------- flags
  const timers = new Map();
  function pulse(flag, ms) {
    clearTimeout(timers.get(flag));
    C.flags.add(flag);
    timers.set(flag, setTimeout(() => { timers.delete(flag); C.flags.delete(flag); C.paint(); }, ms));
  }
  function drop(flag) {
    clearTimeout(timers.get(flag));
    timers.delete(flag);
    C.flags.delete(flag);
  }

  // ---------------------------------------------------------------- between moods
  // [from, to, beat, ms]: the first that matches wins; '*' is any mood.
  // Lengths are whole steps of the work beat, so the next loop starts on it.
  const CHEERS = ['success', 'learned', 'unlocked', 'levelup', 'refreshed'];
  const BEATS = [
    ['sleeping', '*', 'waking', 1167],
    ['*', 'sleeping', 'dozing', 1333],
    ['asking', 'working', 'lead-answer', 500],
    ['*', 'asking', 'lead-ask', 500],
    ['*', 'working', 'lead-work', 500],
    ...CHEERS.map(c => [c, 'idle', 'after-win', 1000]),
    ['error', 'idle', 'after-oof', 833],
    ['working', 'idle', 'after-work', 667],
  ];
  const BEAT_FLAGS = [...new Set(BEATS.map(b => b[2]))];
  const beatFor = (from, to) => BEATS.find(([f, t]) => (f === '*' || f === from) && (t === '*' || t === to));

  function between(from, to) {
    for (const f of BEAT_FLAGS) drop(f);
    const b = beatFor(from, to);
    if (b) pulse(b[2], b[3]);
  }

  // ---------------------------------------------------------------- a question waiting
  // A claw tap after a while, then a hop now and then: he stays polite about it.
  const ASK_STEPS = [['ask-nudge', 20 * 1000], ['ask-plead', 60 * 1000]];
  let askTimers = [];
  function asking(on) {
    if (on === askTimers.length > 0) return; // already waiting, or already not
    askTimers.forEach(clearTimeout);
    askTimers = [];
    for (const [f] of ASK_STEPS) C.flags.delete(f);
    if (!on) return;
    askTimers = ASK_STEPS.map(([f, ms]) => setTimeout(() => {
      for (const [g] of ASK_STEPS) C.flags.delete(g); // one at a time: the plead takes over from the nudge
      C.flags.add(f);
      C.paint();
    }, ms));
  }

  // ---------------------------------------------------------------- his mood
  let state = 'idle';
  api.onState(msg => {
    const was = state;
    state = typeof msg?.state === 'string' ? msg.state : 'idle';
    if (state !== was) between(was, state);
    asking(state === 'asking');
    C.paint();
  });
})();
