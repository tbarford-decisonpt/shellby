// "Run this after the reset": messages and routines held until the usage
// window resets, then sent. Kept in settings so a restart (an update, a
// reboot) in the hours before the reset doesn't lose them; main.js does the
// sending and the timer.
//
// Three kinds:
//   { kind: 'message', tabId, cwd, title, text, attachments }: a message for a
//     conversation; it goes back there, reopening it from History if needed.
//   { kind: 'routine', routineId, name }: one run of a routine.
//   { kind: 'task', prompt, cwd, mode, name, tabId, tries, model?, when? }: heavy work queued
//     for a fresh window ("refactor X overnight"). Tasks go one after another,
//     each waiting for the last to finish. Once one starts it keeps its tabId:
//     if the window runs dry partway, or Shellby restarts, it stays queued and
//     the next pass carries on in that conversation instead of starting over.
// All carry { id, at, createdAt }: `at` is when it may go.
//
// Pure: callers pass `now` (test/held.test.js).

const { randomUUID } = require('crypto');
const { isModel } = require('./models');

const MAX_HELD = 50;
const MAX_TEXT = 50000;
const MAX_FILES = 20;
const MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000; // the weekly window is the longest anyone waits
const MAX_TRIES = 3; // starts of one task (first go, then carrying on) before it's given up on
const TASK_MODES = ['ask', 'smart', 'acceptEdits', 'plan', 'autonomous'];
const ID_RE = /^[\w-]{1,64}$/;

const isStr = s => typeof s === 'string' && s.length > 0;

/** "Refactor the auth module so…" -> a name short enough for a chip and a phone. */
function taskName(prompt) {
  const line = prompt.split('\n').find(l => l.trim()) || 'Queued task';
  const t = line.trim().replace(/\s+/g, ' ');
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}

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
  if (raw.kind === 'task') {
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim().slice(0, MAX_TEXT) : '';
    if (!prompt) return null;
    const tries = Number.isInteger(raw.tries) && raw.tries > 0 ? Math.min(raw.tries, MAX_TRIES) : 0;
    return {
      ...base, kind: 'task', prompt,
      name: isStr(raw.name) && raw.name.trim() ? taskName(raw.name) : taskName(prompt),
      cwd: isStr(raw.cwd) ? raw.cwd : null,
      // From the phone: always Ask first, in its own copy, and its prompts go back to the phone.
      mode: raw.fromPhone === true ? 'ask' : TASK_MODES.includes(raw.mode) ? raw.mode : null,
      tabId: isStr(raw.tabId) && ID_RE.test(raw.tabId) ? raw.tabId : null,
      tries,
      ...(raw.fromPhone === true ? { fromPhone: true } : {}),
      // Queued for tonight rather than the reset (queue-when.js): only what the list says.
      ...(raw.when === 'tonight' ? { when: 'tonight' } : {}),
      // Its own model ('' or none: the one Settings picks).
      ...(isStr(raw.model) && isModel(raw.model) ? { model: raw.model } : {}),
    };
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
  // A new task hasn't started anywhere yet, whatever came in.
  const fresh = raw?.kind === 'task' ? { tabId: null, tries: 0 } : {};
  const item = clean({ ...raw, ...fresh, id: undefined, createdAt: now }, now);
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

/** A task has started in this conversation: one more try, and where to carry on. */
function started(list, id, tabId) {
  return list.map(h => (h.id === id && h.kind === 'task' ? { ...h, tabId, tries: h.tries + 1 } : h));
}

/** Has this task been started as often as it may be? */
const spent = h => h.kind === 'task' && h.tries >= MAX_TRIES;

/** "2 messages, a routine and 3 queued tasks": what went, for one notification. */
function summary(items) {
  const n = k => items.filter(h => h.kind === k).length;
  const parts = [];
  const m = n('message'), r = n('routine'), t = n('task');
  if (m) parts.push(m === 1 ? 'a held message' : `${m} held messages`);
  if (r) parts.push(r === 1 ? 'a routine' : `${r} routines`);
  if (t) parts.push(t === 1 ? 'a queued task' : `${t} queued tasks`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('');
}

module.exports = { normalize, hold, without, due, next, defer, started, spent, summary, taskName, MAX_HELD, MAX_TRIES, TASK_MODES };
