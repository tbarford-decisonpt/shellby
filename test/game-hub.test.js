const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GAME_VIEWS, createGameHub, isView } = require('../src/main/game-hub');
const { registerGameIpc } = require('../src/main/ipc/game');
const fixtures = require('./fixtures/game-views.json');

function makeHub() {
  const sent = [];
  const d = { panel: { id: 'panel' }, send: (win, channel, payload) => sent.push({ win, channel, payload }) };
  return { hub: createGameHub(d), sent };
}

test('the allowlist is the nine game screens', () => {
  assert.deepEqual([...GAME_VIEWS].sort(), ['logbook', 'molt', 'nests', 'quests', 'reef', 'review', 'unlocks', 'wrapped', 'yearbook']);
  assert.ok(Object.isFrozen(GAME_VIEWS));
  assert.equal(isView('reef'), true);
  assert.equal(isView('toString'), false);
  assert.equal(isView(42), false);
});

test('registering an unknown name throws', () => {
  const { hub } = makeHub();
  assert.throws(() => hub.register('casino', { get: () => 1 }), /unknown view/);
  assert.throws(() => hub.register('__proto__', { get: () => 1 }), /unknown view/);
});

test('a view needs a get and is registered once', () => {
  const { hub } = makeHub();
  assert.throws(() => hub.register('reef', {}), /needs a get/);
  hub.register('reef', { get: () => fixtures.reef });
  assert.throws(() => hub.register('reef', { get: () => null }), /twice/);
  assert.equal(hub.has('reef'), true);
});

test('get returns the registered view and passes the arg through', () => {
  const { hub } = makeHub();
  hub.register('nests', { get: arg => ({ ...fixtures.nests, arg }) });
  assert.equal(hub.get('nests', 'shellby').arg, 'shellby');
});

test('get returns null for unknown or not yet registered names', () => {
  const { hub } = makeHub();
  assert.equal(hub.get('casino'), null);
  assert.equal(hub.get('logbook'), null);
});

test('act reaches the view and refuses unknown names and odd actions', () => {
  const { hub } = makeHub();
  const calls = [];
  hub.register('molt', { get: () => fixtures.molt, act: (action, payload) => (calls.push([action, payload]), { done: true }) });
  assert.deepEqual(hub.act('molt', 'confirm', { yes: true }), { done: true });
  assert.equal(hub.act('casino', 'confirm'), null);
  assert.equal(hub.act('molt', 'Confirm!'), null);
  assert.equal(hub.act('molt', ''), null);
  assert.equal(hub.act('molt', 7), null);
  assert.deepEqual(calls, [['confirm', { yes: true }]]);
});

test('act on a view without act returns null', () => {
  const { hub } = makeHub();
  hub.register('yearbook', { get: () => fixtures.yearbook });
  assert.equal(hub.act('yearbook', 'open'), null);
});

test('push sends the view to the panel on the game channel', () => {
  const { hub, sent } = makeHub();
  assert.equal(hub.push('reef', fixtures.reef), true);
  assert.equal(hub.push('reef', fixtures.reef, { kind: 'best' }), true);
  assert.equal(hub.push('casino', {}), false);
  assert.deepEqual(sent.map(s => [s.win.id, s.channel]), [['panel', 'game'], ['panel', 'game']]);
  assert.deepEqual(sent[0].payload, { what: 'reef', view: fixtures.reef });
  assert.deepEqual(sent[1].payload.event, { kind: 'best' });
});

test('the fixtures hold one view per game screen', () => {
  const names = Object.keys(fixtures).filter(k => !k.startsWith('_'));
  assert.deepEqual(names.sort(), [...GAME_VIEWS].sort());
});

test('game:get and game:act validate before reaching the hub', async () => {
  const handlers = {};
  const { hub } = makeHub();
  hub.register('unlocks', { get: () => fixtures.unlocks, act: action => ({ action }) });
  registerGameIpc({ handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {} }, { gameHub: hub });
  assert.deepEqual(await handlers['game:get']({}, 'unlocks'), fixtures.unlocks);
  assert.equal(await handlers['game:get']({}, 'casino'), null);
  assert.equal(await handlers['game:get']({}, { what: 'unlocks' }), null);
  assert.deepEqual(await handlers['game:act']({}, 'unlocks', 'seen'), { action: 'seen' });
  assert.equal(await handlers['game:act']({}, 'unlocks', 'drop table'), null);
});
