// What his claws are busy with while Claude works: the tool running right now
// decides it (src/renderer/critter/beats.js draws it). He squints at a scroll
// while Claude reads or searches, scribbles with a pencil while it edits, turns
// a wrench while a command runs, sweeps a spyglass over the web, ticks off a
// checklist while it plans, and waves the helpers in when it hands work out.
// Anything else (and the thinking in between) is his plain scuttle: null.

const POSES = ['read', 'write', 'shell', 'web', 'plan', 'call'];

const BY_NAME = {
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', NotebookRead: 'read', LSP: 'read', ToolSearch: 'read',
  Edit: 'write', MultiEdit: 'write', Write: 'write', NotebookEdit: 'write',
  Bash: 'shell', PowerShell: 'shell', BashOutput: 'shell', KillShell: 'shell', KillBash: 'shell', Monitor: 'shell', TaskStop: 'shell',
  WebFetch: 'web', WebSearch: 'web',
  TodoWrite: 'plan', TaskCreate: 'plan', TaskUpdate: 'plan', TaskList: 'plan', EnterPlanMode: 'plan', ExitPlanMode: 'plan',
  Task: 'call', Agent: 'call', SendMessage: 'call', Workflow: 'call',
};

// An MCP tool (mcp__server__verb_thing) goes by its verb: a browser is the web,
// a lookup is reading, a change is writing. One that says nothing is null.
const MCP = [
  [/browser|navigate|click|screenshot|page|fetch|url/, 'web'],
  [/^(create|update|write|edit|delete|add|push|set|put|post|move|rename|merge|comment|upload|fill|type|insert)/, 'write'],
  [/^(get|read|list|search|find|query|fetch|lookup|view|show|describe|inspect|download)/, 'read'],
];

/** The pose for a tool name, or null for his plain scuttle. */
function poseOf(tool) {
  if (typeof tool !== 'string' || !tool) return null;
  if (Object.hasOwn(BY_NAME, tool)) return BY_NAME[tool];
  const m = /^mcp__.+?__(.+)$/.exec(tool);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  for (const [re, pose] of MCP) if (re.test(verb)) return pose;
  return null;
}

/**
 * Of several places tools run (Shellby's own tabs, sessions elsewhere), the one
 * that started most recently: [{ tool, toolAt }] -> tool name or null.
 */
function latestTool(sources) {
  let best = null;
  for (const s of sources || []) {
    if (s?.tool && (!best || (s.toolAt || 0) > (best.toolAt || 0))) best = s;
  }
  return best ? best.tool : null;
}

module.exports = { POSES, poseOf, latestTool };
