const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerTankGaugesIpc } = require('../src/main/ipc/tank-gauges');
const G = require('../src/main/tank/gauges');

// A feed over a fake ipcMain and config, recording what reaches the panel.
function feed({ usage = null, now = () => 1000 } = {}) {
  const handlers = new Map();
  const sent = [];
  const store = { tankLive: null };
  let u = usage;
  const f = registerTankGaugesIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, {
    config: { get: k => store[k], set: o => Object.assign(store, o) },
    toPanel: (channel, payload) => sent.push({ channel, payload }),
    health: () => null,
    moodsOn: () => true,
    servers: () => null,
    usage: () => u,
    now,
  });
  return { f, sent, ask: (ch, arg) => handlers.get(ch)(null, arg), setUsage: v => { u = v; } };
}

test('a new usage reading moves the tide and reaches the panel', () => {
  const { f, sent, setUsage } = feed();
  setUsage({ fiveHour: { pct: 40, resetsAt: 9e12 } });
  f.usage();
  assert.deepEqual(sent.at(-1).payload.tide, { left: 60 });
  f.usage(); // the same reading: nothing more is sent
  assert.equal(sent.length, 1);
});

test('a recap puts a bottle in the tank until it is read', async () => {
  const { f, sent, ask } = feed();
  f.unread('recap');
  assert.equal(sent.at(-1).payload.bottle, 'recap');
  f.unread('nonsense');
  assert.equal(sent.length, 1);
  assert.deepEqual(await ask('tank:bottle-read', { kind: 'week' }), { ok: true });
  assert.equal(sent.length, 1, 'reading a card that was not waiting changes nothing');
  await ask('tank:bottle-read', { kind: 'recap' });
  assert.equal(sent.at(-1).payload.bottle, null);
  assert.deepEqual(await ask('tank:bottle-read', null), { ok: true });
});

test('a merge makes the chest glint, then stops it a minute later', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000;
  const { f, sent } = feed({ now: () => clock });
  f.merged();
  assert.equal(sent.at(-1).payload.chest, true);
  clock += G.GLINT_MS + 50;
  t.mock.timers.tick(G.GLINT_MS + 50);
  assert.equal(sent.at(-1).payload.chest, false);
});

test('the new gauges can be turned off like the others', async () => {
  const { f, ask } = feed();
  f.unread('week');
  const r = await ask('tank:live', { key: 'bottle', on: false });
  assert.equal(r.ok, true);
  assert.equal(r.gauges.bottle, null);
  assert.equal(r.gauges.live.bottle, false);
});
