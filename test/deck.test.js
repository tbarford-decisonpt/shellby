// The Stream Deck keys: what each key shows (deck.js keys), what a press does
// (resolvePress and the wiring), the server the plugin talks to, with its
// token and its refusals over a real socket, the plugin itself against that
// server, and the .streamDeckPlugin it's packed into.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { installFakeElectron, fakeConfig, recorder } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
electron.safeStorage = { isEncryptionAvailable: () => false };
const deck = require('../src/main/deck');
const { pack, zip, crc32, FOLDER } = require('../src/main/deck-pack');
const { wireDeck, PLUGIN_DIR } = require('../src/main/wiring/deck');
const plugin = require('../src/streamdeck/com.xsalmon.shellby.sdPlugin/plugin.js');

const ROOT = path.join(__dirname, '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-deck-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const prompt = (over = {}) => ({ tabId: 't1', requestId: 'r1', toolName: 'Bash', label: 'Run', detail: 'npm test', input: { command: 'npm test' }, ...over });
const tab = (over = {}) => ({ id: 't1', title: 'Tests', busy: false, pending: 0, crew: 0, worktree: null, ready: null, ...over });

// ------------------------------------------------------------------ the keys

test('with nothing waiting, every key is idle', () => {
  const k = deck.keys({});
  for (const action of deck.ACTIONS) assert.equal(k[action].mode, 'idle', action);
});

test('Allow and Deny show the oldest prompt, its tool and how many are waiting', () => {
  const k = deck.keys({ prompts: [prompt(), prompt({ tabId: 't2', requestId: 'r9', toolName: 'Edit' })], tabs: [tab(), tab({ id: 't2' })] });
  assert.deepEqual(k.allow, { mode: 'ready', count: 2, line: 'Bash', ref: 't1\nr1' });
  assert.deepEqual(k.deny, k.allow);
});

test('a prompt the card would warn about says Look, never Allow', () => {
  for (const flagged of [
    { toolName: 'AskUserQuestion' },
    { toolName: 'ExitPlanMode' },
    { runsCreated: ['build.ps1'] },
    { selfConfig: 'Claude Code settings' },
    { input: { command: 'x'.repeat(400) } },
  ]) {
    const k = deck.keys({ prompts: [prompt(flagged)], tabs: [tab()] });
    assert.equal(k.allow.mode, 'look', JSON.stringify(flagged));
    assert.deepEqual(deck.resolvePress('allow', k.allow.ref, k), { do: 'show', tabId: 't1' });
  }
});

test('Stop follows the conversation on screen, else the only one working, else says Look', () => {
  const tabs = [tab({ id: 'a', title: 'Alpha', busy: true }), tab({ id: 'b', title: 'Beta', busy: true }), tab({ id: 'c' })];
  assert.deepEqual(deck.keys({ tabs, shown: 'b' }).stop, { mode: 'ready', count: 2, line: 'Beta', ref: 'b' });
  assert.equal(deck.keys({ tabs, shown: 'c' }).stop.mode, 'look');
  assert.deepEqual(deck.keys({ tabs: [tabs[0], tabs[2]], shown: 'c' }).stop.ref, 'a');
});

test('Bring it home is only for the conversation on screen, with a copy, and not mid-turn', () => {
  const w = { branch: 'shellby/fix-login-ab12', base: 'main' };
  assert.deepEqual(deck.keys({ tabs: [tab({ worktree: w })], shown: 't1' }).home, { mode: 'ready', count: 0, line: 'fix-login…', ref: 't1' });
  assert.equal(deck.keys({ tabs: [tab({ worktree: w, busy: true })], shown: 't1' }).home.mode, 'idle');
  assert.equal(deck.keys({ tabs: [tab({ worktree: w })], shown: null }).home.mode, 'idle');
  assert.equal(deck.keys({ tabs: [tab()], shown: 't1' }).home.mode, 'idle');
});

test('Ready to review counts the review inbox, the longest-waiting first', () => {
  const tabs = [
    tab({ id: 'new', title: 'Newer', ready: { at: 20, reviewed: false } }),
    tab({ id: 'old', title: 'Older', ready: { at: 10, reviewed: false } }),
    tab({ id: 'seen', ready: { at: 5, reviewed: true } }),
    tab({ id: 'busy', busy: true, ready: { at: 1, reviewed: false } }),
  ];
  const k = deck.keys({ tabs });
  assert.equal(k.review.count, 2);
  assert.equal(k.review.line, 'Older');
});

test('a press must still point at what the key showed', () => {
  const k = deck.keys({ prompts: [prompt()], tabs: [tab({ busy: true })], shown: 't1' });
  assert.deepEqual(deck.resolvePress('allow', 't1\nr1', k), { do: 'answer', decision: 'allow', tabId: 't1', requestId: 'r1' });
  assert.deepEqual(deck.resolvePress('deny', 't1\nr1', k), { do: 'answer', decision: 'deny', tabId: 't1', requestId: 'r1' });
  assert.deepEqual(deck.resolvePress('allow', 't1\nr0', k), { error: 'changed' });
  assert.deepEqual(deck.resolvePress('allow', undefined, k), { error: 'changed' });
  assert.deepEqual(deck.resolvePress('stop', 't1', k), { do: 'stop', tabId: 't1' });
  assert.deepEqual(deck.resolvePress('home', '', k), { error: 'nothing' });
  assert.deepEqual(deck.resolvePress('always', 't1\nr1', k), { error: 'unknown' });
});

// ------------------------------------------------------------------ the server

function request(port, { method = 'GET', path: p = '/deck/v1/keys', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; if (res.headers['content-type'] === 'text/event-stream' && text.includes('\n\n')) { res.destroy(); resolve({ status: res.statusCode, text }); } });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function serve(over = {}) {
  const presses = [];
  const server = new deck.DeckServer({
    token: 'secret-token', port: 0,
    getKeys: () => ({ allow: { mode: 'idle' } }),
    onPress: async (action, ref) => { presses.push([action, ref]); return { ok: true }; },
    ...over,
  });
  const listening = new Promise(r => server.once('status', r));
  server.start();
  await listening;
  after(() => server.stop());
  return { server, presses, auth: { Authorization: 'Bearer secret-token' } };
}

test('the server turns away anything without the token, and anything that looks like a browser', async () => {
  const { server, auth } = await serve();
  assert.equal((await request(server.port)).status, 401);
  assert.equal((await request(server.port, { headers: { Authorization: 'Bearer wrong-token!' } })).status, 401);
  assert.equal((await request(server.port, { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(server.port, { headers: { ...auth, Host: `evil.example:${server.port}` } })).status, 403);
  assert.equal((await request(server.port, { path: '/', headers: auth })).status, 404);
});

test('the server streams the keys straight away, and takes a press as JSON', async () => {
  const { server, presses, auth } = await serve();
  const stream = await request(server.port, { headers: auth });
  assert.equal(stream.status, 200);
  assert.match(stream.text, /data: \{"keys":\{"allow":\{"mode":"idle"\}\}\}/);

  const json = { ...auth, 'Content-Type': 'application/json' };
  const ok = await request(server.port, { method: 'POST', path: '/deck/v1/press', headers: json, body: JSON.stringify({ action: 'deny', ref: 't\nr' }) });
  assert.deepEqual(JSON.parse(ok.text), { ok: true });
  assert.deepEqual(presses, [['deny', 't\nr']]);

  // A form post (no preflight in a browser) is never JSON.
  assert.equal((await request(server.port, { method: 'POST', path: '/deck/v1/press', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request(server.port, { method: 'POST', path: '/deck/v1/press', headers: json, body: JSON.stringify({ action: 'always' }) })).status, 400);
  assert.equal((await request(server.port, { method: 'POST', path: '/deck/v1/press', headers: json, body: 'x'.repeat(5000) })).status, 413);
  assert.equal(presses.length, 1);
});

// ------------------------------------------------------------------ the plugin

function fakeDeck() {
  const sent = [];
  return { sent, send: msg => sent.push(msg), images: () => sent.filter(m => m.event === 'setImage') };
}

test('the plugin draws each key as it appears, and again only when it changes', () => {
  const sd = fakeDeck();
  const p = new plugin.Plugin({ send: sd.send, pair: { port: 1, token: 't' }, fetchImpl: async () => { throw new Error('no'); } });
  p.onMessage({ event: 'willAppear', action: 'com.xsalmon.shellby.allow', context: 'c1' });
  p.onMessage({ event: 'willAppear', action: 'com.example.other', context: 'c2' });
  assert.equal(sd.images().length, 1);
  assert.match(decodeURIComponent(sd.images()[0].payload.image), /Shellby\?/); // not heard from him yet

  const keys = deck.keys({ prompts: [prompt()], tabs: [tab()] });
  p.setKeys(keys);
  p.setKeys(keys);
  assert.equal(sd.images().length, 2);
  assert.match(decodeURIComponent(sd.images()[1].payload.image), />Bash</);
});

test('the plugin escapes what it draws and counts in the corner', () => {
  const svg = plugin.drawKey('allow', { mode: 'ready', count: 3, line: '<b>&"' });
  assert.match(svg, /&lt;b&gt;&amp;&quot;/);
  assert.match(svg, />3</);
  assert.doesNotMatch(plugin.drawKey('allow', { mode: 'ready', count: 1, line: 'x' }), /<circle/);
  assert.match(plugin.drawKey('review', { mode: 'ready', count: 1, line: 'x' }), /<circle/);
});

test('server-sent events are read across chunks', () => {
  const first = plugin.parseSse('retry: 2000\n\ndata: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(first.events, ['{"a":1}']);
  assert.deepEqual(plugin.parseSse(`${first.rest}:2}\r\n\r\n`).events, ['{"b":2}']);
});

test('the plugin hears Shellby, and a key press answers with the ref it showed', async () => {
  let keys = deck.keys({ prompts: [prompt()], tabs: [tab()] });
  const { server, presses } = await serve({ getKeys: () => keys });
  const sd = fakeDeck();
  const p = new plugin.Plugin({ send: sd.send, pair: { port: server.port, token: 'secret-token' } });
  after(() => p.close());
  p.onMessage({ event: 'willAppear', action: 'com.xsalmon.shellby.allow', context: 'c1' });
  p.listen();
  const until = async check => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(check()); };
  await until(() => p.keys?.allow?.mode === 'ready');

  keys = deck.keys({ prompts: [prompt({ toolName: 'Write' })], tabs: [tab()] });
  server.broadcast(keys);
  await until(() => p.keys?.allow?.line === 'Write');
  assert.match(decodeURIComponent(sd.images().at(-1).payload.image), />Write</);

  const r = await p.onMessage({ event: 'keyDown', action: 'com.xsalmon.shellby.allow', context: 'c1' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(presses, [['allow', 't1\nr1']]);
  assert.equal(sd.sent.at(-1).event, 'showOk');
});

test('a plugin with the wrong token gets nothing and shows him missing', async () => {
  const { server } = await serve();
  const sd = fakeDeck();
  const p = new plugin.Plugin({ send: sd.send, pair: { port: server.port, token: 'nope' } });
  p.onMessage({ event: 'willAppear', action: 'com.xsalmon.shellby.stop', context: 'c1' });
  const r = await p.press('c1', 'stop');
  assert.equal(r.ok, false);
  assert.equal(sd.sent.at(-1).event, 'showAlert');
  assert.equal(p.keys, null);
});

// ------------------------------------------------------------------ the wiring

function wired({ pending = [], busy = false } = {}) {
  const rec = recorder();
  const pendingMap = new Map(pending.map(p => [p.requestId, p]));
  const session = { pending: pendingMap };
  const manager = Object.assign(new EventEmitter(), {
    tabs: new Map([['t1', { session }]]),
    get summary() { return [tab({ busy, pending: pendingMap.size })]; },
    isBusy: () => busy,
    interrupt: rec.fn('interrupt'),
  });
  const d = {
    config: fakeConfig(), manager, deckShown: 't1', panel: {}, ICON: path.join(ROOT, 'assets', 'icon.png'),
    log: { info() {}, warn() {} },
    answerPermission: rec.fn('answerPermission', (tabId, requestId) => pendingMap.delete(requestId)),
    showPanel: rec.fn('showPanel'),
    send: rec.fn('send'),
  };
  return { d, rec, ...wireDeck(d) };
}

test('Allow from the deck answers the prompt as the deck, and never one flagged for the desk', async () => {
  const ok = wired({ pending: [prompt()] });
  const ref = ok.deckKeys().allow.ref;
  assert.deepEqual(await ok.onDeckPress('allow', ref), { ok: true });
  assert.deepEqual(ok.rec.of('answerPermission'), [['t1', 'r1', 'allow', { via: 'deck' }]]);
  // Pressed twice: the prompt is gone, so the second does nothing.
  assert.deepEqual(await ok.onDeckPress('allow', ref), { ok: false, error: 'nothing' });

  const flagged = wired({ pending: [prompt({ toolName: 'ExitPlanMode' })] });
  assert.deepEqual(await flagged.onDeckPress('allow', flagged.deckKeys().allow.ref), { ok: true });
  assert.deepEqual(flagged.rec.of('answerPermission'), []);
  assert.deepEqual(flagged.rec.of('showPanel'), [[{ focusInput: false, tabId: 't1' }]]);
});

test('Stop from the deck interrupts the turn on screen', async () => {
  const w = wired({ busy: true });
  assert.deepEqual(await w.onDeckPress('stop', 't1'), { ok: true });
  assert.deepEqual(w.rec.of('interrupt'), [['t1']]);
});

test('adding the keys packs the plugin with this PC\'s token and opens it', async () => {
  const w = wired();
  w.d.config.set({ streamDeck: { enabled: false } });
  const appdata = process.env.APPDATA;
  process.env.APPDATA = path.join(tmp, 'appdata');
  fs.mkdirSync(path.join(process.env.APPDATA, 'Elgato', 'StreamDeck'), { recursive: true });
  electron.app.getPath = () => path.join(tmp, 'userData');
  w.createDeck();
  try {
    const v = await w.addToStreamDeck();
    assert.equal(v.enabled, true);
    assert.equal(v.added, true);
    const [file] = electron.callsOf('shell.openPath').at(-1);
    assert.match(file, /Shellby\.streamDeckPlugin$/);
  } finally {
    w.d.deck.stop();
    process.env.APPDATA = appdata;
  }
});

// ------------------------------------------------------------------ the package

test('crc32 is the zip one', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the .streamDeckPlugin unzips to a plugin whose manifest finds every file', t => {
  // Windows' own tar is bsdtar, which reads zips (Git's GNU tar, often first on PATH, doesn't).
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(tar)) { t.skip('no bsdtar to unzip with'); return; }
  const file = path.join(tmp, 'Shellby.streamDeckPlugin');
  fs.writeFileSync(file, pack({ srcDir: PLUGIN_DIR, icon: path.join(ROOT, 'assets', 'icon.png'), pair: { port: 47915, token: 'tok' } }));
  const out = path.join(tmp, 'unzipped');
  fs.mkdirSync(out);
  execFileSync(tar, ['-xf', file, '-C', out]);
  const dir = path.join(out, FOLDER);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'shellby.json'), 'utf8')), { port: 47915, token: 'tok' });
  assert.equal(manifest.UUID, plugin.UUID);
  const exists = (base, exts) => exts.some(e => fs.existsSync(path.join(dir, base + e)));
  assert.ok(exists(manifest.Icon, ['.png']), 'the plugin icon is a PNG');
  assert.ok(exists(manifest.CategoryIcon, ['.svg', '.png']));
  assert.deepEqual(manifest.Actions.map(a => a.UUID), plugin.ACTIONS.map(a => `${plugin.UUID}.${a}`));
  for (const a of manifest.Actions) {
    assert.ok(exists(a.Icon, ['.svg', '.png']), a.Icon);
    for (const s of a.States) assert.ok(exists(s.Image, ['.svg', '.png']), s.Image);
  }
  assert.ok(fs.existsSync(path.join(dir, manifest.CodePath)));
});

test('a zip of nothing is just its end record', () => {
  assert.equal(zip([]).length, 22);
});
