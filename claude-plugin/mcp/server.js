#!/usr/bin/env node
// Shellby as an MCP server: this is what lets Claude drive the crab on purpose,
// rather than Shellby guessing from hook events. A skill can have him hold up a
// sign at the end of a long run, put on a party hat when a release ships, or
// ask how hot the machine is before kicking off a build.
//
// It speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and forwards each
// call to the Shellby app on this PC over 127.0.0.1. Deliberately self-contained
// -- node builtins only -- because it ships inside the plugin and runs from
// wherever Claude Code unpacked it, with no access to the app's own modules.
//
// It can make the crab react and it can read his status. It cannot start Claude
// Code tasks: anything on this PC can reach this server, and spending someone's
// Claude subscription is not a thing a local port should be able to do. It can
// propose a routine or a workflow, but the app only saves one after the user
// says yes in a window this server has no way to click. And it can start a
// workflow only if the user gave that workflow the "Claude Code" trigger.
//
// It can read the user's Projects page (projects, next_up, server_log), so a
// Claude in a terminal can ask what's next on the repo it's in. The only thing
// it can change there is the project's to-do list (add_task, finish_task): a
// list of notes the user sees on the project's page, nothing that runs. Those
// five send the token Shellby keeps in the user's own profile folder (other
// accounts on this PC can reach the port, but can't read that file).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.SHELLBY_PORT) || 47913;
const TIMEOUT_MS = 2500;
// add_routine and add_workflow wait while the user reads the confirm window.
const ASK_TIMEOUT_MS = 5 * 60 * 1000;
// run_workflow answers once the run has started, which can take a moment.
const RUN_TIMEOUT_MS = 15 * 1000;
const NAME = 'shellby';
const VERSION = '1.0.0';
// Newest first. The client's version is echoed back when we know it, which is
// what the spec asks for; otherwise it gets our newest.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const MAX_TEXT = 120;   // a speech bubble, not a paragraph
const MOODS = ['happy', 'worried', 'thinking', 'proud', 'sleepy'];
const MAX_ROUTINE_PROMPT = 1000;
const ROUTINE_MODES = ['ask', 'smart', 'acceptEdits', 'plan'];
const MAX_WORKFLOW_NAME = 60;
const MAX_WORKFLOW_INPUTS = 10;
const MAX_INPUT_VALUE = 2000;
const MAX_WORKFLOW_BYTES = 64 * 1024;
const INPUT_KEY = '^[a-z][a-z0-9_]{0,31}$';
const MAX_PROJECT = 200;
const MAX_TODO = 200;
const MAX_TODO_NUMBER = 999;
const LOG_LINES = { min: 10, max: 200, default: 50 };
const SCRIPT = '^[A-Za-z0-9:._-]{1,100}$';
const TODO_ID = '^t-[a-z0-9]{8}$';
// journal too: its notes say what was asked, which files and commits, and it takes pins.
const PROJECT_TOOLS = ['projects', 'next_up', 'server_log', 'add_task', 'finish_task', 'journal'];
const PIN_KINDS = ['decision', 'next', 'blocker', 'note'];
const MAX_PIN = 300;
const MAX_FOLDER = 1024;
// The folder Claude Code started this server in: the project being worked on.
const HERE = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// The same, read at each call, for the project tools ("this repo").
const projectDir = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();

const PROJECT_ARG = {
  type: 'string', maxLength: MAX_PROJECT,
  description: 'Which project: its name, "owner/name", or a folder in it. Leave out for the one Claude Code is working in.',
};

// The tests check this passes the app's own validator.
const WORKFLOW_EXAMPLE = {
  name: 'Morning PR digest',
  when: [{ type: 'schedule', schedule: { type: 'daily', time: '08:30' } }, { type: 'claude' }],
  inputs: [{ name: 'repo', default: 'me/app' }],
  steps: [
    {
      id: 'look', type: 'claude', mode: 'plan',
      prompt: 'Which open PRs in {{ inputs.repo }} need my review?',
      output: { count: { type: 'number', description: 'how many' }, summary: { type: 'string', description: 'one line per PR' } },
    },
    { type: 'tell', if: 'look.count > 0', to: 'notification', title: 'PRs to review', text: '{{ look.summary }}' },
  ],
};

