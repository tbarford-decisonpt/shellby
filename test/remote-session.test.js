// A conversation in a folder on another computer: its Claude Code runs there
// over ssh (session.js remote). A stand-in ssh (fixtures/fake-ssh.js) runs the
// remote command with sh, in a home of its own whose claude is the fake CLI,
// so the whole path is real except the network.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeSession } = require('../src/main/session');
const { SessionManager } = require('../src/main/sessions');
const { findBash } = require('../src/main/hook-test');

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const FAKE_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
const skip = !findBash() && 'needs sh';

const live = new Set();
after(() => { for (const s of live) s.close(); });

// The other computer: a home with ~/proj, and claude on ~/.local/bin.
function otherComputer() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-remote-home-')));
  fs.mkdirSync(path.join(home, 'proj'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const slash = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(FAKE_CLAUDE)}" "$@"\n`, { mode: 0o755 });
  const log = path.join(home, 'ssh-log.jsonl');
  process.env.SHELLBY_FAKE_SSH_HOME = home;
  process.env.SHELLBY_FAKE_SSH_LOG = log;
  return { home, log, runs: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}

const launch = (host, dir) => ({ exe: process.execPath, argsPrefix: [FAKE_SSH], host, dir, env: {} });

function makeSession({ host = 'sandbox', dir = '~/proj', ...opts } = {}) {
  const anchor = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-anchor-'));
  const s = new ClaudeSession({ exe: null, cwd: anchor, mode: 'ask', remote: () => launch(host, dir), ...opts });
  live.add(s);
  const items = [];
  s.on('item', i => items.push(i));
  return { s, items, anchor };
}

function waitFor(session, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for item')), ms);
    session.on('item', function onItem(i) {
      if (pred(i)) { clearTimeout(t); session.off('item', onItem); resolve(i); }
    });
  });
}

test('a turn runs on the other computer, in its folder', { skip }, async () => {
  const pc = otherComputer();
  const { s, items, anchor } = makeSession();
  s.send('edit made-there.txt hello from afar');
  const result = await waitFor(s, i => i.kind === 'result');
  assert.equal(result.ok, true, JSON.stringify(items.filter(i => i.kind === 'error')));
  assert.equal(fs.readFileSync(path.join(pc.home, 'proj', 'made-there.txt'), 'utf8'), 'hello from afar\n');
  assert.ok(!fs.existsSync(path.join(anchor, 'made-there.txt')), 'nothing lands in the stand-in folder');
  const [args] = pc.runs();
  assert.equal(args[args.indexOf('--') + 1], 'sandbox');
  assert.match(args.at(-1), /^exec sh -c 'set -f; IFS=; x=\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\); eval \$x'$/);
  s.close();
});

test('a follow-up and a permission card go over the same connection', { skip }, async () => {
  otherComputer();
  const { s, items } = makeSession();
  s.send('hello');
  await waitFor(s, i => i.kind === 'result');
  s.send('again');
  await waitFor(s, i => i.kind === 'result' && items.filter(x => x.kind === 'result').length === 2);
  assert.deepEqual(items.filter(i => i.kind === 'text').map(i => i.text), ['echo: hello (mode=default)', 'echo: again (mode=default)']);
  s.send('tool please');
  const perm = await waitFor(s, i => i.kind === 'permission');
  assert.ok(s.respond(perm.requestId, 'allow'));
  await waitFor(s, i => i.kind === 'result' && items.filter(x => x.kind === 'result').length === 3);
  assert.ok(items.some(i => i.kind === 'text' && i.text === 'ALLOWED'));
  s.close();
});

test('an MCP config reaches the other end without going on its command line', { skip }, async () => {
  const pc = otherComputer();
  const mcpConfig = { mcpServers: { db: { command: 'db-server', env: { TOKEN: 'never-on-a-command-line' } } } };
  const { s } = makeSession({ mcpConfig });
  s.send('hello');
  const result = await waitFor(s, i => i.kind === 'result');
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(pc.runs()).includes('never-on-a-command-line'));
  s.close();
});

test('an unreachable computer says so, and points at Other computers', { skip }, async () => {
  otherComputer();
  const { s } = makeSession({ host: 'unreachable' });
  s.send('hello');
  const error = await waitFor(s, i => i.kind === 'error');
  assert.equal(error.trouble.kind, 'remote-unreachable');
  assert.equal(error.trouble.action.id, 'remote');
  s.close();
});

test('a folder that has gone from the other computer says so', { skip }, async () => {
  otherComputer();
  const { s } = makeSession({ dir: '~/gone' });
  s.send('hello');
  const error = await waitFor(s, i => i.kind === 'error');
  assert.equal(error.trouble.kind, 'remote-no-folder');
  s.close();
});

test('the manager opens a tab in a remote folder with no Claude Code on this PC', { skip }, async () => {
  otherComputer();
  const anchor = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-anchor-'));
  const history = { create() {}, update() {}, append() {}, get: () => ({ title: 'x' }), markTurn() {}, setReady() {}, load: () => [] };
  const manager = new SessionManager({
    getExe: () => null, history, getMode: () => 'ask', getModel: () => '',
    getRemote: cwd => (cwd === anchor ? launch('sandbox', '~/proj') : null),
  });
  assert.throws(() => manager.open({ tabId: 'local', cwd: os.tmpdir() }), /not installed/);
  const tab = manager.open({ tabId: 'there', cwd: anchor });
  live.add(tab.session);
  manager.send('there', 'hello', { kind: 'user', text: 'hello' });
  const result = await waitFor(tab.session, i => i.kind === 'result');
  assert.equal(result.ok, true);
  tab.session.close();
});
