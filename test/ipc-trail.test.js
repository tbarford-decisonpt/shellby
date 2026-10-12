// The trail's one IPC call (parity.js trail:tests): the tests named after the
// files a turn changed, among the files in the conversation's folder. It only
// reads a file list; what it's given is capped and checked like any input.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { register } = require('../src/main/parity');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-trail-ipc-')));
  for (const rel of ['src/app.js', 'src/util.js', 'test/app.test.js', 'node_modules/x/app.test.js']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '');
  }
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  register({
    ipcMain, manager: { tabs: new Map([['t1', { session: { cwd: dir } }]]) }, history: {}, config: { get: () => null, set: () => {} },
    confirm: {}, dialog: {}, clipboard: {}, app: {}, panel: () => null, dialogLook: () => ({}), currentCwd: () => dir, dataDir: dir,
  });
  const call = args => handlers.get('trail:tests')(null, args);
  return { dir, call, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('trail:tests names the tests for what changed, and nothing for what has none', async () => {
  const s = setup();
  try {
    const r = await s.call({ tabId: 't1', files: ['src/app.js', 'src/util.js'] });
    assert.deepEqual(r, { tests: { 'src/app.js': ['test/app.test.js'] } }, 'node_modules is never looked in');
  } finally { s.done(); }
});

test('trail:tests takes only short strings, and only so many of them', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.call({ tabId: 't1', files: 'src/app.js' }), { tests: {} });
    assert.deepEqual(await s.call({ tabId: 't1', files: [42, null, { x: 1 }, 'x'.repeat(5000)] }), { tests: {} });
    assert.deepEqual(await s.call(undefined), { tests: {} });
    const many = [...Array.from({ length: 200 }, (_, i) => `src/f${i}.js`), 'src/app.js'];
    assert.deepEqual(await s.call({ tabId: 't1', files: many }), { tests: {} }, 'past the cap, the rest are not asked after');
  } finally { s.done(); }
});
