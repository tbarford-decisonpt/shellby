// The preload bridge and the main process have to agree on ~150 channel names,
// and nothing enforces it: a typo in either direction fails silently. An
// invoke() with no handler rejects somewhere in the renderer, and a send() that
// nobody listens for simply vanishes — both of which look like "the UI didn't
// update" rather than a mistake with a line number.
//
// So the two sides are compared here as text. It's a lint, not a unit test:
// cheap, and it has caught nothing yet because the surface is currently exact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = p => fs.readFileSync(p, 'utf8');
const all = (text, re) => [...text.matchAll(re)].map(m => m[1]);

// Every bridge: the panel's, the crab's, the pebble's (fetch), the floor strip's
// (his pals and footprints), a mischief note's, and the confirmation window's
// own (confirm.js), each deliberately its own surface.
const preload = ['preload.js', 'dialog-preload.js', 'critter-preload.js', 'toy-preload.js', 'floor-preload.js', 'note-preload.js'].map(f => read(path.join(SRC, 'preload', f))).join('\n');

// Every .js under src/main: handlers and pushes both live outside main.js too.
const mainFiles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.js') ? [read(p)] : [];
  });
})(path.join(SRC, 'main')).join('\n');
const mainJs = mainFiles;

// ---- what the renderer can call, and what it listens for
const uniq = xs => [...new Set(xs)].sort();
const invokes = uniq([
  ...all(preload, /\binvoke\('([a-z0-9:_-]+)'\)/g),
  ...all(preload, /\bfire\('([a-z0-9:_-]+)'\)/g),
  ...all(preload, /ipcRenderer\.(?:invoke|send)\('([a-z0-9:_-]+)'/g),
]);
const listens = uniq([
  ...all(preload, /\bon\('([a-z0-9:_-]+)'\)/g),
  ...all(preload, /ipcRenderer\.on\('([a-z0-9:_-]+)'/g),
]);

// ---- what main answers, and what it pushes
const handlers = uniq(all(mainJs, /ipcMain\.(?:handle|on)\('([a-z0-9:_-]+)'/g));
const pushes = uniq([
  // send(win, 'channel', …) in main.js, service.toPanel('channel', …) elsewhere,
  // and the occasional raw webContents.send.
  ...all(mainFiles, /\bsend\([A-Za-z_$][\w.$?]*(?:\([^()]*\))?,\s*'([a-z0-9:_-]+)'/g),
  ...all(mainFiles, /\btoPanel\('([a-z0-9:_-]+)'/g),
  // Popped-out windows too: toEveryWindow / sendEveryWindow('channel', …).
  ...all(mainFiles, /\b(?:toEveryWindow|sendEveryWindow)\('([a-z0-9:_-]+)'/g),
  // life.js and playtime.js reach the crab's window through d.toCrab('channel', …).
  ...all(mainFiles, /\btoCrab\('([a-z0-9:_-]+)'/g),
  ...all(mainFiles, /webContents\.send\('([a-z0-9:_-]+)'/g),
]);

const list = xs => xs.join(', ') || '(none)';

test('every channel the renderer can call has a handler in main', () => {
  const orphans = invokes.filter(c => !handlers.includes(c));
  assert.deepEqual(orphans, [], `preload exposes these with nothing to answer them: ${list(orphans)}`);
});

test('every handler in main is reachable from the preload bridge', () => {
  // A sandboxed renderer can only reach main through preload, so a handler
  // missing from it is dead code (or a channel someone renamed on one side).
  const unreachable = handlers.filter(c => !invokes.includes(c));
  assert.deepEqual(unreachable, [], `main handles these but nothing can call them: ${list(unreachable)}`);
});

test('every event the renderer listens for is actually sent by main', () => {
  const never = listens.filter(c => !pushes.includes(c));
  assert.deepEqual(never, [], `the renderer waits forever for: ${list(never)}`);
});

test('every event main pushes has a listener in the preload bridge', () => {
  const lost = pushes.filter(c => !listens.includes(c));
  assert.deepEqual(lost, [], `main sends these into the void: ${list(lost)}`);
});

test('the two sides are the size we think they are', () => {
  // A sanity check on the regexes themselves: if a refactor moves the bridge
  // and these drop to a handful, the tests above would pass by vacuity.
  assert.ok(invokes.length > 80, `only found ${invokes.length} callable channels; has preload.js moved?`);
  assert.ok(listens.length > 30, `only found ${listens.length} listened channels; has preload.js moved?`);
  assert.ok(handlers.length > 80, `only found ${handlers.length} handlers; has main.js moved?`);
});
