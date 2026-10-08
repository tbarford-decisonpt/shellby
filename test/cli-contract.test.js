const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contract = require('../src/main/cli-contract');
const { ClaudeSession, EFFORTS } = require('../src/main/session');
const { CLI_MODE, MODES } = require('../src/main/config');

const TRANSCRIPTS = path.join(__dirname, 'fixtures', 'cli-transcripts');
const lines = file => fs.readFileSync(path.join(TRANSCRIPTS, file), 'utf8').split('\n').filter(Boolean);

// Every kind of conversation Shellby starts, so every flag buildArgs can emit shows up.
function everyLaunch() {
  const sessions = [];
  for (const mode of MODES) sessions.push({ mode });
  for (const effort of EFFORTS) sessions.push({ mode: 'ask', effort });
  sessions.push({ mode: 'ask', model: 'haiku', outputStyle: 'Explanatory' });
  sessions.push({ mode: 'ask', allowedTools: ['mcp__linear__*'], mcpConfig: { mcpServers: {} } });
  sessions.push({ mode: 'ask', resumeId: 'sess-1' });
  sessions.push({ mode: 'ask', resumeId: 'sess-1', resumeAt: 'uuid-9' });
  return sessions.map(o => new ClaudeSession({ exe: 'x', cwd: os.tmpdir(), ...o }).buildArgs());
}

test('every flag Shellby launches with is in the contract, and every contract flag is used', () => {
  const emitted = new Set(everyLaunch().flatMap(contract.flagsIn));
  const listed = new Set(contract.REQUIRED_FLAGS.map(f => f.flag));
  for (const f of emitted) assert.ok(listed.has(f), `${f} is launched with but missing from REQUIRED_FLAGS`);
  for (const f of listed) assert.ok(emitted.has(f), `${f} is in REQUIRED_FLAGS but nothing launches with it`);
});

test('the contract asks for exactly the permission modes and efforts Shellby uses', () => {
  assert.deepEqual([...contract.REQUIRED_MODES].sort(), [...new Set(Object.values(CLI_MODE))].sort());
  assert.ok(contract.REQUIRED_MODES.includes('default'), 'Ask mode launches as "default", which --help no longer lists');
  assert.equal(contract.EFFORTS, EFFORTS, 'session.js uses the contract\'s list, not a copy');
  for (const e of EFFORTS) {
    const args = new ClaudeSession({ exe: 'x', cwd: os.tmpdir(), mode: 'ask', effort: e }).buildArgs();
    assert.equal(args[args.indexOf('--effort') + 1], e);
  }
});

test('flagsIn takes the names and not the values', () => {
  assert.deepEqual(contract.flagsIn(['-p', '--model', 'haiku', '--resume-session-at=abc', '--settings', '{"a":"-b"}', '-p']),
    ['-p', '--model', '--resume-session-at', '--settings']);
});

const HELP = `Usage: claude [options] [command] [prompt]
Options:
  --allow-dangerously-skip-permissions  Enable bypassing all permission checks
  --effort <level>                      Effort level (low, medium, high, xhigh, max)
  --fork-session                        When resuming, create a new session ID
  --input-format <format>               Input format (only works with --print)
  --model <model>                       Model for the current session
  --output-format <format>              Output format
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow
  --mcp-config <configs...>             Load MCP servers from JSON files or strings
  --permission-mode <mode>              Permission mode to use for the session
  -p, --print                           Print response and exit
  --replay-user-messages                Re-emit user messages from stdin back on stdout
  -r, --resume [value]                  Resume a conversation
  --settings <file-or-json>             Path to a settings JSON file
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --verbose                             Override verbose mode setting
`;

test('checkHelp passes a help text with every documented flag, and skips the hidden ones', () => {
  assert.deepEqual(contract.checkHelp(HELP), { ok: true, missing: [] });
  assert.ok(contract.REQUIRED_FLAGS.some(f => f.hidden && f.flag === '--permission-prompt-tool'));
});

test('checkHelp names a flag that disappeared, and a longer flag does not stand in for it', () => {
  const noResume = HELP.replace(/ {2}-r, --resume[^\n]*\n/, '  --resume-session-at <uuid>  something else\n').replace('--verbose ', '--verbosity ');
  assert.deepEqual(contract.checkHelp(noResume), { ok: false, missing: ['--verbose', '--resume'] });
  assert.equal(contract.checkHelp('').ok, false);
  assert.equal(contract.checkHelp(null).missing.length, contract.REQUIRED_FLAGS.filter(f => !f.hidden).length);
});

test('flagRejected spots each way the CLI refuses an argument', () => {
  assert.equal(contract.flagRejected("error: unknown option '--bogus'"), "unknown option '--bogus'");
  assert.match(contract.flagRejected("error: option '--permission-mode <mode>' argument 'default' is invalid. Allowed choices are manual, plan."), /argument 'default' is invalid/);
  assert.match(contract.flagRejected("Warning: Unknown --effort value 'max' — ignoring it"), /Unknown --effort value 'max'/);
  assert.equal(contract.flagRejected('2.1.288 (Claude Code)'), null);
  assert.equal(contract.flagRejected(undefined), null);
});

