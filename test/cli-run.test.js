const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/main/claude-cli');

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = ms => new Promise(r => setTimeout(r, ms));

test('run(): a timeout kills the whole process tree, not just the top process', async () => {
  // Stands in for `claude plugin install` running git: the top process starts a
  // child, reports its pid, and both hang.
  const script = [
    "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write('child:' + c.pid + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const r = await run(process.execPath, ['-e', script], 1500);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  const pid = Number((r.stdout.match(/child:(\d+)/) || [])[1]);
  assert.ok(pid > 0, `got the child pid (${r.stdout})`);
  for (let i = 0; i < 20 && alive(pid); i++) await wait(150);
  assert.equal(alive(pid), false, 'the grandchild was killed too');
});

test('run(): a quick command is unaffected', async () => {
  const r = await run(process.execPath, ['-e', "process.stdout.write('hi')"], 5000);
  assert.deepEqual([r.ok, r.timedOut, r.stdout], [true, false, 'hi']);
});
