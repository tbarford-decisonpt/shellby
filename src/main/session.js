// One conversation = one long-lived `claude -p` process speaking stream-json on
// stdin/stdout. Permission prompts, interrupts and mode switches go over the same
// control protocol the Claude Agent SDK uses, so no API key is ever involved.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TASKKILL } = require('./system32'); // by full path: Claude runs in project folders
const readline = require('readline');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { parseLine, spendFrom } = require('./stream');
const { troubleOf, remoteTroubleOf } = require('./trouble');
const remoteSsh = require('./remote/ssh');
const ctx = require('./context');
const planPace = require('./plan-pace');
const eff = require('./efficiency');
const { claudeEnv } = require('./claude/cli');
const { CLI_MODE } = require('./config');
const { annotatePermission } = require('./safety');
const { plainPermission } = require('./plain-words');
const { lineOf, MAX_TEXT } = require('../renderer/shared/diff');
const crabmcp = require('./crabmcp');
const processJob = require('./process-job');
const todos = require('../renderer/shared/todos');
const jobs = require('./jobs');
const { memoryOf } = require('./automemory');
const { accounting } = require('./session-accounting');
const { crew, TALK_MS } = require('./session-crew');

// The tools that can change files, for the beforeWork hook.
const WORK_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';
const WORK_HOOK = 'shellby-before-work';
// Every finished tool call on the main thread, so what you typed while Claude
// works can go in before its next step (steer()).
const STEER_HOOK = 'shellby-steer';

const DENY_MESSAGE = 'The user declined this action in Shellby. Ask them how they would like to proceed.';

const PLACE_MAX_BYTES = 2 * 1024 * 1024;

// Where an Edit lands in its file, so its diff can show real line numbers and
// a link can open the file at that line; and for a Write over a file that's
// already there, what it's replacing, so that's a diff too rather than a wall
// of green. Read before the edit runs: the CLI reports a tool call before it
// executes it. Off the main thread, which a 2 MB file would hold up: the
// session keeps the items after it waiting meanwhile (inOrder()).
async function placeEdit(item) {
  const first = item.edits?.[0];
  if (!item.filePath || !first) return;
  let text;
  try {
    if ((await fs.promises.stat(item.filePath)).size > PLACE_MAX_BYTES) return;
    text = (await fs.promises.readFile(item.filePath, 'utf8')).replace(/\r\n/g, '\n');
  } catch { return; } // a new file: nothing to compare with
  if (item.name === 'Write' || item.toolName === 'Write') {
    item.edits = [{ old: text.slice(0, MAX_TEXT), new: first.new }];
    item.line = 1;
  } else if (first.old) {
    item.line = lineOf(text, first.old.replace(/\r\n/g, '\n'));
  }
}

// Effort levels Claude Code takes (--effort). '' leaves it to Claude Code.
const { EFFORTS, unknownType } = require('./cli-contract');
// Flags newer than the rest, passed only when this Claude Code lists them in
// its --help (claude/cli.js helpFlags): an older one stops at a flag it doesn't
// know, and every turn would fail. On another computer its version isn't known,
// so they're left out there.
const OPTIONAL_FLAGS = Object.freeze(['--include-partial-messages', '--forward-subagent-text', '--fallback-model', '--name', '--agent', '--safe-mode', '--chrome']);
// A conversation's name as Claude Code shows it (--name): one line, not too long.
const NAME_MAX = 100;
const cleanName = v => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');
// How often the reply's words as they're written reach the panel, at most.
const PARTIAL_MS = 50;
// How long Shellby waits for the CLI to answer one of its own control requests.
const REQUEST_TIMEOUT_MS = 15000;

