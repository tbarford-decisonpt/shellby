// Other computers Claude Code runs on (remote/service.js decides; this does):
// the askpass questions shown in the panel, terminals on the other computer,
// and ~/.ssh/config. Kept out of main.js, which only wires it up.
const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handoff = require('../handoff');
const { createAgent, SSH } = require('../remote/agent');
const { createAskpass } = require('../remote/askpass');
const { createRemoteService } = require('../remote/service');
const ssh = require('../remote/ssh');
const { POWERSHELL } = require('../system32');

// How long a passphrase question waits for you before ssh is told "no".
const ASK_MS = 5 * 60 * 1000;

/** d: what main shares (main.js `shared`). */
function wireRemote(d) {
  // A development run with a profile of its own keeps to a pretend home, the
  // way the Toolbox does, so it never reads or writes your ssh settings.
  // SHELLBY_REAL_SSH=1 lets one use them (to try it against a real computer).
  const pretend = d.ISOLATED && process.env.SHELLBY_REAL_SSH !== '1';
  const home = pretend ? path.join(app.getPath('userData'), 'claude-home') : os.homedir();
  const sshDir = path.join(home, '.ssh');
  const sshConfig = path.join(sshDir, 'config');
  const pending = new Map(); // question id -> resolve
  // A development run can stand fixtures/fake-ssh.js in for ssh.exe (e2e-remote.js).
  const fakeSsh = !app.isPackaged && process.env.SHELLBY_FAKE_SSH ? path.resolve(process.env.SHELLBY_FAKE_SSH) : null;
  const sshCommand = fakeSsh ? { exe: process.env.SHELLBY_NODE || 'node', prefix: [fakeSsh] } : { exe: SSH, prefix: [] };

  // ssh is asking (askpass.js): the panel shows the question, you answer there.
  function ask({ prompt, kind }) {
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); d.send(d.panel, 'remote:asked', { id }); resolve(null); }, ASK_MS);
      pending.set(id, answer => { clearTimeout(timer); pending.delete(id); resolve(answer); });
      d.showPanel?.();
      d.send(d.panel, 'remote:ask', { id, prompt, kind });
    });
  }

  /** The panel's answer to a question: the text, or null for Cancel. */
  function answer(id, text) {
    const resolve = pending.get(id);
    if (!resolve) return false;
    resolve(typeof text === 'string' ? text : null);
    return true;
  }

  function wtPath() {
    const local = process.env.LOCALAPPDATA;
    const wt = local && path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
    return wt && fs.existsSync(wt) ? wt : null;
  }

  // A terminal on the other computer: Windows Terminal (or PowerShell) running
  // ssh -t with one of ssh.js's scripts. Its prompts are its own: a terminal
  // can ask for a passphrase itself.
  function openTerminal({ host, script, extra = [] }) {
    if (!ssh.isHost(host)) return Promise.resolve({ ok: false, error: 'Which computer?' });
    const line = ssh.sshArgs(host, script, { tty: true, extra }).map(handoff.psQuote).join(' ');
    const encoded = handoff.encodeScript(`& ${handoff.psQuote(SSH)} ${line}`);
    const psArgs = ['-NoLogo', '-NoExit', '-EncodedCommand', encoded];
    const options = { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: false };
    const wt = wtPath();
    const plans = [
      ...(wt ? [{ shell: 'wt', file: wt, args: ['-w', 'new', POWERSHELL, ...psArgs], options }] : []),
      { shell: 'powershell', file: POWERSHELL, args: psArgs, options },
    ];
    return handoff.launch(plans, spawn);
  }

  function run(file, args, { input = null, env = null, timeout = 30000 } = {}) {
    return new Promise(resolve => {
      let child;
      try {
        child = execFile(file, args, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      } catch (err) {
        resolve({ code: 1, stdout: '', stderr: err.message });
        return;
      }
      child.stdin?.on('error', () => { /* it never read */ });
      try { child.stdin?.end(input === null ? undefined : input); } catch { /* gone */ }
    });
  }

  function createComputers() {
    const dir = path.join(app.getPath('userData'), 'remote');
    const askpass = createAskpass({ dir, ask, log: m => d.log.info(m) });
    const agent = createAgent({ run, home, askEnv: () => askpass.env() });
    d.remoteService = createRemoteService({
      config: d.config, dir, log: m => d.log.info(m), spawn, fs, agent, askpass, openTerminal,
      sshConfigFile: pretend ? sshConfig : null, sshCommand,
      readSshConfig: () => fs.readFileSync(sshConfig, 'utf8'),
      writeSshConfig: text => {
        fs.mkdirSync(sshDir, { recursive: true });
        // The file as it was before Shellby first touched it, kept once beside it.
        const backup = `${sshConfig}.before-shellby`;
        if (fs.existsSync(sshConfig) && !fs.existsSync(backup)) fs.copyFileSync(sshConfig, backup);
        fs.writeFileSync(sshConfig, text);
      },
    });
    d.remoteService.warm();
    app.on('will-quit', () => askpass.close());
    return d.remoteService;
  }

  return { createComputers, answerRemote: answer };
}

module.exports = { wireRemote };
