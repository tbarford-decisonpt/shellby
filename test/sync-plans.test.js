const test = require('node:test');
const assert = require('node:assert');
const plans = require('../src/main/sync-plans');

const routine = (over = {}) => ({
  id: 'r1', name: 'Tidy', prompt: 'Tidy my Downloads', cwd: null, mode: 'smart', model: '',
  schedule: { type: 'daily', time: '17:00' }, enabled: true, catchUp: true, createdAt: 1000, lastRunAt: null, lastStatus: null, ...over,
});
const workflow = (over = {}) => ({ id: 'w1', name: 'Hello', steps: [{ type: 'tell', text: 'hi' }], enabled: true, createdAt: 1000, updatedAt: 2000, ...over });

test('an item from another PC arrives switched off, with none of its run state', () => {
  const remote = plans.snapshot({ routines: [routine({ lastRunAt: 5000, lastStatus: 'ok' })], workflows: [workflow()] }, {});
  const merged = plans.merge(plans.snapshot({}, {}), remote);
  const { values } = plans.apply({}, merged);
  assert.strictEqual(values.routines.length, 1);
  assert.strictEqual(values.routines[0].enabled, false);
  assert.strictEqual(values.routines[0].lastRunAt, null);
  assert.strictEqual(values.workflows[0].enabled, false);
});

test('an edit made later wins, and this PC keeps it switched on', () => {
  const local = { routines: [routine()] };
  const localSnap = plans.snapshot(local, { routines: { items: { r1: 10 } } });
  const remote = plans.snapshot({ routines: [routine({ prompt: 'Tidy Desktop too', enabled: false })] }, { routines: { items: { r1: 20 } } });
  const { values } = plans.apply(local, plans.merge(localSnap, remote));
  assert.strictEqual(values.routines[0].prompt, 'Tidy Desktop too');
  assert.strictEqual(values.routines[0].enabled, true);
});

test('a delete made later removes it; an older one does not', () => {
  const local = { routines: [routine()] };
  const gone = later => plans.snapshot({ routines: [] }, { routines: { gone: { r1: later } } });
  const keep = plans.apply(local, plans.merge(plans.snapshot(local, { routines: { items: { r1: 50 } } }), gone(40)));
  assert.ok(!('routines' in keep.values));
  const del = plans.apply(local, plans.merge(plans.snapshot(local, { routines: { items: { r1: 50 } } }), gone(60)));
  assert.deepStrictEqual(del.values.routines, []);
});

test('nothing in Autonomous comes across, and a local one stays put', () => {
  const remote = plans.clean({ routines: { v: [routine({ mode: 'autonomous' })] } });
  assert.deepStrictEqual(remote.routines.v, []);
  const local = { routines: [routine({ mode: 'autonomous' })] };
  const { values } = plans.apply(local, plans.merge(plans.snapshot(local, {}), plans.snapshot({ routines: [routine()] }, {})));
  assert.ok(!('routines' in values));
});

test('restamp: edits and deletes are stamped, a run or a switch is not', () => {
  const prev = { routines: [routine(), routine({ id: 'r2', name: 'Two' })] };
  assert.strictEqual(plans.restamp({ routines: [routine({ enabled: false, lastRunAt: 9 }), prev.routines[1]] }, prev, {}, 100), null);
  const s = plans.restamp({ routines: [routine({ prompt: 'New' })] }, prev, {}, 100);
  assert.strictEqual(s.routines.items.r1, 100);
  assert.strictEqual(s.routines.gone.r2, 100);
  assert.strictEqual(plans.restamp({ mode: 'smart' }, prev, {}, 100), null);
});

test('garbage from the gist is dropped', () => {
  const c = plans.clean({ routines: { v: [null, 7, { id: '../x' }], gone: { 'bad id!': 5 } }, workflows: 'no' });
  assert.deepStrictEqual(c.routines, { v: [], items: {}, gone: {} });
  assert.deepStrictEqual(c.workflows.v, []);
});
