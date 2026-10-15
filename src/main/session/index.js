// One conversation = one long-lived `claude -p` process speaking stream-json on
// stdin/stdout. Permission prompts, interrupts and mode switches go over the same
// control protocol the Claude Agent SDK uses, so no API key is ever involved.
// The class keeps the process's life and what it says; the rest is mixed in:
// how it's launched (args.js), answering it (control.js), what it costs
// (accounting.js) and its helpers (crew.js).
const { spawn, execFile } = require('child_process');
const os = require('os');
const { TASKKILL } = require('../system32'); // by full path: Claude runs in project folders
const readline = require('readline');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { parseLine, spendFrom } = require('../stream');
const { troubleOf, remoteTroubleOf } = require('../trouble');
const remoteSsh = require('../remote/ssh');
const ctx = require('../context');
const planPace = require('../plan-pace');
const eff = require('../efficiency');
const { claudeEnv } = require('../claude/cli');
const { annotatePermission } = require('../safety');
const { plainPermission } = require('../plain-words');
const crabmcp = require('../crabmcp');
const processJob = require('../process-job');
const todos = require('../../renderer/shared/todos');
const jobs = require('../jobs');
const ultracode = require('../ultracode');
const { memoryOf } = require('../automemory');
const { unknownType } = require('../cli-contract');
const { args, EFFORTS, OPTIONAL_FLAGS, WORK_HOOK, STEER_HOOK, writeConfig, removeFile, initHooks } = require('./args');
const { control, DENY_MESSAGE } = require('./control');
const { placeEdit } = require('./place');
const { accounting } = require('./accounting');
const { crew, TALK_MS } = require('./crew');
const { ultra } = require('./ultra');

// How often the reply's words as they're written reach the panel, at most.
const PARTIAL_MS = 50;
// How long a closed stdin waits for the CLI to go before it's killed.
const CLOSE_KILL_MS = 3000;

// Where an event type Shellby has never seen gets noted (main.js passes its
// log, which scrubs it). Once per type per run: a chatty new event mustn't fill
// the log, and the type name alone says what a Claude Code update added.
/** @type {{ warn: (...args: unknown[]) => void } | null} */
let logger = null;
const loggedTypes = new Set();
function setLogger(log) { logger = log || null; }
function noteUnknown(event) {
  const type = unknownType(event);
  if (!type || loggedTypes.has(type)) return;
  loggedTypes.add(type);
  try { logger?.warn('Claude Code sent an event Shellby does not know yet', type); } catch { /* the log never matters more than the turn */ }
}

/**
 * What a ClaudeSession is made with (the constructor's comment says what each is).
 * @typedef {object} SessionOptions
 * @property {string | (() => string)} exe
 * @property {string} cwd
 * @property {string} mode
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [outputStyle]
 * @property {string} [fallbackModel]
 * @property {boolean} [chrome]
 * @property {boolean} [safeMode]
 * @property {string} [agent]
 * @property {() => string} [name]
 * @property {(flag: string) => boolean} [supports]
 * @property {string | null} [resumeId]
 * @property {string | null} [resumeAt]
 * @property {string[]} [argsPrefix]
 * @property {() => Record<string, string>} [extraEnv]
 * @property {{ tokens?: number, window?: number } | null} [context]
 * @property {string[]} [allowedTools]
 * @property {{ mcpServers?: Record<string, unknown> } | null} [mcpConfig]
 * @property {string | null} [systemNote]
 * @property {{ tools: unknown[], call: Function } | null} [mcp]
 * @property {() => { exe: string, host: string, dir: string, env: Record<string, string>, extra?: string[], argsPrefix?: string[] } | null} [remote]
 */

/** @typedef {typeof args & typeof control & typeof accounting & typeof crew & typeof ultra} SessionMixins */
// EventEmitter at run time: the mixins join the prototype at the end of this
// file. The cast only lets the class (and tsc) see their methods on `this`.
const Base = /** @type {new () => EventEmitter & SessionMixins} */ (/** @type {unknown} */ (EventEmitter));

