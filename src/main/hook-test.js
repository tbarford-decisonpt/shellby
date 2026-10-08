// "Test run" for Toolbox → Hooks: run a hook's command once, the way Claude
// Code would (Git Bash on Windows, the details as JSON on stdin, the project
// folder as its working folder), and say in plain words what Claude Code would
// make of the result.
//
// samplePayload and verdict are pure (test/hook-test.test.js); runHook spawns.
// main.js asks in the confirm window before anything here runs.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { HOOK_EVENTS } = require('./claude-setup');
const { RECIPES } = require('./hook-recipes');

const MAX_OUTPUT = 16 * 1024;      // kept per stream; the panel shows the start of it
const MAX_PAYLOAD = 64 * 1024;
const MAX_TEST_SECONDS = 120;
const EVENT = new Map(HOOK_EVENTS.map(e => [e.name, e]));

// What each tool's input looks like, for a believable sample. {cwd} is filled in.
const TOOL_INPUT = {
  Bash: { command: 'git status', description: 'Show working tree status' },
  Edit: { file_path: '{cwd}/src/app.js', old_string: 'let total = 0', new_string: 'let total = 1' },
  MultiEdit: { file_path: '{cwd}/src/app.js', edits: [{ old_string: 'let total = 0', new_string: 'let total = 1' }] },
  Write: { file_path: '{cwd}/notes.txt', content: 'Hello from a test run.\n' },
  Read: { file_path: '{cwd}/README.md' },
  Glob: { pattern: '**/*.js' },
  Grep: { pattern: 'TODO', path: '{cwd}' },
  WebFetch: { url: 'https://example.com', prompt: 'Summarise the page' },
  WebSearch: { query: 'claude code hooks' },
  Agent: { description: 'Look around', prompt: 'Find where the config is loaded', subagent_type: 'general-purpose' },
  Task: { description: 'Look around', prompt: 'Find where the config is loaded', subagent_type: 'general-purpose' },
};

const fill = (v, cwd) => JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === 'string' ? x.split('{cwd}').join(cwd) : x));

// The first plain tool name in a matcher (Edit|Write -> Edit), else Bash.
function toolFor(matcher) {
  const first = String(matcher || '').split('|').map(s => s.trim()).find(s => TOOL_INPUT[s]);
  return first || 'Bash';
}

/**
 * The JSON Claude Code would send this hook. A recipe's own sample wins (so
 * "Stop force-pushes" is tried on a force-push, not on git status).
 */
function samplePayload({ event, matcher = '', command = '' } = {}, cwd = process.cwd()) {
  const base = { session_id: 'shellby-test-run', transcript_path: '', cwd, permission_mode: 'default', hook_event_name: event };
  const recipe = RECIPES.find(r => r.command === command && r.event === event);
  const firstChoice = String(matcher).split('|')[0].trim();
  let more;
  switch (event) {
    case 'PreToolUse': case 'PermissionRequest': case 'PostToolUse': case 'PostToolUseFailure': {
      const tool = toolFor(matcher);
      more = { tool_name: tool, tool_input: TOOL_INPUT[tool], tool_use_id: 'toolu_test' };
      if (event === 'PostToolUse') more.tool_response = tool === 'Bash' ? { stdout: 'On branch main', stderr: '', interrupted: false } : { success: true };
      if (event === 'PostToolUseFailure') more.error = 'Command failed with exit code 1';
      break;
    }
    case 'UserPromptSubmit': more = { prompt: 'Fix the failing test in src/app.js' }; break;
    case 'Stop': case 'SubagentStop': more = { stop_hook_active: false }; break;
    case 'SessionStart': more = { source: ['startup', 'resume', 'clear', 'compact'].includes(firstChoice) ? firstChoice : 'startup' }; break;
    case 'SessionEnd': more = { reason: 'other' }; break;
    case 'Notification': more = { message: 'Claude needs your permission to use Bash', notification_type: firstChoice === 'idle_prompt' ? 'idle_prompt' : 'permission_prompt' }; break;
    case 'PreCompact': more = { trigger: firstChoice === 'auto' ? 'auto' : 'manual', custom_instructions: '' }; break;
    case 'SubagentStart': more = { agent_id: 'agent_test', agent_type: firstChoice || 'general-purpose' }; break;
    default: more = {};
  }
  return fill({ ...base, ...more, ...(recipe?.sample || {}) }, cwd);
}

/** A payload typed in the panel: a JSON object, not too big. { payload } or { error } */
function parsePayload(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'The test details are empty.' };
  if (text.length > MAX_PAYLOAD) return { error: 'The test details are too long.' };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'The test details have to be a JSON object, in { }.' };
    return { payload: v };
  } catch { return { error: "The test details aren't valid JSON. Check for a missing comma or quote." }; }
}

