const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toItems, parseLine, describeTool } = require('../src/main/stream');

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
