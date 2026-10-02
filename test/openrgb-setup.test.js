// Getting OpenRGB installed and running: where Shellby looks for it, what it
// runs, what winget's exit codes mean, and starting it when it isn't up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const setup = require('../src/main/openrgb-setup');

const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

test('it looks in Program Files first, then the portable places', () => {
  const c = setup.candidates(env);
  assert.equal(c[0], path.join('C:\\Program Files', 'OpenRGB', 'OpenRGB.exe'));
  assert.ok(c.includes(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'OpenRGB.exe')));
  assert.equal(new Set(c).size, c.length);
});

test('findOpenRgb returns the first one that exists, or null', () => {
  const links = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'OpenRGB.exe');
  assert.equal(setup.findOpenRgb({ env, exists: p => p === links }), links);
  assert.equal(setup.findOpenRgb({ env, exists: () => false }), null);
  assert.equal(setup.findOpenRgb({ env, exists: () => { throw new Error('EPERM'); } }), null);
});

test('it starts OpenRGB with the SDK server on, in the tray', () => {
  assert.deepEqual(setup.launchArgs(), ['--server', '--startminimized']);
  assert.deepEqual(setup.launchArgs(7000), ['--server', '--startminimized', '--server-port', '7000']);
  assert.deepEqual(setup.launchArgs(80), ['--server', '--startminimized'], 'OpenRGB refuses ports under 1024');
});

test('launchOpenRgb spawns it detached, so it outlives Shellby', () => {
  let call;
  const ok = setup.launchOpenRgb('C:\\OpenRGB\\OpenRGB.exe', 6742, { spawn: (exe, args, opts) => { call = { exe, args, opts }; return { on() {}, unref() {} }; } });
  assert.equal(ok, true);
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.stdio, 'ignore');
  assert.equal(setup.launchOpenRgb('x', 6742, { spawn: () => { throw new Error('nope'); } }), false);
});

test('the install is exactly the winget package, silent, agreements accepted', () => {
  const a = setup.INSTALL_ARGS;
  assert.equal(a[0], 'install');
  assert.equal(a[a.indexOf('--id') + 1], 'OpenRGB.OpenRGB');
  for (const f of ['--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--source') + 1], 'winget');
});

test('winget exit codes mean what they say', () => {
  assert.deepEqual(setup.installOutcome(0), { ok: true });
  assert.deepEqual(setup.installOutcome(0x8A15002B), { ok: true }, 'already installed is fine');
  assert.deepEqual(setup.installOutcome(0x8A15002B | 0), { ok: true }, 'and so is its signed form');
  assert.equal(setup.installOutcome('ENOENT').noWinget, true);
  assert.match(setup.installOutcome(1602).error, /cancelled/);
  assert.match(setup.installOutcome(0x8A150011 | 0).error, /cancelled/);
  assert.match(setup.installOutcome(5).error, /0x5/);
});

test('installOpenRgb runs winget and reads its exit', async () => {
  let ran;
  const ok = await setup.installOpenRgb({ execFile: (cmd, args, opts, cb) => { ran = { cmd, args, opts }; cb(null); } });
  assert.deepEqual(ok, { ok: true });
  assert.equal(ran.cmd, 'winget');
  assert.equal(ran.opts.windowsHide, true);
  const missing = await setup.installOpenRgb({ execFile: (_c, _a, _o, cb) => cb(Object.assign(new Error('spawn winget ENOENT'), { code: 'ENOENT' })) });
  assert.equal(missing.noWinget, true);
  const slow = await setup.installOpenRgb({ execFile: (_c, _a, _o, cb) => cb(Object.assign(new Error('killed'), { killed: true })) });
  assert.match(slow.error, /too long/);
});

// ------------------------------------------------------------------ ensureRunning

const noWait = () => Promise.resolve();

test('already running: nothing gets started', async () => {
  let launched = false;
  const r = await setup.ensureRunning({ probe: async () => ({ ok: true, devices: [] }), find: () => 'x', launch: () => { launched = true; return true; }, wait: noWait });
  assert.equal(r.ok, true);
  assert.equal(launched, false);
});

test('installed but not running: it starts OpenRGB and waits for the port', async () => {
  let probes = 0;
  let launchedWith;
  const r = await setup.ensureRunning({
    probe: async () => (++probes >= 4 ? { ok: true, devices: [{ name: 'Keyboard' }] } : { ok: false, error: 'ECONNREFUSED' }),
    port: 6742, find: () => 'C:\\OpenRGB.exe', launch: (exe, port) => { launchedWith = [exe, port]; return true; }, wait: noWait,
  });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.deepEqual(launchedWith, ['C:\\OpenRGB.exe', 6742]);
});

test('not installed: it says so instead of launching anything', async () => {
  const r = await setup.ensureRunning({ probe: async () => ({ ok: false }), find: () => null, launch: () => assert.fail('launched'), wait: noWait });
  assert.equal(r.missing, true);
});

test('started but the server never answers: it points at the SDK setting', async () => {
  const r = await setup.ensureRunning({ probe: async () => ({ ok: false }), find: () => 'x', launch: () => true, wait: noWait, tries: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /SDK Server/);
});
