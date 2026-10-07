// Notes: things you'd like to do, kept per project, plus one General list for
// ideas that aren't tied to a project yet. Each note can be handed to Claude
// three ways (main.js runs them):
//   plan  - the note as written, in Plan mode
//   build - the note as written, in your current mode
//   ask   - "should I do this?", read-only (askPrompt below)
//
// Kept apart from streaks on purpose: streaks forgets projects that go quiet,
// and an idea list shouldn't vanish because you took a month off.
// Pure: no I/O, no clock (callers pass `now` and ids). See test/notes.test.js.

const GENERAL = 'general';
const MAX_NOTES = 100;      // per list
const MAX_TEXT = 2000;
const MAX_PROJECTS = 100;
const KINDS = ['plan', 'build', 'ask'];

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
// A note keeps its line breaks; every other control character goes.
const cleanText = s => (typeof s === 'string'
  ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT)
  : '');

function normalizeNote(n) {
  if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || n.id.length > 64) return null;
  const text = cleanText(n.text);
  if (!text) return null;
  const r = n.lastRun;
  return {
    id: n.id, text,
    createdAt: Number.isFinite(n.createdAt) ? n.createdAt : 0,
    done: !!n.done,
    lastRun: r && KINDS.includes(r.kind) && Number.isFinite(r.at) ? { kind: r.kind, at: r.at, tabId: typeof r.tabId === 'string' ? r.tabId : null } : null,
  };
}

function normalizeList(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(normalizeNote).filter(n => n && !seen.has(n.id) && seen.add(n.id)).slice(0, MAX_NOTES);
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const projects = {};
  for (const [key, p] of Object.entries(src.projects && typeof src.projects === 'object' ? src.projects : {}).slice(0, MAX_PROJECTS)) {
    if (!p || typeof p !== 'object' || !key || key === GENERAL || key.length > 400) continue;
    const notes = normalizeList(p.notes);
    if (!notes.length) continue;   // an emptied project leaves the store
    projects[key] = { name: clip(p.name, 60) || 'project', root: typeof p.root === 'string' && p.root ? p.root : key, notes };
  }
  return { general: normalizeList(src.general), projects };
}

const listOf = (s, scope) => (scope === GENERAL ? s.general : s.projects[scope]?.notes || []);

function withList(s, scope, notes, project) {
  if (scope === GENERAL) return { ...s, general: notes };
  const prev = s.projects[scope] || project;
  const projects = { ...s.projects };
  if (notes.length) projects[scope] = { name: clip(prev?.name, 60) || 'project', root: prev?.root || scope, notes };
  else delete projects[scope];
  return { ...s, projects };
}

/**
 * Add a note to a list. scope: GENERAL or a project key; project: { name, root }
 * for a project that has no notes yet. Newest first.
 * -> { state, note } or { state, error }
 */
function add(stateIn, scope, text, { id, now, project } = {}) {
  const s = normalize(stateIn);
  const t = cleanText(text);
  if (!t) return { state: s, error: 'Write something first.' };
  if (!scope || (scope !== GENERAL && !s.projects[scope] && !project)) return { state: s, error: 'Pick a project for that note.' };
  const list = listOf(s, scope);
  if (list.length >= MAX_NOTES) return { state: s, error: `That list is full (${MAX_NOTES} notes). Delete some first.` };
  if (scope !== GENERAL && !s.projects[scope] && Object.keys(s.projects).length >= MAX_PROJECTS) return { state: s, error: 'That is a lot of projects with notes. Clear one out first.' };
  const note = { id, text: t, createdAt: now, done: false, lastRun: null };
  return { state: withList(s, scope, [note, ...list], project), note };
}

/** Edit a note's text or tick it off. An emptied text leaves the note as it was. */
function update(stateIn, scope, id, patch = {}) {
  const s = normalize(stateIn);
  const list = listOf(s, scope);
  if (!list.some(n => n.id === id)) return s;
  return withList(s, scope, list.map(n => {
    if (n.id !== id) return n;
    const next = { ...n };
    if ('text' in patch) { const t = cleanText(patch.text); if (t) next.text = t; }
    if ('done' in patch) next.done = !!patch.done;
    return next;
  }));
}

function remove(stateIn, scope, id) {
  const s = normalize(stateIn);
  return withList(s, scope, listOf(s, scope).filter(n => n.id !== id));
}

/** Move a note to another list (General to a project, or back). project: as for add(). */
function move(stateIn, from, id, to, { project } = {}) {
  const s = normalize(stateIn);
  const note = listOf(s, from).find(n => n.id === id);
  if (!note || from === to) return { state: s };
  if (to !== GENERAL && !s.projects[to] && !project) return { state: s, error: 'Pick a project for that note.' };
  if (listOf(s, to).length >= MAX_NOTES) return { state: s, error: `That list is full (${MAX_NOTES} notes). Delete some first.` };
  const moved = withList(withList(s, from, listOf(s, from).filter(n => n.id !== id)), to, [note, ...listOf(s, to)], project);
  return { state: moved };
}

/** Remember that a note was handed to Claude, and which tab it opened. */
function markRun(stateIn, scope, id, { kind, tabId, at }) {
  const s = normalize(stateIn);
  const list = listOf(s, scope);
  if (!KINDS.includes(kind) || !list.some(n => n.id === id)) return s;
  return withList(s, scope, list.map(n => (n.id === id ? { ...n, lastRun: { kind, tabId: tabId || null, at } } : n)));
}

const find = (stateIn, scope, id) => listOf(normalize(stateIn), scope).find(n => n.id === id) || null;

/**
 * "Should I do this?" Read-only: asks for a verdict on the idea, from what's
 * actually in the project, and not to start on it. `name` is the folder it runs in.
 */
function askPrompt(text, name) {
  const project = clip(name, 60) || 'this project';
  return [
    `I'm thinking about doing this in ${project}:`,
    '',
    '"""',
    cleanText(text),
    '"""',
    '',
    "Before I spend time on it, tell me honestly whether it's a good idea.",
    '',
    '1. Look around the project first: does something like this already exist, what would it touch, and does it clash with how things work now?',
    '2. Start with your verdict on a line of its own: "Do it", "Do it differently" or "Skip it".',
    '3. Then say why in a few bullets, from what you found here rather than general advice.',
    '4. Roughly how big a job it is, and what could go wrong.',
    "5. If you'd do it differently, say how. If something needs deciding before anyone starts, list it.",
    '',
    "Don't just agree with me. If it isn't worth the effort, or there's a simpler way, say so.",
    "Read only: don't edit or create files, commit, or start on it. This is a question, not the task.",
  ].join('\n');
}

module.exports = { GENERAL, MAX_NOTES, MAX_TEXT, KINDS, normalize, add, update, remove, move, markRun, find, askPrompt };
