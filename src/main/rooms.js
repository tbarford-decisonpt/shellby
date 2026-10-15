// Rooms: the panel's screens open one at a time for someone new, so the first
// thing they meet is the crab and the chat box, not seven buttons. Each finished
// task opens more of his shell. Anyone who already used Shellby before rooms
// existed starts with every door open, and "Show every screen" opens the rest at
// once. Opening a room by hand (Ctrl+K) counts too. The game's deeper rooms
// (`game`) also wait for the core loop: First steps finished, or level
// CORE_LOOP_LEVEL (first-run.js); once reached, that stays reached. A room
// that opens is `fresh` (a small "new" on its door) until it's first visited.
// Pure: no I/O. See test/rooms.test.js.

// The order rooms open in, and how many finished tasks open each. Shellby and
// Chat are always open; Settings is the gear, not a room. A room with `in` is a
// tab of that screen (the Shellby screen's Trophies, Finds, Bugdex...), so his
// own screen starts as just his outfits and grows with him too. A room with
// `part` has no door: it's a card on that screen (the Reef on a project's
// page, Review mastery on Trophies), hidden until it opens. `chapter` is the
// quest chapter (quests/chapters.js) that teaches it, named when it opens.
const ROOMS = Object.freeze([
  // Open from the start: the one page that says what to do next (logbook.js).
  { id: 'logbook', tasks: 0, in: 'wardrobe', name: 'Logbook', text: 'Everything going on in one place: today’s bounties, your quest, bugs on the loose and what each one leads to.' },
  { id: 'history', tasks: 1, name: 'History', text: 'Every conversation you two have had, to pick back up any time.' },
  { id: 'projects', tasks: 1, name: 'Projects', text: 'Every repo you work in on one page, with its dev server a click away.' },
  { id: 'notes', tasks: 1, name: 'Notes', text: 'Ideas to plan, build or ask Claude about, for each project and in one General list.' },
  { id: 'trophies', tasks: 1, in: 'wardrobe', name: 'Trophies', text: 'What you two have done together, and what unlocks next.' },
  { id: 'finds', game: true, tasks: 2, in: 'wardrobe', name: 'Finds', text: 'Things he digs up on the desk while you work, to keep on a shelf.' },
  { id: 'stickers', game: true, tasks: 2, in: 'wardrobe', name: 'Stickers', text: 'A mark on his shell for every repo you ship.' },
  { id: 'health', tasks: 3, name: 'Health', text: 'He keeps an eye on your PC: temperatures, memory and drives.' },
  { id: 'toolbox', tasks: 3, name: 'Toolbox', text: 'The skills, agents and tools he works with, and a shop for more.' },
  { id: 'crew', game: true, tasks: 3, in: 'wardrobe', name: 'Crew', text: 'The helper crabs Claude sends out, and what each is best at.' },
  { id: 'reef', game: true, chapter: 'reef-wakes', part: 'projects', tasks: 3, name: 'Reef', text: 'A coral reef on each project’s page that grows while its tests, CI and dependencies stay healthy.' },
  { id: 'bugdex', game: true, chapter: 'bug-hunter', tasks: 4, in: 'wardrobe', name: 'Bugdex', text: 'Every bug you two have caught, and the battles to catch them.' },
  { id: 'council', game: true, chapter: 'second-opinions', tasks: 4, in: 'wardrobe', name: 'Council', text: 'A table of advisor crabs who argue a decision out, with him in the chair.' },
  { id: 'mastery', game: true, chapter: 'long-watch', part: 'trophies', tasks: 4, name: 'Review mastery', text: 'Your eye for review, ranked on the Trophies page: bugs you catch in his changes, quizzes, tiers.' },
  { id: 'workflows', chapter: 'clockwork', tasks: 5, name: 'Automate', text: 'Routines and workflows: work he does on a schedule or when something happens.' },
  { id: 'us', game: true, chapter: 'tides-and-friends', tasks: 5, in: 'wardrobe', name: 'Us', text: 'Your time together, on a beach that gets a sandcastle for every project you ship.' },
  { id: 'tank', game: true, chapter: 'home-improvement', tasks: 6, in: 'wardrobe', name: 'Tank', text: 'His home, to decorate with castles, plants and his finds.' },
]);
const IDS = new Set(ROOMS.map(r => r.id));
const ALL = Object.freeze({ tasks: 0, open: [], all: true, core: true, fresh: [] });

