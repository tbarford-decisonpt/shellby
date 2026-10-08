// copy-deps.js: a new copy gets its packages only when your checkout has them,
// and installing them runs nothing from the repository.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installCopyDeps, installDir, refusal, registryOnly, installedAlready, depsSentence, ARGS } = require('../src/main/copy-deps');
const { findNpm } = require('../src/main/depwatch');

const W = { root: path.resolve('/repo'), path: path.resolve('/home/abc123/repo'), cwd: path.resolve('/home/abc123/repo/app') };
const has = (...files) => f => files.some(x => path.resolve(x) === path.resolve(f));

test('installs where the lockfile is, when your checkout has node_modules there and the copy has none', () => {
  assert.equal(installDir(W, { exists: has('/home/abc123/repo/package-lock.json', '/repo/node_modules') }), W.path);
  assert.equal(installDir(W, { exists: has('/home/abc123/repo/app/package-lock.json', '/repo/app/node_modules') }), W.cwd, 'the tab\'s own folder first');
});

test('leaves it alone when you never installed, it is installed already, or it is not an npm project', () => {
  assert.equal(installDir(W, { exists: has('/home/abc123/repo/package-lock.json') }), null, 'nothing installed in your checkout');
  assert.equal(installDir(W, { exists: has('/home/abc123/repo/package-lock.json', '/repo/node_modules', '/home/abc123/repo/node_modules') }), null);
  assert.equal(installDir(W, { exists: has('/repo/node_modules') }), null, 'no lockfile, so npm ci has nothing to go by');
});

test('runs npm ci with install scripts off, and says what happened', async () => {
  const exists = has('/home/abc123/repo/package-lock.json', '/repo/node_modules');
  const seen = [];
  const npm = { file: 'node', pre: ['npm-cli.js'] };
  const ok = await installCopyDeps(W, { exists, check: () => null, find: () => npm, run: async (n, dir) => { seen.push({ n, dir }); return { ok: true }; } });
  assert.deepEqual(ok, { installed: true, dir: W.path });
  assert.deepEqual(seen, [{ n: npm, dir: W.path }]);
  assert.ok(ARGS.includes('--ignore-scripts'));
  const failed = await installCopyDeps(W, { exists, check: () => null, find: () => npm, run: async () => ({ ok: false, error: 'E404' }) });
  assert.deepEqual(failed, { installed: false, dir: W.path, error: 'E404' });
  assert.deepEqual(await installCopyDeps(W, { exists, check: () => null, find: () => null }), { installed: false, dir: W.path, error: "npm isn't on PATH" });
  assert.deepEqual(await installCopyDeps(W, { exists: () => false, run: () => assert.fail('nothing to install') }), { skipped: true });
});

