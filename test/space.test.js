// Docker, WSL and package-cache space. The parsers get the real output formats
// (captured from `docker system df`, `wsl --list --verbose` and `tasklist`),
// and the bounded directory walk gets a real temp tree, because the thing that
// matters about it is that it gives up instead of stalling the app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseSize, parseDockerDf, parseWslList, parseTasklist, vmMemory,
  cacheLocations, diskImageLocations, dirSize, createSpaceProbe,
  readings, topSources, spacePrompt,
} = require('../src/main/health/space');

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// ------------------------------------------------------------------ sizes

test('parseSize reads Docker\'s human sizes', () => {
  assert.equal(parseSize('0B'), 0);
  assert.equal(parseSize('512.3MB'), Math.round(512.3 * MB));
  assert.equal(parseSize('8.2GB'), Math.round(8.2 * GB));
  assert.equal(parseSize('1.1TB'), Math.round(1.1 * 1024 ** 4));
  // The Reclaimable column carries a percentage after the size.
  assert.equal(parseSize('4.1GB (50%)'), Math.round(4.1 * GB));
  // GiB and GB both appear depending on the Docker build.
  assert.equal(parseSize('2GiB'), 2 * GB);
  assert.equal(parseSize('N/A'), null);
  assert.equal(parseSize(''), null);
  assert.equal(parseSize(null), null);
});

// ------------------------------------------------------------------ docker

const DOCKER_DF = [
  '{"Active":"3","Reclaimable":"4.1GB (50%)","Size":"8.2GB","TotalCount":"12","Type":"Images"}',
  '{"Active":"2","Reclaimable":"1.2GB (100%)","Size":"1.2GB","TotalCount":"5","Type":"Containers"}',
  '{"Active":"1","Reclaimable":"0B (0%)","Size":"2.1GB","TotalCount":"3","Type":"Local Volumes"}',
  '{"Active":"0","Reclaimable":"3.4GB","Size":"3.4GB","TotalCount":"0","Type":"Build Cache"}',
].join('\n');

test('parseDockerDf totals the sizes and what can be reclaimed', () => {
  const d = parseDockerDf(DOCKER_DF);
  assert.equal(d.rows.length, 4);
  assert.deepEqual(d.rows[0], { type: 'Images', count: 12, active: 3, size: Math.round(8.2 * GB), reclaimable: Math.round(4.1 * GB) });
  assert.equal(Math.round(d.size / GB * 10) / 10, 14.9);
  assert.equal(Math.round(d.reclaimable / GB * 10) / 10, 8.7);
});

test('parseDockerDf ignores noise and returns null when Docker said nothing', () => {
  assert.equal(parseDockerDf(''), null);
  assert.equal(parseDockerDf('Cannot connect to the Docker daemon'), null);
  assert.equal(parseDockerDf('{"not":"docker"}'), null);
  assert.equal(parseDockerDf('{bad json\n' + DOCKER_DF.split('\n')[0]).rows.length, 1);
});

// ------------------------------------------------------------------ wsl

test('parseWslList reads the distro table and marks the default', () => {
  const out = '  NAME              STATE           VERSION\n'
    + '* Ubuntu-24.04      Running         2\n'
    + '  docker-desktop    Stopped         2\n';
  assert.deepEqual(parseWslList(out), [
    { name: 'Ubuntu-24.04', state: 'Running', version: 2, default: true },
    { name: 'docker-desktop', state: 'Stopped', version: 2, default: false },
  ]);
});

test('parseWslList survives the UTF-16 output of older builds and a localised header', () => {
  // wsl.exe answers in UTF-16LE unless WSL_UTF8 is set; decoded as UTF-8 that
  // leaves a NUL between every character.
  const utf16ish = '\0 \0 \0N\0A\0M\0E\0 \0 \0S\0T\0A\0T\0E\0 \0 \0V\0E\0R\0S\0I\0O\0N\0\n* Ubuntu  Running  2\n';
  assert.deepEqual(parseWslList(utf16ish), [{ name: 'Ubuntu', state: 'Running', version: 2, default: true }]);
  // A localised header has no trailing number, so it is skipped by shape.
  assert.deepEqual(parseWslList('  NOM  ÉTAT  VERSION\n* Debian  Arrêté  2\n'),
    [{ name: 'Debian', state: 'Arrêté', version: 2, default: true }]);
});