const firstLines = (s, n = 4) => String(s || '').trim().split(/\r?\n/).slice(0, n).join('\n');

/**
 * What Claude Code would make of a run. { tone: 'ok' | 'block' | 'warn', title, detail }
 * result: { code, stdout, stderr, timedOut, error, timeout }
 */
function verdict(event, result) {
  const e = EVENT.get(event) || {};
  const r = result || {};
  if (r.error) return { tone: 'warn', title: "It didn't start", detail: r.error };
  if (r.timedOut && r.capped) return { tone: 'warn', title: `The test run stopped it after ${r.timeout} seconds`, detail: `A test run waits at most ${r.timeout} seconds. Claude Code would wait up to ${r.asked} seconds for it.` };
  if (r.timedOut) return { tone: 'warn', title: `It didn't finish within ${r.timeout} seconds`, detail: 'Claude Code would stop waiting for it and carry on.' };
  const out = firstLines(r.stdout);
  const err = firstLines(r.stderr);
  if (r.code === 0) {
    if (/^\s*\{/.test(r.stdout || '')) return { tone: 'ok', title: 'It worked, and answered with JSON', detail: 'Claude Code reads JSON output as instructions (to allow, block or add context).' };
    if (e.context && out) return { tone: 'ok', title: 'It worked. Claude would be told:', detail: out };
    return { tone: 'ok', title: 'It worked', detail: e.blocks ? 'Exit code 0, so nothing is blocked and Claude carries on.' : 'Exit code 0. Claude carries on as normal.' };
  }
  if (r.code === 2) {
    if (e.blocks) return { tone: 'block', title: `It would stop ${e.blocks}`, detail: err ? `Claude is told: ${err}` : 'Exit code 2. It printed no reason, so Claude is told nothing more.' };
    if (e.feedback) return { tone: 'block', title: 'Claude would be told to look again', detail: err ? `Claude is told: ${err}` : 'Exit code 2, with no message for Claude.' };
    return { tone: 'warn', title: "Exit code 2, but this moment can't be stopped", detail: err || 'Claude Code shows you the error and carries on.' };
  }
  return { tone: 'warn', title: `It failed (exit code ${r.code})`, detail: `Claude Code shows you this and carries on.${err ? `\n${err}` : ''}` };
}

// ---- running

/** Git Bash, the way Claude Code finds it: its own setting, then next to git. Never WSL's bash. */
function findBash(env = process.env, exists = fs.existsSync) {
  if (process.platform !== 'win32') return exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const tries = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) tries.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) {
    if (exists(path.join(dir, 'git.exe'))) tries.push(path.join(dir, '..', 'bin', 'bash.exe'));
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (root) tries.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  }
  return tries.map(p => path.resolve(p)).find(p => exists(p)) || null;
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const { TASKKILL } = require('./system32');
    execFile(TASKKILL, ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
  } else child.kill('SIGKILL');
}

/**
 * Run a command once with `payload` on stdin. Resolves (never rejects) to
 * { code, stdout, stderr, timedOut, error, ms, timeout, shell }.
 */
function runHook({ command, payload, cwd, timeout = 60, bash = findBash() }) {
  const asked = Math.max(1, Number(timeout) || 60);
  const seconds = Math.min(MAX_TEST_SECONDS, asked);
  const started = Date.now();
  return new Promise(resolve => {
    const out = { stdout: '', stderr: '' };
    let done = false;
    let timedOut = false;
    let timer = null;
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: out.stdout, stderr: out.stderr, timedOut, ms: Date.now() - started, timeout: seconds, asked, capped: asked > seconds, ...r });
    };
    // Never Command Prompt instead: it would read the command differently from
    // how Claude Code will, and runs programs from the project folder first.
    if (!bash) { finish({ code: null, error: "Git Bash wasn't found, and Claude Code runs hooks with it. Install Git for Windows, then try again." }); return; }
    let child;
    try {
      child = spawn(bash, ['-c', command], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, windowsHide: true });
    } catch (e) { finish({ code: null, error: e.message }); return; }
    timer = setTimeout(() => { timedOut = true; killTree(child); finish({ code: null }); }, seconds * 1000);
    for (const k of ['stdout', 'stderr']) {
      child[k].setEncoding('utf8');
      child[k].on('data', d => { if (out[k].length < MAX_OUTPUT) out[k] = (out[k] + d).slice(0, MAX_OUTPUT); });
    }
    child.on('error', e => finish({ code: null, error: e.code === 'ENOENT' ? `Couldn't find the program to run (${e.message}).` : e.message }));
    child.on('close', code => finish({ code }));
    child.stdin.on('error', () => { /* the command didn't read it all: fine */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

module.exports = { samplePayload, parsePayload, verdict, findBash, runHook, MAX_PAYLOAD };
