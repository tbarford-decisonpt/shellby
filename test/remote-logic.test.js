// Settings → Other computers, its words and decisions (src/renderer/panel/remote-logic.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/panel/remote-logic');

const signedIn = { ok: true, reached: true, os: 'Linux x86_64', claude: '/home/u/.local/bin/claude', version: '2.1.4', loggedIn: true, email: 'u@example.com', authMethod: 'claude.ai', subscriptionType: 'max' };

test('where ssh goes, in a line', () => {
  assert.equal(L.whereLine({ host: 'localhost', user: 'blackhawk', port: 2222, jump: 'vps' }), 'blackhawk@localhost:2222, through vps');
  assert.equal(L.whereLine({ host: '10.0.0.5', user: null, port: 22 }), '10.0.0.5');
  assert.equal(L.whereLine(null), '');
});

test('a computer not looked at yet offers Connect', () => {
  const [s] = L.steps({ alias: 'sandbox', check: null });
  assert.equal(s.state, 'todo');
  assert.deepEqual(s.actions.map(a => a.id), ['check']);
});

test('a refused sign-in offers the agent while a passphrase key is locked', () => {
  const c = { alias: 'sandbox', check: { ok: false, kind: 'remote-auth', message: 'no' } };
  const keys = [{ name: 'sandbox_key', locked: true, loaded: false }];
  assert.deepEqual(L.steps(c, { agent: { state: 'stopped' }, keys })[0].actions.map(a => a.id), ['agent-on', 'setup-key', 'check']);
  const on = L.steps(c, { agent: { state: 'running' }, keys })[0].actions;
  assert.deepEqual(on.map(a => a.id), ['unlock', 'setup-key', 'check']);
  assert.equal(on[0].key, 'sandbox_key');
  // Nothing locked: a password is all there is.
  assert.deepEqual(L.steps(c, { agent: { state: 'running' }, keys: [] })[0].actions.map(a => a.id), ['setup-key', 'check']);
});

test('an unreachable computer only offers to try again', () => {
  const s = L.steps({ alias: 'x', check: { ok: false, kind: 'remote-unreachable', message: "Shellby couldn't reach that computer." } })[0];
  assert.equal(s.state, 'bad');
  assert.deepEqual(s.actions.map(a => a.id), ['check']);
});

test('Claude Code there: install, sign in, or ready', () => {
  const none = L.steps({ check: { ...signedIn, claude: null } });
  assert.deepEqual(none.map(s => s.state), ['ok', 'todo']);
  assert.equal(none[1].actions[0].id, 'install');
  const out = L.steps({ check: { ...signedIn, loggedIn: false } });
  assert.equal(out[1].actions[0].id, 'sign-in');
  const ok = L.steps({ check: signedIn });
  assert.deepEqual(ok.map(s => s.state), ['ok', 'ok']);
  assert.match(ok[1].text, /2\.1\.4, signed in as u@example\.com \(max\)/);
  assert.ok(L.ready({ check: signedIn }));
  assert.ok(!L.ready({ check: { ...signedIn, loggedIn: false } }));
  // Signed in with an API key: works, but says it bills per token.
  const api = L.steps({ check: { ...signedIn, authMethod: 'api-key' } })[1];
  assert.equal(api.state, 'todo');
  assert.match(api.text, /bills per token/);
});

test('busy shows one step that says so', () => {
  assert.deepEqual(L.steps({ busy: true, check: signedIn }).map(s => s.state), ['busy']);
});

test('the agent line', () => {
  const locked = [{ name: 'sandbox_key', locked: true, loaded: false }];
  assert.equal(L.agentLine({ state: 'stopped', startType: 'disabled' }, locked).action.id, 'agent-on');
  assert.equal(L.agentLine({ state: 'stopped' }, []).action, null);
  const on = L.agentLine({ state: 'running' }, [{ name: 'a', loaded: true }, ...locked]);
  assert.match(on.text, /holding a/);
  assert.equal(on.action.id, 'unlock');
  assert.match(L.agentLine(null, []).text, /isn't installed/);
});

test("ssh's prompts in plain words", () => {
  const pass = L.askText({ prompt: "Enter passphrase for key 'C:\\Users\\me/.ssh/sandbox_key':", kind: 'passphrase' });
  assert.equal(pass.lede, 'ssh needs the passphrase for sandbox_key.');
  assert.equal(pass.secret, true);
  assert.equal(L.askText({ prompt: "blackhawk@10.0.0.5's password:", kind: 'password' }).lede, 'ssh needs the password for blackhawk@10.0.0.5.');
  assert.equal(L.askText({ prompt: 'Are you sure (yes/no)?', kind: 'confirm' }).confirm, true);
  assert.equal(L.askText({ prompt: 'Verification code:', kind: 'other' }).secret, true);
});

test('the add form', () => {
  assert.equal(L.formProblem({ alias: 'homebox', address: '192.168.1.20', port: '' }), null);
  assert.match(L.formProblem({ alias: '-x', address: 'a' }), /short name/);
  assert.match(L.formProblem({ alias: 'a', address: '' }), /address/);
  assert.match(L.formProblem({ alias: 'a', address: 'b', port: '99999' }), /port/);
});

test('a stand-in folder is named for where it really is', () => {
  const folders = [{ host: 'sandbox', dir: '~/code/app', anchor: 'C:\\Users\\me\\AppData\\Roaming\\Shellby\\remote\\folders\\sandbox\\app-abc123' }];
  assert.equal(L.placeName(folders, 'c:\\users\\me\\appdata\\roaming\\shellby\\remote\\folders\\sandbox\\app-abc123'), 'sandbox: ~/code/app');
  assert.equal(L.placeName(folders, 'C:\\code'), null);
  assert.equal(L.placeName(null, 'C:\\code'), null);
});

test('moving about the folders there', () => {
  assert.equal(L.parentDir('~/code/app'), '~/code');
  assert.equal(L.parentDir('~/code'), '~');
  assert.equal(L.parentDir('/srv'), '/');
  assert.equal(L.parentDir('~'), null);
  assert.equal(L.parentDir('/'), null);
  assert.equal(L.joinDir('~', 'code'), '~/code');
  assert.equal(L.joinDir('/', 'srv'), '/srv');
});

test('first run without Claude Code here starts in a folder on a computer that is ready', () => {
  const folder = (anchor, dir) => ({ anchor, dir, label: `box: ${dir}` });
  assert.equal(L.readyFolder([]), null);
  assert.equal(L.readyFolder(undefined), null);
  // Ready, but no folder there yet.
  assert.equal(L.readyFolder([{ alias: 'box', check: signedIn, folders: [] }]), null);
  // A folder, but Claude Code there isn't signed in.
  assert.equal(L.readyFolder([{ alias: 'old', check: { ...signedIn, loggedIn: false }, folders: [folder('a1', '~/x')] }]), null);
  assert.equal(L.readyFolder([
    { alias: 'old', check: { ...signedIn, loggedIn: false }, folders: [folder('a1', '~/x')] },
    { alias: 'box', check: signedIn, folders: [folder('a2', '~/app'), folder('a3', '~/other')] },
  ]), 'a2');
});
