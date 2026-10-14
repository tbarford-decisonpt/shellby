'use strict';
// Everything Claude Code offers, and what Shellby does about each: so a new
// flag, subcommand or tool is noticed the night it ships, not when someone
// happens to read the changelog. cli-contract.js is the other half: what
// Shellby *needs*, which fails the nightly run when it breaks. This one never
// fails it; it lists what nobody has decided about yet (scripts/cli-compat.js
// writes it into the report, and .github/workflows/cli-compat.yml keeps a
// `cli-new` issue open while anything is unaccounted for or still a gap).
//
// Every entry is one of:
//   use(where)  Shellby uses it: where, so the claim can be checked.
//   skip(why)   deliberately left out, and why.
//   gap(what)   worth having and not built yet: what it would be.
// Slash commands have their own list (cli-commands.js, `npm run commands:check`).
//
// Pure: test/cli-coverage.test.js reads test/fixtures/claude-help.txt (the
// --help of Claude Code 2.1.296) and the recorded transcripts' tool lists.

const use = where => ({ status: 'use', where });
const skip = why => ({ status: 'skip', why });
const gap = what => ({ status: 'gap', what });

const BG = gap('Background sessions: list `claude agents`, open one as a tab (attach), show its logs, stop, respawn and remove it, and tell you when one finishes.');
const BRIEF = gap('SendUserMessage (--brief): Claude sends short updates while it works, said by the crab in a bubble.');
const TERMINAL_ONLY = 'It drives a terminal UI, which Shellby replaces.';

/** Every option in `claude --help`, by its long name. */
const FLAGS = Object.freeze({
  '--add-dir': skip('Extra folders are added with /add-dir in the conversation (cli-commands.js).'),
  '--agent': use('session.js: a tab started as one of your agents'),
  '--agents': skip('Agents are files in ~/.claude/agents, which the Toolbox manages.'),
  '--allow-dangerously-skip-permissions': use('session.js: Bypass mode'),
  '--allowedTools': use('session.js, backlog/trackers.js'),
  '--append-system-prompt': use('session.js, btw.js'),
  '--autocompact': skip('Set with /autocompact in the conversation (cli-commands.js).'),
  '--ax-screen-reader': skip(TERMINAL_ONLY),
  '--bg': BG,
  '--bare': skip('Shellby wants hooks, plugins and CLAUDE.md loaded.'),
  '--betas': skip('API beta headers: for API-key users experimenting by hand.'),
  '--brief': BRIEF,
  '--chrome': use('session.js: Claude in Chrome'),
  '--cloud': use('handoff.js: send a conversation to the cloud'),
  '--continue': skip('Shellby resumes the exact session with --resume.'),
  '--dangerously-skip-permissions': skip('Bypass goes through --allow-dangerously-skip-permissions and --permission-mode.'),
  '--debug': skip('Debug mode is a terminal-side tool.'),
  '--debug-file': skip('Debug mode is a terminal-side tool.'),
  '--desktop': skip('Opens the Claude Desktop app instead: the opposite of what Shellby is for.'),
  '--disable-slash-commands': skip('Skills stay on.'),
  '--disallowedTools': use('backlog/trackers.js'),
  '--effort': use('session.js'),
  '--environment': skip('Cloud sessions go through --cloud and claude.ai\'s own environments.'),
  '--exclude-dynamic-system-prompt-sections': skip('A prompt-caching tweak for SDK hosts with many identical runs.'),
  '--fallback-model': use('session.js'),
  '--file': skip('Downloads Files API resources at startup: API-key only.'),
  '--fork-session': use('session.js: /branch'),
  '--forward-subagent-text': use('session.js: helper crabs'),
  '--from-pr': use('handoff.js'),
  '--help': use('cli-compat.js'),
  '--ide': skip('Shellby opens files in your editor itself (editor.js).'),
  '--include-hook-events': skip('Hooks Shellby needs come through the initialize handshake (session.js initHooks).'),
  '--include-partial-messages': use('session.js: the reply as it\'s written'),
  '--input-format': use('session.js'),
  '--json-schema': use('council/run.js, backlog/trackers.js'),
  '--max-budget-usd': use('cloud-routines.js'),
  '--mcp-config': use('session.js'),
  '--model': use('session.js'),
  '--name': use('session.js'),
  '--no-chrome': skip('Chrome is off unless --chrome is passed.'),
  '--no-session-persistence': use('btw.js, backlog/trackers.js'),
  '--output-format': use('session.js'),
  '--permission-mode': use('session.js'),
  '--permission-prompts': gap('Check whether it replaces --permission-prompt-tool, which Shellby launches with (cli-contract.js).'),
  '--plugin-dir': skip('Plugins are installed (marketplace.js); this loads one for a single session.'),
  '--plugin-url': skip('Plugins are installed (marketplace.js); this loads one for a single session.'),
  '--print': use('session.js'),
  '--prompt-suggestions': use('session.js: promptSuggestions in initialize'),
  '--remote-control': skip('Hands a terminal session to claude.ai; /remote-control is marked terminal (cli-commands.js).'),
  '--remote-control-session-name-prefix': skip('Goes with --remote-control.'),
  '--replay-user-messages': use('session.js'),
  '--restricted': skip('Strips the built-in tools: for locked-down SDK hosts.'),
  '--resume': use('session.js'),
  '--safe-mode': use('session.js'),
  '--session-id': skip('Shellby takes the id Claude Code gives the session.'),
  '--setting-sources': use('claude/cli.js, cloud-routines.js'),
  '--settings': use('session.js'),
  '--strict-mcp-config': use('session.js'),
  '--system-prompt': use('council/run.js, backlog/trackers.js'),
  '--system-prompt-snapshot': skip('A debugging record of the system prompt.'),
  '--teleport': use('handoff.js: bring a cloud session home'),
  '--tmux': skip('tmux isn\'t on Windows.'),
  '--tools': use('btw.js, backlog/trackers.js'),
  '--verbose': use('session.js'),
  '--version': use('claude/cli.js'),
  '--worktree': skip('Shellby makes its own copies (copy-service.js), with its own branch names and installs.'),
});

