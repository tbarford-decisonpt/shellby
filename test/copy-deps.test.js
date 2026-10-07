// copy-deps.js: a new copy gets its packages only when your checkout has them,
// and installing them runs nothing from the repository.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installCopyDeps, installDir, depsSentence, ARGS } = require('../src/main/copy-deps');
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
  const ok = await installCopyDeps(W, { exists, find: () => npm, run: async (n, dir) => { seen.push({ n, dir }); return { ok: true }; } });
  assert.deepEqual(ok, { installed: true, dir: W.path });
  assert.deepEqual(seen, [{ n: npm, dir: W.path }]);
  assert.ok(ARGS.includes('--ignore-scripts'));
  const failed = await installCopyDeps(W, { exists, find: () => npm, run: async () => ({ ok: false, error: 'E404' }) });
  assert.deepEqual(failed, { installed: false, dir: W.path, error: 'E404' });
  assert.deepEqual(await installCopyDeps(W, { exists, find: () => null }), { installed: false, dir: W.path, error: "npm isn't on PATH" });
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
    const r = await installCopyDeps({ root, path: copy, cwd: copy });
    assert.equal(r.installed, true, r.error);
    assert.equal(fs.existsSync(path.join(copy, 'ran.txt')), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
