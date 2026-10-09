// Proposals from your pull requests (wiring/github.js onCiEvent): a new review
// comment offers "Address the review", as a red build already offers "Fix this
// build". Either only opens the sheet that shows what would be sent; nothing
// starts until you press Send there (wiring/startfrom.js).
//
// This decides whether to offer at all, so a pull request that keeps getting
// comments doesn't offer again and again: the same news (the same key, kind
// and stamp) is never offered twice, and the same pull request is offered
// once per COOLDOWN_MS whatever the news.
//
// Pure: callers keep the state and pass `now` (test/ci-proposals.test.js).

const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_KEPT = 200;

const create = () => new Map(); // `${type}:${key}` -> { stamp, at }

/**
 * Whether to offer, and the state after. e: { type, key, stamp } with stamp
 * whatever says the news is new (a commit, an unread count).
 * -> { propose: boolean, state }
 */
function decide(state, e, now) {
  const prev = state instanceof Map ? state : create();
  if (!e || typeof e.key !== 'string' || !e.key || typeof e.type !== 'string') return { propose: false, state: prev };
  const id = `${e.type}:${e.key}`;
  const stamp = e.stamp == null ? '' : String(e.stamp);
  const had = prev.get(id);
  if (had && (had.stamp === stamp || now - had.at < COOLDOWN_MS)) return { propose: false, state: prev };
  const next = new Map(prev);
  next.delete(id); // to the end: the oldest go first
  next.set(id, { stamp, at: now });
  while (next.size > MAX_KEPT) next.delete(next.keys().next().value);
  return { propose: true, state: next };
}

module.exports = { create, decide, COOLDOWN_MS, MAX_KEPT };
