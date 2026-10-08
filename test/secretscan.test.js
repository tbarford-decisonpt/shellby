// The secret scan before a push: the patterns on their own, a patch read the
// way git prints it, and real git in a temp folder (an unpushed commit with a
// key in it, an untracked .env, and what's already on the remote left alone).
// Fake secrets are glued together at runtime so this file never holds one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scan = require('../src/main/secretscan');
const leaving = require('../src/main/leaving');

const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const ANT = 'sk-ant-' + 'api03-abcdefghijklmnop1234567890';
const PEM = '-----BEGIN RSA ' + 'PRIVATE KEY-----';

test('vendor keys and private keys are recognised, by kind', () => {
  assert.equal(scan.lineSecret(`const key = '${AWS}';`), 'an AWS access key');
  assert.equal(scan.lineSecret(`token: ${GH}`), 'a GitHub token');
  assert.equal(scan.lineSecret(`ANTHROPIC_API_KEY=${ANT}`), 'an Anthropic API key');
  assert.equal(scan.lineSecret(PEM), 'a private key');
  assert.equal(scan.lineSecret('glpat-' + 'abcdefghij0123456789'), 'a GitLab token');
  assert.equal(scan.lineSecret('password = "hunter2hunter2X9"'), 'a password or key in the code');
});

test('placeholders, env lookups and allowed lines are not secrets', () => {
  for (const line of [
    'const apiKey = process.env.API_KEY;',
    'password = "your-password-here"',
    'api_key: "xxxxxxxxxxxxxxxx"',
    'secret_key = "${SECRET_KEY}"',
    'password = "correcthorsebattery"', // no digit: reads as words, not a key
    `const k = '${AWS}'; // secretscan:allow`,
    '',
    null,
  ]) assert.equal(scan.lineSecret(line), null, String(line));
});

test('files that are secrets by name; their templates are not', () => {
  assert.equal(scan.riskyFile('.env'), 'an environment file');
  assert.equal(scan.riskyFile('app/.env.local'), 'an environment file');
  assert.equal(scan.riskyFile('.env.example'), null);
  assert.equal(scan.riskyFile('.env.sample'), null);
  assert.equal(scan.riskyFile('home/.ssh/id_ed25519'), 'an SSH private key');
  assert.equal(scan.riskyFile('id_ed25519.pub'), null);
  assert.equal(scan.riskyFile('certs\\server.pem'), 'a key or certificate file');
  assert.equal(scan.riskyFile('src/env.js'), null);
});

test('a patch: only added lines count, with their line numbers; deleted files do not', () => {
  const patch = [
    'diff --git a/src/config.js b/src/config.js',
    '--- a/src/config.js',
    '+++ b/src/config.js',
    '@@ -10,0 +11,2 @@',
    '+const region = "eu-west-1";',
    `+const key = "${AWS}";`,
    '@@ -20 +21 @@',
    `-const old = "${GH}";`,
    '+const old = process.env.GH;',
    'diff --git a/.env b/.env',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1 @@',
    '+DEBUG=1',
    'diff --git a/server.pem b/server.pem',
    'deleted file mode 100644',
    '--- a/server.pem',
    '+++ /dev/null',
  ].join('\n');
  const found = scan.scanPatch(patch);
  assert.deepEqual(found.map(f => [f.file, f.line ?? null, f.kind]), [
    ['src/config.js', 12, 'an AWS access key'],
    ['.env', null, 'an environment file'],
  ]);
  assert.equal(scan.describe(found[0]), 'src/config.js:12 (an AWS access key)');
  assert.ok(!scan.describe(found[0]).includes(AWS), 'never the value itself');
});

