const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toItems, parseLine, describeTool, writeChars } = require('../src/main/stream');

test('init event yields the session id; hook chatter is dropped', () => {
  assert.deepEqual(toItems({ type: 'system', subtype: 'hook_started' }), []);
  const [init] = toItems({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', cwd: 'C:\\x' });
  assert.equal(init.kind, 'init');
  assert.equal(init.sessionId, 's1');
});

test('assistant content becomes text, thinking and tool items', () => {
  const items = toItems({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'thinking', thinking: '...' },
    { type: 'text', text: '  Hello  ' },
    { type: 'tool_use', id: 't1', name: 'PowerShell', input: { command: 'Get-ChildItem' } },
    { type: 'text', text: '   ' },
  ] } });
  assert.deepEqual(items.map(i => i.kind), ['thinking', 'text', 'tool']);
  assert.equal(items[1].text, 'Hello');
  assert.equal(items[2].label, 'Ran');
  assert.equal(items[2].detail, 'Get-ChildItem');
});

test('subagent messages are flagged', () => {
  const [item] = toItems({ type: 'assistant', parent_tool_use_id: 'task1', message: { content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(item.sub, true);
});

test('tool results are matched by id, flagged on error, and truncated', () => {
  const [r] = toItems({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'x'.repeat(9000) }] },
  ] } });
  assert.equal(r.id, 't1');
  assert.equal(r.isError, true);
  assert.ok(r.text.length < 8100);
  assert.match(r.text, /more characters/);
});

test('a backgrounded shell command is flagged: its result is only "started"', () => {
  const [bg] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } });
  assert.equal(bg.background, true);
  const [fg] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } });
  assert.equal(fg.background, undefined);
});

test('a truncated tool result keeps its tail too (test runners print failures last); a short one has none', () => {
  const long = 'head\n' + 'x'.repeat(20000) + '\nFAILED tests/test_auth.py::test_login';
  const [r] = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: long }] } });
  assert.ok(r.text.startsWith('head'));
  assert.ok(r.tail.endsWith('FAILED tests/test_auth.py::test_login'));
  assert.ok(r.tail.length <= 8000);
  const [s] = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } });
  assert.equal(s.tail, undefined);
});

test('plain user text echoes (e.g. interrupt notices) produce nothing', () => {
  assert.deepEqual(toItems({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), []);
  assert.deepEqual(toItems({ type: 'user', message: { content: 'string content' } }), []);
});

test('result events: success and an interrupted run without result text', () => {
  const [ok] = toItems({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3, result: 'Done', session_id: 's1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.turns, 3);
  const [bad] = toItems({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], session_id: 's1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, null);
  assert.equal(bad.tokens, null);
  assert.equal(bad.costUsd, null);
});

test('a result carries the turn\'s token counts and cost for the per-turn ledger', () => {
  const [r] = toItems({ type: 'result', is_error: false, total_cost_usd: 0.42,
    usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } });
  assert.deepEqual(r.tokens, { input: 10, output: 200, cacheRead: 5000, cacheWrite: 300 });
  assert.equal(r.costUsd, 0.42);
});

test('rate limit events become usage percentages', () => {
  const [u] = toItems({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.14, resetsAt: 1790810400 }, seven_day: { utilization: 0.61, resetsAt: 1790809200 } } } });
  assert.equal(u.fiveHour.pct, 14);
  assert.equal(u.sevenDay.pct, 61);
  assert.equal(u.fiveHour.resetsAt, 1790810400000);
  assert.equal(toItems({ type: 'rate_limit_event' })[0].fiveHour, null);
});

test('can_use_tool control requests become permission items', () => {
  const [p] = toItems({ type: 'control_request', request_id: 'r1', request: {
    subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'C:\\a.txt', content: '' },
    description: 'a.txt', tool_use_id: 'tu', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
  assert.equal(p.kind, 'permission');
  assert.equal(p.requestId, 'r1');
  assert.equal(p.label, 'Created');
  assert.equal(p.detail, 'C:\\a.txt');
  assert.equal(p.suggestions.length, 1);
  assert.deepEqual(toItems({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }), []);
});

test('ExitPlanMode carries the plan text', () => {
  const [p] = toItems({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '1. do it' } } });
  assert.equal(p.plan, '1. do it');
});

test('describeTool handles MCP tools, grep and empty input', () => {
  assert.deepEqual(describeTool('mcp__github__create_issue', { title: 'x' }), { label: 'create_issue (github)', detail: '{"title":"x"}' });
  assert.equal(describeTool('Grep', { pattern: 'TODO', path: 'src' }).detail, 'TODO in src');
  assert.equal(describeTool('Weird', {}).detail, '');
  assert.equal(describeTool('Bash', { command: 'a\n  b' }).detail, 'a b');
});

test('parseLine tolerates blank and non-JSON lines', () => {
  assert.deepEqual(parseLine('   ').items, []);
  const { event, items } = parseLine('not json');
  assert.equal(event, null);
  assert.equal(items[0].kind, 'log');
  assert.equal(parseLine('{"type":"result","is_error":false}').items[0].kind, 'result');
});

