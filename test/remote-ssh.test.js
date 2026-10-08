// Claude Code on another computer (src/main/remote/ssh.js): what goes on ssh's
// command line, and what the other computer's shell makes of it. The scripts
// are run for real through sh (Git Bash on Windows), with a stand-in claude
// that prints what it was given, so the quoting is tested end to end.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ssh = require('../src/main/remote/ssh');
const { findBash } = require('../src/main/hooks/test');

const bash = findBash();

// A home with a claude in ~/.local/bin that prints its arguments (one per
// line), its folder and the variables Shellby sets, then echoes stdin back.
function fakeHome() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-remote-')));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'echo "cwd=$(pwd)"',
    'echo "owned=$SHELLBY_OWNED"',
    'for a in "$@"; do echo "arg=$a"; done',
    'for a in "$@"; do case "$a" in */tmp*) [ -f "$a" ] && echo "mcp=$(cat "$a")";; esac; done',
    'cat',
  ].join('\n'), { mode: 0o755 });
  return home;
}

// What the other computer's login shell does with ssh's last argument.
function runRemote(command, { home, input = '' }) {
  const r = spawnSync(bash, ['-c', command], { input, env: { ...process.env, HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('host names: aliases and addresses, never an option or shell syntax', () => {
  for (const ok of ['sandbox', 'home-box', 'build_01', 'my.server.lan']) assert.ok(ssh.isHost(ok), ok);
  for (const bad of ['-oProxyCommand=calc', '', 'a b', 'box;rm', 'box$(x)', 'a/b', '.hidden', 'x'.repeat(64), 'box\n', null, 3]) assert.ok(!ssh.isHost(bad), String(bad));
  assert.ok(ssh.isAddress('192.168.1.20'));
  assert.ok(ssh.isAddress('[fe80::1]'));
  assert.ok(!ssh.isAddress('-oProxyCommand=x'));
  assert.ok(ssh.isUser('blackhawk'));
  assert.ok(!ssh.isUser('-l'));
  assert.ok(ssh.isPort(2222));
  assert.ok(!ssh.isPort(0) && !ssh.isPort(70000) && !ssh.isPort(22.5));
});

test('remote folders: absolute or under home, no steps up, nothing hidden', () => {
  for (const ok of ['~', '~/code/app', '/srv/app', "/home/me/it's mine", '/home/me/$HOME']) assert.ok(ssh.isRemoteDir(ok), ok);
  for (const bad of ['', 'code/app', '~other/app', '/srv/../etc', '/a\nb', 'C:\\Users', null, '/'.repeat(2000)]) assert.ok(!ssh.isRemoteDir(bad), String(bad));
  assert.equal(ssh.cleanDir(' ~/code//app/ '), '~/code/app');
  assert.equal(ssh.cleanDir('/'), '/');
});

test('the line ssh sends holds no quote or backslash a login shell could misread', () => {
  const line = ssh.wrap(`echo "it's $HOME" \\ 'x'`);
  assert.match(line, /^exec sh -c 'set -f; IFS=; x=\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\); eval \$x'$/);
  assert.equal((line.match(/'/g) || []).length, 2);
  assert.ok(!line.includes('"') && !line.includes('\\'));
});

test('ssh arguments: the host after --, keepalives, and the modes', () => {
  const args = ssh.sshArgs('sandbox', 'echo hi');
  assert.equal(args[0], '-T');
  assert.equal(args.at(-3), '--');
  assert.equal(args.at(-2), 'sandbox');
  assert.ok(args.includes('ServerAliveInterval=30'));
  assert.ok(!args.includes('BatchMode=yes'));
  assert.ok(ssh.sshArgs('sandbox', 'x', { batch: true }).includes('BatchMode=yes'));
  assert.ok(ssh.sshArgs('sandbox', 'x', { acceptNew: true }).includes('StrictHostKeyChecking=accept-new'));
  assert.equal(ssh.sshArgs('sandbox', 'x', { tty: true })[0], '-t');
  assert.throws(() => ssh.sshArgs('-oProxyCommand=calc', 'x'), /bad host/);
});

test('a session runs claude in the folder, with every argument exactly as given', { skip: !bash && 'needs sh' }, () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, "it's here"), { recursive: true });
  const tricky = ['-p', '--append-system-prompt', `Line one\nIt's "quoted" $HOME \`x\` \\ ; | & *`, '--settings', '{"outputStyle":"Explanatory"}', ''];
  const script = ssh.sessionScript({ dir: "~/it's here", args: tricky, env: { SHELLBY_OWNED: '1', 'bad name': 'x' } });
  const r = runRemote(ssh.wrap(script), { home, input: '{"type":"user"}\n' });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines[0].endsWith("it's here"), lines[0]);
  assert.equal(lines[1], 'owned=1');
  const args = r.out.split('arg=').slice(1).map(s => s.replace(/\n$/, ''));
  args[args.length - 1] = args.at(-1).split('\n')[0]; // the last one is followed by stdin's echo
  assert.deepEqual(args, tricky);
  assert.match(r.out, /\{"type":"user"\}/, 'stdin reaches claude');
});

test('an MCP config comes over stdin into a file of its own, never onto a command line', { skip: !bash && 'needs sh' }, () => {
  const home = fakeHome();
  const config = JSON.stringify({ mcpServers: { db: { command: 'x', env: { TOKEN: "s3cr3t'\"" } } } });
  const script = ssh.sessionScript({ dir: '~', args: ['--mcp-config', ssh.MCP_FILE] });
  assert.ok(!script.includes('s3cr3t'));
  const r = runRemote(ssh.wrap(script), { home, input: `${config}\n{"type":"user"}\n` });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`mcp=${config}`), r.out);
  assert.match(r.out, /\{"type":"user"\}/, 'and stdin carries on to claude after it');
});

test('a missing folder or claude says which, with codes of their own', { skip: !bash && 'needs sh' }, () => {
  const home = fakeHome();
  const gone = runRemote(ssh.wrap(ssh.sessionScript({ dir: '~/nope', args: [] })), { home });
  assert.equal(gone.code, 97);
  assert.equal(ssh.troubleOf(gone.err).kind, 'remote-no-folder');
  fs.rmSync(path.join(home, '.local'), { recursive: true });
  const none = runRemote(ssh.wrap(ssh.sessionScript({ dir: '~', args: [] })), { home: home });
  // Git Bash's own PATH may still hold a claude.exe: only judge the case where it doesn't.
  if (none.code === 96) assert.equal(ssh.troubleOf(none.err).kind, 'remote-no-claude');
});

test('the probe reads what the other computer has', { skip: !bash && 'needs sh' }, () => {
  const home = fakeHome();
  const r = runRemote(ssh.wrap(ssh.probeScript()), { home });
  const p = ssh.parseProbe(r.out);
  assert.equal(p.reached, true);
  assert.ok(p.claude?.endsWith('claude'), r.out);
  assert.equal(ssh.parseProbe('').reached, false);
  const signedIn = ssh.parseProbe('shellby-ok\nclaude: /home/u/.local/bin/claude\nversion: 2.1.4 (Claude Code)\nauth: {"loggedIn":true,"email":"u@example.com","authMethod":"claude.ai","subscriptionType":"max"}\ngit: /usr/bin/git\ncurl:\n');
  assert.deepEqual([signedIn.version, signedIn.loggedIn, signedIn.email, signedIn.subscriptionType, signedIn.git, signedIn.curl], ['2.1.4', true, 'u@example.com', 'max', true, false]);
  assert.equal(ssh.parseProbe('shellby-ok\nclaude:\nauth: not json').loggedIn, false);
});

test('listing a folder: its subfolders, git repos marked', { skip: !bash && 'needs sh' }, () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, 'code', 'app', '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, 'code', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(home, 'code', '.cache'), { recursive: true });
  const r = runRemote(ssh.wrap(ssh.listScript('~/code')), { home });
  const list = ssh.parseList(r.out);
  assert.ok(list.here.endsWith('code'), list.here);
  assert.deepEqual(list.folders.sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'app', git: true }, { name: 'notes', git: false }]);
});