test('parseWslList returns nothing when no distributions are installed', () => {
  // The real message from a Windows box with WSL but no distro.
  assert.deepEqual(parseWslList('Windows Subsystem for Linux has no installed distributions.\n'
    + "Use 'wsl.exe --list --online' to list available distributions\n"), []);
  assert.deepEqual(parseWslList(''), []);
});

// ------------------------------------------------------------------ tasklist

test('parseTasklist reads the CSV rows and their memory', () => {
  // Captured from a real `tasklist /NH /FO CSV`.
  const out = '"explorer.exe","12312","Console","1","253,476 K"\n"vmmemWSL.exe","9001","Services","0","3,145,728 K"\n';
  const list = parseTasklist(out);
  assert.deepEqual(list[0], { name: 'explorer.exe', pid: 12312, bytes: 253476 * 1024 });
  assert.equal(vmMemory(list), 3145728 * 1024);
});

test('vmMemory covers both process names and is null when the VM is not running', () => {
  assert.equal(vmMemory(parseTasklist('"vmmem.exe","7","Services","0","1,024 K"')), 1024 * 1024);
  assert.equal(vmMemory(parseTasklist('"explorer.exe","1","Console","1","100 K"')), null);
  assert.equal(vmMemory([]), null);
  // A localised build groups thousands with dots.
  assert.equal(vmMemory(parseTasklist('"vmmem.exe","7","Services","0","1.024 K"')), 1024 * 1024);
});

test('parseTasklist ignores the header and malformed rows', () => {
  assert.deepEqual(parseTasklist('Image Name   PID Session\n"only","two"\n'), []);
});

// ------------------------------------------------------------------ locations

test('cache and disk-image locations are absolute and come off the environment', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  const caches = cacheLocations(env, 'C:\\Users\\x');
  const npm = caches.find(c => c.name === 'npm');
  assert.equal(npm.dir, path.join(env.LOCALAPPDATA, 'npm-cache'));
  assert.equal(caches.find(c => c.name === 'Cargo').dir, path.join('C:\\Users\\x', '.cargo', 'registry'));
  assert.ok(caches.every(c => path.isAbsolute(c.dir)), 'every cache path is absolute');
  const images = diskImageLocations(env, 'C:\\Users\\x');
  assert.ok(images.some(i => /docker_desktop\.raw$/.test(i.file || '')));
  assert.ok(images.some(i => i.glob && /Packages$/.test(i.glob)));
});

// ------------------------------------------------------------------ dirSize

