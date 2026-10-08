// Each project's to-do list: the short notes you (or a Claude in a terminal,
// with add_task) leave for "what's next here". Kept in config.projects.todo by
// project key, shown on the project's page, and read back by next_up and
// `shellby next`. Pure.
//
// The text can come from anything that reaches the hooks port, and it is read
// back to Claude later, so it is one plain line: no control or bidi characters,
// no newlines to fake a second item with, and capped.

const MAX_TEXT = 200;
const MAX_PER_PROJECT = 30;
const MAX_PROJECTS = 200;
const FROM = ['you', 'claude', 'terminal'];
const ID = /^t-[a-z0-9]{8}$/;
const KEY = /^(github|local):.{1,490}$/s;

// Control characters and the bidi overrides that make text read differently from what it says.
const UNSAFE = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

// Invisible characters (zero-width spaces, Unicode tag characters, bidi marks):
// nothing on screen, but a model reads them. Each becomes a space (so words
// either side stay apart) and runs of spaces collapse.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
// C0 and C1 controls: a C1 CSI can still steer a terminal.
const CONTROL = /[\p{Cc}]+/gu;

/**
 * Any text that ends up in an answer a terminal prints or Claude reads (a
 * to-do, a PR title, a test name, a folder) -> one plain line.
 */
function oneLine(s) {
  return String(s ?? '').replace(INVISIBLE, ' ').replace(CONTROL, ' ').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
}

/** Anything -> one clean line of at most MAX_TEXT characters ('' when nothing is left). */
function cleanText(s) {
  return oneLine(s).slice(0, MAX_TEXT);
}

const newId = () => `t-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;

function normalizeItem(x) {
  if (!x || typeof x !== 'object' || !ID.test(x.id)) return null;
  const text = cleanText(x.text);
  if (!text) return null;
  return { id: x.id, text, from: FROM.includes(x.from) ? x.from : 'you', at: Number.isFinite(x.at) ? x.at : 0 };
}

/** config.projects.todo -> { [project key]: [{ id, text, from, at }] }, checked. */
function normalizeTodo(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, list] of Object.entries(raw).slice(0, MAX_PROJECTS)) {
    if (!KEY.test(key) || !Array.isArray(list)) continue;
    const items = list.map(normalizeItem).filter(Boolean).slice(0, MAX_PER_PROJECT);
    if (items.length) out[key] = items;
  }
  return out;
}

const listFor = (todo, key) => (Object.hasOwn(todo || {}, key) ? todo[key] : []);

/**
 * One more item on a project's list, at the end.
 *   -> { ok: true, todo, item } | { ok: false, error }
 */
function addTodo(todo, key, text, { from = 'you', now = Date.now(), id = newId } = {}) {
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, error: 'Which project?' };
  const clean = cleanText(text);
  if (!clean) return { ok: false, error: 'Nothing to add: the to-do is empty.' };
  const list = listFor(todo, key);
  if (list.length >= MAX_PER_PROJECT) return { ok: false, error: `That project already has ${MAX_PER_PROJECT} to-dos. Tick some off first.` };
  // The same note twice is the same to-do (a retried call, a double press).
  const same = list.find(x => x.text.toLowerCase() === clean.toLowerCase());
  if (same) return { ok: true, todo, item: same, existed: true };
  if (!Object.hasOwn(todo || {}, key) && Object.keys(todo || {}).length >= MAX_PROJECTS) {
    return { ok: false, error: 'Too many projects have to-do lists. Clear one out first.' };
  }
  const item = { id: id(), text: clean, from: FROM.includes(from) ? from : 'you', at: now };
  return { ok: true, todo: { ...todo, [key]: [...list, item] }, item };
}

/**
 * Tick one off (it's removed). ref: its id, or its number on the list (1 = first).
 *   -> { ok: true, todo, item } | { ok: false, error }
 */
function finishTodo(todo, key, ref) {
  const list = listFor(todo, key);
  if (!list.length) return { ok: false, error: 'That project has nothing on its to-do list.' };
  const n = typeof ref === 'number' ? ref : /^\d{1,3}$/.test(String(ref ?? '')) ? Number(ref) : NaN;
  const item = Number.isInteger(n) ? list[n - 1] : list.find(x => x.id === ref);
  if (!item) return { ok: false, error: `There's no to-do ${Number.isInteger(n) ? `number ${n}` : 'with that id'}. The list has ${list.length}.` };
  const rest = list.filter(x => x !== item);
  const next = { ...todo };
  if (rest.length) next[key] = rest;
  else delete next[key];
  return { ok: true, todo: next, item };
}

module.exports = { normalizeTodo, addTodo, finishTodo, listFor, cleanText, oneLine, MAX_TEXT, MAX_PER_PROJECT, MAX_PROJECTS, FROM, ID };