test('authorizing a key adds it once', { skip: !bash && 'needs sh' }, () => {
  const home = fakeHome();
  const key = 'ssh-ed25519 AAAAC3Nz shellby@pc';
  for (let i = 0; i < 2; i++) assert.match(runRemote(ssh.wrap(ssh.authorizeScript()), { home, input: `${key}\n` }).out, /shellby-ok/);
  assert.equal(fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), `${key}\n`);
});

test('ssh -G output: the resolved host, user, port and jump', () => {
  const r = ssh.parseResolved('host sandbox\nhostname 10.0.0.5\nuser blackhawk\nport 2222\nproxyjump vps\nidentityfile ~/.ssh/sandbox_key\nidentityfile ~/.ssh/id_rsa\n');
  assert.deepEqual(r, { hostname: '10.0.0.5', user: 'blackhawk', port: 2222, proxyjump: 'vps', identityfiles: ['~/.ssh/sandbox_key', '~/.ssh/id_rsa'] });
  assert.equal(ssh.parseResolved('proxyjump none').proxyjump, null);
});

test('reading ~/.ssh/config: the hosts you could pick, Shellby\'s own marked', () => {
  const text = [
    'Host *', '  ServerAliveInterval 60',
    'Host vps', '    HostName 203.0.113.9', '    User admin',
    'Host sandbox', '    HostName localhost', '    Port 2222', '    User blackhawk', '    ProxyJump vps',
    'Host a b !c *.lan', '  User x',
    'Match host z', '  User nobody',
    ssh.MARK, 'Host homebox', '  HostName=192.168.1.20',
    'Host VPS', '  User dup',
  ].join('\n');
  const hosts = ssh.parseConfig(text);
  assert.deepEqual(hosts.map(h => h.alias), ['vps', 'sandbox', 'a', 'b', 'homebox']);
  assert.deepEqual(hosts[1], { alias: 'sandbox', hostName: 'localhost', user: 'blackhawk', port: 2222, proxyJump: 'vps', shellby: false });
  assert.equal(hosts.at(-1).shellby, true);
  assert.equal(hosts.at(-1).hostName, '192.168.1.20');
});

