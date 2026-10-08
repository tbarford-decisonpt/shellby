// Does this Claude Code still work with Shellby? Checks the installed CLI
// against what Shellby relies on (src/main/cli-contract.js), with no Electron.
// Run nightly against the newest release by .github/workflows/cli-compat.yml.
//
//   node scripts/cli-compat.js [--out report.json] [--summary summary.md]
//                              [--real] [--transcript file.jsonl]
//                              [--badge-dir dir]
//
// Without an account it checks the flags, permission modes, effort levels and
// the control protocol's handshake (Claude Code answers initialize before
// sign-in). With ANTHROPIC_API_KEY set, or --real on a signed-in machine, it
// also runs one tiny real turn on Haiku with a Write permission round trip and
// audits every event it sent; --transcript keeps that turn, scrubbed (how
// test/fixtures/cli-transcripts/ is recorded). --badge-dir reads the last
// cli-compat-state.json there and writes the README badge's shields.io
// endpoint (cli-compat.json) beside the new state.
//
// The CLI: SHELLBY_CLAUDE_PATH (claude.exe, or npm's claude.cmd shim, which is
// swapped for the claude.exe beside it), else the global npm install, else
// wherever Shellby itself would find it. Exits 1 on a real incompatibility.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, execFile, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { findClaude, claudeEnv, run } = require('../src/main/claude-cli');
const processJob = require('../src/main/process-job');
const { TASKKILL } = require('../src/main/system32');
const { ClaudeSession, initHooks } = require('../src/main/session');
const contract = require('../src/main/cli-contract');

const QUICK_MS = 30000;
const LAUNCH_MS = 60000;
const TURN_MS = 240000;
const STOP_GRACE_MS = 5000;
const BOGUS = 'shellby-not-a-value';
const PKG_EXE = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];
// What a CLI that wants an account before it does anything says.
const NEEDS_SIGN_IN = /not logged in|log ?in|sign ?in|api key|authenticat|unauthori[sz]ed|credentials/i;
// An API outage, not a CLI change: the real turn is skipped rather than failed.
const API_TROUBLE = /\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|socket hang up/i;

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const flag = name => argv.includes(name);

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
// Windows runners hand out 8.3 temp paths (RUNNER~1), and the CLI may use the
// long form: the folders are compared as the file system resolves them.
const realDir = p => { try { return fs.realpathSync.native(path.dirname(p)).toLowerCase(); } catch { return null; } };
const samePath = (a, b) => !!a && path.basename(a).toLowerCase() === path.basename(b).toLowerCase() && realDir(a) !== null && realDir(a) === realDir(b);

function resolveClaude(env = process.env) {
  const given = env.SHELLBY_CLAUDE_PATH;
  if (given) {
    // An npm shim (claude.cmd, or the extensionless sh one): its JSON-laden
    // arguments wouldn't survive cmd.exe's quoting, so run what it runs.
    if (/\.(cmd|bat|ps1)$/i.test(given) || !path.extname(given)) {
      const exe = path.join(path.dirname(given), ...PKG_EXE);
      if (isFile(exe)) return exe;
      if (/\.(cmd|bat|ps1)$/i.test(given)) throw new Error(`${given} is a shim and there's no claude.exe beside it: point SHELLBY_CLAUDE_PATH at claude.exe.`);
    }
    return given;
  }
  try {
    const prefix = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true }).trim();
    const exe = path.join(prefix, ...PKG_EXE);
    if (isFile(exe)) return exe;
  } catch { /* no npm on PATH: fall through */ }
  return findClaude(env);
}

// The arguments Shellby really launches with, from the class that builds them.
function shellbyArgs(opts = {}) {
  return new ClaudeSession({ exe: 'claude', cwd: os.tmpdir(), mode: 'ask', ...opts }).buildArgs();
}

const initialize = () => ({
  type: 'control_request', request_id: randomUUID(),
  request: { subtype: 'initialize', hooks: initHooks(true) },
});

