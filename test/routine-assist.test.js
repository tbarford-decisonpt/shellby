const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RoutineAssist, DENY_PLAN, DENY_ANY, DRY_RUN_TOOLS, DRY_RUN_MAX_MS, dryRunFence } = require('../src/main/routine-assist');

const routine = { name: 'Morning briefing', prompt: 'List what changed.', schedule: { type: 'daily', time: '08:30' }, mode: 'plan', folder: '' };
const answer = structured => ({ stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }), stderr: '', timedOut: false });

function make(over = {}) {
  const calls = { claude: [], panel: [], denied: [], interrupted: [], stopped: [], opened: [], timers: [] };
  const replies = [...(over.replies || [])];
  const assist = new RoutineAssist({
    runClaude: async (args, timeout, opts) => { calls.claude.push({ args, timeout, input: opts.input }); return replies.shift() || answer(null); },
    context: () => ({ home: 'C:\\Users\\me', defaultFolder: 'C:\\code', places: [], today: 'today' }),
    folderOk: () => true,
    routines: () => over.routines || [],
    allowAutonomous: () => !!over.autonomous,
    signedIn: () => over.signedIn !== false,
    lastRun: id => (over.runs || {})[id] || null,
    loadTranscript: id => (over.transcripts || {})[id] || [],
    openTest: t => { if (over.openFails) throw new Error('no room'); calls.opened.push(t); return `tab${calls.opened.length}`; },
    deny: (tabId, requestId, message) => calls.denied.push({ tabId, requestId, message }),
    interrupt: id => calls.interrupted.push(id),
    stopSession: id => calls.stopped.push(id),
    toPanel: (channel, payload) => calls.panel.push({ channel, payload }),
    timer: (fn, ms) => { const t = { fn, ms, cancelled: false, cancel: () => { t.cancelled = true; } }; calls.timers.push(t); return t; },
    log: { warn: () => {} },
  });
  return { assist, calls };
}

test('draft sends the description on stdin to the quick model and returns the editor fields', async () => {
  const { assist, calls } = make({ replies: [answer({ ...routine, needs_workflow: false, why: '' })] });
  const res = await assist.draft('  every morning, what changed  ');
  assert.equal(res.ok, true);
  assert.equal(res.draft.name, 'Morning briefing');
  assert.match(calls.claude[0].input, /«every morning, what changed»/);
  assert.equal(calls.claude[0].args[calls.claude[0].args.indexOf('--model') + 1], 'haiku');
  assert.equal((await assist.draft('')).ok, false);
  assert.equal(calls.claude.length, 1);
});

test('one call at a time', async () => {
  let release;
  const { assist } = make();
  assist.d.runClaude = () => new Promise(r => { release = r; });
  const first = assist.draft('a');
  assert.match((await assist.draft('b')).error, /already working/);
  release(answer({ ...routine, needs_workflow: false, why: '' }));
  assert.equal((await first).ok, true);
  assert.equal(assist.busy, false);
});

test('a timeout or an empty answer is explained', async () => {
  const { assist } = make({ replies: [{ stdout: '', timedOut: true }, { stdout: '  ', stderr: 'boom' }] });
  assert.match((await assist.draft('a')).error, /too long/);
  assert.match((await assist.draft('a')).error, /signed in/);
});

test('repair reads the last run and keeps the routine\'s own mode', async () => {
  const saved = { id: 'r1', ...routine, mode: 'autonomous', cwd: null };
  const { assist, calls } = make({
    routines: [saved],
    runs: { r1: [{ kind: 'user', text: 'List what changed.' }, { kind: 'result', ok: false, error: 'No such folder' }] },
    replies: [answer({ routine: { ...routine, mode: 'unchanged' }, note: 'Pointed it at Documents.' })],
  });
  const res = await assist.repair('r1');
  assert.equal(res.ok, true);
  assert.equal(res.draft.mode, 'autonomous');
  assert.equal(res.note, 'Pointed it at Documents.');
  assert.match(calls.claude[0].input, /Ended: failed: No such folder/);
  assert.equal(calls.claude[0].args[calls.claude[0].args.indexOf('--model') + 1], 'sonnet');
});

test('repair without the routine or its run says so, without calling Claude', async () => {
  const { assist, calls } = make({ routines: [{ id: 'r1', ...routine }] });
  assert.match((await assist.repair('gone')).error, /gone/);
  assert.match((await assist.repair('r1')).error, /no longer has/);
  assert.equal(calls.claude.length, 0);
});

