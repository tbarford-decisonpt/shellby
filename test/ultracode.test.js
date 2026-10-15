// Ultracode: the keyword the box adds, an ultracode run folded from Claude
// Code's task events (src/main/ultracode.js), its cost, and its helper crabs.
// The event shapes are 2.1.299's (docs/ULTRACODE.md); stream.test.js parses them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/main/ultracode');
const words = require('../src/renderer/shared/ultracode');
const { parseLine } = require('../src/main/stream');

const agent = (index, state, extra = {}) => ({ index, label: `Agent ${index}`, phase: index <= 2 ? 0 : 1, state, type: null, model: null, tokens: null, tools: null, ...extra });
const started = { kind: 'task', phase: 'started', taskId: 'w1', toolUseId: 'tu_wf', taskType: 'local_workflow', workflowName: 'audit', description: 'Audit the repo' };
const progress = (agents, extra = {}) => ({ kind: 'task', phase: 'progress', taskId: 'w1', toolUseId: 'tu_wf', usage: { tokens: 1000, toolUses: 3 }, workflow: { phases: [{ index: 0, title: 'Scout' }, { index: 1, title: 'Fix' }], agents }, ...extra });

test('the keyword goes on the end of the message once, on a line of its own', () => {
  assert.equal(words.withKeyword('Fix the parser'), 'Fix the parser\n\nultracode');
  assert.equal(words.withKeyword('Fix the parser  \n'), 'Fix the parser\n\nultracode');
  assert.equal(words.withKeyword('ultracode: fix the parser'), 'ultracode: fix the parser', 'typed already: left alone');
  assert.equal(words.withKeyword('Fix it, UltraCode please'), 'Fix it, UltraCode please');
  assert.equal(words.withKeyword(''), '', 'nothing to send stays nothing');
});

test('the keyword is a word, not part of a path, a flag or another word', () => {
  assert.equal(words.hasKeyword('run ultracode on this'), true);
  assert.equal(words.hasKeyword('see docs/ultracode.md'), false);
  assert.equal(words.hasKeyword('--ultracode'), false);
  assert.equal(words.hasKeyword('ultracoder'), false);
  assert.equal(words.hasKeyword(null), false);
});

test('only a local_workflow task is a run; later events are known by the task id', () => {
  const s = U.create();
  assert.equal(U.isRun({ kind: 'task', taskId: 'a1', taskType: 'local_agent' }, s), false);
  assert.equal(U.isRun({ kind: 'task', taskId: 'b1', taskType: 'local_bash' }, s), false);
  assert.equal(U.isRun(started, s), true);
  assert.equal(U.isRun({ kind: 'task', phase: 'progress', taskId: 'w1' }, s), false, 'not before it started');
  U.track(s, started, 1000);
  assert.equal(U.isRun({ kind: 'task', phase: 'progress', taskId: 'w1' }, s), true);
});

test('a run takes its name, phases and agents from the events, and ends as Claude Code says', () => {
  const s = U.create();
  U.track(s, started, 1000);
  U.noteLaunch(s, { taskId: 'w1', runId: 'wf_abc', name: 'audit' });
  U.track(s, progress([agent(1, 'progress'), agent(2, 'done'), agent(3, 'error', { error: 'boom' })]), 2000);
  let v = U.view(s.byId.get('w1'), 'claude-sonnet-5-5');
  assert.equal(v.name, 'audit');
  assert.equal(v.runId, 'wf_abc');
  assert.equal(v.description, 'Audit the repo');
  assert.deepEqual(v.counts, { running: 1, done: 1, failed: 1, total: 3 });
  assert.deepEqual(v.phases.map(p => [p.title, p.done, p.total]), [['Scout', 1, 2], ['Fix', 0, 1]]);
  assert.equal(v.agents[0].label, 'Agent 1', 'running agents first');
  U.track(s, { kind: 'task', phase: 'done', taskId: 'w1', status: 'completed', summary: 'All fixed.' }, 5000);
  v = U.view(s.byId.get('w1'), '');
  assert.deepEqual([v.status, v.endedAt, v.summary], ['completed', 5000, 'All fixed.']);
  U.track(s, { kind: 'task', phase: 'done', taskId: 'w1', status: 'failed' }, 6000);
  assert.equal(s.byId.get('w1').status, 'completed', 'it ends once');
});

test('the run id can arrive before task_started', () => {
  const s = U.create();
  assert.equal(U.noteLaunch(s, { taskId: 'w1', runId: 'wf_early', name: 'audit' }), null);
  U.track(s, { ...started, workflowName: undefined, description: 'Dynamic workflow' }, 1);
  const v = U.view(s.byId.get('w1'), '');
  assert.deepEqual([v.runId, v.name, v.description], ['wf_early', 'audit', ''], "Claude Code's placeholder isn't a description");
});

