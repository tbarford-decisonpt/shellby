// "Run this after the reset": messages and routines held until the usage
// window resets, then sent. Kept in settings so a restart (an update, a
// reboot) in the hours before the reset doesn't lose them; main.js does the
// sending and the timer.
//
// Two kinds:
//   { kind: 'message', tabId, cwd, title, text, attachments }: a message for a
//     conversation; it goes back there, reopening it from History if needed.
//   { kind: 'routine', routineId, name }: one run of a routine.
// Both carry { id, at, createdAt }: `at` is when it may go.
//
// Pure: callers pass `now` (test/held.test.js).

const { randomUUID } = require('crypto');

const MAX_HELD = 50;
const MAX_TEXT = 50000;
const MAX_FILES = 20;
const MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000; // the weekly window is the longest anyone waits
const ID_RE = /^[\w-]{1,64}$/;

const isStr = s => typeof s === 'string' && s.length > 0;

/** One item read from disk or the panel, cleaned up, or null if it can't be used. */
function clean(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at - now > MAX_WAIT_MS) return null;
  // A new item gets its id here; a saved one keeps its own, or it couldn't be cancelled by it.
  if (raw.id !== undefined && !(isStr(raw.id) && ID_RE.test(raw.id))) return null;
  const base = {
    id: raw.id ?? randomUUID(),
    at,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
  };
  if (raw.kind === 'routine') {
    if (!isStr(raw.routineId) || !ID_RE.test(raw.routineId)) return null;
    // auto: held because it came due at the limit, not because you asked.
    return { ...base, kind: 'routine', routineId: raw.routineId, name: String(raw.name || 'Routine').slice(0, 60), auto: raw.auto === true };
  }
  if (raw.kind === 'message') {
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT) : '';
    const attachments = (Array.isArray(raw.attachments) ? raw.attachments : []).filter(isStr).slice(0, MAX_FILES);
    if (!text && !attachments.length) return null;
    if (!isStr(raw.tabId) || !ID_RE.test(raw.tabId)) return null;
    return {
      ...base, kind: 'message', tabId: raw.tabId,
      cwd: isStr(raw.cwd) ? raw.cwd : null,
      title: isStr(raw.title) ? raw.title.slice(0, 120) : null,
      text, attachments,
    };
  }
  return null;
}

/** Whatever was saved, as a usable list, oldest first. */
function normalize(raw, now) {
  if (!Array.isArray(raw)) return [];
  return raw.map(r => clean(r, now)).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_HELD);
}

/**
 * The list with one more held item: { list, item } or { error }. A routine
 * already held isn't held twice; the earlier one stands.
 */
function hold(list, raw, now) {
  const item = clean({ ...raw, id: undefined, createdAt: now }, now);
  if (!item) return { error: 'There\'s nothing to hold.' };
  if (item.kind === 'routine') {
    const had = list.find(h => h.kind === 'routine' && h.routineId === item.routineId);
    if (had) return { list, item: had };
  }
  if (list.length >= MAX_HELD) return { error: `${MAX_HELD} things are already waiting for the reset.` };
  return { list: [...list, item], item };
}

const without = (list, id) => list.filter(h => h.id !== id);

/** Ready to go now, oldest first. */
const due = (list, now) => list.filter(h => h.at <= now);

/** The soonest `at`, or null when nothing's held. */
function next(list) {
  return list.length ? Math.min(...list.map(h => h.at)) : null;
}

/** These items moved to a later time (still limited, a busy tab). */
function defer(list, ids, at) {
  const move = new Set(ids);
  return list.map(h => (move.has(h.id) ? { ...h, at: Math.max(h.at, at) } : h));
}

/** "2 messages and a routine": what went, for one notification. */
function summary(items) {
  const n = k => items.filter(h => h.kind === k).length;
  const parts = [];
  const m = n('message'), r = n('routine');
  if (m) parts.push(m === 1 ? 'a held message' : `${m} held messages`);
  if (r) parts.push(r === 1 ? 'a routine' : `${r} routines`);
  return parts.join(' and ');
}

module.exports = { normalize, hold, without, due, next, defer, summary, MAX_HELD };
