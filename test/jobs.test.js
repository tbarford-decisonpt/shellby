const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const jobs = require('../src/main/jobs');
const { toItems } = require('../src/main/stream');

// The events Claude Code 2.1.293 sends for `Bash { run_in_background }` (recorded with the real CLI).
const tool = (id, name, input) => toItems({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })[0];
const sys = ev => toItems({ type: 'system', ...ev })[0];
const OUT = path.join(os.tmpdir(), 'claude', 'C--proj', 'sess', 'tasks', 'bnyot46nq.output');

test('a backgrounded command is a job, not a helper; a helper is not a job', () => {
  assert.equal(jobs.isJob(sys({ subtype: 'task_started', task_id: 't', task_type: 'local_bash' })), true);
  assert.equal(jobs.isJob(sys({ subtype: 'task_started', task_id: 't', task_type: 'local_agent', subagent_type: 'Explore' })), false);
  assert.equal(jobs.isJob(sys({ subtype: 'task_started', task_id: 't', subagent_type: 'Explore' })), false, 'older CLIs said no type: helpers');
  assert.equal(jobs.isJob({ kind: 'tool' }), false);
});

test('a command left running: started, its output file, then finished, with what it was', () => {
  const st = jobs.create();
  const call = tool('tu1', 'Bash', { command: 'sleep 4 && echo done-bg', description: 'Run sleep', run_in_background: true });
  jobs.noteTool(st, call);
  assert.equal(jobs.track(st, sys({ subtype: 'task_started', task_id: 'bnyot46nq', tool_use_id: 'tu1', description: 'Run sleep then echo done-bg in background', is_backgrounded: true, task_type: 'local_bash' }), 1000), true);
  // The result arrives after task_started, with where the output goes.
  const result = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `Command running in background with ID: bnyot46nq. Output is being written to: ${OUT}. You will be notified when it completes.` }] } })[0];
  assert.equal(result.outputFile, OUT);
  jobs.noteResult(st, result);
  let [j] = jobs.view(st, 2000);
  assert.deepEqual([j.kind, j.status, j.hasOutput, j.command], ['command', 'running', true, 'sleep 4 && echo done-bg']);
  assert.equal(jobs.running(st).length, 1);

  // 'completed' waits for the notification: its summary has the exit code.
  assert.equal(jobs.track(st, sys({ subtype: 'task_updated', task_id: 'bnyot46nq', patch: { status: 'completed', end_time: 5 } }), 5000), false);
  assert.equal(jobs.running(st).length, 1);
  jobs.track(st, sys({ subtype: 'task_notification', task_id: 'bnyot46nq', tool_use_id: 'tu1', status: 'completed', output_file: OUT, summary: 'Background command "Run sleep" completed (exit code 0)' }), 5100);
  [j] = jobs.view(st, 6000);
  assert.deepEqual([j.status, j.endedAt, j.summary], ['done', 5100, 'Background command "Run sleep" completed (exit code 0)']);
  assert.equal(jobs.running(st).length, 0);
});

test('a Monitor watch is a job of its own kind; a non-zero exit is a failure; a stop is a stop', () => {
  const failing = jobs.create();
  jobs.track(failing, sys({ subtype: 'task_started', task_id: 'f', task_type: 'local_bash' }), 1);
  jobs.track(failing, sys({ subtype: 'task_updated', task_id: 'f', patch: { status: 'completed' } }), 2);
  jobs.track(failing, sys({ subtype: 'task_notification', task_id: 'f', status: 'completed', summary: 'Background command "x" completed (exit code 1)' }), 3);
  assert.equal(jobs.view(failing, 4)[0].status, 'failed', 'never shown as done first');

  const st = jobs.create();
  jobs.noteTool(st, tool('m', 'Monitor', { command: 'ping', description: 'pinging localhost' }));
  jobs.track(st, sys({ subtype: 'task_started', task_id: 'mon', tool_use_id: 'm', description: 'pinging localhost', task_type: 'local_bash' }), 1);
  assert.equal(jobs.view(st, 2)[0].kind, 'monitor');

  assert.equal(jobs.endedAs('completed', 'Background command "x" completed (exit code 2)'), 'failed');
  assert.equal(jobs.endedAs('completed', 'Monitor "x" stream ended'), 'done');
  assert.equal(jobs.endedAs('killed'), 'stopped');
  assert.equal(jobs.endedAs('stopped'), 'stopped');
  assert.equal(jobs.endedAs('failed'), 'failed');

  // Stopped through stop_task: task_updated killed, then the notification says stopped.
  jobs.track(st, sys({ subtype: 'task_updated', task_id: 'mon', patch: { status: 'killed' } }), 10);
  jobs.track(st, sys({ subtype: 'task_notification', task_id: 'mon', status: 'stopped' }), 11);
  assert.equal(jobs.view(st, 12)[0].status, 'stopped');
});

test('running ones come first, finished ones fade from the tray after two minutes, and a closed process stops the rest', () => {
  const st = jobs.create();
  const start = (id, at) => jobs.track(st, sys({ subtype: 'task_started', task_id: id, description: id, task_type: 'local_bash' }), at);
  start('a', 1); start('b', 2); start('c', 3);
  jobs.track(st, sys({ subtype: 'task_notification', task_id: 'b', status: 'completed' }), 10);
  assert.deepEqual(jobs.view(st, 20).map(j => j.id), ['a', 'c', 'b']);
  assert.deepEqual(jobs.view(st, 10 + jobs.KEEP_FINISHED_MS).map(j => j.id), ['a', 'c']);
  assert.equal(jobs.stopAll(st, 50), true);
  assert.equal(jobs.running(st).length, 0);
  assert.equal(jobs.stopAll(st, 60), false, 'nothing left to stop');
});

test("only a file under the temp folder ending .output is read as a job's output", () => {
  const tmp = os.tmpdir();
  assert.equal(jobs.outputPathOk(path.join(tmp, 'claude', 'x', 'tasks', 'a.output'), tmp), true);
  assert.equal(jobs.outputPathOk(path.join(tmp, 'claude', 'a.txt'), tmp), false);
  assert.equal(jobs.outputPathOk(path.join(os.homedir(), '.ssh', 'id.output'), tmp), false);
  assert.equal(jobs.outputPathOk('relative/a.output', tmp), false);
  assert.equal(jobs.outputPathOk(`${tmp}${path.sep}..${path.sep}x.output`, tmp), false);
  assert.equal(jobs.outputPathOk(null, tmp), false);
  if (process.platform === 'win32') assert.equal(jobs.outputPathOk(path.join(tmp.toUpperCase(), 'a.output'), tmp), true, 'Windows paths compare without case');
});

test('a job started before Shellby saw its tool call still has a name', () => {
  const st = jobs.create();
  jobs.track(st, sys({ subtype: 'task_started', task_id: 'z', task_type: 'local_bash' }), 1);
  assert.equal(jobs.view(st, 2)[0].description, 'a background command');
  assert.equal(jobs.track(st, sys({ subtype: 'task_started', task_id: 'h', task_type: 'local_agent' }), 1), false, 'a helper is never tracked here');
});
