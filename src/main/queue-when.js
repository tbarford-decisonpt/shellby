// When a queued task may start (held-service.js queueTask): the user picks
// per task between "when my limit resets" (the 5-hour window's reset, as
// before) and "tonight" (the next 1am, when the PC is free and you're not
// using your window). A task due tonight that finds you at your limit still
// waits for that reset: held-service.js releaseHeld defers it then.
//
// Pure: callers pass `now` and what they know about the window (test/queue-when.test.js).

const WHENS = ['reset', 'tonight'];
const NIGHT_HOUR = 1;                   // local time a "tonight" task starts
const LATE_NIGHT_END_HOUR = 5;          // queued between 1am and 5am: it's tonight already, so soon
const SOON_MS = 60 * 1000;

/** The next NIGHT_HOUR o'clock, local time (now itself if it's the small hours already). */
function nextNight(now) {
  const d = new Date(now);
  const h = d.getHours();
  if (h >= NIGHT_HOUR && h < LATE_NIGHT_END_HOUR) return now + SOON_MS;
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (h >= LATE_NIGHT_END_HOUR ? 1 : 0), NIGHT_HOUR, 0, 0, 0);
  return at.getTime();
}

/**
 * When a task queued now should start.
 * when: 'reset' | 'tonight'. resetAt: when the 5-hour window resets (with the
 * grace already added), or null when Shellby doesn't know. limited: you're at
 * the limit right now.
 * -> { at } | { error, idle? }
 */
function startAt({ when = 'reset', resetAt = null, limited = false, sawWindow = false }, now) {
  const pick = WHENS.includes(when) ? when : 'reset';
  if (pick === 'tonight') {
    const night = nextNight(now);
    // At the limit and it resets after tonight's start: nothing could run before then.
    return { at: limited && Number.isFinite(resetAt) && resetAt > night ? resetAt : night };
  }
  if (Number.isFinite(resetAt)) return { at: resetAt };
  if (sawWindow) return { error: "There's no 5-hour window running to wait for, so it would just start now. Run it as a normal task instead, or queue it for tonight.", idle: true };
  return { error: "Shellby doesn't know when your window resets yet. He finds out with your next message." };
}

module.exports = { WHENS, NIGHT_HOUR, nextNight, startAt };
