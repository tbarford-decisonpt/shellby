// One conversation = one long-lived `claude -p` process speaking stream-json on
// stdin/stdout. Permission prompts, interrupts and mode switches go over the same
// control protocol the Claude Agent SDK uses, so no API key is ever involved.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { parseLine } = require('./stream');
const { subscriptionEnv } = require('./claude-cli');
const { CLI_MODE } = require('./config');
const { annotatePermission } = require('./safety');
const { lineOf, MAX_TEXT } = require('../renderer/shared/diff');

const DENY_MESSAGE = 'The user declined this action in Shellby. Ask them how they would like to proceed.';
const REQUEST_TIMEOUT_MS = 20000;
const LOCATE_MAX_BYTES = 2 * 1024 * 1024;

// Where an Edit lands in its file, so the diff can show real line numbers and
// "open in editor" can go straight there; and for a Write over a file that's
// already there, what it's replacing, so that's a diff too rather than a wall
// of green. Read before the edit runs: the CLI reports a tool call before it
// executes it.
function placeEdit(item) {
  const first = item.edits?.[0];
  if (!item.filePath || !first) return;
  let text;
  try {
    if (fs.statSync(item.filePath).size > LOCATE_MAX_BYTES) return;
    text = fs.readFileSync(item.filePath, 'utf8').replace(/\r\n/g, '\n');
  } catch { return; } // a new file: nothing to compare with
  if (item.name === 'Write' || item.toolName === 'Write') {
    item.edits = [{ old: text.slice(0, MAX_TEXT), new: first.new }];
    item.line = 1;
  } else if (first.old) {
    item.line = lineOf(text, first.old.replace(/\r\n/g, '\n'));
  }
}

class ClaudeSession extends EventEmitter {
  // argsPrefix lets tests run a fake CLI script: exe=node, argsPrefix=[script].
  // extraEnv: () => {} of variables to add when the process starts (GitHub access).
  constructor({ exe, cwd, mode, model, resumeId = null, argsPrefix = [], extraEnv = () => ({}) }) {
    super();
    Object.assign(this, { exe, cwd, mode, model, resumeId, argsPrefix, extraEnv });
    this.proc = null;
    this.busy = false;
    this.sessionId = resumeId;
    this.pending = new Map(); // requestId -> permission item
    this.interrupting = false;
    this.createdFiles = new Set(); // paths Claude wrote/edited this conversation
    this.tasks = new Map();        // subagent task_id -> { status, description, ... }
    this.requests = new Map();     // our control request_id -> { resolve, reject, timer }
  }

