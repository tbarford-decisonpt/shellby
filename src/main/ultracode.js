// Ultracode runs: Claude Code's Workflow tool, many agents in the background
// (docs/ULTRACODE.md). Not Shellby's own workflows (workflows/), which are a
// different thing with a similar name.
//
// What Claude Code 2.1.299 sends for one, all as task_* events with
// task_type 'local_workflow':
//   task_started { task_id, tool_use_id, description: meta.description, workflow_name: meta.name }
//   task_progress { usage: { total_tokens, tool_uses }, workflow_progress: [phases and agents] }
//   task_notification { status: completed | failed | stopped, summary }
// and the Workflow tool's result names its run id (wf_…). The agents inside a
// run are no tasks of their own: they're only in workflow_progress, with their
// tokens as one number (no input/output split, no price). So a run's cost is
// "at least" what those tokens cost as cache reads, unless Claude Code reports
// real usage for it (assistant events under the Workflow call), which counts.
// Stop is stop_task, as Claude Code's own TaskStop does.
// Pure functions: no Electron, no I/O — see test/ultracode.test.js.
const words = require('../renderer/shared/ultracode');

// Agents of one run that walk out as helper crabs at once; the rest are "+N more".
const MAX_VISIBLE_CRABS = 3;
// Helper crabs of finished agents kept (so they walk home), across all runs.
const MAX_ENDED_CRABS = 20;
// Agent rows a card lists; the rest are counted.
const MAX_SHOWN_AGENTS = 8;
const MAX_RUNS = 20;
const TEXT = 300;
// How often a running card is sent to the panel at most, and saved to History.
const LIVE_MS = 1000;
const SAVE_MS = 15000;

const CREW_KEY = '~wf~';
const text = (v, n = TEXT) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

function create() {
  return { byId: new Map(), launches: new Map() };
}

/** A task_* item that is an ultracode run. Only task_started says task_type. */
function isRun(item, state = null) {
  if (item?.kind !== 'task' || !item.taskId) return false;
  if (typeof item.taskType === 'string') return item.taskType === 'local_workflow';
  return !!state?.byId.has(item.taskId);
}

const endedAs = status => (status === 'completed' ? 'completed' : status === 'failed' || status === 'error' ? 'failed' : 'stopped');

/** Fold a task item in. -> the run it changed, or null. */
function track(state, item, now) {
  if (!state || !isRun(item, state)) return null;
  let run = state.byId.get(item.taskId);
  if (!run) {
    run = {
      id: item.taskId, toolUseId: item.toolUseId || null, runId: null, name: '', description: '',
      status: 'running', startedAt: now, endedAt: null, phases: [], agents: [],
      tokens: 0, toolUses: 0, summary: '', priced: 0, pricedSeen: false, metered: 0,
      savedAt: 0, sentAt: 0,
    };
    state.byId.set(item.taskId, run);
    const launch = state.launches.get(item.taskId);
    if (launch) applyLaunch(run, launch);
    prune(state);
  }
  if (item.workflowName) run.name = item.workflowName;
  // Claude Code's placeholder when the script's meta has no description.
  if (item.description && item.phase === 'started' && item.description !== 'Dynamic workflow') run.description = text(item.description);
  if (item.usage) {
    run.tokens = Math.max(run.tokens, item.usage.tokens || 0);
    run.toolUses = Math.max(run.toolUses, item.usage.toolUses || 0);
  }
  if (item.workflow) {
    if (item.workflow.phases.length) run.phases = item.workflow.phases;
    // A snapshot of every agent so far: it replaces what was known.
    if (item.workflow.agents.length) run.agents = item.workflow.agents;
  }
  if (item.summary) run.summary = text(item.summary, 2000);
  const ending = item.phase === 'done' || (item.phase === 'updated' && item.status && !['running', 'pending'].includes(item.status));
  if (ending && run.status === 'running') {
    run.status = endedAs(item.status);
    run.endedAt = now;
  }
  return run;
}

function applyLaunch(run, launch) {
  if (launch.runId) run.runId = launch.runId;
  if (launch.name && !run.name) run.name = launch.name;
  if (launch.error) run.error = launch.error;
}

/** The Workflow tool's result: its run id, whichever of it and task_started came first. */
function noteLaunch(state, launch) {
  if (!state || !launch?.taskId) return null;
  const run = state.byId.get(launch.taskId);
  if (run) { applyLaunch(run, launch); return run; }
  state.launches.set(launch.taskId, launch);
  if (state.launches.size > MAX_RUNS) state.launches.delete(state.launches.keys().next().value);
  return null;
}

/** Real usage Claude Code reported under a run's Workflow call. -> the run, or null. */
function noteSpend(state, parent, weight) {
  if (!state || !parent || !(weight > 0)) return null;
  for (const run of state.byId.values()) {
    if (run.toolUseId !== parent) continue;
    run.priced += weight;
    run.pricedSeen = true;
    return run;
  }
  return null;
}

function prune(state) {
  const done = [...state.byId.values()].filter(r => r.status !== 'running').sort((a, b) => a.endedAt - b.endedAt);
  for (const r of done.slice(0, Math.max(0, state.byId.size - MAX_RUNS))) state.byId.delete(r.id);
}

const tokensOf = (run, model) => {
  const each = run.agents.filter(a => a.tokens > 0);
  return each.length ? each.map(a => [a.tokens, a.model || model]) : run.tokens > 0 ? [[run.tokens, model]] : [];
};