// The workflow format, for add_workflow. Long on purpose: Claude has to write a
// correct workflow from this alone. Kept in step with docs/plans/workflows.md.
const WORKFLOW_FORMAT = [
  'A Shellby workflow: triggers start a list of steps, and steps pass data to each other.',
  '',
  'Top level: { name (1-60 chars, required), description?, enabled? (default true), cwd? (absolute folder the steps work in), concurrency?: "skip"|"queue" (a trigger while a run is going), inputs?: [{ name, label?, default?, required? }] (at most 10), when?: [trigger] (at most 8; every workflow can also be run by hand), steps: [step] (1-60 in all, nested at most 4 deep) }.',
  'Input names, step ids, output field names and set value names: lowercase letters, digits and _, starting with a letter, at most 32.',
  '',
  'Triggers, { type, ... } -> what trigger.* holds:',
  '- schedule { schedule: { type: "daily", time: "HH:MM" } | { type: "weekly", time, days: [0-6, 0 = Sunday] } | { type: "interval", everyHours: 1-168 } | { type: "minutes", every: 5-1440 } } -> at',
  '- ci { on: failed|fixed|passed|merged|review|any, repo?: "owner/name" } -> event, repo, number, title, url, branch, failing[]',
  '- issue { on: assigned|labelled|any, repo?: "owner/name" } (a GitHub issue assigned to them, or labelled shellby) -> event, reasons[], repo, number, title, body, labels[], author, url',
  '- shipped { kind: push|deploy|release|merge|any, project? } -> kind, project, version',
  '- task { outcome: ok|error|any } (a Shellby task finished) -> title, outcome, folder, error',
  '- health {} (something overheats or fills up) -> title, body',
  '- folder { path (absolute), pattern?: "*.pdf", events: added|changed|any } -> folder, files[]',
  '- workflow { name (another workflow), status: ok|error|any } -> name, status, runId, vars',
  '- startup {}',
  '- webhook {} (Shellby generates the token)',
  '- claude {} (lets Claude Code start it with run_workflow) -> the inputs passed',
  '',
  'Steps: { type, id?, label?, if?: condition (false -> skipped), retry?: { times: 0-5, delaySec: 1-3600 }, timeoutMin?: 1-720, continueOnError?: true, ... } -> what <id>.* holds:',
  '- claude { prompt (up to 8000), mode: ask|smart|acceptEdits|plan (default smart; never autonomous), model?, cwd?, fresh?: true (new conversation; otherwise all Claude steps in a run share one), mcp?: [server names] (MCP servers whose tools Claude may use in this step without asking, at most 10), mcpOnly?: true (load only those servers), output?: { field: { type: string|number|boolean|list|object, description } } (at most 20) } -> reply, tabId, and each output field as typed data',
  '- mcp { server (an MCP server the user has), tool (one of its tools), args?: a JSON object as text, values in it like "{{ x }}" (text, quoted) or {{ list }} (as JSON), cwd?, allowFail? } (calls the tool directly, no Claude turn) -> ok, text, json',
  '- run { command (PowerShell, up to 4000), cwd?, allowFail? } -> output, code, ok',
  '- http { method: GET|POST|PUT|PATCH|DELETE|HEAD, url (http/https), headers?: { name: value }, body?, allowFail? } -> status, ok, body, json',
  '- ask { question (up to 300), choices?: 2-4 (default Continue/Stop; Stop ends the run) } -> choice',
  '- tell { to: notification|phone|crab|file, text (up to 1000), title?, path (absolute; file only) } -> sent',
  '- set { values: { name: template } } -> vars.name',
  '- if { test: condition, then: [steps], else: [steps] }',
  '- each { over: "{{ some.list }}", as?: name (default item), max?: 1-100 (default 25), steps: [steps] } -> count',
  '- wait { seconds: 1-604800 }',
  '- file { action: read|write|append, path (absolute), content? } -> text (read) or path',
  '- workflow { name (another workflow), inputs?: { name: template } } -> status, vars',
  '- stop { status: ok|error, message? } ends the run',
  '- worktree { repo: "owner/name" (cloned on this PC), branch?: short name } (a copy on a new branch from the default branch; later Claude steps work in it with cwd: "{{ <id>.path }}") -> path, branch, base, repo',
  '- pr { folder: "{{ <worktree id>.path }}", title, body?, draft?: true (default) } (commits what is left, pushes the branch, opens a pull request) -> url, number, branch, repo, draft',
  '',
  'Templates: {{ path }} or {{ path | filter }} in any text field. Paths: trigger.*, inputs.<name>, vars.<name>, <stepId>.<field> (or steps.<stepId>.<field>), the each item (item.* or its "as" name) and loop.index, run.id, run.started, now, today, and secrets.NAME (only in run commands and http url/headers/body). Filters: json, upper, lower, trim, length, first, last, join ", ", default "x", lines, slice 0 200. Values go in as data: quoted in commands, marked as data in prompts.',
  'Conditions (if, test): == != > >= < <= contains, and, or, not, parentheses, literals "text" 12 true false null; a bare path is tested for truthiness. E.g. check.count > 0 and not (inputs.dry == "yes").',
  '',
  `Example: ${JSON.stringify(WORKFLOW_EXAMPLE)}`,
].join('\n');

