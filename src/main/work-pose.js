// How he works (pure): which working animation the crab plays, from the tool
// Claude has running. One body class per pose in critter.css (.work-<pose>);
// 'busy', the scuttle in place, is the one he had before there were others.
//   think   no tool running: Claude is thinking, so he taps his chin
//   read    reading files: leans in, eyes running along the lines
//   write   editing: scribbling away with his claw
//   run     a shell command: digging in
//   search  grep and glob: swivelling about, stalks up
//   web     the web: claw to his brow, on tiptoe, looking far off
//   crew    a subagent: waving the helpers on
//   busy    anything else (an MCP tool, a todo list...): the scuttle

const TOOLS = {
  read: ['Read', 'NotebookRead', 'LS'],
  write: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  run: ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash'],
  search: ['Grep', 'Glob', 'ToolSearch'],
  web: ['WebFetch', 'WebSearch'],
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
