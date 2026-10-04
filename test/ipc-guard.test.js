// Which window may call which channel (src/main/ipc-guard.js), and the crab's
// own bridge staying inside what main lets it reach.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { guardIpc, windowPolicy, CRITTER_CHANNELS } = require('../src/main/ipc-guard');

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers, listeners,
    handle: (c, fn) => handlers.set(c, fn),
    on: (c, fn) => listeners.set(c, fn),
  };
}

const panel = { id: 1 };
const critter = { id: 2 };
const stranger = { id: 3 };
const allow = windowPolicy(() => ({ panel, critter }));

test('the panel reaches everything, the crab only his own channels, anything else nothing', () => {
  assert.equal(allow('task:send', panel), true);
  assert.equal(allow('critter:reset-position', panel), true);
  assert.equal(allow('critter:drag-move', critter), true);
  assert.equal(allow('critter:drop', critter), true);
  assert.equal(allow('attach:image', critter), true);
  for (const c of ['task:send', 'task:permission', 'shell:run', 'settings:set', 'channels:set', 'routines:save', 'critter:reset-position', 'attach:thumb']) {
    assert.equal(allow(c, critter), false, c);
  }
  assert.equal(allow('task:send', stranger), false);
  assert.equal(allow('critter:click', stranger), false);
  assert.equal(allow('task:send', undefined), false);
});

test("the pebble for fetch can only be dragged; it reaches nothing of the panel's or the crab's", () => {
  const toy = { id: 4 };
  const withToy = windowPolicy(() => ({ panel, critter, isToy: wc => wc === toy }));
  for (const c of ['toy:drag-start', 'toy:drag-move', 'toy:drag-end']) assert.equal(withToy(c, toy), true, c);
  for (const c of ['task:send', 'critter:click', 'critter:drop', 'attach:image', 'life:play', 'toy:look', 'settings:set']) assert.equal(withToy(c, toy), false, c);
  assert.equal(withToy('toy:drag-move', critter), false, 'the crab is not the pebble');
  assert.equal(withToy('toy:drag-move', stranger), false);
  assert.equal(windowPolicy(() => ({ panel, critter, isToy: () => false }))('toy:drag-move', toy), false, 'a closed pebble is nobody');
});

test('a closed window is nobody: its old sender reaches nothing', () => {
  const gone = windowPolicy(() => ({ panel: null, critter: null }));
  assert.equal(gone('task:send', panel), false);
  assert.equal(gone('critter:click', critter), false);
});

test('guarded handlers refuse the wrong window: invoke rejects, send is dropped, each noted once', async () => {
  const raw = fakeIpcMain();
  const refused = [];
  const ipc = guardIpc(raw, allow, { onRefused: c => refused.push(c) });
  let ran = 0;
  ipc.handle('task:send', (_e, x) => { ran++; return x * 2; });
  ipc.on('critter:click', () => { ran++; });

  assert.equal(await raw.handlers.get('task:send')({ sender: panel }, 21), 42);
  assert.throws(() => raw.handlers.get('task:send')({ sender: critter }, 1), /Not allowed/);
  assert.throws(() => raw.handlers.get('task:send')({ sender: critter }, 1), /Not allowed/);
  raw.listeners.get('critter:click')({ sender: critter });
  raw.listeners.get('critter:click')({ sender: stranger });
  assert.equal(ran, 2);
  assert.deepEqual(refused, ['task:send', 'critter:click']);
});

test('every channel the crab\'s bridge uses is one main lets him reach', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'critter-preload.js'), 'utf8');
  const calls = [...text.matchAll(/(?:fire|ipcRenderer\.(?:send|invoke))\('([a-z0-9:_-]+)'/g)].map(m => m[1]);
  assert.ok(calls.length > 5);
  for (const c of calls) assert.ok(CRITTER_CHANNELS.test(c), c);
  // ...and it carries nothing of the panel's.
  assert.doesNotMatch(text, /task:|settings:|shell:|channels:|routines:/);
});

test('the floor strip may only report the pointer and a poke; a note only closes itself', () => {
  const floor = { id: 5 }, note = { id: 6 };
  const withThem = windowPolicy(() => ({ panel, critter, isFloor: wc => wc === floor, isNote: wc => wc === note }));
  for (const c of ['floor:hit', 'floor:poke']) assert.equal(withThem(c, floor), true, c);
  assert.equal(withThem('note:close', note), true);
  for (const c of ['critter:click', 'critter:drop', 'toy:drag-start', 'task:send', 'settings:set', 'note:close', 'floor:colony']) {
    assert.equal(withThem(c, floor), false, `floor ${c}`);
  }
  for (const c of ['critter:click', 'toy:drag-start', 'task:send', 'settings:set', 'floor:hit', 'floor:poke']) {
    assert.equal(withThem(c, note), false, `note ${c}`);
  }
});

test('the crab, the panel and the pebble are not the floor or a note', () => {
  const floor = { id: 5 }, note = { id: 6 }, toy = { id: 4 };
  const withThem = windowPolicy(() => ({ panel, critter, isToy: wc => wc === toy, isFloor: wc => wc === floor, isNote: wc => wc === note }));
  assert.equal(withThem('floor:hit', critter), false);
  assert.equal(withThem('floor:poke', toy), false);
  assert.equal(withThem('note:close', critter), false);
  assert.equal(withThem('note:close', toy), false);
  assert.equal(withThem('floor:hit', stranger), false);
  assert.equal(withThem('note:close', stranger), false);
});

test('a closed floor or note is nobody', () => {
  const floor = { id: 5 }, note = { id: 6 };
  const closed = windowPolicy(() => ({ panel, critter, isFloor: () => false, isNote: () => false }));
  assert.equal(closed('floor:hit', floor), false);
  assert.equal(closed('note:close', note), false);
});
