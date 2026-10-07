// The Wardrobe's first-run credit (wiring/wardrobe.js pastUsage): finished
// tasks and the days you worked, read from history.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron } = require('./helpers/fake-ipc');

installFakeElectron();
const { pastUsage } = require('../src/main/wiring/wardrobe');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

function fakeHistory(convos) {
  return {
    list: () => convos.map(({ items: _items, ...e }) => e),
    load: id => convos.find(c => c.id === id).items,
  };
}

test('only results that went well count as finished tasks', () => {
  const history = fakeHistory([
    { id: 'a', createdAt: at(2026, 3, 1), updatedAt: at(2026, 3, 1), items: [{ kind: 'user' }, { kind: 'result', ok: true }, { kind: 'result', ok: false }] },
    { id: 'b', createdAt: at(2026, 3, 2), updatedAt: at(2026, 3, 4), items: [{ kind: 'result', ok: true }, { kind: 'result', ok: true }] },
  ]);
  assert.equal(pastUsage(history).tasksCompleted, 3);
});

test('each day a conversation started or was last touched is a day worked, once', () => {
  const history = fakeHistory([
    { id: 'a', createdAt: at(2026, 3, 1, 9), updatedAt: at(2026, 3, 1, 18), items: [] },
    { id: 'b', createdAt: at(2026, 3, 2), updatedAt: at(2026, 12, 25), items: [] },
    { id: 'c', createdAt: null, updatedAt: undefined, items: [] },
  ]);
  assert.deepEqual(pastUsage(history).activeDays.sort(), ['2026-03-01', '2026-03-02', '2026-12-25']);
});

test('no history, no credit', () => {
  assert.deepEqual(pastUsage(fakeHistory([])), { tasksCompleted: 0, activeDays: [] });
});
