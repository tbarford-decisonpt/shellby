'use strict';
// Claude Code's own slash commands, and how Shellby handles each one. Pure: no
// fs, no Electron, so the renderer's copy (sent with the toolbox), the tests
// and scripts/commands-check.js all read the same list.
//
// handling:
//   'cli'      sent to Claude Code as it is: it works in print mode.
//   'shellby'  opens the screen or does the thing Shellby has for it
//              (builtin-commands.js in the panel).
//   'terminal' only works in Claude Code's own terminal (it opens a panel or
//              changes the terminal). Shellby says why and offers to carry the
//              conversation on in a terminal.
// hidden: Claude Code has it but never lists it (internal or renamed), so the
// menu leaves it out. It's still here so the drift check knows it.
//
// The list is Claude Code 2.1.295's (test/fixtures/cli-commands.json is the
// recorded copy). `npm run commands:check` diffs it against the installed CLI.

const CLI = 'cli';
const SHELLBY = 'shellby';
const TERMINAL = 'terminal';
const PANEL = 'It opens a panel in the terminal.';

/** @type {Array<{ name: string, description: string, handling: string, reason?: string, aliases?: string[], hidden?: boolean }>} */
const CATALOGUE = [
  { name: 'add-dir', handling: CLI, description: 'Add another folder Claude can work in.' },
  { name: 'advisor', handling: CLI, description: 'Let Claude ask a stronger model at key moments.' },
  { name: 'agents', handling: SHELLBY, description: 'Your helper agents, in the Toolbox.', hidden: true },
  { name: 'artifacts', handling: TERMINAL, reason: PANEL, description: 'Browse your published and shared artifacts.' },
  { name: 'auto-mode-setup', handling: CLI, description: 'Teach auto mode about your setup.' },
  { name: 'autocompact', handling: CLI, description: 'How full the context gets before it is summarized.' },
  { name: 'autofix-pr', handling: TERMINAL, reason: 'It watches the pull request from the terminal.', description: 'Watch the current pull request and fix what goes wrong.' },
  { name: 'background', handling: TERMINAL, aliases: ['bg'], reason: 'It frees up a terminal, and Shellby has none to free.', description: 'Send the session to the background.' },
  { name: 'branch', handling: SHELLBY, description: 'Try again from an earlier message in a new tab.' },
  { name: 'brief', handling: TERMINAL, reason: 'It changes what the terminal shows.', description: 'Turn brief-only mode on or off.' },
  { name: 'btw', handling: SHELLBY, description: 'Ask a quick side question without interrupting.' },
  { name: 'bug', handling: SHELLBY, aliases: ['share'], description: 'Report a Claude Code bug on GitHub.' },
  { name: 'cd', handling: TERMINAL, reason: "It moves the session to another folder, and the tab can't follow. Open a new conversation in that folder instead.", description: 'Move the session to another folder.' },
  { name: 'chrome', handling: TERMINAL, reason: PANEL, description: 'Claude in Chrome settings.' },
  { name: 'clear', handling: CLI, description: 'Start the conversation over, without its history.' },
  { name: 'cloud-plugins', handling: TERMINAL, reason: PANEL, description: 'Whether cloud sessions use the plugins on this PC.' },
  { name: 'color', handling: CLI, description: "Set the terminal prompt bar's color for this session." },
  { name: 'compact', handling: CLI, description: 'Summarize the conversation so far to free up context.' },
  { name: 'config', handling: SHELLBY, aliases: ['settings'], description: 'Open the settings.' },
  { name: 'context', handling: CLI, description: 'Show what is using the context window.' },
  { name: 'copy', handling: TERMINAL, reason: 'Every reply here has its own copy button.', description: "Copy Claude's last reply." },
  { name: 'daemon', handling: TERMINAL, reason: PANEL, description: 'Manage background services and routines.' },
  { name: 'design-consent', handling: CLI, description: 'Let Claude use your Design projects.' },
  { name: 'design-login', handling: TERMINAL, reason: 'It signs you in from the terminal.', description: 'Sign in for design-system access.' },
  { name: 'design-revoke', handling: CLI, description: 'Stop Claude using your Design projects.' },
  { name: 'desktop', handling: TERMINAL, aliases: ['app'], reason: 'It hands the terminal session to Claude Desktop.', description: 'Carry on in Claude Desktop.' },
  { name: 'diff', handling: SHELLBY, description: 'See the changes Claude made.' },
  { name: 'doctor', handling: SHELLBY, aliases: ['checkup'], description: 'Check your setup for problems (Health).' },
  { name: 'effort', handling: SHELLBY, description: 'How hard Claude thinks.' },
  { name: 'exit', handling: TERMINAL, aliases: ['quit'], reason: 'Close the tab instead.', description: 'Leave Claude Code.' },
  { name: 'export', handling: SHELLBY, description: 'Save the conversation as Markdown.' },
  { name: 'extra-usage', handling: CLI, description: 'Renamed to /usage-credits.', hidden: true },
  { name: 'fast', handling: CLI, description: 'Turn fast mode on or off.' },
  { name: 'feedback', handling: SHELLBY, description: 'Send feedback on Claude Code.' },
  { name: 'focus', handling: TERMINAL, reason: 'It changes what the terminal shows.', description: 'Show just your prompt, a summary and the reply.' },
  { name: 'fork', handling: TERMINAL, reason: 'It starts a background session in the terminal. /branch does this here.', description: 'Copy the conversation into a background session.' },
  { name: 'goal', handling: CLI, description: 'Set a goal Claude checks before it stops.' },
  { name: 'heapdump', handling: CLI, description: 'Dump the JS heap to the Desktop.', hidden: true },
  { name: 'help', handling: SHELLBY, description: 'Every command, in the Toolbox.' },
  { name: 'hooks', handling: SHELLBY, description: 'Your hooks, in the Toolbox.' },
  { name: 'ide', handling: TERMINAL, reason: PANEL, description: 'Manage IDE integrations.' },
  { name: 'import', handling: CLI, description: 'Bring in settings from another AI coding agent.' },
  { name: 'init', handling: CLI, description: 'Write a CLAUDE.md that describes this project.' },
  { name: 'insights', handling: CLI, description: 'A report on how you use Claude Code.' },
  { name: 'install', handling: SHELLBY, description: 'Install or update Claude Code.' },
  { name: 'install-github-app', handling: TERMINAL, reason: PANEL, description: 'Set up Claude GitHub Actions for a repository.' },
  { name: 'install-slack-app', handling: CLI, description: 'Install the Claude Slack app.' },
  { name: 'keybindings', handling: SHELLBY, description: "Shellby's keyboard shortcuts." },
  { name: 'list-agents', handling: CLI, aliases: ['peers'], description: 'List the agents and sessions you can message.' },
  { name: 'login', handling: SHELLBY, description: 'Sign in, or switch Claude accounts.' },
  { name: 'logout', handling: SHELLBY, description: 'Sign out of your Claude account.' },
  { name: 'loops', handling: TERMINAL, reason: PANEL, description: 'List, create and delete loops.' },
  { name: 'mcp', handling: SHELLBY, description: 'MCP servers, in the Toolbox.' },
  { name: 'memory', handling: SHELLBY, description: 'Your CLAUDE.md memory files, in the Toolbox.' },
  { name: 'mobile', handling: TERMINAL, aliases: ['ios', 'android'], reason: 'It shows a QR code in the terminal.', description: 'Get the Claude mobile app.' },
  { name: 'model', handling: SHELLBY, description: 'Pick the model.' },
  { name: 'output-style', handling: SHELLBY, description: 'How Claude writes its replies.' },
  { name: 'passes', handling: TERMINAL, reason: PANEL, description: 'Share a free week of Claude Code with friends.' },
  { name: 'pause-memory', handling: CLI, aliases: ['memory-pause', 'toggle-memory'], description: 'Pause or resume auto memory.' },
  { name: 'permissions', handling: SHELLBY, aliases: ['allowed-tools'], description: 'The allow, ask and deny rules.' },
  { name: 'plan', handling: SHELLBY, description: 'Switch to plan mode.' },
  { name: 'plugin', handling: SHELLBY, aliases: ['plugins', 'marketplace'], description: 'Plugins and marketplaces, in the Skill Shop.' },
  { name: 'powerup', handling: TERMINAL, reason: 'Its lessons run in the terminal.', description: 'Learn Claude Code features in quick lessons.' },
  { name: 'privacy-settings', handling: TERMINAL, reason: PANEL, description: 'View and change your privacy settings.' },
  { name: 'pro-trial-expired', handling: TERMINAL, reason: PANEL, description: 'Options once the Pro trial ends.', hidden: true },
  { name: 'radio', handling: TERMINAL, reason: 'It plays in the terminal.', description: 'Listen to Claude FM lo-fi radio.' },
  { name: 'rate-limit-options', handling: TERMINAL, reason: PANEL, description: 'Usage limit and upgrade options.', hidden: true },
  { name: 'recap', handling: CLI, description: 'A one-line recap of the session.' },
  { name: 'release-notes', handling: CLI, description: 'What changed in recent versions.' },
  { name: 'reload-plugins', handling: CLI, description: 'Turn on plugin changes made during this session.' },
  { name: 'reload-skills', handling: CLI, description: 'Pick up skills added or changed on disk.' },
  { name: 'remote-control', handling: TERMINAL, aliases: ['rc'], reason: 'It hands the terminal session to claude.ai.', description: 'Control this session from claude.ai.' },
  { name: 'remote-env', handling: CLI, description: 'The default environment for cloud agents.' },
  { name: 'rename', handling: CLI, aliases: ['name'], description: 'Rename the conversation.' },
  { name: 'restart', handling: SHELLBY, aliases: ['update'], description: 'Update Claude Code (Settings).' },
  { name: 'resume', handling: SHELLBY, description: 'Pick up an earlier conversation (History).' },
  { name: 'rewind', handling: SHELLBY, aliases: ['checkpoint', 'undo'], description: 'Go back to an earlier point.' },
  { name: 'scroll-speed', handling: TERMINAL, reason: 'It sets how the terminal scrolls.', description: 'Mouse wheel scroll speed.' },
  { name: 'security-review', handling: CLI, description: 'Look over the changes on this branch for security problems.' },
  { name: 'session', handling: TERMINAL, aliases: ['remote'], reason: 'It shows a QR code in the terminal.', description: 'The cloud session link and QR code.' },
  { name: 'setup-bedrock', handling: TERMINAL, reason: PANEL, description: 'Set up Amazon Bedrock sign-in, region or models.' },
  { name: 'setup-vertex', handling: TERMINAL, reason: PANEL, description: 'Set up Google Vertex AI sign-in, project or models.' },
  { name: 'skill-doctor', handling: CLI, description: 'Which skills go unused and cost context.' },
  { name: 'skills', handling: SHELLBY, description: 'Your skills, in the Toolbox.' },
  { name: 'status', handling: SHELLBY, description: 'Your Claude Code version, account and plan.' },
  { name: 'statusline', handling: CLI, description: "Set up Claude Code's status line." },
  { name: 'stickers', handling: TERMINAL, reason: 'It opens in the terminal.', description: 'Order Claude Code stickers.' },
  { name: 'stop', handling: TERMINAL, reason: 'It stops a background terminal session. The stop button does it here.', description: 'Stop a background session.' },
  { name: 'subtask', handling: TERMINAL, reason: PANEL, description: 'Send a helper off with your full context.' },
  { name: 'tasks', handling: TERMINAL, aliases: ['bashes'], reason: PANEL, description: 'What is running in the background.' },
  { name: 'team-onboarding', handling: CLI, description: 'A guide that helps teammates ramp up on Claude Code.' },
  { name: 'teleport', handling: TERMINAL, aliases: ['tp'], reason: 'It hands the terminal session to the cloud.', description: 'Send the session to the cloud, or resume one.' },
  { name: 'terminal-setup', handling: TERMINAL, reason: 'It sets up key bindings in your terminal.', description: 'Set up Shift+Enter for new lines.' },
  { name: 'theme', handling: TERMINAL, reason: "It sets the terminal's colors.", description: "Change Claude Code's theme." },
  { name: 'tui', handling: TERMINAL, reason: 'It picks how the terminal draws.', description: 'The terminal renderer: default or fullscreen.' },
  { name: 'ultraplan', handling: TERMINAL, reason: 'A cloud session drafts the plan from the terminal.', description: 'A cloud session drafts a plan you can edit.' },
  { name: 'ultrareview', handling: CLI, description: 'Find and check bugs on your branch in a cloud session.' },
  { name: 'upgrade', handling: CLI, description: 'Upgrade your plan for higher limits.' },
  { name: 'usage', handling: SHELLBY, aliases: ['cost', 'stats'], description: 'Plan usage, cost and limits.' },
  { name: 'usage-credits', handling: CLI, description: 'Set up usage credits for when you hit a limit.' },
  { name: 'version', handling: CLI, description: 'The Claude Code version this session runs.' },
  { name: 'voice', handling: TERMINAL, reason: 'It listens through the terminal.', description: 'Turn voice mode on or off.' },
  { name: 'web-setup', handling: TERMINAL, reason: PANEL, description: 'Set up cloud sessions with your GitHub account.' },
  { name: 'wellbeing', handling: TERMINAL, aliases: ['breaks', 'break-reminder', 'downtime'], reason: PANEL, description: 'Break reminders and quiet-hours nudges.' },
  { name: 'workflow-launch-exec', handling: CLI, description: 'Runs a server-launched workflow.', hidden: true },
  { name: 'workflows', handling: TERMINAL, reason: PANEL, description: "Browse Claude Code's running and finished workflows." },
];

