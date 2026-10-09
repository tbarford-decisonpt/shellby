// Other computers Claude Code runs on: setting them up, and their folders.
//
// A computer is an ssh Host (one of yours in ~/.ssh/config, or one added here,
// which Shellby writes there so your own terminal can use it too). Setting it
// up is a row of checks, each with the button that fixes it:
//   - can Shellby reach it and sign in (ssh, through any jump host)?
//   - if a key's passphrase keeps being asked for: Windows' ssh agent, on, with
//     the key unlocked in it once;
//   - with a password only: a key of your own, installed there with it;
//   - is Claude Code installed there, and signed in?
// Then a folder there is added like any project: it gets a stand-in folder on
// this PC (ssh.js anchors), and conversations in that folder run over there.
//
// deps:
//   config, dir (the profile's remote folder), log,
//   spawn: child_process.spawn, fs, agent (agent.js), askpass (askpass.js),
//   openTerminal({ host, script }) -> Promise<{ ok, error? }>,
//   readSshConfig() / writeSshConfig(text): ~/.ssh/config
//   sshConfigFile: a config of its own for every ssh (-F), or null for ssh's usual
//     ~/.ssh/config. Development runs with a profile of their own use one, so
//     they never read or write yours.
//   sshCommand: { exe, prefix } to run instead of Windows' ssh.exe (tests and e2e:
//     node and fixtures/fake-ssh.js).
const crypto = require('crypto');
const path = require('path');
const ssh = require('./ssh');
const { SSH } = require('./agent');

const MAX_COMPUTERS = 20;
const MAX_FOLDERS = 60;
const OUT_MAX = 256 * 1024;

const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const sameHost = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

