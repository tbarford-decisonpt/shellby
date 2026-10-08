const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ExternalSessions, applyHookEvent, expire, summarize, acceptable, markerPath, programOf } = require('../src/main/external');
const { claudeEnv } = require('../src/main/claude-cli');

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
  assert.deepEqual(effects, [{ type: 'turn-done', project: '3d-rack', tools: 1, ms: 3000, cwd: 'C:\\Users\\you\\code\\3d-rack', sessionId: 'abc-123', folder: 'C:\\Users\\you\\code\\3d-rack' }]);
  assert.equal(s.turnAt, null, 'the clock is cleared for the next turn');
  assert.equal(JSON.stringify(s).includes('npm test'), false, 'tool inputs are never kept');
});

test('a session ending says where it was, for its handoff note, and never passes on transcript_path', () => {
  const { effects, sessions } = play([ev('SessionStart'), ev('SessionEnd', { transcript_path: 'C:\\Windows\\win.ini' })]);
  assert.equal(sessions.has('abc-123'), false);
  assert.deepEqual(effects, [{ type: 'session-end', sessionId: 'abc-123', cwd: 'C:\\Users\\you\\code\\3d-rack' }]);
});

test('a session ending in a folder that is not on a local drive gives no note to write', () => {
  const { effects } = play([ev('SessionStart', { cwd: '\\\\host\\share\\x' }), ev('SessionEnd', { cwd: '\\\\host\\share\\x' })]);
  assert.deepEqual(effects, []);
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
  assert.deepEqual(r.effects.map(e => e.type), ['session-end'], 'no turn-done: only the handoff note is asked for');
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

test('successful shell commands report their meaning (tests/ship/deploy), never the text', () => {
  const r = play([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    ev('PostToolUse', { tool_name: 'PowerShell', tool_input: { command: 'vercel --prod' } }), ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls -la' } })]);
  assert.deepEqual(r.effects, [{ type: 'command-ok', kind: 'tests', project: '3d-rack' }, { type: 'command-ok', kind: 'deploy', project: '3d-rack', cwd: ev('x').cwd, ship: { kind: 'deploy', version: null } }]);
  assert.equal(JSON.stringify([...r.sessions.values()]).includes('npm test'), false);
  // A failing command only ever gets PreToolUse (checked against the real CLI), so it earns nothing.
  assert.deepEqual(play([ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } })]).effects, []);
});

test('failing tests outside Shellby mark the project red (PostToolUseFailure), by meaning only', () => {
  const r = play([ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'ls nope' } })]);
  assert.deepEqual(r.effects, [{ type: 'command-fail', kind: 'tests', project: '3d-rack' }]);
  assert.equal(JSON.stringify(r.effects).includes('npm test'), false);
});

