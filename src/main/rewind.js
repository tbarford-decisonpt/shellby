// Rewind: take a conversation back to just before one of your messages, the
// way Esc Esc does in the Claude Code terminal.
//
// Two halves, either or both:
//   - the conversation: Claude Code resumes its own transcript only up to the
//     end of the turn before (--resume-session-at, as a fork, so the original
//     is left alone). Each turn's result carries that point as `anchor`.
//   - the code: every turn after it is undone with Shellby's own per-turn
//     snapshots (changes.js), newest first. Those see everything a turn did,
//     scripts and installs included, not only Claude's own edits.
//
// plan() is pure: it reads a transcript and says what a rewind would do.
// See test/rewind.test.js.

// Where a new Claude conversation began in the same tab: a fresh start from a
// summary, or /clear. Nothing before one can be resumed into.
const BEGINNINGS = new Set(['fresh', 'cleared']);
const lastBeginning = items => items.findLastIndex(i => BEGINNINGS.has(i?.kind));

/**
 * items: a tab's transcript (history.load). turnId: the user message to go back to.
 * -> { ok: false, error } |
 *    { ok: true, index, anchor, fresh, conversation, changes, tail, text, attachments }
 *
 * index: where the transcript is cut (that message and everything after go,
 * except `tail`: diffs of earlier turns that were noted after it).
 * anchor: the transcript entry to resume up to; null with fresh=true means the
 * message was the first, so the conversation starts over. conversation: false
 * when the turn before predates anchors (an older transcript): only the code
 * can go back. changes: the 'changes' items after the cut, newest first.
 */
function plan(items, turnId) {
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex(i => i && i.kind === 'user' && i.turnId === turnId && typeof turnId === 'string');
  if (index < 0) return { ok: false, error: "That message isn't in this conversation any more." };
  const before = list.slice(0, index);
  const fresh = !before.some(i => i.kind === 'user');
  // A fresh start or a /clear began a new Claude conversation: it counts as a beginning too.
  const since = before.slice(lastBeginning(before) + 1);
  const restart = fresh || !since.some(i => i.kind === 'user');
  const anchor = restart ? null : [...since].reverse().find(i => i.kind === 'result' && typeof i.anchor === 'string')?.anchor || null;
  // A turn's diff is noted when it has been worked out, which can be after the
  // next message went in. Ones tagged with their turn go by that tag.
  const later = new Set(list.slice(index).filter(i => i.kind === 'user' && i.turnId).map(i => i.turnId));
  const ofLater = (i, at) => (i.turnId ? later.has(i.turnId) : at >= index);
  const changes = list.filter((i, at) => i.kind === 'changes' && ofLater(i, at)).reverse();
  const tail = list.slice(index).filter(i => i.kind === 'changes' && i.turnId && !later.has(i.turnId));
  const msg = list[index];
  return {
    ok: true, index, anchor, fresh: restart,
    conversation: restart || !!anchor,
    changes, tail,
    text: typeof msg.text === 'string' ? msg.text : '',
    attachments: Array.isArray(msg.attachments) ? msg.attachments.filter(a => typeof a === 'string') : [],
  };
}

/**
 * Your messages that can be rewound to, newest first: [{ turnId, text, at }].
 * Only since the last /clear, as in the terminal: what came before it is off screen.
 */
function points(items) {
  const list = Array.isArray(items) ? items : [];
  const cleared = list.findLastIndex(i => i?.kind === 'cleared');
  return list.slice(cleared + 1)
    .filter(i => i && i.kind === 'user' && typeof i.turnId === 'string')
    .map(i => ({ turnId: i.turnId, text: String(i.text || (i.attachments?.length ? `${i.attachments.length} attached file${i.attachments.length === 1 ? '' : 's'}` : '')).slice(0, 300), at: i.t || null }))
    .reverse();
}

/**
 * How much going back undoes, for the timeline: { files, added, removed } over
 * the 'changes' items a rewind would take back (plan().changes). A file
 * touched by several turns counts once.
 */
function weight(changes) {
  const files = new Set();
  let added = 0, removed = 0;
  for (const c of Array.isArray(changes) ? changes : []) {
    for (const f of Array.isArray(c?.files) ? c.files : []) if (typeof f?.path === 'string') files.add(f.path);
    added += Number(c?.added) || 0;
    removed += Number(c?.removed) || 0;
  }
  return { files: files.size, added, removed };
}

module.exports = { plan, points, weight, lastBeginning };
