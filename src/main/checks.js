// Turn checks: run the project's own tests after a turn, and say how it went
// on the turn's diff.
//
// Claude says "all tests pass" a lot. This is Shellby checking for himself:
// the package.json `test` script (and a typecheck or build, if there is one),
// or `cargo test` / `go test ./...` / pytest in projects that are obviously
// those, run in the tab's folder with a time limit.
//
// What runs is never text from the project or the renderer. package.json comes
// from a repository anyone could have written, so only a script's *name* gets
// through, and only when it passes devservers/scripts.js's SCRIPT_RE; the rest
// of every command line is fixed here. isSafeCommand() checks the finished
// line again before cmd.exe ever sees it.
//
// The pickers and the verdict are pure; detect() reads a few files and run()
// spawns, and neither throws.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CMD, TASKKILL } = require('./system32');
const scripts = require('./devservers/scripts');
const { hasTests } = require('./depwatch');
const flaky = require('./flaky');

const DEFAULT_TIMEOUT_MIN = 5;
const TIMEOUTS_MIN = Object.freeze([2, 5, 10, 20]);
const MAX_OUTPUT = 512 * 1024;     // kept per command, from the end: failures print last
const TAIL_LINES = 40;
const MAX_TAIL_LINE = 300;
const MAX_FAILED_SHOWN = 20;
const MAX_PKG_BYTES = 512 * 1024;
const STATUSES = Object.freeze(['pass', 'fail', 'error', 'timeout']);
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// Commands that aren't a package.json script: exactly these, nothing else.
const FIXED = Object.freeze({
  cargo: 'cargo test',
  go: 'go test ./...',
  pytest: 'python -m pytest -q',
});
const SCRIPT_CMD_RE = /^(npm|pnpm|yarn|bun) run [A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/** Is this a command line checks.js would have built? Anything else never runs. */
function isSafeCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.length > 100) return false;
  return SCRIPT_CMD_RE.test(cmd) || Object.values(FIXED).includes(cmd);
}

function parseJson(text) {
  try { const v = JSON.parse(String(text || '')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/**
 * package.json text + the folder's file names -> the commands to run, in order.
 * The test script (not npm's "no test specified" placeholder), then one of
 * typecheck or build: enough to say "it works", not a whole CI pipeline. Pure.
 */
function pickFromPackage(pkgText, files = []) {
  const pkg = parseJson(pkgText);
  const raw = pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : null;
  if (!raw) return [];
  const manager = scripts.managerOf(files);
  const has = name => typeof raw[name] === 'string' && raw[name].trim() && scripts.SCRIPT_RE.test(name);
  const out = [];
  if (hasTests(pkgText)) out.push(scripts.commandFor(manager, 'test'));
  const second = ['typecheck', 'type-check', 'check-types', 'tsc'].find(has) || (has('build') ? 'build' : null);
  if (second) out.push(scripts.commandFor(manager, second));
  return out.filter(isSafeCommand);
}

/** pyproject.toml / setup.cfg text says pytest is set up here. Pure. */
const usesPytest = ({ pyproject = '', setupCfg = '', hasIni = false } = {}) =>
  !!hasIni || /^\s*\[tool\.pytest(\.ini_options)?\]/m.test(String(pyproject)) || /^\s*\[tool:pytest\]/m.test(String(setupCfg));

/**
 * What a folder holds -> the commands to run. A Node project wins over the
 * rest (a repo with both usually tests through npm). Pure.
 *   facts: { pkgText, files: [names], pyproject, setupCfg }
 */
function pickCommands({ pkgText = null, files = [], pyproject = '', setupCfg = '' } = {}) {
  const names = new Set(files);
  if (pkgText != null) {
    const fromPkg = pickFromPackage(pkgText, names);
    if (fromPkg.length) return fromPkg;
  }
  if (names.has('Cargo.toml')) return [FIXED.cargo];
  if (names.has('go.mod')) return [FIXED.go];
  if (usesPytest({ pyproject, setupCfg, hasIni: names.has('pytest.ini') })) return [FIXED.pytest];
  return [];
}

function readSmall(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_PKG_BYTES ? fs.readFileSync(file, 'utf8') : null;
  } catch { return null; }
}

/** A folder -> the commands its checks are. [] when there's nothing to run. Never throws. */
function detect(dir) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return [];
    const files = fs.readdirSync(dir);
    return pickCommands({
      pkgText: files.includes('package.json') ? readSmall(path.join(dir, 'package.json')) : null,
      files,
      pyproject: files.includes('pyproject.toml') ? readSmall(path.join(dir, 'pyproject.toml')) || '' : '',
      setupCfg: files.includes('setup.cfg') ? readSmall(path.join(dir, 'setup.cfg')) || '' : '',
    });
  } catch { return []; }
}

