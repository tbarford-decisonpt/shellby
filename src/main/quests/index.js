// Quests: a quest line in chapters that walks someone through the features
// they'd otherwise never find, and how each one feeds the next. Rooms
// (rooms.js) open the screens; quests teach what's on them. Each quest is done
// the first time the real thing succeeds in main (a review with line comments
// goes, a branch is made, a routine runs, a nest clears), in any order inside
// its chapter. Chapters open by the highest level ever reached, by a tide
// event, or early when their screen has never been opened (the chapter is its
// tutorial). Chapter 1 is the original four quests, so a saved line still
// loads. The copy is in quests/chapters.js. Pure: no I/O, no clock (callers
// pass `now`). See test/quests.test.js and docs/LOGBOOK.md.

const { CHAPTERS } = require('./chapters');

// Every quest, flattened, each knowing its chapter (QUESTS stays for callers
// that only know the old flat list).
const QUESTS = Object.freeze(CHAPTERS.flatMap(c => c.quests.map(q => Object.freeze({ ...q, chapter: c.id }))));
const IDS = new Set(QUESTS.map(q => q.id));
const CHAPTER_IDS = new Set(CHAPTERS.map(c => c.id));
const FIRST = CHAPTERS[0];
const FRESH = Object.freeze({ done: {}, hidden: false });

const stamp = n => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : null);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const chapterOf = id => CHAPTERS.find(c => c.quests.some(q => q.id === id)) || null;
const chapterById = id => CHAPTERS.find(c => c.id === id) || null;

/** A stored quests value made safe: unknown quests, chapters and bad stamps dropped. */
function normalizeQuests(v) {
  const s = v && typeof v === 'object' ? v : FRESH;
  const done = {};
  for (const [id, at] of Object.entries(obj(s.done))) {
    if (IDS.has(id) && stamp(at)) done[id] = stamp(at);
  }
  const chapters = {};
  for (const [id, c] of Object.entries(obj(s.chapters))) {
    if (!CHAPTER_IDS.has(id)) continue;
    const unlockedAt = stamp(c?.unlockedAt), doneAt = stamp(c?.doneAt);
    if (unlockedAt || doneAt) chapters[id] = { unlockedAt: unlockedAt || doneAt, doneAt };
  }
  const seenChapter = CHAPTER_IDS.has(s.seenChapter) ? s.seenChapter : null;
  return { done, hidden: !!s.hidden, chapters, seenChapter };
}

/** ctx made safe: { everLevel, dormant: Set of never-opened screen ids, eventActive }. */
function normalizeCtx(ctx) {
  const c = obj(ctx);
  const d = c.dormant instanceof Set ? c.dormant : new Set(Array.isArray(c.dormant) ? c.dormant : []);
  return { everLevel: Math.max(1, Math.floor(Number(c.everLevel) || 1)), dormant: d, eventActive: !!c.eventActive };
}

const allDone = (s, c) => c.quests.every(q => s.done[q.id]);

// Whether a chapter's rule holds now. A never-opened screen opens a chapter
// only once every chapter already open is finished, so someone new isn't
// handed every tutorial at once (they're all "never opened" on day one).
function ruleHolds(c, s, ctx, openNow) {
  const u = c.unlock;
  if (u.always) return true;
  if (u.level && ctx.everLevel >= u.level) return true;
  if (u.event && ctx.eventActive) return true;
  if (u.dormant && u.dormant.some(id => ctx.dormant.has(id))) return openNow.every(o => allDone(s, o));
  return false;
}

// The chapters open: stored as open, or opened by their rule. Level and event
// rules first, then at most one tutorial chapter.
function openChapters(s, ctx) {
  const open = CHAPTERS.filter(c => c.unlock.always || s.chapters[c.id]);
  for (const c of CHAPTERS) {
    if (open.includes(c) || c.unlock.dormant && !(c.unlock.level && ctx.everLevel >= c.unlock.level)) continue;
    if (ruleHolds(c, s, ctx, open)) open.push(c);
  }
  for (const c of CHAPTERS) {
    if (open.includes(c) || !c.unlock.dormant) continue;
    if (ruleHolds(c, s, ctx, open)) { open.push(c); break; }
  }
  return CHAPTERS.filter(c => open.includes(c));
}

/** Open whatever chapters ctx allows now: the new value and the chapters just opened (in order). */
function unlockChapters(v, ctx, now = Date.now()) {
  const s = normalizeQuests(v);
  const at = stamp(now) || 1;
  const opened = openChapters(s, normalizeCtx(ctx)).filter(c => !c.unlock.always && !s.chapters[c.id]);
  if (!opened.length) return { state: s, opened: [] };
  const chapters = { ...s.chapters };
  for (const c of opened) chapters[c.id] = { unlockedAt: at, doneAt: null };
  return { state: { ...s, chapters }, opened };
}

// The quest to suggest after this state: the first open one in `prefer`'s
// chapter, else the first open one in any open chapter.
function nextQuest(s, open, prefer) {
  const inChapter = c => { const q = c.quests.find(x => !s.done[x.id]); return q ? QUESTS.find(x => x.id === q.id) : null; };
  const first = prefer && open.includes(prefer) ? inChapter(prefer) : null;
  if (first) return first;
  for (const c of open) { const q = inChapter(c); if (q) return q; }
  return null;
}

