// The per-turn ledger's wiring (src/main/wiring/usageplan.js) with a fake
// config and tabs: a turn's spend and usage rise are summed between its start
// and its result, and land as one row without the prompt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wireUsagePlan } = require('../src/main/wiring/usageplan');

function fakeShared(settings = {}) {
  const data = { model: '', spendGuard: true, spendReserve: 25, turnCosts: [], lastUsage: null, ...settings };
  const tabs = new Map();
  const d = {
    CAPTURE: false,
    config: { get: k => data[k], set: patch => Object.assign(data, patch) },
    manager: { tabs },
    currentCwd: () => 'C:\\code\\shellby',
    projectKeyOf: dir => ({ project: dir.split('\\').pop(), pk: dir.toLowerCase() }),
    spendSource: tab => ({ kind: tab.routineId ? 'routine' : 'tab', project: 'shellby', pk: 'c:\\code\\shellby' }),
  };
  return { d, data, tabs };
}

const tabOf = (over = {}) => ({ id: 't1', turnId: 'turn-1', turnText: 'fix the failing login test', session: { lastModel: 'claude-opus-4-8' }, ...over });
const reading = (pct, resetsAt = Date.now() + 3600e3) => ({ kind: 'usage', fiveHour: { pct, resetsAt } });

test('a finished turn leaves one row with its spend, rise and category, never its prompt', () => {
  const { d, data } = fakeShared();
  const plan = wireUsagePlan(d);
  const tab = tabOf();
  plan.onUsage('other', reading(10));
  plan.beginTurn(tab);
  plan.onSpend(tab, 400);
  plan.onSpend(tab, 600);
  plan.onUsage('t1', reading(14));
  plan.endTurn(tab, { ok: true, durationMs: 5000, turns: 3, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
  plan.save();
  const [row] = data.turnCosts;
  assert.equal(data.turnCosts.length, 1);
  assert.equal(row.category, 'fix');
  assert.equal(row.weight, 1000);
  assert.equal(row.pctRise, 4);
  assert.equal(row.model, 'claude-opus-4-8');
  assert.equal(row.durationMs, 5000);
  assert.equal(JSON.stringify(data.turnCosts).includes('login'), false);
  assert.equal(tab.turnText, null, 'the prompt is let go as the turn starts');
});

test('a stopped turn, or a summary turn carrying on, leaves no row', () => {
  const { d, data } = fakeShared();
  const plan = wireUsagePlan(d);
  const tab = tabOf();
  plan.beginTurn(tab);
  plan.onSpend(tab, 500);
  plan.endTurn(tab, { ok: false, interrupted: true });
  plan.beginTurn(tab); // the same turn going on (start fresh): already counted
  plan.onSpend(tab, 500);
  plan.endTurn(tab, { ok: true });
  plan.save();
  assert.deepEqual(data.turnCosts, []);
});

test('a turn without a usage reading keeps its rise unknown', () => {
  const { d, data } = fakeShared();
  const plan = wireUsagePlan(d);
  const tab = tabOf();
  plan.beginTurn(tab);
  plan.onSpend(tab, 800);
  plan.endTurn(tab, { ok: true });
  plan.save();
  assert.equal(data.turnCosts[0].pctRise, null);
});

test('estimateFor says hold only with the setting on and the line in reach', () => {
  const rows = [3, 20, 22, 25].map((p, i) => ({ at: Date.now() - i * 1000, pk: 'c:\\code\\shellby', project: 'shellby', category: 'fix', weight: 100, pctRise: p, ok: true }));
  const lastUsage = { fiveHour: { pct: 63, resetsAt: Date.now() + 3600e3 } };
  const tabs = t => t.set('t1', tabOf());
  const off = fakeShared({ turnCosts: rows, lastUsage });
  tabs(off.tabs);
  const e = wireUsagePlan(off.d).estimateFor('t1', 'fix the flaky upload test');
  assert.equal(e.basis, 'project+kind');
  assert.equal(e.over, true);
  assert.equal(e.left, 12);
  assert.equal(e.hold, false, 'never automatic by default');
  const on = fakeShared({ turnCosts: rows, lastUsage, holdBigTasks: true });
  tabs(on.tabs);
  assert.equal(wireUsagePlan(on.d).estimateFor('t1', 'fix the flaky upload test').hold, true);
  on.tabs.set('r1', tabOf({ id: 'r1', routineId: 'r-1' }));
  assert.equal(wireUsagePlan(on.d).estimateFor('r1', 'fix the flaky upload test').hold, false, 'routines have the guard');
});

test('clear empties the ledger', () => {
  const { d, data } = fakeShared({ turnCosts: [{ at: Date.now(), weight: 5, category: 'fix' }] });
  wireUsagePlan(d).clear();
  assert.deepEqual(data.turnCosts, []);
});
