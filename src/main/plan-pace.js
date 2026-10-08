// How far the running turn is through its own plan, and when that suggests it
// finishes: "step 3 of 7 · about 4 min left". The plan is the to-do list Claude
// keeps for itself (TodoWrite, or TaskCreate / TaskUpdate, as journal.js reads
// them); the pace is the time per step finished since the plan first moved in
// this turn, straight-line. A turn with no plan gets no guess.
//
// Pure: callers pass `now` (test/plan-pace.test.js).

const MIN_SPAN_MS = 20 * 1000; // steps ticked off faster than this are bookkeeping, not a pace

/**
 * The conversation's plan after one main-thread assistant message: { todos,
 * tasks }, statuses only. TodoWrite replaces the whole list; TaskCreate numbers
 * tasks in creation order. Returns the same object when nothing changed.
 */
function read(plan, content) {
  let next = plan || { todos: null, tasks: {} };
  let changed = false;
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type !== 'tool_use') continue;
    if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
      next = { ...next, todos: c.input.todos.map(t => t?.status || 'pending') };
    } else if (c.name === 'TaskCreate' && c.input?.subject) {
      next = { ...next, tasks: { ...next.tasks, [Object.keys(next.tasks).length + 1]: 'pending' } };
    } else if (c.name === 'TaskUpdate' && c.input?.status && String(c.input.taskId) in next.tasks) {
      next = { ...next, tasks: { ...next.tasks, [c.input.taskId]: c.input.status } };
    } else continue;
    changed = true;
  }
  return changed ? next : plan;
}

/** { done, total } of a plan: its tasks when it has any, else its to-dos. */
function counts(plan) {
  const tasks = Object.values(plan?.tasks || {});
  const list = (tasks.length ? tasks : plan?.todos || []).filter(s => s !== 'deleted');
  return { done: list.filter(s => s === 'completed').length, total: list.length };
}

/**
 * The turn's progress after the plan changed: { since, startDone, done, total,
 * lastDoneAt }. Only steps finished during this turn make the pace, so a plan
 * picked up half done doesn't look fast.
 */
function track(t, { done, total }, now) {
  if (!t) return { since: now, startDone: done, done, total, lastDoneAt: now };
  return {
    ...t, done, total,
    startDone: Math.min(t.startDone, done),
    lastDoneAt: done > t.done ? now : t.lastDoneAt,
  };
}

/**
 * What the panel shows: { step, total, endsAt }, or null with no plan or
 * nothing left on it. endsAt is null until a step has been finished this turn
 * and the steps so far took long enough to mean something.
 */
function outlook(t) {
  if (!t || !t.total || t.done >= t.total) return null;
  const finished = t.done - t.startDone;
  const span = t.lastDoneAt - t.since;
  const endsAt = finished > 0 && span >= MIN_SPAN_MS
    ? Math.round(t.lastDoneAt + (span / finished) * (t.total - t.done))
    : null;
  return { step: t.done + 1, total: t.total, endsAt };
}

module.exports = { MIN_SPAN_MS, read, counts, track, outlook };