/** The last few lines of a command's output, colour codes out. Pure. */
function tailOf(output, n = TAIL_LINES) {
  const lines = String(output || '').replace(ANSI_RE, '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-n).map(l => (l.length > MAX_TAIL_LINE ? `${l.slice(0, MAX_TAIL_LINE)}…` : l)).join('\n');
}

/**
 * One finished command -> { cmd, ok, durationMs, failed, tail, timedOut?, error? }. Pure.
 * The exit code is the truth (it's our own run, nothing masks it); the output
 * is only read for which tests failed (flaky.js knows the runners' formats).
 */
function commandVerdict({ cmd, exitCode = null, timedOut = false, error = null, output = '', durationMs = 0 }) {
  const ok = !timedOut && !error && exitCode === 0;
  const failed = ok ? [] : flaky.parse(output, cmd).failed.slice(0, MAX_FAILED_SHOWN);
  return {
    cmd, ok, durationMs: Math.max(0, Math.round(durationMs) || 0), failed, tail: tailOf(output),
    ...(timedOut ? { timedOut: true } : {}), ...(error ? { error: String(error).slice(0, 200) } : {}),
  };
}

/** The whole run -> its status: a timeout or a command that wouldn't start says so over a plain fail. Pure. */
function statusOf(commands) {
  if (commands.some(c => c.timedOut)) return 'timeout';
  if (commands.some(c => c.error)) return 'error';
  return commands.every(c => c.ok) ? 'pass' : 'fail';
}

/**
 * The item noted into the tab. after: the turn's tree it stamps; tree: the
 * folder as the checks found it (not the same when it moved on since). Pure.
 */
function buildVerdict(results, { after, root, tree = null, at = Date.now() } = {}) {
  const commands = (results || []).map(commandVerdict);
  return {
    kind: 'checks', after, root, tree, at,
    status: commands.length ? statusOf(commands) : 'error',
    commands,
    durationMs: commands.reduce((n, c) => n + c.durationMs, 0),
  };
}

/** How many tests failed, as far as can be told, and their names. Pure. */
function failingOf(verdict) {
  const names = [...new Set((verdict?.commands || []).flatMap(c => c.failed || []))];
  const broken = (verdict?.commands || []).filter(c => !c.ok).length;
  return { names, count: names.length || broken };
}

/**
 * Before bringing a copy home. -> 'skip' | 'reuse' | 'run'. Pure.
 *   gate: checking is on (the setting, or ticked for this one)
 *   force: "Bring it home anyway"
 *   commands: what detect() found; none means nothing to say
 *   last: the tab's last verdict ({ tree, status }); tree: the folder now
 */
function homeGate({ gate, force, commands, last, tree }) {
  if (!gate || force || !commands?.length) return 'skip';
  if (last && tree && last.tree === tree && STATUSES.includes(last.status) && last.status !== 'error' && last.status !== 'timeout') return 'reuse';
  return 'run';
}

/** A gate's verdict -> carry on, or stop and say so. Pure. */
function gatePasses(verdict) {
  return !verdict || verdict.status === 'pass';
}

/** "2 tests failing", for a red gate. c: failingOf's names plus the status. Pure. */
function redHeadline(c) {
  if (c?.status === 'timeout') return 'The checks ran out of time';
  const n = c?.names?.length || 0;
  return n ? `${n} test${n === 1 ? '' : 's'} failing` : 'The checks failed';
}

/** A follow-up asking Claude to fix what failed, quoting it. Pure. */
function fixPrompt(verdict, { branch = null } = {}) {
  const { names } = failingOf(verdict);
  const bad = (verdict?.commands || []).filter(c => !c.ok);
  const lines = [`The checks failed${branch ? ` on ${branch}` : ''} before bringing it home.`];
  for (const c of bad) {
    lines.push('', `\`${c.cmd}\` ${c.timedOut ? 'ran out of time' : 'failed'}${c.failed?.length ? `: ${c.failed.slice(0, 10).join(', ')}` : ''}.`);
    if (c.tail) lines.push('```', c.tail.split('\n').slice(-20).join('\n'), '```');
  }
  lines.push('', `Fix ${names.length ? 'them' : 'it'}, run the checks again to be sure, and commit. Then tell me it's ready to bring home.`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ trusting a project

// A project's checks run its own scripts, so the first time in each project
// you say yes (or no) once. Kept by the clone's root: a copy of it counts too.
const MAX_TRUSTED = 200;
const projectKey = root => (typeof root === 'string' && path.isAbsolute(root) ? path.resolve(root).toLowerCase() : null);

/** -> true (yes), false (said no), or null (never asked). Pure. */
function trustOf(store, root) {
  const k = projectKey(root);
  const v = k && store && typeof store === 'object' && !Array.isArray(store) ? store[k] : undefined;
  return v === true || v === false ? v : null;
}

/** The store with this project's answer, newest kept when it's full. Pure. */
function withTrust(store, root, yes) {
  const k = projectKey(root);
  const kept = Object.entries(store && typeof store === 'object' && !Array.isArray(store) ? store : {})
    .filter(([key, v]) => key !== k && typeof v === 'boolean');
  if (!k) return Object.fromEntries(kept);
  return Object.fromEntries([...kept.slice(-(MAX_TRUSTED - 1)), [k, !!yes]]);
}

// ------------------------------------------------------------------ running

// A project's tests are the project's own code, so they get only what a test
// run needs from Shellby's environment: where Windows and the toolchains are,
// and nothing that signs in anywhere (no ANTHROPIC_*, GITHUB_TOKEN, keys).
const ENV_ALLOW = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ',
  'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME', 'FNM_DIR', 'PNPM_HOME', 'BUN_INSTALL',
  'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'YARN_CACHE_FOLDER',
  'GOPATH', 'GOROOT', 'GOCACHE', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYENV', 'PYENV_ROOT', 'PYENV_HOME', 'JAVA_HOME',
]);
const ENV_DENY_RE = /^ANTHROPIC_|^CLAUDE|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(^|_)KEY$|_KEY_|APIKEY|AUTH/i;

/** Shellby's environment -> the one a check runs with. Pure. */
function checkEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string' || !ENV_ALLOW.has(k.toUpperCase()) || ENV_DENY_RE.test(k)) continue;
    out[k] = v;
  }
  return { ...out, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', NoDefaultCurrentDirectoryInExePath: '1' };
}