const BY_NAME = new Map();
for (const c of CATALOGUE) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases || []) if (!BY_NAME.has(a)) BY_NAME.set(a, c);
}

/** The catalogue entry for a name or alias, or null. */
const builtin = name => (typeof name === 'string' && BY_NAME.get(name.replace(/^\//, '').toLowerCase())) || null;

/** A menu/toolbox item for an entry. description: the live CLI's, when it gave one. */
const builtinItem = (c, description = '') => ({
  kind: 'command', name: c.name, description: description || c.description, source: 'cli', path: null,
  builtin: true, handling: c.handling, ...(c.reason ? { reason: c.reason } : {}), ...(c.aliases ? { aliases: c.aliases } : {}),
});

/**
 * The catalogue's commands for the menu. Names the live CLI lists that the
 * catalogue doesn't know are toolbox.js mergeInit's: they go through as they are.
 * live: the init's slash_commands (null before any init). said: Map of
 * name -> description from commands_changed, which wins over ours.
 * Once an init has listed commands, a 'cli' entry it no longer lists is gone
 * from that CLI and hidden. 'shellby' and 'terminal' ones stay: print mode
 * never lists commands that open a panel, and Shellby runs those itself.
 */
function builtinCommands(live, said = new Map()) {
  const listed = Array.isArray(live) && live.length ? new Set(live) : null;
  return CATALOGUE
    .filter(c => !c.hidden && !(listed && c.handling === CLI && !listed.has(c.name) && !said.has(c.name)))
    .map(c => builtinItem(c, said.get(c.name)));
}

/** Is name one of Claude Code's own (or an alias of one)? */
const isBuiltin = name => !!builtin(name);

// What print mode answers a command it can't run with (Claude Code 2.1.295):
// "/theme opens an interactive panel and isn't available in this environment…",
// "/x isn't available in this environment." and "Unknown command: /x. Did you mean /y?"
const UNAVAILABLE = /^\/([\w:-]+)\b[^\n]*isn['’]t available in this environment/i;
const UNKNOWN = /Unknown (?:slash )?command:\s*\/([\w:-]+)(?:\.\s*Did you mean \/([\w:-]+)\?)?/i;

/**
 * A plain-words reply for the CLI's "can't run that here" answers, or null when
 * text isn't one. Without it the turn ends with nothing to read.
 */
function headlessReply(text) {
  if (typeof text !== 'string' || !text) return null;
  const s = text.replace(/<\/?local-command-std(?:out|err)>/g, '').trim();
  const u = UNAVAILABLE.exec(s);
  if (u) {
    const c = builtin(u[1]);
    const why = c?.reason && c.handling === TERMINAL ? ` ${c.reason}` : '';
    return `/${u[1]} only works in Claude Code's own terminal.${why} To use it, open this conversation in a terminal: Ctrl+K, then "Continue this conversation in a terminal".`;
  }
  const k = UNKNOWN.exec(s);
  if (k) return `Claude Code doesn't have a /${k[1]} command${k[2] ? `. Did you mean /${k[2]}?` : '.'} Type / to see them all.`;
  return null;
}

module.exports = { CATALOGUE, HANDLING: { CLI, SHELLBY, TERMINAL }, builtin, isBuiltin, builtinItem, builtinCommands, headlessReply };
