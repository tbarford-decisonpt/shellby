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
const MAX_RUNS = 5;         // per note, newest first
const MAX_FROM_CLAUDE = 10; // open notes Claude added (the `note` tool), per list
const MAX_REPLY = 4000;     // of an Ask reply, read for its verdict
const KINDS = ['plan', 'build', 'ask'];
const VERDICTS = ['do', 'differently', 'skip'];

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
// A note keeps its line breaks; every other control character goes.
const cleanText = s => (typeof s === 'string'
  ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT)
  : '');

function normalizeRun(r) {
  if (!r || typeof r !== 'object' || !KINDS.includes(r.kind) || !Number.isFinite(r.at)) return null;
  const run = { kind: r.kind, at: r.at, tabId: typeof r.tabId === 'string' ? r.tabId : null };
  return r.kind === 'ask' && VERDICTS.includes(r.verdict) ? { ...run, verdict: r.verdict } : run;
}

function normalizeNote(n) {
  if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || n.id.length > 64) return null;
  const text = cleanText(n.text);
  if (!text) return null;
  // Before run history, a note kept only its last run.
  const runs = (Array.isArray(n.runs) ? n.runs : n.lastRun ? [n.lastRun] : []).map(normalizeRun).filter(Boolean).slice(0, MAX_RUNS);
  return {
    id: n.id, text,
    createdAt: Number.isFinite(n.createdAt) ? n.createdAt : 0,
    done: !!n.done,
    pinned: !!n.pinned,
    // Who put it there: you, or Claude with the `note` tool. Claude's run as a draft you read first.
    from: n.from === 'claude' ? 'claude' : 'you',
    runs,
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
function add(stateIn, scope, text, { id, now, project, from = 'you' } = {}) {
  const s = normalize(stateIn);
  const t = cleanText(text);
  if (!t) return { state: s, error: 'Write something first.' };
  if (!scope || (scope !== GENERAL && !s.projects[scope] && !project)) return { state: s, error: 'Pick a project for that note.' };
  const list = listOf(s, scope);
  if (list.length >= MAX_NOTES) return { state: s, error: `That list is full (${MAX_NOTES} notes). Delete some first.` };
  if (scope !== GENERAL && !s.projects[scope] && Object.keys(s.projects).length >= MAX_PROJECTS) return { state: s, error: 'That is a lot of projects with notes. Clear one out first.' };
  const byClaude = from === 'claude';
  if (byClaude && list.filter(n => n.from === 'claude' && !n.done).length >= MAX_FROM_CLAUDE) {
    return { state: s, error: `That list already has ${MAX_FROM_CLAUDE} open notes from Claude. Ask the user to go through them first.` };
  }
  const note = { id, text: t, createdAt: now, done: false, pinned: false, from: byClaude ? 'claude' : 'you', runs: [] };
  return { state: withList(s, scope, [note, ...list], project), note };
}

/** Edit a note's text, tick it off or pin it. An emptied text leaves the note as it was. */
function update(stateIn, scope, id, patch = {}) {
  const s = normalize(stateIn);
  const list = listOf(s, scope);
  if (!list.some(n => n.id === id)) return s;
  return withList(s, scope, list.map(n => {
    if (n.id !== id) return n;
    const next = { ...n };
    // Text you've rewritten is yours, whoever wrote it first.
    if ('text' in patch) { const t = cleanText(patch.text); if (t && t !== n.text) { next.text = t; next.from = 'you'; } }
    if ('done' in patch) next.done = !!patch.done;
    if ('pinned' in patch) next.pinned = !!patch.pinned;
    return next;
  }));
}

/** Take a note out. -> { state, removed: [{ note, at }] } (at: where it was, for restore()). */
function remove(stateIn, scope, id) {
  const s = normalize(stateIn);
  const list = listOf(s, scope);
  const at = list.findIndex(n => n.id === id);
  if (at < 0) return { state: s, removed: [] };
  return { state: withList(s, scope, list.filter(n => n.id !== id)), removed: [{ note: list[at], at }] };
}

/** Clear every ticked-off note from a list. -> { state, removed } as for remove(). */
function clearDone(stateIn, scope) {
  const s = normalize(stateIn);
  const list = listOf(s, scope);
  const removed = list.map((note, at) => ({ note, at })).filter(r => r.note.done);
  return { state: withList(s, scope, list.filter(n => !n.done)), removed };
}

/**
 * Undo a remove() or clearDone(): the notes back where they were. They come from
 * the panel, so each is cleaned up as a stored one is; one whose id is back
 * already, or that would overfill the list, stays out. project: as for add().
 */
function restore(stateIn, scope, removed, { project } = {}) {
  const s = normalize(stateIn);
  if (scope !== GENERAL && !s.projects[scope] && !project) return { state: s, error: 'Pick a project for that note.' };
  const list = [...listOf(s, scope)];
  const ids = new Set(list.map(n => n.id));
  const back = (Array.isArray(removed) ? removed.slice(0, MAX_NOTES) : [])
    .map(r => ({ note: normalizeNote(r?.note), at: Number.isInteger(r?.at) ? r.at : 0 }))
    .filter(r => r.note && !ids.has(r.note.id) && ids.add(r.note.id))
    .sort((a, b) => a.at - b.at);
  for (const r of back) {
    if (list.length >= MAX_NOTES) break;
    list.splice(Math.min(Math.max(r.at, 0), list.length), 0, r.note);
  }
  return { state: withList(s, scope, list, project) };
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

/** Remember that a note was handed to Claude, and which tab it opened (the last few runs, newest first). */
function markRun(stateIn, scope, id, { kind, tabId, at }) {
  const s = normalize(stateIn);
  const list = listOf(s, scope);
  if (!KINDS.includes(kind) || !list.some(n => n.id === id)) return s;
  const run = { kind, tabId: tabId || null, at };
  return withList(s, scope, list.map(n => (n.id === id ? { ...n, runs: [run, ...n.runs].slice(0, MAX_RUNS) } : n)));
}

const find = (stateIn, scope, id) => listOf(normalize(stateIn), scope).find(n => n.id === id) || null;

/** Every list's notes, with the list they're in: [{ scope, note }]. */
function all(stateIn) {
  const s = normalize(stateIn);
  return [
    ...s.general.map(note => ({ scope: GENERAL, note })),
    ...Object.entries(s.projects).flatMap(([scope, p]) => p.notes.map(note => ({ scope, note }))),
  ];
}

/**
 * The verdict an Ask reply led with (askPrompt asks for it on a line of its
 * own): 'do', 'differently', 'skip' or null. Only the first few lines count, so
 * "do it" further down a long reply doesn't read as the answer.
 */
function verdictOf(reply) {
  if (typeof reply !== 'string') return null;
  const lines = reply.slice(0, MAX_REPLY).split('\n').map(l => l.replace(/[*_`#>"“”]/g, '').replace(/^\s*(verdict\s*:\s*)?/i, '').trim().toLowerCase()).filter(Boolean).slice(0, 4);
  for (const l of lines) {
    if (/^do it differently\b/.test(l)) return 'differently';
    if (/^skip it\b/.test(l)) return 'skip';
    if (/^do it\b/.test(l)) return 'do';
  }
  return null;
}

/**
 * An Ask run's tab finished its first answer: the verdict onto that run. Later
 * turns in the same tab (a follow-up that starts "Do it…") don't change it,
 * and any other tab changes nothing.
 */
function markVerdict(stateIn, tabId, reply) {
  const s = normalize(stateIn);
  const verdict = verdictOf(reply);
  const isIt = r => r.kind === 'ask' && r.tabId === tabId && !r.verdict;
  const hit = tabId && verdict && all(s).find(({ note }) => note.runs.some(isIt));
  if (!hit) return s;
  return withList(s, hit.scope, listOf(s, hit.scope).map(n => (n.id === hit.note.id ? { ...n, runs: n.runs.map(r => (isIt(r) ? { ...r, verdict } : r)) } : n)));
}

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

module.exports = {
  GENERAL, MAX_NOTES, MAX_TEXT, MAX_RUNS, MAX_FROM_CLAUDE, KINDS, VERDICTS,
  normalize, add, update, remove, clearDone, restore, move, markRun, markVerdict, verdictOf, find, all, askPrompt,
};