test('a stopped or killed run is stopped; the process going stops every running one', () => {
  const s = U.create();
  U.track(s, started, 1);
  U.track(s, { kind: 'task', phase: 'done', taskId: 'w1', status: 'stopped' }, 2);
  assert.equal(s.byId.get('w1').status, 'stopped');
  U.track(s, { ...started, taskId: 'w2' }, 3);
  assert.deepEqual(U.stopAll(s, 9).map(r => [r.id, r.status, r.endedAt]), [['w2', 'stopped', 9]]);
  assert.deepEqual(U.stopAll(s, 10), []);
});

test("cost: at least what the agents' tokens cost as cache reads, or the real usage when that's more", () => {
  const s = U.create();
  U.track(s, started, 1);
  const run = U.track(s, progress([agent(1, 'done', { tokens: 1000000 }), agent(2, 'progress', { tokens: 1000000, model: 'claude-haiku-4-5' })]), 2);
  // Sonnet's 3 and Haiku's 1, a tenth each, per million tokens.
  let c = U.costOf(run, 'claude-sonnet-5-5');
  assert.equal(c.exact, false);
  assert.ok(Math.abs(c.usd - 0.4) < 1e-9, `${c.usd}`);
  assert.equal(c.tokens, 2000000);
  assert.equal(U.view(run, 'claude-sonnet-5-5').costText, 'at least $0.40');
  // Real usage under the Workflow call (weight 2,000,000 = $2) counts once it's more.
  assert.equal(U.noteSpend(s, 'tu_other', 5), null);
  assert.equal(U.noteSpend(s, 'tu_wf', 2000000), run);
  c = U.costOf(run, 'claude-sonnet-5-5');
  assert.ok(Math.abs(c.usd - 2) < 1e-9);
  assert.equal(U.view(run, '').costText, 'at least $2.00');
});

test('cost falls back on the run total when agents report no tokens; nothing reported says so', () => {
  const s = U.create();
  const run = U.track(s, started, 1);
  assert.equal(U.view(run, '').costText, 'no cost reported yet');
  U.track(s, { kind: 'task', phase: 'progress', taskId: 'w1', usage: { tokens: 500000, toolUses: 1 } }, 2);
  assert.ok(Math.abs(U.costOf(run, 'claude-opus-5').usd - 0.25) < 1e-9);
});

test('the usage meters get the run tokens once, as they grow, and none once real usage arrives', () => {
  const s = U.create();
  U.track(s, started, 1);
  const run = U.track(s, progress([agent(1, 'progress', { tokens: 1000 })]), 2);
  assert.equal(U.meterDelta(run, 'claude-sonnet-5-5'), 3000);
  assert.equal(U.meterDelta(run, 'claude-sonnet-5-5'), 0, 'not twice');
  U.track(s, progress([agent(1, 'progress', { tokens: 1500 })]), 3);
  assert.equal(U.meterDelta(run, 'claude-sonnet-5-5'), 1500);
  U.noteSpend(s, 'tu_wf', 10);
  U.track(s, progress([agent(1, 'progress', { tokens: 9000 })]), 4);
  assert.equal(U.meterDelta(run, 'claude-sonnet-5-5'), 0, 'counted where it lands instead');
});

test('a few agents walk out as crabs and the rest are "+N more"; finished ones walk home', () => {
  const s = U.create();
  const tasks = new Map();
  U.track(s, started, 1);
  const many = Array.from({ length: 12 }, (_, i) => agent(i + 1, 'progress'));
  const run = U.track(s, progress(many), 2);
  assert.equal(U.syncCrew(tasks, run, 2), true);
  const out = [...tasks.values()].filter(t => t.status === 'running');
  assert.equal(out.length, U.MAX_VISIBLE_CRABS);
  assert.equal(U.hiddenCrabs(s), 12 - U.MAX_VISIBLE_CRABS);
  assert.deepEqual(out.map(t => t.description), ['Agent 1', 'Agent 2', 'Agent 3']);
  assert.ok(out.every(t => t.workflow === 'w1' && t.subagentType === 'general-purpose' && U.isCrewKey(t.taskId)));
  assert.equal(U.syncCrew(tasks, run, 3), false, 'nothing new: no change');
  // Agent 1 finishes, agent 2 fails: they go home and the next one walks out.
  U.track(s, progress([agent(1, 'done'), agent(2, 'error'), ...many.slice(2)]), 4);
  U.syncCrew(tasks, run, 4);
  const byLabel = Object.fromEntries([...tasks.values()].map(t => [t.description, t.status]));
  assert.equal(byLabel['Agent 1'], 'completed');
  assert.equal(byLabel['Agent 2'], 'failed');
  assert.deepEqual([...tasks.values()].filter(t => t.status === 'running').map(t => t.description), ['Agent 3', 'Agent 4', 'Agent 5']);
  assert.equal(U.view(run, '').crabsMore, 7);
  // The run ends: every crab goes home, none are hidden.
  U.track(s, { kind: 'task', phase: 'done', taskId: 'w1', status: 'stopped' }, 5);
  U.syncCrew(tasks, run, 5);
  assert.equal([...tasks.values()].filter(t => t.status === 'running').length, 0);
  assert.equal(U.hiddenCrabs(s), 0);
});

