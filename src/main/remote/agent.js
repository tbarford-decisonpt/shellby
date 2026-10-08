// Windows' own ssh agent and your keys, so ssh never has to ask.
//
// A key with a passphrase is unlocked once and handed to the OpenSSH
// Authentication Agent service, which keeps it (encrypted for your Windows
// account) across restarts: from then on every ssh Shellby starts, and every
// one you start, signs in without asking. Windows ships the service switched
// off, and switching it on is the one step that needs an administrator: one
// Windows prompt, and the commands it runs are fixed here.
//
// run(file, args, { input, env, timeout }) -> Promise<{ code, stdout, stderr }>
// is injected, so this is testable without touching the real agent.
const os = require('os');
const path = require('path');
const { SYSTEM32, POWERSHELL, CMD } = require('../system32');

const OPENSSH = path.join(SYSTEM32, 'OpenSSH');
const SSH = path.join(OPENSSH, 'ssh.exe');
const SSH_ADD = path.join(OPENSSH, 'ssh-add.exe');
const SSH_KEYGEN = path.join(OPENSSH, 'ssh-keygen.exe');
const SC = path.join(SYSTEM32, 'sc.exe');
// What UAC's "No" comes back as.
const CANCELLED = 1223;

// sc.exe's words are in the PC's language; its numbers aren't.
const STATES = { 1: 'stopped', 2: 'starting', 3: 'stopping', 4: 'running' };
const START_TYPES = { 2: 'auto', 3: 'manual', 4: 'disabled' };

/** sc query + sc qc output -> { installed, state, startType } */
function parseService(query, config) {
  const state = /STATE\s*:\s*(\d+)/.exec(String(query || ''));
  const start = /START_TYPE\s*:\s*(\d+)/.exec(String(config || ''));
  return {
    installed: !!state,
    state: state ? STATES[state[1]] || 'unknown' : null,
    startType: start ? START_TYPES[start[1]] || 'unknown' : null,
  };
}

/** `ssh-add -l` lines -> [{ bits, fingerprint, comment, type }] */
function parseKeys(text) {
  return String(text || '').split(/\r?\n/).map(l => /^(\d+)\s+(SHA256:\S+)\s+(.*?)\s+\((\w+)\)\s*$/.exec(l.trim())).filter(Boolean)
    .map(/** @param {RegExpExecArray} m */ m => ({ bits: Number(m[1]), fingerprint: m[2], comment: m[3], type: m[4] }));
}

