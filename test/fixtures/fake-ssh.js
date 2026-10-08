#!/usr/bin/env node
// Stands in for ssh.exe in tests and e2e (remote/ssh.js sshArgs): skips the
// options, takes the host and the command after '--', and runs the command the
// way the other computer's login shell would, with sh (Git Bash on Windows) and
// a home of its own (SHELLBY_FAKE_SSH_HOME). Like real ssh, none of this PC's
// environment goes across: only PATH, so sh can find its own tools.
//   host "unreachable": fails the way ssh does when the computer is off.
//   host "asks": first asks for a key's passphrase through SSH_ASKPASS, the way
//     ssh does with no console, and only goes on if the answer is "right".
//   ssh -G host: its reading of the config, from SHELLBY_FAKE_SSH_G.
//   SHELLBY_FAKE_SSH_LOG: each run's arguments, a JSON line per run.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const { findBash } = require('../../src/main/hooks/test');

const args = process.argv.slice(2);
if (args.includes('-G')) {
  process.stdout.write(process.env.SHELLBY_FAKE_SSH_G || `host ${args.at(-1)}\nhostname ${args.at(-1)}\nport 22\n`);
  process.exit(0);
}
const at = args.indexOf('--');
const host = args[at + 1];
const command = args[at + 2];
if (process.env.SHELLBY_FAKE_SSH_LOG) fs.appendFileSync(process.env.SHELLBY_FAKE_SSH_LOG, JSON.stringify(args) + '\n');

if (host === 'unreachable') {
  process.stderr.write(`ssh: connect to host ${host} port 22: Connection timed out\r\n`);
  process.exit(255);
}

if (host === 'asks') {
  const askpass = process.env.SSH_ASKPASS;
  const prompt = "Enter passphrase for key 'C:\\Users\\you/.ssh/test_key': ";
  // As ssh does: the program, with the prompt as its one argument.
  const r = askpass ? spawnSync(askpass, [prompt], { encoding: 'utf8', windowsHide: true }) : null;
  if (!r || r.status !== 0 || r.stdout.replace(/\r?\n$/, '') !== 'right') {
    process.stderr.write(`you@${host}: Permission denied (publickey).\r\n`);
    process.exit(255);
  }
}

const env = {
  HOME: process.env.SHELLBY_FAKE_SSH_HOME,
  PATH: process.env.PATH,
  // Git Bash needs this to start on Windows; it says nothing about this PC's accounts.
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
};
const child = spawn(findBash(), ['-c', command], { env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code ?? 1));
