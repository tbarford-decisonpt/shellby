// How he works, in the renderer (shared/workposes.js): what he holds for each
// pose, and how long a pose stays up. Which pose, and where the tool comes from,
// is test/work-pose.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { POSES } = require('../src/main/work-pose');
const W = require('../src/renderer/shared/workposes');

// A clock whose timers fire at their own time, as real ones would.
function clock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (let h; (h = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]);) { timers.splice(timers.indexOf(h), 1); t = h.at; h.fn(); }
      t = end;
    },
  };
}

test('what he holds: each item is a held thing with its pinch on it and a colour for every pixel', () => {
  assert.deepEqual([...W.POSES].sort(), [...POSES].sort());
  for (const pose of ['read', 'write', 'run', 'search', 'web', 'plan']) assert.ok(W.ITEMS[pose], `${pose} has something in his claw`);
  for (const pose of ['think', 'crew', 'busy']) assert.equal(W.ITEMS[pose], null, `${pose} leaves his claw free`);
  for (const [pose, item] of Object.entries(W.ITEMS)) {
    if (!item) continue;
    assert.equal(item.slot, 'held', pose);
    assert.equal(item.follows, 'claw', pose);
    const w = Math.max(...item.pixels.map(r => r.length));
    assert.ok(item.pivot[0] < w && item.pivot[1] < item.pixels.length, `${pose}: the pinch is on the item`);
    for (const ch of new Set(item.pixels.join('').replace(/\./g, ''))) assert.ok(item.palette[ch], `${pose}: ${ch} has a colour`);
  }
});

test('the first pose of a turn shows at once, and each holds a moment before the next', () => {
  const c = clock();
  const seen = [];
  const h = W.holder((p, was) => seen.push([p, was]), c);
  h.set('think', true);
  assert.deepEqual(seen, [['think', null]], 'a turn starts thinking, straight away');
  c.advance(300);
  h.set('read', true);
  assert.equal(h.shown(), 'think', 'too soon: still thinking');
  c.advance(W.MIN_MS - 300);
  assert.equal(h.shown(), 'read');
  c.advance(W.MIN_MS);
  h.set('run', true);
  assert.equal(h.shown(), 'run', 'held long enough: the next one at once');
});

test('a short think keeps the tool in his claw, and a quick read between edits gets its moment', () => {
  const c = clock();
  const h = W.holder(() => {}, c);
  h.set('write', true);
  c.advance(W.MIN_MS + 10);
  h.set('think', true);
  c.advance(W.GAP_MS - 100);
  h.set('write', true);
  c.advance(5000);
  assert.equal(h.shown(), 'write', 'the pencil never went down');
  h.set('read', true);
  h.set('write', true);
  assert.equal(h.shown(), 'read', 'the read happened, so it shows');
  c.advance(W.MIN_MS);
  assert.equal(h.shown(), 'write', '...and the pencil is back after its moment');
  c.advance(W.MIN_MS);
  h.set('think', true);
  c.advance(W.GAP_MS);
  assert.equal(h.shown(), 'think', 'a longer think and he puts it down');
});

test('leaving work puts it all down at once, and a pose nobody sends is nothing', () => {
  const c = clock();
  const h = W.holder(() => {}, c);
  h.set('web', true);
  h.set('web', false);
  assert.equal(h.shown(), null, 'no waiting once the work is over');
  for (const odd of ['juggle', 'constructor', null, undefined]) {
    h.set(odd, true);
    assert.equal(h.shown(), null, String(odd));
  }
});
