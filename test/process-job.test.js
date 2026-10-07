const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { spawn } = require('child_process');
const processJob = require('../src/main/process-job');

const skip = !processJob.available() && 'job objects need Windows and koffi';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 50));
  }
  return true;
}

// cmd starts a long-lived node and exits at once, leaving it with no parent,
// the way uvx leaves serena's python behind. (Not a node parent: node ends its
// own children when it exits, so nothing would be left over.)
function orphaningParent() {
  const cmd = `/d /s /c "start "" /b "${process.execPath}" -e "setInterval(function () {}, 1000)""`;
  return spawn(process.env.ComSpec || 'cmd.exe', [cmd], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
}

test('ends what a process left running after it exited', { skip }, async () => {
  const parent = orphaningParent();
  const job = processJob.adopt(parent.pid);
  assert.ok(job, 'the parent joins a job');
  await new Promise(r => parent.once('exit', r));
  // cmd is gone; what's left is the orphan (and a conhost, with no console to share).
  let left = [];
  assert.ok(await until(() => (left = processJob.members(job)).length > 0), 'something was left behind');
  try {
    assert.ok(left.every(alive), 'it outlives its parent');
    const r = processJob.sweep(job);
    assert.ok(r.ended.includes('node.exe'), `the orphan is ended (ended: ${r.ended})`);
    assert.ok(await until(() => !left.some(alive)), 'nothing is left running');
  } finally {
    for (const pid of left) if (alive(pid)) process.kill(pid); // never leave one behind if an assert fails
  }
});

// npm -> cmd -> electron, in miniature: node lets its grandchildren slip out of
// its own job, but not out of this one.
const NODE_THEN_CMD = `
  const { spawn } = require('child_process');
  spawn(process.env.ComSpec || 'cmd.exe', ['/d /s /c ""' + process.execPath + '" -e "setInterval(function () {}, 1000)""'], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  setInterval(() => {}, 1000);
`;

test('finds the whole tree, through node and cmd', { skip }, async () => {
  const top = spawn(process.execPath, ['-e', NODE_THEN_CMD], { stdio: 'ignore', windowsHide: true });
  const job = processJob.adopt(top.pid);
  assert.ok(job);
  let all = [];
  try {
    // Wait for the tree to stop growing: Windows adds a conhost or two along the way.
    let steady = 0;
    assert.ok(await until(() => {
      const now = processJob.members(job);
      steady = now.length >= 3 && now.length === all.length ? steady + 1 : 0;
      all = now;
      return steady >= 10;
    }), `the tree settles (${all.length})`);
    const r = processJob.sweep(job);
    assert.deepEqual(r.ended.filter(n => n !== 'conhost.exe').sort(), ['cmd.exe', 'node.exe', 'node.exe']);
    assert.ok(await until(() => !all.some(alive)), 'all of it is ended');
  } finally {
    for (const pid of all) if (alive(pid)) process.kill(pid);
    if (alive(top.pid)) process.kill(top.pid);
  }
});

test('sweeping twice, or with no job, does nothing', { skip }, async () => {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const job = processJob.adopt(p.pid);
  await new Promise(r => p.once('exit', r));
  // Its conhost can outlive it by a moment on a busy machine, and a sweep rightly
  // ends that too; nothing else is left to end.
  const r = processJob.sweep(job);
  assert.deepEqual({ ...r, ended: r.ended.filter(n => n !== 'conhost.exe') }, { ended: [], kept: [] });
  assert.equal(processJob.sweep(job), null);
  assert.equal(processJob.sweep(null), null);
});

// os.getPriority reads IDLE_PRIORITY_CLASS as PRIORITY_LOW.
const IDLE = os.constants.priority.PRIORITY_LOW;
const NORMAL = os.constants.priority.PRIORITY_NORMAL;
const priorityOf = pid => { try { return os.getPriority(pid); } catch { return null; } };

// A process that starts a child only after a moment: what an e2e run does
// mid-game, long after the conversation was held back.
const CHILD_LATER = `
  setTimeout(() => require('child_process').spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], { stdio: 'ignore', windowsHide: true }), 400);
  setInterval(() => {}, 1000);
`;

test('gives way to a game, children started later included, and gets the machine back after', { skip }, async () => {
  const top = spawn(process.execPath, ['-e', CHILD_LATER], { stdio: 'ignore', windowsHide: true });
  const job = processJob.adopt(top.pid);
  assert.ok(job);
  let all = [];
  try {
    processJob.giveWay(true);
    assert.equal(priorityOf(top.pid), IDLE, 'held back at once');
    assert.ok(await until(() => (all = processJob.members(job).filter(pid => pid !== top.pid)).length > 0), 'the child starts');
    assert.ok(all.every(pid => priorityOf(pid) === IDLE), 'a child started mid-game is held back too');
    processJob.giveWay(false);
    assert.ok([top.pid, ...all].every(pid => priorityOf(pid) === NORMAL), 'all of it back to normal');
  } finally {
    processJob.giveWay(false);
    processJob.sweep(job);
  }
});

test('a task started while a game is up is held back from the start', { skip }, async () => {
  const p = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  let job = null;
  try {
    processJob.giveWay(true);
    job = processJob.adopt(p.pid);
    assert.equal(priorityOf(p.pid), IDLE);
    assert.equal(processJob.givingWay(), true);
  } finally {
    processJob.giveWay(false);
    if (job) processJob.sweep(job); else p.kill();
  }
  assert.equal(processJob.givingWay(), false);
});

test("the game's share of the CPU is split between the tasks running", () => {
  assert.equal(processJob.shareOf(0), processJob.GAME_CPU_PERCENT);
  assert.equal(processJob.shareOf(1), processJob.GAME_CPU_PERCENT);
  assert.equal(processJob.shareOf(4) * 4, processJob.GAME_CPU_PERCENT);
});

test('however many tasks are running, each keeps enough to answer', () => {
  assert.equal(processJob.shareOf(100), processJob.MIN_JOB_PERCENT);
});

test('giving way with no tasks running does nothing', () => {
  processJob.giveWay(true);
  processJob.giveWay(true);
  processJob.giveWay(false);
  assert.equal(processJob.givingWay(), false);
});

test('no pid, no job', () => {
  assert.equal(processJob.adopt(undefined), null);
  assert.equal(processJob.adopt(0), null);
});

test("leaves the user's own apps running", () => {
  for (const app of ['chrome.exe', 'msedge.exe', 'firefox.exe', 'explorer.exe', 'code.exe']) assert.ok(processJob.KEEP.has(app), app);
  for (const tool of ['node.exe', 'python.exe', 'cmd.exe', 'uvx.exe', 'electron.exe', 'shellby.exe']) assert.ok(!processJob.KEEP.has(tool), tool);
});
