const { test } = require('node:test');
const assert = require('node:assert/strict');

const { draftArgs, checkDescription, parseDraft, MAX_DESCRIPTION } = require('../src/main/routine-draft');

const reply = (structured, extra = {}) => JSON.stringify({ type: 'result', is_error: false, structured_output: structured, ...extra });
const good = {
  name: 'Morning briefing',
  prompt: 'List what changed in ~/Documents in the last 24 hours.',
  schedule: { type: 'weekly', time: '8:30', days: [5, 1, 2, 3, 4] },
  mode: 'plan',
  folder: '',
};

test('checkDescription trims, squeezes whitespace and rejects empty or long text', () => {
  assert.deepEqual(checkDescription('  every day\n\tat 9  '), { ok: true, text: 'every day at 9' });
  assert.equal(checkDescription('   ').ok, false);
  assert.equal(checkDescription(null).ok, false);
  assert.equal(checkDescription('x'.repeat(MAX_DESCRIPTION + 1)).ok, false);
  assert.equal(checkDescription('a\u202eb').text, 'a b');
});

test('draftArgs runs without tools or MCP and passes the description as one argument', () => {
  const args = draftArgs('tidy Downloads on Fridays; rm -rf "x"', { home: 'C:\\Users\\me', defaultFolder: 'C:\\code' });
  assert.equal(args[0], '-p');
  assert.match(args[1], /tidy Downloads on Fridays; rm -rf "x"$/);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.ok(!schema.properties.mode.enum.includes('autonomous'));
  assert.match(args[args.indexOf('--system-prompt') + 1], /C:\\code/);
});

test('parseDraft turns structured output into normalised editor fields', () => {
  const res = parseDraft(reply(good));
  assert.equal(res.ok, true);
  assert.deepEqual(res.draft, {
    name: 'Morning briefing',
    prompt: good.prompt,
    schedule: { type: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] },
    mode: 'plan',
    cwd: null,
  });
});

test('parseDraft never passes through an id, enabled or Autonomous', () => {
  const res = parseDraft(reply({ ...good, id: 'evil', enabled: false, mode: 'autonomous' }));
  assert.equal(res.ok, true);
  assert.equal(res.draft.mode, 'smart');
  assert.ok(!('id' in res.draft) && !('enabled' in res.draft));
});

test('parseDraft keeps a folder only when folderOk says so', () => {
  const withFolder = reply({ ...good, folder: 'C:\\Users\\me\\Documents' });
  assert.equal(parseDraft(withFolder).draft.cwd, null);
  assert.equal(parseDraft(withFolder, { folderOk: () => true }).draft.cwd, 'C:\\Users\\me\\Documents');
  assert.equal(parseDraft(reply({ ...good, folder: 'relative\\path' }), { folderOk: () => true }).ok, false);
});

