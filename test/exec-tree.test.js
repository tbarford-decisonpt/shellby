// execFileTree (src/main/exec-tree.js): a timeout ends what the program started
// too, which execFile's own timeout leaves running (git -> git-remote-https).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileTree } = require('../src/main/exec-tree');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 50)); }
  return true;
}

test('a timeout ends the child the program started, and says it was killed', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-exectree-'));
  const pidFile = path.join(dir, 'kid.pid');
  const kid = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(kid)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  let kidPid = 0;
  try {
    const err = await new Promise(resolve => execFileTree(process.execPath, ['-e', parent], { timeout: 1500, windowsHide: true }, e => resolve(e)));
    kidPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(err?.killed, 'the error says it was killed');
    assert.ok(await until(() => !alive(kidPid)), 'the grandchild is gone too');
  } finally {
    if (kidPid && alive(kidPid)) process.kill(kidPid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a timeout it is plain execFile: output and errors pass through', async () => {
  const out = await new Promise(resolve => execFileTree(process.execPath, ['-e', 'process.stdout.write("hi")'], { encoding: 'utf8' }, (e, so) => resolve([e, so])));
  assert.deepEqual(out, [null, 'hi']);
  const failed = await new Promise(resolve => execFileTree(process.execPath, ['-e', 'process.exit(2)'], {}, e => resolve(e)));
  assert.equal(failed.code, 2);
  assert.ok(!failed.killed);
});
