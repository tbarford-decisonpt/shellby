// How he works (pure): which working animation the crab plays, from the tool
// Claude has running. One body class per pose in critter.css (.work-<pose>),
// and most of them have something in his claw (renderer/shared/workposes.js);
// 'busy', the scuttle in place, is the one he had before there were others.
//   think   no tool running: Claude is thinking, so he taps his chin
//   read    reading files: leans in over a scroll, eyes running along the lines
//   write   editing: scribbling away with a pencil
//   run     a shell command: digging in, turning a wrench
//   search  grep and glob: swivelling about with a magnifying glass, stalks up
//   web     the web: a spyglass to his eye, on tiptoe, looking far off
//   plan    a to-do list or a plan: ticking off a checklist
//   crew    a subagent: waving the helpers on
//   busy    anything else (an MCP tool...): the scuttle

const TOOLS = {
  read: ['Read', 'NotebookRead', 'LS'],
  write: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  run: ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash'],
  search: ['Grep', 'Glob', 'ToolSearch'],
  web: ['WebFetch', 'WebSearch'],
  plan: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'EnterPlanMode', 'ExitPlanMode'],
  crew: ['Agent', 'Task'],
};
const POSE_OF = new Map(Object.entries(TOOLS).flatMap(([pose, names]) => names.map(n => [n, pose])));
const POSES = ['think', ...Object.keys(TOOLS), 'busy'];

/** A tool name (or null between tools) -> one of POSES. */
function poseOf(tool) {
  if (!tool) return 'think';
  return POSE_OF.get(tool) || 'busy';
}

/**
 * Of several { tool, toolAt } (tabs, outside sessions), the one whose tool
 * started or finished last, or null when none has run one yet.
 */
function latest(list) {
  let best = null;
  for (const s of list) if (s && Number.isFinite(s.toolAt) && (!best || s.toolAt > best.toolAt)) best = s;
  return best;
}

module.exports = { POSES, poseOf, latest };
