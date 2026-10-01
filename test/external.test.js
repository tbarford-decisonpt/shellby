const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ExternalSessions, applyHookEvent, expire, summarize, acceptable, markerPath } = require('../src/main/external');
const { subscriptionEnv } = require('../src/main/claude-cli');

const ev = (hook_event_name, extra = {}) => ({ hook_event_name, session_id: 'abc-123', cwd: 'C:\\Users\\you\\code\\3d-rack', ...extra });

function play(events, start = 0) {
  let sessions = new Map();
  const effects = [];
  events.forEach((e, i) => {
    const r = applyHookEvent(sessions, e, start + i * 1000);
    sessions = r.sessions;
    effects.push(...r.effects);
  });
  return { sessions, effects, s: sessions.get('abc-123') };
}

test('a turn: prompt -> tools -> stop celebrates once', () => {
  const { s, effects } = play([ev('SessionStart'), ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), ev('PostToolUse', { tool_name: 'Bash' }), ev('Stop')]);
  assert.equal(s.state, 'idle');
  assert.equal(s.project, '3d-rack');
  assert.deepEqual(effects, [{ type: 'turn-done', project: '3d-rack', tools: 1 }]);
  assert.equal(JSON.stringify(s).includes('npm test'), false, 'tool inputs are never kept');
});