test('what Claude is told matches what happened in the copy', () => {
  assert.match(depsSentence({ installed: true, dir: W.path }, W), /has run `npm ci --ignore-scripts`, so node_modules is there but no package's install script has run/);
  assert.match(depsSentence({ installed: true, dir: W.cwd }, W), /--ignore-scripts` in .*app, so/);
  assert.match(depsSentence({ installed: false, dir: W.path, error: 'E404' }, W), /it failed \(E404\), so install the dependencies yourself/);
  assert.match(depsSentence({ skipped: true }, W), /\(node_modules, build output\) isn't in it/);
});

test('a real npm ci in a copy runs none of the project\'s scripts', { skip: !findNpm() && 'no npm on PATH' }, async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-copydeps-')));
  try {
    const root = path.join(base, 'repo');
    const copy = path.join(base, 'copy');
    for (const dir of [root, copy]) {
      fs.mkdirSync(dir);
      // A preinstall that would leave a mark: it never runs.
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { preinstall: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'\')"' } }));
      fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0' } } }));
    }
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), '{}'); // installed after the lockfile was written
    const r = await installCopyDeps({ root, path: copy, cwd: copy });
    assert.equal(r.installed, true, r.error || r.why);
    assert.equal(fs.existsSync(path.join(copy, 'ran.txt')), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

const lock = packages => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });

test('only registry tarballs: a git, file or plain-http package would run its build, so none of those', () => {
  const reg = { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-x' };
  assert.equal(registryOnly(lock({ 'node_modules/a': reg, 'node_modules/b': { link: true, resolved: 'packages/b' }, 'node_modules/a/node_modules/c': { inBundle: true } })), true);
  for (const resolved of ['git+https://evil.example/x.git#abc', 'git+ssh://git@github.com/x/y.git', 'github:x/y', 'file:../x', 'http://registry.example/a.tgz']) {
    assert.equal(registryOnly(lock({ 'node_modules/a': reg, 'node_modules/x': { resolved } })), false, resolved);
  }
  assert.equal(registryOnly(lock({ 'node_modules/x': { version: '1.0.0' } })), false, 'no resolved: where would it come from?');
  assert.equal(registryOnly(lock({ 'node_modules/b': { link: true, resolved: 'C:\\elsewhere' } })), false);
  assert.equal(registryOnly('not json'), false);
  assert.equal(registryOnly(JSON.stringify({ lockfileVersion: 1, dependencies: {} })), false, 'an old lockfile says too little');
});

test('installedAlready: every package the very same tarball as one installed, or no', () => {
  const a = { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-a' };
  const b = { resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz', integrity: 'sha512-b' };
  const link = { link: true, resolved: 'packages/l' };
  const have = lock({ 'node_modules/a': a, 'node_modules/b': b, 'node_modules/l': link });
  assert.equal(installedAlready(lock({ 'node_modules/a': a, 'node_modules/l': link }), have), true, 'fewer is fine');
  assert.equal(installedAlready(lock({ 'node_modules/a': a, 'node_modules/c': b }), have), false, 'a package not installed');
  assert.equal(installedAlready(lock({ 'node_modules/a': { ...a, integrity: 'sha512-other' } }), have), false, 'another tarball');
  assert.equal(installedAlready(lock({ 'node_modules/a': { ...a, resolved: 'https://elsewhere.example/a.tgz' } }), have), false, 'from somewhere else');
  assert.equal(installedAlready(lock({ 'node_modules/a': { resolved: a.resolved } }), have), false, 'nothing to match on');
  assert.equal(installedAlready(lock({ 'node_modules/l': { link: true, resolved: 'elsewhere' } }), have), false);
  assert.equal(installedAlready('not json', have), false);
  assert.equal(installedAlready(lock({}), '{}'), false);
});

test('the copy gets packages only when they are exactly the ones installed in your checkout', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-copydeps-')));
  try {
    const root = path.join(base, 'repo');
    const copy = path.join(base, 'copy');
    const w = { root, path: copy, cwd: copy };
    const text = lock({ 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' } });
    for (const dir of [root, copy]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'package-lock.json'), text); }
    fs.mkdirSync(path.join(root, 'node_modules'));
    assert.match(refusal(w, copy), /wasn't installed by npm/);
    const hidden = path.join(root, 'node_modules', '.package-lock.json');
    fs.writeFileSync(hidden, '{}');
    assert.equal(refusal(w, copy), null);

    const old = new Date(Date.now() - 60000);
    fs.utimesSync(hidden, old, old);
    assert.match(refusal(w, copy), /changed after you last installed/);
    // ...unless what you have installed already covers it: nothing new comes onto the PC.
    fs.writeFileSync(hidden, lock({ 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-a' } }));
    fs.utimesSync(hidden, old, old);
    assert.match(refusal(w, copy), /changed after you last installed/, 'the lockfile gives no integrity to match on');
    const pinned = lock({ 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-a' } });
    for (const dir of [root, copy]) fs.writeFileSync(path.join(dir, 'package-lock.json'), pinned);
    fs.utimesSync(hidden, old, old);
    assert.equal(refusal(w, copy), null);
    for (const dir of [root, copy]) fs.writeFileSync(path.join(dir, 'package-lock.json'), text);
    fs.writeFileSync(hidden, '{}');
    fs.utimesSync(hidden, new Date(), new Date());

    fs.writeFileSync(path.join(copy, 'package-lock.json'), lock({ 'node_modules/a': { resolved: 'git+https://evil.example/a.git' } }));
    assert.match(refusal(w, copy), /isn't the one installed in your checkout/, 'a lockfile you never installed');
    fs.writeFileSync(path.join(root, 'package-lock.json'), fs.readFileSync(path.join(copy, 'package-lock.json')));
    fs.utimesSync(hidden, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    assert.match(refusal(w, copy), /packages from git or a folder/, 'even one you installed yourself');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a refusal is passed on, and Claude is told why', async () => {
  const exists = has('/home/abc123/repo/package-lock.json', '/repo/node_modules');
  const r = await installCopyDeps(W, { exists, check: () => 'it has packages from git', run: () => assert.fail('never runs') });
  assert.deepEqual(r, { skipped: true, why: 'it has packages from git', dir: W.path });
  assert.match(depsSentence(r, W), /didn't install them because it has packages from git\. Ask before installing them yourself/);
});