test('a recorded real transcript is understood end to end', () => {
  const files = fs.readdirSync(TRANSCRIPTS).filter(f => f.endsWith('.jsonl'));
  assert.ok(files.length > 0, 'at least one recorded transcript');
  for (const file of files) {
    const audit = contract.auditEvents(lines(file), { expect: [...contract.EXPECTED_KINDS, 'permission', 'tool', 'tool_result'] });
    assert.deepEqual(audit.unknown, [], `${file}: events Shellby doesn't know`);
    assert.deepEqual(audit.missingKinds, [], `${file}: kinds it should have produced`);
    assert.deepEqual(audit.parseErrors, [], `${file}: lines that aren't JSON`);
    assert.ok(audit.ok);
    assert.ok(audit.seen.includes('control_request/can_use_tool') && audit.seen.includes('control_response'));
  }
});

test('the recorded transcripts carry nobody\'s home folder, name or email', () => {
  for (const file of fs.readdirSync(TRANSCRIPTS)) {
    const text = fs.readFileSync(path.join(TRANSCRIPTS, file), 'utf8');
    const users = [...text.matchAll(/Users[\\/]+([^\\/"]+)/g)].map(m => m[1]);
    assert.ok(users.every(u => u === 'user' || u.startsWith('user-')), `${file}: ${[...new Set(users)].join(', ')}`);
    assert.deepEqual([...new Set(text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [])].filter(e => e !== 'user@example.com'), [], file);
    const me = os.userInfo().username;
    if (me.length > 3 && me !== 'user') assert.ok(!new RegExp(`\\b${me}\\b`, 'i').test(text), `${file} names ${me}`);
  }
});

test('auditEvents counts what it can\'t place, and says what is missing', () => {
  const audit = contract.auditEvents([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({ type: 'brand_new', a: 1 }),
    JSON.stringify({ type: 'brand_new', a: 2 }),
    JSON.stringify({ type: 'system', subtype: 'mystery' }),
    JSON.stringify({ type: 'system', subtype: 'hook_started' }),
    JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'mcp_message' } }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'x' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'replayed prompt' } }),
    'not json at all',
    '',
  ]);
  assert.deepEqual(audit.unknown, [
    { type: 'brand_new', subtype: null, count: 2 },
    { type: 'system', subtype: 'mystery', count: 1 },
    { type: 'control_request', subtype: 'mcp_message', count: 1 },
  ]);
  assert.deepEqual(audit.missingKinds, ['text', 'result']);
  assert.deepEqual(audit.parseErrors, ['not json at all']);
  assert.equal(audit.events, 8);
  assert.equal(audit.ok, false);
  assert.ok(audit.seen.includes('system/hook_started'));
});

test('unknownType names only top-level types Shellby has never heard of', () => {
  assert.equal(contract.unknownType({ type: 'brand_new' }), 'brand_new');
  assert.equal(contract.unknownType({ type: 'control_response' }), null);
  assert.equal(contract.unknownType({ type: 'system', subtype: 'mystery' }), null);
  assert.equal(contract.unknownType(null), null);
  assert.equal(contract.unknownType({ type: 42 }), null);
  assert.equal(contract.unknownType({ type: 'x'.repeat(200) }).length, 60);
});

test('the badge shows the version that works, and remembers it once something breaks', () => {
  const good = contract.badgeFor({ ok: true, version: '2.1.288', checkedAt: 't1' });
  assert.deepEqual(good.badge, { schemaVersion: 1, label: 'works with Claude Code', message: '2.1.288', color: '7fd6c2', cacheSeconds: 3600 });
  assert.deepEqual(good.state, { version: '2.1.288', ok: true, lastGood: '2.1.288' }, 'no time in it: a quiet night changes nothing');

  const broken = contract.badgeFor({ ok: false, version: '2.2.0' }, good.state);
  assert.equal(broken.badge.message, '2.1.288 (broken since 2.2.0)');
  assert.equal(broken.badge.color, 'e05d44');
  assert.equal(broken.state.lastGood, '2.1.288');
  assert.equal(contract.badgeFor({ ok: false, version: '2.2.1' }, broken.state).state.lastGood, '2.1.288', 'still the last good one a night later');

  assert.equal(contract.badgeFor({ ok: false, version: '2.2.0' }).badge.message, 'broken since 2.2.0');
  assert.equal(contract.badgeFor(null).badge.message, 'broken since unknown');
  const keys = Object.keys(broken.badge).sort();
  assert.deepEqual(keys, ['cacheSeconds', 'color', 'label', 'message', 'schemaVersion'], 'only keys shields.io accepts');
});

test('the summary lists each check and anything unknown', () => {
  const md = contract.summaryOf({
    version: '2.2.0', ok: false, unknown: [{ type: 'system', subtype: 'mystery', count: 3 }],
    checks: [{ name: 'version', ok: true, detail: 'claude 2.2.0' }, { name: 'flags', ok: false, detail: 'missing: --verbose | x' }, { name: 'real turn', ok: true, skipped: true, detail: 'skipped' }],
  });
  assert.match(md, /Claude Code 2\.2\.0\*\*: something Shellby relies on changed/);
  assert.match(md, /\| ok \| version \|/);
  assert.match(md, /\| \*\*FAIL\*\* \| flags \| missing: --verbose \\\| x \|/);
  assert.match(md, /\| skipped \| real turn \|/);
  assert.match(md, /`system\/mystery` ×3/);
  assert.match(contract.summaryOf({ version: '2.1.0', ok: true, checks: [] }), /works with Shellby/);
});