/** What the run has cost so far: { usd, exact, tokens }. Never exact: agents report no price. */
function costOf(run, model) {
  const parts = tokensOf(run, model);
  const floor = parts.reduce((s, [t, m]) => s + words.floorUsd(t, m), 0);
  const priced = run.priced * words.USD_PER_WEIGHT;
  return { usd: Math.max(floor, priced), exact: false, tokens: Math.max(run.tokens, parts.reduce((s, [t]) => s + t, 0)) };
}

/**
 * Spend for the usage meters that Claude Code didn't report itself: the run's
 * agent tokens, weighted as input. None once real usage for the run arrives
 * (that's counted where it lands). -> the weight to add now.
 */
function meterDelta(run, model) {
  if (!run || run.pricedSeen) return 0;
  const total = tokensOf(run, model).reduce((s, [t, m]) => s + words.weightOfTokens(t, m), 0);
  const delta = total - run.metered;
  if (delta <= 0) return 0;
  run.metered = total;
  return delta;
}

const running = run => run.agents.filter(a => a.state === 'start' || a.state === 'progress');

function counts(agents) {
  let live = 0, done = 0, failed = 0;
  for (const a of agents) {
    if (a.state === 'done') done++;
    else if (a.state === 'error') failed++;
    else live++;
  }
  return { running: live, done, failed, total: agents.length };
}

/** What the card shows. */
function view(run, model) {
  const live = running(run);
  const order = [...live, ...run.agents.filter(a => !live.includes(a)).reverse()];
  const cost = costOf(run, model);
  const crabs = crabsOf(run);
  return {
    id: run.id, runId: run.runId, name: run.name || 'Ultracode run', description: run.description,
    status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
    phases: run.phases.map(p => ({ ...p, ...counts(run.agents.filter(a => a.phase === p.index)) })),
    counts: counts(run.agents),
    agents: order.slice(0, MAX_SHOWN_AGENTS).map(a => ({ index: a.index, label: a.label, state: a.state, type: a.type, tokens: a.tokens, error: a.error || null })),
    moreAgents: Math.max(0, order.length - MAX_SHOWN_AGENTS),
    crabsOut: crabs.visible.length, crabsMore: crabs.hidden,
    tokens: cost.tokens, toolUses: run.toolUses,
    cost: { usd: cost.usd, exact: cost.exact }, costText: words.costText(cost),
    summary: run.summary, error: run.error || null,
  };
}

/** The run's agents out as helper crabs: the first few running, and how many more. */
function crabsOf(run) {
  const live = running(run).sort((a, b) => a.index - b.index);
  const visible = run.status === 'running' ? live.slice(0, MAX_VISIBLE_CRABS) : [];
  return { visible, hidden: run.status === 'running' ? live.length - visible.length : 0 };
}

const crewKey = (run, index) => `${run.id}${CREW_KEY}${index}`;
const isCrewKey = key => typeof key === 'string' && key.includes(CREW_KEY);

/**
 * Keep a session's helper map (session/crew.js `tasks`) in step with a run:
 * its visible agents running, the ones that finished walking home, at most
 * MAX_ENDED_CRABS of those kept. -> true when anything changed.
 */
function syncCrew(tasks, run, now) {
  let changed = false;
  const { visible } = crabsOf(run);
  const want = new Set(visible.map(a => crewKey(run, a.index)));
  for (const a of visible) {
    const key = crewKey(run, a.index);
    const prev = tasks.get(key);
    if (prev?.status === 'running' && prev.activity === a.label) continue;
    tasks.set(key, { taskId: key, toolUseId: null, status: 'running', startedAt: prev?.startedAt || now, description: a.label, activity: a.label, subagentType: a.type || 'general-purpose', workflow: run.id });
    changed = true;
  }
  const byIndex = new Map(run.agents.map(a => [crewKey(run, a.index), a]));
  for (const [key, t] of tasks) {
    if (t.workflow !== run.id || want.has(key) || t.status !== 'running') continue;
    const a = byIndex.get(key);
    tasks.set(key, { ...t, status: a?.state === 'done' ? 'completed' : 'failed', endedAt: now });
    changed = true;
  }
  const ended = [...tasks.values()].filter(t => isCrewKey(t.taskId) && t.status !== 'running').sort((a, b) => a.endedAt - b.endedAt);
  for (const t of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_CRABS))) { tasks.delete(t.taskId); changed = true; }
  return changed;
}

/** Agents of running runs that aren't out as crabs: the desktop's "+N more". */
function hiddenCrabs(state) {
  let n = 0;
  for (const run of state?.byId.values() || []) n += crabsOf(run).hidden;
  return n;
}

/** The process ended: no run can carry on. -> the runs it stopped. */
function stopAll(state, now) {
  const stopped = [];
  for (const run of state?.byId.values() || []) {
    if (run.status !== 'running') continue;
    run.status = 'stopped';
    run.endedAt = now;
    stopped.push(run);
  }
  return stopped;
}

/**
 * Whether a change to a running run goes to the panel now, and to History:
 * { send, save }. The start and the end always go, and are always saved.
 */
function due(run, now, { started = false } = {}) {
  const final = run.status !== 'running';
  const send = started || final || now - run.sentAt >= LIVE_MS;
  const save = started || final || now - run.savedAt >= SAVE_MS;
  if (send) run.sentAt = now;
  if (save) run.savedAt = now;
  return { send, save };
}

module.exports = {
  create, isRun, track, noteLaunch, noteSpend, costOf, meterDelta, view, crabsOf, syncCrew, hiddenCrabs, stopAll, due, isCrewKey,
  MAX_VISIBLE_CRABS, MAX_ENDED_CRABS, MAX_SHOWN_AGENTS, LIVE_MS, SAVE_MS,
};
