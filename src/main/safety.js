// Extra context for permission cards when Claude is building tools for itself.
// Pure functions — see test/safety.test.js.
//
//  • runsCreated: a shell command that executes/references a file Claude wrote
//    earlier in this conversation (the "wrote a script, now runs it" pattern).
//  • selfConfig: a write or command touching Claude Code's own setup — skills,
//    agents, commands, hooks, settings, CLAUDE.md, MCP config. These change
//    what future sessions are allowed to do, so they deserve a second look.

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const SELF_CONFIG = [
  { re: /[\\/]\.claude[\\/]skills[\\/]/i, what: 'a skill' },
  { re: /[\\/]\.claude[\\/]agents[\\/]/i, what: 'a subagent' },
  { re: /[\\/]\.claude[\\/]commands[\\/]/i, what: 'a slash command' },
  { re: /[\\/]\.claude[\\/]hooks[\\/]/i, what: 'a hook script' },
  { re: /[\\/]\.claude[\\/]settings(\.local)?\.json\b/i, what: "Claude Code's settings" },
  { re: /(^|[\\/])\.mcp\.json\b/i, what: 'MCP server config' },
  { re: /[\\/]\.claude\.json\b/i, what: "Claude Code's config" },
  { re: /(^|[\\/])CLAUDE\.md\b/i, what: 'CLAUDE.md instructions' },
];

const norm = p => String(p).replace(/\//g, '\\').toLowerCase();

function selfConfigTarget(text) {
  if (!text) return null;
  const hit = SELF_CONFIG.find(s => s.re.test(text));
  return hit ? hit.what : null;
}

// Which previously-written files does this command mention? Matches full paths,
// and bare filenames that look like scripts/programs (has an extension, ≥ 3 chars).
function referencedFiles(command, createdFiles) {
  const cmd = norm(command);
  const hits = [];
  for (const file of createdFiles) {
    const full = norm(file);
    const base = full.split('\\').pop();
    const baseOk = base.length >= 3 && /\.[a-z0-9]{1,6}$/.test(base);
    const re = baseOk ? new RegExp(`(^|[\\s"'\\\\/&;|(])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s"';|)&])`) : null;
    if (cmd.includes(full) || (re && re.test(cmd))) hits.push(file);
  }
  return hits;
}

// Returns the flags to merge into a permission item.
function annotatePermission(item, { createdFiles = [], tasks = new Map() } = {}) {
  const flags = {};
  const command = SHELL_TOOLS.has(item.toolName) ? String(item.input?.command ?? '') : '';
  if (command) {
    const runs = referencedFiles(command, createdFiles);
    if (runs.length) flags.runsCreated = runs.slice(0, 5);
  }
  const target = selfConfigTarget(item.filePath || command);
  if (target) flags.selfConfig = target;
  if (item.agentId && tasks.has(item.agentId)) {
    const t = tasks.get(item.agentId);
    flags.agent = { taskId: item.agentId, toolUseId: t.toolUseId, description: t.description || '', type: t.subagentType || 'agent' };
  }
  return flags;
}

module.exports = { annotatePermission, referencedFiles, selfConfigTarget };
