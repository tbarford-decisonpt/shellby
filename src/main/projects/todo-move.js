// To-dos left in config.projects.todo by a project that now has a clone here
// (a local-only repo's `local:<root>` list, or one saved before a cloned
// project's list became its .shellby/tasks.md) move into that file, so they
// travel with the repository. Each is added by text, and the file's add
// treats the same text as the same to-do, so a move that's cut short and run
// again never doubles one. A to-do the file won't take (it's capped, or the
// file mixes line endings) stays in config and is tried again on the next list.

/**
 * todo: config.projects.todo. mainRoot: Map project key -> its first clone.
 * rt: { add(root, text, from) -> { ok } } (wiring/backlog.js's backlogRepoTasks).
 * -> { todo, moved, changed }: the config list without what moved.
 */
function moveTodos(todo, mainRoot, rt) {
  if (!todo || !rt || !mainRoot) return { todo, moved: 0, changed: false };
  const next = { ...todo };
  let moved = 0;
  for (const [key, list] of Object.entries(todo)) {
    const root = mainRoot.get(key);
    if (!root || !Array.isArray(list)) continue;
    const left = list.filter(item => {
      const r = safeAdd(rt, root, item);
      if (r?.ok) moved++;
      return !r?.ok;
    });
    if (left.length === list.length) continue;
    if (left.length) next[key] = left;
    else delete next[key];
  }
  return { todo: moved ? next : todo, moved, changed: moved > 0 };
}

function safeAdd(rt, root, item) {
  try {
    return rt.add(root, item.text, item.from);
  } catch {
    return null;
  }
}

module.exports = { moveTodos };
