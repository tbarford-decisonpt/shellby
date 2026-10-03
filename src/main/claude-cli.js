// Finds the Claude Code CLI and reports install/auth state for onboarding.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Env vars that would route the CLI to API-key billing or another provider.
// Claude Code gets them as set: how it signs in is the user's call, not ours.
// Only the "Always use my Claude plan" setting (planOnly) leaves them out.
const BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

let planOnly = false;
function setPlanOnly(on) { planOnly = !!on; }

// Which of BILLING_ENV are set here, so Settings can say what Claude Code will bill.
function billingEnv(base = process.env) {
  return BILLING_ENV.filter(k => base[k]);
}

function claudeEnv(base = process.env, { onlyPlan = planOnly } = {}) {
  const env = { ...base };
  if (onlyPlan) for (const k of BILLING_ENV) delete env[k];
  // Our own sessions tell the Shellby Claude Code plugin's hooks not to report
  // back to us (their tabs already drive the crab).
  env.SHELLBY_OWNED = '1';
  return env;
}

// configured: a path the user picked in Settings when the search below missed
// (unusual installs, a portable copy, a drive we'd never guess). It's tried
// first, but it is not trusted to exist — findClaude still checks.
function candidatePaths(env = process.env, configured = null) {
  const list = [];
  if (env.SHELLBY_CLAUDE_PATH) list.push(env.SHELLBY_CLAUDE_PATH);
  if (typeof configured === 'string' && configured) list.push(configured);
  if (env.APPDATA) list.push(path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  if (env.USERPROFILE) list.push(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, 'claude.exe'));
  }
  return list;
}

function findClaude(env = process.env, configured = null) {
  return candidatePaths(env, configured).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/**
 * Is this file actually the Claude Code CLI? Used before saving a path the user
 * picked by hand, so "I chose the wrong exe" is answered then and there rather
 * than becoming a task that won't start.
 * @returns {Promise<{ ok: true, exe: string, version: string|null } | { ok: false, error: string }>}
 */
async function verifyClaude(file) {
  if (typeof file !== 'string' || !file) return { ok: false, error: 'No file chosen.' };
  try { if (!fs.statSync(file).isFile()) return { ok: false, error: "That's a folder, not the Claude Code program." }; } catch { return { ok: false, error: "That file isn't there any more." }; }
  const ver = await run(file, ['--version'], 20000);
  const version = (ver.stdout.match(/\d+\.\d+\.\d+/) || [null])[0];
  if (!ver.ok || !version) {
    return { ok: false, error: `That doesn't look like Claude Code — ${path.basename(file)} didn't report a version.` };
  }
  return { ok: true, exe: file, version };
}

// opts.cwd: where the CLI runs (it resolves relative arguments there).
// Always resolves: a file Windows refuses to execute at all (a .txt chosen in
// the file picker, say) makes execFile throw synchronously with EFTYPE rather
// than calling back, and that used to escape as a rejected promise.
function run(exe, args, timeout = 15000, { cwd } = {}) {
  return new Promise(resolve => {
    let timedOut = false;
    let child;
    try {
      // Plugin catalogs can be several MB of JSON; the 1 MB default would truncate them.
      child = execFile(exe, args, { env: claudeEnv(), windowsHide: true, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        clearTimeout(timer);
        resolve({ ok: !err && !timedOut, stdout: String(stdout || ''), stderr: String(stderr || ''), err: err || (timedOut ? new Error('timed out') : null), timedOut });
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: '', err, timedOut: false });
      return;
    }
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

// { installed, exe, version, loggedIn, authMethod, subscriptionType, email, planOnly, billingEnv, warning, picked }
// configured: the path the user chose in Settings, if any (see candidatePaths).
async function checkStatus({ configured = null } = {}) {
  const exe = findClaude(process.env, configured);
  if (!exe) return { installed: false };
  const ver = await run(exe, ['--version']);
  const version = (ver.stdout.match(/\d+\.\d+\.\d+/) || [null])[0];
  const auth = await run(exe, ['auth', 'status', '--json']);
  let info = {};
  try { info = JSON.parse(auth.stdout); } catch { /* not logged in or old CLI */ }
  const status = {
    installed: true, exe, version,
    picked: !!configured && exe === configured, // Settings shows where it came from
    loggedIn: !!info.loggedIn,
    authMethod: info.authMethod || null,
    subscriptionType: info.subscriptionType || null,
    email: info.email || null,
    planOnly,
    billingEnv: planOnly ? [] : billingEnv(),
  };
  if (status.billingEnv.length) {
    status.warning = `${status.billingEnv.join(', ')} ${status.billingEnv.length > 1 ? 'are' : 'is'} set on this PC, so Claude Code may bill that instead of your Claude plan. Turn on "Always use my Claude plan" in Settings to ignore ${status.billingEnv.length > 1 ? 'them' : 'it'}.`;
  } else if (status.loggedIn && status.authMethod && status.authMethod !== 'claude.ai') {
    status.warning = `Claude Code is signed in with "${status.authMethod}", which bills per token. Sign in with your Claude account to use your subscription.`;
  }
  return status;
}

module.exports = { findClaude, verifyClaude, checkStatus, claudeEnv, billingEnv, setPlanOnly, candidatePaths, run, BILLING_ENV };
