const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { parseDeepLink, findDeepLink, fetchRegistryPack, fetchRegistryCatalog, REGISTRY_URL } = require('../src/main/registry');

// ------------------------------------------------------------ deep links

test('parseDeepLink accepts the install link in its usual shapes', () => {
  const want = { action: 'install', packId: 'tiny-hats' };
  for (const link of [
    'shellby://install?pack=tiny-hats',
    'shellby://install/?pack=tiny-hats',
    'shellby://install//?pack=tiny-hats',
    'shellby:install?pack=tiny-hats',
    'shellby:install/?pack=tiny-hats',
    'SHELLBY://install?pack=tiny-hats',
    'Shellby://INSTALL?pack=tiny-hats',
    'shellby://install?pack=tiny-hats&utm_source=gallery',
    'shellby://install?pack=tiny-hats#top',
  ]) assert.deepEqual(parseDeepLink(link), want, link);
});

test('parseDeepLink rejects bad ids, other actions and other schemes', () => {
  for (const link of [
    'shellby://install?pack=Tiny-Hats',
    'shellby://install?pack=-hats',
    'shellby://install?pack=a',
    'shellby://install?pack=' + 'a'.repeat(41),
    'shellby://install?pack=tiny_hats',
    'shellby://install?pack=../evil',
    'shellby://install?pack=tiny-hats&pack=other',
    'shellby://install',
    'shellby://remove?pack=tiny-hats',
    'shellby://installx?pack=tiny-hats',
    'shellby://install/../x?pack=tiny-hats',
    'shellby://install/extra?pack=tiny-hats',
    'shellby://user:pw@install?pack=tiny-hats',
    'shellby://install:99?pack=tiny-hats',
    'https://install?pack=tiny-hats',
    'shelby://install?pack=tiny-hats',
    'file:///C:/install?pack=tiny-hats',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    42,
    'shellby://install?pack=tiny-hats&x=' + 'y'.repeat(3000),
  ]) assert.equal(parseDeepLink(link), null, String(link));
});

test('parseDeepLink never carries a url or path from the link', () => {
  const r = parseDeepLink('shellby://install?pack=tiny-hats&url=https://evil.example/p.json&path=C:\\x.json');
  assert.deepEqual(r, { action: 'install', packId: 'tiny-hats' });
  assert.deepEqual(Object.keys(r).sort(), ['action', 'packId']);
});

test('findDeepLink picks the first shellby: argument', () => {
  assert.equal(findDeepLink(['C:\\Shellby\\Shellby.exe', 'shellby://install?pack=a1']), 'shellby://install?pack=a1');
  assert.equal(findDeepLink(['electron.exe', 'C:\\repo', '--flag', 'SHELLBY:install?pack=a1', 'shellby://install?pack=b2']), 'SHELLBY:install?pack=a1');
  assert.equal(findDeepLink(['electron.exe', '--capture-screenshots']), null);
  assert.equal(findDeepLink(['x', 'https://shellby.example']), null);
  assert.equal(findDeepLink([null, 3, {}]), null);
  assert.equal(findDeepLink(undefined), null);
});

test('the registry is the official GitHub Pages site', () => {
  assert.equal(REGISTRY_URL, 'https://x-salmon.github.io/shellby-packs/');
});

// ------------------------------------------------------------ fetchRegistryPack against a local server

const PACK = JSON.stringify({ format: 1, id: 'tiny-hats', name: 'Tiny Hats', author: 'Test', version: '1.0.0', accessories: [] });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let server;
let origin;          // http://127.0.0.1:<port>
let base;            // ${origin}/shellby-packs/
let routes;          // path -> handler(req, res)

function entry(extra = {}) {
  return { id: 'tiny-hats', name: 'Tiny Hats', author: 'Test', version: '1.0.0', url: `${base}packs/tiny-hats.json`, sha256: sha(PACK), bytes: Buffer.byteLength(PACK), ...extra };
}
function serveIndex(packs, extra = {}) {
  routes['/shellby-packs/index.json'] = (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ format: 1, generated: '2026-10-01T12:00:00Z', packs, ...extra })); };
}
function servePack(body = PACK) {
  routes['/shellby-packs/packs/tiny-hats.json'] = (_req, res) => res.end(body);
}
const get = (id = 'tiny-hats', opts = {}) => fetchRegistryPack(id, { baseUrl: base, timeoutMs: 2000, ...opts });

