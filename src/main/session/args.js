'use strict';

// How a ClaudeSession's process is launched: its command line, its MCP config
// and the hooks it registers, mixed into its prototype by session/index.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { CLI_MODE } = require('../config');
const crabmcp = require('../crabmcp');
// Effort levels Claude Code takes (--effort). '' leaves it to Claude Code.
const { EFFORTS } = require('../cli-contract');

// The tools that can change files, for the beforeWork hook.
const WORK_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';
const WORK_HOOK = 'shellby-before-work';
// Every finished tool call on the main thread, so what you typed while Claude
// works can go in before its next step (steer()).
const STEER_HOOK = 'shellby-steer';

// Flags newer than the rest, passed only when this Claude Code lists them in
// its --help (claude/cli.js helpFlags): an older one stops at a flag it doesn't
// know, and every turn would fail. On another computer its version isn't known,
// so they're left out there.
const OPTIONAL_FLAGS = Object.freeze(['--include-partial-messages', '--forward-subagent-text', '--fallback-model', '--name', '--agent', '--safe-mode', '--chrome']);
// A conversation's name as Claude Code shows it (--name): one line, not too long.
const NAME_MAX = 100;
/** @param {unknown} v */
const cleanName = v => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

// A conversation's --mcp-config, in the temp folder (yours alone). null if it
// can't be written: the definitions then go on the command line as before.
/** @param {object} config @returns {string | null} */
function writeConfig(config) {
  const file = path.join(os.tmpdir(), `shellby-mcp-${randomUUID()}.json`);
  try { fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' }); return file; } catch { return null; }
}
/** @param {string | null} file */
const removeFile = file => { if (file) fs.rm(file, { force: true }, () => {}); };

// The hooks Shellby registers with initialize: steering always, the work hook
// when something watches work (beforeWork). scripts/cli-compat.js sends the same.
/** @param {boolean} watchWork */
function initHooks(watchWork) {
  const steerAt = [{ matcher: '.*', hookCallbackIds: [STEER_HOOK] }];
  /** @type {Record<string, { matcher: string, hookCallbackIds: string[] }[]>} */
  const hooks = { PostToolUse: steerAt, PostToolUseFailure: steerAt };
  if (watchWork) hooks.PreToolUse = [{ matcher: WORK_TOOLS, hookCallbackIds: [WORK_HOOK] }];
  return hooks;
}

const args = {
  buildArgs() {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio',
      // Each message echoed back as Claude reads it: how a steer is known to have landed.
      '--replay-user-messages',
      '--permission-mode', CLI_MODE[this.mode] || 'default',
      // Lets the user switch into Autonomous mid-conversation; it has no effect
      // unless that mode is actually selected.
      '--allow-dangerously-skip-permissions',
    ];
    if (this.systemNote) args.push('--append-system-prompt', this.systemNote);
    if (this.model) args.push('--model', this.model);
    if (EFFORTS.includes(this.effort)) args.push('--effort', this.effort);
    if (this.outputStyle) args.push('--settings', JSON.stringify({ outputStyle: this.outputStyle }));
    // The rest only when this Claude Code takes them (OPTIONAL_FLAGS).
    const can = flag => !this.remoteHost && !!this.supports?.(flag);
    // The reply as it's written, and what each helper says, not only its tool calls.
    if (can('--include-partial-messages')) args.push('--include-partial-messages');
    if (can('--forward-subagent-text')) args.push('--forward-subagent-text');
    if (this.fallbackModel && this.fallbackModel !== this.model && can('--fallback-model')) args.push('--fallback-model', this.fallbackModel);
    if (this.chrome && can('--chrome')) args.push('--chrome');
    if (this.safeMode && can('--safe-mode')) args.push('--safe-mode');
    if (this.agent && can('--agent')) args.push('--agent', this.agent);
    const name = cleanName(this.nameOf?.());
    if (name && can('--name')) args.push('--name', name);
    // The crab's own tools are allowed outright: they can't run anything or
    // change anything that matters, so a permission card for each would be noise.
    const allowed = [...(this.allowedTools || []), ...(this.mcp ? [`mcp__${crabmcp.SERVER}`] : [])];
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    const mcpConfig = this.fullMcpConfig();
    if (this.mcpConfig) args.push('--strict-mcp-config', '--mcp-config', this.mcpConfigFile || JSON.stringify(mcpConfig));
    else if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig));
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      if (this.resumeAt) args.push(`--resume-session-at=${this.resumeAt}`, '--fork-session');
    }
    return args;
  },

  // The MCP servers this process loads beyond the usual ones: a routine's or
  // workflow step's own (strict), with the crab's in-app server alongside.
  fullMcpConfig() {
    if (!this.mcp) return this.mcpConfig;
    return { ...(this.mcpConfig || {}), mcpServers: { ...(this.mcpConfig?.mcpServers || {}), ...crabmcp.servers() } };
  },
};

module.exports = { args, EFFORTS, OPTIONAL_FLAGS, WORK_HOOK, STEER_HOOK, writeConfig, removeFile, initHooks };