test('scrubTranscript takes out the person and keeps the shape', () => {
  const home = 'C:\\Users\\Jacob';
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'AB12CD34-0000-4000-8000-123456789abc', cwd: 'C:\\Users\\jacob\\proj',
      tools: ['Bash', 'mcp__mine__thing'], plugins: [{ name: 'p', path: 'C:/Users/jacob/.claude/p' }], skills: ['secret-skill'], mcp_servers: [{ name: 'mine' }] }),
    JSON.stringify({ type: 'system', subtype: 'hook_response', output: 'jacob@example.org did a thing', stdout: 'x', exit_code: 0 }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { commands: [{ name: 'mine' }], account: { email: 'a@b.co' }, pid: 1, current_permission_mode: 'default' } } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'EsYE...' }, { type: 'tool_use', name: 'Write', input: { file_path: 'C:/Users/JACOB\\a.txt', skills: ['kept'] } }] }, session_id: 'ab12cd34-0000-4000-8000-123456789abc' }),
    JSON.stringify({ type: 'result', result: 'mail jacob.smith@corp.example.com', stderr: 'at C:\\\\Users\\\\jacob\\\\x.js', session_id: 'aaaaaaaa-0000-4000-8000-000000000000' }),
    'garbage',
  ];
  const out = contract.scrubTranscript(raw, { home, user: 'jacob' }).map(l => JSON.parse(l));
  assert.equal(out.length, 5, 'unparseable lines are dropped');
  const [init, hook, answer, assistant, result] = out;
  assert.equal(init.cwd, 'C:\\Users\\user\\proj');
  assert.equal(init.session_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(assistant.session_id, init.session_id, 'the same id becomes the same fake, whatever its case');
  assert.equal(result.session_id, '00000000-0000-4000-8000-000000000002');
  assert.deepEqual(init.tools, ['Bash']);
  assert.deepEqual([init.plugins, init.skills, init.mcp_servers], [[], [], []]);
  assert.deepEqual([hook.output, hook.stdout, hook.exit_code], ['', '', 0]);
  assert.deepEqual(answer.response.response, { commands: [], account: {}, pid: 1, current_permission_mode: '' });
  assert.equal(assistant.message.content[0].signature, '');
  assert.equal(assistant.message.content[1].input.file_path, 'C:\\Users\\user\\a.txt');
  assert.deepEqual(assistant.message.content[1].input.skills, ['kept'], 'a tool\'s own input is left as it was');
  assert.equal(result.result, 'mail user@example.com');
  assert.equal(result.stderr, 'at C:\\Users\\user\\\\x.js', 'doubled separators, from JSON inside a string, too');
  const again = contract.scrubTranscript(out.map(o => JSON.stringify(o)), { home, user: 'jacob' });
  assert.deepEqual(again.map(l => JSON.parse(l)), out, 'scrubbing twice changes nothing');
});

test('scrubTranscript catches a home folder named apart from the user, and keys', () => {
  const raw = [JSON.stringify({
    type: 'result',
    a: 'C:\\Users\\jsmith.CORP\\proj and C--Users-jsmith-CORP-proj',
    b: 'key sk-ant-api03-AbC_dEf-123 and ghp_abcdefABCDEF123456',
  })];
  const [out] = contract.scrubTranscript(raw, { home: 'C:\\Users\\jsmith.CORP', user: 'jsmith' }).map(l => JSON.parse(l));
  assert.equal(out.a, 'C:\\Users\\user\\proj and C--Users-user-CORP-proj');
  assert.equal(out.b, 'key sk-ant-… and ghp_…');
  assert.equal(contract.scrubTranscript(['{"type":"x","s":"user"}'], { home: 'C:\\Users\\user', user: 'user' })[0], '{"type":"x","s":"user"}');
});

test('scrubTranscript catches the home folder in its 8.3 short form too', () => {
  // os.tmpdir() and the CLI's scratchpad paths spell it this way; it matches
  // neither the long home folder nor the user name.
  const raw = [JSON.stringify({
    type: 'x',
    a: 'C:\\Users\\JOHNSM~1\\AppData\\Local\\Temp\\x',
    b: 'C:/Users/JOHNSM~1/AppData',
    c: 'C:\\Users\\user\\Documents\\tilde~2',
  })];
  const [out] = contract.scrubTranscript(raw, { home: 'C:\\Users\\john.smith', user: 'john.smith' }).map(l => JSON.parse(l));
  assert.equal(out.a, 'C:\\Users\\user\\AppData\\Local\\Temp\\x');
  assert.equal(out.b, 'C:/Users/user/AppData');
  assert.equal(out.c, 'C:\\Users\\user\\Documents\\tilde~2', 'only the segment right under Users');
});