/**
 * A long-lived stream-json process, the way session.js runs one. Every stdout
 * line is kept; onEvent sees each parsed one and may write back.
 */
function launch(exe, args, { cwd, onEvent = () => {} } = {}) {
  const proc = spawn(exe, args, { cwd, env: claudeEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Hooks, shells and MCP servers it starts end with it (process-job.js).
  const job = processJob.adopt(proc.pid);
  proc.once('exit', () => processJob.sweep(job));
  const lines = [];
  let stderr = '';
  const write = obj => { if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(obj)}\n`); };
  const exited = new Promise(resolve => {
    proc.on('error', err => resolve({ code: null, error: err.message }));
    proc.on('close', code => resolve({ code, error: null }));
  });
  proc.stdin.on('error', () => { /* gone: 'close' says so */ });
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    lines.push(line);
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    onEvent(ev, write);
  });
  const stop = () => {
    try { proc.stdin.end(); } catch { /* gone */ }
    setTimeout(() => {
      if (proc.exitCode !== null) return;
      if (processJob.sweep(job)) return;
      if (process.platform === 'win32') execFile(TASKKILL, ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else proc.kill();
    }, STOP_GRACE_MS).unref();
  };
  return { proc, lines, write, exited, stop, stderr: () => stderr };
}

// ---------------------------------------------------------------- checks

async function checkVersion(exe) {
  const r = await run(exe, ['--version'], QUICK_MS);
  const version = (r.stdout.match(/\d+\.\d+\.\d+/) || [null])[0];
  return { version, check: { name: 'version', ok: !!version, detail: version ? `claude ${version}` : `no version from --version: ${(r.stderr || r.err?.message || '').trim().slice(0, 300)}` } };
}

async function checkHelpText(exe) {
  const r = await run(exe, ['--help'], QUICK_MS);
  const { ok, missing } = contract.checkHelp(r.stdout);
  return { name: 'flags in --help', ok, detail: ok ? `all ${contract.REQUIRED_FLAGS.filter(f => !f.hidden).length} documented flags present` : `missing: ${missing.join(', ')}` };
}

// Claude Code checks a flag's value while it reads the command line, before
// --version answers, so this costs no session. A made-up value goes first: if
// that isn't refused, the CLI stopped checking this way and a pass would mean
// nothing.
async function checkValues(exe, name, flagName, values) {
  const refusal = async v => {
    const r = await run(exe, [flagName, v, '--version'], QUICK_MS);
    return contract.flagRejected(`${r.stdout}\n${r.stderr}`) || (r.ok ? null : (r.stderr || r.err?.message || 'failed').trim().slice(0, 200));
  };
  if (!(await refusal(BOGUS))) return { name, ok: false, detail: `can't tell: ${flagName} ${BOGUS} --version wasn't refused either` };
  const refused = [];
  for (const v of values) {
    const why = await refusal(v);
    if (why) refused.push(`${v} (${why})`);
  }
  return { name, ok: refused.length === 0, detail: refused.length ? `refused: ${refused.join('; ')}` : `accepts ${values.join(', ')}` };
}

// Every flag at once, the hidden ones too. A conversation that doesn't exist
// makes it stop right after reading them, with no account needed.
async function checkLaunchFlags(exe, cwd) {
  const args = shellbyArgs({
    model: 'haiku', effort: 'low', outputStyle: 'default', resumeId: randomUUID(), resumeAt: randomUUID(),
    allowedTools: ['mcp__none__*'], mcpConfig: { mcpServers: {} },
  });
  const r = await run(exe, args, LAUNCH_MS, { cwd });
  const why = contract.flagRejected(`${r.stdout}\n${r.stderr}`);
  // Taking them means getting as far as saying, in stream-json, that there's
  // no such conversation.
  const spoke = r.stdout.split('\n').some(l => { try { return JSON.parse(l)?.type === 'result'; } catch { return false; } });
  let detail = `took ${contract.flagsIn(args).join(' ')}`;
  if (why) detail = why;
  else if (r.timedOut) detail = 'timed out reading its own flags';
  else if (!spoke) detail = `no stream-json result: ${(r.stderr || r.stdout).trim().slice(-300) || 'no output'}`;
  return { name: 'launch flags', ok: !why && !r.timedOut && spoke, detail };
}

async function checkHandshake(exe, cwd) {
  const req = initialize();
  let resolveAnswer;
  const answer = new Promise(r => { resolveAnswer = r; });
  const p = launch(exe, shellbyArgs(), {
    cwd,
    onEvent: ev => { if (ev.type === 'control_response' && ev.response?.request_id === req.request_id) resolveAnswer(ev.response); },
  });
  p.write(req);
  const timer = new Promise(r => setTimeout(() => r('timeout'), LAUNCH_MS).unref());
  const got = await Promise.race([answer, p.exited.then(() => 'exited'), timer]);
  p.stop();
  await p.exited;
  if (got && typeof got === 'object') {
    const ok = got.subtype === 'success';
    return { name: 'control protocol (initialize)', ok, detail: ok ? `answered with ${Object.keys(got.response || {}).length} fields` : `refused: ${String(got.error || got.subtype).slice(0, 200)}` };
  }
  const said = `${p.stderr()}\n${p.lines.join('\n')}`.trim();
  if (NEEDS_SIGN_IN.test(said)) return { name: 'control protocol (initialize)', ok: true, skipped: true, detail: 'skipped (needs sign-in)' };
  return { name: 'control protocol (initialize)', ok: false, detail: `${got === 'timeout' ? 'no answer' : 'exited without answering'}: ${said.slice(-300) || 'no output'}` };
}

// One tiny real turn: Haiku writes a file (Shellby approves the Write over the
// control protocol, as a person would), then says ok.
async function realTurn(exe, cwd) {
  const target = path.join(cwd, 'shellby-compat.txt');
  let permission = false;
  let resolveResult;
  const result = new Promise(r => { resolveResult = r; });
  const p = launch(exe, shellbyArgs({ model: 'haiku' }), {
    cwd,
    onEvent: (ev, write) => {
      if (ev.type === 'control_request') {
        const r = ev.request || {};
        if (r.subtype === 'can_use_tool') {
          // Only the one write it was asked for: anything else is turned down.
          const asked = r.tool_name === 'Write' && samePath(String(r.input?.file_path || ''), target);
          if (asked) permission = true;
          const response = asked ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: 'Only the one Write is allowed in this check.' };
          write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response } });
        } else {
          write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: {} } });
        }
      }
      if (ev.type === 'result') resolveResult(ev);
    },
  });
  p.write(initialize());
  p.write({ type: 'user', message: { role: 'user', content: `Use the Write tool to create the file ${target} containing the word ok. Then reply with the single word: ok` } });
  const timer = new Promise(r => setTimeout(() => r(null), TURN_MS).unref());
  const res = await Promise.race([result, p.exited.then(() => null), timer]);
  p.stop();
  await p.exited;
  const audit = contract.auditEvents(p.lines, { expect: [...contract.EXPECTED_KINDS, 'permission', 'tool', 'tool_result'] });
  const wrote = isFile(target);
  // An API that's down or overloaded tonight says nothing about the CLI.
  const outage = res?.is_error && API_TROUBLE.test(`${res.api_error_status ?? ''} ${res.result ?? ''} ${(res.errors || []).join(' ')}`);
  if (outage) {
    return { checks: [{ name: 'real turn', ok: true, skipped: true, detail: `skipped (the API had trouble: ${String(res.result || res.api_error_status).slice(0, 200)})` }], lines: p.lines, unknown: [] };
  }
  const checks = [
    { name: 'real turn', ok: !!res && !res.is_error, detail: res ? `${res.subtype}${res.is_error ? `: ${String(res.result || '').slice(0, 200)}` : ''}, ${res.num_turns} turns` : `no result: ${p.stderr().slice(-300)}` },
    { name: 'Write permission round trip', ok: permission && wrote, detail: `${permission ? 'asked' : 'never asked'}, ${wrote ? 'file written' : 'no file'}` },
    { name: 'every event understood', ok: audit.ok, detail: audit.ok ? `${audit.events} events: ${audit.seen.join(', ')}` : [audit.unknown.length && `unknown: ${audit.unknown.map(u => `${u.type}${u.subtype ? `/${u.subtype}` : ''}`).join(', ')}`, audit.missingKinds.length && `missing: ${audit.missingKinds.join(', ')}`, audit.parseErrors.length && `${audit.parseErrors.length} lines not JSON`].filter(Boolean).join('; ') },
  ];
  return { checks, lines: p.lines, unknown: audit.unknown };
}

// ---------------------------------------------------------------- main

function writeOut(file, text) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text);
}

async function main() {
  const report = { version: null, ok: false, checkedAt: new Date().toISOString(), checks: [], unknown: [] };
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-compat-')));
  // A check that throws is a failed check, and the report is still written.
  const attempt = async (name, fn) => {
    try { return await fn(); } catch (err) { return { name, ok: false, detail: `the check itself failed: ${err?.message || err}` }; }
  };
  try {
    let exe = null;
    try { exe = resolveClaude(); } catch (err) { report.checks.push({ name: 'find claude', ok: false, detail: err.message }); }
    if (exe) {
      report.checks.push({ name: 'find claude', ok: true, detail: path.basename(exe) });
      const { version, check } = await attempt('version', () => checkVersion(exe)).then(r => (r.check ? r : { version: null, check: r }));
      report.version = version;
      report.checks.push(check);
      report.checks.push(await attempt('flags in --help', () => checkHelpText(exe)));
      report.checks.push(await attempt('permission modes', () => checkValues(exe, 'permission modes', '--permission-mode', contract.REQUIRED_MODES)));
      report.checks.push(await attempt('effort levels', () => checkValues(exe, 'effort levels', '--effort', contract.EFFORTS)));
      report.checks.push(await attempt('launch flags', () => checkLaunchFlags(exe, cwd)));
      report.checks.push(await attempt('control protocol (initialize)', () => checkHandshake(exe, cwd)));
      if (process.env.ANTHROPIC_API_KEY || flag('--real')) {
        const turn = await attempt('real turn', () => realTurn(exe, cwd)).then(r => (r.checks ? r : { checks: [r], lines: [], unknown: [] }));
        report.checks.push(...turn.checks);
        report.unknown = turn.unknown;
        const out = opt('--transcript');
        if (out && turn.lines.length) writeOut(out, `${contract.scrubTranscript(turn.lines, { home: os.homedir(), user: os.userInfo().username }).join('\n')}\n`);
      } else {
        report.checks.push({ name: 'real turn', ok: true, skipped: true, detail: 'skipped (no ANTHROPIC_API_KEY)' });
      }
    } else if (!report.checks.length) {
      report.checks.push({ name: 'find claude', ok: false, detail: 'Claude Code is not installed (set SHELLBY_CLAUDE_PATH)' });
    }
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* a leftover temp folder */ }
  }
  report.ok = report.checks.every(c => c.ok || c.skipped);

  writeOut(opt('--out') || 'cli-compat-report.json', `${JSON.stringify(report, null, 2)}\n`);
  const summary = contract.summaryOf(report);
  writeOut(opt('--summary'), `${summary}\n`);
  const badgeDir = opt('--badge-dir');
  if (badgeDir) {
    const stateFile = path.join(badgeDir, 'cli-compat-state.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
    const { badge, state } = contract.badgeFor(report, previous);
    writeOut(path.join(badgeDir, 'cli-compat.json'), `${JSON.stringify(badge, null, 2)}\n`);
    writeOut(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  for (const c of report.checks) console.log(`${c.skipped ? 'skip' : c.ok ? ' ok ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(report.ok ? `\nClaude Code ${report.version} works with Shellby.` : `\nClaude Code ${report.version || '?'}: something Shellby relies on changed.`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
