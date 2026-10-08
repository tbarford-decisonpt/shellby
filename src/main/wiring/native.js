// The crab noticing what Claude Code does by itself: its to-do list ticking
// over, a command it left running in the background finishing, a memory it
// wrote down, a skill it reached for the first time. Shellby runs none of
// these: it watches each conversation's items and says so (voice.js), the way
// he already remarks on a test run or a push.
// Kept out of main.js, which only wires it up.
const todos = require('../../renderer/shared/todos');

const MAX_SEEN_SKILLS = 500;
const MAX_JOBS_KEPT = 400;

/** d: what main shares (main.js `shared`). */
function wireNative(d) {
  const jobStatus = new Map(); // `${tabId}:${job id}` -> its status when last seen
  const todosDone = new Map(); // tabId -> to-dos done when last seen

  // Routines and workflows run on their own: he only remarks on your conversations.
  const yours = tab => !!tab && !tab.routineId && !tab.workflowRunId;

  function onJobs(tabId, view, tab) {
    for (const j of view) {
      const key = `${tabId}:${j.id}`;
      const was = jobStatus.get(key);
      jobStatus.delete(key);
      jobStatus.set(key, j.status);
      if (jobStatus.size > MAX_JOBS_KEPT) jobStatus.delete(jobStatus.keys().next().value);
      if (was !== 'running' || j.status === 'running' || j.status === 'stopped' || !yours(tab)) continue;
      d.speak?.(j.status === 'failed' ? 'jobFailed' : 'jobDone');
    }
  }

  function onTodos(tabId, s, tab) {
    const before = todosDone.get(tabId) ?? 0;
    todosDone.delete(tabId);
    todosDone.set(tabId, s.done);
    if (todosDone.size > 100) todosDone.delete(todosDone.keys().next().value);
    if (!yours(tab) || s.done <= before) return;
    // The last box ticked on a list worth the name gets its own line.
    d.speak?.(todos.allDone(s) && s.total >= 2 ? 'todosAll' : 'todoDone');
  }

  // The first time Claude uses a skill in Shellby: a line from him, and the panel says so.
  function skillUsed(tabId, name) {
    if (d.CAPTURE || !d.config || !name) return;
    const seen = d.config.get('skillsSeen') || [];
    if (seen.includes(name)) return;
    d.config.set({ skillsSeen: [...seen, name].slice(-MAX_SEEN_SKILLS) });
    d.speak?.('skillFirst', { force: true });
    const win = d.tabWindow?.(tabId) || d.panel; // the panel, or the conversation's own window
    d.send(win, 'native:skill-first', { tabId, name });
  }

  /** wiring/sessions.js: every item of every tab. */
  function onItem(tabId, item, tab) {
    // The conversation was compacted: he squashes his load down and pats it flat.
    if (item.kind === 'compacted' && yours(tab)) {
      d.send(d.critter, 'critter:bit', { bit: 'pack', ms: 2200 });
      d.speak?.('compacted');
      return;
    }
    if (item.kind !== 'tool' || !yours(tab)) return;
    if (item.skill) skillUsed(tabId, item.skill);
    if (item.memory && !item.memory.index) d.speak?.('remembered');
    if (item.name === 'ExitPlanMode' || (item.name === 'EnterPlanMode' && !item.sub)) d.refreshCritter?.();
  }

  function attach(manager) {
    manager.on('jobs', onJobs);
    manager.on('todos', onTodos);
  }

  return { attach, onItem, skillUsed };
}

module.exports = { wireNative };