class ClaudeSession extends Base {
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
  /** @param {SessionOptions} options */
  constructor({ exe, cwd, mode, model, effort = '', outputStyle = '', fallbackModel = '', chrome = false, safeMode = false, agent = '', name = () => '', supports = () => true, resumeId = null, resumeAt = null, argsPrefix = [], extraEnv = () => ({}), context = null, allowedTools = [], mcpConfig = null, systemNote = null, mcp = null, remote = () => null }) {
    super();
    this.exe = exe;
    this.cwd = cwd;
    this.mode = mode;
    this.model = model;
    this.effort = effort;
    this.outputStyle = outputStyle;
    this.fallbackModel = fallbackModel;
    this.chrome = chrome;
    this.safeMode = safeMode;
    this.agent = agent;
    this.nameOf = name;
    this.supports = supports;
    this.resumeId = resumeId;
    this.argsPrefix = argsPrefix;
    this.extraEnv = extraEnv;
    this.allowedTools = allowedTools;
    this.mcpConfig = mcpConfig;
    this.systemNote = systemNote;
    this.mcp = mcp;
    this.remote = remote;
    // Set by the manager (sessions.js) for a conversation that can move into a
    // copy of its folder: whether it's in one now, and the folder it copies.
    /** @type {(() => boolean) | null} */
    this.inCopy = null;
    /** @type {(() => string | null) | null} */
    this.copyOf = null;
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
    // could change files before it runs, and can hold it back (worktrees/index.js).
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
    /** @type {(() => void)[] | null} */
    this.held = null;
    this.createdFiles = new Set(); // paths Claude wrote/edited this conversation
    this.tasks = new Map();        // subagent task_id -> { status, description, ... }
    // Commands and Monitor watches running in the background (jobs.js): kept
    // apart from the helpers, so a `npm run dev` left running isn't a crab.
    this.jobs = jobs.create();
    // Ultracode runs (Claude Code's Workflow tool, ultracode.js): a card each, and their agents as helper crabs.
    this.ultra = ultracode.create();
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
      this.stopRuns();
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
        const rest = this.held || [];
        this.held = null;
        // One of these may be another edit, which holds the rest again.
        while (rest.length && !this.held) {
          const fn = /** @type {() => void} */ (rest.shift()); // the loop checked there is one
          // A listener that throws mustn't strand the rest (it's still reported, as before).
          try { fn(); } catch (err) { setImmediate(() => { throw err; }); }
        }
        // fn() may have held them again: tsc only sees the null set above.
        const heldAgain = /** @type {(() => void)[] | null} */ (this.held);
        if (heldAgain) heldAgain.push(...rest);
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
        if (item.workflowLaunch) this.noteLaunch(item.workflowLaunch);
        this.noteTodos(item);
        break;
      case 'task':
        // An ultracode run is a card and a crowd of crabs, not a helper (ultracode.js).
        if (ultracode.isRun(item, this.ultra)) return this.trackRun(item);
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
          const waiting = [...this.runningCrew().filter(t => !t.workflow), ...jobs.running(this.jobs), ...this.runningRuns()]
            .map(t => t.description || t.name || 'a background task');
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

  /**
   * End the process (not the conversation) and wait until it's gone. The next send() resumes it.
   * @returns {Promise<void>}
   */
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
    setTimeout(() => { if (this.proc === proc) this.kill(); }, CLOSE_KILL_MS);
  }
}

for (const mixin of [args, control, accounting, crew, ultra]) {
  Object.defineProperties(ClaudeSession.prototype, Object.getOwnPropertyDescriptors(mixin));
}

module.exports = { ClaudeSession, DENY_MESSAGE, EFFORTS, OPTIONAL_FLAGS, initHooks, setLogger, placeEdit, TALK_MS };
