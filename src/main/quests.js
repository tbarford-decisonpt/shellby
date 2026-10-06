// Quests: a short quest line that walks someone through the features they'd
// otherwise never find. Rooms (rooms.js) open the screens; quests teach what's
// on them. Each quest is done the first time the real thing succeeds in main
// (a review with line comments goes, a branch is made, a copy is merged home,
// work is held for the reset), in any order: the line suggests an order, it
// doesn't enforce one. Pure: no I/O. See test/quests.test.js.

// In the order they're suggested. Each one leads into the next: a review of
// his diff, a second take on it in its own copy, that copy merged home, and
// the heavy follow-up held for a fresh window. `go` is where the panel points.
const QUESTS = Object.freeze([
  {
    id: 'comment', icon: '💬', title: 'Comment on a diff line', go: 'diff',
    why: 'Point at the exact line instead of describing where it is. Your comments pile up and go back to him as one review.',
    how: 'When he changes a file, open the diff under his reply, click a line number (Shift+click for several), say what should change, then send the review.',
  },
  {
    id: 'branch', icon: '⑂', title: 'Try it another way', go: 'branch',
    why: 'Not quite right? He takes another run at your last message in a new tab with its own copy of the files. The first try stays as it was.',
    how: 'Hover your last message and choose ⑂ Try it another way, or press Ctrl+Shift+B.',
  },
  {
    id: 'home', icon: '↩', title: 'Bring a copy home', go: 'home',
    why: 'Work in a copy never touches your checkout until you say so. Happy with it? One click merges it back.',
    how: 'In a conversation with its own copy, open the branch chip and choose ↩ Bring it home, or press Ctrl+Shift+H.',
  },
  {
    id: 'reset', icon: '🌙', title: 'Queue a routine for the reset', go: 'reset',
    why: 'Near your usage limit? Queue the heavy work and it runs the moment your 5-hour window resets, overnight too.',
    how: 'In Automate → Routines, under "When your limit resets", write the task and press Queue it. A routine or a message can wait for the reset too.',
  },
]);
const IDS = new Set(QUESTS.map(q => q.id));
const FRESH = Object.freeze({ done: {}, hidden: false });

const stamp = n => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : null);

/** A stored quests value made safe: unknown quests and bad stamps dropped. */
function normalizeQuests(v) {
  const s = v && typeof v === 'object' ? v : FRESH;
  const done = {};
  for (const [id, at] of Object.entries(s.done && typeof s.done === 'object' ? s.done : {})) {
    if (IDS.has(id) && stamp(at)) done[id] = stamp(at);
  }
  return { done, hidden: !!s.hidden };
}

/** The real thing just succeeded: the new value, the quest it finished (null if
 *  it was done already or isn't a quest), and whether that finished the line. */
function completeQuest(v, id, now = Date.now()) {
  const s = normalizeQuests(v);
  if (!IDS.has(id) || s.done[id]) return { state: s, quest: null, finished: false };
  const state = { ...s, done: { ...s.done, [id]: stamp(now) || 1 } };
  const quest = QUESTS.find(q => q.id === id);
  const next = QUESTS.find(q => !state.done[q.id]) || null;
  return { state, quest, next, finished: !next };
}

/** Hide the quest card from the chat (the list stays in Trophies), or bring it back. */
function setHidden(v, hidden) {
  return { ...normalizeQuests(v), hidden: !!hidden };
}

/** What the panel needs: every quest with whether it's done, and the one to suggest now. */
function questsView(v) {
  const s = normalizeQuests(v);
  const list = QUESTS.map(q => ({ ...q, done: !!s.done[q.id], at: s.done[q.id] || null }));
  const current = list.find(q => !q.done) || null;
  const doneCount = list.filter(q => q.done).length;
  return { list, current: current && current.id, doneCount, total: QUESTS.length, complete: !current, hidden: s.hidden };
}

module.exports = { QUESTS, normalizeQuests, completeQuest, setHidden, questsView };
