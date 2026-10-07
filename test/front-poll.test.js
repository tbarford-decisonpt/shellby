const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFrontReader, createBeat, signature, FAST_MS, SLOW_MS, STILL_AFTER } = require('../src/main/front-poll');

function fakeNative(front) {
  const calls = { describe: 0, quick: 0 };
  return {
    calls,
    set front(h) { front = h; },
    foreground: () => front,
    describe: h => { calls.describe++; return { hwnd: h, pid: 7, exe: 'game.exe', frame: { left: 0, top: 0, right: 10, bottom: 10 }, visible: true }; },
    quick: h => { calls.quick++; return h === 99 ? { gone: true } : { gone: false, frame: { left: 5, top: 0, right: 15, bottom: 10 }, visible: true, minimized: false }; },
  };
}

test('describes the window in front once, then only re-reads where it is', () => {
  const n = fakeNative(1);
  const read = createFrontReader(n);
  const first = read();
  const again = read();
  assert.equal(n.calls.describe, 1);
  assert.equal(n.calls.quick, 1);
  assert.equal(first.exe, 'game.exe');
  assert.equal(again.exe, 'game.exe', 'the exe is kept');
  assert.equal(again.frame.left, 5, 'the frame is fresh');
});

test('a new window in front is described afresh', () => {
  const n = fakeNative(1);
  const read = createFrontReader(n);
  read();
  n.front = 2;
  assert.equal(read().hwnd, 2);
  assert.equal(n.calls.describe, 2);
});

test('a window that went away is described again, and nothing in front reads as null', () => {
  const n = fakeNative(99);
  const read = createFrontReader(n);
  read();
  read();
  assert.equal(n.calls.describe, 2);
  n.front = 0;
  assert.equal(read(), null);
});

test('the beat slows only after the same picture for a while, and quickens on any change', () => {
  const next = createBeat();
  const info = { hwnd: 1, frame: { left: 0, top: 0, right: 1, bottom: 1 }, visible: true };
  const same = signature(info, false);
  let ms = 0;
  for (let i = 0; i < STILL_AFTER; i++) ms = next(same);
  assert.equal(ms, FAST_MS);
  assert.equal(next(same), SLOW_MS);
  assert.equal(next(signature(info, true)), FAST_MS, 'away changed');
  assert.equal(next(signature({ ...info, frame: { ...info.frame, left: 3 } }, true)), FAST_MS, 'the window moved');
  assert.equal(next(signature(null, true)), FAST_MS);
});
