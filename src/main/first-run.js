// First steps: a short path for someone new, on the chat's start screen.
// Hello (the welcome screen), open a project, send Claude a task, see what
// changed, meet the crab. Each step is done by the real thing happening (a
// folder chosen, a task sent, the file viewer opened, a pet), never by
// ticking it, and each can be skipped. Hiding the card keeps the progress, so
// it can come back. Finishing it (done or skipped, every step) is the core
// loop that opens the game's deeper rooms (rooms.js reachCore); so is
// reaching CORE_LOOP_LEVEL, for anyone who never looks at the card.
// Someone who was here before First steps existed starts with it finished.
// Pure: no I/O, no clock (callers pass `now`). See test/first-run.test.js.

// The level that counts as the core loop done even with First steps untouched.
const CORE_LOOP_LEVEL = 3;

const STEPS = Object.freeze([
  { id: 'welcome', icon: '👋', title: 'Say hello', text: 'You picked how you want him. That one’s done.' },
  { id: 'project', icon: '📁', title: 'Open a project', text: 'Point him at a folder you work in, so Claude reads the right code.', action: 'Choose a folder' },
  { id: 'message', icon: '💬', title: 'Give Claude a task', text: 'Something small to start: “explain this project” or “fix the typo in the README”.', action: 'Write one' },
  { id: 'result', icon: '🔍', title: 'See what changed', text: 'Open a file he touched to read the diff, line by line.', action: 'Show his changes' },
  { id: 'crab', icon: '🦀', title: 'Meet the crab', text: 'Rub the mouse over him on the desktop to pet him, or try on an outfit.', action: 'Open Outfits' },
]);
const IDS = new Set(STEPS.map(s => s.id));
const FRESH = Object.freeze({ done: {}, skipped: {}, hidden: false, legacy: false });

const stamp = n => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : null);
const stamps = v => {
  const out = {};
  for (const [id, at] of Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {})) {
    if (IDS.has(id) && stamp(at)) out[id] = stamp(at);
  }
  return out;
};

/** A stored value made safe; null stays null (not decided yet: treated as finished). */
function normalizeFirstRun(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return { done: stamps(v.done), skipped: stamps(v.skipped), hidden: !!v.hidden, legacy: !!v.legacy };
}

/** The first value, decided once at boot: finished for anyone who was already here. */
function initialFirstRun(existing) {
  return existing ? { ...FRESH, done: {}, skipped: {}, legacy: true } : { ...FRESH, done: {}, skipped: {} };
}

const settled = (s, id) => !!(s.done[id] || s.skipped[id]);

/** Every step done or skipped (or never needed). */
function isComplete(v) {
  const s = normalizeFirstRun(v);
  return !s || s.legacy || STEPS.every(st => settled(s, st.id));
}

/** The core loop: First steps finished, or far enough along anyway. */
function coreLoopDone(v, level) {
  return isComplete(v) || (Number(level) || 0) >= CORE_LOOP_LEVEL;
}

// A step done or skipped, once; anything else hands back the same value.
function settle(v, id, now, key) {
  const s = normalizeFirstRun(v);
  if (!s || s.legacy || !IDS.has(id) || settled(s, id)) return s;
  return { ...s, [key]: { ...s[key], [id]: stamp(now) || 1 } };
}

/** The real thing happened. */
const markStep = (v, id, now) => settle(v, id, now, 'done');
/** Skipped from the card. */
const skipStep = (v, id, now) => settle(v, id, now, 'skipped');

/** The card hidden (×) or brought back (Settings); progress is kept either way. */
function setHidden(v, hidden) {
  const s = normalizeFirstRun(v);
  return s ? { ...s, hidden: !!hidden } : s;
}

/** What the panel shows: each step's state, the one to do now, and whether the card shows at all. */
function firstRunView(v, { onboarded = true, level = 1 } = {}) {
  const s = normalizeFirstRun(v);
  const marked = s && onboarded ? markStep(s, 'welcome', 1) : s; // the welcome screen is the first step
  const steps = STEPS.map(st => ({
    ...st,
    state: !marked || marked.legacy ? 'done' : marked.done[st.id] ? 'done' : marked.skipped[st.id] ? 'skipped' : 'todo',
  }));
  const complete = isComplete(marked);
  return {
    steps,
    current: steps.find(st => st.state === 'todo')?.id || null,
    doneCount: steps.filter(st => st.state !== 'todo').length,
    total: STEPS.length,
    complete,
    hidden: !!s?.hidden,
    shows: !!s && !complete && !s.hidden,
    core: coreLoopDone(marked, level),
    coreLevel: CORE_LOOP_LEVEL,
  };
}

module.exports = { CORE_LOOP_LEVEL, STEPS, normalizeFirstRun, initialFirstRun, isComplete, coreLoopDone, markStep, skipStep, setHidden, firstRunView };
