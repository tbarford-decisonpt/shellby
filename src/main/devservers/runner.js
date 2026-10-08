// Starting, watching and stopping one dev server.
//
// A server outlives Shellby (unless you chose otherwise), so it is not a piped
// child: quitting would close its pipes, and a Node server dies on its next
// write. Instead cmd.exe runs it detached (launch.js), writing to a log file
// of its own, and Shellby reads that file. The same reading works for a server
// started this session and for one picked back up after Shellby restarts.
//
// cmd writes the exit code into the log when the server ends
// ("[shellby-exit 1]", output.js), so Shellby learns how it ended even if it
// wasn't running when it did. The pid Shellby tracks is that cmd's, and it is
// only trusted together with its start time (native-windows.processInfo):
// pids are reused, and a reused one must never be taken for, or stopped as,
// the server.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { CMD, TASKKILL } = require('../system32');
const native = require('./launch');

const READ_CHUNK = 256 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOG_BYTES = 1024 * 1024;
const REATTACH_BYTES = 64 * 1024;
const START_SLACK_MS = 3000;           // how far a pid's start time may be from the one recorded

/**
 * cmd's whole command line: the command, then the exit marker on a line of its
 * own. `&` runs the marker whatever the command did (`&&`/`||` inside it
 * bind tighter), and control comes back after a batch file like npm.cmd.
 * `call` expands %errorlevel% only once the command has finished; the caret
 * keeps cmd from expanding it while it reads the line. /d: no AutoRun
 * commands. /s /c "…": the command exactly as given.
 */
function commandLine(command, cmd = CMD) {
  return `"${cmd}" /d /s /c "${command} & echo(& call echo [shellby-exit %^errorlevel%]"`;
}

/**
 * Start `command` in `root`, output appended to `logFile` (a fresh one).
 * -> { ok: true, pid } | { ok: false, error }. Never throws.
 * command: already checked (scripts.commandFor), or a test's own.
 * launchImpl: launch.js's launch, or a test's.
 */
function start({ root, command, logFile, env = {}, launchImpl = native.launch, cmd = CMD }) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, ''); // each run starts its own log
    const r = launchImpl({
      app: cmd,
      commandLine: commandLine(command, cmd),
      cwd: root,
      logFile,
      env: {
        ...process.env,
        // BROWSER=none: no new browser tab on every restart. FORCE_COLOR: a log
        // file isn't a terminal, and some servers are hard to read without
        // colour; output.js strips it again.
        BROWSER: 'none', FORCE_COLOR: '1',
        ...env,
        // cmd looks in the current folder (the project) before PATH, so a
        // repository holding its own npm.cmd or node.exe would run that
        // instead. This tells cmd, and every program under it, not to.
        NoDefaultCurrentDirectoryInExePath: '1',
      },
    });
    if (!r?.pid) return { ok: false, error: "The server couldn't be started." };
    return { ok: true, pid: r.pid };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Is this still the process we started? info: native processInfo (or a fake).
 * When the start time can't be confirmed the answer is no, so a reused pid is
 * never taken for the server (and never stopped as it). The one exception is
 * a process this session started itself (trustBare), when Windows can't say:
 * then a bare "is that pid there" is the best there is.
 */
function isAlive(pid, createdAt, info, { trustBare = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const i = info(pid);
  if (i == null) {
    if (!trustBare) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  if (!i.alive) return false;
  if (!createdAt || !i.createdAt) return trustBare;
  return Math.abs(i.createdAt - createdAt) <= START_SLACK_MS; // otherwise someone else's now
}

/**
 * End the server and everything it started (cmd -> npm -> node -> esbuild). -> Promise<void>
 * detached: fire taskkill off on its own and don't wait. For quitting: a
 * child of Shellby's is ended with it, and could be cut off mid-tree.
 */
function stop(pid, { execFileImpl = execFile, spawnImpl = spawn, detached = false } = {}) {
  return new Promise(resolve => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve();
    const args = ['/PID', String(pid), '/T', '/F'];
    if (detached) {
      try { spawnImpl(TASKKILL, args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
      return resolve();
    }
    execFileImpl(TASKKILL, args, { windowsHide: true, timeout: 10000 }, () => resolve());
  });
}

/**
 * Reads what a log file gained since last time. A file that shrank (trimmed)
 * is read from where it now ends. One decoder, so a character split across two
 * reads survives.
 */
class LogTail {
  constructor(file, { from = 0 } = {}) {
    this.file = file;
    this.offset = from;
    this.decoder = new StringDecoder('utf8');
  }

  /** Start near the end of an existing log (picking a server back up): the last `bytes`, from a line start. */
  static fromEnd(file, bytes = REATTACH_BYTES) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* not there yet */ }
    const t = new LogTail(file, { from: Math.max(0, size - bytes) });
    t.skipPartial = t.offset > 0;
    return t;
  }

  /** -> the new text ('' when there's none). Never throws. */
  read() {
    let fd = null;
    try {
      const size = fs.statSync(this.file).size;
      if (size < this.offset) { this.offset = size; return ''; }
      if (size === this.offset) return '';
      fd = fs.openSync(this.file, 'r');
      let text = '';
      while (this.offset < size) {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, size - this.offset));
        const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
        if (!n) break;
        this.offset += n;
        text += this.decoder.write(buf.subarray(0, n));
      }
      if (this.skipPartial) {
        this.skipPartial = false;
        const nl = text.search(/\r?\n/);
        text = nl < 0 ? '' : text.slice(nl).replace(/^\r?\n/, '');
      }
      return text;
    } catch {
      return '';
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch { /* gone */ }
    }
  }
}

/**
 * Keep a log from growing without end: past MAX_LOG_BYTES, only the last
 * KEEP_LOG_BYTES stay. The server's handle appends, so its next write lands at
 * the new end. -> true if it trimmed.
 */
function trimLog(file, { max = MAX_LOG_BYTES, keep = KEEP_LOG_BYTES } = {}) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size <= max) return false;
    fd = fs.openSync(file, 'r+');
    const buf = Buffer.alloc(keep);
    const n = fs.readSync(fd, buf, 0, keep, size - keep);
    fs.writeSync(fd, buf, 0, n, 0);
    fs.ftruncateSync(fd, n);
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* gone */ }
  }
}

/** Remove logs older than `maxAgeMs` that no server listed in `keep` (a Set of file paths) uses. */
function cleanLogs(dir, keep, { maxAgeMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!/^srv-[a-z0-9-]+\.log$/.test(name)) continue;
    const file = path.join(dir, name);
    if (keep.has(file)) continue;
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); removed++; }
    } catch { /* in use or gone */ }
  }
  return removed;
}

module.exports = { start, commandLine, stop, isAlive, LogTail, trimLog, cleanLogs, MAX_LOG_BYTES, KEEP_LOG_BYTES };