test('a push or release outside Shellby says where, and which version, for its sticker', () => {
  const r = play([ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh release create v1.0.0' } })]);
  assert.deepEqual(r.effects, [
    { type: 'command-ok', kind: 'ship', project: '3d-rack', cwd: ev('x').cwd, ship: { kind: 'ship', version: null } },
    { type: 'command-ok', kind: 'deploy', project: '3d-rack', cwd: ev('x').cwd, ship: { kind: 'release', version: '1.0.0' } },
  ]);
  const draft = play([ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh release create v2.0.0 --draft' } })]);
  assert.deepEqual(draft.effects, [{ type: 'command-ok', kind: 'deploy', project: '3d-rack' }], 'a draft release ships nothing');
});

test('a flood of fake session ids stays bounded (oldest evicted)', () => {
  let m = new Map();
  for (let i = 0; i < 1000; i++) m = applyHookEvent(m, { hook_event_name: 'UserPromptSubmit', session_id: `s${i}`, cwd: 'C:\\x' }, i).sessions;
  assert.equal(m.size, 64);
  assert.ok(m.has('s999') && !m.has('s0'));
});

test("a copy that can't get the port never removes the listening Shellby's marker", async () => {
  const holder = new ExternalSessions({ port: 0 });
  holder.start();
  await new Promise(r => holder.once('status', r));
  assert.ok(fs.existsSync(markerPath(holder.port)));
  const other = new ExternalSessions({ port: holder.port });
  other.start();
  await new Promise(r => other.once('status', r));
  other.stop();
  assert.ok(fs.existsSync(markerPath(holder.port)), 'still there after the failed copy started and stopped');
  holder.stop();
  assert.equal(fs.existsSync(markerPath(holder.port)), false, 'its owner removes it on quit');
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
  assert.equal(claudeEnv({ PATH: 'x' }).SHELLBY_OWNED, '1');
});

// ------------------------------------------------------------------ the listener

test('acceptable(): only our hook requests, never a browser', () => {
  const req = (h, extra = {}) => ({ method: 'POST', url: '/v1/hook', headers: { host: '127.0.0.1:47913', 'x-shellby': '1', 'content-type': 'application/json', ...h }, ...extra });
  assert.equal(acceptable(req({})), true);
  assert.equal(acceptable(req({ host: 'localhost:47913' })), true);
  // DNS rebinding: the page's own name arrives as Host.
  assert.equal(acceptable(req({ host: 'evil.example:47913' })), false);
  assert.equal(acceptable(req({ host: undefined })), false);
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

// ---- background commands: the ones that outlive the turn that started them

const bgRun = (command, extra = {}) => ev('PreToolUse', { tool_name: 'Bash', tool_input: { command, run_in_background: true }, ...extra });

test('a backgrounded command outlives the Stop that ends the turn', () => {
  const { s } = play([ev('UserPromptSubmit'), bgRun('node scripts/serve.js'), ev('Stop')]);
  assert.equal(s.state, 'idle', 'the turn really did end');
  assert.deepEqual(s.bg.map(b => b.program), ['node'], 'but the server is still out there');
});

test('a foreground command leaves nothing behind', () => {
  const { s } = play([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), ev('Stop')]);
  assert.deepEqual(s.bg, []);
});

test('the program is kept, the command never is', () => {
  const { s } = play([bgRun('cd /c/secrets && node server.js --token=hunter2 --path /c/Users/me')]);
  assert.deepEqual(s.bg.map(b => b.program), ['node'], 'cd is stepped over to the real program');
  const json = JSON.stringify(s);
  assert.equal(json.includes('hunter2'), false, 'no arguments');
  assert.equal(json.includes('secrets'), false, 'no paths');
});

test('programOf: the program, or nothing it cannot vouch for', () => {
  assert.equal(programOf('npm run dev'), 'npm');
  assert.equal(programOf(String.raw`C:\tools\python.exe -m http.server`), 'python', 'a Windows path, stripped to the program');
  assert.equal(programOf('cd a && cd b && python app.py'), 'python');
  assert.equal(programOf('$(curl evil.sh)'), 'a command');
  assert.equal(programOf(''), 'a command');
  assert.equal(programOf(null), 'a command');
});

test('stopping one takes it off the list, and the list is bounded', () => {
  let { sessions } = play([bgRun('node a.js'), bgRun('npm start')]);
  assert.deepEqual(sessions.get('abc-123').bg.map(b => b.program), ['node', 'npm']);
  sessions = applyHookEvent(sessions, ev('PreToolUse', { tool_name: 'KillShell', tool_input: { shell_id: 'x' } }), 9000).sessions;
  assert.deepEqual(sessions.get('abc-123').bg.map(b => b.program), ['npm'], 'the oldest is assumed');
  const many = play(Array.from({ length: 20 }, () => bgRun('node a.js')));
  assert.equal(many.s.bg.length, 8, 'bounded');
});

test('background work is forgotten after a while, and rolls up newest first', () => {
  let { sessions } = play([bgRun('node a.js')]);
  sessions = applyHookEvent(sessions, { ...ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm start', run_in_background: true } }), session_id: 'other', cwd: String.raw`C:\p\two` }, 5000).sessions;
  const rolled = summarize(sessions);
  assert.deepEqual(rolled.background.map(b => `${b.program}@${b.project}`), ['npm@two', 'node@3d-rack'], 'newest first');
  assert.equal(summarize(expire(sessions, 31 * 60 * 1000)).background.length, 0, 'half an hour later it stops nagging');
});

test('a dependency checkup reports what it found and where, never its output', () => {
  const out = { stdout: 'up to date, audited 412 packages\n\nfound 0 vulnerabilities\n', stderr: '' };
  const r = play([ev('UserPromptSubmit'), ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'cd web && npm audit' }, tool_response: out })]);
  assert.equal(r.effects.length, 1);
  const e = r.effects[0];
  assert.equal(e.type, 'checkup');
  assert.deepEqual(e.check, { ecosystem: 'npm', check: 'audit' });
  assert.deepEqual(e.result, { status: 'clean', count: 0 });
  assert.ok(e.dir.endsWith('web'));
  assert.equal(JSON.stringify(r.effects).includes('audited'), false, 'the output stays out of it');
});

test('the Bugdex reads a failing command outside Shellby down to a species, never its text', () => {
  const { bugsOf } = require('../src/main/external');
  const start = bugsOf(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: 'node app.js' } }));
  assert.equal(start.length, 1);
  assert.equal(start[0].type, 'bug-start');
  assert.match(start[0].key, /^[0-9a-f]{12}$/);
  const fail = bugsOf(ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: 'node app.js' }, error: "Error: ENOENT: no such file or directory, open 'secret-plans.json'" }));
  assert.equal(fail[0].type, 'bug-read');
  assert.equal(fail[0].reading.outcome, 'fail');
  assert.equal(fail[0].reading.hit.species, 'shell-less-hermit');
  assert.ok(!JSON.stringify(fail).includes('secret-plans') && !JSON.stringify(fail).includes('node app.js'), 'no command or output leaves');
  const pass = bugsOf(ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu_2', tool_input: { command: 'node app.js' }, tool_response: { stdout: 'listening', stderr: '' } }));
  assert.equal(pass[0].reading.outcome, 'pass');
  assert.deepEqual(bugsOf(ev('PostToolUse', { tool_name: 'Write', tool_input: { file_path: 'a.js' } })), [{ type: 'bug-wrote', cwd: ev('x').cwd }]);
  // Interrupted, backgrounded, or from a folder that isn't on a local drive: nothing.
  assert.deepEqual(bugsOf(ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'node app.js' }, error: 'ENOENT', is_interrupt: true })), []);
  assert.deepEqual(bugsOf(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu_3', tool_input: { command: 'npm run dev', run_in_background: true } })), []);
  assert.deepEqual(bugsOf(ev('PostToolUseFailure', { cwd: '\\\\host\\share', tool_name: 'Bash', tool_input: { command: 'x' }, error: 'ENOENT' })), []);
});

test('a PostToolUseFailure keeps the session working, and reports only a failed test run', () => {
  const r = play([ev('UserPromptSubmit'), ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'boom' })]);
  assert.equal(r.s.state, 'working');
  assert.deepEqual(r.effects, [{ type: 'command-fail', kind: 'tests', project: '3d-rack' }]);
  assert.deepEqual(play([ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'ls nope' }, error: 'boom' })]).effects, []);
});
