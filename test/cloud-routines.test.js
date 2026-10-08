const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const cloud = require('../src/main/cloud-routines');
const { run } = require('../src/main/claude-cli');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const viaFake = (env = {}) => (exe, args, timeout, opts) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const p = run(process.execPath, [FAKE, ...args], timeout, opts);
  process.env = saved;
  return p;
};

// What RemoteTrigger answered on Claude Code 2.1.293 (recorded with the real CLI).
const stream = (status, json) => [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'RemoteTrigger', input: { action: 'list' } }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: `HTTP ${status}\n${json}` }] }, tool_use_result: { status, json } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
].join('\n');

test('one call: Haiku, RemoteTrigger and nothing else, no settings, no saved session, a small budget', () => {
  const a = cloud.args({ action: 'list' });
  const after = flag => a[a.indexOf(flag) + 1];
  assert.equal(after('--model'), 'haiku');
  assert.equal(after('--tools'), 'RemoteTrigger');
  assert.equal(after('--allowedTools'), 'RemoteTrigger');
  assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--no-session-persistence'));
  assert.equal(after('--setting-sources'), '');
  assert.ok(Number(after('--max-budget-usd')) <= 0.05);
  assert.match(after('-p'), /\{"action":"list"\}$/);
});

test("RemoteTrigger's own result is read, never Claude's retelling of it", () => {
  const r = cloud.readOutput(stream(200, '{"data":[],"has_more":false}'));
  assert.deepEqual(r, { ok: true, status: 200, body: { data: [], has_more: false } });
  const out = cloud.readOutput(stream(401, '{"error":{"message":"unauthorized"}}'));
  assert.deepEqual([out.ok, /claude\.ai account/.test(out.error)], [false, true]);
  assert.match(cloud.readOutput(stream(500, '{"error":{"message":"boom"}}')).error, /boom/);
  const none = cloud.readOutput(JSON.stringify({ type: 'result', is_error: true, result: 'Please run /login' }));
  assert.deepEqual([none.ok, none.signedOut], [false, true]);
  assert.equal(cloud.readOutput('').ok, false);
});

test('a routine reads as the panel shows it; anything missing is unknown, not an error', () => {
  const [r] = cloud.parseRoutines({ data: [{
    id: 'trig_1', name: 'Nightly', enabled: true, cron_expression: '0 9 * * *', next_run_at: '2026-10-09T09:00:00Z',
    job_config: { ccr: { session_context: { model: 'claude-sonnet-5-5', sources: [{ git_repository: { url: 'https://github.com/o/r' } }] }, events: [{ data: { message: { content: [{ type: 'text', text: 'Do  the\nthing' }] } } }] } },
  }] });
  assert.deepEqual(r, {
    id: 'trig_1', name: 'Nightly', enabled: true, cron: '0 9 * * *', schedule: 'every day at 09:00 UTC', runOnceAt: null,
    nextRunAt: Date.parse('2026-10-09T09:00:00Z'), model: 'claude-sonnet-5-5', repos: ['https://github.com/o/r'], prompt: 'Do the thing',
    url: 'https://claude.ai/code/routines/trig_1',
  });
  assert.deepEqual(cloud.parseRoutines({ data: [{ id: 'bad id!' }, null, { id: 'ok' }] }).map(x => [x.id, x.name, x.enabled]), [['ok', 'Untitled routine', true]]);
  assert.deepEqual(cloud.parseRoutines(null), []);
});

test('enabled routines come first, soonest first', () => {
  const list = cloud.parseRoutines({ data: [
    { id: 'p', name: 'Paused', enabled: false, next_run_at: '2026-01-01T00:00:00Z' },
    { id: 'l', name: 'Later', next_run_at: '2026-10-10T00:00:00Z' },
    { id: 's', name: 'Soon', next_run_at: '2026-10-09T00:00:00Z' },
  ] });
  assert.deepEqual(list.map(r => r.id), ['s', 'l', 'p']);
});

test('the common cron lines in words, the rest left as cron', () => {
  assert.equal(cloud.cronWords('0 * * * *'), 'every hour');
  assert.equal(cloud.cronWords('15 * * * *'), 'every hour at :15');
  assert.equal(cloud.cronWords('0 */6 * * *'), 'every 6 hours');
  assert.equal(cloud.cronWords('30 8 * * 1-5'), 'weekdays at 08:30 UTC');
  assert.equal(cloud.cronWords('0 2 * * 0'), 'Sundays at 02:00 UTC');
  assert.equal(cloud.cronWords('0 9 1 * *'), 'day 1 of each month at 09:00 UTC');
  assert.equal(cloud.cronWords('0 9 * 1 *'), null);
  assert.equal(cloud.cronWords('*/5 9-17 * * 1-5'), null);
  assert.equal(cloud.cronWords('nonsense'), null);
  assert.equal(cloud.cronWords(null), null);
});

test('runs read whatever fields a run has', () => {
  const runs = cloud.parseRuns({ data: [{ id: 'session_1', status: 'completed', updated_at: '2026-10-08T01:00:00Z', title: 'x' }, { session_id: 'cse_2' }, {}] });
  assert.deepEqual(runs, [
    { id: 'session_1', status: 'completed', at: Date.parse('2026-10-08T01:00:00Z'), title: 'x' },
    { id: 'cse_2', status: null, at: null, title: null },
  ]);
});

test('ask refuses anything but list, list_runs and run, and ids that are not ids, before Claude Code is started', async () => {
  let ran = 0;
  const runner = async () => { ran++; return { stdout: '' }; };
  assert.equal((await cloud.ask('claude', { action: 'create', body: {} }, { runner })).ok, false);
  assert.equal((await cloud.ask('claude', { action: 'run', trigger_id: 'x; rm -rf' }, { runner })).ok, false);
  assert.equal((await cloud.ask(null, { action: 'list' }, { runner })).ok, false);
  assert.equal(ran, 0);
  const slow = await cloud.ask('claude', { action: 'list' }, { runner: async () => ({ timedOut: true, stdout: '' }) });
  assert.match(slow.error, /too long/);
});

test('end to end through the fake CLI: the list, a routine’s runs, a run, and signed out', async () => {
  const list = await cloud.ask('node', { action: 'list' }, { runner: viaFake() });
  assert.deepEqual(list.routines.map(r => [r.id, r.schedule]), [['trig_morning', 'weekdays at 08:00 UTC'], ['trig_deps', 'Sundays at 02:30 UTC']]);
  const runs = await cloud.ask('node', { action: 'list_runs', trigger_id: 'trig_morning' }, { runner: viaFake() });
  assert.equal(runs.runs[0].status, 'completed');
  assert.equal((await cloud.ask('node', { action: 'run', trigger_id: 'trig_morning' }, { runner: viaFake() })).ok, true);
  const out = await cloud.ask('node', { action: 'list' }, { runner: viaFake({ SHELLBY_FAKE_CLOUD: 'signedout' }) });
  assert.deepEqual([out.ok, /claude\.ai account/.test(out.error)], [false, true]);
});
