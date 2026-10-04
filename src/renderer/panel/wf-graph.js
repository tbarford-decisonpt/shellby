// The workflow map's bookkeeping (workflow-canvas.js draws it): how a step's
// run-record key is formed, how all of a step's runs add up to one status, and
// where a step may be dragged to. Pure, no DOM. Works in the browser and in Node
// (for tests).
(function (root) {
  const CONTAINERS = { if: ['then', 'else'], each: ['steps'] };
  const kids = s => (CONTAINERS[s?.type] || []).map(k => [k, Array.isArray(s[k]) ? s[k] : []]);

  // ---- run records -> nodes

  // The engine numbers loop passes (files.each3.move); the map has one node for all of them.
  const keyTemplate = key => String(key).replace(/\.each\d+\./g, '.each*.');

  // Where a container's steps are keyed (engine.js: `${key}.then.`, `${key}.each${i}.`).
  const childBase = (step, key, list) => (step.type === 'each' ? `${key}.each*.` : `${key}.${list}.`);

  // Most telling first: anything still going, then a failure, then done. A step
  // that ran on some passes of a loop and was skipped on others did run.
  const RANK = ['running', 'retrying', 'waiting', 'error', 'interrupted', 'stopped', 'ok', 'skipped', 'pending'];

  function aggregate(entries) {
    if (!entries.length) return null;
    const status = RANK.find(s => entries.some(e => e.status === s)) || entries[entries.length - 1].status;
    const branches = [...new Set(entries.map(e => e.output?.branch).filter(Boolean))];
    return { status, passes: entries.length, entries, branches };
  }

  // run.steps keyed by template: Map('files.each*.move' -> { status, passes, entries, branches })
  function statusMap(run) {
    const groups = new Map();
    const steps = run?.steps || {};
    for (const k of run?.order || Object.keys(steps)) {
      const e = steps[k];
      if (!e) continue;
      const t = keyTemplate(k);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(e);
    }
    return new Map([...groups].map(([t, es]) => [t, aggregate(es)]));
  }

  // Every step with the template its run entries are filed under.
  function stepKeys(steps, base = '') {
    const out = [];
    for (const s of steps || []) {
      if (!s?.id) continue;
      const key = `${base}${s.id}`;
      out.push({ step: s, key });
      for (const [k, list] of kids(s)) out.push(...stepKeys(list, childBase(s, key, k)));
    }
    return out;
  }

  // Entries no step on the map stands for: the workflow has changed since that run.
  function strays(steps, map) {
    const known = new Set(stepKeys(steps).map(x => x.key));
    return [...map.keys()].filter(k => !known.has(k));
  }

  // ---- moving steps around

  function findPlace(steps, step) {
    for (let i = 0; i < (steps || []).length; i++) {
      if (steps[i] === step) return { list: steps, index: i };
      for (const [, list] of kids(steps[i])) {
        const p = findPlace(list, step);
        if (p) return p;
      }
    }
    return null;
  }

  // 1 for the top list, 2 inside a top-level If or Repeat… 0 when it isn't in the workflow.
  function listDepth(steps, target, depth = 1) {
    if (steps === target) return depth;
    for (const s of steps || []) {
      for (const [, list] of kids(s)) {
        const d = listDepth(list, target, depth + 1);
        if (d) return d;
      }
    }
    return 0;
  }

  // How many levels a step takes up. A container always needs room for its
  // own steps, even while it has none (the same rule the step menu follows).
  function nesting(step) {
    const lists = kids(step);
    if (!lists.length) return 1;
    return 1 + Math.max(1, ...lists.flatMap(([, list]) => list.map(nesting)));
  }

  const contains = (step, target) => kids(step).some(([, list]) => list === target || list.some(s => contains(s, target)));

  function canDrop(steps, step, target, maxDepth) {
    if (!findPlace(steps, step) || contains(step, target)) return false;
    const depth = listDepth(steps, target);
    return depth > 0 && depth + nesting(step) - 1 <= maxDepth;
  }

  // Moves step so it lands at `index` of target as target is now (before the step
  // leaves). Returns false, changing nothing, when it can't go there or wouldn't move.
  function moveTo(steps, step, target, index, maxDepth) {
    if (!canDrop(steps, step, target, maxDepth)) return false;
    const from = findPlace(steps, step);
    const at = from.list === target && from.index < index ? index - 1 : index;
    if (from.list === target && at === from.index) return false;
    from.list.splice(from.index, 1);
    target.splice(Math.max(0, Math.min(at, target.length)), 0, step);
    return true;
  }

  const api = { CONTAINERS, keyTemplate, childBase, aggregate, statusMap, stepKeys, strays, findPlace, listDepth, nesting, canDrop, moveTo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyWfGraph = api;
})(typeof window !== 'undefined' ? window : globalThis);