test('write tools carry the path and how much they write', () => {
  const [item] = toItems({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.js', content: 'hello' } }] },
  });
  assert.equal(item.filePath, 'a.js');
  assert.equal(item.writeChars, 5);
  // Non-write tools carry neither.
  const [read] = toItems({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.js' } }] },
  });
  assert.equal(read.filePath, undefined);
  assert.equal(read.writeChars, undefined);
});

test('writeChars reads each write tool, and MultiEdit sums its edits', () => {
  assert.equal(writeChars('Write', { content: 'abc' }), 3);
  assert.equal(writeChars('Edit', { new_string: 'abcd' }), 4);
  assert.equal(writeChars('NotebookEdit', { new_source: 'ab' }), 2);
  assert.equal(writeChars('MultiEdit', { edits: [{ new_string: 'ab' }, { new_string: 'cde' }] }), 5);
  assert.equal(writeChars('MultiEdit', { edits: 'nonsense' }), 0);
  assert.equal(writeChars('Write', { content: 42 }), 0);
  assert.equal(writeChars('Read', { file_path: 'a' }), 0);
  assert.equal(writeChars('Write', null), 0);
});

test('the crab\'s own tools read as what they did', () => {
  const { describeTool } = require('../src/main/stream');
  assert.deepEqual(describeTool('mcp__shellby__say', { text: 'all  green' }), { label: 'Shellby said', detail: 'all green' });
  assert.deepEqual(describeTool('mcp__shellby__suggest', { feature: 'routine', why: 'x' }), { label: 'Suggested', detail: 'routine' });
  assert.deepEqual(describeTool('mcp__shellby__status', {}), { label: 'Checked on Shellby', detail: '' });
  // The plugin's copy, or anyone else's server, keeps the generic label.
  assert.equal(describeTool('mcp__plugin_shellby_shellby__say', { text: 'hi' }).label, 'say (plugin_shellby_shellby)');
});

// ---- mods: what a mod's $.ui.* calls and registered commands become

const { KNOWN } = require('../src/main/stream');
const UUIDS = { uuid: 'u-1', session_id: 's-1' };

test('mod ui_log becomes a modlog line named for its plugin', () => {
  const items = toItems({ type: 'system', subtype: 'ui_log', plugin: 'shellby-probe', text: 'probe: session.start surface=null', ...UUIDS });
  assert.deepEqual(items, [{ kind: 'modlog', plugin: 'shellby-probe', text: 'probe: session.start surface=null' }]);
});

test('mod ui_toast becomes a modtoast, its time kept inside 1.5 to 15 seconds', () => {
  const toast = ms => toItems({ type: 'system', subtype: 'ui_toast', plugin: 'shellby-probe', text: 'probe toast', timeout_ms: ms, ...UUIDS })[0];
  assert.deepEqual(toast(4000), { kind: 'modtoast', plugin: 'shellby-probe', text: 'probe toast', ms: 4000 });
  assert.equal(toast(10).ms, 1500);
  assert.equal(toast(10 * 60 * 1000).ms, 15000);
  assert.equal(toast(undefined).ms, 4000);
  assert.equal(toast('soon').ms, 4000);
});

test('mod ui_status becomes a modstatus, and empty text clears it', () => {
  const status = text => toItems({ type: 'system', subtype: 'ui_status', plugin: 'shellby-probe', text, ...UUIDS });
  assert.deepEqual(status('probe status'), [{ kind: 'modstatus', plugin: 'shellby-probe', text: 'probe status' }]);
  assert.deepEqual(status(''), [{ kind: 'modstatus', plugin: 'shellby-probe', text: null }]);
  assert.deepEqual(status('   '), [{ kind: 'modstatus', plugin: 'shellby-probe', text: null }]);
  assert.deepEqual(status(undefined), [{ kind: 'modstatus', plugin: 'shellby-probe', text: null }]);
});

test('mod ui events without a plugin name, or a log or toast without text, show nothing', () => {
  for (const subtype of ['ui_log', 'ui_toast', 'ui_status']) {
    assert.deepEqual(toItems({ type: 'system', subtype, text: 'who said this' }), [], `${subtype} with no plugin`);
    assert.deepEqual(toItems({ type: 'system', subtype, plugin: '  ', text: 'x' }), [], `${subtype} with a blank plugin`);
  }
  assert.deepEqual(toItems({ type: 'system', subtype: 'ui_log', plugin: 'p', text: '' }), []);
  assert.deepEqual(toItems({ type: 'system', subtype: 'ui_toast', plugin: 'p' }), []);
});

