// Copies coming home into the same checkout work together (src/main/home-line.js):
// merges take turns, and clashes are sorted out one copy at a time, each on a
// base that already has the one before it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createHomeLine, sortPrompt, MAX_TRIES } = require('../src/main/home-line');

const root = path.resolve('/repo/proj');
const copy = id => ({ path: path.resolve(`/home/${id}/proj`), root, branch: `shellby/${id}`, base: 'main' });
const tick = () => new Promise(r => setImmediate(r));

// A pretend repository: a copy is caught up once its "turn" merged the base in.
function world({ open = ['a', 'b', 'c'], busy = [] } = {}) {
  const sent = [];
  const told = [];
  const homed = [];
  const merged = new Set();     // copies that have merged the base in
  const homeResults = new Map(); // tabId -> [results to hand out, in order]
  const opened = new Set(open);
  const busyNow = new Set(busy);
  const line = createHomeLine({
    isOpen: id => opened.has(id),
    isBusy: id => busyNow.has(id),
    send: (id, prompt) => sent.push([id, prompt]),
    bringHome: async (id, opts) => { homed.push([id, opts]); return homeResults.get(id)?.shift() || { ok: true, merged: true, commits: 1 }; },
    caughtUp: async w => merged.has(w.branch),
    tell: e => told.push(e),
  });
  return { line, sent, told, homed, merged, homeResults, opened, busyNow };
}

test('merges into one checkout take turns; another checkout does not wait', async () => {
  const { line } = world();
  const order = [];
  let release;
  const first = line.turn(root, () => new Promise(r => { release = r; }).then(() => order.push('first')));
  const second = line.turn(root, async () => order.push('second'));
  const elsewhere = line.turn(path.resolve('/repo/other'), async () => order.push('elsewhere'));
  await elsewhere;
  await tick();
  assert.deepEqual(order, ['elsewhere'], 'the second waits for the first');
  assert.equal(line.busy(root), true);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['elsewhere', 'first', 'second']);
  await tick();
  assert.equal(line.busy(root), false);
});

test('a merge that throws does not stop the next one', async () => {
  const { line } = world();
  await assert.rejects(line.turn(root, async () => { throw new Error('boom'); }));
  assert.equal(await line.turn(root, async () => 'next'), 'next');
});

test('clashes are sorted out one at a time, each after the one before is home', async () => {
  const { line, sent, told, homed, merged } = world();
  assert.deepEqual(line.sortOut('a', copy('a'), 'A', { push: true }), { ok: true, position: 0, ahead: null });
  assert.deepEqual(line.sortOut('b', copy('b'), 'B'), { ok: true, position: 1, ahead: 'A' });
  assert.deepEqual(line.sortOut('c', copy('c'), 'C'), { ok: true, position: 2, ahead: 'A' });
  assert.deepEqual(sent.map(s => s[0]), ['a'], 'only the front one starts');

  // B's turn ending while it waits changes nothing.
  await line.turnEnded('b');
  assert.deepEqual(homed, []);

  merged.add('shellby/a');
  await line.turnEnded('a');
  assert.deepEqual(homed, [['a', { push: true, check: undefined, force: false, finish: false }]]);
  assert.deepEqual(sent.map(s => s[0]), ['a', 'b'], 'B starts once A is home');
  assert.match(sent[1][1], /main already has "A", which came home just before this/);

  merged.add('shellby/b');
  await line.turnEnded('b');
  assert.match(sent[2][1], /main already has "A", "B"/);
  merged.add('shellby/c');
  await line.turnEnded('c');
  assert.deepEqual(homed.map(h => h[0]), ['a', 'b', 'c']);
  assert.deepEqual(told.filter(e => e.status === 'home').map(e => e.title), ['A', 'B', 'C']);
  assert.equal(line.placeOf('c'), null, 'the line is empty');
});

test('asking twice is one place in line', () => {
  const { line, sent } = world();
  line.sortOut('a', copy('a'), 'A');
  line.sortOut('b', copy('b'), 'B');
  assert.deepEqual(line.sortOut('b', copy('b'), 'B'), { ok: true, already: true, position: 1, ahead: 'A' });
  assert.equal(sent.length, 1);
});

test('the base moving on again: asked once more, then over to you', async () => {
  const { line, sent, told, merged, homeResults } = world();
  homeResults.set('a', Array(MAX_TRIES).fill({ ok: false, conflict: true, error: 'clashes' }));
  line.sortOut('a', copy('a'), 'A');
  line.sortOut('b', copy('b'), 'B');
  merged.add('shellby/a');
  for (let i = 0; i < MAX_TRIES; i++) await line.turnEnded('a');
  const toA = sent.filter(s => s[0] === 'a');
  assert.equal(toA.length, MAX_TRIES);
  assert.match(toA[1][1], /moved on while you were sorting this out/);
  assert.equal(told.at(-2).status, 'stuck');
  assert.equal(told.at(-1).title, 'B', 'and the next one starts');
  assert.equal(told.at(-1).status, 'sorting');
});

test('stopping short of merging the base in leaves it in its copy, and the next one goes', async () => {
  const { line, sent, told, homed } = world();
  line.sortOut('a', copy('a'), 'A');
  line.sortOut('b', copy('b'), 'B');
  await line.turnEnded('a'); // a question for you, say: the base isn't in yet
  assert.deepEqual(homed, []);
  assert.equal(told.find(e => e.tabId === 'a' && e.status === 'stuck').tabId, 'a');
  assert.deepEqual(sent.map(s => s[0]), ['a', 'b']);
});

test('a copy that is busy when its turn comes starts when that turn ends', async () => {
  const { line, sent, busyNow } = world({ busy: ['a'] });
  line.sortOut('a', copy('a'), 'A');
  assert.equal(sent.length, 0);
  busyNow.delete('a');
  await line.turnEnded('a');
  assert.deepEqual(sent.map(s => s[0]), ['a']);
});

test('a conversation that closes leaves the line', () => {
  const { line, sent } = world();
  line.sortOut('a', copy('a'), 'A');
  line.sortOut('b', copy('b'), 'B');
  line.prune(new Set(['b']));
  assert.deepEqual(sent.map(s => s[0]), ['a', 'b']);
  assert.deepEqual(line.placeOf('b'), { position: 0, ahead: null, sorting: true });
});

test('a closed conversation cannot join the line', () => {
  const { line } = world({ open: [] });
  assert.equal(line.sortOut('a', copy('a'), 'A').ok, false);
});

test('the prompt tells him not to merge into the base himself', () => {
  assert.match(sortPrompt(copy('a')), /^Merge main into this branch \(git merge main\).*Don't merge into main yourself/);
});