// A conversation's --mcp-config, in the temp folder (yours alone). null if it
// can't be written: the definitions then go on the command line as before.
function writeConfig(config) {
  const file = path.join(os.tmpdir(), `shellby-mcp-${randomUUID()}.json`);
  try { fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' }); return file; } catch { return null; }
}
const removeFile = file => { if (file) fs.rm(file, { force: true }, () => {}); };

// The hooks Shellby registers with initialize: steering always, the work hook
// when something watches work (beforeWork). scripts/cli-compat.js sends the same.
function initHooks(watchWork) {
  const steerAt = [{ matcher: '.*', hookCallbackIds: [STEER_HOOK] }];
  const hooks = { PostToolUse: steerAt, PostToolUseFailure: steerAt };
  if (watchWork) hooks.PreToolUse = [{ matcher: WORK_TOOLS, hookCallbackIds: [WORK_HOOK] }];
  return hooks;
}

// Where an event type Shellby has never seen gets noted (main.js passes its
// log, which scrubs it). Once per type per run: a chatty new event mustn't fill
// the log, and the type name alone says what a Claude Code update added.
let logger = null;
const loggedTypes = new Set();
function setLogger(log) { logger = log || null; }
function noteUnknown(event) {
  const type = unknownType(event);
  if (!type || loggedTypes.has(type)) return;
  loggedTypes.add(type);
  try { logger?.warn('Claude Code sent an event Shellby does not know yet', type); } catch { /* the log never matters more than the turn */ }
}

class ClaudeSession extends EventEmitter {
  // argsPrefix lets tests run a fake CLI script: exe=node, argsPrefix=[script].
  // extraEnv: () => {} of variables to add when the process starts (GitHub access).
  // context: the last reading of how full it is ({ tokens, window }), so a
  // resumed conversation shows its meter before it next speaks.
  //
  // effort: one of EFFORTS, or '' for Claude Code's own default. outputStyle: a
  // style name passed as a flag setting, or '' to leave the user's own.
  //
  // allowedTools: permission rules Claude Code applies without asking (a
  // routine's or workflow step's MCP servers). mcpConfig: { mcpServers } to load
  // instead of every configured server, or null for the usual ones.
  //
  // fallbackModel: the model Claude Code switches to when this one is busy
  // (--fallback-model), or ''. chrome: Claude in Chrome on (--chrome). safeMode:
  // without CLAUDE.md, skills, plugins, hooks or MCP servers (--safe-mode), to
  // see whether one of them is the trouble. agent: one of your agents runs the
  // conversation (--agent). name: () => what the conversation is called, read at
  // each start (--name). supports(flag): whether this Claude Code takes one of
  // OPTIONAL_FLAGS.
  //
  // systemNote: appended to Claude Code's system prompt (see selfaware.js).
  // mcp: { tools, call(name, args) } -> the crab's tools, hosted here (see crabmcp.js).
  //
  // remote: () => { exe, host, dir, env, extra?, argsPrefix? } | null, read each time
  // the process starts: a folder on another computer (remote/service.js), whose
  // Claude Code runs there over ssh. exe is ssh, env what it needs to ask for a
  // passphrase in Shellby, extra more of ssh's options; argsPrefix, as above, is for tests.
  //
  // exe: the CLI's path, or a function that gives it, asked each time the
  // process starts. The process is started again after an idle stop, and by
  // then Claude Code may have moved (its installer took the npm copy away and
  // left the native one, say): a path fixed when the tab opened would fail
  // every turn after that until Shellby restarted.
  constructor({ exe, cwd, mode, model, effort = '', outputStyle = '', fallbackModel = '', chrome = false, safeMode = false, agent = '', name = () => '', supports = () => true, resumeId = null, resumeAt = null, argsPrefix = [], extraEnv = () => ({}), context = null, allowedTools = [], mcpConfig = null, systemNote = null, mcp = null, remote = () => null }) {
    super();
    Object.assign(this, { exe, cwd, mode, model, effort, outputStyle, fallbackModel, chrome, safeMode, agent, nameOf: name, supports, resumeId, argsPrefix, extraEnv, allowedTools, mcpConfig, systemNote, mcp, remote });
    // Set by rewindTo(): the next start resumes the conversation only up to this
    // transcript entry, as a fork, so the original is left as it was. Kept in
    // History too (sessions.js), so a restart before the next message honours it.
    this.resumeAt = resumeId ? resumeAt : null;
    this.lastUuid = null;          // the newest main-thread transcript entry this turn
    this.requests = new Map();     // request_id -> { resolve, timer } for Shellby's own control requests
    this.context = ctx.view(context?.tokens, context?.window);
    this.windows = null;           // { model: contextWindow } as Claude Code last reported it
    this.proc = null;
    this.busy = false;
    this.busySince = null;         // when the current turn started, for the panel's running clock
    this.sessionId = resumeId;
    this.pending = new Map(); // requestId -> permission item
    // beforeWork(hookInput) -> hook output: set by main.js while a conversation
    // in a git project has no copy of its own yet. It sees every tool call that
    // could change files before it runs, and can hold it back (worktrees.js).
    this.beforeWork = null;
    // takeSteers() -> [{ content, item }]: set by the manager. What you queued
    // while this turn runs, taken (and so no longer queued) the moment it's
    // handed to Claude. `steered` is what Claude hasn't read yet, oldest first,
    // and `openTools` the main thread's tool calls still running.
    this.takeSteers = null;
    this.steered = [];
    this.openTools = new Set();
    // The main thread's newest tool call while it runs, null between tools, and
    // when that last changed: which way the crab works (work-pose.js).
    this.tool = null;
    this.toolAt = null;
    this.interrupting = false;
    // While an edit's file is being read (placeEdit), what came after it waits
    // here, so items still reach listeners in the order Claude Code sent them.
    this.held = null;
    this.createdFiles = new Set(); // paths Claude wrote/edited this conversation
    this.tasks = new Map();        // subagent task_id -> { status, description, ... }
    // Commands and Monitor watches running in the background (jobs.js): kept
    // apart from the helpers, so a `npm run dev` left running isn't a crab.
    this.jobs = jobs.create();
    this.todos = todos.create();   // Claude's own to-do list (shared/todos.js)
    this.agentNames = new Map();   // Agent tool use id -> the name it was given, for SendMessage
    // Planning: started in plan mode, or Claude switched to it (EnterPlanMode),
    // until a plan is approved or the mode changes.
    this.planning = mode === 'plan';
    this.counted = new Map();      // message id -> weight already reported as 'spend'
    this.calls = new Map();        // message id -> token counts already reported as 'call'
    this.cache = null;             // { at, ttlMs }: when this conversation last touched the prompt cache
    this.setupChars = null;        // a new conversation's first prompt, in characters, until its first call is measured
    // What the running turn has cost so far: { usages: message id -> usage, weight,
    // before: context tokens when it began }. Its result carries it (turncost.js).
    this.turn = null;
    this.growths = [];             // how much the last few turns grew the context, for the crowded nudge
    this.plan = null;              // Claude's own to-do list, statuses only (plan-pace.js); the turn keeps its pace
    this.partial = null;           // { text, timer }: the reply's words written since they last went out
  }

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
  }

  // The MCP servers this process loads beyond the usual ones: a routine's or
  // workflow step's own (strict), with the crab's in-app server alongside.
  fullMcpConfig() {
    if (!this.mcp) return this.mcpConfig;
    return { ...(this.mcpConfig || {}), mcpServers: { ...(this.mcpConfig?.mcpServers || {}), ...crabmcp.servers() } };
  }

  /** The CLI's path as it is now (exe may be a function: see the constructor). */
  exePath() { return typeof this.exe === 'function' ? this.exe() : this.exe; }

  start() {
    if (this.proc) return;
    // The servers' definitions can hold tokens, so they go in a file of the
    // process's own rather than on its command line, and the file goes with it.
    // On another computer the config goes over stdin instead (remote/ssh.js MCP_FILE).
    const remote = this.remote?.() || null;
    this.remoteHost = remote?.host || null; // before buildArgs(): the newer flags stay here
    const configFile = this.mcpConfig && !remote ? writeConfig(this.fullMcpConfig()) : null;
    this.mcpConfigFile = remote && this.mcpConfig ? remoteSsh.MCP_FILE : configFile;
    // SHELLBY_CRAB_TOOLS: the crab's tools are served from here, so the plugin's
    // MCP server leaves its copies of them out of every request.
    const crabEnv = this.mcp ? { SHELLBY_CRAB_TOOLS: '1' } : {};
    const exe = this.exePath();
    const proc = remote
      // Only Shellby's own markers go over: your GitHub token and the rest of
      // this PC's environment stay here.
      ? spawn(remote.exe, [...(remote.argsPrefix || []), ...remoteSsh.sshArgs(remote.host, remoteSsh.sessionScript({ dir: remote.dir, args: this.buildArgs(), env: { SHELLBY_OWNED: '1', ...crabEnv } }), { extra: remote.extra || [] })], {
        cwd: os.homedir(), env: { ...process.env, ...remote.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
      : spawn(exe, [...this.argsPrefix, ...this.buildArgs()], {
        cwd: this.cwd, env: { ...claudeEnv(), ...crabEnv, ...this.extraEnv() }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    this.proc = proc;
    // The remote end reads its MCP config from the first line, before Claude Code starts.
    if (remote && this.mcpConfig) this.proc.stdin.write(JSON.stringify(this.fullMcpConfig()) + '\n');
    // Everything Claude starts joins this job, so ending the conversation can
    // end it too: MCP servers, shells, app copies it ran (process-job.js).
    const job = processJob.adopt(proc.pid);
    this.job = job;
    let stderr = '';
    // Also names the servers hosted here: Claude Code then connects to them
    // with mcp_message requests before the first turn.
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize', hooks: initHooks(!!this.beforeWork), promptSuggestions: true, ...(this.mcp ? { sdkMcpServers: [crabmcp.SERVER] } : {}) } });

    readline.createInterface({ input: proc.stdout }).on('line', line => {
      if (this.proc !== proc) return; // dropped: whatever it still says goes unheard
      const { event, items } = parseLine(line);
      noteUnknown(event);
      if (event?.type === 'control_response') return this.answered(event.response);
      // The newest entry of the conversation's own chain, so a later rewind can
      // resume up to the end of this turn (see result below and rewind()).
      if ((event?.type === 'assistant' || event?.type === 'user') && !event.parent_tool_use_id && typeof event.uuid === 'string') this.lastUuid = event.uuid;
      if ((event?.type === 'assistant' || event?.type === 'user') && !event.parent_tool_use_id) this.trackSteps(event);
      if (event?.type === 'control_request' && event.request?.subtype === 'hook_callback' && event.request.callback_id === WORK_HOOK) {
        this.answerHook(event.request_id, event.request.input);
      } else if (event?.type === 'control_request' && event.request?.subtype === 'hook_callback' && event.request.callback_id === STEER_HOOK) {
        this.steer(event.request_id, event.request.input);
      } else if (event?.type === 'control_request' && event.request?.subtype === 'mcp_message' && this.mcp && event.request.server_name === crabmcp.SERVER) {
        this.answerMcp(event);
      } else if (event?.type === 'control_request' && event.request?.subtype !== 'can_use_tool') {
        // Unknown host callbacks (hooks, MCP bridging): answer so the CLI never hangs.
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'Not supported by Shellby' } });
      }
      for (const item of items) this.handle(item);
      this.inOrder(() => {
        this.countSpend(spendFrom(event));
        this.countCall(event);
        this.measure(event);
      });
    });
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    proc.stdin.on('error', () => { /* process gone; 'close' reports it */ });

    proc.on('error', err => {
      removeFile(configFile);
      const text = `Couldn't start Claude Code: ${err.message}`;
      this.emitItem({ kind: 'error', text, trouble: this.troubleOf(text, { start: true }) });
    });
    // 'exit', not 'close': a leftover holding one of claude's pipes would hold
    // 'close' back until it ended on its own, which is what this is here to stop.
    proc.on('exit', () => {
      removeFile(configFile);
      processJob.sweep(job);
      if (this.job === job) this.job = null;
    });
    proc.on('close', code => { if (this.proc === proc) this.ended(code, stderr); });
  }

  // What went wrong, as the panel says it. On another computer, ssh's own
  // failures (no route, sign-in refused, no Claude Code there) come first.
  troubleOf(text, opts) {
    return this.remoteHost ? remoteTroubleOf(text, opts, remoteSsh.troubleOf) : troubleOf(text, opts);
  }

  // The process is gone (or let go of): nothing it had going can finish. What
  // it said before it went is told first (inOrder), and so is its turn's end.
  ended(code, stderr = '') {
    // A stop() asked for isn't a crash, and the tab stays busy for whoever asked.
    const stopping = this.stopping;
    this.stopping = false;
    this.proc = null;
    if (this.partial) { clearTimeout(this.partial.timer); this.partial = null; } // half a reply that will never be finished
    this.setupChars = null; // a first prompt that never got its call can't size the next one
    this.waiting = null;
    this.steered = [];
    this.openTools.clear();
    for (const id of [...this.requests.keys()]) this.answered({ request_id: id, subtype: 'error', error: 'Claude Code stopped.' });
    this.inOrder(() => {
      const wasBusy = this.busy && !stopping;
      this.cancelPending();
      let crewChanged = false;
      for (const [id, t] of this.tasks) {
        if (t.status === 'running') { this.tasks.set(id, { ...t, status: 'stopped', endedAt: Date.now() }); crewChanged = true; }
      }
      if (crewChanged) this.emit('crew', this.crew);
      if (jobs.stopAll(this.jobs, Date.now())) this.emit('jobs', this.jobView()); // what it left running can't finish now
      // You pressed Stop and it didn't wind down in time (interrupt() killed it),
      // or it went on its own meanwhile: a stop either way, not a crash.
      const stopped = this.interrupting;
      this.interrupting = false;
      if (wasBusy) {
        // Everything that waits for a turn to end (the panel's queue, the turn's
        // diff and Undo, the tab's unread mark, a workflow's step) waits for its
        // result, and a process that's gone never sends one: this stands in for it.
        // `error` is the sentence, for whatever reports the turn; the panel has
        // already shown the error item's block, so it doesn't show this one again.
        const result = { kind: 'result', ok: false, interrupted: stopped, error: null, durationMs: this.busySince ? Date.now() - this.busySince : 0 };
        if (!stopped) {
          const text = stderr.trim().split('\n').slice(-6).join('\n') || `Claude Code exited (code ${code}).`;
          const trouble = this.troubleOf(text, { exited: true });
          // Its history is gone (or never was): resuming it again would only fail
          // again, so the next message here starts a new conversation.
          if (trouble.kind === 'resume-failed') { this.sessionId = null; this.resumeAt = null; }
          this.emit('item', { kind: 'error', text, trouble });
          Object.assign(result, { crashed: true, error: trouble.message || text });
        }
        this.closeTurn(result); // what it spent before it went is still spent
        this.setBusy(false);
        this.emit('item', result);
      }
      this.emit('exit', code);
    });
  }

  // Run fn now, or once the edit being placed (and all that came before) has
  // been told. Everything that emits an item goes through here.
  inOrder(fn) {
    if (this.held) this.held.push(fn);
    else fn();
  }

  emitItem(item) { this.inOrder(() => this.emit('item', item)); }

  // Read where an edit lands, then tell it, then whatever waited behind it.
  placeThenEmit(item) {
    this.held = [];
    placeEdit(item).catch(() => {}).then(() => {
      try {
        this.emit('item', item); // still held: what its listeners emit goes after what came before
      } finally {
        const rest = this.held;
        this.held = null;
        // One of these may be another edit, which holds the rest again.
        while (rest.length && !this.held) {
          const fn = rest.shift();
          // A listener that throws mustn't strand the rest (it's still reported, as before).
          try { fn(); } catch (err) { setImmediate(() => { throw err; }); }
        }
        if (this.held) this.held.push(...rest);
      }
    });
  }

  // End the process and let go of it at once, not when it has wound down: the
  // next send starts a fresh one (resuming the conversation) straight away.
  drop() {
    if (!this.proc) return;
    this.kill();
    this.ended(null);
  }

  async answerMcp(event) {
    const response = await crabmcp.handle(event.request.message, this.mcp);
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { mcp_response: response } } });
  }

  // The reply's words as they're written go out together, every PARTIAL_MS at
  // most, and always before whatever came after them.
  handle(item) {
    if (item.kind === 'partial') return this.inOrder(() => this.bufferPartial(item.text));
    this.inOrder(() => { this.flushPartial(); this.handleNow(item); });
  }

  bufferPartial(text) {
    if (!this.partial) {
      const timer = setTimeout(() => this.inOrder(() => this.flushPartial()), PARTIAL_MS);
      timer.unref?.();
      this.partial = { text: '', timer };
    }
    this.partial.text += text;
  }

  flushPartial() {
    const p = this.partial;
    if (!p) return;
    clearTimeout(p.timer);
    this.partial = null;
    if (p.text) this.emit('item', { kind: 'partial', text: p.text });
  }

  handleNow(item) {
    switch (item.kind) {
      case 'text':
        if (item.sub) this.noteSaid(item); // a helper's words (--forward-subagent-text): its crab says them
        break;
      case 'init':
        if (item.sessionId) this.sessionId = item.sessionId;
        this.resumeAt = null; // the fork is made: from here on it's an ordinary resume
        break;
      case 'tool': {
        if (item.filePath) this.createdFiles.add(item.filePath);
        // Claude writing down something to remember (Claude Code's auto memory).
        const memory = item.filePath ? memoryOf(item.filePath) : null;
        if (memory) item.memory = memory;
        jobs.noteTool(this.jobs, item);
        if (item.agent) this.nameAgent(item);
        if (item.message) this.noteMessage(item);
        if (item.name === 'EnterPlanMode' && !item.sub) this.setPlanning(true);
        this.noteTodos(item);
        if (item.edits?.length) return this.placeThenEmit(item);
        break;
      }
      case 'tool_result':
        jobs.noteResult(this.jobs, item);
        this.noteTodos(item);
        break;
      case 'task':
        // A command or a watch left running isn't a helper (jobs.js).
        if (jobs.isJob(item, this.jobs)) {
          if (jobs.track(this.jobs, item, Date.now())) this.emit('jobs', this.jobView());
          break;
        }
        this.trackTask(item);
        break;
      case 'permission':
        Object.assign(item, annotatePermission(item, { createdFiles: this.createdFiles, tasks: this.tasks }));
        Object.assign(item, plainPermission(item, { cwd: this.cwd, inCopy: !!this.inCopy?.(), originalCwd: this.copyOf?.() || null }));
        this.pending.set(item.requestId, item);
        if (item.edits?.length) return this.placeThenEmit(item);
        break;
      case 'result':
        if (item.sessionId) this.sessionId = item.sessionId;
        if (this.interrupting) { item.interrupted = true; item.ok = false; item.error = null; }
        this.interrupting = false;
        // What went wrong, in a sentence and a next step (trouble.js); the CLI's own words stay in `error`.
        if (!item.ok && !item.interrupted && item.error) item.trouble = troubleOf(item.error);
        // Where this turn ends in Claude Code's transcript: rewinding to the
        // message after it resumes up to here.
        if (this.lastUuid) item.anchor = this.lastUuid;
        this.openTools.clear();
        this.closeTurn(item);
        // A steer that went in but was never read (Stop landed first): the CLI
        // would run it as a turn of its own next. Dropping the process drops it
        // too (and what it had running, so nothing below waits on that). It's
        // still in the panel's queue, which hands it back or sends it as usual,
        // and that next message resumes the conversation.
        if (this.steered.length) {
          this.setBusy(false); // not a crash: ended() says nothing
          this.drop();
        }
        // A command that outran its timeout (or was backgrounded on purpose)
        // is still going: the turn ended, but the work isn't done.
        if (item.ok && !item.interrupted) {
          const waiting = [...this.runningCrew(), ...jobs.running(this.jobs)].map(t => t.description || 'a background task');
          if (waiting.length) item.waiting = waiting;
        }
        // Background subagents can outlive the turn, so pending prompts stay open;
        // only interrupt/exit cancel them. Clear busy before emitting so listeners
        // reacting to the result can send a follow-up.
        this.setBusy(false);
        this.emit('item', item);
        return;
    }
    this.emit('item', item);
  }

  /** Background commands and watches, running and just finished (jobs.js). */
  jobView(now = Date.now()) {
    return jobs.view(this.jobs, now);
  }

  /**
   * Ask Claude Code to stop one background command or watch, the way its own
   * TaskStop does. -> { ok } | { ok: false, error }.
   */
  async stopJob(taskId) {
    const job = this.jobs.byId.get(taskId);
    if (!job || job.status !== 'running') return { ok: false, error: "That isn't running any more." };
    const r = await this.request('stop_task', { task_id: taskId });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // Claude's to-do list moved: 'todos' with the list at a glance (shared/todos.js).
  noteTodos(item) {
    if (todos.apply(this.todos, item)) this.emit('todos', todos.summary(this.todos));
  }

  setPlanning(on) {
    if (this.planning === on) return;
    this.planning = on;
    this.emit('planning', on);
  }

  setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    this.busySince = b ? Date.now() : null;
    this.tool = null;
    this.toolAt = null;
    this.emit('busy', b);
  }

  write(obj) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  // ready: a promise to wait for before Claude sees the message. main.js uses
  // it to give a tab its own worktree (which can change cwd, so the process
  // starts after it) and to snapshot the folder for the turn's diff. The tab is
  // busy from the moment it's sent, so typing more still queues.
  //
  // content: the prompt, or a list of blocks when pictures go with it (see
  // attachments.js composeContent).
  send(content, ready = null) {
    if (this.busy) throw new Error('Shellby is still working on the last task.');
    this.setBusy(true);
    // effort: what this turn thinks at, for its cost line ('' is Claude Code's own default).
    this.turn = { usages: new Map(), helpers: new Map(), weight: 0, tokens: 0, before: this.context?.tokens ?? null, effort: this.effort || '' };
    // No conversation yet: its first call will show the setup weight. A prompt
    // with an image can't be sized, so that one isn't measured (-1).
    if (!this.sessionId && !this.proc) this.setupChars = eff.promptChars(content) ?? -1;
    const message = { type: 'user', message: { role: 'user', content } };
    if (!ready) {
      this.start();
      return this.write(message);
    }
    const waiting = (this.waiting = {});
    Promise.resolve(ready).catch(() => {}).then(() => {
      if (this.waiting !== waiting) return; // stopped before it went
      this.waiting = null;
      this.start();
      this.write(message);
    });
  }

  // decision: 'allow' | 'always' | 'deny'. answers: AskUserQuestion's
  // { [question text]: chosen label(s) or the user's own words }. via: 'phone'
  // when it was answered from a notification (replies.js), 'deck' from a Stream
  // Deck key (deck.js), so the card says so.
  respond(requestId, decision, message, answers, via) {
    const item = this.pending.get(requestId);
    if (!item) return false;
    this.pending.delete(requestId);
    let response;
    if (decision === 'deny') {
      response = { behavior: 'deny', message: message || DENY_MESSAGE };
    } else {
      response = { behavior: 'allow', updatedInput: item.input };
      // Claude reads the user's choices from updatedInput.answers (checked against the real CLI).
      if (item.toolName === 'AskUserQuestion' && answers) {
        const asked = new Set((item.input?.questions || []).map(q => q?.question));
        const clean = {};
        for (const [q, a] of Object.entries(answers)) if (asked.has(q) && typeof a === 'string' && a.trim()) clean[q] = a.trim().slice(0, 2000);
        response.updatedInput = { ...item.input, answers: clean };
      }
      if (decision === 'always' && item.suggestions.length) response.updatedPermissions = item.suggestions;
      if (item.toolName === 'ExitPlanMode') this.setPlanning(false); // the plan's approved: on to the work
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emitItem({ kind: 'decision', requestId, decision, toolName: item.toolName, ...(via === 'phone' || via === 'deck' ? { via } : {}) });
    return true;
  }

  cancelPending() {
    for (const id of this.pending.keys()) this.emit('item', { kind: 'decision', requestId: id, decision: 'cancelled' });
    this.pending.clear();
  }

  interrupt() {
    if (this.busy && this.waiting) {
      // Claude never saw it, so there's nothing to interrupt: the turn just ends.
      this.waiting = null;
      this.setBusy(false);
      this.emitItem({ kind: 'result', ok: false, interrupted: true, error: null, durationMs: 0 });
      return;
    }
    if (!this.proc || !this.busy) return;
    this.interrupting = true;
    for (const id of [...this.pending.keys()]) this.respond(id, 'deny', 'Interrupted by the user.');
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    // If the CLI doesn't wind down promptly, kill it; the session can be resumed.
    const proc = this.proc;
    setTimeout(() => { if (this.proc === proc && this.busy) this.kill(); }, 8000);
  }

  /**
   * Ask the running CLI something over the control protocol and wait for its
   * answer. -> { ok: true, response } | { ok: false, error }. Never throws.
   */
  request(subtype, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.proc) return Promise.resolve({ ok: false, error: "This conversation isn't running right now." });
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answered({ request_id: id, subtype: 'error', error: "Claude Code didn't answer." }), timeoutMs);
      this.requests.set(id, { resolve, timer });
      this.write({ type: 'control_request', request_id: id, request: { subtype, ...payload } });
    });
  }

  answered(r) {
    const waiting = r && this.requests.get(r.request_id);
    if (!waiting) return;
    this.requests.delete(r.request_id);
    clearTimeout(waiting.timer);
    waiting.resolve(r.subtype === 'success' ? { ok: true, response: r.response || {} } : { ok: false, error: String(r.error || 'Claude Code said no.') });
  }

  // Effort for this conversation: the flag for the next start, and the running
  // process told now, so the very next turn thinks harder (or less).
  setEffort(effort) {
    this.effort = EFFORTS.includes(effort) ? effort : '';
    if (this.proc) this.request('apply_flag_settings', { settings: { effortLevel: this.effort || null } });
  }

  /**
   * Make the next start pick the conversation up only as far as `anchor` (a
   * transcript entry from an earlier result), as a new fork. No anchor: the
   * next message starts a new conversation.
   */
  async rewindTo(anchor) {
    await this.stop();
    if (anchor) this.resumeAt = anchor;
    else this.sessionId = null;
    this.lastUuid = null;
    this.setContext(0);
    // The panel rebuilds the list from what's left of the feed; here it starts over.
    this.todos = todos.create();
    this.emit('todos', todos.summary(this.todos));
  }

  setMode(mode) {
    this.mode = mode;
    this.setPlanning(mode === 'plan');
    if (this.proc) {
      this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode: CLI_MODE[mode] } });
    }
  }

  // The main thread's tool calls still running, and the moment Claude reads a
  // steer: the CLI echoes each message as it takes it in (--replay-user-messages).
  // A turn's first message is echoed too, but nothing is steered by then.
  trackSteps(event) {
    if (event.type === 'user' && event.isReplay) {
      if (this.steered.length) this.emitItem(this.steered.shift());
      return;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    if (event.type === 'assistant') this.trackPlan(content);
    for (const b of content) {
      if (event.type === 'assistant' && b.type === 'tool_use') { this.openTools.add(b.id); this.setTool(b.name); }
      if (event.type === 'user' && b.type === 'tool_result') { this.openTools.delete(b.tool_use_id); if (!this.openTools.size) this.setTool(null); }
    }
  }

  setTool(name) {
    const tool = typeof name === 'string' ? name.slice(0, 80) : null;
    if (tool === this.tool) return;
    this.tool = tool;
    this.toolAt = Date.now();
    this.emit('tool', tool);
  }

  // Claude's to-do list moved: the running turn's step and pace, beside its clock.
  trackPlan(content) {
    const plan = planPace.read(this.plan, content);
    if (plan === this.plan) return;
    this.plan = plan;
    if (!this.turn) return;
    this.turn.plan = planPace.track(this.turn.plan, planPace.counts(plan), Date.now());
    this.emit('plan');
  }

  // A tool call on the main thread has finished (or failed). What you queued
  // meanwhile goes in now, written ahead of this answer so the CLI has it before
  // it hands the tool's result back: Claude reads it before its next step, like
  // Claude Code's own queue. Only once nothing else of this step is still
  // running (until Claude has read it, Stop can't take it back), not for a
  // subagent's tools, whose steer would wait on the whole subagent, and not
  // once you've pressed Stop.
  steer(requestId, input) {
    try {
      this.openTools.delete(input?.tool_use_id);
      const stopping = this.interrupting || input?.is_interrupt;
      if (this.busy && !stopping && !input?.agent_id && !this.openTools.size && this.proc?.stdin.writable) {
        for (const s of this.takeSteers?.() || []) {
          this.write({ type: 'user', message: { role: 'user', content: s.content } });
          this.steered.push(s.item);
        }
      }
    } catch { /* it waits for the next step, or goes when the turn ends */ }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
  }

  async answerHook(requestId, input) {
    let response = {};
    try { response = (await this.beforeWork?.(input || {})) || {}; } catch { /* let the tool run */ }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  /** End the process (not the conversation) and wait until it's gone. The next send() resumes it. */
  stop(timeoutMs = 8000) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    this.stopping = true;
    this.close();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  kill() {
    if (!this.proc) return;
    // The job holds claude and everything it started, even what has lost its
    // parent. Ended here and now, so it holds while Shellby quits.
    if (processJob.sweep(this.job)) return;
    // No job: /T takes down the tree as far as it's still connected.
    execFile(TASKKILL, ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  close() {
    this.waiting = null; // a turn still waiting to go never goes
    if (!this.proc) return;
    const proc = this.proc;
    try { proc.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { if (this.proc === proc) this.kill(); }, 3000);
  }
}

Object.defineProperties(ClaudeSession.prototype, Object.getOwnPropertyDescriptors(accounting));
Object.defineProperties(ClaudeSession.prototype, Object.getOwnPropertyDescriptors(crew));

module.exports = { ClaudeSession, DENY_MESSAGE, EFFORTS, OPTIONAL_FLAGS, initHooks, setLogger, placeEdit, TALK_MS };