  buildArgs() {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio',
      // Echo each message we send back with its id: the checkpoint "Rewind files" restores to.
      '--replay-user-messages',
      '--permission-mode', CLI_MODE[this.mode] || 'default',
      // Lets the user switch into Autonomous mid-conversation; it has no effect
      // unless that mode is actually selected.
      '--allow-dangerously-skip-permissions',
    ];
    if (this.model) args.push('--model', this.model);
    if (this.sessionId) args.push('--resume', this.sessionId);
    return args;
  }

  start() {
    if (this.proc) return;
    const proc = spawn(this.exe, [...this.argsPrefix, ...this.buildArgs()], {
      // File checkpoints are on in the terminal but off for SDK hosts unless asked for.
      cwd: this.cwd, env: { ...subscriptionEnv(), ...this.extraEnv(), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    let stderr = '';

    readline.createInterface({ input: proc.stdout }).on('line', line => {
      const { event, items } = parseLine(line);
      if (event?.type === 'control_response') this.settle(event.response);
      if (event?.type === 'control_request' && event.request?.subtype !== 'can_use_tool') {
        // Unknown host callbacks (hooks, MCP bridging): answer so the CLI never hangs.
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'Not supported by Shellby' } });
      }
      for (const item of items) this.handle(item);
    });
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    proc.stdin.on('error', () => { /* process gone; 'close' reports it */ });

    proc.on('error', err => {
      this.emit('item', { kind: 'error', text: `Couldn't start Claude Code: ${err.message}` });
    });
    proc.on('close', code => {
      const wasBusy = this.busy;
      this.proc = null;
      this.cancelPending();
      for (const id of [...this.requests.keys()]) this.settle({ subtype: 'error', request_id: id, error: 'Claude Code stopped before answering.' });
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
        break;
      case 'tool':
        if (item.filePath) this.createdFiles.add(item.filePath);
        if (item.edits?.length) placeEdit(item);
        break;
      case 'task':
        this.trackTask(item);
        break;
      case 'permission':
        Object.assign(item, annotatePermission(item, { createdFiles: this.createdFiles, tasks: this.tasks }));
        if (item.edits?.length) placeEdit(item);
        this.pending.set(item.requestId, item);
        break;
      case 'result':
        if (item.sessionId) this.sessionId = item.sessionId;
        if (this.interrupting) { item.interrupted = true; item.ok = false; item.error = null; }
        this.interrupting = false;
        // Background subagents can outlive the turn, so pending prompts stay open;
        // only interrupt/exit cancel them. Clear busy before emitting so listeners
        // reacting to the result can send a follow-up.
        this.setBusy(false);
        this.emit('item', item);
        return;
    }
    this.emit('item', item);
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
    this.emit('busy', b);
  }

  write(obj) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  send(text) {
    if (this.busy) throw new Error('Shellby is still working on the last task.');
    this.start();
    this.setBusy(true);
    this.write({ type: 'user', message: { role: 'user', content: text } });
  }

  // decision: 'allow' | 'always' | 'deny'. answers: AskUserQuestion's
  // { [question text]: chosen label(s) or the user's own words }.
  respond(requestId, decision, message, answers) {
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
    this.emit('item', { kind: 'decision', requestId, decision, toolName: item.toolName });
    return true;
  }

  cancelPending() {
    for (const id of this.pending.keys()) this.emit('item', { kind: 'decision', requestId: id, decision: 'cancelled' });
    this.pending.clear();
  }

  interrupt() {
    if (!this.proc || !this.busy) return;
    this.interrupting = true;
    for (const id of [...this.pending.keys()]) this.respond(id, 'deny', 'Interrupted by the user.');
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    // If the CLI doesn't wind down promptly, kill it; the session can be resumed.
    const proc = this.proc;
    setTimeout(() => { if (this.proc === proc && this.busy) this.kill(); }, 8000);
  }

  // A control request that expects an answer: resolves with the CLI's response
  // payload, rejects with its error (or when it never answers).
  request(subtype, fields = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    this.start();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle({ subtype: 'error', request_id: requestId, error: 'Claude Code took too long to answer.' }), timeoutMs);
      this.requests.set(requestId, { resolve, reject, timer });
      this.write({ type: 'control_request', request_id: requestId, request: { subtype, ...fields } });
    });
  }

  settle(response) {
    const r = this.requests.get(response?.request_id);
    if (!r) return;
    this.requests.delete(response.request_id);
    clearTimeout(r.timer);
    if (response.subtype === 'success') r.resolve(response.response || {});
    else r.reject(new Error(response.error || 'Claude Code refused that.'));
  }

  /**
   * Put files back the way they were before the user message `uuid` (Claude
   * Code's own file checkpoints). dryRun says what would change without
   * touching anything. Never while a turn runs: Claude would be editing the
   * same files underneath it.
   *   -> { canRewind, error?, filesChanged?, insertions?, deletions? }
   */
  async rewind(uuid, { dryRun = false } = {}) {
    if (this.busy) throw new Error('Wait until Shellby has finished, or stop him first.');
    const r = await this.request('rewind_files', { user_message_id: uuid, ...(dryRun ? { dry_run: true } : {}) });
    return {
      canRewind: !!r.canRewind,
      error: typeof r.error === 'string' ? r.error : null,
      filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged.filter(f => typeof f === 'string') : [],
      insertions: Number.isFinite(r.insertions) ? r.insertions : 0,
      deletions: Number.isFinite(r.deletions) ? r.deletions : 0,
    };
  }

  setMode(mode) {
    this.mode = mode;
    if (this.proc) {
      this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode: CLI_MODE[mode] } });
    }
  }

  kill() {
    if (!this.proc) return;
    // /T takes down the whole tree: claude plus any shells or tools it spawned.
    execFile('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  close() {
    if (!this.proc) return;
    const proc = this.proc;
    try { proc.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { if (this.proc === proc) this.kill(); }, 3000);
  }
}

module.exports = { ClaudeSession, DENY_MESSAGE, placeEdit };