/** Every subcommand in `claude --help`. */
const COMMANDS = Object.freeze({
  agents: BG,
  attach: BG,
  auth: use('claude/cli.js: sign-in state'),
  'auto-mode': skip('Auto mode is set up with /auto-mode-setup in the conversation.'),
  doctor: use('toolbox-snippets.js'),
  gateway: skip('Enterprise auth gateway, run by an admin.'),
  import: skip('Run once by hand; /import works in the conversation (cli-commands.js).'),
  install: use('claude/update.js'),
  logs: BG,
  mcp: use('mcpadmin.js'),
  plugin: use('marketplace.js'),
  purge: gap('Forget a project: delete Claude Code\'s transcripts and history for it from the project\'s page, behind a confirm.'),
  respawn: BG,
  rm: BG,
  'setup-token': skip('Long-lived tokens are for CI; Shellby uses your sign-in.'),
  stop: BG,
  ultrareview: use('cli-commands.js: /ultrareview'),
  update: use('claude/update.js'),
});

/** Every tool a session's init lists. MCP tools (mcp__…) are the user's own. */
const TOOLS = Object.freeze({
  Agent: use('stream.js: helper crabs'),
  AskUserQuestion: use('feed-asks.js: question cards'),
  Bash: use('stream.js'),
  CronCreate: use('stream.js: shown as a step'),
  CronDelete: use('stream.js: shown as a step'),
  CronList: use('stream.js: shown as a step'),
  DesignSync: skip('Claude Design\'s own tool; shown as a step like any other.'),
  Edit: use('stream.js, changes.js'),
  EnterPlanMode: use('stream.js, session.js'),
  EnterWorktree: gap('When Claude moves into a worktree mid-conversation, the tab, its changes and its project should follow it.'),
  ExitPlanMode: use('feed-asks.js: the plan card'),
  ExitWorktree: gap('When Claude moves into a worktree mid-conversation, the tab, its changes and its project should follow it.'),
  Glob: use('stream.js'),
  Grep: use('stream.js'),
  ListAgents: use('stream.js: shown as a step'),
  ListMcpResourcesTool: use('stream.js: shown as a step'),
  Monitor: use('stream.js'),
  NotebookEdit: use('changes.js'),
  PowerShell: use('stream.js'),
  PushNotification: gap('Claude asking to notify you: send it through the crab and your phone connections, not just a step in the feed.'),
  Read: use('stream.js'),
  ReadMcpResourceDirTool: use('stream.js: shown as a step'),
  ReadMcpResourceTool: use('stream.js: shown as a step'),
  RemoteTrigger: use('cloud-routines.js'),
  ReportFindings: gap('Code-review findings: show them as a list of cards (file:line, Fix this) rather than a step.'),
  ScheduleWakeup: use('stream.js: shown as a step'),
  SendMessage: use('session-crew.js'),
  SendUserMessage: BRIEF,
  Skill: use('stream.js'),
  Task: use('stream.js: helper crabs'),
  TaskCreate: use('journal.js: the to-do list'),
  TaskGet: use('stream.js'),
  TaskList: use('stream.js'),
  TaskOutput: use('stream.js'),
  TaskStop: use('stream.js'),
  TaskUpdate: use('journal.js: the to-do list'),
  TodoWrite: use('stream.js: the to-do list'),
  ToolSearch: use('stream.js: shown as a step'),
  WebFetch: use('stream.js'),
  WebSearch: use('stream.js'),
  Workflow: use('workflows/run-queue.js'),
  Write: use('stream.js, changes.js'),
});