const count = n => Math.max(0, Math.floor(Number(n) || 0));
const known = list => [...new Set((Array.isArray(list) ? list : []).filter(id => IDS.has(id)))];

// The cards that became rooms along with the core loop: anyone already
// opening rooms before then has always seen them.
const CARDS_SINCE_CORE = Object.freeze(['reef', 'mastery']);

/**
 * A stored rooms value made safe; null stays null (not decided yet). A value
 * saved before the core loop existed has no `core`: it counts as reached, and
 * the cards that became rooms with it stay open, so nobody already opening
 * rooms loses anything they could see.
 */
function normalizeRooms(v) {
  if (!v || typeof v !== 'object') return null;
  const before = v.core === undefined;
  return {
    tasks: count(v.tasks),
    open: known([...(Array.isArray(v.open) ? v.open : []), ...(before ? CARDS_SINCE_CORE : [])]),
    all: !!v.all,
    core: before || !!v.core,
    fresh: known(v.fresh),
  };
}

/** The first value: everything for someone who was here before rooms, nothing yet for someone new. */
function initialRooms(onboarded) {
  return onboarded ? { ...ALL, open: [], fresh: [] } : { tasks: 0, open: [], all: false, core: false, fresh: [] };
}

// Earned by tasks, and a game room by the core loop too.
const earned = (s, r) => s.tasks >= r.tasks && (!r.game || s.core);

/** Which rooms are open. */
function openRooms(v) {
  const s = normalizeRooms(v);
  if (!s || s.all) return ROOMS.map(r => r.id);
  return ROOMS.filter(r => earned(s, r) || s.open.includes(r.id)).map(r => r.id);
}

// From one value to the next: the rooms that just opened (in order), each
// fresh until it's visited.
function step(s, next) {
  const before = new Set(openRooms(s));
  const after = new Set(openRooms(next));
  const opened = ROOMS.filter(r => !before.has(r.id) && after.has(r.id));
  return { state: { ...next, fresh: known([...next.fresh, ...opened.map(r => r.id)]) }, opened };
}

/** A task finished: the new value, and the rooms that just opened (in order). */
function taskDone(v) {
  const s = normalizeRooms(v);
  if (!s || s.all) return { state: s, opened: [] };
  return step(s, { ...s, tasks: s.tasks + 1 });
}

/** The core loop is done (first-run.js coreLoopDone): the game's rooms may open now. */
function reachCore(v) {
  const s = normalizeRooms(v);
  if (!s || s.all || s.core) return { state: s, opened: [] };
  return step(s, { ...s, core: true });
}

/** Opened by hand (found through Ctrl+K, or a link that points there). */
function openRoom(v, id) {
  const s = normalizeRooms(v);
  if (!s || s.all || !IDS.has(id) || openRooms(s).includes(id)) return s;
  return { ...s, open: [...s.open, id] };
}

/** Visited: its "new" goes. */
function seeRoom(v, id) {
  const s = normalizeRooms(v);
  if (!s || !s.fresh.includes(id)) return s;
  return { ...s, fresh: s.fresh.filter(f => f !== id) };
}

/** "Show every screen now". */
function openAll(v) {
  return { ...(normalizeRooms(v) || ALL), all: true, core: true, fresh: [] };
}

// The next room to open. Before the core loop the game's rooms aren't next
// however many tasks go by: `core: true` says the first of them waits on it.
function nextRoom(s, open) {
  if (!s || s.all) return null;
  const shut = ROOMS.filter(r => !open.includes(r.id));
  const next = shut.find(r => !r.game || s.core);
  const where = r => (r.in ? { in: r.in } : {});
  if (next) return { id: next.id, name: next.name, tasksToGo: Math.max(1, next.tasks - s.tasks), ...where(next) };
  return shut[0] ? { id: shut[0].id, name: shut[0].name, core: true, ...where(shut[0]) } : null;
}

/** What the panel needs: which doors are open, which are new, and what the next one is. */
function roomsView(v) {
  const s = normalizeRooms(v);
  const open = openRooms(s);
  return {
    open,
    locked: ROOMS.filter(r => !open.includes(r.id)).map(r => r.id),
    all: open.length === ROOMS.length,
    tasks: s?.tasks || 0,
    core: !s || s.all || s.core,
    fresh: s && !s.all ? s.fresh.filter(id => open.includes(id)) : [],
    next: nextRoom(s, open),
  };
}

module.exports = { ROOMS, normalizeRooms, initialRooms, openRooms, taskDone, reachCore, openRoom, seeRoom, openAll, roomsView };
