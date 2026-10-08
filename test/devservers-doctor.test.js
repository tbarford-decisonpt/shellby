// The port and environment doctor (src/main/devservers/doctor.js, doctor-io.js):
// a taken port read from what real servers print, who holds it, the flag that
// moves each framework, .env keys by name only, and the Node version a project
// asks for.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('../src/main/devservers/doctor');
const io = require('../src/main/devservers/doctor-io');

test('a taken port, as servers say it', () => {
  const cases = [
    ['Error: listen EADDRINUSE: address already in use :::3000', 3000],
    ['Error: listen EADDRINUSE: address already in use 127.0.0.1:8080', 8080],
    ['error when starting dev server:\nError: Port 5173 is already in use', 5173],
    ['Error: Port 5173 is in use', 5173],
    ['OSError: [Errno 98] Address already in use: 0.0.0.0:8000', 8000],
    ['? Something is already running on port 3000.', 3000],
    ['Error: Could not bind to port 4200', 4200],
    ['Port 4321 is already in use', 4321],
  ];
  for (const [line, port] of cases) assert.equal(doctor.portInUse(line.split('\n')), port, line);
  // Next moving along by itself isn't a crash about the port.
  assert.equal(doctor.portInUse([' ⚠ Port 3000 is in use, trying 3001 instead.']), null);
  assert.equal(doctor.portInUse(['  ➜  Local:   http://localhost:5173/', 'ready in 300 ms']), null);
  assert.equal(doctor.portInUse([]), null);
  // The last one said wins.
  assert.equal(doctor.portInUse(['Port 3000 is in use', 'Error: listen EADDRINUSE: address already in use :::3001']), 3001);
});

test('moving a server: the flag its framework reads, and PORT for everything', () => {
  assert.deepEqual(doctor.portArgs('npm', 'vite', 5174), { args: '-- --port 5174', env: { PORT: '5174' }, flag: '--port' });
  assert.deepEqual(doctor.portArgs('pnpm', 'next', 3001), { args: '--port 3001', env: { PORT: '3001' }, flag: '--port' });
  assert.equal(doctor.portArgs('npm', 'vercel', 3001).args, '-- --listen 3001');
  // Only PORT: create-react-app, plain node, and anything unknown.
  assert.deepEqual(doctor.portArgs('npm', 'create-react-app', 3001), { args: '', env: { PORT: '3001' }, flag: null });
  assert.deepEqual(doctor.portArgs('yarn', null, 3001), { args: '', env: { PORT: '3001' }, flag: null });
  // Not a port: nothing at all.
  for (const bad of [null, 0, 70000, 3000.5, '3000']) assert.deepEqual(doctor.portArgs('npm', 'vite', bad), { args: '', env: {}, flag: null });
});

test('who listens on a port, in any language', () => {
  const netstat = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242',
    '  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       1',
    '  TCP    127.0.0.1:3000         127.0.0.1:51234        ESTABLISHED     4242',
    '  TCP    127.0.0.1:51234        127.0.0.1:3000         ESTABLISHED     777',
    '  TCP    [::]:3000              [::]:0                 ABHÖREN         4242',
    '  TCP    [::1]:3000             [::]:0                 ABHÖREN         5150',
  ].join('\r\n');
  assert.deepEqual(doctor.listenersOn(netstat, 3000), [4242, 5150]);
  assert.deepEqual(doctor.listenersOn(netstat, 51234), []);
  assert.deepEqual(doctor.listenersOn('', 3000), []);
});

test('never offered to stop: Windows itself and Shellby', () => {
  assert.equal(doctor.canStop(4242, 'node.exe'), true);
  assert.equal(doctor.canStop(4242, 'python.exe'), true);
  for (const name of ['svchost.exe', 'System', 'explorer.exe', 'lsass.exe', 'Shellby.exe']) assert.equal(doctor.canStop(4242, name), false, name);
  assert.equal(doctor.canStop(4, 'node.exe'), false);
  assert.equal(doctor.canStop(4242, ''), false, 'a program Windows wouldn\'t name');
});

test('.env: names only, never a value', () => {
  const text = '# comment\nAPI_URL=https://x\nexport SECRET_KEY="abc def"\n  DB_HOST = localhost\nnot a line\n=nothing\n';
  assert.deepEqual(doctor.envKeys(text), ['API_URL', 'SECRET_KEY', 'DB_HOST']);
  const example = { file: '.env.example', text: 'API_URL=\nSECRET_KEY=\nDB_HOST=\nSTRIPE_KEY=\n' };
  const m = doctor.missingEnv(example, [{ file: '.env', text: 'API_URL=1\nsecret_key=2' }], ['DB_HOST']);
  assert.deepEqual(m, { example: '.env.example', missing: ['STRIPE_KEY'], noEnv: false });
  assert.equal(doctor.missingEnv(null, []), null, 'no example, nothing to say');
  assert.equal(doctor.missingEnv(example, []).noEnv, true);
});

test('the Node a project wants', () => {
  assert.deepEqual(doctor.nodeWanted({ nvmrc: 'v20.11.0\n' }), { range: '20.11.0', from: '.nvmrc' });
  assert.deepEqual(doctor.nodeWanted({ nvmrc: 'lts/iron', nodeVersion: '20' }), { range: '20', from: '.node-version' });
  assert.deepEqual(doctor.nodeWanted({ packageJson: '{"engines":{"node":">=18 <21"}}' }), { range: '>=18 <21', from: 'package.json engines' });
  assert.equal(doctor.nodeWanted({ nvmrc: 'node', packageJson: '{"engines":{}}' }), null);
  assert.equal(doctor.nodeWanted({ packageJson: 'not json' }), null);
});