// ------------------------------------------------------------------ the tools

const TOOLS = [
  {
    name: 'say',
    title: 'Make Shellby say something',
    description: 'Put a short line in Shellby\'s speech bubble on the desktop. Use it to tell the user what you are doing, or to react to something you found. Keep it under 120 characters; he is a small crab with a small bubble.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: MAX_TEXT, description: 'What he says. One short line.' },
        mood: { type: 'string', enum: MOODS, description: 'How he looks while saying it. Defaults to happy.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'celebrate',
    title: 'Make Shellby celebrate',
    description: 'Confetti and a little dance on the desktop. For a release going out, a red build going green, or a long job finally finishing. Do not use it for every passing test.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', maxLength: MAX_TEXT, description: 'What is being celebrated, shown in his bubble.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wear',
    title: 'Dress Shellby up',
    description: 'Put an accessory on Shellby by name ("party hat", "hard hat", "wizard hat", "sunglasses", "scarf"). Only items the user has unlocked can be worn; the result says what he actually put on, or lists near matches if the name did not match anything.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', maxLength: 60, description: 'The accessory name.' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    title: 'Read Shellby\'s status',
    description: 'How the crab and the PC are doing: his level and XP, what he is up to, how many tasks are running, and the current CPU/GPU temperature, memory and disk pressure if the user has Health switched on. Useful before starting something heavy.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'journal',
    title: 'Read or add to this project\'s handoff notes',
    // Kept short: every session pays for a tool's description.
    description: 'Shellby\'s handoff notes from earlier sessions in this project: what was asked, what is half-done, what was decided, what is next. Read them first when asked where we left off, instead of re-exploring. Pass `pin` to leave a decision, next step or blocker for the next session.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', maxLength: MAX_FOLDER, description: 'Absolute path of the project. Defaults to the folder Claude Code started in.' },
        pin: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: PIN_KINDS },
            text: { type: 'string', minLength: 1, maxLength: MAX_PIN },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_routine',
    title: 'Set up a Shellby routine',
    description: 'Set up a routine: a Claude Code task Shellby runs for the user on a schedule ("every Friday at 5pm, tidy my Downloads"). Shellby shows the user the full routine and only saves it if they say yes; the result says which. A routine with the same name as an existing one replaces it (call list_routines first to check). Write the prompt as a complete, self-contained instruction, since each run starts a fresh session with no memory of this conversation. Prefer non-destructive prompts ("suggest", "move", not "delete").',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 60, description: 'Short name the user will recognise, e.g. "Friday Downloads tidy".' },
        prompt: { type: 'string', minLength: 1, maxLength: MAX_ROUTINE_PROMPT, description: 'What Claude should do on each run.' },
        schedule: {
          type: 'object',
          description: 'When it runs, in the user\'s local time. daily: { type, time }. weekly: { type, time, days }. interval: { type, everyHours }.',
          properties: {
            type: { type: 'string', enum: ['daily', 'weekly', 'interval'] },
            time: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$', description: '24-hour HH:MM, for daily and weekly.' },
            days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, minItems: 1, maxItems: 7, uniqueItems: true, description: 'For weekly: 0 = Sunday ... 6 = Saturday.' },
            everyHours: { type: 'integer', minimum: 1, maximum: 168, description: 'For interval.' },
          },
          required: ['type'],
          additionalProperties: false,
        },
        folder: { type: 'string', maxLength: 1024, description: 'Absolute path of the folder it works in. Leave out to use Shellby\'s default folder.' },
        mode: { type: 'string', enum: ROUTINE_MODES, description: 'Permission mode for each run. Defaults to smart. acceptEdits lets it change files without asking; plan only plans.' },
        catchUp: { type: 'boolean', description: 'Run once at startup if a slot was missed while the PC was off. Defaults to true.' },
        model: { type: 'string', maxLength: 40, description: 'Claude model for each run, e.g. "sonnet" or "haiku" (a lighter model is plenty for tidy-ups and summaries). Leave out to use the user\'s default.' },
      },
      required: ['name', 'prompt', 'schedule'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_routines',
    title: 'List Shellby routines',
    description: 'The routines the user has set up in Shellby: name, schedule, mode, folder, whether it is paused, and how the last run went. Check this before add_routine to avoid a duplicate, or to change an existing one by reusing its name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_workflows',
    title: 'List Shellby workflows',
    description: 'The workflows the user has in Shellby: name, description, triggers, whether it is paused and how the last run went. Says which ones you may start with run_workflow (those with the "Claude Code" trigger) and what inputs they take. Check this before add_workflow to avoid a duplicate, or to replace one by reusing its name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_workflow',
    title: 'Run a Shellby workflow',
    description: 'Run one of the user\'s Shellby workflows that allows being started by Claude Code (it has the "Claude Code" trigger; list_workflows says which and what inputs they take). Returns once the run has started, not when it finishes; the user follows it in Shellby.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: MAX_WORKFLOW_NAME, description: 'The workflow\'s name, as list_workflows gives it.' },
        inputs: {
          type: 'object',
          description: 'Values for the workflow\'s inputs, by input name. All values are text.',
          propertyNames: { pattern: INPUT_KEY },
          additionalProperties: { type: 'string', maxLength: MAX_INPUT_VALUE },
          maxProperties: MAX_WORKFLOW_INPUTS,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_workflow',
    title: 'Propose a Shellby workflow',
    description: 'Propose a workflow for Shellby: triggers (a schedule, a failing build, a file landing in a folder, ...) that start a list of steps (Claude, PowerShell commands, web requests, questions, notifications, loops, ...). Shellby shows the user everything it would do in a confirmation window and saves it only if they approve; the result says which, or lists what to fix. A workflow with the same name as an existing one replaces it (call list_workflows first). Autonomous mode is never allowed from here. Write Claude step prompts as complete instructions, and prefer non-destructive steps. The workflow argument describes the format.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'object', description: WORKFLOW_FORMAT },
      },
      required: ['workflow'],
      additionalProperties: false,
    },
  },
  {
    name: 'projects',
    title: 'List the user\'s projects',
    description: 'The projects on Shellby\'s Projects page (the user\'s git repositories on this PC and on GitHub), most recently worked on first: where each is, its branch, dev servers running, and what needs attention (a crashed server, failing CI, vulnerabilities, unpushed commits, flaky tests, to-dos).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'next_up',
    title: 'What to do next in a project',
    description: 'Shellby\'s answer to "what\'s next on this repo?": what is broken (crashed dev server, failing CI, serious vulnerabilities), then the user\'s to-do list for the project, then housekeeping (review comments, unpushed or uncommitted work, flaky tests, outdated packages), plus where they left off. Defaults to the project Claude Code is working in. Use it when the user asks what to work on.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        everywhere: { type: 'boolean', description: 'The first few things in every project that has any, instead of one project.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'server_log',
    title: 'Read a dev server\'s log',
    description: 'The last lines printed by a dev server Shellby runs for the project, with secrets redacted: the one that crashed most recently, else the one running. Use it to find out why a dev server fell over. Do not start or restart the server yourself; the user does that from Shellby.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        script: { type: 'string', pattern: SCRIPT, description: 'The package.json script of the server, like "dev", when the project has several.' },
        lines: { type: 'integer', minimum: LOG_LINES.min, maximum: LOG_LINES.max, description: `How many lines. Defaults to ${LOG_LINES.default}.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_task',
    title: 'Add to a project\'s to-do list',
    description: 'Put a short note on the project\'s to-do list in Shellby, where the user sees it on the project\'s page and next_up lists it. For follow-ups worth remembering past this conversation ("add tests for the CSV import"). One line, under 200 characters. Adding the same text twice keeps one.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_TODO, description: 'The to-do, as one short line.' },
        project: PROJECT_ARG,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish_task',
    title: 'Tick off a to-do',
    description: 'Remove a to-do from the project\'s list once it is done, by the id next_up gives it ("t-…"), or its number. The id still means the same to-do if the list changed since. Only for to-dos you actually finished, or that the user asked to drop.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: ['string', 'integer'], pattern: TODO_ID, minimum: 1, maximum: MAX_TODO_NUMBER,
          description: 'The to-do\'s id from next_up, like "t-k3j9x0ab" (best), or its number on the list.',
        },
        project: PROJECT_ARG,
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
];

// Shellby's own conversations get the crab's tools from the app itself
// (src/main/crabmcp.js) and say so with SHELLBY_CRAB_TOOLS, so these copies
// would only add their schemas to every request there.
const CRAB_TOOLS = ['say', 'celebrate', 'wear', 'status'];
const listedTools = (env = process.env) => (env.SHELLBY_CRAB_TOOLS === '1' ? TOOLS.filter(t => !CRAB_TOOLS.includes(t.name)) : TOOLS);

// ------------------------------------------------------------------ transport

const markerPath = () => path.join(os.tmpdir(), `shellby-hooks-${PORT}`);

// How long each action may take, and what a timeout means for it.
// The project tools read git in each clone, which can take a few seconds on a long list.
const PROJECTS_TIMEOUT_MS = 15 * 1000;
const TIMEOUTS = {
  add_routine: ASK_TIMEOUT_MS, add_workflow: ASK_TIMEOUT_MS, run_workflow: RUN_TIMEOUT_MS,
  projects: PROJECTS_TIMEOUT_MS, next_up: PROJECTS_TIMEOUT_MS, server_log: PROJECTS_TIMEOUT_MS,
  add_task: PROJECTS_TIMEOUT_MS, finish_task: PROJECTS_TIMEOUT_MS,
};
const TIMEOUT_TEXT = {
  add_routine: 'The user has not answered Shellby\'s question about the routine yet. If they say yes later it is still saved; check with list_routines.',
  add_workflow: 'The user has not answered Shellby\'s question about the workflow yet. If they say yes later it is still saved; check with list_workflows.',
  run_workflow: 'Shellby did not confirm the run in time. It may still have started; list_workflows shows the last run.',
};

/**
 * The token for the project tools, from Shellby's settings folder. A dev run
 * with its own profile (SHELLBY_USER_DATA) keeps it there instead.
 */
function readCrabToken() {
  const dirs = [
    process.env.SHELLBY_USER_DATA,
    process.env.APPDATA && path.join(process.env.APPDATA, 'Shellby'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Shellby'),
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'Shellby'),
    path.join(os.homedir(), '.config', 'Shellby'),
  ].filter(Boolean);
  for (const d of dirs) {
    try {
      const t = fs.readFileSync(path.join(d, 'crab-token'), 'utf8').trim();
      if (t) return t;
    } catch { /* try the next one */ }
  }
  return null;
}

/** Is the app listening? The marker file means a quick no instead of a slow one. */
function appIsRunning() {
  try { return fs.existsSync(markerPath()); } catch { return false; }
}

/**
 * POST one action to the running Shellby.
 *   resolves { ok: true, text } | { ok: false, error }
 * Never rejects: a tool call that cannot reach the crab is a tool result that
 * says so, not a crash that takes the MCP server down with it.
 */
function callApp(action, args, timeoutMs = TIMEOUT_MS) {
  return new Promise(resolve => {
    if (!appIsRunning()) {
      resolve({ ok: false, error: 'Shellby is not running on this PC, so there is no crab to tell. Start Shellby and try again.' });
      return;
    }
    const body = Buffer.from(JSON.stringify({ action, args }), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'X-Shellby': '1',
    };
    // Shellby asks for the token for projects, the journal, routines and
    // workflows. Sending it every time costs nothing.
    const token = readCrabToken();
    if (token) headers['X-Shellby-Token'] = token;
    if (PROJECT_TOOLS.includes(action)) {
      if (!token) {
        resolve({ ok: false, error: 'This Shellby is too old to answer about projects, or has not finished starting. Update it, start it, and try again.' });
        return;
      }
    }
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/v1/crab',
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size < 64 * 1024) chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolve({ ok: false, error: 'This Shellby is too old to be driven from Claude Code. Update it and try again.' });
          return;
        }
        let payload = null;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* no body */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, text: payload?.text || 'Done.' });
        else resolve({ ok: false, error: payload?.error || `Shellby answered ${res.statusCode}.` });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: TIMEOUT_TEXT[action] || 'Shellby did not answer in time.' });
    });
    req.on('error', () => resolve({ ok: false, error: 'Could not reach Shellby on this PC.' }));
    req.end(body);
  });
}

// ------------------------------------------------------------------ validation

const clip = (s, n) => String(s ?? '').replace(/[ -]+/g, ' ').trim().slice(0, n);

/**
 * Check one tool call and turn it into the action the app receives.
 * Returns { action, args } or { error }. The app validates again on its side:
 * this server is not the only thing that can reach that port.
 */
function toAction(name, raw) {
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  switch (name) {
    case 'say': {
      const text = clip(args.text, MAX_TEXT);
      if (!text) return { error: 'say needs some text.' };
      const mood = MOODS.includes(args.mood) ? args.mood : 'happy';
      return { action: 'say', args: { text, mood } };
    }
    case 'celebrate':
      return { action: 'celebrate', args: { reason: clip(args.reason, MAX_TEXT) } };
    case 'wear': {
      const item = clip(args.item, 60);
      if (!item) return { error: 'wear needs the name of an accessory.' };
      return { action: 'wear', args: { item } };
    }
    case 'status':
      return { action: 'status', args: {} };
    case 'add_routine': {
      const name = clip(args.name, 60);
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!name) return { error: 'add_routine needs a name.' };
      if (!prompt) return { error: 'add_routine needs a prompt.' };
      if (prompt.length > MAX_ROUTINE_PROMPT) return { error: `Keep the routine's prompt under ${MAX_ROUTINE_PROMPT} characters.` };
      const s = args.schedule && typeof args.schedule === 'object' && !Array.isArray(args.schedule) ? args.schedule : null;
      if (!s) return { error: 'add_routine needs a schedule.' };
      if (args.mode !== undefined && !ROUTINE_MODES.includes(args.mode)) return { error: `mode must be one of: ${ROUTINE_MODES.join(', ')}.` };
      const out = { name, prompt, schedule: { type: s.type, time: s.time, days: s.days, everyHours: s.everyHours } };
      if (typeof args.folder === 'string' && args.folder.trim()) out.folder = args.folder.trim();
      if (args.mode !== undefined) out.mode = args.mode;
      if (typeof args.catchUp === 'boolean') out.catchUp = args.catchUp;
      if (typeof args.model === 'string' && args.model.trim()) out.model = args.model.trim().slice(0, 40);
      return { action: 'add_routine', args: out };
    }
    case 'journal': {
      const folder = typeof args.folder === 'string' && args.folder.trim() ? args.folder.trim() : HERE;
      if (folder.length > MAX_FOLDER || !path.isAbsolute(folder)) return { error: 'folder must be an absolute path.' };
      if (args.pin === undefined || args.pin === null) return { action: 'journal', args: { folder } };
      const p = args.pin && typeof args.pin === 'object' && !Array.isArray(args.pin) ? args.pin : null;
      const text = clip(p?.text, MAX_PIN);
      if (!text) return { error: 'pin needs some text.' };
      if (p.kind !== undefined && !PIN_KINDS.includes(p.kind)) return { error: `pin.kind must be one of: ${PIN_KINDS.join(', ')}.` };
      return { action: 'journal', args: { folder, pin: { kind: p.kind || 'note', text } } };
    }
    case 'list_routines':
      return { action: 'list_routines', args: {} };
    case 'list_workflows':
      return { action: 'list_workflows', args: {} };
    case 'run_workflow': {
      const name = clip(args.name, MAX_WORKFLOW_NAME);
      if (!name) return { error: 'run_workflow needs the name of a workflow.' };
      if (args.inputs === undefined || args.inputs === null) return { action: 'run_workflow', args: { name } };
      if (typeof args.inputs !== 'object' || Array.isArray(args.inputs)) return { error: 'inputs must be an object of input names and text values.' };
      const keys = Object.keys(args.inputs);
      if (keys.length > MAX_WORKFLOW_INPUTS) return { error: `At most ${MAX_WORKFLOW_INPUTS} inputs.` };
      const inputs = {};
      for (const k of keys) {
        if (!new RegExp(INPUT_KEY).test(k)) return { error: `"${clip(k, 32)}" can't be an input name: use lowercase letters, digits and _.` };
        const v = args.inputs[k];
        if (!['string', 'number', 'boolean'].includes(typeof v)) return { error: `Input "${k}" must be text.` };
        if (String(v).length > MAX_INPUT_VALUE) return { error: `Input "${k}" is longer than ${MAX_INPUT_VALUE} characters.` };
        inputs[k] = String(v);
      }
      return { action: 'run_workflow', args: { name, inputs } };
    }
    case 'add_workflow': {
      const wf = args.workflow;
      if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return { error: 'add_workflow needs a workflow object.' };
      if (Buffer.byteLength(JSON.stringify(wf), 'utf8') > MAX_WORKFLOW_BYTES) return { error: `Keep the workflow under ${MAX_WORKFLOW_BYTES / 1024} KB.` };
      return { action: 'add_workflow', args: { workflow: wf } };
    }
    case 'projects':
      return { action: 'projects', args: {} };
    case 'next_up':
    case 'server_log':
    case 'add_task':
    case 'finish_task':
      return projectAction(name, args);
    default:
      return { error: `Unknown tool: ${clip(name, 40)}` };
  }
}

