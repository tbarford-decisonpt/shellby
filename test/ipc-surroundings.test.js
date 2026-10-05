// The surroundings' IPC (src/main/ipc/surroundings.js): links only open over
// https, the crab card is checked to be a PNG before it's saved, and only the
// card main saved itself is shown in Explorer.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, fakeConfig, recorder, isStr } = require('./helpers/fake-ipc');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-surroundings-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const electron = installFakeElectron({ userData: path.join(root, 'userData'), pictures: path.join(root, 'Pictures') });
const { registerSurroundingsIpc } = require('../src/main/ipc/surroundings');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CARD_MAX_BYTES = 64;
const png = (extra = 8) => new Uint8Array(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(extra, 1)]));

function setup() {
  const ipc = createFakeIpc();
  const config = fakeConfig();
  const rec = recorder();
  const d = {
    config, isStr, PNG_SIGNATURE, CARD_MAX_BYTES,
    log: { warn: rec.fn('log.warn') },
    stat: rec.fn('stat'),
    health: {
      view: () => ({ view: true }),
      setSettings: rec.fn('health.setSettings', p => p),
      ask: rec.fn('health.ask', () => ({ ok: true })),
      endTask: rec.fn('health.endTask', pid => ({ pid })),
      endGroup: rec.fn('health.endGroup', name => ({ name })),
      hogs: rec.fn('health.hogs', m => ({ m })),
      setStartup: rec.fn('health.setStartup', (id, off) => ({ id, off })),
    },
    obsSettings: () => config.get('obs') || { enabled: false, port: 4455 },
    obsView: () => ({ obs: config.get('obs') }),
    obsServer: { port: 0, start: rec.fn('obs.start'), stop: rec.fn('obs.stop') },
    weatherSvc: { set: rec.fn('weather.set'), search: rec.fn('weather.search', q => q) },
    weatherView: () => ({}),
    broadcastWardrobe: rec.fn('broadcastWardrobe'),
    typingSettings: () => ({ enabled: false, remarks: true }),
    typing: { sync: rec.fn('typing.sync'), view: () => config.get('typing') },
  };
  registerSurroundingsIpc(ipc.ipcMain, d);
  return { ipc, config, rec };
}

const opened = () => electron.callsOf('shell.openExternal').map(([url]) => url);
const revealed = () => electron.callsOf('shell.showItemInFolder').map(([p]) => p);

test('open-external opens an https link', () => {
  const { ipc } = setup();
  const before = opened().length;

  ipc.send('open-external', 'https://github.com/x-salmon/shellby');

  assert.deepEqual(opened().slice(before), ['https://github.com/x-salmon/shellby']);
});

test('open-external ignores anything that is not https', () => {
  const { ipc } = setup();
  const before = opened().length;

  for (const url of ['http://example.com', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)',
    'ms-settings:privacy', 'smb://server/share', 'not a url', '', null, 42, { href: 'https://x.y' }]) {
    ipc.send('open-external', url);
  }

  assert.deepEqual(opened().slice(before), []);
});

test('open-external sent from the crab window is dropped by the guard', () => {
  const { ipc } = setup();
  const before = opened().length;

  ipc.sendAs(ipc.senders.critter, 'open-external', 'https://example.com');

  assert.deepEqual(opened().slice(before), []);
  assert.deepEqual(ipc.refused, ['open-external']);
});

test('clipboard:text copies a short string and nothing else', () => {
  const { ipc } = setup();
  const before = electron.callsOf('clipboard.writeText').length;

  ipc.send('clipboard:text', 'hello');
  ipc.send('clipboard:text', 'x'.repeat(2001));
  ipc.send('clipboard:text', { text: 'hi' });
  ipc.send('clipboard:text', '');

  assert.deepEqual(electron.callsOf('clipboard.writeText').slice(before), [['hello']]);
});

test('card:save refuses bytes that are not a PNG, too big, or not bytes at all', async () => {
  const { ipc } = setup();

  for (const bad of [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), png(CARD_MAX_BYTES), 'iVBORw0KGgo=', [137, 80, 78, 71], null, PNG_SIGNATURE.buffer]) {
    const r = await ipc.invoke('card:save', bad, 'card');
    assert.equal(r.ok, false, String(bad));
  }
});

