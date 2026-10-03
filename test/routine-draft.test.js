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