/** The project tools: what was asked, plus the folder Claude Code is in, for "this repo". */
function projectAction(name, args) {
  const out = { cwd: projectDir() };
  if (args.project !== undefined) {
    if (typeof args.project !== 'string') return { error: 'project must be a name, owner/name or folder.' };
    if (args.project.length > MAX_PROJECT) return { error: `A project name is at most ${MAX_PROJECT} characters.` };
    const project = clip(args.project, MAX_PROJECT);
    if (project) out.project = project;
  }
  if (name === 'next_up') {
    if (args.everywhere === true) out.everywhere = true;
  } else if (name === 'server_log') {
    if (args.script !== undefined && args.script !== '' && !(typeof args.script === 'string' && new RegExp(SCRIPT).test(args.script))) {
      return { error: 'script must be the name of a package.json script, like dev.' };
    }
    if (args.script) out.script = args.script;
    if (args.lines !== undefined) {
      if (!Number.isInteger(args.lines) || args.lines < LOG_LINES.min || args.lines > LOG_LINES.max) {
        return { error: `lines must be a whole number from ${LOG_LINES.min} to ${LOG_LINES.max}.` };
      }
      out.lines = args.lines;
    }
  } else if (name === 'add_task') {
    if (typeof args.text !== 'string') return { error: 'add_task needs the text of the to-do.' };
    const text = clip(args.text, MAX_TODO + 1);
    if (!text) return { error: 'add_task needs the text of the to-do.' };
    if (text.length > MAX_TODO) return { error: `Keep a to-do under ${MAX_TODO} characters.` };
    out.text = text;
  } else {
    const isNumber = Number.isInteger(args.task) && args.task >= 1 && args.task <= MAX_TODO_NUMBER;
    const isId = typeof args.task === 'string' && new RegExp(TODO_ID).test(args.task);
    if (!isNumber && !isId) return { error: "finish_task needs the to-do's id or number, as next_up lists it." };
    out.task = args.task;
  }
  return { action: name, args: out };
}

