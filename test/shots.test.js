// Before/after pictures (src/main/shots.js): which turns get one, which dev
// server is the tab's, what the hidden window may fetch, and that pictures are
// only ever read from ids Shellby made.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/main/shots');

test('isUiFile spots styles, markup and components', () => {
  for (const f of ['src/app.css', 'styles/x.scss', 'index.html', 'src/Button.tsx', 'App.vue', 'src/routes/+page.svelte', 'src/pages/index.astro', 'src/components/nav.js', 'app/layout.ts', 'src\\components\\Card.jsx']) {
    assert.equal(S.isUiFile(f), true, f);
  }
});

test('isUiFile leaves out server code, config, tests and build output', () => {
  for (const f of ['server/db.js', 'package.json', 'README.md', 'src/lib/math.ts', 'src/components/Button.test.tsx', 'tests/ui.spec.ts', 'dist/app.css', 'node_modules/x/y.css', '']) {
    assert.equal(S.isUiFile(f), false, f);
  }
});

test('anyUi reads the file rows of a changes summary', () => {
  assert.equal(S.anyUi([{ path: 'server.js' }, { path: 'src/App.tsx' }]), true);
  assert.equal(S.anyUi([{ path: 'server.js' }]), false);
  assert.equal(S.anyUi(null), false);
});

test('localOrigin accepts only a dev server on this PC', () => {
  assert.equal(S.localOrigin('http://localhost:5173/'), 'http://localhost:5173');
  assert.equal(S.localOrigin('http://127.0.0.1:3000/app'), 'http://127.0.0.1:3000');
  assert.equal(S.localOrigin('http://[::1]:8080/'), 'http://[::1]:8080');
  const tricks = [
    'http://localhost:3000@evil.com/', 'http://localhost:3000\\@evil.com/', 'http://localhost:3000 http://evil.com/',
    'http://localhost:3000.evil.com/', 'http://user:pw@localhost:3000/', 'http://localhost:99999/', 'http://127.0.0.1:3000x/',
  ];
  for (const bad of ['https://example.com/', 'http://localhost/', 'http://localhost.evil.com:80/', 'file:///C:/x', 'http://192.168.1.2:3000/', 'javascript:alert(1)', null, ...tricks]) {
    assert.equal(S.localOrigin(bad), null, String(bad));
  }
});

test('pickServer finds the running server for the tab folder, the deepest first', () => {
  const servers = [
    { id: 'a', kind: 'server', status: 'up', root: 'C:\\code\\site', url: 'http://localhost:3000/' },
    { id: 'b', kind: 'server', status: 'up', root: 'C:\\code\\site\\docs', url: 'http://localhost:4000/' },
    { id: 'c', kind: 'server', status: 'crashed', root: 'C:\\code\\other', url: 'http://localhost:5000/' },
    { id: 'd', kind: 'install', status: 'up', root: 'C:\\code\\inst', url: 'http://localhost:6000/' },
  ];
  assert.equal(S.pickServer(servers, 'C:\\code\\site')?.id, 'a');
  assert.equal(S.pickServer(servers, 'c:\\Code\\Site\\src')?.id, 'a');
  assert.equal(S.pickServer(servers, 'C:\\code\\site\\docs\\guide')?.id, 'b');
  assert.equal(S.pickServer(servers, 'C:\\code\\other'), null);
  assert.equal(S.pickServer(servers, 'C:\\code\\inst'), null);
  assert.equal(S.pickServer(servers, 'C:\\code\\sitemap'), null);
  assert.equal(S.pickServer(servers, ''), null);
});

test('pickServer ignores a server whose url is not local', () => {
  assert.equal(S.pickServer([{ kind: 'server', status: 'up', root: 'C:\\p', url: 'https://example.com/' }], 'C:\\p'), null);
});

test('requestAllowed keeps the hidden page to its own origin and public https', () => {
  const origin = 'http://localhost:5173';
  assert.equal(S.requestAllowed('http://localhost:5173/src/main.tsx', origin), true);
  assert.equal(S.requestAllowed('https://fonts.gstatic.com/x.woff2', origin), true);
  assert.equal(S.requestAllowed('data:image/png;base64,AAAA', origin), true);
  for (const bad of ['http://localhost:8080/admin', 'file:///C:/Windows/win.ini', 'http://example.com/', 'https://192.168.0.1/', 'https://10.0.0.5/', 'https://localhost:9999/', 'https://printer.local/', 'https://[::1]/', 'not a url']) {
    assert.equal(S.requestAllowed(bad, origin), false, bad);
  }
});

test('fileFor only builds paths from ids Shellby makes', () => {
  const dir = path.join(os.tmpdir(), 'shots');
  const id = S.shotId('0b8f2a3c-1d2e-4f5a-9b8c-7d6e5f4a3b2c', 'before');
  assert.equal(S.fileFor(dir, 'tab-1', id), path.join(dir, 'tab-1', `${id}.png`));
  for (const [tab, shot] of [['..', id], ['tab-1', '../../secret'], ['tab-1', 'x-before'], ['tab/1', id], ['tab-1', `${id}.png`], ['tab-1', 'abcdefgh-sideways']]) {
    assert.equal(S.fileFor(dir, tab, shot), null, `${tab} ${shot}`);
  }
});

test('toPrune drops pictures past two weeks, then the oldest past the cap', () => {
  const now = 100 * 86400000;
  const day = 86400000;
  const entries = [
    { name: 'old.png', mtimeMs: now - 20 * day },
    { name: 'a.png', mtimeMs: now - 3 * day },
    { name: 'b.png', mtimeMs: now - 2 * day },
    { name: 'c.png', mtimeMs: now - 1 * day },
    { name: 'notes.txt', mtimeMs: now - 30 * day },
  ];
  assert.deepEqual(S.toPrune(entries, { now, maxPerTab: 2 }).sort(), ['a.png', 'old.png']);
  assert.deepEqual(S.toPrune(entries, { now }), ['old.png']);
  assert.deepEqual(S.toPrune([], { now }), []);
});

test('save, read and remove round-trip a picture, as a PNG data URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-shots-'));
  try {
    const id = S.shotId('0b8f2a3c-1d2e-4f5a-9b8c-7d6e5f4a3b2c', 'after');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    assert.equal(S.save(dir, 'tab-1', id, png), true);
    assert.equal(S.read(dir, 'tab-1', id), `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(S.read(dir, 'tab-2', id), null);
    assert.equal(S.save(dir, '../evil', id, png), false);
    assert.equal(S.save(dir, 'tab-1', id, Buffer.alloc(0)), false);
    S.remove(dir, 'tab-1', id);
    assert.equal(S.read(dir, 'tab-1', id), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capture refuses a url that is not a local dev server, without opening a window', async () => {
  let made = 0;
  const electron = { BrowserWindow: function () { made++; }, session: { fromPartition: () => null } };
  assert.equal(await S.capture('https://example.com/', { electron }), null);
  assert.equal(made, 0);
});