test('chat only trusts an Autonomous mode the user may have chosen', async () => {
  const reply = answer({ reply: 'Kept it.', routine: { ...routine, mode: 'unchanged' }, test: false, needs_workflow: false, why: '' });
  const off = make({ replies: [reply] });
  assert.equal((await off.assist.chat({ routine: { ...routine, mode: 'autonomous' }, messages: [{ role: 'user', text: 'hi' }] })).routine.mode, 'smart');
  const on = make({ replies: [reply], autonomous: true });
  assert.equal((await on.assist.chat({ routine: { ...routine, mode: 'autonomous' }, messages: [{ role: 'user', text: 'hi' }] })).routine.mode, 'autonomous');
});

test('chat asks once more when the routine it got back does not fit', async () => {
  const bad = answer({ reply: 'Moved it.', routine: { ...routine, schedule: { type: 'daily', time: '25:00' } }, test: true, needs_workflow: false, why: '' });
  const fixed = answer({ reply: 'Moved it to 23:00.', routine: { ...routine, schedule: { type: 'daily', time: '23:00' } }, test: true, needs_workflow: false, why: '' });
  const { assist, calls } = make({ replies: [bad, fixed] });
  const res = await assist.chat({ routine, messages: [{ role: 'user', text: 'later' }] });
  assert.equal(calls.claude.length, 2);
  assert.match(calls.claude[1].input, /had problems: Time must be/);
  assert.equal(res.routine.schedule.time, '23:00');
  assert.equal(res.test, true);
  assert.equal(res.problem, undefined);
});

test('chat reads a finished dry run of its own, and only that', async () => {
  const reply = () => answer({ reply: 'Looks right.', routine, test: false, needs_workflow: false, why: '' });
  const { assist, calls } = make({ replies: [reply(), reply(), reply()], transcripts: { tab1: [{ kind: 'text', text: 'I would list 3 files' }], other: [{ kind: 'text', text: 'secret' }] } });
  const { runId } = assist.test({ ...routine, cwd: null });
  await assist.chat({ routine, messages: [{ role: 'user', text: 'x' }], runId });
  assert.doesNotMatch(calls.claude[0].input, /dry run that just finished/); // still running
  assist.onResult(runId, { kind: 'result', ok: true });
  await assist.chat({ routine, messages: [{ role: 'user', text: 'x' }], runId });
  assert.match(calls.claude[1].input, /I would list 3 files/);
  await assist.chat({ routine, messages: [{ role: 'user', text: 'x' }], runId: 'other' });
  assert.doesNotMatch(calls.claude[2].input, /secret/);
});

test('a dry run opens in Plan mode whatever the editor says, one at a time', () => {
  const { assist, calls } = make();
  const res = assist.test({ ...routine, mode: 'autonomous', cwd: 'C:\\code' });
  assert.deepEqual(res, { ok: true, runId: 'tab1' });
  assert.deepEqual(calls.opened[0], { cwd: 'C:\\code', prompt: 'List what changed.', title: '⟳ Dry run: Morning briefing' });
  assert.deepEqual(calls.panel[0], { channel: 'routines:test-changed', payload: { id: 'tab1', status: 'running' } });
  assert.match(assist.test(routine).error, /already going/);
  assert.equal(assist.getTest('tab1').status, 'running');
});

