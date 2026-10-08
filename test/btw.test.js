const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const btw = require('../src/main/btw');
const { run } = require('../src/main/claude-cli');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const fakeRun = (args, timeout, opts) => run(process.execPath, [FAKE, ...args], timeout, opts);
const valueOf = (a, flag) => a[a.indexOf(flag) + 1];

test('args: a fork of the conversation, with no tools, that saves nothing', () => {
  const a = btw.args({ sessionId: 'abc', model: 'opus' });
  assert.deepEqual(a.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.equal(valueOf(a, '--tools'), '');
  for (const f of ['--strict-mcp-config', '--no-session-persistence', '--fork-session']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('--mcp-config'), 'no MCP servers at all');
  assert.equal(valueOf(a, '--resume'), 'abc');
  assert.equal(valueOf(a, '--model'), 'opus');
  assert.equal(valueOf(a, '--append-system-prompt'), btw.NOTE);
  assert.ok(!a.some(x => x.startsWith('--resume-session-at')));
});

test('args: a rewound conversation forks from where its next message would', () => {
  assert.ok(btw.args({ sessionId: 'abc', resumeAt: 'u-7' }).includes('--resume-session-at=u-7'));
});

test('args: before the first message there is nothing to resume', () => {
  const a = btw.args({});
  for (const f of ['--resume', '--fork-session', '--model']) assert.ok(!a.includes(f), f);
});

test('args: lean flags go last', () => {
  assert.deepEqual(btw.args({ lean: ['--setting-sources', ''] }).slice(-2), ['--setting-sources', '']);
});

test('cleanQuestion: trimmed, and nothing or too much is no question', () => {
  assert.equal(btw.cleanQuestion('  what was it?\r\n'), 'what was it?');
  assert.equal(btw.cleanQuestion('   '), null);
  assert.equal(btw.cleanQuestion(null), null);
  assert.equal(btw.cleanQuestion('x'.repeat(btw.MAX_QUESTION + 1)), null);
});

test('parse: the answer, or a sentence about what went wrong', () => {
  assert.deepEqual(btw.parse(JSON.stringify({ is_error: false, result: ' It was auth.js. ' })), { ok: true, answer: 'It was auth.js.' });
  assert.equal(btw.parse('not json').ok, false);
  assert.equal(btw.parse(JSON.stringify({ is_error: false, result: '' })).ok, false);
  assert.match(btw.parse(JSON.stringify({ is_error: true, result: 'Not logged in' })).error, /Sign in/);
  assert.doesNotMatch(btw.parse(JSON.stringify({ is_error: true, result: 'boom' })).error, /Sign in/);
});

test('ask: the question goes on stdin to a fork of the conversation', async () => {
  const r = await btw.ask({ question: 'what was that file?', sessionId: 'sess-9' }, fakeRun);
  assert.deepEqual(r, { ok: true, answer: 'side answer (fork of sess-9): what was that file?' });
});

test('ask: no question asks nothing', async () => {
  let ran = false;
  const r = await btw.ask({ question: ' ' }, async () => { ran = true; return {}; });
  assert.equal(r.ok, false);
  assert.equal(ran, false);
});

test('ask: an error, a timeout and silence each say so', async () => {
  assert.match((await btw.ask({ question: 'btw fail' }, fakeRun)).error, /couldn't answer/);
  assert.match((await btw.ask({ question: 'q' }, async () => ({ timedOut: true, stdout: '' }))).error, /too long/);
  const quiet = await btw.ask({ question: 'q' }, async () => ({ stdout: '', stderr: 'line1\nwhy' }));
  assert.equal(quiet.ok, false);
  assert.match(quiet.detail, /why/);
});
