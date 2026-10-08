// The OBS browser source. The server is booted for real on a loose port and
// driven over HTTP, because what matters is the exact surface a browser sees:
// which URLs answer, what they refuse, and whether the event stream actually
// delivers the crab.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ObsServer, routeTable, urlFor, MAX_CLIENTS } = require('../src/main/obs');

const SRC = path.join(__dirname, '..', 'src');
const ASSETS = path.join(__dirname, '..', 'assets');

const STATE = {
  skin: { pixels: ['ab', 'ba'], palette: { a: '#f00', b: '#0f0' }, parts: {} },
  outfit: { accessories: [], effect: null, crewAccessories: [], home: null },
  px: 4,
  state: 'working',
  busy: 2,
  crew: [],
};

async function boot(getState = () => STATE) {
  const server = new ObsServer({ srcDir: SRC, assetsDir: ASSETS, getState, port: 0 });
  await new Promise(resolve => { server.once('status', resolve); server.start(); });
  return server;
}

const get = (server, route, opts = {}) => fetch(`http://127.0.0.1:${server.port}${route}`, opts);

// ------------------------------------------------------------------ the routes

test('every route in the table points at a file that exists', () => {
  const routes = routeTable(SRC, ASSETS);
  for (const [url, file] of Object.entries(routes)) {
    assert.ok(fs.existsSync(file), `${url} -> ${file} is missing`);
  }
  // The things the overlay page actually asks for.
  for (const needed of ['/', '/obs/overlay.js', '/obs/overlay.css', '/shared/sprite.js',
    '/shared/fonts.css', '/critter/critter.css', '/shared/workposes.js', '/assets/fonts/PixelifySans.ttf']) {
    assert.ok(routes[needed], `${needed} is not served`);
  }
});

test('the page is served with the right type, and says it is the overlay', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const res = await get(server, '/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const html = await res.text();
  assert.match(html, /Shellby overlay/);
  assert.match(html, /EventSource|overlay\.js/);
});

test('the overlay page asks only for URLs the server answers', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const html = await (await get(server, '/')).text();
  // Every href/src in the page must be a route, or the crab loads half-dressed.
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 6, `found ${refs.length} references`);
  for (const ref of refs) {
    const res = await get(server, ref);
    assert.equal(res.status, 200, `${ref} returned ${res.status}`);
  }
});

test('the stylesheet it borrows is the real critter one', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const css = await (await get(server, '/critter/critter.css')).text();
  const onDisk = fs.readFileSync(path.join(SRC, 'renderer', 'critter', 'critter.css'), 'utf8');
  assert.equal(css, onDisk, 'served byte for byte, so the stream crab matches the desktop one');
});

test('the overlay keeps the DOM ids and state classes critter.css styles', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const html = await (await get(server, '/')).text();
  // If the real crab's stylesheet is reused, the page has to look like the real
  // crab's page. These are the hooks critter.css hangs its animations on.
  for (const id of ['stage', 'self', 'crab', 'sprite', 'bubble', 'bubbleText', 'crew', 'shadow', 'fx', 'zzz']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing`);
  }
  assert.match(html, /class="state-idle"/, 'starts in a state critter.css knows');
  const css = fs.readFileSync(path.join(SRC, 'renderer', 'critter', 'critter.css'), 'utf8');
  assert.match(css, /#sprite/, 'critter.css really does style #sprite');
});

test('the overlay css makes the background transparent for OBS', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const css = await (await get(server, '/obs/overlay.css')).text();
  assert.match(css, /background:\s*transparent\s*!important/);
});

// ------------------------------------------------------------------ refusals

test('an unknown URL is a plain 404, and no request ever becomes a file path', async t => {
  const server = await boot();
  t.after(() => server.stop());
  for (const url of [
    '/nope',
    '/../package.json',
    '/..%2fpackage.json',
    '/shared/../../../package.json',
    '/assets/fonts/../../../package.json',
    '/C:/Windows/win.ini',
    '//etc/passwd',
    '/obs/overlay.js/../../../../package.json',
  ]) {
    const res = await get(server, url);
    assert.equal(res.status, 404, `${url} returned ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('"name"'), `${url} leaked a file`);
  }
});

