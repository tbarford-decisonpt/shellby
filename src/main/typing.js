// Typing along, like Bongo Cat. While you type he taps his claw on a little
// keyboard; when you're fast he keeps up; hold a real burst and he looks on,
// impressed, then tells you how fast that was. keystrokes.js says *that* a key
// was let go, never which; this turns those beats into how he looks.
//
// The rhythm (step) is pure, so it's tested without a keyboard. createTyping
// wires it to keystrokes.js and his window through `deps`, like life.js, and
// only runs a timer while you're actually typing: between bursts it costs nothing.
//
// His window never sees your keystrokes' timing. It draws things other people
// made (a friend's crab, stickers), and the gaps between keys say more about
// what was typed than you'd think, so taps go over on a fixed beat instead:
// "at least one key since the last beat", never when.

const SECOND = 1000;

const WINDOW_MS = 3 * SECOND;   // your speed is measured over the last few seconds
const MIN_SPAN_MS = SECOND;     // ...and never over less than this, so two quick keys aren't 200 wpm
const STOPPED_MS = 1500;        // no key for this long: you've stopped
const FAST_KPS = 6;             // keys a second (about 70 wpm): he speeds up to keep up
const BURST_MS = 6 * SECOND;    // fast for this long: a burst, and he's impressed
const CHARS_PER_WORD = 5;       // a typing test's "word"
const MAX_KEYS = 64;            // more than three seconds of anyone's typing
const TICK_MS = 120;            // while you type: the beat he taps on, and how often the speed is read
const LEVELS = Object.freeze(['none', 'typing', 'fast']);

const emptyRhythm = () => ({ keys: [], fastSince: null, bursting: false, peak: 0 });

/** Keys a second over the recent window, 0 with fewer than two keys in it. */
function speedOf(keys, t) {
  const recent = keys.filter(k => t - k <= WINDOW_MS);
  if (recent.length < 2) return 0;
  return recent.length / (Math.max(MIN_SPAN_MS, t - recent[0]) / SECOND);
}

const wpmOf = kps => Math.round((kps * 60) / CHARS_PER_WORD);

/**
 * One beat: a key let go at `t` ({ key: true }), or only time passing.
 *   -> { state, level, wpm, burst: 'start' | 'end' | null, peak }
 * A burst starts after BURST_MS of fast typing and lasts until you stop, so
 * slowing down for a word or two doesn't end it; `peak` is its best wpm.
 */
function step(state, t, { key = false } = {}) {
  const prev = state || emptyRhythm();
  const keys = [...prev.keys.filter(k => t - k <= WINDOW_MS), ...(key ? [t] : [])].slice(-MAX_KEYS);
  const last = keys.length ? keys[keys.length - 1] : null;
  const typing = last !== null && t - last < STOPPED_MS;
  const wpm = typing ? wpmOf(speedOf(keys, t)) : 0;
  const level = !typing ? 'none' : wpm >= wpmOf(FAST_KPS) ? 'fast' : 'typing';

  let { fastSince, bursting, peak } = prev;
  let burst = null;
  if (bursting) {
    peak = Math.max(peak, wpm);
    if (level === 'none') { bursting = false; fastSince = null; burst = 'end'; }
  } else if (level === 'fast') {
    fastSince = fastSince ?? t;
    if (t - fastSince >= BURST_MS) { bursting = true; peak = wpm; burst = 'start'; }
  } else {
    fastSince = null;
  }
  return { state: { keys, fastSince, bursting, peak: bursting || burst === 'end' ? peak : 0 }, level, wpm, burst, peak };
}

/** What he says when a burst ends: a new record, or how fast that was. */
function burstLine(peak, best) {
  if (!(peak > 0)) return null;
  if (best > 0 && peak > best) return { occasion: 'typingRecord', text: `new record: ${peak} wpm!` };
  return { occasion: 'typingBurst', text: `${peak} wpm!` };
}

/**
 * deps: {
 *   watch(onKey) -> stop | null   keystrokes.watch
 *   now()                          clock
 *   settings() -> { enabled, remarks }
 *   eligible() -> bool             awake, idle and on the ground: free to tap along
 *   toCrab(channel, payload)
 *   speak(occasion, { text })      voice (cooldowns and 'quiet' apply)
 *   best() / setBest(wpm)          your fastest burst so far
 *   rand(), every(fn, ms), stopEvery(id)   optional: randomness and the tick's timer, for tests
 * }
 */
function createTyping(d) {
  const now = () => d.now?.() ?? Date.now();
  const rand = () => (d.rand ? d.rand() : Math.random());
  const every = d.every || ((fn, ms) => setInterval(fn, ms));
  const stopEvery = d.stopEvery || (id => clearInterval(id));
  let rhythm = emptyRhythm();
  let stopWatch = null;
  let available = null;          // null: not tried yet; false: the keyboard can't be heard
  let timer = null;
  let keyed = false;             // a key since the last beat
  let sent = { level: 'none', impressed: false };
  let burstSeen = false;         // he was looking on for some of this burst

  function send(level, impressed, tap) {
    if (!tap && level === sent.level && impressed === sent.impressed) return;
    sent = { level, impressed };
    d.toCrab('critter:typing', { level, impressed, tap });
  }

  // A burst he watched: remember it and say so. One he didn't see (you were
  // in a game, on a call, or he was busy working) doesn't count.
  function remark(peak) {
    const best = Number(d.best()) || 0;
    if (peak > best) d.setBest(peak);
    if (!d.settings().remarks) return;
    const line = burstLine(peak, best);
    // Half the time the number, half a line of his own about it.
    if (line) d.speak(line.occasion, { text: line.occasion === 'typingRecord' || rand() < 0.5 ? line.text : null });
  }

  function beat() {
    const r = step(rhythm, now());
    rhythm = r.state;
    const show = !!d.eligible();
    if (show && r.state.bursting) burstSeen = true;
    if (r.burst === 'end') { if (burstSeen) remark(r.peak); burstSeen = false; }
    send(show ? r.level : 'none', show && r.state.bursting, show && keyed && r.level !== 'none');
    keyed = false;
    if (r.level === 'none' && !r.state.bursting) stopTicking();
  }

  function stopTicking() { if (timer) stopEvery(timer); timer = null; }

  function onKey() {
    rhythm = step(rhythm, now(), { key: true }).state;
    keyed = true;
    if (!timer) timer = every(beat, TICK_MS);
  }

  function start() {
    if (stopWatch || !d.settings().enabled) return;
    stopWatch = d.watch(onKey);
    available = !!stopWatch;
  }

  function stop() {
    stopWatch?.();
    stopWatch = null;
    stopTicking();
    rhythm = emptyRhythm();
    keyed = burstSeen = false;
    send('none', false, false);
  }

  /** Settings changed: start or stop listening to match. */
  function sync() { if (d.settings().enabled) start(); else stop(); }

  /** His window reloaded: send what he's doing again on the next beat. */
  function resend() { sent = { level: null, impressed: null }; }

  const view = () => ({ ...d.settings(), available: available !== false, listening: !!stopWatch, best: Number(d.best()) || 0 });

  /** Tapping along right now: the idle loop leaves him be (main.js). */
  const active = () => !!sent.level && sent.level !== 'none';

  return { start, stop, sync, resend, view, active };
}

module.exports = { step, burstLine, createTyping, emptyRhythm, wpmOf, LEVELS, FAST_KPS, BURST_MS, STOPPED_MS, TICK_MS };