test('finished crabs are kept to MAX_ENDED_CRABS, oldest gone first, and other helpers are left alone', () => {
  const s = U.create();
  const tasks = new Map([['helper-1', { taskId: 'helper-1', status: 'completed', endedAt: 0 }]]);
  U.track(s, started, 1);
  const total = U.MAX_ENDED_CRABS + 10;
  for (let n = 1; n <= total; n++) {
    const agents = Array.from({ length: n }, (_, i) => agent(i + 1, i + 1 < n ? 'done' : 'progress'));
    U.syncCrew(tasks, U.track(s, progress(agents), n), n);
  }
  const ended = [...tasks.values()].filter(t => U.isCrewKey(t.taskId) && t.status !== 'running');
  assert.equal(ended.length, U.MAX_ENDED_CRABS);
  assert.ok(!ended.some(t => t.description === 'Agent 1'), 'the oldest went');
  assert.ok(tasks.has('helper-1'));
});

test('a running card goes to the panel at most every LIVE_MS and to History every SAVE_MS; its start and end always', () => {
  const s = U.create();
  const run = U.track(s, started, 0);
  assert.deepEqual(U.due(run, 0, { started: true }), { send: true, save: true });
  assert.deepEqual(U.due(run, 10), { send: false, save: false });
  assert.deepEqual(U.due(run, U.LIVE_MS), { send: true, save: false });
  assert.deepEqual(U.due(run, U.SAVE_MS), { send: true, save: true });
  U.track(s, { kind: 'task', phase: 'done', taskId: 'w1', status: 'completed' }, U.SAVE_MS + 1);
  assert.deepEqual(U.due(run, U.SAVE_MS + 1), { send: true, save: true });
});

test('the card lists a few agents and counts the rest', () => {
  const s = U.create();
  U.track(s, started, 1);
  const run = U.track(s, progress(Array.from({ length: 20 }, (_, i) => agent(i + 1, 'done'))), 2);
  const v = U.view(run, '');
  assert.equal(v.agents.length, U.MAX_SHOWN_AGENTS);
  assert.equal(v.moreAgents, 20 - U.MAX_SHOWN_AGENTS);
  assert.equal(v.agents[0].label, 'Agent 20', 'the latest finished first');
});

test('the expectation before the first run is a range, dearer on dearer models', () => {
  const sonnet = words.expect('claude-sonnet-5-5');
  const opus = words.expect('claude-opus-5');
  assert.ok(sonnet.low > 0 && sonnet.high > sonnet.low);
  assert.ok(opus.high > sonnet.high);
  assert.match(words.money(sonnet.low), /^\$\d/);
  assert.equal(words.money(0.004), '<$0.01');
  assert.equal(words.money(42.4), '$42');
});

test('from the stream: a run start, its progress and its end become one run', () => {
  const s = U.create();
  const line = o => parseLine(JSON.stringify(o)).items;
  const items = [
    ...line({ type: 'system', subtype: 'task_started', task_id: 'w9', tool_use_id: 'tu9', description: 'Audit', task_type: 'local_workflow', workflow_name: 'audit' }),
    ...line({ type: 'system', subtype: 'task_progress', task_id: 'w9', tool_use_id: 'tu9', description: 'Scout: part 1', usage: { total_tokens: 5000, tool_uses: 2, duration_ms: 10 },
      workflow_progress: [{ type: 'workflow_phase', index: 0, title: 'Scout' }, { type: 'workflow_agent', index: 1, label: 'part 1', phaseIndex: 0, phaseTitle: 'Scout', state: 'progress', tokens: 5000 }] }),
    ...line({ type: 'system', subtype: 'task_notification', task_id: 'w9', tool_use_id: 'tu9', status: 'completed', output_file: '', summary: 'Done' }),
  ];
  for (const i of items) U.track(s, i, 1);
  const v = U.view(s.byId.get('w9'), '');
  assert.deepEqual([v.name, v.status, v.counts.total, v.tokens, v.summary], ['audit', 'completed', 1, 5000, 'Done']);
});