test('mid-turn the session is working with the current tool', () => {
  const { s } = play([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Edit' })]);
  assert.equal(s.state, 'working');
  assert.equal(s.tool, 'Edit');
});

test('permission notification raises a claw; the next tool result clears it', () => {
  let r = play([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash' }), ev('Notification', { message: 'Claude needs your permission to use Bash' })]);
  assert.equal(r.s.state, 'asking');
  assert.deepEqual(r.effects, [{ type: 'asking', project: '3d-rack', message: 'Claude needs your permission to use Bash' }]);
  r = applyHookEvent(r.sessions, ev('PostToolUse', { tool_name: 'Bash' }), 9000);
  assert.equal(r.sessions.get('abc-123').state, 'working');
});

test('"waiting for your input" is idle, not asking', () => {
  const { s } = play([ev('Stop'), ev('Notification', { message: 'Claude is waiting for your input' })]);
  assert.equal(s.state, 'idle');
});

test('subagents become helper crabs and go home', () => {
  const r = play([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Agent' }), ev('PreToolUse', { tool_name: 'Task' }), ev('SubagentStop')]);
  assert.equal(r.s.helpers, 1);
  const sum = summarize(r.sessions);
  assert.equal(sum.crew.length, 1);
  assert.deepEqual(sum.crew[0], { id: 'ext-abc-123-0', tabId: null, label: '3d-rack', type: 'Claude Code' });
});

test('a stop without work (e.g. /clear) does not celebrate; SessionEnd forgets', () => {
  const r = play([ev('SessionStart'), ev('Stop'), ev('SessionEnd')]);
  assert.deepEqual(r.effects, []);
  assert.equal(r.sessions.size, 0);
});

test('junk events change nothing', () => {
  for (const bad of [null, {}, { hook_event_name: 'Stop' }, { hook_event_name: 'Stop', session_id: '../../etc' }, { hook_event_name: 'Mystery', session_id: 'x' }]) {
    const r = applyHookEvent(new Map(), bad, 0);
    assert.equal(r.sessions.size, 0);
    assert.deepEqual(r.effects, []);
  }
});

test('names are clipped to one short line', () => {
  const { s } = play([ev('PreToolUse', { cwd: 'C:\\x\\' + 'a'.repeat(200), tool_name: 'Bash\nrm -rf' })]);
  assert.equal(s.project.length, 60);
  assert.equal(s.tool, 'Bash rm -rf');
});

test('quiet sessions go idle after 15 min and are forgotten after 2 h', () => {
  const { sessions } = play([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash' })]);
  assert.equal(expire(sessions, 16 * 60 * 1000).get('abc-123').state, 'idle');
  assert.equal(expire(sessions, 3 * 60 * 60 * 1000).size, 0);
});

test('summary rolls up several sessions: asking beats working', () => {
  let m = new Map();
  m = applyHookEvent(m, { hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: 'C:\\p\\one' }, 1).sessions;
  m = applyHookEvent(m, { hook_event_name: 'Notification', session_id: 'b', cwd: 'C:\\p\\two', message: 'needs your permission' }, 2).sessions;
  const sum = summarize(m);
  assert.equal(sum.state, 'asking');
  assert.equal(sum.busy, 2);
  assert.deepEqual(sum.sessions.map(x => x.project), ['two', 'one']);
});

test('a flood of fake session ids stays bounded (oldest evicted)', () => {
  let m = new Map();
  for (let i = 0; i < 1000; i++) m = applyHookEvent(m, { hook_event_name: 'UserPromptSubmit', session_id: `s${i}`, cwd: 'C:\\x' }, i).sessions;
  assert.equal(m.size, 64);
  assert.ok(m.has('s999') && !m.has('s0'));
});

test('a busy port: status busy, no leaked timers across retries', async () => {
  const holder = new ExternalSessions({ port: 0 });
  holder.start();
  await new Promise(r => holder.once('status', r));
  const x = new ExternalSessions({ port: holder.port });
  for (let i = 0; i < 3; i++) {
    x.start();
    await new Promise(r => x.once('status', r));
    assert.equal(x.status, 'busy');
    assert.equal(x.timer, null, 'no timer after a failed listen');
  }
  x.stop();
  holder.stop();
});

test("Shellby's own Claude processes are marked so the plugin ignores them", () => {
  assert.equal(subscriptionEnv({ PATH: 'x' }).SHELLBY_OWNED, '1');
});

// ------------------------------------------------------------------ the listener

test('acceptable(): only our hook requests, never a browser', () => {
  const req = (h, extra = {}) => ({ method: 'POST', url: '/v1/hook', headers: { 'x-shellby': '1', 'content-type': 'application/json', ...h }, ...extra });
  assert.equal(acceptable(req({})), true);
  assert.equal(acceptable(req({ origin: 'https://evil.example' })), false);
  assert.equal(acceptable(req({ 'x-shellby': undefined })), false);
  assert.equal(acceptable(req({ 'content-type': 'text/plain' })), false);
  assert.equal(acceptable(req({}, { method: 'GET' })), false);
  assert.equal(acceptable(req({}, { url: '/v1/hook?x=1' })), false);
});

test('listener: real HTTP round trip, refusals, owned sessions, size cap', async () => {
  const x = new ExternalSessions({ port: 0 });
  x.start();
  await new Promise(r => x.once('status', r));
  const port = x.server.address().port;
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/v1/hook`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'X-Shellby': '1', 'Content-Type': 'application/json', ...headers },
  });
  try {
    let res = await post(ev('UserPromptSubmit'));
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '', 'empty body: nothing for Claude Code to read as hook output');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(x.summary.state, 'working');

    res = await post(ev('Stop'), { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    res = await fetch(`http://127.0.0.1:${port}/v1/hook`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 403);
    assert.equal(x.summary.state, 'working', 'refused requests change nothing');

    res = await post({ ...ev('Stop'), session_id: 'owned' }, { 'X-Shellby-Owned': '1' });
    assert.equal(res.status, 204);
    assert.equal(x.summary.sessions.length, 1, "Shellby's own sessions are not tracked");

    res = await post('x'.repeat(2 * 1024 * 1024 + 10)).catch(() => ({ status: 413 }));
    assert.equal(res.status, 413);

    const done = new Promise(r => x.once('turn-done', r));
    await post(ev('Stop'));
    assert.equal((await done).project, '3d-rack');
    assert.ok(fs.existsSync(markerPath(port)), 'listening marker present');
  } finally {
    x.stop();
  }
  assert.equal(fs.existsSync(markerPath(port)), false, 'marker removed on stop');
});
