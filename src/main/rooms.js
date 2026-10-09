// Rooms: the panel's screens open one at a time for someone new, so the first
// thing they meet is the crab and the chat box, not seven buttons. Each finished
// task opens more of his shell. Anyone who already used Shellby before rooms
// existed starts with every door open, and "Show every screen" opens the rest at
// once. Opening a room by hand (Ctrl+K) counts too. Pure: no I/O. See
// test/rooms.test.js.

// The order rooms open in, and how many finished tasks open each. Shellby and
// Chat are always open; Settings is the gear, not a room. A room with `in` is a
// tab of that screen (the Shellby screen's Trophies, Finds, Bugdex...), so his
// own screen starts as just his outfits and grows with him too.
const ROOMS = Object.freeze([
  { id: 'history', tasks: 1, name: 'History', text: 'Every conversation you two have had, to pick back up any time.' },
  { id: 'projects', tasks: 1, name: 'Projects', text: 'Every repo you work in on one page, with its dev server a click away.' },
  { id: 'notes', tasks: 1, name: 'Notes', text: 'Ideas to plan, build or ask Claude about, for each project and in one General list.' },
  { id: 'trophies', tasks: 1, in: 'wardrobe', name: 'Trophies', text: 'What you two have done together, and what unlocks next.' },
  { id: 'finds', tasks: 2, in: 'wardrobe', name: 'Finds', text: 'Things he digs up on the desk while you work, to keep on a shelf.' },
  { id: 'stickers', tasks: 2, in: 'wardrobe', name: 'Stickers', text: 'A mark on his shell for every repo you ship.' },
  { id: 'health', tasks: 3, name: 'Health', text: 'He keeps an eye on your PC: temperatures, memory and drives.' },
  { id: 'toolbox', tasks: 3, name: 'Toolbox', text: 'The skills, agents and tools he works with, and a shop for more.' },
  { id: 'crew', tasks: 3, in: 'wardrobe', name: 'Crew', text: 'The helper crabs Claude sends out, and what each is best at.' },
  { id: 'bugdex', tasks: 4, in: 'wardrobe', name: 'Bugdex', text: 'Every bug you two have caught, and the battles to catch them.' },
  { id: 'council', tasks: 4, in: 'wardrobe', name: 'Council', text: 'A table of advisor crabs who argue a decision out, with him in the chair.' },
  { id: 'workflows', tasks: 5, name: 'Automate', text: 'Routines and workflows: work he does on a schedule or when something happens.' },
  { id: 'us', tasks: 5, in: 'wardrobe', name: 'Us', text: 'Your time together: streaks, tide events and his friends.' },
  { id: 'tank', tasks: 6, in: 'wardrobe', name: 'Tank', text: 'His home, to decorate with castles, plants and his finds.' },
  { id: 'beach', tasks: 8, in: 'wardrobe', name: 'Beach', text: 'A beach that fills in as he grows, day and night.' },
]);
const IDS = new Set(ROOMS.map(r => r.id));
const ALL = Object.freeze({ tasks: 0, open: [], all: true });

const count = n => Math.max(0, Math.floor(Number(n) || 0));

/** A stored rooms value made safe; null stays null (not decided yet). */
function normalizeRooms(v) {
  if (!v || typeof v !== 'object') return null;
  return {
    tasks: count(v.tasks),
    open: [...new Set((Array.isArray(v.open) ? v.open : []).filter(id => IDS.has(id)))],
    all: !!v.all,
  };
}

/** The first value: everything for someone who was here before rooms, nothing yet for someone new. */
function initialRooms(onboarded) {
  return onboarded ? { ...ALL } : { tasks: 0, open: [], all: false };
}

/** Which rooms are open. */
function openRooms(v) {
  const s = normalizeRooms(v);
  if (!s || s.all) return ROOMS.map(r => r.id);
  return ROOMS.filter(r => s.tasks >= r.tasks || s.open.includes(r.id)).map(r => r.id);
}

/** A task finished: the new value, and the rooms that just opened (in order). */
function taskDone(v) {
  const s = normalizeRooms(v);
  if (!s || s.all) return { state: s, opened: [] };
  const before = new Set(openRooms(s));
  const next = { ...s, tasks: s.tasks + 1 };
  return { state: next, opened: ROOMS.filter(r => !before.has(r.id) && openRooms(next).includes(r.id)) };
}

/** Opened by hand (found through Ctrl+K, or a link that points there). */
function openRoom(v, id) {
  const s = normalizeRooms(v);
  if (!s || s.all || !IDS.has(id) || openRooms(s).includes(id)) return s;
  return { ...s, open: [...s.open, id] };
}

/** "Show every screen now". */
function openAll(v) {
  return { ...(normalizeRooms(v) || ALL), all: true };
}

/** What the panel needs: which doors are open, and what the next one is. */
function roomsView(v) {
  const s = normalizeRooms(v);
  const open = openRooms(s);
  const next = s && !s.all ? ROOMS.find(r => !open.includes(r.id)) : null;
  return {
    open,
    all: open.length === ROOMS.length,
    tasks: s?.tasks || 0,
    next: next ? { id: next.id, name: next.name, tasksToGo: Math.max(1, next.tasks - s.tasks), ...(next.in ? { in: next.in } : {}) } : null,
  };
}

module.exports = { ROOMS, normalizeRooms, initialRooms, openRooms, taskDone, openRoom, openAll, roomsView };