test('semver ranges, the forms package.json uses', () => {
  const yes = [
    ['v20.11.1', '20'], ['20.0.0', '20.x'], ['20.11.1', '^20.0.0'], ['20.11.1', '>=18'], ['18.19.0', '>=18 <21'],
    ['20.11.1', '~20.11.0'], ['16.0.0', '14 || 16'], ['20.11.1', '18 - 20'], ['20.11.1', '*'], ['0.2.5', '^0.2.3'],
    ['20.11.1', '20.11.1'], ['20.11.1', '>= 20.10'], ['22.0.0', '>20'],
  ];
  const no = [
    ['v18.19.0', '20'], ['21.0.0', '>=18 <21'], ['20.12.0', '~20.11.0'], ['21.0.0', '^20.0.0'], ['17.9.0', '>=18'],
    ['0.3.0', '^0.2.3'], ['21.0.0', '18 - 20'], ['20.1.0', '>20'],
  ];
  for (const [v, r] of yes) assert.equal(doctor.satisfies(v, r), true, `${v} in ${r}`);
  for (const [v, r] of no) assert.equal(doctor.satisfies(v, r), false, `${v} not in ${r}`);
  assert.equal(doctor.satisfies('20.11.1', 'lts/*'), null);
  assert.equal(doctor.satisfies('nonsense', '20'), null);
});

test('what the card says before a start', () => {
  const env = { example: '.env.example', missing: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], noEnv: false };
  const [e] = doctor.notes({ env });
  assert.equal(e.kind, 'env');
  assert.match(e.text, /\.env\.example has 8 settings your \.env doesn't: A, B, C, D, E, F and 2 more\./);
  assert.match(doctor.notes({ env: { ...env, missing: ['A'], noEnv: true } })[0].text, /There's a \.env\.example but no \.env, so its setting isn't set\./);
  const wanted = { range: '20', from: '.nvmrc' };
  assert.deepEqual(doctor.notes({ node: { wanted, have: 'v20.11.1' } }), []);
  assert.match(doctor.notes({ node: { wanted, have: 'v18.19.0' } })[0].text, /wants Node 20 \(\.nvmrc\), and this PC has v18\.19\.0/);
  assert.equal(doctor.notes({ node: { wanted, have: null } })[0].kind, 'node-missing');
  assert.deepEqual(doctor.notes({ env: { ...env, missing: [] } }), []);
});

test('checking a clone, and .env from its example (never over one)', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-doc-')));
  try {
    fs.writeFileSync(path.join(root, '.env.example'), 'SHELLBY_TEST_ONLY_KEY_1=\nSHELLBY_TEST_ONLY_KEY_2=x\n');
    fs.writeFileSync(path.join(root, '.nvmrc'), '20\n');
    const v = await io.checkProject(root, { node: async () => 'v18.0.0' });
    assert.equal(v.canMakeEnv, true);
    assert.deepEqual(v.notes.map(n => n.kind), ['no-env', 'node']);
    assert.deepEqual(v.notes[0].keys, ['SHELLBY_TEST_ONLY_KEY_1', 'SHELLBY_TEST_ONLY_KEY_2']);

    assert.equal(io.makeEnv(root).ok, true);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SHELLBY_TEST_ONLY_KEY_1=\nSHELLBY_TEST_ONLY_KEY_2=x\n');
    fs.writeFileSync(path.join(root, '.env'), 'MINE=1\n');
    const again = io.makeEnv(root);
    assert.equal(again.ok, false);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'MINE=1\n', 'a .env that is there is never touched');
    const after = await io.checkProject(root, { node: async () => 'v20.1.0' });
    assert.equal(after.canMakeEnv, false);
    assert.deepEqual(after.notes.map(n => n.kind), ['env']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a free port: the first after the taken one that both addresses allow', async () => {
  const taken = new Set([3001, 3002]);
  const asked = [];
  const listen = async (port, host) => { asked.push(`${host}:${port}`); return !(taken.has(port) || (host === '::' && port === 3003)); };
  assert.equal(await io.freePort(3000, { listen }), 3004);
  assert.ok(asked.includes(':::3003'), 'every address was asked too');
  assert.equal(await io.freePort(65535, { listen }), null);
});

test('who has a port: names from Windows, and whether to offer Stop', async () => {
  const run = (_exe, args, _opts, cb) => cb(null, args.includes('TCPv6')
    ? '  TCP    [::]:3000    [::]:0    LISTENING    900\n'
    : '  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    4242\n');
  const names = { 4242: 'node.exe', 900: 'svchost.exe' };
  const holders = await io.whoHasPort(3000, { run, info: () => ({ alive: true, createdAt: 123 }), image: pid => ({ name: names[pid] }) });
  assert.deepEqual(holders, [
    { pid: 4242, name: 'node.exe', createdAt: 123, canStop: true },
    { pid: 900, name: 'svchost.exe', createdAt: 123, canStop: false },
  ]);
  assert.deepEqual(await io.whoHasPort('3000', { run }), []);
});
