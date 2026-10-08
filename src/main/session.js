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
const { troubleOf } = require('./trouble');
const { weightOf } = require('./spend');
const ctx = require('./context');
const turncost = require('./turncost');
const eff = require('./efficiency');
const { claudeEnv } = require('./claude-cli');
const { CLI_MODE } = require('./config');
const { annotatePermission } = require('./safety');
const crabmcp = require('./crabmcp');
const processJob = require('./process-job');

// The tools that can change files, for the beforeWork hook.
const WORK_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';
const WORK_HOOK = 'shellby-before-work';
// Every finished tool call on the main thread, so what you typed while Claude
// works can go in before its next step (steer()).
const STEER_HOOK = 'shellby-steer';

const DENY_MESSAGE = 'The user declined this action in Shellby. Ask them how they would like to proceed.';

// Effort levels Claude Code takes (--effort). '' leaves it to Claude Code.
const { EFFORTS, unknownType } = require('./cli-contract');
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
  // systemNote: appended to Claude Code's system prompt (see selfaware.js).
  // mcp: { tools, call(name, args) } -> the crab's tools, hosted here (see crabmcp.js).
  constructor({ exe, cwd, mode, model, effort = '', outputStyle = '', resumeId = null, resumeAt = null, argsPrefix = [], extraEnv = () => ({}), context = null, allowedTools = [], mcpConfig = null, systemNote = null, mcp = null }) {
    super();
    Object.assign(this, { exe, cwd, mode, model, effort, outputStyle, resumeId, argsPrefix, extraEnv, allowedTools, mcpConfig, systemNote, mcp });
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
    this.interrupting = false;
    this.createdFiles = new Set(); // paths Claude wrote/edited this conversation
    this.tasks = new Map();        // subagent task_id -> { status, description, ... }
    this.counted = new Map();      // message id -> weight already reported as 'spend'
    this.calls = new Map();        // message id -> token counts already reported as 'call'
    this.cache = null;             // { at, ttlMs }: when this conversation last touched the prompt cache
    this.setupChars = null;        // a new conversation's first prompt, in characters, until its first call is measured
    // What the running turn has cost so far: { usages: message id -> usage, weight,
    // before: context tokens when it began }. Its result carries it (turncost.js).
    this.turn = null;
    this.growths = [];             // how much the last few turns grew the context, for the crowded nudge
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

  start() {
    if (this.proc) return;
    // The servers' definitions can hold tokens, so they go in a file of the
    // process's own rather than on its command line, and the file goes with it.
    const configFile = this.mcpConfig ? writeConfig(this.fullMcpConfig()) : null;
    this.mcpConfigFile = configFile;
    const proc = spawn(this.exe, [...this.argsPrefix, ...this.buildArgs()], {
      cwd: this.cwd, env: { ...claudeEnv(), ...this.extraEnv() }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    // Everything Claude starts joins this job, so ending the conversation can
    // end it too: MCP servers, shells, app copies it ran (process-job.js).
    const job = processJob.adopt(proc.pid);
    this.job = job;
    let stderr = '';
    // Also names the servers hosted here: Claude Code then connects to them
    // with mcp_message requests before the first turn.
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize', hooks: initHooks(!!this.beforeWork), ...(this.mcp ? { sdkMcpServers: [crabmcp.SERVER] } : {}) } });

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
      this.countSpend(spendFrom(event));
      this.countCall(event);
      this.measure(event);
    });
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    proc.stdin.on('error', () => { /* process gone; 'close' reports it */ });

    proc.on('error', err => {
      removeFile(configFile);
      const text = `Couldn't start Claude Code: ${err.message}`;
      this.emit('item', { kind: 'error', text, trouble: troubleOf(text, { start: true }) });
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

  // The process is gone (or let go of): nothing it had going can finish.
  ended(code, stderr = '') {
    // A stop() asked for isn't a crash, and the tab stays busy for whoever asked.
    const wasBusy = this.busy && !this.stopping;
    this.stopping = false;
    this.proc = null;
    this.setupChars = null; // a first prompt that never got its call can't size the next one
    this.waiting = null;
    this.steered = [];
    this.openTools.clear();
    this.cancelPending();
    for (const id of [...this.requests.keys()]) this.answered({ request_id: id, subtype: 'error', error: 'Claude Code stopped.' });
    let crewChanged = false;
    for (const [id, t] of this.tasks) {
      if (t.status === 'running') { this.tasks.set(id, { ...t, status: 'stopped' }); crewChanged = true; }
    }
    if (crewChanged) this.emit('crew', this.crew);
    if (wasBusy) {
      const text = stderr.trim().split('\n').slice(-6).join('\n') || `Claude Code exited (code ${code}).`;
      const trouble = troubleOf(text, { exited: true });
      // Its history is gone (or never was): resuming it again would only fail
      // again, so the next message here starts a new conversation.
      if (trouble.kind === 'resume-failed') { this.sessionId = null; this.resumeAt = null; }
      this.emit('item', { kind: 'error', text, trouble });
      this.setBusy(false);
    }
    this.emit('exit', code);
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

  handle(item) {
    switch (item.kind) {
      case 'init':
        if (item.sessionId) this.sessionId = item.sessionId;
        this.resumeAt = null; // the fork is made: from here on it's an ordinary resume
        break;
      case 'tool':
        if (item.filePath) this.createdFiles.add(item.filePath);
        break;
      case 'task':
        this.trackTask(item);
        break;
      case 'permission':
        Object.assign(item, annotatePermission(item, { createdFiles: this.createdFiles, tasks: this.tasks }));
        this.pending.set(item.requestId, item);
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
          const waiting = this.runningCrew().map(t => t.description || 'a background task');
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

  // What each API call cost, for the usage-by-project ledger (spend.js). One
  // call arrives as several events repeating its usage, so only growth past
  // what was already reported counts. Kept off the 'item' stream so it never
  // lands in the transcript.
  countSpend(s) {
    if (!s) return;
    if (this.turn) this.countTurnTokens(s);
    const weight = weightOf(s.usage, s.model);
    const before = this.counted.get(s.messageId) || 0;
    if (weight <= before) return;
    this.counted.delete(s.messageId);
    this.counted.set(s.messageId, weight);
    if (this.counted.size > 500) this.counted.delete(this.counted.keys().next().value);
    if (this.turn) this.turn.weight += weight - before;
    this.emit('spend', { messageId: s.messageId, weight: weight - before });
  }

  // The running turn's tokens so far, counted as its result's cost will count
  // them, for the panel's live "12s · 4.2k tokens". 'tokens' only when it grows.
  countTurnTokens(s) {
    const turn = this.turn;
    turn.usages.set(s.messageId, turncost.mergeUsage(turn.usages.get(s.messageId), s.usage));
    const { fresh } = turncost.tokensOf([...turn.usages.values()]);
    if (fresh <= turn.tokens) return;
    turn.tokens = fresh;
    this.emit('tokens', fresh);
  }

  // The turn's cost goes on its result, so History keeps it with the turn.
  // Helpers' calls count too: they spend from the same window.
  closeTurn(item) {
    const turn = this.turn;
    this.turn = null;
    if (!turn) return;
    const cost = turncost.turnCost({ usages: [...turn.usages.values()], weight: turn.weight }, this.context);
    if (cost) item.cost = cost;
    this.growths = turncost.addGrowth(this.growths, turn.before, this.context?.tokens);
  }

  // The prompt cache and setup weight (efficiency.js), off the transcript like
  // spend. 'call' carries each call's growth in cache reads, cache writes and
  // fresh input; 'cache' says when the main thread last touched the cache.
  countCall(event) {
    const c = eff.callFrom(event);
    if (!c) return;
    const prev = this.calls.get(c.messageId);
    const grow = f => Math.max(0, c[f] - (prev?.[f] || 0));
    const delta = { input: grow('input'), write: grow('write'), read: grow('read'), isNew: !prev };
    this.calls.delete(c.messageId);
    this.calls.set(c.messageId, { input: Math.max(c.input, prev?.input || 0), write: Math.max(c.write, prev?.write || 0), read: Math.max(c.read, prev?.read || 0) });
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value);
    // A brand-new conversation's first call is everything it carries before your first word.
    let setup = null;
    if (c.main && !prev && this.setupChars !== null) {
      setup = eff.setupTokens(c, this.setupChars);
      this.setupChars = null;
    }
    if (delta.input || delta.write || delta.read || setup) this.emit('call', { ...delta, setup });
    // Stamped on a call's first event, close to when it read the cache: its later
    // blocks arrive as it writes, which would make the cache look warmer than it is.
    if (c.main && !prev) {
      this.cache = { at: Date.now(), ttlMs: c.ttlMs || this.cache?.ttlMs || eff.DEFAULT_TTL_MS };
      this.emit('cache', this.cache);
    }
  }

  // How full the context window is, from each main-thread reply's token counts.
  // Emitted as 'context', off the transcript like spend.
  measure(event) {
    const windows = ctx.windowsFrom(event);
    if (windows) {
      this.windows = windows;
      if (this.context) this.setContext(this.context.tokens, this.lastModel);
      return;
    }
    if (event?.type === 'system' && event.subtype === 'compact_boundary') return this.setContext(0);
    const t = ctx.tokensFrom(event);
    if (!t) return;
    this.lastModel = t.model || this.lastModel;
    this.setContext(t.tokens, this.lastModel);
  }

  setContext(tokens, model = this.lastModel) {
    const next = ctx.view(tokens, ctx.windowFor(model, this.windows, this.model));
    const before = this.context;
    if (before?.tokens === next?.tokens && before?.window === next?.window) return;
    this.context = next;
    this.emit('context', next, before);
  }

  // Keeps a live map of subagents so permission prompts can be attributed and
  // the desktop can show one helper crab per running agent.
  trackTask(item) {
    if (!item.taskId) return;
    const prev = this.tasks.get(item.taskId) || { taskId: item.taskId, status: 'running', startedAt: Date.now() };
    const next = { ...prev };
    for (const k of ['toolUseId', 'description', 'subagentType', 'background', 'lastTool', 'usage']) {
      if (item[k] != null && !(k === 'description' && prev.description && item.phase === 'progress')) next[k] = item[k];
    }
    if (item.phase === 'progress' && item.description) next.activity = item.description;
    if (item.status) next.status = item.status === 'completed' ? 'completed' : item.status;
    if (item.phase === 'done' && !item.status) next.status = 'completed';
    this.tasks.set(item.taskId, next);
    this.emit('crew', this.crew);
  }

  get crew() {
    return [...this.tasks.values()];
  }

  runningCrew() {
    return this.crew.filter(t => t.status === 'running');
  }

  setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    this.busySince = b ? Date.now() : null;
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
    this.turn = { usages: new Map(), weight: 0, tokens: 0, before: this.context?.tokens ?? null };
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
  // when it was answered from a notification (replies.js), so the card says so.
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
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit('item', { kind: 'decision', requestId, decision, toolName: item.toolName, ...(via === 'phone' ? { via } : {}) });
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
      this.emit('item', { kind: 'result', ok: false, interrupted: true, error: null, durationMs: 0 });
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
  }

  setMode(mode) {
    this.mode = mode;
    if (this.proc) {
      this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode: CLI_MODE[mode] } });
    }
  }

  // The main thread's tool calls still running, and the moment Claude reads a
  // steer: the CLI echoes each message as it takes it in (--replay-user-messages).
  // A turn's first message is echoed too, but nothing is steered by then.
  trackSteps(event) {
    if (event.type === 'user' && event.isReplay) {
      if (this.steered.length) this.emit('item', this.steered.shift());
      return;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (event.type === 'assistant' && b.type === 'tool_use') this.openTools.add(b.id);
      if (event.type === 'user' && b.type === 'tool_result') this.openTools.delete(b.tool_use_id);
    }
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

module.exports = { ClaudeSession, DENY_MESSAGE, EFFORTS, initHooks, setLogger };
