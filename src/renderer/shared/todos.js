// Claude's own to-do list for a conversation, as its tool calls build it:
// TaskCreate adds one (the id arrives with the result), TaskUpdate ticks one
// off or drops it, and TodoWrite (older Claude Code) replaces the whole list.
// stream.js turns each call into `item.todo` and each TaskCreate result into
// `item.todoId`; this folds those items into the list. Pure, no DOM: the panel
// draws it above the Working bar, and main counts it for the crab and the tabs.
// Works in the browser and in Node (for tests).
(function (root) {
  const MAX_TODOS = 100;
  const MAX_WAITING = 50; // TaskCreate calls whose result hasn't come back yet

  /** An empty list: { items: [{ id, subject, activeForm, status }], waiting: Map(tool id -> to-do) }. */
  function create() {
    return { items: [], waiting: new Map() };
  }

  const find = (list, id) => list.items.find(t => t.id === id);

  /**
   * Fold one feed item into the list. Returns true when the list changed.
   * Only tool calls with `todo` and results with `todoId` matter; anything else
   * is ignored, so every item can be passed through.
   */
  function apply(list, item) {
    if (!list || !item) return false;
    if (item.kind === 'tool' && item.todo) {
      const t = item.todo;
      if (t.op === 'set') {
        // The whole list, as TodoWrite has it: its own ids, one per row.
        if (item.sub) return false; // a helper's list of its own isn't the conversation's
        list.items = (t.items || []).slice(0, MAX_TODOS).map((x, i) => ({ id: `w${i + 1}`, subject: x.subject, activeForm: x.activeForm || '', status: x.status }));
        return true;
      }
      if (t.op === 'create') {
        list.waiting.set(item.id, { subject: t.subject, activeForm: t.activeForm || '' });
        if (list.waiting.size > MAX_WAITING) list.waiting.delete(list.waiting.keys().next().value);
        return false;
      }
      if (t.op === 'update') {
        const row = find(list, t.id);
        if (!row) return false;
        if (t.status === 'deleted') {
          list.items = list.items.filter(x => x !== row);
          return true;
        }
        let changed = false;
        for (const k of ['status', 'subject', 'activeForm']) {
          if (t[k] && row[k] !== t[k]) { row[k] = t[k]; changed = true; }
        }
        return changed;
      }
      return false;
    }
    if (item.kind === 'tool_result' && list.waiting.has(item.id)) {
      const made = list.waiting.get(item.id);
      list.waiting.delete(item.id);
      if (item.isError || !item.todoId) return false;
      const row = find(list, item.todoId);
      if (row) { Object.assign(row, made); return true; }
      if (list.items.length >= MAX_TODOS) return false;
      list.items.push({ id: item.todoId, ...made, status: 'pending' });
      return true;
    }
    return false;
  }

  /** Rebuild a list from a conversation's items (a replay, or a rewind). */
  function fromItems(items) {
    const list = create();
    for (const it of items || []) apply(list, it);
    return list;
  }

  /**
   * The list at a glance: { total, done, current, items } where current is the
   * to-do Claude is on now, worded as it's being done ("Running the tests"),
   * or null. items are copies, safe to hand on.
   */
  function summary(list) {
    const items = (list?.items || []).map(t => ({ ...t }));
    const done = items.filter(t => t.status === 'completed').length;
    const on = items.find(t => t.status === 'in_progress');
    return { total: items.length, done, current: on ? (on.activeForm || on.subject) : null, items };
  }

  /** Every to-do ticked off (and there were some). */
  const allDone = s => !!s && s.total > 0 && s.done === s.total;

  const api = { create, apply, fromItems, summary, allDone, MAX_TODOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyTodos = api;
})(typeof window !== 'undefined' ? window : globalThis);