test('mod text is one clean line: control and bidi characters are stripped, and it is capped', () => {
  const bidi = String.fromCharCode(0x202e);
  const zeroWidth = String.fromCharCode(0x200b);
  const bell = String.fromCharCode(7);
  const [log] = toItems({ type: 'system', subtype: 'ui_log', plugin: `p${bidi}q`, text: `a${bell}b\nc${zeroWidth}d${bidi}e` });
  assert.equal(log.plugin, 'p q');
  assert.equal(log.text, 'a b c d e');
  const [long] = toItems({ type: 'system', subtype: 'ui_log', plugin: 'p', text: 'x'.repeat(2000) });
  assert.equal(long.text.length, 500);
});

test('commands_changed becomes one commands item with each name and description', () => {
  const items = toItems({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'probe', description: 'Says hello from the probe mod.', argumentHint: '' }], ...UUIDS });
  assert.deepEqual(items, [{ kind: 'commands', commands: [{ name: 'probe', description: 'Says hello from the probe mod.' }] }]);
});

test('commands_changed drops entries with no usable name and tolerates a missing list', () => {
  const items = toItems({ type: 'system', subtype: 'commands_changed', commands: [null, {}, { name: '' }, { name: 5 }, { name: 'x'.repeat(200) }, { name: 'ok' }] });
  assert.deepEqual(items, [{ kind: 'commands', commands: [{ name: 'ok', description: '' }] }]);
  assert.deepEqual(toItems({ type: 'system', subtype: 'commands_changed' }), [{ kind: 'commands', commands: [] }]);
});

test('the stream knows the four mod system subtypes', () => {
  for (const s of ['ui_log', 'ui_toast', 'ui_status', 'commands_changed']) assert.ok(KNOWN.system.has(s), s);
});

// ---- what Claude Code does by itself (shapes recorded from 2.1.293)

test('to-do calls carry what they do to the list, and TaskCreate results the new id', () => {
  const [create] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'TaskCreate', input: { subject: 'Alpha', description: 'Alpha', activeForm: 'Doing alpha' } }] } });
  assert.deepEqual(create.todo, { op: 'create', subject: 'Alpha', activeForm: 'Doing alpha' });
  assert.equal(create.label, 'Added a to-do');
  assert.equal(create.detail, 'Alpha');
  const [made] = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Task #1 created successfully: Alpha' }] }, tool_use_result: { task: { id: '1', subject: 'Alpha' } } });
  assert.equal(made.todoId, '1');
  const [update] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } });
  assert.deepEqual(update.todo, { op: 'update', id: '1', status: 'completed' });
  assert.equal(update.detail, '#1 done');
  const [write] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'TodoWrite', input: { todos: [{ content: 'X', status: 'in_progress', activeForm: 'Xing' }, { content: '' }] } }] } });
  assert.deepEqual(write.todo, { op: 'set', items: [{ subject: 'X', status: 'in_progress', activeForm: 'Xing' }] });
  assert.equal(write.detail, '2 to-dos', 'the row says how many, not a blob of JSON');
});

test('a backgrounded command is a task_started with task_type, and its result names its output file', () => {
  const [t] = toItems({ type: 'system', subtype: 'task_started', task_id: 'bnyot46nq', tool_use_id: 'tu', description: 'Run sleep', is_backgrounded: true, task_type: 'local_bash' });
  assert.deepEqual([t.kind, t.taskType, t.background], ['task', 'local_bash', true]);
  const [r] = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'Command running in background with ID: bnyot46nq. Output is being written to: /tmp/claude/p/s/tasks/bnyot46nq.output. You will be notified when it completes.' }] } });
  assert.equal(r.outputFile, '/tmp/claude/p/s/tasks/bnyot46nq.output');
  const [plain] = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'Output is being written to: /evil.output.' }] } });
  assert.equal(plain.outputFile, undefined, 'only the CLI\'s own sentence, from its start');
});

test('a skill, a message between agents, and an agent\'s name are kept on their tool items', () => {
  const [skill] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'code-review:code-review' } }] } });
  assert.equal(skill.skill, 'code-review:code-review');
  const [msg] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'm', name: 'SendMessage', input: { to: 'scout', message: 'Now reply DONE.', summary: 'Ask scout to reply DONE', type: 'message' } }] } });
  assert.deepEqual(msg.message, { to: 'scout', text: 'Now reply DONE.', summary: 'Ask scout to reply DONE' });
  assert.equal(msg.detail, 'scout: Now reply DONE.');
  const [agent] = toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Scout', name: 'scout', run_in_background: true } }] } });
  assert.equal(agent.agent.name, 'scout');
});

test('a result says how much of the turn was thinking', () => {
  const [r] = toItems({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 4, output_tokens: 641, output_tokens_details: { thinking_tokens: 54 } } });
  assert.equal(r.thinkingTokens, 54);
  assert.equal(toItems({ type: 'result', subtype: 'success', usage: {} })[0].thinkingTokens, null);
});

test('background_tasks_changed is a known event, read past on purpose', () => {
  const { KNOWN } = require('../src/main/stream');
  assert.ok(KNOWN.system.has('background_tasks_changed'));
  assert.deepEqual(toItems({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }), []);
});