test('dirSize adds up a real tree', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shellby-space-'));
  try {
    await fs.promises.mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'one.bin'), Buffer.alloc(1000));
    await fs.promises.writeFile(path.join(root, 'a', 'two.bin'), Buffer.alloc(2000));
    await fs.promises.writeFile(path.join(root, 'a', 'b', 'three.bin'), Buffer.alloc(3000));
    const r = await dirSize(root);
    assert.equal(r.bytes, 6000);
    assert.equal(r.files, 3);
    assert.equal(r.partial, false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('dirSize gives up on its budget instead of stalling, and says so', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shellby-space-'));
  try {
    for (let i = 0; i < 12; i++) {
      await fs.promises.mkdir(path.join(root, `d${i}`), { recursive: true });
      await fs.promises.writeFile(path.join(root, `d${i}`, 'f.bin'), Buffer.alloc(100));
    }
    // A clock that is already past the deadline on the second look.
    let t = 0;
    const r = await dirSize(root, { ms: 5, now: () => (t += 4) });
    assert.equal(r.partial, true);
    assert.ok(r.bytes < 1200, 'stopped early, so it did not add up the whole tree');
    // An entry cap does the same.
    const capped = await dirSize(root, { entries: 1 });
    assert.equal(capped.partial, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('dirSize on a missing folder is zero, not a throw', async () => {
  const r = await dirSize(path.join(os.tmpdir(), 'shellby-does-not-exist-' + Date.now()));
  assert.deepEqual(r, { bytes: 0, files: 0, partial: false });
});

// ------------------------------------------------------------------ probe

test('the probe caches its measurement and re-measures when forced', async () => {
  let now = 0;
  const probe = createSpaceProbe({ platform: 'linux', env: {}, home: path.join(os.tmpdir(), 'nope'), now: () => now });
  const first = await probe.read();
  assert.equal(typeof first.at, 'number');
  const second = await probe.read();
  assert.equal(second, first, 'the second read inside the window is the cached object');
  now += 7 * 60 * 60 * 1000;
  const third = await probe.read();
  assert.notEqual(third, first, 'past the refresh window it measures again');
  assert.equal(probe.latest, third);
});

test('the probe reports nothing rather than failing when the tools are absent', async () => {
  const probe = createSpaceProbe({ platform: 'linux', env: {}, home: path.join(os.tmpdir(), 'nope') });
  const snap = await probe.read();
  assert.equal(snap.wsl, null);       // not Windows
  assert.equal(snap.vmMemory, null);
  assert.deepEqual(snap.images, []);
  assert.deepEqual(snap.caches, []);
  assert.equal(snap.reclaimable, 0);
});

test('readWsl on this machine answers without throwing', async () => {
  // WSL may or may not be installed wherever this runs; either way the reader
  // must come back with a distro list or null, never an exception.
  const probe = createSpaceProbe();
  const wsl = await probe.readWsl();
  assert.ok(wsl === null || Array.isArray(wsl.distros), 'null or { distros: [...] }');
});

// ------------------------------------------------------------------ rules

const SNAP = {
  at: 0,
  docker: parseDockerDf(DOCKER_DF),
  wsl: { distros: [{ name: 'Ubuntu', state: 'Running', version: 2, default: true }] },
  images: [{ name: 'Docker Desktop', file: 'C:\\x\\docker_desktop.raw', size: 62 * GB }],
  caches: [
    { name: 'npm', dir: 'C:\\x\\npm-cache', size: 12 * GB, files: 90000, partial: true },
    { name: 'Cargo', dir: 'C:\\x\\.cargo\\registry', size: 3 * GB, files: 12000, partial: false },
  ],
  vmMemory: 3 * GB,
  reclaimable: Math.round(8.7 * GB) + 15 * GB,
};

test('readings produce one reclaim check in the shape the rules consume', () => {
  const [r] = readings(SNAP);
  assert.equal(r.id, 'reclaim');
  assert.equal(r.kind, 'reclaim');
  assert.equal(r.unit, 'GB');
  assert.equal(Math.round(r.value), 24);
  assert.deepEqual(r.sources, ['npm cache', 'Docker', 'Cargo cache']);
  // Nothing to reclaim is no check at all, not a check reading zero.
  assert.deepEqual(readings({ reclaimable: 0 }), []);
  assert.deepEqual(readings(null), []);
});

test('topSources ranks Docker against the caches', () => {
  assert.deepEqual(topSources(SNAP, 2).map(s => s.label), ['npm cache', 'Docker']);
});

test('the space prompt lists everything found and asks for nothing to be run', () => {
  const p = spacePrompt(SNAP);
  assert.match(p, /Docker reports 14\.9 GB in use, 8\.7 GB of it reclaimable/);
  assert.match(p, /- Images: 12 items/);
  assert.match(p, /- npm: 12\.0 GB \(at least\) at C:\\x\\npm-cache/);
  assert.match(p, /do not shrink on their own/);
  assert.match(p, /- Docker Desktop: 62\.0 GB/);
  assert.match(p, /Don't run anything, prune anything or delete anything/);
  assert.equal(spacePrompt(null), null);
});
