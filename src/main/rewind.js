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
  // A fresh start ('fresh') began a new Claude conversation: nothing before it
  // can be resumed into, so it counts as a beginning too.
  const lastFresh = before.map(i => i.kind).lastIndexOf('fresh');
  const sinceFresh = lastFresh >= 0 ? before.slice(lastFresh + 1) : before;
  const restart = fresh || !sinceFresh.some(i => i.kind === 'user');
  const anchor = restart ? null : [...sinceFresh].reverse().find(i => i.kind === 'result' && typeof i.anchor === 'string')?.anchor || null;
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

/** Your messages that can be rewound to, newest first: [{ turnId, text, at }]. */
function points(items) {
  return (Array.isArray(items) ? items : [])
    .filter(i => i && i.kind === 'user' && typeof i.turnId === 'string')
    .map(i => ({ turnId: i.turnId, text: String(i.text || (i.attachments?.length ? `${i.attachments.length} attached file${i.attachments.length === 1 ? '' : 's'}` : '')).slice(0, 300), at: i.t || null }))
    .reverse();
}

module.exports = { plan, points };
