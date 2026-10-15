// execFile whose timeout ends the whole process tree, not only the program it
// started. execFile's own timeout kills git.exe alone, and whatever git was
// running under it (git-remote-https, a credential helper, an ssh) is left
// going. At the timeout git is still alive, so taskkill /T can walk down from
// it. Same arguments and callback as execFile; on a timeout the error has
// killed: true and signal 'SIGTERM', as execFile's would.
const { execFile } = require('child_process');
const { TASKKILL } = require('./system32');

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import('child_process').ExecFileOptions & { encoding?: string }} opts
 * @param {(err: any, stdout: any, stderr: any) => void} cb
 * @param {{ execFileImpl?: Function, killTree?: (pid: number) => void }} [impl] tests
 */
function execFileTree(file, args, opts, cb, { execFileImpl = execFile, killTree = defaultKillTree } = {}) {
  const { timeout = 0, ...rest } = opts || {};
  let timedOut = false;
  /** @type {any} */
  let timer = null;
  const child = execFileImpl(file, args, rest, (err, stdout, stderr) => {
    clearTimeout(timer);
    if (timedOut) {
      const e = err || new Error(`Command timed out: ${file}`);
      e.killed = true;
      e.signal = e.signal || 'SIGTERM';
      return cb(e, stdout, stderr);
    }
    cb(err, stdout, stderr);
  });
  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child?.pid) killTree(child.pid);
      else child?.kill?.();
    }, timeout);
  }
  return child;
}

function defaultKillTree(pid) {
  execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* gone already */ });
}

module.exports = { execFileTree };