test('only GET and HEAD are allowed', async t => {
  const server = await boot();
  t.after(() => server.stop());
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await get(server, '/', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  }
  assert.equal((await get(server, '/', { method: 'HEAD' })).status, 200);
});

test('a query string or fragment still finds the route', async t => {
  const server = await boot();
  t.after(() => server.stop());
  assert.equal((await get(server, '/?layer=1')).status, 200);
  assert.equal((await get(server, '/obs/overlay.css?v=2')).status, 200);
});

// ------------------------------------------------------------------ the stream

/** Read Server-Sent Events off the stream until `want` data frames arrive. */
async function readEvents(server, want, { after } = {}) {
  const res = await get(server, '/events');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let kicked = false;
  while (frames.length < want) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    }
    buffer = '';
    if (after && !kicked) { kicked = true; after(); }
  }
  await reader.cancel();
  return frames;
}

test('a new browser source is sent the crab straight away', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const [first] = await readEvents(server, 1);
  assert.equal(first.state, 'working');
  assert.equal(first.busy, 2);
  assert.deepEqual(first.skin.palette, STATE.skin.palette);
  assert.equal(server.viewers, 1);
});

test('a state change reaches the open browser source', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const frames = await readEvents(server, 2, { after: () => server.broadcast({ ...STATE, state: 'asking', busy: 0 }) });
  assert.equal(frames[0].state, 'working', 'the one it opened with');
  assert.equal(frames[1].state, 'asking', 'and then the change');
});

test('with no state yet, the stream still opens rather than failing', async t => {
  const server = await boot(() => null);
  t.after(() => server.stop());
  const [first] = await readEvents(server, 1);
  assert.deepEqual(first, {});
});

test('a getState that throws does not take the connection down', async t => {
  const server = await boot(() => { throw new Error('mid-update'); });
  t.after(() => server.stop());
  const [first] = await readEvents(server, 1);
  assert.deepEqual(first, {});
});

test('viewers are counted, and a closed source is forgotten', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const res = await get(server, '/events');
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(server.viewers, 1);
  await reader.cancel();
  // The close event is what drops it; give the server a tick to see it.
  for (let i = 0; i < 40 && server.viewers > 0; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(server.viewers, 0);
});

test('too many browser sources is refused rather than unbounded', async t => {
  const server = await boot();
  const readers = [];
  t.after(async () => { for (const r of readers) await r.cancel().catch(() => {}); server.stop(); });
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const res = await get(server, '/events');
    const reader = res.body.getReader();
    await reader.read();
    readers.push(reader);
  }
  assert.equal(server.viewers, MAX_CLIENTS);
  assert.equal((await get(server, '/events')).status, 503);
});

// ------------------------------------------------------------------ lifecycle

test('the view gives a URL you can paste into OBS, and nothing when it is off', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const v = server.view();
  assert.equal(v.status, 'listening');
  assert.equal(v.url, urlFor(server.port));
  assert.match(v.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  server.stop();
  assert.deepEqual(server.view().url, null);
  assert.equal(server.view().status, 'off');
});

test('stopping closes the open sources and starting again works', async t => {
  const server = await boot();
  t.after(() => server.stop());
  const res = await get(server, '/events');
  const reader = res.body.getReader();
  await reader.read();
  server.stop();
  // The stream ends rather than hanging forever.
  const { done } = await reader.read();
  assert.equal(done, true);
  await new Promise(resolve => { server.once('status', resolve); server.port = 0; server.start(); });
  assert.equal(server.view().status, 'listening');
  assert.equal((await get(server, '/')).status, 200);
});

test('a port already in use is reported, not thrown', async t => {
  const first = await boot();
  t.after(() => { first.stop(); });
  const second = new ObsServer({ srcDir: SRC, assetsDir: ASSETS, getState: () => STATE, port: first.port });
  const view = await new Promise(resolve => { second.once('status', resolve); second.start(); });
  assert.equal(view.status, 'busy');
  assert.equal(second.view().url, null);
});