/**
 * Run one checked command in a folder. -> { promise, cancel }.
 * cmd.exe runs it (npm is npm.cmd), with the command fixed and checked; /d: no
 * AutoRun. NoDefaultCurrentDirectoryInExePath: the project's own npm.cmd or
 * node.exe never stands in for the real one. CI=1 keeps a watch-mode runner
 * from waiting forever. A timeout or cancel ends the whole tree (taskkill /T).
 */
function runCommand(cmd, cwd, { timeoutMs = DEFAULT_TIMEOUT_MIN * 60000, spawnImpl = spawn, killImpl = killTree } = {}) {
  let child = null;
  let finish = null;
  let ended = false;
  const startedAt = Date.now();
  const promise = new Promise(resolve => { finish = resolve; });
  const done = r => { if (ended) return; ended = true; clearTimeout(timer); finish({ cmd, durationMs: Date.now() - startedAt, ...r }); };
  let out = '';
  const take = chunk => { out += chunk.toString('utf8'); if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT); };
  const timer = setTimeout(() => { if (child?.pid) killImpl(child.pid); done({ timedOut: true, output: out.slice(-MAX_OUTPUT) }); }, timeoutMs);
  if (!isSafeCommand(cmd)) { done({ error: 'Not a check Shellby knows how to run.' }); return { promise, cancel: () => {} }; }
  try {
    child = spawnImpl(CMD, ['/d', '/s', '/c', `"${cmd}"`], {
      cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: checkEnv(process.env),
    });
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', e => done({ error: e.message, output: out.slice(-MAX_OUTPUT) }));
    child.on('close', code => done({ exitCode: code, output: out.slice(-MAX_OUTPUT) }));
  } catch (e) {
    done({ error: e.message });
  }
  return {
    promise,
    cancel: () => { if (ended) return; if (child?.pid) killImpl(child.pid); done({ cancelled: true, output: out.slice(-MAX_OUTPUT) }); },
  };
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {}); } catch { /* gone already */ }
}

/**
 * Run every command in turn (they share a folder, so never side by side).
 * -> { promise: Promise<{ results, cancelled }>, cancel }. Stops at a cancel; a
 * failing command doesn't stop the next (a broken typecheck is worth knowing
 * about alongside failing tests).
 */
function runAll(commands, cwd, opts = {}) {
  let current = null;
  let cancelled = false;
  const promise = (async () => {
    const results = [];
    for (const cmd of commands) {
      if (cancelled) break;
      current = runCommand(cmd, cwd, opts);
      const r = await current.promise;
      if (r.cancelled) { cancelled = true; break; }
      results.push(r);
    }
    return { results, cancelled };
  })();
  return { promise, cancel: () => { cancelled = true; current?.cancel(); } };
}

/** The setting's minutes -> ms, kept to the choices offered. Pure. */
const timeoutMs = minutes => (TIMEOUTS_MIN.includes(minutes) ? minutes : DEFAULT_TIMEOUT_MIN) * 60000;

module.exports = {
  DEFAULT_TIMEOUT_MIN, TIMEOUTS_MIN, STATUSES, FIXED, TAIL_LINES,
  isSafeCommand, pickFromPackage, pickCommands, usesPytest, detect,
  tailOf, commandVerdict, statusOf, buildVerdict, failingOf, homeGate, gatePasses, redHeadline, fixPrompt,
  projectKey, trustOf, withTrust, checkEnv, runCommand, runAll, timeoutMs,
};
