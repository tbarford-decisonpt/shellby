// What a conversation has running in the background: commands Claude sent off
// with run_in_background, and Monitor watches. Claude Code reports both as
// task_* events with task_type 'local_bash' (helpers are 'local_agent'), so they
// arrive the same way as helpers but aren't crabs: they're the tray above the
// box and the badge on the crab. Checked against Claude Code 2.1.293:
//   tool_use Bash { run_in_background } / Monitor { command, description }
//   task_started { task_id, tool_use_id, description, task_type: 'local_bash' }
//   tool_result "Command running in background with ID: … Output is being written to: <file>."
//   task_updated { patch: { status } } then task_notification { status, summary, output_file }
// Pure functions: no Electron, no I/O — see test/jobs.test.js.
const path = require('path');

const KEEP_FINISHED_MS = 2 * 60 * 1000; // a finished one stays in the tray this long
const MAX_FINISHED = 20;
const MAX_TOOLS = 100;
const MAX_SHOWN = 12;
const TEXT = 300;

const text = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, TEXT) : '');

/** { byId: task id -> job, tools: tool use id -> { name, command, outputFile } } */
function create() {
  return { byId: new Map(), tools: new Map() };
}

/**
 * A task_* item that is a background command or watch rather than a helper.
 * Only task_started says task_type: later events are known by their task id.
 */
function isJob(item, state = null) {
  if (item?.kind !== 'task') return false;
  if (typeof item.taskType === 'string') return item.taskType !== 'local_agent';
  return !!(item.taskId && state?.byId.has(item.taskId));
}

/** A tool call that may become a job: remembered, so its job knows what it ran. */
function noteTool(state, item) {
  if (!state || item?.kind !== 'tool' || !item.id) return;
  if (item.name !== 'Monitor' && !item.background) return;
  state.tools.set(item.id, { name: item.name, command: text(item.detail) });
  if (state.tools.size > MAX_TOOLS) state.tools.delete(state.tools.keys().next().value);
}

/** The tool's result names the file its output goes to. */
function noteResult(state, item) {
  const t = item?.id && state?.tools.get(item.id);
  if (!t || !item.outputFile) return;
  t.outputFile = item.outputFile;
  for (const job of state.byId.values()) if (job.toolUseId === item.id && !job.outputFile) job.outputFile = item.outputFile;
}

// How a job ended, from its status and (for a command) the exit code its summary gives.
function endedAs(status, summary) {
  if (status === 'killed' || status === 'stopped') return 'stopped';
  if (status === 'failed' || status === 'error') return 'failed';
  const code = /exit code (-?\d+)/i.exec(summary || '');
  return code && Number(code[1]) !== 0 ? 'failed' : 'done';
}

/** Fold a task item in. Returns true when the tray should redraw. */
function track(state, item, now) {
  if (!state || !isJob(item, state) || !item.taskId) return false;
  let job = state.byId.get(item.taskId);
  if (!job) {
    const tool = state.tools.get(item.toolUseId) || {};
    job = {
      id: item.taskId, toolUseId: item.toolUseId || null,
      kind: tool.name === 'Monitor' ? 'monitor' : 'command',
      description: text(item.description) || tool.command || 'a background command',
      command: tool.command || '',
      outputFile: tool.outputFile || item.outputFile || null,
      status: 'running', startedAt: now, endedAt: null, summary: '',
    };
    state.byId.set(item.taskId, job);
  }
  if (item.outputFile) job.outputFile = item.outputFile;
  // A finished command's exit code is only in task_notification's summary, which follows
  // task_updated at once: so 'completed' waits for it, and a kill or a failure doesn't.
  const ending = item.phase === 'done' || (item.phase === 'updated' && item.status && !['running', 'completed'].includes(item.status));
  if (item.summary) job.summary = text(item.summary);
  if (ending && job.status === 'running') {
    job.status = endedAs(item.status, item.summary);
    job.endedAt = now;
    prune(state);
    return true;
  }
  // A late summary still changes what the tray says.
  return item.phase === 'started' || !!item.summary;
}

// Finished jobs past the limit go, oldest first.
function prune(state) {
  const done = [...state.byId.values()].filter(j => j.status !== 'running').sort((a, b) => a.endedAt - b.endedAt);
  for (const j of done.slice(0, Math.max(0, done.length - MAX_FINISHED))) state.byId.delete(j.id);
}

const running = state => [...(state?.byId.values() || [])].filter(j => j.status === 'running');

/** The process ended: nothing it had running can finish. True when something stopped. */
function stopAll(state, now) {
  let any = false;
  for (const j of running(state)) { j.status = 'stopped'; j.endedAt = now; any = true; }
  return any;
}

/**
 * What the panel shows: running ones first (oldest first, the way they started),
 * then the ones that finished in the last two minutes, newest first.
 */
function view(state, now) {
  const all = [...(state?.byId.values() || [])];
  const live = all.filter(j => j.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
  const recent = all.filter(j => j.status !== 'running' && now - j.endedAt < KEEP_FINISHED_MS).sort((a, b) => b.endedAt - a.endedAt);
  return [...live, ...recent].slice(0, MAX_SHOWN).map(j => ({
    id: j.id, kind: j.kind, description: j.description, command: j.command,
    status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, summary: j.summary, hasOutput: !!j.outputFile,
  }));
}

/**
 * Whether a file named as a job's output is one Shellby may read: Claude Code
 * writes them as <task id>.output under its folder in the temp directory.
 * `tmp` is the real temp folder (compared without regard to case on Windows).
 */
function outputPathOk(file, tmp) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.output$/i.test(file) || !tmp) return false;
  const norm = p => path.resolve(p).toLowerCase();
  const root = norm(tmp) + path.sep;
  return norm(file).startsWith(root) && !norm(file).slice(root.length).split(path.sep).includes('..');
}

module.exports = { create, isJob, noteTool, noteResult, track, running, stopAll, view, outputPathOk, endedAs, KEEP_FINISHED_MS };
