// Setting up other computers (src/main/remote/): the askpass bridge, Windows'
// ssh agent, the service behind Settings → Other computers, and its IPC.
// ssh itself is the stand-in in fixtures/fake-ssh.js, the agent a fake run().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createAskpass, kindOf } = require('../src/main/remote/askpass');
const agentMod = require('../src/main/remote/agent');
const { createRemoteService } = require('../src/main/remote/service');
const { registerRemoteIpc } = require('../src/main/ipc/remote');
const { findBash } = require('../src/main/hook-test');
const { createFakeIpc, fakeConfig } = require('./helpers/fake-ipc');

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const FAKE_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
const needsSh = !findBash() && 'needs sh';
const tmp = prefix => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function post(port, body, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ask', method: 'POST', headers: { 'Content-Type': 'text/plain', ...(token ? { 'X-Shellby-Token': token } : {}) } }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---- askpass

test("askpass: ssh's prompts by kind", () => {
  assert.equal(kindOf("Enter passphrase for key 'x':"), 'passphrase');
  assert.equal(kindOf("me@box's password:"), 'password');
  assert.equal(kindOf('Are you sure you want to continue connecting (yes/no/[fingerprint])?'), 'confirm');
  assert.equal(kindOf('Verification code:'), 'other');
});

test('askpass: only a request with the token is asked, and the answer goes back', async () => {
  const dir = tmp('shellby-askpass-');
  const asked = [];
  const answers = ['open sesame', null, 'two\nlines'];
  const ap = createAskpass({ dir, ask: async q => { asked.push(q); return answers.shift(); }, compiler: null });
  // Already built (this test is about the server): the helper's source and a stand-in exe.
  fs.writeFileSync(path.join(dir, 'shellby-askpass.cs'), require('../src/main/remote/askpass').SOURCE);
  fs.writeFileSync(path.join(dir, 'shellby-askpass.exe'), '');
  try {
    const env = await ap.env();
    assert.equal(env.SSH_ASKPASS, path.join(dir, 'shellby-askpass.exe'));
    assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
    const port = Number(env.SHELLBY_ASKPASS_PORT);
    assert.equal((await post(port, 'x')).status, 403, 'no token');
    assert.equal((await post(port, 'x', 'f'.repeat(48))).status, 403, 'wrong token');
    assert.equal(asked.length, 0);
    const yes = await post(port, "Enter passphrase for key 'k':\u0007", env.SHELLBY_ASKPASS_TOKEN);
    assert.equal(yes.body, '1\nopen sesame');
    assert.deepEqual(asked[0], { prompt: "Enter passphrase for key 'k':", kind: 'passphrase' });
    assert.equal((await post(port, 'again', env.SHELLBY_ASKPASS_TOKEN)).body, '0', 'Cancel tells ssh no');
    assert.equal((await post(port, 'more', env.SHELLBY_ASKPASS_TOKEN)).body, '0', 'an answer with a line break is never half sent');
  } finally {
    ap.close();
  }
});

test('askpass: no helper to build with, no askpass (and it says why)', async () => {
  const ap = createAskpass({ dir: tmp('shellby-askpass-'), ask: async () => null, compiler: null });
  await assert.rejects(ap.env(), /C# compiler/);
});

// The real helper, built with Windows' own compiler, and a prompt a hostile
// server could send: it must arrive as text, and nothing in it may run.
const csc = require('../src/main/remote/askpass').findCompiler();
test('askpass: the built helper passes any prompt through as text, and runs none of it', { skip: !csc && "needs Windows' C# compiler" }, async () => {
  const dir = tmp('shellby-askpass-');
  const canary = path.join(dir, 'ran.txt');
  const hostile = `Code" & echo pwned > "${canary}" & echo "%PATH% | ^ < >`;
  const asked = [];
  const ap = createAskpass({ dir, ask: async q => { asked.push(q.prompt); return 'p@ss w%rd "&|'; }, compiler: csc });
  try {
    const env = await ap.env();
    const r = await new Promise(resolve => {
      execFile(env.SSH_ASKPASS, [hostile], { env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'p@ss w%rd "&|\n', 'the answer comes back exactly');
    assert.deepEqual(asked, [hostile], 'the prompt arrives exactly');
    assert.ok(!fs.existsSync(canary), 'nothing in the prompt ran');
    // Without the token from Shellby's environment it gets nothing.
    const bare = await new Promise(resolve => execFile(env.SSH_ASKPASS, ['x'], { env: { ...process.env, SHELLBY_ASKPASS_TOKEN: '' }, windowsHide: true }, err => resolve(err?.code)));
    assert.equal(bare, 1);
  } finally {
    ap.close();
  }
});

// ---- the agent

test("agent: sc.exe's numbers, whatever the PC's language", () => {
  const query = 'SERVICE_NAME: ssh-agent\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 1  ARRÊTÉ\r\n';
  const config = '        START_TYPE         : 4   DISABLED\r\n';
  assert.deepEqual(agentMod.parseService(query, config), { installed: true, state: 'stopped', startType: 'disabled' });
  assert.deepEqual(agentMod.parseService('STATE : 4 RUNNING', 'START_TYPE : 2 AUTO_START'), { installed: true, state: 'running', startType: 'auto' });
  assert.equal(agentMod.parseService('[SC] OpenService FAILED 1060', '').installed, false);
});

test('agent: the keys it holds', () => {
  const keys = agentMod.parseKeys('256 SHA256:7Xkzn99VfIB+QJYVw/Fpts razer (ED25519)\r\n3072 SHA256:abc me@pc (RSA)\r\nnot a key');
  assert.deepEqual(keys.map(k => [k.fingerprint, k.comment, k.type]), [['SHA256:7Xkzn99VfIB+QJYVw/Fpts', 'razer', 'ED25519'], ['SHA256:abc', 'me@pc', 'RSA']]);
});

test("agent: turning it on is one fixed, elevated command; Windows' No changes nothing", async () => {
  const script = agentMod.enableScript();
  assert.match(script, /-Verb RunAs/);
  assert.match(script, /sc\.exe config ssh-agent start= auto && .*sc\.exe start ssh-agent/);
  const calls = [];
  const states = { before: '1', after: '4' };
  let enabled = false;
  const run = async (file, args) => {
    calls.push([path.basename(file), args[0]]);
    if (/powershell/i.test(file)) return { code: enabled ? 0 : agentMod.CANCELLED, stdout: '', stderr: '' };
    if (args[0] === 'query') return { code: 0, stdout: `STATE : ${enabled ? states.after : states.before} X` };
    return { code: 0, stdout: 'START_TYPE : 4 X' };
  };
  const agent = agentMod.createAgent({ run, home: tmp('shellby-home-') });
  assert.deepEqual(await agent.enable(), { ok: false, cancelled: true, error: 'Windows asked, and it was turned down. Nothing changed.' });
  enabled = true;
  assert.deepEqual(await agent.enable(), { ok: true });
});

test('agent: unlocking a key asks through Shellby, and says what went wrong', async () => {
  let reply = { code: 0, stdout: '', stderr: '' };
  const seen = [];
  const agent = agentMod.createAgent({ run: async (file, args, opts) => { seen.push({ file, args, opts }); return reply; }, home: 'C:\\home', askEnv: async () => ({ SSH_ASKPASS: 'x' }) });
  assert.deepEqual(await agent.add('sandbox_key'), { ok: true });
  assert.equal(seen[0].args[0], path.join('C:\\home', '.ssh', 'sandbox_key'));
  assert.equal(seen[0].opts.env.SSH_ASKPASS, 'x');
  reply = { code: 1, stdout: '', stderr: 'Error connecting to agent: No such file or directory' };
  assert.match((await agent.add('sandbox_key')).error, /isn't running/);
  reply = { code: 1, stdout: '', stderr: 'Bad passphrase, try again' };
  assert.match((await agent.add('sandbox_key')).error, /didn't unlock/);
  assert.deepEqual(await agent.add('../../evil'), { ok: false, error: 'Which key?' });
  assert.deepEqual(await agent.add('id_ed25519.pub'), { ok: false, error: 'Which key?' });
});

test('agent: a key of your own is made once, under a name ssh uses by itself', async () => {
  const home = tmp('shellby-home-');
  const made = [];
  const run = async (file, args) => {
    made.push(args);
    const f = args[args.indexOf('-f') + 1];
    fs.writeFileSync(f, 'PRIVATE');
    fs.writeFileSync(`${f}.pub`, 'ssh-ed25519 AAAA shellby@pc');
    return { code: 0, stdout: '', stderr: '' };
  };
  const agent = agentMod.createAgent({ run, home });
  assert.deepEqual(await agent.ensureKey(fs), { ok: true, name: 'id_ed25519', created: true });
  assert.deepEqual(await agent.ensureKey(fs), { ok: true, name: 'id_ed25519', created: false });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].slice(0, 6), ['-q', '-t', 'ed25519', '-N', '', '-C']);
});

// ---- the service, with the stand-in ssh

function otherComputer() {
  const home = tmp('shellby-remote-home-');
  fs.mkdirSync(path.join(home, 'code', 'app', '.git'), { recursive: true });
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const slash = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"email":"me@example.com","authMethod":"claude.ai","subscriptionType":"pro"}'; exit 0; fi\nif [ "$1" = --version ]; then echo '2.1.9 (Claude Code)'; exit 0; fi\nexec "${slash(process.execPath)}" "${slash(FAKE_CLAUDE)}" "$@"\n`, { mode: 0o755 });
  process.env.SHELLBY_FAKE_SSH_HOME = home;
  delete process.env.SHELLBY_FAKE_SSH_LOG;
  return home;
}

function makeService({ sshConfig = '', computers = [], folders = [] } = {}) {
  const config = fakeConfig({ remoteComputers: computers, remoteFolders: folders });
  const dir = tmp('shellby-remote-profile-');
  let text = sshConfig;
  const agent = {
    service: async () => ({ installed: true, state: 'running', startType: 'auto' }),
    loaded: async () => ({ ok: true, keys: [] }),
    keyFiles: async () => [],
    needsPassphrase: async () => false,
    add: async () => ({ ok: true }),
    ensureKey: async () => ({ ok: true, name: 'id_ed25519', created: false }),
    keyPath: n => n,
    enable: async () => ({ ok: true }),
  };
  const terminals = [];
  const svc = createRemoteService({
    config, dir, fs, agent,
    spawn: (_file, args, opts) => spawn(process.execPath, [FAKE_SSH, ...args], opts),
    askpass: { env: async () => ({}) },
    openTerminal: async t => { terminals.push(t); return { ok: true, shell: 'wt' }; },
    readSshConfig: () => text,
    writeSshConfig: t => { text = t; },
  });
  return { svc, config, dir, terminals, sshConfig: () => text };
}

test('adding a computer: from your ssh settings, or a new one written there', () => {
  const { svc, config, sshConfig } = makeService({ sshConfig: 'Host vps\n  HostName 203.0.113.9\n' });
  assert.deepEqual(svc.addComputer('vps'), { ok: true, alias: 'vps' });
  assert.deepEqual(svc.addComputer('-oProxyCommand=calc'), { ok: false, error: 'Which computer?' });
  const made = svc.createComputer({ alias: 'homebox', address: 'localhost', user: 'me', port: 2222, jump: 'vps' });
  assert.deepEqual(made, { ok: true, alias: 'homebox' });
  assert.match(sshConfig(), /Host vps\n {2}HostName 203\.0\.113\.9\n\n# Added by Shellby\nHost homebox\n {4}HostName localhost\n {4}User me\n {4}Port 2222\n {4}ProxyJump vps\n$/);
  assert.deepEqual(config.get('remoteComputers').map(c => c.alias), ['vps', 'homebox']);
  assert.match(svc.createComputer({ alias: 'homebox', address: 'x' }).error, /already a computer called homebox/);
  assert.match(svc.createComputer({ alias: 'other', address: 'x', jump: 'nowhere' }).error, /isn't one of your computers/);
});

test('checking a computer: reached, and what Claude Code there says', { skip: needsSh }, async () => {
  otherComputer();
  const { svc } = makeService({ computers: [{ alias: 'sandbox' }] });
  const r = await svc.check('sandbox');
  assert.equal(r.check.ok, true, JSON.stringify(r));
  assert.deepEqual([r.check.version, r.check.loggedIn, r.check.email], ['2.1.9', true, 'me@example.com']);
  const off = makeService({ computers: [{ alias: 'unreachable' }] });
  const bad = await off.svc.check('unreachable');
  assert.deepEqual([bad.check.ok, bad.check.kind], [false, 'remote-unreachable']);
  assert.equal(off.config.get('remoteComputers')[0].check.kind, 'remote-unreachable', 'kept for Settings');
});

test('folders there: browsed, added with a stand-in here, and found again by it', { skip: needsSh }, async () => {
  otherComputer();
  const { svc, config, dir } = makeService({ computers: [{ alias: 'sandbox' }] });
  const list = await svc.browse('sandbox', '~/code');
  assert.deepEqual(list.folders, [{ name: 'app', git: true }]);
  assert.match((await svc.browse('sandbox', '~/nope')).error, /no folder ~\/nope/);
  assert.match((await svc.browse('sandbox', '../etc')).error, /starts with/);
  const added = await svc.addFolder('sandbox', '~/code/app/');
  assert.equal(added.ok, true);
  assert.equal(added.label, 'sandbox: ~/code/app');
  assert.ok(added.anchor.startsWith(path.join(dir, 'folders', 'sandbox') + path.sep));
  assert.ok(fs.statSync(added.anchor).isDirectory());
  assert.deepEqual(svc.placeOf(added.anchor.toUpperCase()), { host: 'sandbox', dir: '~/code/app', anchor: added.anchor });
  assert.equal(svc.placeOf(os.tmpdir()), null);
  assert.deepEqual((await svc.addFolder('sandbox', '~/code/app')).anchor, added.anchor, 'the same folder twice is one');
  assert.equal(config.get('remoteFolders').length, 1);
  const launch = svc.launch(svc.placeOf(added.anchor));
  assert.deepEqual([launch.host, launch.dir], ['sandbox', '~/code/app']);
  assert.deepEqual(svc.removeFolder(added.anchor), { ok: true });
  assert.ok(!fs.existsSync(added.anchor), 'its empty stand-in goes too');
});

test('removing a computer takes its folders with it', async () => {
  const anchor = tmp('shellby-anchor-');
  const { svc, config } = makeService({ computers: [{ alias: 'sandbox' }, { alias: 'vps' }], folders: [{ host: 'sandbox', dir: '~/a', anchor }] });
  assert.deepEqual(svc.removeComputer('sandbox'), { ok: true });
  assert.deepEqual(config.get('remoteComputers').map(c => c.alias), ['vps']);
  assert.deepEqual(config.get('remoteFolders'), []);
  assert.ok(fs.existsSync(anchor), 'a folder outside its own is never touched');
});

test('signing in to Claude Code there opens a terminal on that computer', async () => {
  const { svc, terminals } = makeService({ computers: [{ alias: 'sandbox' }] });
  assert.deepEqual(await svc.signInClaude('sandbox'), { ok: true, shell: 'wt' });
  assert.equal(terminals[0].host, 'sandbox');
  assert.match(terminals[0].script, /claude auth login/);
  assert.deepEqual(await svc.signInClaude('elsewhere'), { ok: false, error: 'Which computer?' });
});

test("Settings' view: your computers, the ones you could add, where each one goes", async () => {
  process.env.SHELLBY_FAKE_SSH_G = 'host sandbox\nhostname localhost\nuser blackhawk\nport 2222\nproxyjump vps\n';
  try {
    const { svc } = makeService({ sshConfig: 'Host vps\nHost sandbox\n  ProxyJump vps\n', computers: [{ alias: 'sandbox' }] });
    const v = await svc.view();
    assert.deepEqual(v.computers.map(c => [c.alias, c.where.host, c.where.port, c.where.jump]), [['sandbox', 'localhost', 2222, 'vps']]);
    assert.deepEqual(v.available.map(a => a.alias), ['vps']);
    assert.deepEqual(v.jumps, ['vps', 'sandbox']);
    assert.equal(v.agent.state, 'running');
  } finally {
    delete process.env.SHELLBY_FAKE_SSH_G;
  }
});

// ---- IPC

function ipcWith(svc = {}) {
  const ipc = createFakeIpc();
  const calls = [];
  const rec = name => (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const fake = new Proxy({}, { get: (_t, k) => svc[k] || rec(String(k)) });
  const d = { remoteService: fake, setFolder: dir => ({ cwd: dir }), answerRemote: (id, text) => { calls.push(['answer', id, text]); return true; } };
  registerRemoteIpc(ipc.ipcMain, d);
  return { ipc, calls };
}

test('IPC: a computer must look like one, and nothing odd reaches the service', async () => {
  const { ipc, calls } = ipcWith();
  for (const bad of ['-oProxyCommand=calc', '', null, 42, 'a b', 'x;y']) {
    for (const ch of ['remote:add', 'remote:check', 'remote:install', 'remote:sign-in', 'remote:setup-key', 'remote:remove']) {
      assert.deepEqual(await ipc.invoke(ch, bad), { ok: false, error: 'Which computer?' }, `${ch} ${bad}`);
    }
  }
  assert.deepEqual(await ipc.invoke('remote:browse', null), { ok: false, error: 'Which computer?' });
  assert.deepEqual(await ipc.invoke('remote:add-folder', { alias: 'sandbox' }), { ok: false, error: 'Which computer?' }, 'no folder');
  assert.deepEqual(await ipc.invoke('remote:unlock', '../id_rsa'), { ok: false, error: 'Which key?' });
  assert.equal(calls.length, 0);
  await ipc.invoke('remote:check', 'sandbox');
  await ipc.invoke('remote:add-folder', { alias: 'sandbox', dir: '~/code' });
  assert.deepEqual(calls, [['check', 'sandbox'], ['addFolder', 'sandbox', '~/code']]);
});

test('IPC: Work here only for a folder that is one of yours', async () => {
  const { ipc } = ipcWith({ placeOf: a => (a === 'C:\\anchor' ? { anchor: 'C:\\anchor' } : null) });
  assert.deepEqual(await ipc.invoke('remote:work-here', 'C:\\anchor'), { cwd: 'C:\\anchor' });
  assert.deepEqual(await ipc.invoke('remote:work-here', 'C:\\Windows'), { error: 'That folder is no longer one of yours.' });
});

test("IPC: an answer for ssh, and nothing past its length", async () => {
  const { ipc, calls } = ipcWith();
  await ipc.invoke('remote:answer', { id: 'q1', answer: 'secret' });
  await ipc.invoke('remote:answer', { id: 'q2', answer: 'x'.repeat(5000) });
  await ipc.invoke('remote:answer', { id: 'q3', answer: null });
  assert.equal(await ipc.invoke('remote:answer', null), false);
  assert.deepEqual(calls, [['answer', 'q1', 'secret'], ['answer', 'q2', null], ['answer', 'q3', null]]);
});

test("IPC: the crab's window and strangers get none of it", async () => {
  const { ipc } = ipcWith();
  await assert.rejects(ipc.invokeAs(ipc.senders.critter, 'remote:view'), /Not allowed/);
  await assert.rejects(ipc.invokeAs(ipc.senders.stranger, 'remote:answer', { id: 'q', answer: 'x' }), /Not allowed/);
});