// ------------------------------------------------------------------ JSON-RPC

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (id, text, isError) => result(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      result(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
        instructions: 'Shellby is the pixel hermit crab on this user\'s desktop. Use `say` to keep them posted while you work, `celebrate` when something real lands, and `status` to check the machine before heavy jobs. When the user wants something done on a schedule, `add_routine` sets it up in Shellby (they confirm it there). For anything with several steps or other triggers (a failing build, a file arriving), `add_workflow` proposes a workflow; `list_workflows` and `run_workflow` start the ones the user lets Claude Code run. Asked where we left off, read `journal` before exploring the project. When the user asks what to work on, `next_up` gives Shellby\'s answer for this repo (crashed servers, failing CI, their to-dos, unpushed work); `server_log` shows why a dev server fell over; `add_task` and `finish_task` keep the project\'s to-do list.',
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;                       // notifications: nothing to answer
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: listedTools() });
      return;
    case 'tools/call': {
      const { action, args, error } = toAction(params?.name, params?.arguments);
      if (error) { textResult(id, error, true); return; }
      const answer = await callApp(action, args, TIMEOUTS[action] || TIMEOUT_MS);
      textResult(id, answer.ok ? answer.text : answer.error, !answer.ok);
      return;
    }
    default:
      if (isRequest) failure(id, -32601, `Method not found: ${String(method).slice(0, 60)}`);
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    // Newline-delimited JSON. A chunk can hold several messages, or half of one.
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { failure(null, -32700, 'Parse error'); continue; }
      // A batch arrives as an array; the spec allows it.
      for (const one of Array.isArray(msg) ? msg : [msg]) {
        Promise.resolve(handle(one)).catch(e => {
          if (one?.id != null) failure(one.id, -32603, `Internal error: ${String(e?.message || e).slice(0, 120)}`);
        });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  // Claude Code closes stdin to stop us; nothing else should take the server down.
  process.on('uncaughtException', e => process.stderr.write(`[shellby-mcp] ${e?.message || e}\n`));
}

if (require.main === module) main();

module.exports = {
  TOOLS, toAction, PROTOCOL_VERSIONS, MOODS, MAX_TEXT, MAX_ROUTINE_PROMPT, ROUTINE_MODES,
  MAX_WORKFLOW_NAME, MAX_WORKFLOW_INPUTS, MAX_INPUT_VALUE, MAX_WORKFLOW_BYTES, INPUT_KEY, WORKFLOW_EXAMPLE,
  MAX_PROJECT, MAX_TODO, LOG_LINES, SCRIPT, TODO_ID, PROJECT_TOOLS, readCrabToken,
  PIN_KINDS, MAX_PIN, CRAB_TOOLS, listedTools,
};