// An option line is indented two spaces; its description's later lines, which
// can start with --something too, are indented much further.
const OPTION_LINE = /^ {2}(?:-\w, )?(--[\w-]+)(?:, (--[\w-]+))?/;
const COMMAND_LINE = /^ {2}([a-z][\w-]*)(?:\|([a-z][\w-]*))?(?=\s|$)/;

/**
 * The options and subcommands `claude --help` lists. An option with two long
 * names (--allowedTools, --allowed-tools) counts once, by its first; so does
 * a command with an alias (stop|kill).
 * @returns {{ flags: string[], commands: string[] }}
 */
function parseHelp(text) {
  const flags = new Set();
  const commands = new Set();
  let section = null;
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (/^Options:/.test(line)) { section = 'options'; continue; }
    if (/^Commands:/.test(line)) { section = 'commands'; continue; }
    if (section === 'options') {
      const m = OPTION_LINE.exec(line);
      if (m) flags.add(m[1]);
    } else if (section === 'commands') {
      const m = COMMAND_LINE.exec(line);
      if (m && m[1] !== 'help') commands.add(m[1]);
    }
  }
  return { flags: [...flags].sort(), commands: [...commands].sort() };
}

const builtinTools = tools => (Array.isArray(tools) ? tools : []).filter(t => typeof t === 'string' && !t.startsWith('mcp__'));

/**
 * What the CLI offers that the lists here don't account for, what they list
 * that it no longer has, and the known gaps.
 * help: `claude --help` text. tools: an init's tool list, or null when no turn ran.
 * @returns {{ unaccounted: { flags: string[], commands: string[], tools: string[] },
 *   gone: { flags: string[], commands: string[], tools: string[] },
 *   gaps: { kind: string, name: string, what: string }[] }}
 */
function coverageOf({ help, tools = null }) {
  const live = parseHelp(help);
  const liveTools = tools ? builtinTools(tools) : null;
  const missingFrom = (names, list) => names.filter(n => !Object.hasOwn(list, n));
  const notIn = (list, names) => (names ? Object.keys(list).filter(n => !names.includes(n)).sort() : []);
  const gaps = [];
  const seenGap = new Set();
  for (const [kind, list, names] of [['flag', FLAGS, live.flags], ['command', COMMANDS, live.commands], ['tool', TOOLS, liveTools]]) {
    for (const [name, e] of Object.entries(list)) {
      if (e.status !== 'gap' || (names && !names.includes(name)) || seenGap.has(e.what)) continue;
      seenGap.add(e.what);
      gaps.push({ kind, name, what: e.what });
    }
  }
  return {
    unaccounted: { flags: missingFrom(live.flags, FLAGS), commands: missingFrom(live.commands, COMMANDS), tools: liveTools ? missingFrom(liveTools, TOOLS) : [] },
    // Tools come and go with settings and sign-in, so only flags and commands
    // the CLI has dropped are reported gone.
    gone: { flags: notIn(FLAGS, live.flags), commands: notIn(COMMANDS, live.commands), tools: [] },
    gaps,
  };
}

const anyIn = o => Object.values(o).some(a => a.length);

/** The coverage as Markdown, for the nightly `cli-new` issue and the run summary. */
function coverageSummary(cov, version) {
  const out = [`**Claude Code ${version || '(version unknown)'}**: what it offers that Shellby hasn't decided about.`, ''];
  const list = (title, o, fmt) => {
    if (!anyIn(o)) return;
    out.push(title, '');
    for (const [k, names] of Object.entries(o)) for (const n of names) out.push(fmt(k, n));
    out.push('');
  };
  list('### New, not yet in src/main/cli-coverage.js', cov.unaccounted, (k, n) => `- [ ] ${k.replace(/s$/, '')} \`${n}\``);
  list('### Gone from Claude Code (remove from src/main/cli-coverage.js)', cov.gone, (k, n) => `- ${k.replace(/s$/, '')} \`${n}\``);
  if (cov.gaps.length) {
    out.push('### Known gaps', '');
    for (const g of cov.gaps) out.push(`- [ ] ${g.kind} \`${g.name}\`: ${g.what}`);
    out.push('');
  }
  if (!anyIn(cov.unaccounted) && !anyIn(cov.gone) && !cov.gaps.length) out.push('Nothing: every flag, command and tool is accounted for.');
  return out.join('\n').trim();
}

/** Is there anything to put in an issue? */
const needsAttention = cov => anyIn(cov.unaccounted) || anyIn(cov.gone) || cov.gaps.length > 0;

module.exports = { FLAGS, COMMANDS, TOOLS, parseHelp, coverageOf, coverageSummary, needsAttention };