function repo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-secrets-')));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'proj');
  fs.mkdirSync(dir);
  g(base, 'init', '-q', '--bare', '-b', 'main', origin);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.env\n');
  // Already pushed: not this push's business.
  fs.writeFileSync(path.join(dir, 'old.js'), `const k = "${GH}";\n`);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  g(dir, 'remote', 'add', 'origin', origin);
  g(dir, 'push', '-q', '-u', 'origin', 'main');
  const commit = (file, text) => { fs.writeFileSync(path.join(dir, file), text); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', `change ${file}`); };
  return { base, dir, g, commit, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('outgoing: a key in an unpushed commit is found; what the remote has is not', async () => {
  const r = repo();
  try {
    assert.deepEqual((await scan.outgoing(r.dir)).findings, [], 'nothing unpushed, nothing to say');
    r.commit('aws.js', `module.exports = {\n  id: "${AWS}",\n};\n`);
    const out = await scan.outgoing(r.dir);
    assert.equal(out.ok, true);
    assert.deepEqual(out.findings.map(f => [f.file, f.line, f.kind]), [['aws.js', 2, 'an AWS access key']]);
  } finally { r.done(); }
});

test('outgoing: a key added and then deleted before the push still goes out in history', async () => {
  const r = repo();
  try {
    r.commit('k.js', `x = "${ANT}"\n`);
    r.commit('k.js', 'x = process.env.KEY\n');
    const out = await scan.outgoing(r.dir);
    assert.deepEqual(out.findings.map(f => f.kind), ['an Anthropic API key']);
  } finally { r.done(); }
});

test('outgoing: a named branch and remote; another remote having it is not this one having it', async () => {
  const r = repo();
  try {
    r.g(r.dir, 'checkout', '-q', '-b', 'side');
    r.commit('side.js', `x = "${AWS}"\n`);
    r.g(r.dir, 'checkout', '-q', 'main');
    assert.deepEqual((await scan.outgoing(r.dir)).findings, [], 'HEAD is main, which is pushed');
    const side = await scan.outgoing(r.dir, undefined, { rev: 'refs/heads/side', remote: 'origin' });
    assert.deepEqual(side.findings.map(f => f.file), ['side.js']);
    // A fork that has it doesn't make it safe to send to origin.
    const fork = path.join(r.base, 'fork.git');
    r.g(r.base, 'init', '-q', '--bare', fork);
    r.g(r.dir, 'remote', 'add', 'fork', fork);
    r.g(r.dir, 'push', '-q', 'fork', 'side');
    assert.deepEqual((await scan.outgoing(r.dir, undefined, { rev: 'refs/heads/side' })).findings, [], 'any remote');
    assert.deepEqual((await scan.outgoing(r.dir, undefined, { rev: 'refs/heads/side', remote: 'origin' })).findings.map(f => f.file), ['side.js']);
    assert.equal((await scan.outgoing(r.dir, undefined, { rev: '--all' })).ok, false, 'an option is not a revision');
  } finally { r.done(); }
});

test('atRisk: an untracked .env and an edited file are found; an ignored one is not', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, '.env'), `TOKEN=${GH}\n`);
    fs.writeFileSync(path.join(r.dir, 'ignored.env'), `TOKEN=${GH}\n`);
    fs.writeFileSync(path.join(r.dir, 'old.js'), `const k = process.env.K;\nconst p = "${PEM}";\n`);
    const out = await scan.atRisk(r.dir, { dirs: [r.dir], unpushed: false });
    const got = out.findings.map(f => `${f.file}:${f.line ?? '-'}:${f.where}`).sort();
    assert.deepEqual(got, ['.env:-:uncommitted', '.env:1:uncommitted', 'old.js:2:uncommitted']);
  } finally { r.done(); }
});

test('"Is it safe to leave?" lists a secret waiting to go out, without holding up a shutdown for it', async () => {
  const r = repo();
  try {
    r.commit('aws.js', `id = "${AWS}"\n`);
    const [p] = await leaving.check([r.dir], undefined, { scan: scan.atRisk });
    assert.equal(p.secrets.findings.length, 1);
    const v = leaving.verdict([p]);
    assert.equal(v.counts.secrets, 1);
    assert.match(v.headline, /1 project has something that looks like a secret waiting to go out/);
    assert.match(v.lines[0], /^proj: 1 commit not pushed \(main\), something that looks like a secret \(aws\.js:1\)$/);
    // The unpushed commit holds a shutdown; the secret alone wouldn't.
    assert.equal(leaving.verdict([{ ...p, unpushed: { commits: 0, branches: [] } }]).hold, false);
  } finally { r.done(); }
});

test('a clean repo is not scanned at all, and a scan that throws is shrugged off', async () => {
  const r = repo();
  try {
    let asked = 0;
    const [p] = await leaving.check([r.dir], undefined, { scan: async () => { asked++; return { findings: [] }; } });
    assert.equal(asked, 0);
    assert.equal(p.secrets, undefined);
    fs.writeFileSync(path.join(r.dir, 'n.txt'), 'n\n');
    const [q] = await leaving.check([r.dir], undefined, { scan: async () => { throw new Error('boom'); } });
    assert.equal(q.ok, true);
    assert.equal(q.secrets, undefined);
  } finally { r.done(); }
});
