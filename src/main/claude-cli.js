// Finds the Claude Code CLI and reports install/auth state for onboarding.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Env vars that would route the CLI to API-key billing or another provider.
// Shellby always runs Claude Code on the user's own claude.ai login.
const BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

function subscriptionEnv(base = process.env) {
  const env = { ...base };
  for (const k of BILLING_ENV) delete env[k];
  // Our own sessions tell the Shellby Claude Code plugin's hooks not to report
  // back to us (their tabs already drive the crab).
  env.SHELLBY_OWNED = '1';
  return env;
}

function candidatePaths(env = process.env) {
  const list = [];
  if (env.SHELLBY_CLAUDE_PATH) list.push(env.SHELLBY_CLAUDE_PATH);
  if (env.APPDATA) list.push(path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  if (env.USERPROFILE) list.push(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, 'claude.exe'));
  }
  return list;
}

function findClaude(env = process.env) {
  return candidatePaths(env).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// opts.cwd: where the CLI runs (it resolves relative arguments there).
function run(exe, args, timeout = 15000, { cwd } = {}) {
  return new Promise(resolve => {
    let timedOut = false;
    // Plugin catalogs can be several MB of JSON; the 1 MB default would truncate them.
    const child = execFile(exe, args, { env: subscriptionEnv(), windowsHide: true, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      resolve({ ok: !err && !timedOut, stdout: String(stdout || ''), stderr: String(stderr || ''), err: err || (timedOut ? new Error('timed out') : null), timedOut });
    });
    // Our own timeout: kill the whole tree while claude is still alive (a plugin
    // install may be running git; execFile's timeout would only kill claude.exe).
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        child.kill('SIGKILL');
      }
    }, timeout);
  });
}

// { installed, exe, version, loggedIn, authMethod, subscriptionType, email, warning }
async function checkStatus() {
  const exe = findClaude();
  if (!exe) return { installed: false };
  const ver = await run(exe, ['--version']);
  const version = (ver.stdout.match(/\d+\.\d+\.\d+/) || [null])[0];
  const auth = await run(exe, ['auth', 'status', '--json']);
  let info = {};
  try { info = JSON.parse(auth.stdout); } catch { /* not logged in or old CLI */ }
  const status = {
    installed: true, exe, version,
    loggedIn: !!info.loggedIn,
    authMethod: info.authMethod || null,
    subscriptionType: info.subscriptionType || null,
    email: info.email || null,
  };
  if (status.loggedIn && status.authMethod && status.authMethod !== 'claude.ai') {
    status.warning = `Claude Code is signed in with "${status.authMethod}", which bills per token. Sign in with your Claude account to use your subscription.`;
  }
  return status;
}

module.exports = { findClaude, checkStatus, subscriptionEnv, candidatePaths, run, BILLING_ENV };
