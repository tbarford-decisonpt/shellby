// What went wrong, in a sentence, and the next step: the words Claude Code,
// Node and the API really use, mapped to one kind each.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { troubleOf, detailOf, ACTIONS } = require('../src/main/trouble');

const kindOf = (text, opts) => troubleOf(text, opts).kind;

test('Claude Code missing: the spawn error, whatever the path', () => {
  assert.equal(kindOf("Couldn't start Claude Code: spawn C:\\Program Files\\claude\\claude.exe ENOENT", { start: true }), 'cli-missing');
  assert.equal(kindOf("'claude' is not recognized as an internal or external command"), 'cli-missing');
  const t = troubleOf('spawn claude ENOENT', { start: true });
  assert.deepEqual(t.action, { id: 'setup', label: 'Set up Claude Code' });
  // Any other reason it won't start is still about setting it up, not "can't find".
  assert.equal(kindOf("Couldn't start Claude Code: spawn EACCES", { start: true }), 'no-start');
});

test('signed out: the ways Claude Code says it', () => {
  for (const said of [
    'Invalid API key · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'Not logged in · Please run /login',
  ]) assert.equal(kindOf(said), 'signed-out', said);
  assert.deepEqual(troubleOf('Invalid API key').action, { id: 'sign-in', label: 'Sign in again' });
  assert.notEqual(kindOf('Wrote 401 lines to app.js'), 'signed-out', 'a number on its own is not a sign-in');
});

test('a resume that fails is told apart from a crash', () => {
  assert.equal(kindOf('No conversation found with session ID: 0f9e8d7c-aaaa-bbbb-cccc-1234567890ab', { exited: true }), 'resume-failed');
  assert.equal(troubleOf('No conversation found with session ID: x').action.id, 'fresh-tab');
  const crash = troubleOf('Claude Code exited (code 3221225477).', { exited: true });
  assert.equal(crash.kind, 'stopped');
  assert.equal(crash.message, 'Claude Code stopped partway through that turn.');
  assert.equal(crash.action.id, 'retry');
});

test('usage limits, busy servers, a conversation that is too long', () => {
  assert.equal(kindOf('Claude AI usage limit reached|1759600000'), 'usage-limit');
  assert.equal(kindOf("5-hour limit reached ∙ resets 3pm"), 'usage-limit');
  assert.equal(troubleOf('usage limit reached').action.id, 'hold');
  assert.equal(kindOf('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), 'busy');
  assert.equal(kindOf('API Error: 500 Internal server error'), 'busy');
  assert.equal(kindOf('Prompt is too long'), 'too-long');
  assert.equal(troubleOf('Prompt is too long').action.id, 'fresh-tab');
});

test('network down: the CLI, Node and fetch all say it differently', () => {
  for (const said of [
    'API Error: Connection error.',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'connect ECONNREFUSED 127.0.0.1:443',
    'read ECONNRESET',
    'TypeError: fetch failed',
    'Request timed out.',
  ]) assert.equal(kindOf(said), 'network', said);
  assert.equal(troubleOf('API Error: Connection error.').action.id, 'retry');
});

test('something unknown says what the program said, in one tidy line, and offers the details', () => {
  const t = troubleOf('Error: The model refused for an unusual reason\n    at Foo (file.js:1:2)\n    at Bar (file.js:3:4)');
  assert.equal(t.kind, 'unknown');
  assert.equal(t.message, 'Something went wrong: The model refused for an unusual reason');
  assert.equal(t.action.id, 'copy');
  assert.equal(troubleOf('').message, "Something went wrong, and Claude Code didn't say what.");
  assert.equal(troubleOf('x'.repeat(500)).message.length < 240, true, 'never a wall of text');
});

test('a crash checks for a known cause before calling it a crash', () => {
  assert.equal(kindOf('Error: getaddrinfo ENOTFOUND api.anthropic.com', { exited: true }), 'network');
  assert.equal(kindOf('Invalid API key · Please run /login', { exited: true }), 'signed-out');
});

test('details for the log and the clipboard: no stack frames, a few lines, a size cap', () => {
  const raw = ['Error: boom', '    at a (x.js:1:1)', '    at b (y.js:2:2)', 'caused by: thing'].join('\n');
  assert.equal(detailOf(raw), 'Error: boom\ncaused by: thing');
  assert.equal(detailOf(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')).split('\n').length, 12);
  assert.equal(detailOf(null), '');
});

test('every action has a button label', () => {
  for (const kind of ['retry', 'sign-in', 'setup', 'fresh-tab', 'hold', 'copy']) assert.ok(ACTIONS[kind], kind);
});
