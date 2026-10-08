// The review inbox, main's half: what each tab's latest finished work changed,
// and whether you've looked at it since. The panel (review-queue.js and
// review-view.js) lists the tabs with something waiting; this keeps the facts,
// on the tab summary and in History, so a panel reload or a restart still
// knows what you haven't seen.
//
//   ready: { after, turnId, root, files, added, removed, paths, at, reviewed } | null
//
// A turn that changes files puts the tab back in the inbox (unreviewed), even if
// you'd marked the last one reviewed. Bringing a copy home counts as reviewing
// it; undoing the very turn it's about leaves nothing to review. Pure.

const MAX_PATHS = 5;
const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const count = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
const text = (s, max) => (typeof s === 'string' ? s.slice(0, max) : null);

/** A turn's `changes` item -> a fresh, unreviewed entry, or null when it changed nothing. */
function fromChanges(item, now = Date.now()) {
  const files = Array.isArray(item?.files) ? item.files : [];
  if (!files.length) return null;
  return {
    after: item.after, turnId: item.turnId || null, root: item.root || null,
    files: files.length + count(item.more),
    added: count(item.added), removed: count(item.removed),
    paths: files.slice(0, MAX_PATHS).map(f => String(f?.path || '')).filter(Boolean),
    at: now, reviewed: false,
  };
}

/**
 * Where a tab's review stands after one of its items. Returns the same object
 * when nothing changed, so the caller can tell whether to save.
 */
function next(ready, item, now = Date.now()) {
  if (!item) return ready;
  if (item.kind === 'changes') return fromChanges(item, now) || ready;
  if (!ready) return ready;
  if (item.kind === 'home' && !ready.reviewed) return { ...ready, reviewed: true };
  if (item.kind === 'undone' && item.after === ready.after) return null;
  return ready;
}

/** Marked reviewed (or back to waiting). Same object when nothing changes. */
function setReviewed(ready, reviewed) {
  if (!ready || ready.reviewed === !!reviewed) return ready;
  return { ...ready, reviewed: !!reviewed };
}

/** What History kept, checked before a tab trusts it. -> a clean entry or null. */
function restore(saved) {
  if (!saved || typeof saved !== 'object' || !TREE.test(saved.after || '')) return null;
  const at = Number(saved.at);
  return {
    after: saved.after, turnId: text(saved.turnId, 64), root: text(saved.root, 400),
    files: count(saved.files), added: count(saved.added), removed: count(saved.removed),
    paths: (Array.isArray(saved.paths) ? saved.paths : []).filter(p => typeof p === 'string' && p).slice(0, MAX_PATHS).map(p => p.slice(0, 400)),
    at: Number.isFinite(at) && at > 0 ? at : 0,
    reviewed: saved.reviewed === true,
  };
}

module.exports = { MAX_PATHS, fromChanges, next, setReviewed, restore };
