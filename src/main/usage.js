// Plan usage without sending a prompt. The meter otherwise only moves when a
// turn's rate-limit event arrives (stream.js usageFrom), so usage spent on
// another device stays invisible until you next ask Claude something. This asks
// a short-lived `claude -p` for its /usage data over the control protocol
// (`get_usage`); no message is sent, so it costs nothing against the limit.
//
// get_usage is marked experimental by Claude Code: any surprise reads as null.
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const { randomUUID } = require('crypto');
const { claudeEnv } = require('./claude/cli');

const TIMEOUT_MS = 30_000;
// claude's arguments for the probe; on another computer they go into ssh's script (remote/service.js).
const PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

/** get_usage's response -> the same { kind: 'usage', ... } item a turn produces, or null. */
function fromGetUsage(r) {
  if (!r || !r.rate_limits_available || !r.rate_limits) return null;
  const win = x => (x && Number.isFinite(x.utilization)
    ? { pct: Math.round(x.utilization), resetsAt: Number.isFinite(Date.parse(x.resets_at)) ? Date.parse(x.resets_at) : null }
    : null);
  const fiveHour = win(r.rate_limits.five_hour);
  const sevenDay = win(r.rate_limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { kind: 'usage', status: null, fiveHour, sevenDay };
}

/**
 * Resolves to a usage item, or null if the CLI couldn't say (offline, API key login, old CLI).
 * args/env: the whole command line and environment instead, for ssh to another computer.
 */
function probe({ exe, argsPrefix = [], cwd, timeout = TIMEOUT_MS, args = [...argsPrefix, ...PROBE_ARGS], env = claudeEnv() }) {
  return new Promise(resolve => {
    let proc;
    try {
      proc = spawn(exe, args, {
        cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const id = randomUUID();
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
      try { proc.stdin.end(); } catch { /* ignore */ }
      if (proc.exitCode === null && proc.pid) {
        execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      }
    };
    const timer = setTimeout(() => finish(null), timeout);
    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));
    proc.stdin.on('error', () => { /* process gone; 'close' reports it */ });
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev?.type !== 'control_response' || ev.response?.request_id !== id) return;
      finish(ev.response.subtype === 'success' ? fromGetUsage(ev.response.response) : null);
    });
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}

module.exports = { PROBE_ARGS, fromGetUsage, probe };