before(async () => {
  server = http.createServer((req, res) => {
    const h = routes[req.url.split('?')[0]];
    if (h) return h(req, res);
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  base = `${origin}/shellby-packs/`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

function reset() { routes = {}; }

test('downloads and verifies a registry pack', async () => {
  reset();
  serveIndex([entry({ id: 'other-pack', url: `${base}packs/other.json` }), entry()]);
  servePack();
  const r = await get();
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(r.text, PACK);
  assert.equal(r.entry.id, 'tiny-hats');
  assert.equal(r.entry.version, '1.0.0');
  assert.deepEqual(r.errors, []);
  // Base without a trailing slash works too.
  assert.equal((await get('tiny-hats', { baseUrl: base.slice(0, -1) })).ok, true);
});

test('an id missing from the index is refused', async () => {
  reset();
  serveIndex([entry()]);
  servePack();
  const r = await get('tiny-hat');
  assert.equal(r.ok, false);
  assert.equal(r.errors[0], "That pack isn't in the Shellby community registry.");
  assert.equal((await get('../index')).ok, false);
});

test('a download that does not match the checksum is refused', async () => {
  reset();
  serveIndex([entry()]);
  servePack(PACK.replace('Tiny Hats', 'Evil Hats'));
  const r = await get();
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /didn't match the registry checksum/);
  assert.equal(r.text, undefined);
});

test('a missing or malformed checksum is refused', async () => {
  reset();
  servePack();
  serveIndex([entry({ sha256: undefined })]);
  assert.equal((await get()).ok, false);
  serveIndex([entry({ sha256: sha(PACK).toUpperCase() })]);
  assert.equal((await get()).ok, false);
});

test('pack urls on another origin are refused without fetching them', async () => {
  reset();
  let hits = 0;
  routes['/shellby-packs/packs/tiny-hats.json'] = (_req, res) => { hits++; res.end(PACK); };
  const port = server.address().port;
  for (const url of [
    'https://evil.example/shellby-packs/packs/tiny-hats.json',
    `http://localhost:${port}/shellby-packs/packs/tiny-hats.json`, // same server, different origin
    `http://127.0.0.1:${port + 1}/shellby-packs/packs/tiny-hats.json`,
    `https://127.0.0.1:${port}/shellby-packs/packs/tiny-hats.json`,
    `http://user:pw@127.0.0.1:${port}/shellby-packs/packs/tiny-hats.json`,
    'file:///C:/Windows/win.ini',
    'packs/tiny-hats.json', // relative
    42,
  ]) {
    serveIndex([entry({ url })]);
    const r = await get();
    assert.equal(r.ok, false, String(url));
    assert.match(r.errors[0], /outside the Shellby community registry/, String(url));
  }
  assert.equal(hits, 0);
});

test('pack urls outside the base path are refused, including .. tricks', async () => {
  reset();
  routes['/other/tiny-hats.json'] = (_req, res) => res.end(PACK);
  routes['/shellby-packs-evil/tiny-hats.json'] = (_req, res) => res.end(PACK);
  for (const url of [
    `${origin}/other/tiny-hats.json`,
    `${origin}/shellby-packs-evil/tiny-hats.json`,
    `${base}../other/tiny-hats.json`,
    `${base}packs/../../other/tiny-hats.json`,
    `${base}%2e%2e/other/tiny-hats.json`,
    `${base}..%2fother/tiny-hats.json`,
    `${base}`,
    `${origin}/shellby-packs`,
  ]) {
    serveIndex([entry({ url })]);
    const r = await get();
    assert.equal(r.ok, false, url);
    assert.match(r.errors[0], /outside the Shellby community registry/, url);
  }
});

test('oversize packs are refused from the index entry', async () => {
  reset();
  let hits = 0;
  routes['/shellby-packs/packs/tiny-hats.json'] = (_req, res) => { hits++; res.end(PACK); };
  serveIndex([entry({ bytes: 600 * 1024 })]);
  const r = await get();
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /too big/);
  assert.equal(hits, 0);
});

test('an oversize body is cut off even when content-length lies', async () => {
  reset();
  const big = 'x'.repeat(4096);
  serveIndex([entry({ bytes: 10, sha256: sha(big) })]);
  // Claims 10 bytes, streams 4 KB (well over the 1 KB cap below).
  routes['/shellby-packs/packs/tiny-hats.json'] = (_req, res) => {
    res.writeHead(200, { 'content-length': '10' });
    res.socket.write(`${big}`); // write raw past the declared length
    res.socket.end();
  };
  const r = await get('tiny-hats', { maxBytes: 1024 });
  assert.equal(r.ok, false); // Node's HTTP parser may reject this first; either way, never success

  // A response whose headers claim 10 bytes but whose body streams 4 KB: only
  // the streaming cap can catch this one.
  routes['/shellby-packs/packs/tiny-hats.json'] = (_req, res) => res.end(big);
  const lying = async (url, init) => {
    const res = await fetch(url, init);
    if (!String(url).endsWith('tiny-hats.json')) return res;
    return new Response(res.body, { status: 200, headers: { 'content-length': '10' } });
  };
  const r1 = await get('tiny-hats', { maxBytes: 1024, fetchImpl: lying });
  assert.equal(r1.ok, false);
  assert.match(r1.errors[0], /too big/);

  // No content-length at all (chunked): the streaming cap still applies.
  routes['/shellby-packs/packs/tiny-hats.json'] = (_req, res) => { res.write(big); res.end(big); };
  serveIndex([entry({ bytes: 10, sha256: sha(big + big) })]);
  const r2 = await get('tiny-hats', { maxBytes: 1024 });
  assert.equal(r2.ok, false);
  assert.match(r2.errors[0], /too big/);
});

test('a bad index is refused with a friendly error', async () => {
  reset();
  servePack();
  for (const body of ['not json', '[]', JSON.stringify({ format: 2, packs: [] }), JSON.stringify({ format: 1 }), JSON.stringify({ format: 1, packs: {} })]) {
    routes['/shellby-packs/index.json'] = (_req, res) => res.end(body);
    const r = await get();
    assert.equal(r.ok, false, body);
    assert.equal(r.errors.length, 1);
    assert.doesNotMatch(r.errors[0], /Unexpected token|JSON at position/, body); // no raw parser messages
  }
  routes['/shellby-packs/index.json'] = (_req, res) => { res.statusCode = 500; res.end('oops'); };
  assert.match((await get()).errors[0], /HTTP 500/);
  delete routes['/shellby-packs/index.json'];
  assert.match((await get()).errors[0], /404/);
});

test('network failures and timeouts are reported, never thrown', async () => {
  reset();
  // Nothing listening on this port.
  const dead = http.createServer();
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const deadBase = `http://127.0.0.1:${dead.address().port}/shellby-packs/`;
  await new Promise(r => dead.close(r));
  const r = await fetchRegistryPack('tiny-hats', { baseUrl: deadBase, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /Couldn't reach/);

  // Index that never answers.
  routes['/shellby-packs/index.json'] = () => { /* hang */ };
  const t = await get('tiny-hats', { timeoutMs: 150 });
  assert.equal(t.ok, false);
  assert.match(t.errors[0], /took too long/);

  // Pack that starts but stalls mid-body.
  serveIndex([entry()]);
  routes['/shellby-packs/packs/tiny-hats.json'] = (_req, res) => { res.write(PACK.slice(0, 10)); };
  const s = await get('tiny-hats', { timeoutMs: 300 });
  assert.equal(s.ok, false);
  assert.match(s.errors[0], /took too long/);

  // A fetch implementation that throws synchronously, or a nonsense one.
  assert.equal((await get('tiny-hats', { fetchImpl: () => { throw new Error('boom'); } })).ok, false);
  assert.equal((await get('tiny-hats', { fetchImpl: 'nope' })).ok, false);
  assert.equal((await get('tiny-hats', { baseUrl: 'not a url' })).ok, false);
  assert.equal((await get('Bad Id')).ok, false);
});

test('a redirect off the registry is refused', async () => {
  reset();
  routes['/elsewhere/index.json'] = (_req, res) => res.end(JSON.stringify({ format: 1, packs: [entry()] }));
  routes['/shellby-packs/index.json'] = (_req, res) => { res.writeHead(302, { location: '/elsewhere/index.json' }); res.end(); };
  servePack();
  const r = await get();
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /redirected/);
});

// ------------------------------------------------------------ the gallery's catalog

test('fetchRegistryCatalog lists tank decor as its own category, next to hats, effects and skins', async () => {
  const cat = { packs: [
    { id: 'reef-things', name: 'Reef Things', accessories: [{ id: 'kelp-hat', name: 'Kelp Hat', slot: 'hat' }], effects: [{ id: 'bubbles', name: 'Bubbles' }], decor: [{ id: 'coral-arch', name: 'Coral Arch' }, { id: '../evil', name: 'Bad' }, 'nope'] },
    { id: 'Bad Pack', decor: [{ id: 'arch', name: 'Arch' }] },
  ] };
  const r = await fetchRegistryCatalog({ fetchImpl: async () => new Response(JSON.stringify(cat)) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map(i => `${i.slot}:${i.key}`), ['hat:reef-things/kelp-hat', 'effect:reef-things/bubbles', 'decor:reef-things/coral-arch']);
});