test('a dry run that can\'t start says why', () => {
  assert.match(make({ signedIn: false }).assist.test(routine).error, /not signed in/);
  assert.match(make().assist.test({ ...routine, prompt: '' }).error, /Prompt/);
  assert.match(make({ openFails: true }).assist.test(routine).error, /didn't start: no room/);
  const noFolder = make();
  noFolder.assist.d.folderOk = () => false;
  assert.match(noFolder.assist.test({ ...routine, cwd: 'C:\\nope' }).error, /doesn't exist/);
  assert.equal(make().assist.test(null).ok, false);
});

test('a dry run refuses every permission, and the plan with its own words', () => {
  const { assist, calls } = make();
  const { runId } = assist.test(routine);
  assert.equal(assist.onPermission(runId, { requestId: 'q1', toolName: 'Write' }), true);
  assert.equal(assist.onPermission(runId, { requestId: 'q2', toolName: 'ExitPlanMode' }), true);
  assert.deepEqual(calls.denied.map(d => d.message), [DENY_ANY, DENY_PLAN]);
  assert.equal(assist.onPermission('someone-else', { requestId: 'q3', toolName: 'Write' }), false);
  assist.onResult(runId, { kind: 'result', ok: true });
  assert.equal(assist.onPermission(runId, { requestId: 'q4', toolName: 'Write' }), false); // finished: the tab is yours again
});

test('a dry run ending tells the panel once and frees the process', () => {
  const { assist, calls } = make();
  const { runId } = assist.test(routine);
  assert.equal(assist.onResult(runId, { kind: 'result', ok: false, error: 'boom' }), true);
  // You replied in its tab afterwards: an ordinary turn, with its notification and XP.
  assert.equal(assist.onResult(runId, { kind: 'result', ok: true }), false);
  assert.deepEqual(calls.panel.at(-1), { channel: 'routines:test-changed', payload: { id: runId, status: 'error', error: 'boom' } });
  assert.equal(calls.panel.length, 2);
  assert.deepEqual(calls.stopped, [runId]);
  assert.equal(calls.timers[0].cancelled, true);
  assert.equal(assist.onResult('not-ours', { ok: true }), false);
});

test('Stop ends a dry run at once, even if Claude Code never answers the interrupt', () => {
  const { assist, calls } = make();
  const { runId } = assist.test(routine);
  assert.equal(assist.stopTest('nope'), false);
  assert.equal(assist.stopTest(runId), true);
  assert.deepEqual(calls.interrupted, [runId]);
  assert.equal(assist.getTest(runId).status, 'stopped');
  assert.equal(assist.onResult(runId, { kind: 'result', interrupted: true }), false); // the interrupt's own result, later
  assert.equal(assist.stopTest(runId), false);
  assert.equal(assist.getTest('nope'), null);
  assert.ok(assist.test(routine).ok, 'the next one can start');
});

test('a dry run whose Claude Code dies ends as failed, and frees the next one', () => {
  const { assist, calls } = make();
  const { runId } = assist.test(routine);
  assist.onError(runId, { kind: 'error', text: 'Claude Code exited (code 1).' });
  assert.deepEqual(assist.getTest(runId), { id: runId, status: 'error', error: 'Claude Code exited (code 1).' });
  assert.equal(calls.panel.at(-1).payload.status, 'error');
  assist.onError('not-ours', { text: 'x' });
  assert.ok(assist.test(routine).ok);
});

test('a dry run whose tab closed, however it closed, counts as stopped', () => {
  const { assist } = make();
  const { runId } = assist.test(routine);
  assist.sweep(() => true);
  assert.equal(assist.getTest(runId).status, 'running');
  assist.sweep(id => id !== runId);
  assert.equal(assist.getTest(runId).status, 'stopped');
});

test('a dry run has a time limit', () => {
  const { assist, calls } = make();
  const { runId } = assist.test(routine);
  assert.equal(calls.timers[0].ms, DRY_RUN_MAX_MS);
  calls.timers[0].fn();
  assert.deepEqual(calls.interrupted, [runId]);
  assert.equal(assist.getTest(runId).status, 'stopped');
  assert.match(assist.getTest(runId).error, /20 minutes/);
});

test('the dry-run fence refuses file, shell and outside tools', () => {
  const re = new RegExp(`^(${DRY_RUN_TOOLS})$`);
  for (const tool of ['Edit', 'Write', 'Bash', 'PowerShell', 'NotebookEdit', 'mcp__slack__send_message']) assert.ok(re.test(tool), tool);
  for (const tool of ['Read', 'Grep', 'Glob', 'ExitPlanMode']) assert.ok(!re.test(tool), tool);
  assert.equal(dryRunFence({ tool_name: 'Bash' }).hookSpecificOutput.permissionDecision, 'deny');
});

test('only the last few finished dry runs are remembered', () => {
  const { assist } = make();
  for (let i = 0; i < 15; i++) {
    const { runId } = assist.test(routine);
    assist.onResult(runId, { kind: 'result', ok: true });
  }
  assert.ok(assist.tests.size <= 10);
  assert.equal(assist.getTest('tab1'), null);
  assert.ok(assist.getTest('tab15'));
});