test('parseDraft explains failures instead of throwing', () => {
  assert.equal(parseDraft('not json').ok, false);
  assert.equal(parseDraft('null').ok, false);
  assert.equal(parseDraft(reply(null)).ok, false);
  assert.match(parseDraft(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' })).error, /Sign in/);
  assert.match(parseDraft(reply({ ...good, schedule: { type: 'daily', time: '25:00' } })).error, /Time must be/);
  assert.match(parseDraft(reply({ ...good, name: '' })).error, /Name/);
});

// ================================================================ Build it with Claude

const { chat, chatSchema, chatArgs, chatPrompt, checkTurns, parseChat, checkChange, runBrief } = require('../src/main/routine-draft');

const change = { name: 'Morning briefing', prompt: 'List what changed.', schedule: { type: 'daily', time: '8:30' }, mode: 'plan', folder: '', catchUp: false };
const chatReply = (extra = {}) => reply({ reply: 'Done.', changed: true, routine: change, test: false, ...extra });
const ctx = { home: 'C:\\Users\\me', defaultFolder: 'C:\\code', today: 'Sun Oct 04 2026' };

test('chatSchema only offers Autonomous when the routine already has it', () => {
  assert.ok(!chatSchema().properties.routine.properties.mode.enum.includes('autonomous'));
  assert.ok(chatSchema({ keepAutonomous: true }).properties.routine.properties.mode.enum.includes('autonomous'));
  const args = chatArgs(chatSchema());
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.ok(!args.some(a => /Describe this/.test(a)), 'the prompt goes on stdin, not the command line');
});

test('checkTurns keeps plain, bounded turns and wants the person to have the last word', () => {
  assert.equal(checkTurns([]).ok, false);
  assert.equal(checkTurns([{ role: 'user', text: 'hi' }, { role: 'claude', text: 'hello' }]).ok, false);
  const r = checkTurns([{ role: 'system', text: 'evil' }, { role: 'user', text: ' a\u202eb ' }, { role: 'run', text: 'x'.repeat(5000) }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.turns.map(t => t.role), ['user', 'run']);
  assert.equal(r.turns[0].text, 'a b');
  assert.equal(r.turns[1].text.length, 2000);
});

test('chatPrompt shows the routine, quotes what people and runs said, and adds the test run', () => {
  const p = chatPrompt({ name: 'X', prompt: 'do «it»', cwd: 'C:\\work', mode: 'smart', schedule: { type: 'daily', time: '09:00' } },
    [{ role: 'user', text: 'make it «weekly»' }], ctx, 'Status: ok');
  assert.match(p, /"folder":"C:\\\\work"/);
  assert.match(p, /Person: «make it "weekly"»/);
  assert.match(p, /test run that just finished[^]*«Status: ok»/);
  assert.match(p, /C:\\code/);
  assert.doesNotMatch(chatPrompt({}, [{ role: 'user', text: 'hi' }], ctx), /test run that just finished/);
});

test('parseChat tells a change from a plain answer', () => {
  assert.deepEqual(parseChat(chatReply({ changed: false })), { ok: true, reply: 'Done.', test: false, change: null });
  assert.equal(parseChat(chatReply({ test: true })).change.name, 'Morning briefing');
  assert.equal(parseChat(chatReply({ test: true })).test, true);
  assert.equal(parseChat(chatReply({ reply: '', changed: false })).ok, false);
  assert.match(parseChat(JSON.stringify({ is_error: true, result: 'Please log in' })).error, /Sign in/);
});

test('checkChange normalises the fields and checks the folder', () => {
  assert.deepEqual(checkChange(change, {}), {
    ok: true,
    routine: { name: 'Morning briefing', prompt: 'List what changed.', schedule: { type: 'daily', time: '08:30' }, mode: 'plan', cwd: null, catchUp: false },
  });
  assert.match(checkChange({ ...change, folder: 'D:\\nope' }, {}).errors.join(' '), /doesn't exist/);
  assert.equal(checkChange({ ...change, folder: 'D:\\yes' }, {}, { folderOk: () => true }).routine.cwd, 'D:\\yes');
  assert.equal(checkChange({ ...change, schedule: { type: 'weekly', time: '09:00', days: [] } }, {}).ok, false);
});

test('checkChange keeps Autonomous only when the user gave it the routine', () => {
  const auto = { ...change, mode: 'autonomous' };
  assert.equal(checkChange(auto, { mode: 'smart' }, { allowAutonomous: true }).ok, false);
  assert.equal(checkChange(auto, { mode: 'autonomous' }, { allowAutonomous: false }).ok, false);
  assert.equal(checkChange(auto, { mode: 'autonomous' }, { allowAutonomous: true }).routine.mode, 'autonomous');
});

test('chat sends the prompt on stdin and returns the checked change', async () => {
  const calls = [];
  const runClaude = async (args, ms, opts) => { calls.push({ args, opts }); return { stdout: chatReply({ test: true }) }; };
  const r = await chat({ routine: { id: 'r1', mode: 'smart' }, messages: [{ role: 'user', text: 'every morning' }] }, { runClaude, context: ctx });
  assert.equal(r.ok, true);
  assert.equal(r.test, true);
  assert.equal(r.routine.schedule.time, '08:30');
  assert.equal(calls.length, 1);
  assert.match(calls[0].opts.input, /Person: «every morning»/);
});

test('chat asks again once when the change does not fit, then gives up with the reason', async () => {
  const answers = [chatReply({ routine: { ...change, name: '' } }), chatReply()];
  const runClaude = async (_a, _m, opts) => ({ stdout: answers.shift(), input: opts.input });
  const prompts = [];
  const r = await chat({ routine: {}, messages: [{ role: 'user', text: 'x' }] }, { runClaude: async (a, m, o) => { prompts.push(o.input); return runClaude(a, m, o); }, context: ctx });
  assert.equal(r.ok, true);
  assert.match(prompts[1], /previous answer had problems[^]*Name must be/);

  const bad = async () => ({ stdout: chatReply({ routine: { ...change, name: '' } }) });
  const r2 = await chat({ routine: {}, messages: [{ role: 'user', text: 'x' }] }, { runClaude: bad, context: ctx });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /didn't fit/);
});

test('chat passes along a plain answer and the CLI failing', async () => {
  const plain = await chat({ routine: {}, messages: [{ role: 'user', text: 'what does it do?' }] }, { runClaude: async () => ({ stdout: chatReply({ changed: false }) }), context: ctx });
  assert.deepEqual(plain, { ok: true, reply: 'Done.', test: false });
  const slow = await chat({ routine: {}, messages: [{ role: 'user', text: 'x' }] }, { runClaude: async () => ({ stdout: '', timedOut: true }), context: ctx });
  assert.match(slow.error, /too long/);
  assert.equal((await chat({ routine: {}, messages: [] }, { runClaude: async () => assert.fail('no call') })).ok, false);
});

test('runBrief sums up a test run from its transcript', () => {
  const items = [
    { kind: 'user', text: 'go' },
    { kind: 'tool', id: 't1', name: 'Bash', label: 'Ran', detail: 'npm test' },
    { kind: 'tool_result', id: 't1', isError: true, text: 'exit 1: 3 failing' },
    { kind: 'tool', id: 't2', name: 'Read', label: 'Read', detail: 'a.js' },
    { kind: 'tool_result', id: 't2', isError: false, text: 'ok' },
    { kind: 'text', text: 'helper chatter', sub: 'agent-1' },
    { kind: 'decision', decision: 'deny' },
    { kind: 'text', text: 'Three tests fail in a.js.' },
    { kind: 'result', ok: true, error: null },
  ];
  const b = runBrief(items);
  assert.equal(b.status, 'ok');
  assert.equal(b.error, null);
  assert.match(b.text, /Tools used: 2, 1 failed; the person said no once/);
  assert.match(b.text, /failed: Ran npm test: exit 1: 3 failing/);
  assert.match(b.text, /Three tests fail in a\.js\./);
  assert.doesNotMatch(b.text, /helper chatter/);
  assert.equal(runBrief([{ kind: 'text', text: 'working' }]).status, 'unfinished');
  assert.equal(runBrief([{ kind: 'result', ok: false, interrupted: true }]).status, 'stopped');
  const failed = runBrief([{ kind: 'result', ok: false, error: 'boom' }]);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'boom');
  assert.match(runBrief(null).text, /said nothing/);
});