test('card:save writes the PNG under Pictures/Shellby, copies it, and card:reveal shows that file', async () => {
  const { ipc, rec } = setup();
  const writesBefore = electron.callsOf('clipboard.write').length;

  const r = await ipc.invoke('card:save', png(), 'week');

  assert.equal(r.ok, true);
  assert.equal(r.copied, true);
  assert.match(r.name, /^Pictures[\\/]Shellby[\\/]shellby-week-\d{8}-\d{6}\.png$/);
  const saved = path.join(root, 'Pictures', 'Shellby', path.basename(r.name));
  assert.deepEqual([...fs.readFileSync(saved)], [...png()]);
  const [items] = electron.callsOf('clipboard.write').slice(writesBefore)[0];
  assert.deepEqual(items[0].types, ['image/png'], 'copied as a PNG ClipboardItem (Electron 44 clipboard)');
  assert.deepEqual(rec.of('stat'), [['card-shared']]);

  ipc.send('card:reveal');
  assert.equal(revealed().at(-1), saved);
});

test('card:save names an unknown kind "card" rather than putting the renderer\'s text in the path', async () => {
  const { ipc } = setup();

  const r = await ipc.invoke('card:save', png(), '..\\..\\evil');

  assert.match(path.basename(r.name), /^shellby-card-/);
});

test('card:save still reports the save when the clipboard is busy', async () => {
  const { ipc, rec } = setup();
  const realWrite = electron.clipboard.write;
  electron.clipboard.write = async () => { throw new Error('clipboard locked'); };
  try {
    const r = await ipc.invoke('card:save', png(), 'beach');

    assert.equal(r.ok, true);
    assert.equal(r.copied, false);
    assert.equal(rec.of('log.warn').length, 1);
  } finally { electron.clipboard.write = realWrite; }
});

test('card:reveal shows nothing before a card was saved, whatever it is sent', () => {
  const { ipc } = setup();
  const before = revealed().length;

  ipc.send('card:reveal', 'C:\\Windows\\System32');

  assert.equal(revealed().length, before);
});

test('card:copy is ok only for a real PNG', async () => {
  const { ipc } = setup();

  assert.deepEqual(await ipc.invoke('card:copy', png()), { ok: true });
  assert.deepEqual(await ipc.invoke('card:copy', 'png'), { ok: false });
});

test('health handlers pass on only the types they expect', async () => {
  const { ipc, rec } = setup();

  await ipc.invoke('health:end-task', '1234');
  await ipc.invoke('health:end-task', 1234);
  await ipc.invoke('health:end-group', { name: 'chrome' });
  await ipc.invoke('health:set-startup', 7, 'yes');
  await ipc.invoke('health:set', 'all-off');
  const asked = await ipc.invoke('health:ask', 99);

  assert.deepEqual(rec.of('health.endTask'), [[null], [1234]]);
  assert.deepEqual(rec.of('health.endGroup'), [[null]]);
  assert.deepEqual(rec.of('health.setStartup'), [[null, false]]);
  assert.deepEqual(rec.of('health.setSettings'), [[{}]]);
  assert.deepEqual(asked, { ok: false, error: 'Unknown reading.' });
  assert.deepEqual(rec.of('health.ask'), []);
});

test('obs:set keeps the port to 1024-65535 integers', async () => {
  const { ipc, config } = setup();

  for (const port of [80, 70000, 4455.5, 'abc']) await ipc.invoke('obs:set', { port });
  assert.equal(config.get('obs').port, 4455);

  await ipc.invoke('obs:set', { enabled: 1, port: '8080' });
  assert.deepEqual(config.get('obs'), { enabled: true, port: 8080 });
});

test('typing:set and weather:set ignore a payload that is not an object', async () => {
  const { ipc, config, rec } = setup();

  await ipc.invoke('typing:set', 'enabled');
  await ipc.invoke('weather:set', null);
  await ipc.invoke('weather:search', { q: 'Oslo' });

  assert.deepEqual(config.get('typing'), { enabled: false, remarks: true });
  assert.deepEqual(rec.of('weather.set'), [[{}]]);
  assert.deepEqual(rec.of('weather.search'), [['']]);
});
