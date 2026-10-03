// One conversation = one long-lived `claude -p` process speaking stream-json on
// stdin/stdout. Permission prompts, interrupts and mode switches go over the same
// control protocol the Claude Agent SDK uses, so no API key is ever involved.
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { parseLine, spendFrom } = require('./stream');
const { weightOf } = require('./spend');
const ctx = require('./context');
const { claudeEnv } = require('./claude-cli');
const { CLI_MODE } = require('./config');
const { annotatePermission } = require('./safety');

// The tools that can change files, for the beforeWork hook.
const WORK_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';
const WORK_HOOK = 'shellby-before-work';

const DENY_MESSAGE = 'The user declined this action in Shellby. Ask them how they would like to proceed.';

// Effort levels Claude Code takes (--effort). '' leaves it to Claude Code.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// How long Shellby waits for the CLI to answer one of its own control requests.
const REQUEST_TIMEOUT_MS = 15000;

class ClaudeSession extends EventEmitter {
  // argsPrefix lets tests run a fake CLI script: exe=node, argsPrefix=[script].
  // extraEnv: () => {} of variables to add when the process starts (GitHub access).
  // context: the last reading of how full it is ({ tokens, window }), so a
  // resumed conversation shows its meter before it next speaks.
  //
  // effort: one of EFFORTS, or '' for Claude Code's own default. outputStyle: a
  // style name passed as a flag setting, or '' to leave the user's own.
  constructor({ exe, cwd, mode, model, effort = '', outputStyle = '', resumeId = null, resumeAt = null, argsPrefix = [], extraEnv = () => ({}), context = null }) {
    super();
    Object.assign(this, { exe, cwd, mode, model, effort, outputStyle, resumeId, argsPrefix, extraEnv });
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
    this.interrupting = false;
    this.createdFiles = new Set(); // paths Claude wrote/edited this conversation
    this.tasks = new Map();        // subagent task_id -> { status, description, ... }
    this.counted = new Map();      // message id -> weight already reported as 'spend'
  }

  buildArgs() {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', CLI_MODE[this.mode] || 'default',
      // Lets the user switch into Autonomous mid-conversation; it has no effect
      // unless that mode is actually selected.
      '--allow-dangerously-skip-permissions',
    ];
    if (this.model) args.push('--model', this.model);
    if (EFFORTS.includes(this.effort)) args.push('--effort', this.effort);
    if (this.outputStyle) args.push('--settings', JSON.stringify({ outputStyle: this.outputStyle }));
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      if (this.resumeAt) args.push(`--resume-session-at=${this.resumeAt}`, '--fork-session');
    }
    return args;
  }

  start() {
    if (this.proc) return;
    const proc = spawn(this.exe, [...this.argsPrefix, ...this.buildArgs()], {
      cwd: this.cwd, env: { ...claudeEnv(), ...this.extraEnv() }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    let stderr = '';
    if (this.beforeWork) {
      this.write({ type: 'control_request', request_id: randomUUID(), request: {
        subtype: 'initialize',
        hooks: { PreToolUse: [{ matcher: WORK_TOOLS, hookCallbackIds: [WORK_HOOK] }] },
      } });
    }

    readline.createInterface({ input: proc.stdout }).on('line', line => {
      const { event, items } = parseLine(line);
      if (event?.type === 'control_response') return this.answered(event.response);
      // The newest entry of the conversation's own chain, so a later rewind can
      // resume up to the end of this turn (see result below and rewind()).
      if ((event?.type === 'assistant' || event?.type === 'user') && !event.parent_tool_use_id && typeof event.uuid === 'string') this.lastUuid = event.uuid;
      if (event?.type === 'control_request' && event.request?.subtype === 'hook_callback' && event.request.callback_id === WORK_HOOK) {
        this.answerHook(event.request_id, event.request.input);
      } else if (event?.type === 'control_request' && event.request?.subtype !== 'can_use_tool') {
        // Unknown host callbacks (hooks, MCP bridging): answer so the CLI never hangs.
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'Not supported by Shellby' } });
      }
      for (const item of items) this.handle(item);
      this.countSpend(spendFrom(event));
      this.measure(event);
    });
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    proc.stdin.on('error', () => { /* process gone; 'close' reports it */ });

    proc.on('error', err => {
      this.emit('item', { kind: 'error', text: `Couldn't start Claude Code: ${err.message}` });
    });
    proc.on('close', code => {
      // A stop() asked for isn't a crash, and the tab stays busy for whoever asked.
      const wasBusy = this.busy && !this.stopping;
      this.stopping = false;
      this.proc = null;
      this.waiting = null;
      this.cancelPending();
      for (const id of [...this.requests.keys()]) this.answered({ request_id: id, subtype: 'error', error: 'Claude Code stopped.' });
      let crewChanged = false;
      for (const [id, t] of this.tasks) {
        if (t.status === 'running') { this.tasks.set(id, { ...t, status: 'stopped' }); crewChanged = true; }
      }
      if (crewChanged) this.emit('crew', this.crew);
      if (wasBusy) {
        this.emit('item', { kind: 'error', text: stderr.trim().split('\n').slice(-6).join('\n') || `Claude Code exited (code ${code}).` });
        this.setBusy(false);
      }
      this.emit('exit', code);
    });
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
        // Where this turn ends in Claude Code's transcript: rewinding to the
        // message after it resumes up to here.
        if (this.lastUuid) item.anchor = this.lastUuid;
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
    const weight = weightOf(s.usage, s.model);
    const before = this.counted.get(s.messageId) || 0;
    if (weight <= before) return;
    this.counted.delete(s.messageId);
    this.counted.set(s.messageId, weight);
    if (this.counted.size > 500) this.counted.delete(this.counted.keys().next().value);
    this.emit('spend', { messageId: s.messageId, weight: weight - before });
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
    // /T takes down the whole tree: claude plus any shells or tools it spawned.
    execFile('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  close() {
    this.waiting = null; // a turn still waiting to go never goes
    if (!this.proc) return;
    const proc = this.proc;
    try { proc.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { if (this.proc === proc) this.kill(); }, 3000);
  }
}

module.exports = { ClaudeSession, DENY_MESSAGE, EFFORTS };
