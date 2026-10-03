// The supervisor: a tiny process that runs one dev server and stays with it.
// runner.js starts it detached (so it outlives Shellby) and passes this file's
// text with -e, so it runs from inside app.asar too. It is plain Node: no
// requires from Shellby, everything it needs comes in the environment.
//
// Why not run cmd detached directly? A detached cmd has no console, so the
// console program it starts (node, under npm) gets a brand new one, and a new
// console replaces that program's output handles: the log stays empty. Started
// from here, not detached, cmd shares a hidden console and passes the log on.
//
// It ends with "[shellby-exit <code>]" in the log (output.js), so Shellby
// learns how the server ended even if Shellby wasn't running at the time.
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

const log = process.env.SHELLBY_LOG;
const command = process.env.SHELLBY_COMMAND;
const cmdExe = process.env.SHELLBY_CMD_EXE;

const env = { ...process.env };
// None of this is the server's business. ELECTRON_RUN_AS_NODE above all: an
// Electron project's own `electron .` would otherwise start as plain Node.
for (const k of ['SHELLBY_LOG', 'SHELLBY_COMMAND', 'SHELLBY_CMD_EXE', 'ELECTRON_RUN_AS_NODE']) delete env[k];
// cmd looks in the current folder (the project) before PATH, so a repository
// holding its own npm.cmd or node.exe would run that instead. This tells cmd,
// and every program under it, not to.
env.NoDefaultCurrentDirectoryInExePath = '1';

const mark = code => { try { fs.appendFileSync(log, `\n[shellby-exit ${code}]\n`); } catch { /* the log is gone */ } };

let fd;
try { fd = fs.openSync(log, 'a'); } catch { process.exit(1); }
let child;
try {
  // /d: no AutoRun commands. /s /c "…": the command line exactly as given.
  child = spawn(cmdExe, ['/d', '/s', '/c', `"${command}"`], {
    cwd: process.cwd(), env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', fd, fd],
  });
} catch (e) {
  fs.writeSync(fd, `${e.message}\n`);
  mark(-1);
  process.exit(1);
}
fs.closeSync(fd);
child.on('error', e => { try { fs.appendFileSync(log, `${e.message}\n`); } catch { /* gone */ } });
child.on('exit', code => { mark(Number.isInteger(code) ? code : -1); process.exit(0); });