/** The elevated PowerShell that turns the service on (start at sign-in, and now). */
function enableScript() {
  const inner = `${SC} config ssh-agent start= auto && ${SC} start ssh-agent`;
  return [
    'try {',
    `  $p = Start-Process -FilePath '${CMD}' -ArgumentList '/d /c "${inner}"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    '  exit $p.ExitCode',
    `} catch { exit ${CANCELLED} }`,
  ].join('\n');
}

const encode = script => Buffer.from(script, 'utf16le').toString('base64');

// A key file Shellby will name on a command line: under ~/.ssh, nothing odd.
const KEY_NAME = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * home: your profile folder. -> the agent and key helpers.
 */
function createAgent({ run, home = os.homedir(), askEnv = async () => ({}) }) {
  const sshDir = path.join(home, '.ssh');
  const keyPath = name => (KEY_NAME.test(name) && !name.endsWith('.pub') ? path.join(sshDir, name) : null);

  async function service() {
    const [q, c] = await Promise.all([run(SC, ['query', 'ssh-agent']), run(SC, ['qc', 'ssh-agent'])]);
    return parseService(q.stdout, c.stdout);
  }

  /** One Windows prompt, then the service is on and set to start with Windows. -> { ok, cancelled?, error? } */
  async function enable() {
    const r = await run(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(enableScript())], { timeout: 120000 });
    if (r.code === CANCELLED) return { ok: false, cancelled: true, error: 'Windows asked, and it was turned down. Nothing changed.' };
    const s = await service();
    if (s.state === 'running') return { ok: true };
    return { ok: false, error: `Windows didn't start the ssh agent (${s.state || 'not installed'}).` };
  }

  /** The keys the agent holds now. -> { ok, keys } (ok false: no agent to ask) */
  async function loaded() {
    const r = await run(SSH_ADD, ['-l']);
    if (r.code === 0) return { ok: true, keys: parseKeys(r.stdout) };
    if (r.code === 1) return { ok: true, keys: [] }; // running, holding nothing
    return { ok: false, keys: [] };
  }

  /** The key files in ~/.ssh: a private key with its .pub beside it. -> [{ name, file, fingerprint, comment, type }] */
  async function keyFiles(fsm = require('fs')) {
    let names = [];
    try { names = fsm.readdirSync(sshDir); } catch { return []; }
    const pubs = names.filter(n => n.endsWith('.pub') && names.includes(n.slice(0, -4)) && KEY_NAME.test(n.slice(0, -4)));
    const out = [];
    for (const pub of pubs) {
      const r = await run(SSH_KEYGEN, ['-lf', path.join(sshDir, pub)]);
      const k = parseKeys(r.stdout)[0];
      if (k) out.push({ name: pub.slice(0, -4), file: path.join(sshDir, pub.slice(0, -4)), ...k });
    }
    return out;
  }

  /** Does this key need a passphrase? (Tries an empty one.) */
  async function needsPassphrase(name) {
    const file = keyPath(name);
    if (!file) return null;
    const r = await run(SSH_KEYGEN, ['-y', '-P', '', '-f', file]);
    return r.code !== 0;
  }

  /** Hand a key to the agent: its passphrase is asked for in Shellby, once. -> { ok, cancelled?, error? } */
  async function add(name) {
    const file = keyPath(name);
    if (!file) return { ok: false, error: 'Which key?' };
    const r = await run(SSH_ADD, [file], { env: await askEnv(), timeout: 600000 });
    if (r.code === 0) return { ok: true };
    const said = `${r.stderr}${r.stdout}`;
    if (/agent/i.test(said) && /connect|communicat/i.test(said)) return { ok: false, error: "Windows' ssh agent isn't running." };
    if (/bad passphrase|incorrect passphrase/i.test(said)) return { ok: false, error: "That passphrase didn't unlock the key." };
    return { ok: false, cancelled: true, error: 'The key was left locked.' };
  }

  /**
   * A key of your own for Shellby to set up sign-in with: id_ed25519 if you
   * have none (ssh uses that name everywhere without being told), otherwise
   * the existing one. No passphrase: the file is yours alone in your profile,
   * and the agent can hold it too. -> { ok, name, created, error? }
   */
  async function ensureKey(fsm = require('fs')) {
    for (const name of ['id_ed25519', 'shellby_ed25519']) {
      const file = path.join(sshDir, name);
      if (fsm.existsSync(file) && fsm.existsSync(`${file}.pub`)) return { ok: true, name, created: false };
      if (fsm.existsSync(file) || fsm.existsSync(`${file}.pub`)) continue; // half a pair: leave it be
      try { fsm.mkdirSync(sshDir, { recursive: true }); } catch { /* keygen says */ }
      const r = await run(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', `shellby@${os.hostname()}`.replace(/[^\w@.-]/g, ''), '-f', file]);
      if (r.code === 0 && fsm.existsSync(`${file}.pub`)) return { ok: true, name, created: true };
      return { ok: false, error: `ssh-keygen couldn't make a key: ${String(r.stderr || '').trim().slice(0, 200)}` };
    }
    return { ok: false, error: 'Your .ssh folder has half a key pair under both names Shellby would use.' };
  }

  return { service, enable, loaded, keyFiles, needsPassphrase, add, ensureKey, keyPath };
}

module.exports = { createAgent, parseService, parseKeys, enableScript, SSH, SSH_ADD, SSH_KEYGEN, OPENSSH, CANCELLED };
