// Putting the `shellby` command on the user's PATH, and the token that lets it
// start tasks (see src/cli/shellby.js).
//
// Shellby copies the CLI into %LOCALAPPDATA%\Shellby\bin next to a small shim,
// and adds that one folder to the user's PATH. Nothing is written to the machine
// PATH, nothing needs admin rights, and removing it puts the PATH back exactly
// as it was.
//
// Everything here is pure string work, so the PATH edit -- the one thing in
// Shellby that would really annoy someone if it went wrong -- is unit-tested.
const crypto = require('crypto');
const { parseWorkflowCall } = require('./crabtools');
const { NAME: SNIPPET_NAME } = require('./snippets');

const BIN_DIR_NAME = 'bin';
const TOKEN_FILE = 'cli-token';
const TOKEN_BYTES = 32;

/** A fresh CLI token. 256 bits of base64url: not guessable, and one line long. */
function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time compare for the token header. A plain === would leak the token
 * a character at a time to anything that can time the response.
 */
function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  if (!expected || expected.length !== given.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

// ------------------------------------------------------------------ the shims

/**
 * The .cmd that cmd.exe and PowerShell run. It calls the copy of the CLI next to
 * itself (%~dp0), so the shim never carries a path into the installed app and
 * keeps working across updates and reinstalls.
 */
function cmdShim() {
  return [
    '@echo off',
    'rem Shellby command line. Written by Shellby; delete the folder to remove it.',
    'setlocal',
    'node "%~dp0shellby.js" %*',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

/** The same for Git Bash, WSL and any other shell that reads a shebang. */
function shShim() {
  return [
    '#!/usr/bin/env bash',
    '# Shellby command line. Written by Shellby; delete the folder to remove it.',
    'exec node "$(dirname "$0")/shellby.js" "$@"',
    '',
  ].join('\n');
}

/** A PowerShell shim, so `shellby` also works when a profile prefers .ps1. */
function ps1Shim() {
  return [
    '# Shellby command line. Written by Shellby; delete the folder to remove it.',
    'node "$PSScriptRoot\\shellby.js" @args',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

// ------------------------------------------------------------------ PATH maths

// PATH entries are compared without case (Windows), without a trailing slash,
// and without the quotes some installers leave behind.
function normalizeEntry(entry) {
  return String(entry ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

const split = pathValue => String(pathValue ?? '').split(';');

/** Is this folder already on the PATH? */
function isOnPath(pathValue, dir) {
  const want = normalizeEntry(dir);
  return !!want && split(pathValue).some(e => normalizeEntry(e) === want);
}

/**
 * PATH with the folder added, or the value unchanged if it's already there.
 * Appended rather than prepended: Shellby's command must never shadow something
 * the user already has.
 */
function pathWith(pathValue, dir) {
  const current = String(pathValue ?? '');
  if (!dir || isOnPath(current, dir)) return current;
  if (!current.trim()) return dir;
  // Keep a single trailing semicolon from turning into an empty entry.
  return `${current.replace(/;+$/, '')};${dir}`;
}

/** PATH with the folder removed, leaving everything else exactly as it was. */
function pathWithout(pathValue, dir) {
  const want = normalizeEntry(dir);
  const parts = split(pathValue);
  const kept = parts.filter((e, i) => {
    if (normalizeEntry(e) === want) return false;
    // A trailing empty segment was a trailing semicolon; keep it only if it
    // was there before we touched anything.
    return !(e === '' && i === parts.length - 1 && parts.length > 1);
  });
  return kept.join(';');
}

/**
 * PowerShell that tells Windows the user environment changed. `reg add` writes
 * PATH but announces nothing, so Explorer keeps its old copy and every terminal
 * opened from the Start menu says "'shellby' is not recognized" until sign-out.
 * This is the WM_SETTINGCHANGE broadcast setx and the Environment Variables
 * dialog send. Returned as -EncodedCommand args so nothing needs quoting.
 */
function settingChangeArgs() {
  const script = [
    "Add-Type -Namespace Shellby -Name Env -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'",
    '$r = [UIntPtr]::Zero',
    // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5 s per window at most
    "[void][Shellby.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)",
  ].join('; ');
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** Where the command lives, given Electron's app.getPath('userData') neighbours. */
const binDir = localAppData => require('path').join(localAppData, 'Shellby', BIN_DIR_NAME);
const tokenPath = userData => require('path').join(userData, TOKEN_FILE);

/**
 * What a `shellby do` request is allowed to ask for. The CLI already checks
 * these, but the CLI is not the only thing that can reach the port.
 * A task can name one of the user's snippets (`shellby do @review`), and then
 * its prompt is only what goes with it, and may be empty.
 *   { ok: true, task: { prompt, cwd, mode, snippet } } | { ok: false, error }
 */
function parseTaskRequest(body, { modes, maxPrompt = 4000, isDir = () => true } = {}) {
  if (!body || typeof body !== 'object' || body.action !== 'task') return { ok: false, error: 'Expected a task.' };
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  const prompt = typeof args.prompt === 'string' ? args.prompt.replace(/\u0000/g, '').trim() : '';
  if (args.snippet != null && (typeof args.snippet !== 'string' || !SNIPPET_NAME.test(args.snippet))) return { ok: false, error: 'That is not a snippet name.' };
  const snippet = args.snippet ?? null;
  if (!prompt && !snippet) return { ok: false, error: 'No task given.' };
  if (prompt.length > maxPrompt) return { ok: false, error: 'That task is too long.' };
  const cwd = typeof args.cwd === 'string' ? args.cwd : '';
  if (!cwd || !isDir(cwd)) return { ok: false, error: 'That folder does not exist.' };
  // A mode is optional; an unknown one is refused rather than quietly ignored,
  // and "autonomous" is never reachable from a terminal.
  const allowed = Array.isArray(modes) ? modes : ['ask', 'smart', 'acceptEdits', 'plan'];
  if (args.mode != null && !allowed.includes(args.mode)) return { ok: false, error: 'Unknown permission mode.' };
  return { ok: true, task: { prompt, cwd, mode: args.mode ?? null, snippet } };
}

/**
 * A `shellby flow list` or `shellby flow run <name> [key=value ...]`. The name
 * and inputs get exactly the checks MCP's run_workflow gets (crabtools).
 *   { ok: true, request: { action: 'flow-list' } | { action: 'flow-run', name, inputs } }
 *   | { ok: false, error }
 */
function parseFlowRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a workflow request.' };
  if (body.action === 'flow-list') return { ok: true, request: { action: 'flow-list' } };
  if (body.action !== 'flow-run') return { ok: false, error: 'Expected a workflow request.' };
  const call = parseWorkflowCall(body.name, body.inputs);
  if (!call.ok) return { ok: false, error: call.error };
  return { ok: true, request: { action: 'flow-run', name: call.name, inputs: call.inputs } };
}

module.exports = {
  newToken, tokenMatches, cmdShim, shShim, ps1Shim,
  isOnPath, pathWith, pathWithout, normalizeEntry, binDir, tokenPath, parseTaskRequest, parseFlowRequest, settingChangeArgs,
  BIN_DIR_NAME, TOKEN_FILE,
};
