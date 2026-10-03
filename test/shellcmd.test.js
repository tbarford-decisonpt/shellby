const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { run, contextFor } = require('../src/main/shellcmd');

test('contextFor: what you ran goes to Claude in the terminal shell mode tags', () => {
  const text = contextFor([{ command: 'git status', output: 'clean', code: 0 }, { command: 'npm test', output: 'boom', code: 1 }]);
  assert.match(text, /<bash-input>git status<\/bash-input>\n<bash-stdout>clean<\/bash-stdout>\n<bash-stderr><\/bash-stderr>/);
  assert.match(text, /<bash-input>npm test<\/bash-input>[\s\S]*\(exit code 1\)/);
  assert.ok(text.endsWith('\n\n'), 'separated from your message');
  assert.equal(contextFor([]), '');
  assert.equal(contextFor(undefined), '');
});

test('run: output and exit code come back', { skip: process.platform !== 'win32' }, async () => {
  const ok = await run(os.tmpdir(), 'Write-Output "hello from shellby"');
  assert.equal(ok.code, 0);
  assert.equal(ok.output, 'hello from shellby');
  const bad = await run(os.tmpdir(), 'Write-Output nope; exit 3');
  assert.equal(bad.code, 3);
  assert.equal(bad.output, 'nope');
});

test('run: a command that runs over is stopped and says so', { skip: process.platform !== 'win32' }, async () => {
  const r = await run(os.tmpdir(), 'Start-Sleep -Seconds 20', { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.match(r.output, /stopped after/);
  assert.ok(r.ms < 15000);
});
