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

test('an edit made later wins, and switches the routine off here', () => {
  const local = { routines: [routine()] };
  const localSnap = plans.snapshot(local, { routines: { items: { r1: 10 } } });
  const remote = plans.snapshot({ routines: [routine({ prompt: 'Tidy Desktop too', enabled: false })] }, { routines: { items: { r1: 20 } } });
  const { values } = plans.apply(local, plans.merge(localSnap, remote));
  assert.strictEqual(values.routines[0].prompt, 'Tidy Desktop too');
  assert.strictEqual(values.routines[0].enabled, false);
});

test("a webhook's token never goes to the gist, and each PC keeps its own", () => {
  const mine = 'a'.repeat(48), theirs = 'b'.repeat(48);
  const hook = token => workflow({ when: [{ type: 'webhook', token }] });
  assert.ok(!JSON.stringify(plans.snapshot({ workflows: [hook(mine)] }, {})).includes(mine));
  const local = { workflows: [hook(mine)] };
  const remote = plans.snapshot({ workflows: [{ ...hook(theirs), steps: [{ type: 'tell', text: 'changed' }] }] }, { workflows: { items: { w1: 99 } } });
  const { values } = plans.apply(local, plans.merge(plans.snapshot(local, {}), remote));
  assert.strictEqual(values.workflows[0].when[0].token, mine);
  assert.strictEqual(values.workflows[0].enabled, true);
  const fresh = plans.apply({}, remote).values.workflows[0].when[0].token;
  assert.match(fresh, /^[a-f0-9]{48}$/);
  assert.notStrictEqual(fresh, theirs);
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

test('a list over its budget sends what fits, and nothing is lost or deleted', () => {
  const big = n => workflow({ id: 'w' + n, name: 'Big ' + n, steps: [{ type: 'tell', text: 'x'.repeat(900) }, ...Array.from({ length: 59 }, (_, i) => ({ type: 'tell', text: String(n) + 'y'.repeat(900) + i }))] });
  const local = { workflows: Array.from({ length: 4 }, (_, n) => big(n)) };
  const snap = plans.snapshot(local, {});
  assert.ok(JSON.stringify(snap).length < 160 * 1024);
  assert.ok(snap.workflows.v.length < 4);
  const { values } = plans.apply(local, plans.merge(snap, plans.snapshot({}, {})));
  assert.ok(!values.workflows || values.workflows.length === 4);
  assert.strictEqual(plans.restamp({ workflows: local.workflows.map(w => ({ ...w, enabled: false })) }, local, plans.restamp(local, {}, {}, 5), 9), null);
});

test('no more routines arrive than a PC can hold', () => {
  const many = Array.from({ length: 60 }, (_, n) => routine({ id: 'r' + n, name: 'R' + n }));
  assert.strictEqual(plans.snapshot({ routines: many }, {}).routines.v.length, 50);
});

test('a workflow arriving with a name taken here is renamed, and the sync says so', () => {
  const local = { workflows: [workflow({ id: 'mine', name: 'Deploy' })] };
  const remote = plans.snapshot({ workflows: [workflow({ id: 'theirs', name: 'deploy' })] }, {});
  const { values } = plans.apply(local, plans.merge(plans.snapshot(local, {}), remote));
  assert.deepStrictEqual(values.workflows.map(w => w.name), ['Deploy', 'deploy (2)']);
  const news = plans.arrived(local, values);
  assert.deepStrictEqual(news, { routines: 0, workflows: 1, renamed: ['deploy (2)'] });
  assert.match(plans.describeArrived(news), /1 workflow came from your other PC, switched off\. Renamed .*deploy \(2\)/);
  assert.strictEqual(plans.describeArrived(plans.arrived(values, values)), '');
});