test('a Host block from the add form, every value checked', () => {
  const ok = ssh.hostBlock({ alias: 'homebox', address: '192.168.1.20', user: 'me', port: 2222, jump: 'vps', identityFile: '~/.ssh/id_ed25519' });
  assert.equal(ok.text, [ssh.MARK, 'Host homebox', '    HostName 192.168.1.20', '    User me', '    Port 2222', '    ProxyJump vps', '    IdentityFile ~/.ssh/id_ed25519'].join('\n'));
  assert.ok(!ssh.hostBlock({ alias: 'homebox', address: 'x', port: 22 }).text.includes('Port'));
  assert.equal(ssh.hostBlock({ alias: 'h', address: 'x\nProxyCommand calc' }).ok, false);
  assert.equal(ssh.hostBlock({ alias: 'h', address: 'x', user: 'a b' }).ok, false);
  assert.equal(ssh.hostBlock({ alias: 'h', address: 'x', jump: 'h' }).ok, false);
  assert.equal(ssh.hostBlock({ alias: 'h', address: 'x', port: 0 }).ok, false);
  assert.equal(ssh.hostBlock({ alias: '-h', address: 'x' }).ok, false);
});

test('appending a block keeps the file as it was, line endings too', () => {
  assert.equal(ssh.appendBlock('', 'Host a'), 'Host a\n');
  assert.equal(ssh.appendBlock('Host b\n  User x\n\n\n', 'Host a'), 'Host b\n  User x\n\nHost a\n');
  assert.equal(ssh.appendBlock('Host b\r\n', 'Host a\n  User y'), 'Host b\r\n\r\nHost a\r\n  User y\r\n');
});

test('anchors: readable, distinct, under the host', () => {
  const a = ssh.anchorFor('C:\\r', 'sandbox', '~/code/my app', 'abcdef123');
  assert.equal(a, path.join('C:\\r', 'sandbox', 'my-app-abcdef'));
  assert.equal(ssh.anchorName('~', 'abcdef'), 'home-abcdef');
  assert.equal(ssh.anchorName('/..weird/../', '123456'), 'weird-123456');
  assert.equal(ssh.placeLabel('sandbox', '~/code'), 'sandbox: ~/code');
});

test('ssh troubles become sentences', () => {
  assert.equal(ssh.troubleOf('user@host: Permission denied (publickey).').kind, 'remote-auth');
  assert.equal(ssh.troubleOf('ssh: Could not resolve hostname box: No such host is known.').kind, 'remote-name');
  assert.equal(ssh.troubleOf('ssh: connect to host 10.0.0.5 port 22: Connection timed out').kind, 'remote-unreachable');
  assert.equal(ssh.troubleOf('Host key verification failed.').kind, 'remote-host-key');
  assert.equal(ssh.troubleOf('shellby: claude: command not found').kind, 'remote-no-claude');
  assert.equal(ssh.troubleOf('Connection closed by 203.0.113.9 port 22').kind, 'remote-unreachable');
  assert.equal(ssh.troubleOf('API Error: overloaded'), null);
  // Claude Code's own words from over there are its trouble, not ssh's.
  assert.equal(ssh.troubleOf("EACCES: permission denied, open '/etc/x'"), null);
  assert.equal(ssh.troubleOf('write EPIPE: broken pipe'), null);
});