function createRemoteService(deps) {
  const { config, dir, log = () => {}, spawn, fs, agent, askpass, openTerminal, readSshConfig, writeSshConfig, sshConfigFile = null, sshCommand = { exe: SSH, prefix: [] } } = deps;
  const configArgs = sshConfigFile ? ['-F', sshConfigFile] : [];
  const anchorsRoot = path.join(dir, 'folders');
  let askEnv = null; // askpass's environment once its server is up (sessions start synchronously)
  let askError = null; // why it couldn't start (a PC that won't run the helper), for the sign-in step to say
  const busy = new Map(); // alias -> what's running for it, so a second press waits for the first

  const computers = () => (Array.isArray(config.get('remoteComputers')) ? config.get('remoteComputers') : []).filter(c => ssh.isHost(c?.alias));
  const folders = () => (Array.isArray(config.get('remoteFolders')) ? config.get('remoteFolders') : []).filter(f => ssh.isHost(f?.host) && ssh.isRemoteDir(f?.dir) && typeof f?.anchor === 'string');
  const computer = alias => computers().find(c => sameHost(c.alias, alias)) || null;

  /** Start the askpass server now, so a session started later can ask for a passphrase. */
  function warm() {
    if (!computers().length) return Promise.resolve(null);
    return askpass.env().then(env => { askEnv = env; askError = null; return env; }, err => { askError = err.message; log(`askpass: ${err.message}`); return null; });
  }

  // ---- running ssh

  /**
   * One ssh command on `host`. -> Promise<{ code, stdout, stderr, timedOut }>. Never rejects.
   * input: stdin text. interactive: you pressed a button, so ssh may ask (askpass)
   * and trust a computer it's never seen; otherwise it never asks anything.
   */
  async function runSsh(host, script, { input = '', interactive = false, timeout = 30000, extra = /** @type {string[]} */ ([]) } = {}) {
    let env = {};
    if (interactive) env = (await warm()) || {};
    const args = ssh.sshArgs(host, script, { batch: !interactive, acceptNew: interactive, timeout: Math.min(30, timeout / 1000), extra: [...configArgs, ...extra] });
    return new Promise(resolve => {
      let child;
      try { child = spawn(sshCommand.exe, [...sshCommand.prefix, ...args], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (err) {
        resolve({ code: null, stdout: '', stderr: err.message, timedOut: false });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeout);
      child.stdout.on('data', d => { if (stdout.length < OUT_MAX) stdout += d; });
      child.stderr.on('data', d => { if (stderr.length < OUT_MAX) stderr += d; });
      child.stdin.on('error', () => { /* it went before reading */ });
      child.on('error', err => { stderr += err.message; });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
      try { child.stdin.end(input); } catch { /* gone */ }
    });
  }

  /** ssh's own reading of the config for this host (no network). */
  async function resolved(alias) {
    const r = await new Promise(resolve => {
      let out = '';
      let child;
      try { child = spawn(sshCommand.exe, [...sshCommand.prefix, ...configArgs, '-G', '--', alias], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(''); return; }
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(out));
    });
    return ssh.parseResolved(r);
  }

  // What went wrong with an ssh run, as a sentence.
  function failure(r) {
    if (r.timedOut) return { kind: 'remote-unreachable', message: 'That computer took too long to answer.' };
    const t = ssh.troubleOf(r.stderr);
    if (t) return t;
    const last = String(r.stderr || '').trim().split(/\r?\n/).pop();
    return { kind: 'remote-other', message: last ? `ssh said: ${last.slice(0, 200)}` : `ssh stopped (code ${r.code}).` };
  }

  // ---- computers

  function saveComputer(alias, patch) {
    config.set({ remoteComputers: computers().map(c => (sameHost(c.alias, alias) ? { ...c, ...patch } : c)) });
  }

  /** The hosts in ~/.ssh/config, for the add list. */
  function sshHosts() {
    let text = '';
    try { text = readSshConfig(); } catch { /* none yet */ }
    return ssh.parseConfig(text);
  }

  /** Use a computer you already have in ~/.ssh/config. */
  function addComputer(alias) {
    if (!ssh.isHost(alias)) return { ok: false, error: 'Which computer?' };
    if (computer(alias)) return { ok: true, alias };
    if (computers().length >= MAX_COMPUTERS) return { ok: false, error: `Shellby keeps up to ${MAX_COMPUTERS} computers.` };
    const known = sshHosts().find(h => sameHost(h.alias, alias));
    const name = known?.alias || alias;
    config.set({ remoteComputers: [...computers(), { alias: name, added: Date.now(), check: null }] });
    warm();
    return { ok: true, alias: name };
  }

  /**
   * A new computer from the form: written to ~/.ssh/config, then used.
   * @param {{ alias?: any, address?: any, user?: any, port?: any, jump?: any }} [form]
   */
  function createComputer({ alias, address, user = null, port = null, jump = null } = {}) {
    const block = ssh.hostBlock({ alias, address, user: user || null, port: port ? Number(port) : null, jump: jump || null });
    if (!block.ok) return block;
    if (sshHosts().some(h => sameHost(h.alias, alias))) return { ok: false, error: `There's already a computer called ${alias} in your ssh settings. Pick it from the list, or use another name.` };
    if (jump && !sshHosts().some(h => sameHost(h.alias, jump))) return { ok: false, error: `${jump} isn't one of your computers yet.` };
    let text = '';
    try { text = readSshConfig(); } catch { /* a new file */ }
    try { writeSshConfig(ssh.appendBlock(text, block.text)); } catch (err) { return { ok: false, error: `Couldn't save your ssh settings: ${err.message}` }; }
    return addComputer(alias);
  }

  function removeComputer(alias) {
    if (!computer(alias)) return { ok: false, error: 'Which computer?' };
    const gone = folders().filter(f => sameHost(f.host, alias));
    config.set({
      remoteComputers: computers().filter(c => !sameHost(c.alias, alias)),
      remoteFolders: folders().filter(f => !sameHost(f.host, alias)),
    });
    for (const f of gone) dropAnchor(f.anchor);
    return { ok: true };
  }

  /**
   * Look at a computer: reach it, sign in, and see what Claude Code there says.
   * interactive: you pressed Check, so ssh may ask for a passphrase or password.
   */
  async function check(alias, { interactive = true } = {}) {
    if (!computer(alias)) return { ok: false, error: 'Which computer?' };
    if (busy.has(alias)) return busy.get(alias);
    const p = (async () => {
      const r = await runSsh(alias, ssh.probeScript(), { interactive, timeout: 60000 });
      const probe = ssh.parseProbe(r.stdout);
      const failed = probe.reached ? null : failure(r);
      // ssh had no way to ask for the passphrase: say that, not "it didn't accept the sign-in".
      const said = failed?.kind === 'remote-auth' && interactive && askError ? `Shellby couldn't show its passphrase box on this PC (${askError}), so ssh had no way to ask. Windows' ssh agent can hold the key instead, or set up a key without a passphrase.` : null;
      const result = probe.reached
        ? { at: Date.now(), ok: true, ...probe }
        : { at: Date.now(), ok: false, reached: false, ...failed, ...(said ? { message: said } : {}) };
      saveComputer(alias, { check: result });
      return { ok: true, check: result };
    })().finally(() => busy.delete(alias));
    busy.set(alias, p);
    return p;
  }

  /** Install Claude Code there, with its own installer. */
  async function installClaude(alias) {
    if (!computer(alias)) return { ok: false, error: 'Which computer?' };
    const r = await runSsh(alias, ssh.installScript(), { interactive: true, timeout: 10 * 60000 });
    if (r.code !== 0) {
      const said = `${r.stderr}`;
      if (/shellby: curl: command not found/.test(said)) return { ok: false, error: 'That computer has no curl, which the installer needs. Install curl there first.' };
      log(`remote install on ${alias}: ${said.trim().split('\n').slice(-3).join(' | ')}`);
      return { ok: false, error: failure(r).message };
    }
    return check(alias);
  }

  /** Sign in to Claude Code there: a terminal opens on that computer, since the sign-in is a conversation. */
  function signInClaude(alias) {
    if (!computer(alias)) return Promise.resolve({ ok: false, error: 'Which computer?' });
    return openTerminal({ host: alias, script: ssh.signInScript(), extra: configArgs });
  }

  /**
   * Sign in to the computer with a key from now on: make one if you have none,
   * put it there (ssh asks for your password, in Shellby, this once), and hand
   * it to the agent if it's running.
   */
  async function setupKey(alias) {
    if (!computer(alias)) return { ok: false, error: 'Which computer?' };
    const key = await agent.ensureKey(fs);
    if (!key.ok) return key;
    let pub;
    try { pub = fs.readFileSync(`${agent.keyPath(key.name)}.pub`, 'utf8').trim(); } catch { return { ok: false, error: "Couldn't read the new key." }; }
    if (!/^ssh-[\w-]+ [A-Za-z0-9+/=]+( .*)?$/.test(pub)) return { ok: false, error: "That key file doesn't look like an ssh public key." };
    // The password, not a key: a key that needs its passphrase is what this is here to replace.
    const r = await runSsh(alias, ssh.authorizeScript(), {
      interactive: true, input: `${pub}\n`, timeout: 120000,
      extra: ['-o', 'PreferredAuthentications=keyboard-interactive,password,publickey', '-o', 'NumberOfPasswordPrompts=3'],
    });
    if (!/shellby-ok/.test(r.stdout)) return { ok: false, error: failure(r).message };
    const svc = await agent.service().catch(() => null);
    if (svc?.state === 'running') await agent.add(key.name);
    const c = await check(alias, { interactive: false });
    return { ok: true, created: key.created, key: key.name, check: c.check };
  }

  // ---- folders

  function anchorFor(host, dir) {
    return ssh.anchorFor(anchorsRoot, host, dir, hash(`${host.toLowerCase()}:${dir}`));
  }

  function dropAnchor(anchor) {
    // Only ever our own stand-ins, and only while empty: nothing of yours is in one.
    if (!path.resolve(anchor).toLowerCase().startsWith(path.resolve(anchorsRoot).toLowerCase() + path.sep)) return;
    try { fs.rmdirSync(anchor); } catch { /* not empty, or gone */ }
  }

  /** The folders in a folder there, to pick one. */
  async function browse(alias, where = '~') {
    if (!computer(alias)) return { ok: false, error: 'Which computer?' };
    const at = ssh.cleanDir(where || '~');
    if (!ssh.isRemoteDir(at)) return { ok: false, error: 'A folder there starts with / or ~/.' };
    const r = await runSsh(alias, ssh.listScript(at), { interactive: true, timeout: 30000 });
    if (r.code === 97) return { ok: false, error: `There's no folder ${at} on ${alias}.` };
    if (r.code !== 0) return { ok: false, error: failure(r).message };
    const list = ssh.parseList(r.stdout);
    return { ok: true, dir: at, here: list.here, folders: list.folders };
  }

  /** Add a folder there as a place to work. -> { ok, anchor, label } */
  async function addFolder(alias, where) {
    if (!computer(alias)) return { ok: false, error: 'Which computer?' };
    const dirClean = ssh.cleanDir(where);
    if (!ssh.isRemoteDir(dirClean)) return { ok: false, error: 'A folder there starts with / or ~/, like ~/code/app.' };
    const existing = folders().find(f => sameHost(f.host, alias) && f.dir === dirClean);
    if (existing) return { ok: true, anchor: existing.anchor, label: ssh.placeLabel(existing.host, existing.dir) };
    if (folders().length >= MAX_FOLDERS) return { ok: false, error: `Shellby keeps up to ${MAX_FOLDERS} folders on other computers.` };
    const there = await browse(alias, dirClean);
    if (!there.ok) return there;
    const host = computer(alias).alias;
    const anchor = anchorFor(host, dirClean);
    try { fs.mkdirSync(anchor, { recursive: true }); } catch (err) { return { ok: false, error: `Couldn't make its folder on this PC: ${err.message}` }; }
    config.set({ remoteFolders: [...folders(), { host, dir: dirClean, anchor }] });
    return { ok: true, anchor, label: ssh.placeLabel(host, dirClean) };
  }

  function removeFolder(anchor) {
    const f = folders().find(x => samePath(x.anchor, anchor));
    if (!f) return { ok: false, error: 'Which folder?' };
    config.set({ remoteFolders: folders().filter(x => x !== f) });
    dropAnchor(f.anchor);
    return { ok: true };
  }

  /** Is this cwd a folder on another computer? -> { host, dir, anchor } | null */
  function placeOf(cwd) {
    if (typeof cwd !== 'string' || !cwd) return null;
    return folders().find(f => samePath(f.anchor, cwd)) || null;
  }

  /** How a session in `place` starts its Claude Code (session.js remote). */
  function launch(place) {
    return { exe: sshCommand.exe, argsPrefix: sshCommand.prefix, host: place.host, dir: place.dir, env: askEnv || {}, extra: configArgs };
  }

  /**
   * A short-lived claude there with `args`, for its plan usage (usage.js probe).
   * Never asks for a passphrase: it runs on its own, so it just fails without a key. -> { exe, args, env } | null
   */
  function probeCommand(alias, args) {
    if (!computer(alias)) return null;
    const script = ssh.sessionScript({ dir: '~', args, env: { SHELLBY_OWNED: '1' } });
    return {
      exe: sshCommand.exe,
      args: [...sshCommand.prefix, ...ssh.sshArgs(alias, script, { batch: true, extra: configArgs })],
      env: { ...process.env, ...(askEnv || {}) },
    };
  }

  /** Carry a conversation on in a terminal on that computer. */
  function resumeInTerminal(place, sessionId) {
    return openTerminal({ host: place.host, script: ssh.resumeScript({ dir: place.dir, sessionId }), extra: configArgs });
  }

  // ---- what Settings shows

  async function view() {
    const [svc, held, keys] = await Promise.all([
      agent.service().catch(() => null),
      agent.loaded().catch(() => ({ ok: false, keys: [] })),
      agent.keyFiles(fs).catch(() => []),
    ]);
    const heldPrints = new Set(held.keys.map(k => k.fingerprint));
    const keyRows = [];
    for (const k of keys) keyRows.push({ name: k.name, type: k.type, comment: k.comment, loaded: heldPrints.has(k.fingerprint), locked: await agent.needsPassphrase(k.name).catch(() => null) });
    const mine = computers();
    const rows = [];
    for (const c of mine) {
      const r = await resolved(c.alias);
      rows.push({
        alias: c.alias,
        where: { host: r.hostname, user: r.user, port: r.port, jump: r.proxyjump },
        check: c.check || null,
        folders: folders().filter(f => sameHost(f.host, c.alias)).map(f => ({ dir: f.dir, anchor: f.anchor, label: ssh.placeLabel(f.host, f.dir) })),
        busy: busy.has(c.alias),
      });
    }
    const listed = new Set(mine.map(c => c.alias.toLowerCase()));
    return {
      ok: true,
      sshFound: fs.existsSync(SSH),
      agent: svc ? { ...svc, reachable: held.ok } : null,
      keys: keyRows,
      computers: rows,
      available: sshHosts().filter(h => !listed.has(h.alias.toLowerCase())).map(h => ({ alias: h.alias, hostName: h.hostName, user: h.user, jump: h.proxyJump })),
      jumps: sshHosts().map(h => h.alias),
    };
  }

  return {
    warm, view, addComputer, createComputer, removeComputer, check, installClaude, signInClaude, setupKey,
    enableAgent: () => agent.enable(), unlockKey: name => agent.add(name),
    browse, addFolder, removeFolder, placeOf, launch, probeCommand, resumeInTerminal, runSsh,
  };
}

module.exports = { createRemoteService };
