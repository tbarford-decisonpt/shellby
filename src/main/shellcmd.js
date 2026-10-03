// ! in the message box: run a command yourself, the way Claude Code's shell
// mode does. The output shows in the conversation, and goes to Claude along
// with your next message, so it knows what you ran and what came back
// without spending a turn on it.
//
// It runs in PowerShell (Windows PowerShell 5.1, always present) in the
// conversation's working folder, with your own account's rights: it's you
// typing a command, not Claude. Bounded in time and output, and the whole
// process tree goes if it runs over.
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
// By full path: the working folder is the project, and a powershell.exe in a
// cloned repository would otherwise run instead.
const { POWERSHELL, TASKKILL } = require('./system32');

const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT = 30000;        // kept, shown and sent to Claude
const MAX_COMMAND = 4000;

/**
 * -> Promise<{ command, output, code, timedOut, ms }>. Never rejects.
 */
function run(cwd, command, { timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  const cmd = String(command || '').slice(0, MAX_COMMAND);
  return new Promise(resolve => {
    let output = '';
    let over = false;
    let timedOut = false;
    // One decoder per stream, so a character split across two chunks survives.
    const keeper = () => {
      const dec = new StringDecoder('utf8');
      return d => {
        if (output.length >= MAX_OUTPUT) { over = true; return; }
        output += dec.write(d);
        if (output.length > MAX_OUTPUT) over = true;
      };
    };
    let child;
    try {
      // UTF-8 output, so non-ASCII file names and messages come back intact.
      child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${cmd}`], {
        cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ command: cmd, output: e.message, code: -1, timedOut: false, ms: 0 });
      return;
    }
    child.stdout.on('data', keeper());
    child.stderr.on('data', keeper());
    const timer = setTimeout(() => {
      timedOut = true;
      execFile(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    }, timeoutMs);
    child.on('error', e => { output += e.message; });
    child.on('close', code => {
      clearTimeout(timer);
      let text = output.replace(/\r\n/g, '\n').replace(/\s+$/, '');
      if (over) text = `${text.slice(0, MAX_OUTPUT)}\n… (output cut off at ${MAX_OUTPUT.toLocaleString('en-US')} characters)`;
      if (timedOut) text = `${text}\n(stopped after ${Math.round(timeoutMs / 1000)} seconds)`.trim();
      resolve({ command: cmd, output: text, code: code ?? -1, timedOut, ms: Date.now() - started });
    });
  });
}

/**
 * What Claude is told about commands you ran since your last message, put in
 * front of that message. Same tags as the Claude Code terminal's shell mode.
 */
function contextFor(runs) {
  if (!Array.isArray(runs) || !runs.length) return '';
  return runs.map(r => [
    `<bash-input>${r.command}</bash-input>`,
    `<bash-stdout>${r.output}</bash-stdout>`,
    r.code ? `<bash-stderr>(exit code ${r.code})</bash-stderr>` : '<bash-stderr></bash-stderr>',
  ].join('\n')).join('\n\n') + '\n\n';
}

module.exports = { run, contextFor, MAX_OUTPUT, MAX_COMMAND };
