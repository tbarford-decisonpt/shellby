// "Test run" in Toolbox → Hooks: the details a hook would get, running it, and
// what Claude Code would make of the answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { samplePayload, parsePayload, verdict, findBash, runHook } = require('../src/main/hooks/test');
const { HOOK_EVENTS } = require('../src/main/claude/setup');

const bash = findBash();
const needsBash = { skip: bash ? false : 'no bash on this machine' };

test('samplePayload: the shape Claude Code sends, for every moment', () => {
  for (const e of HOOK_EVENTS) {
    const p = samplePayload({ event: e.name }, '/proj');
    assert.equal(p.hook_event_name, e.name);
    assert.equal(p.cwd, '/proj');
    assert.equal(typeof p.session_id, 'string');
  }
  const pre = samplePayload({ event: 'PreToolUse', matcher: 'Edit|Write' }, '/proj');
  assert.equal(pre.tool_name, 'Edit');
  assert.equal(pre.tool_input.file_path, '/proj/src/app.js');
  assert.equal(samplePayload({ event: 'PreToolUse', matcher: 'mcp__.*' }, '/p').tool_name, 'Bash', 'a pattern falls back to a shell command');
  assert.ok(samplePayload({ event: 'PostToolUse', matcher: 'Bash' }, '/p').tool_response);
  assert.equal(samplePayload({ event: 'PostToolUseFailure' }, '/p').error.length > 0, true);
  assert.equal(samplePayload({ event: 'SessionStart', matcher: 'resume' }, '/p').source, 'resume');
  assert.equal(samplePayload({ event: 'Notification', matcher: 'idle_prompt' }, '/p').notification_type, 'idle_prompt');
  assert.equal(samplePayload({ event: 'Stop' }, '/p').stop_hook_active, false);
});

test('parsePayload: a JSON object only, with a reason when it is not', () => {
  assert.deepEqual(parsePayload('{"a":1}'), { payload: { a: 1 } });
  assert.match(parsePayload('').error, /empty/);
  assert.match(parsePayload('[1]').error, /JSON object/);
  assert.match(parsePayload('{"a":1,}').error, /valid JSON/);
  assert.match(parsePayload(`{"a":"${'x'.repeat(70000)}"}`).error, /too long/);
});

test('verdict: says what exit 0, 2 and anything else mean at each moment', () => {
  assert.equal(verdict('PreToolUse', { code: 0, stdout: '', stderr: '' }).tone, 'ok');
  const blocked = verdict('PreToolUse', { code: 2, stdout: '', stderr: 'No force-pushing\nsecond line' });
  assert.deepEqual([blocked.tone, blocked.title], ['block', 'It would stop Claude from using the tool']);
  assert.match(blocked.detail, /^Claude is told: No force-pushing/);
  assert.equal(verdict('Stop', { code: 2, stderr: 'tests fail' }).title, 'It would stop Claude from stopping');
  assert.equal(verdict('PostToolUse', { code: 2, stderr: 'lint errors' }).title, 'Claude would be told to look again');
  assert.match(verdict('Notification', { code: 2, stderr: 'x' }).title, /can't be stopped/);
  assert.deepEqual(verdict('SessionStart', { code: 0, stdout: 'On branch main\n' }), { tone: 'ok', title: 'It worked. Claude would be told:', detail: 'On branch main' });
  assert.match(verdict('PreToolUse', { code: 0, stdout: '{"decision":"block"}' }).title, /JSON/);
  assert.deepEqual([verdict('Stop', { code: 1, stderr: 'boom' }).tone, verdict('Stop', { code: 1, stderr: 'boom' }).title], ['warn', 'It failed (exit code 1)']);
  assert.match(verdict('Stop', { code: null, timedOut: true, timeout: 5 }).title, /within 5 seconds/);
  const capped = verdict('Stop', { code: null, timedOut: true, timeout: 120, asked: 300, capped: true });
  assert.match(capped.title, /test run stopped it after 120 seconds/);
  assert.match(capped.detail, /up to 300 seconds/);
  assert.equal(verdict('Stop', { code: null, error: 'nope' }).detail, 'nope');
});

test('findBash: Claude Code\'s own setting first, then beside git, never a bare bash', { skip: process.platform !== 'win32' }, () => {
  const has = set => p => set.has(path.resolve(p));
  const own = 'D:\\Tools\\Git\\bin\\bash.exe';
  assert.equal(findBash({ CLAUDE_CODE_GIT_BASH_PATH: own, PATH: '' }, has(new Set([path.resolve(own)]))), path.resolve(own));
  const viaGit = 'E:\\Git\\bin\\bash.exe';
  assert.equal(findBash({ PATH: 'C:\\Windows\\System32;E:\\Git\\cmd' }, has(new Set([path.resolve('E:\\Git\\cmd\\git.exe'), path.resolve(viaGit)]))), path.resolve(viaGit));
  // C:\Windows\System32\bash.exe is WSL's: it's not looked at.
  assert.equal(findBash({ PATH: 'C:\\Windows\\System32' }, has(new Set([path.resolve('C:\\Windows\\System32\\bash.exe')]))), null);
});

test('runHook: stdin in, exit code and both streams out, in the given folder', needsBash, async () => {
  const r = await runHook({ command: 'cat; echo; pwd; echo oops >&2; exit 3', payload: { hello: 'reef' }, cwd: os.tmpdir(), timeout: 20, bash });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /^\{"hello":"reef"\}\n/);
  assert.equal(r.stderr.trim(), 'oops');
  assert.equal(r.timedOut, false);
});

test('runHook: no Git Bash means no run, never Command Prompt instead', async () => {
  const r = await runHook({ command: 'echo hi', payload: {}, cwd: os.tmpdir(), timeout: 5, bash: null });
  assert.equal(r.code, null);
  assert.match(r.error, /Git Bash wasn't found/);
});

test('samplePayload: a folder with $ in its name is copied as it is', () => {
  assert.equal(samplePayload({ event: 'PreToolUse', matcher: 'Edit' }, 'C:\\a$&b').tool_input.file_path, 'C:\\a$&b/src/app.js');
});

test('runHook: gives up after the timeout and says so', needsBash, async () => {
  const r = await runHook({ command: 'sleep 20', payload: {}, cwd: os.tmpdir(), timeout: 1, bash });
  assert.equal(r.timedOut, true);
  assert.ok(r.ms < 10000, `took ${r.ms} ms`);
});