/**
 * The real thing just succeeded. -> { state, quest, chapter, chapterDone, next,
 * finished, opened }: the quest it finished (null if it was done already, isn't
 * a quest, or its chapter isn't open yet), its chapter, whether that finished
 * the chapter, the quest to suggest next, whether every open chapter is done,
 * and any chapters ctx opened on the way.
 */
function completeQuest(v, id, now = Date.now(), ctx = null) {
  const u = unlockChapters(v, ctx, now);
  const s = u.state;
  const none = { state: s, quest: null, chapter: null, chapterDone: false, next: null, finished: false, opened: u.opened };
  const chapter = chapterOf(id);
  if (!chapter || s.done[id]) return none;
  const open = openChapters(s, normalizeCtx(ctx));
  if (!open.includes(chapter)) return none;
  const at = stamp(now) || 1;
  let state = { ...s, done: { ...s.done, [id]: at } };
  const chapterDone = allDone(state, chapter);
  if (chapterDone) {
    const was = state.chapters[chapter.id];
    state = { ...state, chapters: { ...state.chapters, [chapter.id]: { unlockedAt: was?.unlockedAt || at, doneAt: at } } };
  }
  const next = nextQuest(state, open, chapter);
  return { state, quest: QUESTS.find(q => q.id === id), chapter, chapterDone, next, finished: !next, opened: u.opened };
}

/** Hide the quest card from the chat (the line stays in the Logbook), or bring it back. */
function setHidden(v, hidden) {
  return { ...normalizeQuests(v), hidden: !!hidden };
}

/** The newest open chapter has been looked at: its "new" mark goes. */
function markSeen(v, chapterId) {
  const s = normalizeQuests(v);
  return CHAPTER_IDS.has(chapterId) ? { ...s, seenChapter: chapterId } : s;
}

/** What a locked chapter needs, in words: "Opens at level 10, or sooner if you've never tried Routines." */
function unlockText(c, names = {}) {
  const u = c.unlock;
  if (u.always) return '';
  const parts = [];
  if (u.level) parts.push(`Opens at level ${u.level}`);
  if (u.event) parts.push(parts.length ? 'or during a tide event' : 'Opens during a tide event');
  if (u.dormant) {
    const what = u.dormant.map(id => names[id] || id).join(' or ');
    parts.push(parts.length ? `or sooner if you’ve never tried ${what}` : `Opens if you’ve never tried ${what}`);
  }
  return `${parts.join(', ')}.`;
}

const publicChapter = c => ({ id: c.id, n: c.n, icon: c.icon, title: c.title, blurb: c.blurb, teaches: c.teaches });

/**
 * What the panel needs. The chat's card keeps its shape (list, current,
 * doneCount, total, complete, hidden), now for the chapter in progress; plus
 * every chapter with whether it's open and done, and how it opens.
 *   ctx: as completeQuest's; without one only stored chapters count as open.
 *   names: screen id -> name, for the unlock line.
 */
function questsView(v, ctx = null, names = {}) {
  const s = normalizeQuests(v);
  const c = normalizeCtx(ctx);
  const open = openChapters(s, c);
  const chapters = CHAPTERS.map(ch => {
    const quests = ch.quests.map(q => ({ ...q, done: !!s.done[q.id], at: s.done[q.id] || null }));
    const doneCount = quests.filter(q => q.done).length;
    const unlocked = open.includes(ch);
    return {
      ...publicChapter(ch), unlocked, done: doneCount === quests.length, doneCount, total: quests.length,
      progress: quests.length ? doneCount / quests.length : 0, quests,
      unlockText: unlocked ? '' : unlockText(ch, names), unlockLevel: ch.unlock.level || null,
    };
  });
  const live = chapters.filter(ch => ch.unlocked);
  const now = live.find(ch => !ch.done) || live[live.length - 1] || chapters[0];
  const current = now.quests.find(q => !q.done) || null;
  const nextLocked = chapters.find(ch => !ch.unlocked) || null;
  return {
    list: now.quests, current: current && current.id, doneCount: now.doneCount, total: now.total,
    complete: !live.some(ch => !ch.done), hidden: s.hidden,
    chapter: { ...publicChapter(now), doneCount: now.doneCount, total: now.total, isNew: now.n > 1 && s.seenChapter !== now.id && !now.done },
    chapters, chaptersDone: chapters.filter(ch => ch.done).length, totalChapters: chapters.length,
    nextLocked: nextLocked && { id: nextLocked.id, n: nextLocked.n, title: nextLocked.title, icon: nextLocked.icon, unlockText: nextLocked.unlockText, unlockLevel: nextLocked.unlockLevel },
  };
}

module.exports = {
  CHAPTERS, QUESTS, FIRST, chapterOf, chapterById,
  normalizeQuests, completeQuest, unlockChapters, setHidden, markSeen, questsView, unlockText,
};
