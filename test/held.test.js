const { test } = require('node:test');
const assert = require('node:assert/strict');
const held = require('../src/main/held');

const NOW = 1_790_000_000_000;
const H = 60 * 60 * 1000;
const RESET = NOW + 2 * H;

const msg = (over = {}) => ({ kind: 'message', tabId: 'tab-1', cwd: 'C:\\code', title: 'Fix it', text: 'carry on', attachments: [], at: RESET, ...over });
const routine = (over = {}) => ({ kind: 'routine', routineId: 'r-1', name: 'Morning briefing', at: RESET, ...over });

test('hold adds a cleaned-up item without touching the old list', () => {
  const before = [];
  const r = held.hold(before, msg({ text: '  carry on  ', extra: 'dropped' }), NOW);
  assert.equal(before.length, 0);
  assert.equal(r.list.length, 1);
  assert.equal(r.item.text, 'carry on');
  assert.equal(r.item.createdAt, NOW);
  assert.equal(r.item.extra, undefined);
  assert.match(r.item.id, /^[\w-]+$/);
});

test('nothing to send, or nowhere to send it, is refused', () => {
  assert.ok(held.hold([], msg({ text: '   ' }), NOW).error);
  assert.ok(held.hold([], msg({ tabId: '../etc' }), NOW).error);
  assert.ok(held.hold([], msg({ at: NaN }), NOW).error);
  assert.ok(held.hold([], msg({ at: NOW + 30 * 24 * H }), NOW).error);
  assert.ok(held.hold([], { kind: 'shell', at: RESET }, NOW).error);
  assert.ok(held.hold([], routine({ routineId: '' }), NOW).error);
  // Attachments alone are enough.
  assert.ok(held.hold([], msg({ text: '', attachments: ['C:\\shot.png'] }), NOW).item);
});

test('a routine remembers whether it was held for you or by you', () => {
  assert.equal(held.hold([], routine({ auto: true }), NOW).item.auto, true);
  assert.equal(held.hold([], routine(), NOW).item.auto, false);
  assert.equal(held.hold([], routine({ auto: 'yes' }), NOW).item.auto, false);
});

test('a routine is held once; holding it again keeps the first', () => {
  const a = held.hold([], routine(), NOW);
  const b = held.hold(a.list, routine({ at: RESET + H }), NOW + 1000);
  assert.equal(b.list.length, 1);
  assert.equal(b.item.id, a.item.id);
  assert.equal(b.item.at, RESET);
});

test('the list has a cap', () => {
  let list = [];
  for (let i = 0; i < held.MAX_HELD; i++) list = held.hold(list, msg({ text: `m${i}` }), NOW).list;
  assert.match(held.hold(list, msg(), NOW).error, /already waiting/);
});

test('due, next, defer and without', () => {
  let list = held.hold([], msg(), NOW).list;
  list = held.hold(list, routine({ at: RESET + H }), NOW).list;
  assert.equal(held.next(list), RESET);
  assert.equal(held.next([]), null);
  assert.equal(held.due(list, NOW).length, 0);
  assert.equal(held.due(list, RESET).length, 1);
  assert.equal(held.due(list, RESET + H).length, 2);

  const moved = held.defer(list, [list[0].id], RESET + 2 * H);
  assert.equal(moved[0].at, RESET + 2 * H);
  assert.equal(list[0].at, RESET); // not mutated
  // Deferring never brings anything earlier.
  assert.equal(held.defer(list, [list[1].id], NOW)[1].at, RESET + H);

  assert.equal(held.without(list, list[0].id).length, 1);
});

test('normalize keeps what is usable from disk, oldest first', () => {
  const raw = [
    { ...msg(), id: 'b', createdAt: NOW + 2 },
    { ...routine(), id: 'a', createdAt: NOW + 1 },
    { kind: 'message', text: 'no tab', at: RESET },
    { ...msg(), id: 'bad id!' }, // couldn't be cancelled by its id: dropped, not renamed
    'junk', null,
  ];
  const list = held.normalize(raw, NOW);
  assert.deepEqual(list.map(h => h.id), ['a', 'b']);
  assert.deepEqual(held.normalize(raw, NOW), list); // the same every time it's read
  assert.deepEqual(held.normalize(undefined, NOW), []);
  assert.deepEqual(held.normalize({}, NOW), []);
});

test('summary says what went', () => {
  const m = msg(), r = routine();
  assert.equal(held.summary([m]), 'a held message');
  assert.equal(held.summary([m, m, r]), '2 held messages and a routine');
  assert.equal(held.summary([r, r]), '2 routines');
});

const task = (over = {}) => ({ kind: 'task', prompt: 'Refactor the billing module\ninto smaller files', cwd: 'C:\\code\\app', mode: 'smart', at: RESET, ...over });

test('a task is held with a short name, and starts fresh whatever came in', () => {
  const r = held.hold([], task({ tabId: 'stale-tab', tries: 2 }), NOW);
  assert.equal(r.item.kind, 'task');
  assert.equal(r.item.name, 'Refactor the billing module');
  assert.equal(r.item.prompt, 'Refactor the billing module\ninto smaller files');
  assert.equal(r.item.tabId, null);
  assert.equal(r.item.tries, 0);
  assert.equal(r.item.mode, 'smart');
  assert.equal(held.hold([], task({ mode: 'yolo' }), NOW).item.mode, null);
  assert.ok(held.hold([], task({ prompt: '   ' }), NOW).error);
  assert.equal(held.taskName('x'.repeat(80)).length, 60);
  assert.ok(held.taskName('x'.repeat(80)).endsWith('…'));
});

test('the same task can be queued twice; tasks go in the order they were queued', () => {
  let list = held.hold([], task(), NOW).list;
  list = held.hold(list, task({ prompt: 'Write tests for the parser' }), NOW + 1).list;
  list = held.hold(list, task(), NOW + 2).list;
  assert.equal(list.length, 3);
  assert.deepEqual(held.due(list, RESET).map(h => h.name), ['Refactor the billing module', 'Write tests for the parser', 'Refactor the billing module']);
});

test('a started task remembers its conversation, and gives up after MAX_TRIES', () => {
  let list = held.hold([], task(), NOW).list;
  list = held.hold(list, msg(), NOW).list;
  const id = list[0].id;
  let after = held.started(list, id, 'tab-9');
  assert.equal(after[0].tabId, 'tab-9');
  assert.equal(after[0].tries, 1);
  assert.equal(list[0].tries, 0); // not mutated
  assert.deepEqual(after[1], list[1]); // only that task
  assert.equal(held.spent(after[0]), false);
  for (let i = 1; i < held.MAX_TRIES; i++) after = held.started(after, id, 'tab-9');
  assert.equal(held.spent(after[0]), true);
  assert.equal(held.spent(after[1]), false); // messages never are
  // ...and survives a restart: read back from disk, it still carries on there.
  const back = held.normalize(after, NOW);
  assert.equal(back.find(h => h.id === id).tabId, 'tab-9');
  assert.equal(back.find(h => h.id === id).tries, held.MAX_TRIES);
});

test('summary counts queued tasks too', () => {
  assert.equal(held.summary([task()]), 'a queued task');
  assert.equal(held.summary([task(), task()]), '2 queued tasks');
  assert.equal(held.summary([msg(), routine(), task()]), 'a held message, a routine and a queued task');
});
